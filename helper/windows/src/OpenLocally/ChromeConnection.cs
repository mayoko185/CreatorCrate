namespace OpenLocally;

public sealed record ChromeConnectionResult(bool Success, string? ErrorCode)
{
    public static ChromeConnectionResult Ok() => new(true, null);

    public static ChromeConnectionResult Fail(string errorCode) => new(false, errorCode);
}

/// <summary>
/// Run-level owner for one approved browser socket. Later CDP work can use the
/// established socket, but it must not create another one or reconnect it.
/// </summary>
public sealed class ChromeConnection : IAsyncDisposable
{
    public static readonly TimeSpan DefaultApprovalTimeout = TimeSpan.FromMinutes(5);
    public static readonly TimeSpan DefaultCleanupTimeout = TimeSpan.FromSeconds(5);

    private readonly Func<IWebSocketConnection> _createConnection;
    private readonly TimeSpan _approvalTimeout;
    private readonly TimeSpan _cleanupTimeout;
    private IWebSocketConnection? _socket;
    private WebSocketCloseOutcome? _closeOutcome;
    private int _attemptActive;
    private int _disposed;

    public ChromeConnection()
        : this(() => new ClientWebSocketConnection(), DefaultApprovalTimeout, DefaultCleanupTimeout)
    {
    }

    internal ChromeConnection(
        Func<IWebSocketConnection> createConnection,
        TimeSpan approvalTimeout,
        TimeSpan? cleanupTimeout = null)
    {
        _createConnection = createConnection;
        _approvalTimeout = approvalTimeout;
        _cleanupTimeout = cleanupTimeout ?? DefaultCleanupTimeout;
        if (_cleanupTimeout <= TimeSpan.Zero || _cleanupTimeout > DefaultApprovalTimeout)
        {
            throw new ArgumentOutOfRangeException(nameof(cleanupTimeout), "The Chrome cleanup timeout must be short and positive.");
        }
    }

    internal IWebSocketConnection? Socket => _socket;
    internal WebSocketCloseOutcome? CloseOutcome => Volatile.Read(ref _closeOutcome);

    public Task<ChromeConnectionResult> ConnectAsync(
        ChromeEndpoint endpoint,
        CancellationToken cancellationToken) => ConnectAsync(endpoint, cancellationToken, null);

    internal async Task<ChromeConnectionResult> ConnectAsync(
        ChromeEndpoint endpoint, CancellationToken cancellationToken, ManualPreparationEvidence? evidence)
    {
        if (evidence is not null) evidence.ConnectionSetup = ManualBoundaryState.entered;
        try
        {
            ChromeConnectionResult result = await ConnectCoreAsync(endpoint, cancellationToken, evidence).ConfigureAwait(false);
            evidence?.ObserveConnection(result);
            return result;
        }
        catch
        {
            if (evidence?.ConnectionSetup == ManualBoundaryState.entered) evidence.ConnectionSetup = ManualBoundaryState.failed;
            if (evidence?.Connection == ManualBoundaryState.entered) evidence.Connection = ManualBoundaryState.failed;
            throw;
        }
    }

    private async Task<ChromeConnectionResult> ConnectCoreAsync(
        ChromeEndpoint endpoint, CancellationToken cancellationToken, ManualPreparationEvidence? evidence)
    {
        ObjectDisposedException.ThrowIf(Volatile.Read(ref _disposed) != 0, this);
        if (Interlocked.CompareExchange(ref _attemptActive, 1, 0) != 0)
        {
            throw new InvalidOperationException("A Chrome connection attempt is already active.");
        }

        try
        {
            if (_socket is not null)
            {
                throw new InvalidOperationException("The approved Chrome connection may not be replaced.");
            }

            IWebSocketConnection socket = _createConnection();
            _socket = socket;
            using var timeout = new CancellationTokenSource(_approvalTimeout);
            using var linked = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken, timeout.Token);

            if (evidence is not null) evidence.ConnectionSetup = ManualBoundaryState.completed;

            try
            {
                if (evidence is not null) evidence.Connection = ManualBoundaryState.entered;
                await socket.ConnectAsync(endpoint.Uri, linked.Token);
                if (evidence is not null) evidence.Connection = ManualBoundaryState.completed;
                return ChromeConnectionResult.Ok();
            }
            catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
            {
                evidence?.ObserveConnection(ChromeConnectionResult.Fail("chrome_connection_cancelled"));
                await DisposeFailedSocketAsync(socket);
                return ChromeConnectionResult.Fail("chrome_connection_cancelled");
            }
            catch (OperationCanceledException) when (timeout.IsCancellationRequested)
            {
                evidence?.ObserveConnection(ChromeConnectionResult.Fail("chrome_approval_timeout"));
                await DisposeFailedSocketAsync(socket);
                return ChromeConnectionResult.Fail("chrome_approval_timeout");
            }
            catch (WebSocketConnectionException ex)
            {
                ChromeConnectionResult result = ChromeConnectionResult.Fail(ex.Failure switch
                {
                    WebSocketConnectionFailure.ConnectionRefused => "chrome_connection_refused",
                    WebSocketConnectionFailure.ApprovalDenied => "chrome_approval_denied",
                    _ => "chrome_handshake_failed",
                });
                evidence?.ObserveConnection(result);
                await DisposeFailedSocketAsync(socket);
                return result;
            }
            catch (Exception)
            {
                evidence?.ObserveConnection(ChromeConnectionResult.Fail("chrome_handshake_failed"));
                await DisposeFailedSocketAsync(socket);
                return ChromeConnectionResult.Fail("chrome_handshake_failed");
            }
        }
        finally
        {
            Volatile.Write(ref _attemptActive, 0);
        }
    }

    public async ValueTask DisposeAsync()
    {
        if (Interlocked.Exchange(ref _disposed, 1) != 0)
        {
            return;
        }

        if (_socket is not null)
        {
            await DisposeSocketAsync(_socket);
        }
    }

    private async Task DisposeFailedSocketAsync(IWebSocketConnection socket)
    {
        await DisposeSocketAsync(socket);
        if (ReferenceEquals(_socket, socket))
        {
            _socket = null;
        }
    }

    private async Task DisposeSocketAsync(IWebSocketConnection socket)
    {
        using var closeTimeout = new CancellationTokenSource(_cleanupTimeout);
        try
        {
            await socket.CloseAsync(closeTimeout.Token);
        }
        catch (Exception ex) when (ex is OperationCanceledException or WebSocketConnectionException)
        {
            // The socket still must be disposed after a bounded graceful-close failure.
        }
        finally
        {
            await socket.DisposeAsync();
            if (socket is ClientWebSocketConnection clientSocket && clientSocket.CloseOutcome is { } outcome)
            {
                if (closeTimeout.IsCancellationRequested &&
                    outcome.FallbackReason == WebSocketCloseFallbackReason.Cancellation)
                {
                    outcome = outcome with
                    {
                        Kind = WebSocketCloseOutcomeKind.TimedOutAndAborted,
                        FallbackReason = WebSocketCloseFallbackReason.Timeout,
                    };
                }
                else if (outcome.FallbackReason == WebSocketCloseFallbackReason.Cancellation)
                {
                    outcome = outcome with { Kind = WebSocketCloseOutcomeKind.CancelledAndAborted };
                }
                Volatile.Write(ref _closeOutcome, outcome);
            }
        }
    }
}
