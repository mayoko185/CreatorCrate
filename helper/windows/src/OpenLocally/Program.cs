using OpenLocally;

// Command-line entry point for the CreatorCrate "Open locally" helper.
//
// Usage:
//   OpenLocally.exe "creatorcrate-open://open?v=2&path=<absolute-windows-path>&select=<0|1>"
//   OpenLocally.exe --register
//   OpenLocally.exe --unregister
//
// Expected user errors (invalid URI, invalid path, launcher failure,
// registration failure) are reported with a non-zero exit code; the process
// never crashes on them. The Windows GUI subsystem has no visible console,
// so failures are written to stderr when one exists (command line, scripts,
// redirected output) and shown in a small message box only when there is no
// stderr stream at all (normal protocol activation). No installer, config UI,
// or automatic registration on launch is performed here.

string? firstArg = args.Length > 0 ? args[0] : null;
if (firstArg is null)
{
    return FailureReporter.Report("Usage: OpenLocally <creatorcrate-open:// URI> | --register | --unregister");
}

if (firstArg == "--register" || firstArg == "--unregister")
{
    var registrar = new ProtocolRegistrar();
    ProtocolRegistrationResult registrationResult = firstArg == "--register"
        ? registrar.Register(Environment.ProcessPath)
        : registrar.Unregister();

    if (!registrationResult.Success)
    {
        return FailureReporter.Report(registrationResult.Error!);
    }

    return 0;
}

var orchestrator = new OpenLocallyOrchestrator(new ExplorerLauncher());
OpenLocallyResult result = orchestrator.Run(firstArg);

if (!result.Success)
{
    return FailureReporter.Report(result.Error!);
}

return 0;
