using OpenLocally;
using System.Net.WebSockets;

namespace OpenLocally.Tests;

public class ChromeConnectionWorkflowTests
{
    private static readonly ChromeEndpoint Endpoint = new(new Uri("ws://127.0.0.1:9222/devtools/browser/current-id"));

    [Fact]
    public async Task ReadyContinue_SuccessStartsOneSocketOnlyAfterConsent()
    {
        var tracker = new AttemptTracker();
        var socket = new FakeSocket(tracker);
        var consent = new FakeConsent(ready: [true]);
        int discoveries = 0;
        await using var connection = new ChromeConnection(() => socket, TimeSpan.FromSeconds(1));
        var workflow = new ChromeConnectionWorkflow(() =>
        {
            discoveries++;
            return ChromeDiscoveryResult.Ok(Endpoint);
        }, connection, consent);

        ChromeConnectionResult result = await workflow.ConnectAsync(CancellationToken.None);

        Assert.True(result.Success);
        Assert.Equal(1, consent.ReadyCalls);
        Assert.Equal(0, consent.RetryCalls);
        Assert.Equal(1, discoveries);
        Assert.Equal(1, socket.ConnectCalls);
        Assert.Equal(1, tracker.MaximumActive);
    }

    [Fact]
    public async Task ReadyCancel_CreatesNoSocketOrDiscovery()
    {
        var consent = new FakeConsent(ready: [false]);
        int factories = 0;
        int discoveries = 0;
        await using var connection = new ChromeConnection(() =>
        {
            factories++;
            return new FakeSocket(new AttemptTracker());
        }, TimeSpan.FromSeconds(1));
        var workflow = new ChromeConnectionWorkflow(() =>
        {
            discoveries++;
            return ChromeDiscoveryResult.Ok(Endpoint);
        }, connection, consent);

        ChromeConnectionResult result = await workflow.ConnectAsync(CancellationToken.None);

        Assert.Equal("chrome_connection_ready_cancelled", result.ErrorCode);
        Assert.Equal(0, factories);
        Assert.Equal(0, discoveries);
        Assert.Equal(0, consent.RetryCalls);
    }

    [Fact]
    public async Task HandshakeFailure_RetryThenSuccess_DisposesBeforeTheNextSequentialAttempt()
    {
        var tracker = new AttemptTracker();
        var first = new FakeSocket(tracker, _ => throw new WebSocketConnectionException(WebSocketConnectionFailure.HandshakeFailed));
        var second = new FakeSocket(tracker);
        var sockets = new Queue<FakeSocket>([first, second]);
        var consent = new FakeConsent(ready: [true], retry: [true]);
        int discoveries = 0;
        await using var connection = new ChromeConnection(() => sockets.Dequeue(), TimeSpan.FromSeconds(1));
        var workflow = new ChromeConnectionWorkflow(() =>
        {
            discoveries++;
            return ChromeDiscoveryResult.Ok(Endpoint);
        }, connection, consent);

        ChromeConnectionResult result = await workflow.ConnectAsync(CancellationToken.None);

        Assert.True(result.Success);
        Assert.Equal(1, first.DisposeCalls);
        Assert.Equal(1, second.ConnectCalls);
        Assert.Equal(2, discoveries);
        Assert.Equal(1, consent.RetryCalls);
        Assert.Equal(1, tracker.MaximumActive);
    }

    [Fact]
    public async Task HandshakeFailure_CancelDoesNotStartASecondSocket()
    {
        var tracker = new AttemptTracker();
        var first = new FakeSocket(tracker, _ => throw new WebSocketConnectionException(WebSocketConnectionFailure.ApprovalDenied));
        var consent = new FakeConsent(ready: [true], retry: [false]);
        await using var connection = new ChromeConnection(() => first, TimeSpan.FromSeconds(1));
        var workflow = new ChromeConnectionWorkflow(() => ChromeDiscoveryResult.Ok(Endpoint), connection, consent);

        ChromeConnectionResult result = await workflow.ConnectAsync(CancellationToken.None);

        Assert.Equal("chrome_connection_retry_cancelled", result.ErrorCode);
        Assert.Equal(1, first.ConnectCalls);
        Assert.Equal(1, first.DisposeCalls);
        Assert.Equal(1, consent.RetryCalls);
    }

