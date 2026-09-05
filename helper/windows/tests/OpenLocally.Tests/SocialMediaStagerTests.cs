using System.Net;
using System.Security.Cryptography;
using System.Text;
using OpenLocally;

namespace OpenLocally.Tests;

public class SocialMediaStagerTests : IDisposable
{
    private readonly string _root = Path.Combine(Path.GetTempPath(), "creatorcrate-stage-" + Guid.NewGuid().ToString("N"));

    [Fact]
    public async Task DownloadedMedia_IsOwnedFinalizedAndCleanupIsIdempotent()
    {
        var handler = new SocialCapabilityClientTests.CaptureHandler(_ => new HttpResponseMessage(HttpStatusCode.OK) { Content = new ByteArrayContent(Encoding.UTF8.GetBytes("abc")) });
        var stager = new SocialMediaStager(SocialCapabilityClientTests.CreateClient(handler), new LocalMediaResolver(new Store(), new Prompt()), _root);
        var capability = new SocialCapability("00000000-0000-0000-0000-000000000001", "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");

        StagedMedia media = await stager.StageAsync(SocialCapabilityClientTests.Origin(), capability, SocialCapabilityClientTests.Asset(7, 3), 1, CancellationToken.None);

        Assert.True(media.Success);
        Assert.Equal(StagedMediaProvenance.HelperOwned, media.Provenance);
        Assert.Equal("abc", File.ReadAllText(media.Path!));
        Assert.DoesNotContain(".partial", media.Path!);
        Assert.True(stager.Cleanup(capability));
        Assert.True(stager.Cleanup(capability));
    }

    [Fact]
    public async Task RepeatedSessionAsset_StagesOnceAndReusesTheOwnedPathAcrossPlatforms()
    {
        var handler = new CountingHandler("abc");
        var stager = CreateStager(handler, Path.Combine(_root, "staging"));
        SocialCapability capability = Capability();
        SocialRedeemAsset asset = SocialCapabilityClientTests.Asset(7, 3);

        StagedMedia patreon = await stager.StageAsync(SocialCapabilityClientTests.Origin(), capability, asset, 0, CancellationToken.None);
        StagedMedia x = await stager.StageAsync(SocialCapabilityClientTests.Origin(), capability, asset, 0, CancellationToken.None);
        StagedMedia bluesky = await stager.StageAsync(SocialCapabilityClientTests.Origin(), capability, asset, 0, CancellationToken.None);

        Assert.All(new[] { patreon, x, bluesky }, media => Assert.True(media.Success));
        Assert.Equal(1, handler.Requests);
        Assert.Equal(patreon.Path, x.Path);
        Assert.Equal(patreon.Path, bluesky.Path);
        Assert.EndsWith("0000-7.png", patreon.Path, StringComparison.OrdinalIgnoreCase);
        Assert.Equal("abc", File.ReadAllText(patreon.Path!));
        Assert.True(stager.Cleanup(capability));
        Assert.False(File.Exists(patreon.Path));
    }

    [Theory]
    [InlineData("role")]
    [InlineData("sort-order")]
    [InlineData("relative-path")]
    public async Task RepeatedSessionAsset_WithContradictorySnapshotMetadata_FailsClosed(string field)
    {
        var handler = new CountingHandler("abc");
        var stager = CreateStager(handler, Path.Combine(_root, "staging"));
        SocialCapability capability = Capability();
        SocialRedeemAsset asset = SocialCapabilityClientTests.Asset(7, 3);
        SocialRedeemAsset contradictoryAsset = field switch
        {
            "role" => asset with { Role = "primary" },
            "sort-order" => asset with { SortOrder = 1 },
            "relative-path" => asset with { RelativePath = "other/media.png" },
            _ => throw new ArgumentOutOfRangeException(nameof(field)),
        };

        StagedMedia first = await stager.StageAsync(SocialCapabilityClientTests.Origin(), capability, asset, 0, CancellationToken.None);
        StagedMedia contradictory = await stager.StageAsync(
            SocialCapabilityClientTests.Origin(), capability, contradictoryAsset, 0, CancellationToken.None);

        Assert.True(first.Success);
        Assert.False(contradictory.Success);
        Assert.Equal("validation_failed", contradictory.ErrorCode);
        Assert.Null(contradictory.Path);
        Assert.Equal(1, handler.Requests);
    }

