using System.Text.Json;
using OpenLocally;

namespace OpenLocally.Tests.Manual;

/// <summary>Test-only, bounded DOM evidence resolver for a single explicitly authorized X composer session.</summary>
internal sealed class XLiveEvidenceNodeResolver
{
    private static readonly HashSet<string> StableAttributeNames = new(StringComparer.OrdinalIgnoreCase)
    {
        "aria-label",
        "contenteditable",
        "data-testid",
        "role",
        "type",
    };

    private readonly CdpSession _session;
    private readonly TimeSpan _retryInterval;

    internal XLiveEvidenceNodeResolver(CdpSession session, TimeSpan? retryInterval = null)
    {
        _session = session ?? throw new ArgumentNullException(nameof(session));
        _retryInterval = retryInterval ?? TimeSpan.FromMilliseconds(50);
        if (_retryInterval <= TimeSpan.Zero) throw new ArgumentOutOfRangeException(nameof(retryInterval));
    }

    internal async Task<XLiveEvidenceDomNode> ResolveFreshNodeAsync(
        string selector,
        string frameId,
        TimeSpan timeout,
        CancellationToken cancellationToken = default)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(selector);
        ArgumentException.ThrowIfNullOrWhiteSpace(frameId);
        if (timeout <= TimeSpan.Zero) throw new ArgumentOutOfRangeException(nameof(timeout));

        using var deadline = new CancellationTokenSource(timeout);
        using var linked = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken, deadline.Token);
        try
        {
            while (true)
            {
                JsonElement document = await _session.SendCommandAsync(
                    "DOM.getDocument",
                    JsonSerializer.SerializeToElement(new { depth = 0, pierce = false }),
                    cancellationToken: linked.Token).ConfigureAwait(false);
                int rootNodeId = RequiredInt32(document, "root", "nodeId");
                JsonElement query = await _session.SendCommandAsync(
                    "DOM.querySelector",
                    JsonSerializer.SerializeToElement(new { nodeId = rootNodeId, selector }),
                    cancellationToken: linked.Token).ConfigureAwait(false);
                int nodeId = OptionalInt32(query, "nodeId");
                if (nodeId == 0)
                {
                    await Task.Delay(_retryInterval, linked.Token).ConfigureAwait(false);
                    continue;
                }

                try
                {
                    JsonElement described = await _session.SendCommandAsync(
                        "DOM.describeNode",
                        JsonSerializer.SerializeToElement(new { nodeId, depth = 0, pierce = false }),
                        cancellationToken: linked.Token).ConfigureAwait(false);
                    return Parse(selector, frameId, described);
                }
                catch (CdpCommandException exception) when (IsStaleDescribeNode(exception))
                {
                    // X can replace a frontend node between querySelector and describeNode; reacquire within this deadline only.
                }

                await Task.Delay(_retryInterval, linked.Token).ConfigureAwait(false);
            }
        }
        catch (OperationCanceledException) when (deadline.IsCancellationRequested && !cancellationToken.IsCancellationRequested)
        {
            throw new BrowserPreparationException(BrowserPreparationFailure.ReadinessTimedOut);
        }
    }

    internal static bool IsStaleDescribeNode(CdpCommandException exception) =>
        exception.Code == -32000 &&
        string.Equals(exception.Message, "Could not find node with given id", StringComparison.Ordinal);

    private static XLiveEvidenceDomNode Parse(string selector, string frameId, JsonElement described)
    {
        if (!described.TryGetProperty("node", out JsonElement node) || node.ValueKind != JsonValueKind.Object)
            throw new BrowserPreparationException(BrowserPreparationFailure.InvalidNode);

        long backendNodeId = OptionalInt64(node, "backendNodeId");
        string? nodeName = OptionalString(node, "nodeName");
        if (backendNodeId == 0 || string.IsNullOrWhiteSpace(nodeName))
            throw new BrowserPreparationException(BrowserPreparationFailure.InvalidNode);

        IReadOnlyDictionary<string, string> attributes = StableAttributes(node);
        return new XLiveEvidenceDomNode(
            selector,
            frameId,
            backendNodeId,
            nodeName,
            attributes.TryGetValue("contenteditable", out string? contentEditable) && string.Equals(contentEditable, "true", StringComparison.OrdinalIgnoreCase),
            string.Equals(nodeName, "INPUT", StringComparison.OrdinalIgnoreCase) && attributes.TryGetValue("type", out string? type) && string.Equals(type, "file", StringComparison.OrdinalIgnoreCase),
            attributes);
    }

    private static IReadOnlyDictionary<string, string> StableAttributes(JsonElement node)
    {
        if (!node.TryGetProperty("attributes", out JsonElement attributes) || attributes.ValueKind != JsonValueKind.Array)
            return new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);

        string[] values = attributes.EnumerateArray().Select(value => value.GetString() ?? string.Empty).ToArray();
        var stable = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        for (int index = 0; index + 1 < values.Length; index += 2)
        {
            if (StableAttributeNames.Contains(values[index])) stable[values[index]] = values[index + 1];
        }
        return stable;
    }

    private static int RequiredInt32(JsonElement element, string parent, string property)
    {
        if (!element.TryGetProperty(parent, out JsonElement nested))
            throw new BrowserPreparationException(BrowserPreparationFailure.InvalidNode);
        int value = OptionalInt32(nested, property);
        return value != 0 ? value : throw new BrowserPreparationException(BrowserPreparationFailure.InvalidNode);
    }

    private static int OptionalInt32(JsonElement element, string property) =>
        element.TryGetProperty(property, out JsonElement value) && value.TryGetInt32(out int result) ? result : 0;

    private static long OptionalInt64(JsonElement element, string property) =>
        element.TryGetProperty(property, out JsonElement value) && value.TryGetInt64(out long result) ? result : 0;

    private static string? OptionalString(JsonElement element, string property) =>
        element.TryGetProperty(property, out JsonElement value) && value.ValueKind == JsonValueKind.String ? value.GetString() : null;
}

/// <summary>Sanitized evidence shape. Frontend node IDs are deliberately not retained.</summary>
internal sealed record XLiveEvidenceDomNode(
    string Selector,
    string FrameId,
    long BackendNodeId,
    string NodeName,
    bool IsContentEditable,
    bool IsFileInput,
    IReadOnlyDictionary<string, string> StableAttributes);
