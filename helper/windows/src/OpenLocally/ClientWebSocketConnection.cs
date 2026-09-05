using System.Diagnostics;
using System.Net.Sockets;
using System.Net.WebSockets;

namespace OpenLocally;

/// <summary>
/// BCL implementation for exactly one browser WebSocket handshake. It does not
/// retry or create replacement sockets after a failure or cancellation.
/// </summary>
public sealed class ClientWebSocketConnection : IWebSocketConnection
{
    private readonly ClientWebSocket _socket = new();
    private WebSocketCloseOutcome? _closeOutcome;
    private int _connectAttempted;
    private int _disposed;

    public WebSocketState State => _socket.State;

    internal WebSocketCloseOutcome? CloseOutcome => Volatile.Read(ref _closeOutcome);

    public async Task ConnectAsync(Uri endpoint, CancellationToken cancellationToken)
    {
        ObjectDisposedException.ThrowIf(Volatile.Read(ref _disposed) != 0, this);
        if (Interlocked.Exchange(ref _connectAttempted, 1) != 0)
        {
            throw new InvalidOperationException("A browser WebSocket connection may be attempted only once.");
        }

        try
        {
            await _socket.ConnectAsync(endpoint, cancellationToken);
        }
        catch (OperationCanceledException)
        {
            throw;
        }
        catch (Exception ex) when (ex is WebSocketException or SocketException)
        {
            throw new WebSocketConnectionException(
                IsConnectionRefused(ex)
                    ? WebSocketConnectionFailure.ConnectionRefused
                    : WebSocketConnectionFailure.HandshakeFailed,
                ex);
        }
    }

    public async Task CloseAsync(CancellationToken cancellationToken)
    {
        if (Volatile.Read(ref _disposed) != 0)
        {
            return;
        }

        WebSocketState stateBefore = _socket.State;
        if (stateBefore is not (WebSocketState.Open or WebSocketState.CloseReceived))
        {
            SetCloseOutcome(new WebSocketCloseOutcome(
                WebSocketCloseOutcomeKind.NotAttempted,
                stateBefore,
                GracefulCloseAttempted: false,
                CloseAsyncCompletedNormally: false,
                TimeSpan.Zero,
                _socket.State,
                _socket.CloseStatus,
                !string.IsNullOrEmpty(_socket.CloseStatusDescription),
                WebSocketCloseFallbackReason.None,
                AbortCalled: false,
                DisposeCalled: false));
            return;
        }

        var stopwatch = Stopwatch.StartNew();
        try
        {
            await _socket.CloseAsync(
                WebSocketCloseStatus.NormalClosure,
                "CreatorCrate preparation complete",
                cancellationToken);
            stopwatch.Stop();
            SetCloseOutcome(CreateOutcome(
                WebSocketCloseOutcomeKind.GracefulClosed,
                stateBefore,
                completedNormally: true,
                stopwatch.Elapsed,
                WebSocketCloseFallbackReason.None,
                abortCalled: false));
        }
        catch (Exception ex)
        {
            stopwatch.Stop();
            WebSocketCloseFallbackReason fallbackReason = ex switch
            {
                OperationCanceledException => WebSocketCloseFallbackReason.Cancellation,
                WebSocketException => WebSocketCloseFallbackReason.WebSocketException,
                _ => WebSocketCloseFallbackReason.Other,
            };
            _socket.Abort();
            SetCloseOutcome(CreateOutcome(
                fallbackReason == WebSocketCloseFallbackReason.Cancellation
                    ? WebSocketCloseOutcomeKind.CancelledAndAborted
                    : WebSocketCloseOutcomeKind.FailedAndAborted,
                stateBefore,
                completedNormally: false,
                stopwatch.Elapsed,
                fallbackReason,
                abortCalled: true));
        }
    }

    public Task SendAsync(ArraySegment<byte> buffer, WebSocketMessageType messageType, bool endOfMessage, CancellationToken cancellationToken)
    {
        ObjectDisposedException.ThrowIf(Volatile.Read(ref _disposed) != 0, this);
        return _socket.SendAsync(buffer, messageType, endOfMessage, cancellationToken);
    }

    public Task<WebSocketReceiveResult> ReceiveAsync(ArraySegment<byte> buffer, CancellationToken cancellationToken)
    {
        ObjectDisposedException.ThrowIf(Volatile.Read(ref _disposed) != 0, this);
        return _socket.ReceiveAsync(buffer, cancellationToken);
    }

    public ValueTask DisposeAsync()
    {
        if (Interlocked.Exchange(ref _disposed, 1) == 0)
        {
            _socket.Dispose();
            WebSocketCloseOutcome outcome = CloseOutcome ?? new WebSocketCloseOutcome(
                WebSocketCloseOutcomeKind.NotAttempted,
                _socket.State,
                GracefulCloseAttempted: false,
                CloseAsyncCompletedNormally: false,
                TimeSpan.Zero,
                _socket.State,
                _socket.CloseStatus,
                !string.IsNullOrEmpty(_socket.CloseStatusDescription),
                WebSocketCloseFallbackReason.None,
                AbortCalled: false,
                DisposeCalled: false);
            SetCloseOutcome(outcome with
            {
                FinalState = _socket.State,
                DisposeCalled = true,
            });
        }

        return ValueTask.CompletedTask;
    }

    private static bool IsConnectionRefused(Exception exception) =>
        exception is SocketException { SocketErrorCode: SocketError.ConnectionRefused } ||
        exception.InnerException is not null && IsConnectionRefused(exception.InnerException);

    private WebSocketCloseOutcome CreateOutcome(
        WebSocketCloseOutcomeKind kind,
        WebSocketState stateBefore,
        bool completedNormally,
        TimeSpan elapsed,
        WebSocketCloseFallbackReason fallbackReason,
        bool abortCalled) =>
        new(
            kind,
            stateBefore,
            GracefulCloseAttempted: true,
            completedNormally,
            elapsed,
            _socket.State,
            _socket.CloseStatus,
            !string.IsNullOrEmpty(_socket.CloseStatusDescription),
            fallbackReason,
            abortCalled,
            DisposeCalled: false);

    private void SetCloseOutcome(WebSocketCloseOutcome outcome) =>
        Volatile.Write(ref _closeOutcome, outcome);
}

internal enum WebSocketCloseOutcomeKind
{
    NotAttempted,
    GracefulClosed,
    TimedOutAndAborted,
    CancelledAndAborted,
    FailedAndAborted,
}

internal enum WebSocketCloseFallbackReason
{
    None,
    Timeout,
    Cancellation,
    WebSocketException,
    Other,
}

internal sealed record WebSocketCloseOutcome(
    WebSocketCloseOutcomeKind Kind,
    WebSocketState StateBefore,
    bool GracefulCloseAttempted,
    bool CloseAsyncCompletedNormally,
    TimeSpan Elapsed,
    WebSocketState FinalState,
    WebSocketCloseStatus? PeerCloseStatus,
    bool PeerCloseDescriptionPresent,
    WebSocketCloseFallbackReason FallbackReason,
    bool AbortCalled,
    bool DisposeCalled);
