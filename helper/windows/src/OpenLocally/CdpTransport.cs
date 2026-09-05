using System.Buffers;
using System.Collections.Concurrent;
using System.Net.WebSockets;
using System.Text.Json;
using System.Threading.Channels;

namespace OpenLocally;

/// <summary>
/// One raw CDP connection over the run-owned browser socket. It neither connects
/// nor closes that socket; ChromeConnection retains that lifecycle ownership.
/// </summary>
public sealed class CdpTransport : IAsyncDisposable
{
    public const int MaximumMessageBytes = 16 * 1024 * 1024;
    public const int EventQueueCapacity = 64;
    public static readonly TimeSpan DefaultCommandTimeout = TimeSpan.FromSeconds(15);
    public static readonly TimeSpan MaximumCommandTimeout = TimeSpan.FromMinutes(2);
    public static readonly TimeSpan DefaultSocketSendTimeout = TimeSpan.FromSeconds(15);

    private readonly IWebSocketConnection _socket;
    private readonly TimeSpan _socketSendTimeout;
    private readonly SemaphoreSlim _sendLock = new(1, 1);
    private readonly ConcurrentDictionary<long, TaskCompletionSource<JsonElement>> _pending = new();
    private readonly ConcurrentDictionary<long, string> _pendingMethods = new();
    private readonly CancellationTokenSource _lifetime = new();
    private readonly Channel<CdpEvent> _events = Channel.CreateBounded<CdpEvent>(new BoundedChannelOptions(EventQueueCapacity)
    {
        FullMode = BoundedChannelFullMode.Wait,
        SingleReader = true,
        SingleWriter = true,
    });
    private readonly Task _receiveLoop;
    private readonly Task _eventLoop;
    private readonly TaskCompletionSource<Exception> _termination = new(TaskCreationOptions.RunContinuationsAsynchronously);
    private TerminalState? _terminalState;
    private long _nextCommandId;
    private int _disposed;

    public CdpTransport(IWebSocketConnection socket, TimeSpan? socketSendTimeout = null)
    {
        _socket = socket ?? throw new ArgumentNullException(nameof(socket));
        _socketSendTimeout = socketSendTimeout ?? DefaultSocketSendTimeout;
        if (_socketSendTimeout <= TimeSpan.Zero || _socketSendTimeout > MaximumCommandTimeout)
        {
            throw new ArgumentOutOfRangeException(nameof(socketSendTimeout), "The CDP socket send timeout must be positive and bounded.");
        }
        _receiveLoop = Task.Run(ReceiveLoopAsync);
        _eventLoop = Task.Run(EventLoopAsync);
    }

    /// <summary>Receives both browser-level and flattened-session events.</summary>
    public event Func<CdpEvent, Task>? EventReceived;

    /// <summary>Reports isolated consumer failures without exposing CDP payloads.</summary>
    public event Action<CdpEventHandlerException>? EventHandlerFailed;

    /// <summary>Exposes pending-command cleanup to the in-process regression suite.</summary>
    internal int PendingCommandCount => _pending.Count;
    internal Task<Exception> Termination => _termination.Task;
    internal bool IsTerminal => Volatile.Read(ref _terminalState) is not null;
    internal string DiagnosticState => Volatile.Read(ref _terminalState)?.Reason switch
    {
        TerminationReason.LocalDispose => "local_dispose",
        TerminationReason.RemoteClose => "remote_close",
        TerminationReason.ReceiveFailure => "receive_failure",
        TerminationReason.SendFailure => "send_failure",
        TerminationReason.ProtocolFailure => "protocol_failure",
        TerminationReason.InternalFailure => "internal_failure",
        _ => "connected",
    };

