using System.Runtime.InteropServices;
using System.Text.Json;

namespace OpenLocally;

internal static class NativeDpiChange
{
    private const uint SwpNoZOrder = 0x0004;
    private const uint SwpNoActivate = 0x0010;

    public static void Apply(IntPtr window, IntPtr wParam, IntPtr lParam, Action<int> refresh)
    {
        ArgumentNullException.ThrowIfNull(refresh);
        Rect suggested = Marshal.PtrToStructure<Rect>(lParam);
        SetWindowPos(window, IntPtr.Zero, suggested.left, suggested.top,
            suggested.right - suggested.left, suggested.bottom - suggested.top, SwpNoZOrder | SwpNoActivate);
        refresh(unchecked((ushort)(wParam.ToInt64() & 0xffff)));
    }

    [StructLayout(LayoutKind.Sequential)]
    internal struct Rect { public int left, top, right, bottom; }

    [DllImport("user32.dll")]
    private static extern bool SetWindowPos(IntPtr window, IntPtr insertAfter, int x, int y, int width, int height, uint flags);
}

internal sealed record DpiAwarenessProbeResult(
    bool ThreadPerMonitorV2,
    bool WindowPerMonitorV2,
    int InitialDpi,
    int FinalDpi,
    bool DpiChangedReceived,
    bool SuggestedBoundsProcessed,
    bool ThemeDpiUpdated,
    bool FontResourcesRebuilt,
    bool LayoutUpdated,
    bool RealTransitionAttempted,
    bool RealTransitionObserved,
    string? RealTransitionLimitation);

/// <summary>Private production-executable seam used to verify the embedded manifest and native DPI path.</summary>
internal static class DpiAwarenessProbe
{
    private const string Switch = "--creatorcrate-verify-dpi-awareness";
    private const string ClassName = "CreatorCrate.DpiAwarenessProbe";
    private const uint WmDpiChanged = 0x02E0;
    private const uint WsOverlapped = 0x00000000;
    private const uint PmRemove = 0x0001;
    private static readonly WindowProc Procedure = WindowProcedure;

    public static bool TryRun(string[] args, out int exitCode)
    {
        exitCode = 0;
        if (args.Length == 0 || !string.Equals(args[0], Switch, StringComparison.Ordinal)) return false;
        if (args.Length != 2 || string.IsNullOrWhiteSpace(args[1])) return Fail(out exitCode);

        try
        {
            DpiAwarenessProbeResult result = Run();
            File.WriteAllText(args[1], JsonSerializer.Serialize(result));
            exitCode = result.ThreadPerMonitorV2 && result.WindowPerMonitorV2 && result.DpiChangedReceived &&
                result.SuggestedBoundsProcessed && result.ThemeDpiUpdated && result.FontResourcesRebuilt && result.LayoutUpdated ? 0 : 1;
        }
        catch (Exception exception)
        {
            File.WriteAllText(args[1], JsonSerializer.Serialize(new { Error = exception.ToString() }));
            exitCode = 1;
        }
        return true;
    }

    private static bool Fail(out int exitCode) { exitCode = 2; return true; }

    private static DpiAwarenessProbeResult Run()
    {
        IntPtr instance = GetModuleHandle(null);
        var definition = new WindowClass
        {
            cbSize = (uint)Marshal.SizeOf<WindowClass>(),
            hInstance = instance,
            lpszClassName = ClassName,
            lpfnWndProc = Marshal.GetFunctionPointerForDelegate(Procedure),
        };
        if (RegisterClassEx(ref definition) == 0 && Marshal.GetLastWin32Error() != 1410)
            throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());

        var state = new ProbeState();
        GCHandle handle = GCHandle.Alloc(state);
        IntPtr window = IntPtr.Zero;
        try
        {
            window = CreateWindowEx(0, ClassName, string.Empty, WsOverlapped, 20, 20, 640, 480,
                IntPtr.Zero, IntPtr.Zero, instance, GCHandle.ToIntPtr(handle));
            if (window == IntPtr.Zero) throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());

