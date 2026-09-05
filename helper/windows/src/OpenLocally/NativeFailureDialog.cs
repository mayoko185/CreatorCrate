using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

namespace OpenLocally
{

public enum NativePresentationState { Failed, PresentedAndDismissed }
public enum NativePresentationStage
{
    start, open_input_desktop, set_thread_desktop, register_window_class,
    create_main_window, create_report_control, create_copy_button, create_close_button,
    show_window, visibility_check, message_loop, completed, unexpected
}

/// <summary>Only bounded technical evidence crosses the process boundary.</summary>
public sealed class NativePresentationResult
{
    public NativePresentationState State { get; internal set; }
    public NativePresentationStage Stage { get; internal set; }
    public int Win32Code { get; internal set; }
    public int SessionId { get; internal set; }
    public bool InputDesktopOpened { get; internal set; }
    public bool ThreadDesktopSelected { get; internal set; }
    public bool WindowCreated { get; internal set; }
    public bool WindowVisible { get; internal set; }
    public bool NormalDismissal { get; internal set; }

    public string ToMarker()
    {
        return string.Format(System.Globalization.CultureInfo.InvariantCulture,
            "CREATORCRATE_MANUAL_PRESENTATION;state={0};stage={1};win32_code={2};session_id={3};input_desktop={4};thread_desktop={5};window_created={6};window_visible={7};normal_dismissal={8}",
            State == NativePresentationState.PresentedAndDismissed ? "presented" : "failed",
            Enum.IsDefined(typeof(NativePresentationStage), Stage) ? Stage : NativePresentationStage.unexpected,
            Math.Max(0, Win32Code), Math.Max(0, SessionId), Flag(InputDesktopOpened), Flag(ThreadDesktopSelected),
            Flag(WindowCreated), Flag(WindowVisible), Flag(NormalDismissal));
    }

    private static string Flag(bool value) { return value ? "yes" : "no"; }
}

/// <summary>
/// Small raw-Win32 detailed error surface shared by the GUI helper and the
/// manual PowerShell harness. It intentionally depends on no UI framework or
/// package: the report is already sanitized before it reaches this boundary.
/// </summary>
public static class NativeFailureDialog
{
    public const string Title = "CreatorCrate Social Preparation Failed";
    private const int ReportId = 101;
    private const int CopyId = 102;
    private const int CloseId = 103;
    private const uint WM_NCCREATE = 0x0081;
    private const uint WM_CREATE = 0x0001;
    private const uint WM_SIZE = 0x0005;
    private const uint WM_SETFOCUS = 0x0007;
    private const uint WM_GETMINMAXINFO = 0x0024;
    private const uint WM_COMMAND = 0x0111;
    private const uint WM_CTLCOLORSTATIC = 0x0138;
    private const uint WM_DESTROY = 0x0002;
    private const uint WM_SETFONT = 0x0030;
    private const uint STM_SETICON = 0x0170;
    private const uint WS_OVERLAPPEDWINDOW = 0x00CF0000;
    private const uint WS_VISIBLE = 0x10000000;
    private const uint WS_CHILD = 0x40000000;
    private const uint WS_TABSTOP = 0x00010000;
    private const uint WS_BORDER = 0x00800000;
    private const uint WS_VSCROLL = 0x00200000;
    private const uint WS_HSCROLL = 0x00100000;
    private const uint ES_MULTILINE = 0x0004;
    private const uint ES_AUTOVSCROLL = 0x0040;
    private const uint ES_AUTOHSCROLL = 0x0080;
    private const uint ES_READONLY = 0x0800;
    private const uint BS_PUSHBUTTON = 0;
    private const uint SS_ICON = 0x00000003;
    private const int SW_SHOW = 5;
    private const int VK_ESCAPE = 0x1B;
    private const int VK_RETURN = 0x0D;
    private const int VK_TAB = 0x09;
    private const int GWLP_USERDATA = -21;
    private const uint CF_UNICODETEXT = 13;
    private const uint GMEM_MOVEABLE = 0x0002;
    private const int DEFAULT_GUI_FONT = 17;
    private const int COLOR_WINDOW = 5;
    private const uint SWP_NOSIZE = 0x0001;
    private const uint SWP_NOMOVE = 0x0002;
    private const uint SWP_SHOWWINDOW = 0x0040;
    private static readonly WindowProc WindowProcedure = WindowProcedureImpl;

