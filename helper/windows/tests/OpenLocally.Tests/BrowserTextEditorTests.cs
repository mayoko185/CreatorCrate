using System.Text.Json;
using OpenLocally;
using OpenLocally.Tests.Manual;

namespace OpenLocally.Tests;

public class BrowserTextEditorTests
{
    [Fact]
    public async Task ReplaceAndVerify_UseFocusKeyboardInsertAndAccessibilityOnTheAttachedSession()
    {
        var socket = new CdpTestSocket();
        socket.OnSendAsync = message => ReplyAsync(socket, message, method => method switch
        {
            "Target.getTargets" => "{\"targetInfos\":[{\"targetId\":\"tab\",\"type\":\"page\",\"url\":\"https://fixture.test\",\"title\":\"Fixture\"}]}",
            "Target.attachToTarget" => "{\"sessionId\":\"tab-session\"}",
            "DOM.getDocument" => "{\"root\":{\"nodeId\":1,\"backendNodeId\":11,\"nodeName\":\"#document\"}}",
            "DOM.querySelector" => "{\"nodeId\":2}",
            "DOM.describeNode" => "{\"node\":{\"nodeId\":2,\"backendNodeId\":22,\"nodeName\":\"TEXTAREA\"}}",
            "Accessibility.getPartialAXTree" => "{\"nodes\":[{\"value\":{\"value\":\"one\\ntwo\\n\\n😀\"}}]}",
            _ => "{}",
        });
        await using var transport = new CdpTransport(socket);
        await using BrowserPreparationSession page = await BrowserPreparationSession.AttachAsync(new CdpTargetManager(transport), "tab");
        var editor = new BrowserTextEditor(page);
        BrowserDomNode node = Assert.IsType<BrowserDomNode>(await editor.FindAsync("textarea"));

        await editor.ReplaceAsync(node, "one\ntwo\n\n😀");
        BrowserTextReadback readback = await editor.ReadAsync(node);
        BrowserTextVerification result = await editor.VerifyAsync(node, "one\ntwo\n\n😀");

        Assert.Equal(BrowserTextVerification.Mismatch, readback.Verification);
        Assert.Equal("one\ntwo\n\n😀", readback.Actual);
        Assert.Equal(BrowserTextVerification.Match, result);
        Assert.Equal("tab-session", Sent(socket, "Input.insertText").GetProperty("sessionId").GetString());
        Assert.Equal("one\ntwo\n\n😀", Sent(socket, "Input.insertText").GetProperty("params").GetProperty("text").GetString());
        Assert.Equal(2, socket.Sent.Count(message => Method(message) == "Input.dispatchKeyEvent"));
        Assert.DoesNotContain(SentAll(socket, "Input.dispatchKeyEvent"), command => command.GetProperty("params").TryGetProperty("commands", out _));
        Assert.DoesNotContain(socket.Sent, message => Method(message) == "Runtime.evaluate");
    }

