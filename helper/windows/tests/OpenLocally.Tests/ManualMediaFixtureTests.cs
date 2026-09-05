using System.Net;
using System.Text;
using OpenLocally;
using OpenLocally.Tests.Manual;

namespace OpenLocally.Tests;

public sealed class ManualMediaFixtureTests : IDisposable
{
    private readonly string _root = Path.Combine(Path.GetTempPath(), "creatorcrate-m2-media-fixture-" + Guid.NewGuid().ToString("N"));

    [Fact]
    public async Task ExactManualFixture_UsesExternalSourceThenStagesDistinctFallbackAsset()
    {
        byte[] bytes = Encoding.UTF8.GetBytes("creatorcrate-manual-media");
        ManualMediaFixture fixture = ManualMediaFixture.Create(_root, bytes);
        var handler = new MediaHandler(fixture.MediaBytes);
        var roots = new TrustedRootStore();
        SocialOrigin origin = SocialCapabilityClientTests.Origin();
        roots.Trust(origin, Path.GetDirectoryName(Path.GetDirectoryName(fixture.SourcePath)!)!);
        var stager = new SocialMediaStager(
            SocialCapabilityClientTests.CreateClient(handler),
            new LocalMediaResolver(roots, new RejectingRootPrompt()),
            Path.Combine(_root, "staging"));

        string originalHash = Convert.ToHexString(System.Security.Cryptography.SHA256.HashData(File.ReadAllBytes(fixture.SourcePath)));
        var strategyA = new ManualMediaStageState();
        strategyA.BeginStrategyA();
        StagedMedia direct = await stager.StageAsync(origin, fixture.Capability, fixture.ApprovedAsset, 1, CancellationToken.None);
        strategyA.RecordStrategyAResult(direct);

        Assert.True(direct.Success, strategyA.FormatDiagnostic("Media staging failed."));
        Assert.Equal(StagedMediaProvenance.ExternalSource, direct.Provenance);
        Assert.Equal(0, handler.RequestCount);
        Assert.Equal(originalHash, Convert.ToHexString(System.Security.Cryptography.SHA256.HashData(File.ReadAllBytes(fixture.SourcePath))));
        string strategyADiagnostic = strategyA.FormatDiagnostic("Media staging diagnostic");
        Assert.Contains("Strategy A accepted: true", strategyADiagnostic);
        Assert.Contains("Strategy B requested: false", strategyADiagnostic);
        Assert.Contains("Returned provenance: ExternalSource", strategyADiagnostic);

        var strategyB = new ManualMediaStageState();
        strategyB.BeginStrategyA();
        strategyB.RecordStrategyARejection("relative_path_mismatch");
        StagedMedia staged = await stager.StageAsync(origin, fixture.Capability, fixture.FallbackAsset, 2, CancellationToken.None);
        strategyB.RecordStrategyBResult(staged, handler.RequestCount, (int)handler.ResponseStatus);

        Assert.True(staged.Success, strategyB.FormatDiagnostic("Media staging failed."));
        Assert.Equal(StagedMediaProvenance.HelperOwned, staged.Provenance);
        Assert.Equal(1, handler.RequestCount);
        Assert.Equal($"/social-prep/{fixture.Capability.SessionId}/assets/2", handler.LastPath);
        Assert.Equal($"Bearer {fixture.Capability.MediaToken}", handler.LastAuthorization);
        Assert.True(File.Exists(staged.Path!));
        bool exactBytes = ManualMediaStageVerification.HasExactExpectedBytes(staged.Path, fixture.MediaBytes);
        strategyB.RecordByteVerification(exactBytes);
        Assert.True(exactBytes, $"Staged fixture media bytes did not match expected fixture content.\n{strategyB.FormatDiagnostic("Media staging failed.")}");
        string strategyBDiagnostic = strategyB.FormatDiagnostic("Media staging diagnostic");
        Assert.Contains("Strategy A accepted: false", strategyBDiagnostic);
        Assert.Contains("Strategy A rejection: relative_path_mismatch", strategyBDiagnostic);
        Assert.Contains("Strategy B requested: true", strategyBDiagnostic);
        Assert.Contains("Fixture media GET count: 1", strategyBDiagnostic);
        Assert.Contains("Strategy B outcome: success", strategyBDiagnostic);
        Assert.Contains("Returned provenance: HelperOwned", strategyBDiagnostic);
        Assert.Contains("Byte verification passed: true", strategyBDiagnostic);
        Assert.True(File.Exists(fixture.SourcePath));
        bool cleanupSucceeded = stager.Cleanup(fixture.Capability);
        strategyB.RecordCleanup(cleanupSucceeded);
        Assert.True(cleanupSucceeded, strategyB.FormatDiagnostic("Media staging cleanup failed."));
        Assert.False(File.Exists(staged.Path!));
        Assert.True(File.Exists(fixture.SourcePath));
    }

    [Fact]
    public void ExactByteVerification_RejectsSameSizeDifferentContent()
    {
        byte[] expected = [0x10, 0x20, 0x30, 0x40];
        byte[] sameSizeWrong = [0x10, 0x20, 0x31, 0x40];
        string path = Path.Combine(_root, "same-size-corruption.bin");
        Directory.CreateDirectory(_root);
        File.WriteAllBytes(path, sameSizeWrong);

        Assert.Equal(expected.Length, sameSizeWrong.Length);
        Assert.False(ManualMediaStageVerification.HasExactExpectedBytes(path, expected));
    }

