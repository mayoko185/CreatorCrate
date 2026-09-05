using System.Text.Json;
using OpenLocally;

namespace OpenLocally.Tests.Manual;

public sealed class FixturePreparationAdapterTests
{
    [Fact]
    public async Task VerifyExactAsync_RetriesInitialObservedValueUntilLiveAccessibilityValueMatches()
    {
        var socket = new CdpTestSocket();
        int accessibilityReads = 0;
        socket.OnSendAsync = message => ReplyAsync(socket, message, method => method switch
        {
            "Target.getTargets" => "{\"targetInfos\":[{\"targetId\":\"fixture\",\"type\":\"page\",\"url\":\"https://fixture.test\",\"title\":\"Fixture\"}]}",
            "Target.attachToTarget" => "{\"sessionId\":\"fixture-session\"}",
            "DOM.getDocument" => "{\"root\":{\"nodeId\":1,\"backendNodeId\":11,\"nodeName\":\"#document\"}}",
            "DOM.querySelector" => "{\"nodeId\":2}",
            "DOM.describeNode" => "{\"node\":{\"nodeId\":2,\"backendNodeId\":22,\"nodeName\":\"INPUT\",\"attributes\":[\"value\",\"initial fixture value\"]}}",
            "Accessibility.getPartialAXTree" => ++accessibilityReads == 1
                ? "{\"nodes\":[{\"value\":{\"value\":\"initial fixture value\"}}]}"
                : "{\"nodes\":[{\"value\":{\"value\":\"CreatorCrate Milestone 2 Fixture Title\"}}]}",
            _ => "{}",
        });
        await using var transport = new CdpTransport(socket);
        await using BrowserPreparationSession page = await BrowserPreparationSession.AttachAsync(new CdpTargetManager(transport), "fixture");

        await FixturePreparationAdapter.VerifyExactAsync(
            page,
            targetOrdinal: 1,
            "#fixture-title",
            "CreatorCrate Milestone 2 Fixture Title",
            commandCompleted: true,
            timeout: TimeSpan.FromSeconds(1));

        Assert.Equal(2, accessibilityReads);
        Assert.DoesNotContain(socket.Sent, message => Method(message) == "Runtime.evaluate");
    }

    [Fact]
    public async Task VerifyExactAsync_TimesOutWithSafeSecondTargetReadbackDiagnostic()
    {
        var socket = CreateMismatchingFixtureSocket();
        await using var transport = new CdpTransport(socket);
        await using BrowserPreparationSession page = await BrowserPreparationSession.AttachAsync(new CdpTargetManager(transport), "fixture");

        BrowserPreparationException exception = await Assert.ThrowsAsync<BrowserPreparationException>(() =>
            FixturePreparationAdapter.VerifyExactAsync(
                page,
                targetOrdinal: 2,
                "#fixture-title",
                "CreatorCrate Fixture Target B",
                commandCompleted: true,
                timeout: TimeSpan.FromMilliseconds(120)));

        Assert.Equal(BrowserPreparationFailure.ReadinessTimedOut, exception.Failure);
        Assert.StartsWith("ReadinessTimedOut: manual_fixture_text_verification_timeout;", exception.Message);
        Assert.Contains("detail_code=text_verification_timeout", exception.Message, StringComparison.Ordinal);
        Assert.Contains("target=2", exception.Message, StringComparison.Ordinal);
        Assert.Contains("selector=#fixture-title", exception.Message, StringComparison.Ordinal);
        Assert.Contains("element=INPUT", exception.Message, StringComparison.Ordinal);
        Assert.Contains("phase=readback", exception.Message, StringComparison.Ordinal);
        Assert.Contains("command_completed=true", exception.Message, StringComparison.Ordinal);
        Assert.Contains("observed=\"initial fixture value\"", exception.Message, StringComparison.Ordinal);
        Assert.Contains("expected=\"CreatorCrate Fixture Target B\"", exception.Message, StringComparison.Ordinal);
        Assert.True(Count(socket, "Accessibility.getPartialAXTree") >= 2);
    }

    [Fact]
    public async Task VerifyExactAsync_PropagatesCallerCancellation()
    {
        var socket = CreateMismatchingFixtureSocket();
        await using var transport = new CdpTransport(socket);
        await using BrowserPreparationSession page = await BrowserPreparationSession.AttachAsync(new CdpTargetManager(transport), "fixture");
        using var cancelled = new CancellationTokenSource(TimeSpan.FromMilliseconds(25));

        await Assert.ThrowsAnyAsync<OperationCanceledException>(() =>
            FixturePreparationAdapter.VerifyExactAsync(
                page,
                targetOrdinal: 1,
                "#fixture-title",
                "CreatorCrate Milestone 2 Fixture Title",
                commandCompleted: true,
                timeout: TimeSpan.FromSeconds(1),
                cancellationToken: cancelled.Token));
    }

    [Fact]
    public async Task VerifyExactAsync_SucceedsOnFirstMatchingAccessibilityValue()
    {
        var socket = CreateFixtureSocket("{\"nodes\":[{\"value\":{\"value\":\"CreatorCrate Milestone 2 Fixture Title\"}}]}");
        await using var transport = new CdpTransport(socket);
        await using BrowserPreparationSession page = await BrowserPreparationSession.AttachAsync(new CdpTargetManager(transport), "fixture");

        await FixturePreparationAdapter.VerifyExactAsync(
            page,
            targetOrdinal: 1,
            "#fixture-title",
            "CreatorCrate Milestone 2 Fixture Title",
            commandCompleted: true,
            timeout: TimeSpan.FromSeconds(1));

        Assert.Equal(1, Count(socket, "Accessibility.getPartialAXTree"));
    }

