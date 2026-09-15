namespace OpenLocally;

public enum SocialPreparationResultCategory
{
    Completed,
    PreRedeemFailure,
    CapabilityFailure,
    PreparationFailure,
    Cancelled,
}

/// <summary>One authoritative redeemed asset made available for a future manual companion.</summary>
public sealed record ManualPreparedAsset(SocialRedeemAsset Asset, string Path, StagedMediaProvenance Provenance)
{
    public override string ToString() => $"ManualPreparedAsset {{ AssetId = {Asset.AssetId}, Provenance = {Provenance} }}";
}

/// <summary>Exact server-supplied platform content and its assets in server order.</summary>
public sealed record ManualPreparedPlatform(
    string Platform, string Title, string Body, IReadOnlyList<ManualPreparedAsset> Assets)
{
    public override string ToString() => $"ManualPreparedPlatform {{ Platform = {Platform}, AssetCount = {Assets.Count} }}";
}

/// <summary>
/// Browser-independent handoff boundary for the future native companion. The
/// bearer capability is deliberately not exposed beyond the preparation runtime.
/// </summary>
public sealed record ManualSocialSession(
    Uri ServerOrigin, int ReleaseId, string ReleaseTitle, IReadOnlyList<ManualPreparedPlatform> Platforms)
{
    public override string ToString() => $"ManualSocialSession {{ ReleaseId = {ReleaseId}, PlatformCount = {Platforms.Count} }}";
}

public sealed record ManualSocialPreparationResult(
    bool Success, string? ErrorCode, SocialPreparationResultCategory Category,
    ManualSocialSession? Session, ManualSocialDiagnostic? Diagnostic = null)
{
    public static ManualSocialPreparationResult Ready(ManualSocialSession session) =>
        new(true, null, SocialPreparationResultCategory.Completed, session);

    public static ManualSocialPreparationResult Fail(
        string code, SocialPreparationResultCategory category, ManualSocialDiagnostic? diagnostic = null) =>
        new(false, code, category, null, diagnostic ?? new ManualSocialDiagnostic(
            ManualSocialDiagnostic.SafeCode(code), ManualSocialDiagnosticStage.ManualPreparation,
            ManualSocialDiagnosticReason.PreparationFailed));
}

/// <summary>Narrow, browser-free production seam used only by social envelope v2.</summary>
public interface IManualSocialPreparationRuntime : IAsyncDisposable
{
    Task<SocialRedeemResult> RedeemAsync(SocialUriRequest request, CancellationToken cancellationToken);
    Task<SocialPlatformStatusResult> PatchAsync(
        SocialCapability capability, string platform, string status, string? detailCode,
        string? message, CancellationToken cancellationToken);
    Task<StagedMedia> StageAssetAsync(
        SocialCapability capability, SocialRedeemAsset asset, int ordinal, CancellationToken cancellationToken);
    Task<StagedMedia> EnsureAssetAvailableAsync(
        SocialCapability capability, SocialRedeemAsset asset, int ordinal, StagedMedia media, CancellationToken cancellationToken);
    Task CleanupMediaAsync(SocialCapability capability);
    IDisposable DetachMediaLease(SocialCapability capability);
}

public interface IManualSocialCompanionLifetime : IDisposable
{
    Task Ready { get; }
    Task Closed { get; }
}

public interface IManualSocialCompanion
{
    IManualSocialCompanionLifetime Open(
        ManualSocialSession session, IDisposable mediaLease, IManualAssetAvailability availability);
}

internal interface IManualSocialPreviewCompanion
{
    IManualSocialCompanionLifetime OpenWithPreviews(
        ManualSocialSession session, IDisposable mediaLease, IManualAssetAvailability availability,
        IManualAssetPreviewAccess previewAccess);
}

internal interface IManualAssetPreviewAccessProvider
{
    IManualAssetPreviewAccess CreatePreviewAccess(SocialCapability capability);
}

/// <summary>Borrowed-controller composition seam; the orchestrator remains the sole controller owner.</summary>
internal interface IManualPostingConfirmationCompanion
{
    IManualSocialCompanionLifetime OpenWithPostingConfirmation(
        ManualSocialSession session, IDisposable mediaLease, IManualAssetAvailability availability,
        IManualAssetPreviewAccess? previewAccess, ManualPostingConfirmationController confirmation);
}

