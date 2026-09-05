using System.Text.Json;
using OpenLocally;

namespace OpenLocally.Tests;

public class SocialPreparationOrchestratorTests
{
    private const string Token = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

    [Fact]
    public async Task IncompleteRegistry_StopsBeforeRuntimeConstruction()
    {
        int factories = 0;
        var orchestrator = new SocialPreparationOrchestrator(new SocialAdapterRegistry(), () =>
        {
            factories++;
            return new Runtime();
        });

        SocialPreparationResult result = await orchestrator.RunAsync(Request());

        Assert.False(result.Success);
        Assert.Equal("production_adapters_unavailable", result.ErrorCode);
        Assert.Equal(0, factories);
    }

    [Fact]
    public async Task ProductionComposition_CanConstructItsRuntimeWithoutBrowserOrNetworkUse()
    {
        await using ISocialPreparationRuntime runtime = ProductionSocialPreparationComposition.CreateRuntime();

        Assert.NotNull(runtime);
    }

    [Fact]
    public async Task MultiplePlatforms_RunSequentiallyWithFreshProbeAndOneBrowser()
    {
        var calls = new List<string>();
        var runtime = new Runtime(calls);
        var adapters = new SocialAdapterRegistry([
            new Adapter("patreon", calls), new Adapter("x", calls), new Adapter("bluesky", calls),
        ]);
        var orchestrator = new SocialPreparationOrchestrator(adapters, () => runtime);

        SocialPreparationResult result = await orchestrator.RunAsync(Request());

        Assert.True(result.Success);
        Assert.Equal(1, runtime.Redeems);
        Assert.Equal(1, runtime.BrowserConnections);
        Assert.Equal(3, runtime.Probes);
        Assert.Equal(["adapter:patreon", "adapter:x", "adapter:bluesky"], calls.Where(call => call.StartsWith("adapter:")).ToArray());
        Assert.Equal(1, runtime.Cleanups);
        Assert.Equal(new[] { "starting", "preparing", "uploading", "prepared" }, runtime.Writes.Take(4).Select(write => write.Status).ToArray());
        Assert.All(runtime.Writes, write =>
        {
            if (write.DetailCode is not null)
                Assert.Contains(write.DetailCode, new[] { "platform_auth_required", "platform_preparation_failed" });
        });
    }

    [Fact]
    public async Task OrdinaryFailure_DoesNotPreventLaterPlatform()
    {
        var calls = new List<string>();
        var runtime = new Runtime(calls);
        var adapters = new SocialAdapterRegistry([
            new Adapter("patreon", calls), new Adapter("x", calls, PlatformPreparationResult.Failed()), new Adapter("bluesky", calls),
        ]);

        SocialPreparationResult result = await new SocialPreparationOrchestrator(adapters, () => runtime).RunAsync(Request());

        Assert.False(result.Success);
        Assert.Equal("platform_preparation_failed", result.ErrorCode);
        Assert.NotNull(result.Detail);
        Assert.Contains("Platform: x", result.Detail);
        Assert.Contains(runtime.Writes, write => write.Platform == "x" && write.Status == "failed" && write.DetailCode == "platform_preparation_failed");
        Assert.Equal(new[] { "adapter:patreon", "adapter:x", "adapter:bluesky" }, calls.Where(call => call.StartsWith("adapter:")).ToArray());
    }

    [Fact]
    public async Task OrdinaryFailure_PreservesTheAdapterDiagnosticStableCodeForPresentation()
    {
        var diagnostic = new SocialPreparationDiagnostic("x", "media_readiness", "x_media_not_ready");
        diagnostic.Checkpoint("composer_ready", false);
        var calls = new List<string>();
        var adapters = new SocialAdapterRegistry([
            new Adapter("patreon", calls), new Adapter("x", calls, PlatformPreparationResult.Failed(diagnostic)), new Adapter("bluesky", calls),
        ]);

        SocialPreparationResult result = await new SocialPreparationOrchestrator(adapters, () => new Runtime(calls)).RunAsync(Request());

        Assert.False(result.Success);
        Assert.Contains("Stable error: x_media_not_ready", result.Detail);
        Assert.Contains("composer_ready: no", result.Detail);
    }

