using System.Net;
using System.Text;
using OpenLocally;

namespace OpenLocally.Tests;

public sealed class ManualPostingConfirmationClientTests
{
    private const string Token = "sentinel-bearer-aaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    private const string SessionId = "00000000-0000-0000-0000-000000000001";
    private static readonly SocialCapability Capability = new(SessionId, Token);

    [Fact]
    public void ManualSessionBoundary_DoesNotExposeConfirmationAuthority()
    {
        string[] propertyNames = typeof(ManualSocialSession).GetProperties().Select(property => property.Name).ToArray();

        Assert.DoesNotContain(propertyNames, name =>
            name.Contains("Token", StringComparison.OrdinalIgnoreCase) ||
            name.Contains("Bearer", StringComparison.OrdinalIgnoreCase) ||
            name.Contains("Capability", StringComparison.OrdinalIgnoreCase) ||
            name.Contains("SessionId", StringComparison.OrdinalIgnoreCase));
        Assert.DoesNotContain(Token, new ManualSocialSession(
            new Uri("https://creatorcrate.test/"), 42, "Release", []).ToString());
    }

    [Fact]
    public async Task PostAndGet_UseExactAuthenticatedContract_AndPostHasNoContent()
    {
        var handler = new RecordingHandler((request, call) => Json(HttpStatusCode.OK,
            call == 1 ? Posted("x", "2030-01-01 00:10:00", 1, 3, false) : Ready("x", 1, 3)));
        using var client = CreateClient(handler);

        ManualPostingTransportResult posted = await client.PostAsync("x", CancellationToken.None);
        ManualPostingTransportResult read = await client.GetAsync("x", CancellationToken.None);

        Assert.Equal(ManualPostingTransportOutcome.Authoritative, posted.Outcome);
        Assert.Equal(new DateTime(2030, 1, 1, 0, 10, 0), posted.Response!.PostedAt);
        Assert.Equal(ManualPostingTransportOutcome.Authoritative, read.Outcome);
        Assert.Collection(handler.Requests,
            request =>
            {
                Assert.Equal(HttpMethod.Post, request.Method);
                Assert.Equal($"/social-prep/{SessionId}/platforms/x/posted", request.Path);
                Assert.Equal($"Bearer {Token}", request.Authorization);
                Assert.Null(request.ContentType);
                Assert.Empty(request.Body);
                Assert.False(request.HadContent);
                Assert.Null(request.TransferEncodingChunked);
            },
            request =>
            {
                Assert.Equal(HttpMethod.Get, request.Method);
                Assert.Equal($"/social-prep/{SessionId}/platforms/x/posted", request.Path);
                Assert.Equal($"Bearer {Token}", request.Authorization);
                Assert.Empty(request.Body);
            });
    }

    [Fact]
    public async Task InvalidOrSecretServerFailure_IsReducedToBoundedReasonCode()
    {
        const string secret = "sentinel-secret-server-payload";
        var handler = new RecordingHandler((_, _) => Json(HttpStatusCode.Forbidden,
            $"{{\"ok\":false,\"error\":{{\"code\":\"{secret}\",\"message\":\"{secret} {Token}\"}}}}"));
        using var client = CreateClient(handler);

        ManualPostingTransportResult result = await client.PostAsync("x", CancellationToken.None);

        Assert.Equal(ManualPostingTransportOutcome.Rejected, result.Outcome);
        Assert.Equal("confirmation_rejected", result.ErrorCode);
        Assert.DoesNotContain(secret, result.ErrorCode!);
        Assert.DoesNotContain(Token, result.ErrorCode!);
    }

    [Fact]
    public async Task TransportFailureAndMalformedSuccess_AreAmbiguous()
    {
        var throwing = new RecordingHandler((_, _) => throw new HttpRequestException($"lost {Token}"));
        using var first = CreateClient(throwing);
        Assert.Equal(ManualPostingTransportOutcome.Ambiguous,
            (await first.PostAsync("x", CancellationToken.None)).Outcome);

        var malformed = new RecordingHandler((_, _) => Json(HttpStatusCode.OK, $"{{\"secret\":\"{Token}\"}}"));
        using var second = CreateClient(malformed);
        ManualPostingTransportResult result = await second.GetAsync("x", CancellationToken.None);
        Assert.Equal(ManualPostingTransportOutcome.Ambiguous, result.Outcome);
        Assert.DoesNotContain(Token, result.ErrorCode ?? string.Empty);
    }

