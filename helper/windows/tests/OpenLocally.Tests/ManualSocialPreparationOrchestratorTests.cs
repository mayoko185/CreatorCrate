using OpenLocally;

namespace OpenLocally.Tests;

public class ManualSocialPreparationOrchestratorTests
{
    private static readonly SocialUriRequest Request = new(
        SocialUriRequestParser.ManualVersion,
        new Uri("https://creatorcrate.test/"),
        new string('a', 43));

    [Fact]
    public async Task ProductionManualRuntime_HasNoBrowserOrAdapterDependency()
    {
        IManualSocialPreparationRuntime runtime = ProductionManualSocialPreparationComposition.CreateRuntime();
        string[] dependencyTypes = runtime.GetType()
            .GetFields(System.Reflection.BindingFlags.Instance | System.Reflection.BindingFlags.NonPublic)
            .Select(field => field.FieldType.FullName ?? field.FieldType.Name)
            .ToArray();

        Assert.IsType<ProductionManualSocialPreparationRuntime>(runtime);
        Assert.DoesNotContain(dependencyTypes, IsLegacyBrowserAutomationType);
        await runtime.DisposeAsync();
    }

    [Fact]
    public void ProductionAssembly_ContainsNoLegacyBrowserAutomationTypes()
    {
        string[] productionTypes = typeof(CommandDispatcher).Assembly
            .GetTypes()
            .Select(type => type.FullName ?? type.Name)
            .ToArray();
        string[] productionReferences = typeof(CommandDispatcher).Assembly
            .GetReferencedAssemblies()
            .Select(reference => reference.Name ?? string.Empty)
            .ToArray();

        Assert.DoesNotContain(productionTypes, IsLegacyBrowserAutomationType);
        Assert.DoesNotContain(productionReferences, IsBrowserAutomationAssembly);
    }

    [Fact]
    public void LegacyBrowserAutomationGuard_AllowsNativeWindowChromeIdentifiers()
    {
        Assert.False(IsLegacyBrowserAutomationType("OpenLocally.NativeCompanionChromeRole"));
        Assert.False(IsLegacyBrowserAutomationType("OpenLocally.NativeHeaderChromeStyle"));
    }

    [Theory]
    [InlineData("OpenLocally.CdpTransport")]
    [InlineData("OpenLocally.ChromeConnectionWorkflow")]
    [InlineData("OpenLocally.NativeChromeConnectionConsent")]
    [InlineData("OpenLocally.IChromeDiscoveryFile")]
    [InlineData("OpenLocally.ChromeDiscoveryFile")]
    [InlineData("OpenLocally.ChromeEndpoint")]
    [InlineData("OpenLocally.BrowserDomNode")]
    [InlineData("OpenLocally.BrowserPreparationSession")]
    [InlineData("OpenLocally.PatreonSocialPreparationAdapter")]
    [InlineData("OpenLocally.WebSocketConnectionException")]
    [InlineData("OpenLocally.WebSocketCloseOutcome")]
    [InlineData("OpenLocally.SocialAdapterRegistry")]
    [InlineData("OpenLocally.ProductionSocialPreparationRuntime")]
    public void LegacyBrowserAutomationGuard_RejectsRepresentativeRemovedTypes(string typeName)
    {
        Assert.True(IsLegacyBrowserAutomationType(typeName));
    }

    private static readonly string[] LegacyBrowserAutomationTypeRoots =
    [
        "BlueskySocialPreparationAdapter",
        "BrowserFileChooser",
        "BrowserDomNode",
        "BrowserNavigationResult",
        "BrowserPreparation",
        "BrowserTargetSelector",
        "BrowserText",
        "ChromeConnection",
        "ChromeDiscovery",
        "ChromeEndpoint",
        "ChromeEnvironment",
        "ClientWebSocketConnection",
        "IChromeConnection",
        "IChromeDiscovery",
        "IChromeEnvironment",
        "ISocialPreparationAdapter",
        "IWebSocketConnection",
        "NativeChromeConnection",
        "PatreonSocialPreparationAdapter",
        "ProductionSocialPreparationRuntime",
        "SocialAdapterRegistry",
        "WebSocketClose",
        "WebSocketConnection",
        "XSocialPreparationAdapter",
    ];