    [Fact]
    public void MediaDiagnostic_StrategyARejectionLeavesFallbackUnrequested()
    {
        var state = new ManualMediaStageState();
        state.BeginStrategyA();
        state.RecordStrategyARejection("relative_path_mismatch");

        string diagnostic = state.FormatDiagnostic("Media staging diagnostic");

        Assert.Contains("Strategy A attempted: true", diagnostic);
        Assert.Contains("Strategy A accepted: false", diagnostic);
        Assert.Contains("Strategy A outcome: rejected", diagnostic);
        Assert.Contains("Strategy A rejection: relative_path_mismatch", diagnostic);
        Assert.Contains("Strategy B requested: false", diagnostic);
        Assert.Contains("Strategy B outcome: not_started", diagnostic);
    }

    [Fact]
    public void MediaDiagnostic_EarlyStrategyAFailureDoesNotClaimLaterPhases()
    {
        var state = new ManualMediaStageState();
        state.BeginStrategyA();
        state.RecordStrategyAResult(StagedMedia.Fail("media_temp_unavailable"));

        string diagnostic = state.FormatDiagnostic("Media staging failed.");

        Assert.Contains("Strategy A attempted: true", diagnostic);
        Assert.Contains("Strategy A accepted: false", diagnostic);
        Assert.Contains("Strategy A outcome: failed:media_temp_unavailable", diagnostic);
        Assert.Contains("Strategy B requested: false", diagnostic);
        Assert.Contains("Strategy B outcome: not_started", diagnostic);
        Assert.Contains("Returned provenance: none", diagnostic);
    }

    [Fact]
    public async Task MediaDiagnostic_StrategyBFailureReportsActualRequestAndFailure()
    {
        byte[] bytes = Encoding.UTF8.GetBytes("creatorcrate-manual-media");
        ManualMediaFixture fixture = ManualMediaFixture.Create(_root, bytes);
        var handler = new MediaHandler(fixture.MediaBytes, HttpStatusCode.InternalServerError);
        var roots = new TrustedRootStore();
        SocialOrigin origin = SocialCapabilityClientTests.Origin();
        roots.Trust(origin, Path.GetDirectoryName(Path.GetDirectoryName(fixture.SourcePath)!)!);
        var stager = new SocialMediaStager(
            SocialCapabilityClientTests.CreateClient(handler),
            new LocalMediaResolver(roots, new RejectingRootPrompt()),
            Path.Combine(_root, "staging"));

        var state = new ManualMediaStageState();
        state.BeginStrategyA();
        state.RecordStrategyARejection("relative_path_mismatch");
        StagedMedia result = await stager.StageAsync(origin, fixture.Capability, fixture.FallbackAsset, 2, CancellationToken.None);
        state.RecordStrategyBResult(result, handler.RequestCount, (int)handler.ResponseStatus);

        Assert.False(result.Success);
        string diagnostic = state.FormatDiagnostic("Media staging failed.");
        Assert.Contains("Strategy B requested: true", diagnostic);
        Assert.Contains("Fixture media GET count: 1", diagnostic);
        Assert.Contains("Media response status: 500", diagnostic);
        Assert.Contains("Strategy B outcome: failed:", diagnostic);
        Assert.Contains("Returned provenance: none", diagnostic);
    }

    [Fact]
    public void MediaDiagnostic_ByteMismatchReportsFailedVerification()
    {
        byte[] expected = [0x10, 0x20, 0x30, 0x40];
        byte[] sameSizeWrong = [0x10, 0x20, 0x31, 0x40];
        string path = Path.Combine(_root, "byte-mismatch.bin");
        Directory.CreateDirectory(_root);
        File.WriteAllBytes(path, sameSizeWrong);

        var state = new ManualMediaStageState();
        state.BeginStrategyA();
        state.RecordStrategyARejection("relative_path_mismatch");
        state.RecordStrategyBResult(StagedMedia.Owned(path), 1, 200);
        bool exactBytes = ManualMediaStageVerification.HasExactExpectedBytes(path, expected);
        state.RecordByteVerification(exactBytes);

        Assert.False(exactBytes);
        string diagnostic = state.FormatDiagnostic("Media staging failed.");
        Assert.Contains("Returned provenance: HelperOwned", diagnostic);
        Assert.Contains("Result file exists: true", diagnostic);
        Assert.Contains("Byte verification completed: true", diagnostic);
        Assert.Contains("Byte verification passed: false", diagnostic);
    }

    public void Dispose()
    {
        if (Directory.Exists(_root)) Directory.Delete(_root, recursive: true);
    }

    private sealed class TrustedRootStore : ITrustedMediaRootStore
    {
        private readonly HashSet<string> _values = new(StringComparer.OrdinalIgnoreCase);

        public bool IsTrusted(SocialOrigin origin, string root) => _values.Contains(origin.Identity + "|" + root);
        public void Trust(SocialOrigin origin, string root) => _values.Add(origin.Identity + "|" + root);
    }

    private sealed class RejectingRootPrompt : ITrustedMediaRootPrompt
    {
        public bool ConfirmTrust(SocialOrigin origin, string root) => false;
    }

    private sealed class MediaHandler(byte[] bytes, HttpStatusCode responseStatus = HttpStatusCode.OK) : HttpMessageHandler
    {
        public int RequestCount { get; private set; }
        public HttpStatusCode ResponseStatus => responseStatus;
        public string? LastPath { get; private set; }
        public string? LastAuthorization { get; private set; }

        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
        {
            RequestCount++;
            LastPath = request.RequestUri!.AbsolutePath;
            LastAuthorization = request.Headers.Authorization?.ToString();
            return Task.FromResult(new HttpResponseMessage(responseStatus)
            {
                Content = new ByteArrayContent(bytes),
            });
        }
    }
}
