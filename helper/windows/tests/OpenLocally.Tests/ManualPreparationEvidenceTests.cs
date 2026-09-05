using System.Net.WebSockets;
using System.Text;
using System.Text.Json;
using OpenLocally;

namespace OpenLocally.Tests;

public class ManualPreparationEvidenceTests
{
    private const string Private = "private-vanity private-title private-token private-file.png C:\\private\\media.png https://private.test/raw arbitrary-message";

    [Fact]
    public void CompositionFailureUsesRealWrapperCatchAndDoesNotInventLaterBoundaries()
    {
        var run = new Run { CompositionFailure = new InvalidOperationException(Private) };
        CommandDispatchResult result = run.Execute();
        AssertState(run, "composition", "failed");
        foreach (string boundary in new[] { "consent", "discovery", "connection_setup", "connection", "browser_setup", "adapter_invocation", "runtime_disposal" })
            AssertState(run, boundary, "not_started");
        AssertFailure(run, "caught_exception", "invalid_operation");
        Assert.Equal("manual_patreon_validation_failed", result.Error);
        Assert.Equal("unexpected", run.Report.ErrorClass);
        AssertPrivateAbsent(run, result);
    }

    [Theory]
    [InlineData(ChromeConnectionConsentDecision.Continue, "continue", "failed", "chrome_not_running")]
    [InlineData(ChromeConnectionConsentDecision.Cancel, "cancel", "not_started", "chrome_connection_ready_cancelled")]
    [InlineData(ChromeConnectionConsentDecision.DisplayFailed, "display_failed", "not_started", "chrome_connection_prompt_failed")]
    public void ChildConsumedConsentControlsDiscoveryAndKeepsStableCodes(ChromeConnectionConsentDecision decision, string word, string discovery, string code)
    {
        var run = new Run { Consent = new Consent(decision), Running = false };
        CommandDispatchResult result = run.Execute();
        AssertState(run, "composition", "completed");
        AssertState(run, "consent", "completed");
        AssertState(run, "discovery", discovery);
        AssertState(run, "connection", "not_started");
        AssertState(run, "runtime_disposal", "completed");
        Assert.Equal(word, Block(run).GetProperty("consent").GetProperty("decision").GetString());
        Assert.Equal(code, result.Error);
        AssertFailure(run, "failure_outcome", null);
        Assert.Equal("unexpected", run.Report.ErrorClass);
        if (decision == ChromeConnectionConsentDecision.Continue)
            Assert.Equal("chrome_not_running", Block(run).GetProperty("discovery").GetProperty("result").GetString());
    }

    [Fact]
    public void ThrowingConsentIsFailedAndUnknownRatherThanFabricatedCancelOrContinue()
    {
        var run = new Run { Consent = new Consent(ChromeConnectionConsentDecision.Continue, new IOException(Private)) };
        run.Execute();
        AssertState(run, "consent", "failed");
        AssertState(run, "discovery", "not_started");
        Assert.Equal("unknown", Block(run).GetProperty("consent").GetProperty("decision").GetString());
        AssertFailure(run, "caught_exception", "io");
    }

    [Theory]
    [InlineData("chrome_discovery_missing")]
    [InlineData("chrome_discovery_malformed")]
    public void DiscoveryReturnedFailuresRetainOnlyTheExistingStableResult(string code)
    {
        var run = new Run { DiscoveryContent = code == "chrome_discovery_missing" ? null : Private };
        Assert.Equal(code, run.Execute().Error);
        AssertState(run, "discovery", "failed");
        AssertState(run, "connection_setup", "not_started");
        Assert.Equal(code, Block(run).GetProperty("discovery").GetProperty("result").GetString());
    }

    [Fact]
    public void DiscoveryExceptionIsNotAConnectionFailure()
    {
        var run = new Run { DiscoveryFailure = new UnauthorizedAccessException(Private) };
        run.Execute();
        AssertState(run, "discovery", "failed");
        AssertState(run, "connection_setup", "not_started");
        AssertFailure(run, "caught_exception", "unauthorized_access");
    }

