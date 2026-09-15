using System.Net;
using System.Net.Http;
using OpenLocally;

namespace OpenLocally.Tests;

public class ManualSocialDiagnosticsBoundaryTests
{
    private const string ValidIntent = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

    public static TheoryData<string, string, ManualSocialDiagnosticReason> MalformedActivationUris => new()
    {
        {
            $"creatorcrate-social://prepare?v=2&server=https%3A%2F%2Fcreatorcrate.test&intent={ValidIntent}&SECRET_BEARER_SENTINEL=value",
            "SECRET_BEARER_SENTINEL", ManualSocialDiagnosticReason.UnsupportedActivationParameter
        },
        {
            $"creatorcrate-social://prepare?v=2&server=https%3A%2F%2Fcreatorcrate.test&intent={ValidIntent}&unsupported=SECRET_INTENT_SENTINEL",
            "SECRET_INTENT_SENTINEL", ManualSocialDiagnosticReason.UnsupportedActivationParameter
        },
        {
            $"creatorcrate-social://prepare?v=2&server=https%3A%2F%2Fcreatorcrate.test&intent={ValidIntent}&intent=SECRET_POST_BODY_SENTINEL",
            "SECRET_POST_BODY_SENTINEL", ManualSocialDiagnosticReason.DuplicateActivationParameter
        },
        {
            "creatorcrate-social://prepare?v=2&server=https%3A%2F%2Fcreatorcrate.test&intent=SECRET_INTENT_SENTINEL",
            "SECRET_INTENT_SENTINEL", ManualSocialDiagnosticReason.InvalidIntent
        },
        {
            $"creatorcrate-social://prepare?v=2&server=https%3A%2F%2Fcreatorcrate.test%2FSECRET_PATH_SENTINEL&intent={ValidIntent}",
            "SECRET_PATH_SENTINEL", ManualSocialDiagnosticReason.InvalidServerOrigin
        },
    };

    [Theory]
    [MemberData(nameof(MalformedActivationUris))]
    public void MalformedV2_ProductionBoundaryKeepsUriSecretsOutOfDialogAndStderr(
        string uri, string sentinel, ManualSocialDiagnosticReason expectedReason)
    {
        var dispatcher = CreateDispatcher(_ => throw new InvalidOperationException("runtime must not be constructed"));

        PresentedFailure presented = Run([uri], dispatcher);

        Assert.Equal(1, presented.ExitCode);
        Assert.Equal(expectedReason, presented.Result!.Diagnostic!.Reason);
        Assert.Contains("Stage: Open publishing companion", presented.AllOutput);
        Assert.Contains("Reason: " + presented.Result.Diagnostic.ReasonCode, presented.AllOutput);
        Assert.Contains("Code: social_uri_invalid", presented.AllOutput);
        AssertSecretAbsent(sentinel, presented);
        Assert.DoesNotContain(uri, presented.AllOutput, StringComparison.Ordinal);
        Assert.DoesNotContain(uri[(uri.IndexOf('?') + 1)..], presented.AllOutput, StringComparison.Ordinal);
        Assert.Equal(presented.DialogReport + Environment.NewLine, presented.Stderr);
    }