internal interface IManualPostingConfirmationProvider
{
    ManualPostingConfirmationController CreatePostingConfirmation(
        SocialCapability capability, IReadOnlyList<string> platforms);
}

public sealed record ManualDragAsset(ManualPreparedAsset Prepared, int Ordinal);

public sealed record ManualDragPreparation(
    bool Success, IReadOnlyList<string> Paths, string? ErrorCode, string? AssetName)
{
    public static ManualDragPreparation Ready(IReadOnlyList<string> paths) => new(true, paths, null, null);
    public static ManualDragPreparation Fail(string code, string? assetName = null) => new(false, [], code, assetName);
}

public interface IManualAssetAvailability
{
    Task<ManualDragPreparation> PrepareAsync(
        IReadOnlyList<ManualDragAsset> selected, CancellationToken cancellationToken);
}

internal sealed class RuntimeManualAssetAvailability(
    IManualSocialPreparationRuntime runtime, SocialCapability capability) : IManualAssetAvailability
{
    public async Task<ManualDragPreparation> PrepareAsync(
        IReadOnlyList<ManualDragAsset> selected, CancellationToken cancellationToken)
    {
        if (selected.Count == 0) return ManualDragPreparation.Fail("no_assets_selected");
        var paths = new List<string>(selected.Count);
        ManualDragPreparation? failure = null;
        foreach (ManualDragAsset item in selected)
        {
            ManualPreparedAsset prepared = item.Prepared;
            StagedMedia current = prepared.Provenance == StagedMediaProvenance.HelperOwned
                ? StagedMedia.Owned(prepared.Path) : StagedMedia.Source(prepared.Path);
            StagedMedia available = await runtime.EnsureAssetAvailableAsync(
                capability, prepared.Asset, item.Ordinal, current, cancellationToken).ConfigureAwait(false);
            if (!available.Success)
            {
                failure ??= ManualDragPreparation.Fail(available.ErrorCode ?? "media_unavailable", prepared.Asset.Filename);
                continue;
            }
            if (string.IsNullOrWhiteSpace(available.Path) || !Path.IsPathFullyQualified(available.Path) || !File.Exists(available.Path))
            {
                failure ??= ManualDragPreparation.Fail("media_file_missing", prepared.Asset.Filename);
                continue;
            }
            paths.Add(Path.GetFullPath(available.Path));
        }
        return failure ?? ManualDragPreparation.Ready(paths.AsReadOnly());
    }
}

/// <summary>Runs one v2 preparation iteration and completes server accounting at ready.</summary>
public sealed class ManualSocialPreparationOrchestrator
{
    internal const string FailureCode = "manual_preparation_failed";
    internal const string CompanionFailureCode = "manual_companion_unavailable";
    private readonly Func<IManualSocialPreparationRuntime> _createRuntime;
    private readonly IManualSocialCompanion _companion;

    public ManualSocialPreparationOrchestrator(
        Func<IManualSocialPreparationRuntime> createRuntime, IManualSocialCompanion? companion = null)
    {
        _createRuntime = createRuntime ?? throw new ArgumentNullException(nameof(createRuntime));
        _companion = companion ?? NativeManualPublishingCompanion.Instance;
    }

