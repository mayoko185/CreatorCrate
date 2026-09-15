using System.Net;
using System.Security.Cryptography;
using System.Text;
using System.Diagnostics;
using System.Reflection;
using OpenLocally;

namespace OpenLocally.Tests;

public class SocialMediaStagerTests : IDisposable
{
    private readonly string _root = Path.Combine(Path.GetTempPath(), "creatorcrate-stage-" + Guid.NewGuid().ToString("N"));

    [Fact]
    public async Task DownloadedMedia_IsOwnedFinalizedAndCleanupRetainsCompletedFile()
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
        Assert.True(File.Exists(media.Path));
    }

    [Fact]
    public async Task BareRedeemExtension_IsNormalizedAndRetainedInStagedFilename()
    {
        const string json = "{\"ok\":true,\"sessionId\":\"00000000-0000-0000-0000-000000000001\",\"releaseId\":42,\"attemptDeadlineAt\":\"2026-01-01 12:00:00\",\"platforms\":[{\"platform\":\"patreon\",\"title\":\"Title\",\"body\":\"\",\"assets\":[{\"assetId\":7,\"role\":\"primary\",\"sortOrder\":0,\"filename\":\"asset.PNG\",\"extension\":\"png\",\"mimeType\":\"image/png\",\"sizeBytes\":3,\"relativePath\":\"final/asset.PNG\",\"isPresent\":1}]}],\"mediaToken\":\"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\"}";
        Assert.True(SocialRedeemClient.TryParseResponse(Encoding.UTF8.GetBytes(json), out SocialRedeemResponse? response));
        SocialRedeemAsset asset = response!.Platforms.Single().Assets.Single();
        Assert.Equal(".png", asset.Extension);
        var handler = new SocialCapabilityClientTests.CaptureHandler(_ => new HttpResponseMessage(HttpStatusCode.OK) { Content = new ByteArrayContent(Encoding.UTF8.GetBytes("abc")) });
        var stager = new SocialMediaStager(SocialCapabilityClientTests.CreateClient(handler), new LocalMediaResolver(new Store(), new Prompt()), _root);
        var capability = new SocialCapability(response.SessionId, response.MediaToken);

        StagedMedia media = await stager.StageAsync(SocialCapabilityClientTests.Origin(), capability, asset, 0, CancellationToken.None);

        Assert.True(media.Success);
        Assert.EndsWith("0000-7.png", media.Path, StringComparison.OrdinalIgnoreCase);
        Assert.False(media.Path!.EndsWith(".bin", StringComparison.OrdinalIgnoreCase));
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
        Assert.True(File.Exists(patreon.Path));
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
        stager.Cleanup(capability);
    }

    [Fact]
    public async Task ReparseStagingRoot_IsRejectedBeforeAnyTargetWrite()
    {
        string target = Path.Combine(_root, "outside");
        string link = Path.Combine(_root, "staging-link");
        Directory.CreateDirectory(target);
        CreateDirectoryReparsePoint(link, target);
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
        CreateDirectoryReparsePoint(candidate, target);
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
    public void Cleanup_OnlyReleasesOwnedLeaseAndNeverTraversesAReparseCandidate()
    {
        string root = Path.Combine(_root, "staging");
        SocialCapability capability = Capability();
        string target = Path.Combine(_root, "outside");
        string candidate = SessionDirectory(root, capability.SessionId);
        Directory.CreateDirectory(root);
        Directory.CreateDirectory(target);
        File.WriteAllText(Path.Combine(target, SocialMediaStager.MarkerName), "creatorcrate-social-prep-v1");
        File.WriteAllText(Path.Combine(target, "sentinel"), "keep");
        CreateDirectoryReparsePoint(candidate, target);
        var stager = CreateStager(new CountingHandler("abc"), root);

        Assert.True(stager.Cleanup(capability));
        Assert.Equal("keep", File.ReadAllText(Path.Combine(target, "sentinel")));
        Assert.True(File.Exists(Path.Combine(target, SocialMediaStager.MarkerName)));
        Directory.Delete(candidate);
    }

    [Fact]
    public void Sweep_RemovesExpiredCompletedAndAbandonedDirectoriesButPreservesSafeBoundaries()
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
        File.WriteAllText(Path.Combine(oldOwned, "0000-1.png"), "old");
        File.WriteAllText(Path.Combine(freshOwned, "0000-2.png"), "fresh");
        Directory.CreateDirectory(outside);
        File.WriteAllText(Path.Combine(outside, SocialMediaStager.MarkerName), "creatorcrate-social-prep-v1");
        File.WriteAllText(Path.Combine(outside, "sentinel"), "keep");
        CreateDirectoryReparsePoint(reparse, outside);
        Directory.SetLastWriteTimeUtc(oldOwned, DateTime.UtcNow.AddHours(-25));
        Directory.SetLastWriteTimeUtc(freshOwned, DateTime.UtcNow.AddHours(-23));
        File.SetLastWriteTimeUtc(Path.Combine(oldOwned, "0000-1.png"), DateTime.UtcNow.AddHours(-25));
        File.SetLastWriteTimeUtc(Path.Combine(freshOwned, "0000-2.png"), DateTime.UtcNow.AddHours(-23));
        var stager = CreateStager(new CountingHandler("abc"), root);

        Assert.Equal(1, stager.SweepAbandonedDirectories());
        Assert.False(Directory.Exists(oldOwned));
        Assert.True(Directory.Exists(freshOwned));
        Assert.True(Directory.Exists(unmarked));
        Assert.True(Directory.Exists(reparse));
        Assert.Equal("keep", File.ReadAllText(Path.Combine(outside, "sentinel")));
        Directory.Delete(reparse);
    }

    [Fact]
    public async Task ActiveLease_PreventsAnotherStagerFromSweepingEvenWithExpiredTimestamp()
    {
        DateTimeOffset now = DateTimeOffset.UtcNow;
        string root = Path.Combine(_root, "staging");
        SocialCapability capability = Capability();
        var owner = CreateStager(new CountingHandler("abc"), root, () => now.AddHours(-48));
        StagedMedia media = await owner.StageAsync(SocialCapabilityClientTests.Origin(), capability, SocialCapabilityClientTests.Asset(7, 3), 0, CancellationToken.None);
        var sweeper = CreateStager(new CountingHandler("unused"), root, () => now);

        Assert.Equal(0, sweeper.SweepAbandonedDirectories());
        Assert.True(File.Exists(media.Path));

        owner.Cleanup(capability);
        Assert.Equal(1, sweeper.SweepAbandonedDirectories());
        Assert.False(File.Exists(media.Path));
    }

    [Fact]
    public async Task DetachedLease_RemainsActiveAfterRuntimeCleanupUntilCompanionOwnerDisposesIt()
    {
        DateTimeOffset now = DateTimeOffset.UtcNow;
        string root = Path.Combine(_root, "staging");
        SocialCapability capability = Capability();
        var owner = CreateStager(new CountingHandler("abc"), root, () => now.AddHours(-48));
        StagedMedia media = await owner.StageAsync(
            SocialCapabilityClientTests.Origin(), capability, SocialCapabilityClientTests.Asset(7, 3), 0, CancellationToken.None);
        var sweeper = CreateStager(new CountingHandler("unused"), root, () => now);

        IDisposable companionLease = owner.DetachLease(capability);
        Assert.True(owner.Cleanup(capability));
        Assert.Equal(0, sweeper.SweepAbandonedDirectories());
        Assert.True(File.Exists(media.Path));

        companionLease.Dispose();
        Assert.Equal(1, sweeper.SweepAbandonedDirectories());
        Assert.False(File.Exists(media.Path));
    }

    [Fact]
    public async Task ActiveOwner_BlocksCrossProcessMarkerDeleteRenameReplacementAndDirectoryCleanup()
    {
        DateTimeOffset old = DateTimeOffset.UtcNow.AddHours(-25);
        string root = Path.Combine(_root, "staging");
        var owner = CreateStager(new CountingHandler("abc"), root, () => old);
        SocialCapability capability = Capability();
        StagedMedia media = await owner.StageAsync(SocialCapabilityClientTests.Origin(), capability, SocialCapabilityClientTests.Asset(7, 3), 0, CancellationToken.None);
        string directory = Path.GetDirectoryName(media.Path!)!;
        string marker = Path.Combine(directory, SocialMediaStager.MarkerName);

        Assert.Equal(1, RunMutationProbe("delete", marker, directory));
        Assert.Equal(1, RunMutationProbe("rename", marker, directory));
        Assert.Equal(1, RunMutationProbe("replace", marker, directory));
        Assert.Equal(1, RunMutationProbe("cleanup", marker, directory));
        Assert.Equal("creatorcrate-social-prep-v1", File.ReadAllText(marker));
        Assert.True(File.Exists(media.Path));

        owner.Cleanup(capability);
        int deleted = CreateStager(new CountingHandler("unused"), root, () => DateTimeOffset.UtcNow.AddHours(26)).SweepAbandonedDirectories();
        Assert.Equal(1, deleted);
    }

    [Fact]
    public async Task ExclusiveSweepClaim_BlocksASecondSweeperUntilDeletionCompletes()
    {
        DateTimeOffset old = DateTimeOffset.UtcNow.AddHours(-25);
        string root = Path.Combine(_root, "staging");
        var owner = CreateStager(new CountingHandler("abc"), root, () => old);
        SocialCapability capability = Capability();
        await owner.StageAsync(SocialCapabilityClientTests.Origin(), capability, SocialCapabilityClientTests.Asset(7, 3), 0, CancellationToken.None);
        owner.Cleanup(capability);
        using var claimed = new ManualResetEventSlim();
        using var release = new ManualResetEventSlim();
        var hooks = new SocialMediaStager.SocialMediaStagerTestHooks
        {
            BeforeDeleteFile = _ => { claimed.Set(); Assert.True(release.Wait(TimeSpan.FromSeconds(10))); },
        };
        var first = CreateStager(new CountingHandler("unused"), root, testHooks: hooks);
        var second = CreateStager(new CountingHandler("unused"), root);
        string marker = Path.Combine(SessionDirectory(root, capability.SessionId), SocialMediaStager.MarkerName);

        Task<int> firstSweep = Task.Run(first.SweepAbandonedDirectories);
        Assert.True(claimed.Wait(TimeSpan.FromSeconds(10)));
        Assert.Equal(0, second.SweepAbandonedDirectories());
        Assert.Equal(1, RunMutationProbe("delete", marker, Path.GetDirectoryName(marker)!));
        Assert.Equal(1, RunMutationProbe("rename", marker, Path.GetDirectoryName(marker)!));
        Assert.Equal(1, RunMutationProbe("replace", marker, Path.GetDirectoryName(marker)!));
        release.Set();

        Assert.Equal(1, await firstSweep);
    }

    [Fact]
    public void LockedExpiredMedia_PreservesMarkerAndSucceedsOnNextSweepAfterUnlock()
    {
        DateTimeOffset now = DateTimeOffset.UtcNow;
        string root = Path.Combine(_root, "staging");
        string owned = CreateExpiredOwnedDirectory(root, "locked-retry", now);
        string media = Path.Combine(owned, "0000-1.png");
        string marker = Path.Combine(owned, SocialMediaStager.MarkerName);
        var stager = CreateStager(new CountingHandler("unused"), root, () => now);

        using (new FileStream(media, FileMode.Open, FileAccess.Read, FileShare.None))
        {
            Assert.Equal(0, stager.SweepAbandonedDirectories());
            Assert.True(File.Exists(media));
            Assert.Equal("creatorcrate-social-prep-v1", File.ReadAllText(marker));
        }

        Assert.Equal(1, stager.SweepAbandonedDirectories());
        Assert.False(Directory.Exists(owned));
    }

    [Fact]
    public void Sweep_FailsClosedForNestedDirectoryAndNestedReparseWithoutTouchingOutsideTarget()
    {
        DateTimeOffset now = DateTimeOffset.UtcNow;
        string root = Path.Combine(_root, "staging");
        string ordinary = CreateExpiredOwnedDirectory(root, "ordinary", now);
        string nested = Path.Combine(ordinary, "nested");
        Directory.CreateDirectory(nested);
        File.WriteAllText(Path.Combine(nested, "keep"), "nested");
        string reparseOwned = CreateExpiredOwnedDirectory(root, "reparse-owned", now);
        string outside = Path.Combine(_root, "outside-nested");
        Directory.CreateDirectory(outside);
        File.WriteAllText(Path.Combine(outside, "sentinel"), "keep");
        string link = Path.Combine(reparseOwned, "nested-link");
        CreateDirectoryReparsePoint(link, outside);

        Assert.Equal(0, CreateStager(new CountingHandler("unused"), root, () => now).SweepAbandonedDirectories());
        Assert.Equal("nested", File.ReadAllText(Path.Combine(nested, "keep")));
        Assert.Equal("keep", File.ReadAllText(Path.Combine(outside, "sentinel")));

        Directory.Delete(link);
    }

    [Fact]
    public void ChildFileReplacementWithJunction_CannotEscapeStaging()
    {
        DateTimeOffset now = DateTimeOffset.UtcNow;
        string root = Path.Combine(_root, "staging");
        string owned = CreateExpiredOwnedDirectory(root, "child-race", now);
        string victim = Path.Combine(owned, "0000-1.png");
        string outside = Path.Combine(_root, "outside-child-race");
        Directory.CreateDirectory(outside);
        File.WriteAllText(Path.Combine(outside, "sentinel"), "keep");
        var hooks = new SocialMediaStager.SocialMediaStagerTestHooks
        {
            BeforeDeleteFile = path =>
            {
                if (!string.Equals(path, victim, StringComparison.OrdinalIgnoreCase)) return;
                File.Delete(path);
                CreateDirectoryReparsePoint(path, outside);
            },
        };

        Assert.Equal(0, CreateStager(new CountingHandler("unused"), root, () => now, hooks).SweepAbandonedDirectories());
        Assert.Equal("keep", File.ReadAllText(Path.Combine(outside, "sentinel")));

        DeleteDirectoryReparsePoint(victim);
    }

    [Fact]
    public void SessionReplacementWithJunction_IsBlockedByPinnedIdentityAndCannotEscapeStagingRoot()
    {
        DateTimeOffset now = DateTimeOffset.UtcNow;
        string root = Path.Combine(_root, "staging");
        string owned = CreateExpiredOwnedDirectory(root, "session-race", now);
        string moved = owned + "-moved";
        string outside = Path.Combine(_root, "outside-session-race");
        Directory.CreateDirectory(outside);
        File.WriteAllText(Path.Combine(outside, "sentinel"), "keep");
        bool replacementBlocked = false;
        var hooks = new SocialMediaStager.SocialMediaStagerTestHooks
        {
            BeforeFinalDirectoryDisposition = directory =>
            {
                try
                {
                    Directory.Move(directory, moved);
                    CreateDirectoryReparsePoint(directory, outside);
                }
                catch (IOException) { replacementBlocked = true; }
            },
        };

        Assert.Equal(1, CreateStager(new CountingHandler("unused"), root, () => now, hooks).SweepAbandonedDirectories());
        Assert.True(replacementBlocked);
        Assert.Equal("keep", File.ReadAllText(Path.Combine(outside, "sentinel")));
        Assert.False(Directory.Exists(owned));
    }

    [Fact]
    public void AncestorReplacementWithJunction_IsBlockedByPinnedIdentityAndCannotEscapeStagingRoot()
    {
        DateTimeOffset now = DateTimeOffset.UtcNow;
        string root = Path.Combine(_root, "staging");
        string owned = CreateExpiredOwnedDirectory(root, "ancestor-race", now);
        string moved = root + "-moved";
        string outside = Path.Combine(_root, "outside-ancestor-race");
        Directory.CreateDirectory(outside);
        File.WriteAllText(Path.Combine(outside, "sentinel"), "keep");
        bool replacementBlocked = false;
        var hooks = new SocialMediaStager.SocialMediaStagerTestHooks
        {
            BeforeFinalDirectoryDisposition = _ =>
            {
                try
                {
                    Directory.Move(root, moved);
                    CreateDirectoryReparsePoint(root, outside);
                }
                catch (IOException) { replacementBlocked = true; }
            },
        };

        Assert.Equal(1, CreateStager(new CountingHandler("unused"), root, () => now, hooks).SweepAbandonedDirectories());
        Assert.True(replacementBlocked);
        Assert.Equal("keep", File.ReadAllText(Path.Combine(outside, "sentinel")));
        Assert.False(Directory.Exists(owned));
    }

    [Fact]
    public void FinalDirectoryDispositionFailure_RestoresMarkerAndRecoveryMetadataSupportsLaterSweep()
    {
        DateTimeOffset now = DateTimeOffset.UtcNow;
        string root = Path.Combine(_root, "staging");
        string owned = CreateExpiredOwnedDirectory(root, "final-removal-failure", now);
        string marker = Path.Combine(owned, SocialMediaStager.MarkerName);
        var hooks = new SocialMediaStager.SocialMediaStagerTestHooks
        {
            BeforeFinalDirectoryDisposition = _ => throw new IOException("simulated final removal failure"),
        };

        Assert.Equal(0, CreateStager(new CountingHandler("unused"), root, () => now, hooks).SweepAbandonedDirectories());
        Assert.Equal("creatorcrate-social-prep-v1", File.ReadAllText(marker));
        Assert.Equal("creatorcrate-social-prep-v1", File.ReadAllText(owned + SocialMediaStager.RecoveryStreamName));
        Assert.Empty(Directory.EnumerateFiles(owned).Where(path => Path.GetFileName(path) != SocialMediaStager.MarkerName));

        File.Delete(marker);
        Assert.Equal(1, CreateStager(new CountingHandler("unused"), root, () => now).SweepAbandonedDirectories());
        Assert.False(Directory.Exists(owned));
    }

    [Fact]
    public async Task MarkerLease_IsObservableAcrossProcessesAndReleasedAfterOwnerCleanup()
    {
        DateTimeOffset old = DateTimeOffset.UtcNow.AddHours(-25);
        string root = Path.Combine(_root, "staging");
        var owner = CreateStager(new CountingHandler("abc"), root, () => old);
        SocialCapability capability = Capability();
        StagedMedia media = await owner.StageAsync(SocialCapabilityClientTests.Origin(), capability, SocialCapabilityClientTests.Asset(7, 3), 0, CancellationToken.None);
        string marker = Path.Combine(Path.GetDirectoryName(media.Path!)!, SocialMediaStager.MarkerName);

        Assert.Equal(1, RunLeaseProbe(marker));
        owner.Cleanup(capability);
        Assert.Equal(0, RunLeaseProbe(marker));
    }

    [Fact]
    public async Task TwoProcessOwnerLeasesCoexistAndEitherLiveOwnerBlocksCleanup()
    {
        DateTimeOffset old = DateTimeOffset.UtcNow.AddHours(-25);
        string root = Path.Combine(_root, "staging");
        var owner = CreateStager(new CountingHandler("abc"), root, () => old);
        SocialCapability capability = Capability();
        StagedMedia media = await owner.StageAsync(SocialCapabilityClientTests.Origin(), capability, SocialCapabilityClientTests.Asset(7, 3), 0, CancellationToken.None);
        string marker = Path.Combine(Path.GetDirectoryName(media.Path!)!, SocialMediaStager.MarkerName);
        using Process secondOwner = StartLeaseHolder(marker);
        try
        {
            Assert.Equal("ready", secondOwner.StandardOutput.ReadLine());
            owner.Cleanup(capability);

            Assert.Equal(0, CreateStager(new CountingHandler("unused"), root).SweepAbandonedDirectories());

            secondOwner.Kill(entireProcessTree: true);
            Assert.True(secondOwner.WaitForExit(10_000));
            Assert.Equal(1, CreateStager(new CountingHandler("unused"), root).SweepAbandonedDirectories());
        }
        finally
        {
            if (!secondOwner.HasExited) secondOwner.Kill(entireProcessTree: true);
        }
    }

    [Fact]
    public async Task CrashedProcessLease_IsReleasedAndDoesNotMakeDirectoryImmortal()
    {
        DateTimeOffset old = DateTimeOffset.UtcNow.AddHours(-25);
        string root = Path.Combine(_root, "staging");
        var creator = CreateStager(new CountingHandler("abc"), root, () => old);
        SocialCapability capability = Capability();
        StagedMedia media = await creator.StageAsync(SocialCapabilityClientTests.Origin(), capability, SocialCapabilityClientTests.Asset(7, 3), 0, CancellationToken.None);
        creator.Cleanup(capability);
        string marker = Path.Combine(Path.GetDirectoryName(media.Path!)!, SocialMediaStager.MarkerName);
        using Process holder = StartLeaseHolder(marker);
        try
        {
            Assert.Equal("ready", holder.StandardOutput.ReadLine());
            var sweeper = CreateStager(new CountingHandler("unused"), root);
            Assert.Equal(0, sweeper.SweepAbandonedDirectories());

            holder.Kill(entireProcessTree: true);
            Assert.True(holder.WaitForExit(10_000));
            Assert.Equal(1, sweeper.SweepAbandonedDirectories());
        }
        finally
        {
            if (!holder.HasExited) holder.Kill(entireProcessTree: true);
        }
    }

    [Fact]
    public async Task Sweep_SkipsOnlyLeasedDirectoryAndCanDeleteAnotherExpiredSession()
    {
        DateTimeOffset now = DateTimeOffset.UtcNow;
        string root = Path.Combine(_root, "staging");
        var active = CreateStager(new CountingHandler("abc"), root, () => now.AddHours(-25));
        var released = CreateStager(new CountingHandler("xyz"), root, () => now.AddHours(-25));
        SocialCapability activeCapability = Capability();
        SocialCapability releasedCapability = new("00000000-0000-0000-0000-000000000002", "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb");
        StagedMedia activeMedia = await active.StageAsync(SocialCapabilityClientTests.Origin(), activeCapability, SocialCapabilityClientTests.Asset(7, 3), 0, CancellationToken.None);
        StagedMedia releasedMedia = await released.StageAsync(SocialCapabilityClientTests.Origin(), releasedCapability, SocialCapabilityClientTests.Asset(8, 3), 0, CancellationToken.None);
        released.Cleanup(releasedCapability);

        var sweeper = CreateStager(new CountingHandler("unused"), root, () => now);
        Assert.Equal(1, sweeper.SweepAbandonedDirectories());
        Assert.True(File.Exists(activeMedia.Path));
        Assert.False(File.Exists(releasedMedia.Path));
        active.Cleanup(activeCapability);
    }

    [Fact]
    public async Task CompletedRetention_DeletesOnlyAfterExactTwentyFourHourBoundary()
    {
        DateTimeOffset now = DateTimeOffset.UtcNow;
        string root = Path.Combine(_root, "staging");
        var stager = CreateStager(new CountingHandler("abc"), root, () => now);
        SocialCapability capability = Capability();
        StagedMedia media = await stager.StageAsync(SocialCapabilityClientTests.Origin(), capability, SocialCapabilityClientTests.Asset(7, 3), 0, CancellationToken.None);
        stager.Cleanup(capability);

        now = now.AddHours(24).AddTicks(-1);
        Assert.Equal(0, stager.SweepAbandonedDirectories());
        Assert.True(File.Exists(media.Path));
        now = now.AddTicks(1);
        Assert.Equal(0, stager.SweepAbandonedDirectories());
        Assert.True(File.Exists(media.Path));
        now = now.AddTicks(1);
        Assert.Equal(1, stager.SweepAbandonedDirectories());
    }

    [Fact]
    public async Task SuccessfulRevalidation_ExtendsLastUseAndRetention()
    {
        DateTimeOffset now = DateTimeOffset.UtcNow;
        string root = Path.Combine(_root, "staging");
        var stager = CreateStager(new CountingHandler("abc"), root, () => now);
        SocialCapability capability = Capability();
        SocialRedeemAsset asset = SocialCapabilityClientTests.Asset(7, 3);
        StagedMedia media = await stager.StageAsync(SocialCapabilityClientTests.Origin(), capability, asset, 0, CancellationToken.None);
        stager.Cleanup(capability);

        now = now.AddHours(23);
        Assert.True(stager.Revalidate(SocialCapabilityClientTests.Origin(), capability, asset, 0, media).Success);
        stager.Cleanup(capability);
        now = now.AddHours(2);
        Assert.Equal(0, stager.SweepAbandonedDirectories());
        now = now.AddHours(22).AddTicks(1);
        Assert.Equal(1, stager.SweepAbandonedDirectories());
    }

    [Fact]
    public async Task Revalidate_DetectsMissingFileWithoutSilentlyDroppingIt()
    {
        var stager = CreateStager(new CountingHandler("abc"), Path.Combine(_root, "staging"));
        SocialCapability capability = Capability();
        SocialRedeemAsset asset = SocialCapabilityClientTests.Asset(7, 3);
        StagedMedia media = await stager.StageAsync(SocialCapabilityClientTests.Origin(), capability, asset, 0, CancellationToken.None);
        File.Delete(media.Path!);

        StagedMedia result = stager.Revalidate(SocialCapabilityClientTests.Origin(), capability, asset, 0, media);

        Assert.False(result.Success);
        Assert.Equal("media_file_missing", result.ErrorCode);
        stager.Cleanup(capability);
    }

    [Fact]
    public async Task EnsureAvailable_RestagesMissingOwnedFileThroughExistingDownloadPath()
    {
        var handler = new CountingHandler("abc");
        var stager = CreateStager(handler, Path.Combine(_root, "staging"));
        SocialCapability capability = Capability();
        SocialRedeemAsset asset = SocialCapabilityClientTests.Asset(7, 3);
        StagedMedia media = await stager.StageAsync(SocialCapabilityClientTests.Origin(), capability, asset, 0, CancellationToken.None);
        File.Delete(media.Path!);

        StagedMedia restaged = await stager.EnsureAvailableAsync(SocialCapabilityClientTests.Origin(), capability, asset, 0, media, CancellationToken.None);

        Assert.True(restaged.Success);
        Assert.Equal(media.Path, restaged.Path);
        Assert.Equal("abc", File.ReadAllText(restaged.Path!));
        Assert.Equal(2, handler.Requests);
        stager.Cleanup(capability);
    }

    [Fact]
    public async Task EnsureAvailable_ExpiredCapabilityRequiresFreshPreparation()
    {
        var handler = new ExpiringHandler();
        var stager = CreateStager(handler, Path.Combine(_root, "staging"));
        SocialCapability capability = Capability();
        SocialRedeemAsset asset = SocialCapabilityClientTests.Asset(7, 3);
        StagedMedia media = await stager.StageAsync(SocialCapabilityClientTests.Origin(), capability, asset, 0, CancellationToken.None);
        File.Delete(media.Path!);

        StagedMedia restaged = await stager.EnsureAvailableAsync(SocialCapabilityClientTests.Origin(), capability, asset, 0, media, CancellationToken.None);

        Assert.False(restaged.Success);
        Assert.Equal("media_token_expired", restaged.ErrorCode);
        Assert.Equal(2, handler.Requests);
        stager.Cleanup(capability);
    }

    [Fact]
    public async Task EnsureAvailable_ConcurrentCallersShareOneControlledRestagingDownload()
    {
        var handler = new BlockingRestageHandler("abc", initialRequests: 1, expectedBlockedRequests: 1);
        var stager = CreateStager(handler, Path.Combine(_root, "staging"));
        SocialCapability capability = Capability();
        SocialRedeemAsset asset = SocialCapabilityClientTests.Asset(7, 3);
        StagedMedia media = await stager.StageAsync(SocialCapabilityClientTests.Origin(), capability, asset, 0, CancellationToken.None);
        File.Delete(media.Path!);

        Task<StagedMedia> first = stager.EnsureAvailableAsync(SocialCapabilityClientTests.Origin(), capability, asset, 0, media, CancellationToken.None);
        await handler.AllBlocked.Task.WaitAsync(TimeSpan.FromSeconds(10));
        Task<StagedMedia> second = stager.EnsureAvailableAsync(SocialCapabilityClientTests.Origin(), capability, asset, 0, media, CancellationToken.None);
        Assert.Equal(2, handler.Requests);
        handler.Release.TrySetResult();

        StagedMedia[] results = await Task.WhenAll(first, second);
        Assert.All(results, result => Assert.True(result.Success));
        Assert.All(results, result => Assert.Equal(media.Path, result.Path));
        Assert.Equal(2, handler.Requests);
        Assert.Equal("abc", File.ReadAllText(media.Path!));
        stager.Cleanup(capability);
    }

    [Fact]
    public async Task EnsureAvailable_ConcurrentSizeMismatchCallersShareOneControlledRecovery()
    {
        var handler = new BlockingRestageHandler("abc", initialRequests: 1, expectedBlockedRequests: 1);
        var stager = CreateStager(handler, Path.Combine(_root, "staging"));
        SocialCapability capability = Capability();
        SocialRedeemAsset asset = SocialCapabilityClientTests.Asset(7, 3);
        StagedMedia media = await stager.StageAsync(SocialCapabilityClientTests.Origin(), capability, asset, 0, CancellationToken.None);
        File.WriteAllText(media.Path!, "x");

        Task<StagedMedia> first = stager.EnsureAvailableAsync(SocialCapabilityClientTests.Origin(), capability, asset, 0, media, CancellationToken.None);
        await handler.AllBlocked.Task.WaitAsync(TimeSpan.FromSeconds(10));
        Task<StagedMedia> second = stager.EnsureAvailableAsync(SocialCapabilityClientTests.Origin(), capability, asset, 0, media, CancellationToken.None);
        handler.Release.TrySetResult();

        StagedMedia[] results = await Task.WhenAll(first, second);
        Assert.All(results, result => Assert.True(result.Success));
        Assert.All(results, result => Assert.Equal(media.Path, result.Path));
        Assert.Equal(2, handler.Requests);
        Assert.Equal("abc", File.ReadAllText(media.Path!));
        stager.Cleanup(capability);
    }

    [Fact]
    public async Task EnsureAvailable_StalePreCoordinationObservationCannotDeleteNewValidWinner()
    {
        var handler = new CountingHandler("abc");
        var stager = CreateStager(handler, Path.Combine(_root, "staging"));
        SocialCapability capability = Capability();
        SocialRedeemAsset asset = SocialCapabilityClientTests.Asset(7, 3);
        StagedMedia media = await stager.StageAsync(SocialCapabilityClientTests.Origin(), capability, asset, 0, CancellationToken.None);
        File.WriteAllText(media.Path!, "x");
        Assert.Equal("media_size_mismatch", stager.Revalidate(SocialCapabilityClientTests.Origin(), capability, asset, 0, media).ErrorCode);
        File.WriteAllText(media.Path!, "abc");

        StagedMedia available = await stager.EnsureAvailableAsync(SocialCapabilityClientTests.Origin(), capability, asset, 0, media, CancellationToken.None);

        Assert.True(available.Success);
        Assert.Equal("abc", File.ReadAllText(media.Path!));
        Assert.Equal(1, handler.Requests);
        stager.Cleanup(capability);
    }

    [Fact]
    public async Task EnsureAvailable_AfterCompletedCoordinationFreshlyValidatesWithoutDownloading()
    {
        var handler = new CountingHandler("abc");
        var stager = CreateStager(handler, Path.Combine(_root, "staging"));
        SocialCapability capability = Capability();
        SocialRedeemAsset asset = SocialCapabilityClientTests.Asset(7, 3);
        StagedMedia media = await stager.StageAsync(SocialCapabilityClientTests.Origin(), capability, asset, 0, CancellationToken.None);
        File.Delete(media.Path!);

        StagedMedia first = await stager.EnsureAvailableAsync(SocialCapabilityClientTests.Origin(), capability, asset, 0, media, CancellationToken.None);
        StagedMedia next = await stager.EnsureAvailableAsync(SocialCapabilityClientTests.Origin(), capability, asset, 0, media, CancellationToken.None);

        Assert.True(first.Success);
        Assert.True(next.Success);
        Assert.Equal(first.Path, next.Path);
        Assert.Equal(2, handler.Requests);
        stager.Cleanup(capability);
    }

    [Fact]
    public async Task EnsureAvailable_FailedCoordinationIsRemovedAndLaterRetrySucceeds()
    {
        var handler = new FailOnceRestageHandler();
        var stager = CreateStager(handler, Path.Combine(_root, "staging"));
        SocialCapability capability = Capability();
        SocialRedeemAsset asset = SocialCapabilityClientTests.Asset(7, 3);
        StagedMedia media = await stager.StageAsync(SocialCapabilityClientTests.Origin(), capability, asset, 0, CancellationToken.None);
        File.Delete(media.Path!);

        StagedMedia failed = await stager.EnsureAvailableAsync(SocialCapabilityClientTests.Origin(), capability, asset, 0, media, CancellationToken.None);
        StagedMedia retried = await stager.EnsureAvailableAsync(SocialCapabilityClientTests.Origin(), capability, asset, 0, media, CancellationToken.None);

        Assert.Equal("media_download_failed", failed.ErrorCode);
        Assert.True(retried.Success);
        Assert.Equal("abc", File.ReadAllText(media.Path!));
        Assert.Equal(3, handler.Requests);
        Assert.Empty(Directory.EnumerateFiles(Path.GetDirectoryName(media.Path!)!, "*.partial"));
        stager.Cleanup(capability);
    }

    [Fact]
    public async Task EnsureAvailable_UnrelatedAssetsRestageIndependently()
    {
        var handler = new BlockingRestageHandler("abc", initialRequests: 2, expectedBlockedRequests: 2);
        var stager = CreateStager(handler, Path.Combine(_root, "staging"));
        SocialCapability capability = Capability();
        SocialRedeemAsset firstAsset = SocialCapabilityClientTests.Asset(7, 3);
        SocialRedeemAsset secondAsset = SocialCapabilityClientTests.Asset(8, 3);
        StagedMedia firstMedia = await stager.StageAsync(SocialCapabilityClientTests.Origin(), capability, firstAsset, 0, CancellationToken.None);
        StagedMedia secondMedia = await stager.StageAsync(SocialCapabilityClientTests.Origin(), capability, secondAsset, 1, CancellationToken.None);
        File.Delete(firstMedia.Path!);
        File.Delete(secondMedia.Path!);

        Task<StagedMedia> first = stager.EnsureAvailableAsync(SocialCapabilityClientTests.Origin(), capability, firstAsset, 0, firstMedia, CancellationToken.None);
        Task<StagedMedia> second = stager.EnsureAvailableAsync(SocialCapabilityClientTests.Origin(), capability, secondAsset, 1, secondMedia, CancellationToken.None);
        await handler.AllBlocked.Task.WaitAsync(TimeSpan.FromSeconds(10));
        Assert.Equal(4, handler.Requests);
        handler.Release.TrySetResult();

        Assert.All(await Task.WhenAll(first, second), result => Assert.True(result.Success));
        stager.Cleanup(capability);
    }

    [Fact]
    public async Task FinalizationCollision_WithValidWinner_ReusesWinnerAndCleansLosingPartial()
    {
        bool simulateWinner = false;
        var hooks = new SocialMediaStager.SocialMediaStagerTestHooks
        {
            BeforeFinalMove = (_, finalPath) =>
            {
                if (simulateWinner) File.WriteAllText(finalPath, "abc");
            },
        };
        var handler = new CountingHandler("abc");
        string root = Path.Combine(_root, "staging");
        var stager = CreateStager(handler, root, testHooks: hooks);
        SocialCapability capability = Capability();
        SocialRedeemAsset asset = SocialCapabilityClientTests.Asset(7, 3);
        StagedMedia media = await stager.StageAsync(SocialCapabilityClientTests.Origin(), capability, asset, 0, CancellationToken.None);
        File.Delete(media.Path!);
        simulateWinner = true;

        StagedMedia restaged = await stager.EnsureAvailableAsync(SocialCapabilityClientTests.Origin(), capability, asset, 0, media, CancellationToken.None);

        Assert.True(restaged.Success);
        Assert.Equal("abc", File.ReadAllText(restaged.Path!));
        Assert.Empty(Directory.EnumerateFiles(Path.GetDirectoryName(restaged.Path!)!, "*.partial"));
        Assert.Equal(2, handler.Requests);
        stager.Cleanup(capability);
    }

    [Fact]
    public async Task MismatchRecovery_CrossProcessReplacementPreservesAndReusesValidWinner()
    {
        var handler = new CountingHandler("abc");
        var hooks = new SocialMediaStager.SocialMediaStagerTestHooks
        {
            BeforeMismatchDisposition = path => Assert.Equal(0, RunIdentityReplacementProbe(path, "abc")),
        };
        var stager = CreateStager(handler, Path.Combine(_root, "staging"), testHooks: hooks);
        SocialCapability capability = Capability();
        SocialRedeemAsset asset = SocialCapabilityClientTests.Asset(7, 3);
        StagedMedia media = await stager.StageAsync(SocialCapabilityClientTests.Origin(), capability, asset, 0, CancellationToken.None);
        File.WriteAllText(media.Path!, "x");

        StagedMedia available = await stager.EnsureAvailableAsync(SocialCapabilityClientTests.Origin(), capability, asset, 0, media, CancellationToken.None);

        Assert.True(available.Success);
        Assert.Equal("abc", File.ReadAllText(media.Path!));
        Assert.Equal(1, handler.Requests);
        Assert.Empty(Directory.EnumerateFiles(Path.GetDirectoryName(media.Path!)!, "*.partial"));
        stager.Cleanup(capability);
    }

    [Fact]
    public async Task MismatchRecovery_CrossProcessInvalidWinnerFailsWithoutDeletingIt()
    {
        var handler = new CountingHandler("abc");
        var hooks = new SocialMediaStager.SocialMediaStagerTestHooks
        {
            BeforeMismatchDisposition = path => Assert.Equal(0, RunIdentityReplacementProbe(path, "x")),
        };
        var stager = CreateStager(handler, Path.Combine(_root, "staging"), testHooks: hooks);
        SocialCapability capability = Capability();
        SocialRedeemAsset asset = SocialCapabilityClientTests.Asset(7, 3);
        StagedMedia media = await stager.StageAsync(SocialCapabilityClientTests.Origin(), capability, asset, 0, CancellationToken.None);
        File.WriteAllText(media.Path!, "bad!");

        StagedMedia available = await stager.EnsureAvailableAsync(SocialCapabilityClientTests.Origin(), capability, asset, 0, media, CancellationToken.None);

        Assert.False(available.Success);
        Assert.Equal("media_size_mismatch", available.ErrorCode);
        Assert.Equal("x", File.ReadAllText(media.Path!));
        Assert.Equal(1, handler.Requests);
        Assert.Empty(Directory.EnumerateFiles(Path.GetDirectoryName(media.Path!)!, "*.partial"));
        stager.Cleanup(capability);
    }

    [Fact]
    public async Task FinalizationCollision_WithInvalidWinner_FailsDeterministicallyAndCleansLosingPartial()
    {
        bool simulateWinner = false;
        var hooks = new SocialMediaStager.SocialMediaStagerTestHooks
        {
            BeforeFinalMove = (_, finalPath) =>
            {
                if (simulateWinner) File.WriteAllText(finalPath, "x");
            },
        };
        string root = Path.Combine(_root, "staging");
        var stager = CreateStager(new CountingHandler("abc"), root, testHooks: hooks);
        SocialCapability capability = Capability();
        SocialRedeemAsset asset = SocialCapabilityClientTests.Asset(7, 3);
        StagedMedia media = await stager.StageAsync(SocialCapabilityClientTests.Origin(), capability, asset, 0, CancellationToken.None);
        File.Delete(media.Path!);
        simulateWinner = true;

        StagedMedia restaged = await stager.EnsureAvailableAsync(SocialCapabilityClientTests.Origin(), capability, asset, 0, media, CancellationToken.None);

        Assert.False(restaged.Success);
        Assert.Equal("media_size_mismatch", restaged.ErrorCode);
        Assert.Equal("x", File.ReadAllText(media.Path!));
        Assert.Empty(Directory.EnumerateFiles(Path.GetDirectoryName(media.Path!)!, "*.partial"));
        stager.Cleanup(capability);
    }

    [Fact]
    public async Task EnsureAvailable_DownloadFailureStillFailsAndCleansPartial()
    {
        var handler = new FailingRestageHandler();
        var stager = CreateStager(handler, Path.Combine(_root, "staging"));
        SocialCapability capability = Capability();
        SocialRedeemAsset asset = SocialCapabilityClientTests.Asset(7, 3);
        StagedMedia media = await stager.StageAsync(SocialCapabilityClientTests.Origin(), capability, asset, 0, CancellationToken.None);
        File.Delete(media.Path!);

        StagedMedia restaged = await stager.EnsureAvailableAsync(SocialCapabilityClientTests.Origin(), capability, asset, 0, media, CancellationToken.None);

        Assert.False(restaged.Success);
        Assert.Equal("media_download_failed", restaged.ErrorCode);
        Assert.Empty(Directory.EnumerateFiles(Path.GetDirectoryName(media.Path!)!, "*.partial"));
        stager.Cleanup(capability);
    }

    [Fact]
    public void Sweep_RemovesFailedPartialImmediatelyWhenUnleased()
    {
        string root = Path.Combine(_root, "staging");
        string failed = Path.Combine(root, "failed");
        Directory.CreateDirectory(failed);
        File.WriteAllText(Path.Combine(failed, SocialMediaStager.MarkerName), "creatorcrate-social-prep-v1");
        File.WriteAllText(Path.Combine(failed, ".download.partial"), "incomplete");
        var stager = CreateStager(new CountingHandler("unused"), root);

        Assert.Equal(1, stager.SweepAbandonedDirectories());
        Assert.False(Directory.Exists(failed));
    }

    [Fact]
    public void Sweep_BoundsMalformedRetentionMetadataAndEventuallyDeletesOwnedDirectory()
    {
        DateTimeOffset now = DateTimeOffset.UtcNow;
        string root = Path.Combine(_root, "staging");
        string owned = Path.Combine(root, "malformed");
        Directory.CreateDirectory(owned);
        File.WriteAllText(Path.Combine(owned, SocialMediaStager.MarkerName), "creatorcrate-social-prep-v1");
        string metadata = Path.Combine(owned, SocialMediaStager.LastUseName);
        File.WriteAllText(metadata, new string('x', 10_000));
        File.SetLastWriteTimeUtc(metadata, now.AddHours(-25).UtcDateTime);
        var stager = CreateStager(new CountingHandler("unused"), root, () => now);

        Assert.Equal(1, stager.SweepAbandonedDirectories());
        Assert.False(Directory.Exists(owned));
    }

    [Fact]
    public async Task Sweep_ToleratesSmallFutureClockSkew()
    {
        DateTimeOffset now = DateTimeOffset.UtcNow;
        string root = Path.Combine(_root, "staging");
        var stager = CreateStager(new CountingHandler("abc"), root, () => now);
        SocialCapability capability = Capability();
        StagedMedia media = await stager.StageAsync(SocialCapabilityClientTests.Origin(), capability, SocialCapabilityClientTests.Asset(7, 3), 0, CancellationToken.None);
        stager.Cleanup(capability);
        string lastUse = Path.Combine(Path.GetDirectoryName(media.Path!)!, SocialMediaStager.LastUseName);
        DateTime tolerated = now.Add(SocialMediaStager.FutureClockSkewTolerance).UtcDateTime;
        File.SetLastWriteTimeUtc(lastUse, tolerated);

        Assert.Equal(0, stager.SweepAbandonedDirectories());
        Assert.Equal(tolerated, File.GetLastWriteTimeUtc(lastUse));
    }

    [Fact]
    public async Task Sweep_NormalizesExcessiveFutureLastUseOnceAndExpiresFromThatBound()
    {
        DateTimeOffset now = DateTimeOffset.UtcNow;
        string root = Path.Combine(_root, "staging");
        var stager = CreateStager(new CountingHandler("abc"), root, () => now);
        SocialCapability capability = Capability();
        StagedMedia media = await stager.StageAsync(SocialCapabilityClientTests.Origin(), capability, SocialCapabilityClientTests.Asset(7, 3), 0, CancellationToken.None);
        stager.Cleanup(capability);
        string lastUse = Path.Combine(Path.GetDirectoryName(media.Path!)!, SocialMediaStager.LastUseName);
        File.SetLastWriteTimeUtc(lastUse, DateTime.MaxValue);

        Assert.Equal(0, stager.SweepAbandonedDirectories());
        Assert.Equal(now.UtcDateTime, File.GetLastWriteTimeUtc(lastUse));
        now = now.AddHours(24);
        Assert.Equal(0, stager.SweepAbandonedDirectories());
        now = now.AddTicks(1);
        Assert.Equal(1, stager.SweepAbandonedDirectories());
    }

    [Fact]
    public void Sweep_NormalizesLegacyExcessiveFutureTimestampIntoLastUseMetadata()
    {
        DateTimeOffset now = DateTimeOffset.UtcNow;
        string root = Path.Combine(_root, "staging");
        string owned = CreateExpiredOwnedDirectory(root, "legacy-future", now);
        string media = Path.Combine(owned, "0000-1.png");
        File.SetLastWriteTimeUtc(media, DateTime.MaxValue);
        Directory.SetLastWriteTimeUtc(owned, DateTime.MaxValue);
        var stager = CreateStager(new CountingHandler("unused"), root, () => now);

        Assert.Equal(0, stager.SweepAbandonedDirectories());
        string lastUse = Path.Combine(owned, SocialMediaStager.LastUseName);
        Assert.Equal("creatorcrate-social-prep-last-use-v1", File.ReadAllText(lastUse));
        Assert.Equal(now.UtcDateTime, File.GetLastWriteTimeUtc(lastUse));
        now = now.AddHours(24).AddTicks(1);
        Assert.Equal(1, stager.SweepAbandonedDirectories());
    }

    [Fact]
    public async Task Sweep_ActiveLeaseStillProtectsDirectoryWithExtremeFutureTimestamp()
    {
        DateTimeOffset now = DateTimeOffset.UtcNow;
        string root = Path.Combine(_root, "staging");
        var owner = CreateStager(new CountingHandler("abc"), root, () => now);
        SocialCapability capability = Capability();
        StagedMedia media = await owner.StageAsync(SocialCapabilityClientTests.Origin(), capability, SocialCapabilityClientTests.Asset(7, 3), 0, CancellationToken.None);
        string lastUse = Path.Combine(Path.GetDirectoryName(media.Path!)!, SocialMediaStager.LastUseName);
        File.SetLastWriteTimeUtc(lastUse, DateTime.MaxValue);
        now = now.AddYears(100);

        Assert.Equal(0, CreateStager(new CountingHandler("unused"), root, () => now).SweepAbandonedDirectories());
        Assert.True(File.Exists(media.Path));
        owner.Cleanup(capability);
    }

    [Fact]
    public async Task ConcurrentSweeps_DeleteExpiredDirectoryAtMostOnceAndTolerateDisappearance()
    {
        DateTimeOffset old = DateTimeOffset.UtcNow.AddHours(-25);
        string root = Path.Combine(_root, "staging");
        var owner = CreateStager(new CountingHandler("abc"), root, () => old);
        SocialCapability capability = Capability();
        await owner.StageAsync(SocialCapabilityClientTests.Origin(), capability, SocialCapabilityClientTests.Asset(7, 3), 0, CancellationToken.None);
        owner.Cleanup(capability);
        var first = CreateStager(new CountingHandler("unused"), root);
        var second = CreateStager(new CountingHandler("unused"), root);

        int[] results = await Task.WhenAll(Task.Run(first.SweepAbandonedDirectories), Task.Run(second.SweepAbandonedDirectories));

        Assert.Equal(1, results.Sum());
        Assert.Equal(0, first.SweepAbandonedDirectories());
    }

    [Fact]
    public async Task ExistingFileAndAggregateLimitsRemainEnforcedBeforeDownload()
    {
        var handler = new CountingHandler("unused");
        var stager = CreateStager(handler, Path.Combine(_root, "staging"));
        SocialRedeemAsset oversized = SocialCapabilityClientTests.Asset(7, SocialMediaStager.MaxAssetBytes + 1);
        Assert.Equal("media_file_limit_exceeded", (await stager.StageAsync(SocialCapabilityClientTests.Origin(), Capability(), oversized, 0, CancellationToken.None)).ErrorCode);

        FieldInfo stagedBytes = typeof(SocialMediaStager).GetField("_stagedBytes", BindingFlags.Instance | BindingFlags.NonPublic)!;
        stagedBytes.SetValue(stager, SocialMediaStager.MaxAggregateBytes);
        Assert.Equal("media_aggregate_limit_exceeded", (await stager.StageAsync(SocialCapabilityClientTests.Origin(), Capability(), SocialCapabilityClientTests.Asset(8, 1), 1, CancellationToken.None)).ErrorCode);
        Assert.Equal(0, handler.Requests);
    }

    [Fact]
    public async Task SweepAndCleanupNeverMutateExternalLocalSource()
    {
        string source = Path.Combine(_root, "project", "final", "a.png");
        Directory.CreateDirectory(Path.GetDirectoryName(source)!);
        File.WriteAllText(source, "abc");
        string root = Path.Combine(_root, "staging");
        var handler = new CountingHandler("unused");
        var stager = new SocialMediaStager(
            SocialCapabilityClientTests.CreateClient(handler),
            new LocalMediaResolver(new AlwaysTrustedStore(), new Prompt()), root);
        var asset = new SocialRedeemAsset(7, "attachment", 0, "a.png", ".png", "image/png", 3, "final/a.png", true, source);

        StagedMedia media = await stager.StageAsync(SocialCapabilityClientTests.Origin(), Capability(), asset, 0, CancellationToken.None);
        stager.Cleanup(Capability());
        stager.SweepAbandonedDirectories();

        Assert.Equal(StagedMediaProvenance.ExternalSource, media.Provenance);
        Assert.Equal("abc", File.ReadAllText(source));

        File.WriteAllText(source, "changed");
        StagedMedia changed = await stager.EnsureAvailableAsync(
            SocialCapabilityClientTests.Origin(), Capability(), asset, 0, media, CancellationToken.None);
        Assert.Equal("media_size_mismatch", changed.ErrorCode);
        Assert.Equal("changed", File.ReadAllText(source));

        File.Delete(source);
        StagedMedia missing = await stager.EnsureAvailableAsync(
            SocialCapabilityClientTests.Origin(), Capability(), asset, 0, media, CancellationToken.None);
        Assert.Equal("media_file_missing", missing.ErrorCode);
        Assert.Equal(0, handler.Requests);
        Assert.False(Directory.Exists(root));
    }

    public void Dispose() { if (Directory.Exists(_root)) Directory.Delete(_root, true); }
    private static SocialCapability Capability() => new("00000000-0000-0000-0000-000000000001", "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
    private static string SessionDirectory(string root, string sessionId)
    {
        byte[] digest = SHA256.HashData(Encoding.UTF8.GetBytes(sessionId));
        return Path.Combine(root, Convert.ToHexString(digest.AsSpan(0, 16)).ToLowerInvariant());
    }
    private static SocialMediaStager CreateStager(
        HttpMessageHandler handler, string root, Func<DateTimeOffset>? utcNow = null,
        SocialMediaStager.SocialMediaStagerTestHooks? testHooks = null) =>
        testHooks is null
            ? new(SocialCapabilityClientTests.CreateClient(handler), new LocalMediaResolver(new Store(), new Prompt()), root, utcNow)
            : new(SocialCapabilityClientTests.CreateClient(handler), new LocalMediaResolver(new Store(), new Prompt()), root, utcNow, testHooks);

    private static string CreateExpiredOwnedDirectory(string root, string name, DateTimeOffset now)
    {
        string directory = Path.Combine(root, name);
        Directory.CreateDirectory(directory);
        string marker = Path.Combine(directory, SocialMediaStager.MarkerName);
        string media = Path.Combine(directory, "0000-1.png");
        File.WriteAllText(marker, "creatorcrate-social-prep-v1");
        File.WriteAllText(media, "old");
        File.SetLastWriteTimeUtc(media, now.AddHours(-25).UtcDateTime);
        Directory.SetLastWriteTimeUtc(directory, now.AddHours(-25).UtcDateTime);
        return directory;
    }
    private sealed class Store : ITrustedMediaRootStore { public bool IsTrusted(SocialOrigin origin, string root) => false; public void Trust(SocialOrigin origin, string root) { } }
    private sealed class AlwaysTrustedStore : ITrustedMediaRootStore { public bool IsTrusted(SocialOrigin origin, string root) => true; public void Trust(SocialOrigin origin, string root) { } }
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
    private sealed class ExpiringHandler : HttpMessageHandler
    {
        public int Requests { get; private set; }
        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
        {
            Requests++;
            if (Requests == 1)
                return Task.FromResult(new HttpResponseMessage(HttpStatusCode.OK) { Content = new ByteArrayContent(Encoding.UTF8.GetBytes("abc")) });
            return Task.FromResult(new HttpResponseMessage(HttpStatusCode.Unauthorized)
            {
                Content = new StringContent("{\"ok\":false,\"error\":{\"code\":\"media_token_expired\",\"message\":\"expired\"}}", Encoding.UTF8, "application/json"),
            });
        }
    }

    private sealed class FailingRestageHandler : HttpMessageHandler
    {
        private int _requests;
        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
        {
            if (Interlocked.Increment(ref _requests) == 1)
                return Task.FromResult(new HttpResponseMessage(HttpStatusCode.OK) { Content = new ByteArrayContent(Encoding.UTF8.GetBytes("abc")) });
            throw new HttpRequestException("simulated download failure");
        }
    }

    private sealed class FailOnceRestageHandler : HttpMessageHandler
    {
        private int _requests;
        public int Requests => Volatile.Read(ref _requests);
        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
        {
            int requestNumber = Interlocked.Increment(ref _requests);
            if (requestNumber == 2) throw new HttpRequestException("simulated download failure");
            return Task.FromResult(new HttpResponseMessage(HttpStatusCode.OK) { Content = new ByteArrayContent(Encoding.UTF8.GetBytes("abc")) });
        }
    }

    private sealed class BlockingRestageHandler(string content, int initialRequests, int expectedBlockedRequests) : HttpMessageHandler
    {
        private int _requests;
        private int _blockedRequests;
        public int Requests => Volatile.Read(ref _requests);
        public TaskCompletionSource AllBlocked { get; } = new(TaskCreationOptions.RunContinuationsAsynchronously);
        public TaskCompletionSource Release { get; } = new(TaskCreationOptions.RunContinuationsAsynchronously);

        protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
        {
            int requestNumber = Interlocked.Increment(ref _requests);
            if (requestNumber > initialRequests)
            {
                if (Interlocked.Increment(ref _blockedRequests) == expectedBlockedRequests) AllBlocked.TrySetResult();
                await Release.Task.WaitAsync(cancellationToken);
            }
            return new HttpResponseMessage(HttpStatusCode.OK) { Content = new ByteArrayContent(Encoding.UTF8.GetBytes(content)) };
        }
    }

    private static int RunLeaseProbe(string marker)
    {
        var start = new ProcessStartInfo("powershell.exe")
        {
            UseShellExecute = false,
            CreateNoWindow = true,
        };
        start.Environment["CREATORCRATE_TEST_LEASE"] = marker;
        start.ArgumentList.Add("-NoProfile");
        start.ArgumentList.Add("-NonInteractive");
        start.ArgumentList.Add("-Command");
        start.ArgumentList.Add("try { $s = [IO.File]::Open($env:CREATORCRATE_TEST_LEASE, 'Open', 'ReadWrite', 'Delete'); $s.Dispose(); exit 0 } catch { exit 1 }");
        using Process process = Process.Start(start)!;
        Assert.True(process.WaitForExit(10_000));
        return process.ExitCode;
    }

    private static int RunIdentityReplacementProbe(string finalPath, string replacement)
    {
        var start = new ProcessStartInfo("powershell.exe")
        {
            UseShellExecute = false,
            CreateNoWindow = true,
        };
        start.Environment["CREATORCRATE_TEST_FINAL"] = finalPath;
        start.Environment["CREATORCRATE_TEST_REPLACEMENT"] = replacement;
        start.ArgumentList.Add("-NoProfile");
        start.ArgumentList.Add("-NonInteractive");
        start.ArgumentList.Add("-Command");
        start.ArgumentList.Add("try { $stale = $env:CREATORCRATE_TEST_FINAL + '.stale.partial'; Move-Item -LiteralPath $env:CREATORCRATE_TEST_FINAL -Destination $stale -ErrorAction Stop; [IO.File]::WriteAllText($env:CREATORCRATE_TEST_FINAL, $env:CREATORCRATE_TEST_REPLACEMENT); exit 0 } catch { exit 1 }");
        using Process process = Process.Start(start)!;
        Assert.True(process.WaitForExit(10_000));
        return process.ExitCode;
    }

    private static int RunMutationProbe(string operation, string marker, string directory)
    {
        var start = new ProcessStartInfo("powershell.exe")
        {
            UseShellExecute = false,
            CreateNoWindow = true,
        };
        start.Environment["CREATORCRATE_TEST_OPERATION"] = operation;
        start.Environment["CREATORCRATE_TEST_LEASE"] = marker;
        start.Environment["CREATORCRATE_TEST_DIRECTORY"] = directory;
        start.ArgumentList.Add("-NoProfile");
        start.ArgumentList.Add("-NonInteractive");
        start.ArgumentList.Add("-Command");
        start.ArgumentList.Add("try { switch ($env:CREATORCRATE_TEST_OPERATION) { 'delete' { Remove-Item -LiteralPath $env:CREATORCRATE_TEST_LEASE -Force -ErrorAction Stop } 'rename' { Rename-Item -LiteralPath $env:CREATORCRATE_TEST_LEASE -NewName 'replaced-marker' -ErrorAction Stop } 'replace' { Remove-Item -LiteralPath $env:CREATORCRATE_TEST_LEASE -Force -ErrorAction Stop; [IO.File]::WriteAllText($env:CREATORCRATE_TEST_LEASE, 'replacement') } 'cleanup' { Remove-Item -LiteralPath $env:CREATORCRATE_TEST_DIRECTORY -Recurse -Force -ErrorAction Stop } }; exit 0 } catch { exit 1 }");
        using Process process = Process.Start(start)!;
        Assert.True(process.WaitForExit(10_000));
        return process.ExitCode;
    }

    private static Process StartLeaseHolder(string marker)
    {
        var start = new ProcessStartInfo("powershell.exe")
        {
            UseShellExecute = false,
            CreateNoWindow = true,
            RedirectStandardOutput = true,
        };
        start.Environment["CREATORCRATE_TEST_LEASE"] = marker;
        start.ArgumentList.Add("-NoProfile");
        start.ArgumentList.Add("-NonInteractive");
        start.ArgumentList.Add("-Command");
        start.ArgumentList.Add("$s = [IO.File]::Open($env:CREATORCRATE_TEST_LEASE, 'Open', 'Read', 'Read'); [Console]::Out.WriteLine('ready'); [Console]::Out.Flush(); Wait-Event");
        return Process.Start(start)!;
    }

    private static void CreateDirectoryReparsePoint(string link, string target)
    {
        try
        {
            Directory.CreateSymbolicLink(link, target);
            return;
        }
        catch (IOException) when (OperatingSystem.IsWindows()) { }

        var start = new ProcessStartInfo("cmd.exe")
        {
            UseShellExecute = false,
            CreateNoWindow = true,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
        };
        start.ArgumentList.Add("/d");
        start.ArgumentList.Add("/c");
        start.ArgumentList.Add("mklink");
        start.ArgumentList.Add("/J");
        start.ArgumentList.Add(link);
        start.ArgumentList.Add(target);
        using Process process = Process.Start(start)!;
        Assert.True(process.WaitForExit(10_000));
        Assert.True(process.ExitCode == 0, process.StandardError.ReadToEnd());
    }

    private static void DeleteDirectoryReparsePoint(string link)
    {
        if (!OperatingSystem.IsWindows())
        {
            Directory.Delete(link);
            return;
        }

        var start = new ProcessStartInfo("cmd.exe")
        {
            UseShellExecute = false,
            CreateNoWindow = true,
            RedirectStandardError = true,
        };
        start.ArgumentList.Add("/d");
        start.ArgumentList.Add("/c");
        start.ArgumentList.Add("rmdir");
        start.ArgumentList.Add(link);
        using Process process = Process.Start(start)!;
        Assert.True(process.WaitForExit(10_000));
        Assert.True(process.ExitCode == 0, process.StandardError.ReadToEnd());
    }
}
