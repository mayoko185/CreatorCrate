using System;
using System.Runtime.InteropServices;
using System.Threading;

namespace OpenLocally
{
/// <summary>Operator-desktop attachment only; dialog content and commands belong to the caller.</summary>
internal static class NativeOperatorUiHost
{
    internal class Native : IDisposable
    {
        private const int ErrorBusy = 170;
        private const int UoiName = 2;
        private IntPtr desktop;
        private int error;
        public virtual int LastError { get { return error; } }
        public virtual bool Execute(NativePresentationStage stage, NativePresentationResult result)
        {
            if (stage == NativePresentationStage.open_input_desktop)
            {
                desktop = OpenInputDesktopHandle();
                bool opened = desktop != IntPtr.Zero;
                error = opened ? 0 : CaptureLastError();
                return opened;
            }
            if (stage != NativePresentationStage.set_thread_desktop) return false;

            if (SetThreadDesktopHandle(desktop))
            {
                error = 0;
                return true;
            }

            // SetThreadDesktop can report ERROR_BUSY when this STA thread is already
            // attached to the requested input desktop. No other error is recoverable.
            error = CaptureLastError();
            if (error != ErrorBusy) return false;

            IntPtr currentDesktop = GetCurrentThreadDesktopHandle();
            if (currentDesktop == IntPtr.Zero) return false;

            bool inputIdentityRead = TryGetDesktopName(desktop, out string inputIdentity);
            bool currentIdentityRead = TryGetDesktopName(currentDesktop, out string currentIdentity);
            bool alreadyAttached = inputIdentityRead && currentIdentityRead
                && !string.IsNullOrEmpty(inputIdentity)
                && !string.IsNullOrEmpty(currentIdentity)
                && string.Equals(inputIdentity, currentIdentity, StringComparison.Ordinal);
            if (alreadyAttached) error = 0;
            return alreadyAttached;
        }
        public virtual void Dispose() { }
        internal void ReleaseDesktop()
        {
            // The selected thread must have exited before closing its desktop.
            if (desktop != IntPtr.Zero) { CloseDesktopHandle(desktop); desktop = IntPtr.Zero; }
        }
        internal virtual IntPtr OpenInputDesktopHandle()
        {
            return OpenInputDesktop(0, false, 0x0001 | 0x0002 | 0x0080);
        }
        internal virtual bool SetThreadDesktopHandle(IntPtr desktopHandle)
        {
            return SetThreadDesktop(desktopHandle);
        }
        internal virtual int CaptureLastError()
        {
            return Marshal.GetLastWin32Error();
        }
        internal virtual IntPtr GetCurrentThreadDesktopHandle()
        {
            return GetThreadDesktop(GetCurrentThreadId());
        }
        internal virtual bool TryGetDesktopName(IntPtr desktopHandle, out string name)
        {
            name = string.Empty;
            GetUserObjectInformation(desktopHandle, UoiName, IntPtr.Zero, 0, out uint requiredBytes);
            if (requiredBytes == 0) return false;

            IntPtr buffer = Marshal.AllocHGlobal(checked((int)requiredBytes));
            try
            {
                if (!GetUserObjectInformation(desktopHandle, UoiName, buffer, requiredBytes, out _)) return false;
                name = Marshal.PtrToStringUni(buffer) ?? string.Empty;
                return true;
            }
            finally
            {
                Marshal.FreeHGlobal(buffer);
            }
        }
        internal virtual bool CloseDesktopHandle(IntPtr desktopHandle)
        {
            return CloseDesktop(desktopHandle);
        }
        [DllImport("user32.dll", SetLastError = true)] private static extern IntPtr OpenInputDesktop(uint flags, bool inherit, uint access);
        [DllImport("user32.dll", SetLastError = true)] private static extern bool SetThreadDesktop(IntPtr desktop);
        [DllImport("user32.dll")] private static extern IntPtr GetThreadDesktop(uint threadId);
        [DllImport("user32.dll", EntryPoint = "GetUserObjectInformationW", ExactSpelling = true, SetLastError = true)]
        private static extern bool GetUserObjectInformation(IntPtr handle, int index, IntPtr information, uint length, out uint requiredLength);
        [DllImport("user32.dll", SetLastError = true)] private static extern bool CloseDesktop(IntPtr desktop);
    }

    internal static NativePresentationResult Show(Native native, Action<NativePresentationResult> body, CancellationToken cancellation = default(CancellationToken))
    {
        var result = new NativePresentationResult();
        bool started = false;
        try
        {
            try { result.SessionId = System.Diagnostics.Process.GetCurrentProcess().SessionId; } catch { }
            var thread = new Thread(delegate()
            {
                try
                {
                    uint threadId = GetCurrentThreadId();
                    int interval = cancellation.CanBeCanceled ? 100 : Timeout.Infinite;
                    var closer = new Timer(delegate
                    {
                        if (!cancellation.IsCancellationRequested) return;
                        try { EnumThreadWindows(threadId, delegate(IntPtr window, IntPtr parameter) { PostMessage(window, 0x0010, IntPtr.Zero, IntPtr.Zero); return true; }, IntPtr.Zero); } catch { }
                    }, null, interval, interval);
                    try
                    {
                        foreach (var stage in new[] { NativePresentationStage.open_input_desktop, NativePresentationStage.set_thread_desktop })
                        {
                            result.Stage = stage;
                            if (!native.Execute(stage, result)) { result.Win32Code = Math.Max(0, native.LastError); return; }
                            if (stage == NativePresentationStage.open_input_desktop) result.InputDesktopOpened = true;
                            else result.ThreadDesktopSelected = true;
                        }
                        if (!cancellation.IsCancellationRequested) body(result);
                    }
                    finally
                    {
                        using (var drained = new ManualResetEvent(false)) { closer.Dispose(drained); drained.WaitOne(); }
                    }
                }
                catch { Fail(result); }
                finally
                {
                    try { native.Dispose(); } catch { Fail(result); }
                }
            });
            thread.SetApartmentState(ApartmentState.STA);
            thread.Start();
            started = true;
            // An interrupted caller must not release an attached desktop while its thread lives.
            bool interrupted = false;
            for (;;)
            {
                try { thread.Join(); break; }
                catch (ThreadInterruptedException) { interrupted = true; }
            }
            if (interrupted) Fail(result);
        }
        catch { Fail(result); }
        finally
        {
            if (!started) { try { native.Dispose(); } catch { Fail(result); } }
            try { native.ReleaseDesktop(); } catch { Fail(result); }
        }
        return result;
    }

    private delegate bool EnumWindow(IntPtr window, IntPtr parameter);
    [DllImport("kernel32.dll")] private static extern uint GetCurrentThreadId();
    [DllImport("user32.dll")] private static extern bool EnumThreadWindows(uint thread, EnumWindow callback, IntPtr parameter);
    [DllImport("user32.dll", EntryPoint = "PostMessageW", ExactSpelling = true)] private static extern bool PostMessage(IntPtr window, uint message, IntPtr wParam, IntPtr lParam);

    private static void Fail(NativePresentationResult result)
    {
        result.State = NativePresentationState.Failed;
        result.Stage = NativePresentationStage.unexpected;
        result.Win32Code = 0;
    }
}
}