            state.Window = window;
            state.InitialDpi = checked((int)GetDpiForWindow(window));
            state.FinalDpi = state.InitialDpi;
            state.Theme = new NativeCompanionTheme(state.InitialDpi);
            state.Layout = NativeCompanionLayout.Calculate(640, 480, state.InitialDpi, patreon: true);
            NativeCompanionLayout initialLayout = state.Layout;

            bool threadV2 = AreDpiAwarenessContextsEqual(
                GetThreadDpiAwarenessContext(), new IntPtr(-4));
            bool windowV2 = AreDpiAwarenessContextsEqual(
                GetWindowDpiAwarenessContext(window), new IntPtr(-4));

            IReadOnlyList<MonitorDpi> monitors = MonitorDpis();
            MonitorDpi? target = monitors.Where(monitor => monitor.Dpi != state.InitialDpi)
                .Select(monitor => (MonitorDpi?)monitor).FirstOrDefault();
            bool attempted = target is not null;
            bool observed = false;
            string? limitation = null;
            if (target is not null)
            {
                SetWindowPos(window, IntPtr.Zero, target.Value.Left + 20, target.Value.Top + 20, 640, 480, 0x0004 | 0x0010);
                PumpPendingMessages();
                observed = state.DpiChangedReceived && state.FinalDpi == target.Value.Dpi;
                if (!observed) limitation = "A distinct-DPI monitor was enumerated, but the hidden disposable window did not receive a genuine WM_DPICHANGED transition.";
            }
            else
            {
                limitation = monitors.Count <= 1
                    ? "The worker exposes only one monitor DPI, so a genuine cross-monitor DPI transition is unavailable."
                    : "The worker's monitors all expose the same effective DPI, so a genuine cross-monitor DPI transition is unavailable.";
            }

            if (!observed)
            {
                state.ResetTransitionEvidence();
                int syntheticDpi = state.InitialDpi == 144 ? 192 : 144;
                var suggested = new NativeDpiChange.Rect { left = 40, top = 50, right = 40 + 720, bottom = 50 + 540 };
                IntPtr pointer = Marshal.AllocHGlobal(Marshal.SizeOf<NativeDpiChange.Rect>());
                try
                {
                    Marshal.StructureToPtr(suggested, pointer, false);
                    long packedDpi = (uint)syntheticDpi | ((long)(uint)syntheticDpi << 16);
                    SendMessage(window, WmDpiChanged, new IntPtr(packedDpi), pointer);
                }
                finally { Marshal.FreeHGlobal(pointer); }
            }

            GetWindowRect(window, out NativeDpiChange.Rect bounds);
            state.SuggestedBoundsProcessed = state.SuggestedBoundsProcessed ||
                (bounds.right - bounds.left == 720 && bounds.bottom - bounds.top == 540);
            NativeCompanionLayout? finalLayout = state.Layout;
            NativeCompanionLayout expectedLayout = NativeCompanionLayout.Calculate(
                bounds.right - bounds.left, bounds.bottom - bounds.top, state.FinalDpi, patreon: true);
            state.LayoutUpdated = finalLayout is not null && finalLayout != initialLayout &&
                finalLayout.HeaderTitle == expectedLayout.HeaderTitle;