    public async Task<JsonElement> SendCommandAsync(
        string method,
        JsonElement? parameters = null,
        string? sessionId = null,
        TimeSpan? timeout = null,
        CancellationToken cancellationToken = default)
    {
        if (string.IsNullOrWhiteSpace(method))
        {
            throw new ArgumentException("A CDP method is required.", nameof(method));
        }

        if (sessionId is not null && string.IsNullOrWhiteSpace(sessionId))
        {
            throw new ArgumentException("A CDP session ID cannot be empty.", nameof(sessionId));
        }

        TimeSpan effectiveTimeout = timeout ?? DefaultCommandTimeout;
        if (effectiveTimeout <= TimeSpan.Zero || effectiveTimeout > MaximumCommandTimeout)
        {
            throw new ArgumentOutOfRangeException(nameof(timeout), "The CDP command timeout must be positive and bounded.");
        }

        using var command = CancellationTokenSource.CreateLinkedTokenSource(_lifetime.Token, cancellationToken);
        command.CancelAfter(effectiveTimeout);
        try
        {
            ThrowIfTerminal();
            long id = NextCommandId();
            var completion = new TaskCompletionSource<JsonElement>(TaskCreationOptions.RunContinuationsAsynchronously);
            if (!_pending.TryAdd(id, completion))
            {
                throw new CdpTransportException(CdpTransportFailure.CommandIdExhausted);
            }
            _pendingMethods.TryAdd(id, method);

            try
            {
                await SendSerializedCommandAsync(id, method, parameters, sessionId, command.Token, cancellationToken);
                return await completion.Task.WaitAsync(command.Token);
            }
            finally
            {
                _pending.TryRemove(id, out _);
                _pendingMethods.TryRemove(id, out _);
            }
        }
        catch (OperationCanceledException) when (command.IsCancellationRequested)
        {
            ThrowIfTerminal();
            if (cancellationToken.IsCancellationRequested)
            {
                throw new OperationCanceledException(cancellationToken);
            }
            throw new TimeoutException("The CDP command timed out.");
        }
    }

    /// <summary>
    /// Stops CDP commands and event delivery while leaving the run-owned socket
    /// receive pending for its owner to complete the graceful close handshake.
    /// </summary>
    internal void StopForGracefulSocketClose()
    {
        if (Volatile.Read(ref _disposed) == 0)
        {
            FailTransport(
                new CdpTransportException(CdpTransportFailure.Disposed),
                TerminationReason.LocalDispose,
                cancelLifetime: false);
        }
    }

    public async ValueTask DisposeAsync()
    {
        if (Interlocked.Exchange(ref _disposed, 1) != 0)
        {
            return;
        }

        FailTransport(new CdpTransportException(CdpTransportFailure.Disposed), TerminationReason.LocalDispose);
        await ObserveLoopAsync(_receiveLoop);
        await ObserveLoopAsync(_eventLoop);
        _sendLock.Dispose();
        _lifetime.Dispose();
    }

    private long NextCommandId()
    {
        long id = Interlocked.Increment(ref _nextCommandId);
        if (id > 0)
        {
            return id;
        }

        var failure = new CdpTransportException(CdpTransportFailure.CommandIdExhausted);
        FailTransport(failure, TerminationReason.InternalFailure);
        throw failure;
    }

    private async Task SendSerializedCommandAsync(
        long id,
        string method,
        JsonElement? parameters,
        string? sessionId,
        CancellationToken commandToken,
        CancellationToken callerToken)
    {
        byte[] payload = SerializeCommand(id, method, parameters, sessionId);
        bool lockAcquired = false;
        try
        {
            await _sendLock.WaitAsync(commandToken);
            lockAcquired = true;
            try
            {
                ThrowIfTerminal();
                commandToken.ThrowIfCancellationRequested();
                using var socketSend = CancellationTokenSource.CreateLinkedTokenSource(_lifetime.Token);
                socketSend.CancelAfter(_socketSendTimeout);
                try
                {
                    await _socket.SendAsync(new ArraySegment<byte>(payload), WebSocketMessageType.Text, true, socketSend.Token);
                }
                catch (OperationCanceledException ex) when (socketSend.IsCancellationRequested && !_lifetime.IsCancellationRequested)
                {
                    var failure = CreateTransportFailure(method, "socket_send", callerToken, commandToken, ex, TerminationReason.SendFailure);
                    throw FailTransport(failure, TerminationReason.SendFailure);
                }
                commandToken.ThrowIfCancellationRequested();
            }
            finally
            {
                if (lockAcquired)
                {
                    _sendLock.Release();
                }
            }
        }
        catch (Exception ex) when (ex is not CdpTransportException)
        {
            if (ex is OperationCanceledException && commandToken.IsCancellationRequested)
            {
                throw;
            }
            var failure = CreateTransportFailure(method, "socket_send", callerToken, commandToken, ex, TerminationReason.SendFailure);
            throw FailTransport(failure, TerminationReason.SendFailure);
        }
    }

