using OpenLocally;

namespace OpenLocally.Tests;

public class ManualAssetAvailabilityTests : IDisposable
{
    private readonly string _directory = Path.Combine(Path.GetTempPath(), $"creatorcrate-drag-{Guid.NewGuid():N}");

    public ManualAssetAvailabilityTests() => Directory.CreateDirectory(_directory);

    [Fact]
    public async Task PrepareAsync_RevalidatesEverySelectedAssetInAuthoritativeOrder()
    {
        string firstPath = FilePath("one file.png", 1);
        string secondPath = FilePath("雪.png", 2);
        var first = Prepared(11, firstPath, StagedMediaProvenance.ExternalSource);
        var second = Prepared(12, secondPath, StagedMediaProvenance.HelperOwned);
        var runtime = new RecordingRuntime((asset, _, media) => Task.FromResult(
            asset.AssetId == 11 ? StagedMedia.Source(firstPath) : StagedMedia.Owned(secondPath)));
        var availability = new RuntimeManualAssetAvailability(runtime, Capability());

        ManualDragPreparation result = await availability.PrepareAsync(
            [new(first, 3), new(second, 1)], CancellationToken.None);

        Assert.True(result.Success);
        Assert.Equal(new[] { Path.GetFullPath(firstPath), Path.GetFullPath(secondPath) }, result.Paths);
        Assert.Equal(new long[] { 11, 12 }, runtime.Calls.Select(call => call.Asset.AssetId));
        Assert.Equal(new[] { 3, 1 }, runtime.Calls.Select(call => call.Ordinal));
        Assert.Equal(new[] { StagedMediaProvenance.ExternalSource, StagedMediaProvenance.HelperOwned },
            runtime.Calls.Select(call => call.Media.Provenance!.Value));
    }

    [Fact]
    public async Task PrepareAsync_OneFailureReturnsNoPartialPayloadButStillChecksEverySelection()
    {
        string validPath = FilePath("valid.png", 1);
        var missing = Prepared(11, Path.Combine(_directory, "missing.png"), StagedMediaProvenance.ExternalSource);
        var valid = Prepared(12, validPath, StagedMediaProvenance.HelperOwned);
        var runtime = new RecordingRuntime((asset, _, _) => Task.FromResult(
            asset.AssetId == 11 ? StagedMedia.Fail("media_file_missing") : StagedMedia.Owned(validPath)));

        ManualDragPreparation result = await new RuntimeManualAssetAvailability(runtime, Capability()).PrepareAsync(
            [new(missing, 0), new(valid, 1)], CancellationToken.None);

        Assert.False(result.Success);
        Assert.Empty(result.Paths);
        Assert.Equal("media_file_missing", result.ErrorCode);
        Assert.Equal("11.png", result.AssetName);
        Assert.Equal(new long[] { 11, 12 }, runtime.Calls.Select(call => call.Asset.AssetId));
    }

    [Fact]
    public async Task PrepareAsync_SuccessWhoseFileDisappearedIsRefused()
    {
        string path = FilePath("gone.png", 1);
        var prepared = Prepared(11, path, StagedMediaProvenance.HelperOwned);
        var runtime = new RecordingRuntime((_, _, _) =>
        {
            File.Delete(path);
            return Task.FromResult(StagedMedia.Owned(path));
        });

        ManualDragPreparation result = await new RuntimeManualAssetAvailability(runtime, Capability()).PrepareAsync(
            [new(prepared, 0)], CancellationToken.None);

        Assert.False(result.Success);
        Assert.Empty(result.Paths);
        Assert.Equal("media_file_missing", result.ErrorCode);
    }

    public void Dispose()
    {
        if (Directory.Exists(_directory)) Directory.Delete(_directory, recursive: true);
    }

    private string FilePath(string name, byte value)
    {
        string path = Path.Combine(_directory, name);
        File.WriteAllBytes(path, [value]);
        return path;
    }

    private static ManualPreparedAsset Prepared(long id, string path, StagedMediaProvenance provenance) =>
        new(new SocialRedeemAsset(id, "attachment", id, $"{id}.png", ".png", "image/png", 1,
            $"release/{id}.png", true, provenance == StagedMediaProvenance.ExternalSource ? path : null), path, provenance);

    private static SocialCapability Capability() => new(Guid.NewGuid().ToString(), new string('a', 43));

    private sealed class RecordingRuntime(
        Func<SocialRedeemAsset, int, StagedMedia, Task<StagedMedia>> ensure) : IManualSocialPreparationRuntime
    {
        public List<(SocialRedeemAsset Asset, int Ordinal, StagedMedia Media)> Calls { get; } = [];
        public Task<StagedMedia> EnsureAssetAvailableAsync(SocialCapability capability, SocialRedeemAsset asset, int ordinal, StagedMedia media, CancellationToken cancellationToken)
        {
            Calls.Add((asset, ordinal, media));
            return ensure(asset, ordinal, media);
        }
        public Task<SocialRedeemResult> RedeemAsync(SocialUriRequest request, CancellationToken cancellationToken) => throw new NotSupportedException();
        public Task<SocialPlatformStatusResult> PatchAsync(SocialCapability capability, string platform, string status, string? detailCode, string? message, CancellationToken cancellationToken) => throw new NotSupportedException();
        public Task<StagedMedia> StageAssetAsync(SocialCapability capability, SocialRedeemAsset asset, int ordinal, CancellationToken cancellationToken) => throw new NotSupportedException();
        public Task CleanupMediaAsync(SocialCapability capability) => Task.CompletedTask;
        public IDisposable DetachMediaLease(SocialCapability capability) => throw new NotSupportedException();
        public ValueTask DisposeAsync() => ValueTask.CompletedTask;
    }
}
