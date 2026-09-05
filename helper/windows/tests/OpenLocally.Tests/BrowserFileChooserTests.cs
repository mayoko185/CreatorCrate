using System.Net.WebSockets;
using System.Text.Json;
using OpenLocally;

namespace OpenLocally.Tests;

public class BrowserFileChooserTests
{
    [Fact]
    public async Task AttachFiles_CapturesMatchingEventDuringTrigger_AfterInterceptionIsEnabled()
    {
        var socket = CreateReplyingSocket();
        await using var transport = new CdpTransport(socket);
        bool eventSubscriptionRegistered = false;
        var chooser = new BrowserFileChooser(
            new CdpSession(transport, "session-a"),
            onEventSubscriptionRegistered: () => eventSubscriptionRegistered = true);

        await chooser.AttachFilesAsync(
            ["C:\\fixture\\first.png", "C:\\fixture\\second.png"],
            async _ =>
            {
                Assert.True(eventSubscriptionRegistered, "The file chooser handler must be subscribed before the trigger runs.");
                JsonElement enable = Command(socket.Sent.Single());
                Assert.Equal("Page.setInterceptFileChooserDialog", enable.GetProperty("method").GetString());
                Assert.True(enable.GetProperty("params").GetProperty("enabled").GetBoolean());

                socket.EnqueueJson("{\"method\":\"Page.fileChooserOpened\",\"sessionId\":\"session-b\",\"params\":{\"backendNodeId\":42}}");
                socket.EnqueueJson("{\"method\":\"Page.fileChooserOpened\",\"sessionId\":\"session-a\",\"params\":{\"backendNodeId\":99}}");
                socket.EnqueueJson("{\"method\":\"Page.fileChooserOpened\",\"sessionId\":\"session-a\",\"params\":{\"backendNodeId\":42}}");
                await Task.Delay(20);
            },
            expectedBackendNodeId: 42,
            timeout: TimeSpan.FromSeconds(1));

        JsonElement setFiles = Command(socket.Sent.Single(message => Method(message) == "DOM.setFileInputFiles"));
        Assert.Equal("session-a", setFiles.GetProperty("sessionId").GetString());
        Assert.Equal(["C:\\fixture\\first.png", "C:\\fixture\\second.png"], setFiles.GetProperty("params").GetProperty("files").EnumerateArray().Select(item => item.GetString()));
        Assert.Equal(42, setFiles.GetProperty("params").GetProperty("backendNodeId").GetInt64());
    }

    [Fact]
    public async Task AttachFiles_CapturesEventImmediatelyAfterTriggerReturns()
    {
        var socket = CreateReplyingSocket();
        await using var transport = new CdpTransport(socket);
        var chooser = new BrowserFileChooser(new CdpSession(transport, "session-a"));
        var triggerReturned = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        Task emit = Task.Run(async () =>
        {
            await triggerReturned.Task;
            await Task.Delay(1);
            socket.EnqueueJson("{\"method\":\"Page.fileChooserOpened\",\"sessionId\":\"session-a\",\"params\":{\"backendNodeId\":42}}");
        });

        await chooser.AttachFilesAsync(
            ["C:\\fixture\\first.png"],
            _ =>
            {
                triggerReturned.TrySetResult();
                return Task.CompletedTask;
            },
            expectedBackendNodeId: 42,
            timeout: TimeSpan.FromSeconds(1));
        await emit;

        Assert.Single(socket.Sent.Where(message => Method(message) == "DOM.setFileInputFiles"));
    }

    [Fact]
    public async Task AttachFiles_TimeoutReportsStage_CleansInterception_AndDoesNotReuseLateEvent()
    {
        var socket = CreateReplyingSocket();
        await using var transport = new CdpTransport(socket);
        var chooser = new BrowserFileChooser(new CdpSession(transport, "session-a"));

        BrowserPreparationException exception = await Assert.ThrowsAsync<BrowserPreparationException>(() =>
            chooser.AttachFilesAsync(
                ["C:\\fixture\\first.png"],
                _ => Task.CompletedTask,
                expectedBackendNodeId: 42,
                timeout: TimeSpan.FromMilliseconds(25)));

        Assert.Equal(BrowserPreparationFailure.FileChooserTimedOut, exception.Failure);
        Assert.Contains("phase=waiting_for_fileChooserOpened", exception.Message, StringComparison.Ordinal);
        Assert.Contains("interception_enabled=true", exception.Message, StringComparison.Ordinal);
        Assert.Contains("event_subscription_active=true", exception.Message, StringComparison.Ordinal);
        Assert.Contains("trigger_completed=true", exception.Message, StringComparison.Ordinal);
        Assert.Contains("expected_backend_node_id=42", exception.Message, StringComparison.Ordinal);
        Assert.False(exception.Data.Contains("file_chooser_cleanup_phase"));
        Assert.Equal([true, false], InterceptionStates(socket));

        socket.EnqueueJson("{\"method\":\"Page.fileChooserOpened\",\"sessionId\":\"session-a\",\"params\":{\"backendNodeId\":42}}");
        await Task.Delay(20);
        await chooser.AttachFilesAsync(
            ["C:\\fixture\\second.png"],
            _ =>
            {
                socket.EnqueueJson("{\"method\":\"Page.fileChooserOpened\",\"sessionId\":\"session-a\",\"params\":{\"backendNodeId\":84}}");
                return Task.CompletedTask;
            },
            expectedBackendNodeId: 84,
            timeout: TimeSpan.FromSeconds(1));

        Assert.Equal(84, Command(socket.Sent.Single(message => Method(message) == "DOM.setFileInputFiles")).GetProperty("params").GetProperty("backendNodeId").GetInt64());
    }