    [Fact]
    public async Task TerminalCdpTransportFailure_StopsLaterAdaptersAndWritesGlobalFailureRows()
    {
        var calls = new List<string>();
        var runtime = new Runtime(calls);
        var adapters = new SocialAdapterRegistry([
            new Adapter("patreon", calls),
            new Adapter("x", calls, exception: new CdpTransportException(CdpTransportFailure.Disconnected)),
            new Adapter("bluesky", calls),
        ]);

        SocialPreparationResult result = await new SocialPreparationOrchestrator(adapters, () => runtime).RunAsync(Request());

        Assert.False(result.Success);
        Assert.Equal("cdp_transport_failed", result.ErrorCode);
        Assert.NotNull(result.Detail);
        Assert.Contains("Platform: x", result.Detail);
        Assert.Contains("Stable error: cdp_transport_failed", result.Detail);
        Assert.Contains("Error class: cdp_transport", result.Detail);
        Assert.Equal(1, runtime.BrowserConnections);
        Assert.Equal(1, runtime.Cleanups);
        Assert.Equal(new[] { "adapter:patreon", "adapter:x" }, calls.Where(call => call.StartsWith("adapter:")).ToArray());
        Assert.Contains(runtime.Writes, write => write.Platform == "patreon" && write.Status == "prepared");
        Assert.Contains(runtime.Writes, write => write.Platform == "x" && write.Status == "failed" && write.DetailCode == "cdp_transport_failed");
        Assert.Contains(runtime.Writes, write => write.Platform == "bluesky" && write.Status == "cancelled" && write.DetailCode == "cdp_transport_failed");
    }

    [Fact]
    public async Task SupersededWhileReportingCdpTransportFailure_StopsFurtherWritesAndAdapters()
    {
        var calls = new List<string>();
        var runtime = new Runtime(calls) { PatchFailureAt = 6, PatchFailureCode = "attempt_superseded" };
        var adapters = new SocialAdapterRegistry([
            new Adapter("patreon", calls),
            new Adapter("x", calls, exception: new CdpTransportException(CdpTransportFailure.Disconnected)),
            new Adapter("bluesky", calls),
        ]);

        SocialPreparationResult result = await new SocialPreparationOrchestrator(adapters, () => runtime).RunAsync(Request());

        Assert.False(result.Success);
        Assert.Equal(SocialPreparationResultCategory.PreparationFailure, result.Category);
        Assert.Contains("Stable error: cdp_transport_failed", result.Detail);
        Assert.Contains("Reporting/persistence:", result.Detail);
        Assert.Contains("attempt_superseded", result.Detail);
        Assert.Equal(new[] { "adapter:patreon", "adapter:x" }, calls.Where(call => call.StartsWith("adapter:")).ToArray());
        Assert.DoesNotContain(runtime.Writes, write => write.Platform == "bluesky");
        Assert.Equal(1, runtime.Cleanups);
    }

    [Fact]
    public async Task OrdinaryAdapterException_DoesNotPreventLaterPlatform()
    {
        var calls = new List<string>();
        var runtime = new Runtime(calls);
        var adapters = new SocialAdapterRegistry([
            new Adapter("patreon", calls),
            new Adapter("x", calls, exception: new InvalidOperationException()),
            new Adapter("bluesky", calls),
        ]);

        SocialPreparationResult result = await new SocialPreparationOrchestrator(adapters, () => runtime).RunAsync(Request());

        Assert.False(result.Success);
        Assert.Equal("platform_preparation_failed", result.ErrorCode);
        Assert.NotNull(result.Detail);
        Assert.Contains("Platform: x", result.Detail);
        Assert.Contains(runtime.Writes, write => write.Platform == "x" && write.Status == "failed" && write.DetailCode == "platform_preparation_failed");
        Assert.Equal(new[] { "adapter:patreon", "adapter:x", "adapter:bluesky" }, calls.Where(call => call.StartsWith("adapter:")).ToArray());
    }

