using System.Diagnostics;
using System.Net;
using System.Security.Cryptography;
using OpenLocally;
using OpenLocally.Tests;

namespace OpenLocally.Tests.Manual;

/// <summary>Operator-run non-Chrome checks. Every external effect is blocked unless the caller explicitly sets CREATORCRATE_M2_MANUAL=1.</summary>
[Trait("Category", "Manual")]
public sealed class ManualFoundationHarnessTests : IDisposable
{
    private readonly string _root = Path.Combine(Path.GetTempPath(), "creatorcrate-m2-manual-test-" + Guid.NewGuid().ToString("N"));

    [Fact]
    public Task RunDeterministicFoundationWorkflow()
    {
        ManualFoundationGuard.RequireOptIn();

        return new ManualFoundationWorkflow(
            ManualFoundationGuard.RequireOptIn,
            new ManualWorkflowFileReporter(),
            new ManualFileWorkflowConfirmation(),
            [
                new ManualWorkflowStage("Production gate", "MANUAL CHECK — Production gate\nVerify the temporary published helper rejects the valid social URI before any fixture request.", TimeSpan.FromSeconds(90), (_, _) => ProductionGate_RejectsValidSocialUriBeforeFixtureRequests()),
                new ManualWorkflowStage("Open Locally", "MANUAL CHECK - Open Locally\nExplorer should open and reveal the harmless test fixture.", TimeSpan.FromMinutes(5), OpenLocally_UsesTemporaryPublishedHelperAndLeavesSocialFixtureUntouched),
                new ManualWorkflowStage("Social registration", "MANUAL CHECK — Social registration\nThe temporary helper will register and unregister only creatorcrate-social.", TimeSpan.FromSeconds(90), (_, _) =>
                {
                    SocialRegistration_ChangesOnlyTheSocialProtocol();
                    return Task.CompletedTask;
                }),
                new ManualWorkflowStage("Origin trust", "MANUAL CHECK - Origin trust DENY\nA separate Windows confirmation dialog will appear. It may open behind or minimized.\nIf you do not see it, use Alt+Tab to bring it forward.\n\nFor this step:\nClick NO / DENY.", TimeSpan.FromMinutes(5), OriginTrust_DenyAllowReuseAndDistinctOriginsUseExactIdentities),
                new ManualWorkflowStage("TLS validation", "MANUAL CHECK — TLS validation\nThe harmless self-signed fixture must be rejected by normal certificate validation.", TimeSpan.FromSeconds(90), (_, _) => TlsFixture_IsRejectedByNormalValidation()),
                new ManualWorkflowStage("Media staging", "MANUAL CHECK - Media-root trust ALLOW\nA separate Windows confirmation dialog may appear for the normalized harmless fixture origin and temporary project root. It may open behind or minimized.\nIf you do not see it, use Alt+Tab.\n\nFor this step:\nClick YES / ALLOW.", TimeSpan.FromMinutes(5), StrategyAAndB_KeepExternalSourceAndCleanOnlyOwnedStaging),
                new ManualWorkflowStage("Startup sweep", "MANUAL CHECK — Startup sweep\nOnly the injected harmless staging root is eligible for this cleanup check.", TimeSpan.FromSeconds(90), (_, _) =>
                {
                    Sweep_UsesOnlyInjectedRootAndDeletesOnlyOldOwnedDirectory();
                    return Task.CompletedTask;
                }),
                new ManualWorkflowStage("Chrome", "MANUAL CHECK - Chrome Remote Debugging\nNormal stable Chrome must already be running with Remote Debugging enabled.\n\nChrome itself should display its Remote Debugging Allow/Deny prompt.\nThis is NOT the CreatorCrate origin-trust dialog.\nIf it appears behind another window, bring Chrome forward.\n\nClick ALLOW in Chrome. The helper then runs one harmless fixture tab automatically; no editor, file chooser, or native file dialog interaction is required.", TimeSpan.FromMinutes(12), BrowserFixture_PreparesOneOwnedTargetOverOneApprovedChromeConnection),
            ],
            CleanupAsync).RunAsync(CancellationToken.None);
    }

