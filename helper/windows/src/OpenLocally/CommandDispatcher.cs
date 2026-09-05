namespace OpenLocally;

/// <summary>
/// Result of selecting and running one supported helper command.
/// </summary>
public sealed record CommandDispatchResult(bool Success, string? Error, string? Detail = null, bool RequiresManualFailurePresentation = false)
{
    public static CommandDispatchResult Ok() => new(true, null);

    public static CommandDispatchResult Fail(string error, string? detail = null) => new(false, error, detail);

    public static CommandDispatchResult ManualFailure(string error, string detail) => new(false, error, detail, true);
}

/// <summary>
/// Top-level command selector. Dependencies are factories/delegates so an
/// Open Locally activation never constructs or initializes social-only work.
/// </summary>
public sealed class CommandDispatcher
{
    internal const string VerifyReadyConsentCommand = "--verify-ready-consent";
    internal const string ValidateXPreparationCommand = "--validate-x-preparation";
    internal const string XLiveValidationEnvironmentVariable = "CREATORCRATE_RUN_X_LIVE_VALIDATION";
    internal const string XLiveImageEnvironmentVariable = "CREATORCRATE_X_LIVE_IMAGE";
    internal const string XLiveValidationBody = "CreatorCrate X final validation\n\nUnicode check ✓";
    internal const string ValidatePatreonPreparationCommand = "--validate-patreon-preparation";
    internal const string PatreonLiveValidationEnvironmentVariable = "CREATORCRATE_RUN_PATREON_LIVE_VALIDATION";
    internal const string PatreonLiveCreatorVanityEnvironmentVariable = "CREATORCRATE_PATREON_LIVE_CREATOR_VANITY";
    internal const string PatreonLiveImage1EnvironmentVariable = "CREATORCRATE_PATREON_LIVE_IMAGE_1";
    internal const string PatreonLiveImage2EnvironmentVariable = "CREATORCRATE_PATREON_LIVE_IMAGE_2";
    internal const string PatreonLiveValidationBody = "CreatorCrate Patreon body validation\n\nUnicode check ✓";
    private const string XLiveValidationTitle = "CreatorCrate X final validation";
    private const string PatreonLiveValidationTitle = "CreatorCrate Patreon final validation";
    private readonly Func<string?, OpenLocallyResult> _runOpenLocally;
    private readonly Func<SocialUriRequest, CommandDispatchResult> _runSocial;
    private readonly Func<string, string, IReadOnlyList<string>, CommandDispatchResult> _runManualXPreparation;
    private readonly Func<string, string, string, IReadOnlyList<string>, CommandDispatchResult> _runManualPatreonPreparation;
    private readonly Func<string, string?> _getEnvironmentVariable;
    private readonly Func<string, bool> _fileExists;
    private readonly Func<string?, ProtocolRegistrationResult> _registerOpen;
    private readonly Func<ProtocolRegistrationResult> _unregisterOpen;
    private readonly Func<string?, ProtocolRegistrationResult> _registerSocial;
    private readonly Func<ProtocolRegistrationResult> _unregisterSocial;

    public CommandDispatcher()
        : this(
            uri => new OpenLocallyOrchestrator(new ExplorerLauncher()).Run(uri),
            RunProductionSocial,
            executablePath => new ProtocolRegistrar().Register(executablePath),
            () => new ProtocolRegistrar().Unregister(),
            executablePath => new SocialProtocolRegistrar().Register(executablePath),
            () => new SocialProtocolRegistrar().Unregister(),
            RunProductionXPreparation,
            Environment.GetEnvironmentVariable,
            File.Exists,
            RunProductionPatreonPreparation)
    {
    }

    // Milestone 2 intentionally registers no production adapters. This check
    // is deliberately the first social operation: it constructs no trust,
    // transport, redeem, media, Chrome, WebSocket, or CDP dependency.
    private static CommandDispatchResult RunProductionSocial(SocialUriRequest request)
    {
        var adapters = new SocialAdapterRegistry();
        if (!adapters.HasCompleteFrozenCoverage())
            return CommandDispatchResult.Fail("production_adapters_unavailable");

        SocialPreparationResult result = ProductionSocialPreparationComposition
            .CreateOrchestrator(adapters)
            .RunAsync(request)
            .GetAwaiter()
            .GetResult();
        return result.Success ? CommandDispatchResult.Ok() : CommandDispatchResult.Fail(result.ErrorCode!, result.Detail);
    }

