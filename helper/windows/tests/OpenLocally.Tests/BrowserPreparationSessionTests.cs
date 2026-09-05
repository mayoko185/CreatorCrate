using System.Reflection;
using System.Text;
using System.Text.Json;
using OpenLocally;

namespace OpenLocally.Tests;

public class BrowserPreparationSessionTests
{
    [Theory]
    [InlineData(false, false)]
    [InlineData(false, true)]
    [InlineData(true, false)]
    [InlineData(true, true)]
    public async Task DescribeObserver_IsSynchronousIsolatedAndUsesOneResponse(bool valid, bool observerThrows)
    {
        string response = valid
            ? "{\"node\":{\"nodeId\":12,\"backendNodeId\":120,\"nodeName\":\"BUTTON\"}}"
            : "{\"node\":{\"nodeId\":12,\"backendNodeId\":0,\"nodeName\":\"BUTTON\"}}";
        var socket = new CdpTestSocket();
        socket.OnSendAsync = message => ReplyAsync(socket, message, method => method switch
        {
            "Target.createTarget" => "{\"targetId\":\"owned\"}",
            "Target.attachToTarget" => "{\"sessionId\":\"owned-session\"}",
            "DOM.describeNode" => response,
            _ => "{}",
        });
        await using var transport = new CdpTransport(socket);
        var targets = new BrowserPreparationTargets(new CdpTargetManager(transport));
        await using BrowserPreparationSession page = await targets.CreateOwnedAsync();
        int observed = 0;
        bool sameResponse = false;
        BrowserDomNode? parsed = null;
        Exception? actual = await Record.ExceptionAsync(async () => parsed = await page.DescribeNodeAsync(12,
            CancellationToken.None, raw =>
            {
                observed++;
                sameResponse = response == raw.GetRawText();
                if (observerThrows) throw new InvalidOperationException("private observer failure");
            }));
        Assert.Equal(1, observed);
        Assert.True(sameResponse);
        Assert.Single(socket.Sent.Where(message => Method(message) == "DOM.describeNode"));
        BrowserDomNode? legacy = null;
        Exception? original = await Record.ExceptionAsync(async () => legacy = await page.DescribeNodeAsync(12, CancellationToken.None));
        Assert.Equal(1, observed); // The existing signature never opts into observation.
        Assert.Equal(2, socket.Sent.Count(message => Method(message) == "DOM.describeNode"));
        if (valid)
        {
            Assert.Null(actual);
            Assert.Null(original);
            Assert.Equal(legacy!.NodeId, parsed!.NodeId);
            Assert.Equal(legacy.BackendNodeId, parsed.BackendNodeId);
            Assert.Equal(legacy.NodeName, parsed.NodeName);
            Assert.Equal(legacy.SessionId, parsed.SessionId);
        }
        else
        {
            var failure = Assert.IsType<BrowserPreparationException>(actual);
            var baseline = Assert.IsType<BrowserPreparationException>(original);
            Assert.Equal(BrowserPreparationFailure.InvalidNode, failure.Failure);
            Assert.Equal(baseline.Message, failure.Message);
            Assert.Null(failure.InnerException);
        }
    }

    [Fact]
    public async Task CreateOwnedAttachNavigateAndClose_UseOnlyExistingFlattenedPrimitives()
    {
        var socket = new CdpTestSocket();
        socket.OnSendAsync = message => ReplyAsync(socket, message, method => method switch
        {
            "Target.createTarget" => "{\"targetId\":\"owned\"}",
            "Target.attachToTarget" => "{\"sessionId\":\"owned-session\"}",
            "Page.navigate" => "{\"frameId\":\"frame\"}",
            "Target.closeTarget" => "{\"success\":true}",
            _ => "{}",
        });
        await using var transport = new CdpTransport(socket);
        var targets = new BrowserPreparationTargets(new CdpTargetManager(transport));
        await using BrowserPreparationSession page = await targets.CreateOwnedAsync();

        BrowserNavigationResult navigation = await page.NavigateAsync("https://fixture.test/compose");
        await page.CloseOwnedTargetAsync();

        Assert.True(page.OwnsTarget);
        Assert.Equal("frame", navigation.FrameId);
        JsonElement create = Sent(socket, "Target.createTarget");
        Assert.Equal("about:blank", create.GetProperty("params").GetProperty("url").GetString());
        Assert.Equal("owned-session", Sent(socket, "Page.navigate").GetProperty("sessionId").GetString());
        Assert.Equal("owned", Sent(socket, "Target.closeTarget").GetProperty("params").GetProperty("targetId").GetString());
    }

    [Fact]
    public async Task RelinquishOwnedTarget_DetachesWithoutClosingAndMakesLaterCleanupSafe()
    {
        var socket = new CdpTestSocket();
        socket.OnSendAsync = message => ReplyAsync(socket, message, method => method switch
        {
            "Target.createTarget" => "{\"targetId\":\"owned\"}",
            "Target.attachToTarget" => "{\"sessionId\":\"owned-session\"}",
            _ => "{}",
        });

        await using (var transport = new CdpTransport(socket))
        {
            var targets = new BrowserPreparationTargets(new CdpTargetManager(transport));
            BrowserPreparationSession page = await targets.CreateOwnedAsync();

            await page.RelinquishOwnedTargetAsync();
            await page.DisposeAsync();

            Assert.True(page.OwnsTarget);
            Assert.Equal(1, socket.Sent.Count(message => Method(message) == "Target.detachFromTarget"));
            Assert.DoesNotContain(socket.Sent, message => Method(message) == "Target.closeTarget");
        }

        Assert.Equal(1, socket.Sent.Count(message => Method(message) == "Target.detachFromTarget"));
        Assert.DoesNotContain(socket.Sent, message => Method(message) == "Target.closeTarget");
    }

    [Fact]
    public async Task RelinquishOwnedTarget_OverlappingLifecycleCallsShareOneTerminalDetach()
    {
        var socket = new CdpTestSocket();
        var detachStarted = new TaskCompletionSource<long>(TaskCreationOptions.RunContinuationsAsynchronously);
        socket.OnSendAsync = message =>
        {
            JsonElement command = JsonDocument.Parse(message).RootElement;
            string method = command.GetProperty("method").GetString()!;
            if (method == "Target.detachFromTarget")
            {
                detachStarted.TrySetResult(command.GetProperty("id").GetInt64());
                return Task.CompletedTask;
            }

            string result = method switch
            {
                "Target.createTarget" => "{\"targetId\":\"owned\"}",
                "Target.attachToTarget" => "{\"sessionId\":\"owned-session\"}",
                _ => "{}",
            };
            socket.EnqueueJson($"{{\"id\":{command.GetProperty("id").GetInt64()},\"result\":{result}}}");
            return Task.CompletedTask;
        };
        await using var transport = new CdpTransport(socket);
        var targets = new BrowserPreparationTargets(new CdpTargetManager(transport));
        BrowserPreparationSession page = await targets.CreateOwnedAsync();

        Task firstRelinquish = page.RelinquishOwnedTargetAsync();
        long detachId = await detachStarted.Task;
        Task secondRelinquish = page.RelinquishOwnedTargetAsync();
        Task dispose = page.DisposeAsync().AsTask();

        Assert.Equal(1, socket.Sent.Count(message => Method(message) == "Target.detachFromTarget"));
        socket.EnqueueJson($"{{\"id\":{detachId},\"result\":{{}}}}");
        await Task.WhenAll(firstRelinquish, secondRelinquish, dispose);
        await page.DisposeAsync();

        Assert.Equal(1, socket.Sent.Count(message => Method(message) == "Target.detachFromTarget"));
        Assert.DoesNotContain(socket.Sent, message => Method(message) == "Target.closeTarget");
    }