    [Fact]
    public async Task ContentEditableMultiline_UsesExactLineBreaksForFixtureBlankLineAndUnicode()
    {
        var socket = new CdpTestSocket();
        socket.OnSendAsync = message => ReplyAsync(socket, message, method => method switch
        {
            "Target.getTargets" => "{\"targetInfos\":[{\"targetId\":\"tab\",\"type\":\"page\",\"url\":\"https://fixture.test\",\"title\":\"Fixture\"}]}",
            "Target.attachToTarget" => "{\"sessionId\":\"tab-session\"}",
            "DOM.getDocument" => "{\"root\":{\"nodeId\":1,\"backendNodeId\":11,\"nodeName\":\"#document\"}}",
            "DOM.querySelector" => "{\"nodeId\":2}",
            "DOM.describeNode" => "{\"node\":{\"nodeId\":2,\"backendNodeId\":22,\"nodeName\":\"DIV\",\"attributes\":[\"id\",\"fixture-body\",\"contenteditable\",\"true\"]}}",
            "Accessibility.getPartialAXTree" => "{\"nodes\":[{\"nodeId\":\"root\",\"backendDOMNodeId\":22,\"role\":{\"value\":\"textbox\"},\"childIds\":[\"line-1\",\"break-1\",\"break-2\",\"line-3\"]},{\"nodeId\":\"line-1\",\"role\":{\"value\":\"StaticText\"},\"name\":{\"value\":\"CreatorCrate fixture body line 1\"}},{\"nodeId\":\"break-1\",\"role\":{\"value\":\"LineBreak\"}},{\"nodeId\":\"break-2\",\"role\":{\"value\":\"LineBreak\"}},{\"nodeId\":\"line-3\",\"role\":{\"value\":\"StaticText\"},\"name\":{\"value\":\"Fixture line 3 — Unicode ✓\"}}]}",
            _ => "{}",
        });
        await using var transport = new CdpTransport(socket);
        await using BrowserPreparationSession page = await BrowserPreparationSession.AttachAsync(new CdpTargetManager(transport), "tab");
        var editor = new BrowserTextEditor(page);
        BrowserDomNode node = Assert.IsType<BrowserDomNode>(await editor.FindAsync("#fixture-body"));

        await editor.ReplaceAsync(node, ManualBrowserFixture.Body);

        JsonElement[] insertions = SentAll(socket, "Input.insertText");
        Assert.Equal(["CreatorCrate fixture body line 1", "Fixture line 3 — Unicode ✓"],
            insertions.Select(command => command.GetProperty("params").GetProperty("text").GetString()).ToArray());
        JsonElement[] lineBreaks = SentAll(socket, "Input.dispatchKeyEvent")
            .Where(command => command.GetProperty("params").TryGetProperty("commands", out _))
            .ToArray();
        Assert.Equal(2, lineBreaks.Length);
        Assert.All(lineBreaks, command =>
        {
            JsonElement parameters = command.GetProperty("params");
            Assert.Equal("rawKeyDown", parameters.GetProperty("type").GetString());
            Assert.Equal("Enter", parameters.GetProperty("key").GetString());
            Assert.Equal("Enter", parameters.GetProperty("code").GetString());
            Assert.Equal(13, parameters.GetProperty("windowsVirtualKeyCode").GetInt32());
            Assert.Equal(8, parameters.GetProperty("modifiers").GetInt32());
            Assert.Equal(new[] { "InsertLineBreak" }, parameters.GetProperty("commands").EnumerateArray().Select(item => item.GetString()).ToArray());
        });
        Assert.Equal(4, SentAll(socket, "Input.dispatchKeyEvent").Count(command => command.GetProperty("params").GetProperty("key").GetString() == "Enter"));
        Assert.Equal(2, SentAll(socket, "Input.dispatchKeyEvent").Count(command =>
            command.GetProperty("params").GetProperty("type").GetString() == "keyUp" &&
            command.GetProperty("params").GetProperty("key").GetString() == "Enter"));
        Assert.DoesNotContain(SentAll(socket, "Input.dispatchKeyEvent"), command =>
            command.GetProperty("params").GetProperty("key").GetString() == "Shift");
        Assert.Equal(BrowserTextVerification.Match, await editor.VerifyAsync(node, ManualBrowserFixture.Body));
        Assert.DoesNotContain(socket.Sent, message => Method(message) == "Runtime.evaluate");
    }

    [Theory]
    [MemberData(nameof(ContentEditableLfCases))]
    public async Task ExplicitContentEditable_LfCardinalityPreservesEverySourceLineFeed(string text, string[] expectedRuns, int expectedLineBreaks)
    {
        await using EditorHarness harness = await CreateEditorAsync("DIV", ["contenteditable", "true"]);

        await harness.Editor.ReplaceAsync(harness.Node, text);

        Assert.Equal(expectedRuns, InsertedTexts(harness.Socket));
        Assert.Equal(expectedLineBreaks, LineBreakDowns(harness.Socket).Length);
        Assert.Equal(expectedLineBreaks, LineBreakUps(harness.Socket).Length);
        Assert.Equal(text.Count(character => character == '\n'), LineBreakDowns(harness.Socket).Length);
        Assert.Equal(text.Count(character => character == '\n'), LineBreakUps(harness.Socket).Length);
    }

    public static IEnumerable<object[]> ContentEditableLfCases()
    {
        yield return ["a\nb", new[] { "a", "b" }, 1];
        yield return ["a\n\nb", new[] { "a", "b" }, 2];
        yield return ["a\n\n\nb", new[] { "a", "b" }, 3];
        yield return ["\na", new[] { "a" }, 1];
        yield return ["a\n", new[] { "a" }, 1];
        yield return ["😀\n€", new[] { "😀", "€" }, 1];
    }