    [Fact]
    public async Task CdpProtocolCommandError_IsAnOrdinaryPlatformFailure()
    {
        var calls = new List<string>();
        var runtime = new Runtime(calls);
        var adapters = new SocialAdapterRegistry([
            new Adapter("patreon", calls),
            new Adapter("x", calls, exception: new CdpCommandException(-32000, "denied")),
            new Adapter("bluesky", calls),
        ]);

        SocialPreparationResult result = await new SocialPreparationOrchestrator(adapters, () => runtime).RunAsync(Request());

        Assert.False(result.Success);
        Assert.Equal("platform_preparation_failed", result.ErrorCode);
        Assert.NotNull(result.Detail);
        Assert.Contains("Platform: x", result.Detail);
        Assert.Contains(runtime.Writes, write => write.Platform == "x" && write.Status == "failed" && write.DetailCode == "platform_preparation_failed");
        Assert.Equal(new[] { "adapter:patreon", "adapter:x", "adapter:bluesky" }, calls.Where(call => call.StartsWith("adapter:")).ToArray());
    }

    [Fact]
    public async Task SupersededProbe_HardStopsWithoutStatusWriteOrLaterAdapter()
    {
        var calls = new List<string>();
        var runtime = new Runtime(calls) { ProbeFailureAt = 2, ProbeFailureCode = "attempt_superseded" };
        var adapters = new SocialAdapterRegistry([
            new Adapter("patreon", calls), new Adapter("x", calls), new Adapter("bluesky", calls),
        ]);

        SocialPreparationResult result = await new SocialPreparationOrchestrator(adapters, () => runtime).RunAsync(Request());

        Assert.False(result.Success);
        Assert.Equal(SocialPreparationResultCategory.Superseded, result.Category);
        Assert.Equal(new[] { "adapter:patreon" }, calls.Where(call => call.StartsWith("adapter:")).ToArray());
        Assert.DoesNotContain(runtime.Writes, write => write.Platform == "x");
        Assert.Equal(1, runtime.Cleanups);
    }

    [Fact]
    public async Task FinishedPatch_SoftStopsWithoutLaterPlatformWork()
    {
        var calls = new List<string>();
        var runtime = new Runtime(calls) { PatchFailureAt = 1, PatchFailureCode = "attempt_finished" };
        var adapters = Registry(calls);

        SocialPreparationResult result = await new SocialPreparationOrchestrator(adapters, () => runtime).RunAsync(Request());

        Assert.True(result.Success);
        Assert.Equal(SocialPreparationResultCategory.Finished, result.Category);
        Assert.Empty(calls.Where(call => call.StartsWith("adapter:")));
        Assert.Equal(1, runtime.Cleanups);
    }

    [Fact]
    public async Task GlobalMediaFailure_TerminalizesFirstAndCancelsRemainingRows()
    {
        var runtime = new Runtime { MediaFailureCode = "media_download_failed" };

        SocialPreparationResult result = await new SocialPreparationOrchestrator(Registry(), () => runtime).RunAsync(Request());

        Assert.False(result.Success);
        Assert.Equal("media_download_failed", result.ErrorCode);
        Assert.Equal(new[] { "failed", "cancelled", "cancelled" }, runtime.Writes.Select(write => write.Status).ToArray());
        Assert.All(runtime.Writes, write => Assert.Equal("platform_preparation_failed", write.DetailCode));
        Assert.Equal(1, runtime.Cleanups);
    }

    [Fact]
    public async Task CapabilityPatchFailure_StopsFurtherWritesImmediately()
    {
        var runtime = new Runtime { PatchFailureAt = 1, PatchFailureCode = "media_token_expired" };

        SocialPreparationResult result = await new SocialPreparationOrchestrator(Registry(), () => runtime).RunAsync(Request());

        Assert.False(result.Success);
        Assert.Equal(SocialPreparationResultCategory.CapabilityFailure, result.Category);
        Assert.Single(runtime.Writes);
    }