    [Fact]
    public async Task RelinquishOwnedTarget_FailedDetachClearsSharedTaskBeforePublishingFailure()
    {
        var socket = new CdpTestSocket();
        var firstDetachStarted = new TaskCompletionSource<long>(TaskCreationOptions.RunContinuationsAsynchronously);
        var secondDetachStarted = new TaskCompletionSource<long>(TaskCreationOptions.RunContinuationsAsynchronously);
        int detachAttempts = 0;
        socket.OnSendAsync = message =>
        {
            JsonElement command = JsonDocument.Parse(message).RootElement;
            long id = command.GetProperty("id").GetInt64();
            string method = command.GetProperty("method").GetString()!;
            if (method == "Target.detachFromTarget")
            {
                if (Interlocked.Increment(ref detachAttempts) == 1) firstDetachStarted.TrySetResult(id);
                else secondDetachStarted.TrySetResult(id);
                return Task.CompletedTask;
            }

            string result = method switch
            {
                "Target.createTarget" => "{\"targetId\":\"owned\"}",
                "Target.attachToTarget" => "{\"sessionId\":\"owned-session\"}",
                _ => "{}",
            };
            socket.EnqueueJson($"{{\"id\":{id},\"result\":{result}}}");
            return Task.CompletedTask;
        };
        await using var transport = new CdpTransport(socket);
        var targets = new BrowserPreparationTargets(new CdpTargetManager(transport));
        BrowserPreparationSession page = await targets.CreateOwnedAsync();

        Task firstRelinquish = page.RelinquishOwnedTargetAsync();
        long firstDetachId = await firstDetachStarted.Task;
        Task firstSharedTask = Assert.IsType<Task>(typeof(BrowserPreparationSession)
            .GetField("_terminalDetachTask", BindingFlags.Instance | BindingFlags.NonPublic)!
            .GetValue(page));
        var failureScheduler = new FailurePublicationScheduler();
        Task firstFailureContinuation = firstSharedTask.ContinueWith(
            _ => { },
            CancellationToken.None,
            TaskContinuationOptions.OnlyOnFaulted,
            failureScheduler);

        socket.EnqueueJson($"{{\"id\":{firstDetachId},\"error\":{{\"code\":-32001,\"message\":\"detach denied\"}}}}");
        await failureScheduler.Queued.WaitAsync(TimeSpan.FromSeconds(1));

        Task retry = page.RelinquishOwnedTargetAsync();
        try
        {
            long secondDetachId = await secondDetachStarted.Task.WaitAsync(TimeSpan.FromSeconds(1));
            socket.EnqueueJson($"{{\"id\":{secondDetachId},\"result\":{{}}}}");
        }
        finally
        {
            failureScheduler.Release();
        }

        await firstFailureContinuation;
        await Assert.ThrowsAsync<CdpCommandException>(() => firstRelinquish);
        await retry;
        await page.DisposeAsync();

        Assert.Equal(2, socket.Sent.Count(message => Method(message) == "Target.detachFromTarget"));
        Assert.DoesNotContain(socket.Sent, message => Method(message) == "Target.closeTarget");
    }

    [Fact]
    public async Task RelinquishOwnedTarget_FailedDetachDoesNotCommitTerminalState()
    {
        var socket = new CdpTestSocket();
        int detachAttempts = 0;
        socket.OnSendAsync = message =>
        {
            JsonElement command = JsonDocument.Parse(message).RootElement;
            long id = command.GetProperty("id").GetInt64();
            string method = command.GetProperty("method").GetString()!;
            if (method == "Target.detachFromTarget" && Interlocked.Increment(ref detachAttempts) == 1)
            {
                socket.EnqueueJson($"{{\"id\":{id},\"error\":{{\"code\":-32001,\"message\":\"detach denied\"}}}}");
                return Task.CompletedTask;
            }

            string result = method switch
            {
                "Target.createTarget" => "{\"targetId\":\"owned\"}",
                "Target.attachToTarget" => "{\"sessionId\":\"owned-session\"}",
                _ => "{}",
            };
            socket.EnqueueJson($"{{\"id\":{id},\"result\":{result}}}");
            return Task.CompletedTask;
        };
        await using var transport = new CdpTransport(socket);
        var targets = new BrowserPreparationTargets(new CdpTargetManager(transport));
        BrowserPreparationSession page = await targets.CreateOwnedAsync();

        await Assert.ThrowsAsync<CdpCommandException>(() => page.RelinquishOwnedTargetAsync());
        await page.RelinquishOwnedTargetAsync();
        await page.DisposeAsync();

        Assert.Equal(2, socket.Sent.Count(message => Method(message) == "Target.detachFromTarget"));
        Assert.DoesNotContain(socket.Sent, message => Method(message) == "Target.closeTarget");
    }

    [Fact]
    public async Task AttachedOperatorTarget_CannotBeClosedByCleanup()
    {
        var socket = new CdpTestSocket();
        socket.OnSendAsync = message => ReplyAsync(socket, message, method => method switch
        {
            "Target.getTargets" => "{\"targetInfos\":[{\"targetId\":\"operator\",\"type\":\"page\",\"url\":\"https://fixture.test\",\"title\":\"Operator\"}]}",
            "Target.attachToTarget" => "{\"sessionId\":\"operator-session\"}",
            _ => "{}",
        });
        await using var transport = new CdpTransport(socket);
        var targets = new BrowserPreparationTargets(new CdpTargetManager(transport));
        BrowserPreparationSession page = await targets.AttachAsync("operator");

        BrowserPreparationException closeException = await Assert.ThrowsAsync<BrowserPreparationException>(() => page.CloseOwnedTargetAsync());
        BrowserPreparationException relinquishException = await Assert.ThrowsAsync<BrowserPreparationException>(() => page.RelinquishOwnedTargetAsync());
        await page.DisposeAsync();

        Assert.Equal(BrowserPreparationFailure.NotOwnedTarget, closeException.Failure);
        Assert.Equal(BrowserPreparationFailure.NotOwnedTarget, relinquishException.Failure);
        Assert.Contains(socket.Sent, message => Method(message) == "Target.detachFromTarget");
        Assert.DoesNotContain(socket.Sent, message => Method(message) == "Target.closeTarget");
    }