    [Theory]
    [MemberData(nameof(ExplicitEditabilityCases))]
    public async Task ExplicitContentEditableAttributeMatrix_SelectsTheRichLineBreakPathOnlyForEditableValues(string[]? attributes, bool usesRichLineBreakPath)
    {
        await using EditorHarness harness = await CreateEditorAsync("DIV", attributes);

        await harness.Editor.ReplaceAsync(harness.Node, "a\nb");

        Assert.Equal(usesRichLineBreakPath ? new[] { "a", "b" } : new[] { "a\nb" }, InsertedTexts(harness.Socket));
        Assert.Equal(usesRichLineBreakPath ? 1 : 0, LineBreakDowns(harness.Socket).Length);
        Assert.Equal(usesRichLineBreakPath ? 1 : 0, LineBreakUps(harness.Socket).Length);
    }

    public static IEnumerable<object?[]> ExplicitEditabilityCases()
    {
        yield return [new[] { "contenteditable", "true" }, true];
        yield return [new[] { "contenteditable", "" }, true];
        yield return [new[] { "contenteditable", "plaintext-only" }, true];
        yield return [new[] { "contenteditable", "false" }, false];
        yield return [null, false];
        yield return [new[] { "CONTENTEDITABLE", "TRUE" }, true];
    }

    [Fact]
    public async Task ContentEditableEmptyText_RemainsAnAtomicEmptyInsertionWithoutLineBreaks()
    {
        await using EditorHarness harness = await CreateEditorAsync("DIV", ["contenteditable", "true"]);

        await harness.Editor.ReplaceAsync(harness.Node, "");

        Assert.Equal(new[] { "" }, InsertedTexts(harness.Socket));
        Assert.Empty(LineBreakDowns(harness.Socket));
    }

    [Fact]
    public async Task ContentEditableSingleLine_RemainsAnAtomicInsertionWithoutLineBreaks()
    {
        await using EditorHarness harness = await CreateEditorAsync("DIV", ["contenteditable", "true"]);

        await harness.Editor.ReplaceAsync(harness.Node, "abc");

        Assert.Equal(new[] { "abc" }, InsertedTexts(harness.Socket));
        Assert.Empty(LineBreakDowns(harness.Socket));
    }

    [Fact]
    public async Task OddContentEditableAttributeArray_FailsClosedToTheAtomicPath()
    {
        await using EditorHarness harness = await CreateEditorAsync("DIV", ["contenteditable"]);

        await harness.Editor.ReplaceAsync(harness.Node, "a\nb");

        Assert.Equal(new[] { "a\nb" }, InsertedTexts(harness.Socket));
        Assert.Empty(LineBreakDowns(harness.Socket));
    }

    [Fact]
    public async Task InputWithLineFeeds_RemainsAtomicAndDoesNotUseContentEditableCommands()
    {
        await using EditorHarness harness = await CreateEditorAsync("INPUT");

        await harness.Editor.ReplaceAsync(harness.Node, "a\n\nb");

        Assert.Equal(new[] { "a\n\nb" }, InsertedTexts(harness.Socket));
        Assert.Empty(LineBreakDowns(harness.Socket));
    }

    [Fact]
    public async Task InsertLineBreakCommandFailure_PropagatesImmediatelyWithoutLaterInsertionOrReadback()
    {
        await using EditorHarness harness = await CreateEditorAsync("DIV", ["contenteditable", "true"], failFirstLineBreak: true);

        CdpCommandException exception = await Assert.ThrowsAsync<CdpCommandException>(() => harness.Editor.ReplaceAsync(harness.Node, "a\nb"));

        Assert.Equal(-32042, exception.Code);
        Assert.Equal("InsertLineBreak denied", exception.Message);
        Assert.Equal(new[] { "a" }, InsertedTexts(harness.Socket));
        Assert.Single(LineBreakDowns(harness.Socket));
        Assert.Empty(LineBreakUps(harness.Socket));
        Assert.DoesNotContain(InsertedTexts(harness.Socket), text => text == "b");
        Assert.DoesNotContain(harness.Socket.Sent, message => Method(message) == "Accessibility.getPartialAXTree");
        Assert.DoesNotContain(harness.Socket.Sent, message => Method(message) == "Accessibility.enable");
    }