    [Theory]
    [InlineData(0, 0, false)]
    [InlineData(1, 3, false)]
    [InlineData(2, 3, false)]
    [InlineData(3, 3, true)]
    public async Task ConsistentCompletionAggregates_AreAuthoritative(int posted, int total, bool complete)
    {
        var handler = new RecordingHandler((_, _) => Json(
            HttpStatusCode.OK, Posted("x", "2030-01-01 00:10:00", posted, total, complete)));
        using var client = CreateClient(handler);

        ManualPostingTransportResult result = await client.PostAsync("x", CancellationToken.None);

        Assert.Equal(ManualPostingTransportOutcome.Authoritative, result.Outcome);
        Assert.Equal(new ManualPostingCompletion(posted, total, complete), result.Response!.Completion);
    }

    [Theory]
    [InlineData(-1, 3, false)]
    [InlineData(0, -1, false)]
    [InlineData(4, 3, false)]
    [InlineData(1, 3, true)]
    [InlineData(3, 3, false)]
    [InlineData(0, 0, true)]
    public async Task InvalidOrContradictoryCompletionAggregates_AreAmbiguous(
        int posted, int total, bool complete)
    {
        var handler = new RecordingHandler((_, _) => Json(
            HttpStatusCode.OK, Posted("x", "2030-01-01 00:10:00", posted, total, complete)));
        using var client = CreateClient(handler);

        ManualPostingTransportResult result = await client.PostAsync("x", CancellationToken.None);

        Assert.Equal(ManualPostingTransportOutcome.Ambiguous, result.Outcome);
        Assert.Null(result.Response);
    }

    [Fact]
    public async Task NonIntegerCompletionCount_IsAmbiguous()
    {
        string body = Posted("x", "2030-01-01 00:10:00", 1, 3, false)
            .Replace("\"postedCount\":1", "\"postedCount\":1.5", StringComparison.Ordinal);
        var handler = new RecordingHandler((_, _) => Json(HttpStatusCode.OK, body));
        using var client = CreateClient(handler);

        ManualPostingTransportResult result = await client.GetAsync("x", CancellationToken.None);

        Assert.Equal(ManualPostingTransportOutcome.Ambiguous, result.Outcome);
        Assert.Null(result.Response);
    }

    private static ManualPostingConfirmationClient CreateClient(HttpMessageHandler handler)
    {
        var resolver = new Resolver();
        Assert.True(SocialOrigin.TryParse("https://creatorcrate.test", out SocialOrigin? origin));
        return new ManualPostingConfirmationClient(
            new SocialHttpClient(resolver, () => handler),
            new OriginTrustService(new TrustedStore(), new AllowPrompt(), resolver),
            origin!, Capability, new DateTime(2030, 1, 2));
    }

    private static HttpResponseMessage Json(HttpStatusCode status, string json) => new(status)
    {
        Content = new StringContent(json, Encoding.UTF8, "application/json"),
    };

    internal static string Posted(string platform, string at, int posted, int total, bool complete) =>
        $"{{\"ok\":true,\"sessionId\":\"{SessionId}\",\"platform\":\"{platform}\",\"status\":\"posted\",\"postedAt\":\"{at}\",\"completion\":{{\"postedCount\":{posted},\"totalCount\":{total},\"isComplete\":{complete.ToString().ToLowerInvariant()}}}}}";

    internal static string Ready(string platform, int posted, int total) =>
        $"{{\"ok\":true,\"sessionId\":\"{SessionId}\",\"platform\":\"{platform}\",\"status\":\"ready\",\"postedAt\":null,\"completion\":{{\"postedCount\":{posted},\"totalCount\":{total},\"isComplete\":false}}}}";