    [Fact]
    public async Task ActivateAsync_UsesResolvedNodeBoundsAndNormalPrimaryButtonEvents()
    {
        var socket = CreateNodeSocket("BUTTON", null);
        await using var transport = new CdpTransport(socket);
        await using BrowserPreparationSession page = await BrowserPreparationSession.AttachAsync(new CdpTargetManager(transport), "fixture");
        BrowserDomNode control = Assert.IsType<BrowserDomNode>(await page.FindNodeAsync("#fixture-compose"));

        await page.ActivateAsync(control);

        Assert.Equal(22, Sent(socket, "DOM.scrollIntoViewIfNeeded").GetProperty("params").GetProperty("backendNodeId").GetInt64());
        Assert.Equal(22, Sent(socket, "DOM.getBoxModel").GetProperty("params").GetProperty("backendNodeId").GetInt64());
        JsonElement[] events = socket.Sent.Where(message => Method(message) == "Input.dispatchMouseEvent").Select(message => JsonDocument.Parse(message).RootElement).ToArray();
        Assert.Equal(2, events.Length);
        Assert.Equal("mousePressed", events[0].GetProperty("params").GetProperty("type").GetString());
        Assert.Equal("left", events[0].GetProperty("params").GetProperty("button").GetString());
        Assert.Equal(1, events[0].GetProperty("params").GetProperty("buttons").GetInt32());
        Assert.Equal("mouseReleased", events[1].GetProperty("params").GetProperty("type").GetString());
        Assert.Equal(0, events[1].GetProperty("params").GetProperty("buttons").GetInt32());
        Assert.DoesNotContain(socket.Sent, message => Method(message) is "Runtime.evaluate" or "Runtime.callFunctionOn" or "Input.dispatchKeyEvent");
    }

    [Fact]
    public async Task ActivateAsync_ObserverReportsOnlyCompletedMilestonesAndCannotChangeActivation()
    {
        var socket = CreateNodeSocket("BUTTON", null);
        await using var transport = new CdpTransport(socket);
        await using BrowserPreparationSession page = await BrowserPreparationSession.AttachAsync(new CdpTargetManager(transport), "fixture");
        BrowserDomNode control = Assert.IsType<BrowserDomNode>(await page.FindNodeAsync("#fixture-compose"));
        var stages = new List<BrowserPreparationActivationStage>();

        await page.ActivateAsync(control, stage =>
        {
            stages.Add(stage);
            if (stage == BrowserPreparationActivationStage.BoxReady) throw new InvalidOperationException("fixture observer failure");
        });

        Assert.Equal(
            [
                BrowserPreparationActivationStage.NodeReady,
                BrowserPreparationActivationStage.ScrollReady,
                BrowserPreparationActivationStage.BoxReady,
                BrowserPreparationActivationStage.MousePressSent,
                BrowserPreparationActivationStage.MouseReleaseSent,
            ],
            stages);
        Assert.Equal(2, socket.Sent.Count(message => Method(message) == "Input.dispatchMouseEvent"));
    }

    [Theory]
    [InlineData("Accessibility.enable")]
    [InlineData("Accessibility.getPartialAXTree")]
    public async Task ReadTextAsync_PropagatesAccessibilityCommandFailures(string failedMethod)
    {
        var socket = new CdpTestSocket();
        socket.OnSendAsync = message =>
        {
            JsonElement command = JsonDocument.Parse(message).RootElement;
            long id = command.GetProperty("id").GetInt64();
            string method = command.GetProperty("method").GetString()!;
            if (method == failedMethod)
            {
                socket.EnqueueJson($"{{\"id\":{id},\"error\":{{\"code\":-32001,\"message\":\"AX command denied\"}}}}");
                return Task.CompletedTask;
            }

            string result = method switch
            {
                "Target.getTargets" => "{\"targetInfos\":[{\"targetId\":\"fixture\",\"type\":\"page\",\"url\":\"https://fixture.test\",\"title\":\"Fixture\"}]}",
                "Target.attachToTarget" => "{\"sessionId\":\"fixture-session\"}",
                "DOM.getDocument" => "{\"root\":{\"nodeId\":1,\"backendNodeId\":11,\"nodeName\":\"#document\"}}",
                "DOM.querySelector" => "{\"nodeId\":2}",
                "DOM.describeNode" => "{\"node\":{\"nodeId\":2,\"backendNodeId\":22,\"nodeName\":\"INPUT\"}}",
                _ => "{}",
            };
            socket.EnqueueJson($"{{\"id\":{id},\"result\":{result}}}");
            return Task.CompletedTask;
        };
        await using var transport = new CdpTransport(socket);
        await using BrowserPreparationSession page = await BrowserPreparationSession.AttachAsync(new CdpTargetManager(transport), "fixture");
        BrowserDomNode node = Assert.IsType<BrowserDomNode>(await page.FindNodeAsync("#fixture-title"));

        CdpCommandException exception = await Assert.ThrowsAsync<CdpCommandException>(() => page.ReadTextAsync(node));

        Assert.Equal(-32001, exception.Code);
        Assert.Equal("AX command denied", exception.Message);
        Assert.Equal(1, socket.Sent.Count(message => Method(message) == failedMethod));
        if (failedMethod == "Accessibility.enable")
        {
            Assert.DoesNotContain(socket.Sent, message => Method(message) == "Accessibility.getPartialAXTree");
        }
    }

    [Fact]
    public async Task ReadTextAsync_PropagatesAccessibilityTransportFailure()
    {
        var socket = new CdpTestSocket();
        socket.OnSendAsync = message =>
        {
            JsonElement command = JsonDocument.Parse(message).RootElement;
            string method = command.GetProperty("method").GetString()!;
            if (method == "Accessibility.getPartialAXTree")
            {
                socket.EnqueueFailure(new InvalidOperationException("transport lost"));
                return Task.CompletedTask;
            }

            string result = method switch
            {
                "Target.getTargets" => "{\"targetInfos\":[{\"targetId\":\"fixture\",\"type\":\"page\",\"url\":\"https://fixture.test\",\"title\":\"Fixture\"}]}",
                "Target.attachToTarget" => "{\"sessionId\":\"fixture-session\"}",
                "DOM.getDocument" => "{\"root\":{\"nodeId\":1,\"backendNodeId\":11,\"nodeName\":\"#document\"}}",
                "DOM.querySelector" => "{\"nodeId\":2}",
                "DOM.describeNode" => "{\"node\":{\"nodeId\":2,\"backendNodeId\":22,\"nodeName\":\"INPUT\"}}",
                _ => "{}",
            };
            socket.EnqueueJson($"{{\"id\":{command.GetProperty("id").GetInt64()},\"result\":{result}}}");
            return Task.CompletedTask;
        };
        await using var transport = new CdpTransport(socket);
        BrowserPreparationSession page = await BrowserPreparationSession.AttachAsync(new CdpTargetManager(transport), "fixture");
        BrowserDomNode node = Assert.IsType<BrowserDomNode>(await page.FindNodeAsync("#fixture-title"));

        CdpTransportException exception = await Assert.ThrowsAsync<CdpTransportException>(() => page.ReadTextAsync(node));

        Assert.Equal(CdpTransportFailure.Disconnected, exception.Failure);
        await Assert.ThrowsAsync<CdpTransportException>(() => page.DisposeAsync().AsTask());
    }

    [Fact]
    public async Task ReadTextAsync_UsesPresentNonemptyAccessibilityValue()
    {
        var socket = CreateTextReadbackSocket("{\"nodes\":[{\"value\":{\"value\":\"Fixture AX Value\"},\"name\":{\"value\":\"SHOULD NOT BE USED\"}}]}");
        await using var transport = new CdpTransport(socket);
        await using BrowserPreparationSession page = await BrowserPreparationSession.AttachAsync(new CdpTargetManager(transport), "fixture");
        BrowserDomNode node = Assert.IsType<BrowserDomNode>(await page.FindNodeAsync("#fixture-title"));

        BrowserTextReadback readback = await page.ReadTextAsync(node);

        Assert.Equal(BrowserTextVerification.Mismatch, readback.Verification);
        Assert.Equal("Fixture AX Value", readback.Actual);
    }