    [Fact]
    public async Task AttachFiles_TriggerCommandFailurePropagatesWithoutBecomingTimeout()
    {
        var socket = CreateReplyingSocket();
        await using var transport = new CdpTransport(socket);
        var chooser = new BrowserFileChooser(new CdpSession(transport, "session-a"));
        var expected = new CdpCommandException(-32000, "trigger failed");

        CdpCommandException actual = await Assert.ThrowsAsync<CdpCommandException>(() =>
            chooser.AttachFilesAsync(["C:\\fixture\\first.png"], _ => Task.FromException(expected), expectedBackendNodeId: 42, timeout: TimeSpan.FromSeconds(1)));

        Assert.Same(expected, actual);
        Assert.False(actual.Data.Contains("file_chooser_cleanup_phase"));
        Assert.Equal([true, false], InterceptionStates(socket));
    }

    [Fact]
    public async Task AttachFiles_TimeoutPreservesPrimaryAndRetainsDisableCommandFailure()
    {
        var socket = CreateReplyingSocketWithDisableCommandFailure(-32001, "disable failed");
        await using var transport = new CdpTransport(socket);
        var chooser = new BrowserFileChooser(new CdpSession(transport, "session-a"));

        BrowserPreparationException exception = await Assert.ThrowsAsync<BrowserPreparationException>(() =>
            chooser.AttachFilesAsync(
                ["C:\\fixture\\first.png"],
                _ => Task.CompletedTask,
                expectedBackendNodeId: 42,
                timeout: TimeSpan.FromMilliseconds(25)));

        Assert.Equal(BrowserPreparationFailure.FileChooserTimedOut, exception.Failure);
        Assert.Contains("phase=waiting_for_fileChooserOpened", exception.Message, StringComparison.Ordinal);
        Assert.Contains("expected_backend_node_id=42", exception.Message, StringComparison.Ordinal);
        Assert.Contains(nameof(BrowserFileChooser.AttachFilesAsync), exception.StackTrace, StringComparison.Ordinal);
        AssertCleanupDiagnostic(exception, nameof(CdpCommandException), -32001);
        Assert.Equal([true, false], InterceptionStates(socket));

        int sentCount = socket.Sent.Count;
        InvalidOperationException next = await Assert.ThrowsAsync<InvalidOperationException>(() =>
            chooser.AttachFilesAsync(["C:\\fixture\\second.png"], _ => Task.CompletedTask, expectedBackendNodeId: 42, timeout: TimeSpan.FromSeconds(1)));
        Assert.Equal("File chooser interception state is uncertain for this page session.", next.Message);
        Assert.Equal(sentCount, socket.Sent.Count);
    }

    [Fact]
    public async Task AttachFiles_TriggerFailurePreservesPrimaryWhenDisableLosesTransport()
    {
        var socket = CreateReplyingSocketWithDisableTransportFailure();
        await using var transport = new CdpTransport(socket);
        var chooser = new BrowserFileChooser(new CdpSession(transport, "session-a"));
        var expected = new CdpCommandException(-32000, "trigger failed");

        CdpCommandException actual = await Assert.ThrowsAsync<CdpCommandException>(() =>
            chooser.AttachFilesAsync(["C:\\fixture\\first.png"], _ => Task.FromException(expected), expectedBackendNodeId: 42, timeout: TimeSpan.FromSeconds(1)));

        Assert.Same(expected, actual);
        Assert.Contains(nameof(BrowserFileChooser.AttachFilesAsync), actual.StackTrace, StringComparison.Ordinal);
        AssertCleanupDiagnostic(actual, nameof(CdpTransportException), CdpTransportFailure.Disconnected.ToString());
        Assert.Equal(CdpTransportFailure.Disconnected.ToString(), actual.Data["file_chooser_cleanup_transport_state"]);
        Assert.Equal([true, false], InterceptionStates(socket));

        CdpTransportException next = await Assert.ThrowsAsync<CdpTransportException>(() =>
            chooser.AttachFilesAsync(["C:\\fixture\\second.png"], _ => Task.CompletedTask, expectedBackendNodeId: 42, timeout: TimeSpan.FromSeconds(1)));
        Assert.Equal(CdpTransportFailure.Disconnected, next.Failure);
    }