    /// <summary>Shows a modal, resizable native report window until the operator closes it.</summary>
    public static NativePresentationResult Show(string summary, string report)
    {
        return ShowWithNative(new WindowsPresentation(summary ?? string.Empty, report ?? string.Empty));
    }

    internal static NativePresentationResult ShowWithNative(PresentationNative native)
    {
        return NativeOperatorUiHost.Show(native, result => RunPresentation(native, result));
    }

    internal abstract class PresentationNative : NativeOperatorUiHost.Native
    {
    }

    private static void RunPresentation(PresentationNative native, NativePresentationResult result)
    {
        foreach (NativePresentationStage stage in new[] {
            NativePresentationStage.register_window_class, NativePresentationStage.create_main_window,
            NativePresentationStage.create_report_control, NativePresentationStage.create_copy_button,
            NativePresentationStage.create_close_button, NativePresentationStage.show_window,
            NativePresentationStage.visibility_check, NativePresentationStage.message_loop })
        {
            result.Stage = stage;
            if (!native.Execute(stage, result))
            {
                // Visibility has no meaningful GetLastError contract.
                result.Win32Code = stage == NativePresentationStage.visibility_check ? 0 : Math.Max(0, native.LastError);
                return;
            }
            if (stage == NativePresentationStage.create_main_window) result.WindowCreated = true;
            if (stage == NativePresentationStage.visibility_check) result.WindowVisible = true;
        }
        result.NormalDismissal = true;
        result.State = NativePresentationState.PresentedAndDismissed;
        result.Stage = NativePresentationStage.completed;
    }

    private sealed class WindowsPresentation : PresentationNative
    {
        private readonly DialogState state;
        private IntPtr window;
        private int lastError;
        public WindowsPresentation(string summary, string report) { state = new DialogState(summary, report); }
        public override int LastError { get { return lastError != 0 ? lastError : base.LastError; } }

        public override bool Execute(NativePresentationStage stage, NativePresentationResult result)
        {
            bool succeeded;
            IntPtr instance = GetModuleHandle(null);
            switch (stage)
            {
                case NativePresentationStage.open_input_desktop:
                case NativePresentationStage.set_thread_desktop:
                    return base.Execute(stage, result);
                case NativePresentationStage.register_window_class:
                    succeeded = RegisterClassOnce("CreatorCrate.NativeFailureDialog", instance) != 0;
                    break;
                case NativePresentationStage.create_main_window:
                    state.Handle = GCHandle.Alloc(state);
                    int dpi = SystemDpi();
                    window = CreateWindowEx(0, "CreatorCrate.NativeFailureDialog", Title, WS_OVERLAPPEDWINDOW,
                        100, 100, Scale(760, dpi), Scale(540, dpi), IntPtr.Zero, IntPtr.Zero, instance, GCHandle.ToIntPtr(state.Handle));
                    succeeded = window != IntPtr.Zero;
                    break;
                case NativePresentationStage.create_report_control:
                    CreateControls(window, state);
                    succeeded = state.ReportControl != IntPtr.Zero;
                    lastError = state.ReportError;
                    return succeeded;
                case NativePresentationStage.create_copy_button:
                    state.CopyControl = CreateWindowEx(0, "Button", "Copy Report", WS_CHILD | WS_VISIBLE | WS_TABSTOP | BS_PUSHBUTTON,
                        0, 0, 0, 0, window, new IntPtr(CopyId), instance, IntPtr.Zero);
                    succeeded = state.CopyControl != IntPtr.Zero;
                    break;
                case NativePresentationStage.create_close_button:
                    state.CloseControl = CreateWindowEx(0, "Button", "Close", WS_CHILD | WS_VISIBLE | WS_TABSTOP | BS_PUSHBUTTON,
                        0, 0, 0, 0, window, new IntPtr(CloseId), instance, IntPtr.Zero);
                    succeeded = state.CloseControl != IntPtr.Zero;
                    break;
                case NativePresentationStage.show_window:
                    foreach (IntPtr control in state.Controls) SendMessage(control, WM_SETFONT, GetStockObject(DEFAULT_GUI_FONT), new IntPtr(1));
                    Layout(window, state);
                    ShowWindow(window, SW_SHOW); // Return value is previous visibility, not success.
                    UpdateWindow(window);
                    SetWindowPos(window, new IntPtr(-1), 0, 0, 0, 0, SWP_NOSIZE | SWP_NOMOVE | SWP_SHOWWINDOW);
                    SetForegroundWindow(window);
                    FlashWindow(window);
                    return true;
                case NativePresentationStage.visibility_check:
                    return IsWindowVisible(window);
                case NativePresentationStage.message_loop:
                    return RunMessageLoop();
                default: return false;
            }
            lastError = succeeded ? 0 : Marshal.GetLastWin32Error();
            return succeeded;
        }

