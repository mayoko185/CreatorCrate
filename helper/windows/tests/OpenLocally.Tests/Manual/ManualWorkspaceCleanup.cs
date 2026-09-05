namespace OpenLocally.Tests.Manual;

/// <summary>
/// Bounded deletion policy for the Manual wrapper's uniquely-owned temporary
/// workspace. The PowerShell wrapper uses the same eight-second, 200ms policy;
/// this seam makes lock/retry behavior deterministic to test without VSTest
/// locks or a live Manual run.
/// </summary>
internal static class ManualWorkspaceCleanup
{
    internal static readonly TimeSpan RetryWindow = TimeSpan.FromSeconds(8);
    internal static readonly TimeSpan RetryDelay = TimeSpan.FromMilliseconds(200);

    internal static ManualWorkspaceCleanupResult DeleteWithRetry(
        string workspace,
        Func<string, bool> exists,
        Action<string> delete,
        Func<Exception, bool> isTransientLock,
        Action<TimeSpan> delay,
        Func<DateTimeOffset> utcNow)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(workspace);
        ArgumentNullException.ThrowIfNull(exists);
        ArgumentNullException.ThrowIfNull(delete);
        ArgumentNullException.ThrowIfNull(isTransientLock);
        ArgumentNullException.ThrowIfNull(delay);
        ArgumentNullException.ThrowIfNull(utcNow);

        DateTimeOffset deadline = utcNow() + RetryWindow;
        int attempts = 0;

        while (true)
        {
            if (!exists(workspace)) return ManualWorkspaceCleanupResult.Success(attempts);

            attempts++;
            try
            {
                delete(workspace);
                return ManualWorkspaceCleanupResult.Success(attempts);
            }
            catch (Exception error) when (isTransientLock(error) && utcNow() < deadline)
            {
                delay(RetryDelay);
            }
            catch (Exception error)
            {
                return ManualWorkspaceCleanupResult.Failed(attempts, error);
            }
        }
    }

    internal static bool IsTransientLock(Exception error) =>
        error is IOException or UnauthorizedAccessException;
}

internal sealed record ManualWorkspaceCleanupResult(bool Succeeded, int Attempts, Exception? Error)
{
    internal static ManualWorkspaceCleanupResult Success(int attempts) => new(true, attempts, null);

    internal static ManualWorkspaceCleanupResult Failed(int attempts, Exception error) => new(false, attempts, error);
}
