using System.Runtime.InteropServices;

namespace OpenLocally;

/// <summary>
/// Reports launch failures in a way that stays visible after the helper
/// became a Windows GUI-subsystem executable (no console on protocol
/// activation).
///
/// When a console or a redirected stream exists (command line, automated
/// scripts, CI), the message goes to stderr exactly as before — no dialog, no
/// interference with direct testability. When no stderr stream is available
/// (normal protocol activation from the shell), a small Windows message box
/// shows the failure. The box appears only for genuine launch failures, never
/// on successful launches, and never contains stack traces.
/// </summary>
internal static class FailureReporter
{
    /// <summary>
    /// Report a failure message. Returns the process exit code to use (1).
    /// </summary>
    public static int Report(string message)
    {
        TextWriter? stderr = GetStderr();
        if (stderr is not null)
        {
            stderr.WriteLine(message);
            return 1;
        }

        _ = MessageBoxW(IntPtr.Zero, message, "CreatorCrate", MB_OK | MB_ICONERROR);
        return 1;
    }

    private static TextWriter? GetStderr()
    {
        // Console.IsErrorRedirected reports true for a process with no console
        // at all (the handle is absent), so it cannot distinguish "redirected"
        // from "nowhere to write". Probe the raw handle instead: a valid
        // handle means a console or an explicit redirect exists and stderr
        // works; a NULL/invalid handle means normal protocol activation, where
        // the only visible channel left is a message box.
        if (!IsStderrAvailable(GetStdHandle(STD_ERROR_HANDLE)))
        {
            return null;
        }

        return Console.Error;
    }

    /// <summary>
    /// Whether a process can actually write to stderr. A NULL or invalid
    /// standard-error handle means the process has neither a console nor a
    /// redirect (a GUI process launched by the shell).
    /// </summary>
    internal static bool IsStderrAvailable(IntPtr stdErrorHandle)
    {
        return stdErrorHandle != IntPtr.Zero && stdErrorHandle != INVALID_HANDLE_VALUE;
    }

    private const int STD_ERROR_HANDLE = -12;
    private static readonly IntPtr INVALID_HANDLE_VALUE = new(-1);

    [DllImport("kernel32.dll")]
    private static extern IntPtr GetStdHandle(int nStdHandle);

    private const uint MB_OK = 0x00000000;
    private const uint MB_ICONERROR = 0x00000010;

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern int MessageBoxW(IntPtr hWnd, string lpText, string lpCaption, uint uType);
}
