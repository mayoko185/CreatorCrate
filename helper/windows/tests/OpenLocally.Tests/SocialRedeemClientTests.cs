using System.Net;
using System.Net.Http;
using System.Security.Authentication;
using System.Text;
using OpenLocally;

namespace OpenLocally.Tests;

public class SocialRedeemClientTests
{
    private const string Intent = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

    [Fact]
    public async Task Redeem_SendsExactBodyAndDoesNotFollowRedirect()
    {
        var handler = new CaptureHandler(_ => new HttpResponseMessage(HttpStatusCode.Found)
        {
            Headers = { Location = new Uri("http://public.example/steal") },
        });
        var client = CreateClient(handler);
        SocialRedeemResult result = await client.RedeemAsync(Origin("http://127.0.0.1"), Intent, CancellationToken.None);

        Assert.False(result.Success);
        Assert.Equal("server_unreachable", result.ErrorCode);
        Assert.Equal(1, handler.Calls);
        Assert.Equal(HttpMethod.Post, handler.Method);
        Assert.Equal("/social-prep/redeem", handler.Path);
        Assert.Equal($"{{\"intent\":\"{Intent}\"}}", handler.Body);
        Assert.Equal("application/json", handler.ContentType);
    }

    [Fact]
    public async Task Redeem_MapsUnauthorizedToInvalidIntent()
    {
        var handler = new CaptureHandler(_ => new HttpResponseMessage(HttpStatusCode.Unauthorized));
        var client = CreateClient(handler);

        SocialRedeemResult result = await client.RedeemAsync(Origin("https://creatorcrate.test"), Intent, CancellationToken.None);

        Assert.Equal("invalid_intent", result.ErrorCode);
        Assert.DoesNotContain(Intent, result.ErrorCode!);
    }

    [Theory]
    [InlineData("certificate handling failed")]
    [InlineData("SSL connection failed")]
    public async Task Redeem_DoesNotMapTlsLookingMessageWithoutTypedEvidence(string message)
    {
        var handler = new CaptureHandler(_ => throw new HttpRequestException(message));
        var client = CreateClient(handler);

        SocialRedeemResult result = await client.RedeemAsync(Origin("https://127.0.0.1"), Intent, CancellationToken.None);

        Assert.False(result.Success);
        Assert.Equal("server_unreachable", result.ErrorCode);
    }

    [Fact]
    public async Task Redeem_MapsSecureConnectionHttpRequestError()
    {
        var handler = new CaptureHandler(_ => throw new HttpRequestException(
            HttpRequestError.SecureConnectionError,
            "network request failed",
            inner: null));
        var client = CreateClient(handler);

        SocialRedeemResult result = await client.RedeemAsync(Origin("https://127.0.0.1"), Intent, CancellationToken.None);

        Assert.False(result.Success);
        Assert.Equal("tls_validation_failed", result.ErrorCode);
    }

    [Fact]
    public async Task Redeem_MapsWrappedCertificateValidationFailure()
    {
        var handler = new CaptureHandler(_ => throw new HttpRequestException(
            "HTTPS request failed",
            new AuthenticationException("Certificate validation failed.")));
        var client = CreateClient(handler);

        SocialRedeemResult result = await client.RedeemAsync(Origin("https://127.0.0.1"), Intent, CancellationToken.None);

        Assert.False(result.Success);
        Assert.Equal("tls_validation_failed", result.ErrorCode);
    }

    private static SocialOrigin Origin(string text) { Assert.True(SocialOrigin.TryParse(text, out SocialOrigin? origin)); return origin!; }
    private static SocialRedeemClient CreateClient(HttpMessageHandler handler)
    {
        var resolver = new Resolver();
        return new SocialRedeemClient(new SocialHttpClient(resolver, () => handler), new OriginTrustService(new Store(), new Prompt(), resolver));
    }
    private sealed class Store : ITrustedOriginStore { public bool IsTrusted(SocialOrigin origin) => false; public void Trust(SocialOrigin origin) { } }
    private sealed class Prompt : IOriginTrustPrompt { public bool ConfirmTrust(SocialOrigin origin) => true; }
    private sealed class Resolver : IOriginAddressResolver
    {
        public Task<IReadOnlyList<System.Net.IPAddress>> ResolveAsync(string host, CancellationToken cancellationToken) =>
            Task.FromResult<IReadOnlyList<System.Net.IPAddress>>(new[] { System.Net.IPAddress.Loopback });
    }
    private sealed class CaptureHandler(Func<HttpRequestMessage, HttpResponseMessage> response) : HttpMessageHandler
    {
        public int Calls { get; private set; }
        public HttpMethod? Method { get; private set; }
        public string? Path { get; private set; }
        public string? Body { get; private set; }
        public string? ContentType { get; private set; }
        protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
        {
            Calls++;
            Method = request.Method;
            Path = request.RequestUri!.AbsolutePath;
            Body = request.Content is null ? null : await request.Content.ReadAsStringAsync(cancellationToken);
            ContentType = request.Content?.Headers.ContentType?.MediaType;
            return response(request);
        }
    }
}