        private bool RunMessageLoop()
        {
            Message message;
            while (true)
            {
                int status = GetMessage(out message, IntPtr.Zero, 0, 0);
                if (state.CallbackFailed) throw new InvalidOperationException();
                if (status <= 0) { lastError = status == -1 ? Marshal.GetLastWin32Error() : 0; return IsNormalMessageLoopExit(status, state.Dismissed); }
                if (TryHandleThreadMessage(message.message, message.wParam, delegate { state.Dismissed = true; DestroyWindow(window); }))
                    continue;
                if (message.message == 0x0100 && (int)message.wParam == VK_RETURN)
                    continue; // Enter must never copy the report accidentally.
                if (message.message == 0x0100 && (int)message.wParam == VK_TAB)
                {
                    IntPtr next = GetNextDlgTabItem(window, GetFocus(), IsShiftPressed());
                    if (next != IntPtr.Zero) SetFocus(next);
                    continue;
                }
                TranslateMessage(ref message);
                DispatchMessage(ref message);
            }
        }

        public override void Dispose()
        {
            if (window != IntPtr.Zero && IsWindow(window)) DestroyWindow(window);
            if (state.Handle.IsAllocated) state.Handle.Free();
        }
    }

    internal static bool IsNormalMessageLoopExit(int getMessageResult, bool dismissed)
    {
        return getMessageResult == 0 && dismissed;
    }

    /// <summary>Intercepts thread messages before child controls can consume a close request.</summary>
    internal static bool TryHandleThreadMessage(uint message, IntPtr wParam, Action requestClose)
    {
        if (message != 0x0100 || (int)wParam != VK_ESCAPE) return false;
        requestClose();
        return true;
    }

    /// <summary>Testable Copy Report command; it never alters the clipboard before invocation.</summary>
    internal static bool TryCopyReport(string report, IFailureReportClipboard clipboard)
    {
        try { return clipboard.TrySetText(report); }
        catch { return false; }
    }

    private static ushort RegisterClassOnce(string className, IntPtr instance)
    {
        var definition = new WindowClass
        {
            cbSize = (uint)Marshal.SizeOf<WindowClass>(),
            hInstance = instance,
            lpszClassName = className,
            lpfnWndProc = Marshal.GetFunctionPointerForDelegate(WindowProcedure),
            hCursor = LoadCursor(IntPtr.Zero, new IntPtr(32512)),
            hIcon = LoadIcon(IntPtr.Zero, new IntPtr(32513)),
            hbrBackground = GetSysColorBrush(COLOR_WINDOW),
        };
        ushort atom = RegisterClassEx(ref definition);
        return atom != 0 || Marshal.GetLastWin32Error() == 1410 ? (ushort)1 : (ushort)0;
    }

    private static IntPtr WindowProcedureImpl(IntPtr window, uint message, IntPtr wParam, IntPtr lParam)
    {
        try { return WindowProcedureCore(window, message, wParam, lParam); }
        catch
        {
            // Never unwind managed exceptions through the unmanaged callback.
            try { DialogState state = GetState(window); if (state != null) state.CallbackFailed = true; } catch { }
            PostQuitMessage(1);
            return IntPtr.Zero;
        }
    }

