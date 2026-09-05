using System.Net;
using System.Net.Sockets;

namespace OpenLocally;

public sealed record SocialOrigin
{
    private SocialOrigin(Uri uri, string identity) { Uri = uri; Identity = identity; }
    public Uri Uri { get; }
    public string Identity { get; }
    public string Scheme => Uri.Scheme;
    public string Host => Uri.Host;
    public int Port => Uri.IsDefaultPort ? DefaultPort(Uri.Scheme) : Uri.Port;
    public bool IsHttps => Uri.Scheme == Uri.UriSchemeHttps;

    public static bool TryParse(string? value, out SocialOrigin? origin)
    {
        origin = null;
        if (string.IsNullOrWhiteSpace(value) || value.Any(char.IsControl) ||
            !System.Uri.TryCreate(value, UriKind.Absolute, out Uri? parsed) ||
            (parsed.Scheme != Uri.UriSchemeHttp && parsed.Scheme != Uri.UriSchemeHttps) ||
            !string.IsNullOrEmpty(parsed.UserInfo) || parsed.AbsolutePath != "/" ||
            !string.IsNullOrEmpty(parsed.Query) || !string.IsNullOrEmpty(parsed.Fragment)) return false;
        string scheme = parsed.Scheme.ToLowerInvariant();
        string host = parsed.IdnHost.ToLowerInvariant();
        if (string.IsNullOrEmpty(host)) return false;
        int port = parsed.IsDefaultPort ? DefaultPort(scheme) : parsed.Port;
        Uri canonical = new UriBuilder(scheme, host, port).Uri;
        string renderedHost = canonical.HostNameType == UriHostNameType.IPv6 ? $"[{canonical.Host.Trim('[', ']')}]" : canonical.IdnHost.ToLowerInvariant();
        origin = new SocialOrigin(canonical, $"{scheme}://{renderedHost}{(port == DefaultPort(scheme) ? string.Empty : $":{port}")}");
        return true;
    }

    public static SocialOrigin Parse(Uri value)
    {
        if (!TryParse(value.OriginalString, out SocialOrigin? origin)) throw new ArgumentException("A canonical absolute HTTP(S) origin is required.", nameof(value));
        return origin!;
    }
    private static int DefaultPort(string scheme) => scheme == Uri.UriSchemeHttps ? 443 : 80;
}

public interface IOriginAddressResolver { Task<IReadOnlyList<IPAddress>> ResolveAsync(string host, CancellationToken cancellationToken); }

public sealed class DnsOriginAddressResolver : IOriginAddressResolver
{
    public async Task<IReadOnlyList<IPAddress>> ResolveAsync(string host, CancellationToken cancellationToken) =>
        await Dns.GetHostAddressesAsync(host, cancellationToken).ConfigureAwait(false);
}

public sealed record TransportAuthorizationResult(bool Allowed, string? ErrorCode, IReadOnlyList<IPAddress> Addresses)
{
    public static TransportAuthorizationResult Allow(IReadOnlyList<IPAddress>? addresses = null) => new(true, null, addresses ?? Array.Empty<IPAddress>());
    public static TransportAuthorizationResult Deny() => new(false, "insecure_origin_disallowed", Array.Empty<IPAddress>());
}

public static class SocialTransportPolicy
{
    public static async Task<TransportAuthorizationResult> AuthorizeAsync(SocialOrigin origin, IOriginAddressResolver resolver, CancellationToken cancellationToken)
    {
        if (origin.IsHttps) return TransportAuthorizationResult.Allow();
        if (IPAddress.TryParse(origin.Host.Trim('[', ']'), out IPAddress? literal))
            return IsPermittedPlaintextAddress(literal) ? TransportAuthorizationResult.Allow(new[] { literal }) : TransportAuthorizationResult.Deny();
        IReadOnlyList<IPAddress> addresses;
        try { addresses = await resolver.ResolveAsync(origin.Host, cancellationToken).ConfigureAwait(false); }
        catch (SocketException) { return TransportAuthorizationResult.Deny(); }
        return addresses.Count > 0 && addresses.All(IsPermittedPlaintextAddress) ? TransportAuthorizationResult.Allow(addresses) : TransportAuthorizationResult.Deny();
    }

    public static bool IsPermittedPlaintextAddress(IPAddress address)
    {
        if (address.AddressFamily == AddressFamily.InterNetworkV6)
        {
            if (address.ScopeId != 0 || address.IsIPv6LinkLocal) return false;
            return IPAddress.IsLoopback(address) || address.IsIPv6UniqueLocal;
        }
        if (address.AddressFamily != AddressFamily.InterNetwork) return false;
        byte[] b = address.GetAddressBytes();
        return IPAddress.IsLoopback(address) || b[0] == 10 || (b[0] == 172 && b[1] is >= 16 and <= 31) || (b[0] == 192 && b[1] == 168);
    }
}
