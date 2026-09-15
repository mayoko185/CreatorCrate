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
    public static int Report(CommandDispatchResult result)
    {
        ArgumentNullException.ThrowIfNull(result);
        return Report(result, GetStderr, ShowMessageBox, NativeFailureDialog.Show, Console.Out.WriteLine);
    }

    internal static int Report(
        CommandDispatchResult result,
        Func<TextWriter?> getStderr,
        Action<string> showMessageBox,
        Func<string, string, NativePresentationResult> showDialog,
        Action<string>? writeMarker = null)
    {
        if (!result.RequiresManualFailurePresentation)
            return Report(result.Error!, result.Detail, getStderr, showMessageBox);
        return result.Diagnostic is not null
            ? ReportManualSocialFailure(result.Diagnostic, getStderr, showDialog, writeMarker)
            : ReportManualSocialFailure(result.Error!, result.Detail, getStderr, showDialog, writeMarker);
    }

    /// <summary>
    /// Report a failure message. Returns the process exit code to use (1).
    /// </summary>
    public static int Report(string message, string? detail = null)
    {
        return Report(message, detail, GetStderr, ShowMessageBox);
    }

    /// <summary>
    /// Reports a manual social-preparation failure. Unlike generic activation
    /// failures, its native dialog is mandatory even when a parent harness has
    /// redirected stderr; stderr remains secondary evidence only.
    /// </summary>
    public static int ReportManualSocialFailure(string message, string? detail)
    {
        return ReportManualSocialFailure(message, detail, GetStderr, NativeFailureDialog.Show, Console.Out.WriteLine);
    }

    public static int ReportManualSocialFailure(ManualSocialDiagnostic diagnostic)
    {
        ArgumentNullException.ThrowIfNull(diagnostic);
        return ReportManualSocialFailure(diagnostic, GetStderr, NativeFailureDialog.Show, Console.Out.WriteLine);
    }

    /// <summary>Presentation is best effort: it can never replace the original failure outcome.</summary>
    internal static int Report(string message, string? detail, Func<TextWriter?> getStderr, Action<string> showMessageBox)
    {
        string report = BuildReport(message, detail);
        try
        {
            TextWriter? stderr = getStderr();
            if (stderr is not null)
            {
                stderr.WriteLine(report);
                return 1;
            }
        }
        catch { }
        try { showMessageBox(report); } catch { }
        return 1;
    }

    /// <summary>Manual presentation is best effort and cannot replace the original nonzero result.</summary>
    internal static int ReportManualSocialFailure(
        string message,
        string? detail,
        Func<TextWriter?> getStderr,
        Func<string, string, NativePresentationResult> showDialog,
        Action<string>? writeMarker = null)
    {
        string report = string.IsNullOrEmpty(detail) ? BuildManualFallbackReport(message) : detail;
        try { getStderr()?.WriteLine(report); } catch { }
        NativePresentationResult outcome;
        try { outcome = showDialog(BuildSummary(report), report); }
        catch { outcome = new NativePresentationResult { Stage = NativePresentationStage.unexpected }; }
        try { writeMarker?.Invoke(outcome.ToMarker()); } catch { }
        return 1;
    }

    internal static int ReportManualSocialFailure(
        ManualSocialDiagnostic diagnostic,
        Func<TextWriter?> getStderr,
        Func<string, string, NativePresentationResult> showDialog,
        Action<string>? writeMarker = null)
    {
        string report = diagnostic.FormatForDisplay();
        try { getStderr()?.WriteLine(report); } catch { }
        NativePresentationResult outcome;
        try { outcome = showDialog(diagnostic.Summary, report); }
        catch { outcome = new NativePresentationResult { Stage = NativePresentationStage.unexpected }; }
        try { writeMarker?.Invoke(outcome.ToMarker()); } catch { }
        return 1;
    }

    /// <summary>Combines the stable failure headline and its safe detail without shortening either.</summary>
    internal static string BuildReport(string message, string? detail) =>
        string.IsNullOrEmpty(detail) ? message : $"{message}{Environment.NewLine}{detail}";

    internal static string BuildSummary(string report)
    {
        string platform = ValueFor(report, "Platform") ?? "Social preparation";
        string phase = ValueFor(report, "Phase")?.Replace('_', ' ') ?? "manual validation";
        string stableError = ValueFor(report, "Stable error") ?? "unknown";
        string errorClass = ValueFor(report, "Error class") ?? "unexpected";
        return $"{char.ToUpperInvariant(platform[0])}{platform[1..]} preparation failed during {phase}.{Environment.NewLine}{Environment.NewLine}Stable error: {stableError}{Environment.NewLine}Error class: {errorClass}";
    }

    private static string BuildManualFallbackReport(string message)
    {
        string code = ManualSocialDiagnostic.SafeCode(message);
        return $"Social Preparation failed{Environment.NewLine}Platform: unknown{Environment.NewLine}Phase: manual_preparation{Environment.NewLine}Stable error: {code}{Environment.NewLine}Outcome: failed{Environment.NewLine}Error class: unexpected";
    }

    private static string? ValueFor(string report, string label)
    {
        string prefix = label + ":";
        foreach (string line in report.Split(["\r\n", "\n"], StringSplitOptions.None))
        {
            if (line.StartsWith(prefix, StringComparison.Ordinal)) return line[prefix.Length..].Trim();
        }
        return null;
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

    private static void ShowMessageBox(string report) =>
        _ = MessageBoxW(IntPtr.Zero, report, "CreatorCrate", MB_OK | MB_ICONERROR);

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