            return new DpiAwarenessProbeResult(
                threadV2, windowV2, state.InitialDpi, state.FinalDpi, state.DpiChangedReceived,
                state.SuggestedBoundsProcessed, state.Theme?.Dpi == state.FinalDpi,
                state.FontResourcesRebuilt, state.LayoutUpdated, attempted, observed, limitation);
        }
        finally
        {
            state.Theme?.Dispose();
            if (window != IntPtr.Zero) DestroyWindow(window);
            if (handle.IsAllocated) handle.Free();
        }
    }

    private static IntPtr WindowProcedure(IntPtr window, uint message, IntPtr wParam, IntPtr lParam)
    {
        if (message == 0x0081)
        {
            CreateStruct create = Marshal.PtrToStructure<CreateStruct>(lParam);
            SetWindowLongPtr(window, -21, create.lpCreateParams);
        }
        ProbeState? state = State(window);
        if (message == WmDpiChanged && state is not null)
        {
            NativeDpiChange.Rect suggested = Marshal.PtrToStructure<NativeDpiChange.Rect>(lParam);
            NativeCompanionTheme theme = state.Theme ?? throw new InvalidOperationException("The DPI probe theme was not initialized.");
            NativeDpiChange.Apply(window, wParam, lParam, dpi =>
            {
                state.DpiChangedReceived = true;
                state.FinalDpi = dpi;
                theme.Refresh(dpi);
                state.FontResourcesRebuilt = theme.Dpi == dpi && theme.Font(NativeCompanionFontRole.Body) != IntPtr.Zero;
                state.Layout = NativeCompanionLayout.Calculate(720, 540, dpi, patreon: true);
            });
            GetWindowRect(window, out NativeDpiChange.Rect actual);
            state.SuggestedBoundsProcessed = actual.left == suggested.left && actual.top == suggested.top &&
                actual.right - actual.left == suggested.right - suggested.left && actual.bottom - actual.top == suggested.bottom - suggested.top;
            return IntPtr.Zero;
        }
        return DefWindowProc(window, message, wParam, lParam);
    }

    private static ProbeState? State(IntPtr window)
    {
        IntPtr value = GetWindowLongPtr(window, -21);
        return value == IntPtr.Zero ? null : GCHandle.FromIntPtr(value).Target as ProbeState;
    }

    private static IReadOnlyList<MonitorDpi> MonitorDpis()
    {
        var result = new List<MonitorDpi>();
        EnumDisplayMonitors(IntPtr.Zero, IntPtr.Zero, (monitor, _, _, _) =>
        {
            var info = new MonitorInfo { cbSize = (uint)Marshal.SizeOf<MonitorInfo>() };
            if (GetMonitorInfo(monitor, ref info) && GetDpiForMonitor(monitor, 0, out uint x, out _) == 0)
                result.Add(new MonitorDpi(info.rcMonitor.left, info.rcMonitor.top, checked((int)x)));
            return true;
        }, IntPtr.Zero);
        return result;
    }

    private static void PumpPendingMessages()
    {
        while (PeekMessage(out Message message, IntPtr.Zero, 0, 0, PmRemove))
        {
            TranslateMessage(ref message);
            DispatchMessage(ref message);
        }
    }

    private sealed class ProbeState
    {
        public IntPtr Window;
        public int InitialDpi, FinalDpi;
        public bool DpiChangedReceived, SuggestedBoundsProcessed, FontResourcesRebuilt, LayoutUpdated;
        public NativeCompanionTheme? Theme;
        public NativeCompanionLayout? Layout;
        public void ResetTransitionEvidence()
        {
            DpiChangedReceived = SuggestedBoundsProcessed = FontResourcesRebuilt = LayoutUpdated = false;
            FinalDpi = InitialDpi;
        }
    }

    private readonly record struct MonitorDpi(int Left, int Top, int Dpi);
    private delegate bool MonitorEnumProc(IntPtr monitor, IntPtr device, IntPtr rect, IntPtr data);
    [UnmanagedFunctionPointer(CallingConvention.Winapi)] private delegate IntPtr WindowProc(IntPtr window, uint message, IntPtr wParam, IntPtr lParam);
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)] private struct WindowClass { public uint cbSize, style; public IntPtr lpfnWndProc; public int cbClsExtra, cbWndExtra; public IntPtr hInstance, hIcon, hCursor, hbrBackground; public string? lpszMenuName, lpszClassName; public IntPtr hIconSm; }
    [StructLayout(LayoutKind.Sequential)] private struct CreateStruct { public IntPtr lpCreateParams, hInstance, hMenu, hwndParent; public int cy, cx, y, x, style; public IntPtr lpszName, lpszClass; public uint dwExStyle; }
    [StructLayout(LayoutKind.Sequential)] private struct Message { public IntPtr hwnd; public uint message; public IntPtr wParam, lParam; public uint time; public Point pt; public uint lPrivate; }
    [StructLayout(LayoutKind.Sequential)] private struct Point { public int x, y; }
    [StructLayout(LayoutKind.Sequential)] private struct MonitorInfo { public uint cbSize; public NativeDpiChange.Rect rcMonitor, rcWork; public uint dwFlags; }

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] private static extern IntPtr GetModuleHandle(string? moduleName);
    [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)] private static extern ushort RegisterClassEx(ref WindowClass definition);
    [DllImport("user32.dll", EntryPoint = "CreateWindowExW", CharSet = CharSet.Unicode, ExactSpelling = true, SetLastError = true)] private static extern IntPtr CreateWindowEx(uint extendedStyle, string className, string title, uint style, int x, int y, int width, int height, IntPtr parent, IntPtr menu, IntPtr instance, IntPtr parameter);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern IntPtr DefWindowProc(IntPtr window, uint message, IntPtr wParam, IntPtr lParam);
    [DllImport("user32.dll", SetLastError = true)] private static extern bool DestroyWindow(IntPtr window);
    [DllImport("user32.dll")] private static extern IntPtr GetThreadDpiAwarenessContext();
    [DllImport("user32.dll")] private static extern IntPtr GetWindowDpiAwarenessContext(IntPtr window);
    [DllImport("user32.dll")] private static extern bool AreDpiAwarenessContextsEqual(IntPtr first, IntPtr second);
    [DllImport("user32.dll")] private static extern uint GetDpiForWindow(IntPtr window);
    [DllImport("user32.dll", SetLastError = true)] private static extern bool SetWindowPos(IntPtr window, IntPtr insertAfter, int x, int y, int width, int height, uint flags);
    [DllImport("user32.dll")] private static extern IntPtr SendMessage(IntPtr window, uint message, IntPtr wParam, IntPtr lParam);
    [DllImport("user32.dll")] private static extern bool GetWindowRect(IntPtr window, out NativeDpiChange.Rect rect);
    [DllImport("user32.dll")] private static extern bool EnumDisplayMonitors(IntPtr hdc, IntPtr clip, MonitorEnumProc callback, IntPtr data);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern bool GetMonitorInfo(IntPtr monitor, ref MonitorInfo info);
    [DllImport("shcore.dll")] private static extern int GetDpiForMonitor(IntPtr monitor, int dpiType, out uint dpiX, out uint dpiY);
    [DllImport("user32.dll")] private static extern bool PeekMessage(out Message message, IntPtr window, uint min, uint max, uint remove);
    [DllImport("user32.dll")] private static extern bool TranslateMessage(ref Message message);
    [DllImport("user32.dll")] private static extern IntPtr DispatchMessage(ref Message message);
    [DllImport("user32.dll", EntryPoint = "SetWindowLongPtrW")] private static extern IntPtr SetWindowLongPtr64(IntPtr window, int index, IntPtr value);
    [DllImport("user32.dll", EntryPoint = "SetWindowLongW")] private static extern IntPtr SetWindowLong32(IntPtr window, int index, IntPtr value);
    [DllImport("user32.dll", EntryPoint = "GetWindowLongPtrW")] private static extern IntPtr GetWindowLongPtr64(IntPtr window, int index);
    [DllImport("user32.dll", EntryPoint = "GetWindowLongW")] private static extern IntPtr GetWindowLong32(IntPtr window, int index);
    private static IntPtr SetWindowLongPtr(IntPtr window, int index, IntPtr value) => IntPtr.Size == 8 ? SetWindowLongPtr64(window, index, value) : SetWindowLong32(window, index, value);
    private static IntPtr GetWindowLongPtr(IntPtr window, int index) => IntPtr.Size == 8 ? GetWindowLongPtr64(window, index) : GetWindowLong32(window, index);
}
