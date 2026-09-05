using System.Net.WebSockets;
using System.Text.Json;
using OpenLocally;

namespace OpenLocally.Tests;

public class CdpTransportTests
{
    [Fact]
    public async Task Commands_AreSerializedAndOutOfOrderResponsesCorrelate()
    {
        var socket = new CdpTestSocket();
        await using var transport = new CdpTransport(socket);
        Task<JsonElement> first = transport.SendCommandAsync("Browser.first", JsonSerializer.SerializeToElement(new { first = true }));
        Task<JsonElement> second = transport.SendCommandAsync("Browser.second", sessionId: "session-a");
        await WaitForAsync(() => socket.Sent.Count == 2);

        string[] sent = socket.Sent.ToArray();
        Assert.Equal(1, JsonDocument.Parse(sent[0]).RootElement.GetProperty("id").GetInt32());
        Assert.Equal("Browser.first", JsonDocument.Parse(sent[0]).RootElement.GetProperty("method").GetString());
        Assert.Equal("session-a", JsonDocument.Parse(sent[1]).RootElement.GetProperty("sessionId").GetString());
        socket.EnqueueJson("{\"id\":2,\"result\":{\"value\":\"second\"}}");
        socket.EnqueueJson("{\"id\":1,\"result\":{\"value\":\"first\"}}");

        Assert.Equal("first", (await first).GetProperty("value").GetString());
        Assert.Equal("second", (await second).GetProperty("value").GetString());
        Assert.Equal(1, socket.MaximumConcurrentSends);
    }

    [Fact]
    public async Task FragmentedUtf8Response_IsReassembledAndReturnedOwned()
    {
        var socket = new CdpTestSocket();
        await using var transport = new CdpTransport(socket);
        Task<JsonElement> command = transport.SendCommandAsync("Browser.getVersion");
        await WaitForAsync(() => socket.Sent.Count == 1);
        string json = "{\"id\":1,\"result\":{\"name\":\"café\"}}";
        int split = System.Text.Encoding.UTF8.GetByteCount("{\"id\":1,\"result\":{\"name\":\"caf");
        socket.EnqueueJson(json, split, System.Text.Encoding.UTF8.GetByteCount(json) - split);

        Assert.Equal("café", (await command).GetProperty("name").GetString());
    }

    [Fact]
    public async Task ProtocolErrorTimeoutCancellationAndLateResponses_DoNotKillTransport()
    {
        var socket = new CdpTestSocket();
        await using var transport = new CdpTransport(socket);
        Task<JsonElement> error = transport.SendCommandAsync("Browser.error");
        await WaitForAsync(() => socket.Sent.Count == 1);
        socket.EnqueueJson("{\"id\":1,\"error\":{\"code\":-32000,\"message\":\"denied\"}}");
        CdpCommandException thrown = await Assert.ThrowsAsync<CdpCommandException>(() => error);
        Assert.Equal(-32000, thrown.Code);
        Assert.Equal("denied", thrown.Message);

        await Assert.ThrowsAsync<TimeoutException>(() => transport.SendCommandAsync("Browser.timeout", timeout: TimeSpan.FromMilliseconds(20)));
        socket.EnqueueJson("{\"id\":2,\"result\":{}}");
        using var cancelled = new CancellationTokenSource();
        cancelled.Cancel();
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => transport.SendCommandAsync("Browser.cancel", cancellationToken: cancelled.Token));

