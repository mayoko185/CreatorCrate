using System.Buffers.Binary;
using System.Runtime.InteropServices;
using System.Runtime.InteropServices.ComTypes;
using System.Text;

namespace OpenLocally;

internal static class FileDropHGlobal
{
    internal const short CfHDrop = 15;
    internal const int DropFilesSize = 20;
    private const uint GmemMoveable = 0x0002;

    public static byte[] BuildPayload(IReadOnlyList<string> paths)
    {
        ArgumentNullException.ThrowIfNull(paths);
        if (paths.Count == 0) throw new ArgumentException("At least one file path is required.", nameof(paths));

        foreach (string path in paths)
        {
            if (string.IsNullOrWhiteSpace(path) || path.Contains('\0') || !Path.IsPathFullyQualified(path))
                throw new ArgumentException("File-drop paths must be fully qualified.", nameof(paths));
        }

        int size = CalculatePayloadSize([.. paths.Select(path => path.Length)]);
        byte[] payload = new byte[size];
        BinaryPrimitives.WriteUInt32LittleEndian(payload.AsSpan(0, 4), DropFilesSize);
        BinaryPrimitives.WriteInt32LittleEndian(payload.AsSpan(16, 4), 1);
        int offset = DropFilesSize;
        foreach (string path in paths)
        {
            int bytes = Encoding.Unicode.GetBytes(path, payload.AsSpan(offset));
            offset = checked(offset + bytes + sizeof(char));
        }
        return payload;
    }

    internal static int CalculatePayloadSize(IReadOnlyList<int> pathLengths)
    {
        int characterCount = 1;
        foreach (int length in pathLengths)
        {
            if (length < 0) throw new ArgumentOutOfRangeException(nameof(pathLengths));
            characterCount = checked(characterCount + length + 1);
        }
        return checked(DropFilesSize + checked(characterCount * sizeof(char)));
    }

    public static IntPtr Allocate(IReadOnlyList<string> paths)
    {
        byte[] payload = BuildPayload(paths);
        IntPtr memory = GlobalAlloc(GmemMoveable, (UIntPtr)(uint)payload.Length);
        if (memory == IntPtr.Zero) throw new OutOfMemoryException("Unable to allocate the file-drop payload.");
        IntPtr locked = GlobalLock(memory);
        if (locked == IntPtr.Zero)
        {
            GlobalFree(memory);
            throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
        }
        try { Marshal.Copy(payload, 0, locked, payload.Length); }
        catch { GlobalUnlock(memory); GlobalFree(memory); throw; }
        GlobalUnlock(memory);
        return memory;
    }

    internal static void Free(IntPtr memory)
    {
        if (memory != IntPtr.Zero) GlobalFree(memory);
    }

    [DllImport("kernel32.dll", SetLastError = true)] private static extern IntPtr GlobalAlloc(uint flags, UIntPtr bytes);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern IntPtr GlobalLock(IntPtr memory);
    [DllImport("kernel32.dll")] private static extern bool GlobalUnlock(IntPtr memory);
    [DllImport("kernel32.dll")] private static extern IntPtr GlobalFree(IntPtr memory);
}

