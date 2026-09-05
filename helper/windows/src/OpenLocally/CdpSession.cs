using System.Text.Json;

namespace OpenLocally;

/// <summary>A flattened target session sharing a parent CdpTransport.</summary>
public sealed class CdpSession : IAsyncDisposable
{
    private readonly CdpTransport _transport;
    private int _disposed;

    internal CdpSession(CdpTransport transport, string sessionId)
    {
        _transport = transport;
        SessionId = string.IsNullOrWhiteSpace(sessionId)
            ? throw new ArgumentException("A CDP session ID is required.", nameof(sessionId))
            : sessionId;
        _transport.EventReceived += HandleEventAsync;
    }

    public string SessionId { get; }

    internal Task<Exception> TransportTermination => _transport.Termination;

    public event Func<CdpEvent, Task>? EventReceived;

    public Task<JsonElement> SendCommandAsync(
        string method,
        JsonElement? parameters = null,
        TimeSpan? timeout = null,
        CancellationToken cancellationToken = default)
    {
        ObjectDisposedException.ThrowIf(Volatile.Read(ref _disposed) != 0, this);
        return _transport.SendCommandAsync(method, parameters, SessionId, timeout, cancellationToken);
    }

    public ValueTask DisposeAsync()
    {
        if (Interlocked.Exchange(ref _disposed, 1) == 0)
        {
            _transport.EventReceived -= HandleEventAsync;
        }
        return ValueTask.CompletedTask;
    }

    private async Task HandleEventAsync(CdpEvent @event)
    {
        if (!string.Equals(@event.SessionId, SessionId, StringComparison.Ordinal))
        {
            return;
        }
        Delegate[] handlers = EventReceived?.GetInvocationList() ?? [];
        foreach (Func<CdpEvent, Task> handler in handlers.Cast<Func<CdpEvent, Task>>())
        {
            await handler(@event);
        }
    }
}