    [Fact]
    public void SocketFactoryFailureIsDistinctFromAnActualConnectionAttemptAndDetailIsComplete()
    {
        var run = new Run { SocketFactoryFailure = new ArgumentException(Private) };
        CommandDispatchResult result = run.Execute();
        AssertState(run, "composition", "completed");
        AssertState(run, "consent", "completed");
        AssertState(run, "discovery", "completed");
        AssertState(run, "connection_setup", "failed");
        AssertState(run, "connection", "not_started");
        AssertState(run, "browser_setup", "not_started");
        AssertState(run, "adapter_invocation", "not_started");
        AssertFailure(run, "caught_exception", "argument");
        Assert.Contains("decision: continue", result.Detail);
        Assert.True(result.RequiresManualFailurePresentation);
        AssertPrivateAbsent(run, result);
    }

    [Theory]
    [InlineData(WebSocketConnectionFailure.ConnectionRefused, "chrome_connection_refused")]
    [InlineData(WebSocketConnectionFailure.ApprovalDenied, "chrome_approval_denied")]
    [InlineData(WebSocketConnectionFailure.HandshakeFailed, "chrome_handshake_failed")]
    public void ConnectionFailureRetainsResultAndDoesNotChangeRetryPolicy(WebSocketConnectionFailure failure, string code)
    {
        var run = new Run();
        run.Socket.ConnectFailure = new WebSocketConnectionException(failure);
        Assert.Equal("chrome_connection_retry_cancelled", run.Execute().Error);
        AssertState(run, "connection_setup", "completed");
        AssertState(run, "connection", "failed");
        AssertState(run, "browser_setup", "not_started");
        Assert.Equal(code, Block(run).GetProperty("connection").GetProperty("result").GetString());
        Assert.Equal(1, run.Socket.ConnectCalls);
        Assert.Equal(1, ((Consent)run.Consent).RetryCalls);
        AssertFailure(run, "failure_outcome", null);
    }

    [Fact]
    public void BrowserWrapperConstructionFailureOccursAfterConnectionBeforeAdapter()
    {
        var run = new Run { BrowserFailure = new InvalidOperationException(Private) };
        run.Execute();
        AssertState(run, "connection", "completed");
        AssertState(run, "browser_setup", "failed");
        AssertState(run, "adapter_invocation", "not_started");
        AssertFailure(run, "caught_exception", "invalid_operation");
        Assert.Equal(1, run.Socket.DisposeCalls);
    }

    [Fact]
    public void AdapterConstructionFailureDoesNotFabricateInvocation()
    {
        var run = new Run { AdapterFactory = _ => throw new InvalidOperationException(Private) };
        run.Execute();
        AssertState(run, "browser_setup", "completed");
        AssertState(run, "adapter_invocation", "not_started");
    }

