using System.Diagnostics;
using System.Net;
using System.Text;
using Microsoft.Win32.SafeHandles;
using OpenLocally;

namespace OpenLocally.Tests;

public sealed class ManualAssetPreviewAccessTests : IDisposable
{
    private readonly string _root = Path.Combine(Path.GetTempPath(), "creatorcrate-preview-access-" + Guid.NewGuid().ToString("N"));
    private readonly SocialOrigin _origin = SocialCapabilityClientTests.Origin();

    [Fact]
    public async Task HelperOwned_AcquiresPinnedReadLeaseWithoutTouchingRetention_AndBlocksReplacement()
    {
        OwnedFixture fixture = await CreateOwnedAsync();
        Assert.True(fixture.Stager.Cleanup(fixture.Capability));
        MetadataSnapshot before = SnapshotMetadata(fixture.Prepared.Path);

        using var access = new ManualAssetPreviewAccess(_origin, fixture.Capability.SessionId, fixture.Resolver, fixture.Stager);
        ManualPreviewAccessResult result = access.TryAcquireRead(fixture.Prepared, 0);

        Assert.True(result.Success);
        Assert.Null(result.ErrorCode);
        Assert.Equal(Path.GetFullPath(fixture.Prepared.Path), result.Lease!.Path);
        Assert.Equal(fixture.Asset.AssetId, result.Lease.AssetId);
        Assert.Equal(StagedMediaProvenance.HelperOwned, result.Lease.Provenance);
        Assert.Equal(3, RandomAccess.GetLength(result.Lease.ReadHandle));
        byte[] bytes = new byte[3];
        Assert.Equal(3, RandomAccess.Read(result.Lease.ReadHandle, bytes, 0));
        Assert.Equal("abc", Encoding.UTF8.GetString(bytes));
        Assert.Equal(1, fixture.Handler.Requests);
        Assert.Equal(before, SnapshotMetadata(fixture.Prepared.Path));

        string moved = fixture.Prepared.Path + ".moved";
        Assert.Throws<IOException>(() => File.Move(fixture.Prepared.Path, moved));
        Assert.Throws<IOException>(() => File.Delete(fixture.Prepared.Path));
        Assert.Throws<IOException>(() => File.WriteAllText(fixture.Prepared.Path, "replacement"));
        Assert.Equal("abc", File.ReadAllText(fixture.Prepared.Path));

        result.Lease.Dispose();
        result.Lease.Dispose();
        Assert.True(result.Lease.IsDisposed);
        Assert.True(result.Lease.ReadHandle.IsClosed);
        File.Move(fixture.Prepared.Path, moved);
        Assert.Equal("abc", File.ReadAllText(moved));
        Assert.Equal(before, SnapshotMetadata(moved));
    }

    [Fact]
    public void External_AcquiresWithoutMutationStagingOrCapabilityUse()
    {
        ExternalFixture fixture = CreateExternal();
        DateTime fixedWrite = new(2025, 1, 2, 3, 4, 6, DateTimeKind.Utc);
        File.SetLastWriteTimeUtc(fixture.Prepared.Path, fixedWrite);
        byte[] before = File.ReadAllBytes(fixture.Prepared.Path);

        using var access = new ManualAssetPreviewAccess(_origin, fixture.SessionId, fixture.Resolver, fixture.Stager);
        using ManualPreviewFileLease lease = AssertReady(access.TryAcquireRead(fixture.Prepared, 0));

        Assert.Equal(StagedMediaProvenance.ExternalSource, lease.Provenance);
        Assert.Equal(before, File.ReadAllBytes(fixture.Prepared.Path));
        Assert.Equal(fixedWrite, File.GetLastWriteTimeUtc(fixture.Prepared.Path));
        Assert.False(Directory.Exists(fixture.StagingRoot));
        Assert.Equal(0, fixture.Handler.Requests);
        Assert.Equal(0, fixture.Prompt.Calls);
    }