    [Fact]
    public async Task ReparseStagingRoot_IsRejectedBeforeAnyTargetWrite()
    {
        string target = Path.Combine(_root, "outside");
        string link = Path.Combine(_root, "staging-link");
        Directory.CreateDirectory(target);
        Directory.CreateSymbolicLink(link, target);
        var stager = CreateStager(new CountingHandler("abc"), link);

        StagedMedia media = await stager.StageAsync(SocialCapabilityClientTests.Origin(), Capability(), SocialCapabilityClientTests.Asset(7, 3), 0, CancellationToken.None);

        Assert.False(media.Success);
        Assert.Equal("media_temp_unavailable", media.ErrorCode);
        Assert.Empty(Directory.EnumerateFileSystemEntries(target));
        Directory.Delete(link);
    }

    [Fact]
    public async Task ReparseSessionCandidate_IsRejectedBeforeItCanBeClaimed()
    {
        string root = Path.Combine(_root, "staging");
        SocialCapability capability = Capability();
        string target = Path.Combine(_root, "outside");
        string candidate = SessionDirectory(root, capability.SessionId);
        Directory.CreateDirectory(root);
        Directory.CreateDirectory(target);
        File.WriteAllText(Path.Combine(target, "sentinel"), "keep");
        Directory.CreateSymbolicLink(candidate, target);
        var stager = CreateStager(new CountingHandler("abc"), root);

        StagedMedia media = await stager.StageAsync(SocialCapabilityClientTests.Origin(), capability, SocialCapabilityClientTests.Asset(7, 3), 0, CancellationToken.None);

        Assert.False(media.Success);
        Assert.Equal("media_temp_unavailable", media.ErrorCode);
        Assert.Equal("keep", File.ReadAllText(Path.Combine(target, "sentinel")));
        Assert.False(File.Exists(Path.Combine(target, SocialMediaStager.MarkerName)));
        Directory.Delete(candidate);
    }

    [Fact]
    public async Task ExistingUnmarkedSessionDirectory_IsNotClaimed()
    {
        string root = Path.Combine(_root, "staging");
        SocialCapability capability = Capability();
        string candidate = SessionDirectory(root, capability.SessionId);
        Directory.CreateDirectory(candidate);
        File.WriteAllText(Path.Combine(candidate, "sentinel"), "keep");
        var stager = CreateStager(new CountingHandler("abc"), root);

        StagedMedia media = await stager.StageAsync(SocialCapabilityClientTests.Origin(), capability, SocialCapabilityClientTests.Asset(7, 3), 0, CancellationToken.None);

        Assert.False(media.Success);
        Assert.Equal("media_temp_unavailable", media.ErrorCode);
        Assert.False(File.Exists(Path.Combine(candidate, SocialMediaStager.MarkerName)));
        Assert.Equal("keep", File.ReadAllText(Path.Combine(candidate, "sentinel")));
    }

    [Fact]
    public async Task ExistingMarkerValidatedSessionDirectory_IsReused()
    {
        string root = Path.Combine(_root, "staging");
        SocialCapability capability = Capability();
        string candidate = SessionDirectory(root, capability.SessionId);
        Directory.CreateDirectory(candidate);
        File.WriteAllText(Path.Combine(candidate, SocialMediaStager.MarkerName), "creatorcrate-social-prep-v1");
        var stager = CreateStager(new CountingHandler("abc"), root);

        StagedMedia media = await stager.StageAsync(SocialCapabilityClientTests.Origin(), capability, SocialCapabilityClientTests.Asset(7, 3), 0, CancellationToken.None);

        Assert.True(media.Success);
        Assert.True(stager.Cleanup(capability));
    }

