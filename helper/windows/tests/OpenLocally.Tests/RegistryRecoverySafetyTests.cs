using OpenLocally.Tests.Manual;

namespace OpenLocally.Tests;

public sealed class RegistryRecoverySafetyTests
{
    private static readonly string[] Roots =
    [
        @"HKCU:\Software\Classes\creatorcrate-open",
        @"HKCU:\Software\Classes\creatorcrate-social",
        @"HKCU:\Software\CreatorCrate\SocialPreparation\TrustedOrigins",
        @"HKCU:\Software\CreatorCrate\SocialPreparation\TrustedMediaRoots",
    ];

    [Fact]
    public void CompletePreflight_RestoresFourRootsExactlyIncludingCapturedAbsence()
    {
        var store = new RegistryTree();
        Seed(store, Roots[0], "open-before");
        Seed(store, Roots[2], "origins-before");
        ManualRegistryPreflight preflight = ManualRegistryPreflight.Capture(store, Roots);

        MutateEveryRoot(store);
        int environmentRestores = 0;
        int cleanups = 0;
        ManualRecoveryResult result = Restore(store, preflight, () => environmentRestores++, () => cleanups++);

        Assert.True(preflight.Completed);
        Assert.True(result.Succeeded);
        Assert.Equal(Roots, result.RegistryAttemptedPaths);
        AssertRootValue(store, Roots[0], "open-before");
        AssertRootValue(store, Roots[2], "origins-before");
        Assert.False(store.Exists(Roots[1]));
        Assert.False(store.Exists(Roots[3]));
        Assert.Equal(1, environmentRestores);
        Assert.Equal(1, cleanups);
    }

    [Fact]
    public void SnapshotFailure_AbortsBeforeMutationAndDoesNotRestorePartialSnapshots()
    {
        var store = new RegistryTree();
        Seed(store, Roots[0], "before");
        Seed(store, Roots[1], "before");
        store.ThrowOnGetValues.Add(Roots[1]);
        ManualRegistryPreflight preflight = ManualRegistryPreflight.Capture(store, Roots);
        store.ThrowOnGetValues.Clear();

        int environmentRestores = 0;
        int cleanups = 0;
        ManualRecoveryResult result = Restore(store, preflight, () => environmentRestores++, () => cleanups++);

        Assert.False(preflight.Completed);
        Assert.Empty(result.RegistryAttemptedPaths);
        Assert.Empty(store.DeleteAttempts);
        AssertRootValue(store, Roots[0], "before");
        AssertRootValue(store, Roots[1], "before");
        Assert.Equal(1, environmentRestores);
        Assert.Equal(1, cleanups);
    }

    [Fact]
    public void MissingSnapshot_LeavesLiveKeyUntouchedAndReportsRecoveryFailure()
    {
        var store = new RegistryTree();
        Seed(store, Roots[0], "live");
        var snapshots = new Dictionary<string, ManualRegistrySnapshot?>(StringComparer.OrdinalIgnoreCase)
        {
            [Roots[0]] = null,
        };

        ManualRecoveryResult result = ManualRegistryRecovery.Restore(
            snapshotPreflightCompleted: true,
            store,
            [Roots[0]],
            snapshots,
            new HashSet<string>(Roots, StringComparer.OrdinalIgnoreCase),
            () => { },
            () => { },
            Roots[0]);

        Assert.Single(result.RegistryAttemptedPaths);
        ManualRecoveryFailure failure = Assert.Single(result.Failures);
        Assert.Equal(Roots[0], failure.Target);
        Assert.Null(failure.OriginallyExisted);
        Assert.Contains("left untouched", failure.Detail, StringComparison.Ordinal);
        AssertRootValue(store, Roots[0], "live");
        Assert.Empty(store.DeleteAttempts);
    }

    [Fact]
    public void FirstRestoreFailure_DoesNotPreventLaterRootsFromRestoring()
    {
        var store = new RegistryTree();
        foreach (string root in Roots) Seed(store, root, root + "-before");
        ManualRegistryPreflight preflight = ManualRegistryPreflight.Capture(store, Roots);

        MutateEveryRoot(store);
        store.ThrowOnDelete.Add(Roots[0]);
        ManualRecoveryResult result = Restore(store, preflight, () => { }, () => { });

        Assert.Equal(Roots, result.RegistryAttemptedPaths);
        Assert.Single(result.Failures);
        Assert.Equal(Roots[0], result.Failures[0].Target);
        AssertRootValue(store, Roots[1], Roots[1] + "-before");
        AssertRootValue(store, Roots[2], Roots[2] + "-before");
        AssertRootValue(store, Roots[3], Roots[3] + "-before");
    }