    private sealed class RecordingHandler(Func<HttpRequestMessage, int, HttpResponseMessage> respond) : HttpMessageHandler
    {
        private int _calls;
        internal List<CapturedRequest> Requests { get; } = [];

        protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
        {
            byte[] body = request.Content is null
                ? [] : await request.Content.ReadAsByteArrayAsync(cancellationToken);
            Requests.Add(new CapturedRequest(
                request.Method, request.RequestUri!.AbsolutePath,
                request.Headers.Authorization?.ToString(), request.Content is not null,
                request.Content?.Headers.ContentType?.ToString(), request.Headers.TransferEncodingChunked, body));
            return respond(request, Interlocked.Increment(ref _calls));
        }
    }

    private sealed record CapturedRequest(
        HttpMethod Method, string Path, string? Authorization, bool HadContent, string? ContentType,
        bool? TransferEncodingChunked, byte[] Body);
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

public sealed class ManualPostingConfirmationControllerTests
{
    [Fact]
    public async Task Success_UpdatesOnlyCapturedPlatform_AndUsesCanonicalTimestampAndAggregate()
    {
        var transport = new FakeTransport
        {
            Post = async (platform, token) =>
            {
                await Task.Yield();
                return Authoritative(platform, "posted", new DateTime(2030, 1, 1, 0, 10, 0), 1, 3, false);
            },
        };
        using var controller = Controller(transport);

        Task<ManualPostingPlatformState> confirming = controller.ConfirmAsync("x");
        Assert.Equal(ManualPostingConfirmationStatus.Confirming, controller.GetState("x").Status);
        Assert.Equal(ManualPostingConfirmationStatus.Ready, controller.GetState("patreon").Status);
        ManualPostingPlatformState result = await confirming;

        Assert.Equal(ManualPostingConfirmationStatus.Posted, result.Status);
        Assert.Equal(new DateTime(2030, 1, 1, 0, 10, 0), result.PostedAt);
        Assert.Equal(new ManualPostingCompletion(1, 3, false), controller.Completion);
        Assert.Equal(ManualPostingConfirmationStatus.Ready, controller.GetState("patreon").Status);
    }

    [Fact]
    public async Task PlatformSwitchAndDuplicateRequest_CannotRetargetOrDuplicatePost()
    {
        var held = new TaskCompletionSource<ManualPostingTransportResult>(TaskCreationOptions.RunContinuationsAsynchronously);
        var transport = new FakeTransport { Post = (_, _) => held.Task };
        using var controller = Controller(transport);

        Task<ManualPostingPlatformState> first = controller.ConfirmAsync("x");
        _ = controller.GetState("patreon"); // conceptual UI selection changed while X is pending
        Task<ManualPostingPlatformState> duplicate = controller.ConfirmAsync("x");

        Assert.Same(first, duplicate);
        Assert.Equal(1, transport.PostCalls);
        held.SetResult(Authoritative("x", "posted", new DateTime(2030, 1, 1, 0, 20, 0), 1, 3, false));
        await first;
        Assert.Equal(ManualPostingConfirmationStatus.Posted, controller.GetState("x").Status);
        Assert.Equal(ManualPostingConfirmationStatus.Ready, controller.GetState("patreon").Status);
    }

    [Fact]
    public async Task LostPost_ReconcilesPostedOrReady_WithoutFalseSuccess()
    {
        var postedTransport = new FakeTransport
        {
            Post = (_, _) => Task.FromResult(ManualPostingTransportResult.Ambiguous()),
            Get = (platform, _) => Task.FromResult(Authoritative(
                platform, "posted", new DateTime(2030, 1, 1, 0, 30, 0), 2, 3, false)),
        };
        using var postedController = Controller(postedTransport);
        ManualPostingPlatformState posted = await postedController.ConfirmAsync("x");
        Assert.Equal(ManualPostingConfirmationStatus.Posted, posted.Status);
        Assert.Equal(new ManualPostingCompletion(2, 3, false), postedController.Completion);

        var readyTransport = new FakeTransport
        {
            Post = (_, _) => Task.FromResult(ManualPostingTransportResult.Ambiguous()),
            Get = (platform, _) => Task.FromResult(Authoritative(platform, "ready", null, 1, 3, false)),
        };
        using var readyController = Controller(readyTransport);
        ManualPostingPlatformState ready = await readyController.ConfirmAsync("x");
        Assert.Equal(ManualPostingConfirmationStatus.Ready, ready.Status);
        Assert.Null(ready.PostedAt);
        Assert.Equal(new ManualPostingCompletion(1, 3, false), readyController.Completion);
    }