    [Fact]
    public async Task VerifyExactAsync_RetriesEmptyAccessibilityValueUntilExpectedValueAppears()
    {
        var socket = new CdpTestSocket();
        int accessibilityReads = 0;
        socket.OnSendAsync = message => ReplyAsync(socket, message, method => method switch
        {
            "Target.getTargets" => "{\"targetInfos\":[{\"targetId\":\"fixture\",\"type\":\"page\",\"url\":\"https://fixture.test\",\"title\":\"Fixture\"}]}",
            "Target.attachToTarget" => "{\"sessionId\":\"fixture-session\"}",
            "DOM.getDocument" => "{\"root\":{\"nodeId\":1,\"backendNodeId\":11,\"nodeName\":\"#document\"}}",
            "DOM.querySelector" => "{\"nodeId\":2}",
            "DOM.describeNode" => "{\"node\":{\"nodeId\":2,\"backendNodeId\":22,\"nodeName\":\"INPUT\"}}",
            "Accessibility.getPartialAXTree" => ++accessibilityReads == 1
                ? "{\"nodes\":[]}"
                : "{\"nodes\":[{\"value\":{\"value\":\"CreatorCrate Milestone 2 Fixture Title\"}}]}",
            _ => "{}",
        });
        await using var transport = new CdpTransport(socket);
        await using BrowserPreparationSession page = await BrowserPreparationSession.AttachAsync(new CdpTargetManager(transport), "fixture");

        await FixturePreparationAdapter.VerifyExactAsync(
            page,
            targetOrdinal: 1,
            "#fixture-title",
            "CreatorCrate Milestone 2 Fixture Title",
            commandCompleted: true,
            timeout: TimeSpan.FromSeconds(1));

        Assert.Equal(2, accessibilityReads);
    }

    [Fact]
    public async Task VerifyExactAsync_SucceedsOnFirstPresentEmptyAccessibilityValue()
    {
        var socket = CreateFixtureSocket("{\"nodes\":[{\"value\":{\"value\":\"\"},\"name\":{\"value\":\"SHOULD NOT BE USED\"}}]}");
        await using var transport = new CdpTransport(socket);
        await using BrowserPreparationSession page = await BrowserPreparationSession.AttachAsync(new CdpTargetManager(transport), "fixture");

        await FixturePreparationAdapter.VerifyExactAsync(
            page,
            targetOrdinal: 1,
            "#fixture-title",
            string.Empty,
            commandCompleted: true,
            timeout: TimeSpan.FromSeconds(1));

        Assert.Equal(1, Count(socket, "Accessibility.getPartialAXTree"));
    }

    [Fact]
    public async Task VerifyExactAsync_RetriesPresentEmptyAccessibilityValueUntilExpectedValueAppears()
    {
        var socket = new CdpTestSocket();
        int accessibilityReads = 0;
        socket.OnSendAsync = message => ReplyAsync(socket, message, method => method switch
        {
            "Target.getTargets" => "{\"targetInfos\":[{\"targetId\":\"fixture\",\"type\":\"page\",\"url\":\"https://fixture.test\",\"title\":\"Fixture\"}]}",
            "Target.attachToTarget" => "{\"sessionId\":\"fixture-session\"}",
            "DOM.getDocument" => "{\"root\":{\"nodeId\":1,\"backendNodeId\":11,\"nodeName\":\"#document\"}}",
            "DOM.querySelector" => "{\"nodeId\":2}",
            "DOM.describeNode" => "{\"node\":{\"nodeId\":2,\"backendNodeId\":22,\"nodeName\":\"INPUT\"}}",
            "Accessibility.getPartialAXTree" => ++accessibilityReads == 1
                ? "{\"nodes\":[{\"value\":{\"value\":\"\"},\"name\":{\"value\":\"SHOULD NOT BE USED\"}}]}"
                : "{\"nodes\":[{\"value\":{\"value\":\"CreatorCrate Milestone 2 Fixture Title\"},\"name\":{\"value\":\"SHOULD NOT BE USED\"}}]}",
            _ => "{}",
        });
        await using var transport = new CdpTransport(socket);
        await using BrowserPreparationSession page = await BrowserPreparationSession.AttachAsync(new CdpTargetManager(transport), "fixture");

        await FixturePreparationAdapter.VerifyExactAsync(
            page,
            targetOrdinal: 1,
            "#fixture-title",
            "CreatorCrate Milestone 2 Fixture Title",
            commandCompleted: true,
            timeout: TimeSpan.FromSeconds(1));

        Assert.Equal(2, accessibilityReads);
    }