    private static byte[] SerializeCommand(long id, string method, JsonElement? parameters, string? sessionId)
    {
        var buffer = new ArrayBufferWriter<byte>();
        using var writer = new Utf8JsonWriter(buffer);
        writer.WriteStartObject();
        writer.WriteNumber("id", id);
        writer.WriteString("method", method);
        if (sessionId is not null)
        {
            writer.WriteString("sessionId", sessionId);
        }
        if (parameters is { } value)
        {
            writer.WritePropertyName("params");
            value.WriteTo(writer);
        }
        writer.WriteEndObject();
        writer.Flush();
        return buffer.WrittenSpan.ToArray();
    }

    private async Task ReceiveLoopAsync()
    {
        byte[] receiveBuffer = ArrayPool<byte>.Shared.Rent(8192);
        try
        {
            while (!_lifetime.IsCancellationRequested)
            {
                using var message = new MemoryStream();
                WebSocketReceiveResult result;
                do
                {
                    result = await _socket.ReceiveAsync(new ArraySegment<byte>(receiveBuffer), _lifetime.Token);
                    if (result.MessageType == WebSocketMessageType.Close)
                    {
                        FailTransport(new CdpTransportException(CdpTransportFailure.Closed), TerminationReason.RemoteClose);
                        return;
                    }
                    if (result.MessageType != WebSocketMessageType.Text)
                    {
                        FailTransport(new CdpTransportException(CdpTransportFailure.UnexpectedBinaryMessage), TerminationReason.ProtocolFailure);
                        return;
                    }
                    if (message.Length + result.Count > MaximumMessageBytes)
                    {
                        FailTransport(new CdpTransportException(CdpTransportFailure.MessageTooLarge), TerminationReason.ProtocolFailure);
                        return;
                    }
                    message.Write(receiveBuffer, 0, result.Count);
                }
                while (!result.EndOfMessage);

                ProcessMessage(message.GetBuffer().AsMemory(0, checked((int)message.Length)));
            }
        }
        catch (OperationCanceledException) when (_lifetime.IsCancellationRequested)
        {
            // Disposal or another terminal path already completed all pending work.
        }
        catch (Exception ex)
        {
            FailTransport(new CdpTransportException(CdpTransportFailure.Disconnected, ex), TerminationReason.ReceiveFailure);
        }
        finally
        {
            ArrayPool<byte>.Shared.Return(receiveBuffer);
        }
    }

    private void ProcessMessage(ReadOnlyMemory<byte> utf8)
    {
        try
        {
            using JsonDocument document = JsonDocument.Parse(utf8);
            JsonElement root = document.RootElement;
            if (root.ValueKind != JsonValueKind.Object)
            {
                throw new JsonException();
            }

            if (root.TryGetProperty("id", out JsonElement idElement))
            {
                if (!idElement.TryGetInt64(out long id))
                {
                    throw new JsonException();
                }
                if (_pending.TryGetValue(id, out TaskCompletionSource<JsonElement>? completion))
                {
                    if (root.TryGetProperty("error", out JsonElement error))
                    {
                        if (!error.TryGetProperty("code", out JsonElement code) || !code.TryGetInt32(out int errorCode) ||
                            !error.TryGetProperty("message", out JsonElement errorMessage) || errorMessage.ValueKind != JsonValueKind.String)
                        {
                            throw new JsonException();
                        }
                        _pendingMethods.TryGetValue(id, out string? operation);
                        completion.TrySetException(new CdpCommandException(errorCode, errorMessage.GetString()!, operation));
                    }
                    else if (root.TryGetProperty("result", out JsonElement result))
                    {
                        completion.TrySetResult(result.Clone());
                    }
                    else
                    {
                        throw new JsonException();
                    }
                }
                return; // Unknown/late response IDs are harmless.
            }

            if (!root.TryGetProperty("method", out JsonElement methodElement) || methodElement.ValueKind != JsonValueKind.String ||
                string.IsNullOrWhiteSpace(methodElement.GetString()))
            {
                throw new JsonException();
            }
            string? sessionId = null;
            if (root.TryGetProperty("sessionId", out JsonElement sessionElement))
            {
                if (sessionElement.ValueKind != JsonValueKind.String || string.IsNullOrWhiteSpace(sessionElement.GetString()))
                {
                    throw new JsonException();
                }
                sessionId = sessionElement.GetString();
            }
            JsonElement? parameters = root.TryGetProperty("params", out JsonElement paramsElement) ? paramsElement.Clone() : null;
            if (!_events.Writer.TryWrite(new CdpEvent(methodElement.GetString()!, sessionId, parameters)))
            {
                FailTransport(new CdpTransportException(CdpTransportFailure.EventQueueOverflow), TerminationReason.ProtocolFailure);
            }
        }
        catch (Exception ex) when (ex is JsonException or InvalidOperationException)
        {
            FailTransport(new CdpTransportException(CdpTransportFailure.MalformedMessage, ex), TerminationReason.ProtocolFailure);
        }
    }