    private static IntPtr WindowProcedureCore(IntPtr window, uint message, IntPtr wParam, IntPtr lParam)
    {
        if (message == WM_NCCREATE)
        {
            var create = Marshal.PtrToStructure<CreateStruct>(lParam);
            IntPtr defaultResult = DefWindowProcW(window, message, wParam, lParam);
            if (defaultResult == IntPtr.Zero) return IntPtr.Zero;
            SetWindowLongPtr(window, GWLP_USERDATA, create.lpCreateParams);
            return defaultResult;
        }

        DialogState state = GetState(window);
        switch (message)
        {
            case WM_CREATE:
                SetWindowText(window, Title);
                return IntPtr.Zero;
            case WM_SIZE:
                if (state != null) Layout(window, state);
                return IntPtr.Zero;
            case WM_SETFOCUS:
                if (state != null && state.ReportControl != IntPtr.Zero) SetFocus(state.ReportControl);
                return IntPtr.Zero;
            case WM_GETMINMAXINFO:
                SetMinimumSize(window, lParam);
                return IntPtr.Zero;
            case WM_COMMAND:
                if (state != null) HandleCommand(window, state, LowWord(wParam));
                return IntPtr.Zero;
            case WM_CTLCOLORSTATIC:
                return GetSysColorBrush(COLOR_WINDOW);
            case 0x0100:
                if ((int)wParam == VK_ESCAPE) { if (state != null) state.Dismissed = true; DestroyWindow(window); }
                return IntPtr.Zero;
            case 0x0010: // WM_CLOSE: title-bar close / Alt+F4.
                if (state != null) state.Dismissed = true;
                DestroyWindow(window);
                return IntPtr.Zero;
            case WM_DESTROY:
                PostQuitMessage(0);
                return IntPtr.Zero;
        }
        return DefWindowProcW(window, message, wParam, lParam);
    }

    private static void CreateControls(IntPtr window, DialogState state)
    {
        IntPtr instance = GetModuleHandle(null);
        state.IconControl = CreateWindowEx(0, "Static", string.Empty, WS_CHILD | WS_VISIBLE | SS_ICON,
            0, 0, 0, 0, window, IntPtr.Zero, instance, IntPtr.Zero);
        SendMessage(state.IconControl, STM_SETICON, LoadIcon(IntPtr.Zero, new IntPtr(32513)), IntPtr.Zero);
        state.SummaryControl = CreateWindowEx(0, "Static", state.Summary, WS_CHILD | WS_VISIBLE,
            0, 0, 0, 0, window, IntPtr.Zero, instance, IntPtr.Zero);
        state.ReportLabel = CreateWindowEx(0, "Static", "Full diagnostic report:", WS_CHILD | WS_VISIBLE,
            0, 0, 0, 0, window, IntPtr.Zero, instance, IntPtr.Zero);
        state.ReportControl = CreateWindowEx(0, "Edit", state.Report,
            WS_CHILD | WS_VISIBLE | WS_TABSTOP | WS_BORDER | WS_VSCROLL | WS_HSCROLL |
            ES_MULTILINE | ES_AUTOVSCROLL | ES_AUTOHSCROLL | ES_READONLY,
            0, 0, 0, 0, window, new IntPtr(ReportId), instance, IntPtr.Zero);
        state.ReportError = state.ReportControl == IntPtr.Zero ? Marshal.GetLastWin32Error() : 0;
        state.StatusControl = CreateWindowEx(0, "Static", string.Empty, WS_CHILD | WS_VISIBLE,
            0, 0, 0, 0, window, IntPtr.Zero, instance, IntPtr.Zero);

        ShowWindow(state.StatusControl, 0);
    }