    [Fact]
    public async Task DoubleNetworkFailure_IsUnknown_AndRetryReconcilesBeforeIdempotentPost()
    {
        int reads = 0;
        int posts = 0;
        var transport = new FakeTransport
        {
            Post = (platform, _) => Task.FromResult(transportPost(platform)),
            Get = (platform, _) => Task.FromResult(++reads == 1
                ? ManualPostingTransportResult.Ambiguous()
                : reads == 2
                    ? Authoritative(platform, "ready", null, 0, 3, false)
                    : Authoritative(platform, "posted", new DateTime(2030, 1, 1, 0, 40, 0), 1, 3, false)),
        };
        ManualPostingTransportResult transportPost(string platform) => ++posts == 1
            ? ManualPostingTransportResult.Ambiguous()
            : Authoritative(platform, "posted", new DateTime(2030, 1, 1, 0, 40, 0), 1, 3, false);
        using var controller = Controller(transport);

        ManualPostingPlatformState unknown = await controller.ConfirmAsync("x");
        Assert.Equal(ManualPostingConfirmationStatus.ConfirmationUnknown, unknown.Status);
        Assert.Equal(ManualPostingConfirmationController.RetryReason, unknown.Reason);
        Assert.Null(unknown.PostedAt);

        ManualPostingPlatformState retried = await controller.ConfirmAsync("x");
        Assert.Equal(ManualPostingConfirmationStatus.Posted, retried.Status);
        Assert.Equal(2, transport.PostCalls);
        Assert.Equal(2, transport.GetCalls);
    }

    [Fact]
    public async Task Retry_RemainsConfirmingAfterReadyReconciliationWhilePostIsPending()
    {
        var firstPost = new TaskCompletionSource<ManualPostingTransportResult>(TaskCreationOptions.RunContinuationsAsynchronously);
        var retryPost = new TaskCompletionSource<ManualPostingTransportResult>(TaskCreationOptions.RunContinuationsAsynchronously);
        int posts = 0, reads = 0;
        var transport = new FakeTransport
        {
            Post = (platform, _) => Interlocked.Increment(ref posts) == 1 ? firstPost.Task : retryPost.Task,
            Get = (platform, _) => Task.FromResult(Interlocked.Increment(ref reads) == 1
                ? ManualPostingTransportResult.Ambiguous()
                : Authoritative(platform, "ready", null, 0, 3, false)),
        };
        using var controller = Controller(transport);

        Task<ManualPostingPlatformState> first = controller.ConfirmAsync("x");
        firstPost.SetResult(ManualPostingTransportResult.Ambiguous());
        Assert.Equal(ManualPostingConfirmationStatus.ConfirmationUnknown, (await first).Status);

        Task<ManualPostingPlatformState> retry = controller.ConfirmAsync("x");
        Assert.Equal(ManualPostingConfirmationStatus.Confirming, controller.GetState("x").Status);
        retryPost.SetResult(Authoritative("x", "posted", new DateTime(2030, 1, 1), 1, 3, false));
        Assert.Equal(ManualPostingConfirmationStatus.Posted, (await retry).Status);
    }

    [Theory]
    [InlineData("confirmation_token_expired", ManualPostingConfirmationController.ExpiredReason)]
    [InlineData("confirmation_target_not_owned", ManualPostingConfirmationController.RejectedReason)]
    public async Task DefiniteRejection_ReturnsReadyWithFixedReason(string code, string expectedReason)
    {
        var transport = new FakeTransport
        {
            Post = (_, _) => Task.FromResult(ManualPostingTransportResult.Rejected(code)),
        };
        using var controller = Controller(transport);

        ManualPostingPlatformState result = await controller.ConfirmAsync("x");

        Assert.Equal(ManualPostingConfirmationStatus.Ready, result.Status);
        Assert.Equal(expectedReason, result.Reason);
        Assert.Null(result.PostedAt);
    }