    [Fact]
    public async Task AttachFiles_SuccessThenDisableFailureSurfacesAndFailsClosed()
    {
        var socket = CreateReplyingSocketWithDisableCommandFailure(-32002, "disable failed");
        await using var transport = new CdpTransport(socket);
        var chooser = new BrowserFileChooser(new CdpSession(transport, "session-a"));

        CdpCommandException exception = await Assert.ThrowsAsync<CdpCommandException>(() =>
            chooser.AttachFilesAsync(
                ["C:\\fixture\\first.png"],
                _ =>
                {
                    socket.EnqueueJson("{\"method\":\"Page.fileChooserOpened\",\"sessionId\":\"session-a\",\"params\":{\"backendNodeId\":42}}");
                    return Task.CompletedTask;
                },
                expectedBackendNodeId: 42,
                timeout: TimeSpan.FromSeconds(1)));

        Assert.Equal(-32002, exception.Code);
        Assert.Equal("disable failed", exception.Message);
        Assert.Empty(exception.Data);
        Assert.Single(socket.Sent.Where(message => Method(message) == "DOM.setFileInputFiles"));
        Assert.Equal([true, false], InterceptionStates(socket));

        int sentCount = socket.Sent.Count;
        InvalidOperationException next = await Assert.ThrowsAsync<InvalidOperationException>(() =>
            chooser.AttachFilesAsync(["C:\\fixture\\second.png"], _ => Task.CompletedTask, expectedBackendNodeId: 42, timeout: TimeSpan.FromSeconds(1)));
        Assert.Equal("File chooser interception state is uncertain for this page session.", next.Message);
        Assert.Equal(sentCount, socket.Sent.Count);
    }

    [Fact]
    public async Task AttachFiles_TransportFailureWhileWaitingPropagatesImmediately()
    {
        var socket = CreateReplyingSocket();
        await using var transport = new CdpTransport(socket);
        var chooser = new BrowserFileChooser(new CdpSession(transport, "session-a"));
        var stopwatch = System.Diagnostics.Stopwatch.StartNew();

        CdpTransportException exception = await Assert.ThrowsAsync<CdpTransportException>(() =>
            chooser.AttachFilesAsync(
                ["C:\\fixture\\first.png"],
                _ =>
                {
                    socket.EnqueueFailure(new WebSocketException(WebSocketError.ConnectionClosedPrematurely));
                    return Task.CompletedTask;
                },
                expectedBackendNodeId: 42,
                timeout: TimeSpan.FromSeconds(5)));

        stopwatch.Stop();
        Assert.Equal(CdpTransportFailure.Disconnected, exception.Failure);
        Assert.True(stopwatch.Elapsed < TimeSpan.FromSeconds(1), $"Transport failure took {stopwatch.Elapsed}.");
    }

    [Fact]
    public async Task AttachFiles_TwoSequentialOperationsUseTheirOwnMatchingEvents()
    {
        var socket = CreateReplyingSocket();
        await using var transport = new CdpTransport(socket);
        var chooser = new BrowserFileChooser(new CdpSession(transport, "session-a"));

        await chooser.AttachFilesAsync(
            ["C:\\fixture\\first.png"],
            _ =>
            {
                socket.EnqueueJson("{\"method\":\"Page.fileChooserOpened\",\"sessionId\":\"session-a\",\"params\":{\"backendNodeId\":41}}");
                return Task.CompletedTask;
            },
            expectedBackendNodeId: 41,
            timeout: TimeSpan.FromSeconds(1));
        await chooser.AttachFilesAsync(
            ["C:\\fixture\\second.png"],
            _ =>
            {
                socket.EnqueueJson("{\"method\":\"Page.fileChooserOpened\",\"sessionId\":\"session-a\",\"params\":{\"backendNodeId\":42}}");
                return Task.CompletedTask;
            },
            expectedBackendNodeId: 42,
            timeout: TimeSpan.FromSeconds(1));

        Assert.Equal([41L, 42L], socket.Sent
            .Where(message => Method(message) == "DOM.setFileInputFiles")
            .Select(message => Command(message).GetProperty("params").GetProperty("backendNodeId").GetInt64()));
        Assert.Equal([true, false, true, false], InterceptionStates(socket));
    }

    [Fact]
    public async Task AttachFiles_FirstSucceedsAndSecondTimesOutWithSecondIdentity()
    {
        var socket = CreateReplyingSocket();
        await using var transport = new CdpTransport(socket);
        var chooser = new BrowserFileChooser(new CdpSession(transport, "session-a"));

        await chooser.AttachFilesAsync(
            ["C:\\fixture\\first.png"],
            _ =>
            {
                socket.EnqueueJson("{\"method\":\"Page.fileChooserOpened\",\"sessionId\":\"session-a\",\"params\":{\"backendNodeId\":41}}");
                return Task.CompletedTask;
            },
            expectedBackendNodeId: 41,
            timeout: TimeSpan.FromSeconds(1));

        BrowserPreparationException exception = await Assert.ThrowsAsync<BrowserPreparationException>(() =>
            chooser.AttachFilesAsync(
                ["C:\\fixture\\second.png"],
                _ => Task.CompletedTask,
                expectedBackendNodeId: 42,
                timeout: TimeSpan.FromMilliseconds(25)));

        Assert.Equal(BrowserPreparationFailure.FileChooserTimedOut, exception.Failure);
        Assert.Contains("expected_backend_node_id=42", exception.Message, StringComparison.Ordinal);
        Assert.Single(socket.Sent.Where(message => Method(message) == "DOM.setFileInputFiles"));
    }