    [Fact]
    public void HandleCacheIdentity_IsStableForUnchangedFileAndChangesForModificationAndReplacement()
    {
        ExternalFixture fixture = CreateExternal(directoryName: "cache-identity");
        using var access = new ManualAssetPreviewAccess(
            _origin, fixture.SessionId, fixture.Resolver, fixture.Stager);

        ManualPreviewFileLease first = AssertReady(access.TryAcquireRead(fixture.Prepared, 0));
        ManualPreviewFileCacheIdentity firstIdentity = Assert.IsType<ManualPreviewFileCacheIdentity>(first.CacheIdentity);
        first.Dispose();

        using (ManualPreviewFileLease unchanged = AssertReady(access.TryAcquireRead(fixture.Prepared, 0)))
            Assert.Equal(firstIdentity, Assert.IsType<ManualPreviewFileCacheIdentity>(unchanged.CacheIdentity));

        File.WriteAllBytes(fixture.Prepared.Path, "xyz"u8.ToArray());
        ManualPreviewFileLease modified = AssertReady(access.TryAcquireRead(fixture.Prepared, 0));
        ManualPreviewFileCacheIdentity modifiedIdentity = Assert.IsType<ManualPreviewFileCacheIdentity>(modified.CacheIdentity);
        Assert.NotEqual(firstIdentity, modifiedIdentity);
        Assert.Equal(firstIdentity.FileIdLow, modifiedIdentity.FileIdLow);
        Assert.Equal(firstIdentity.FileIdHigh, modifiedIdentity.FileIdHigh);
        Assert.NotEqual(firstIdentity.ChangeTime, modifiedIdentity.ChangeTime);
        modified.Dispose();

        string replacement = fixture.Prepared.Path + ".replacement";
        File.WriteAllBytes(replacement, "123"u8.ToArray());
        File.Delete(fixture.Prepared.Path);
        File.Move(replacement, fixture.Prepared.Path);
        using ManualPreviewFileLease replaced = AssertReady(access.TryAcquireRead(fixture.Prepared, 0));
        ManualPreviewFileCacheIdentity replacementIdentity = Assert.IsType<ManualPreviewFileCacheIdentity>(replaced.CacheIdentity);
        Assert.NotEqual(modifiedIdentity, replacementIdentity);
        Assert.True(
            modifiedIdentity.VolumeSerialNumber != replacementIdentity.VolumeSerialNumber ||
            modifiedIdentity.FileIdLow != replacementIdentity.FileIdLow ||
            modifiedIdentity.FileIdHigh != replacementIdentity.FileIdHigh);
    }

    [Fact]
    public void InvalidHandleHasNoReusableCacheIdentity()
    {
        using var invalid = new SafeFileHandle(IntPtr.Zero, ownsHandle: false);
        Assert.Null(ManualPreviewFileCacheIdentity.TryCreate(invalid));
    }

    [Fact]
    public async Task MissingAndSizeMismatch_FailLocallyWithoutRetentionOrDownload()
    {
        OwnedFixture fixture = await CreateOwnedAsync();
        Assert.True(fixture.Stager.Cleanup(fixture.Capability));
        MetadataSnapshot before = SnapshotMetadata(fixture.Prepared.Path);
        File.Delete(fixture.Prepared.Path);
        using var access = new ManualAssetPreviewAccess(_origin, fixture.Capability.SessionId, fixture.Resolver, fixture.Stager);

        ManualPreviewAccessResult missing = access.TryAcquireRead(fixture.Prepared, 0);
        Assert.False(missing.Success);
        Assert.Equal("media_file_missing", missing.ErrorCode);
        Assert.Equal(1, fixture.Handler.Requests);
        Assert.Equal(before.MarkerBytes, SnapshotMetadataForDirectory(Path.GetDirectoryName(fixture.Prepared.Path)!).MarkerBytes);
        Assert.Equal(before.MarkerWriteUtc, SnapshotMetadataForDirectory(Path.GetDirectoryName(fixture.Prepared.Path)!).MarkerWriteUtc);
        Assert.Equal(before.LastUseBytes, SnapshotMetadataForDirectory(Path.GetDirectoryName(fixture.Prepared.Path)!).LastUseBytes);
        Assert.Equal(before.LastUseWriteUtc, SnapshotMetadataForDirectory(Path.GetDirectoryName(fixture.Prepared.Path)!).LastUseWriteUtc);

        File.WriteAllText(fixture.Prepared.Path, "abcd");
        ManualPreviewAccessResult mismatch = access.TryAcquireRead(fixture.Prepared, 0);
        Assert.False(mismatch.Success);
        Assert.Equal("media_size_mismatch", mismatch.ErrorCode);
        Assert.Equal(1, fixture.Handler.Requests);
    }

