using System.Net;
using System.Net.Sockets;
using System.Text;
using System.Text.Json;

namespace OpenLocally.Tests.Manual;

/// <summary>Opt-in loopback-only CreatorCrate contract fixture; it records only fixed harmless test data.</summary>
internal sealed class ManualCreatorCrateFixture : IAsyncDisposable
{
    internal const string SessionId = "00000000-0000-0000-0000-000000000001";
    internal const string MediaToken = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    private readonly TcpListener _listener;
    private readonly CancellationTokenSource _lifetime = new();
    private readonly Task _serveTask;
    private int _requests;
    private int _mediaRequests;
    private int _lastMediaResponseStatus;

    private ManualCreatorCrateFixture(TcpListener listener)
    {
        _listener = listener;
        _serveTask = ServeAsync();
    }

    public Uri Origin => new($"http://127.0.0.1:{((IPEndPoint)_listener.LocalEndpoint).Port}/");
    public int RequestCount => Volatile.Read(ref _requests);
    public int MediaRequestCount => Volatile.Read(ref _mediaRequests);
    public int LastMediaResponseStatus => Volatile.Read(ref _lastMediaResponseStatus);
    public List<ManualFixtureRequest> Requests { get; } = [];
    public byte[] MediaBytes { get; init; } = Encoding.UTF8.GetBytes("creatorcrate-manual-media");

    public static Task<ManualCreatorCrateFixture> StartAsync()
    {
        ManualFoundationGuard.RequireOptIn();
        var listener = new TcpListener(IPAddress.Loopback, 0);
        listener.Start();
        return Task.FromResult(new ManualCreatorCrateFixture(listener));
    }

    public async ValueTask DisposeAsync()
    {
        _lifetime.Cancel();
        _listener.Stop();
        try { await _serveTask.ConfigureAwait(false); } catch (OperationCanceledException) { }
        _lifetime.Dispose();
    }

    private async Task ServeAsync()
    {
        try
        {
            while (!_lifetime.IsCancellationRequested)
            {
                TcpClient client = await _listener.AcceptTcpClientAsync(_lifetime.Token).ConfigureAwait(false);
                _ = HandleAsync(client);
            }
        }
        catch (OperationCanceledException) when (_lifetime.IsCancellationRequested) { }
        catch (ObjectDisposedException) when (_lifetime.IsCancellationRequested) { }
    }

    private async Task HandleAsync(TcpClient client)
    {
        using (client)
        await using (NetworkStream stream = client.GetStream())
        {
            try
            {
                ManualFixtureHttpRequest? request = await ReadRequestAsync(stream, _lifetime.Token).ConfigureAwait(false);
                if (request is null) return;
                bool hasBearer = request.Headers.TryGetValue("Authorization", out string? authorization) && authorization == $"Bearer {MediaToken}";
                bool tokenInUrl = request.PathAndQuery.Contains(MediaToken, StringComparison.Ordinal);
                var recorded = new ManualFixtureRequest(request.Method, request.PathAndQuery, hasBearer, tokenInUrl, request.Body);
                lock (Requests) Requests.Add(recorded);
                Interlocked.Increment(ref _requests);
                int responseStatus = await WriteResponseAsync(stream, recorded, _lifetime.Token).ConfigureAwait(false);
                if (recorded.HasBearerAuthorization && recorded.Method == "GET" && recorded.PathAndQuery.StartsWith($"/social-prep/{SessionId}/assets/", StringComparison.Ordinal))
                {
                    Interlocked.Increment(ref _mediaRequests);
                    Interlocked.Exchange(ref _lastMediaResponseStatus, responseStatus);
                }
            }
            catch (OperationCanceledException) when (_lifetime.IsCancellationRequested) { }
            catch (IOException) { }
        }
    }