    [Fact]
    public async Task AttachFiles_MatchingEventWithoutBackendNodeFailsClosed()
    {
        var socket = CreateReplyingSocket();
        await using var transport = new CdpTransport(socket);
        var chooser = new BrowserFileChooser(new CdpSession(transport, "session-a"));

        BrowserPreparationException exception = await Assert.ThrowsAsync<BrowserPreparationException>(() =>
            chooser.AttachFilesAsync(
                ["C:\\fixture\\first.png"],
                _ =>
                {
                    socket.EnqueueJson("{\"method\":\"Page.fileChooserOpened\",\"sessionId\":\"session-a\",\"params\":{\"frameId\":\"frame-a\"}}");
                    return Task.CompletedTask;
                },
                expectedBackendNodeId: 42,
                timeout: TimeSpan.FromSeconds(1)));

        Assert.Equal(BrowserPreparationFailure.FileChooserMissingBackendNode, exception.Failure);
        Assert.DoesNotContain(socket.Sent, message => Method(message) == "DOM.setFileInputFiles");
    }

    [Fact]
    public async Task AttachTransientFiles_ArmsBeforeTrigger_ValidatesNewInput_AndPreservesPathOrder()
    {
        var socket = CreateTransientInputSocket(84, ["type", "file", "multiple", ""]);
        await using var transport = new CdpTransport(socket);
        var chooser = new BrowserFileChooser(new CdpSession(transport, "session-a"));

        await chooser.AttachTransientFilesAsync(
            ["C:\\fixture\\second.png", "C:\\fixture\\first.png"],
            "frame-a",
            _ =>
            {
                Assert.Equal([true], InterceptionStates(socket));
                socket.EnqueueJson("{\"method\":\"Page.fileChooserOpened\",\"sessionId\":\"session-a\",\"params\":{\"backendNodeId\":84,\"frameId\":\"frame-a\"}}");
                return Task.CompletedTask;
            },
            TimeSpan.FromSeconds(1));

        JsonElement describe = Command(socket.Sent.Single(message => Method(message) == "DOM.describeNode"));
        Assert.Equal(84, describe.GetProperty("params").GetProperty("backendNodeId").GetInt64());
        JsonElement setFiles = Command(socket.Sent.Single(message => Method(message) == "DOM.setFileInputFiles"));
        Assert.Equal(84, setFiles.GetProperty("params").GetProperty("backendNodeId").GetInt64());
        Assert.Equal(["C:\\fixture\\second.png", "C:\\fixture\\first.png"], setFiles.GetProperty("params").GetProperty("files").EnumerateArray().Select(item => item.GetString()));
    }

    [Fact]
    public async Task AttachTransientFiles_RejectsUnexpectedInputWithoutAssignment()
    {
        var socket = CreateTransientInputSocket(84, null, "DIV");
        await using var transport = new CdpTransport(socket);
        var chooser = new BrowserFileChooser(new CdpSession(transport, "session-a"));

        BrowserPreparationException exception = await Assert.ThrowsAsync<BrowserPreparationException>(() =>
            chooser.AttachTransientFilesAsync(
                ["C:\\fixture\\first.png"], "frame-a",
                _ =>
                {
                    socket.EnqueueJson("{\"method\":\"Page.fileChooserOpened\",\"sessionId\":\"session-a\",\"params\":{\"backendNodeId\":84,\"frameId\":\"frame-a\"}}");
                    return Task.CompletedTask;
                }, TimeSpan.FromSeconds(1)));

        Assert.Equal(BrowserPreparationFailure.FileChooserUnexpectedInput, exception.Failure);
        Assert.DoesNotContain(socket.Sent, message => Method(message) == "DOM.setFileInputFiles");
    }