    private async Task EventLoopAsync()
    {
        try
        {
            await foreach (CdpEvent @event in _events.Reader.ReadAllAsync(_lifetime.Token))
            {
                Delegate[] handlers = EventReceived?.GetInvocationList() ?? [];
                foreach (Func<CdpEvent, Task> handler in handlers.Cast<Func<CdpEvent, Task>>())
                {
                    try
                    {
                        await handler(@event);
                    }
                    catch (Exception ex)
                    {
                        try { EventHandlerFailed?.Invoke(new CdpEventHandlerException(ex)); } catch { }
                    }
                }
            }
        }
        catch (OperationCanceledException) when (_lifetime.IsCancellationRequested)
        {
        }
    }

    private void ThrowIfTerminal()
    {
        if (Volatile.Read(ref _terminalState) is { } terminal)
        {
            throw terminal.Exception;
        }
    }

    private CdpTransportException CreateTransportFailure(
        string method,
        string phase,
        CancellationToken callerToken,
        CancellationToken commandToken,
        Exception innerException,
        TerminationReason reason) =>
        new(
            CdpTransportFailure.Disconnected,
            innerException,
            new CdpTransportDiagnostic(
                method,
                phase,
                _socket.State,
                callerToken.IsCancellationRequested,
                commandToken.IsCancellationRequested && !callerToken.IsCancellationRequested && !_lifetime.IsCancellationRequested,
                _lifetime.IsCancellationRequested,
                DiagnosticReason(reason)));

    private Exception FailTransport(Exception exception, TerminationReason reason, bool cancelLifetime = true)
    {
        if (exception is CdpTransportException transportException)
        {
            transportException.AttachDiagnostic(new CdpTransportDiagnostic(
                null,
                null,
                _socket.State,
                false,
                false,
                _lifetime.IsCancellationRequested,
                DiagnosticReason(reason)));
        }
        var terminal = new TerminalState(exception, reason);
        if (Interlocked.CompareExchange(ref _terminalState, terminal, null) is { } existing)
        {
            return existing.Exception;
        }
        _termination.TrySetResult(exception);
        if (cancelLifetime)
        {
            _lifetime.Cancel();
        }
        _events.Writer.TryComplete(exception);
        foreach ((long id, TaskCompletionSource<JsonElement> completion) in _pending)
        {
            if (_pending.TryRemove(id, out _))
            {
                completion.TrySetException(exception);
            }
        }
        return exception;
    }

    private static string DiagnosticReason(TerminationReason reason) => reason switch
    {
        TerminationReason.LocalDispose => "local_dispose",
        TerminationReason.RemoteClose => "remote_close",
        TerminationReason.ReceiveFailure => "receive_failure",
        TerminationReason.SendFailure => "send_failure",
        TerminationReason.ProtocolFailure => "protocol_failure",
        TerminationReason.InternalFailure => "internal_failure",
        _ => "internal_failure",
    };

    private sealed record TerminalState(Exception Exception, TerminationReason Reason);

    private enum TerminationReason
    {
        LocalDispose,
        RemoteClose,
        ReceiveFailure,
        SendFailure,
        ProtocolFailure,
        InternalFailure,
    }

    private static async Task ObserveLoopAsync(Task task)
    {
        try { await task; } catch { }
    }
}