    [Fact]
    public async Task ReadTextAsync_UsesPresentEmptyAccessibilityValueWithoutNameFallback()
    {
        const string name = "SHOULD NOT BE USED";
        var socket = CreateTextReadbackSocket("{\"nodes\":[{\"value\":{\"value\":\"\"},\"name\":{\"value\":\"SHOULD NOT BE USED\"}}]}");
        await using var transport = new CdpTransport(socket);
        await using BrowserPreparationSession page = await BrowserPreparationSession.AttachAsync(new CdpTargetManager(transport), "fixture");
        BrowserDomNode node = Assert.IsType<BrowserDomNode>(await page.FindNodeAsync("#fixture-title"));

        BrowserTextReadback readback = await page.ReadTextAsync(node);

        Assert.Equal(BrowserTextVerification.Mismatch, readback.Verification);
        Assert.Equal(string.Empty, readback.Actual);
        Assert.NotEqual(name, readback.Actual);
    }

    [Theory]
    [InlineData("INPUT")]
    [InlineData("TEXTAREA")]
    public async Task ReadTextAsync_AtomicControlsKeepRootValueReadback(string nodeName)
    {
        var socket = CreateTextReadbackSocket("{\"nodes\":[{\"value\":{\"value\":\"atomic value\"}}]}", nodeName);
        await using var transport = new CdpTransport(socket);
        await using BrowserPreparationSession page = await BrowserPreparationSession.AttachAsync(new CdpTargetManager(transport), "fixture");
        BrowserDomNode node = Assert.IsType<BrowserDomNode>(await page.FindNodeAsync("#fixture-title"));

        BrowserTextReadback readback = await page.ReadTextAsync(node);

        Assert.Equal("atomic value", readback.Actual);
        Assert.False(Sent(socket, "Accessibility.getPartialAXTree").GetProperty("params").GetProperty("fetchRelatives").GetBoolean());
        Assert.DoesNotContain(socket.Sent, message => Method(message) == "Accessibility.getChildAXNodes");
    }

    [Fact]
    public async Task ReadTextAsync_FallsBackToAccessibilityNameWhenValueIsAbsent()
    {
        const string name = "Fixture Accessible Name";
        const string response = "{\"nodes\":[{\"name\":{\"value\":\"Fixture Accessible Name\"}}]}";
        using JsonDocument document = JsonDocument.Parse(response);
        Assert.False(document.RootElement.GetProperty("nodes")[0].TryGetProperty("value", out _));

        var socket = CreateTextReadbackSocket(response);
        await using var transport = new CdpTransport(socket);
        await using BrowserPreparationSession page = await BrowserPreparationSession.AttachAsync(new CdpTargetManager(transport), "fixture");
        BrowserDomNode node = Assert.IsType<BrowserDomNode>(await page.FindNodeAsync("#fixture-title"));

        BrowserTextReadback readback = await page.ReadTextAsync(node);

        Assert.Equal(BrowserTextVerification.Mismatch, readback.Verification);
        Assert.Equal(name, readback.Actual);
    }

    [Fact]
    public async Task SetFileInputFilesAsync_AssignsKnownNodeWithoutChooserInterception()
    {
        var socket = CreateNodeSocket("INPUT", ["type", "file"]);
        await using var transport = new CdpTransport(socket);
        await using BrowserPreparationSession page = await BrowserPreparationSession.AttachAsync(new CdpTargetManager(transport), "fixture");
        BrowserDomNode input = Assert.IsType<BrowserDomNode>(await page.FindNodeAsync("#fixture-media"));

        await page.SetFileInputFilesAsync(input, ["C:\\fixture\\first.txt", "C:\\fixture\\second.txt"]);

        JsonElement command = Sent(socket, "DOM.setFileInputFiles");
        Assert.Equal(22, command.GetProperty("params").GetProperty("backendNodeId").GetInt64());
        Assert.Equal(["C:\\fixture\\first.txt", "C:\\fixture\\second.txt"], command.GetProperty("params").GetProperty("files").EnumerateArray().Select(path => path.GetString()));
        Assert.DoesNotContain(socket.Sent, message => Method(message) == "Page.setInterceptFileChooserDialog");
        Assert.DoesNotContain(socket.Sent, message => Method(message) is "Runtime.evaluate" or "Runtime.callFunctionOn");
    }

    [Theory]
    [InlineData("INPUT", "text")]
    [InlineData("INPUT", null)]
    [InlineData("DIV", null)]
    public async Task SetFileInputFilesAsync_RejectsNodesThatDoNotProveExplicitFileInput(string nodeName, string? type)
    {
        var socket = CreateNodeSocket(nodeName, type is null ? null : ["type", type]);
        await using var transport = new CdpTransport(socket);
        await using BrowserPreparationSession page = await BrowserPreparationSession.AttachAsync(new CdpTargetManager(transport), "fixture");
        BrowserDomNode node = Assert.IsType<BrowserDomNode>(await page.FindNodeAsync("#fixture-media"));

        BrowserPreparationException exception = await Assert.ThrowsAsync<BrowserPreparationException>(() =>
            page.SetFileInputFilesAsync(node, ["C:\\fixture\\first.txt"]));

        Assert.Equal(BrowserPreparationFailure.InvalidNode, exception.Failure);
        Assert.DoesNotContain(socket.Sent, message => Method(message) == "DOM.setFileInputFiles");
    }

    [Fact]
    public async Task SetFileInputFilesAsync_PropagatesCdpCommandFailureForProvenFileInput()
    {
        var socket = CreateNodeSocket("INPUT", ["type", "file"], failedMethod: "DOM.setFileInputFiles");
        await using var transport = new CdpTransport(socket);
        await using BrowserPreparationSession page = await BrowserPreparationSession.AttachAsync(new CdpTargetManager(transport), "fixture");
        BrowserDomNode node = Assert.IsType<BrowserDomNode>(await page.FindNodeAsync("#fixture-media"));

        CdpCommandException exception = await Assert.ThrowsAsync<CdpCommandException>(() =>
            page.SetFileInputFilesAsync(node, ["C:\\fixture\\first.txt"]));

        Assert.Equal(-32001, exception.Code);
        Assert.Equal(1, socket.Sent.Count(message => Method(message) == "DOM.setFileInputFiles"));
    }

    [Fact]
    public async Task SetFileInputFilesAsync_PropagatesTransportFailureForProvenFileInput()
    {
        var socket = CreateNodeSocket("INPUT", ["type", "file"], failedMethod: "DOM.setFileInputFiles", transportFailure: true);
        await using var transport = new CdpTransport(socket);
        BrowserPreparationSession page = await BrowserPreparationSession.AttachAsync(new CdpTargetManager(transport), "fixture");
        BrowserDomNode node = Assert.IsType<BrowserDomNode>(await page.FindNodeAsync("#fixture-media"));

        CdpTransportException exception = await Assert.ThrowsAsync<CdpTransportException>(() =>
            page.SetFileInputFilesAsync(node, ["C:\\fixture\\first.txt"]));

        Assert.Equal(CdpTransportFailure.Disconnected, exception.Failure);
        await Assert.ThrowsAsync<CdpTransportException>(() => page.DisposeAsync().AsTask());
    }

