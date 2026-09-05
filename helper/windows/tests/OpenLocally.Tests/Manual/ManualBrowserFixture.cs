using System.Net;
using System.Net.Sockets;
using System.Text;

namespace OpenLocally.Tests.Manual;

/// <summary>
/// Opt-in-only loopback page used to exercise the generic browser preparation
/// primitives. It contains no form or publication endpoint.
/// </summary>
internal sealed class ManualBrowserFixture : IAsyncDisposable
{
    internal const string Title = "CreatorCrate Milestone 2 Fixture Title";
    internal const string Body = "CreatorCrate fixture body line 1\n\nFixture line 3 — Unicode ✓";

    internal const string Html = """
        <!doctype html>
        <html lang="en">
        <meta charset="utf-8">
        <title>CreatorCrate preparation fixture</title>
        <main data-creatorcrate-fixture="preparation-only">
          <label>Title <input id="fixture-title" aria-label="Fixture title" value=""></label>
          <label>Body <textarea id="fixture-body" aria-label="Fixture body"></textarea></label>
          <label>Media <input id="fixture-media" type="file" multiple aria-label="Fixture media"></label>
          <output id="fixture-upload-ready" aria-live="polite">not-ready</output>
        </main>
        <script>
        const media = document.querySelector('#fixture-media');
        const upload = document.querySelector('#fixture-upload-ready');
        media.addEventListener('change', () => {
          const names = Array.from(media.files, file => file.name);
          upload.textContent = names.length ? `ready:${names.length}:${names.join('|')}` : 'not-ready';
        });
        </script>
        </html>
        """;

    private readonly TcpListener _listener;
    private readonly CancellationTokenSource _lifetime = new();
    private readonly Task _serveTask;
    private int _disposed;

    private ManualBrowserFixture(TcpListener listener, string mediaDirectory, IReadOnlyList<string> mediaPaths)
    {
        _listener = listener;
        MediaDirectory = mediaDirectory;
        MediaPaths = mediaPaths;
        Origin = new Uri($"http://127.0.0.1:{((IPEndPoint)_listener.LocalEndpoint).Port}/");
        _serveTask = ServeAsync();
    }

    private ManualBrowserFixture(Uri origin)
    {
        _listener = new TcpListener(IPAddress.Loopback, 0);
        Origin = origin;
        MediaDirectory = string.Empty;
        MediaPaths = [];
        _serveTask = Task.CompletedTask;
    }

    internal Uri Origin { get; }
    internal string MediaDirectory { get; }
    internal IReadOnlyList<string> MediaPaths { get; }

    internal static Task<ManualBrowserFixture> StartAsync(string workspace)
    {
        ManualFoundationGuard.RequireOptIn();
        ArgumentException.ThrowIfNullOrWhiteSpace(workspace);

        string mediaDirectory = Path.Combine(workspace, "browser-fixture-media");
        Directory.CreateDirectory(mediaDirectory);
        string first = Path.Combine(mediaDirectory, "fixture-first.txt");
        File.WriteAllText(first, "CreatorCrate harmless browser fixture media one");

        var listener = new TcpListener(IPAddress.Loopback, 0);
        listener.Start();
        return Task.FromResult(new ManualBrowserFixture(listener, mediaDirectory, [first]));
    }

    internal static ManualBrowserFixture CreateForFakeCdp(Uri origin) => new(origin);

    public async ValueTask DisposeAsync()
    {
        if (Interlocked.Exchange(ref _disposed, 1) != 0) return;
        _lifetime.Cancel();
        _listener.Stop();
        try { await _serveTask.ConfigureAwait(false); }
        catch (OperationCanceledException) { }
        finally
        {
            _lifetime.Dispose();
            if (!string.IsNullOrEmpty(MediaDirectory) && Directory.Exists(MediaDirectory)) Directory.Delete(MediaDirectory, recursive: true);
        }
    }

