using OpenLocally;

// Command-line entry point for the CreatorCrate helper.
//
// Usage:
//   OpenLocally.exe "creatorcrate-open://open?v=2&path=<absolute-windows-path>&select=<0|1>"
//   OpenLocally.exe "creatorcrate-social://prepare?v=1&server=<origin>&intent=<token>"
//   OpenLocally.exe --register | --unregister
//   OpenLocally.exe --register-social | --unregister-social
//
// Expected user errors are reported with a non-zero exit code; the process
// never crashes on them. The dispatcher keeps the original Open Locally
// activation lazy: that branch never constructs social-only dependencies.

var dispatcher = new CommandDispatcher();
CommandDispatchResult result = dispatcher.Dispatch(args);

// Explicit offline selection never falls through into another UI or browser path,
// including when the required manual opt-in is absent.
if (args.Length > 0 && args[0] == CommandDispatcher.VerifyReadyConsentCommand)
{
    if (!result.Success) { try { Console.Error.WriteLine(result.Error); } catch { } }
    return result.Success ? 0 : 1;
}

if (!result.Success)
{
    // Explicit offline-only verification; the extra arguments force Dispatch to
    // reject before environment, browser, or platform access. No ambient bypass.
    if (result.RequiresManualFailurePresentation && args.Length == 3 &&
        args[0] == CommandDispatcher.ValidatePatreonPreparationCommand &&
        args[1] == "--offline-presentation-verification" &&
        args[2] is "presented" or "failed" or "missing" or "malformed")
        return FailureReporter.ReportOfflineManualFailure(result.Error!, result.Detail, args[2]);

    return result.RequiresManualFailurePresentation
        ? FailureReporter.ReportManualSocialFailure(result.Error!, result.Detail)
        : FailureReporter.Report(result.Error!, result.Detail);
}

return 0;
