namespace OpenLocally;

/// <summary>Result of selecting and running one supported helper command.</summary>
public sealed record CommandDispatchResult(
    bool Success, string? Error, string? Detail = null,
    bool RequiresManualFailurePresentation = false, ManualSocialSession? ManualSession = null,
    ManualSocialDiagnostic? Diagnostic = null)
{
    public static CommandDispatchResult Ok() => new(true, null);
    public static CommandDispatchResult ManualReady(ManualSocialSession session) => new(true, null, ManualSession: session);
    public static CommandDispatchResult Fail(string error, string? detail = null) => new(false, error, detail);
    public static CommandDispatchResult ManualFailure(string error, string detail) => new(false, error, detail, true);
    public static CommandDispatchResult ManualFailure(string error, ManualSocialDiagnostic diagnostic) =>
        new(false, error, RequiresManualFailurePresentation: true, Diagnostic: diagnostic);
}

/// <summary>
/// Top-level command selector. Dependencies are factories/delegates so an
/// Open Locally activation never constructs or initializes social-only work.
/// </summary>
public sealed class CommandDispatcher
{
    internal const string UnsupportedLegacySocialWorkflow = "unsupported_social_workflow";
    internal const string InvalidSocialUri = "social_uri_invalid";
    internal const string UriArityError = "URI invocations require exactly one URI argument.";

    private readonly Func<string?, OpenLocallyResult> _runOpenLocally;
    private readonly Func<SocialUriRequest, CommandDispatchResult> _runManualSocial;
    private readonly Func<string?, ProtocolRegistrationResult> _registerOpen;
    private readonly Func<ProtocolRegistrationResult> _unregisterOpen;
    private readonly Func<string?, ProtocolRegistrationResult> _registerSocial;
    private readonly Func<ProtocolRegistrationResult> _unregisterSocial;

    public CommandDispatcher()
        : this(
            uri => new OpenLocallyOrchestrator(new ExplorerLauncher()).Run(uri),
            RunProductionManualSocial,
            executablePath => new ProtocolRegistrar().Register(executablePath),
            () => new ProtocolRegistrar().Unregister(Environment.ProcessPath),
            executablePath => new SocialProtocolRegistrar().Register(executablePath),
            () => new SocialProtocolRegistrar().Unregister(Environment.ProcessPath))
    {
    }

    private static CommandDispatchResult RunProductionManualSocial(SocialUriRequest request)
    {
        ManualSocialPreparationResult result = ProductionManualSocialPreparationComposition
            .CreateOrchestrator()
            .RunAsync(request)
            .GetAwaiter()
            .GetResult();
        return result.Success
            ? CommandDispatchResult.ManualReady(result.Session!)
            : CommandDispatchResult.ManualFailure(result.ErrorCode!, result.Diagnostic!);
    }

    internal CommandDispatcher(
        Func<string?, OpenLocallyResult> runOpenLocally,
        Func<SocialUriRequest, CommandDispatchResult> runManualSocial,
        Func<string?, ProtocolRegistrationResult> registerOpen,
        Func<ProtocolRegistrationResult> unregisterOpen,
        Func<string?, ProtocolRegistrationResult> registerSocial,
        Func<ProtocolRegistrationResult> unregisterSocial)
    {
        _runOpenLocally = runOpenLocally;
        _runManualSocial = runManualSocial;
        _registerOpen = registerOpen;
        _unregisterOpen = unregisterOpen;
        _registerSocial = registerSocial;
        _unregisterSocial = unregisterSocial;
    }

    public CommandDispatchResult Dispatch(string[] args) =>
        Dispatch(args, static () => Environment.ProcessPath);

    public CommandDispatchResult Dispatch(string[] args, string? executablePath) =>
        Dispatch(args, () => executablePath);