[ComImport, Guid("0000010e-0000-0000-C000-000000000046"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
internal interface IFileDropDataObject
{
    [PreserveSig] int GetData(ref FormatEtc format, out StgMedium medium);
    [PreserveSig] int GetDataHere(ref FormatEtc format, ref StgMedium medium);
    [PreserveSig] int QueryGetData(ref FormatEtc format);
    [PreserveSig] int GetCanonicalFormatEtc(ref FormatEtc input, out FormatEtc output);
    [PreserveSig] int SetData(ref FormatEtc format, ref StgMedium medium, [MarshalAs(UnmanagedType.Bool)] bool release);
    [PreserveSig] int EnumFormatEtc(uint direction, out IntPtr enumerator);
    [PreserveSig] int DAdvise(ref FormatEtc format, uint flags, IntPtr sink, out uint connection);
    [PreserveSig] int DUnadvise(uint connection);
    [PreserveSig] int EnumDAdvise(out IntPtr enumerator);
}

[ComImport, Guid("00000121-0000-0000-C000-000000000046"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
internal interface IFileDragDropSource
{
    [PreserveSig] int QueryContinueDrag([MarshalAs(UnmanagedType.Bool)] bool escapePressed, uint keyState);
    [PreserveSig] int GiveFeedback(uint effect);
}

[StructLayout(LayoutKind.Sequential)]
internal struct FormatEtc
{
    public short cfFormat;
    public IntPtr ptd;
    public uint dwAspect;
    public int lindex;
    public uint tymed;
}

[StructLayout(LayoutKind.Sequential)]
internal struct StgMedium
{
    public uint tymed;
    public IntPtr unionMember;
    public IntPtr pUnkForRelease;
}

[ComVisible(true), ClassInterface(ClassInterfaceType.None)]
internal sealed class FileDropFormatEnumerator : IEnumFORMATETC
{
    internal const int S_OK = 0;
    internal const int S_FALSE = 1;
    private const int FormatCount = 1;
    private int _position;

    public FileDropFormatEnumerator(int position = 0) => _position = position;

    public int Next(int count, FORMATETC[] formats, int[] fetched)
    {
        ArgumentNullException.ThrowIfNull(formats);
        if (count < 0 || formats.Length < count) throw new ArgumentOutOfRangeException(nameof(count));

        int copied = 0;
        if (count > 0 && _position < FormatCount)
        {
            formats[0] = FileDropDataObject.SupportedFormat;
            _position = FormatCount;
            copied = 1;
        }

        if (fetched is { Length: > 0 }) fetched[0] = copied;
        return copied == count ? S_OK : S_FALSE;
    }

    public int Skip(int count)
    {
        if (count < 0) throw new ArgumentOutOfRangeException(nameof(count));
        int remaining = FormatCount - _position;
        _position = Math.Min(FormatCount, _position + count);
        return count <= remaining ? S_OK : S_FALSE;
    }

    public int Reset()
    {
        _position = 0;
        return S_OK;
    }

    public void Clone(out IEnumFORMATETC newEnumerator) =>
        newEnumerator = new FileDropFormatEnumerator(_position);
}

[ComVisible(true), ClassInterface(ClassInterfaceType.None)]
internal sealed class FileDropDataObject : IFileDropDataObject
{
    internal const int S_OK = 0;
    internal const int E_NOTIMPL = unchecked((int)0x80004001);
    internal const int E_INVALIDARG = unchecked((int)0x80070057);
    internal const int E_OUTOFMEMORY = unchecked((int)0x8007000E);
    internal const int DV_E_FORMATETC = unchecked((int)0x80040064);
    internal const int DV_E_DVASPECT = unchecked((int)0x8004006B);
    internal const int DV_E_LINDEX = unchecked((int)0x80040068);
    internal const int DV_E_TYMED = unchecked((int)0x80040069);
    internal const uint DatadirGet = 1;
    internal const uint DatadirSet = 2;
    private const uint DvaspectContent = 1;
    internal const uint TymedHGlobal = 1;
    private readonly string[] _paths;
    private readonly Func<IReadOnlyList<string>, IntPtr> _allocate;

    internal static FORMATETC SupportedFormat => new()
    {
        cfFormat = FileDropHGlobal.CfHDrop,
        ptd = IntPtr.Zero,
        dwAspect = DVASPECT.DVASPECT_CONTENT,
        lindex = -1,
        tymed = TYMED.TYMED_HGLOBAL,
    };

    public FileDropDataObject(IEnumerable<string> paths, Func<IReadOnlyList<string>, IntPtr>? allocate = null)
    {
        _paths = paths?.ToArray() ?? throw new ArgumentNullException(nameof(paths));
        _ = FileDropHGlobal.BuildPayload(_paths);
        _allocate = allocate ?? FileDropHGlobal.Allocate;
    }

    public int QueryGetData(ref FormatEtc format)
    {
        if (format.cfFormat != FileDropHGlobal.CfHDrop) return DV_E_FORMATETC;
        if (format.dwAspect != DvaspectContent) return DV_E_DVASPECT;
        if (format.lindex != -1) return DV_E_LINDEX;
        if ((format.tymed & TymedHGlobal) == 0) return DV_E_TYMED;
        return S_OK;
    }

    public int GetData(ref FormatEtc format, out StgMedium medium)
    {
        medium = default;
        int validation = QueryGetData(ref format);
        if (validation != S_OK) return validation;
        try
        {
            IntPtr memory = _allocate(_paths);
            if (memory == IntPtr.Zero) return E_OUTOFMEMORY;
            medium = new StgMedium { tymed = TymedHGlobal, unionMember = memory, pUnkForRelease = IntPtr.Zero };
            return S_OK;
        }
        catch (OutOfMemoryException) { return E_OUTOFMEMORY; }
        catch { return unchecked((int)0x80004005); }
    }

    public int GetDataHere(ref FormatEtc format, ref StgMedium medium) => E_NOTIMPL;
    public int GetCanonicalFormatEtc(ref FormatEtc input, out FormatEtc output) { output = default; return E_NOTIMPL; }
    public int SetData(ref FormatEtc format, ref StgMedium medium, bool release) => E_NOTIMPL;
    public int EnumFormatEtc(uint direction, out IntPtr enumerator)
    {
        enumerator = IntPtr.Zero;
        if (direction == DatadirSet) return E_NOTIMPL;
        if (direction != DatadirGet) return E_INVALIDARG;

        enumerator = Marshal.GetComInterfaceForObject(
            new FileDropFormatEnumerator(), typeof(IEnumFORMATETC));
        return S_OK;
    }
    public int DAdvise(ref FormatEtc format, uint flags, IntPtr sink, out uint connection) { connection = 0; return E_NOTIMPL; }
    public int DUnadvise(uint connection) => E_NOTIMPL;
    public int EnumDAdvise(out IntPtr enumerator) { enumerator = IntPtr.Zero; return E_NOTIMPL; }
}

[ComVisible(true), ClassInterface(ClassInterfaceType.None)]
internal sealed class FileDragDropSource : IFileDragDropSource
{
    internal const int S_OK = 0;
    internal const int DragDropSCancel = 0x00040101;
    internal const int DragDropSDrop = 0x00040100;
    internal const int DragDropSUseDefaultCursors = 0x00040102;
    internal const uint MkLeftButton = 0x0001;

    public int QueryContinueDrag(bool escapePressed, uint keyState) =>
        escapePressed ? DragDropSCancel : (keyState & MkLeftButton) == 0 ? DragDropSDrop : S_OK;

    public int GiveFeedback(uint effect) => DragDropSUseDefaultCursors;
}

internal enum FileDragResult { Copied, Cancelled, Rejected, Failed }

internal interface IFileDragNative
{
    int DoDragDrop(IFileDropDataObject data, IFileDragDropSource source, uint allowedEffects, out uint effect);
}

internal static class WindowsFileDrag
{
    internal const uint DropEffectCopy = 1;

    public static FileDragResult Run(IReadOnlyList<string> paths, IFileDragNative? native = null)
    {
        var data = new FileDropDataObject(paths);
        var source = new FileDragDropSource();
        int result = (native ?? OleFileDragNative.Instance).DoDragDrop(data, source, DropEffectCopy, out uint effect);
        GC.KeepAlive(data);
        GC.KeepAlive(source);
        return Classify(result, effect);
    }

    internal static FileDragResult Classify(int result, uint effect)
    {
        if (result == FileDragDropSource.DragDropSCancel) return FileDragResult.Cancelled;
        if (result == FileDragDropSource.DragDropSDrop)
            return (effect & DropEffectCopy) != 0 ? FileDragResult.Copied : FileDragResult.Rejected;
        return FileDragResult.Failed;
    }

    private sealed class OleFileDragNative : IFileDragNative
    {
        public static OleFileDragNative Instance { get; } = new();
        public int DoDragDrop(IFileDropDataObject data, IFileDragDropSource source, uint allowedEffects, out uint effect) =>
            NativeDoDragDrop(data, source, allowedEffects, out effect);

        [DllImport("ole32.dll", EntryPoint = "DoDragDrop")]
        private static extern int NativeDoDragDrop(
            [MarshalAs(UnmanagedType.Interface)] IFileDropDataObject data,
            [MarshalAs(UnmanagedType.Interface)] IFileDragDropSource source,
            uint allowedEffects, out uint effect);
    }
}

internal sealed class OleThreadLifetime : IDisposable
{
    internal const int RpcEChangedMode = unchecked((int)0x80010106);
    private readonly Action _uninitialize;
    private bool _initialized;

    private OleThreadLifetime(bool initialized, int result, Action uninitialize) =>
        (_initialized, Result, _uninitialize) = (initialized, result, uninitialize);

    public int Result { get; }
    public bool Available => _initialized;

    public static OleThreadLifetime Initialize(Func<int>? initialize = null, Action? uninitialize = null)
    {
        int result = (initialize ?? (() => OleInitialize(IntPtr.Zero)))();
        return new OleThreadLifetime(result is 0 or 1, result, uninitialize ?? OleUninitialize);
    }

    public void Dispose()
    {
        if (!_initialized) return;
        _initialized = false;
        _uninitialize();
    }

    [DllImport("ole32.dll")] private static extern int OleInitialize(IntPtr reserved = default);
    [DllImport("ole32.dll")] private static extern void OleUninitialize();
}