    [Fact]
    public async Task ProbeFailure_ReturnsFullFallbackDiagnostic()
    {
        var runtime = new Runtime { ProbeFailureAt = 1, ProbeFailureCode = "server_unreachable" };
        SocialPreparationResult result = await new SocialPreparationOrchestrator(Registry(), () => runtime).RunAsync(Request());
        Assert.False(result.Success);
        Assert.Equal("server_unreachable", result.ErrorCode);
        Assert.Contains("Platform: patreon", result.Detail);
        Assert.Contains("Phase: status_probe", result.Detail);
        Assert.Contains("Stable error: server_unreachable", result.Detail);
        Assert.Contains("Release ID: 42", result.Detail);
    }

    [Fact]
    public async Task ProgressPatchFailure_ReturnsFullFallbackDiagnostic()
    {
        var runtime = new Runtime { PatchFailureAt = 2, PatchFailureCode = "status_patch_failed" };
        SocialPreparationResult result = await new SocialPreparationOrchestrator(Registry(), () => runtime).RunAsync(Request());
        Assert.False(result.Success);
        Assert.Contains("Platform: patreon", result.Detail);
        Assert.Contains("Stable error: status_patch_failed", result.Detail);
        Assert.Contains("Release ID: 42", result.Detail);
        Assert.Contains("Attempt: 1", result.Detail);
    }

    [Fact]
    public async Task AdapterFailureThenFinalPatchFailure_PreservesPrimaryDiagnostic()
    {
        var primary = new SocialPreparationDiagnostic("x", "media_readiness", "x_media_not_ready");
        primary.Checkpoint("media_ready", false);
        var calls = new List<string>();
        var runtime = new Runtime(calls) { PatchFailureAt = 8, PatchFailureCode = "status_patch_failed" };
        var adapters = new SocialAdapterRegistry([
            new Adapter("patreon", calls), new Adapter("x", calls, PlatformPreparationResult.Failed(primary)), new Adapter("bluesky", calls),
        ]);
        SocialPreparationResult result = await new SocialPreparationOrchestrator(adapters, () => runtime).RunAsync(Request());
        Assert.False(result.Success);
        Assert.Equal("x_media_not_ready", result.ErrorCode);
        Assert.Contains("Stable error: x_media_not_ready", result.Detail);
        Assert.Contains("media_ready: no", result.Detail);
        Assert.Contains("Reporting/persistence:", result.Detail);
        Assert.Contains("status_patch_failed", result.Detail);
    }

    [Fact]
    public async Task GlobalFailurePatchFailure_PreservesFullPrimaryFallback()
    {
        var runtime = new Runtime { MediaFailureCode = "media_download_failed", PatchFailureAt = 1, PatchFailureCode = "status_patch_failed" };
        SocialPreparationResult result = await new SocialPreparationOrchestrator(Registry(), () => runtime).RunAsync(Request());
        Assert.False(result.Success);
        Assert.Equal("media_download_failed", result.ErrorCode);
        Assert.Contains("Stable error: media_download_failed", result.Detail);
        Assert.Contains("Reporting/persistence:", result.Detail);
        Assert.Contains("status_patch_failed", result.Detail);
    }

