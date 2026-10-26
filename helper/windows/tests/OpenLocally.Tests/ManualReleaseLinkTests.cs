using System.Net;
using System.Text;
using System.Text.Json;
using OpenLocally;

namespace OpenLocally.Tests;

public sealed class ManualReleaseLinkClientTests
{
    private const string Token = "sentinel-bearer-aaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    private const string SessionId = "00000000-0000-0000-0000-000000000001";
    private static readonly SocialCapability Capability = new(SessionId, Token);

    [Fact]
    public async Task Get_UsesExactAuthenticatedContract_AndKeepsUntrimmedValue()
    {
        var handler = new RecordingHandler((_, _) => Json(HttpStatusCode.OK,
            $"{{\"ok\":true,\"sessionId\":\"{SessionId}\",\"releaseLink\":\"  https://example.com/a  \"}}"));
        using var client = CreateClient(handler);

        ManualReleaseLinkTransportResult result = await client.GetAsync(CancellationToken.None);

        Assert.Equal(ManualReleaseLinkTransportOutcome.Authoritative, result.Outcome);
        Assert.Equal("  https://example.com/a  ", result.ReleaseLink);
        CapturedRequest request = Assert.Single(handler.Requests);
        Assert.Equal(HttpMethod.Get, request.Method);
        Assert.Equal("https://creatorcrate.test/social-prep/" + SessionId + "/release-link", request.Uri);
        Assert.Equal($"Bearer {Token}", request.Authorization);
        Assert.Equal("application/json", request.Accept);
        Assert.False(request.HadContent);
        Assert.Null(request.Cookie);
    }

    [Fact]
    public async Task Patch_SendsExactExpectedValue_WithJsonHeaders()
    {
        var handler = new RecordingHandler((_, _) => Json(HttpStatusCode.OK,
            $"{{\"ok\":true,\"sessionId\":\"{SessionId}\",\"releaseLink\":\"https://example.com/b\",\"changed\":true}}"));
        using var client = CreateClient(handler);

        ManualReleaseLinkTransportResult result = await client.PatchAsync(
            "https://example.com/b", " https://example.com/a\t", CancellationToken.None);

        Assert.Equal(ManualReleaseLinkTransportOutcome.Authoritative, result.Outcome);
        Assert.Equal("https://example.com/b", result.ReleaseLink);
        Assert.True(result.Changed);
        CapturedRequest request = Assert.Single(handler.Requests);
        Assert.Equal(HttpMethod.Patch, request.Method);
        Assert.EndsWith($"/social-prep/{SessionId}/release-link", request.Uri, StringComparison.Ordinal);
        Assert.Equal($"Bearer {Token}", request.Authorization);
        Assert.Equal("application/json", request.Accept);
        Assert.Equal("application/json", request.ContentType);
        using JsonDocument body = JsonDocument.Parse(request.Body);
        Assert.Equal(new[] { "releaseLink", "expectedReleaseLink" },
            body.RootElement.EnumerateObject().Select(property => property.Name));
        Assert.Equal("https://example.com/b", body.RootElement.GetProperty("releaseLink").GetString());
        Assert.Equal(" https://example.com/a\t", body.RootElement.GetProperty("expectedReleaseLink").GetString());
    }

    [Fact]
    public async Task NullValues_RoundTripAsJsonNull()
    {
        var handler = new RecordingHandler((_, call) => Json(HttpStatusCode.OK, call == 1
            ? $"{{\"ok\":true,\"sessionId\":\"{SessionId}\",\"releaseLink\":null,\"changed\":false}}"
            : $"{{\"ok\":true,\"sessionId\":\"{SessionId}\",\"releaseLink\":null}}"));
        using var client = CreateClient(handler);

        ManualReleaseLinkTransportResult patched = await client.PatchAsync(null, null, CancellationToken.None);
        ManualReleaseLinkTransportResult read = await client.GetAsync(CancellationToken.None);

        Assert.Equal(ManualReleaseLinkTransportOutcome.Authoritative, patched.Outcome);
        Assert.Null(patched.ReleaseLink);
        Assert.False(patched.Changed);
        Assert.Equal(ManualReleaseLinkTransportOutcome.Authoritative, read.Outcome);
        Assert.Null(read.ReleaseLink);
        Assert.Equal("{\"releaseLink\":null,\"expectedReleaseLink\":null}", Encoding.UTF8.GetString(handler.Requests[0].Body));
    }

    [Theory]
    [InlineData("{\"ok\":true,\"sessionId\":\"00000000-0000-0000-0000-000000000002\",\"releaseLink\":null}")]
    [InlineData("{\"ok\":true,\"sessionId\":\"00000000-0000-0000-0000-000000000001\",\"releaseLink\":\"\"}")]
    [InlineData("{\"ok\":true,\"sessionId\":\"00000000-0000-0000-0000-000000000001\",\"releaseLink\":5}")]
    [InlineData("{\"ok\":true,\"sessionId\":\"00000000-0000-0000-0000-000000000001\"}")]
    [InlineData("{\"ok\":true,\"sessionId\":\"00000000-0000-0000-0000-000000000001\",\"releaseLink\":null,\"extra\":1}")]
    [InlineData("{\"ok\":false,\"sessionId\":\"00000000-0000-0000-0000-000000000001\",\"releaseLink\":null}")]
    [InlineData("[]")]
    [InlineData("<!doctype html><html>CreatorCrate</html>")]
    public async Task MalformedOrForeignGetSuccess_IsUnsupported(string body)
    {
        using var client = CreateClient(new RecordingHandler((_, _) => Json(HttpStatusCode.OK, body)));

        ManualReleaseLinkTransportResult result = await client.GetAsync(CancellationToken.None);

        Assert.Equal(ManualReleaseLinkTransportOutcome.Unsupported, result.Outcome);
        Assert.Null(result.ReleaseLink);
    }

    [Theory]
    [InlineData("{\"ok\":true,\"sessionId\":\"00000000-0000-0000-0000-000000000002\",\"releaseLink\":null,\"changed\":true}")]
    [InlineData("{\"ok\":true,\"sessionId\":\"00000000-0000-0000-0000-000000000001\",\"releaseLink\":null}")]
    [InlineData("{\"ok\":true,\"sessionId\":\"00000000-0000-0000-0000-000000000001\",\"releaseLink\":null,\"changed\":\"yes\"}")]
    [InlineData("not json")]
    public async Task MalformedPatchSuccess_IsAmbiguous_BecauseTheWriteMayHaveCommitted(string body)
    {
        using var client = CreateClient(new RecordingHandler((_, _) => Json(HttpStatusCode.OK, body)));

        ManualReleaseLinkTransportResult result = await client.PatchAsync("https://example.com", null, CancellationToken.None);

        Assert.Equal(ManualReleaseLinkTransportOutcome.Ambiguous, result.Outcome);
    }

    [Theory]
    [InlineData("validation_failed", 422)]
    [InlineData("release_link_token_missing", 401)]
    [InlineData("release_link_token_malformed", 401)]
    [InlineData("release_link_token_invalid", 403)]
    [InlineData("release_link_token_expired", 401)]
    [InlineData("attempt_superseded", 409)]
    [InlineData("attempt_not_link_editable", 409)]
    [InlineData("release_link_not_eligible", 409)]
    [InlineData("release_not_editable", 409)]
    [InlineData("release_not_found", 404)]
    public async Task RecognizedContractRejection_IsReportedByCode(string code, int status)
    {
        using var client = CreateClient(new RecordingHandler((_, _) => Json((HttpStatusCode)status,
            $"{{\"ok\":false,\"error\":{{\"code\":\"{code}\",\"message\":\"server text {Token}\"}}}}")));

        ManualReleaseLinkTransportResult result = await client.GetAsync(CancellationToken.None);

        Assert.Equal(ManualReleaseLinkTransportOutcome.Rejected, result.Outcome);
        Assert.Equal(code, result.ErrorCode);
        Assert.DoesNotContain(Token, result.ToString());
    }

    [Fact]
    public async Task ValidationRejection_AcceptsServerIssues()
    {
        using var client = CreateClient(new RecordingHandler((_, _) => Json((HttpStatusCode)422,
            "{\"ok\":false,\"error\":{\"code\":\"validation_failed\",\"message\":\"Social Preparation validation failed.\"," +
            "\"issues\":[{\"code\":\"invalid_release_link\",\"severity\":\"blocking\"}]}}")));

        ManualReleaseLinkTransportResult result = await client.PatchAsync("nope", null, CancellationToken.None);

        Assert.Equal(ManualReleaseLinkTransportOutcome.Rejected, result.Outcome);
        Assert.Equal("validation_failed", result.ErrorCode);
    }