    [Fact]
    public async Task ReadTextAsync_RichContentEditablePrefersDescendantLineBreakStructureOverParentValue()
    {
        const string expected = "CreatorCrate fixture body line 1\n\nFixture line 3 — Unicode ✓";
        var socket = CreateRichTextReadbackSocket(
            AxNodes(
                AxNode("root", "textbox", value: "CreatorCrate fixture body line 1Fixture line 3 — Unicode ✓", childIds: new[] { "container" }),
                AxNode("container", "generic", childIds: new[] { "line-1", "break-1", "break-2", "line-3" })),
            new Dictionary<string, string>
            {
                ["container"] = AxNodes(
                    AxNode("line-1", "StaticText", name: "CreatorCrate fixture body line 1"),
                    AxNode("break-1", "LineBreak"),
                    AxNode("break-2", "LineBreak"),
                    AxNode("line-3", "StaticText", name: "Fixture line 3 — Unicode ✓")),
            });

        BrowserTextReadback readback = await ReadRichTextAsync(socket);

        Assert.Equal(BrowserTextVerification.Mismatch, readback.Verification);
        Assert.Equal(expected, readback.Actual);
        Assert.Contains("root_role=textbox", readback.Detail, StringComparison.Ordinal);
        Assert.Contains("line_break_nodes=2", readback.Detail, StringComparison.Ordinal);
        Assert.Contains("static_text_nodes=2", readback.Detail, StringComparison.Ordinal);
        Assert.True(Sent(socket, "Accessibility.getPartialAXTree").GetProperty("params").GetProperty("fetchRelatives").GetBoolean());
        Assert.Equal(1, socket.Sent.Count(message => Method(message) == "Accessibility.getChildAXNodes"));
    }

    [Theory]
    [InlineData(1, "a\nb")]
    [InlineData(2, "a\n\nb")]
    [InlineData(3, "a\n\n\nb")]
    public async Task ReadTextAsync_RichContentEditablePreservesEveryExplicitLineBreak(int lineBreakCount, string expected)
    {
        var children = new List<object> { AxNode("a", "StaticText", name: "a") };
        for (int index = 0; index < lineBreakCount; index++) children.Add(AxNode($"break-{index}", "LineBreak"));
        children.Add(AxNode("b", "StaticText", name: "b"));
        var socket = CreateRichTextReadbackSocket(
            AxNodes(AxNode("root", "textbox", value: "ab", childIds: new[] { "container" }), AxNode("container", "generic", childIds: children.Select((_, index) => index == 0 ? "a" : index == children.Count - 1 ? "b" : $"break-{index - 1}").ToArray())),
            new Dictionary<string, string> { ["container"] = AxNodes(children.ToArray()) });

        BrowserTextReadback readback = await ReadRichTextAsync(socket);

        Assert.Equal(expected, readback.Actual);
    }

    [Theory]
    [InlineData(true, "\na")]
    [InlineData(false, "a\n")]
    public async Task ReadTextAsync_RichContentEditablePreservesLeadingAndTrailingLineBreaks(bool leading, string expected)
    {
        object[] children = leading
            ? new object[] { AxNode("break", "LineBreak"), AxNode("a", "StaticText", name: "a") }
            : new object[] { AxNode("a", "StaticText", name: "a"), AxNode("break", "LineBreak") };
        string[] childIds = leading ? new[] { "break", "a" } : new[] { "a", "break" };
        var socket = CreateRichTextReadbackSocket(
            AxNodes(AxNode("root", "textbox", value: "a", childIds: new[] { "container" }), AxNode("container", "generic", childIds: childIds)),
            new Dictionary<string, string> { ["container"] = AxNodes(children) });

        BrowserTextReadback readback = await ReadRichTextAsync(socket);

        Assert.Equal(expected, readback.Actual);
    }

    [Fact]
    public async Task ReadTextAsync_RichContentEditablePreservesUnicodeAndDoesNotDuplicateInlineTextBoxes()
    {
        var socket = CreateRichTextReadbackSocket(
            AxNodes(
                AxNode("root", "textbox", value: "😀€ — ✓", childIds: new[] { "container" }),
                AxNode("container", "generic", childIds: new[] { "first", "break", "last" })),
            new Dictionary<string, string>
            {
                ["container"] = AxNodes(
                    AxNode("first", "StaticText", name: "😀", childIds: new[] { "first-inline" }),
                    AxNode("first-inline", "InlineTextBox", name: "😀"),
                    AxNode("break", "LineBreak"),
                    AxNode("last", "StaticText", name: "€ — ✓", childIds: new[] { "last-inline" }),
                    AxNode("last-inline", "InlineTextBox", name: "€ — ✓")),
            });

        BrowserTextReadback readback = await ReadRichTextAsync(socket);

        Assert.Equal("😀\n€ — ✓", readback.Actual);
        Assert.DoesNotContain(socket.Sent, message => Method(message) == "Accessibility.getChildAXNodes" && Sent(socket, "Accessibility.getChildAXNodes").GetProperty("params").GetProperty("id").GetString() is "first" or "last");
    }

    [Fact]
    public async Task ReadTextAsync_RichContentEditableFallsBackToParentValueWhenDescendantsAreUnavailable()
    {
        var socket = CreateRichTextReadbackSocket(AxNodes(AxNode("root", "textbox", value: "parent fallback", childIds: new[] { "missing" })));

        BrowserTextReadback readback = await ReadRichTextAsync(socket);

        Assert.Equal("parent fallback", readback.Actual);
    }

    [Theory]
    [InlineData("Accessibility.getChildAXNodes", false)]
    [InlineData("Accessibility.getChildAXNodes", true)]
    public async Task ReadTextAsync_RichContentEditablePropagatesChildAccessibilityFailures(string failedMethod, bool transportFailure)
    {
        var socket = CreateRichTextReadbackSocket(
            AxNodes(AxNode("root", "textbox", value: "ab", childIds: new[] { "container" }), AxNode("container", "generic", childIds: new[] { "a", "b" })),
            new Dictionary<string, string>(),
            failedMethod,
            transportFailure);

        if (transportFailure)
        {
            await Assert.ThrowsAsync<CdpTransportException>(() => ReadRichTextAsync(socket));
        }
        else
        {
            await Assert.ThrowsAsync<CdpCommandException>(() => ReadRichTextAsync(socket));
        }
    }

    [Fact]
    public async Task ReadTextAsync_RichContentEditableRequiresTheRequestedBackendDomRoot()
    {
        var socket = CreateRichTextReadbackSocket(AxNodes(AxNode("unrelated", "textbox", value: "unrelated", backendDomNodeId: 999)));

        BrowserTextReadback readback = await ReadRichTextAsync(socket);

        Assert.Equal(BrowserTextVerification.UnsupportedReadback, readback.Verification);
        Assert.Null(readback.Actual);
        Assert.Contains("rich_ax=missing_root", readback.Detail, StringComparison.Ordinal);
        Assert.Contains("requested_backend_dom_node_id=22", readback.Detail, StringComparison.Ordinal);
    }