    internal CommandDispatcher(
        Func<string?, OpenLocallyResult> runOpenLocally,
        Func<SocialUriRequest, CommandDispatchResult> runSocial,
        Func<string?, ProtocolRegistrationResult> registerOpen,
        Func<ProtocolRegistrationResult> unregisterOpen,
        Func<string?, ProtocolRegistrationResult> registerSocial,
        Func<ProtocolRegistrationResult> unregisterSocial,
        Func<string, string, IReadOnlyList<string>, CommandDispatchResult>? runManualXPreparation = null,
        Func<string, string?>? getEnvironmentVariable = null,
        Func<string, bool>? fileExists = null,
        Func<string, string, string, IReadOnlyList<string>, CommandDispatchResult>? runManualPatreonPreparation = null)
    {
        _runOpenLocally = runOpenLocally;
        _runSocial = runSocial;
        _registerOpen = registerOpen;
        _unregisterOpen = unregisterOpen;
        _registerSocial = registerSocial;
        _unregisterSocial = unregisterSocial;
        _runManualXPreparation = runManualXPreparation ?? RunProductionXPreparation;
        _getEnvironmentVariable = getEnvironmentVariable ?? Environment.GetEnvironmentVariable;
        _fileExists = fileExists ?? File.Exists;
        _runManualPatreonPreparation = runManualPatreonPreparation ?? RunProductionPatreonPreparation;
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
            VerifyReadyConsentCommand => VerifyReadyConsent(args, _getEnvironmentVariable, ManualReadyConsent.Create, Console.WriteLine),
            "--register" => RegistrationResult(_registerOpen(executablePath())),
            "--unregister" => RegistrationResult(_unregisterOpen()),
            "--register-social" => RegistrationResult(_registerSocial(executablePath())),
            "--unregister-social" => RegistrationResult(_unregisterSocial()),
            ValidateXPreparationCommand => DispatchManualXPreparation(args),
            ValidatePatreonPreparationCommand => DispatchManualPatreonPreparation(args),
            _ when firstArg.StartsWith($"{SocialUriRequestParser.Scheme}:", StringComparison.Ordinal) => DispatchSocial(args),
            _ => OpenResult(_runOpenLocally(firstArg)),
        };
    }

    internal static CommandDispatchResult VerifyReadyConsent(string[] args, Func<string, string?> environment,
        Func<IChromeConnectionConsent> consentFactory, Action<string> evidence)
    {
        if (args.Length != 1 || args[0] != VerifyReadyConsentCommand || environment(ManualReadyConsent.Gate) != "1")
            return CommandDispatchResult.Fail("offline_ready_verification_disabled");
        // This branch has no runtime/browser factory and returns directly to Program.
        var consent = consentFactory();
        var decision = consent.ConfirmReady();
        var bridge = consent as ManualReadyConsent;
        var native = consent as NativeChromeConnectionConsent;
        evidence("CREATORCRATE_READY_VERIFICATION;decision=" + decision +
            ";parent_requested=" + (bridge?.Requested == true ? "yes" : "no") +
            ";correlation_accepted=" + (bridge?.Accepted == true ? "yes" : "no"));
        var presentation = native?.LastPresentation ?? bridge?.LocalPresentation;
        if (presentation is not null) evidence(presentation.ToMarker());
        return decision is ChromeConnectionConsentDecision.Continue or ChromeConnectionConsentDecision.Cancel
            ? CommandDispatchResult.Ok() : CommandDispatchResult.Fail("offline_ready_display_failed");
    }

    private CommandDispatchResult DispatchSocial(string[] args)
    {
        if (args.Length != 1)
        {
            return CommandDispatchResult.Fail("Social URI invocations require exactly one URI argument.");
        }

        SocialUriParseResult parsed = SocialUriRequestParser.Parse(args[0]);
        if (!parsed.Success)
        {
            return CommandDispatchResult.Fail(parsed.Error!);
        }

        return _runSocial(parsed.Request!);
    }

    private CommandDispatchResult DispatchManualXPreparation(string[] args)
    {
        if (args.Length != 1)
            return ManualPreflightFailure("x", "manual_x_validation_command_invalid");

        if (!string.Equals(_getEnvironmentVariable(XLiveValidationEnvironmentVariable), "1", StringComparison.Ordinal))
            return ManualPreflightFailure("x", "manual_x_validation_opt_in_required", XLiveValidationEnvironmentVariable, false);

        string? imagePath = _getEnvironmentVariable(XLiveImageEnvironmentVariable);
        if (string.IsNullOrWhiteSpace(imagePath))
            return ManualPreflightFailure("x", "manual_x_validation_image_required", XLiveImageEnvironmentVariable, false);

        if (!Path.IsPathFullyQualified(imagePath) || !_fileExists(imagePath))
            return ManualPreflightFailure("x", "manual_x_validation_image_invalid", XLiveImageEnvironmentVariable, true);

        return _runManualXPreparation(XLiveValidationTitle, XLiveValidationBody, [imagePath]);
    }

    private CommandDispatchResult DispatchManualPatreonPreparation(string[] args)
    {
        if (args.Length != 1)
            return ManualPreflightFailure("patreon", "manual_patreon_validation_command_invalid");

        if (!string.Equals(_getEnvironmentVariable(PatreonLiveValidationEnvironmentVariable), "1", StringComparison.Ordinal))
            return ManualPreflightFailure("patreon", "manual_patreon_validation_opt_in_required", PatreonLiveValidationEnvironmentVariable, false);

        string? creatorVanity = _getEnvironmentVariable(PatreonLiveCreatorVanityEnvironmentVariable);
        if (string.IsNullOrWhiteSpace(creatorVanity))
            return ManualPreflightFailure("patreon", "manual_patreon_validation_creator_vanity_required", PatreonLiveCreatorVanityEnvironmentVariable, false);
        if (creatorVanity.Contains('/', StringComparison.Ordinal) || creatorVanity.Any(char.IsControl))
            return ManualPreflightFailure("patreon", "manual_patreon_validation_creator_vanity_invalid", PatreonLiveCreatorVanityEnvironmentVariable, true);

        string? image1Path = _getEnvironmentVariable(PatreonLiveImage1EnvironmentVariable);
        string? image2Path = _getEnvironmentVariable(PatreonLiveImage2EnvironmentVariable);
        if (string.IsNullOrWhiteSpace(image1Path))
            return ManualPreflightFailure("patreon", "manual_patreon_validation_image_1_required", PatreonLiveImage1EnvironmentVariable, false);
        if (string.IsNullOrWhiteSpace(image2Path))
            return ManualPreflightFailure("patreon", "manual_patreon_validation_image_2_required", PatreonLiveImage2EnvironmentVariable, false);

        if (!Path.IsPathFullyQualified(image1Path))
            return ManualPreflightFailure("patreon", "manual_patreon_validation_image_1_invalid", PatreonLiveImage1EnvironmentVariable, true);
        if (!Path.IsPathFullyQualified(image2Path))
            return ManualPreflightFailure("patreon", "manual_patreon_validation_image_2_invalid", PatreonLiveImage2EnvironmentVariable, true);

        if (!PatreonComposer.IsVerifiedImagePath(image1Path))
            return ManualPreflightFailure("patreon", "manual_patreon_validation_image_1_invalid", PatreonLiveImage1EnvironmentVariable, true);
        if (!PatreonComposer.IsVerifiedImagePath(image2Path))
            return ManualPreflightFailure("patreon", "manual_patreon_validation_image_2_invalid", PatreonLiveImage2EnvironmentVariable, true);

        if (!_fileExists(image1Path))
            return ManualPreflightFailure("patreon", "manual_patreon_validation_image_1_invalid");
        if (!_fileExists(image2Path))
            return ManualPreflightFailure("patreon", "manual_patreon_validation_image_2_invalid");

        return _runManualPatreonPreparation(creatorVanity, PatreonLiveValidationTitle, PatreonLiveValidationBody, [image1Path, image2Path]);
    }

    private static CommandDispatchResult RunProductionXPreparation(string title, string body, IReadOnlyList<string> mediaPaths)
    {
        try
        {
            return RunProductionXPreparationAsync(title, body, mediaPaths).GetAwaiter().GetResult();
        }
        catch (SocialPreparationRuntimeException exception)
        {
            return ManualFailure("x", exception.Code, exception);
        }
        catch (CdpTransportException exception)
        {
            return ManualFailure("x", "cdp_transport_failed", exception);
        }
        catch (CdpCommandException exception)
        {
            return ManualFailure("x", "x_preparation_failed", exception);
        }
        catch (BrowserPreparationException exception) { return ManualFailure("x", "x_target_closed", exception); }
        catch (Exception exception) { return ManualFailure("x", "manual_x_validation_failed", exception); }
    }

    private static async Task<CommandDispatchResult> RunProductionXPreparationAsync(string title, string body, IReadOnlyList<string> mediaPaths)
    {
        await using ISocialPreparationRuntime runtime = ProductionSocialPreparationComposition.CreateRuntime(ManualReadyConsent.Create());
        BrowserPreparationTargets? targets = await runtime.ConnectBrowserAsync(CancellationToken.None).ConfigureAwait(false);
        if (targets is null) return ManualFailure("x", "x_target_closed", new ObjectDisposedException("target"));

        var adapter = new XSocialPreparationAdapter();
        var context = new PlatformPreparationContext(adapter.Platform, title, body, mediaPaths, targets);
        PlatformPreparationResult result = await adapter
            .PrepareAsync(context, new ManualPreparationProgress(), CancellationToken.None)
            .ConfigureAwait(false);
        return result.Outcome switch
        {
            PlatformPreparationOutcome.Prepared => CommandDispatchResult.Ok(),
            PlatformPreparationOutcome.AuthenticationRequired => ManualFailure("x", "x_authentication_required", new SocialPreparationRuntimeException("platform_auth_required")),
            PlatformPreparationOutcome.Failed => ManualFailure("x", "x_preparation_failed", null, result.Diagnostic),
            _ => ManualFailure("x", "manual_x_validation_failed"),
        };
    }

    private static CommandDispatchResult RunProductionPatreonPreparation(string creatorVanity, string title, string body, IReadOnlyList<string> mediaPaths)
        => RunProductionPatreonPreparation(creatorVanity, title, body, mediaPaths,
            evidence => ProductionSocialPreparationComposition.CreateRuntime(ManualReadyConsent.Create(), evidence),
            diagnostic => new PatreonSocialPreparationAdapter(creatorVanity, diagnostic));

    internal static CommandDispatchResult RunProductionPatreonPreparation(string creatorVanity, string title, string body,
        IReadOnlyList<string> mediaPaths, Func<ManualPreparationEvidence, ISocialPreparationRuntime> createRuntime,
        Func<PatreonManualPreparationDiagnostic, ISocialPreparationAdapter> createAdapter)
    {
        var evidence = new ManualPreparationEvidence();
        var diagnostic = new PatreonManualPreparationDiagnostic();
        try
        {
            CommandDispatchResult result = RunProductionPatreonPreparationAsync(title, body, mediaPaths, diagnostic,
                evidence, createRuntime, createAdapter).GetAwaiter().GetResult();
            // Runtime disposal has now completed. Do not present an earlier snapshot.
            return result.Success ? result : ManualRunFailure("patreon", result.Error!, evidence: evidence);
        }
        catch (Exception exception) { return ManualPatreonExceptionFailure(exception, evidence); }
    }

    private static async Task<CommandDispatchResult> RunProductionPatreonPreparationAsync(
        string title,
        string body,
        IReadOnlyList<string> mediaPaths,
        PatreonManualPreparationDiagnostic diagnostic,
        ManualPreparationEvidence evidence,
        Func<ManualPreparationEvidence, ISocialPreparationRuntime> createRuntime,
        Func<PatreonManualPreparationDiagnostic, ISocialPreparationAdapter> createAdapter)
    {
        evidence.Composition = ManualBoundaryState.entered;
        ISocialPreparationRuntime runtime;
        try
        {
            runtime = createRuntime(evidence);
            evidence.Composition = ManualBoundaryState.completed;
        }
        catch
        {
            evidence.Composition = ManualBoundaryState.failed;
            throw;
        }

        try
        {
            BrowserPreparationTargets? targets = await runtime.ConnectBrowserAsync(CancellationToken.None).ConfigureAwait(false);
            if (targets is null)
            {
                evidence.CaptureFailure(ManualFailureKind.failure_outcome);
                return ManualRunFailure("patreon", "patreon_preparation_failed", new ObjectDisposedException("target"), evidence: evidence);
            }

            ISocialPreparationAdapter adapter = createAdapter(diagnostic);
            var context = new PlatformPreparationContext(adapter.Platform, title, body, mediaPaths, targets);
            evidence.AdapterInvocation = ManualBoundaryState.entered;
            PlatformPreparationResult result;
            try
            {
                result = await adapter.PrepareAsync(context, new ManualPreparationProgress(), CancellationToken.None).ConfigureAwait(false);
                evidence.AdapterInvocation = ManualBoundaryState.completed;
            }
            catch
            {
                evidence.AdapterInvocation = ManualBoundaryState.failed;
                throw;
            }
            if (result.Outcome != PlatformPreparationOutcome.Prepared) evidence.CaptureFailure(ManualFailureKind.failure_outcome);
            return result.Outcome switch
            {
                PlatformPreparationOutcome.Prepared => CommandDispatchResult.Ok(),
                PlatformPreparationOutcome.AuthenticationRequired => ManualRunFailure("patreon", "patreon_authentication_required", new SocialPreparationRuntimeException("platform_auth_required"), result.Diagnostic, evidence),
                PlatformPreparationOutcome.Failed => ManualRunFailure("patreon", "patreon_preparation_failed", null, result.Diagnostic, evidence),
                _ => ManualRunFailure("patreon", "manual_patreon_validation_failed", evidence: evidence),
            };
        }
        catch (Exception exception)
        {
            // Capture before disposal can replace the escaping exception. Rethrow unchanged.
            ManualPatreonExceptionFailure(exception, evidence);
            throw;
        }
        finally
        {
            evidence.RuntimeDisposal = ManualBoundaryState.entered;
            try
            {
                await runtime.DisposeAsync().ConfigureAwait(false);
                evidence.RuntimeDisposal = ManualBoundaryState.completed;
            }
            catch (Exception exception)
            {
                evidence.RuntimeDisposal = ManualBoundaryState.failed;
                evidence.CaptureFailure(ManualFailureKind.disposal_failure, exception);
                throw;
            }
        }
    }

    private static CommandDispatchResult ManualPatreonExceptionFailure(Exception exception, ManualPreparationEvidence evidence)
    {
        evidence.CaptureFailure(ManualFailureKind.caught_exception, exception);
        string code = exception switch
        {
            SocialPreparationRuntimeException runtime => runtime.Code,
            CdpTransportException => "cdp_transport_failed",
            CdpCommandException => "patreon_preparation_failed",
            BrowserPreparationException => "patreon_target_closed",
            _ => "manual_patreon_validation_failed",
        };
        return ManualRunFailure("patreon", code, exception, evidence: evidence);
    }

    private static CommandDispatchResult ManualFailure(string platform, string code, Exception? exception = null, SocialPreparationDiagnostic? diagnostic = null)
        => ManualRunFailure(platform, code, exception, diagnostic);

    private static CommandDispatchResult ManualRunFailure(string platform, string code, Exception? exception = null,
        SocialPreparationDiagnostic? diagnostic = null, ManualPreparationEvidence? evidence = null)
    {
        SocialPreparationDiagnostic? attached = ManualPreparationEvidence.AttachedDiagnostic(exception);
        SocialPreparationDiagnostic? retained = evidence?.PrimaryDiagnostic ?? diagnostic ?? attached;
        SocialPreparationDiagnostic report = retained ?? new SocialPreparationDiagnostic(platform, "manual_preparation", code);
        if (retained is null && exception is not null) report.CapturePrimary(exception);
        if (evidence is not null)
        {
            evidence.PrimaryDiagnostic = report;
            report.SetManualPreparation(evidence);
        }
        return CommandDispatchResult.ManualFailure(code, report.FormatForDisplay());
    }

    private static CommandDispatchResult ManualPreflightFailure(string platform, string code, string? inputName = null, bool invalidInput = false)
    {
        var report = new SocialPreparationDiagnostic(platform, "manual_preflight", code);
        report.CapturePrimary(new SocialPreparationRuntimeException("validation_failed"));
        string detail = report.FormatForDisplay();
        if (inputName is not null) detail += $"{Environment.NewLine}{(invalidInput ? "Invalid input" : "Missing input")}: {inputName}";
        return CommandDispatchResult.ManualFailure(code, detail);
    }

    private sealed class ManualPreparationProgress : IPreparationProgress
    {
        public Task ReportAsync(SocialPreparationProgress progress, CancellationToken cancellationToken) => Task.CompletedTask;
    }

    private static CommandDispatchResult OpenResult(OpenLocallyResult result) =>
        result.Success ? CommandDispatchResult.Ok() : CommandDispatchResult.Fail(result.Error!);

    private static CommandDispatchResult RegistrationResult(ProtocolRegistrationResult result) =>
        result.Success ? CommandDispatchResult.Ok() : CommandDispatchResult.Fail(result.Error!);
}