    [Fact]
    public async Task HelperOwned_RejectsExpectedPathMismatchAndSessionReparseWithoutTouchingOutside()
    {
        OwnedFixture fixture = await CreateOwnedAsync();
        Assert.True(fixture.Stager.Cleanup(fixture.Capability));
        using var access = new ManualAssetPreviewAccess(_origin, fixture.Capability.SessionId, fixture.Resolver, fixture.Stager);

        ManualPreviewAccessResult mismatch = access.TryAcquireRead(fixture.Prepared with { Path = fixture.Prepared.Path + ".other" }, 0);
        Assert.False(mismatch.Success);
        Assert.Equal("validation_failed", mismatch.ErrorCode);

        string session = Path.GetDirectoryName(fixture.Prepared.Path)!;
        string moved = session + ".moved";
        Directory.Move(session, moved);
        string outside = Path.Combine(_root, "outside");
        Directory.CreateDirectory(outside);
        string sentinel = Path.Combine(outside, "sentinel.txt");
        File.WriteAllText(sentinel, "keep");
        CreateDirectoryReparsePoint(session, outside);

        ManualPreviewAccessResult reparse = access.TryAcquireRead(fixture.Prepared, 0);
        Assert.False(reparse.Success);
        Assert.Equal("media_file_unsafe", reparse.ErrorCode);
        Assert.Equal("keep", File.ReadAllText(sentinel));
        Assert.False(File.Exists(Path.Combine(outside, SocialMediaStager.MarkerName)));
        DeleteDirectoryReparsePoint(session);
    }

    [Fact]
    public void External_RejectsUntrustedUncMissingAndTargetReparse()
    {
        ExternalFixture fixture = CreateExternal(trusted: false);
        using var access = new ManualAssetPreviewAccess(_origin, fixture.SessionId, fixture.Resolver, fixture.Stager);
        Assert.Equal("media_source_untrusted", access.TryAcquireRead(fixture.Prepared, 0).ErrorCode);

        var uncAsset = fixture.Prepared.Asset with { WindowsPath = @"\\server\share\final\a.png" };
        Assert.Equal("validation_failed", access.TryAcquireRead(fixture.Prepared with { Asset = uncAsset, Path = uncAsset.WindowsPath! }, 0).ErrorCode);

        ExternalFixture trusted = CreateExternal(directoryName: "trusted", trusted: true);
        File.Delete(trusted.Prepared.Path);
        using var trustedAccess = new ManualAssetPreviewAccess(_origin, trusted.SessionId, trusted.Resolver, trusted.Stager);
        Assert.Equal("media_file_missing", trustedAccess.TryAcquireRead(trusted.Prepared, 0).ErrorCode);

        string target = Path.Combine(_root, "reparse-target");
        Directory.CreateDirectory(target);
        File.WriteAllText(Path.Combine(target, "sentinel.txt"), "keep");
        CreateDirectoryReparsePoint(trusted.Prepared.Path, target);
        Assert.Equal("media_file_unsafe", trustedAccess.TryAcquireRead(trusted.Prepared, 0).ErrorCode);
        Assert.Equal("keep", File.ReadAllText(Path.Combine(target, "sentinel.txt")));
        DeleteDirectoryReparsePoint(trusted.Prepared.Path);
        Assert.Equal(0, fixture.Handler.Requests);
        Assert.Equal(0, trusted.Handler.Requests);
        Assert.Equal(0, fixture.Prompt.Calls);
        Assert.Equal(0, trusted.Prompt.Calls);
    }

    [Fact]
    public void UnsafeProvenanceAndOwnedUncBoundaryFailBeforeFilesystemAccess()
    {
        ExternalFixture fixture = CreateExternal();
        using var access = new ManualAssetPreviewAccess(_origin, fixture.SessionId, fixture.Resolver, fixture.Stager);
        Assert.Equal(
            "validation_failed",
            access.TryAcquireRead(fixture.Prepared with { Provenance = (StagedMediaProvenance)99 }, 0).ErrorCode);

        var uncStager = new SocialMediaStager(
            SocialCapabilityClientTests.CreateClient(fixture.Handler), fixture.Resolver, @"\\server\share\staging");
        using var uncAccess = new ManualAssetPreviewAccess(_origin, fixture.SessionId, fixture.Resolver, uncStager);
        Assert.Equal(
            "validation_failed",
            uncAccess.TryAcquireRead(
                fixture.Prepared with
                {
                    Provenance = StagedMediaProvenance.HelperOwned,
                    Path = @"\\server\share\staging\session\0000-1.png",
                },
                0).ErrorCode);
        Assert.Equal(0, fixture.Handler.Requests);
    }