    [Fact]
    public async Task AggregateAlwaysUsesLatestServerResponse_IncludingConfiguredPlatformsOutsideSession()
    {
        var aggregates = new Queue<(int Posted, int Total, bool Complete)>(
            [(1, 3, false), (2, 3, false), (3, 3, true)]);
        var transport = new FakeTransport
        {
            Post = (platform, _) =>
            {
                var aggregate = aggregates.Dequeue();
                return Task.FromResult(Authoritative(
                    platform, "posted", new DateTime(2030, 1, 1),
                    aggregate.Posted, aggregate.Total, aggregate.Complete));
            },
        };
        using var controller = new ManualPostingConfirmationController(transport, ["x", "patreon", "bluesky"]);

        await controller.ConfirmAsync("x");
        Assert.Equal(new ManualPostingCompletion(1, 3, false), controller.Completion);
        await controller.ConfirmAsync("patreon");
        Assert.Equal(new ManualPostingCompletion(2, 3, false), controller.Completion);
        await controller.ConfirmAsync("bluesky");
        Assert.Equal(new ManualPostingCompletion(3, 3, true), controller.Completion);
    }

    [Fact]
    public async Task MalformedAggregate_CannotOverwriteRetainedCompletionOrMarkTargetPosted()
    {
        var transport = new FakeTransport
        {
            Post = (platform, _) => Task.FromResult(platform == "x"
                ? Authoritative(platform, "posted", new DateTime(2030, 1, 1), 1, 3, false)
                : Authoritative(platform, "posted", new DateTime(2030, 1, 1), 3, 3, false)),
            Get = (platform, _) => Task.FromResult(
                Authoritative(platform, "posted", new DateTime(2030, 1, 1), 3, 3, false)),
        };
        using var controller = Controller(transport);
        await controller.ConfirmAsync("x");

        ManualPostingPlatformState result = await controller.ConfirmAsync("patreon");

        Assert.Equal(ManualPostingConfirmationStatus.ConfirmationUnknown, result.Status);
        Assert.Null(result.PostedAt);
        Assert.Equal(ManualPostingConfirmationController.RetryReason, result.Reason);
        Assert.Equal(new ManualPostingCompletion(1, 3, false), controller.Completion);
    }

    [Theory]
    [InlineData("x", "patreon")]
    [InlineData("patreon", "x")]
    public async Task DifferentPlatformWorkflows_AreSerializedInGateAcquisitionOrder(
        string firstPlatform, string secondPlatform)
    {
        var firstStarted = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var releaseFirst = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var secondStarted = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var transport = new FakeTransport
        {
            Post = async (platform, _) =>
            {
                if (platform == firstPlatform)
                {
                    firstStarted.SetResult();
                    await releaseFirst.Task;
                    return Authoritative(platform, "posted", new DateTime(2030, 1, 1), 1, 3, false);
                }

                secondStarted.SetResult();
                return Authoritative(platform, "posted", new DateTime(2030, 1, 1), 2, 3, false);
            },
        };
        using var controller = Controller(transport);

        Task<ManualPostingPlatformState> first = controller.ConfirmAsync(firstPlatform);
        await firstStarted.Task;
        Task<ManualPostingPlatformState> second = controller.ConfirmAsync(secondPlatform);

        Assert.Equal(ManualPostingConfirmationStatus.Confirming, controller.GetState(secondPlatform).Status);
        Assert.False(secondStarted.Task.IsCompleted);
        Assert.Equal(1, transport.PostCalls);

        releaseFirst.SetResult();
        await first;
        await secondStarted.Task;
        await second;

        Assert.Equal(2, transport.PostCalls);
        Assert.Equal(1, transport.PeakConcurrentCalls);
        Assert.Equal(new ManualPostingCompletion(2, 3, false), controller.Completion);
    }