    [Fact]
    public async Task AttachTransientFiles_WrongSessionTimesOut_AndWrongFrameFailsClosed()
    {
        var wrongSessionSocket = CreateTransientInputSocket(84, ["type", "file"]);
        await using var wrongSessionTransport = new CdpTransport(wrongSessionSocket);
        var wrongSessionChooser = new BrowserFileChooser(new CdpSession(wrongSessionTransport, "session-a"));

        BrowserPreparationException wrongSession = await Assert.ThrowsAsync<BrowserPreparationException>(() =>
            wrongSessionChooser.AttachTransientFilesAsync(
                ["C:\\fixture\\first.png"], "frame-a",
                _ =>
                {
                    wrongSessionSocket.EnqueueJson("{\"method\":\"Page.fileChooserOpened\",\"sessionId\":\"session-b\",\"params\":{\"backendNodeId\":84,\"frameId\":\"frame-a\"}}");
                    return Task.CompletedTask;
                }, TimeSpan.FromMilliseconds(25)));
        Assert.Equal(BrowserPreparationFailure.FileChooserTimedOut, wrongSession.Failure);
        Assert.DoesNotContain(wrongSessionSocket.Sent, message => Method(message) == "DOM.setFileInputFiles");

        var wrongFrameSocket = CreateTransientInputSocket(84, ["type", "file"]);
        await using var wrongFrameTransport = new CdpTransport(wrongFrameSocket);
        var wrongFrameChooser = new BrowserFileChooser(new CdpSession(wrongFrameTransport, "session-a"));

        BrowserPreparationException wrongFrame = await Assert.ThrowsAsync<BrowserPreparationException>(() =>
            wrongFrameChooser.AttachTransientFilesAsync(
                ["C:\\fixture\\first.png"], "frame-a",
                _ =>
                {
                    wrongFrameSocket.EnqueueJson("{\"method\":\"Page.fileChooserOpened\",\"sessionId\":\"session-a\",\"params\":{\"backendNodeId\":84,\"frameId\":\"frame-b\"}}");
                    return Task.CompletedTask;
                }, TimeSpan.FromSeconds(1)));
        Assert.Equal(BrowserPreparationFailure.FileChooserWrongFrame, wrongFrame.Failure);
        Assert.DoesNotContain(wrongFrameSocket.Sent, message => Method(message) == "DOM.setFileInputFiles");
    }

    [Fact]
    public async Task AttachTransientFiles_RejectsMissingParamsFirstEventWithoutAssignment()
    {
        var socket = CreateTransientInputSocket(84, ["type", "file"]);
        await using var transport = new CdpTransport(socket);
        var chooser = new BrowserFileChooser(new CdpSession(transport, "session-a"));
        int triggerCount = 0;

        BrowserPreparationException exception = await Assert.ThrowsAsync<BrowserPreparationException>(() =>
            chooser.AttachTransientFilesAsync(
                ["C:\\fixture\\first.png"], "frame-a",
                _ =>
                {
                    Assert.Equal([true], InterceptionStates(socket));
                    Assert.Equal(1, ++triggerCount);
                    socket.EnqueueJson("{\"method\":\"Page.fileChooserOpened\",\"sessionId\":\"session-a\"}");
                    return Task.CompletedTask;
                }, TimeSpan.FromSeconds(1)));

        Assert.Equal(BrowserPreparationFailure.FileChooserMissingBackendNode, exception.Failure);
        Assert.NotEqual(BrowserPreparationFailure.FileChooserMultipleEvents, exception.Failure);
        Assert.NotEqual(BrowserPreparationFailure.FileChooserTimedOut, exception.Failure);
        Assert.DoesNotContain(socket.Sent, message => Method(message) == "DOM.setFileInputFiles");
        Assert.Equal([true, false], InterceptionStates(socket));
    }

    [Fact]
    public async Task AttachTransientFiles_RejectsMultipleEventsAndCleansInterception()
    {
        var socket = CreateTransientInputSocket(84, ["type", "file"]);
        await using var transport = new CdpTransport(socket);
        var chooser = new BrowserFileChooser(new CdpSession(transport, "session-a"));

        BrowserPreparationException exception = await Assert.ThrowsAsync<BrowserPreparationException>(() =>
            chooser.AttachTransientFilesAsync(
                ["C:\\fixture\\first.png"], "frame-a",
                _ =>
                {
                    socket.EnqueueJson("{\"method\":\"Page.fileChooserOpened\",\"sessionId\":\"session-a\",\"params\":{\"backendNodeId\":84,\"frameId\":\"frame-a\"}}");
                    socket.EnqueueJson("{\"method\":\"Page.fileChooserOpened\",\"sessionId\":\"session-a\",\"params\":{\"backendNodeId\":85,\"frameId\":\"frame-a\"}}");
                    return Task.Delay(20);
                }, TimeSpan.FromSeconds(1)));

        Assert.Equal(BrowserPreparationFailure.FileChooserMultipleEvents, exception.Failure);
        Assert.DoesNotContain(socket.Sent, message => Method(message) == "DOM.setFileInputFiles");
        Assert.Equal([true, false], InterceptionStates(socket));
    }

    [Fact]
    public async Task AttachTransientFiles_CancellationUnsubscribesBeforeLateEvent()
    {
        var socket = CreateTransientInputSocket(84, ["type", "file"]);
        await using var transport = new CdpTransport(socket);
        var chooser = new BrowserFileChooser(new CdpSession(transport, "session-a"));
        using var cancellation = new CancellationTokenSource();

        await Assert.ThrowsAnyAsync<OperationCanceledException>(() =>
            chooser.AttachTransientFilesAsync(
                ["C:\\fixture\\first.png"], "frame-a",
                _ =>
                {
                    cancellation.Cancel();
                    return Task.CompletedTask;
                }, TimeSpan.FromSeconds(1), cancellation.Token));

        socket.EnqueueJson("{\"method\":\"Page.fileChooserOpened\",\"sessionId\":\"session-a\",\"params\":{\"backendNodeId\":84,\"frameId\":\"frame-a\"}}");
        await Task.Delay(20);
        Assert.DoesNotContain(socket.Sent, message => Method(message) == "DOM.setFileInputFiles");
        Assert.Equal([true, false], InterceptionStates(socket));
    }