    [Fact]
    public async Task ReadTextAsync_RichContentEditableTraversesOnlyTheRequestedBackendDomRoot()
    {
        var socket = CreateRichTextReadbackSocket(
            AxNodes(
                AxNode("unrelated", "textbox", value: "unrelated", childIds: new[] { "unrelated-text" }, backendDomNodeId: 999),
                AxNode("unrelated-text", "StaticText", name: "wrong"),
                AxNode("root", "textbox", childIds: new[] { "target-text" })),
            new Dictionary<string, string> { ["root"] = AxNodes(AxNode("target-text", "StaticText", name: "right")) });

        BrowserTextReadback readback = await ReadRichTextAsync(socket);

        Assert.Equal("right", readback.Actual);
        Assert.Equal("root", Sent(socket, "Accessibility.getChildAXNodes").GetProperty("params").GetProperty("id").GetString());
    }

    [Fact]
    public async Task ReadTextAsync_RichContentEditableReconstructsTheLatestLiveFixtureFromTheLaterRequestedRoot()
    {
        const long requestedBackendNodeId = 22;
        const long firstNodeBackendNodeId = 999;
        const string targetRootValue = "CreatorCrate fixture body line 1Fixture line 3 — Unicode ✓";
        const string expected = "CreatorCrate fixture body line 1\n\nFixture line 3 — Unicode ✓";
        string partialTree = AxNodes(
            AxNode("unrelated", "button", name: "WRONG UNRELATED NAME", value: "WRONG UNRELATED VALUE", backendDomNodeId: firstNodeBackendNodeId),
            AxNode("root", "textbox", value: targetRootValue, childIds: new[] { "container" }, backendDomNodeId: requestedBackendNodeId),
            AxNode("container", "generic", childIds: new[] { "line-1", "break-1", "break-2", "line-3" }),
            AxNode("line-1", "StaticText", name: "CreatorCrate fixture body line 1"),
            AxNode("break-1", "LineBreak"),
            AxNode("break-2", "LineBreak"),
            AxNode("line-3", "StaticText", name: "Fixture line 3 — Unicode ✓"));
        using JsonDocument partialTreeDocument = JsonDocument.Parse(partialTree);
        JsonElement partialNodes = partialTreeDocument.RootElement.GetProperty("nodes");

        Assert.Equal(firstNodeBackendNodeId, partialNodes[0].GetProperty("backendDOMNodeId").GetInt64());
        Assert.NotEqual(requestedBackendNodeId, partialNodes[0].GetProperty("backendDOMNodeId").GetInt64());
        Assert.Equal(requestedBackendNodeId, partialNodes[1].GetProperty("backendDOMNodeId").GetInt64());

        var socket = CreateRichTextReadbackSocket(partialTree);

        BrowserTextReadback readback = await ReadRichTextAsync(socket);

        Assert.Equal(expected, readback.Actual);
        Assert.Contains("root_backend_dom_node_id=22", readback.Detail, StringComparison.Ordinal);
        Assert.Contains("root_role=textbox", readback.Detail, StringComparison.Ordinal);
        Assert.Contains($"root_value_utf16_length={targetRootValue.Length}", readback.Detail, StringComparison.Ordinal);
        Assert.Contains($"reconstructed_utf16_length={expected.Length}", readback.Detail, StringComparison.Ordinal);
        Assert.Contains("static_text_nodes=2", readback.Detail, StringComparison.Ordinal);
        Assert.Contains("line_break_nodes=2", readback.Detail, StringComparison.Ordinal);
        Assert.Contains("subtree_complete=true", readback.Detail, StringComparison.Ordinal);
        Assert.DoesNotContain("WRONG UNRELATED VALUE", readback.Actual, StringComparison.Ordinal);
        Assert.DoesNotContain("WRONG UNRELATED NAME", readback.Actual, StringComparison.Ordinal);
        Assert.DoesNotContain("WRONG UNRELATED VALUE", readback.Detail, StringComparison.Ordinal);
        Assert.DoesNotContain("WRONG UNRELATED NAME", readback.Detail, StringComparison.Ordinal);
        Assert.DoesNotContain(targetRootValue, readback.Detail, StringComparison.Ordinal);
        Assert.DoesNotContain(expected, readback.Detail, StringComparison.Ordinal);
    }

    [Fact]
    public async Task ReadTextAsync_RichContentEditableFailsClosedForAnActualAncestorCycle()
    {
        const string targetFallback = "CYCLE TARGET FALLBACK";
        string partialTree = AxNodes(
            AxNode("unrelated", "button", value: "WRONG CYCLE FALLBACK", backendDomNodeId: 999),
            AxNode("root", "textbox", value: targetFallback, childIds: new[] { "partial", "container" }),
            AxNode("partial", "StaticText", name: "partial"),
            AxNode("container", "generic", childIds: new[] { "root" }));
        var socket = CreateRichTextReadbackSocket(partialTree);

        BrowserTextReadback readback = await ReadRichTextAsync(socket);

        Assert.Equal(targetFallback, readback.Actual);
        Assert.DoesNotContain("partial", readback.Actual, StringComparison.Ordinal);
        Assert.DoesNotContain("WRONG CYCLE FALLBACK", readback.Actual, StringComparison.Ordinal);
        Assert.Contains("reconstructed_utf16_length=<unavailable>", readback.Detail, StringComparison.Ordinal);
        Assert.Contains("subtree_complete=false", readback.Detail, StringComparison.Ordinal);
        Assert.Contains("static_text_nodes=1", readback.Detail, StringComparison.Ordinal);
        Assert.DoesNotContain(socket.Sent, message => Method(message) == "Accessibility.getChildAXNodes");
    }

    [Fact]
    public async Task ReadTextAsync_RichContentEditableFallsBackOnlyToTheRequestedRoot()
    {
        var socket = CreateRichTextReadbackSocket(AxNodes(
            AxNode("unrelated", "textbox", value: "unrelated", backendDomNodeId: 999),
            AxNode("root", "textbox", value: "target fallback", childIds: new[] { "missing" })));

        BrowserTextReadback readback = await ReadRichTextAsync(socket);

        Assert.Equal("target fallback", readback.Actual);
        Assert.Contains("subtree_complete=false", readback.Detail, StringComparison.Ordinal);
    }

    [Fact]
    public async Task ReadTextAsync_RichContentEditableTreatsACompleteEmptySubtreeAsAuthoritative()
    {
        var socket = CreateRichTextReadbackSocket(AxNodes(AxNode("root", "textbox", value: "stale root value", childIds: Array.Empty<string>())));

        BrowserTextReadback readback = await ReadRichTextAsync(socket);

        Assert.Equal(string.Empty, readback.Actual);
        Assert.Contains("reconstructed_utf16_length=0", readback.Detail, StringComparison.Ordinal);
        Assert.Contains("subtree_complete=true", readback.Detail, StringComparison.Ordinal);
    }

    [Fact]
    public async Task ReadTextAsync_RichContentEditableTreatsMissingChildIdsAsACompleteEmptySubtree()
    {
        var rootWithoutChildIds = new
        {
            nodeId = "root",
            backendDOMNodeId = 22,
            role = new { value = "textbox" },
            value = new { value = "stale root value" },
        };
        var socket = CreateRichTextReadbackSocket(AxNodes(rootWithoutChildIds));

        BrowserTextReadback readback = await ReadRichTextAsync(socket);

        Assert.Equal(string.Empty, readback.Actual);
        Assert.Contains("subtree_complete=true", readback.Detail, StringComparison.Ordinal);
    }