    private Task ProductionGate_RejectsValidSocialUriBeforeFixtureRequests()
    {
        ManualFoundationGuard.RequireOptIn();
        string helper = Helper();
        string uri = DiagnosticSocialRequest.RequireFromEnvironment();
        ProcessResult result = Run(helper, uri, captureLaunchContext: true);
        Assert.NotEqual(0, result.ExitCode);
        Assert.DoesNotContain("intent is malformed", result.Output, StringComparison.OrdinalIgnoreCase);
        Assert.True(
            result.Output.Contains("production_adapters_unavailable", StringComparison.Ordinal),
            ProductionGateFailure(result));
        return Task.CompletedTask;
    }

    private async Task OpenLocally_UsesTemporaryPublishedHelperAndLeavesSocialFixtureUntouched(ManualWorkflowStageContext context, CancellationToken cancellationToken)
    {
        ManualFoundationGuard.RequireOptIn();
        string helper = Helper();
        ManualOpenLocallyRequest request = ManualOpenLocallyRequest.Create(_root);
        Assert.True(File.Exists(request.FixturePath));
        Assert.False((File.GetAttributes(request.FixturePath) & FileAttributes.Directory) != 0);

        UriParseResult parsed = UriRequestParser.Parse(request.Uri);
        Assert.True(parsed.Success);
        Assert.Equal(request.FixturePath, parsed.Request!.Path);
        Assert.True(parsed.Request.Select);

        ProcessResult result = Run(helper, request.Uri);
        Assert.True(result.ExitCode == 0, OpenLocallyFailure(result, request));
        Assert.True(File.Exists(request.FixturePath));

        await context.ConfirmAsync(
            "explorer_revealed_fixture",
            """
            MANUAL CHECK - Open Locally

            Explorer should have opened and revealed the harmless test fixture.

            Did Explorer open/reveal the expected fixture?

            [Y] Yes
            [N] No
            """,
            cancellationToken);

        Assert.NotEqual(0, Run(helper, "creatorcrate-open://open?v=2&path=%ZZ&select=1").ExitCode);
    }

    private void SocialRegistration_ChangesOnlyTheSocialProtocol()
    {
        ManualFoundationGuard.RequireOptIn();
        string helper = Helper();
        string? openCommand = Microsoft.Win32.Registry.CurrentUser.OpenSubKey(@"Software\Classes\creatorcrate-open\shell\open\command", writable: false)?.GetValue(null) as string;
        Assert.Equal(0, Run(helper, "--register-social").ExitCode);
        Assert.Equal($"\"{helper}\" \"%1\"", Microsoft.Win32.Registry.CurrentUser.OpenSubKey(@"Software\Classes\creatorcrate-social\shell\open\command", writable: false)?.GetValue(null));
        Assert.Equal(openCommand, Microsoft.Win32.Registry.CurrentUser.OpenSubKey(@"Software\Classes\creatorcrate-open\shell\open\command", writable: false)?.GetValue(null) as string);
        Assert.Equal(0, Run(helper, "--unregister-social").ExitCode);
        Assert.Null(Microsoft.Win32.Registry.CurrentUser.OpenSubKey(@"Software\Classes\creatorcrate-social", writable: false));
        Assert.Equal(openCommand, Microsoft.Win32.Registry.CurrentUser.OpenSubKey(@"Software\Classes\creatorcrate-open\shell\open\command", writable: false)?.GetValue(null) as string);
    }

