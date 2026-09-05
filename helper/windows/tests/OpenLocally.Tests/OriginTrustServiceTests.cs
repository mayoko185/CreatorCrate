using System.Net;
using OpenLocally;

namespace OpenLocally.Tests;

public class OriginTrustServiceTests
{
    [Fact]
    public async Task Deny_DoesNotResolveOrPersist()
    {
        SocialOrigin origin = Origin("http://lan.test");
        var store = new Store();
        var resolver = new Resolver(IPAddress.Parse("192.168.1.10"));
        var service = new OriginTrustService(store, new Prompt(false), resolver);

        OriginTrustResult result = await service.AuthorizeAsync(origin, CancellationToken.None);

        Assert.False(result.Allowed);
        Assert.Equal("server_origin_denied", result.ErrorCode);
        Assert.Equal(0, resolver.Calls);
        Assert.Empty(store.Trusted);
    }

    [Fact]
    public async Task Allow_PersistsOnlyAfterPrivateTransportPasses_AndRepeatSkipsPrompt()
    {
        SocialOrigin origin = Origin("http://lan.test");
        var store = new Store();
        var prompt = new Prompt(true);
        var resolver = new Resolver(IPAddress.Parse("192.168.1.10"));
        var service = new OriginTrustService(store, prompt, resolver);

        Assert.True((await service.AuthorizeAsync(origin, CancellationToken.None)).Allowed);
        Assert.Contains(origin.Identity, store.Trusted);
        Assert.True((await service.AuthorizeAsync(origin, CancellationToken.None)).Allowed);
        Assert.Equal(1, prompt.Calls);
    }

    [Fact]
    public async Task PublicOrMixedDns_IsRejectedAndNeverTrusted()
    {
        SocialOrigin origin = Origin("http://lan.test");
        var store = new Store();
        var service = new OriginTrustService(store, new Prompt(true), new Resolver(IPAddress.Parse("192.168.1.10"), IPAddress.Parse("8.8.8.8")));

        OriginTrustResult result = await service.AuthorizeAsync(origin, CancellationToken.None);

        Assert.Equal("insecure_origin_disallowed", result.ErrorCode);
        Assert.Empty(store.Trusted);
    }

    private static SocialOrigin Origin(string value) { Assert.True(SocialOrigin.TryParse(value, out SocialOrigin? origin)); return origin!; }
    private sealed class Store : ITrustedOriginStore
    {
        public HashSet<string> Trusted { get; } = new(StringComparer.Ordinal);
        public bool IsTrusted(SocialOrigin origin) => Trusted.Contains(origin.Identity);
        public void Trust(SocialOrigin origin) => Trusted.Add(origin.Identity);
    }
    private sealed class Prompt(bool value) : IOriginTrustPrompt
    {
        public int Calls { get; private set; }
        public bool ConfirmTrust(SocialOrigin origin) { Calls++; return value; }
    }
    private sealed class Resolver(params IPAddress[] addresses) : IOriginAddressResolver
    {
        public int Calls { get; private set; }
        public Task<IReadOnlyList<IPAddress>> ResolveAsync(string host, CancellationToken cancellationToken) { Calls++; return Task.FromResult<IReadOnlyList<IPAddress>>(addresses); }
    }
}
