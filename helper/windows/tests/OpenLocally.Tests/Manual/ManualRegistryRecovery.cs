namespace OpenLocally.Tests.Manual;

/// <summary>
/// Test-side transactional model for the Manual wrapper: a complete preflight
/// is required before mutation, and recovery attempts every independent phase.
/// </summary>
internal sealed record ManualRegistryPreflight(
    bool Completed,
    IReadOnlyDictionary<string, ManualRegistrySnapshot> Snapshots,
    string? Failure)
{
    internal static ManualRegistryPreflight Capture(IManualRegistryTree store, IReadOnlyList<string> paths)
    {
        var snapshots = new Dictionary<string, ManualRegistrySnapshot>(StringComparer.OrdinalIgnoreCase);
        foreach (string path in paths)
        {
            try
            {
                snapshots.Add(path, ManualRegistrySnapshot.Capture(store, path));
            }
            catch (Exception exception)
            {
                return new ManualRegistryPreflight(false, snapshots, exception.Message);
            }
        }

        return new ManualRegistryPreflight(true, snapshots, null);
    }
}

internal sealed record ManualEnvironmentSnapshot(bool Exists, string? Value)
{
    internal static ManualEnvironmentSnapshot Capture(IManualEnvironment environment, string name) =>
        environment.Exists(name)
            ? new ManualEnvironmentSnapshot(true, environment.Get(name))
            : new ManualEnvironmentSnapshot(false, null);

    internal void Restore(IManualEnvironment environment, string name)
    {
        if (Exists) environment.Set(name, Value);
        else environment.Remove(name);
    }
}

internal interface IManualEnvironment
{
    bool Exists(string name);
    string? Get(string name);
    void Set(string name, string? value);
    void Remove(string name);
}

internal sealed record ManualRecoveryFailure(
    string Phase,
    string Target,
    bool? OriginallyExisted,
    string Detail);

internal sealed class ManualRecoveryResult
{
    internal List<string> RegistryAttemptedPaths { get; } = [];
    internal List<ManualRecoveryFailure> Failures { get; } = [];
    internal bool Succeeded => Failures.Count == 0;
}

/// <summary>Runs each recovery phase independently so no failure can skip a later restore or cleanup.</summary>
internal static class ManualRegistryRecovery
{
    internal static ManualRecoveryResult Restore(
        bool snapshotPreflightCompleted,
        IManualRegistryTree store,
        IReadOnlyList<string> registryPaths,
        IReadOnlyDictionary<string, ManualRegistrySnapshot?> snapshots,
        IReadOnlySet<string> mutationExposedRoots,
        Action restoreEnvironment,
        Action cleanup,
        string openLocallyPath,
        Func<string, ManualRegistrySnapshot, bool>? matchesSnapshot = null)
    {
        var result = new ManualRecoveryResult();

        if (snapshotPreflightCompleted)
        {
            foreach (string path in registryPaths)
            {
                if (!mutationExposedRoots.Contains(path)) continue;

                result.RegistryAttemptedPaths.Add(path);
                snapshots.TryGetValue(path, out ManualRegistrySnapshot? snapshot);
                if (snapshot is not { Captured: true })
                {
                    result.Failures.Add(new ManualRecoveryFailure(
                        "registry",
                        path,
                        null,
                        "No complete pre-run snapshot is available; the live key was left untouched."));
                    continue;
                }

                try
                {
                    snapshot.Restore(store, path);
                    if (path.Equals(openLocallyPath, StringComparison.OrdinalIgnoreCase) &&
                        matchesSnapshot is not null &&
                        !matchesSnapshot(path, snapshot))
                    {
                        throw new InvalidOperationException("The restored Open Locally command/value tree does not match its captured pre-run state.");
                    }
                }
                catch (Exception exception)
                {
                    result.Failures.Add(new ManualRecoveryFailure(
                        "registry",
                        path,
                        snapshot.Exists,
                        exception.Message));
                }
            }
        }

        TryPhase(result, "environment", "Manual environment", restoreEnvironment);
        TryPhase(result, "cleanup", "Manual workspace", cleanup);
        return result;
    }

    private static void TryPhase(ManualRecoveryResult result, string phase, string target, Action action)
    {
        try
        {
            action();
        }
        catch (Exception exception)
        {
            result.Failures.Add(new ManualRecoveryFailure(phase, target, null, exception.Message));
        }
    }
}