    [Fact]
    public async Task VerifyExactAsync_ReacquiresReplacementNodeAfterSelectorDisappears()
    {
        var socket = new CdpTestSocket();
        int selectorLookups = 0;
        long accessibilityBackendNodeId = 0;
        socket.OnSendAsync = message =>
        {
            JsonElement command = JsonDocument.Parse(message).RootElement;
            long id = command.GetProperty("id").GetInt64();
            string method = command.GetProperty("method").GetString()!;
            if (method == "Accessibility.getPartialAXTree")
            {
                accessibilityBackendNodeId = command.GetProperty("params").GetProperty("backendNodeId").GetInt64();
                socket.EnqueueJson($"{{\"id\":{id},\"result\":{{\"nodes\":[{{\"value\":{{\"value\":\"CreatorCrate Milestone 2 Fixture Title\"}}}}]}}}}");
                return Task.CompletedTask;
            }

            string result = method switch
            {
                "Target.getTargets" => "{\"targetInfos\":[{\"targetId\":\"fixture\",\"type\":\"page\",\"url\":\"https://fixture.test\",\"title\":\"Fixture\"}]}",
                "Target.attachToTarget" => "{\"sessionId\":\"fixture-session\"}",
                "DOM.getDocument" => "{\"root\":{\"nodeId\":1,\"backendNodeId\":11,\"nodeName\":\"#document\"}}",
                "DOM.querySelector" => ++selectorLookups switch
                {
                    1 => "{\"nodeId\":101}",
                    2 => "{}",
                    _ => "{\"nodeId\":202}",
                },
                "DOM.describeNode" => $"{{\"node\":{{\"nodeId\":{command.GetProperty("params").GetProperty("nodeId").GetInt32()},\"backendNodeId\":{command.GetProperty("params").GetProperty("nodeId").GetInt32() * 10L},\"nodeName\":\"INPUT\"}}}}",
                _ => "{}",
            };
            socket.EnqueueJson($"{{\"id\":{id},\"result\":{result}}}");
            return Task.CompletedTask;
        };
        await using var transport = new CdpTransport(socket);
        await using BrowserPreparationSession page = await BrowserPreparationSession.AttachAsync(new CdpTargetManager(transport), "fixture");

        BrowserDomNode initialNode = await page.WaitForNodeAsync("#fixture-title", timeout: TimeSpan.FromSeconds(1));
        await page.ReplaceTextAsync(initialNode, "CreatorCrate Milestone 2 Fixture Title");
        await FixturePreparationAdapter.VerifyExactAsync(
            page,
            targetOrdinal: 1,
            "#fixture-title",
            "CreatorCrate Milestone 2 Fixture Title",
            commandCompleted: true,
            timeout: TimeSpan.FromSeconds(1));

        Assert.Equal(101, initialNode.NodeId);
        Assert.True(selectorLookups >= 3);
        Assert.Equal(2020, accessibilityBackendNodeId);
        Assert.DoesNotContain(socket.Sent, message => Method(message) == "Runtime.evaluate");
    }

    [Fact]
    public async Task VerifyExactAsync_TimesOutWhenSelectorNeverReappearsWithSelectorMissingDiagnostic()
    {
        var socket = new CdpTestSocket();
        var selectorResponses = new Queue<string>(Enumerable.Repeat("{}", 10));
        socket.OnSendAsync = message => ReplyAsync(socket, message, method => method switch
        {
            "Target.getTargets" => "{\"targetInfos\":[{\"targetId\":\"fixture\",\"type\":\"page\",\"url\":\"https://fixture.test\",\"title\":\"Fixture\"}]}",
            "Target.attachToTarget" => "{\"sessionId\":\"fixture-session\"}",
            "DOM.getDocument" => "{\"root\":{\"nodeId\":1,\"backendNodeId\":11,\"nodeName\":\"#document\"}}",
            "DOM.querySelector" => selectorResponses.Dequeue(),
            _ => "{}",
        });
        await using var transport = new CdpTransport(socket);
        await using BrowserPreparationSession page = await BrowserPreparationSession.AttachAsync(new CdpTargetManager(transport), "fixture");

        BrowserPreparationException exception = await Assert.ThrowsAsync<BrowserPreparationException>(() =>
            FixturePreparationAdapter.VerifyExactAsync(
                page,
                targetOrdinal: 1,
                "#fixture-title",
                "CreatorCrate Milestone 2 Fixture Title",
                commandCompleted: true,
                timeout: TimeSpan.FromMilliseconds(120)));

        Assert.Equal(BrowserPreparationFailure.ReadinessTimedOut, exception.Failure);
        Assert.True(Count(socket, "DOM.querySelector") >= 2);
        Assert.DoesNotContain(socket.Sent, message => Method(message) == "Accessibility.getPartialAXTree");
        Assert.Contains("detail_code=text_verification_timeout", exception.Message, StringComparison.Ordinal);
        Assert.Contains("target=1", exception.Message, StringComparison.Ordinal);
        Assert.Contains("selector=#fixture-title", exception.Message, StringComparison.Ordinal);
        Assert.Contains("phase=readback", exception.Message, StringComparison.Ordinal);
        Assert.Contains("attempts=", exception.Message, StringComparison.Ordinal);
        Assert.DoesNotContain("attempts=0", exception.Message, StringComparison.Ordinal);
        Assert.Contains("observed=selector_missing", exception.Message, StringComparison.Ordinal);
        Assert.DoesNotContain("observed=<unsupported-readback>", exception.Message, StringComparison.Ordinal);
        Assert.Contains("expected=\"CreatorCrate Milestone 2 Fixture Title\"", exception.Message, StringComparison.Ordinal);
    }

