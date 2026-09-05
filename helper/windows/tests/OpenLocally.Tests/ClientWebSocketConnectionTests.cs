using System.Net;
using System.Net.Sockets;
using System.Net.WebSockets;
using System.Security.Cryptography;
using System.Text;
using OpenLocally;

namespace OpenLocally.Tests;

public sealed class ClientWebSocketConnectionTests
{
    [Fact]
    public async Task Close_PeerResponds_CompletesGracefullyWithPeerStatus()
    {
        await using var peer = new LoopbackWebSocketPeer(PeerBehavior.RespondToClose);
        var socket = new ClientWebSocketConnection();
        await socket.ConnectAsync(peer.Endpoint, CancellationToken.None);

        await socket.CloseAsync(new CancellationTokenSource(TimeSpan.FromSeconds(2)).Token);
        await socket.DisposeAsync();
        await peer.Completion.WaitAsync(TimeSpan.FromSeconds(2));

        WebSocketCloseOutcome outcome = Assert.IsType<WebSocketCloseOutcome>(socket.CloseOutcome);
        Assert.True(peer.ClientCloseObserved);
        Assert.Equal(WebSocketCloseStatus.NormalClosure, peer.ClientCloseStatus);
        Assert.Equal(WebSocketCloseOutcomeKind.GracefulClosed, outcome.Kind);
        Assert.True(outcome.CloseAsyncCompletedNormally);
        Assert.Equal(WebSocketState.Closed, outcome.FinalState);
        Assert.Equal(WebSocketCloseStatus.NormalClosure, outcome.PeerCloseStatus);
        Assert.True(outcome.PeerCloseDescriptionPresent);
        Assert.Equal(WebSocketCloseFallbackReason.None, outcome.FallbackReason);
        Assert.False(outcome.AbortCalled);
        Assert.True(outcome.DisposeCalled);
    }

    [Fact]
    public async Task Close_PeerDoesNotRespond_CleanupTimeoutIsRecordedAndAborted()
    {
        await using var peer = new LoopbackWebSocketPeer(PeerBehavior.IgnoreClose);
        var socket = new ClientWebSocketConnection();
        var connection = new ChromeConnection(() => socket, TimeSpan.FromSeconds(1), TimeSpan.FromMilliseconds(50));
        Assert.True((await connection.ConnectAsync(new ChromeEndpoint(peer.Endpoint), CancellationToken.None)).Success);

        await connection.DisposeAsync();

        WebSocketCloseOutcome outcome = Assert.IsType<WebSocketCloseOutcome>(connection.CloseOutcome);
        Assert.True(peer.ClientCloseObserved);
        Assert.Equal(WebSocketCloseOutcomeKind.TimedOutAndAborted, outcome.Kind);
        Assert.False(outcome.CloseAsyncCompletedNormally);
        Assert.Equal(WebSocketCloseFallbackReason.Timeout, outcome.FallbackReason);
        Assert.Equal(WebSocketState.Aborted, outcome.FinalState);
        Assert.True(outcome.AbortCalled);
        Assert.True(outcome.DisposeCalled);
    }

    [Fact]
    public async Task Close_CleanupTokenAlreadyCancelled_IsRecordedAndAborted()
    {
        await using var peer = new LoopbackWebSocketPeer(PeerBehavior.IgnoreClose);
        var socket = new ClientWebSocketConnection();
        await socket.ConnectAsync(peer.Endpoint, CancellationToken.None);
        using var cancellation = new CancellationTokenSource();
        cancellation.Cancel();

        await socket.CloseAsync(cancellation.Token);
        await socket.DisposeAsync();

        WebSocketCloseOutcome outcome = Assert.IsType<WebSocketCloseOutcome>(socket.CloseOutcome);
        Assert.Equal(WebSocketCloseOutcomeKind.CancelledAndAborted, outcome.Kind);
        Assert.False(outcome.CloseAsyncCompletedNormally);
        Assert.Equal(WebSocketCloseFallbackReason.Cancellation, outcome.FallbackReason);
        Assert.Equal(WebSocketState.Aborted, outcome.FinalState);
        Assert.True(outcome.AbortCalled);
        Assert.True(outcome.DisposeCalled);
    }

    [Fact]
    public async Task Close_PeerResetsConnection_IsRecordedAsWebSocketFailureAndAborted()
    {
        await using var peer = new LoopbackWebSocketPeer(PeerBehavior.ResetAfterHandshake);
        var socket = new ClientWebSocketConnection();
        await socket.ConnectAsync(peer.Endpoint, CancellationToken.None);
        await peer.ResetCompleted.WaitAsync(TimeSpan.FromSeconds(2));

        await socket.CloseAsync(new CancellationTokenSource(TimeSpan.FromSeconds(2)).Token);
        await socket.DisposeAsync();

        WebSocketCloseOutcome outcome = Assert.IsType<WebSocketCloseOutcome>(socket.CloseOutcome);
        Assert.Equal(WebSocketCloseOutcomeKind.FailedAndAborted, outcome.Kind);
        Assert.False(outcome.CloseAsyncCompletedNormally);
        Assert.Equal(WebSocketCloseFallbackReason.WebSocketException, outcome.FallbackReason);
        Assert.Equal(WebSocketState.Aborted, outcome.FinalState);
        Assert.True(outcome.AbortCalled);
        Assert.True(outcome.DisposeCalled);
    }