    [Fact]
    public async Task ActiveLease_PinsHelperSessionAndExternalAncestorsUntilDisposed()
    {
        OwnedFixture owned = await CreateOwnedAsync();
        Assert.True(owned.Stager.Cleanup(owned.Capability));
        using var ownedAccess = new ManualAssetPreviewAccess(_origin, owned.Capability.SessionId, owned.Resolver, owned.Stager);
        ManualPreviewFileLease ownedLease = AssertReady(ownedAccess.TryAcquireRead(owned.Prepared, 0));
        string session = Path.GetDirectoryName(owned.Prepared.Path)!;
        string movedSession = session + ".moved";
        Assert.Throws<IOException>(() => Directory.Move(session, movedSession));
        ownedLease.Dispose();
        Directory.Move(session, movedSession);

        ExternalFixture external = CreateExternal(directoryName: "external-pinned");
        using var externalAccess = new ManualAssetPreviewAccess(_origin, external.SessionId, external.Resolver, external.Stager);
        ManualPreviewFileLease externalLease = AssertReady(externalAccess.TryAcquireRead(external.Prepared, 0));
        string trustedRoot = Path.GetDirectoryName(Path.GetDirectoryName(external.Prepared.Path)!)!;
        string movedRoot = trustedRoot + ".moved";
        Assert.Throws<IOException>(() => Directory.Move(trustedRoot, movedRoot));
        externalLease.Dispose();
        Directory.Move(trustedRoot, movedRoot);
    }

    [Fact]
    public async Task DisposedAccessRejectsNewAcquisitionButExistingLeaseCanFinish()
    {
        OwnedFixture fixture = await CreateOwnedAsync();
        Assert.True(fixture.Stager.Cleanup(fixture.Capability));
        var access = new ManualAssetPreviewAccess(_origin, fixture.Capability.SessionId, fixture.Resolver, fixture.Stager);
        ManualPreviewFileLease lease = AssertReady(access.TryAcquireRead(fixture.Prepared, 0));

        access.Dispose();

        Assert.Equal("preview_access_closed", access.TryAcquireRead(fixture.Prepared, 0).ErrorCode);
        Assert.Equal(3, RandomAccess.GetLength(lease.ReadHandle));
        lease.Dispose();
    }

    [Fact]
    public async Task PreviewFailureDoesNotMutatePreparedAssetAndDragAvailabilityCanRestageLater()
    {
        OwnedFixture fixture = await CreateOwnedAsync();
        Assert.True(fixture.Stager.Cleanup(fixture.Capability));
        ManualPreparedAsset original = fixture.Prepared;
        File.Delete(original.Path);
        using var access = new ManualAssetPreviewAccess(_origin, fixture.Capability.SessionId, fixture.Resolver, fixture.Stager);

        ManualPreviewAccessResult preview = access.TryAcquireRead(original, 0);
        StagedMedia available = await fixture.Stager.EnsureAvailableAsync(
            _origin, fixture.Capability, original.Asset, 0, StagedMedia.Owned(original.Path), CancellationToken.None);

        Assert.False(preview.Success);
        Assert.Same(original, fixture.Prepared);
        Assert.True(available.Success);
        Assert.Equal(original.Path, available.Path);
        Assert.Equal("abc", File.ReadAllText(original.Path));
        Assert.Equal(2, fixture.Handler.Requests);
        fixture.Stager.Cleanup(fixture.Capability);
    }

    public void Dispose()
    {
        if (Directory.Exists(_root)) Directory.Delete(_root, recursive: true);
    }