    private static void Layout(IntPtr window, DialogState state)
    {
        Rect client;
        GetClientRect(window, out client);
        int dpi = DpiForWindow(window);
        int pad = Scale(16, dpi);
        int icon = Scale(32, dpi);
        int line = Scale(22, dpi);
        int buttonHeight = Scale(30, dpi);
        int buttonWidth = Scale(110, dpi);
        int reportTop = pad + Math.Max(icon, line * 3) + Scale(30, dpi);
        int buttonTop = Math.Max(reportTop + Scale(120, dpi), client.bottom - pad - buttonHeight);
        int reportBottom = buttonTop - Scale(38, dpi);
        MoveWindow(state.IconControl, pad, pad, icon, icon, true);
        MoveWindow(state.SummaryControl, pad + icon + Scale(12, dpi), pad, Math.Max(100, client.right - (pad * 2) - icon - Scale(12, dpi)), line * 3, true);
        MoveWindow(state.ReportLabel, pad, reportTop - Scale(24, dpi), Math.Max(100, client.right - (pad * 2)), line, true);
        MoveWindow(state.ReportControl, pad, reportTop, Math.Max(100, client.right - (pad * 2)), Math.Max(80, reportBottom - reportTop), true);
        MoveWindow(state.StatusControl, pad, buttonTop + Scale(5, dpi), Math.Max(100, client.right - (pad * 2) - (buttonWidth * 2) - Scale(12, dpi)), line, true);
        MoveWindow(state.CopyControl, client.right - pad - (buttonWidth * 2) - Scale(8, dpi), buttonTop, buttonWidth, buttonHeight, true);
        MoveWindow(state.CloseControl, client.right - pad - buttonWidth, buttonTop, buttonWidth, buttonHeight, true);
    }

    private static void HandleCommand(IntPtr window, DialogState state, int id)
    {
        if (id == CloseId)
        {
            state.Dismissed = true;
            DestroyWindow(window);
            return;
        }
        if (id != CopyId) return;
        bool copied = TryCopyReport(state.Report, new WindowsClipboard(window));
        SetWindowText(state.StatusControl, copied ? "Report copied to clipboard" : "Unable to copy report");
        ShowWindow(state.StatusControl, SW_SHOW);
    }

    private static void SetMinimumSize(IntPtr window, IntPtr lParam)
    {
        var info = Marshal.PtrToStructure<MinMaxInfo>(lParam);
        int dpi = DpiForWindow(window);
        info.ptMinTrackSize.x = Scale(580, dpi);
        info.ptMinTrackSize.y = Scale(380, dpi);
        Marshal.StructureToPtr(info, lParam, false);
    }

    private static DialogState GetState(IntPtr window)
    {
        IntPtr value = GetWindowLongPtr(window, GWLP_USERDATA);
        return value == IntPtr.Zero ? null : GCHandle.FromIntPtr(value).Target as DialogState;
    }

    private static int LowWord(IntPtr value) { return unchecked((ushort)value.ToInt64()); }
    private static int Scale(int value, int dpi) { return (value * dpi) / 96; }
    private static bool IsShiftPressed() { return (GetKeyState(0x10) & 0x8000) != 0; }
    private static int SystemDpi()
    {
        try { return checked((int)GetDpiForSystem()); }
        catch (EntryPointNotFoundException) { return 96; }
    }
    private static int DpiForWindow(IntPtr window)
    {
        try { return checked((int)GetDpiForWindow(window)); }
        catch (EntryPointNotFoundException) { return SystemDpi(); }
    }
    private static void FlashWindow(IntPtr window)
    {
        var info = new FlashInfo { cbSize = (uint)Marshal.SizeOf<FlashInfo>(), hwnd = window, dwFlags = 0x00000003, uCount = 3, dwTimeout = 0 };
        FlashWindowEx(ref info);
    }

    internal interface IFailureReportClipboard
    {
        bool TrySetText(string text);
    }

    private sealed class WindowsClipboard : IFailureReportClipboard
    {
        private readonly IntPtr _owner;

        public WindowsClipboard(IntPtr owner) { _owner = owner; }