    [Fact]
    public void RejectedRedeemPayload_ProductionBoundaryKeepsEveryInjectedSecretOutOfOperatorOutput()
    {
        const string json = """
            {
              "SECRET_BEARER_SENTINEL": "unexpected",
              "ok": true,
              "sessionId": "00000000-0000-0000-0000-000000000001",
              "releaseId": 42,
              "attemptDeadlineAt": "2026-01-01 12:00:00",
              "platforms": [{
                "platform": "patreon",
                "title": "Title",
                "body": "SECRET_POST_BODY_SENTINEL",
                "assets": [{
                  "assetId": 1,
                  "role": "primary",
                  "sortOrder": 0,
                  "filename": "SECRET_PATH_SENTINEL.png",
                  "extension": ".png",
                  "mimeType": "image/png",
                  "sizeBytes": 1,
                  "relativePath": "SECRET_PATH_SENTINEL/final.png",
                  "isPresent": 0,
                  "windowsPath": "C:\\SECRET_PATH_SENTINEL\\final.png"
                }]
              }],
              "mediaToken": "SECRET_INTENT_SENTINEL"
            }
            """;
        var handler = new StaticResponseHandler(json);
        SocialRedeemClient redeem = CreateRedeemClient(handler);
        var runtime = new RedeemOnlyRuntime((request, _) => redeem.RedeemAsync(
            SocialOrigin.Parse(request.ServerOrigin), request.Intent, CancellationToken.None));
        var orchestrator = new ManualSocialPreparationOrchestrator(() => runtime);
#pragma warning disable xUnit1031 // CommandDispatcher's production manual-social boundary is intentionally synchronous.
        var dispatcher = CreateDispatcher(request =>
        {
            ManualSocialPreparationResult result = orchestrator.RunAsync(request).GetAwaiter().GetResult();
            return CommandDispatchResult.ManualFailure(result.ErrorCode!, result.Diagnostic!);
        });
#pragma warning restore xUnit1031

        PresentedFailure presented = Run([ValidSocialUri()], dispatcher);

        Assert.Equal(1, handler.Calls);
        Assert.Equal(ManualSocialDiagnosticReason.UnexpectedProperty, presented.Result!.Diagnostic!.Reason);
        Assert.Contains("Stage: Redeem preparation", presented.AllOutput);
        Assert.Contains("Reason: unexpected_property", presented.AllOutput);
        Assert.Contains("Code: redeem_payload_invalid", presented.AllOutput);
        Assert.Equal(presented.DialogReport + Environment.NewLine, presented.Stderr);
        foreach (string sentinel in new[]
        {
            "SECRET_BEARER_SENTINEL", "SECRET_POST_BODY_SENTINEL",
            "SECRET_PATH_SENTINEL", "SECRET_INTENT_SENTINEL",
        })
            AssertSecretAbsent(sentinel, presented);
    }

    [Fact]
    public void RedeemTimeout_ProductionBoundaryReportsSanitizedRedeemRequestFailure()
    {
        const string sentinel = "SECRET_TIMEOUT_EXCEPTION_SENTINEL";
        var handler = new TimeoutHandler(sentinel);
        SocialRedeemClient redeem = CreateRedeemClient(handler);
        var runtime = new RedeemOnlyRuntime((request, cancellationToken) => redeem.RedeemAsync(
            SocialOrigin.Parse(request.ServerOrigin), request.Intent, cancellationToken));
        var orchestrator = new ManualSocialPreparationOrchestrator(() => runtime);
#pragma warning disable xUnit1031 // CommandDispatcher's production manual-social boundary is intentionally synchronous.
        var dispatcher = CreateDispatcher(request =>
        {
            ManualSocialPreparationResult result = orchestrator.RunAsync(request).GetAwaiter().GetResult();
            return CommandDispatchResult.ManualFailure(result.ErrorCode!, result.Diagnostic!);
        });
#pragma warning restore xUnit1031

        PresentedFailure presented = Run([ValidSocialUri()], dispatcher);

        Assert.Equal(1, handler.Calls);
        Assert.Equal("server_unreachable", presented.Result!.Error);
        Assert.Equal(ManualSocialDiagnosticStage.RedeemRequest, presented.Result.Diagnostic!.Stage);
        Assert.Equal(ManualSocialDiagnosticReason.RequestNotSent, presented.Result.Diagnostic.Reason);
        Assert.Contains("Stage: Redeem request", presented.AllOutput);
        Assert.Contains("Problem: The redeem request could not be sent.", presented.AllOutput);
        Assert.Contains("Reason: request_not_sent", presented.AllOutput);
        Assert.Contains("Code: server_unreachable", presented.AllOutput);
        Assert.DoesNotContain("manual_preparation_failed", presented.AllOutput, StringComparison.Ordinal);
        Assert.DoesNotContain("preparation_failed", presented.AllOutput, StringComparison.Ordinal);
        AssertSecretAbsent(sentinel, presented);
        Assert.DoesNotContain(nameof(TaskCanceledException), presented.AllOutput, StringComparison.Ordinal);
        Assert.DoesNotContain(" at ", presented.AllOutput, StringComparison.Ordinal);
        Assert.Equal(presented.DialogReport + Environment.NewLine, presented.Stderr);
    }