    [Theory]
    [InlineData("\" https://example.com/current \"", " https://example.com/current ")]
    [InlineData("null", null)]
    public async Task Conflict_CarriesExactCurrentServerValue(string json, string? expected)
    {
        using var client = CreateClient(new RecordingHandler((_, _) => Json(HttpStatusCode.Conflict,
            $"{{\"ok\":false,\"error\":{{\"code\":\"release_link_conflict\",\"message\":\"m\",\"currentReleaseLink\":{json}}}}}")));

        ManualReleaseLinkTransportResult result = await client.PatchAsync("https://example.com/new", null, CancellationToken.None);

        Assert.Equal(ManualReleaseLinkTransportOutcome.Rejected, result.Outcome);
        Assert.Equal("release_link_conflict", result.ErrorCode);
        Assert.Equal(expected, result.CurrentReleaseLink);
    }

    [Theory]
    [InlineData(404, "text/html", "<html>Cannot GET /social-prep/x/release-link</html>")]
    [InlineData(401, "text/html", "<html>Please sign in</html>")]
    [InlineData(401, "application/json", "{\"error\":\"unauthorized\"}")]
    [InlineData(404, "application/json", "{\"ok\":false,\"error\":{\"code\":\"not_found\",\"message\":\"Not found\"}}")]
    [InlineData(403, "application/json", "{\"ok\":false,\"error\":{\"code\":\"release_link_token_expired\",\"message\":\"wrong status\"}}")]
    [InlineData(409, "application/json", "{\"ok\":false,\"error\":{\"code\":\"release_link_conflict\",\"message\":\"no current value\"}}")]
    [InlineData(409, "application/json", "{\"ok\":false,\"error\":{\"code\":\"attempt_superseded\",\"message\":\"m\",\"extra\":true}}")]
    public async Task GenericOrNonContractClientError_IsUnsupported_NotAnAuthorizationRejection(
        int status, string mediaType, string body)
    {
        var handler = new RecordingHandler((_, _) => new HttpResponseMessage((HttpStatusCode)status)
        {
            Content = new StringContent(body, Encoding.UTF8, mediaType),
        });
        using var client = CreateClient(handler);

        ManualReleaseLinkTransportResult result = await client.PatchAsync("https://example.com", null, CancellationToken.None);

        Assert.Equal(ManualReleaseLinkTransportOutcome.Unsupported, result.Outcome);
        Assert.Single(handler.Requests);
    }

    [Fact]
    public async Task LoginRedirect_IsNotFollowed_AndIsUnsupported()
    {
        var handler = new RecordingHandler((_, _) =>
        {
            var response = new HttpResponseMessage(HttpStatusCode.Found) { Content = new StringContent(string.Empty) };
            response.Headers.Location = new Uri("https://login.example.net/signin");
            return response;
        });
        using var client = CreateClient(handler);

        ManualReleaseLinkTransportResult result = await client.GetAsync(CancellationToken.None);

        Assert.Equal(ManualReleaseLinkTransportOutcome.Unsupported, result.Outcome);
        CapturedRequest request = Assert.Single(handler.Requests);
        Assert.StartsWith("https://creatorcrate.test/", request.Uri, StringComparison.Ordinal);
        Assert.DoesNotContain(Token, request.Uri);
    }

    [Fact]
    public async Task ServerErrorAndNetworkFailure_AreAmbiguous_WithoutLeakingBearer()
    {
        using var serverError = CreateClient(new RecordingHandler((_, _) => Json(HttpStatusCode.BadGateway, "{}")));
        Assert.Equal(ManualReleaseLinkTransportOutcome.Ambiguous, (await serverError.GetAsync(CancellationToken.None)).Outcome);

        using var lost = CreateClient(new RecordingHandler((_, _) => throw new HttpRequestException($"reset {Token}")));
        ManualReleaseLinkTransportResult result = await lost.PatchAsync("https://example.com", null, CancellationToken.None);
        Assert.Equal(ManualReleaseLinkTransportOutcome.Ambiguous, result.Outcome);
        Assert.DoesNotContain(Token, result.ToString());
    }

    [Fact]
    public async Task DisposedClient_RefusesRequests()
    {
        var handler = new RecordingHandler((_, _) => Json(HttpStatusCode.OK, "{}"));
        var client = CreateClient(handler);
        client.Dispose();

        await Assert.ThrowsAsync<ObjectDisposedException>(() => client.GetAsync(CancellationToken.None));
        Assert.Empty(handler.Requests);
    }

    [Fact]
    public async Task StalledGetBody_EndsAtRequestTimeout_AsFailedLoad()
    {
        var body = new StallingStream("{\"ok\":true,"u8.ToArray());
        using var controller = new ManualReleaseLinkController(CreateClient(
            new RecordingHandler((_, _) => Stream(body)), TimeSpan.FromMilliseconds(100)));

        ManualReleaseLinkState state = await controller.LoadAsync().WaitAsync(TimeSpan.FromSeconds(10));

        Assert.True(body.Stalled.Task.IsCompleted);
        Assert.Equal(ManualReleaseLinkPhase.Failed, state.Phase);
        Assert.Equal(ManualReleaseLinkController.LoadFailedMessage, state.Message);
    }

