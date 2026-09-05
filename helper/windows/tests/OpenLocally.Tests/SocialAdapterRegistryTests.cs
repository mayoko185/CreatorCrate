using OpenLocally;

namespace OpenLocally.Tests;

public class SocialAdapterRegistryTests
{
    [Fact]
    public void EmptyProductionRegistry_HasNoCoverage()
    {
        var registry = new SocialAdapterRegistry();

        Assert.False(registry.Supports("patreon"));
        Assert.False(registry.HasCompleteFrozenCoverage());
    }

    [Fact]
    public void Registry_AcceptsAllFrozenPlatformsExactlyOnce()
    {
        var registry = new SocialAdapterRegistry([new Adapter("patreon"), new Adapter("x"), new Adapter("bluesky")]);

        Assert.True(registry.HasCompleteFrozenCoverage());
        Assert.True(registry.Supports("x"));
        Assert.False(registry.Supports("mastodon"));
        Assert.Throws<InvalidOperationException>(() => registry.Register(new Adapter("x")));
        Assert.Throws<ArgumentException>(() => registry.Register(new Adapter("unknown")));
    }

    private sealed class Adapter(string platform) : ISocialPreparationAdapter
    {
        public string Platform { get; } = platform;
        public Task<PlatformPreparationResult> PrepareAsync(PlatformPreparationContext context, IPreparationProgress progress, CancellationToken cancellationToken) => Task.FromResult(PlatformPreparationResult.Prepared());
    }
}
