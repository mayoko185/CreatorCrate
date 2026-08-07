using System.Runtime.ExceptionServices;
using System.Runtime.InteropServices;

namespace OpenLocally;

/// <summary>
/// Real Shell implementation backed by shell32.dll P/Invokes.
///
/// Opening a folder goes through ShellExecuteExW with the fixed "open" verb
/// (SEE_MASK_INVOKEIDLIST): the folder's own contents are shown and the call
/// returns an actual success/failure result. No command string, cmd.exe, or
/// PowerShell is involved.
///
/// Reveal/select goes through SHOpenFolderAndSelectItems, which requires COM
/// initialized as STA on the calling thread. The helper's default MTA console
/// thread cannot satisfy that — CoInitializeEx(COINIT_APARTMENTTHREADED) there
/// returns RPC_E_CHANGED_MODE (0x80010106) — so the Shell call is executed on
/// a short-lived STA thread whenever the current thread is not already STA.
/// Every execution path initializes COM explicitly and balances
/// CoUninitialize against the initialization count it owns.
/// </summary>
internal sealed class NativeShell : INativeShell
{
    private readonly Func<string, bool> _shellOpenFolder;
    private readonly Func<IntPtr, IntPtr[]?, int> _shellOpen;

    public NativeShell()
        : this(null, null)
    {
    }

    /// <summary>
    /// Test seam: replaces the Shell invocations so the apartment/thread
    /// behavior and the folder-open path can be verified without opening
    /// Explorer or touching COM. Null delegates fall back to the real
    /// implementations.
    /// </summary>
    internal NativeShell(
        Func<string, bool>? shellOpenFolder,
        Func<IntPtr, IntPtr[]?, int>? shellOpen)
    {
        _shellOpenFolder = shellOpenFolder ?? OpenFolderWithShellExecute;
        _shellOpen = shellOpen ?? ((folderPidl, childPidls) => SHOpenFolderAndSelectItems(
            folderPidl,
            childPidls is null ? 0u : (uint)childPidls.Length,
            childPidls,
            0));
    }

    public bool OpenFolder(string folderPath)
    {
        return _shellOpenFolder(folderPath);
    }

    public IntPtr ParseDisplayName(string path)
    {
        IntPtr pidl = IntPtr.Zero;
        int hr = SHParseDisplayName(path, IntPtr.Zero, out pidl, 0, out _);
        return hr == 0 ? pidl : IntPtr.Zero;
    }

    public bool OpenFolderAndSelectItem(IntPtr folderPidl, IntPtr childPidl)
    {
        return OpenFolderAndSelectItems(folderPidl, new[] { childPidl });
    }

    public IntPtr GetLastId(IntPtr pidl)
    {
        return ILFindLastID(pidl);
    }

    public void FreePidl(IntPtr pidl)
    {
        if (pidl != IntPtr.Zero)
        {
            ILFree(pidl);
        }
    }

    private bool OpenFolderAndSelectItems(IntPtr folderPidl, IntPtr[]? childPidls)
    {
        if (Thread.CurrentThread.GetApartmentState() == ApartmentState.STA)
        {
            return RunShellCallOnCurrentThread(folderPidl, childPidls);
        }

        return RunShellCallOnStaThread(folderPidl, childPidls);
    }

    /// <summary>
    /// Execute the Shell call on a short-lived STA thread and return its
    /// result to the caller. Exceptions thrown on the STA thread are rethrown
    /// on the caller's thread with their original stack trace, so PIDL
    /// cleanup and error reporting in <see cref="ExplorerLauncher"/> behave
    /// exactly as for a direct call.
    /// </summary>
    private bool RunShellCallOnStaThread(IntPtr folderPidl, IntPtr[]? childPidls)
    {
        bool result = false;
        Exception? failure = null;

        var staThread = new Thread(() =>
        {
            try
            {
                result = RunShellCallOnCurrentThread(folderPidl, childPidls);
            }
            catch (Exception ex)
            {
                failure = ex;
            }
        });
        staThread.SetApartmentState(ApartmentState.STA);
        staThread.Start();
        staThread.Join();

        if (failure is not null)
        {
            ExceptionDispatchInfo.Capture(failure).Throw();
        }

        return result;
    }