    [Fact]
    public async Task StalledGetBody_FromRealLoopbackServer_EndsAtRequestTimeout()
    {
        using var listener = new System.Net.Sockets.TcpListener(IPAddress.Loopback, 0);
        listener.Start();
        using var stop = new CancellationTokenSource();
        Task server = Task.Run(async () =>
        {
            using System.Net.Sockets.TcpClient connection = await listener.AcceptTcpClientAsync(stop.Token);
            System.Net.Sockets.NetworkStream stream = connection.GetStream();
            var received = new StringBuilder();
            byte[] buffer = new byte[1024];
            while (!received.ToString().Contains("\r\n\r\n", StringComparison.Ordinal))
                received.Append(Encoding.ASCII.GetString(buffer, 0, await stream.ReadAsync(buffer, stop.Token)));
            await stream.WriteAsync(Encoding.ASCII.GetBytes(
                "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 200\r\n\r\n{\"ok\":true,"), stop.Token);
            await Task.Delay(Timeout.Infinite, stop.Token);
        });
        var resolver = new Resolver();
        Assert.True(SocialOrigin.TryParse($"http://127.0.0.1:{((IPEndPoint)listener.LocalEndpoint).Port}", out SocialOrigin? origin));
        using var client = new ManualReleaseLinkClient(
            new SocialHttpClient(resolver) { RequestTimeout = TimeSpan.FromMilliseconds(150) },
            new OriginTrustService(new TrustedStore(), new AllowPrompt(), resolver), origin!, Capability);

        ManualReleaseLinkTransportResult result = await client.GetAsync(CancellationToken.None).WaitAsync(TimeSpan.FromSeconds(10));

        Assert.Equal(ManualReleaseLinkTransportOutcome.Ambiguous, result.Outcome);
        stop.Cancel();
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => server);
    }

    [Fact]
    public async Task StalledPatchBody_IsAmbiguous_AndSettledByOneBoundedReadback()
    {
        var body = new StallingStream([]);
        var handler = new RecordingHandler((_, call) => call == 1
            ? Json(HttpStatusCode.OK, $"{{\"ok\":true,\"sessionId\":\"{SessionId}\",\"releaseLink\":\"https://example.com/a\"}}")
            : call == 2
                ? Stream(body)
                : Json(HttpStatusCode.OK, $"{{\"ok\":true,\"sessionId\":\"{SessionId}\",\"releaseLink\":\"https://example.com/b\"}}"));
        using var controller = new ManualReleaseLinkController(CreateClient(handler, TimeSpan.FromMilliseconds(100)));
        await controller.LoadAsync();
        controller.SetDraft("https://example.com/b");

        ManualReleaseLinkState state = await controller.SaveAsync().WaitAsync(TimeSpan.FromSeconds(10));

        Assert.True(body.Stalled.Task.IsCompleted);
        Assert.Equal(ManualReleaseLinkPhase.Saved, state.Phase);
        Assert.Equal("https://example.com/b", state.AuthoritativeLink);
        Assert.Equal(new[] { HttpMethod.Get, HttpMethod.Patch, HttpMethod.Get }, handler.Requests.Select(request => request.Method));
    }

    [Fact]
    public async Task StalledPatchAndReadbackBodies_EndUncertain_WithoutRetry()
    {
        var handler = new RecordingHandler((_, call) => call == 1
            ? Json(HttpStatusCode.OK, $"{{\"ok\":true,\"sessionId\":\"{SessionId}\",\"releaseLink\":\"https://example.com/a\"}}")
            : Stream(new StallingStream([])));
        using var controller = new ManualReleaseLinkController(CreateClient(handler, TimeSpan.FromMilliseconds(100)));
        await controller.LoadAsync();
        controller.SetDraft("https://example.com/b");

        ManualReleaseLinkState state = await controller.SaveAsync().WaitAsync(TimeSpan.FromSeconds(10));

        Assert.Equal(ManualReleaseLinkPhase.Uncertain, state.Phase);
        Assert.Equal("https://example.com/b", state.Draft);
        Assert.Equal("https://example.com/a", state.AuthoritativeLink);
        Assert.Equal(new[] { HttpMethod.Get, HttpMethod.Patch, HttpMethod.Get }, handler.Requests.Select(request => request.Method));
    }

    [Fact]
    public async Task Dispose_CancelsOutstandingBodyRead()
    {
        var body = new StallingStream([]);
        var controller = new ManualReleaseLinkController(CreateClient(new RecordingHandler((_, _) => Stream(body))));
        Task<ManualReleaseLinkState> loading = controller.LoadAsync();
        CancellationToken token = await body.Stalled.Task.WaitAsync(TimeSpan.FromSeconds(10));

        controller.Dispose();

        await loading.WaitAsync(TimeSpan.FromSeconds(10));
        Assert.True(token.IsCancellationRequested);
    }

    [Fact]
    public async Task OversizedStreamedBody_IsStillRejected()
    {
        using var client = CreateClient(new RecordingHandler((_, _) => Stream(new StallingStream(new byte[64 * 1024 + 1]))));

        ManualReleaseLinkTransportResult result = await client.GetAsync(CancellationToken.None).WaitAsync(TimeSpan.FromSeconds(10));

        Assert.Equal(ManualReleaseLinkTransportOutcome.Ambiguous, result.Outcome);
    }

    private static ManualReleaseLinkClient CreateClient(HttpMessageHandler handler, TimeSpan? requestTimeout = null)
    {
        var resolver = new Resolver();
        Assert.True(SocialOrigin.TryParse("https://creatorcrate.test", out SocialOrigin? origin));
        var http = requestTimeout is { } timeout
            ? new SocialHttpClient(resolver, () => handler) { RequestTimeout = timeout }
            : new SocialHttpClient(resolver, () => handler);
        return new ManualReleaseLinkClient(
            http, new OriginTrustService(new TrustedStore(), new AllowPrompt(), resolver), origin!, Capability);
    }

    private static HttpResponseMessage Stream(Stream body)
    {
        var content = new StreamContent(body);
        content.Headers.ContentType = new System.Net.Http.Headers.MediaTypeHeaderValue("application/json");
        return new HttpResponseMessage(HttpStatusCode.OK) { Content = content };
    }

    /// <summary>Returns its prefix, then never completes a read and ignores cancellation, like a stalled peer.</summary>
    private sealed class StallingStream(byte[] prefix) : Stream
    {
        private readonly TaskCompletionSource<int> _never = new(TaskCreationOptions.RunContinuationsAsynchronously);
        private int _offset;
        internal TaskCompletionSource<CancellationToken> Stalled { get; } = new(TaskCreationOptions.RunContinuationsAsynchronously);

        public override ValueTask<int> ReadAsync(Memory<byte> buffer, CancellationToken cancellationToken = default)
        {
            if (_offset < prefix.Length)
            {
                int count = Math.Min(buffer.Length, prefix.Length - _offset);
                prefix.AsMemory(_offset, count).CopyTo(buffer);
                _offset += count;
                return ValueTask.FromResult(count);
            }
            Stalled.TrySetResult(cancellationToken);
            return new ValueTask<int>(_never.Task);
        }

        protected override void Dispose(bool disposing)
        {
            _never.TrySetCanceled();
            base.Dispose(disposing);
        }

        public override bool CanRead => true;
        public override bool CanSeek => false;
        public override bool CanWrite => false;
        public override long Length => throw new NotSupportedException();
        public override long Position { get => throw new NotSupportedException(); set => throw new NotSupportedException(); }
        public override void Flush() { }
        public override int Read(byte[] buffer, int offset, int count) => throw new NotSupportedException();
        public override long Seek(long offset, SeekOrigin origin) => throw new NotSupportedException();
        public override void SetLength(long value) => throw new NotSupportedException();
        public override void Write(byte[] buffer, int offset, int count) => throw new NotSupportedException();
    }

    private static HttpResponseMessage Json(HttpStatusCode status, string json) => new(status)
    {
        Content = new StringContent(json, Encoding.UTF8, "application/json"),
    };

    private sealed class RecordingHandler(Func<HttpRequestMessage, int, HttpResponseMessage> respond) : HttpMessageHandler
    {
        private int _calls;
        internal List<CapturedRequest> Requests { get; } = [];

        protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
        {
            byte[] body = request.Content is null ? [] : await request.Content.ReadAsByteArrayAsync(cancellationToken);
            Requests.Add(new CapturedRequest(
                request.Method, request.RequestUri!.AbsoluteUri, request.Headers.Authorization?.ToString(),
                request.Headers.Accept.ToString(), request.Headers.TryGetValues("Cookie", out var cookie) ? string.Join(";", cookie) : null,
                request.Content is not null, request.Content?.Headers.ContentType?.MediaType, body));
            return respond(request, Interlocked.Increment(ref _calls));
        }
    }

    private sealed record CapturedRequest(
        HttpMethod Method, string Uri, string? Authorization, string Accept, string? Cookie,
        bool HadContent, string? ContentType, byte[] Body);

    private sealed class Resolver : IOriginAddressResolver
    {
        public Task<IReadOnlyList<IPAddress>> ResolveAsync(string host, CancellationToken cancellationToken) =>
            Task.FromResult<IReadOnlyList<IPAddress>>([IPAddress.Loopback]);
    }

    private sealed class TrustedStore : ITrustedOriginStore
    {
        public bool IsTrusted(SocialOrigin origin) => true;
        public void Trust(SocialOrigin origin) { }
    }

    private sealed class AllowPrompt : IOriginTrustPrompt
    {
        public bool ConfirmTrust(SocialOrigin origin) => true;
    }
}

public sealed class ManualReleaseLinkControllerTests
{
    private const string Untrimmed = "  https://example.com/a  ";

    [Fact]
    public async Task InitialLoad_KeepsExactAuthoritativeValue_AndTrimmedDraft()
    {
        var transport = new ScriptedTransport();
        transport.Gets.Enqueue(_ => Ok(Untrimmed));
        using var controller = new ManualReleaseLinkController(transport);
        Assert.Equal(ManualReleaseLinkPhase.NotLoaded, controller.State.Phase);
        Assert.False(controller.State.CanSave);

        ManualReleaseLinkState state = await controller.LoadAsync();

        Assert.Equal(ManualReleaseLinkPhase.Ready, state.Phase);
        Assert.Equal(Untrimmed, state.AuthoritativeLink);
        Assert.Equal("https://example.com/a", state.DisplayLink);
        Assert.Equal("https://example.com/a", state.Draft);
        Assert.False(state.IsDirty);
        Assert.True(state.CanSave);

        controller.SetDraft("https://example.com/b");
        transport.Patches.Enqueue((_, _, _) => Ok("https://example.com/b", changed: true));
        await controller.SaveAsync();

        (string? link, string? expected) = Assert.Single(transport.PatchCalls);
        Assert.Equal("https://example.com/b", link);
        Assert.Equal(Untrimmed, expected);
    }

    [Fact]
    public async Task NullServerValue_ProducesEmptyDraft_AndBlankDraftSubmitsNull()
    {
        var transport = new ScriptedTransport();
        transport.Gets.Enqueue(_ => Ok(null));
        using var controller = new ManualReleaseLinkController(transport);

        ManualReleaseLinkState loaded = await controller.LoadAsync();
        Assert.Equal(string.Empty, loaded.Draft);
        Assert.Null(loaded.AuthoritativeLink);

        controller.SetDraft("   ");
        Assert.False(controller.State.IsDirty);
        transport.Patches.Enqueue((_, _, _) => Ok(null, changed: false));
        ManualReleaseLinkState saved = await controller.SaveAsync();

        Assert.Equal((null, null), Assert.Single(transport.PatchCalls));
        Assert.Equal(ManualReleaseLinkPhase.Saved, saved.Phase);
        Assert.False(saved.LastSaveChanged);
        Assert.Equal(string.Empty, saved.Draft);
    }

    [Fact]
    public async Task LoadFailure_IsStateOnly_AndBlocksSaveWithoutThrowing()
    {
        var transport = new ScriptedTransport();
        transport.Gets.Enqueue(_ => throw new HttpRequestException("offline"));
        using var controller = new ManualReleaseLinkController(transport);

        ManualReleaseLinkState state = await controller.LoadAsync();

        Assert.Equal(ManualReleaseLinkPhase.Failed, state.Phase);
        Assert.Equal(ManualReleaseLinkController.LoadFailedMessage, state.Message);
        Assert.False(state.CanSave);
        Assert.Equal(ManualReleaseLinkPhase.Failed, (await controller.SaveAsync()).Phase);
        Assert.Empty(transport.PatchCalls);

        transport.Gets.Enqueue(_ => Ok("https://example.com"));
        Assert.Equal(ManualReleaseLinkPhase.Ready, (await controller.LoadAsync()).Phase);
    }

