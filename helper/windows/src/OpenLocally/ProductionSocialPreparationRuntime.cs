namespace OpenLocally;

/// <summary>
/// Future production composition for social preparation. Command dispatch keeps
/// construction behind the adapter-coverage gate, so this type is inert while
/// Milestone 2 deliberately ships no production adapters.
/// </summary>
public static class ProductionSocialPreparationComposition
{
    public static SocialPreparationOrchestrator CreateOrchestrator(SocialAdapterRegistry adapters) =>
        new(adapters, CreateRuntime);

    public static ISocialPreparationRuntime CreateRuntime() => CreateRuntime(new NativeChromeConnectionConsent());

    internal static ISocialPreparationRuntime CreateRuntime(IChromeConnectionConsent consent,
        ManualPreparationEvidence? evidence = null, ChromeDiscovery? discovery = null,
        ChromeConnection? connection = null, Func<CdpTransport, BrowserPreparationTargets>? createTargets = null)
    {
        var resolver = new DnsOriginAddressResolver();
        var trust = new OriginTrustService(new WindowsTrustedOriginStore(), new NativeOriginTrustPrompt(), resolver);
        var http = new SocialHttpClient(resolver);
        var capability = new SocialCapabilityClient(http, trust);
        var media = new SocialMediaStager(
            capability,
            new LocalMediaResolver(new WindowsTrustedMediaRootStore(), new NativeTrustedMediaRootPrompt()));
        return new ProductionSocialPreparationRuntime(
            trust,
            new SocialRedeemClient(http, trust),
            capability,
            media,
            discovery ?? new ChromeDiscovery(),
            connection ?? new ChromeConnection(),
            consent, evidence, createTargets);
    }
}

/// <summary>Safe, run-owned implementation of the narrow orchestrator runtime seam.</summary>
public sealed class ProductionSocialPreparationRuntime : ISocialPreparationRuntime
{
    private readonly OriginTrustService _trust;
    private readonly SocialRedeemClient _redeem;
    private readonly SocialCapabilityClient _capabilities;
    private readonly SocialMediaStager _media;
    private readonly ChromeDiscovery _discovery;
    private readonly ChromeConnection _connection;
    private readonly IChromeConnectionConsent _chromeConsent;
    private readonly ManualPreparationEvidence? _evidence;
    private readonly Func<CdpTransport, BrowserPreparationTargets> _createTargets;
    private SocialOrigin? _origin;
    private CdpTransport? _transport;
    private int _disposed;

    internal ProductionSocialPreparationRuntime(
        OriginTrustService trust,
        SocialRedeemClient redeem,
        SocialCapabilityClient capabilities,
        SocialMediaStager media,
        ChromeDiscovery discovery,
        ChromeConnection connection,
        IChromeConnectionConsent chromeConsent,
        ManualPreparationEvidence? evidence = null,
        Func<CdpTransport, BrowserPreparationTargets>? createTargets = null)
    {
        _trust = trust ?? throw new ArgumentNullException(nameof(trust));
        _redeem = redeem ?? throw new ArgumentNullException(nameof(redeem));
        _capabilities = capabilities ?? throw new ArgumentNullException(nameof(capabilities));
        _media = media ?? throw new ArgumentNullException(nameof(media));
        _discovery = discovery ?? throw new ArgumentNullException(nameof(discovery));
        _connection = connection ?? throw new ArgumentNullException(nameof(connection));
        _chromeConsent = chromeConsent ?? throw new ArgumentNullException(nameof(chromeConsent));
        _evidence = evidence;
        _createTargets = createTargets ?? (transport => new BrowserPreparationTargets(new CdpTargetManager(transport)));
    }

    public async Task<SocialRedeemResult> RedeemAsync(SocialUriRequest request, CancellationToken cancellationToken)
    {
        _origin = SocialOrigin.Parse(request.ServerOrigin);
        OriginTrustResult authorization = await _trust.AuthorizeAsync(_origin, cancellationToken).ConfigureAwait(false);
        if (!authorization.Allowed) return SocialRedeemResult.Fail(authorization.ErrorCode!);
        _media.SweepAbandonedDirectories();
        return await _redeem.RedeemAuthorizedAsync(_origin, request.Intent, authorization.Transport!, cancellationToken).ConfigureAwait(false);
    }

    public Task<SocialStatusResult> GetStatusAsync(SocialCapability capability, CancellationToken cancellationToken) =>
        _capabilities.GetStatusAsync(Origin(), capability, cancellationToken);

    public Task<SocialPlatformStatusResult> PatchAsync(SocialCapability capability, string platform, string status, string? detailCode, string? message, CancellationToken cancellationToken) =>
        _capabilities.PatchPlatformStatusAsync(Origin(), capability, platform, status, detailCode, message, cancellationToken);

    public async Task<IReadOnlyList<string>> PrepareMediaAsync(SocialCapability capability, SocialRedeemPlatform platform, CancellationToken cancellationToken)
    {
        var paths = new List<string>(platform.Assets.Count);
        int ordinal = 0;
        foreach (SocialRedeemAsset asset in platform.Assets)
        {
            StagedMedia staged = await _media.StageAsync(Origin(), capability, asset, ordinal++, cancellationToken).ConfigureAwait(false);
            if (!staged.Success) throw new SocialPreparationRuntimeException(staged.ErrorCode!);
            paths.Add(staged.Path!);
        }
        return paths;
    }

    public async Task<BrowserPreparationTargets?> ConnectBrowserAsync(CancellationToken cancellationToken)
    {
        ChromeConnectionResult connected = await new ChromeConnectionWorkflow(_discovery, _connection, _chromeConsent, _evidence)
            .ConnectAsync(cancellationToken)
            .ConfigureAwait(false);
        if (!connected.Success)
        {
            _evidence?.CaptureFailure(ManualFailureKind.failure_outcome);
            throw new SocialPreparationRuntimeException(connected.ErrorCode!);
        }
        if (_evidence is not null) _evidence.BrowserSetup = ManualBoundaryState.entered;
        try
        {
            if (_connection.Socket is null) throw new SocialPreparationRuntimeException("chrome_handshake_failed");
            _transport = new CdpTransport(_connection.Socket);
            BrowserPreparationTargets targets = _createTargets(_transport);
            if (_evidence is not null) _evidence.BrowserSetup = ManualBoundaryState.completed;
            return targets;
        }
        catch
        {
            if (_evidence is not null) _evidence.BrowserSetup = ManualBoundaryState.failed;
            throw;
        }
    }

    public Task CleanupMediaAsync(SocialCapability capability)
    {
        _media.Cleanup(capability);
        return Task.CompletedTask;
    }

    public async ValueTask DisposeAsync()
    {
        if (Interlocked.Exchange(ref _disposed, 1) != 0) return;

        _transport?.StopForGracefulSocketClose();
        try
        {
            await _connection.DisposeAsync().ConfigureAwait(false);
        }
        finally
        {
            if (_transport is not null) await _transport.DisposeAsync().ConfigureAwait(false);
        }
    }

    private SocialOrigin Origin() => _origin ?? throw new InvalidOperationException("Social origin is unavailable before redeem.");
}

/// <summary>Internal runtime failures are reduced to stable process/detail codes by the orchestrator.</summary>
public class SocialPreparationRuntimeException(string code, Exception? inner = null, SocialPreparationDiagnostic? diagnostic = null) : Exception(code, inner)
{
    public string Code { get; } = code;
    public SocialPreparationDiagnostic? Diagnostic { get; } = diagnostic;
}
