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
    IntPtr WindowAtClientPoint,
    int ClientHitTest,
    IntPtr Parent,
    IntPtr Owner,
    nint Style,
    nint ExtendedStyle,
    int WindowRegionType,
    bool Registered);

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

    internal LocalDropTargetWindowProbe CaptureProbe()
    {
        if (!GetClientRect(Handle, out NativeRect client))
            throw new Win32Exception(Marshal.GetLastWin32Error());
        var point = new NativePoint(
            client.Left + (client.Right - client.Left) / 2,
            client.Top + (client.Bottom - client.Top) / 2);
        if (!ClientToScreen(Handle, ref point))
            throw new Win32Exception(Marshal.GetLastWin32Error());
        IntPtr coordinate = new(unchecked((point.Y << 16) | (point.X & 0xffff)));
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
            WindowFromPoint(point),
            unchecked((int)SendMessage(Handle, WmNcHitTest, IntPtr.Zero, coordinate).ToInt64()),
            GetParent(Handle),
            GetWindow(Handle, GwOwner),
            GetWindowLongPtr(Handle, GwlpStyle),
            GetWindowLongPtr(Handle, GwlpExtendedStyle),
            regionType,
            Registered);
    }

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

    [DllImport("user32.dll")]
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

    [DllImport("user32.dll", SetLastError = true)]
    private static extern bool GetClientRect(IntPtr window, out NativeRect rectangle);

    [DllImport("user32.dll", SetLastError = true)]
    private static extern bool ClientToScreen(IntPtr window, ref NativePoint point);

    [DllImport("user32.dll")]
    private static extern IntPtr WindowFromPoint(NativePoint point);

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