        public bool TrySetText(string text)
        {
            IntPtr memory = IntPtr.Zero;
            bool transferred = false;
            try
            {
                if (!OpenClipboard(_owner)) return false;
                if (!EmptyClipboard()) return false;
                byte[] bytes = Encoding.Unicode.GetBytes(text + '\0');
                memory = GlobalAlloc(GMEM_MOVEABLE, (UIntPtr)bytes.Length);
                if (memory == IntPtr.Zero) return false;
                IntPtr target = GlobalLock(memory);
                if (target == IntPtr.Zero) return false;
                Marshal.Copy(bytes, 0, target, bytes.Length);
                GlobalUnlock(memory);
                if (SetClipboardData(CF_UNICODETEXT, memory) == IntPtr.Zero) return false;
                transferred = true;
                return true;
            }
            catch { return false; }
            finally
            {
                if (memory != IntPtr.Zero && !transferred) GlobalFree(memory);
                CloseClipboard();
            }
        }
    }

    private sealed class DialogState
    {
        public DialogState(string summary, string report) { Summary = summary; Report = report; }
        public string Summary { get; private set; }
        public string Report { get; private set; }
        public GCHandle Handle;
        public int ReportError;
        public bool Dismissed;
        public bool CallbackFailed;
        public IntPtr IconControl;
        public IntPtr SummaryControl;
        public IntPtr ReportLabel;
        public IntPtr ReportControl;
        public IntPtr StatusControl;
        public IntPtr CopyControl;
        public IntPtr CloseControl;
        public IEnumerable<IntPtr> Controls { get { return new[] { IconControl, SummaryControl, ReportLabel, ReportControl, StatusControl, CopyControl, CloseControl }; } }
    }

