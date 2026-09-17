using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Text;
using OpenLocally;

namespace OpenLocally.ManualVisualProof;

internal sealed record LocalDropResult(
    bool DropReceived,
    int Count,
    IReadOnlyList<string> Paths,
    uint Effect,
    long Sequence,
    DateTime TimestampUtc,
    string? Error);

[ComVisible(true)]
[Guid("00000122-0000-0000-C000-000000000046")]
[InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
internal interface ILocalOleDropTarget
{
    [PreserveSig]
    int DragEnter(
        [MarshalAs(UnmanagedType.Interface)] IFileDropDataObject dataObject,
        uint keyState,
        NativePoint point,
        ref uint effect);

    [PreserveSig]
    int DragOver(uint keyState, NativePoint point, ref uint effect);

    [PreserveSig]
    int DragLeave();

    [PreserveSig]
    int Drop(
        [MarshalAs(UnmanagedType.Interface)] IFileDropDataObject dataObject,
        uint keyState,
        NativePoint point,
        ref uint effect);
}

[StructLayout(LayoutKind.Sequential)]
internal readonly struct NativePoint(int x, int y)
{
    public readonly int X = x;
    public readonly int Y = y;
}

internal interface IStorageMediumReleaser
{
    void Release(ref StgMedium medium);
}

internal sealed class NativeStorageMediumReleaser : IStorageMediumReleaser
{
    internal static NativeStorageMediumReleaser Instance { get; } = new();

    public void Release(ref StgMedium medium) => ReleaseStgMedium(ref medium);

    [DllImport("ole32.dll")]
    private static extern void ReleaseStgMedium(ref StgMedium medium);
}

internal sealed class LocalFileDropDecoder(IStorageMediumReleaser? releaser = null)
{
    private const uint DvaspectContent = 1;
    private const uint TymedHGlobal = 1;
    private readonly IStorageMediumReleaser _releaser = releaser ?? NativeStorageMediumReleaser.Instance;

    internal bool HasFileDrop(IFileDropDataObject dataObject)
    {
        ArgumentNullException.ThrowIfNull(dataObject);
        FormatEtc format = RequiredFormat();
        return dataObject.QueryGetData(ref format) == 0;
    }

    internal IReadOnlyList<string> Decode(IFileDropDataObject dataObject)
    {
        ArgumentNullException.ThrowIfNull(dataObject);
        FormatEtc format = RequiredFormat();
        int query = dataObject.QueryGetData(ref format);
        if (query != 0)
            throw new InvalidOperationException($"Incoming IDataObject does not provide CF_HDROP (0x{query:X8}).");

        int get = dataObject.GetData(ref format, out StgMedium medium);
        if (get != 0)
            throw new InvalidOperationException($"Incoming IDataObject GetData(CF_HDROP) failed (0x{get:X8}).");

        try
        {
            if (medium.tymed != TymedHGlobal || medium.unionMember == IntPtr.Zero)
                throw new InvalidOperationException("Incoming CF_HDROP did not return TYMED_HGLOBAL storage.");

            uint count = DragQueryFile(medium.unionMember, uint.MaxValue, null, 0);
            var paths = new string[checked((int)count)];
            for (uint index = 0; index < count; index++)
            {
                uint length = DragQueryFile(medium.unionMember, index, null, 0);
                var path = new StringBuilder(checked((int)length + 1));
                uint copied = DragQueryFile(medium.unionMember, index, path, checked((uint)path.Capacity));
                if (copied != length)
                    throw new InvalidOperationException($"DragQueryFileW failed while decoding item {index}.");
                paths[checked((int)index)] = path.ToString();
            }
            return paths;
        }
        finally
        {
            _releaser.Release(ref medium);
        }
    }

    private static FormatEtc RequiredFormat() => new()
    {
        cfFormat = FileDropHGlobal.CfHDrop,
        ptd = IntPtr.Zero,
        dwAspect = DvaspectContent,
        lindex = -1,
        tymed = TymedHGlobal,
    };

    [DllImport("shell32.dll", EntryPoint = "DragQueryFileW", CharSet = CharSet.Unicode)]
    private static extern uint DragQueryFile(
        IntPtr drop,
        uint fileIndex,
        StringBuilder? fileName,
        uint characterCount);
}

[ComVisible(true)]
[ClassInterface(ClassInterfaceType.None)]
internal sealed class LocalOleDropTarget : ILocalOleDropTarget
{
    private const int S_OK = 0;
    private const uint DropEffectNone = 0;
    private readonly LocalFileDropDecoder _decoder;
    private long _sequence;
    private bool _canCopy;

    internal LocalOleDropTarget(LocalFileDropDecoder? decoder = null) =>
        _decoder = decoder ?? new LocalFileDropDecoder();

    internal event Action<LocalDropResult>? ResultReceived;
    internal LocalDropResult? LastResult { get; private set; }

    public int DragEnter(IFileDropDataObject dataObject, uint keyState, NativePoint point, ref uint effect)
    {
        _canCopy = (effect & WindowsFileDrag.DropEffectCopy) != 0 && _decoder.HasFileDrop(dataObject);
        effect = _canCopy ? WindowsFileDrag.DropEffectCopy : DropEffectNone;
        return S_OK;
    }

    public int DragOver(uint keyState, NativePoint point, ref uint effect)
    {
        effect = _canCopy && (effect & WindowsFileDrag.DropEffectCopy) != 0
            ? WindowsFileDrag.DropEffectCopy
            : DropEffectNone;
        return S_OK;
    }

    public int DragLeave()
    {
        _canCopy = false;
        return S_OK;
    }

    public int Drop(IFileDropDataObject dataObject, uint keyState, NativePoint point, ref uint effect)
    {
        uint acceptedEffect = _canCopy && (effect & WindowsFileDrag.DropEffectCopy) != 0
            ? WindowsFileDrag.DropEffectCopy
            : DropEffectNone;
        LocalDropResult result;
        try
        {
            if (acceptedEffect == DropEffectNone || !_decoder.HasFileDrop(dataObject))
                throw new InvalidOperationException("Incoming IDataObject does not provide an acceptable copy CF_HDROP.");
            IReadOnlyList<string> paths = _decoder.Decode(dataObject);
            result = new LocalDropResult(
                true, paths.Count, paths, acceptedEffect, Interlocked.Increment(ref _sequence),
                DateTime.UtcNow, null);
        }
        catch (Exception exception)
        {
            acceptedEffect = DropEffectNone;
            result = new LocalDropResult(
                false, 0, [], acceptedEffect, Interlocked.Increment(ref _sequence),
                DateTime.UtcNow, exception.Message);
        }
        finally
        {
            _canCopy = false;
        }

        effect = acceptedEffect;
        LastResult = result;
        ResultReceived?.Invoke(result);
        return S_OK;
    }
}

internal interface ILocalDropRegistrationNative
{
    int Register(IntPtr window, ILocalOleDropTarget target);
    int Revoke(IntPtr window);
}

internal sealed class NativeLocalDropRegistration : ILocalDropRegistrationNative
{
    internal static NativeLocalDropRegistration Instance { get; } = new();

    public int Register(IntPtr window, ILocalOleDropTarget target) => RegisterDragDrop(window, target);
    public int Revoke(IntPtr window) => RevokeDragDrop(window);

    [DllImport("ole32.dll")]
    private static extern int RegisterDragDrop(
        IntPtr window,
        [MarshalAs(UnmanagedType.Interface)] ILocalOleDropTarget target);

    [DllImport("ole32.dll")]
    private static extern int RevokeDragDrop(IntPtr window);
}

internal sealed class LocalDropRegistration : IDisposable
{
    private readonly IntPtr _window;
    private readonly ILocalDropRegistrationNative _native;
    private ILocalOleDropTarget? _target;

    internal LocalDropRegistration(
        IntPtr window,
        ILocalOleDropTarget target,
        ILocalDropRegistrationNative? native = null)
    {
        if (window == IntPtr.Zero) throw new ArgumentException("A real target HWND is required.", nameof(window));
        _window = window;
        _native = native ?? NativeLocalDropRegistration.Instance;
        int result = _native.Register(window, target ?? throw new ArgumentNullException(nameof(target)));
        if (result != 0) Marshal.ThrowExceptionForHR(result);
        RegistrationResult = result;
        _target = target;
    }

    internal bool Registered => _target is not null;
    internal IntPtr RegisteredWindow => _window;
    internal int RegistrationResult { get; }
    internal bool Revoked { get; private set; }

    public void Dispose()
    {
        if (Interlocked.Exchange(ref _target, null) is null) return;
        int result = _native.Revoke(_window);
        if (result != 0) Marshal.ThrowExceptionForHR(result);
        Revoked = true;
    }
}

internal sealed record LocalDropTargetWindowProbe(
    IntPtr VisibleWindow,
    IntPtr RegisteredWindow,
    int RegisterDragDropResult,
    bool Visible,
    bool Enabled,
    bool WindowRectAvailable,
    NativeRectangle WindowRect,
    bool WindowRectNonEmpty,
    bool ClientRectAvailable,
    NativeRectangle ClientRect,
    bool ClientRectNonEmpty,
    NativePoint ClientCenter,
    bool ClientCenterInside,
    bool ClientToScreenSucceeded,
    int ClientToScreenError,
    NativePoint ScreenCenter,
    IntPtr WindowAtClientPoint,
    int ClientHitTest,
    IntPtr CompanionWindow,
    bool CompanionWindowRectAvailable,
    NativeRectangle CompanionWindowRect,
    IntPtr Parent,
    IntPtr Owner,
    IntPtr ForegroundWindow,
    IntPtr WindowAbove,
    nint Style,
    nint ExtendedStyle,
    int WindowRegionType,
    bool Registered,
    bool VerificationPositioned,
    int VerificationPositionError,
    int Attempts)
{
    internal const int HtClient = 1;
    internal const int HitTestUnavailable = int.MinValue;

    internal bool WindowFromPointMatches =>
        ClientToScreenSucceeded && WindowAtClientPoint == VisibleWindow;
    internal bool ClientHitTestMatches => ClientHitTest == HtClient;
    internal bool HitTestable =>
        VerificationPositioned && Visible && Enabled &&
        VisibleWindow != IntPtr.Zero && VisibleWindow == RegisteredWindow &&
        RegisterDragDropResult == 0 && Registered &&
        WindowRectAvailable && WindowRectNonEmpty &&
        ClientRectAvailable && ClientRectNonEmpty && ClientCenterInside &&
        ClientToScreenSucceeded && WindowFromPointMatches && ClientHitTestMatches;

    internal string FailedConjuncts()
    {
        var failures = new List<string>();
        if (!VerificationPositioned) failures.Add($"verification-positioned(error={VerificationPositionError})");
        if (!Visible) failures.Add("target-visible");
        if (!Enabled) failures.Add("target-enabled");
        if (VisibleWindow == IntPtr.Zero) failures.Add("target-hwnd-nonzero");
        if (VisibleWindow != RegisteredWindow) failures.Add("registered-hwnd-equals-target");
        if (RegisterDragDropResult != 0) failures.Add($"register-drag-drop-hr=0x{RegisterDragDropResult:X8}");
        if (!Registered) failures.Add("target-registered");
        if (!WindowRectAvailable) failures.Add("get-window-rect");
        else if (!WindowRectNonEmpty) failures.Add("window-rect-nonempty");
        if (!ClientRectAvailable) failures.Add("get-client-rect");
        else
        {
            if (!ClientRectNonEmpty) failures.Add("client-rect-nonempty");
            if (!ClientCenterInside) failures.Add("client-center-inside");
        }
        if (!ClientToScreenSucceeded) failures.Add($"client-to-screen(error={ClientToScreenError})");
        if (ClientToScreenSucceeded && !WindowFromPointMatches)
            failures.Add($"window-from-point-equals-target(actual=0x{WindowAtClientPoint.ToInt64():X})");
        if (!ClientHitTestMatches)
            failures.Add(ClientHitTest == HitTestUnavailable
                ? "wm-nchittest-unavailable"
                : $"wm-nchittest-htclient(actual={ClientHitTest})");
        return failures.Count == 0 ? "none" : string.Join(',', failures);
    }
}

internal readonly record struct NativeRectangle(int Left, int Top, int Right, int Bottom)
{
    internal int Width => Right - Left;
    internal int Height => Bottom - Top;
    internal bool NonEmpty => Width > 0 && Height > 0;
    public override string ToString() => $"({Left},{Top})-({Right},{Bottom})[{Width}x{Height}]";
}

internal sealed class LocalDropTargetWindow : IDisposable
{
    private const uint WmClose = 0x0010;
    private const uint WmLButtonDown = 0x0201;
    private const uint WmNcHitTest = 0x0084;
    private const uint WsOverlappedWindow = 0x00CF0000;
    private const uint WsVisible = 0x10000000;
    private const uint SsLeft = 0x00000000;
    private const uint SsNotify = 0x00000100;
    private const int GwlpStyle = -16;
    private const int GwlpExtendedStyle = -20;
    private const uint GwOwner = 4;
    private const uint GwHwndPrev = 3;
    private const uint SwpNoActivate = 0x0010;
    private const uint SwpShowWindow = 0x0040;
    private const uint MonitorDefaultToNearest = 2;
    private static readonly IntPtr HwndTop = IntPtr.Zero;
    private readonly LocalDropRegistration _registration;
    private bool _disposed;

    private LocalDropTargetWindow(IntPtr handle, LocalOleDropTarget target, LocalDropRegistration registration)
    {
        Handle = handle;
        Target = target;
        _registration = registration;
        target.ResultReceived += OnResultReceived;
    }

    internal IntPtr Handle { get; }
    internal LocalOleDropTarget Target { get; }
    internal bool Registered => _registration.Registered;
    internal bool Revoked => _registration.Revoked;

    internal static LocalDropTargetWindow Create(IntPtr companionWindow)
    {
        const int width = 560, height = 300;
        GetWindowRect(companionWindow, out NativeRect companion);
        int screenWidth = GetSystemMetrics(0);
        int screenHeight = GetSystemMetrics(1);
        int x = companion.Right + 20;
        if (x + width > screenWidth) x = Math.Max(0, screenWidth - width - 20);
        int y = Math.Max(0, Math.Min(companion.Top + 80, screenHeight - height - 40));
        IntPtr handle = CreateWindowEx(
            0, "STATIC",
            "CreatorCrate local OLE drop proof\r\n\r\nDrop selected CreatorCrate assets here.\r\n\r\nNo drop received.",
            WsOverlappedWindow | WsVisible | SsLeft | SsNotify,
            x, y, width, height,
            companionWindow, IntPtr.Zero, GetModuleHandle(null), IntPtr.Zero);
        if (handle == IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error());

        try
        {
            if (!SetWindowSubclass(handle, TargetWindowProcedure, UIntPtr.Zero, UIntPtr.Zero))
                throw new Win32Exception(Marshal.GetLastWin32Error());
            var target = new LocalOleDropTarget();
            var registration = new LocalDropRegistration(handle, target);
            ShowWindow(handle, 5);
            UpdateWindow(handle);
            return new LocalDropTargetWindow(handle, target, registration);
        }
        catch
        {
            RemoveWindowSubclass(handle, TargetWindowProcedure, UIntPtr.Zero);
            DestroyWindow(handle);
            throw;
        }
    }

    internal void SetDisplay(string text)
    {
        if (!_disposed && IsWindow(Handle)) SetWindowText(Handle, text);
    }

    internal LocalDropTargetWindowProbe WaitForHitTestable(
        IntPtr companionWindow,
        TimeSpan timeout,
        TimeSpan retryInterval)
    {
        DateTime deadline = DateTime.UtcNow + timeout;
        LocalDropTargetWindowProbe? last = null;
        int attempts = 0;
        do
        {
            attempts++;
            (bool positioned, int positionError) = PositionForVerification(companionWindow);
            last = CaptureProbe(companionWindow, positioned, positionError, attempts);
            if (last.HitTestable) return last;
            if (DateTime.UtcNow >= deadline) return last;
            Thread.Sleep(retryInterval);
        } while (true);
    }

    internal LocalDropTargetWindowProbe CaptureProbe(
        IntPtr companionWindow = default,
        bool verificationPositioned = true,
        int verificationPositionError = 0,
        int attempts = 1)
    {
        bool windowRectAvailable = GetWindowRect(Handle, out NativeRect windowRectNative);
        NativeRectangle windowRect = Rectangle(windowRectNative);
        bool clientRectAvailable = GetClientRect(Handle, out NativeRect clientRectNative);
        NativeRectangle clientRect = Rectangle(clientRectNative);
        var clientCenter = clientRectAvailable
            ? new NativePoint(clientRect.Left + clientRect.Width / 2, clientRect.Top + clientRect.Height / 2)
            : default;
        bool clientCenterInside = clientRectAvailable && clientRect.NonEmpty &&
            clientCenter.X >= clientRect.Left && clientCenter.X < clientRect.Right &&
            clientCenter.Y >= clientRect.Top && clientCenter.Y < clientRect.Bottom;
        var screenCenter = clientCenter;
        Marshal.SetLastPInvokeError(0);
        bool clientToScreenSucceeded = clientCenterInside && ClientToScreen(Handle, ref screenCenter);
        int clientToScreenError = clientToScreenSucceeded ? 0 : Marshal.GetLastPInvokeError();
        IntPtr windowAtPoint = clientToScreenSucceeded ? WindowFromPoint(screenCenter) : IntPtr.Zero;
        int clientHitTest = LocalDropTargetWindowProbe.HitTestUnavailable;
        if (clientToScreenSucceeded)
        {
            IntPtr coordinate = new(unchecked((screenCenter.Y << 16) | (screenCenter.X & 0xffff)));
            clientHitTest = unchecked((int)SendMessage(Handle, WmNcHitTest, IntPtr.Zero, coordinate).ToInt64());
        }
        NativeRect companionRectNative = default;
        bool companionRectAvailable = companionWindow != IntPtr.Zero &&
            GetWindowRect(companionWindow, out companionRectNative);
        NativeRectangle companionRect = Rectangle(companionRectNative);
        IntPtr region = CreateRectRgn(0, 0, 0, 0);
        if (region == IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error());
        int regionType;
        try { regionType = GetWindowRgn(Handle, region); }
        finally { DeleteObject(region); }
        return new LocalDropTargetWindowProbe(
            Handle,
            _registration.RegisteredWindow,
            _registration.RegistrationResult,
            IsWindowVisible(Handle),
            IsWindowEnabled(Handle),
            windowRectAvailable,
            windowRect,
            windowRectAvailable && windowRect.NonEmpty,
            clientRectAvailable,
            clientRect,
            clientRectAvailable && clientRect.NonEmpty,
            clientCenter,
            clientCenterInside,
            clientToScreenSucceeded,
            clientToScreenError,
            screenCenter,
            windowAtPoint,
            clientHitTest,
            companionWindow,
            companionRectAvailable,
            companionRect,
            GetParent(Handle),
            GetWindow(Handle, GwOwner),
            GetForegroundWindow(),
            GetWindow(Handle, GwHwndPrev),
            GetWindowLongPtr(Handle, GwlpStyle),
            GetWindowLongPtr(Handle, GwlpExtendedStyle),
            regionType,
            Registered,
            verificationPositioned,
            verificationPositionError,
            attempts);
    }

    private (bool Positioned, int Error) PositionForVerification(IntPtr companionWindow)
    {
        if (!GetWindowRect(Handle, out NativeRect target) || !GetWindowRect(companionWindow, out NativeRect companion))
            return (false, Marshal.GetLastPInvokeError());
        IntPtr monitor = MonitorFromWindow(companionWindow, MonitorDefaultToNearest);
        var monitorInfo = new MonitorInfo { Size = (uint)Marshal.SizeOf<MonitorInfo>() };
        if (monitor == IntPtr.Zero || !GetMonitorInfo(monitor, ref monitorInfo))
            return (false, Marshal.GetLastPInvokeError());

        NativeRect work = monitorInfo.Work;
        int width = target.Right - target.Left;
        int height = target.Bottom - target.Top;
        if (width <= 0 || height <= 0 || work.Right <= work.Left || work.Bottom <= work.Top)
            return (false, 0);
        (int x, int y) = VerificationPosition(companion, work, width, height);
        Marshal.SetLastPInvokeError(0);
        bool positioned = SetWindowPos(
            Handle, HwndTop, x, y, width, height, SwpNoActivate | SwpShowWindow);
        int error = positioned ? 0 : Marshal.GetLastPInvokeError();
        if (positioned) UpdateWindow(Handle);
        return (positioned, error);
    }

    private static (int X, int Y) VerificationPosition(
        NativeRect companion,
        NativeRect work,
        int width,
        int height)
    {
        const int gap = 16;
        int yBeside = Math.Clamp(companion.Top, work.Top, Math.Max(work.Top, work.Bottom - height));
        if (companion.Right + gap + width <= work.Right) return (companion.Right + gap, yBeside);
        if (companion.Left - gap - width >= work.Left) return (companion.Left - gap - width, yBeside);

        int xAboveOrBelow = Math.Clamp(companion.Left, work.Left, Math.Max(work.Left, work.Right - width));
        if (companion.Bottom + gap + height <= work.Bottom) return (xAboveOrBelow, companion.Bottom + gap);
        if (companion.Top - gap - height >= work.Top) return (xAboveOrBelow, companion.Top - gap - height);

        return (
            Math.Clamp(companion.Left + gap, work.Left, Math.Max(work.Left, work.Right - width)),
            Math.Clamp(companion.Top + gap, work.Top, Math.Max(work.Top, work.Bottom - height)));
    }

    private static NativeRectangle Rectangle(NativeRect rectangle) =>
        new(rectangle.Left, rectangle.Top, rectangle.Right, rectangle.Bottom);

    private void OnResultReceived(LocalDropResult result) => SetDisplay(result.DropReceived
        ? $"CreatorCrate local OLE drop proof\r\n\r\nReceived {result.Count} file{(result.Count == 1 ? string.Empty : "s")}.\r\n\r\nChecking release order in console…"
        : $"CreatorCrate local OLE drop proof\r\n\r\nDROP FAIL\r\n\r\n{result.Error}");

    public void Dispose()
    {
        if (_disposed) return;
        _disposed = true;
        Target.ResultReceived -= OnResultReceived;
        Exception? failure = null;
        try { _registration.Dispose(); }
        catch (Exception exception) { failure = exception; }
        RemoveWindowSubclass(Handle, TargetWindowProcedure, UIntPtr.Zero);
        if (IsWindow(Handle) && !DestroyWindow(Handle) && failure is null)
            failure = new Win32Exception(Marshal.GetLastWin32Error());
        if (failure is not null) throw failure;
    }

    [DllImport("user32.dll", EntryPoint = "CreateWindowExW", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern IntPtr CreateWindowEx(
        uint extendedStyle, string className, string windowName, uint style,
        int x, int y, int width, int height, IntPtr parent, IntPtr menu, IntPtr instance, IntPtr parameter);

    [DllImport("user32.dll", EntryPoint = "SetWindowTextW", CharSet = CharSet.Unicode)]
    private static extern bool SetWindowText(IntPtr window, string text);

    [DllImport("user32.dll")]
    private static extern bool ShowWindow(IntPtr window, int command);

    [DllImport("user32.dll")]
    private static extern bool UpdateWindow(IntPtr window);

    [DllImport("user32.dll", SetLastError = true)]
    private static extern bool DestroyWindow(IntPtr window);

    [DllImport("user32.dll")]
    private static extern bool IsWindow(IntPtr window);

    [DllImport("user32.dll", SetLastError = true)]
    private static extern bool GetWindowRect(IntPtr window, out NativeRect rectangle);

    [DllImport("user32.dll")]
    private static extern int GetSystemMetrics(int index);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)]
    private static extern IntPtr GetModuleHandle(string? moduleName);

    [DllImport("comctl32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool SetWindowSubclass(
        IntPtr window, SubclassProcedure procedure, UIntPtr subclassId, UIntPtr referenceData);

    [DllImport("comctl32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool RemoveWindowSubclass(
        IntPtr window, SubclassProcedure procedure, UIntPtr subclassId);

    [DllImport("comctl32.dll")]
    private static extern IntPtr DefSubclassProc(IntPtr window, uint message, IntPtr wParam, IntPtr lParam);

    private delegate IntPtr SubclassProcedure(
        IntPtr window, uint message, IntPtr wParam, IntPtr lParam,
        UIntPtr subclassId, UIntPtr referenceData);

    private static readonly SubclassProcedure TargetWindowProcedure = TargetWindowProcedureCore;

    private static IntPtr TargetWindowProcedureCore(
        IntPtr window, uint message, IntPtr wParam, IntPtr lParam,
        UIntPtr subclassId, UIntPtr referenceData)
    {
        if (message == WmClose) return IntPtr.Zero;
        if (message == WmLButtonDown)
        {
            SetForegroundWindow(window);
            SetFocus(window);
            SetWindowText(window,
                "CreatorCrate local OLE drop proof\r\n\r\nCLICK RECEIVED — target is interactive.\r\n\r\nDrop selected CreatorCrate assets here.");
            Console.WriteLine($"drop-target-click-received=true; hwnd=0x{window.ToInt64():X}");
            return IntPtr.Zero;
        }
        return DefSubclassProc(window, message, wParam, lParam);
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct NativeRect
    {
        public int Left, Top, Right, Bottom;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct MonitorInfo
    {
        public uint Size;
        public NativeRect Monitor;
        public NativeRect Work;
        public uint Flags;
    }

    [DllImport("user32.dll", SetLastError = true)]
    private static extern bool GetClientRect(IntPtr window, out NativeRect rectangle);

    [DllImport("user32.dll", SetLastError = true)]
    private static extern bool ClientToScreen(IntPtr window, ref NativePoint point);

    [DllImport("user32.dll")]
    private static extern IntPtr WindowFromPoint(NativePoint point);

    [DllImport("user32.dll", SetLastError = true)]
    private static extern bool SetWindowPos(
        IntPtr window, IntPtr insertAfter, int x, int y, int width, int height, uint flags);

    [DllImport("user32.dll")]
    private static extern IntPtr MonitorFromWindow(IntPtr window, uint flags);

    [DllImport("user32.dll", EntryPoint = "GetMonitorInfoW", SetLastError = true)]
    private static extern bool GetMonitorInfo(IntPtr monitor, ref MonitorInfo information);

    [DllImport("user32.dll", EntryPoint = "SendMessageW")]
    private static extern IntPtr SendMessage(IntPtr window, uint message, IntPtr wParam, IntPtr lParam);

    [DllImport("user32.dll")]
    private static extern bool IsWindowVisible(IntPtr window);

    [DllImport("user32.dll")]
    private static extern bool IsWindowEnabled(IntPtr window);

    [DllImport("user32.dll")]
    private static extern IntPtr GetParent(IntPtr window);

    [DllImport("user32.dll")]
    private static extern IntPtr GetWindow(IntPtr window, uint command);

    [DllImport("user32.dll")]
    private static extern IntPtr GetForegroundWindow();

    [DllImport("user32.dll", EntryPoint = "GetWindowLongPtrW")]
    private static extern nint GetWindowLongPtr(IntPtr window, int index);

    [DllImport("user32.dll")]
    private static extern IntPtr SetFocus(IntPtr window);

    [DllImport("user32.dll")]
    private static extern bool SetForegroundWindow(IntPtr window);

    [DllImport("gdi32.dll", SetLastError = true)]
    private static extern IntPtr CreateRectRgn(int left, int top, int right, int bottom);

    [DllImport("user32.dll")]
    private static extern int GetWindowRgn(IntPtr window, IntPtr region);

    [DllImport("gdi32.dll")]
    private static extern bool DeleteObject(IntPtr value);
}
