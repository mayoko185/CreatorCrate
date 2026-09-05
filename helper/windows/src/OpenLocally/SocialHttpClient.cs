using System.Net;
using System.Net.Http;
using System.Net.Sockets;

namespace OpenLocally;

/// <summary>Creates no-redirect clients; plaintext hostnames use the policy-approved DNS answers directly.</summary>
public sealed class SocialHttpClient
{
    private readonly IOriginAddressResolver _resolver;
    private readonly Func<HttpMessageHandler>? _testHandlerFactory;
    public TimeSpan ConnectTimeout { get; init; } = TimeSpan.FromSeconds(10);
    public TimeSpan RequestTimeout { get; init; } = TimeSpan.FromSeconds(30);

    public SocialHttpClient(IOriginAddressResolver resolver, Func<HttpMessageHandler>? testHandlerFactory = null)
    {
        _resolver = resolver ?? throw new ArgumentNullException(nameof(resolver));
        _testHandlerFactory = testHandlerFactory;
    }

    internal async Task<HttpResponseMessage> SendAsync(
        SocialOrigin origin,
        HttpRequestMessage request,
        TransportAuthorizationResult transport,
        CancellationToken cancellationToken)
    {
        if (!transport.Allowed) throw new InvalidOperationException("insecure_origin_disallowed");
        using HttpClient client = CreateClient(origin, transport);
        return await client.SendAsync(request, HttpCompletionOption.ResponseHeadersRead, cancellationToken).ConfigureAwait(false);
    }

    private HttpClient CreateClient(SocialOrigin origin, TransportAuthorizationResult transport)
    {
        HttpMessageHandler handler = _testHandlerFactory?.Invoke() ?? CreateProductionHandler(origin, transport);
        return new HttpClient(handler, disposeHandler: true) { Timeout = RequestTimeout };
    }

    private SocketsHttpHandler CreateProductionHandler(SocialOrigin origin, TransportAuthorizationResult transport)
    {
        var handler = new SocketsHttpHandler
        {
            AllowAutoRedirect = false,
            UseCookies = false,
            ConnectTimeout = ConnectTimeout,
        };

        if (!origin.IsHttps && !IPAddress.TryParse(origin.Host.Trim('[', ']'), out _))
        {
            IPAddress[] pinned = transport.Addresses.ToArray();
            handler.ConnectCallback = async (_, cancellationToken) =>
            {
                Exception? last = null;
                foreach (IPAddress address in pinned)
                {
                    var socket = new Socket(address.AddressFamily, SocketType.Stream, ProtocolType.Tcp);
                    try
                    {
                        await socket.ConnectAsync(new IPEndPoint(address, origin.Port), cancellationToken).ConfigureAwait(false);
                        return new NetworkStream(socket, ownsSocket: true);
                    }
                    catch (Exception ex) when (ex is SocketException or OperationCanceledException)
                    {
                        last = ex;
                        socket.Dispose();
                    }
                }
                throw new HttpRequestException("server_unreachable", last);
            };
        }

        return handler;
    }
}