    private async Task<OwnedFixture> CreateOwnedAsync()
    {
        string stagingRoot = Path.Combine(_root, "staging-" + Guid.NewGuid().ToString("N"));
        var handler = new CountingHandler("abc");
        var store = new TrustedStore();
        var resolver = new LocalMediaResolver(store, new RejectingPrompt());
        var stager = new SocialMediaStager(SocialCapabilityClientTests.CreateClient(handler), resolver, stagingRoot);
        var capability = new SocialCapability(Guid.NewGuid().ToString(), "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
        SocialRedeemAsset asset = SocialCapabilityClientTests.Asset(7, 3);
        StagedMedia media = await stager.StageAsync(_origin, capability, asset, 0, CancellationToken.None);
        Assert.True(media.Success);
        return new OwnedFixture(handler, resolver, stager, capability, asset,
            new ManualPreparedAsset(asset, media.Path!, StagedMediaProvenance.HelperOwned));
    }

    private ExternalFixture CreateExternal(string? directoryName = null, bool trusted = true)
    {
        string project = Path.Combine(_root, directoryName ?? ("external-" + Guid.NewGuid().ToString("N")), "project");
        string source = Path.Combine(project, "final", "a.png");
        Directory.CreateDirectory(Path.GetDirectoryName(source)!);
        File.WriteAllText(source, "abc");
        var store = new TrustedStore();
        if (trusted) store.Trust(_origin, project);
        var prompt = new RejectingPrompt();
        var resolver = new LocalMediaResolver(store, prompt);
        var handler = new ThrowingHandler();
        string stagingRoot = Path.Combine(_root, "unused-staging-" + Guid.NewGuid().ToString("N"));
        var stager = new SocialMediaStager(SocialCapabilityClientTests.CreateClient(handler), resolver, stagingRoot);
        var asset = new SocialRedeemAsset(1, "attachment", 0, "a.png", ".png", "image/png", 3, "final/a.png", true, source);
        return new ExternalFixture(handler, prompt, resolver, stager, stagingRoot, Guid.NewGuid().ToString(), asset,
            new ManualPreparedAsset(asset, source, StagedMediaProvenance.ExternalSource));
    }

    private static ManualPreviewFileLease AssertReady(ManualPreviewAccessResult result)
    {
        Assert.True(result.Success, result.ErrorCode);
        return Assert.IsType<ManualPreviewFileLease>(result.Lease);
    }

    private static MetadataSnapshot SnapshotMetadata(string mediaPath) => SnapshotMetadataForDirectory(Path.GetDirectoryName(mediaPath)!);

    private static MetadataSnapshot SnapshotMetadataForDirectory(string directory)
    {
        string marker = Path.Combine(directory, SocialMediaStager.MarkerName);
        string lastUse = Path.Combine(directory, SocialMediaStager.LastUseName);
        return new MetadataSnapshot(
            Convert.ToHexString(File.ReadAllBytes(marker)), File.GetLastWriteTimeUtc(marker),
            Convert.ToHexString(File.ReadAllBytes(lastUse)), File.GetLastWriteTimeUtc(lastUse));
    }

    private static void CreateDirectoryReparsePoint(string link, string target)
    {
        try
        {
            Directory.CreateSymbolicLink(link, target);
            return;
        }
        catch (UnauthorizedAccessException) { }
        catch (IOException) { }

        var start = new ProcessStartInfo("cmd.exe")
        {
            UseShellExecute = false,
            CreateNoWindow = true,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
        };
        start.ArgumentList.Add("/c");
        start.ArgumentList.Add("mklink");
        start.ArgumentList.Add("/J");
        start.ArgumentList.Add(link);
        start.ArgumentList.Add(target);
        using Process process = Process.Start(start)!;
        process.WaitForExit();
        Assert.Equal(0, process.ExitCode);
    }

    private static void DeleteDirectoryReparsePoint(string link)
    {
        Directory.Delete(link);
    }

    private sealed record MetadataSnapshot(string MarkerBytes, DateTime MarkerWriteUtc, string LastUseBytes, DateTime LastUseWriteUtc);
    private sealed record OwnedFixture(
        CountingHandler Handler, LocalMediaResolver Resolver, SocialMediaStager Stager,
        SocialCapability Capability, SocialRedeemAsset Asset, ManualPreparedAsset Prepared);
    private sealed record ExternalFixture(
        ThrowingHandler Handler, RejectingPrompt Prompt, LocalMediaResolver Resolver, SocialMediaStager Stager,
        string StagingRoot, string SessionId, SocialRedeemAsset Asset, ManualPreparedAsset Prepared);

    private sealed class TrustedStore : ITrustedMediaRootStore
    {
        private readonly HashSet<string> _trusted = new(StringComparer.OrdinalIgnoreCase);
        public bool IsTrusted(SocialOrigin origin, string root) => _trusted.Contains(origin.Identity + "|" + root);
        public void Trust(SocialOrigin origin, string root) => _trusted.Add(origin.Identity + "|" + root);
    }

    private sealed class RejectingPrompt : ITrustedMediaRootPrompt
    {
        public int Calls { get; private set; }
        public bool ConfirmTrust(SocialOrigin origin, string root)
        {
            Calls++;
            return false;
        }
    }

    private sealed class ThrowingHandler : HttpMessageHandler
    {
        private int _requests;
        public int Requests => Volatile.Read(ref _requests);

        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
        {
            Interlocked.Increment(ref _requests);
            throw new InvalidOperationException("Preview access must not invoke the capability client.");
        }
    }

    private sealed class CountingHandler(string content) : HttpMessageHandler
    {
        private int _requests;
        public int Requests => Volatile.Read(ref _requests);

        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
        {
            Interlocked.Increment(ref _requests);
            return Task.FromResult(new HttpResponseMessage(HttpStatusCode.OK)
            {
                Content = new ByteArrayContent(Encoding.UTF8.GetBytes(content)),
            });
        }
    }
}
