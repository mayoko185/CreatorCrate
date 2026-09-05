namespace OpenLocally;

/// <summary>
/// Lifecycle-only browser socket seam. CDP framing, commands, and sessions are
/// intentionally outside this foundation. A single ChromeConnection owns one
/// implementation instance for one helper preparation run.
/// </summary>
public interface IWebSocketConnection : IAsyncDisposable
{
    System.Net.WebSockets.WebSocketState State { get; }

    Task ConnectAsync(Uri endpoint, CancellationToken cancellationToken);

    Task SendAsync(ArraySegment<byte> buffer, System.Net.WebSockets.WebSocketMessageType messageType, bool endOfMessage, CancellationToken cancellationToken);

    Task<System.Net.WebSockets.WebSocketReceiveResult> ReceiveAsync(ArraySegment<byte> buffer, CancellationToken cancellationToken);

    Task CloseAsync(CancellationToken cancellationToken);
}

public enum WebSocketConnectionFailure
{
    ConnectionRefused,
    ApprovalDenied,
    HandshakeFailed,
}

public sealed class WebSocketConnectionException : Exception
{
    public WebSocketConnectionException(WebSocketConnectionFailure failure, Exception? innerException = null)
        : base(failure.ToString(), innerException)
    {
        Failure = failure;
    }

    public WebSocketConnectionFailure Failure { get; }
}
