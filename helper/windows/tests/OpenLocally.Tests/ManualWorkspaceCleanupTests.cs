using OpenLocally.Tests.Manual;

namespace OpenLocally.Tests;

public sealed class ManualWorkspaceCleanupTests
{
    [Fact]
    public void TransientLock_RetriesThenDeletesOwnedWorkspace()
    {
        const string workspace = @"C:\Temp\CreatorCrate-m2-manual-owned";
        DateTimeOffset now = DateTimeOffset.UnixEpoch;
        bool exists = true;
        int deletes = 0;
        var delays = new List<TimeSpan>();

        ManualWorkspaceCleanupResult result = ManualWorkspaceCleanup.DeleteWithRetry(
            workspace,
            _ => exists,
            path =>
            {
                Assert.Equal(workspace, path);
                deletes++;
                if (deletes == 1) throw new UnauthorizedAccessException("locked");
                exists = false;
            },
            ManualWorkspaceCleanup.IsTransientLock,
            delay =>
            {
                delays.Add(delay);
                now += delay;
            },
            () => now);

        Assert.True(result.Succeeded);
        Assert.Null(result.Error);
        Assert.Equal(2, result.Attempts);
        Assert.Equal(2, deletes);
        Assert.Equal([ManualWorkspaceCleanup.RetryDelay], delays);
        Assert.False(exists);
    }

    [Fact]
    public void PermanentLock_ExpiresBoundAndRetainsWorkspace()
    {
        const string workspace = @"C:\Temp\CreatorCrate-m2-manual-owned";
        DateTimeOffset now = DateTimeOffset.UnixEpoch;
        bool exists = true;
        int deletes = 0;

        ManualWorkspaceCleanupResult result = ManualWorkspaceCleanup.DeleteWithRetry(
            workspace,
            _ => exists,
            _ =>
            {
                deletes++;
                throw new IOException("locked");
            },
            ManualWorkspaceCleanup.IsTransientLock,
            delay => now += delay,
            () => now);

        Assert.False(result.Succeeded);
        Assert.IsType<IOException>(result.Error);
        Assert.Equal(1 + (int)(ManualWorkspaceCleanup.RetryWindow / ManualWorkspaceCleanup.RetryDelay), result.Attempts);
        Assert.Equal(result.Attempts, deletes);
        Assert.True(exists);
    }

    [Fact]
    public void ParentOwnership_DeletesOnlyWorkspaceAndNeverNestedOrSiblingPaths()
    {
        const string workspace = @"C:\Temp\CreatorCrate-m2-manual-owned";
        const string nestedArtifacts = workspace + @"\test-artifacts";
        const string sibling = @"C:\Temp\CreatorCrate-m2-manual-unrelated";
        bool exists = true;
        var deleted = new List<string>();

        ManualWorkspaceCleanupResult result = ManualWorkspaceCleanup.DeleteWithRetry(
            workspace,
            _ => exists,
            path =>
            {
                deleted.Add(path);
                exists = false;
            },
            ManualWorkspaceCleanup.IsTransientLock,
            _ => throw new InvalidOperationException("No delay is expected."),
            () => DateTimeOffset.UnixEpoch);

        Assert.True(result.Succeeded);
        Assert.Equal([workspace], deleted);
        Assert.DoesNotContain(nestedArtifacts, deleted);
        Assert.DoesNotContain(sibling, deleted);
    }
}