    private async Task OriginTrust_DenyAllowReuseAndDistinctOriginsUseExactIdentities(ManualWorkflowStageContext context, CancellationToken cancellationToken)
    {
        ManualFoundationGuard.RequireOptIn();
        await using var fixture = await ManualCreatorCrateFixture.StartAsync();
        SocialOrigin loopback = SocialOrigin.Parse(fixture.Origin);
        var store = new WindowsTrustedOriginStore();
        var client = RedeemClient(store, new NativeOriginTrustPrompt());
        Assert.Equal("server_origin_denied", (await client.RedeemAsync(loopback, ManualCreatorCrateFixture.MediaToken, CancellationToken.None)).ErrorCode);
        Assert.Equal(0, fixture.RequestCount);
        Assert.False(store.IsTrusted(loopback));
        context.Checkpoint($"MANUAL CHECK - Origin trust ALLOW\nA separate Windows confirmation dialog will appear for: {loopback.Identity}\nIt may open behind or minimized. If you do not see it, use Alt+Tab.\n\nClick YES / ALLOW.");
        Assert.True((await client.RedeemAsync(loopback, ManualCreatorCrateFixture.MediaToken, cancellationToken)).Success);
        Assert.True((await client.RedeemAsync(loopback, ManualCreatorCrateFixture.MediaToken, cancellationToken)).Success);
        Assert.True(store.IsTrusted(loopback));
        Assert.True(SocialOrigin.TryParse($"http://localhost:{fixture.Origin.Port}/", out SocialOrigin? localhost));
        Assert.False(store.IsTrusted(localhost!));
        context.Checkpoint("MANUAL CHECK - Origin trust ALLOW\nA separate Windows confirmation dialog will appear for the distinct localhost identity.\nIt may open behind or minimized. If you do not see it, use Alt+Tab.\n\nClick YES / ALLOW.");
        Assert.True((await client.RedeemAsync(localhost!, ManualCreatorCrateFixture.MediaToken, cancellationToken)).Success);
        Assert.True(store.IsTrusted(localhost!));
        await using var changedPortFixture = await ManualCreatorCrateFixture.StartAsync();
        SocialOrigin changedPort = SocialOrigin.Parse(changedPortFixture.Origin);
        Assert.False(store.IsTrusted(changedPort));
        context.Checkpoint("MANUAL CHECK - Origin trust ALLOW\nA separate Windows confirmation dialog will appear for the distinct port identity.\nIt may open behind or minimized. If you do not see it, use Alt+Tab.\n\nClick YES / ALLOW.");
        Assert.True((await client.RedeemAsync(changedPort, ManualCreatorCrateFixture.MediaToken, cancellationToken)).Success);
        context.Checkpoint("MANUAL DIAGNOSTIC - Origin trust\nDeny produced no request. Allow/reuse/different host/different port completed with exact normalized identities.");
    }

    private async Task TlsFixture_IsRejectedByNormalValidation()
    {
        ManualFoundationGuard.RequireOptIn();
        await using var fixture = await ManualTlsFixture.StartAsync();
        SocialRedeemResult result = await RedeemClient(new MemoryOriginStore(), new RecordingOriginPrompt(true)).RedeemAsync(SocialOrigin.Parse(fixture.Origin), ManualCreatorCrateFixture.MediaToken, CancellationToken.None);
        Assert.Equal("tls_validation_failed", result.ErrorCode);
    }