    public async Task<ManualSocialPreparationResult> RunAsync(
        SocialUriRequest request, CancellationToken cancellationToken = default)
    {
        if (request.Version != SocialUriRequestParser.ManualVersion)
            return ManualSocialPreparationResult.Fail("unsupported_social_version", SocialPreparationResultCategory.PreRedeemFailure);

        IManualSocialPreparationRuntime? runtime = null;
        SocialCapability? capability = null;
        IReadOnlyList<SocialRedeemPlatform> platforms = Array.Empty<SocialRedeemPlatform>();
        int currentPlatform = 0;
        IManualSocialCompanionLifetime? companion = null;
        ManualPostingConfirmationController? postingConfirmation = null;
        bool readyReported = false;
        try
        {
            runtime = _createRuntime();
            SocialRedeemResult redeemed = await runtime.RedeemAsync(request, cancellationToken).ConfigureAwait(false);
            if (!redeemed.Success)
                return ManualSocialPreparationResult.Fail(
                    redeemed.ErrorCode!, SocialPreparationResultCategory.PreRedeemFailure, redeemed.Diagnostic);
            if (!SocialCapability.TryCreate(redeemed.Response!, out capability) || capability is null)
                return ManualSocialPreparationResult.Fail(
                    "media_token_malformed", SocialPreparationResultCategory.CapabilityFailure,
                    new ManualSocialDiagnostic("media_token_malformed", ManualSocialDiagnosticStage.CapabilityConstruction,
                        ManualSocialDiagnosticReason.CapabilityConstructionFailed,
                        ReleaseId: redeemed.Response!.ReleaseId));
            if (redeemed.Response!.ReleaseId is null || redeemed.Response.ReleaseId <= 0 || redeemed.Response.Platforms.Count == 0)
                return ManualSocialPreparationResult.Fail(
                    "redeem_payload_invalid", SocialPreparationResultCategory.PreRedeemFailure,
                    new ManualSocialDiagnostic("redeem_payload_invalid", ManualSocialDiagnosticStage.RedeemPreparation,
                        redeemed.Response.ReleaseId is null or <= 0
                            ? ManualSocialDiagnosticReason.InvalidReleaseId
                            : ManualSocialDiagnosticReason.InvalidPlatformCollection));

            platforms = redeemed.Response.Platforms;
            for (int index = 0; index < platforms.Count; index++)
            {
                currentPlatform = index;
                SocialPlatformStatusResult staging = await runtime.PatchAsync(
                    capability, platforms[index].Platform, "staging", null, null, cancellationToken).ConfigureAwait(false);
                if (!staging.Success)
                {
                    await ReportFailureAsync(runtime, capability, platforms, index, staging.ErrorCode!, CancellationToken.None).ConfigureAwait(false);
                    return PreparationFailure(staging.ErrorCode!, CategoryFor(staging.ErrorCode!),
                        ManualSocialDiagnosticStage.ManualPreparation, platformOrdinal: index + 1,
                        releaseId: redeemed.Response.ReleaseId);
                }
            }

            var stagedPlatforms = new List<(SocialRedeemPlatform Platform, List<(SocialRedeemAsset Asset, int Ordinal, StagedMedia Media)> Assets)>(platforms.Count);
            for (int platformIndex = 0; platformIndex < platforms.Count; platformIndex++)
            {
                currentPlatform = platformIndex;
                SocialRedeemPlatform platform = platforms[platformIndex];
                var stagedAssets = new List<(SocialRedeemAsset, int, StagedMedia)>(platform.Assets.Count);
                for (int ordinal = 0; ordinal < platform.Assets.Count; ordinal++)
                {
                    SocialRedeemAsset asset = platform.Assets[ordinal];
                    StagedMedia media = await runtime.StageAssetAsync(capability, asset, ordinal, cancellationToken).ConfigureAwait(false);
                    if (!media.Success)
                    {
                        await ReportFailureAsync(runtime, capability, platforms, platformIndex, media.ErrorCode!, CancellationToken.None).ConfigureAwait(false);
                        return PreparationFailure(media.ErrorCode!, CategoryFor(media.ErrorCode!),
                            ManualSocialDiagnosticStage.MediaPreparation, platformIndex + 1, ordinal + 1,
                            redeemed.Response.ReleaseId);
                    }
                    stagedAssets.Add((asset, ordinal, media));
                }
                stagedPlatforms.Add((platform, stagedAssets));
            }

            // This final pass is intentionally adjacent to the ready transition:
            // external sources are read-only revalidated and helper-owned files
            // may use the authorized WP4 restaging path.
            var preparedPlatforms = new List<ManualPreparedPlatform>(platforms.Count);
            for (int platformIndex = 0; platformIndex < stagedPlatforms.Count; platformIndex++)
            {
                currentPlatform = platformIndex;
                var stagedPlatform = stagedPlatforms[platformIndex];
                var preparedAssets = new List<ManualPreparedAsset>(stagedPlatform.Assets.Count);
                foreach (var stagedAsset in stagedPlatform.Assets)
                {
                    StagedMedia available = await runtime.EnsureAssetAvailableAsync(
                        capability, stagedAsset.Asset, stagedAsset.Ordinal, stagedAsset.Media, cancellationToken).ConfigureAwait(false);
                    if (!available.Success)
                    {
                        await ReportFailureAsync(runtime, capability, platforms, platformIndex, available.ErrorCode!, CancellationToken.None).ConfigureAwait(false);
                        return PreparationFailure(available.ErrorCode!, CategoryFor(available.ErrorCode!),
                            ManualSocialDiagnosticStage.MediaPreparation, platformIndex + 1,
                            stagedAsset.Ordinal + 1, redeemed.Response.ReleaseId);
                    }
                    preparedAssets.Add(new ManualPreparedAsset(
                        stagedAsset.Asset, available.Path!, available.Provenance!.Value));
                }
                preparedPlatforms.Add(new ManualPreparedPlatform(
                    stagedPlatform.Platform.Platform, stagedPlatform.Platform.Title,
                    stagedPlatform.Platform.Body, preparedAssets.AsReadOnly()));
            }

            var session = new ManualSocialSession(
                request.ServerOrigin, redeemed.Response.ReleaseId!.Value,
                platforms[0].Title, preparedPlatforms.AsReadOnly());

            IDisposable lease = runtime.DetachMediaLease(capability);
            var availability = new RuntimeManualAssetAvailability(runtime, capability);
            IManualAssetPreviewAccess? previewAccess = null;
            try
            {
                if (runtime is IManualPostingConfirmationProvider confirmationProvider)
                    postingConfirmation = confirmationProvider.CreatePostingConfirmation(
                        capability, platforms.Select(platform => platform.Platform).ToArray());
                if (runtime is IManualAssetPreviewAccessProvider previewProvider &&
                    (_companion is IManualSocialPreviewCompanion || _companion is IManualPostingConfirmationCompanion))
                    previewAccess = previewProvider.CreatePreviewAccess(capability);

                if (_companion is IManualPostingConfirmationCompanion confirmationCompanion && postingConfirmation is not null)
                {
                    // The companion borrows this controller through its window lifetime.
                    // Ownership stays here so the orchestrator disposes it exactly once after Closed.
                    companion = confirmationCompanion.OpenWithPostingConfirmation(
                        session, lease, availability, previewAccess, postingConfirmation);
                    previewAccess = null; // ownership moved to the native companion lifetime
                }
                else if (_companion is IManualSocialPreviewCompanion previewCompanion && previewAccess is not null)
                {
                    companion = previewCompanion.OpenWithPreviews(session, lease, availability, previewAccess);
                    previewAccess = null; // ownership moved to the native companion lifetime
                }
                else companion = _companion.Open(session, lease, availability);
            }
            catch
            {
                previewAccess?.Dispose();
                lease.Dispose();
                throw;
            }
            try
            {
                await companion.Ready.WaitAsync(cancellationToken).ConfigureAwait(false);
            }
            catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested) { throw; }
            catch
            {
                await ReportFailureAsync(runtime, capability, platforms, currentPlatform,
                    CompanionFailureCode, CancellationToken.None).ConfigureAwait(false);
                return ManualSocialPreparationResult.Fail(
                    CompanionFailureCode, SocialPreparationResultCategory.PreparationFailure,
                    new ManualSocialDiagnostic(CompanionFailureCode,
                        ManualSocialDiagnosticStage.CompanionPresentation,
                        ManualSocialDiagnosticReason.CompanionUnavailable,
                        PlatformOrdinal: currentPlatform + 1,
                        ReleaseId: redeemed.Response.ReleaseId));
            }

            for (int index = 0; index < platforms.Count; index++)
            {
                currentPlatform = index;
                SocialPlatformStatusResult ready = await runtime.PatchAsync(
                    capability, platforms[index].Platform, "ready", null, null, cancellationToken).ConfigureAwait(false);
                if (!ready.Success)
                {
                    await ReportFailureAsync(runtime, capability, platforms, index, ready.ErrorCode!, CancellationToken.None).ConfigureAwait(false);
                    return PreparationFailure(ready.ErrorCode!, CategoryFor(ready.ErrorCode!),
                        ManualSocialDiagnosticStage.ManualPreparation, index + 1,
                        releaseId: redeemed.Response.ReleaseId);
                }
            }
            readyReported = true;

            // Server state remains ready. The narrow availability service retains
            // the capability only for WP4 revalidation/restaging until window close.
            try { await companion.Closed.ConfigureAwait(false); } catch { }
            return ManualSocialPreparationResult.Ready(session);
        }
        catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
        {
            if (!readyReported && runtime is not null && capability is not null)
                await ReportCancellationAsync(runtime, capability, platforms, CancellationToken.None).ConfigureAwait(false);
            return ManualSocialPreparationResult.Fail("caller_cancelled", SocialPreparationResultCategory.Cancelled);
        }
        catch
        {
            if (!readyReported && runtime is not null && capability is not null)
                await ReportFailureAsync(runtime, capability, platforms, currentPlatform, FailureCode, CancellationToken.None).ConfigureAwait(false);
            return ManualSocialPreparationResult.Fail(FailureCode, SocialPreparationResultCategory.PreparationFailure);
        }
        finally
        {
            try { companion?.Dispose(); } catch { }
            if (companion is not null) try { await companion.Closed.ConfigureAwait(false); } catch { }
            try { postingConfirmation?.Dispose(); } catch { }
            if (runtime is not null)
            {
                if (capability is not null)
                {
                    try { await runtime.CleanupMediaAsync(capability).ConfigureAwait(false); }
                    catch { }
                }
                try { await runtime.DisposeAsync().ConfigureAwait(false); }
                catch { }
            }
        }
    }

    private static async Task ReportFailureAsync(
        IManualSocialPreparationRuntime runtime, SocialCapability capability,
        IReadOnlyList<SocialRedeemPlatform> platforms, int failedIndex, string code,
        CancellationToken cancellationToken)
    {
        for (int index = 0; index < platforms.Count; index++)
        {
            string status = index == Math.Clamp(failedIndex, 0, Math.Max(0, platforms.Count - 1)) ? "failed" : "cancelled";
            try
            {
                await runtime.PatchAsync(capability, platforms[index].Platform, status,
                    status == "failed" ? BoundedCode(code) : null, null, cancellationToken).ConfigureAwait(false);
            }
            catch { }
        }
    }

    private static async Task ReportCancellationAsync(
        IManualSocialPreparationRuntime runtime, SocialCapability capability,
        IReadOnlyList<SocialRedeemPlatform> platforms, CancellationToken cancellationToken)
    {
        foreach (SocialRedeemPlatform platform in platforms)
        {
            try { await runtime.PatchAsync(capability, platform.Platform, "cancelled", null, null, cancellationToken).ConfigureAwait(false); }
            catch { }
        }
    }

    private static string BoundedCode(string code) =>
        code.Length is > 0 and <= 64 && code.All(character => character is >= 'a' and <= 'z' or >= '0' and <= '9' or '_')
            ? code : FailureCode;

    private static ManualSocialPreparationResult PreparationFailure(
        string code, SocialPreparationResultCategory category, ManualSocialDiagnosticStage stage,
        int? platformOrdinal = null, int? assetOrdinal = null, int? releaseId = null) =>
        ManualSocialPreparationResult.Fail(code, category, new ManualSocialDiagnostic(
            ManualSocialDiagnostic.SafeCode(code), stage, ManualSocialDiagnosticReason.PreparationFailed,
            PlatformOrdinal: platformOrdinal, AssetOrdinal: assetOrdinal, ReleaseId: releaseId));

    private static SocialPreparationResultCategory CategoryFor(string code) => code switch
    {
        "media_token_missing" or "media_token_malformed" or "media_token_invalid" or "media_token_expired" or
        "attempt_not_active" or "validation_failed" or "platform_not_in_release" => SocialPreparationResultCategory.CapabilityFailure,
        "caller_cancelled" => SocialPreparationResultCategory.Cancelled,
        _ => SocialPreparationResultCategory.PreparationFailure,
    };
}

