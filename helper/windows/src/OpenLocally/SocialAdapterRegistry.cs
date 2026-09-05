namespace OpenLocally;

/// <summary>Exact registry for the frozen Milestone 2 platform vocabulary.</summary>
public sealed class SocialAdapterRegistry
{
    public static readonly IReadOnlyList<string> FrozenPlatforms = ["patreon", "x", "bluesky"];
    private readonly Dictionary<string, ISocialPreparationAdapter> _adapters = new(StringComparer.Ordinal);

    public SocialAdapterRegistry(IEnumerable<ISocialPreparationAdapter>? adapters = null)
    {
        if (adapters is null) return;
        foreach (ISocialPreparationAdapter adapter in adapters) Register(adapter);
    }

    public void Register(ISocialPreparationAdapter adapter)
    {
        ArgumentNullException.ThrowIfNull(adapter);
        if (!FrozenPlatforms.Contains(adapter.Platform, StringComparer.Ordinal))
            throw new ArgumentException("The adapter platform is not supported by this helper.", nameof(adapter));
        if (!_adapters.TryAdd(adapter.Platform, adapter))
            throw new InvalidOperationException("Only one adapter may be registered for each platform.");
    }

    public bool Supports(string platform) => !string.IsNullOrWhiteSpace(platform) && _adapters.ContainsKey(platform);

    public bool HasCompleteFrozenCoverage() => FrozenPlatforms.All(Supports);

    public ISocialPreparationAdapter GetRequired(string platform) =>
        _adapters.TryGetValue(platform, out ISocialPreparationAdapter? adapter)
            ? adapter
            : throw new InvalidOperationException("No adapter is registered for this platform.");
}
