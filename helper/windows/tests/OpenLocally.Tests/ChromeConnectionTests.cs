using OpenLocally;
using System.Net.WebSockets;

namespace OpenLocally.Tests;

public class ChromeConnectionTests
{
    private static readonly ChromeEndpoint Endpoint =
        new(new Uri("ws://127.0.0.1:9222/devtools/browser/current-id"));

    [Fact]
    public async Task Connect_SucceedsWithExactlyOneAttemptAndCurrentEndpoint()
    {
        var socket = new FakeSocket();
        await using var connection = new ChromeConnection(() => socket, TimeSpan.FromSeconds(1));

        ChromeConnectionResult result = await connection.ConnectAsync(Endpoint, CancellationToken.None);

        Assert.True(result.Success);
        Assert.Equal(1, socket.ConnectCalls);
        Assert.Same(Endpoint.Uri, socket.Endpoint);
    }

    [Fact]
    public async Task Connect_SucceedsWhenApprovalCompletesNearConfiguredDeadline()
    {
        var approval = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var connectStarted = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var socket = new FakeSocket(async token =>
        {
            connectStarted.TrySetResult();
            await approval.Task.WaitAsync(token);
        });
        await using var connection = new ChromeConnection(() => socket, TimeSpan.FromMilliseconds(250));

        Task<ChromeConnectionResult> pending = connection.ConnectAsync(Endpoint, CancellationToken.None);
        await connectStarted.Task.WaitAsync(TimeSpan.FromSeconds(1));
        await Task.Delay(TimeSpan.FromMilliseconds(200));
        approval.SetResult();

        ChromeConnectionResult result = await pending;

        Assert.True(result.Success);
        Assert.Equal(1, socket.ConnectCalls);
        Assert.False(socket.ConnectCancelled);
    }

    [Fact]
    public async Task Connect_RefusalDoesNotRetryAndDisposesSocket()
    {
        var socket = new FakeSocket(_ => throw new WebSocketConnectionException(WebSocketConnectionFailure.ConnectionRefused));
        await using var connection = new ChromeConnection(() => socket, TimeSpan.FromSeconds(1));

        ChromeConnectionResult result = await connection.ConnectAsync(Endpoint, CancellationToken.None);

        Assert.Equal("chrome_connection_refused", result.ErrorCode);
        Assert.Equal(1, socket.ConnectCalls);
        Assert.Equal(1, socket.DisposeCalls);
    }

    [Theory]
    [InlineData(WebSocketConnectionFailure.HandshakeFailed, "chrome_handshake_failed")]
    [InlineData(WebSocketConnectionFailure.ApprovalDenied, "chrome_approval_denied")]
    public async Task Connect_MapsOnlyExplicitSocketFailures(WebSocketConnectionFailure failure, string expected)
    {
        var socket = new FakeSocket(_ => throw new WebSocketConnectionException(failure));
        await using var connection = new ChromeConnection(() => socket, TimeSpan.FromSeconds(1));

        ChromeConnectionResult result = await connection.ConnectAsync(Endpoint, CancellationToken.None);

        Assert.Equal(expected, result.ErrorCode);
    }

    [Fact]
    public async Task Connect_TimeoutCancelsThePendingHandshakeWithoutSecondAttempt()
    {
        var socket = new FakeSocket(async token => await Task.Delay(Timeout.InfiniteTimeSpan, token));
        await using var connection = new ChromeConnection(() => socket, TimeSpan.FromMilliseconds(20));

        ChromeConnectionResult result = await connection.ConnectAsync(Endpoint, CancellationToken.None);

        Assert.Equal("chrome_approval_timeout", result.ErrorCode);
        Assert.Equal(1, socket.ConnectCalls);
        Assert.True(socket.ConnectCancelled);
        Assert.Equal(1, socket.DisposeCalls);
    }

    [Fact]
    public async Task Connect_CallerCancellationRemainsDistinct()
    {
        using var cancellation = new CancellationTokenSource();
        cancellation.Cancel();
        var socket = new FakeSocket(async token => await Task.Delay(Timeout.InfiniteTimeSpan, token));
        await using var connection = new ChromeConnection(() => socket, TimeSpan.FromSeconds(1));

        ChromeConnectionResult result = await connection.ConnectAsync(Endpoint, cancellation.Token);

        Assert.Equal("chrome_connection_cancelled", result.ErrorCode);
        Assert.True(socket.ConnectCancelled);
    }

    [Fact]
    public async Task Connect_AllowsOneFreshAttemptAfterAFailedSocketIsTerminal()
    {
        var first = new FakeSocket(_ => throw new WebSocketConnectionException(WebSocketConnectionFailure.ConnectionRefused));
        var second = new FakeSocket();
        var sockets = new Queue<FakeSocket>([first, second]);
        await using var connection = new ChromeConnection(() => sockets.Dequeue(), TimeSpan.FromSeconds(1));

        Assert.Equal("chrome_connection_refused", (await connection.ConnectAsync(Endpoint, CancellationToken.None)).ErrorCode);
        Assert.True((await connection.ConnectAsync(Endpoint, CancellationToken.None)).Success);

        Assert.Equal(1, first.ConnectCalls);
        Assert.Equal(1, first.DisposeCalls);
        Assert.Equal(1, second.ConnectCalls);
    }