    [Fact]
    public async Task AmbiguousPost_HoldsWorkflowGateThroughReconciliationGet()
    {
        var reconciliationStarted = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var releaseReconciliation = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var patreonStarted = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var transport = new FakeTransport
        {
            Post = (platform, _) =>
            {
                if (platform == "patreon") patreonStarted.SetResult();
                return Task.FromResult(platform == "x"
                    ? ManualPostingTransportResult.Ambiguous()
                    : Authoritative(platform, "posted", new DateTime(2030, 1, 1), 1, 3, false));
            },
            Get = async (platform, _) =>
            {
                reconciliationStarted.SetResult();
                await releaseReconciliation.Task;
                return Authoritative(platform, "ready", null, 0, 3, false);
            },
        };
        using var controller = Controller(transport);

        Task<ManualPostingPlatformState> x = controller.ConfirmAsync("x");
        await reconciliationStarted.Task;
        Task<ManualPostingPlatformState> patreon = controller.ConfirmAsync("patreon");

        Assert.False(patreonStarted.Task.IsCompleted);
        Assert.Equal(1, transport.PostCalls);

        releaseReconciliation.SetResult();
        await x;
        await patreonStarted.Task;
        await patreon;

        Assert.Equal(1, transport.PeakConcurrentCalls);
        Assert.Equal(new ManualPostingCompletion(1, 3, false), controller.Completion);
    }