/// <summary>Trusted transport, redemption, and WP4 media composition with no browser references.</summary>
public static class ProductionManualSocialPreparationComposition
{
    public static ManualSocialPreparationOrchestrator CreateOrchestrator() => new(CreateRuntime);

    internal static IManualSocialPreparationRuntime CreateRuntime()
    {
        var resolver = new DnsOriginAddressResolver();
        var trust = new OriginTrustService(new WindowsTrustedOriginStore(), new NativeOriginTrustPrompt(), resolver);
        var http = new SocialHttpClient(resolver);
        var capability = new SocialCapabilityClient(http, trust);
        var localMedia = new LocalMediaResolver(
            new WindowsTrustedMediaRootStore(), new NativeTrustedMediaRootPrompt());
        var media = new SocialMediaStager(capability, localMedia);
        return new ProductionManualSocialPreparationRuntime(
            http, trust, new SocialRedeemClient(http, trust), capability, media, localMedia);
    }
}

public sealed class ProductionManualSocialPreparationRuntime :
    IManualSocialPreparationRuntime, IManualAssetPreviewAccessProvider, IManualPostingConfirmationProvider
{
    private readonly SocialHttpClient _http;
    private readonly OriginTrustService _trust;
    private readonly SocialRedeemClient _redeem;
    private readonly SocialCapabilityClient _capabilities;
    private readonly SocialMediaStager _media;
    private readonly LocalMediaResolver _localMedia;
    private SocialOrigin? _origin;

    internal ProductionManualSocialPreparationRuntime(
        SocialHttpClient http, OriginTrustService trust, SocialRedeemClient redeem,
        SocialCapabilityClient capabilities, SocialMediaStager media, LocalMediaResolver localMedia) =>
        (_http, _trust, _redeem, _capabilities, _media, _localMedia) =
        (http ?? throw new ArgumentNullException(nameof(http)), trust ?? throw new ArgumentNullException(nameof(trust)), redeem ?? throw new ArgumentNullException(nameof(redeem)),
         capabilities ?? throw new ArgumentNullException(nameof(capabilities)), media ?? throw new ArgumentNullException(nameof(media)),
         localMedia ?? throw new ArgumentNullException(nameof(localMedia)));

    public async Task<SocialRedeemResult> RedeemAsync(SocialUriRequest request, CancellationToken cancellationToken)
    {
        _origin = SocialOrigin.Parse(request.ServerOrigin);
        OriginTrustResult authorization = await _trust.AuthorizeAsync(_origin, cancellationToken).ConfigureAwait(false);
        if (!authorization.Allowed) return SocialRedeemResult.Fail(authorization.ErrorCode!);
        _media.SweepAbandonedDirectories();
        return await _redeem.RedeemAuthorizedAsync(_origin, request.Intent, authorization.Transport!, cancellationToken).ConfigureAwait(false);
    }

    public Task<SocialPlatformStatusResult> PatchAsync(
        SocialCapability capability, string platform, string status, string? detailCode,
        string? message, CancellationToken cancellationToken) =>
        _capabilities.PatchPlatformStatusAsync(Origin(), capability, platform, status, detailCode, message, cancellationToken);

    public Task<StagedMedia> StageAssetAsync(
        SocialCapability capability, SocialRedeemAsset asset, int ordinal, CancellationToken cancellationToken) =>
        _media.StageAsync(Origin(), capability, asset, ordinal, cancellationToken);

    public Task<StagedMedia> EnsureAssetAvailableAsync(
        SocialCapability capability, SocialRedeemAsset asset, int ordinal,
        StagedMedia media, CancellationToken cancellationToken) =>
        _media.EnsureAvailableAsync(Origin(), capability, asset, ordinal, media, cancellationToken);

    public Task CleanupMediaAsync(SocialCapability capability)
    {
        _media.Cleanup(capability);
        return Task.CompletedTask;
    }

    public IDisposable DetachMediaLease(SocialCapability capability) => _media.DetachLease(capability);

    IManualAssetPreviewAccess IManualAssetPreviewAccessProvider.CreatePreviewAccess(SocialCapability capability) =>
        new ManualAssetPreviewAccess(Origin(), capability.SessionId, _localMedia, _media);

    ManualPostingConfirmationController IManualPostingConfirmationProvider.CreatePostingConfirmation(
        SocialCapability capability, IReadOnlyList<string> platforms) =>
        new(new ManualPostingConfirmationClient(_http, _trust, Origin(), capability, confirmationExpiresAt: null), platforms);

    public ValueTask DisposeAsync() => ValueTask.CompletedTask;

    private SocialOrigin Origin() => _origin ?? throw new InvalidOperationException("Social origin is unavailable before redeem.");
}
