using System.Text.Json;

namespace OpenLocally;

public sealed record CdpTargetInfo(string TargetId, string Type, string Url, string Title, bool Attached);
public sealed record CdpBrowserVersion(string Product, string ProtocolVersion, string UserAgent);

/// <summary>Low-level flattened target commands; filtering and tab lifecycle remain higher-level concerns.</summary>
internal sealed class CdpTargetManager
{
    private readonly CdpTransport _transport;

    internal CdpTargetManager(CdpTransport transport)
    {
        _transport = transport ?? throw new ArgumentNullException(nameof(transport));
    }

    internal bool IsTransportTerminal => _transport.IsTerminal;
    internal string TransportDiagnosticState => _transport.DiagnosticState;

    internal async Task<CdpBrowserVersion> GetBrowserVersionAsync(TimeSpan? timeout = null, CancellationToken cancellationToken = default)
    {
        JsonElement result = await _transport.SendCommandAsync("Browser.getVersion", timeout: timeout, cancellationToken: cancellationToken);
        if (!TryGetString(result, "product", out string? product) ||
            !TryGetString(result, "protocolVersion", out string? protocolVersion) ||
            !TryGetString(result, "userAgent", out string? userAgent))
        {
            throw new CdpTransportException(CdpTransportFailure.MalformedMessage);
        }
        return new CdpBrowserVersion(product!, protocolVersion!, userAgent!);
    }

    internal async Task<string> CreateTargetAsync(string url = "about:blank", TimeSpan? timeout = null, CancellationToken cancellationToken = default)
    {
        if (!string.Equals(url, "about:blank", StringComparison.Ordinal))
        {
            throw new ArgumentException("Only the harmless about:blank target is created by this primitive.", nameof(url));
        }
        JsonElement parameters = JsonSerializer.SerializeToElement(new { url });
        JsonElement result = await _transport.SendCommandAsync("Target.createTarget", parameters, timeout: timeout, cancellationToken: cancellationToken);
        if (!TryGetString(result, "targetId", out string? targetId))
        {
            throw new CdpTransportException(CdpTransportFailure.MalformedMessage);
        }
        return targetId!;
    }

    internal async Task CloseTargetAsync(string targetId, TimeSpan? timeout = null, CancellationToken cancellationToken = default)
    {
        if (string.IsNullOrWhiteSpace(targetId))
        {
            throw new ArgumentException("A CDP target ID is required.", nameof(targetId));
        }
        JsonElement parameters = JsonSerializer.SerializeToElement(new { targetId });
        JsonElement result = await _transport.SendCommandAsync("Target.closeTarget", parameters, timeout: timeout, cancellationToken: cancellationToken);
        if (!result.TryGetProperty("success", out JsonElement success) || success.ValueKind != JsonValueKind.True)
        {
            throw new CdpTransportException(CdpTransportFailure.MalformedMessage);
        }
    }

    internal async Task<IReadOnlyList<CdpTargetInfo>> GetTargetsAsync(TimeSpan? timeout = null, CancellationToken cancellationToken = default)
    {
        JsonElement result = await _transport.SendCommandAsync("Target.getTargets", timeout: timeout, cancellationToken: cancellationToken);
        if (!result.TryGetProperty("targetInfos", out JsonElement targetInfos) || targetInfos.ValueKind != JsonValueKind.Array)
        {
            throw new CdpTransportException(CdpTransportFailure.MalformedMessage);
        }

        var targets = new List<CdpTargetInfo>();
        foreach (JsonElement target in targetInfos.EnumerateArray())
        {
            if (!TryGetString(target, "targetId", out string? targetId) ||
                !TryGetString(target, "type", out string? type) ||
                !TryGetString(target, "url", out string? url) ||
                !TryGetString(target, "title", out string? title))
            {
                throw new CdpTransportException(CdpTransportFailure.MalformedMessage);
            }
            bool attached = target.TryGetProperty("attached", out JsonElement attachedElement) && attachedElement.ValueKind == JsonValueKind.True;
            targets.Add(new CdpTargetInfo(targetId!, type!, url!, title!, attached));
        }
        return targets;
    }

    internal async Task<CdpSession> AttachToTargetAsync(string targetId, TimeSpan? timeout = null, CancellationToken cancellationToken = default)
    {
        if (string.IsNullOrWhiteSpace(targetId))
        {
            throw new ArgumentException("A CDP target ID is required.", nameof(targetId));
        }
        JsonElement parameters = JsonSerializer.SerializeToElement(new { targetId, flatten = true });
        JsonElement result = await _transport.SendCommandAsync("Target.attachToTarget", parameters, timeout: timeout, cancellationToken: cancellationToken);
        if (!TryGetString(result, "sessionId", out string? sessionId))
        {
            throw new CdpTransportException(CdpTransportFailure.MalformedMessage);
        }
        return new CdpSession(_transport, sessionId!);
    }

    internal async Task DetachFromTargetAsync(CdpSession session, TimeSpan? timeout = null, CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(session);
        JsonElement parameters = JsonSerializer.SerializeToElement(new { sessionId = session.SessionId });
        await _transport.SendCommandAsync("Target.detachFromTarget", parameters, timeout: timeout, cancellationToken: cancellationToken);
        await session.DisposeAsync();
    }

    private static bool TryGetString(JsonElement element, string name, out string? value)
    {
        value = null;
        return element.ValueKind == JsonValueKind.Object &&
            element.TryGetProperty(name, out JsonElement property) &&
            property.ValueKind == JsonValueKind.String &&
            !string.IsNullOrWhiteSpace(value = property.GetString());
    }
}