    [Theory]
    [InlineData(true)]
    [InlineData(false)]
    public async Task SaveSuccess_AdvancesAuthoritativeValue(bool changed)
    {
        var (controller, transport) = await LoadedAsync("https://example.com/a");
        using (controller)
        {
            controller.SetDraft("  https://example.com/b ");
            transport.Patches.Enqueue((_, _, _) => Ok("https://example.com/b", changed));

            ManualReleaseLinkState state = await controller.SaveAsync();

            Assert.Equal(ManualReleaseLinkPhase.Saved, state.Phase);
            Assert.Equal("https://example.com/b", state.AuthoritativeLink);
            Assert.Equal("https://example.com/b", state.Draft);
            Assert.Equal(changed, state.LastSaveChanged);
            Assert.False(state.IsDirty);
            Assert.Equal("https://example.com/b", transport.PatchCalls.Single().Link);

            controller.SetDraft("https://example.com/c");
            Assert.Equal(ManualReleaseLinkPhase.Ready, controller.State.Phase);
            transport.Patches.Enqueue((_, _, _) => Ok("https://example.com/c", true));
            await controller.SaveAsync();
            Assert.Equal("https://example.com/b", transport.PatchCalls[1].Expected);
        }
    }

    [Fact]
    public async Task ValidationError_PreservesDraft_AndAuthoritativeValue()
    {
        var (controller, transport) = await LoadedAsync("https://example.com/a");
        using (controller)
        {
            controller.SetDraft("not a url");
            transport.Patches.Enqueue((_, _, _) => Task.FromResult(ManualReleaseLinkTransportResult.Rejected("validation_failed")));

            ManualReleaseLinkState state = await controller.SaveAsync();

            Assert.Equal(ManualReleaseLinkPhase.Invalid, state.Phase);
            Assert.Equal(ManualReleaseLinkController.InvalidMessage, state.Message);
            Assert.Equal("not a url", state.Draft);
            Assert.Equal("https://example.com/a", state.AuthoritativeLink);
            Assert.True(state.CanSave);
            Assert.Single(transport.Gets.History);
        }
    }

    [Fact]
    public async Task DuplicateSave_JoinsPendingRequest()
    {
        var (controller, transport) = await LoadedAsync("https://example.com/a");
        using (controller)
        {
            var gate = new TaskCompletionSource<ManualReleaseLinkTransportResult>(TaskCreationOptions.RunContinuationsAsynchronously);
            transport.Patches.Enqueue((_, _, _) => gate.Task);
            controller.SetDraft("https://example.com/b");

            Task<ManualReleaseLinkState> first = controller.SaveAsync();
            Task<ManualReleaseLinkState> second = controller.SaveAsync();
            Assert.Same(first, second);
            Assert.True(controller.State.IsBusy);
            Assert.False(controller.State.CanSave);

            gate.SetResult(ManualReleaseLinkTransportResult.Authoritative("https://example.com/b", true));
            await first;
            await WaitUntilAsync(() => transport.PatchCalls.Count >= 1);
            Assert.Single(transport.PatchCalls);
        }
    }

    [Fact]
    public async Task DraftEditedDuringSave_IsNotOverwrittenByResponse()
    {
        var (controller, transport) = await LoadedAsync("https://example.com/a");
        using (controller)
        {
            var gate = new TaskCompletionSource<ManualReleaseLinkTransportResult>(TaskCreationOptions.RunContinuationsAsynchronously);
            transport.Patches.Enqueue((_, _, _) => gate.Task);
            controller.SetDraft("https://example.com/b");
            Task<ManualReleaseLinkState> saving = controller.SaveAsync();
            await WaitUntilAsync(() => transport.PatchCalls.Count == 1);

            controller.SetDraft("https://example.com/newer");
            gate.SetResult(ManualReleaseLinkTransportResult.Authoritative("https://example.com/b", true));
            ManualReleaseLinkState state = await saving;

            Assert.Equal(ManualReleaseLinkPhase.Ready, state.Phase);
            Assert.Equal("https://example.com/b", state.AuthoritativeLink);
            Assert.Equal("https://example.com/newer", state.Draft);
            Assert.True(state.IsDirty);
        }
    }

    [Fact]
    public async Task Conflict_PreservesDraft_RecordsServerValue_AndRequiresExplicitResolution()
    {
        var (controller, transport) = await LoadedAsync("https://example.com/a");
        using (controller)
        {
            controller.SetDraft("https://example.com/mine");
            transport.Patches.Enqueue((_, _, _) => Task.FromResult(
                ManualReleaseLinkTransportResult.Rejected("release_link_conflict", " https://example.com/theirs ")));

            ManualReleaseLinkState conflict = await controller.SaveAsync();

            Assert.Equal(ManualReleaseLinkPhase.Conflict, conflict.Phase);
            Assert.Equal("https://example.com/mine", conflict.Draft);
            Assert.Equal(" https://example.com/theirs ", conflict.AuthoritativeLink);
            Assert.False(conflict.CanSave);

            // No blind retry of the stale write.
            Assert.Equal(ManualReleaseLinkPhase.Conflict, (await controller.SaveAsync()).Phase);
            Assert.Single(transport.PatchCalls);

            Assert.Equal(ManualReleaseLinkPhase.Ready, controller.KeepDraftAfterConflict().Phase);
            transport.Patches.Enqueue((_, _, _) => Ok("https://example.com/mine", true));
            ManualReleaseLinkState saved = await controller.SaveAsync();

            Assert.Equal(ManualReleaseLinkPhase.Saved, saved.Phase);
            Assert.Equal(" https://example.com/theirs ", transport.PatchCalls[1].Expected);
        }
    }

    [Fact]
    public async Task Conflict_CanBeResolvedByDiscardingDraft_OrByReload()
    {
        var (controller, transport) = await LoadedAsync("https://example.com/a");
        using (controller)
        {
            controller.SetDraft("https://example.com/mine");
            transport.Patches.Enqueue((_, _, _) => Task.FromResult(
                ManualReleaseLinkTransportResult.Rejected("release_link_conflict", "https://example.com/theirs")));
            await controller.SaveAsync();

            ManualReleaseLinkState discarded = controller.DiscardDraft();
            Assert.Equal(ManualReleaseLinkPhase.Ready, discarded.Phase);
            Assert.Equal("https://example.com/theirs", discarded.Draft);

            controller.SetDraft("https://example.com/mine-again");
            transport.Patches.Enqueue((_, _, _) => Task.FromResult(
                ManualReleaseLinkTransportResult.Rejected("release_link_conflict", "https://example.com/third")));
            await controller.SaveAsync();
            transport.Gets.Enqueue(_ => Ok("https://example.com/fourth"));

            ManualReleaseLinkState reloaded = await controller.LoadAsync();

            Assert.Equal(ManualReleaseLinkPhase.Ready, reloaded.Phase);
            Assert.Equal("https://example.com/fourth", reloaded.AuthoritativeLink);
            Assert.Equal("https://example.com/mine-again", reloaded.Draft);
        }
    }

    [Fact]
    public async Task SaveDuringLoad_SendsNothing_AndLoadResultCannotReplaceLaterSave()
    {
        var (controller, transport) = await LoadedAsync("https://example.com/a");
        using (controller)
        {
            var gate = new TaskCompletionSource<ManualReleaseLinkTransportResult>(TaskCreationOptions.RunContinuationsAsynchronously);
            transport.Gets.Enqueue(_ => gate.Task);
            Task<ManualReleaseLinkState> reload = controller.LoadAsync();
            controller.SetDraft("https://example.com/b");

            ManualReleaseLinkState ignored = await controller.SaveAsync();
            Assert.Equal(ManualReleaseLinkPhase.Loading, ignored.Phase);
            Assert.Empty(transport.PatchCalls);
            Assert.Same(reload, controller.LoadAsync());

            gate.SetResult(ManualReleaseLinkTransportResult.Authoritative("https://example.com/a"));
            await reload;
            Assert.Equal("https://example.com/b", controller.State.Draft);

            transport.Patches.Enqueue((_, _, _) => Ok("https://example.com/b", true));
            ManualReleaseLinkState saved = await controller.SaveAsync();
            Assert.Equal("https://example.com/b", saved.AuthoritativeLink);
            Assert.Equal(ManualReleaseLinkPhase.Saved, saved.Phase);
        }
    }