    [Fact]
    public async Task VerifyExactAsync_PropagatesAccessibilityCommandFailureWithoutTimeout()
    {
        var socket = new CdpTestSocket();
        socket.OnSendAsync = message =>
        {
            JsonElement command = JsonDocument.Parse(message).RootElement;
            long id = command.GetProperty("id").GetInt64();
            string method = command.GetProperty("method").GetString()!;
            if (method == "Accessibility.getPartialAXTree")
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

        CdpCommandException exception = await Assert.ThrowsAsync<CdpCommandException>(() =>
            FixturePreparationAdapter.VerifyExactAsync(
                page,
                targetOrdinal: 1,
                "#fixture-title",
                "CreatorCrate Milestone 2 Fixture Title",
                commandCompleted: true,
                timeout: TimeSpan.FromSeconds(1)));

        Assert.Equal(-32001, exception.Code);
        Assert.Equal("AX command denied", exception.Message);
        Assert.Equal(1, Count(socket, "Accessibility.getPartialAXTree"));
    }

    [Fact]
    public async Task VerifyExactAsync_PropagatesAccessibilityTransportFailureWithoutTimeout()
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

        CdpTransportException exception = await Assert.ThrowsAsync<CdpTransportException>(() =>
            FixturePreparationAdapter.VerifyExactAsync(
                page,
                targetOrdinal: 1,
                "#fixture-title",
                "CreatorCrate Milestone 2 Fixture Title",
                commandCompleted: true,
                timeout: TimeSpan.FromSeconds(1)));

        Assert.Equal(CdpTransportFailure.Disconnected, exception.Failure);
        Assert.Equal(1, Count(socket, "Accessibility.getPartialAXTree"));
        await Assert.ThrowsAsync<CdpTransportException>(() => page.DisposeAsync().AsTask());
    }

    [Fact]
    public async Task PreparationFailureAndCleanupFailure_PreservesDistinctPrimaryException()
    {
        LifecycleHarness harness = await CreateLifecycleHarnessAsync();
        await using CdpTransport transport = harness.Transport;
        harness.Socket.OnSendAsync = message =>
        {
            if (Method(message) == "Target.closeTarget")
            {
                harness.Socket.EnqueueFailure(new IOException("CLEANUP_DISCONNECTED"));
            }
            return Task.CompletedTask;
        };
        var primary = new BrowserPreparationException(
            BrowserPreparationFailure.ReadinessTimedOut,
            "PRIMARY_PREPARATION_FAILURE");

        BrowserPreparationException surfaced = await Assert.ThrowsAsync<BrowserPreparationException>(() =>
            harness.Adapter.ExecutePreparationLifecycleAsync(_ => Task.FromException<PlatformPreparationResult>(primary)));

        Assert.Same(primary, surfaced);
        Assert.Equal("ReadinessTimedOut: PRIMARY_PREPARATION_FAILURE", surfaced.Message);
        Assert.DoesNotContain("CLEANUP_DISCONNECTED", surfaced.Message, StringComparison.Ordinal);
        Assert.True(FixturePreparationAdapter.TryGetCleanupDiagnostic(surfaced, out string? cleanup));
        Assert.Contains("cleanup_error=CdpTransportException", cleanup, StringComparison.Ordinal);
        Assert.Contains("cleanup_detail=Disconnected", cleanup, StringComparison.Ordinal);
    }

    [Fact]
    public async Task PreparationFailureAndCleanupDisconnect_PreservesPrimaryAndStructuralDiagnostics()
    {
        LifecycleHarness harness = await CreateLifecycleHarnessAsync();
        await using CdpTransport transport = harness.Transport;
        int closeCalls = 0;
        harness.Socket.OnSendAsync = message =>
        {
            if (Method(message) == "Target.closeTarget")
            {
                closeCalls++;
                harness.Socket.EnqueueFailure(new IOException("CLEANUP_DISCONNECTED"));
            }
            return Task.CompletedTask;
        };
        const string detail = "manual_fixture_text_verification_timeout; detail_code=text_verification_timeout; root_role=textbox; root_value=\"line 1line 3\"; reconstructed=\"line 1\\n\\nline 3\"; static_text_nodes=2; line_break_nodes=2; subtree_complete=true; expected=\"line 1\\n\\nline 3\"; observed=\"line 1line 3\"";
        var primary = new BrowserPreparationException(BrowserPreparationFailure.ReadinessTimedOut, detail);
        string originalMessage = primary.Message;

        BrowserPreparationException surfaced = await Assert.ThrowsAsync<BrowserPreparationException>(() =>
            harness.Adapter.ExecutePreparationLifecycleAsync(_ => Task.FromException<PlatformPreparationResult>(primary)));

        Assert.Same(primary, surfaced);
        Assert.Equal(originalMessage, surfaced.Message);
        Assert.Contains("root_role=textbox", surfaced.Message, StringComparison.Ordinal);
        Assert.Contains("line_break_nodes=2", surfaced.Message, StringComparison.Ordinal);
        Assert.True(FixturePreparationAdapter.TryGetCleanupDiagnostic(surfaced, out string? cleanup));
        Assert.Contains("prepare_completed=false", cleanup, StringComparison.Ordinal);
        Assert.Contains("primary_error=BrowserPreparationException/ReadinessTimedOut", cleanup, StringComparison.Ordinal);
        Assert.Contains("cleanup_error=CdpTransportException", cleanup, StringComparison.Ordinal);
        Assert.Contains("cleanup_detail=Disconnected", cleanup, StringComparison.Ordinal);
        Assert.Contains("transport_state_before_cleanup=connected", cleanup, StringComparison.Ordinal);
        Assert.Contains("target={target_ordinal=1,close_attempted=true,close_completed=false,close_error=CdpTransportException/Disconnected}", cleanup, StringComparison.Ordinal);
        Assert.Contains("target={target_ordinal=2,close_attempted=false,close_completed=false,close_error=CdpTransportException/receive_failure}", cleanup, StringComparison.Ordinal);
        Assert.Contains("transport_state_after_cleanup=receive_failure", cleanup, StringComparison.Ordinal);
        Assert.Equal(1, closeCalls);

        string eventPath = Path.Combine(Path.GetTempPath(), $"creatorcrate-c2-35-{Guid.NewGuid():N}.jsonl");
        try
        {
            new ManualWorkflowFileReporter(eventPath).StageFailed("Chrome", surfaced);
            string reported = JsonDocument.Parse(await File.ReadAllTextAsync(eventPath)).RootElement.GetProperty("Message").GetString()!;
            Assert.Contains("root_role=textbox", reported, StringComparison.Ordinal);
            Assert.Contains("line_break_nodes=2", reported, StringComparison.Ordinal);
            Assert.Contains("MANUAL DIAGNOSTIC — Chrome fixture cleanup:", reported, StringComparison.Ordinal);
            Assert.Contains("cleanup_detail=Disconnected", reported, StringComparison.Ordinal);
        }
        finally
        {
            File.Delete(eventPath);
        }
    }

