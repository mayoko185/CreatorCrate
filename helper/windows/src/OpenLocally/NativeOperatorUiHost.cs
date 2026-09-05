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
        private IntPtr desktop;
        private int error;
        public virtual int LastError { get { return error; } }
        public virtual bool Execute(NativePresentationStage stage, NativePresentationResult result)
        {
            bool success;
            if (stage == NativePresentationStage.open_input_desktop)
            {
                desktop = OpenInputDesktop(0, false, 0x0001 | 0x0002 | 0x0080);
                success = desktop != IntPtr.Zero;
            }
            else if (stage == NativePresentationStage.set_thread_desktop) success = SetThreadDesktop(desktop);
            else return false;
            error = success ? 0 : Marshal.GetLastWin32Error();
            return success;
        }
        public virtual void Dispose() { }
        internal void ReleaseDesktop()
        {
            // The selected thread must have exited before closing its desktop.
            if (desktop != IntPtr.Zero) { CloseDesktop(desktop); desktop = IntPtr.Zero; }
        }
        [DllImport("user32.dll", SetLastError = true)] private static extern IntPtr OpenInputDesktop(uint flags, bool inherit, uint access);
        [DllImport("user32.dll", SetLastError = true)] private static extern bool SetThreadDesktop(IntPtr desktop);
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
