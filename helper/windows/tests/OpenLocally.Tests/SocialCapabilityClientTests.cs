using System.Net;
using System.Text;
using OpenLocally;

namespace OpenLocally.Tests;

public class SocialCapabilityClientTests
{
    private const string Token = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    private static readonly SocialCapability Capability = new("00000000-0000-0000-0000-000000000001", Token);

    [Fact]
    public async Task Status_UsesBearerHeaderAndStrictResponse()
    {
        var handler = new CaptureHandler(_ => Json(HttpStatusCode.OK, StatusJson));
        var client = CreateClient(handler);

        SocialStatusResult result = await client.GetStatusAsync(Origin(), Capability, CancellationToken.None);

        Assert.True(result.Success);
        Assert.Equal("/social-prep/00000000-0000-0000-0000-000000000001/status", handler.Path);
        Assert.Equal($"Bearer {Token}", handler.Authorization);
        Assert.DoesNotContain(Token, result.ErrorCode ?? string.Empty);
        Assert.Equal(new[] { "x", "patreon" }, result.Status!.Platforms.Select(x => x.Platform));
    }

    [Fact]
    public async Task Patch_UsesExactMethodPathAndBody()
    {
        var handler = new CaptureHandler(_ => Json(HttpStatusCode.OK, "{\"ok\":true,\"sessionId\":\"00000000-0000-0000-0000-000000000001\",\"platform\":{\"platform\":\"x\",\"status\":\"prepared\",\"detailCode\":null,\"attempts\":1,\"preparedAt\":\"2026-01-01 12:00:00\"}}"));
        var client = CreateClient(handler);

        SocialPlatformStatusResult result = await client.PatchPlatformStatusAsync(Origin(), Capability, "x", "preparing", null, null, CancellationToken.None);

        Assert.True(result.Success);
        Assert.Equal(HttpMethod.Patch, handler.Method);
        Assert.Equal("/social-prep/00000000-0000-0000-0000-000000000001/platforms/x", handler.Path);
        Assert.Equal("{\"status\":\"preparing\",\"detailCode\":null,\"message\":null}", handler.Body);
    }

    [Theory]
    [InlineData("media_token_missing", HttpStatusCode.Unauthorized)]
    [InlineData("media_token_malformed", HttpStatusCode.Unauthorized)]
    [InlineData("media_token_invalid", HttpStatusCode.Forbidden)]
    [InlineData("media_token_expired", HttpStatusCode.Unauthorized)]
    [InlineData("attempt_superseded", HttpStatusCode.Conflict)]
    [InlineData("attempt_finished", HttpStatusCode.Conflict)]
    [InlineData("attempt_not_active", HttpStatusCode.Conflict)]
    [InlineData("validation_failed", HttpStatusCode.UnprocessableEntity)]
    [InlineData("platform_not_in_release", HttpStatusCode.NotFound)]
    public async Task CapabilityAndServerCodes_ArePreserved(string code, HttpStatusCode status)
    {
        var client = CreateClient(new CaptureHandler(_ => Json(status, Error(code))));

        SocialStatusResult result = await client.GetStatusAsync(Origin(), Capability, CancellationToken.None);

        Assert.False(result.Success);
        Assert.Equal(code, result.ErrorCode);
        Assert.DoesNotContain(Token, result.ErrorCode!);
    }

    [Fact]
    public async Task Media_RedirectIsNotFollowedAndTokenNeverAppearsInUrl()
    {
        var handler = new CaptureHandler(_ => new HttpResponseMessage(HttpStatusCode.Found) { Headers = { Location = new Uri("https://elsewhere.invalid/") } });
        var client = CreateClient(handler);
        var asset = Asset(1, 1);

        await using var target = new MemoryStream();
        SocialMediaDownloadResult result = await client.DownloadAssetAsync(Origin(), Capability, asset, target, SocialMediaStager.MaxAssetBytes, CancellationToken.None);

        Assert.False(result.Success);
        Assert.Equal("server_unreachable", result.ErrorCode);
        Assert.DoesNotContain(Token, handler.Uri!);
    }

    internal static SocialCapabilityClient CreateClient(HttpMessageHandler handler)
    {
        var resolver = new Resolver();
        return new SocialCapabilityClient(new SocialHttpClient(resolver, () => handler), new OriginTrustService(new Store(), new Prompt(), resolver));
    }
    internal static SocialOrigin Origin() { Assert.True(SocialOrigin.TryParse("https://creatorcrate.test", out SocialOrigin? value)); return value!; }
    internal static SocialRedeemAsset Asset(long id, long size) => new(id, "attachment", 0, "media.png", ".png", "image/png", size, "nested/media.png", true, null);
    private static HttpResponseMessage Json(HttpStatusCode status, string json) => new(status) { Content = new StringContent(json, Encoding.UTF8, "application/json") };
    private static string Error(string code) => $"{{\"ok\":false,\"error\":{{\"code\":\"{code}\",\"message\":\"ignored\"}}}}";
    private const string StatusJson = "{\"ok\":true,\"sessionId\":\"00000000-0000-0000-0000-000000000001\",\"state\":\"redeemed\",\"attemptDeadlineAt\":\"2026-01-01 12:00:00\",\"platforms\":[{\"platform\":\"x\",\"status\":\"pending\",\"detailCode\":null,\"attempts\":0,\"preparedAt\":null},{\"platform\":\"patreon\",\"status\":\"prepared\",\"detailCode\":null,\"attempts\":1,\"preparedAt\":\"2026-01-01 12:00:00\"}]}";

    private sealed class Store : ITrustedOriginStore { public bool IsTrusted(SocialOrigin origin) => true; public void Trust(SocialOrigin origin) { } }
    private sealed class Prompt : IOriginTrustPrompt { public bool ConfirmTrust(SocialOrigin origin) => false; }
    private sealed class Resolver : IOriginAddressResolver { public Task<IReadOnlyList<IPAddress>> ResolveAsync(string host, CancellationToken token) => Task.FromResult<IReadOnlyList<IPAddress>>(new[] { IPAddress.Loopback }); }
    internal sealed class CaptureHandler(Func<HttpRequestMessage, HttpResponseMessage> response) : HttpMessageHandler
    {
        public HttpMethod? Method { get; private set; }
        public string? Path { get; private set; }
        public string? Uri { get; private set; }
        public string? Authorization { get; private set; }
        public string? Body { get; private set; }
        protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
        {
            Method = request.Method; Path = request.RequestUri!.AbsolutePath; Uri = request.RequestUri!.OriginalString;
            Authorization = request.Headers.Authorization?.ToString();
            Body = request.Content is null ? null : await request.Content.ReadAsStringAsync(cancellationToken);
            return response(request);
        }
    }
}