    [Fact]
    public void RegistryFailure_StillRestoresExactEnvironmentState()
    {
        var store = new RegistryTree();
        Seed(store, Roots[0], "before");
        ManualRegistryPreflight preflight = ManualRegistryPreflight.Capture(store, [Roots[0]]);
        store.ThrowOnDelete.Add(Roots[0]);

        var environment = new ManualEnvironment();
        environment.Set("CREATORCRATE_M2_MANUAL", "before");
        ManualEnvironmentSnapshot original = ManualEnvironmentSnapshot.Capture(environment, "CREATORCRATE_M2_MANUAL");
        environment.Set("CREATORCRATE_M2_MANUAL", "1");
        environment.Set("CREATORCRATE_M2_HELPER_EXE", "temporary.exe");
        ManualEnvironmentSnapshot absent = ManualEnvironmentSnapshot.Capture(new ManualEnvironment(), "CREATORCRATE_M2_HELPER_EXE");

        ManualRecoveryResult result = Restore(
            store,
            preflight,
            () =>
            {
                original.Restore(environment, "CREATORCRATE_M2_MANUAL");
                absent.Restore(environment, "CREATORCRATE_M2_HELPER_EXE");
            },
            () => { },
            [Roots[0]]);

        Assert.Contains(result.Failures, failure => failure.Phase == "registry");
        Assert.Equal("before", environment.Get("CREATORCRATE_M2_MANUAL"));
        Assert.False(environment.Exists("CREATORCRATE_M2_HELPER_EXE"));
    }

    [Fact]
    public void MultipleFailures_AggregateAfterAllRegistryEnvironmentAndCleanupAttempts()
    {
        var store = new RegistryTree();
        foreach (string root in Roots) Seed(store, root, "before");
        ManualRegistryPreflight preflight = ManualRegistryPreflight.Capture(store, Roots);
        MutateEveryRoot(store);
        store.ThrowOnDelete.Add(Roots[0]);
        store.ThrowOnDelete.Add(Roots[2]);

        bool environmentAttempted = false;
        bool cleanupAttempted = false;
        ManualRecoveryResult result = Restore(
            store,
            preflight,
            () =>
            {
                environmentAttempted = true;
                throw new InvalidOperationException("environment failure");
            },
            () =>
            {
                cleanupAttempted = true;
                throw new InvalidOperationException("cleanup failure");
            });

        Assert.Equal(Roots, result.RegistryAttemptedPaths);
        Assert.True(environmentAttempted);
        Assert.True(cleanupAttempted);
        Assert.Equal(4, result.Failures.Count);
        Assert.Contains(result.Failures, failure => failure.Target == Roots[0]);
        Assert.Contains(result.Failures, failure => failure.Target == Roots[2]);
        Assert.Contains(result.Failures, failure => failure.Phase == "environment");
        Assert.Contains(result.Failures, failure => failure.Phase == "cleanup");
    }

    [Fact]
    public void OpenLocallyCommandMismatch_IsReportedAfterRestoration()
    {
        var store = new RegistryTree();
        Seed(store, Roots[0], "before-command");
        ManualRegistryPreflight preflight = ManualRegistryPreflight.Capture(store, [Roots[0]]);
        Seed(store, Roots[0], "changed-command");

        ManualRecoveryResult result = Restore(
            store,
            preflight,
            () => { },
            () => { },
            [Roots[0]],
            matchesSnapshot: (_, _) => false);

        ManualRecoveryFailure failure = Assert.Single(result.Failures);
        Assert.Equal(Roots[0], failure.Target);
        Assert.Contains("Open Locally command/value tree", failure.Detail, StringComparison.Ordinal);
        AssertRootValue(store, Roots[0], "before-command");
    }

