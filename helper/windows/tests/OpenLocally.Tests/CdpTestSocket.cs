using System.Collections.Concurrent;
using System.Net.WebSockets;
using System.Text;
using System.Threading.Channels;
using OpenLocally;

namespace OpenLocally.Tests;

internal sealed class CdpTestSocket : IWebSocketConnection
{
    private readonly Channel<ReceiveStep> _receives = Channel.CreateUnbounded<ReceiveStep>();
    private ReceiveStep? _active;
    private int _offset;
    private int _activeSends;
    private int _sendCancellations;
    private int _receiveCancellations;
    private readonly TaskCompletionSource _receiveStarted = new(TaskCreationOptions.RunContinuationsAsynchronously);

    public ConcurrentQueue<string> Sent { get; } = new();
    public Func<string, Task>? OnSendAsync { get; set; }
    public Func<string, CancellationToken, Task>? OnSendWithCancellationAsync { get; set; }
    public Func<CancellationToken, Task>? OnCloseAsync { get; set; }
    public int MaximumConcurrentSends { get; private set; }
    public int SendCancellations => Volatile.Read(ref _sendCancellations);
    public int ReceiveCancellations => Volatile.Read(ref _receiveCancellations);
    public int CloseCalls { get; private set; }
    public Task ReceiveStarted => _receiveStarted.Task;
    public int DisposeCalls { get; private set; }
    public int ConnectCalls { get; private set; }
    public WebSocketState State { get; private set; } = WebSocketState.Open;

    public void EnqueueJson(string json, params int[] fragmentLengths)
    {
        byte[] bytes = Encoding.UTF8.GetBytes(json);
        if (fragmentLengths.Length == 0)
        {
            fragmentLengths = [bytes.Length];
        }
        int offset = 0;
        foreach (int length in fragmentLengths)
        {
            _receives.Writer.TryWrite(new ReceiveStep(bytes.AsMemory(offset, length).ToArray(), WebSocketMessageType.Text, offset + length == bytes.Length));
            offset += length;
        }
    }

    public void EnqueueClose() => _receives.Writer.TryWrite(new ReceiveStep([], WebSocketMessageType.Close, true));

    public void EnqueueFailure(Exception exception) => _receives.Writer.TryWrite(new ReceiveStep(exception));

    public Task ConnectAsync(Uri endpoint, CancellationToken cancellationToken)
    {
        ConnectCalls++;
        return Task.CompletedTask;
    }
    public async Task CloseAsync(CancellationToken cancellationToken)
    {
        CloseCalls++;
        if (OnCloseAsync is not null)
        {
            await OnCloseAsync(cancellationToken);
        }
        State = WebSocketState.Closed;
    }

    public async Task SendAsync(ArraySegment<byte> buffer, WebSocketMessageType messageType, bool endOfMessage, CancellationToken cancellationToken)
    {
        int concurrent = Interlocked.Increment(ref _activeSends);
        MaximumConcurrentSends = Math.Max(MaximumConcurrentSends, concurrent);
        try
        {
            string message = Encoding.UTF8.GetString(buffer.Array!, buffer.Offset, buffer.Count);
            Sent.Enqueue(message);
            if (OnSendAsync is not null)
            {
                await OnSendAsync(message);
            }
            if (OnSendWithCancellationAsync is not null)
            {
                try
                {
                    await OnSendWithCancellationAsync(message, cancellationToken);
                }
                catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
                {
                    Interlocked.Increment(ref _sendCancellations);
                    throw;
                }
            }
        }
        finally
        {
            Interlocked.Decrement(ref _activeSends);
        }
    }

    public async Task<WebSocketReceiveResult> ReceiveAsync(ArraySegment<byte> buffer, CancellationToken cancellationToken)
    {
        _receiveStarted.TrySetResult();
        try
        {
            _active ??= await _receives.Reader.ReadAsync(cancellationToken);
        }
        catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
        {
            Interlocked.Increment(ref _receiveCancellations);
            throw;
        }
        if (_active.Exception is not null)
        {
            throw _active.Exception;
        }
        _active.Bytes.AsSpan().CopyTo(buffer.AsSpan());
        int count = _active.Bytes.Length;
        bool end = _active.EndOfMessage;
        WebSocketMessageType type = _active.MessageType;
        _active = null;
        return new WebSocketReceiveResult(count, type, end);
        }

    public ValueTask DisposeAsync()
    {
        DisposeCalls++;
        return ValueTask.CompletedTask;
    }

    private sealed record ReceiveStep(byte[] Bytes, WebSocketMessageType MessageType, bool EndOfMessage, Exception? Exception = null)
    {
        public ReceiveStep(Exception exception) : this([], WebSocketMessageType.Text, true, exception) { }
    }
}
