using System.Runtime.InteropServices;
using System.Text;

namespace OpenLocally;

internal interface IUnicodeClipboard
{
    bool TrySetText(string text);
}

/// <summary>Single CF_UNICODETEXT implementation shared by native helper windows.</summary>
internal sealed class NativeUnicodeClipboard(IntPtr owner) : IUnicodeClipboard
{
    private const uint CfUnicodeText = 13;
    private const uint GmemMoveable = 0x0002;
    private readonly ClipboardNative _native = ClipboardNative.Instance;

    internal NativeUnicodeClipboard(IntPtr owner, ClipboardNative native) : this(owner)
    {
        _native = native;
    }

    public bool TrySetText(string text)
    {
        IntPtr memory = IntPtr.Zero;
        MemoryOwnership ownership = MemoryOwnership.None;
        bool memoryLocked = false;
        bool unlockFailed = false;
        bool opened = false;
        try
        {
            opened = _native.OpenClipboard(owner);
            if (!opened || !_native.EmptyClipboard()) return false;
            byte[] bytes = Encoding.Unicode.GetBytes(text + '\0');
            memory = _native.GlobalAlloc(GmemMoveable, (UIntPtr)bytes.Length);
            if (memory == IntPtr.Zero) return false;
            ownership = MemoryOwnership.HelperOwned;
            IntPtr target = _native.GlobalLock(memory);
            if (target == IntPtr.Zero) return false;
            memoryLocked = true;
            _native.Copy(bytes, target);
            if (!TryUnlock(memory))
            {
                unlockFailed = true;
                return false;
            }
            memoryLocked = false;
            if (_native.SetClipboardData(CfUnicodeText, memory) == IntPtr.Zero) return false;
            ownership = MemoryOwnership.Transferred;
            return true;
        }
        catch { return false; }
        finally
        {
            if (ownership == MemoryOwnership.HelperOwned && memory != IntPtr.Zero)
            {
                if (memoryLocked && !unlockFailed && TryUnlock(memory)) memoryLocked = false;
                // GlobalFree is invalid for a still-locked HGLOBAL. A genuine unlock
                // failure therefore leaves one explicit bounded leak instead of
                // pretending cleanup succeeded or retrying without a bound.
                if (!memoryLocked) _native.GlobalFree(memory);
            }
            if (opened) _native.CloseClipboard();
        }
    }

    private bool TryUnlock(IntPtr memory)
    {
        if (_native.GlobalUnlock(memory)) return true;
        return _native.GetLastError() == 0;
    }

    private enum MemoryOwnership
    {
        None,
        HelperOwned,
        Transferred,
    }

    internal abstract class ClipboardNative
    {
        internal static ClipboardNative Instance { get; } = new Win32ClipboardNative();

        internal abstract bool OpenClipboard(IntPtr owner);
        internal abstract bool EmptyClipboard();
        internal abstract IntPtr GlobalAlloc(uint flags, UIntPtr bytes);
        internal abstract IntPtr GlobalLock(IntPtr memory);
        internal virtual void Copy(byte[] bytes, IntPtr target) => Marshal.Copy(bytes, 0, target, bytes.Length);
        internal abstract bool GlobalUnlock(IntPtr memory);
        internal abstract int GetLastError();
        internal abstract IntPtr SetClipboardData(uint format, IntPtr memory);
        internal abstract IntPtr GlobalFree(IntPtr memory);
        internal abstract bool CloseClipboard();
    }

    private sealed class Win32ClipboardNative : ClipboardNative
    {
        internal override bool OpenClipboard(IntPtr owner) => NativeOpenClipboard(owner);
        internal override bool EmptyClipboard() => NativeEmptyClipboard();
        internal override IntPtr GlobalAlloc(uint flags, UIntPtr bytes) => NativeGlobalAlloc(flags, bytes);
        internal override IntPtr GlobalLock(IntPtr memory) => NativeGlobalLock(memory);
        internal override bool GlobalUnlock(IntPtr memory) => NativeGlobalUnlock(memory);
        internal override int GetLastError() => Marshal.GetLastPInvokeError();
        internal override IntPtr SetClipboardData(uint format, IntPtr memory) => NativeSetClipboardData(format, memory);
        internal override IntPtr GlobalFree(IntPtr memory) => NativeGlobalFree(memory);
        internal override bool CloseClipboard() => NativeCloseClipboard();

        [DllImport("user32.dll", EntryPoint = "OpenClipboard", SetLastError = true)] private static extern bool NativeOpenClipboard(IntPtr owner);
        [DllImport("user32.dll", EntryPoint = "EmptyClipboard")] private static extern bool NativeEmptyClipboard();
        [DllImport("user32.dll", EntryPoint = "SetClipboardData")] private static extern IntPtr NativeSetClipboardData(uint format, IntPtr memory);
        [DllImport("user32.dll", EntryPoint = "CloseClipboard")] private static extern bool NativeCloseClipboard();
        [DllImport("kernel32.dll", EntryPoint = "GlobalAlloc")] private static extern IntPtr NativeGlobalAlloc(uint flags, UIntPtr bytes);
        [DllImport("kernel32.dll", EntryPoint = "GlobalLock")] private static extern IntPtr NativeGlobalLock(IntPtr memory);
        [DllImport("kernel32.dll", EntryPoint = "GlobalUnlock", SetLastError = true)] private static extern bool NativeGlobalUnlock(IntPtr memory);
        [DllImport("kernel32.dll", EntryPoint = "GlobalFree")] private static extern IntPtr NativeGlobalFree(IntPtr memory);
    }
}