    [Fact]
    public void RealPatreonPageFactoryFailureBeforeProtectedBodyStillProvesAdapterInvocation()
    {
        var run = new Run { AdapterFactory = _ => new PatreonSocialPreparationAdapter(_ => throw new InvalidOperationException(Private)) };
        CommandDispatchResult result = run.Execute();
        AssertState(run, "adapter_invocation", "failed");
        Assert.Equal("manual_preparation", run.Report.Phase);
        AssertFailure(run, "caught_exception", "invalid_operation");
        AssertPrivateAbsent(run, result);
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public void AttachedReportSurvivesGenericWrapperAndOuterDisposal(bool disposalFails)
    {
        SocialPreparationDiagnostic report = DetailedReport();
        var attached = new CdpCommandException(-32000, "Could not find node", "DOM.getBoxModel");
        attached.AttachSocialDiagnostic(report);
        var run = new Run { AdapterFactory = _ => new Adapter(() => throw new Exception(Private, attached)) };
        if (disposalFails) run.Socket.DisposeFailure = new IOException(Private);
        CommandDispatchResult result = run.Execute();
        Assert.Same(report, run.Report);
        Assert.Equal("create_activation", run.Report.Phase);
        Assert.Equal("patreon_create_control_missing", run.Report.StableCode);
        Assert.Contains("no_usable_candidate", result.Detail);
        Assert.Contains("CDP code: -32000", result.Detail);
        Assert.Contains("creator_page_ready: yes", result.Detail);
        Assert.Contains("target_still_present: yes", result.Detail);
        Assert.Contains("Cleanup:", result.Detail);
        Assert.Equal("manual_patreon_validation_failed", result.Error);
        AssertFailure(run, "caught_exception", "unexpected");
        AssertState(run, "runtime_disposal", disposalFails ? "failed" : "completed");
        Assert.Equal(disposalFails ? "io" : null, Block(run).GetProperty("failure").GetProperty("disposal_exception_class").GetString());
        AssertPrivateAbsent(run, result);
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public void ReturnedFailureRemainsAnOutcomeEvenWhenDisposalThrows(bool disposalFails)
    {
        SocialPreparationDiagnostic report = DetailedReport();
        var run = new Run { AdapterFactory = _ => new Adapter(() => PlatformPreparationResult.Failed(report)) };
        if (disposalFails) run.Socket.DisposeFailure = new IOException(Private);
        CommandDispatchResult result = run.Execute();
        Assert.Same(report, run.Report);
        AssertState(run, "adapter_invocation", "completed");
        AssertFailure(run, "failure_outcome", null);
        Assert.Equal(disposalFails ? "manual_patreon_validation_failed" : "patreon_preparation_failed", result.Error);
        Assert.Contains("no_usable_candidate", result.Detail);
        AssertPrivateAbsent(run, result);
    }

    [Theory]
    [InlineData(PlatformPreparationOutcome.Failed, "patreon_preparation_failed", "unexpected")]
    [InlineData(PlatformPreparationOutcome.AuthenticationRequired, "patreon_authentication_required", "authentication_manual_attention")]
    public void UnattachedNormalFailureKeepsExistingStableErrorAndClass(PlatformPreparationOutcome outcome, string code, string errorClass)
    {
        var run = new Run { AdapterFactory = _ => new Adapter(() => new(outcome)) };
        Assert.Equal(code, run.Execute().Error);
        Assert.Equal(errorClass, run.Report.ErrorClass);
        AssertFailure(run, "failure_outcome", null);
    }

    [Fact]
    public void DisposalOnlyFailureRemainsAuthoritativeAndHasNoFabricatedAdapterFailure()
    {
        var run = new Run();
        run.Socket.DisposeFailure = new IOException(Private);
        CommandDispatchResult result = run.Execute();
        Assert.False(result.Success);
        AssertState(run, "adapter_invocation", "completed");
        AssertState(run, "runtime_disposal", "failed");
        AssertFailure(run, "disposal_failure", "io");
        Assert.Equal("manual_patreon_validation_failed", result.Error);
        Assert.Equal(1, run.Socket.DisposeCalls);
        AssertPrivateAbsent(run, result);
    }

    [Theory]
    [InlineData("Continue", true, "continue", "failed")]
    [InlineData("Cancel", true, "cancel", "not_started")]
    [InlineData("DisplayFailed", true, "display_failed", "not_started")]
    [InlineData("rejected", false, "display_failed", "not_started")]
    [InlineData("missing", false, "display_failed", "not_started")]
    public async Task RealReadyBridgeEvidenceReflectsOnlyTheChildConsumedResponse(string answer, bool accepted, string decision, string discovery)
    {
        string directory = Path.Combine(Path.GetTempPath(), "CreatorCrate-manual-evidence-" + Guid.NewGuid().ToString("N"));
        string id = Guid.NewGuid().ToString("N");
        Directory.CreateDirectory(directory);
        try
        {
            var run = new Run
            {
                Running = false,
                Consent = new ManualReadyConsent(new Consent(ChromeConnectionConsentDecision.DisplayFailed), directory, id,
                    answer == "missing" ? TimeSpan.FromMilliseconds(1) : TimeSpan.FromSeconds(10)),
            };
            Task<CommandDispatchResult> execution = Task.Run(run.Execute);
            if (answer != "missing")
            {
                string request = Path.Combine(directory, "request.json");
                using var deadline = new CancellationTokenSource(TimeSpan.FromSeconds(5));
                while (!File.Exists(request)) await Task.Delay(10, deadline.Token);
                string response = Path.Combine(directory, id + ".json");
                File.WriteAllText(response + ".tmp", JsonSerializer.Serialize(new
                {
                    RequestId = answer == "rejected" ? Guid.NewGuid().ToString("N") : id, Answer = answer,
                }));
                File.Move(response + ".tmp", response);
            }
            CommandDispatchResult result = await execution.WaitAsync(TimeSpan.FromSeconds(15));
            JsonElement consent = Block(run).GetProperty("consent");
            Assert.True(consent.GetProperty("parent_requested").GetBoolean());
            Assert.Equal(accepted, consent.GetProperty("parent_response_accepted").GetBoolean());
            Assert.Equal(decision, consent.GetProperty("decision").GetString());
            AssertState(run, "consent", "completed");
            AssertState(run, "discovery", discovery);
            Assert.DoesNotContain(id, run.Report.Serialize());
            Assert.DoesNotContain(directory, result.Detail);
        }
        finally { Directory.Delete(directory, recursive: true); }
    }

    [Fact]
    public void MaximalExistingDiagnosticPlusRunEvidenceFitsUtf8BoundWithoutLosingAnyBlock()
    {
        var report = new SocialPreparationDiagnostic("patreon", "create_activation", "patreon_create_control_missing");
        report.SetCreateResolution(new(PatreonCreateResolutionOutcome.NoUsableCandidate, 16, 16, 0, 16, complete: true));
        report.CaptureCleanup(new TimeoutException());
        for (int i = 0; i < 16; i++) report.Checkpoint(new string('a', 62) + i, null);
        for (int i = 0; i < 8; i++) report.TargetState(new string('b', 62) + i, null);
        report.CapturePrimary(new CdpCommandException(int.MinValue, new string('漢', 256), "DOM.scrollIntoViewIfNeeded"));
        report.SetPhase(new string('p', 64));
        report.SetStableCode(new string('s', 64));
        report.SetCorrelation(int.MaxValue, int.MaxValue);
        report.SetReportingFailure(new string('r', 64), new TimeoutException());
        var run = new Run { AdapterFactory = _ => new Adapter(() => PlatformPreparationResult.Failed(report)) };
        run.Socket.DisposeFailure = new UnauthorizedAccessException(Private);
        run.Execute();
        string serialized = report.Serialize();
        Assert.InRange(Encoding.UTF8.GetByteCount(serialized), 1, 6144);
        using var json = JsonDocument.Parse(serialized);
        Assert.False(json.RootElement.TryGetProperty("truncated", out _));
        foreach (string key in new[] { "manual_preparation", "create_resolution", "checkpoints", "target_state", "cleanup", "reporting", "cdp_message" })
            Assert.True(json.RootElement.TryGetProperty(key, out _), key);
    }

    [Fact]
    public void FailedSocketCleanupCannotEraseTheAlreadyKnownConnectionResult()
    {
        var run = new Run();
        run.Socket.ConnectFailure = new WebSocketConnectionException(WebSocketConnectionFailure.ApprovalDenied);
        run.Socket.DisposeFailure = new IOException(Private);
        run.Execute();
        AssertState(run, "connection", "failed");
        Assert.Equal("chrome_approval_denied", Block(run).GetProperty("connection").GetProperty("result").GetString());
        AssertState(run, "runtime_disposal", "failed");
        AssertFailure(run, "caught_exception", "io");
        Assert.Equal(2, run.Socket.DisposeCalls); // Existing failed-attempt + runtime disposal ordering.
    }

    public static TheoryData<Exception, string, string, string> ExceptionVocabulary => new()
    {
        { new InvalidOperationException(Private), "invalid_operation", "manual_patreon_validation_failed", "unexpected" },
        { new IOException(Private), "io", "manual_patreon_validation_failed", "unexpected" },
        { new UnauthorizedAccessException(Private), "unauthorized_access", "manual_patreon_validation_failed", "unexpected" },
        { new ArgumentException(Private), "argument", "manual_patreon_validation_failed", "unexpected" },
        { new OperationCanceledException(Private), "operation_canceled", "manual_patreon_validation_failed", "unexpected" },
        { new ObjectDisposedException(Private), "object_disposed", "manual_patreon_validation_failed", "target_closed" },
        { new TimeoutException(Private), "timeout", "manual_patreon_validation_failed", "timeout" },
        { new WebSocketConnectionException(WebSocketConnectionFailure.HandshakeFailed, new Exception(Private)), "websocket_connection", "manual_patreon_validation_failed", "unexpected" },
        { new SocialPreparationRuntimeException("patreon_preparation_failed", new Exception(Private)), "social_preparation_runtime", "patreon_preparation_failed", "unexpected" },
        { new BrowserPreparationException(BrowserPreparationFailure.InvalidTarget, Private), "browser_preparation", "patreon_target_closed", "target_closed" },
        { new CdpCommandException(-32000, "title=" + Private, "DOM.getBoxModel"), "cdp_command", "patreon_preparation_failed", "cdp_command" },
        { new CdpTransportException(CdpTransportFailure.Closed, new Exception(Private)), "cdp_transport", "cdp_transport_failed", "cdp_transport" },
        { new Exception(Private), "unexpected", "manual_patreon_validation_failed", "unexpected" },
    };

    [Theory]
    [MemberData(nameof(ExceptionVocabulary))]
    public void EveryExceptionCategoryIsFixedAndExistingDispatchErrorClassificationIsUnchanged(Exception exception, string category, string code, string errorClass)
    {
        var run = new Run { AdapterFactory = _ => new Adapter(() => throw exception) };
        CommandDispatchResult result = run.Execute();
        AssertFailure(run, "caught_exception", category);
        Assert.Equal(code, result.Error);
        Assert.Equal(errorClass, run.Report.ErrorClass);
        AssertPrivateAbsent(run, result);
    }

    private static SocialPreparationDiagnostic DetailedReport()
    {
        var report = new SocialPreparationDiagnostic("patreon", "create_activation", "patreon_create_control_missing");
        report.SetCreateResolution(new(PatreonCreateResolutionOutcome.NoUsableCandidate, 16, 16, 0, 16, complete: true));
        report.Checkpoint("creator_page_ready");
        report.TargetState("target_still_present", true);
        report.CapturePrimary(new CdpCommandException(-32000, "Could not find node", "DOM.getBoxModel"));
        report.CaptureCleanup(new TimeoutException());
        return report;
    }

    private static JsonElement Block(Run run) => JsonSerializer.SerializeToElement(run.Evidence!.ToPayload());
    private static void AssertState(Run run, string boundary, string state)
    {
        Assert.Equal(state, Block(run).GetProperty(boundary).GetProperty("state").GetString());
        Assert.Contains($"  {boundary}:{Environment.NewLine}    state: {state}", run.Report.FormatForDisplay());
    }
    private static void AssertFailure(Run run, string kind, string? exceptionClass)
    {
        Assert.Equal(kind, Block(run).GetProperty("failure").GetProperty("kind").GetString());
        Assert.Equal(exceptionClass, Block(run).GetProperty("failure").GetProperty("exception_class").GetString());
    }
    private static void AssertPrivateAbsent(Run run, CommandDispatchResult result)
    {
        using var serialized = JsonDocument.Parse(run.Report.Serialize());
        JsonElement manual = serialized.RootElement.GetProperty("manual_preparation");
        Assert.Equal(Block(run).GetRawText(), manual.GetRawText());
        foreach (JsonProperty boundary in manual.EnumerateObject())
        {
            foreach (JsonProperty field in boundary.Value.EnumerateObject())
            {
                string value = field.Value.ValueKind switch
                {
                    JsonValueKind.True => "yes", JsonValueKind.False => "no",
                    JsonValueKind.Null => "unknown", _ => field.Value.ToString(),
                };
                Assert.Contains($"    {field.Name}: {value}", result.Detail);
            }
        }
        foreach (string text in new[] { run.Report.Serialize(), run.Report.FormatForDisplay(), result.Detail! })
            foreach (string fragment in Private.Split(' ')) Assert.DoesNotContain(fragment, text);
        Assert.Equal(run.Report.FormatForDisplay(), result.Detail);
    }

    private sealed class Run : IChromeEnvironment, IChromeDiscoveryFile
    {
        public ManualPreparationEvidence? Evidence;
        public SocialPreparationDiagnostic Report => Evidence!.PrimaryDiagnostic!;
        public Exception? CompositionFailure, DiscoveryFailure, SocketFactoryFailure, BrowserFailure;
        public bool Running = true;
        public string? DiscoveryContent = "9222\n/devtools/browser/offline-test\n";
        public IChromeConnectionConsent Consent = new Consent(ChromeConnectionConsentDecision.Continue);
        public readonly Socket Socket = new();
        public Func<PatreonManualPreparationDiagnostic, ISocialPreparationAdapter> AdapterFactory = _ => new Adapter(PlatformPreparationResult.Prepared);
        public CommandDispatchResult Execute() => CommandDispatcher.RunProductionPatreonPreparation(Private, Private, Private, [Private], evidence =>
        {
            Evidence = evidence;
            Assert.Equal(ManualBoundaryState.entered, evidence.Composition);
            if (CompositionFailure is not null) throw CompositionFailure;
            return ProductionSocialPreparationComposition.CreateRuntime(Consent, evidence, new ChromeDiscovery(this, this),
                new ChromeConnection(() => SocketFactoryFailure is { } failure ? throw failure : Socket, TimeSpan.FromSeconds(1)),
                transport => BrowserFailure is { } failure ? throw failure : new BrowserPreparationTargets(new CdpTargetManager(transport)));
        }, AdapterFactory);
        public bool IsStableChromeRunning() => DiscoveryFailure is { } failure ? throw failure : Running;
        public string GetLocalAppDataPath() => "C:\\offline-test";
        public string? Read(string path, int maximumCharacters) => DiscoveryContent;
    }

    private sealed class Consent(ChromeConnectionConsentDecision decision, Exception? failure = null) : IChromeConnectionConsent
    {
        public int RetryCalls;
        public ChromeConnectionConsentDecision ConfirmReady() => failure is not null ? throw failure : decision;
        public ChromeConnectionConsentDecision ConfirmRetry(string errorCode) { RetryCalls++; return ChromeConnectionConsentDecision.Cancel; }
    }
    private sealed class Adapter(Func<PlatformPreparationResult> prepare) : ISocialPreparationAdapter
    {
        public string Platform => "patreon";
        public Task<PlatformPreparationResult> PrepareAsync(PlatformPreparationContext context, IPreparationProgress progress, CancellationToken cancellationToken)
            => Task.FromResult(prepare());
    }
    private sealed class Socket : IWebSocketConnection
    {
        private readonly TaskCompletionSource _closed = new(TaskCreationOptions.RunContinuationsAsynchronously);
        public Exception? ConnectFailure, DisposeFailure;
        public int ConnectCalls, DisposeCalls;
        public WebSocketState State => WebSocketState.Open;
        public Task ConnectAsync(Uri endpoint, CancellationToken cancellationToken)
        {
            ConnectCalls++;
            return ConnectFailure is { } failure ? Task.FromException(failure) : Task.CompletedTask;
        }
        public Task SendAsync(ArraySegment<byte> buffer, WebSocketMessageType messageType, bool endOfMessage, CancellationToken cancellationToken) => Task.CompletedTask;
        public async Task<WebSocketReceiveResult> ReceiveAsync(ArraySegment<byte> buffer, CancellationToken cancellationToken)
        {
            await _closed.Task.WaitAsync(cancellationToken);
            return new WebSocketReceiveResult(0, WebSocketMessageType.Close, true);
        }
        public Task CloseAsync(CancellationToken cancellationToken) { _closed.TrySetResult(); return Task.CompletedTask; }
        public ValueTask DisposeAsync()
        {
            DisposeCalls++;
            return DisposeFailure is { } failure ? ValueTask.FromException(failure) : ValueTask.CompletedTask;
        }
    }
}