    [Fact]
    public async Task AttachTransientFiles_RejectsSecondEventBeforeAssignmentCommit()
    {
        var socket = CreateTransientInputSocket(84, ["type", "file"]);
        await using var transport = new CdpTransport(socket);
        var commitBoundaryReached = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var releaseCommit = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var secondCandidateObserved = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        int observedCandidates = 0;
        var chooser = new BrowserFileChooser(
            new CdpSession(transport, "session-a"),
            onCandidateObserved: () =>
            {
                if (Interlocked.Increment(ref observedCandidates) == 2)
                {
                    secondCandidateObserved.TrySetResult();
                }
            },
            beforeAssignmentCommitAsync: async cancellationToken =>
            {
                commitBoundaryReached.TrySetResult();
                await releaseCommit.Task.WaitAsync(cancellationToken);
            });

        Task attachment = chooser.AttachTransientFilesAsync(
            ["C:\\fixture\\first.png"],
            "frame-a",
            _ =>
            {
                socket.EnqueueJson("{\"method\":\"Page.fileChooserOpened\",\"sessionId\":\"session-a\",\"params\":{\"backendNodeId\":84,\"frameId\":\"frame-a\"}}");
                return Task.CompletedTask;
            },
            TimeSpan.FromSeconds(1));

        await commitBoundaryReached.Task;
        socket.EnqueueJson("{\"method\":\"Page.fileChooserOpened\",\"sessionId\":\"session-a\",\"params\":{\"backendNodeId\":85,\"frameId\":\"frame-a\"}}");
        await secondCandidateObserved.Task;
        releaseCommit.TrySetResult();

        BrowserPreparationException exception = await Assert.ThrowsAsync<BrowserPreparationException>(() => attachment);
        Assert.Equal(BrowserPreparationFailure.FileChooserMultipleEvents, exception.Failure);
        Assert.DoesNotContain(socket.Sent, message => Method(message) == "DOM.setFileInputFiles");
        Assert.Equal([true, false], InterceptionStates(socket));
    }

    [Fact]
    public async Task AttachTransientFiles_RejectsWrongFrameSecondEventBeforeAssignmentCommit()
    {
        var socket = CreateTransientInputSocket(84, ["type", "file"]);
        await using var transport = new CdpTransport(socket);
        var commitBoundaryReached = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var releaseCommit = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var secondEventObserved = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        int observedEvents = 0;
        var chooser = new BrowserFileChooser(
            new CdpSession(transport, "session-a"),
            onCandidateObserved: () =>
            {
                if (Interlocked.Increment(ref observedEvents) == 2)
                {
                    secondEventObserved.TrySetResult();
                }
            },
            beforeAssignmentCommitAsync: async cancellationToken =>
            {
                commitBoundaryReached.TrySetResult();
                await releaseCommit.Task.WaitAsync(cancellationToken);
            });

        Task attachment = chooser.AttachTransientFilesAsync(
            ["C:\\fixture\\first.png"],
            "frame-a",
            _ =>
            {
                socket.EnqueueJson("{\"method\":\"Page.fileChooserOpened\",\"sessionId\":\"session-a\",\"params\":{\"backendNodeId\":84,\"frameId\":\"frame-a\"}}");
                return Task.CompletedTask;
            },
            TimeSpan.FromSeconds(1));

        await commitBoundaryReached.Task;
        socket.EnqueueJson("{\"method\":\"Page.fileChooserOpened\",\"sessionId\":\"session-a\",\"params\":{\"backendNodeId\":85,\"frameId\":\"frame-b\"}}");
        await secondEventObserved.Task;
        releaseCommit.TrySetResult();

        BrowserPreparationException exception = await Assert.ThrowsAsync<BrowserPreparationException>(() => attachment);
        Assert.Equal(BrowserPreparationFailure.FileChooserMultipleEvents, exception.Failure);
        Assert.DoesNotContain(socket.Sent, message => Method(message) == "DOM.setFileInputFiles");
        Assert.Equal([true, false], InterceptionStates(socket));
    }