    private async Task StrategyAAndB_KeepExternalSourceAndCleanOnlyOwnedStaging(ManualWorkflowStageContext context, CancellationToken cancellationToken)
    {
        ManualFoundationGuard.RequireOptIn();
        await using var fixture = await ManualCreatorCrateFixture.StartAsync();
        ManualMediaFixture media = ManualMediaFixture.Create(_root, fixture.MediaBytes);
        DateTime beforeTime = File.GetLastWriteTimeUtc(media.SourcePath);
        string beforeHash = Convert.ToHexString(SHA256.HashData(File.ReadAllBytes(media.SourcePath)));
        SocialOrigin origin = SocialOrigin.Parse(fixture.Origin);
        var stager = new SocialMediaStager(
            CapabilityClient(),
            new LocalMediaResolver(new WindowsTrustedMediaRootStore(), new NativeTrustedMediaRootPrompt()),
            StagingRoot());

        var strategyA = new ManualMediaStageState();
        strategyA.BeginStrategyA();
        StagedMedia external = await stager.StageAsync(origin, media.Capability, media.ApprovedAsset, 1, cancellationToken);
        strategyA.RecordStrategyAResult(external);
        Assert.True(external.Success, strategyA.FormatDiagnostic("Media staging failed."));
        Assert.Equal(StagedMediaProvenance.ExternalSource, external.Provenance);
        Assert.Equal(0, fixture.MediaRequestCount);
        Assert.Equal(beforeHash, Convert.ToHexString(SHA256.HashData(File.ReadAllBytes(media.SourcePath))));
        Assert.Equal(beforeTime, File.GetLastWriteTimeUtc(media.SourcePath));
        context.Checkpoint(strategyA.FormatDiagnostic("MANUAL DIAGNOSTIC - Media staging Strategy A"));

        var strategyB = new ManualMediaStageState();
        strategyB.BeginStrategyA();
        strategyB.RecordStrategyARejection("relative_path_mismatch");
        StagedMedia staged = await stager.StageAsync(origin, media.Capability, media.FallbackAsset, 2, cancellationToken);
        strategyB.RecordStrategyBResult(staged, fixture.MediaRequestCount, fixture.LastMediaResponseStatus);
        Assert.True(staged.Success, strategyB.FormatDiagnostic("Media staging failed."));
        Assert.Equal(StagedMediaProvenance.HelperOwned, staged.Provenance);
        Assert.Equal(1, fixture.MediaRequestCount);
        Assert.Equal(200, fixture.LastMediaResponseStatus);
        Assert.True(File.Exists(staged.Path!));
        Assert.True(File.Exists(Path.Combine(Path.GetDirectoryName(staged.Path!)!, SocialMediaStager.MarkerName)));
        bool exactBytes = ManualMediaStageVerification.HasExactExpectedBytes(staged.Path, media.MediaBytes);
        strategyB.RecordByteVerification(exactBytes);
        Assert.True(exactBytes, $"Staged fixture media bytes did not match expected fixture content.\n{strategyB.FormatDiagnostic("Media staging failed.")}");
        Assert.DoesNotContain(".partial", Directory.EnumerateFiles(Path.GetDirectoryName(staged.Path!)!).Select(Path.GetFileName));
        bool cleanupSucceeded = stager.Cleanup(media.Capability);
        strategyB.RecordCleanup(cleanupSucceeded);
        Assert.True(cleanupSucceeded, strategyB.FormatDiagnostic("Media staging cleanup failed."));
        context.Checkpoint(strategyB.FormatDiagnostic("MANUAL DIAGNOSTIC - Media staging"));
        Assert.True(File.Exists(media.SourcePath));
        Assert.False(File.Exists(staged.Path!));
    }

    internal void Sweep_UsesOnlyInjectedRootAndDeletesOnlyOldOwnedDirectory()
    {
        ManualFoundationGuard.RequireOptIn();
        string root = StagingRoot();
        Directory.CreateDirectory(root);
        string oldOwned = MakeDirectory(root, "old", true, 25);
        string freshOwned = MakeDirectory(root, "fresh", true, 23);
        string oldUnowned = MakeDirectory(root, "unowned", false, 25);
        var stager = new SocialMediaStager(CapabilityClient(), new LocalMediaResolver(new MemoryRootStore(), new RecordingRootPrompt(false)), root);
        Assert.Equal(1, stager.SweepAbandonedDirectories());
        Assert.False(Directory.Exists(oldOwned));
        Assert.True(Directory.Exists(freshOwned));
        Assert.True(Directory.Exists(oldUnowned));
    }