    private bool RunShellCallOnCurrentThread(IntPtr folderPidl, IntPtr[]? childPidls)
    {
        int initHr = CoInitializeEx(IntPtr.Zero, COINIT_APARTMENTTHREADED);
        if (initHr < 0)
        {
            // Includes RPC_E_CHANGED_MODE (0x80010106): the thread is already
            // initialized in a different COM mode and cannot be switched.
            // No init count is owned, so CoUninitialize must not be called.
            return false;
        }

        try
        {
            return _shellOpen(folderPidl, childPidls) == 0;
        }
        finally
        {
            CoUninitialize();
        }
    }

    /// <summary>
    /// Invoke the Shell "open" verb on the folder path (ShellExecuteExW). The
    /// verb is a fixed compile-time constant, never user-supplied. The result
    /// is the call's actual outcome: the boolean success of ShellExecuteExW
    /// itself.
    ///
    /// SEE_MASK_INVOKEIDLIST is deliberately NOT set: for a plain filesystem
    /// folder it forces the shell's IDList/DDE "open" resolution, which blocks
    /// for ~2 seconds per call. The paths handled here are always validated
    /// absolute drive paths, so the direct "open" verb resolves the same
    /// folder in ~30 ms.
    /// </summary>
    private bool OpenFolderWithShellExecute(string folderPath)
    {
        var info = new SHELLEXECUTEINFOW
        {
            cbSize = (uint)Marshal.SizeOf<SHELLEXECUTEINFOW>(),
            fMask = SEE_MASK_FLAG_NO_UI,
            lpVerb = OpenVerb,
            lpFile = folderPath,
            nShow = SW_SHOWNORMAL,
        };

        return ShellExecuteExW(ref info);
    }

    private const string OpenVerb = "open";
    private const uint SEE_MASK_FLAG_NO_UI = 0x00000400;
    private const int SW_SHOWNORMAL = 1;
    private const int COINIT_APARTMENTTHREADED = 0x2;

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct SHELLEXECUTEINFOW
    {
        public uint cbSize;
        public uint fMask;
        public IntPtr hwnd;
        [MarshalAs(UnmanagedType.LPWStr)] public string? lpVerb;
        [MarshalAs(UnmanagedType.LPWStr)] public string? lpFile;
        [MarshalAs(UnmanagedType.LPWStr)] public string? lpParameters;
        [MarshalAs(UnmanagedType.LPWStr)] public string? lpDirectory;
        public int nShow;
        public IntPtr hInstApp;
        public IntPtr lpIDList;
        [MarshalAs(UnmanagedType.LPWStr)] public string? lpClass;
        public IntPtr hkeyClass;
        public uint dwHotKey;
        public IntPtr hIcon;
        public IntPtr hProcess;
    }

    [DllImport("shell32.dll", CharSet = CharSet.Unicode)]
    private static extern bool ShellExecuteExW(ref SHELLEXECUTEINFOW lpExecInfo);

    [DllImport("shell32.dll", CharSet = CharSet.Unicode)]
    private static extern int SHParseDisplayName(
        [MarshalAs(UnmanagedType.LPWStr)] string pszName,
        IntPtr pbc,
        out IntPtr ppidl,
        uint sfgaoIn,
        out uint psfgaoOut);

    [DllImport("shell32.dll", CharSet = CharSet.Unicode)]
    private static extern int SHOpenFolderAndSelectItems(
        IntPtr pidlFolder,
        uint cidl,
        [In, MarshalAs(UnmanagedType.LPArray)] IntPtr[]? apidl,
        uint dwFlags);

    [DllImport("shell32.dll")]
    private static extern IntPtr ILFindLastID(IntPtr pidl);

    [DllImport("shell32.dll")]
    private static extern void ILFree(IntPtr pidl);

    [DllImport("ole32.dll")]
    private static extern int CoInitializeEx(IntPtr pvReserved, int dwCoInit);

    [DllImport("ole32.dll")]
    private static extern void CoUninitialize();
}