    [Fact]
    public void InvalidVersion_UsesDetailedBoundedUpdateRequiredPresentation()
    {
        const string sentinel = "SECRET_BEARER_SENTINEL";
        string uri = $"creatorcrate-social://prepare?v={sentinel}&server=https%3A%2F%2Fcreatorcrate.test&intent={ValidIntent}";
        var dispatcher = CreateDispatcher(_ => throw new InvalidOperationException("runtime must not be constructed"));

        PresentedFailure presented = Run([uri], dispatcher);

        Assert.Equal("helper_update_required", presented.Result!.Error);
        Assert.Equal(ManualSocialDiagnosticReason.InvalidActivationVersion, presented.Result.Diagnostic!.Reason);
        Assert.Contains("Stage: Open publishing companion", presented.AllOutput);
        Assert.Contains("Reason: invalid_activation_version", presented.AllOutput);
        Assert.Contains("Code: helper_update_required", presented.AllOutput);
        AssertSecretAbsent(sentinel, presented);
    }

    [Fact]
    public void UnexpectedManualFailure_ProductionBoundaryNeverDisplaysExceptionTextOrStack()
    {
        const string sentinel = "SECRET_EXCEPTION_SENTINEL";
        var dispatcher = CreateDispatcher(_ => throw new InvalidOperationException(sentinel));

        PresentedFailure presented = Run([ValidSocialUri()], dispatcher);

        Assert.Equal(ManualSocialPreparationOrchestrator.FailureCode, presented.Result!.Error);
        Assert.Equal(ManualSocialDiagnosticReason.PreparationFailed, presented.Result.Diagnostic!.Reason);
        Assert.Contains("Stage: Manual preparation", presented.AllOutput);
        Assert.Contains("Reason: preparation_failed", presented.AllOutput);
        Assert.Contains("Code: manual_preparation_failed", presented.AllOutput);
        AssertSecretAbsent(sentinel, presented);
        Assert.DoesNotContain(nameof(InvalidOperationException), presented.AllOutput, StringComparison.Ordinal);
        Assert.DoesNotContain(" at ", presented.AllOutput, StringComparison.Ordinal);
    }

    [Fact]
    public void MalformedOpenLocally_RemainsOnGenericReporter()
    {
        var dispatcher = CreateDispatcher(
            _ => throw new InvalidOperationException("social runtime must not run"),
            _ => OpenLocallyResult.Fail("open_uri_invalid"));

        PresentedFailure presented = Run(["creatorcrate-open:not-valid"], dispatcher);

        Assert.False(presented.Result!.RequiresManualFailurePresentation);
        Assert.Equal("open_uri_invalid" + Environment.NewLine, presented.Stderr);
        Assert.Null(presented.DialogReport);
    }

    private static PresentedFailure Run(string[] args, CommandDispatcher dispatcher)
    {
        var stderr = new StringWriter();
        string? dialogSummary = null;
        string? dialogReport = null;
        CommandDispatchResult? captured = null;
        int exit = HelperProgram.Run(args, dispatcher, result =>
        {
            captured = result;
            return FailureReporter.Report(
                result, () => stderr, _ => { },
                (summary, report) =>
                {
                    dialogSummary = summary;
                    dialogReport = report;
                    return new NativePresentationResult();
                });
        });
        return new PresentedFailure(exit, captured, dialogSummary, dialogReport, stderr.ToString());
    }