    private async Task BrowserFixture_PreparesOneOwnedTargetOverOneApprovedChromeConnection(ManualWorkflowStageContext context, CancellationToken cancellationToken)
    {
        ManualFoundationGuard.RequireOptIn();
        var discovery = new ChromeDiscovery();
        {
            await using var connection = new ChromeConnection();
            await ManualBrowserChromeStage.DiscoverAndConnectAsync(discovery.Discover, connection.ConnectAsync, cancellationToken);
            if (connection.Socket is null) throw new InvalidOperationException("Chrome connected without a run-owned socket.");

            await using var transport = new CdpTransport(connection.Socket);
            var targets = new CdpTargetManager(transport);
            await using var fixture = await ManualBrowserFixture.StartAsync(_root);
            await using var adapter = new FixturePreparationAdapter(fixture);
            var progress = new FixtureProgress();
            PlatformPreparationResult result = await adapter.PrepareAsync(
                new PlatformPreparationContext(adapter.Platform, ManualBrowserFixture.Title, ManualBrowserFixture.Body, fixture.MediaPaths, new BrowserPreparationTargets(targets)),
                progress,
                cancellationToken);

            Assert.Equal(PlatformPreparationOutcome.Prepared, result.Outcome);
            Assert.Single(adapter.OwnedTargetIds);
            Assert.Equal([SocialPreparationProgress.Preparing, SocialPreparationProgress.Uploading], progress.Values);
            context.Checkpoint("MANUAL DIAGNOSTIC - Chrome fixture\nBrowser connection established\nOwned target created and attached\nNavigation completed\nOrdinary text exact verification passed\nDirect file assignment passed\nUpload-ready fixture verification passed\nFixture target count: 1");
            await context.ConfirmAsync(
                "browser_fixture_inspected",
                """
                Verify that no second Chrome approval prompt appeared. The helper used one test-owned fixture tab:
                - title/input verified
                - multiline textarea verified
                - direct file attachment verified
                - upload-ready state verified
                - no submit/post/publish action exists

                Did the expected browser fixture state appear?

                [Y] Yes
                [N] No
                """,
                cancellationToken);
        }

        await context.ConfirmAsync(
            "chrome_cleanup_visible",
            """
            Verify:
            - the Chrome debugging banner disappeared;
            - Chrome remains running normally; and
            - existing operator tabs remain open.

            Did Chrome return to its expected normal state?

            [Y] Yes
            [N] No
            """,
            cancellationToken);
    }

    public void Dispose() => CleanupAsync().GetAwaiter().GetResult();

    private Task CleanupAsync()
    {
        if (Directory.Exists(_root)) Directory.Delete(_root, recursive: true);
        return Task.CompletedTask;
    }
    private static string Helper() { ManualFoundationGuard.RequireOptIn(); return Environment.GetEnvironmentVariable("CREATORCRATE_M2_HELPER_EXE") is { Length: > 0 } helper && File.Exists(helper) ? helper : throw new InvalidOperationException("The manual wrapper must provide CREATORCRATE_M2_HELPER_EXE."); }
    private static string StagingRoot() => Environment.GetEnvironmentVariable("CREATORCRATE_M2_MANUAL_STAGING_ROOT") ?? Path.Combine(Path.GetTempPath(), "creatorcrate-m2-manual-staging-" + Guid.NewGuid().ToString("N"));
    private ProcessResult Run(string helper, string argument, bool captureLaunchContext = false)
    {
        Directory.CreateDirectory(_root);
        var start = new ProcessStartInfo(helper)
        {
            WorkingDirectory = _root,
            UseShellExecute = false,
            CreateNoWindow = true,
            RedirectStandardError = true,
            RedirectStandardOutput = true,
        };
        start.ArgumentList.Add(argument);

        ManualNativeAppHostPreflightResult preflight = ManualNativeAppHostPreflight.Inspect(helper, start.WorkingDirectory);
        if (captureLaunchContext)
        {
            string contextPath = Environment.GetEnvironmentVariable("CREATORCRATE_M2_TESTHOST_LAUNCH_CONTEXT")
                ?? throw new InvalidOperationException("The manual wrapper must provide CREATORCRATE_M2_TESTHOST_LAUNCH_CONTEXT.");
            ManualNativeAppHostPreflight.RecordTestHostLaunch(contextPath, preflight, start);
        }

        using var process = Process.Start(start) ?? throw new InvalidOperationException("The temporary helper could not be launched.");
        Assert.True(process.WaitForExit(30_000));
        return new ProcessResult(process.ExitCode, process.StandardOutput.ReadToEnd(), process.StandardError.ReadToEnd(), preflight.ExecutablePath, start.WorkingDirectory);
    }
    private static string ProductionGateFailure(ProcessResult result) =>
        $"Production gate helper failed before the adapter gate.\nHelper exit code: {result.ExitCode}\nExecutable path: {result.ExecutablePath}\nWorking directory: {result.WorkingDirectory}\nHelper stdout:\n{SanitizeHelperOutput(result.Stdout)}\nHelper stderr:\n{SanitizeHelperOutput(result.Stderr)}";