    private static bool IsLegacyBrowserAutomationType(string fullName)
    {
        string typeName = fullName[(fullName.LastIndexOf('.') + 1)..];
        return typeName.StartsWith("Cdp", StringComparison.Ordinal) ||
            LegacyBrowserAutomationTypeRoots.Any(root =>
                typeName.StartsWith(root, StringComparison.Ordinal));
    }

    private static bool IsBrowserAutomationAssembly(string assemblyName) =>
        assemblyName.Equals("Microsoft.Playwright", StringComparison.Ordinal) ||
        assemblyName.Equals("WebDriver", StringComparison.Ordinal) ||
        assemblyName.Equals("PuppeteerSharp", StringComparison.Ordinal);

    [Fact]
    public async Task RunAsync_RedeemsOnce_PreservesExactContentAndAssetOrder_AndUsesOnlyManualStates()
    {
        var first = Asset(11, "primary", 7, "uno-雪.png", 3);
        var second = Asset(12, "attachment", 9, "two.png", 4);
        var runtime = new FakeRuntime(Response(
            new SocialRedeemPlatform("patreon", "Título ✓\nsecond line", "Body one\r\n\r\nBody two 🐈", [first, second]),
            new SocialRedeemPlatform("x", "Título ✓\nsecond line", "Exact X text\n\nUnicode 雪", [second]),
            new SocialRedeemPlatform("bluesky", "Título ✓\nsecond line", "Exact Bluesky text\r\nnext", [])));
        var orchestrator = Orchestrator(runtime);

        ManualSocialPreparationResult result = await orchestrator.RunAsync(Request);

        Assert.True(result.Success);
        Assert.Equal(1, runtime.RedeemCalls);
        Assert.Equal(new[] { "staging", "staging", "staging", "ready", "ready", "ready" }, runtime.Patches.Select(call => call.Status));
        Assert.DoesNotContain(runtime.Patches, call => call.Status is "starting" or "preparing" or "uploading" or "auth_required" or "prepared");
        Assert.All(runtime.Patches, call => Assert.Null(call.Message));
        ManualSocialSession session = result.Session!;
        Assert.Equal(Request.ServerOrigin, session.ServerOrigin);
        Assert.Equal(42, session.ReleaseId);
        Assert.Equal("Título ✓\nsecond line", session.ReleaseTitle);
        Assert.Equal(new[] { "patreon", "x", "bluesky" }, session.Platforms.Select(platform => platform.Platform));
        Assert.Equal("Título ✓\nsecond line", session.Platforms[0].Title);
        Assert.Equal("Body one\r\n\r\nBody two 🐈", session.Platforms[0].Body);
        Assert.Equal("Exact X text\n\nUnicode 雪", session.Platforms[1].Body);
        Assert.Equal("Exact Bluesky text\r\nnext", session.Platforms[2].Body);
        Assert.DoesNotContain("Notes", string.Join("|", session.Platforms.SelectMany(platform => new[] { platform.Title, platform.Body })));
        Assert.Equal(new long[] { 11, 12 }, session.Platforms[0].Assets.Select(asset => asset.Asset.AssetId));
        Assert.Equal(new[] { 7L, 9L }, session.Platforms[0].Assets.Select(asset => asset.Asset.SortOrder));
        Assert.Equal(new[] { 0, 1, 0 }, runtime.PreparedAssets.Select(call => call.Ordinal));
        Assert.Equal(new long[] { 11, 12, 12 }, runtime.EnsuredAssets);
        Assert.True(runtime.CleanupCalled);
        Assert.True(runtime.Disposed);
    }

    [Fact]
    public async Task RunAsync_RedeemFailure_PreservesStructuredDiagnostic()
    {
        var diagnostic = new ManualSocialDiagnostic(
            "redeem_payload_invalid", ManualSocialDiagnosticStage.RedeemPreparation,
            ManualSocialDiagnosticReason.InvalidMediaToken, HttpStatus: 200);
        var runtime = new FakeRuntime(Response(new SocialRedeemPlatform("x", "Title", "Body", [])))
        {
            RedeemResult = SocialRedeemResult.Fail("redeem_payload_invalid", diagnostic),
        };

        ManualSocialPreparationResult result = await Orchestrator(runtime).RunAsync(Request);

        Assert.False(result.Success);
        Assert.Same(diagnostic, result.Diagnostic);
        Assert.Empty(runtime.Patches);
    }

