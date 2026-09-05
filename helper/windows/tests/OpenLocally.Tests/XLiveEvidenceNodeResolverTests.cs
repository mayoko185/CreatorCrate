using System.Text.Json;
using OpenLocally;
using OpenLocally.Tests.Manual;

namespace OpenLocally.Tests;

public sealed class XLiveEvidenceNodeResolverTests
{
    [Fact]
    public async Task ResolveFreshNode_StaleFrontendNode_ReacquiresAndReturnsSanitizedStableMetadata()
    {
        var socket = new CdpTestSocket();
        int queries = 0;
        int descriptions = 0;
        socket.OnSendAsync = message => ReplyAsync(socket, message, command => command.GetProperty("method").GetString()! switch
        {
            "DOM.getDocument" => "{\"root\":{\"nodeId\":1}}",
            "DOM.querySelector" => $"{{\"nodeId\":{(++queries == 1 ? 101 : 202)}}}",
            "DOM.describeNode" when ++descriptions == 1 => "{\"error\":{\"code\":-32000,\"message\":\"Could not find node with given id\"}}",
            "DOM.describeNode" => "{\"node\":{\"nodeId\":202,\"backendNodeId\":902,\"nodeName\":\"DIV\",\"attributes\":[\"data-testid\",\"tweetTextarea_0\",\"contenteditable\",\"true\",\"data-private\",\"omit\"]}}",
            _ => throw new InvalidOperationException(),
        });
        await using var transport = new CdpTransport(socket);
        var resolver = new XLiveEvidenceNodeResolver(new CdpSession(transport, "session-a"), TimeSpan.FromMilliseconds(1));

        XLiveEvidenceDomNode node = await resolver.ResolveFreshNodeAsync("[data-testid='tweetTextarea_0']", "frame-a", TimeSpan.FromSeconds(1));

        Assert.Equal(2, queries);
        Assert.Equal(2, descriptions);
        Assert.Equal(902, node.BackendNodeId);
        Assert.Equal("frame-a", node.FrameId);
        Assert.True(node.IsContentEditable);
        Assert.Equal("tweetTextarea_0", node.StableAttributes["data-testid"]);
        Assert.DoesNotContain("data-private", node.StableAttributes.Keys);
    }

    [Fact]
    public async Task ResolveFreshNode_RepeatedStaleNodes_ExpiresWithinTheSharedDeadline()
    {
        var socket = new CdpTestSocket();
        int descriptions = 0;
        socket.OnSendAsync = message => ReplyAsync(socket, message, command => command.GetProperty("method").GetString()! switch
        {
            "DOM.getDocument" => "{\"root\":{\"nodeId\":1}}",
            "DOM.querySelector" => "{\"nodeId\":101}",
            "DOM.describeNode" => Stale(ref descriptions),
            _ => throw new InvalidOperationException(),
        });
        await using var transport = new CdpTransport(socket);
        var resolver = new XLiveEvidenceNodeResolver(new CdpSession(transport, "session-a"), TimeSpan.FromMilliseconds(1));

        BrowserPreparationException exception = await Assert.ThrowsAsync<BrowserPreparationException>(() =>
            resolver.ResolveFreshNodeAsync("[data-testid='tweetButton']", "frame-a", TimeSpan.FromMilliseconds(40)));

        Assert.Equal(BrowserPreparationFailure.ReadinessTimedOut, exception.Failure);
        Assert.True(descriptions > 1);
        Assert.True(descriptions < 40, "The resolver must stop at its deadline rather than retry indefinitely.");
    }

    [Fact]
    public async Task ResolveFreshNode_NonStaleProtocolFailure_PropagatesWithoutSelectorRetry()
    {
        var socket = new CdpTestSocket();
        int queries = 0;
        socket.OnSendAsync = message => ReplyAsync(socket, message, command => command.GetProperty("method").GetString()! switch
        {
            "DOM.getDocument" => "{\"root\":{\"nodeId\":1}}",
            "DOM.querySelector" => Query(ref queries),
            "DOM.describeNode" => "{\"error\":{\"code\":-32000,\"message\":\"Access denied\"}}",
            _ => throw new InvalidOperationException(),
        });
        await using var transport = new CdpTransport(socket);
        var resolver = new XLiveEvidenceNodeResolver(new CdpSession(transport, "session-a"));

        CdpCommandException exception = await Assert.ThrowsAsync<CdpCommandException>(() =>
            resolver.ResolveFreshNodeAsync("[data-testid='tweetButton']", "frame-a", TimeSpan.FromSeconds(1)));

        Assert.Equal(-32000, exception.Code);
        Assert.Equal("Access denied", exception.Message);
        Assert.Equal(1, queries);
    }

    [Fact]
    public async Task ResolveFreshNode_TransportFailure_IsTerminal()
    {
        var socket = new CdpTestSocket();
        socket.OnSendAsync = _ =>
        {
            socket.EnqueueFailure(new IOException("connection dropped"));
            return Task.CompletedTask;
        };
        await using var transport = new CdpTransport(socket);
        var resolver = new XLiveEvidenceNodeResolver(new CdpSession(transport, "session-a"));

        await Assert.ThrowsAsync<CdpTransportException>(() =>
            resolver.ResolveFreshNodeAsync("[data-testid='tweetButton']", "frame-a", TimeSpan.FromSeconds(1)));

        Assert.Single(socket.Sent);
    }

    [Fact]
    public async Task ResolveFreshNode_CallerCancellation_IsTerminal()
    {
        var socket = new CdpTestSocket();
        await using var transport = new CdpTransport(socket);
        var resolver = new XLiveEvidenceNodeResolver(new CdpSession(transport, "session-a"));
        using var cancellation = new CancellationTokenSource();
        cancellation.Cancel();

        await Assert.ThrowsAnyAsync<OperationCanceledException>(() =>
            resolver.ResolveFreshNodeAsync("[data-testid='tweetButton']", "frame-a", TimeSpan.FromSeconds(1), cancellation.Token));
    }

    private static string Stale(ref int descriptions)
    {
        descriptions++;
        return "{\"error\":{\"code\":-32000,\"message\":\"Could not find node with given id\"}}";
    }

    private static string Query(ref int queries)
    {
        queries++;
        return "{\"nodeId\":101}";
    }

    private static async Task ReplyAsync(CdpTestSocket socket, string message, Func<JsonElement, string> response)
    {
        JsonElement command = JsonDocument.Parse(message).RootElement;
        string reply = response(command);
        long id = command.GetProperty("id").GetInt64();
        string session = command.GetProperty("sessionId").GetString()!;
        socket.EnqueueJson($"{{\"id\":{id},\"sessionId\":\"{session}\",{(reply.StartsWith("{\"error\"", StringComparison.Ordinal) ? reply[1..^1] : $"\"result\":{reply}")}}}");
        await Task.CompletedTask;
    }
}