    [Fact]
    public async Task MultipleExplicitRetries_AreSequentialAndNeverAutomatic()
    {
        var tracker = new AttemptTracker();
        var sockets = new Queue<FakeSocket>([
            new(tracker, _ => throw new WebSocketConnectionException(WebSocketConnectionFailure.HandshakeFailed)),
            new(tracker, _ => throw new WebSocketConnectionException(WebSocketConnectionFailure.ConnectionRefused)),
            new(tracker),
        ]);
        var consent = new FakeConsent(ready: [true], retry: [true, true]);
        await using var connection = new ChromeConnection(() => sockets.Dequeue(), TimeSpan.FromSeconds(1));
        var workflow = new ChromeConnectionWorkflow(() => ChromeDiscoveryResult.Ok(Endpoint), connection, consent);

        ChromeConnectionResult result = await workflow.ConnectAsync(CancellationToken.None);

        Assert.True(result.Success);
        Assert.Equal(2, consent.RetryCalls);
        Assert.Equal(1, tracker.MaximumActive);
        Assert.Empty(sockets);
    }

    [Fact]
    public async Task ApprovalTimeout_RetryStartsOneFreshAttemptOnlyAfterOperatorChoice()
    {
        var tracker = new AttemptTracker();
        var first = new FakeSocket(tracker, async token => await Task.Delay(Timeout.InfiniteTimeSpan, token));
        var second = new FakeSocket(tracker);
        var sockets = new Queue<FakeSocket>([first, second]);
        var consent = new FakeConsent(ready: [true], retry: [true]);
        await using var connection = new ChromeConnection(() => sockets.Dequeue(), TimeSpan.FromMilliseconds(20));
        var workflow = new ChromeConnectionWorkflow(() => ChromeDiscoveryResult.Ok(Endpoint), connection, consent);

        ChromeConnectionResult result = await workflow.ConnectAsync(CancellationToken.None);

        Assert.True(result.Success);
        Assert.True(first.ConnectCancelled);
        Assert.Equal(1, consent.RetryCalls);
        Assert.Equal(1, tracker.MaximumActive);
    }

    [Fact]
    public async Task DiscoveryFailure_IsTerminalAndDoesNotOfferRetry()
    {
        var consent = new FakeConsent(ready: [true]);
        await using var connection = new ChromeConnection(() => throw new InvalidOperationException(), TimeSpan.FromSeconds(1));
        var workflow = new ChromeConnectionWorkflow(() => ChromeDiscoveryResult.Fail("chrome_discovery_missing"), connection, consent);

        ChromeConnectionResult result = await workflow.ConnectAsync(CancellationToken.None);

        Assert.Equal("chrome_discovery_missing", result.ErrorCode);
        Assert.Equal(0, consent.RetryCalls);
    }

    [Fact]
    public async Task ExternalCancellationDuringAttempt_DoesNotOfferRetry()
    {
        var tracker = new AttemptTracker();
        var socket = new FakeSocket(tracker, async token => await Task.Delay(Timeout.InfiniteTimeSpan, token));
        var consent = new FakeConsent(ready: [true]);
        using var cancellation = new CancellationTokenSource();
        await using var connection = new ChromeConnection(() => socket, TimeSpan.FromSeconds(1));
        var workflow = new ChromeConnectionWorkflow(() => ChromeDiscoveryResult.Ok(Endpoint), connection, consent);

        Task<ChromeConnectionResult> pending = workflow.ConnectAsync(cancellation.Token);
        await socket.Started.Task.WaitAsync(TimeSpan.FromSeconds(1));
        cancellation.Cancel();
        ChromeConnectionResult result = await pending;

        Assert.Equal("chrome_connection_cancelled", result.ErrorCode);
        Assert.Equal(0, consent.RetryCalls);
    }

    [Fact]
    public async Task ReadinessWait_DoesNotStartTheConnectionTimeoutOrSocketBeforeContinue()
    {
        var tracker = new AttemptTracker();
        var socket = new FakeSocket(tracker);
        var consent = new BlockingReadyConsent();
        int factories = 0;
        await using var connection = new ChromeConnection(() =>
        {
            factories++;
            return socket;
        }, TimeSpan.FromMilliseconds(20));
        var workflow = new ChromeConnectionWorkflow(() => ChromeDiscoveryResult.Ok(Endpoint), connection, consent);

        Task<ChromeConnectionResult> pending = Task.Run(() => workflow.ConnectAsync(CancellationToken.None));
        await consent.ReadyShown.Task.WaitAsync(TimeSpan.FromSeconds(1));
        await Task.Delay(TimeSpan.FromMilliseconds(75));

        Assert.Equal(0, factories);
        consent.Continue();
        Assert.True((await pending).Success);
        Assert.Equal(1, factories);
    }