    [Fact]
    public async Task AttachTransientFiles_RejectsMissingBackendSecondEventBeforeAssignmentCommit()
    {
        var socket = CreateTransientInputSocket(84, ["type", "file"]);
        await using var transport = new CdpTransport(socket);
        var commitBoundaryReached = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var releaseCommit = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var secondEventObserved = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        int observedEvents = 0;
        var chooser = new BrowserFileChooser(
            new CdpSession(transport, "session-a"),
            onCandidateObserved: () =>
            {
                if (Interlocked.Increment(ref observedEvents) == 2)
                {
                    secondEventObserved.TrySetResult();
                }
            },
            beforeAssignmentCommitAsync: async cancellationToken =>
            {
                commitBoundaryReached.TrySetResult();
                await releaseCommit.Task.WaitAsync(cancellationToken);
            });

        Task attachment = chooser.AttachTransientFilesAsync(
            ["C:\\fixture\\first.png"],
            "frame-a",
            _ =>
            {
                socket.EnqueueJson("{\"method\":\"Page.fileChooserOpened\",\"sessionId\":\"session-a\",\"params\":{\"backendNodeId\":84,\"frameId\":\"frame-a\"}}");
                return Task.CompletedTask;
            },
            TimeSpan.FromSeconds(1));

        await commitBoundaryReached.Task;
        socket.EnqueueJson("{\"method\":\"Page.fileChooserOpened\",\"sessionId\":\"session-a\",\"params\":{\"frameId\":\"frame-a\"}}");
        await secondEventObserved.Task;
        releaseCommit.TrySetResult();

        BrowserPreparationException exception = await Assert.ThrowsAsync<BrowserPreparationException>(() => attachment);
        Assert.Equal(BrowserPreparationFailure.FileChooserMultipleEvents, exception.Failure);
        Assert.DoesNotContain(socket.Sent, message => Method(message) == "DOM.setFileInputFiles");
        Assert.Equal([true, false], InterceptionStates(socket));
    }

    [Fact]
    public async Task AttachTransientFiles_RejectsMissingParamsSecondEventBeforeAssignmentCommit()
    {
        var socket = CreateTransientInputSocket(84, ["type", "file"]);
        await using var transport = new CdpTransport(socket);
        var commitBoundaryReached = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var releaseCommit = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var secondEventObserved = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        int observedEvents = 0;
        var chooser = new BrowserFileChooser(
            new CdpSession(transport, "session-a"),
            onCandidateObserved: () =>
            {
                if (Interlocked.Increment(ref observedEvents) == 2)
                {
                    secondEventObserved.TrySetResult();
                }
            },
            beforeAssignmentCommitAsync: async cancellationToken =>
            {
                commitBoundaryReached.TrySetResult();
                await releaseCommit.Task.WaitAsync(cancellationToken);
            });

        Task attachment = chooser.AttachTransientFilesAsync(
            ["C:\\fixture\\first.png"],
            "frame-a",
            _ =>
            {
                socket.EnqueueJson("{\"method\":\"Page.fileChooserOpened\",\"sessionId\":\"session-a\",\"params\":{\"backendNodeId\":84,\"frameId\":\"frame-a\"}}");
                return Task.CompletedTask;
            },
            TimeSpan.FromSeconds(1));

        await commitBoundaryReached.Task;
        socket.EnqueueJson("{\"method\":\"Page.fileChooserOpened\",\"sessionId\":\"session-a\"}");
        await secondEventObserved.Task;
        releaseCommit.TrySetResult();

        BrowserPreparationException exception = await Assert.ThrowsAsync<BrowserPreparationException>(() => attachment);
        Assert.Equal(BrowserPreparationFailure.FileChooserMultipleEvents, exception.Failure);
        Assert.DoesNotContain(socket.Sent, message => Method(message) == "DOM.setFileInputFiles");
        Assert.Equal([true, false], InterceptionStates(socket));
    }

    [Fact]
    public async Task AttachTransientFiles_RejectsMalformedOrUnsafeAttributesWithoutAssignment()
    {
        (object?[] Attributes, string[] Paths, BrowserPreparationFailure Failure)[] cases =
        [
            (new object?[] { "type", "file", "disabled" }, ["C:\\fixture\\first.png"], BrowserPreparationFailure.FileChooserUnexpectedInput),
            (new object?[] { "type", "file", 1, "" }, ["C:\\fixture\\first.png"], BrowserPreparationFailure.FileChooserUnexpectedInput),
            (new object?[] { 1, "file" }, ["C:\\fixture\\first.png"], BrowserPreparationFailure.FileChooserUnexpectedInput),
            (new object?[] { "type", 1 }, ["C:\\fixture\\first.png"], BrowserPreparationFailure.FileChooserUnexpectedInput),
            (new object?[] { "type", "file", "type", "text" }, ["C:\\fixture\\first.png"], BrowserPreparationFailure.FileChooserUnexpectedInput),
            (new object?[] { "type", "file", "disabled", "", "disabled", "" }, ["C:\\fixture\\first.png"], BrowserPreparationFailure.FileChooserUnexpectedInput),
            (new object?[] { "type", "file", "multiple", "", "multiple", "" }, ["C:\\fixture\\first.png", "C:\\fixture\\second.png"], BrowserPreparationFailure.FileChooserUnexpectedInput),
            (new object?[] { "type", "file", "disabled", "" }, ["C:\\fixture\\first.png"], BrowserPreparationFailure.FileChooserUnexpectedInput),
            (new object?[] { "type", "file" }, ["C:\\fixture\\first.png", "C:\\fixture\\second.png"], BrowserPreparationFailure.FileChooserMultipleFilesUnsupported),
        ];

        foreach ((object?[] attributes, string[] paths, BrowserPreparationFailure failure) in cases)
        {
            var socket = CreateTransientInputSocket(84, attributes);
            await using var transport = new CdpTransport(socket);
            var chooser = new BrowserFileChooser(new CdpSession(transport, "session-a"));

            BrowserPreparationException exception = await Assert.ThrowsAsync<BrowserPreparationException>(() =>
                chooser.AttachTransientFilesAsync(
                    paths,
                    "frame-a",
                    _ =>
                    {
                        socket.EnqueueJson("{\"method\":\"Page.fileChooserOpened\",\"sessionId\":\"session-a\",\"params\":{\"backendNodeId\":84,\"frameId\":\"frame-a\"}}");
                        return Task.CompletedTask;
                    },
                    TimeSpan.FromSeconds(1)));

            Assert.Equal(failure, exception.Failure);
            Assert.DoesNotContain(socket.Sent, message => Method(message) == "DOM.setFileInputFiles");
        }
    }