    [UnmanagedFunctionPointer(CallingConvention.Winapi)]
    private delegate IntPtr WindowProc(IntPtr window, uint message, IntPtr wParam, IntPtr lParam);
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)] private struct WindowClass { public uint cbSize; public uint style; public IntPtr lpfnWndProc; public int cbClsExtra; public int cbWndExtra; public IntPtr hInstance; public IntPtr hIcon; public IntPtr hCursor; public IntPtr hbrBackground; public string lpszMenuName; public string lpszClassName; public IntPtr hIconSm; }
    [StructLayout(LayoutKind.Sequential)] private struct CreateStruct { public IntPtr lpCreateParams; public IntPtr hInstance; public IntPtr hMenu; public IntPtr hwndParent; public int cy; public int cx; public int y; public int x; public int style; public IntPtr lpszName; public IntPtr lpszClass; public uint dwExStyle; }
    [StructLayout(LayoutKind.Sequential)] private struct Message { public IntPtr hwnd; public uint message; public IntPtr wParam; public IntPtr lParam; public uint time; public Point pt; public uint lPrivate; }
    [StructLayout(LayoutKind.Sequential)] private struct Point { public int x; public int y; }
    [StructLayout(LayoutKind.Sequential)] private struct Rect { public int left; public int top; public int right; public int bottom; }
    [StructLayout(LayoutKind.Sequential)] private struct MinMaxInfo { public Point ptReserved; public Point ptMaxSize; public Point ptMaxPosition; public Point ptMinTrackSize; public Point ptMaxTrackSize; }
    [StructLayout(LayoutKind.Sequential)] private struct FlashInfo { public uint cbSize; public IntPtr hwnd; public uint dwFlags; public uint uCount; public uint dwTimeout; }

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] private static extern IntPtr GetModuleHandle(string moduleName);
    [DllImport("user32.dll", EntryPoint = "RegisterClassExW", CharSet = CharSet.Unicode, ExactSpelling = true, SetLastError = true)] private static extern ushort RegisterClassEx(ref WindowClass windowClass);
    [DllImport("user32.dll", EntryPoint = "CreateWindowExW", CharSet = CharSet.Unicode, ExactSpelling = true, SetLastError = true)] private static extern IntPtr CreateWindowEx(uint extendedStyle, string className, string title, uint style, int x, int y, int width, int height, IntPtr parent, IntPtr menu, IntPtr instance, IntPtr parameter);
    [DllImport("user32.dll", EntryPoint = "DefWindowProcW", CharSet = CharSet.Unicode, ExactSpelling = true)] private static extern IntPtr DefWindowProcW(IntPtr window, uint message, IntPtr wParam, IntPtr lParam);
    [DllImport("user32.dll")] private static extern bool DestroyWindow(IntPtr window);
    [DllImport("user32.dll")] private static extern bool ShowWindow(IntPtr window, int command);
    [DllImport("user32.dll")] private static extern bool UpdateWindow(IntPtr window);
    [DllImport("user32.dll")] private static extern bool SetWindowPos(IntPtr window, IntPtr insertAfter, int x, int y, int width, int height, uint flags);
    [DllImport("user32.dll")] private static extern bool SetForegroundWindow(IntPtr window);
    [DllImport("user32.dll", SetLastError = true)] private static extern int GetMessage(out Message message, IntPtr window, uint minimum, uint maximum);
    [DllImport("user32.dll")] private static extern bool IsWindowVisible(IntPtr window);
    [DllImport("user32.dll")] private static extern bool IsWindow(IntPtr window);
    [DllImport("user32.dll")] private static extern bool TranslateMessage(ref Message message);
    [DllImport("user32.dll")] private static extern IntPtr DispatchMessage(ref Message message);
    [DllImport("user32.dll")] private static extern void PostQuitMessage(int exitCode);
    [DllImport("user32.dll", EntryPoint = "SetWindowTextW", CharSet = CharSet.Unicode, ExactSpelling = true)] private static extern bool SetWindowText(IntPtr window, string text);
    [DllImport("user32.dll")] private static extern IntPtr SendMessage(IntPtr window, uint message, IntPtr wParam, IntPtr lParam);
    [DllImport("user32.dll")] private static extern bool MoveWindow(IntPtr window, int x, int y, int width, int height, bool repaint);
    [DllImport("user32.dll")] private static extern bool GetClientRect(IntPtr window, out Rect rect);
    [DllImport("user32.dll")] private static extern IntPtr GetWindowLongPtr(IntPtr window, int index);
    [DllImport("user32.dll")] private static extern IntPtr SetWindowLongPtr(IntPtr window, int index, IntPtr value);
    [DllImport("user32.dll")] private static extern IntPtr GetFocus();
    [DllImport("user32.dll")] private static extern IntPtr SetFocus(IntPtr window);
    [DllImport("user32.dll")] private static extern IntPtr GetNextDlgTabItem(IntPtr dialog, IntPtr control, bool previous);
    [DllImport("user32.dll")] private static extern short GetKeyState(int key);
    [DllImport("user32.dll")] private static extern IntPtr LoadCursor(IntPtr instance, IntPtr cursor);
    [DllImport("user32.dll")] private static extern IntPtr LoadIcon(IntPtr instance, IntPtr icon);
    [DllImport("user32.dll")] private static extern bool FlashWindowEx(ref FlashInfo info);
    [DllImport("user32.dll")] private static extern uint GetDpiForSystem();
    [DllImport("user32.dll")] private static extern uint GetDpiForWindow(IntPtr window);
    [DllImport("user32.dll")] private static extern IntPtr GetSysColorBrush(int color);
    [DllImport("gdi32.dll")] private static extern IntPtr GetStockObject(int objectIndex);
    [DllImport("user32.dll")] private static extern bool OpenClipboard(IntPtr owner);
    [DllImport("user32.dll")] private static extern bool CloseClipboard();
    [DllImport("user32.dll")] private static extern bool EmptyClipboard();
    [DllImport("user32.dll")] private static extern IntPtr SetClipboardData(uint format, IntPtr memory);
    [DllImport("kernel32.dll")] private static extern IntPtr GlobalAlloc(uint flags, UIntPtr bytes);
    [DllImport("kernel32.dll")] private static extern IntPtr GlobalLock(IntPtr memory);
    [DllImport("kernel32.dll")] private static extern bool GlobalUnlock(IntPtr memory);
    [DllImport("kernel32.dll")] private static extern IntPtr GlobalFree(IntPtr memory);
}

}