    internal CommandDispatchResult Dispatch(string[] args, Func<string?> executablePath)
    {
        ArgumentNullException.ThrowIfNull(executablePath);

        if (args.Length == 0)
        {
            return CommandDispatchResult.Fail(
                "Usage: OpenLocally <creatorcrate-open:// URI | creatorcrate-social:// URI> | --register | --unregister | --register-social | --unregister-social");
        }

        string firstArg = args[0];
        return firstArg switch
        {
            "--register" => RegistrationResult(_registerOpen(executablePath())),
            "--unregister" => RegistrationResult(_unregisterOpen()),
            "--register-social" => RegistrationResult(_registerSocial(executablePath())),
            "--unregister-social" => RegistrationResult(_unregisterSocial()),
            _ when firstArg.StartsWith($"{SocialUriRequestParser.Scheme}:", StringComparison.Ordinal) =>
                args.Length == 1 ? DispatchSocial(firstArg) : SocialParseFailure(SocialUriParseFailureReason.InvalidActivationShape),
            _ when args.Length != 1 => CommandDispatchResult.Fail(UriArityError),
            _ => OpenResult(_runOpenLocally(firstArg)),
        };
    }

    private CommandDispatchResult DispatchSocial(string uri)
    {
        SocialUriParseResult parsed = SocialUriRequestParser.Parse(uri);
        if (!parsed.Success)
            return SocialParseFailure(parsed.Reason!.Value, parsed.Error!);

        try
        {
            return parsed.Request!.Version switch
            {
                SocialUriRequestParser.LegacyVersion => CommandDispatchResult.Fail(UnsupportedLegacySocialWorkflow),
                SocialUriRequestParser.ManualVersion => _runManualSocial(parsed.Request),
                _ => CommandDispatchResult.Fail("helper_update_required"),
            };
        }
        catch
        {
            return CommandDispatchResult.ManualFailure(
                ManualSocialPreparationOrchestrator.FailureCode,
                new ManualSocialDiagnostic(
                    ManualSocialPreparationOrchestrator.FailureCode,
                    ManualSocialDiagnosticStage.ManualPreparation,
                    ManualSocialDiagnosticReason.PreparationFailed));
        }
    }

    private static CommandDispatchResult SocialParseFailure(
        SocialUriParseFailureReason reason, string code = InvalidSocialUri) =>
        CommandDispatchResult.ManualFailure(code, new ManualSocialDiagnostic(
            code, ManualSocialDiagnosticStage.ActivationParsing, reason switch
            {
                SocialUriParseFailureReason.InvalidActivationUri => ManualSocialDiagnosticReason.InvalidActivationUri,
                SocialUriParseFailureReason.InvalidActivationShape => ManualSocialDiagnosticReason.InvalidActivationShape,
                SocialUriParseFailureReason.MissingActivationParameter => ManualSocialDiagnosticReason.MissingActivationParameter,
                SocialUriParseFailureReason.DuplicateActivationParameter => ManualSocialDiagnosticReason.DuplicateActivationParameter,
                SocialUriParseFailureReason.UnsupportedActivationParameter => ManualSocialDiagnosticReason.UnsupportedActivationParameter,
                SocialUriParseFailureReason.InvalidActivationVersion => ManualSocialDiagnosticReason.InvalidActivationVersion,
                SocialUriParseFailureReason.InvalidServerOrigin => ManualSocialDiagnosticReason.InvalidServerOrigin,
                SocialUriParseFailureReason.InvalidIntent => ManualSocialDiagnosticReason.InvalidIntent,
                _ => ManualSocialDiagnosticReason.InvalidActivationUri,
            }));

    private static CommandDispatchResult OpenResult(OpenLocallyResult result) =>
        result.Success ? CommandDispatchResult.Ok() : CommandDispatchResult.Fail(result.Error!);

    private static CommandDispatchResult RegistrationResult(ProtocolRegistrationResult result) =>
        result.Success ? CommandDispatchResult.Ok() : CommandDispatchResult.Fail(result.Error!);
}