    [Fact]
    public async Task RunAsync_MediaFailure_ReportsFailedAndCancelledButNeverReady()
    {
        var runtime = new FakeRuntime(Response(
            new SocialRedeemPlatform("patreon", "Title", "Body", [Asset(11, "primary", 0, "one.png", 3)]),
            new SocialRedeemPlatform("x", "Title", "Post", [Asset(12, "attachment", 0, "two.png", 4)])))
        {
            Stage = (asset, ordinal, _) => Task.FromResult(
                asset.AssetId == 11 ? StagedMedia.Fail("media_token_expired") : StagedMedia.Owned(@"C:\staged\two.png")),
        };

        ManualSocialPreparationResult result = await Orchestrator(runtime).RunAsync(Request);

        Assert.False(result.Success);
        Assert.Equal("media_token_expired", result.ErrorCode);
        Assert.Equal(new[] { "staging", "staging", "failed", "cancelled" }, runtime.Patches.Select(call => call.Status));
        Assert.DoesNotContain(runtime.Patches, call => call.Status == "ready");
    }

    [Fact]
    public async Task RunAsync_FinalAvailabilityFailure_DoesNotExposeOrReportReady()
    {
        var runtime = new FakeRuntime(Response(
            new SocialRedeemPlatform("x", "Title", "Post", [Asset(11, "primary", 0, "one.png", 3)])))
        {
            Ensure = (_, _, _, _) => Task.FromResult(StagedMedia.Fail("media_file_missing")),
        };

        ManualSocialPreparationResult result = await Orchestrator(runtime).RunAsync(Request);

        Assert.False(result.Success);
        Assert.Null(result.Session);
        Assert.Equal("media_file_missing", result.ErrorCode);
        Assert.Equal(new[] { "staging", "failed" }, runtime.Patches.Select(call => call.Status));
    }

    [Fact]
    public async Task RunAsync_CancellationAfterRedemption_UsesCancelledOnly()
    {
        using var cancellation = new CancellationTokenSource();
        var runtime = new FakeRuntime(Response(
            new SocialRedeemPlatform("x", "Title", "Post", [Asset(11, "primary", 0, "one.png", 3)])))
        {
            Stage = (_, _, _) =>
            {
                cancellation.Cancel();
                throw new OperationCanceledException(cancellation.Token);
            },
        };

        ManualSocialPreparationResult result = await Orchestrator(runtime)
            .RunAsync(Request, cancellation.Token);

        Assert.False(result.Success);
        Assert.Equal(SocialPreparationResultCategory.Cancelled, result.Category);
        Assert.Equal(new[] { "staging", "cancelled" }, runtime.Patches.Select(call => call.Status));
    }

    [Fact]
    public async Task RunAsync_CallerCancellationDuringRedemption_RemainsCancelled()
    {
        using var cancellation = new CancellationTokenSource();
        var runtime = new FakeRuntime(Response())
        {
            Redeem = token =>
            {
                cancellation.Cancel();
                throw new OperationCanceledException(token);
            },
        };

        ManualSocialPreparationResult result = await Orchestrator(runtime)
            .RunAsync(Request, cancellation.Token);

        Assert.False(result.Success);
        Assert.Equal("caller_cancelled", result.ErrorCode);
        Assert.Equal(SocialPreparationResultCategory.Cancelled, result.Category);
        Assert.NotEqual(ManualSocialDiagnosticReason.RequestNotSent, result.Diagnostic!.Reason);
        Assert.Empty(runtime.Patches);
    }

    [Fact]
    public async Task RunAsync_LegacyRequestFailsBeforeRuntimeAndRedemption()
    {
        int constructions = 0;
        var orchestrator = new ManualSocialPreparationOrchestrator(() =>
        {
            constructions++;
            return new FakeRuntime(Response(new SocialRedeemPlatform("x", "Title", "Post", [])));
        }, new ImmediateCompanion());

        ManualSocialPreparationResult result = await orchestrator.RunAsync(Request with { Version = 1 });

        Assert.False(result.Success);
        Assert.Equal(0, constructions);
    }