    [Fact]
    public async Task PreparationSuccessAndCleanupDisconnect_ReportsCleanupSpecificFailure()
    {
        LifecycleHarness harness = await CreateLifecycleHarnessAsync();
        await using CdpTransport transport = harness.Transport;
        int closeCalls = 0;
        harness.Socket.OnSendAsync = message =>
        {
            if (Method(message) == "Target.closeTarget")
            {
                closeCalls++;
                harness.Socket.EnqueueFailure(new IOException("CLEANUP_DISCONNECTED"));
            }
            return Task.CompletedTask;
        };

        PlatformPreparationResult result = await harness.Adapter.ExecutePreparationLifecycleAsync(
            _ => Task.FromResult(PlatformPreparationResult.Prepared()));
        FixtureOwnedTargetCleanupException cleanup = await Assert.ThrowsAsync<FixtureOwnedTargetCleanupException>(
            () => harness.Adapter.DisposeAsync().AsTask());

        Assert.Equal(PlatformPreparationOutcome.Prepared, result.Outcome);
        Assert.Contains("prepare_completed=true", cleanup.Message, StringComparison.Ordinal);
        Assert.Contains("primary_error=none", cleanup.Message, StringComparison.Ordinal);
        Assert.Contains("phase=cleanup", cleanup.Message, StringComparison.Ordinal);
        Assert.Contains("detail_code=owned_target_cleanup_failed", cleanup.Message, StringComparison.Ordinal);
        Assert.Contains("cleanup_status=failed", cleanup.Message, StringComparison.Ordinal);
        Assert.Contains("cleanup_error=CdpTransportException", cleanup.Message, StringComparison.Ordinal);
        Assert.Contains("cleanup_detail=Disconnected", cleanup.Message, StringComparison.Ordinal);
        Assert.Equal("receive_failure", cleanup.Result.TransportStateAfter);
        Assert.Equal(1, closeCalls);
    }

    [Fact]
    public async Task PreparationFailureAndCleanupSuccess_PreservesOriginalFailureUnchanged()
    {
        LifecycleHarness harness = await CreateLifecycleHarnessAsync();
        await using CdpTransport transport = harness.Transport;
        var counter = new CleanupCounter();
        ConfigureSuccessfulCleanup(harness.Socket, counter);
        var primary = new BrowserPreparationException(
            BrowserPreparationFailure.ReadinessTimedOut,
            "PRIMARY_PREPARATION_FAILURE");

        BrowserPreparationException surfaced = await Assert.ThrowsAsync<BrowserPreparationException>(() =>
            harness.Adapter.ExecutePreparationLifecycleAsync(_ => Task.FromException<PlatformPreparationResult>(primary)));

        Assert.Same(primary, surfaced);
        Assert.Equal("ReadinessTimedOut: PRIMARY_PREPARATION_FAILURE", surfaced.Message);
        Assert.False(FixturePreparationAdapter.TryGetCleanupDiagnostic(surfaced, out _));
        Assert.Equal(2, counter.CloseCalls);
    }

    [Fact]
    public async Task PreparationSuccessAndCleanupSuccess_PreservesNormalSuccess()
    {
        LifecycleHarness harness = await CreateLifecycleHarnessAsync();
        await using CdpTransport transport = harness.Transport;
        var counter = new CleanupCounter();
        ConfigureSuccessfulCleanup(harness.Socket, counter);

        PlatformPreparationResult result = await harness.Adapter.ExecutePreparationLifecycleAsync(
            _ => Task.FromResult(PlatformPreparationResult.Prepared()));
        await harness.Adapter.DisposeAsync();

        Assert.Equal(PlatformPreparationOutcome.Prepared, result.Outcome);
        Assert.Equal(2, counter.CloseCalls);
        Assert.Equal("connected", transport.DiagnosticState);
    }

