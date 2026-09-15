using OpenLocally;

// Command-line entry point for the CreatorCrate helper.
//
// Usage:
//   OpenLocally.exe "creatorcrate-open://open?v=2&path=<absolute-windows-path>&select=<0|1>"
//   OpenLocally.exe "creatorcrate-social://prepare?v=<1|2>&server=<origin>&intent=<token>"
//   OpenLocally.exe --register | --unregister
//   OpenLocally.exe --register-social | --unregister-social
//
// Expected user errors are reported with a non-zero exit code; the process
// never crashes on them. The dispatcher keeps the original Open Locally
// activation lazy: that branch never constructs social-only dependencies.

if (DpiAwarenessProbe.TryRun(args, out int dpiProbeExitCode)) return dpiProbeExitCode;
return HelperProgram.Run(args, new CommandDispatcher(), FailureReporter.Report);

internal static class HelperProgram
{
    internal static int Run(
        string[] args, CommandDispatcher dispatcher,
        Func<CommandDispatchResult, int> reportFailure)
    {
        CommandDispatchResult result = dispatcher.Dispatch(args);
        return result.Success ? 0 : reportFailure(result);
    }
}
