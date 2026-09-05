namespace OpenLocally.Tests.Manual;

/// <summary>Test-only exact-tree snapshot model used to prove the manual wrapper's narrow restoration contract.</summary>
internal sealed record ManualRegistrySnapshot(
    bool Captured,
    bool Exists,
    IReadOnlyDictionary<string, string> Values,
    IReadOnlyDictionary<string, ManualRegistrySnapshot> Children)
{
    internal static ManualRegistrySnapshot Capture(IManualRegistryTree store, string path)
    {
        if (!store.Exists(path))
            return new ManualRegistrySnapshot(true, false, new Dictionary<string, string>(), new Dictionary<string, ManualRegistrySnapshot>());

        var children = new Dictionary<string, ManualRegistrySnapshot>(StringComparer.OrdinalIgnoreCase);
        foreach (string child in store.GetChildren(path))
            children[child] = Capture(store, path + "\\" + child);

        return new ManualRegistrySnapshot(
            true,
            true,
            new Dictionary<string, string>(store.GetValues(path), StringComparer.Ordinal),
            children);
    }

    internal static ManualRegistrySnapshot Uncaptured() =>
        new(false, false, new Dictionary<string, string>(), new Dictionary<string, ManualRegistrySnapshot>());

    internal void Restore(IManualRegistryTree store, string path)
    {
        if (!Captured)
            throw new InvalidOperationException($"Registry snapshot for '{path}' was not captured; the live key must remain untouched.");

        store.DeleteTree(path);
        if (!Exists) return;

        store.Create(path);
        foreach ((string name, string value) in Values)
            store.SetValue(path, name, value);
        foreach ((string name, ManualRegistrySnapshot child) in Children)
            child.Restore(store, path + "\\" + name);
    }
}

internal interface IManualRegistryTree
{
    bool Exists(string path);
    IReadOnlyDictionary<string, string> GetValues(string path);
    IReadOnlyList<string> GetChildren(string path);
    void Create(string path);
    void SetValue(string path, string name, string value);
    void DeleteTree(string path);
}