    [Theory]
    [InlineData("https://example.com/b", "Saved", "https://example.com/b")]
    // A padded value is not what this save stored, so it is someone else's write.
    [InlineData(" https://example.com/b ", "Conflict", " https://example.com/b ")]
    [InlineData("https://example.com/a", "Failed", "https://example.com/a")]
    [InlineData("https://example.com/other", "Conflict", "https://example.com/other")]
    public async Task LostPatchResponse_IsReconciledByOneReadback(
        string readback, string phase, string expectedAuthoritative)
    {
        var expectedPhase = Enum.Parse<ManualReleaseLinkPhase>(phase);
        var (controller, transport) = await LoadedAsync("https://example.com/a");
        using (controller)
        {
            controller.SetDraft("https://example.com/b");
            transport.Patches.Enqueue((_, _, _) => throw new HttpRequestException("connection reset"));
            transport.Gets.Enqueue(_ => Ok(readback));

            ManualReleaseLinkState state = await controller.SaveAsync();

            Assert.Equal(expectedPhase, state.Phase);
            Assert.Equal(expectedAuthoritative, state.AuthoritativeLink);
            Assert.Single(transport.PatchCalls);
            Assert.Equal(2, transport.Gets.History.Count);
            if (expectedPhase == ManualReleaseLinkPhase.Saved) Assert.True(state.LastSaveChanged);
            else Assert.Equal("https://example.com/b", state.Draft);
        }
    }

    [Fact]
    public async Task ClearingSave_AcceptsNullResult()
    {
        var (controller, transport) = await LoadedAsync(" https://example.com/a ");
        using (controller)
        {
            controller.SetDraft("  ");
            transport.Patches.Enqueue((_, _, _) => Ok(null, changed: true));

            ManualReleaseLinkState state = await controller.SaveAsync();

            Assert.Equal((null, " https://example.com/a "), Assert.Single(transport.PatchCalls));
            Assert.Equal(ManualReleaseLinkPhase.Saved, state.Phase);
            Assert.Null(state.AuthoritativeLink);
            Assert.Equal(string.Empty, state.Draft);
            Assert.True(state.LastSaveChanged);
            Assert.Single(transport.Gets.History);
        }
    }

    [Theory]
    [InlineData("https://example.com/wanted", "Saved", "https://example.com/wanted")]
    [InlineData("https://example.com/a", "Failed", "https://example.com/a")]
    [InlineData("https://example.com/wrong", "Conflict", "https://example.com/wrong")]
    [InlineData(null, "Uncertain", "https://example.com/a")]
    public async Task ContradictorySuccess_IsNotSaved_AndIsSettledByReadback(
        string? readback, string phase, string expectedAuthoritative)
    {
        var expectedPhase = Enum.Parse<ManualReleaseLinkPhase>(phase);
        var (controller, transport) = await LoadedAsync("https://example.com/a");
        using (controller)
        {
            var phases = new List<ManualReleaseLinkPhase>();
            controller.StateChanged += state => { lock (phases) phases.Add(state.Phase); };
            controller.SetDraft("https://example.com/wanted");
            transport.Patches.Enqueue((_, _, _) => Ok("https://example.com/wrong", changed: true));
            transport.Gets.Enqueue(_ => readback is null
                ? Task.FromResult(ManualReleaseLinkTransportResult.Ambiguous())
                : Ok(readback));

            ManualReleaseLinkState state = await controller.SaveAsync();

            Assert.Equal(expectedPhase, state.Phase);
            Assert.Equal(expectedAuthoritative, state.AuthoritativeLink);
            Assert.Equal("https://example.com/wanted", state.Draft);
            Assert.Single(transport.PatchCalls);
            Assert.Equal(2, transport.Gets.History.Count);
            if (expectedPhase == ManualReleaseLinkPhase.Saved) Assert.True(state.LastSaveChanged);
            lock (phases)
                Assert.Equal(expectedPhase == ManualReleaseLinkPhase.Saved ? 1 : 0,
                    phases.Count(observed => observed == ManualReleaseLinkPhase.Saved));
        }
    }

    [Fact]
    public async Task ContradictoryUnchangedSuccess_ForClear_IsNotSaved()
    {
        var (controller, transport) = await LoadedAsync("https://example.com/a");
        using (controller)
        {
            controller.SetDraft(string.Empty);
            transport.Patches.Enqueue((_, _, _) => Ok("https://example.com/a", changed: false));
            transport.Gets.Enqueue(_ => Ok("https://example.com/a"));

            ManualReleaseLinkState state = await controller.SaveAsync();

            Assert.Equal(ManualReleaseLinkPhase.Failed, state.Phase);
            Assert.Equal(string.Empty, state.Draft);
            Assert.Equal("https://example.com/a", state.AuthoritativeLink);
            Assert.Single(transport.PatchCalls);
        }
    }

    [Theory]
    [InlineData(" https://example.com/post ", "Failed", false)]
    [InlineData("https://example.com/post", "Saved", true)]
    [InlineData("https://example.com/other", "Conflict", false)]
    [InlineData("\thttps://example.com/post", "Conflict", false)]
    public async Task UncertainSave_ReconcilesOnExactStoredValues(string readback, string phase, bool saved)
    {
        var expectedPhase = Enum.Parse<ManualReleaseLinkPhase>(phase);
        var (controller, transport) = await LoadedAsync(" https://example.com/post ");
        using (controller)
        {
            Assert.Equal("https://example.com/post", controller.State.Draft);
            transport.Patches.Enqueue((_, _, _) => throw new HttpRequestException("connection reset"));
            transport.Gets.Enqueue(_ => Ok(readback));

            ManualReleaseLinkState state = await controller.SaveAsync();

            Assert.Equal(("https://example.com/post", " https://example.com/post "), Assert.Single(transport.PatchCalls));
            Assert.Equal(expectedPhase, state.Phase);
            Assert.Equal(readback, state.AuthoritativeLink);
            Assert.Equal("https://example.com/post", state.Draft);
            Assert.Equal(saved ? true : null, state.LastSaveChanged);
            if (expectedPhase == ManualReleaseLinkPhase.Failed)
                Assert.Equal(ManualReleaseLinkController.SaveFailedMessage, state.Message);
        }
    }

    [Fact]
    public async Task UncertainSave_FailedReadback_KeepsPaddedPreviousValueAndDraft()
    {
        var (controller, transport) = await LoadedAsync(" https://example.com/post ");
        using (controller)
        {
            transport.Patches.Enqueue((_, _, _) => Task.FromResult(ManualReleaseLinkTransportResult.Ambiguous()));
            transport.Gets.Enqueue(_ => Task.FromResult(ManualReleaseLinkTransportResult.Ambiguous()));

            ManualReleaseLinkState state = await controller.SaveAsync();

            Assert.Equal(ManualReleaseLinkPhase.Uncertain, state.Phase);
            Assert.Equal(" https://example.com/post ", state.AuthoritativeLink);
            Assert.Equal("https://example.com/post", state.Draft);

            // A later readback still holding the padded value proves the write never landed.
            transport.Gets.Enqueue(_ => Ok(" https://example.com/post "));
            ManualReleaseLinkState reloaded = await controller.LoadAsync();
            Assert.Equal(ManualReleaseLinkPhase.Failed, reloaded.Phase);
            Assert.Null(reloaded.LastSaveChanged);
            Assert.Single(transport.PatchCalls);
        }
    }

    [Theory]
    [InlineData(null, null, "Saved", false)]
    [InlineData(" https://example.com/a ", null, "Saved", true)]
    [InlineData(" https://example.com/a ", " https://example.com/a ", "Failed", null)]
    public async Task UncertainClear_ReconcilesNullExactly(
        string? loaded, string? readback, string phase, bool? changed)
    {
        var (controller, transport) = await LoadedAsync(loaded);
        using (controller)
        {
            controller.SetDraft(string.Empty);
            transport.Patches.Enqueue((_, _, _) => throw new HttpRequestException("connection reset"));
            transport.Gets.Enqueue(_ => Ok(readback));

            ManualReleaseLinkState state = await controller.SaveAsync();

            Assert.Equal((null, loaded), Assert.Single(transport.PatchCalls));
            Assert.Equal(Enum.Parse<ManualReleaseLinkPhase>(phase), state.Phase);
            Assert.Equal(readback, state.AuthoritativeLink);
            Assert.Equal(changed, state.LastSaveChanged);
            Assert.Equal(string.Empty, state.Draft);
        }
    }

    [Fact]
    public async Task FailedReadback_LeavesUncertainty_AndNextSaveReconcilesBeforeWriting()
    {
        var (controller, transport) = await LoadedAsync("https://example.com/a");
        using (controller)
        {
            controller.SetDraft("https://example.com/b");
            transport.Patches.Enqueue((_, _, _) => Task.FromResult(ManualReleaseLinkTransportResult.Ambiguous()));
            transport.Gets.Enqueue(_ => Task.FromResult(ManualReleaseLinkTransportResult.Ambiguous()));

            ManualReleaseLinkState uncertain = await controller.SaveAsync();

            Assert.Equal(ManualReleaseLinkPhase.Uncertain, uncertain.Phase);
            Assert.Equal(ManualReleaseLinkController.UncertainMessage, uncertain.Message);
            Assert.Equal("https://example.com/b", uncertain.Draft);
            Assert.Equal("https://example.com/a", uncertain.AuthoritativeLink);
            Assert.Single(transport.PatchCalls);
            Assert.Equal(2, transport.Gets.History.Count);

            // The committed write is found by readback, so no second PATCH is sent.
            transport.Gets.Enqueue(_ => Ok("https://example.com/b"));
            ManualReleaseLinkState settled = await controller.SaveAsync();

            Assert.Equal(ManualReleaseLinkPhase.Saved, settled.Phase);
            Assert.Equal("https://example.com/b", settled.AuthoritativeLink);
            Assert.Single(transport.PatchCalls);
        }
    }