    [Fact]
    public async Task InputReadback_UsesLiveAccessibilityValueRatherThanInitialHtmlAttribute()
    {
        var socket = new CdpTestSocket();
        socket.OnSendAsync = message => ReplyAsync(socket, message, method => method switch
        {
            "Target.getTargets" => "{\"targetInfos\":[{\"targetId\":\"tab\",\"type\":\"page\",\"url\":\"https://fixture.test\",\"title\":\"Fixture\"}]}",
            "Target.attachToTarget" => "{\"sessionId\":\"tab-session\"}",
            "DOM.getDocument" => "{\"root\":{\"nodeId\":1,\"backendNodeId\":11,\"nodeName\":\"#document\"}}",
            "DOM.querySelector" => "{\"nodeId\":2}",
            "DOM.describeNode" => "{\"node\":{\"nodeId\":2,\"backendNodeId\":22,\"nodeName\":\"INPUT\",\"attributes\":[\"value\",\"initial fixture value\"]}}",
            "Accessibility.getPartialAXTree" => "{\"nodes\":[{\"value\":{\"value\":\"updated fixture value\"}}]}",
            _ => "{}",
        });
        await using var transport = new CdpTransport(socket);
        await using BrowserPreparationSession page = await BrowserPreparationSession.AttachAsync(new CdpTargetManager(transport), "tab");
        var editor = new BrowserTextEditor(page);
        BrowserDomNode node = Assert.IsType<BrowserDomNode>(await editor.FindAsync("input"));

        await editor.ReplaceAsync(node, "updated fixture value");
        BrowserTextReadback readback = await editor.ReadAsync(node);

        Assert.Equal(BrowserTextVerification.Mismatch, readback.Verification);
        Assert.Equal("updated fixture value", readback.Actual);
        Assert.Equal(BrowserTextVerification.Match, await editor.VerifyAsync(node, "updated fixture value"));
        Assert.Equal("updated fixture value", Sent(socket, "Input.insertText").GetProperty("params").GetProperty("text").GetString());
        Assert.Equal(2, socket.Sent.Count(message => Method(message) == "Input.dispatchKeyEvent"));
        Assert.DoesNotContain(socket.Sent, message => Method(message) == "Runtime.evaluate");
    }

    [Fact]
    public async Task CrossSessionNode_IsRejectedBeforeAnyBrowserCommand()
    {
        var socket = new CdpTestSocket();
        socket.OnSendAsync = async message =>
        {
            JsonElement command = JsonDocument.Parse(message).RootElement;
            string method = command.GetProperty("method").GetString()!;
            string result = method switch
            {
                "Target.getTargets" => "{\"targetInfos\":[{\"targetId\":\"one\",\"type\":\"page\",\"url\":\"https://fixture.test/one\",\"title\":\"One\"},{\"targetId\":\"two\",\"type\":\"page\",\"url\":\"https://fixture.test/two\",\"title\":\"Two\"}]}",
                "Target.attachToTarget" when command.GetProperty("params").GetProperty("targetId").GetString() == "one" => "{\"sessionId\":\"one-session\"}",
                "Target.attachToTarget" => "{\"sessionId\":\"two-session\"}",
                "DOM.getDocument" => "{\"root\":{\"nodeId\":1,\"backendNodeId\":11,\"nodeName\":\"#document\"}}",
                "DOM.querySelector" => "{\"nodeId\":2}",
                "DOM.describeNode" => "{\"node\":{\"nodeId\":2,\"backendNodeId\":22,\"nodeName\":\"INPUT\"}}",
                _ => "{}",
            };
            socket.EnqueueJson($"{{\"id\":{command.GetProperty("id").GetInt64()},\"result\":{result}}}");
            await Task.CompletedTask;
        };
        await using var transport = new CdpTransport(socket);
        var targets = new CdpTargetManager(transport);
        await using BrowserPreparationSession pageOne = await BrowserPreparationSession.AttachAsync(targets, "one");
        await using BrowserPreparationSession pageTwo = await BrowserPreparationSession.AttachAsync(targets, "two");
        BrowserDomNode node = Assert.IsType<BrowserDomNode>(await pageOne.FindNodeAsync("input"));

        BrowserPreparationException exception = await Assert.ThrowsAsync<BrowserPreparationException>(() => pageTwo.ReplaceTextAsync(node, "nope"));

        Assert.Equal(BrowserPreparationFailure.CrossSessionNode, exception.Failure);
        Assert.DoesNotContain(socket.Sent, message => Method(message) == "Input.insertText");
    }

    private static async Task ReplyAsync(CdpTestSocket socket, string message, Func<string, string> response)
    {
        JsonElement command = JsonDocument.Parse(message).RootElement;
        socket.EnqueueJson($"{{\"id\":{command.GetProperty("id").GetInt64()},\"result\":{response(command.GetProperty("method").GetString()!)}}}");
        await Task.CompletedTask;
    }