    [Fact]
    public async Task AdapterFailureThenThrownFinalPatchFailure_PreservesPrimaryDiagnostic()
    {
        var primary = new SocialPreparationDiagnostic("x", "media_readiness", "x_media_not_ready");
        primary.Checkpoint("media_ready", false);
        var calls = new List<string>();
        var runtime = new Runtime(calls) { PatchExceptionAt = 8, PatchException = new CdpTransportException(CdpTransportFailure.Disconnected) };
        var adapters = new SocialAdapterRegistry([
            new Adapter("patreon", calls), new Adapter("x", calls, PlatformPreparationResult.Failed(primary)), new Adapter("bluesky", calls),
        ]);

        SocialPreparationResult result = await new SocialPreparationOrchestrator(adapters, () => runtime).RunAsync(Request());

        Assert.False(result.Success);
        Assert.Equal("x_media_not_ready", result.ErrorCode);
        Assert.Contains("Stable error: x_media_not_ready", result.Detail);
        Assert.Contains("media_ready: no", result.Detail);
        Assert.Contains("Reporting/persistence:", result.Detail);
        Assert.Contains("status_reporting_failed", result.Detail);
        Assert.Contains("Error class: cdp_transport", result.Detail);
        Assert.DoesNotContain("Disconnected", result.Detail);
        Assert.True(result.Detail.IndexOf("Stable error: x_media_not_ready", StringComparison.Ordinal) < result.Detail.IndexOf("Reporting/persistence:", StringComparison.Ordinal));
    }

    [Fact]
    public async Task GlobalFailureThrownPatch_ReturnsFullPrimaryFallback()
    {
        var runtime = new Runtime { MediaFailureCode = "media_download_failed", PatchExceptionAt = 1, PatchException = new TimeoutException("private timeout at C:\\private\\reporting") };

        SocialPreparationResult result = await new SocialPreparationOrchestrator(Registry(), () => runtime).RunAsync(Request());

        Assert.False(result.Success);
        Assert.Equal("media_download_failed", result.ErrorCode);
        Assert.Contains("Stable error: media_download_failed", result.Detail);
        Assert.Contains("Reporting/persistence:", result.Detail);
        Assert.Contains("status_reporting_failed", result.Detail);
        Assert.Contains("Error class: timeout", result.Detail);
        Assert.DoesNotContain("private timeout", result.Detail);
    }

    [Fact]
    public async Task DisposeFailureAfterRichFailure_PreservesPrimaryDiagnostic()
    {
        var primary = new SocialPreparationDiagnostic("x", "media_readiness", "x_media_not_ready");
        primary.Checkpoint("media_ready", false);
        var calls = new List<string>();
        var runtime = new Runtime(calls) { DisposeException = new InvalidOperationException("private dispose failure") };
        var adapters = new SocialAdapterRegistry([
            new Adapter("patreon", calls), new Adapter("x", calls, PlatformPreparationResult.Failed(primary)), new Adapter("bluesky", calls),
        ]);

        SocialPreparationResult result = await new SocialPreparationOrchestrator(adapters, () => runtime).RunAsync(Request());

        Assert.False(result.Success);
        Assert.Equal("x_media_not_ready", result.ErrorCode);
        Assert.Contains("Stable error: x_media_not_ready", result.Detail);
        Assert.Contains("media_ready: no", result.Detail);
        Assert.Contains("Stable error: runtime_dispose_failed", result.Detail);
        Assert.Contains("Cleanup:", result.Detail);
    }

    [Fact]
    public async Task DisposeFailureAfterTerminalFailure_ReturnsFallbackDiagnostic()
    {
        var runtime = new Runtime { MediaFailureCode = "media_download_failed", DisposeException = new InvalidOperationException("private dispose failure") };

        SocialPreparationResult result = await new SocialPreparationOrchestrator(Registry(), () => runtime).RunAsync(Request());

        Assert.False(result.Success);
        Assert.Equal("media_download_failed", result.ErrorCode);
        Assert.Contains("Stable error: media_download_failed", result.Detail);
        Assert.Contains("Stable error: runtime_dispose_failed", result.Detail);
        Assert.Contains("Cleanup:", result.Detail);
    }