    [Fact]
    public async Task UncertainSave_ProvenUncommittedOnRetry_WritesWithCurrentExpectedValue()
    {
        var (controller, transport) = await LoadedAsync("https://example.com/a");
        using (controller)
        {
            controller.SetDraft("https://example.com/b");
            transport.Patches.Enqueue((_, _, _) => Task.FromResult(ManualReleaseLinkTransportResult.Ambiguous()));
            transport.Gets.Enqueue(_ => Task.FromResult(ManualReleaseLinkTransportResult.Ambiguous()));
            await controller.SaveAsync();

            transport.Gets.Enqueue(_ => Ok("https://example.com/a"));
            transport.Patches.Enqueue((_, _, _) => Ok("https://example.com/b", true));
            ManualReleaseLinkState saved = await controller.SaveAsync();

            Assert.Equal(ManualReleaseLinkPhase.Saved, saved.Phase);
            Assert.Equal(2, transport.PatchCalls.Count);
            Assert.Equal("https://example.com/a", transport.PatchCalls[1].Expected);
        }
    }

    [Fact]
    public async Task UncertainSave_ExplicitReload_Reconciles()
    {
        var (controller, transport) = await LoadedAsync("https://example.com/a");
        using (controller)
        {
            controller.SetDraft("https://example.com/b");
            transport.Patches.Enqueue((_, _, _) => Task.FromResult(ManualReleaseLinkTransportResult.Ambiguous()));
            transport.Gets.Enqueue(_ => Task.FromResult(ManualReleaseLinkTransportResult.Ambiguous()));
            await controller.SaveAsync();

            transport.Gets.Enqueue(_ => Ok("https://example.com/b"));
            ManualReleaseLinkState state = await controller.LoadAsync();

            Assert.Equal(ManualReleaseLinkPhase.Saved, state.Phase);
            Assert.Single(transport.PatchCalls);
        }
    }

    [Theory]
    [InlineData("release_link_token_expired", ManualReleaseLinkController.ExpiredMessage)]
    [InlineData("attempt_superseded", ManualReleaseLinkController.AuthorityMessage)]
    [InlineData("release_link_token_invalid", ManualReleaseLinkController.AuthorityMessage)]
    public async Task ExpiredOrSupersededAuthority_StopsAllFurtherRequests(string code, string message)
    {
        var (controller, transport) = await LoadedAsync("https://example.com/a");
        using (controller)
        {
            controller.SetDraft("https://example.com/b");
            transport.Patches.Enqueue((_, _, _) => Task.FromResult(ManualReleaseLinkTransportResult.Rejected(code)));

            ManualReleaseLinkState state = await controller.SaveAsync();

            Assert.Equal(ManualReleaseLinkPhase.Unavailable, state.Phase);
            Assert.Equal(message, state.Message);
            Assert.Equal("https://example.com/b", state.Draft);
            Assert.False(state.CanEdit);
            await controller.LoadAsync();
            await controller.SaveAsync();
            Assert.Single(transport.PatchCalls);
            Assert.Single(transport.Gets.History);
        }
    }

    [Fact]
    public async Task UnsupportedServer_MarksEditingUnavailable_WithoutRetrying()
    {
        var transport = new ScriptedTransport();
        transport.Gets.Enqueue(_ => Task.FromResult(ManualReleaseLinkTransportResult.Unsupported()));
        using var controller = new ManualReleaseLinkController(transport);

        ManualReleaseLinkState state = await controller.LoadAsync();

        Assert.Equal(ManualReleaseLinkPhase.Unavailable, state.Phase);
        Assert.Equal(ManualReleaseLinkController.UnsupportedMessage, state.Message);
        Assert.False(state.CanEdit);
        await controller.LoadAsync();
        await controller.SaveAsync();
        Assert.Single(transport.Gets.History);
        Assert.Empty(transport.PatchCalls);
    }

    [Fact]
    public async Task NotEligible_IsUnavailable_ButAllowsExplicitReload()
    {
        var transport = new ScriptedTransport();
        transport.Gets.Enqueue(_ => Task.FromResult(ManualReleaseLinkTransportResult.Rejected("release_link_not_eligible")));
        transport.Gets.Enqueue(_ => Ok("https://example.com"));
        using var controller = new ManualReleaseLinkController(transport);

        Assert.Equal(ManualReleaseLinkController.NotEditableMessage, (await controller.LoadAsync()).Message);
        Assert.Equal(ManualReleaseLinkPhase.Ready, (await controller.LoadAsync()).Phase);
    }

    [Fact]
    public async Task DisposeDuringSave_CancelsRequest_IgnoresLateResult_AndStopsNotifications()
    {
        var (controller, transport) = await LoadedAsync("https://example.com/a");
        var gate = new TaskCompletionSource<ManualReleaseLinkTransportResult>(TaskCreationOptions.RunContinuationsAsynchronously);
        var sent = new TaskCompletionSource<CancellationToken>(TaskCreationOptions.RunContinuationsAsynchronously);
        transport.Patches.Enqueue((_, _, token) => { sent.TrySetResult(token); return gate.Task; });
        int notifications = 0;
        controller.StateChanged += _ => Interlocked.Increment(ref notifications);
        controller.SetDraft("https://example.com/b");
        Task<ManualReleaseLinkState> saving = controller.SaveAsync();
        CancellationToken observed = await sent.Task.WaitAsync(TimeSpan.FromSeconds(2));
        int before = Volatile.Read(ref notifications);

        controller.Dispose();
        Assert.True(observed.IsCancellationRequested);
        Assert.Equal(1, transport.DisposeCalls);
        gate.SetResult(ManualReleaseLinkTransportResult.Authoritative("https://example.com/b", true));
        ManualReleaseLinkState final = await saving.WaitAsync(TimeSpan.FromSeconds(2));

        Assert.Equal("https://example.com/a", final.AuthoritativeLink);
        Assert.Equal(before, Volatile.Read(ref notifications));
        Assert.Equal(ManualReleaseLinkPhase.Saving, controller.State.Phase);
        await controller.LoadAsync();
        await controller.SaveAsync();
        Assert.Single(transport.Gets.History);
        Assert.Single(transport.PatchCalls);
        controller.Dispose();
        Assert.Equal(1, transport.DisposeCalls);
    }

    [Fact]
    public async Task SubscriberThatDisposes_StopsLaterSubscribers()
    {
        var (controller, transport) = await LoadedAsync("https://example.com/a");
        int first = 0, second = 0;
        controller.StateChanged += _ => { Interlocked.Increment(ref first); controller.Dispose(); };
        controller.StateChanged += _ => Interlocked.Increment(ref second);

        controller.SetDraft("https://example.com/b");

        Assert.Equal(1, first);
        Assert.Equal(0, second);
        Assert.Equal(1, transport.DisposeCalls);
        controller.SetDraft("https://example.com/c");
        Assert.Equal(1, first);
    }

    [Fact]
    public async Task SubscriberThatDisposesOnRequestResult_StopsLaterSubscribers_WithoutDeadlock()
    {
        var (controller, transport) = await LoadedAsync("https://example.com/a");
        var seen = new List<ManualReleaseLinkPhase>();
        controller.StateChanged += state => { if (state.Phase == ManualReleaseLinkPhase.Saved) controller.Dispose(); };
        controller.StateChanged += state => { lock (seen) seen.Add(state.Phase); };
        controller.SetDraft("https://example.com/b");
        transport.Patches.Enqueue((_, _, _) => Ok("https://example.com/b", true));

        ManualReleaseLinkState state = await controller.SaveAsync().WaitAsync(TimeSpan.FromSeconds(5));

        Assert.Equal(ManualReleaseLinkPhase.Saved, state.Phase);
        lock (seen) Assert.DoesNotContain(ManualReleaseLinkPhase.Saved, seen);
        Assert.Equal(1, transport.DisposeCalls);
    }

    [Fact]
    public async Task ReentrantNotificationThatDisposes_StopsOuterDelivery_WithoutDeadlock()
    {
        var (controller, _) = await LoadedAsync("https://example.com/a");
        var delivered = new List<string>();
        controller.StateChanged += state =>
        {
            if (state.Draft == "https://example.com/outer") controller.SetDraft("https://example.com/nested");
        };
        controller.StateChanged += state =>
        {
            lock (delivered) delivered.Add(state.Draft);
            if (state.Draft == "https://example.com/nested") controller.Dispose();
        };

        await Task.Run(() => controller.SetDraft("https://example.com/outer")).WaitAsync(TimeSpan.FromSeconds(5));

        lock (delivered) Assert.Equal(new[] { "https://example.com/nested" }, delivered);
    }