    [Fact]
    public async Task Cancellation_ReleasesWorkflowGateForQueuedPlatform()
    {
        var xStarted = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var patreonStarted = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var transport = new FakeTransport
        {
            Post = async (platform, token) =>
            {
                if (platform == "x")
                {
                    xStarted.SetResult();
                    await Task.Delay(Timeout.InfiniteTimeSpan, token);
                }
                patreonStarted.SetResult();
                return Authoritative(platform, "posted", new DateTime(2030, 1, 1), 1, 3, false);
            },
        };
        using var controller = Controller(transport);
        using var cancellation = new CancellationTokenSource();

        Task<ManualPostingPlatformState> x = controller.ConfirmAsync("x", cancellation.Token);
        await xStarted.Task;
        Task<ManualPostingPlatformState> patreon = controller.ConfirmAsync("patreon");
        Assert.False(patreonStarted.Task.IsCompleted);

        cancellation.Cancel();
        await x;
        await patreonStarted.Task;
        await patreon;

        Assert.Equal(1, transport.PeakConcurrentCalls);
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task RejectionOrMalformedAggregate_ReleasesWorkflowGateForQueuedPlatform(bool malformed)
    {
        var xStarted = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var releaseX = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var patreonStarted = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var transport = new FakeTransport
        {
            Post = async (platform, _) =>
            {
                if (platform == "x")
                {
                    xStarted.SetResult();
                    await releaseX.Task;
                    return malformed
                        ? Authoritative(platform, "posted", new DateTime(2030, 1, 1), 3, 3, false)
                        : ManualPostingTransportResult.Rejected("confirmation_target_not_owned");
                }

                patreonStarted.SetResult();
                return Authoritative(platform, "posted", new DateTime(2030, 1, 1), 1, 3, false);
            },
            Get = (_, _) => Task.FromResult(
                ManualPostingTransportResult.Rejected("confirmation_target_not_owned")),
        };
        using var controller = Controller(transport);

        Task<ManualPostingPlatformState> x = controller.ConfirmAsync("x");
        await xStarted.Task;
        Task<ManualPostingPlatformState> patreon = controller.ConfirmAsync("patreon");
        Assert.False(patreonStarted.Task.IsCompleted);

        releaseX.SetResult();
        await x;
        await patreonStarted.Task;
        await patreon;

        Assert.Equal(1, transport.PeakConcurrentCalls);
        Assert.Equal(new ManualPostingCompletion(1, 3, false), controller.Completion);
    }

    [Fact]
    public async Task DisposeWithActiveWorkflowAndWaiter_CancelsSafelyWithoutStartingWaiter()
    {
        var started = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var transport = new FakeTransport
        {
            Post = async (_, token) =>
            {
                started.SetResult();
                await Task.Delay(Timeout.InfiniteTimeSpan, token);
                return ManualPostingTransportResult.Ambiguous();
            },
        };
        var controller = Controller(transport);
        Task<ManualPostingPlatformState> pending = controller.ConfirmAsync("x");
        await started.Task;
        Task<ManualPostingPlatformState> waiter = controller.ConfirmAsync("patreon");
        Assert.Equal(1, transport.PostCalls);

        controller.Dispose();
        await pending.WaitAsync(TimeSpan.FromSeconds(2));
        await waiter.WaitAsync(TimeSpan.FromSeconds(2));

        Assert.True(transport.Disposed);
        Assert.Equal(1, transport.PostCalls);
        Assert.Equal(0, transport.GetCalls);
        Assert.Null(controller.Completion);

        var neverStarted = new FakeTransport();
        new ManualPostingConfirmationController(neverStarted, ["x"]).Dispose();
        Assert.Equal(0, neverStarted.PostCalls);
    }

    [Fact]
    public async Task LocallyObservedDeadlineAvoidsPointlessRequestWithoutClaimingServerAuthority()
    {
        var transport = new FakeTransport { ConfirmationExpiresAt = new DateTime(2030, 1, 1) };
        using var controller = new ManualPostingConfirmationController(
            transport, ["x"], () => new DateTime(2030, 1, 1));

        ManualPostingPlatformState result = await controller.ConfirmAsync("x");

        Assert.Equal(ManualPostingConfirmationStatus.Ready, result.Status);
        Assert.Equal(ManualPostingConfirmationController.ExpiredReason, result.Reason);
        Assert.Equal(0, transport.PostCalls);
    }

    private static ManualPostingConfirmationController Controller(FakeTransport transport) =>
        new(transport, ["x", "patreon"]);

    private static ManualPostingTransportResult Authoritative(
        string platform, string status, DateTime? postedAt, int posted, int total, bool complete) =>
        ManualPostingTransportResult.Authoritative(new ManualPostingConfirmationResponse(
            platform, status, postedAt, new ManualPostingCompletion(posted, total, complete)));

    private sealed class FakeTransport : IManualPostingConfirmationTransport
    {
        private int _activeCalls;
        private int _getCalls;
        private int _peakConcurrentCalls;
        private int _postCalls;

        public DateTime? ConfirmationExpiresAt { get; init; }
        public int PostCalls => Volatile.Read(ref _postCalls);
        public int GetCalls => Volatile.Read(ref _getCalls);
        public int PeakConcurrentCalls => Volatile.Read(ref _peakConcurrentCalls);
        public bool Disposed { get; private set; }
        public Func<string, CancellationToken, Task<ManualPostingTransportResult>> Post { get; init; } =
            (_, _) => Task.FromResult(ManualPostingTransportResult.Ambiguous());
        public Func<string, CancellationToken, Task<ManualPostingTransportResult>> Get { get; init; } =
            (_, _) => Task.FromResult(ManualPostingTransportResult.Ambiguous());

        public async Task<ManualPostingTransportResult> PostAsync(string platform, CancellationToken cancellationToken)
        {
            Interlocked.Increment(ref _postCalls);
            return await TrackAsync(Post(platform, cancellationToken));
        }

        public async Task<ManualPostingTransportResult> GetAsync(string platform, CancellationToken cancellationToken)
        {
            Interlocked.Increment(ref _getCalls);
            return await TrackAsync(Get(platform, cancellationToken));
        }

        private async Task<ManualPostingTransportResult> TrackAsync(Task<ManualPostingTransportResult> operation)
        {
            int active = Interlocked.Increment(ref _activeCalls);
            int peak;
            while (active > (peak = Volatile.Read(ref _peakConcurrentCalls)) &&
                Interlocked.CompareExchange(ref _peakConcurrentCalls, active, peak) != peak) { }
            try { return await operation; }
            finally
            {
                Interlocked.Decrement(ref _activeCalls);
            }
        }

        public void Dispose() => Disposed = true;
    }
}