    private static async Task<EditorHarness> CreateEditorAsync(string nodeName, string[]? attributes = null, bool failFirstLineBreak = false)
    {
        var socket = new CdpTestSocket();
        bool lineBreakFailed = false;
        socket.OnSendAsync = message =>
        {
            JsonElement command = JsonDocument.Parse(message).RootElement;
            long id = command.GetProperty("id").GetInt64();
            string method = command.GetProperty("method").GetString()!;
            if (failFirstLineBreak && !lineBreakFailed && IsLineBreakRawKeyDown(command))
            {
                lineBreakFailed = true;
                socket.EnqueueJson($"{{\"id\":{id},\"error\":{{\"code\":-32042,\"message\":\"InsertLineBreak denied\"}}}}");
                return Task.CompletedTask;
            }

            string attributesJson = attributes is null ? "" : $",\"attributes\":{JsonSerializer.Serialize(attributes)}";
            string result = method switch
            {
                "Target.getTargets" => "{\"targetInfos\":[{\"targetId\":\"tab\",\"type\":\"page\",\"url\":\"https://fixture.test\",\"title\":\"Fixture\"}]}",
                "Target.attachToTarget" => "{\"sessionId\":\"tab-session\"}",
                "DOM.getDocument" => "{\"root\":{\"nodeId\":1,\"backendNodeId\":11,\"nodeName\":\"#document\"}}",
                "DOM.querySelector" => "{\"nodeId\":2}",
                "DOM.describeNode" => $"{{\"node\":{{\"nodeId\":2,\"backendNodeId\":22,\"nodeName\":\"{nodeName}\"{attributesJson}}}}}",
                _ => "{}",
            };
            socket.EnqueueJson($"{{\"id\":{id},\"result\":{result}}}");
            return Task.CompletedTask;
        };

        var transport = new CdpTransport(socket);
        BrowserPreparationSession page = await BrowserPreparationSession.AttachAsync(new CdpTargetManager(transport), "tab");
        var editor = new BrowserTextEditor(page);
        BrowserDomNode node = Assert.IsType<BrowserDomNode>(await editor.FindAsync("#fixture-body"));
        return new EditorHarness(socket, transport, page, editor, node);
    }

    private static string[] InsertedTexts(CdpTestSocket socket) => SentAll(socket, "Input.insertText")
        .Select(command => command.GetProperty("params").GetProperty("text").GetString()!)
        .ToArray();

    private static JsonElement[] LineBreakDowns(CdpTestSocket socket) => SentAll(socket, "Input.dispatchKeyEvent")
        .Where(IsLineBreakRawKeyDown)
        .ToArray();

    private static JsonElement[] LineBreakUps(CdpTestSocket socket) => SentAll(socket, "Input.dispatchKeyEvent")
        .Where(command =>
        {
            JsonElement parameters = command.GetProperty("params");
            return parameters.GetProperty("type").GetString() == "keyUp" &&
                parameters.GetProperty("key").GetString() == "Enter" &&
                parameters.GetProperty("code").GetString() == "Enter" &&
                parameters.GetProperty("windowsVirtualKeyCode").GetInt32() == 13 &&
                parameters.GetProperty("modifiers").GetInt32() == 8;
        })
        .ToArray();

    private static bool IsLineBreakRawKeyDown(JsonElement command)
    {
        if (command.GetProperty("method").GetString() != "Input.dispatchKeyEvent") return false;
        JsonElement parameters = command.GetProperty("params");
        return parameters.GetProperty("type").GetString() == "rawKeyDown" &&
            parameters.TryGetProperty("commands", out JsonElement commands) &&
            commands.ValueKind == JsonValueKind.Array &&
            commands.GetArrayLength() == 1 &&
            commands[0].GetString() == "InsertLineBreak";
    }

    private static JsonElement Sent(CdpTestSocket socket, string method) => JsonDocument.Parse(socket.Sent.Single(message => Method(message) == method)).RootElement;
    private static JsonElement[] SentAll(CdpTestSocket socket, string method) => socket.Sent
        .Where(message => Method(message) == method)
        .Select(message => JsonDocument.Parse(message).RootElement.Clone())
        .ToArray();
    private static string? Method(string message) => JsonDocument.Parse(message).RootElement.GetProperty("method").GetString();

    private sealed class EditorHarness(CdpTestSocket socket, CdpTransport transport, BrowserPreparationSession page, BrowserTextEditor editor, BrowserDomNode node) : IAsyncDisposable
    {
        public CdpTestSocket Socket { get; } = socket;
        public CdpTransport Transport { get; } = transport;
        public BrowserPreparationSession Page { get; } = page;
        public BrowserTextEditor Editor { get; } = editor;
        public BrowserDomNode Node { get; } = node;

        public async ValueTask DisposeAsync()
        {
            await Page.DisposeAsync();
            await Transport.DisposeAsync();
        }
    }
}
