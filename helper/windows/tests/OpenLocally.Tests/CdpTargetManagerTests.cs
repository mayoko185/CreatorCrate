using System.Text.Json;
using OpenLocally;

namespace OpenLocally.Tests;

public class CdpTargetManagerTests
{
    [Fact]
    public async Task GetTargetsAttachAndDetach_UseLowLevelFlattenedCommands()
    {
        var socket = new CdpTestSocket();
        await using var transport = new CdpTransport(socket);
        var targets = new CdpTargetManager(transport);

        Task<IReadOnlyList<CdpTargetInfo>> listed = targets.GetTargetsAsync();
        await WaitForAsync(() => socket.Sent.Count == 1);
        Assert.Equal("Target.getTargets", Method(socket.Sent.ElementAt(0)));
        socket.EnqueueJson("{\"id\":1,\"result\":{\"targetInfos\":[{\"targetId\":\"tab\",\"type\":\"page\",\"url\":\"https://example.test\",\"title\":\"Example\",\"attached\":true}]}}");
        Assert.Equal("tab", (await listed).Single().TargetId);

        Task<CdpSession> attached = targets.AttachToTargetAsync("tab");
        await WaitForAsync(() => socket.Sent.Count == 2);
        JsonElement attach = JsonDocument.Parse(socket.Sent.ElementAt(1)).RootElement;
        Assert.True(attach.GetProperty("params").GetProperty("flatten").GetBoolean());
        socket.EnqueueJson("{\"id\":2,\"result\":{\"sessionId\":\"session-tab\"}}");
        CdpSession session = await attached;

        Task detach = targets.DetachFromTargetAsync(session);
        await WaitForAsync(() => socket.Sent.Count == 3);
        JsonElement detachCommand = JsonDocument.Parse(socket.Sent.ElementAt(2)).RootElement;
        Assert.Equal("Target.detachFromTarget", detachCommand.GetProperty("method").GetString());
        Assert.Equal("session-tab", detachCommand.GetProperty("params").GetProperty("sessionId").GetString());
        socket.EnqueueJson("{\"id\":3,\"result\":{}}");
        await detach;
    }

    private static string? Method(string message) => JsonDocument.Parse(message).RootElement.GetProperty("method").GetString();

    private static async Task WaitForAsync(Func<bool> condition)
    {
        for (int index = 0; index < 100 && !condition(); index++) await Task.Delay(10);
        Assert.True(condition());
    }
}
