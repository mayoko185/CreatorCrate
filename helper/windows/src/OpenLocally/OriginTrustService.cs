namespace OpenLocally;
public sealed record OriginTrustResult(bool Allowed, string? ErrorCode, TransportAuthorizationResult? Transport)
{
    public static OriginTrustResult Allow(TransportAuthorizationResult transport) => new(true, null, transport);
    public static OriginTrustResult Deny(string errorCode) => new(false, errorCode, null);
}
public sealed class OriginTrustService
{
    private readonly ITrustedOriginStore _store;
    private readonly IOriginTrustPrompt _prompt;
    private readonly IOriginAddressResolver _resolver;
    public OriginTrustService(ITrustedOriginStore store, IOriginTrustPrompt prompt, IOriginAddressResolver resolver) =>
        (_store, _prompt, _resolver) = (store ?? throw new ArgumentNullException(nameof(store)), prompt ?? throw new ArgumentNullException(nameof(prompt)), resolver ?? throw new ArgumentNullException(nameof(resolver)));
    public async Task<OriginTrustResult> AuthorizeAsync(SocialOrigin origin, CancellationToken cancellationToken)
    {
        bool trusted = _store.IsTrusted(origin);
        if (!trusted && !_prompt.ConfirmTrust(origin)) return OriginTrustResult.Deny("server_origin_denied");
        TransportAuthorizationResult transport = await SocialTransportPolicy.AuthorizeAsync(origin, _resolver, cancellationToken).ConfigureAwait(false);
        if (!transport.Allowed) return OriginTrustResult.Deny(transport.ErrorCode!);
        if (!trusted) _store.Trust(origin);
        return OriginTrustResult.Allow(transport);
    }
}