    [Fact]
    public async Task DisposeFromAnotherThread_WaitsForRunningSubscriber_AndNoneRunAfterwards()
    {
        var (controller, _) = await LoadedAsync("https://example.com/a");
        using var entered = new ManualResetEventSlim();
        using var release = new ManualResetEventSlim();
        int disposed = 0, lateCalls = 0, secondCalls = 0, firstExitedAfterDispose = 0;
        controller.StateChanged += _ =>
        {
            if (Volatile.Read(ref disposed) == 1) Interlocked.Increment(ref lateCalls);
            entered.Set();
            release.Wait(TimeSpan.FromSeconds(5));
            if (Volatile.Read(ref disposed) == 1) Interlocked.Increment(ref firstExitedAfterDispose);
        };
        controller.StateChanged += _ =>
        {
            Interlocked.Increment(ref secondCalls);
            if (Volatile.Read(ref disposed) == 1) Interlocked.Increment(ref lateCalls);
        };

        Task notifying = Task.Run(() => controller.SetDraft("https://example.com/b"));
        Assert.True(entered.Wait(TimeSpan.FromSeconds(5)));
        Task disposing = Task.Run(() => { controller.Dispose(); Volatile.Write(ref disposed, 1); });
        await Task.Delay(50);
        Assert.False(disposing.IsCompleted);
        release.Set();
        await Task.WhenAll(notifying, disposing).WaitAsync(TimeSpan.FromSeconds(5));

        Assert.Equal(0, firstExitedAfterDispose);
        Assert.Equal(0, secondCalls);
        Assert.Equal(0, lateCalls);
    }

    [Fact]
    public async Task ConcurrentDispose_NeverDeliversAfterDisposeReturns()
    {
        for (int round = 0; round < 100; round++)
        {
            var (controller, _) = await LoadedAsync("https://example.com/a");
            int disposed = 0, late = 0;
            for (int i = 0; i < 3; i++)
                controller.StateChanged += _ => { if (Volatile.Read(ref disposed) == 1) Interlocked.Increment(ref late); };
            using var start = new ManualResetEventSlim();
            Task editing = Task.Run(() =>
            {
                start.Wait();
                for (int i = 0; i < 200; i++) controller.SetDraft($"https://example.com/{i}");
            });
            Task disposing = Task.Run(() => { start.Wait(); controller.Dispose(); Volatile.Write(ref disposed, 1); });
            start.Set();
            await Task.WhenAll(editing, disposing).WaitAsync(TimeSpan.FromSeconds(5));
            Assert.Equal(0, late);
        }
    }

    [Fact]
    public async Task CancelledRequestAfterDispose_DoesNotNotify()
    {
        var transport = new ScriptedTransport();
        var observed = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        transport.Gets.Enqueue(async token =>
        {
            observed.TrySetResult();
            await Task.Delay(Timeout.Infinite, token);
            return ManualReleaseLinkTransportResult.Ambiguous();
        });
        var controller = new ManualReleaseLinkController(transport);
        int notifications = 0;
        Task<ManualReleaseLinkState> loading = controller.LoadAsync();
        await observed.Task.WaitAsync(TimeSpan.FromSeconds(5));
        controller.StateChanged += _ => Interlocked.Increment(ref notifications);

        controller.Dispose();
        ManualReleaseLinkState final = await loading.WaitAsync(TimeSpan.FromSeconds(5));

        Assert.Equal(ManualReleaseLinkPhase.Loading, final.Phase);
        Assert.Equal(0, Volatile.Read(ref notifications));
    }

    [Fact]
    public async Task CallerCancellationDuringPatch_IsUncertain_NotFailure()
    {
        var (controller, transport) = await LoadedAsync("https://example.com/a");
        using (controller)
        {
            using var cancellation = new CancellationTokenSource();
            transport.Patches.Enqueue(async (_, _, token) =>
            {
                cancellation.Cancel();
                await Task.Delay(Timeout.Infinite, token);
                return ManualReleaseLinkTransportResult.Ambiguous();
            });
            controller.SetDraft("https://example.com/b");

            ManualReleaseLinkState state = await controller.SaveAsync(cancellation.Token);

            Assert.Equal(ManualReleaseLinkPhase.Uncertain, state.Phase);
            Assert.Single(transport.Gets.History);
        }
    }

    [Fact]
    public async Task StateChanged_ReportsRequestTransitions()
    {
        var transport = new ScriptedTransport();
        transport.Gets.Enqueue(_ => Ok("https://example.com"));
        using var controller = new ManualReleaseLinkController(transport);
        var phases = new List<ManualReleaseLinkPhase>();
        controller.StateChanged += state => { lock (phases) phases.Add(state.Phase); };

        await controller.LoadAsync();

        await WaitUntilAsync(() => { lock (phases) return phases.Count == 2; });
        Assert.Equal(new[] { ManualReleaseLinkPhase.Loading, ManualReleaseLinkPhase.Ready }, phases);
    }

    [Fact]
    public void DisplayModel_HasNoAuthorityMaterial()
    {
        string[] names = typeof(ManualReleaseLinkState).GetProperties(
            System.Reflection.BindingFlags.Instance | System.Reflection.BindingFlags.Public | System.Reflection.BindingFlags.NonPublic)
            .Select(property => property.Name).ToArray();
        Assert.DoesNotContain(names, name =>
            name.Contains("Token", StringComparison.OrdinalIgnoreCase) ||
            name.Contains("Bearer", StringComparison.OrdinalIgnoreCase) ||
            name.Contains("Capability", StringComparison.OrdinalIgnoreCase) ||
            name.Contains("Session", StringComparison.OrdinalIgnoreCase));
    }

    private static async Task<(ManualReleaseLinkController Controller, ScriptedTransport Transport)> LoadedAsync(string? link)
    {
        var transport = new ScriptedTransport();
        transport.Gets.Enqueue(_ => Ok(link));
        var controller = new ManualReleaseLinkController(transport);
        Assert.Equal(ManualReleaseLinkPhase.Ready, (await controller.LoadAsync()).Phase);
        return (controller, transport);
    }

    private static Task<ManualReleaseLinkTransportResult> Ok(string? link, bool? changed = null) =>
        Task.FromResult(ManualReleaseLinkTransportResult.Authoritative(link, changed));

    private static async Task WaitUntilAsync(Func<bool> condition)
    {
        using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(2));
        while (!condition()) await Task.Delay(10, timeout.Token);
    }
}

internal sealed class ScriptedQueue<T>
{
    private readonly Queue<T> _items = new();
    internal List<T> History { get; } = [];
    internal void Enqueue(T item) { lock (_items) _items.Enqueue(item); }
    internal T Dequeue()
    {
        lock (_items)
        {
            T item = _items.Count > 0 ? _items.Dequeue() : throw new InvalidOperationException("No scripted response.");
            History.Add(item);
            return item;
        }
    }
}

internal sealed class ScriptedTransport : IManualReleaseLinkTransport
{
    internal ScriptedQueue<Func<CancellationToken, Task<ManualReleaseLinkTransportResult>>> Gets { get; } = new();
    internal ScriptedQueue<Func<string?, string?, CancellationToken, Task<ManualReleaseLinkTransportResult>>> Patches { get; } = new();
    internal List<(string? Link, string? Expected)> PatchCalls { get; } = [];
    internal int DisposeCalls { get; private set; }

    public Task<ManualReleaseLinkTransportResult> GetAsync(CancellationToken cancellationToken) =>
        Gets.Dequeue()(cancellationToken);

    public Task<ManualReleaseLinkTransportResult> PatchAsync(
        string? releaseLink, string? expectedReleaseLink, CancellationToken cancellationToken)
    {
        lock (PatchCalls) PatchCalls.Add((releaseLink, expectedReleaseLink));
        return Patches.Dequeue()(releaseLink, expectedReleaseLink, cancellationToken);
    }

    public void Dispose() => DisposeCalls++;
}

public sealed class ManualReleaseLinkOrchestrationTests
{
    private static readonly SocialUriRequest Request = new(
        SocialUriRequestParser.ManualVersion,
        new Uri("https://creatorcrate.test/"),
        new string('a', 43));