    [Fact]
    public async Task ExternalCancellationWhileReadinessIsOpen_StartsNoSocket()
    {
        var consent = new BlockingReadyConsent();
        int factories = 0;
        using var cancellation = new CancellationTokenSource();
        await using var connection = new ChromeConnection(() =>
        {
            factories++;
            return new FakeSocket(new AttemptTracker());
        }, TimeSpan.FromSeconds(1));
        var workflow = new ChromeConnectionWorkflow(() => ChromeDiscoveryResult.Ok(Endpoint), connection, consent);

        Task<ChromeConnectionResult> pending = Task.Run(() => workflow.ConnectAsync(cancellation.Token));
        await consent.ReadyShown.Task.WaitAsync(TimeSpan.FromSeconds(1));
        cancellation.Cancel();
        consent.Continue();

        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => pending);
        Assert.Equal(0, factories);
    }

    [Fact]
    public async Task PromptDisplayFailure_StartsNoSocket()
    {
        int factories = 0;
        await using var connection = new ChromeConnection(() =>
        {
            factories++;
            return new FakeSocket(new AttemptTracker());
        }, TimeSpan.FromSeconds(1));
        var workflow = new ChromeConnectionWorkflow(
            () => ChromeDiscoveryResult.Ok(Endpoint),
            connection,
            new DisplayFailingConsent());

        ChromeConnectionResult result = await workflow.ConnectAsync(CancellationToken.None);

        Assert.Equal("chrome_connection_prompt_failed", result.ErrorCode);
        Assert.Equal(0, factories);
    }

    private sealed class BlockingReadyConsent : IChromeConnectionConsent
    {
        private readonly ManualResetEventSlim _continue = new(false);
        public TaskCompletionSource ReadyShown { get; } = new(TaskCreationOptions.RunContinuationsAsynchronously);
        public ChromeConnectionConsentDecision ConfirmReady()
        {
            ReadyShown.TrySetResult();
            _continue.Wait();
            return ChromeConnectionConsentDecision.Continue;
        }
        public ChromeConnectionConsentDecision ConfirmRetry(string errorCode) => throw new InvalidOperationException();
        public void Continue() => _continue.Set();
    }

    private sealed class DisplayFailingConsent : IChromeConnectionConsent
    {
        public ChromeConnectionConsentDecision ConfirmReady() => ChromeConnectionConsentDecision.DisplayFailed;
        public ChromeConnectionConsentDecision ConfirmRetry(string errorCode) => ChromeConnectionConsentDecision.DisplayFailed;
    }

    private sealed class FakeConsent(bool[] ready, bool[]? retry = null) : IChromeConnectionConsent
    {
        private readonly Queue<bool> _ready = new(ready);
        private readonly Queue<bool> _retry = new(retry ?? []);
        public int ReadyCalls { get; private set; }
        public int RetryCalls { get; private set; }
        public ChromeConnectionConsentDecision ConfirmReady()
        {
            ReadyCalls++;
            return _ready.Dequeue() ? ChromeConnectionConsentDecision.Continue : ChromeConnectionConsentDecision.Cancel;
        }
        public ChromeConnectionConsentDecision ConfirmRetry(string errorCode)
        {
            RetryCalls++;
            return _retry.Dequeue() ? ChromeConnectionConsentDecision.Continue : ChromeConnectionConsentDecision.Cancel;
        }
    }

    private sealed class AttemptTracker
    {
        private int _active;
        public int MaximumActive { get; private set; }
        public void Begin()
        {
            int active = Interlocked.Increment(ref _active);
            MaximumActive = Math.Max(MaximumActive, active);
        }
        public void End() => Interlocked.Decrement(ref _active);
    }

    private sealed class FakeSocket(AttemptTracker tracker, Func<CancellationToken, Task>? connect = null) : IWebSocketConnection
    {
        private readonly Func<CancellationToken, Task> _connect = connect ?? (_ => Task.CompletedTask);
        private bool _active;
        public int ConnectCalls { get; private set; }
        public int DisposeCalls { get; private set; }
        public bool ConnectCancelled { get; private set; }
        public TaskCompletionSource Started { get; } = new(TaskCreationOptions.RunContinuationsAsynchronously);
        public WebSocketState State => WebSocketState.Open;

        public async Task ConnectAsync(Uri endpoint, CancellationToken cancellationToken)
        {
            ConnectCalls++;
            _active = true;
            tracker.Begin();
            Started.TrySetResult();
            try
            {
                await _connect(cancellationToken);
            }
            catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
            {
                ConnectCancelled = true;
                throw;
            }
        }

        public Task CloseAsync(CancellationToken cancellationToken) => Task.CompletedTask;
        public Task SendAsync(ArraySegment<byte> buffer, WebSocketMessageType messageType, bool endOfMessage, CancellationToken cancellationToken) => throw new NotSupportedException();
        public Task<WebSocketReceiveResult> ReceiveAsync(ArraySegment<byte> buffer, CancellationToken cancellationToken) => throw new NotSupportedException();
        public ValueTask DisposeAsync()
        {
            DisposeCalls++;
            if (_active)
            {
                _active = false;
                tracker.End();
            }
            return ValueTask.CompletedTask;
        }
    }
}