    [Fact]
    public async Task RunAsync_WindowUsablePrecedesReady_AndLeaseOutlivesServerAttempt()
    {
        var runtime = new FakeRuntime(Response(new SocialRedeemPlatform(
            "x", "Release", "Exact post", [Asset(11, "primary", 0, "one.png", 3)])));
        var companion = new ControlledCompanion();
        Task<ManualSocialPreparationResult> run = new ManualSocialPreparationOrchestrator(() => runtime, companion).RunAsync(Request);

        await companion.Opened.Task.WaitAsync(TimeSpan.FromSeconds(2));
        Assert.Equal(new[] { "staging" }, runtime.Patches.Select(call => call.Status));
        Assert.True(runtime.LeaseDetached);
        Assert.False(companion.Lease!.Disposed);

        companion.MarkReady();
        await WaitUntilAsync(() => runtime.Patches.Count == 2);
        Assert.Equal(new[] { "staging", "ready" }, runtime.Patches.Select(call => call.Status));
        Assert.False(run.IsCompleted);
        Assert.False(companion.Lease.Disposed);
        Assert.False(runtime.Disposed);

        companion.Close();
        ManualSocialPreparationResult result = await run.WaitAsync(TimeSpan.FromSeconds(2));
        Assert.True(result.Success);
        Assert.True(companion.Lease.Disposed);
        Assert.True(runtime.Disposed);
        Assert.Single(runtime.Patches.Where(call => call.Status == "ready"));
        Assert.DoesNotContain(runtime.Patches, call => call.Status == "cancelled");
    }

    [Fact]
    public async Task RunAsync_ComposesConfirmationControllerForOptInCompanion_WithoutAutomaticPost()
    {
        var runtime = new FakeRuntime(Response(new SocialRedeemPlatform("x", "Release", "Post", [])));
        var companion = new ConfirmationCompanion();

        ManualSocialPreparationResult result = await new ManualSocialPreparationOrchestrator(() => runtime, companion)
            .RunAsync(Request);

        Assert.True(result.Success);
        Assert.Same(runtime.PostingConfirmation, companion.PostingConfirmation);
        Assert.Equal(0, runtime.ConfirmationTransport.PostCalls);
        Assert.Equal(new[] { "staging", "ready" }, runtime.Patches.Select(call => call.Status));
        Assert.Equal(1, runtime.ConfirmationTransport.DisposeCalls);
        await Assert.ThrowsAsync<ObjectDisposedException>(() => companion.PostingConfirmation!.ConfirmAsync("x"));
    }

    [Fact]
    public async Task RunAsync_WindowInitializationFailure_PreventsReadyAndReleasesLease()
    {
        var runtime = new FakeRuntime(Response(new SocialRedeemPlatform("x", "Release", "Post", [])));
        var companion = new ControlledCompanion();
        Task<ManualSocialPreparationResult> run = new ManualSocialPreparationOrchestrator(() => runtime, companion).RunAsync(Request);
        await companion.Opened.Task.WaitAsync(TimeSpan.FromSeconds(2));

        companion.FailReady();
        ManualSocialPreparationResult result = await run.WaitAsync(TimeSpan.FromSeconds(2));

        Assert.False(result.Success);
        Assert.Equal(ManualSocialPreparationOrchestrator.CompanionFailureCode, result.ErrorCode);
        Assert.DoesNotContain(runtime.Patches, call => call.Status == "ready");
        Assert.Contains(runtime.Patches, call => call.Status == "failed");
        Assert.True(companion.Lease!.Disposed);
    }

    [Fact]
    public async Task RunAsync_WindowClosesBeforeReady_PreventsServerReadyAndReleasesLease()
    {
        var runtime = new FakeRuntime(Response(new SocialRedeemPlatform("x", "Release", "Post", [])));
        var companion = new ControlledCompanion();
        Task<ManualSocialPreparationResult> run = new ManualSocialPreparationOrchestrator(() => runtime, companion).RunAsync(Request);
        await companion.Opened.Task.WaitAsync(TimeSpan.FromSeconds(2));

        companion.CloseBeforeReady();
        ManualSocialPreparationResult result = await run.WaitAsync(TimeSpan.FromSeconds(2));

        Assert.False(result.Success);
        Assert.Equal(ManualSocialPreparationOrchestrator.CompanionFailureCode, result.ErrorCode);
        Assert.DoesNotContain(runtime.Patches, call => call.Status == "ready");
        Assert.Contains(runtime.Patches, call => call.Status == "failed");
        Assert.True(companion.Lease!.Disposed);
    }