    [Fact]
    public async Task Connect_RejectsAConcurrentAttemptBeforeItCanCreateAnotherSocket()
    {
        var started = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var release = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var first = new FakeSocket(async _ =>
        {
            started.TrySetResult();
            await release.Task;
        });
        int factories = 0;
        await using var connection = new ChromeConnection(() =>
        {
            factories++;
            return first;
        }, TimeSpan.FromSeconds(1));

        Task<ChromeConnectionResult> pending = connection.ConnectAsync(Endpoint, CancellationToken.None);
        await started.Task.WaitAsync(TimeSpan.FromSeconds(1));

        await Assert.ThrowsAsync<InvalidOperationException>(() => connection.ConnectAsync(Endpoint, CancellationToken.None));
        Assert.Equal(1, factories);

        release.SetResult();
        Assert.True((await pending).Success);
    }

    [Fact]
    public async Task Dispose_ClosesAndDisposesSuccessfulSocketExactlyOnce()
    {
        var socket = new FakeSocket();
        var connection = new ChromeConnection(() => socket, TimeSpan.FromSeconds(1));
        Assert.True((await connection.ConnectAsync(Endpoint, CancellationToken.None)).Success);

        await connection.DisposeAsync();
        await connection.DisposeAsync();

        Assert.Equal(1, socket.CloseCalls);
        Assert.Equal(1, socket.DisposeCalls);
    }

    [Fact]
    public async Task Dispose_WaitsForFullCloseHandshakeBeforeDisposingSocket()
    {
        var closeStarted = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var peerClosed = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var socket = new FakeSocket(
            close: async cancellationToken =>
            {
                closeStarted.TrySetResult();
                await peerClosed.Task.WaitAsync(cancellationToken);
            });
        var connection = new ChromeConnection(() => socket, TimeSpan.FromSeconds(1), TimeSpan.FromSeconds(1));
        Assert.True((await connection.ConnectAsync(Endpoint, CancellationToken.None)).Success);

        Task dispose = connection.DisposeAsync().AsTask();
        await closeStarted.Task.WaitAsync(TimeSpan.FromSeconds(1));

        Assert.False(dispose.IsCompleted);
        Assert.Equal(0, socket.DisposeCalls);

        peerClosed.TrySetResult();
        await dispose;

        Assert.Equal(WebSocketState.Closed, socket.State);
        Assert.Equal(1, socket.CloseCalls);
        Assert.Equal(1, socket.DisposeCalls);
    }

    [Fact]
    public async Task Dispose_GracefulCloseTimeoutFallsBackToBoundedDisposal()
    {
        var socket = new FakeSocket(close: cancellationToken => Task.Delay(Timeout.InfiniteTimeSpan, cancellationToken));
        var connection = new ChromeConnection(() => socket, TimeSpan.FromSeconds(1), TimeSpan.FromMilliseconds(20));
        Assert.True((await connection.ConnectAsync(Endpoint, CancellationToken.None)).Success);

        var stopwatch = System.Diagnostics.Stopwatch.StartNew();
        await connection.DisposeAsync();
        stopwatch.Stop();

        Assert.True(stopwatch.Elapsed < TimeSpan.FromSeconds(1));
        Assert.Equal(1, socket.CloseCalls);
        Assert.Equal(WebSocketState.Aborted, socket.State);
        Assert.Equal(1, socket.DisposeCalls);
    }

    [Fact]
    public async Task Dispose_RunTokenAlreadyCancelled_StillUsesIndependentCleanupToken()
    {
        using var runCancellation = new CancellationTokenSource();
        bool cleanupTokenWasCancelled = true;
        var socket = new FakeSocket(close: token =>
        {
            cleanupTokenWasCancelled = token.IsCancellationRequested;
            return Task.CompletedTask;
        });
        var connection = new ChromeConnection(() => socket, TimeSpan.FromSeconds(1), TimeSpan.FromSeconds(1));
        Assert.True((await connection.ConnectAsync(Endpoint, runCancellation.Token)).Success);
        runCancellation.Cancel();

        await connection.DisposeAsync();

        Assert.False(cleanupTokenWasCancelled);
        Assert.Equal(1, socket.CloseCalls);
        Assert.Equal(1, socket.DisposeCalls);
    }

    private sealed class FakeSocket(
        Func<CancellationToken, Task>? connect = null,
        Func<CancellationToken, Task>? close = null) : IWebSocketConnection
    {
        private readonly Func<CancellationToken, Task> _connect = connect ?? (_ => Task.CompletedTask);
        private readonly Func<CancellationToken, Task> _close = close ?? (_ => Task.CompletedTask);

        public int ConnectCalls { get; private set; }

        public int CloseCalls { get; private set; }

        public int DisposeCalls { get; private set; }

        public bool ConnectCancelled { get; private set; }

        public Uri? Endpoint { get; private set; }

        public WebSocketState State { get; private set; } = WebSocketState.Open;

        public async Task ConnectAsync(Uri endpoint, CancellationToken cancellationToken)
        {
            ConnectCalls++;
            Endpoint = endpoint;
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

        public async Task CloseAsync(CancellationToken cancellationToken)
        {
            CloseCalls++;
            await _close(cancellationToken);
            State = WebSocketState.Closed;
        }

        public Task SendAsync(ArraySegment<byte> buffer, WebSocketMessageType messageType, bool endOfMessage, CancellationToken cancellationToken) =>
            throw new NotSupportedException();

        public Task<WebSocketReceiveResult> ReceiveAsync(ArraySegment<byte> buffer, CancellationToken cancellationToken) =>
            throw new NotSupportedException();

        public ValueTask DisposeAsync()
        {
            DisposeCalls++;
            if (State != WebSocketState.Closed)
            {
                State = WebSocketState.Aborted;
            }
            return ValueTask.CompletedTask;
        }
    }
}