    [Fact]
    public async Task ReadTextAsync_RichContentEditableFailsClosedForMalformedChildIds()
    {
        var malformedRoot = new
        {
            nodeId = "root",
            backendDOMNodeId = 22,
            role = new { value = "textbox" },
            value = new { value = "fallback" },
            childIds = new object[] { "valid", 42 },
        };
        var socket = CreateRichTextReadbackSocket(AxNodes(malformedRoot));

        BrowserTextReadback readback = await ReadRichTextAsync(socket);

        Assert.Equal("fallback", readback.Actual);
        Assert.Contains("subtree_complete=false", readback.Detail, StringComparison.Ordinal);
        Assert.DoesNotContain(socket.Sent, message => Method(message) == "Accessibility.getChildAXNodes");
    }

    [Fact]
    public async Task ReadTextAsync_RichContentEditableAcceptsExactly128VisitedNodes()
    {
        var children = Enumerable.Range(0, 127).Select(index => $"text-{index}").ToArray();
        var nodes = new List<object> { AxNode("root", "textbox", childIds: children) };
        nodes.AddRange(children.Select(childId => AxNode(childId, "StaticText", name: "x")));
        var socket = CreateRichTextReadbackSocket(AxNodes(nodes.ToArray()));

        BrowserTextReadback readback = await ReadRichTextAsync(socket);

        Assert.Equal(new string('x', 127), readback.Actual);
        Assert.Contains("subtree_complete=true", readback.Detail, StringComparison.Ordinal);
    }

    [Fact]
    public async Task ReadTextAsync_RichContentEditableFailsClosedBeyondThe128NodeBound()
    {
        var children = Enumerable.Range(0, 128).Select(index => $"text-{index}").ToArray();
        var nodes = new List<object> { AxNode("root", "textbox", value: "fallback", childIds: children) };
        nodes.AddRange(children.Select(childId => AxNode(childId, "StaticText", name: "x")));
        var socket = CreateRichTextReadbackSocket(AxNodes(nodes.ToArray()));

        BrowserTextReadback readback = await ReadRichTextAsync(socket);

        Assert.Equal("fallback", readback.Actual);
        Assert.Contains("subtree_complete=false", readback.Detail, StringComparison.Ordinal);
    }

    [Fact]
    public async Task ReadTextAsync_RichContentEditableFailsClosedBeyondThe16DepthBound()
    {
        var nodes = new List<object>();
        for (int depth = 0; depth <= 17; depth++)
        {
            nodes.Add(depth == 17
                ? AxNode($"node-{depth}", "StaticText", name: "too deep")
                : AxNode($"node-{depth}", depth == 0 ? "textbox" : "generic", value: depth == 0 ? "fallback" : null, childIds: new[] { $"node-{depth + 1}" }, backendDomNodeId: depth == 0 ? 22 : null));
        }
        var socket = CreateRichTextReadbackSocket(AxNodes(nodes.ToArray()));

        BrowserTextReadback readback = await ReadRichTextAsync(socket);

        Assert.Equal("fallback", readback.Actual);
        Assert.Contains("subtree_complete=false", readback.Detail, StringComparison.Ordinal);
    }

    [Fact]
    public async Task ReadTextAsync_RichContentEditableAcceptsThe16DepthBound()
    {
        var nodes = new List<object>();
        for (int depth = 0; depth <= 16; depth++)
        {
            nodes.Add(depth == 16
                ? AxNode($"node-{depth}", "StaticText", name: "at bound")
                : AxNode($"node-{depth}", depth == 0 ? "textbox" : "generic", childIds: new[] { $"node-{depth + 1}" }, backendDomNodeId: depth == 0 ? 22 : null));
        }
        var socket = CreateRichTextReadbackSocket(AxNodes(nodes.ToArray()));

        BrowserTextReadback readback = await ReadRichTextAsync(socket);

        Assert.Equal("at bound", readback.Actual);
        Assert.Contains("subtree_complete=true", readback.Detail, StringComparison.Ordinal);
    }

    [Fact]
    public async Task ReadTextAsync_RichContentEditableFailsClosedForRepeatedChildIds()
    {
        var socket = CreateRichTextReadbackSocket(AxNodes(
            AxNode("root", "textbox", value: "fallback", childIds: new[] { "text", "text" }),
            AxNode("text", "StaticText", name: "once")));

        BrowserTextReadback readback = await ReadRichTextAsync(socket);

        Assert.Equal("fallback", readback.Actual);
        Assert.Contains("subtree_complete=false", readback.Detail, StringComparison.Ordinal);
    }

    [Fact]
    public async Task ReadTextAsync_RichContentEditableFailsClosedForDuplicateReachableNodeIds()
    {
        var socket = CreateRichTextReadbackSocket(AxNodes(
            AxNode("root", "textbox", value: "fallback"),
            AxNode("root", "textbox", value: "duplicate", backendDomNodeId: 22)));

        BrowserTextReadback readback = await ReadRichTextAsync(socket);

        Assert.Equal("fallback", readback.Actual);
        Assert.Contains("subtree_complete=false", readback.Detail, StringComparison.Ordinal);
    }

    [Fact]
    public void BrowserTextMismatchDiagnostic_LowSurrogateDifferenceReportsContainingScalarsWithoutBodies()
    {
        const string expected = "😀";
        const string actual = "😁";

        BrowserTextMismatchDiagnostic diagnostic = BrowserTextMismatchDiagnostic.Create(expected, actual, readbackStructure: null);
        string rendered = diagnostic.ToString();

        Assert.Equal(1, diagnostic.FirstDifferenceIndex);
        Assert.Equal("U+1F600", diagnostic.ExpectedCodePoint);
        Assert.Equal("U+1F601", diagnostic.ActualCodePoint);
        Assert.DoesNotContain(expected, rendered, StringComparison.Ordinal);
        Assert.DoesNotContain(actual, rendered, StringComparison.Ordinal);
    }

    [Fact]
    public void BrowserTextMismatchDiagnostic_HighSurrogateDifferenceReportsContainingScalars()
    {
        BrowserTextMismatchDiagnostic diagnostic = BrowserTextMismatchDiagnostic.Create("😀", "\U00020000", readbackStructure: null);

        Assert.Equal(0, diagnostic.FirstDifferenceIndex);
        Assert.Equal("U+1F600", diagnostic.ExpectedCodePoint);
        Assert.Equal("U+20000", diagnostic.ActualCodePoint);
    }

    [Fact]
    public void BrowserTextMismatchDiagnostic_BmpDifferenceReportsCodeUnits()
    {
        BrowserTextMismatchDiagnostic diagnostic = BrowserTextMismatchDiagnostic.Create("A", "B", readbackStructure: null);

        Assert.Equal(0, diagnostic.FirstDifferenceIndex);
        Assert.Equal("U+41", diagnostic.ExpectedCodePoint);
        Assert.Equal("U+42", diagnostic.ActualCodePoint);
    }