    private static string OpenLocallyFailure(ProcessResult result, ManualOpenLocallyRequest request) =>
        $"Open Locally helper failed before human confirmation.\nFixture path: {request.FixturePath}\nFixture type: file\nProtocol version: 2\nEncoded path: {Uri.EscapeDataString(request.FixturePath)}\nSelect value: 1 (reveal/select file)\nHelper executable: {result.ExecutablePath}\nWorking directory: {result.WorkingDirectory}\nHelper exit code: {result.ExitCode}\nHelper stdout:\n{SanitizeHelperOutput(result.Stdout)}\nHelper stderr:\n{SanitizeHelperOutput(result.Stderr)}";

    private static string SanitizeHelperOutput(string output) => output
        .Replace(DiagnosticSocialRequest.Intent, "<redacted>", StringComparison.Ordinal)
        .Replace(ManualCreatorCrateFixture.MediaToken, "<redacted>", StringComparison.Ordinal);
    private static string MakeDirectory(string root, string name, bool owned, int ageHours) { string directory = Path.Combine(root, name); Directory.CreateDirectory(directory); if (owned) File.WriteAllText(Path.Combine(directory, SocialMediaStager.MarkerName), "creatorcrate-social-prep-v1"); Directory.SetLastWriteTimeUtc(directory, DateTime.UtcNow.AddHours(-ageHours)); return directory; }
    private static SocialRedeemClient RedeemClient(ITrustedOriginStore store, IOriginTrustPrompt prompt) { var resolver = new DnsOriginAddressResolver(); return new SocialRedeemClient(new SocialHttpClient(resolver), new OriginTrustService(store, prompt, resolver)); }
    private static SocialCapabilityClient CapabilityClient() { var resolver = new DnsOriginAddressResolver(); return new SocialCapabilityClient(new SocialHttpClient(resolver), new OriginTrustService(new WindowsTrustedOriginStore(), new NativeOriginTrustPrompt(), resolver)); }
    private sealed record ProcessResult(int ExitCode, string Stdout, string Stderr, string ExecutablePath, string WorkingDirectory)
    {
        internal string Output => Stdout + Stderr;
    }
    private sealed class MemoryOriginStore : ITrustedOriginStore { internal HashSet<string> Values { get; } = new(StringComparer.Ordinal); public bool IsTrusted(SocialOrigin origin) => Values.Contains(origin.Identity); public void Trust(SocialOrigin origin) => Values.Add(origin.Identity); }
    private sealed class RecordingOriginPrompt(bool allowed) : IOriginTrustPrompt { internal int Calls { get; private set; } public bool ConfirmTrust(SocialOrigin origin) { Calls++; return allowed; } }
    private sealed class MemoryRootStore : ITrustedMediaRootStore { private readonly HashSet<string> _values = new(StringComparer.OrdinalIgnoreCase); public bool IsTrusted(SocialOrigin origin, string root) => _values.Contains(origin.Identity + "|" + root); public void Trust(SocialOrigin origin, string root) => _values.Add(origin.Identity + "|" + root); }
    private sealed class RecordingRootPrompt(bool allowed) : ITrustedMediaRootPrompt { public bool ConfirmTrust(SocialOrigin origin, string root) => allowed; }
    private sealed class FixtureProgress : IPreparationProgress
    {
        internal List<SocialPreparationProgress> Values { get; } = [];
        public Task ReportAsync(SocialPreparationProgress progress, CancellationToken cancellationToken)
        {
            Values.Add(progress);
            return Task.CompletedTask;
        }
    }
}
