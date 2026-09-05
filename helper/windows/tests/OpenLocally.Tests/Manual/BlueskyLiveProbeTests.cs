using System.Text.Json;
using OpenLocally;

namespace OpenLocally.Tests.Manual;

/// <summary>Explicit opt-in, read-only live semantic probe used before freezing Bluesky adapter selectors.</summary>
[Trait("Category", "Manual")]
public sealed class BlueskyLiveProbeTests
{
    private const string ExactBody = "CreatorCrate live probe line 1\n\nLine 3 — Unicode ✓";

    [Fact]
    public async Task Home_ActivatesCurrentComposeNewPostAndReportsComposerSemantics()
    {
        ManualFoundationGuard.RequireOptIn();
        string reportPath = RequireReportPath();

        await using var connection = new ChromeConnection();
        var workflow = new ChromeConnectionWorkflow(
            new ChromeDiscovery(),
            connection,
            new NativeChromeConnectionConsent());

        ChromeConnectionResult result = await workflow.ConnectAsync(CancellationToken.None);
        Assert.True(result.Success, $"Chrome connection failed: {result.ErrorCode}");
        Assert.NotNull(connection.Socket);

        await using var transport = new CdpTransport(connection.Socket);
        var targets = new CdpTargetManager(transport);
        BrowserPreparationSession page = await BrowserPreparationSession.CreateOwnedAsync(targets);
        try
        {
            BrowserNavigationResult navigation = await page.NavigateAsync("https://bsky.app/", TimeSpan.FromSeconds(30));
            await page.WaitForDocumentAsync(TimeSpan.FromSeconds(30));
            await Task.Delay(TimeSpan.FromSeconds(3));
            await page.Session.SendCommandAsync("Accessibility.enable");
            JsonElement tree = await page.Session.SendCommandAsync("Accessibility.getFullAXTree");

            Control[] controls = Controls(tree);
            Control compose = controls
                .Where(control => control is { Role: "button", Name: "Compose new post" })
                .OrderBy(control => control.BackendNodeId)
                .First();
            BrowserDomNode composeControl = await page.WaitForNodeAsync("button[aria-label='Compose new post']");
            await page.ActivateAsync(composeControl);
            (JsonElement composerTree, bool composerFound) = await WaitForComposerAsync(page);
            Control[] composerControls = Controls(composerTree);
            DomCandidate[] composerNodes = await FindComposerNodesAsync(page);
            DomCandidate composeNode = await DescribeBackendNodeAsync(page, composeControl.BackendNodeId);
            DomCandidate mediaNode = await DescribeBackendNodeAsync(
                page,
                composerControls.Single(control => control.Name == "Add media to post").BackendNodeId);
            DomCandidate publishNode = await DescribeBackendNodeAsync(
                page,
                composerControls.Single(control => control.Name == "Publish post").BackendNodeId);
            BrowserDomNode editorNode = await page.WaitForNodeAsync("div.tiptap.ProseMirror[contenteditable='true']");
            var editor = new BrowserTextEditor(page);
            await editor.ReplaceAsync(editorNode, ExactBody);
            BrowserTextVerification readback = await editor.VerifyAsync(editorNode, ExactBody);
            string mediaPath = Path.Combine(Path.GetTempPath(), "creatorcrate-bluesky-live-probe.png");
            await File.WriteAllBytesAsync(mediaPath, Convert.FromBase64String("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScL9WAAAAABJRU5ErkJggg=="));
            try
            {
                BrowserDomNode mediaControl = await page.WaitForNodeAsync("button[data-testid='openMediaBtn']");
                var chooser = new BrowserFileChooser(page);
                await chooser.AttachTransientFilesAsync([mediaPath], navigation.FrameId, token => page.ActivateAsync(mediaControl, token));
            }
            finally
            {
                File.Delete(mediaPath);
            }
            JsonElement uploadTree = await page.Session.SendCommandAsync("Accessibility.getFullAXTree");
            Control[] uploadControls = Controls(uploadTree);

            await File.WriteAllTextAsync(reportPath, JsonSerializer.Serialize(new
            {
                Url = "https://bsky.app/",
                Controls = controls,
                ComposeAction = compose,
                ComposeNode = composeNode,
                ComposerFrameId = navigation.FrameId,
                ComposerControls = composerControls,
                ComposerNodes = composerNodes,
                MediaNode = mediaNode,
                PublishNode = publishNode,
                ExactBodyReadback = readback.ToString(),
                UploadControls = uploadControls,
            }, new JsonSerializerOptions { WriteIndented = true }));

            Assert.NotEmpty(controls);
            Assert.True(composerFound, "The real Compose new post control did not expose composer semantics after activation.");
            Assert.Contains(composerControls, control => control.Name == "Publish post");
            Assert.Contains(composerNodes, node => node.IsContentEditable);
            Assert.DoesNotContain(composerNodes, node => node.IsFileInput);
            Assert.Equal(BrowserTextVerification.Match, readback);
        }
        finally
        {
            await page.DisposeAsync();
            await targets.CloseTargetAsync(page.TargetId);
        }
    }

    private static string RequireReportPath()
    {
        string? path = Environment.GetEnvironmentVariable("CREATORCRATE_M3_LIVE_PROBE_REPORT");
        if (string.IsNullOrWhiteSpace(path)) throw new InvalidOperationException("Set CREATORCRATE_M3_LIVE_PROBE_REPORT for the live probe.");
        return path;
    }

    private static string? Value(JsonElement node, string property) =>
        node.TryGetProperty(property, out JsonElement field) &&
        field.TryGetProperty("value", out JsonElement value) &&
        value.ValueKind == JsonValueKind.String
            ? value.GetString()
            : null;