        Task<JsonElement> healthy = transport.SendCommandAsync("Browser.healthy");
        await WaitForAsync(() => socket.Sent.Count == 3);
        socket.EnqueueJson("{\"id\":4,\"result\":{\"ok\":true}}");
        Assert.True((await healthy).GetProperty("ok").GetBoolean());
    }

    [Fact]
    public async Task TimeoutDuringSend_DoesNotCancelSocketSendCleansPendingAndKeepsHealthyTransportUsable()
    {
        var socket = new CdpTestSocket();
        var sendStarted = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var releaseSend = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        CancellationToken socketSendToken = default;
        socket.OnSendWithCancellationAsync = (message, cancellationToken) =>
        {
            int id = JsonDocument.Parse(message).RootElement.GetProperty("id").GetInt32();
            if (id == 1)
            {
                socketSendToken = cancellationToken;
                sendStarted.TrySetResult();
                return releaseSend.Task;
            }
            socket.EnqueueJson($"{{\"id\":{id},\"result\":{{\"ok\":true}}}}");
            return Task.CompletedTask;
        };
        await using var transport = new CdpTransport(socket);

        Task<JsonElement> timedOut = transport.SendCommandAsync("Browser.stalled", timeout: TimeSpan.FromMilliseconds(40));
        await sendStarted.Task.WaitAsync(TimeSpan.FromSeconds(1));
        await Task.Delay(80);
        Assert.False(socketSendToken.IsCancellationRequested);
        Assert.False(timedOut.IsCompleted);
        releaseSend.TrySetResult();
        TimeoutException timeout = await Assert.ThrowsAsync<TimeoutException>(async () => await timedOut.WaitAsync(TimeSpan.FromSeconds(1)));

        Assert.Equal("The CDP command timed out.", timeout.Message);
        Assert.Equal(0, socket.SendCancellations);
        Assert.Equal(0, transport.PendingCommandCount);
        Assert.Single(socket.Sent);

        JsonElement healthy = await transport.SendCommandAsync("Browser.healthy", timeout: TimeSpan.FromSeconds(1));
        Assert.True(healthy.GetProperty("ok").GetBoolean());
        Assert.Equal(0, transport.PendingCommandCount);
    }

    [Fact]
    public async Task CallerCancellationDuringSend_DoesNotCancelSocketSendAndKeepsTransportHealthy()
    {
        var socket = new CdpTestSocket();
        var sendStarted = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var releaseSend = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        CancellationToken socketSendToken = default;
        socket.OnSendWithCancellationAsync = (message, cancellationToken) =>
        {
            int id = JsonDocument.Parse(message).RootElement.GetProperty("id").GetInt32();
            if (id == 1)
            {
                socketSendToken = cancellationToken;
                sendStarted.TrySetResult();
                return releaseSend.Task;
            }
            socket.EnqueueJson($"{{\"id\":{id},\"result\":{{\"ok\":true}}}}");
            return Task.CompletedTask;
        };
        await using var transport = new CdpTransport(socket);
        using var caller = new CancellationTokenSource();

        Task<JsonElement> cancelled = transport.SendCommandAsync("Browser.stalled", cancellationToken: caller.Token);
        await sendStarted.Task.WaitAsync(TimeSpan.FromSeconds(1));
        caller.Cancel();
        Assert.False(socketSendToken.IsCancellationRequested);
        Assert.False(cancelled.IsCompleted);
        releaseSend.TrySetResult();
        await Assert.ThrowsAnyAsync<OperationCanceledException>(async () => await cancelled.WaitAsync(TimeSpan.FromSeconds(1)));

        Assert.Equal(0, socket.SendCancellations);
        Assert.Equal(0, transport.PendingCommandCount);
        JsonElement healthy = await transport.SendCommandAsync("Browser.healthy", timeout: TimeSpan.FromSeconds(1));
        Assert.True(healthy.GetProperty("ok").GetBoolean());
        Assert.Equal(1, socket.MaximumConcurrentSends);
        Assert.Equal("connected", transport.DiagnosticState);
    }

    [Fact]
    public async Task TimeoutWaitingForSendLock_CleansPendingWithoutReleasingAnotherCommandLock()
    {
        var socket = new CdpTestSocket();
        var firstSendStarted = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var releaseFirstSend = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        socket.OnSendWithCancellationAsync = (message, cancellationToken) =>
        {
            int id = JsonDocument.Parse(message).RootElement.GetProperty("id").GetInt32();
            if (id == 1)
            {
                firstSendStarted.TrySetResult();
                return releaseFirstSend.Task;
            }
            socket.EnqueueJson($"{{\"id\":{id},\"result\":{{\"ok\":true}}}}");
            return Task.CompletedTask;
        };
        await using var transport = new CdpTransport(socket);
        using var firstCaller = new CancellationTokenSource();

        Task<JsonElement> first = transport.SendCommandAsync("Browser.first", cancellationToken: firstCaller.Token);
        await firstSendStarted.Task.WaitAsync(TimeSpan.FromSeconds(1));
        Task<JsonElement> second = transport.SendCommandAsync("Browser.second", timeout: TimeSpan.FromMilliseconds(40));
        TimeoutException timeout = await Assert.ThrowsAsync<TimeoutException>(async () => await second.WaitAsync(TimeSpan.FromSeconds(1)));

        Assert.Equal("The CDP command timed out.", timeout.Message);
        Assert.Single(socket.Sent);
        Assert.Equal(1, transport.PendingCommandCount);
        firstCaller.Cancel();
        Assert.False(first.IsCompleted);
        releaseFirstSend.TrySetResult();
        await Assert.ThrowsAnyAsync<OperationCanceledException>(async () => await first.WaitAsync(TimeSpan.FromSeconds(1)));
        Assert.Equal(0, transport.PendingCommandCount);

        JsonElement healthy = await transport.SendCommandAsync("Browser.healthy", timeout: TimeSpan.FromSeconds(1));
        Assert.True(healthy.GetProperty("ok").GetBoolean());
        Assert.Equal(1, socket.MaximumConcurrentSends);
    }

    [Fact]
    public async Task SocketSendTimeout_TerminalizesTransportWithBoundedDiagnostic()
    {
        var socket = new CdpTestSocket();
        socket.OnSendWithCancellationAsync = (_, cancellationToken) => Task.Delay(Timeout.InfiniteTimeSpan, cancellationToken);
        await using var transport = new CdpTransport(socket, TimeSpan.FromMilliseconds(40));

        CdpTransportException failure = await Assert.ThrowsAsync<CdpTransportException>(
            () => transport.SendCommandAsync("Browser.stalled", timeout: TimeSpan.FromSeconds(1)));

        Assert.Equal(CdpTransportFailure.Disconnected, failure.Failure);
        Assert.Equal("send_failure", transport.DiagnosticState);
        Assert.Equal(0, transport.PendingCommandCount);
        Assert.Equal("Browser.stalled", failure.Diagnostic!.CommandMethod);
        Assert.Equal("socket_send", failure.Diagnostic.CommandPhase);
        Assert.Equal(WebSocketState.Open, failure.Diagnostic.WebSocketState);
        Assert.False(failure.Diagnostic.CallerTokenCancelled);
        Assert.False(failure.Diagnostic.CommandTimeoutFired);
        Assert.False(failure.Diagnostic.TransportLifetimeCancelled);
        Assert.Equal("send_failure", failure.Diagnostic.FirstTerminalReason);
        Assert.Equal(1, socket.SendCancellations);
    }

    [Fact]
    public async Task EventHandlerCanSendACommand_AndSessionsStayScoped()
    {
        var socket = new CdpTestSocket();
        socket.OnSendAsync = message =>
        {
            int id = JsonDocument.Parse(message).RootElement.GetProperty("id").GetInt32();
            socket.EnqueueJson($"{{\"id\":{id},\"result\":{{\"ok\":true}}}}");
            return Task.CompletedTask;
        };
        await using var transport = new CdpTransport(socket);
        await using var first = new CdpSession(transport, "first");
        await using var second = new CdpSession(transport, "second");
        var completed = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        first.EventReceived += async _ => { Assert.True((await first.SendCommandAsync("Runtime.enable")).GetProperty("ok").GetBoolean()); completed.TrySetResult(); };
        second.EventReceived += _ => throw new Xunit.Sdk.XunitException("wrong session");

        socket.EnqueueJson("{\"sessionId\":\"first\",\"method\":\"Page.fileChooserOpened\",\"params\":{\"frameId\":\"a\"}}");
        await completed.Task.WaitAsync(TimeSpan.FromSeconds(1));
    }

    [Fact]
    public async Task BrowserEventsAreOwned_HandlerFailuresAreReported_AndQueueOverflowTerminatesTransport()
    {
        var socket = new CdpTestSocket();
        await using var transport = new CdpTransport(socket);
        var browserEvent = new TaskCompletionSource<CdpEvent>(TaskCreationOptions.RunContinuationsAsynchronously);
        var handlerFailure = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        transport.EventReceived += @event => { browserEvent.TrySetResult(@event); return Task.CompletedTask; };
        transport.EventReceived += _ => throw new InvalidOperationException();
        transport.EventHandlerFailed += _ => handlerFailure.TrySetResult();
        socket.EnqueueJson("{\"method\":\"Target.targetCreated\",\"params\":{\"targetInfo\":{}}}");
        CdpEvent received = await browserEvent.Task.WaitAsync(TimeSpan.FromSeconds(1));
        Assert.Null(received.SessionId);
        Assert.Equal("Target.targetCreated", received.Method);
        Assert.Equal(JsonValueKind.Object, received.Parameters!.Value.ValueKind);
        await handlerFailure.Task.WaitAsync(TimeSpan.FromSeconds(1));

        var release = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        transport.EventReceived += async _ => await release.Task;
        for (int index = 0; index <= CdpTransport.EventQueueCapacity + 1; index++)
        {
            socket.EnqueueJson($"{{\"method\":\"Target.changed\",\"params\":{{\"index\":{index}}}}}");
        }
        await Task.Delay(30);
        CdpTransportException overflow = await Assert.ThrowsAsync<CdpTransportException>(() => transport.SendCommandAsync("Browser.nope"));
        Assert.Equal(CdpTransportFailure.EventQueueOverflow, overflow.Failure);
        release.TrySetResult();
    }

    [Fact]
    public async Task CloseAndAbruptFailure_FailPendingAndRejectNewCommands()
    {
        var closeSocket = new CdpTestSocket();
        await using var closeTransport = new CdpTransport(closeSocket);
        Task<JsonElement> pending = closeTransport.SendCommandAsync("Browser.wait");
        await WaitForAsync(() => closeSocket.Sent.Count == 1);
        closeSocket.EnqueueClose();
        CdpTransportException closed = await Assert.ThrowsAsync<CdpTransportException>(() => pending);
        Assert.Equal(CdpTransportFailure.Closed, closed.Failure);
        Assert.Equal("remote_close", closeTransport.DiagnosticState);
        Assert.Equal("remote_close", closed.Diagnostic!.FirstTerminalReason);
        Assert.Null(closed.Diagnostic.CommandMethod);
        Assert.Null(closed.Diagnostic.CommandPhase);
        await Assert.ThrowsAsync<CdpTransportException>(() => closeTransport.SendCommandAsync("Browser.nope"));

        var failedSocket = new CdpTestSocket();
        await using var failedTransport = new CdpTransport(failedSocket);
        failedSocket.EnqueueFailure(new InvalidOperationException());
        await Task.Delay(10);
        CdpTransportException disconnected = await Assert.ThrowsAsync<CdpTransportException>(() => failedTransport.SendCommandAsync("Browser.nope"));
        Assert.Equal(CdpTransportFailure.Disconnected, disconnected.Failure);
        Assert.Equal("receive_failure", failedTransport.DiagnosticState);
        Assert.Equal("receive_failure", disconnected.Diagnostic!.FirstTerminalReason);
    }

    [Fact]
    public async Task SendFailure_RejectsSubsequentCommandsAndRemainsFirstTerminalCause()
    {
        var socket = new CdpTestSocket();
        var injected = new WebSocketException(WebSocketError.ConnectionClosedPrematurely);
        int sendCallbacks = 0;
        socket.OnSendAsync = _ =>
        {
            Interlocked.Increment(ref sendCallbacks);
            return Task.FromException(injected);
        };
        var transport = new CdpTransport(socket);

        Assert.Equal("connected", transport.DiagnosticState);
        CdpTransportException failure = await Assert.ThrowsAsync<CdpTransportException>(
            () => transport.SendCommandAsync("Browser.failing"));

        Assert.Equal(CdpTransportFailure.Disconnected, failure.Failure);
        Assert.Equal("Disconnected", failure.Message);
        Assert.Same(injected, failure.InnerException);
        Assert.Equal("Browser.failing", failure.Diagnostic!.CommandMethod);
        Assert.Equal("socket_send", failure.Diagnostic.CommandPhase);
        Assert.Equal("send_failure", failure.Diagnostic.FirstTerminalReason);
        Assert.Equal("send_failure", transport.DiagnosticState);
        Assert.Equal(0, transport.PendingCommandCount);
        Assert.Equal(1, Volatile.Read(ref sendCallbacks));
        Assert.Single(socket.Sent);

        CdpTransportException subsequent = await Assert.ThrowsAsync<CdpTransportException>(
            () => transport.SendCommandAsync("Browser.subsequent"));
        Assert.Equal(CdpTransportFailure.Disconnected, subsequent.Failure);
        Assert.Equal("Disconnected", subsequent.Message);
        Assert.Same(injected, subsequent.InnerException);
        Assert.Equal(1, Volatile.Read(ref sendCallbacks));
        Assert.Single(socket.Sent);
        Assert.Equal(0, socket.ConnectCalls);

        await transport.DisposeAsync();
        await transport.DisposeAsync();
        Assert.Equal("send_failure", transport.DiagnosticState);
        Assert.Equal(0, socket.DisposeCalls);
    }

    [Fact]
    public async Task GracefulSocketShutdown_LeavesReceiveLoopActiveUntilConnectionOwnerCloses()
    {
        var socket = new CdpTestSocket();
        socket.OnCloseAsync = _ =>
        {
            Assert.Equal(0, socket.ReceiveCancellations);
            socket.EnqueueClose();
            return Task.CompletedTask;
        };
        var connection = new ChromeConnection(() => socket, TimeSpan.FromSeconds(1), TimeSpan.FromSeconds(1));
        Assert.True((await connection.ConnectAsync(new ChromeEndpoint(new Uri("ws://127.0.0.1:9222/devtools/browser/current-id")), CancellationToken.None)).Success);
        var transport = new CdpTransport(socket);

        await socket.ReceiveStarted.WaitAsync(TimeSpan.FromSeconds(1));
        transport.StopForGracefulSocketClose();
        Assert.Equal(0, socket.ReceiveCancellations);

        await connection.DisposeAsync();
        await transport.DisposeAsync();

        Assert.Equal(1, socket.CloseCalls);
        Assert.Equal(1, socket.DisposeCalls);
        Assert.Equal(0, socket.ReceiveCancellations);
    }

    [Fact]
    public async Task Dispose_IsIdempotentAndDoesNotDisposeRunOwnedSocket()
    {
        var socket = new CdpTestSocket();
        var transport = new CdpTransport(socket);
        await transport.DisposeAsync();
        await transport.DisposeAsync();
        Assert.Equal("local_dispose", transport.DiagnosticState);
        Assert.Equal(0, socket.DisposeCalls);
    }

    private static async Task WaitForAsync(Func<bool> condition)
    {
        for (int index = 0; index < 100 && !condition(); index++)
        {
            await Task.Delay(10);
        }
        Assert.True(condition());
    }
}