    private static SocialRedeemResponse Response(params SocialRedeemPlatform[] platforms) =>
        new(Guid.NewGuid().ToString(), new DateTime(2026, 9, 13, 12, 0, 0), platforms, new string('b', 43)) { ReleaseId = 42 };

    private static SocialRedeemAsset Asset(long id, string role, long sortOrder, string filename, long size) =>
        new(id, role, sortOrder, filename, Path.GetExtension(filename), "image/png", size,
            $"release/{filename}", true, $@"C:\source\release\{filename}");

    private static ManualSocialPreparationOrchestrator Orchestrator(FakeRuntime runtime) =>
        new(() => runtime, new ImmediateCompanion());

    private sealed class ImmediateCompanion : IManualSocialCompanion
    {
        public IManualSocialCompanionLifetime Open(
            ManualSocialSession session, IDisposable mediaLease, IManualAssetAvailability availability) => new Lifetime(mediaLease);
        private sealed class Lifetime(IDisposable lease) : IManualSocialCompanionLifetime
        {
            public Task Ready => Task.CompletedTask;
            public Task Closed => Task.CompletedTask;
            public void Dispose() => lease.Dispose();
        }
    }

    private sealed class ControlledCompanion : IManualSocialCompanion
    {
        private readonly TaskCompletionSource _ready = new(TaskCreationOptions.RunContinuationsAsynchronously);
        private readonly TaskCompletionSource _closed = new(TaskCreationOptions.RunContinuationsAsynchronously);
        public TaskCompletionSource Opened { get; } = new(TaskCreationOptions.RunContinuationsAsynchronously);
        public RecordingLease? Lease { get; private set; }

        public IManualSocialCompanionLifetime Open(
            ManualSocialSession session, IDisposable mediaLease, IManualAssetAvailability availability)
        {
            Lease = Assert.IsType<RecordingLease>(mediaLease);
            Opened.TrySetResult();
            return new Lifetime(_ready.Task, _closed.Task, () => Lease.Dispose());
        }

        public void MarkReady() => _ready.TrySetResult();
        public void FailReady() { _ready.TrySetException(new InvalidOperationException("window failed")); Close(); }
        public void CloseBeforeReady() { _ready.TrySetException(new InvalidOperationException("window closed before ready")); Close(); }
        public void Close() { Lease?.Dispose(); _closed.TrySetResult(); }

        private sealed class Lifetime(Task ready, Task closed, Action dispose) : IManualSocialCompanionLifetime
        {
            public Task Ready => ready;
            public Task Closed => closed;
            public void Dispose() => dispose();
        }
    }

    private sealed class ConfirmationCompanion : IManualSocialCompanion, IManualPostingConfirmationCompanion
    {
        public ManualPostingConfirmationController? PostingConfirmation { get; private set; }

        public IManualSocialCompanionLifetime Open(
            ManualSocialSession session, IDisposable mediaLease, IManualAssetAvailability availability) =>
            throw new InvalidOperationException("Confirmation composition was not used.");

        public IManualSocialCompanionLifetime OpenWithPostingConfirmation(
            ManualSocialSession session, IDisposable mediaLease, IManualAssetAvailability availability,
            IManualAssetPreviewAccess? previewAccess, ManualPostingConfirmationController confirmation)
        {
            PostingConfirmation = confirmation;
            previewAccess?.Dispose();
            return new Lifetime(mediaLease);
        }

        private sealed class Lifetime(IDisposable lease) : IManualSocialCompanionLifetime
        {
            public Task Ready => Task.CompletedTask;
            public Task Closed => Task.CompletedTask;
            public void Dispose() => lease.Dispose();
        }
    }