    private static CommandDispatcher CreateDispatcher(
        Func<SocialUriRequest, CommandDispatchResult> runManualSocial,
        Func<string?, OpenLocallyResult>? runOpen = null) => new(
            runOpen ?? (_ => OpenLocallyResult.Ok()), runManualSocial,
            _ => ProtocolRegistrationResult.Ok(), () => ProtocolRegistrationResult.Ok(),
            _ => ProtocolRegistrationResult.Ok(), () => ProtocolRegistrationResult.Ok());

    private static string ValidSocialUri() =>
        $"creatorcrate-social://prepare?v=2&server=https%3A%2F%2Fcreatorcrate.test&intent={ValidIntent}";

    private static void AssertSecretAbsent(string sentinel, PresentedFailure presented)
    {
        Assert.DoesNotContain(sentinel, presented.Result!.Diagnostic!.FormatForDisplay(), StringComparison.Ordinal);
        Assert.DoesNotContain(sentinel, presented.DialogSummary ?? string.Empty, StringComparison.Ordinal);
        Assert.DoesNotContain(sentinel, presented.DialogReport ?? string.Empty, StringComparison.Ordinal);
        Assert.DoesNotContain(sentinel, presented.Stderr, StringComparison.Ordinal);
    }

    private static SocialRedeemClient CreateRedeemClient(HttpMessageHandler handler)
    {
        var resolver = new LoopbackResolver();
        return new SocialRedeemClient(
            new SocialHttpClient(resolver, () => handler),
            new OriginTrustService(new TrustStore(), new TrustPrompt(), resolver));
    }

    private sealed record PresentedFailure(
        int ExitCode, CommandDispatchResult? Result, string? DialogSummary,
        string? DialogReport, string Stderr)
    {
        public string AllOutput => (DialogSummary ?? string.Empty) + (DialogReport ?? string.Empty) + Stderr;
    }

    private sealed class StaticResponseHandler(string json) : HttpMessageHandler
    {
        public int Calls { get; private set; }
        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
        {
            Calls++;
            return Task.FromResult(new HttpResponseMessage(HttpStatusCode.OK) { Content = new StringContent(json) });
        }
    }

    private sealed class TimeoutHandler(string message) : HttpMessageHandler
    {
        public int Calls { get; private set; }
        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
        {
            Calls++;
            throw new TaskCanceledException(message);
        }
    }

    private sealed class TrustStore : ITrustedOriginStore
    {
        public bool IsTrusted(SocialOrigin origin) => false;
        public void Trust(SocialOrigin origin) { }
    }

    private sealed class TrustPrompt : IOriginTrustPrompt
    {
        public bool ConfirmTrust(SocialOrigin origin) => true;
    }

    private sealed class LoopbackResolver : IOriginAddressResolver
    {
        public Task<IReadOnlyList<IPAddress>> ResolveAsync(string host, CancellationToken cancellationToken) =>
            Task.FromResult<IReadOnlyList<IPAddress>>([IPAddress.Loopback]);
    }

    private sealed class RedeemOnlyRuntime(
        Func<SocialUriRequest, CancellationToken, Task<SocialRedeemResult>> redeem) : IManualSocialPreparationRuntime
    {
        public Task<SocialRedeemResult> RedeemAsync(SocialUriRequest request, CancellationToken cancellationToken) => redeem(request, cancellationToken);
        public Task<SocialPlatformStatusResult> PatchAsync(SocialCapability capability, string platform, string status, string? detailCode, string? message, CancellationToken cancellationToken) => throw new NotSupportedException();
        public Task<StagedMedia> StageAssetAsync(SocialCapability capability, SocialRedeemAsset asset, int ordinal, CancellationToken cancellationToken) => throw new NotSupportedException();
        public Task<StagedMedia> EnsureAssetAvailableAsync(SocialCapability capability, SocialRedeemAsset asset, int ordinal, StagedMedia media, CancellationToken cancellationToken) => throw new NotSupportedException();
        public Task CleanupMediaAsync(SocialCapability capability) => Task.CompletedTask;
        public IDisposable DetachMediaLease(SocialCapability capability) => throw new NotSupportedException();
        public ValueTask DisposeAsync() => ValueTask.CompletedTask;
    }
}
