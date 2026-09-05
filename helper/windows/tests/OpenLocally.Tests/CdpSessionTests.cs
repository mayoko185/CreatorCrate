using System.Text.Json;
using OpenLocally;

namespace OpenLocally.Tests;

public class CdpSessionTests
{
    [Fact]
    public async Task SessionCommand_UsesItsFlattenedSessionId_AndDisposalLeavesParentUsable()
    {
        var socket = new CdpTestSocket();
        await using var transport = new CdpTransport(socket);
        var session = new CdpSession(transport, "session-one");
        Task<JsonElement> command = session.SendCommandAsync("DOM.getDocument");
        await WaitForAsync(() => socket.Sent.Count == 1);
        JsonElement sent = JsonDocument.Parse(socket.Sent.Single()).RootElement;
        Assert.Equal("session-one", sent.GetProperty("sessionId").GetString());
        socket.EnqueueJson("{\"id\":1,\"result\":{}}");
        await command;

        await session.DisposeAsync();
        Task<JsonElement> parentCommand = transport.SendCommandAsync("Target.getTargets");
        await WaitForAsync(() => socket.Sent.Count == 2);
        socket.EnqueueJson("{\"id\":2,\"result\":{}}");
        await parentCommand;
    }

    private static async Task WaitForAsync(Func<bool> condition)
    {
        for (int index = 0; index < 100 && !condition(); index++) await Task.Delay(10);
        Assert.True(condition());
    }
}