    [Fact]
    public void Cleanup_ReparseSessionCandidate_IsRejectedBeforeMarkerInspection()
    {
        string root = Path.Combine(_root, "staging");
        SocialCapability capability = Capability();
        string target = Path.Combine(_root, "outside");
        string candidate = SessionDirectory(root, capability.SessionId);
        Directory.CreateDirectory(root);
        Directory.CreateDirectory(target);
        File.WriteAllText(Path.Combine(target, SocialMediaStager.MarkerName), "creatorcrate-social-prep-v1");
        File.WriteAllText(Path.Combine(target, "sentinel"), "keep");
        Directory.CreateSymbolicLink(candidate, target);
        var stager = CreateStager(new CountingHandler("abc"), root);

        Assert.False(stager.Cleanup(capability));
        Assert.Equal("keep", File.ReadAllText(Path.Combine(target, "sentinel")));
        Assert.True(File.Exists(Path.Combine(target, SocialMediaStager.MarkerName)));
        Directory.Delete(candidate);
    }

    [Fact]
    public void Sweep_RemovesOnlyOldMarkerValidatedDirectory()
    {
        string root = Path.Combine(_root, "staging");
        Directory.CreateDirectory(root);
        string oldOwned = Path.Combine(root, "old");
        string freshOwned = Path.Combine(root, "fresh");
        string unmarked = Path.Combine(root, "unmarked");
        string outside = Path.Combine(_root, "outside");
        string reparse = Path.Combine(root, "reparse");
        foreach (string path in new[] { oldOwned, freshOwned, unmarked }) Directory.CreateDirectory(path);
        File.WriteAllText(Path.Combine(oldOwned, SocialMediaStager.MarkerName), "creatorcrate-social-prep-v1");
        File.WriteAllText(Path.Combine(freshOwned, SocialMediaStager.MarkerName), "creatorcrate-social-prep-v1");
        Directory.CreateDirectory(outside);
        File.WriteAllText(Path.Combine(outside, SocialMediaStager.MarkerName), "creatorcrate-social-prep-v1");
        File.WriteAllText(Path.Combine(outside, "sentinel"), "keep");
        Directory.CreateSymbolicLink(reparse, outside);
        Directory.SetLastWriteTimeUtc(oldOwned, DateTime.UtcNow.AddHours(-25));
        Directory.SetLastWriteTimeUtc(freshOwned, DateTime.UtcNow.AddHours(-23));
        var stager = CreateStager(new CountingHandler("abc"), root);

        Assert.Equal(1, stager.SweepAbandonedDirectories());
        Assert.False(Directory.Exists(oldOwned));
        Assert.True(Directory.Exists(freshOwned));
        Assert.True(Directory.Exists(unmarked));
        Assert.True(Directory.Exists(reparse));
        Assert.Equal("keep", File.ReadAllText(Path.Combine(outside, "sentinel")));
        Directory.Delete(reparse);
    }

    public void Dispose() { if (Directory.Exists(_root)) Directory.Delete(_root, true); }
    private static SocialCapability Capability() => new("00000000-0000-0000-0000-000000000001", "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
    private static string SessionDirectory(string root, string sessionId)
    {
        byte[] digest = SHA256.HashData(Encoding.UTF8.GetBytes(sessionId));
        return Path.Combine(root, Convert.ToHexString(digest.AsSpan(0, 16)).ToLowerInvariant());
    }
    private static SocialMediaStager CreateStager(HttpMessageHandler handler, string root) =>
        new(SocialCapabilityClientTests.CreateClient(handler), new LocalMediaResolver(new Store(), new Prompt()), root);
    private sealed class Store : ITrustedMediaRootStore { public bool IsTrusted(SocialOrigin origin, string root) => false; public void Trust(SocialOrigin origin, string root) { } }
    private sealed class Prompt : ITrustedMediaRootPrompt { public bool ConfirmTrust(SocialOrigin origin, string root) => false; }
    private sealed class CountingHandler(string content) : HttpMessageHandler
    {
        public int Requests { get; private set; }
        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
        {
            Requests++;
            return Task.FromResult(new HttpResponseMessage(HttpStatusCode.OK) { Content = new ByteArrayContent(Encoding.UTF8.GetBytes(content)) });
        }
    }
}
