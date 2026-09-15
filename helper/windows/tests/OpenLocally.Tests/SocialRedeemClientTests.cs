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
        Assert.Equal(ManualSocialDiagnosticReason.RedirectRejected, result.Diagnostic!.Reason);
        Assert.Equal(302, result.Diagnostic.HttpStatus);
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
        Assert.Equal(ManualSocialDiagnosticReason.HttpNonSuccess, result.Diagnostic!.Reason);
        Assert.Equal(401, result.Diagnostic.HttpStatus);
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
        Assert.Equal(ManualSocialDiagnosticReason.RequestNotSent, result.Diagnostic!.Reason);
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
        Assert.Equal(ManualSocialDiagnosticReason.TlsTransportFailure, result.Diagnostic!.Reason);
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
        Assert.Equal(ManualSocialDiagnosticReason.TlsTransportFailure, result.Diagnostic!.Reason);
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task Redeem_MapsNonCallerCancellationToBoundedRequestFailure(bool taskCanceled)
    {
        const string sentinel = "SECRET_TIMEOUT_EXCEPTION_SENTINEL";
        OperationCanceledException timeout = taskCanceled
            ? new TaskCanceledException(sentinel)
            : new OperationCanceledException(sentinel);
        var handler = new CaptureHandler(_ => throw timeout);

        SocialRedeemResult result = await CreateClient(handler)
            .RedeemAsync(Origin("https://creatorcrate.test"), Intent, CancellationToken.None);

        Assert.False(result.Success);
        Assert.Equal("server_unreachable", result.ErrorCode);
        Assert.Equal(ManualSocialDiagnosticStage.RedeemRequest, result.Diagnostic!.Stage);
        Assert.Equal(ManualSocialDiagnosticReason.RequestNotSent, result.Diagnostic.Reason);
        Assert.Null(result.Diagnostic.HttpStatus);
        Assert.DoesNotContain(sentinel, result.Diagnostic.FormatForDisplay(), StringComparison.Ordinal);
    }

    [Fact]
    public async Task Redeem_PreservesCallerCancellation()
    {
        const string sentinel = "SECRET_CALLER_CANCELLATION_SENTINEL";
        using var cancellation = new CancellationTokenSource();
        cancellation.Cancel();
        var handler = new CaptureHandler(_ => throw new OperationCanceledException(sentinel, cancellation.Token));

        OperationCanceledException error = await Assert.ThrowsAnyAsync<OperationCanceledException>(() =>
            CreateClient(handler).RedeemAsync(Origin("https://creatorcrate.test"), Intent, cancellation.Token));

        Assert.Equal(sentinel, error.Message);
    }

    [Fact]
    public async Task Redeem_NonSuccessIncludesOnlyNumericStatusAndNoBody()
    {
        const string secret = "SECRET_POST_BODY_SENTINEL";
        var handler = new CaptureHandler(_ => new HttpResponseMessage(HttpStatusCode.UnprocessableEntity)
        {
            Content = new StringContent(secret),
        });

        SocialRedeemResult result = await CreateClient(handler)
            .RedeemAsync(Origin("https://creatorcrate.test"), Intent, CancellationToken.None);

        Assert.Equal("server_unreachable", result.ErrorCode);
        Assert.Equal(ManualSocialDiagnosticReason.HttpNonSuccess, result.Diagnostic!.Reason);
        Assert.Equal(422, result.Diagnostic.HttpStatus);
        Assert.DoesNotContain(secret, result.Diagnostic.FormatForDisplay());
    }

    [Fact]
    public async Task Redeem_InvalidPayloadCarriesParserReasonAndHttpStatusWithoutBody()
    {
        const string secret = "SECRET_BEARER_SENTINEL";
        var handler = new CaptureHandler(_ => new HttpResponseMessage(HttpStatusCode.OK)
        {
            Content = new StringContent("{\"" + secret + "\":true}"),
        });

        SocialRedeemResult result = await CreateClient(handler)
            .RedeemAsync(Origin("https://creatorcrate.test"), Intent, CancellationToken.None);

        Assert.Equal("redeem_payload_invalid", result.ErrorCode);
        Assert.Equal(ManualSocialDiagnosticReason.UnexpectedProperty, result.Diagnostic!.Reason);
        Assert.Equal(200, result.Diagnostic.HttpStatus);
        Assert.DoesNotContain(secret, result.Diagnostic.FormatForDisplay());
    }

    [Fact]
    public async Task Redeem_OversizedResponseHasBoundedDiagnostic()
    {
        var content = new ByteArrayContent([0]);
        content.Headers.ContentLength = SocialRedeemClient.MaxJsonBytes + 1L;
        var handler = new CaptureHandler(_ => new HttpResponseMessage(HttpStatusCode.OK) { Content = content });

        SocialRedeemResult result = await CreateClient(handler)
            .RedeemAsync(Origin("https://creatorcrate.test"), Intent, CancellationToken.None);

        Assert.Equal("redeem_payload_too_large", result.ErrorCode);
        Assert.Equal(ManualSocialDiagnosticReason.ResponseTooLarge, result.Diagnostic!.Reason);
        Assert.Equal(200, result.Diagnostic.HttpStatus);
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