    [Fact]
    public async Task Cleanup_FirstTargetSucceedsAndSecondDisconnects_ReportsEveryTarget()
    {
        LifecycleHarness harness = await CreateLifecycleHarnessAsync();
        await using CdpTransport transport = harness.Transport;
        int closeCalls = 0;
        harness.Socket.OnSendAsync = message =>
        {
            if (Method(message) != "Target.closeTarget") return Task.CompletedTask;
            closeCalls++;
            if (closeCalls == 1)
            {
                Reply(harness.Socket, message, "{\"success\":true}");
            }
            else
            {
                harness.Socket.EnqueueFailure(new IOException("CLEANUP_DISCONNECTED"));
            }
            return Task.CompletedTask;
        };

        FixtureOwnedTargetCleanupException cleanup = await Assert.ThrowsAsync<FixtureOwnedTargetCleanupException>(
            () => harness.Adapter.DisposeAsync().AsTask());

        Assert.Equal(2, closeCalls);
        Assert.True(cleanup.Result.Attempts[0].CloseAttempted);
        Assert.True(cleanup.Result.Attempts[0].CloseCompleted);
        Assert.Null(cleanup.Result.Attempts[0].CloseError);
        Assert.True(cleanup.Result.Attempts[1].CloseAttempted);
        Assert.False(cleanup.Result.Attempts[1].CloseCompleted);
        Assert.Equal(new FixtureCleanupError("CdpTransportException", "Disconnected"), cleanup.Result.Attempts[1].CloseError);
        Assert.Contains("target={target_ordinal=1,close_attempted=true,close_completed=true,close_error=none}", cleanup.Message, StringComparison.Ordinal);
        Assert.Contains("target={target_ordinal=2,close_attempted=true,close_completed=false,close_error=CdpTransportException/Disconnected}", cleanup.Message, StringComparison.Ordinal);
        Assert.Equal(["fixture-1", "fixture-2"], ClosedTargets(harness.Socket));
    }

    [Fact]
    public async Task Cleanup_UsesIndependentTotalDeadlineAndDoesNotRepeatTimedOutCommands()
    {
        LifecycleHarness harness = await CreateLifecycleHarnessAsync();
        await using CdpTransport transport = harness.Transport;
        harness.Socket.OnSendAsync = null;
        var socketSendStarted = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var releaseSocketSend = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        harness.Socket.OnSendWithCancellationAsync = (_, _) =>
        {
            socketSendStarted.TrySetResult();
            return releaseSocketSend.Task;
        };
        var stopwatch = System.Diagnostics.Stopwatch.StartNew();

        Task<FixtureOwnedTargetCleanupResult> closeTargets = FixturePreparationAdapter.CloseOwnedTargetsAsync(
            [harness.First, harness.Second],
            TimeSpan.FromMilliseconds(80));
        await socketSendStarted.Task.WaitAsync(TimeSpan.FromSeconds(1));
        await Task.Delay(100);
        releaseSocketSend.TrySetResult();
        FixtureOwnedTargetCleanupResult cleanup = await closeTargets;

        stopwatch.Stop();
        Assert.False(cleanup.Succeeded);
        Assert.True(cleanup.Attempts[0].CloseAttempted);
        Assert.Equal(new FixtureCleanupError("OperationCanceledException", "cleanup_timeout"), cleanup.Attempts[0].CloseError);
        Assert.False(cleanup.Attempts[1].CloseAttempted);
        Assert.Equal(new FixtureCleanupError("CleanupTimeout", "deadline_expired"), cleanup.Attempts[1].CloseError);
        Assert.Equal("connected", cleanup.TransportStateAfter);
        Assert.Equal(1, harness.Socket.Sent.Count(message => Method(message) == "Target.closeTarget"));
        Assert.True(stopwatch.Elapsed < TimeSpan.FromSeconds(1), $"Cleanup took {stopwatch.Elapsed}.");
    }