    private async Task ServeAsync()
    {
        try
        {
            while (!_lifetime.IsCancellationRequested)
            {
                TcpClient client = await _listener.AcceptTcpClientAsync(_lifetime.Token).ConfigureAwait(false);
                await ServeClientAsync(client).ConfigureAwait(false);
            }
        }
        catch (OperationCanceledException) when (_lifetime.IsCancellationRequested) { }
        catch (ObjectDisposedException) when (_lifetime.IsCancellationRequested) { }
        catch (SocketException) when (_lifetime.IsCancellationRequested) { }
    }

    private async Task ServeClientAsync(TcpClient client)
    {
        using (client)
        await using (NetworkStream stream = client.GetStream())
        using (var reader = new StreamReader(stream, Encoding.ASCII, leaveOpen: true))
        {
            try
            {
                string? requestLine = await reader.ReadLineAsync(_lifetime.Token).ConfigureAwait(false);
                while (!string.IsNullOrEmpty(await reader.ReadLineAsync(_lifetime.Token).ConfigureAwait(false))) { }
                bool serveFixture = requestLine?.StartsWith("GET / ", StringComparison.Ordinal) == true ||
                    requestLine?.StartsWith("GET / HTTP/", StringComparison.Ordinal) == true;
                byte[] body = serveFixture ? Encoding.UTF8.GetBytes(Html) : Encoding.UTF8.GetBytes("not found");
                string header = $"HTTP/1.1 {(serveFixture ? "200 OK" : "404 Not Found")}\r\nContent-Type: {(serveFixture ? "text/html; charset=utf-8" : "text/plain; charset=utf-8")}\r\nContent-Length: {body.Length}\r\nConnection: close\r\n\r\n";
                await stream.WriteAsync(Encoding.ASCII.GetBytes(header), _lifetime.Token).ConfigureAwait(false);
                await stream.WriteAsync(body, _lifetime.Token).ConfigureAwait(false);
            }
            catch (OperationCanceledException) when (_lifetime.IsCancellationRequested) { }
            catch (IOException) { }
        }
    }
}

/// <summary>Guards the live Chrome stage before either discovery or connection can run.</summary>
internal static class ManualBrowserChromeStage
{
    internal static async Task<ChromeEndpoint> DiscoverAndConnectAsync(
        Func<ChromeDiscoveryResult> discover,
        Func<ChromeEndpoint, CancellationToken, Task<ChromeConnectionResult>> connect,
        CancellationToken cancellationToken)
    {
        ManualFoundationGuard.RequireOptIn();
        ArgumentNullException.ThrowIfNull(discover);
        ArgumentNullException.ThrowIfNull(connect);

        ChromeDiscoveryResult discovery = discover();
        if (!discovery.Success)
            throw new InvalidOperationException(DescribeDiscoveryFailure(discovery.ErrorCode));

        ChromeConnectionResult connection = await connect(discovery.Endpoint!, cancellationToken).ConfigureAwait(false);
        if (!connection.Success)
            throw new InvalidOperationException($"Chrome manual checkpoint failed: {connection.ErrorCode}. Check the normal Chrome approval prompt and retry only by starting a new Manual run.");

        return discovery.Endpoint!;
    }

    private static string DescribeDiscoveryFailure(string? code) => code switch
    {
        "chrome_not_running" => "Chrome manual checkpoint failed: normal stable Google Chrome is not running. Start it normally and enable Remote Debugging through Chrome's UI.",
        "chrome_discovery_missing" => "Chrome manual checkpoint failed: DevToolsActivePort is absent. Enable Remote Debugging through Chrome's UI for the normal stable profile.",
        "chrome_discovery_malformed" => "Chrome manual checkpoint failed: DevToolsActivePort is malformed. Restart the Manual checkpoint only after correcting Chrome through its UI.",
        _ => "Chrome manual checkpoint failed before discovery completed.",
    };
}