    [Fact]
    public void CapturedAbsentKey_IsRemovedAfterManualMutation()
    {
        var store = new RegistryTree();
        ManualRegistryPreflight preflight = ManualRegistryPreflight.Capture(store, [Roots[3]]);
        Seed(store, Roots[3], "manual-created");

        ManualRecoveryResult result = Restore(store, preflight, () => { }, () => { }, [Roots[3]]);

        Assert.True(result.Succeeded);
        Assert.False(store.Exists(Roots[3]));
        Assert.Contains(Roots[3], store.DeleteAttempts);
    }

    private static ManualRecoveryResult Restore(
        RegistryTree store,
        ManualRegistryPreflight preflight,
        Action restoreEnvironment,
        Action cleanup,
        IReadOnlyList<string>? paths = null,
        Func<string, ManualRegistrySnapshot, bool>? matchesSnapshot = null)
    {
        IReadOnlyList<string> recoveryPaths = paths ?? Roots;
        var snapshots = recoveryPaths.ToDictionary(
            path => path,
            path => preflight.Snapshots.TryGetValue(path, out ManualRegistrySnapshot? snapshot) ? snapshot : null,
            StringComparer.OrdinalIgnoreCase);

        return ManualRegistryRecovery.Restore(
            preflight.Completed,
            store,
            recoveryPaths,
            snapshots,
            new HashSet<string>(recoveryPaths, StringComparer.OrdinalIgnoreCase),
            restoreEnvironment,
            cleanup,
            Roots[0],
            matchesSnapshot);
    }

    private static void MutateEveryRoot(RegistryTree store)
    {
        foreach (string root in Roots)
        {
            store.Create(root);
            store.SetValue(root, "state", "mutated");
            store.Create(root + @"\unexpected-child");
            store.SetValue(root + @"\unexpected-child", "state", "mutated");
        }
    }

    private static void Seed(RegistryTree store, string root, string value)
    {
        store.Create(root);
        store.SetValue(root, "state", value);
        store.Create(root + @"\child");
        store.SetValue(root + @"\child", "state", value + "-child");
    }

    private static void AssertRootValue(RegistryTree store, string root, string expected)
    {
        Assert.True(store.Exists(root));
        Assert.Equal(expected, store.GetValues(root)["state"]);
        Assert.Equal(expected + "-child", store.GetValues(root + @"\child")["state"]);
        Assert.DoesNotContain("unexpected-child", store.GetChildren(root));
    }

    private sealed class RegistryTree : IManualRegistryTree
    {
        private readonly Dictionary<string, Dictionary<string, string>> _keys = new(StringComparer.OrdinalIgnoreCase);

        internal HashSet<string> ThrowOnGetValues { get; } = new(StringComparer.OrdinalIgnoreCase);
        internal HashSet<string> ThrowOnDelete { get; } = new(StringComparer.OrdinalIgnoreCase);
        internal List<string> DeleteAttempts { get; } = [];

        public bool Exists(string path) => _keys.ContainsKey(path);

        public IReadOnlyDictionary<string, string> GetValues(string path)
        {
            if (ThrowOnGetValues.Contains(path))
                throw new InvalidOperationException("snapshot read failure");
            return _keys[path];
        }

        public IReadOnlyList<string> GetChildren(string path) => _keys.Keys
            .Where(key => key.StartsWith(path + "\\", StringComparison.OrdinalIgnoreCase))
            .Select(key => key[(path.Length + 1)..])
            .Where(suffix => !suffix.Contains('\\'))
            .ToArray();

        public void Create(string path) => _keys.TryAdd(path, new Dictionary<string, string>(StringComparer.Ordinal));

        public void SetValue(string path, string name, string value) => _keys[path][name] = value;

        public void DeleteTree(string path)
        {
            DeleteAttempts.Add(path);
            if (ThrowOnDelete.Contains(path))
                throw new InvalidOperationException("restore delete failure");

            foreach (string key in _keys.Keys
                         .Where(key => key == path || key.StartsWith(path + "\\", StringComparison.OrdinalIgnoreCase))
                         .ToArray())
            {
                _keys.Remove(key);
            }
        }
    }

    private sealed class ManualEnvironment : IManualEnvironment
    {
        private readonly Dictionary<string, string?> _values = new(StringComparer.Ordinal);

        public bool Exists(string name) => _values.ContainsKey(name);
        public string? Get(string name) => _values[name];
        public void Set(string name, string? value) => _values[name] = value;
        public void Remove(string name) => _values.Remove(name);
    }
}
