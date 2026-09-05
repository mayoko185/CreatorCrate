using System.Net;
using System.Net.Http;
using System.Text;
using OpenLocally;
using OpenLocally.Tests.Manual;

namespace OpenLocally.Tests;

public sealed class ManualHarnessSafetyTests
{
    [Fact]
    public void RegistrySnapshot_RestoresPresentAndAbsentKeysExactly()
    {
        var store = new RegistryTree();
        store.Create("root\\present");
        store.SetValue("root\\present", string.Empty, "before");
        store.Create("root\\present\\child");
        store.SetValue("root\\present\\child", "value", "nested");
        ManualRegistrySnapshot present = ManualRegistrySnapshot.Capture(store, "root\\present");
        ManualRegistrySnapshot absent = ManualRegistrySnapshot.Capture(store, "root\\absent");

        store.SetValue("root\\present", string.Empty, "changed");
        store.Create("root\\present\\extra");
        store.Create("root\\absent");
        present.Restore(store, "root\\present");
        absent.Restore(store, "root\\absent");

        Assert.Equal("before", store.GetValues("root\\present")[string.Empty]);
        Assert.Equal("nested", store.GetValues("root\\present\\child")["value"]);
        Assert.DoesNotContain("extra", store.GetChildren("root\\present"));
        Assert.False(store.Exists("root\\absent"));
    }

    [Fact]
    public async Task Fixture_RecordsExactRoutesBodyAndBearerWithoutUrlToken()
    {
        await using var fixture = await InProcessCreatorCrateFixture.StartAsync();
        using var client = new HttpClient();
        using HttpResponseMessage redeem = await client.PostAsync(new Uri(fixture.Origin, "/social-prep/redeem"), new StringContent($"{{\"intent\":\"{InProcessCreatorCrateFixture.MediaToken}\"}}", Encoding.UTF8, "application/json"));
        using var assetRequest = new HttpRequestMessage(HttpMethod.Get, new Uri(fixture.Origin, $"/social-prep/{InProcessCreatorCrateFixture.SessionId}/assets/1"));
        assetRequest.Headers.Authorization = new System.Net.Http.Headers.AuthenticationHeaderValue("Bearer", InProcessCreatorCrateFixture.MediaToken);
        using HttpResponseMessage asset = await client.SendAsync(assetRequest);

        Assert.True(redeem.IsSuccessStatusCode);
        Assert.True(asset.IsSuccessStatusCode);
        Assert.Equal(2, fixture.RequestCount);
        Assert.Equal(new[] { "POST", "GET" }, fixture.Requests.Select(request => request.Method));
        Assert.True(fixture.Requests[0].IsRedeemIntentBody);
        Assert.True(fixture.Requests[1].HasBearerAuthorization);
        Assert.All(fixture.Requests, request => Assert.False(request.TokenInUrl));
    }

    [Fact]
    public async Task Fixture_RejectsBearerInQuery()
    {
        await using var fixture = await InProcessCreatorCrateFixture.StartAsync();
        using var client = new HttpClient();
        using HttpResponseMessage response = await client.GetAsync(new Uri(fixture.Origin, $"/social-prep/{InProcessCreatorCrateFixture.SessionId}/assets/1?token={InProcessCreatorCrateFixture.MediaToken}"));

        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
        Assert.Single(fixture.Requests);
        Assert.True(fixture.Requests[0].TokenInUrl);
    }

    [Fact]
    public async Task TlsFixture_MapsNormalCertificateRejectionWithoutValidationBypass()
    {
        await using var fixture = await InProcessTlsFixture.StartAsync();
        var resolver = new LoopbackResolver();
        var client = new SocialRedeemClient(new SocialHttpClient(resolver), new OriginTrustService(new OriginStore(), new AllowPrompt(), resolver));
        SocialRedeemResult result = await client.RedeemAsync(SocialOrigin.Parse(fixture.Origin), InProcessCreatorCrateFixture.MediaToken, CancellationToken.None);
        Assert.Equal("tls_validation_failed", result.ErrorCode);
    }

    private sealed class RegistryTree : IManualRegistryTree
    {
        private readonly Dictionary<string, Dictionary<string, string>> _keys = new(StringComparer.OrdinalIgnoreCase);
        public bool Exists(string path) => _keys.ContainsKey(path);
        public IReadOnlyDictionary<string, string> GetValues(string path) => _keys[path];
        public IReadOnlyList<string> GetChildren(string path) => _keys.Keys
            .Where(key => key.StartsWith(path + "\\", StringComparison.OrdinalIgnoreCase))
            .Select(key => key[(path.Length + 1)..])
            .Where(suffix => !suffix.Contains('\\'))
            .ToArray();
        public void Create(string path) => _keys.TryAdd(path, new Dictionary<string, string>(StringComparer.Ordinal));
        public void SetValue(string path, string name, string value) => _keys[path][name] = value;
        public void DeleteTree(string path)
        {
            foreach (string key in _keys.Keys.Where(key => key == path || key.StartsWith(path + "\\", StringComparison.OrdinalIgnoreCase)).ToArray()) _keys.Remove(key);
        }
    }

    private sealed class OriginStore : ITrustedOriginStore { public bool IsTrusted(SocialOrigin origin) => false; public void Trust(SocialOrigin origin) { } }
    private sealed class AllowPrompt : IOriginTrustPrompt { public bool ConfirmTrust(SocialOrigin origin) => true; }
    private sealed class LoopbackResolver : IOriginAddressResolver { public Task<IReadOnlyList<IPAddress>> ResolveAsync(string host, CancellationToken cancellationToken) => Task.FromResult<IReadOnlyList<IPAddress>>(new[] { IPAddress.Loopback }); }
}