    [Fact]
    public async Task EarlierFailureThenLaterProbeFailure_PreservesBothDiagnostics()
    {
        var primary = new SocialPreparationDiagnostic("x", "media_readiness", "x_media_not_ready");
        primary.Checkpoint("media_ready", false);
        var calls = new List<string>();
        var runtime = new Runtime(calls) { ProbeFailureAt = 3, ProbeFailureCode = "server_unreachable", ProbeAttempts = [1, 4] };
        var adapters = new SocialAdapterRegistry([
            new Adapter("patreon", calls), new Adapter("x", calls, PlatformPreparationResult.Failed(primary)), new Adapter("bluesky", calls),
        ]);

        SocialPreparationResult result = await new SocialPreparationOrchestrator(adapters, () => runtime).RunAsync(Request());

        Assert.False(result.Success);
        Assert.Equal("x_media_not_ready", result.ErrorCode);
        Assert.Contains("Stable error: x_media_not_ready", result.Detail);
        Assert.Contains("media_ready: no", result.Detail);
        Assert.Contains("Platform: bluesky", result.Detail);
        Assert.Contains("Stable error: server_unreachable", result.Detail);
        Assert.Contains("Attempt: 4", result.Detail);
        string blueskyReport = result.Detail[result.Detail.IndexOf("Platform: bluesky", StringComparison.Ordinal)..];
        Assert.DoesNotContain("Attempt: 4", blueskyReport);
    }

    [Fact]
    public async Task EarlierFailureThenLaterGlobalFailure_PersistsTheLaterPlatformDiagnostic()
    {
        var primary = new SocialPreparationDiagnostic("x", "media_readiness", "x_media_not_ready");
        primary.Checkpoint("media_ready", false);
        var calls = new List<string>();
        var runtime = new Runtime(calls) { ProbeAttempts = [1, 4, 9] };
        var adapters = new SocialAdapterRegistry([
            new Adapter("patreon", calls),
            new Adapter("x", calls, PlatformPreparationResult.Failed(primary)),
            new Adapter("bluesky", calls, exception: new CdpTransportException(CdpTransportFailure.Disconnected)),
        ]);

        SocialPreparationResult result = await new SocialPreparationOrchestrator(adapters, () => runtime).RunAsync(Request());
        string? blueskyMessage = runtime.Writes.Single(write => write.Platform == "bluesky" && write.Status == "failed").Message;

        Assert.False(result.Success);
        Assert.Equal("x_media_not_ready", result.ErrorCode);
        Assert.Contains("Platform: x", result.Detail);
        Assert.Contains("Platform: bluesky", result.Detail);
        Assert.True(result.Detail.IndexOf("Platform: x", StringComparison.Ordinal) < result.Detail.IndexOf("Platform: bluesky", StringComparison.Ordinal));
        using JsonDocument json = JsonDocument.Parse(blueskyMessage!);
        JsonElement diagnostic = json.RootElement;
        Assert.Equal("bluesky", diagnostic.GetProperty("platform").GetString());
        Assert.Equal("lifecycle", diagnostic.GetProperty("phase").GetString());
        Assert.Equal("cdp_transport_failed", diagnostic.GetProperty("stable_code").GetString());
        Assert.Equal("cdp_transport", diagnostic.GetProperty("error_class").GetString());
        Assert.Equal(42, diagnostic.GetProperty("release_id").GetInt32());
        Assert.Equal(9, diagnostic.GetProperty("attempt").GetInt32());
        Assert.DoesNotContain("\"platform\":\"x\"", blueskyMessage);
        Assert.DoesNotContain("\"attempt\":4", blueskyMessage);
    }

    [Fact]
    public async Task VisibleDiagnosticMatchesFirstActiveAttemptAndRetainedReport()
    {
        var diagnostic = new SocialPreparationDiagnostic("x", "media_readiness", "x_media_not_ready");
        var calls = new List<string>();
        var runtime = new Runtime(calls);
        var adapters = new SocialAdapterRegistry([
            new Adapter("patreon", calls), new Adapter("x", calls, PlatformPreparationResult.Failed(diagnostic)), new Adapter("bluesky", calls),
        ]);

        SocialPreparationResult result = await new SocialPreparationOrchestrator(adapters, () => runtime).RunAsync(Request());
        string? retainedDiagnostic = runtime.Writes.Single(write => write.Platform == "x" && write.Status == "failed").Message;

        Assert.Contains("Release ID: 42", result.Detail);
        Assert.Contains("Attempt: 1", result.Detail);
        Assert.Contains("\"release_id\":42", retainedDiagnostic);
        Assert.Contains("\"attempt\":1", retainedDiagnostic);
    }