    [Fact]
    public void BrowserTextMismatchDiagnostic_UnpairedSurrogatesRemainSafelyRepresentable()
    {
        BrowserTextMismatchDiagnostic diagnostic = BrowserTextMismatchDiagnostic.Create("\uD800", "\uD801", readbackStructure: null);

        Assert.Equal(0, diagnostic.FirstDifferenceIndex);
        Assert.Equal("U+D800", diagnostic.ExpectedCodePoint);
        Assert.Equal("U+D801", diagnostic.ActualCodePoint);
    }

    private sealed class FailurePublicationScheduler : TaskScheduler
    {
        private readonly TaskCompletionSource _queued = new(TaskCreationOptions.RunContinuationsAsynchronously);
        private readonly TaskCompletionSource _release = new(TaskCreationOptions.RunContinuationsAsynchronously);

        public Task Queued => _queued.Task;

        public void Release() => _release.TrySetResult();

        protected override IEnumerable<Task> GetScheduledTasks() => [];

        protected override void QueueTask(Task task)
        {
            _queued.TrySetResult();
            _release.Task.GetAwaiter().GetResult();
            _ = Task.Run(() => TryExecuteTask(task));
        }

        protected override bool TryExecuteTaskInline(Task task, bool taskWasPreviouslyQueued) => false;
    }

    private static object AxNode(string nodeId, string role, string? name = null, string? value = null, string[]? childIds = null, long? backendDomNodeId = null) =>
        new
        {
            nodeId,
            backendDOMNodeId = backendDomNodeId ?? (nodeId == "root" ? 22 : null),
            role = new { value = role },
            name = name is null ? null : new { value = name },
            value = value is null ? null : new { value },
            childIds,
        };

    private static string AxNodes(params object[] nodes) => JsonSerializer.Serialize(new { nodes });

    private static async Task<BrowserTextReadback> ReadRichTextAsync(CdpTestSocket socket)
    {
        await using var transport = new CdpTransport(socket);
        await using BrowserPreparationSession page = await BrowserPreparationSession.AttachAsync(new CdpTargetManager(transport), "fixture");
        BrowserDomNode node = Assert.IsType<BrowserDomNode>(await page.FindNodeAsync("#fixture-body"));
        return await page.ReadTextAsync(node);
    }

    private static CdpTestSocket CreateRichTextReadbackSocket(
        string accessibilityResponse,
        IReadOnlyDictionary<string, string>? childResponses = null,
        string? failedMethod = null,
        bool transportFailure = false)
    {
        var socket = new CdpTestSocket();
        socket.OnSendAsync = message =>
        {
            JsonElement command = JsonDocument.Parse(message).RootElement;
            string method = command.GetProperty("method").GetString()!;
            if (method == failedMethod)
            {
                if (transportFailure)
                {
                    socket.EnqueueFailure(new InvalidOperationException("transport lost"));
                }
                else
                {
                    socket.EnqueueJson($"{{\"id\":{command.GetProperty("id").GetInt64()},\"error\":{{\"code\":-32001,\"message\":\"AX command denied\"}}}}");
                }
                return Task.CompletedTask;
            }

            string result = method switch
            {
                "Target.getTargets" => "{\"targetInfos\":[{\"targetId\":\"fixture\",\"type\":\"page\",\"url\":\"https://fixture.test\",\"title\":\"Fixture\"}]}",
                "Target.attachToTarget" => "{\"sessionId\":\"fixture-session\"}",
                "DOM.getDocument" => "{\"root\":{\"nodeId\":1,\"backendNodeId\":11,\"nodeName\":\"#document\"}}",
                "DOM.querySelector" => "{\"nodeId\":2}",
                "DOM.describeNode" => "{\"node\":{\"nodeId\":2,\"backendNodeId\":22,\"nodeName\":\"DIV\",\"attributes\":[\"contenteditable\",\"true\"]}}",
                "Accessibility.getPartialAXTree" => accessibilityResponse,
                "Accessibility.getChildAXNodes" => childResponses is not null &&
                    childResponses.TryGetValue(command.GetProperty("params").GetProperty("id").GetString()!, out string? children)
                    ? children : "{\"nodes\":[]}",
                _ => "{}",
            };
            string response = $"{{\"id\":{command.GetProperty("id").GetInt64()},\"result\":{result}}}";
            int byteCount = Encoding.UTF8.GetByteCount(response);
            int[] fragments = Enumerable.Range(0, (byteCount + 1023) / 1024)
                .Select(index => Math.Min(1024, byteCount - (index * 1024)))
                .ToArray();
            socket.EnqueueJson(response, fragments);
            return Task.CompletedTask;
        };
        return socket;
    }

    private static CdpTestSocket CreateTextReadbackSocket(string accessibilityResponse, string nodeName = "INPUT")
        => CreateNodeSocket(nodeName, null, accessibilityResponse);

    private static CdpTestSocket CreateNodeSocket(string nodeName, string[]? attributes, string accessibilityResponse = "{\"nodes\":[]}", string? failedMethod = null, bool transportFailure = false)
    {
        var socket = new CdpTestSocket();
        socket.OnSendAsync = message =>
        {
            JsonElement command = JsonDocument.Parse(message).RootElement;
            long id = command.GetProperty("id").GetInt64();
            string method = command.GetProperty("method").GetString()!;
            if (method == failedMethod)
            {
                if (transportFailure) socket.EnqueueFailure(new InvalidOperationException("transport lost"));
                else socket.EnqueueJson($"{{\"id\":{id},\"error\":{{\"code\":-32001,\"message\":\"CDP command denied\"}}}}");
                return Task.CompletedTask;
            }
            string result = method switch
            {
                "Target.getTargets" => "{\"targetInfos\":[{\"targetId\":\"fixture\",\"type\":\"page\",\"url\":\"https://fixture.test\",\"title\":\"Fixture\"}]}",
                "Target.attachToTarget" => "{\"sessionId\":\"fixture-session\"}",
                "DOM.getDocument" => "{\"root\":{\"nodeId\":1,\"backendNodeId\":11,\"nodeName\":\"#document\"}}",
                "DOM.querySelector" => "{\"nodeId\":2}",
                "DOM.describeNode" => JsonSerializer.Serialize(new { node = new { nodeId = 2, backendNodeId = 22, nodeName, attributes } }),
                "DOM.getBoxModel" => "{\"model\":{\"border\":[10,20,110,20,110,70,10,70]}}",
                "Accessibility.getPartialAXTree" => accessibilityResponse,
                _ => "{}",
            };
            socket.EnqueueJson($"{{\"id\":{id},\"result\":{result}}}");
            return Task.CompletedTask;
        };
        return socket;
    }

    private static async Task ReplyAsync(CdpTestSocket socket, string message, Func<string, string> response)
    {
        JsonElement command = JsonDocument.Parse(message).RootElement;
        socket.EnqueueJson($"{{\"id\":{command.GetProperty("id").GetInt64()},\"result\":{response(command.GetProperty("method").GetString()!)}}}");
        await Task.CompletedTask;
    }

    private static JsonElement Sent(CdpTestSocket socket, string method) => JsonDocument.Parse(socket.Sent.Single(message => Method(message) == method)).RootElement;
    private static string? Method(string message) => JsonDocument.Parse(message).RootElement.GetProperty("method").GetString();
}
