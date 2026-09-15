using OpenLocally;

namespace OpenLocally.Tests;

public class CommandDispatcherTests
{
    private const string OpenUri = "creatorcrate-open://open?v=2&path=C%3A%5CCreatorCrate%5Casset.png&select=1";
    private static readonly string LegacySocialUri = SocialUri(1);
    private static readonly string ManualSocialUri = SocialUri(2);

    [Fact]
    public void Dispatch_OpenUri_UsesOnlyOpenLocallySeam()
    {
        int openCalls = 0;
        var dispatcher = CreateDispatcher(
            runOpen: uri => { openCalls++; Assert.Equal(OpenUri, uri); return OpenLocallyResult.Ok(); },
            runManualSocial: _ => throw new InvalidOperationException("Open Locally must stay independent of social composition."));

        CommandDispatchResult result = dispatcher.Dispatch([OpenUri], () => throw new InvalidOperationException("No registration path."));

        Assert.True(result.Success);
        Assert.Equal(1, openCalls);
    }

    [Theory]
    [InlineData("extra")]
    [InlineData("extra", "another")]
    public void Dispatch_OpenUriWithExtraArguments_FailsBeforeEitherRuntime(params string[] extraArguments)
    {
        int openCalls = 0;
        int socialCalls = 0;
        var dispatcher = CreateDispatcher(
            runOpen: _ => { openCalls++; return OpenLocallyResult.Ok(); },
            runManualSocial: _ => { socialCalls++; return CommandDispatchResult.Ok(); });

        CommandDispatchResult result = dispatcher.Dispatch([OpenUri, .. extraArguments], "ignored.exe");

        Assert.False(result.Success);
        Assert.Equal(CommandDispatcher.UriArityError, result.Error);
        Assert.Equal(0, openCalls);
        Assert.Equal(0, socialCalls);
    }

    [Fact]
    public void Dispatch_V2SocialUri_UsesOnlyManualSocialSeam()
    {
        int calls = 0;
        var dispatcher = CreateDispatcher(
            runOpen: _ => throw new InvalidOperationException("V2 must not enter Open Locally."),
            runManualSocial: request =>
            {
                calls++;
                Assert.Equal(SocialUriRequestParser.ManualVersion, request.Version);
                return CommandDispatchResult.Ok();
            });

        CommandDispatchResult result = dispatcher.Dispatch([ManualSocialUri], () => throw new InvalidOperationException("No registration path."));

        Assert.True(result.Success);
        Assert.Equal(1, calls);
    }

    [Fact]
    public void Dispatch_V2StructuredFailure_PreservesDiagnosticForNativePresentation()
    {
        var diagnostic = new ManualSocialDiagnostic(
            "redeem_payload_invalid", ManualSocialDiagnosticStage.RedeemPreparation,
            ManualSocialDiagnosticReason.InvalidAssetExtension,
            HttpStatus: 200, PlatformOrdinal: 1, AssetOrdinal: 3);
        var dispatcher = CreateDispatcher(runManualSocial: _ =>
            CommandDispatchResult.ManualFailure("redeem_payload_invalid", diagnostic));

        CommandDispatchResult result = dispatcher.Dispatch([ManualSocialUri], "ignored.exe");

        Assert.False(result.Success);
        Assert.True(result.RequiresManualFailurePresentation);
        Assert.Same(diagnostic, result.Diagnostic);
        Assert.Null(result.Detail);
    }

    [Fact]
    public void Dispatch_V1SocialUri_FailsBeforeManualRuntimeOrExecutableResolution()
    {
        var dispatcher = CreateDispatcher(
            runOpen: _ => throw new InvalidOperationException("V1 must not enter Open Locally."),
            runManualSocial: _ => throw new InvalidOperationException("V1 must not enter the manual runtime."));

        CommandDispatchResult result = dispatcher.Dispatch(
            [LegacySocialUri], () => throw new InvalidOperationException("V1 must not resolve a registration executable."));

        Assert.False(result.Success);
        Assert.Equal(CommandDispatcher.UnsupportedLegacySocialWorkflow, result.Error);
    }

    [Fact]
    public void Dispatch_MalformedV2_FailsBeforeManualRuntime()
    {
        var dispatcher = CreateDispatcher(runManualSocial: _ => throw new InvalidOperationException("Malformed input must not enter the runtime."));

        CommandDispatchResult result = dispatcher.Dispatch(
            ["creatorcrate-social://prepare?v=2&server=https%3A%2F%2Fcreatorcrate.test&intent=short"], "ignored.exe");

        Assert.False(result.Success);
        Assert.Equal(CommandDispatcher.InvalidSocialUri, result.Error);
        Assert.True(result.RequiresManualFailurePresentation);
        Assert.Equal(ManualSocialDiagnosticStage.ActivationParsing, result.Diagnostic!.Stage);
        Assert.Equal(ManualSocialDiagnosticReason.InvalidIntent, result.Diagnostic.Reason);
    }