    private enum PeerBehavior
    {
        RespondToClose,
        IgnoreClose,
        ResetAfterHandshake,
    }

    private sealed class LoopbackWebSocketPeer : IAsyncDisposable
    {
        private readonly TcpListener _listener = new(IPAddress.Loopback, 0);
        private readonly CancellationTokenSource _lifetime = new();
        private readonly PeerBehavior _behavior;
        private readonly Task _run;
        private readonly TaskCompletionSource _resetCompleted = new(TaskCreationOptions.RunContinuationsAsynchronously);

        public LoopbackWebSocketPeer(PeerBehavior behavior)
        {
            _behavior = behavior;
            _listener.Start();
            int port = ((IPEndPoint)_listener.LocalEndpoint).Port;
            Endpoint = new Uri($"ws://127.0.0.1:{port}/close-test");
            _run = RunAsync();
        }

        public Uri Endpoint { get; }
        public bool ClientCloseObserved { get; private set; }
        public WebSocketCloseStatus? ClientCloseStatus { get; private set; }
        public Task Completion => _run;
        public Task ResetCompleted => _resetCompleted.Task;

        public async ValueTask DisposeAsync()
        {
            _lifetime.Cancel();
            _listener.Stop();
            try { await _run; } catch (OperationCanceledException) when (_lifetime.IsCancellationRequested) { }
            _lifetime.Dispose();
        }

        private async Task RunAsync()
        {
            using TcpClient client = await _listener.AcceptTcpClientAsync(_lifetime.Token);
            _listener.Stop();
            NetworkStream stream = client.GetStream();
            string request = await ReadHandshakeAsync(stream, _lifetime.Token);
            string key = request.Split("\r\n", StringSplitOptions.RemoveEmptyEntries)
                .Single(line => line.StartsWith("Sec-WebSocket-Key:", StringComparison.OrdinalIgnoreCase))
                .Split(':', 2)[1].Trim();
            string accept = Convert.ToBase64String(SHA1.HashData(Encoding.ASCII.GetBytes(
                key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11")));
            byte[] response = Encoding.ASCII.GetBytes(
                "HTTP/1.1 101 Switching Protocols\r\n" +
                "Upgrade: websocket\r\n" +
                "Connection: Upgrade\r\n" +
                $"Sec-WebSocket-Accept: {accept}\r\n\r\n");
            await stream.WriteAsync(response, _lifetime.Token);
            await stream.FlushAsync(_lifetime.Token);

            if (_behavior == PeerBehavior.ResetAfterHandshake)
            {
                client.Client.LingerState = new LingerOption(true, 0);
                client.Close();
                _resetCompleted.TrySetResult();
                return;
            }

            using WebSocket server = WebSocket.CreateFromStream(
                stream,
                isServer: true,
                subProtocol: null,
                keepAliveInterval: Timeout.InfiniteTimeSpan);
            var buffer = new byte[128];
            WebSocketReceiveResult received;
            try
            {
                received = await server.ReceiveAsync(buffer, _lifetime.Token);
            }
            catch (WebSocketException) when (_behavior == PeerBehavior.IgnoreClose)
            {
                return;
            }
            ClientCloseObserved = received.MessageType == WebSocketMessageType.Close;
            ClientCloseStatus = received.CloseStatus;
            if (_behavior == PeerBehavior.RespondToClose)
            {
                await server.CloseOutputAsync(
                    WebSocketCloseStatus.NormalClosure,
                    "peer accepted",
                    _lifetime.Token);
                return;
            }

            await Task.Delay(Timeout.InfiniteTimeSpan, _lifetime.Token);
        }

        private static async Task<string> ReadHandshakeAsync(NetworkStream stream, CancellationToken cancellationToken)
        {
            var bytes = new List<byte>();
            var one = new byte[1];
            while (bytes.Count < 16 * 1024)
            {
                int read = await stream.ReadAsync(one, cancellationToken);
                if (read == 0) throw new IOException("WebSocket handshake ended prematurely.");
                bytes.Add(one[0]);
                int count = bytes.Count;
                if (count >= 4 && bytes[count - 4] == '\r' && bytes[count - 3] == '\n' &&
                    bytes[count - 2] == '\r' && bytes[count - 1] == '\n')
                {
                    return Encoding.ASCII.GetString(bytes.ToArray());
                }
            }
            throw new IOException("WebSocket handshake exceeded the test bound.");
        }
    }
}