    [Fact]
    public async Task ReleaseLinkLoadsAfterReady_UnsupportedServerLeavesPostingUsable_AndBothControllersAreDisposed()
    {
        var runtime = new Runtime();
        runtime.ReleaseLinkTransport.Gets.Enqueue(_ =>
        {
            lock (runtime.Patches) runtime.PatchesAtFirstLinkRead = runtime.Patches.ToArray();
            return Task.FromResult(ManualReleaseLinkTransportResult.Unsupported());
        });
        var companion = new Companion();
        Task<ManualSocialPreparationResult> run = new ManualSocialPreparationOrchestrator(() => runtime, companion).RunAsync(Request);

        await WaitUntilAsync(() => companion.ReleaseLink?.State.Phase == ManualReleaseLinkPhase.Unavailable);
        Assert.Equal(new[] { "staging", "ready" }, runtime.PatchesAtFirstLinkRead);
        Assert.Same(runtime.PostingConfirmation, companion.PostingConfirmation);
        Assert.Same(runtime.ReleaseLink, companion.ReleaseLink);

        ManualPostingPlatformState posted = await companion.PostingConfirmation!.ConfirmAsync("x");
        Assert.Equal(ManualPostingConfirmationStatus.Posted, posted.Status);
        Assert.Equal(1, runtime.ConfirmationTransport.PostCalls);
        Assert.False(run.IsCompleted);

        companion.Close();
        ManualSocialPreparationResult result = await run.WaitAsync(TimeSpan.FromSeconds(2));

        Assert.True(result.Success);
        Assert.Equal(1, runtime.ReleaseLinkTransport.DisposeCalls);
        Assert.Equal(1, runtime.ConfirmationTransport.DisposeCalls);
        Assert.Single(runtime.ReleaseLinkTransport.Gets.History);
        Assert.Empty(runtime.ReleaseLinkTransport.PatchCalls);
        Assert.Equal(new[] { "staging", "ready" }, runtime.Patches);
    }

    [Fact]
    public async Task CloseDuringPendingLoad_DisposesControllerAndCancelsRequest()
    {
        var runtime = new Runtime();
        var observed = new TaskCompletionSource<CancellationToken>(TaskCreationOptions.RunContinuationsAsynchronously);
        runtime.ReleaseLinkTransport.Gets.Enqueue(async token =>
        {
            observed.TrySetResult(token);
            await Task.Delay(Timeout.Infinite, token);
            return ManualReleaseLinkTransportResult.Ambiguous();
        });
        var companion = new Companion();
        Task<ManualSocialPreparationResult> run = new ManualSocialPreparationOrchestrator(() => runtime, companion).RunAsync(Request);
        CancellationToken token = await observed.Task.WaitAsync(TimeSpan.FromSeconds(2));

        companion.Close();
        ManualSocialPreparationResult result = await run.WaitAsync(TimeSpan.FromSeconds(2));

        Assert.True(result.Success);
        Assert.True(token.IsCancellationRequested);
        Assert.Equal(1, runtime.ReleaseLinkTransport.DisposeCalls);
        Assert.Equal(ManualPostingConfirmationStatus.Ready, companion.PostingConfirmation!.GetState("x").Status);
    }

    [Fact]
    public async Task ReleaseLinkProviderFailure_FallsBackToPostingConfirmationCompanion()
    {
        var runtime = new Runtime { FailReleaseLink = true };
        var companion = new Companion();
        Task<ManualSocialPreparationResult> run = new ManualSocialPreparationOrchestrator(() => runtime, companion).RunAsync(Request);
        await WaitUntilAsync(() => companion.PostingConfirmation is not null);

        Assert.Null(companion.ReleaseLink);
        companion.Close();
        Assert.True((await run.WaitAsync(TimeSpan.FromSeconds(2))).Success);
    }

    private static async Task WaitUntilAsync(Func<bool> condition)
    {
        using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(2));
        while (!condition()) await Task.Delay(10, timeout.Token);
    }

    private sealed class Companion :
        IManualSocialCompanion, IManualPostingConfirmationCompanion, IManualReleaseLinkCompanion
    {
        private readonly TaskCompletionSource _closed = new(TaskCreationOptions.RunContinuationsAsynchronously);
        private IDisposable? _lease;
        public ManualPostingConfirmationController? PostingConfirmation { get; private set; }
        public ManualReleaseLinkController? ReleaseLink { get; private set; }

        public IManualSocialCompanionLifetime Open(
            ManualSocialSession session, IDisposable mediaLease, IManualAssetAvailability availability) =>
            throw new InvalidOperationException("Controller composition was not used.");

        public IManualSocialCompanionLifetime OpenWithPostingConfirmation(
            ManualSocialSession session, IDisposable mediaLease, IManualAssetAvailability availability,
            IManualAssetPreviewAccess? previewAccess, ManualPostingConfirmationController confirmation)
        {
            PostingConfirmation = confirmation;
            return Lifetime(mediaLease, previewAccess);
        }

        public IManualSocialCompanionLifetime OpenWithReleaseLink(
            ManualSocialSession session, IDisposable mediaLease, IManualAssetAvailability availability,
            IManualAssetPreviewAccess? previewAccess, ManualPostingConfirmationController? confirmation,
            ManualReleaseLinkController releaseLink)
        {
            PostingConfirmation = confirmation;
            ReleaseLink = releaseLink;
            return Lifetime(mediaLease, previewAccess);
        }

        public void Close() { _lease?.Dispose(); _closed.TrySetResult(); }

        private IManualSocialCompanionLifetime Lifetime(IDisposable lease, IManualAssetPreviewAccess? previewAccess)
        {
            previewAccess?.Dispose();
            _lease = lease;
            return new CompanionLifetime(_closed.Task, Close);
        }

        private sealed class CompanionLifetime(Task closed, Action close) : IManualSocialCompanionLifetime
        {
            public Task Ready => Task.CompletedTask;
            public Task Closed => closed;
            public void Dispose() => close();
        }
    }

    private sealed class Runtime :
        IManualSocialPreparationRuntime, IManualPostingConfirmationProvider, IManualReleaseLinkProvider
    {
        public bool FailReleaseLink { get; init; }
        public List<string> Patches { get; } = [];
        public string[]? PatchesAtFirstLinkRead { get; set; }
        public ScriptedTransport ReleaseLinkTransport { get; } = new();
        public PostingTransport ConfirmationTransport { get; } = new();
        public ManualPostingConfirmationController? PostingConfirmation { get; private set; }
        public ManualReleaseLinkController? ReleaseLink { get; private set; }

        public Task<SocialRedeemResult> RedeemAsync(SocialUriRequest request, CancellationToken cancellationToken) =>
            Task.FromResult(SocialRedeemResult.Ok(new SocialRedeemResponse(
                Guid.NewGuid().ToString(), new DateTime(2026, 9, 13, 12, 0, 0),
                [new SocialRedeemPlatform("x", "Release", "Post", [])], new string('b', 43)) { ReleaseId = 42 }));

        public Task<SocialPlatformStatusResult> PatchAsync(
            SocialCapability capability, string platform, string status, string? detailCode,
            string? message, CancellationToken cancellationToken)
        {
            lock (Patches) Patches.Add(status);
            return Task.FromResult(SocialPlatformStatusResult.Ok(new(platform, status, detailCode, 1, null)));
        }

        public Task<StagedMedia> StageAssetAsync(
            SocialCapability capability, SocialRedeemAsset asset, int ordinal, CancellationToken cancellationToken) =>
            throw new InvalidOperationException("No assets are staged.");

        public Task<StagedMedia> EnsureAssetAvailableAsync(
            SocialCapability capability, SocialRedeemAsset asset, int ordinal, StagedMedia media,
            CancellationToken cancellationToken) => Task.FromResult(media);

        public Task CleanupMediaAsync(SocialCapability capability) => Task.CompletedTask;

        public IDisposable DetachMediaLease(SocialCapability capability) => new Lease();

        ManualPostingConfirmationController IManualPostingConfirmationProvider.CreatePostingConfirmation(
            SocialCapability capability, IReadOnlyList<string> platforms) =>
            PostingConfirmation = new ManualPostingConfirmationController(ConfirmationTransport, platforms);

        ManualReleaseLinkController IManualReleaseLinkProvider.CreateReleaseLink(SocialCapability capability) =>
            FailReleaseLink
                ? throw new InvalidOperationException("release link unavailable")
                : ReleaseLink = new ManualReleaseLinkController(ReleaseLinkTransport);

        public ValueTask DisposeAsync() => ValueTask.CompletedTask;

        private sealed class Lease : IDisposable { public void Dispose() { } }
    }

    private sealed class PostingTransport : IManualPostingConfirmationTransport
    {
        public DateTime? ConfirmationExpiresAt => null;
        public int PostCalls { get; private set; }
        public int DisposeCalls { get; private set; }

        public Task<ManualPostingTransportResult> PostAsync(string platform, CancellationToken cancellationToken)
        {
            PostCalls++;
            return Task.FromResult(ManualPostingTransportResult.Authoritative(new ManualPostingConfirmationResponse(
                platform, "posted", new DateTime(2030, 1, 1), new ManualPostingCompletion(1, 1, true))));
        }

        public Task<ManualPostingTransportResult> GetAsync(string platform, CancellationToken cancellationToken) =>
            Task.FromResult(ManualPostingTransportResult.Ambiguous());

        public void Dispose() => DisposeCalls++;
    }
}