    [Fact]
    public async Task AttachTransientFiles_AcceptsValidatedSingleFileInput()
    {
        var socket = CreateTransientInputSocket(84, ["type", "file"]);
        await using var transport = new CdpTransport(socket);
        var chooser = new BrowserFileChooser(new CdpSession(transport, "session-a"));

        await chooser.AttachTransientFilesAsync(
            ["C:\\fixture\\first.png"],
            "frame-a",
            _ =>
            {
                socket.EnqueueJson("{\"method\":\"Page.fileChooserOpened\",\"sessionId\":\"session-a\",\"params\":{\"backendNodeId\":84,\"frameId\":\"frame-a\"}}");
                return Task.CompletedTask;
            },
            TimeSpan.FromSeconds(1));

        Assert.Single(socket.Sent.Where(message => Method(message) == "DOM.setFileInputFiles"));
    }

    private static CdpTestSocket CreateTransientInputSocket(long backendNodeId, object?[]? attributes, string nodeName = "INPUT")
    {
        var socket = new CdpTestSocket();
        socket.OnSendAsync = message =>
        {
            JsonElement command = Command(message);
            string? method = command.GetProperty("method").GetString();
            string result = method == "DOM.describeNode"
                ? JsonSerializer.Serialize(new { node = new { backendNodeId, nodeName, attributes } })
                : "{}";
            socket.EnqueueJson($"{{\"id\":{command.GetProperty("id").GetInt64()},\"result\":{result}}}");
            return Task.CompletedTask;
        };
        return socket;
    }

    private static CdpTestSocket CreateReplyingSocketWithDisableCommandFailure(int code, string message)
    {
        var socket = new CdpTestSocket();
        socket.OnSendAsync = payload =>
        {
            JsonElement command = Command(payload);
            long id = command.GetProperty("id").GetInt64();
            if (IsDisableInterception(command))
            {
                socket.EnqueueJson($"{{\"id\":{id},\"error\":{{\"code\":{code},\"message\":{JsonSerializer.Serialize(message)}}}}}");
            }
            else
            {
                socket.EnqueueJson($"{{\"id\":{id},\"result\":{{}}}}");
            }
            return Task.CompletedTask;
        };
        return socket;
    }

    private static CdpTestSocket CreateReplyingSocketWithDisableTransportFailure()
    {
        var socket = new CdpTestSocket();
        socket.OnSendAsync = payload =>
        {
            JsonElement command = Command(payload);
            if (IsDisableInterception(command))
            {
                socket.EnqueueFailure(new WebSocketException(WebSocketError.ConnectionClosedPrematurely));
            }
            else
            {
                socket.EnqueueJson($"{{\"id\":{command.GetProperty("id").GetInt64()},\"result\":{{}}}}");
            }
            return Task.CompletedTask;
        };
        return socket;
    }

    private static bool IsDisableInterception(JsonElement command) =>
        string.Equals(command.GetProperty("method").GetString(), "Page.setInterceptFileChooserDialog", StringComparison.Ordinal) &&
        command.GetProperty("params").GetProperty("enabled").ValueKind == JsonValueKind.False;

    private static void AssertCleanupDiagnostic(Exception exception, string errorType, object error)
    {
        Assert.Equal("cleanup", exception.Data["file_chooser_cleanup_phase"]);
        Assert.Equal("disable_file_chooser_interception", exception.Data["file_chooser_cleanup_operation"]);
        Assert.Equal(errorType, exception.Data["file_chooser_cleanup_error_type"]);
        Assert.Equal(error, exception.Data["file_chooser_cleanup_error"]);
    }

    private static CdpTestSocket CreateReplyingSocket()
    {
        var socket = new CdpTestSocket();
        socket.OnSendAsync = message =>
        {
            JsonElement command = Command(message);
            socket.EnqueueJson($"{{\"id\":{command.GetProperty("id").GetInt64()},\"result\":{{}}}}");
            return Task.CompletedTask;
        };
        return socket;
    }

    private static bool[] InterceptionStates(CdpTestSocket socket) => socket.Sent
        .Where(message => Method(message) == "Page.setInterceptFileChooserDialog")
        .Select(message => Command(message).GetProperty("params").GetProperty("enabled").GetBoolean())
        .ToArray();

    private static JsonElement Command(string message) => JsonDocument.Parse(message).RootElement.Clone();
    private static string? Method(string message) => Command(message).GetProperty("method").GetString();
}
