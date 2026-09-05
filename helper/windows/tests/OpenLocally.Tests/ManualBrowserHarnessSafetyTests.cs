using System.Text.Json;
using OpenLocally;
using OpenLocally.Tests.Manual;

namespace OpenLocally.Tests;

public sealed class ManualBrowserHarnessSafetyTests
{
    [Fact]
    public async Task BrowserStage_RefusesBeforeDiscoveryConnectionOrFixtureCreationWithoutOptIn()
    {
        string? prior = Environment.GetEnvironmentVariable(ManualFoundationGuard.EnvironmentVariable);
        string workspace = Path.Combine(Path.GetTempPath(), "creatorcrate-m2-manual-browser-guard-" + Guid.NewGuid().ToString("N"));
        int discoveryCalls = 0;
        int connectionCalls = 0;
        try
        {
            Environment.SetEnvironmentVariable(ManualFoundationGuard.EnvironmentVariable, null);

            await Assert.ThrowsAsync<InvalidOperationException>(() => ManualBrowserChromeStage.DiscoverAndConnectAsync(
                () =>
                {
                    discoveryCalls++;
                    return ChromeDiscoveryResult.Ok(new ChromeEndpoint(new Uri("ws://127.0.0.1:9222/devtools/browser/test")));
                },
                (_, _) =>
                {
                    connectionCalls++;
                    return Task.FromResult(ChromeConnectionResult.Ok());
                },
                CancellationToken.None));
            await Assert.ThrowsAsync<InvalidOperationException>(() => ManualBrowserFixture.StartAsync(workspace));
            Assert.Equal(0, discoveryCalls);
            Assert.Equal(0, connectionCalls);
            Assert.False(Directory.Exists(workspace));
        }
        finally
        {
            Environment.SetEnvironmentVariable(ManualFoundationGuard.EnvironmentVariable, prior);
            if (Directory.Exists(workspace)) Directory.Delete(workspace, recursive: true);
        }
    }

    [Fact]
    public void BrowserFixture_HasOnlyPreparationControlsAndUploadObservation()
    {
        string html = ManualBrowserFixture.Html;

        Assert.Contains("id=\"fixture-title\"", html, StringComparison.Ordinal);
        Assert.Contains("<textarea id=\"fixture-body\"", html, StringComparison.Ordinal);
        Assert.DoesNotContain("contenteditable", html, StringComparison.OrdinalIgnoreCase);
        Assert.Contains("id=\"fixture-media\" type=\"file\" multiple", html, StringComparison.Ordinal);
        Assert.Contains("id=\"fixture-upload-ready\"", html, StringComparison.Ordinal);
        Assert.DoesNotContain("<form", html, StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain("action=", html, StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain("fetch(", html, StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain("xmlhttprequest", html, StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain("submit", html, StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain("publish", html, StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain("post", html, StringComparison.OrdinalIgnoreCase);
    }

    [Fact]
    public void FixtureAdapter_UsesPreparationOnlyInterfaceAndAcceptsInjectedBrowserPreparationTargets()
    {
        Assert.Contains(typeof(ISocialPreparationAdapter), typeof(FixturePreparationAdapter).GetInterfaces());
        Assert.Equal(typeof(ManualBrowserFixture), typeof(FixturePreparationAdapter).GetConstructors(System.Reflection.BindingFlags.Instance | System.Reflection.BindingFlags.Public | System.Reflection.BindingFlags.NonPublic).Single().GetParameters().Single().ParameterType);

        string[] methods = typeof(FixturePreparationAdapter)
            .GetMethods(System.Reflection.BindingFlags.Instance | System.Reflection.BindingFlags.Static | System.Reflection.BindingFlags.Public | System.Reflection.BindingFlags.NonPublic | System.Reflection.BindingFlags.DeclaredOnly)
            .Select(method => method.Name.ToLowerInvariant())
            .ToArray();
        string[] forbidden = ["submit", "publish", "post", "sendnow", "confirmpublished"];
        Assert.DoesNotContain(methods, method => forbidden.Any(word => method.Contains(word, StringComparison.Ordinal)));
    }

    [Fact]
    public async Task OneOwnedTarget_ReusesOneConnectedSocketAndOnlyOwnedTargetCloses()
    {
        var socket = new CdpTestSocket();
        int targetsCreated = 0;
        socket.OnSendAsync = message => ReplyAsync(socket, message, command => command.GetProperty("method").GetString()! switch
        {
            "Target.createTarget" => $"{{\"targetId\":\"fixture-{++targetsCreated}\"}}",
            "Target.attachToTarget" => $"{{\"sessionId\":\"{command.GetProperty("params").GetProperty("targetId").GetString()}-session\"}}",
            "Target.getTargets" => "{\"targetInfos\":[{\"targetId\":\"operator\",\"type\":\"page\",\"url\":\"https://operator.example/\",\"title\":\"Operator\"}]}",
            "Target.closeTarget" => "{\"success\":true}",
            _ => "{}",
        });

        await using var connection = new ChromeConnection(() => socket, TimeSpan.FromSeconds(1));
        Assert.True((await connection.ConnectAsync(new ChromeEndpoint(new Uri("ws://127.0.0.1:9222/devtools/browser/test")), CancellationToken.None)).Success);
        await using var transport = new CdpTransport(connection.Socket!);
        var targets = new BrowserPreparationTargets(new CdpTargetManager(transport));
        await using BrowserPreparationSession fixtureTarget = await targets.CreateOwnedAsync();
        await using BrowserPreparationSession operatorTab = await targets.AttachAsync("operator");

        await FixturePreparationAdapter.CloseOwnedTargetsAsync([fixtureTarget]);

        Assert.Equal(1, socket.ConnectCalls);
        Assert.Equal(1, targetsCreated);
        string[] closed = socket.Sent
            .Select(message => JsonDocument.Parse(message).RootElement)
            .Where(command => command.GetProperty("method").GetString() == "Target.closeTarget")
            .Select(command => command.GetProperty("params").GetProperty("targetId").GetString()!)
            .ToArray();
        Assert.Equal(["fixture-1"], closed);
        Assert.DoesNotContain("operator", closed);
    }

    private static async Task ReplyAsync(CdpTestSocket socket, string message, Func<JsonElement, string> response)
    {
        JsonElement command = JsonDocument.Parse(message).RootElement;
        socket.EnqueueJson($"{{\"id\":{command.GetProperty("id").GetInt64()},\"result\":{response(command)}}}");
        await Task.CompletedTask;
    }
}