    private static Control[] Controls(JsonElement tree) => tree.GetProperty("nodes")
        .EnumerateArray()
        .Select(node => new Control(
            Value(node, "role"),
            Value(node, "name"),
            node.TryGetProperty("backendDOMNodeId", out JsonElement backend) && backend.TryGetInt64(out long id) ? id : 0))
        .Where(control => control.Role is "button" or "link" or "textbox")
        .Where(control => control.Role == "textbox" || !string.IsNullOrWhiteSpace(control.Name))
        .OrderBy(control => control.Role, StringComparer.Ordinal)
        .ThenBy(control => control.Name, StringComparer.Ordinal)
        .ToArray();

    private static async Task<(JsonElement Tree, bool Found)> WaitForComposerAsync(BrowserPreparationSession page)
    {
        using var deadline = new CancellationTokenSource(TimeSpan.FromSeconds(15));
        JsonElement? lastTree = null;
        while (true)
        {
            JsonElement tree;
            try
            {
                tree = await page.Session.SendCommandAsync("Accessibility.getFullAXTree", cancellationToken: deadline.Token);
            }
            catch (OperationCanceledException) when (deadline.IsCancellationRequested && lastTree is JsonElement previous)
            {
                return (previous, false);
            }
            Control[] controls = Controls(tree);
            if (controls.Any(control => control.Name == "Publish post") && controls.Any(control => control.Name == "Add media to post"))
                return (tree, true);
            lastTree = tree;
            try { await Task.Delay(TimeSpan.FromMilliseconds(50), deadline.Token); }
            catch (OperationCanceledException) when (deadline.IsCancellationRequested) { return (lastTree.Value, false); }
        }
    }

    private static async Task<DomCandidate[]> FindComposerNodesAsync(BrowserPreparationSession page)
    {
        JsonElement document = await page.Session.SendCommandAsync("DOM.getDocument", JsonSerializer.SerializeToElement(new { depth = 0, pierce = false }));
        int rootNodeId = document.GetProperty("root").GetProperty("nodeId").GetInt32();
        JsonElement query = await page.Session.SendCommandAsync(
            "DOM.querySelectorAll",
            JsonSerializer.SerializeToElement(new { nodeId = rootNodeId, selector = "[contenteditable='true'], input[type='file']" }));
        var candidates = new List<DomCandidate>();
        foreach (JsonElement nodeId in query.GetProperty("nodeIds").EnumerateArray())
        {
            JsonElement description = await page.Session.SendCommandAsync("DOM.describeNode", JsonSerializer.SerializeToElement(new { nodeId = nodeId.GetInt32(), depth = 0, pierce = false }));
            JsonElement node = description.GetProperty("node");
            string[] attributes = Attributes(node);
            string? nodeName = StringProperty(node, "nodeName");
            candidates.Add(new DomCandidate(
                nodeName,
                node.TryGetProperty("backendNodeId", out JsonElement backend) && backend.TryGetInt64(out long id) ? id : 0,
                Attribute(attributes, "contenteditable") is "true",
                string.Equals(nodeName, "INPUT", StringComparison.OrdinalIgnoreCase) && Attribute(attributes, "type") is "file",
                attributes));
        }
        return candidates.ToArray();
    }

    private static async Task<DomCandidate> DescribeBackendNodeAsync(BrowserPreparationSession page, long backendNodeId)
    {
        await page.Session.SendCommandAsync("DOM.getDocument", JsonSerializer.SerializeToElement(new { depth = 0, pierce = false }));
        JsonElement pushed = await page.Session.SendCommandAsync(
            "DOM.pushNodesByBackendIdsToFrontend",
            JsonSerializer.SerializeToElement(new { backendNodeIds = new[] { backendNodeId } }));
        int nodeId = pushed.GetProperty("nodeIds")[0].GetInt32();
        JsonElement description = await page.Session.SendCommandAsync("DOM.describeNode", JsonSerializer.SerializeToElement(new { nodeId, depth = 0, pierce = false }));
        JsonElement node = description.GetProperty("node");
        string[] attributes = Attributes(node);
        string? nodeName = StringProperty(node, "nodeName");
        return new DomCandidate(
            nodeName,
            node.TryGetProperty("backendNodeId", out JsonElement backend) && backend.TryGetInt64(out long id) ? id : 0,
            Attribute(attributes, "contenteditable") is "true",
            string.Equals(nodeName, "INPUT", StringComparison.OrdinalIgnoreCase) && Attribute(attributes, "type") is "file",
            attributes);
    }

    private static string[] Attributes(JsonElement node) =>
        node.TryGetProperty("attributes", out JsonElement attributes) && attributes.ValueKind == JsonValueKind.Array
            ? attributes.EnumerateArray().Select(value => value.GetString() ?? string.Empty).ToArray()
            : [];

    private static string? StringProperty(JsonElement node, string property) =>
        node.TryGetProperty(property, out JsonElement value) && value.ValueKind == JsonValueKind.String
            ? value.GetString()
            : null;

    private static string? Attribute(IReadOnlyList<string> attributes, string name)
    {
        for (int index = 0; index + 1 < attributes.Count; index += 2)
        {
            if (string.Equals(attributes[index], name, StringComparison.OrdinalIgnoreCase)) return attributes[index + 1];
        }
        return null;
    }

    private sealed record Control(string? Role, string? Name, long BackendNodeId);
    private sealed record DomCandidate(string? NodeName, long BackendNodeId, bool IsContentEditable, bool IsFileInput, string[] Attributes);
}