    [Fact]
    public async Task PrepareAsync_ExecutesTheSimplifiedOneTargetFlowThroughDirectFileAssignment()
    {
        const string title = ManualBrowserFixture.Title;
        const string body = ManualBrowserFixture.Body;
        string mediaDirectory = Path.Combine(Path.GetTempPath(), "creatorcrate-c2-41-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(mediaDirectory);
        string mediaPath = Path.Combine(mediaDirectory, "fixture-first.txt");
        await File.WriteAllTextAsync(mediaPath, "fixture media");

        var values = new Dictionary<long, string> { [22] = string.Empty, [33] = string.Empty, [55] = "not-ready" };
        var socket = new CdpTestSocket();
        int focusedNodeId = 0;
        socket.OnSendAsync = message =>
        {
            JsonElement command = JsonDocument.Parse(message).RootElement;
            long id = command.GetProperty("id").GetInt64();
            string method = command.GetProperty("method").GetString()!;
            JsonElement parameters = command.TryGetProperty("params", out JsonElement currentParameters) ? currentParameters : default;
            string result = method switch
            {
                "Target.createTarget" => "{\"targetId\":\"owned\"}",
                "Target.attachToTarget" => "{\"sessionId\":\"owned-session\"}",
                "Target.closeTarget" => "{\"success\":true}",
                "Page.navigate" => "{\"frameId\":\"fixture-frame\"}",
                "DOM.getDocument" => "{\"root\":{\"nodeId\":1,\"backendNodeId\":11,\"nodeName\":\"#document\"}}",
                "DOM.querySelector" => JsonSerializer.Serialize(new { nodeId = parameters.GetProperty("selector").GetString() switch
                {
                    "#fixture-title" => 2,
                    "#fixture-body" => 3,
                    "#fixture-media" => 4,
                    "#fixture-upload-ready" => 5,
                    _ => 0,
                } }),
                "DOM.describeNode" => DescribeFixtureNode(parameters.GetProperty("nodeId").GetInt32()),
                "Accessibility.getPartialAXTree" => JsonSerializer.Serialize(new { nodes = new[] { new { value = new { value = values[parameters.GetProperty("backendNodeId").GetInt64()] } } } }),
                _ => "{}",
            };

            if (method == "DOM.focus") focusedNodeId = parameters.GetProperty("nodeId").GetInt32();
            if (method == "Input.insertText") values[focusedNodeId == 2 ? 22 : 33] = parameters.GetProperty("text").GetString()!;
            if (method == "DOM.setFileInputFiles")
            {
                string[] files = parameters.GetProperty("files").EnumerateArray().Select(file => file.GetString()!).ToArray();
                values[55] = $"ready:{files.Length}:{string.Join("|", files.Select(Path.GetFileName))}";
            }

            socket.EnqueueJson($"{{\"id\":{id},\"result\":{result}}}");
            return Task.CompletedTask;
        };

        string? priorOptIn = Environment.GetEnvironmentVariable(ManualFoundationGuard.EnvironmentVariable);
        Environment.SetEnvironmentVariable(ManualFoundationGuard.EnvironmentVariable, "1");
        try
        {
            await using var transport = new CdpTransport(socket);
            await using var fixture = ManualBrowserFixture.CreateForFakeCdp(new Uri("https://fixture.test/"));
            await using var adapter = new FixturePreparationAdapter(fixture);
            var progress = new RecordingProgress();
            var targets = new BrowserPreparationTargets(new CdpTargetManager(transport));

            PlatformPreparationResult result = await adapter.PrepareAsync(
                new PlatformPreparationContext(adapter.Platform, title, body, [mediaPath], targets), progress, CancellationToken.None);

            Assert.Equal(PlatformPreparationOutcome.Prepared, result.Outcome);
            Assert.Equal([SocialPreparationProgress.Preparing, SocialPreparationProgress.Uploading], progress.Values);
            Assert.Equal(title, values[22]);
            Assert.Equal(body, values[33]);
            Assert.Equal("ready:1:fixture-first.txt", values[55]);
            Assert.Equal(1, Count(socket, "Target.createTarget"));
            Assert.Equal(1, Count(socket, "Target.attachToTarget"));
            Assert.Equal(1, Count(socket, "Page.navigate"));
            Assert.Equal(1, Count(socket, "DOM.setFileInputFiles"));
            Assert.Equal(0, Count(socket, "Target.getTargets"));
            Assert.Equal(0, Count(socket, "Target.closeTarget"));
            Assert.Equal(0, Count(socket, "Accessibility.getChildAXNodes"));
            Assert.Equal(0, Count(socket, "Page.setInterceptFileChooserDialog"));
            Assert.Equal(0, Count(socket, "Page.fileChooserOpened"));
            Assert.Equal(0, Count(socket, "Runtime.evaluate"));
            Assert.Equal(0, Count(socket, "Runtime.callFunctionOn"));
            Assert.Equal(0, Count(socket, "Browser.close"));
            Assert.DoesNotContain(socket.Sent, sent => Method(sent) is "Input.dispatchMouseEvent" or "Input.dispatchTouchEvent");
            Assert.All(socket.Sent.Where(sent => Method(sent) == "Accessibility.getPartialAXTree"), sent =>
                Assert.False(JsonDocument.Parse(sent).RootElement.GetProperty("params").GetProperty("fetchRelatives").GetBoolean()));

            List<string> sent = socket.Sent.ToList();
            int assignedAt = sent.FindIndex(sent => Method(sent) == "DOM.setFileInputFiles");
            int readyReadAt = sent.FindIndex(sent => Method(sent) == "Accessibility.getPartialAXTree" &&
                JsonDocument.Parse(sent).RootElement.GetProperty("params").GetProperty("backendNodeId").GetInt64() == 55);
            Assert.True(assignedAt >= 0 && readyReadAt > assignedAt);

            await adapter.DisposeAsync();
            Assert.Equal(1, Count(socket, "Target.closeTarget"));
            Assert.Equal(["owned"], ClosedTargets(socket));
        }
        finally
        {
            Environment.SetEnvironmentVariable(ManualFoundationGuard.EnvironmentVariable, priorOptIn);
            Directory.Delete(mediaDirectory, recursive: true);
        }
    }

    private static string DescribeFixtureNode(int nodeId) => nodeId switch
    {
        2 => "{\"node\":{\"nodeId\":2,\"backendNodeId\":22,\"nodeName\":\"INPUT\",\"attributes\":[\"type\",\"text\"]}}",
        3 => "{\"node\":{\"nodeId\":3,\"backendNodeId\":33,\"nodeName\":\"TEXTAREA\"}}",
        4 => "{\"node\":{\"nodeId\":4,\"backendNodeId\":44,\"nodeName\":\"INPUT\",\"attributes\":[\"type\",\"file\"]}}",
        5 => "{\"node\":{\"nodeId\":5,\"backendNodeId\":55,\"nodeName\":\"OUTPUT\"}}",
        _ => throw new InvalidOperationException($"Unexpected fixture node {nodeId}."),
    };

    private static async Task<LifecycleHarness> CreateLifecycleHarnessAsync()
    {
        var socket = new CdpTestSocket();
        int created = 0;
        socket.OnSendAsync = message =>
        {
            JsonElement command = JsonDocument.Parse(message).RootElement;
            string method = command.GetProperty("method").GetString()!;
            string result = method switch
            {
                "Target.createTarget" => $"{{\"targetId\":\"fixture-{++created}\"}}",
                "Target.attachToTarget" => $"{{\"sessionId\":\"{command.GetProperty("params").GetProperty("targetId").GetString()}-session\"}}",
                _ => "{}",
            };
            Reply(socket, message, result);
            return Task.CompletedTask;
        };
        var transport = new CdpTransport(socket);
        var targets = new BrowserPreparationTargets(new CdpTargetManager(transport));
        BrowserPreparationSession first = await targets.CreateOwnedAsync();
        BrowserPreparationSession second = await targets.CreateOwnedAsync();
        var adapter = new FixturePreparationAdapter(null!);
        adapter.TrackOwnedTarget(first);
        adapter.TrackOwnedTarget(second);
        return new LifecycleHarness(socket, transport, adapter, first, second);
    }

    private static void ConfigureSuccessfulCleanup(CdpTestSocket socket, CleanupCounter counter)
    {
        socket.OnSendAsync = message =>
        {
            if (Method(message) == "Target.closeTarget")
            {
                counter.CloseCalls++;
                Reply(socket, message, "{\"success\":true}");
            }
            return Task.CompletedTask;
        };
    }

    private static void Reply(CdpTestSocket socket, string message, string result)
    {
        long id = JsonDocument.Parse(message).RootElement.GetProperty("id").GetInt64();
        socket.EnqueueJson($"{{\"id\":{id},\"result\":{result}}}");
    }

    private static string[] ClosedTargets(CdpTestSocket socket) => socket.Sent
        .Select(message => JsonDocument.Parse(message).RootElement)
        .Where(command => command.GetProperty("method").GetString() == "Target.closeTarget")
        .Select(command => command.GetProperty("params").GetProperty("targetId").GetString()!)
        .ToArray();

    private sealed record LifecycleHarness(
        CdpTestSocket Socket,
        CdpTransport Transport,
        FixturePreparationAdapter Adapter,
        BrowserPreparationSession First,
        BrowserPreparationSession Second);

    private sealed class CleanupCounter
    {
        internal int CloseCalls;
    }

    private sealed class RecordingProgress : IPreparationProgress
    {
        internal List<SocialPreparationProgress> Values { get; } = [];

        public Task ReportAsync(SocialPreparationProgress progress, CancellationToken cancellationToken)
        {
            Values.Add(progress);
            return Task.CompletedTask;
        }
    }

    private static CdpTestSocket CreateFixtureSocket(string accessibilityResponse)
    {
        var socket = new CdpTestSocket();
        socket.OnSendAsync = message => ReplyAsync(socket, message, method => method switch
        {
            "Target.getTargets" => "{\"targetInfos\":[{\"targetId\":\"fixture\",\"type\":\"page\",\"url\":\"https://fixture.test\",\"title\":\"Fixture\"}]}",
            "Target.attachToTarget" => "{\"sessionId\":\"fixture-session\"}",
            "DOM.getDocument" => "{\"root\":{\"nodeId\":1,\"backendNodeId\":11,\"nodeName\":\"#document\"}}",
            "DOM.querySelector" => "{\"nodeId\":2}",
            "DOM.describeNode" => "{\"node\":{\"nodeId\":2,\"backendNodeId\":22,\"nodeName\":\"INPUT\"}}",
            "Accessibility.getPartialAXTree" => accessibilityResponse,
            _ => "{}",
        });
        return socket;
    }

    private static CdpTestSocket CreateMismatchingFixtureSocket()
    {
        var socket = new CdpTestSocket();
        socket.OnSendAsync = message => ReplyAsync(socket, message, method => method switch
        {
            "Target.getTargets" => "{\"targetInfos\":[{\"targetId\":\"fixture\",\"type\":\"page\",\"url\":\"https://fixture.test\",\"title\":\"Fixture\"}]}",
            "Target.attachToTarget" => "{\"sessionId\":\"fixture-session\"}",
            "DOM.getDocument" => "{\"root\":{\"nodeId\":1,\"backendNodeId\":11,\"nodeName\":\"#document\"}}",
            "DOM.querySelector" => "{\"nodeId\":2}",
            "DOM.describeNode" => "{\"node\":{\"nodeId\":2,\"backendNodeId\":22,\"nodeName\":\"INPUT\"}}",
            "Accessibility.getPartialAXTree" => "{\"nodes\":[{\"value\":{\"value\":\"initial fixture value\"}}]}",
            _ => "{}",
        });
        return socket;
    }

    private static async Task ReplyAsync(CdpTestSocket socket, string message, Func<string, string> response)
    {
        JsonElement command = JsonDocument.Parse(message).RootElement;
        socket.EnqueueJson($"{{\"id\":{command.GetProperty("id").GetInt64()},\"result\":{response(command.GetProperty("method").GetString()!)}}}");
        await Task.CompletedTask;
    }

    private static int Count(CdpTestSocket socket, string method) => socket.Sent.Count(message => Method(message) == method);
    private static string? Method(string message) => JsonDocument.Parse(message).RootElement.GetProperty("method").GetString();
}