    [Fact]
    public void Dispatch_SocialUriWithExtraArgument_FailsBeforeManualRuntime()
    {
        int openCalls = 0;
        int socialCalls = 0;
        var dispatcher = CreateDispatcher(
            runOpen: _ => { openCalls++; return OpenLocallyResult.Ok(); },
            runManualSocial: _ => { socialCalls++; return CommandDispatchResult.Ok(); });

        CommandDispatchResult result = dispatcher.Dispatch([ManualSocialUri, "extra"], "ignored.exe");

        Assert.False(result.Success);
        Assert.Equal(CommandDispatcher.InvalidSocialUri, result.Error);
        Assert.True(result.RequiresManualFailurePresentation);
        Assert.Equal(ManualSocialDiagnosticReason.InvalidActivationShape, result.Diagnostic!.Reason);
        Assert.Equal(0, openCalls);
        Assert.Equal(0, socialCalls);
    }

    [Fact]
    public void Dispatch_WithoutArguments_PreservesEstablishedUsageFailure()
    {
        var dispatcher = CreateDispatcher(
            runOpen: _ => throw new InvalidOperationException("No request must not enter Open Locally."),
            runManualSocial: _ => throw new InvalidOperationException("No request must not enter the manual runtime."));

        CommandDispatchResult result = dispatcher.Dispatch([], () => throw new InvalidOperationException("No registration path."));

        Assert.False(result.Success);
        Assert.Equal(
            "Usage: OpenLocally <creatorcrate-open:// URI | creatorcrate-social:// URI> | --register | --unregister | --register-social | --unregister-social",
            result.Error);
    }

    [Theory]
    [InlineData("--register", "open-register")]
    [InlineData("--unregister", "open-unregister")]
    [InlineData("--register-social", "social-register")]
    [InlineData("--unregister-social", "social-unregister")]
    public void Dispatch_RegistrationCommands_SelectTheirOwnRegistrar(string command, string expected)
    {
        string? selected = null;
        var dispatcher = new CommandDispatcher(
            _ => throw new InvalidOperationException("Registration must not enter Open Locally."),
            _ => throw new InvalidOperationException("Registration must not enter social composition."),
            _ => { selected = "open-register"; return ProtocolRegistrationResult.Ok(); },
            () => { selected = "open-unregister"; return ProtocolRegistrationResult.Ok(); },
            _ => { selected = "social-register"; return ProtocolRegistrationResult.Ok(); },
            () => { selected = "social-unregister"; return ProtocolRegistrationResult.Ok(); });

        CommandDispatchResult result = dispatcher.Dispatch([command], @"C:\Tools\OpenLocally.exe");

        Assert.True(result.Success);
        Assert.Equal(expected, selected);
    }

    [Fact]
    public void Dispatch_UnsupportedSocialVersion_ReturnsUpdateRequiredWithoutManualRuntime()
    {
        var dispatcher = CreateDispatcher(runManualSocial: _ => throw new InvalidOperationException("Unsupported input must not enter the runtime."));

        CommandDispatchResult result = dispatcher.Dispatch([SocialUri(3)], "ignored.exe");

        Assert.False(result.Success);
        Assert.Equal("helper_update_required", result.Error);
        Assert.True(result.RequiresManualFailurePresentation);
        Assert.Equal(ManualSocialDiagnosticReason.InvalidActivationVersion, result.Diagnostic!.Reason);
    }

    private static CommandDispatcher CreateDispatcher(
        Func<string?, OpenLocallyResult>? runOpen = null,
        Func<SocialUriRequest, CommandDispatchResult>? runManualSocial = null) =>
        new(
            runOpen ?? (_ => OpenLocallyResult.Ok()),
            runManualSocial ?? (_ => CommandDispatchResult.Ok()),
            _ => ProtocolRegistrationResult.Ok(),
            () => ProtocolRegistrationResult.Ok(),
            _ => ProtocolRegistrationResult.Ok(),
            () => ProtocolRegistrationResult.Ok());

    private static string SocialUri(int version) =>
        $"creatorcrate-social://prepare?v={version}&server=https%3A%2F%2Fcreatorcrate.test&intent={new string('a', 43)}";
}