    [Fact]
    public async Task VisibleDiagnosticMatchesRetryAttemptAndRetainedReport()
    {
        var diagnostic = new SocialPreparationDiagnostic("x", "media_readiness", "x_media_not_ready");
        var calls = new List<string>();
        var runtime = new Runtime(calls) { Attempts = 2 };
        var adapters = new SocialAdapterRegistry([
            new Adapter("patreon", calls), new Adapter("x", calls, PlatformPreparationResult.Failed(diagnostic)), new Adapter("bluesky", calls),
        ]);

        SocialPreparationResult result = await new SocialPreparationOrchestrator(adapters, () => runtime).RunAsync(Request());
        string? retainedDiagnostic = runtime.Writes.Single(write => write.Platform == "x" && write.Status == "failed").Message;

        Assert.Contains("Attempt: 2", result.Detail);
        Assert.Contains("\"attempt\":2", retainedDiagnostic);
    }

    [Theory]
    [InlineData(0)]
    [InlineData(1)]
    [InlineData(2)]
    [InlineData(int.MaxValue)]
    public async Task VisibleDiagnosticRetainsEveryPositiveAttempt(int attempts)
    {
        var diagnostic = new SocialPreparationDiagnostic("x", "media_readiness", "x_media_not_ready");
        var calls = new List<string>();
        var runtime = new Runtime(calls) { Attempts = attempts };
        var adapters = new SocialAdapterRegistry([
            new Adapter("patreon", calls), new Adapter("x", calls, PlatformPreparationResult.Failed(diagnostic)), new Adapter("bluesky", calls),
        ]);

        SocialPreparationResult result = await new SocialPreparationOrchestrator(adapters, () => runtime).RunAsync(Request());
        string? retainedDiagnostic = runtime.Writes.Single(write => write.Platform == "x" && write.Status == "failed").Message;

        if (attempts == 0)
        {
            Assert.DoesNotContain("Attempt:", result.Detail);
            Assert.DoesNotContain("\"attempt\"", retainedDiagnostic);
        }
        else
        {
            Assert.Contains($"Attempt: {attempts}", result.Detail);
            Assert.Contains($"\"attempt\":{attempts}", retainedDiagnostic);
        }
    }

    [Fact]
    public void AdapterSurface_HasNoFinalPublicationMethod()
    {
        string[] forbidden = ["submit", "publish", "post", "confirmpublished", "finalize"];
        string[] methods = typeof(ISocialPreparationAdapter).GetMethods().Select(method => method.Name.ToLowerInvariant()).ToArray();
        Assert.DoesNotContain(methods, method => forbidden.Any(word => method.Contains(word, StringComparison.Ordinal)));
        Assert.DoesNotContain(typeof(ISocialPreparationAdapter).GetMethods().SelectMany(method => method.GetParameters()), parameter => parameter.ParameterType == typeof(SocialCapability));
    }

    private static SocialUriRequest Request() => new(new Uri("https://creatorcrate.test/"), Token);

    private static SocialAdapterRegistry Registry(List<string>? calls = null) => new([
        new Adapter("patreon", calls ?? []), new Adapter("x", calls ?? []), new Adapter("bluesky", calls ?? []),
    ]);

    private sealed class Adapter(string platform, List<string> calls, PlatformPreparationResult? result = null, Exception? exception = null) : ISocialPreparationAdapter
    {
        public string Platform { get; } = platform;
        public async Task<PlatformPreparationResult> PrepareAsync(PlatformPreparationContext context, IPreparationProgress progress, CancellationToken cancellationToken)
        {
            calls.Add($"adapter:{Platform}");
            if (exception is not null) throw exception;
            await progress.ReportAsync(SocialPreparationProgress.Preparing, cancellationToken);
            await progress.ReportAsync(SocialPreparationProgress.Uploading, cancellationToken);
            return result ?? PlatformPreparationResult.Prepared();
        }
    }