    private sealed class FakeRuntime(SocialRedeemResponse response) :
        IManualSocialPreparationRuntime, IManualPostingConfirmationProvider
    {
        public SocialRedeemResult RedeemResult { get; init; } = SocialRedeemResult.Ok(response);
        public int RedeemCalls { get; private set; }
        public List<(string Platform, string Status, string? Detail, string? Message)> Patches { get; } = [];
        public List<(long AssetId, int Ordinal)> PreparedAssets { get; } = [];
        public List<long> EnsuredAssets { get; } = [];
        public bool CleanupCalled { get; private set; }
        public bool LeaseDetached { get; private set; }
        public bool Disposed { get; private set; }
        public TaskCompletionSource RuntimeDisposed { get; } = new(TaskCreationOptions.RunContinuationsAsynchronously);
        public ConfirmationTransport ConfirmationTransport { get; } = new();
        public ManualPostingConfirmationController? PostingConfirmation { get; private set; }
        public Func<SocialRedeemAsset, int, CancellationToken, Task<StagedMedia>> Stage { get; init; } =
            (asset, ordinal, _) => Task.FromResult(StagedMedia.Owned($@"C:\staged\{ordinal:D4}-{asset.AssetId}{asset.Extension}"));
        public Func<SocialRedeemAsset, int, StagedMedia, CancellationToken, Task<StagedMedia>> Ensure { get; init; } =
            (_, _, media, _) => Task.FromResult(media);
        public Func<CancellationToken, Task<SocialRedeemResult>>? Redeem { get; init; }

        public Task<SocialRedeemResult> RedeemAsync(SocialUriRequest request, CancellationToken cancellationToken)
        {
            RedeemCalls++;
            return Redeem?.Invoke(cancellationToken) ?? Task.FromResult(RedeemResult);
        }

        public Task<SocialPlatformStatusResult> PatchAsync(
            SocialCapability capability, string platform, string status, string? detailCode,
            string? message, CancellationToken cancellationToken)
        {
            Patches.Add((platform, status, detailCode, message));
            return Task.FromResult(SocialPlatformStatusResult.Ok(new(platform, status, detailCode, 1, null)));
        }

        public Task<StagedMedia> StageAssetAsync(
            SocialCapability capability, SocialRedeemAsset asset, int ordinal, CancellationToken cancellationToken)
        {
            PreparedAssets.Add((asset.AssetId, ordinal));
            return Stage(asset, ordinal, cancellationToken);
        }

        public Task<StagedMedia> EnsureAssetAvailableAsync(
            SocialCapability capability, SocialRedeemAsset asset, int ordinal,
            StagedMedia media, CancellationToken cancellationToken)
        {
            EnsuredAssets.Add(asset.AssetId);
            return Ensure(asset, ordinal, media, cancellationToken);
        }

        public Task CleanupMediaAsync(SocialCapability capability)
        {
            CleanupCalled = true;
            return Task.CompletedTask;
        }

        public IDisposable DetachMediaLease(SocialCapability capability)
        {
            LeaseDetached = true;
            return new RecordingLease();
        }

        ManualPostingConfirmationController IManualPostingConfirmationProvider.CreatePostingConfirmation(
            SocialCapability capability, IReadOnlyList<string> platforms)
        {
            PostingConfirmation = new ManualPostingConfirmationController(ConfirmationTransport, platforms);
            return PostingConfirmation;
        }

        public ValueTask DisposeAsync()
        {
            Disposed = true;
            RuntimeDisposed.TrySetResult();
            return ValueTask.CompletedTask;
        }
    }

    private sealed class ConfirmationTransport : IManualPostingConfirmationTransport
    {
        public DateTime? ConfirmationExpiresAt => null;
        public int PostCalls { get; private set; }
        public int DisposeCalls { get; private set; }
        public Task<ManualPostingTransportResult> PostAsync(string platform, CancellationToken cancellationToken)
        {
            PostCalls++;
            return Task.FromResult(ManualPostingTransportResult.Ambiguous());
        }
        public Task<ManualPostingTransportResult> GetAsync(string platform, CancellationToken cancellationToken) =>
            Task.FromResult(ManualPostingTransportResult.Ambiguous());
        public void Dispose() => DisposeCalls++;
    }

    private sealed class RecordingLease : IDisposable
    {
        public bool Disposed { get; private set; }
        public void Dispose() => Disposed = true;
    }

    private static async Task WaitUntilAsync(Func<bool> condition)
    {
        using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(2));
        while (!condition()) await Task.Delay(10, timeout.Token);
    }
}