    private async Task<int> WriteResponseAsync(NetworkStream stream, ManualFixtureRequest request, CancellationToken cancellationToken)
    {
        int status = 200;
        byte[] body;
        string contentType;
        if (request.TokenInUrl)
        {
            status = 400;
            body = Error("validation_failed");
            contentType = "application/json";
        }
        else if (request.Method == "POST" && request.PathAndQuery == "/social-prep/redeem" && request.IsRedeemIntentBody)
        {
            body = Encoding.UTF8.GetBytes($"{{\"ok\":true,\"sessionId\":\"{SessionId}\",\"attemptDeadlineAt\":\"2099-01-01 00:00:00\",\"platforms\":[],\"mediaToken\":\"{MediaToken}\"}}");
            contentType = "application/json";
        }
        else if (request.HasBearerAuthorization && request.Method == "GET" && request.PathAndQuery == $"/social-prep/{SessionId}/status")
        {
            body = Encoding.UTF8.GetBytes($"{{\"ok\":true,\"sessionId\":\"{SessionId}\",\"state\":\"redeemed\",\"attemptDeadlineAt\":\"2099-01-01 00:00:00\",\"platforms\":[]}}");
            contentType = "application/json";
        }
        else if (request.HasBearerAuthorization && request.Method == "PATCH" && request.PathAndQuery == $"/social-prep/{SessionId}/platforms/patreon")
        {
            body = Encoding.UTF8.GetBytes($"{{\"ok\":true,\"sessionId\":\"{SessionId}\",\"platform\":{{\"platform\":\"patreon\",\"status\":\"prepared\",\"detailCode\":null,\"attempts\":0,\"preparedAt\":null}}}}");
            contentType = "application/json";
        }
        else if (request.HasBearerAuthorization && request.Method == "GET" &&
            (request.PathAndQuery == $"/social-prep/{SessionId}/assets/1" || request.PathAndQuery == $"/social-prep/{SessionId}/assets/2"))
        {
            body = MediaBytes;
            contentType = "application/octet-stream";
        }
        else
        {
            status = 400;
            body = Error("validation_failed");
            contentType = "application/json";
        }

        string reason = status == 200 ? "OK" : "Bad Request";
        byte[] header = Encoding.ASCII.GetBytes($"HTTP/1.1 {status} {reason}\r\nContent-Type: {contentType}\r\nContent-Length: {body.Length}\r\nConnection: close\r\n\r\n");
        await stream.WriteAsync(header, cancellationToken).ConfigureAwait(false);
        await stream.WriteAsync(body, cancellationToken).ConfigureAwait(false);
        return status;
    }

    private static byte[] Error(string code) => Encoding.UTF8.GetBytes($"{{\"ok\":false,\"error\":{{\"code\":\"{code}\",\"message\":\"fixture request rejected\"}}}}");

    private static async Task<ManualFixtureHttpRequest?> ReadRequestAsync(NetworkStream stream, CancellationToken cancellationToken)
    {
        string? headers = await ReadHeadersAsync(stream, cancellationToken).ConfigureAwait(false);
        if (headers is null) return null;
        string[] lines = headers.Split("\r\n", StringSplitOptions.None);
        string[] requestLine = lines[0].Split(' ', StringSplitOptions.RemoveEmptyEntries);
        if (requestLine.Length != 3) return null;
        var values = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        foreach (string line in lines.Skip(1))
        {
            int separator = line.IndexOf(':');
            if (separator > 0) values[line[..separator]] = line[(separator + 1)..].Trim();
        }
        int contentLength = values.TryGetValue("Content-Length", out string? length) && int.TryParse(length, out int parsed) && parsed is >= 0 and <= 16 * 1024 ? parsed : 0;
        byte[] body = new byte[contentLength];
        for (int offset = 0; offset < body.Length;)
        {
            int read = await stream.ReadAsync(body.AsMemory(offset), cancellationToken).ConfigureAwait(false);
            if (read == 0) return null;
            offset += read;
        }
        return new ManualFixtureHttpRequest(requestLine[0], requestLine[1], values, Encoding.UTF8.GetString(body));
    }

    private static async Task<string?> ReadHeadersAsync(NetworkStream stream, CancellationToken cancellationToken)
    {
        using var bytes = new MemoryStream();
        var one = new byte[1];
        while (bytes.Length < 16 * 1024 && await stream.ReadAsync(one, cancellationToken).ConfigureAwait(false) == 1)
        {
            bytes.WriteByte(one[0]);
            if (bytes.Length >= 4 && bytes.GetBuffer().AsSpan(checked((int)bytes.Length - 4), 4).SequenceEqual("\r\n\r\n"u8))
                return Encoding.ASCII.GetString(bytes.GetBuffer(), 0, checked((int)bytes.Length - 4));
        }
        return null;
    }

    private sealed record ManualFixtureHttpRequest(string Method, string PathAndQuery, IReadOnlyDictionary<string, string> Headers, string Body);
}

internal sealed record ManualFixtureRequest(string Method, string PathAndQuery, bool HasBearerAuthorization, bool TokenInUrl, string Body)
{
    internal bool IsRedeemIntentBody
    {
        get
        {
            try
            {
                using JsonDocument document = JsonDocument.Parse(Body);
                return document.RootElement.ValueKind == JsonValueKind.Object && document.RootElement.EnumerateObject().Count() == 1 &&
                    document.RootElement.TryGetProperty("intent", out JsonElement intent) && intent.ValueKind == JsonValueKind.String &&
                    intent.GetString() == ManualCreatorCrateFixture.MediaToken;
            }
            catch (JsonException) { return false; }
        }
    }
}