    private sealed class Runtime(List<string>? calls = null) : ISocialPreparationRuntime
    {
        private readonly List<string> _calls = calls ?? [];
        public int Redeems { get; private set; }
        public int BrowserConnections { get; private set; }
        public int Probes { get; private set; }
        public int Cleanups { get; private set; }
        public int? ProbeFailureAt { get; init; }
        public string? ProbeFailureCode { get; init; }
        public int? PatchFailureAt { get; init; }
        public string? PatchFailureCode { get; init; }
        public int? PatchExceptionAt { get; init; }
        public Exception? PatchException { get; init; }
        public string? MediaFailureCode { get; init; }
        public Exception? DisposeException { get; init; }
        public int Attempts { get; init; } = 1;
        public IReadOnlyList<int>? ProbeAttempts { get; init; }
        public List<(string Platform, string Status, string? DetailCode, string? Message)> Writes { get; } = [];

        public Task<SocialRedeemResult> RedeemAsync(SocialUriRequest request, CancellationToken cancellationToken)
        {
            Redeems++;
            return Task.FromResult(SocialRedeemResult.Ok(new SocialRedeemResponse(
                "00000000-0000-0000-0000-000000000001", DateTime.UtcNow.AddMinutes(5),
                [Platform("patreon"), Platform("x"), Platform("bluesky")], Token) { ReleaseId = 42 }));
        }

        public Task<SocialStatusResult> GetStatusAsync(SocialCapability capability, CancellationToken cancellationToken)
        {
            Probes++;
            if (ProbeFailureAt == Probes) return Task.FromResult(SocialStatusResult.Fail(ProbeFailureCode!));
            int attempts = ProbeAttempts is not null && Probes <= ProbeAttempts.Count ? ProbeAttempts[Probes - 1] : Attempts;
            return Task.FromResult(SocialStatusResult.Ok(new SocialStatusResponse(capability.SessionId, "redeemed", DateTime.UtcNow.AddMinutes(5), [
                new SocialPlatformStatus("patreon", "pending", null, attempts, null), new SocialPlatformStatus("x", "pending", null, attempts, null), new SocialPlatformStatus("bluesky", "pending", null, attempts, null),
            ])));
        }

        public Task<SocialPlatformStatusResult> PatchAsync(SocialCapability capability, string platform, string status, string? detailCode, string? message, CancellationToken cancellationToken)
        {
            Writes.Add((platform, status, detailCode, message));
            if (PatchExceptionAt == Writes.Count) return Task.FromException<SocialPlatformStatusResult>(PatchException!);
            if (PatchFailureAt == Writes.Count) return Task.FromResult(SocialPlatformStatusResult.Fail(PatchFailureCode!));
            return Task.FromResult(SocialPlatformStatusResult.Ok(new SocialPlatformStatus(platform, status, detailCode, Attempts, null)));
        }

        public Task<IReadOnlyList<string>> PrepareMediaAsync(SocialCapability capability, SocialRedeemPlatform platform, CancellationToken cancellationToken)
        {
            if (MediaFailureCode is not null) throw new SocialPreparationRuntimeException(MediaFailureCode);
            return Task.FromResult<IReadOnlyList<string>>([@"C:\fixture\media.png"]);
        }
        public Task<BrowserPreparationTargets?> ConnectBrowserAsync(CancellationToken cancellationToken) { BrowserConnections++; return Task.FromResult<BrowserPreparationTargets?>(null); }
        public Task CleanupMediaAsync(SocialCapability capability) { Cleanups++; return Task.CompletedTask; }
        public ValueTask DisposeAsync() => DisposeException is null ? ValueTask.CompletedTask : ValueTask.FromException(DisposeException);
        private static SocialRedeemPlatform Platform(string platform) => new(platform, "title", "body", [new SocialRedeemAsset(1, "attachment", 0, "media.png", ".png", "image/png", 1, "media.png", true, null)]);
    }
}
