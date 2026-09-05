namespace OpenLocally;

public interface ISocialPreparationRuntime : IAsyncDisposable
{
    Task<SocialRedeemResult> RedeemAsync(SocialUriRequest request, CancellationToken cancellationToken);
    Task<SocialStatusResult> GetStatusAsync(SocialCapability capability, CancellationToken cancellationToken);
    Task<SocialPlatformStatusResult> PatchAsync(SocialCapability capability, string platform, string status, string? detailCode, string? message, CancellationToken cancellationToken);
    Task<IReadOnlyList<string>> PrepareMediaAsync(SocialCapability capability, SocialRedeemPlatform platform, CancellationToken cancellationToken);
    Task<BrowserPreparationTargets?> ConnectBrowserAsync(CancellationToken cancellationToken);
    Task CleanupMediaAsync(SocialCapability capability);
}

public sealed class SocialPreparationOrchestrator
{
    private readonly SocialAdapterRegistry _adapters;
    private readonly Func<ISocialPreparationRuntime> _createRuntime;
    public SocialPreparationOrchestrator(SocialAdapterRegistry adapters, Func<ISocialPreparationRuntime> createRuntime) =>
        (_adapters, _createRuntime) = (adapters ?? throw new ArgumentNullException(nameof(adapters)), createRuntime ?? throw new ArgumentNullException(nameof(createRuntime)));

    public async Task<SocialPreparationResult> RunAsync(SocialUriRequest request, CancellationToken cancellationToken = default)
    {
        if (!_adapters.HasCompleteFrozenCoverage()) return FallbackFailure("unknown", "adapter_coverage", "production_adapters_unavailable");
        ISocialPreparationRuntime? runtime = null;
        SocialCapability? capability = null;
        IReadOnlyList<SocialRedeemPlatform> platforms = Array.Empty<SocialRedeemPlatform>();
        int firstUnfinishedPlatform = 0;
        int? releaseId = null;
        int? currentAttempt = null;
        SocialPreparationDiagnostic? primaryFailure = null;
        var failureReports = new List<string>();
        SocialPreparationResult? result = null;
        Exception? cleanupFailure = null;
        Exception? disposalFailure = null;
        try
        {
            result = await RunCoreAsync().ConfigureAwait(false);
        }
        catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
        { result = WithFailureReports(FallbackFailure(CurrentPlatform(platforms, firstUnfinishedPlatform), "lifecycle", "caller_cancelled", null, releaseId, currentAttempt, SocialPreparationResultCategory.Cancelled), failureReports, primaryFailure); }
        catch (CdpTransportException ex) when (runtime is not null && capability is not null)
        { result = await GlobalFailureAsync(runtime, capability, platforms, firstUnfinishedPlatform, "cdp_transport_failed", cancellationToken, ex, ex.SocialDiagnostic, releaseId, currentAttempt, "cdp_transport_failed", failureReports, primaryFailure).ConfigureAwait(false); }
        catch (SocialPreparationRuntimeException ex) when (runtime is not null && capability is not null)
        { result = await GlobalFailureAsync(runtime, capability, platforms, firstUnfinishedPlatform, ex.Code, cancellationToken, ex, ex.Diagnostic, releaseId, currentAttempt, "platform_preparation_failed", failureReports, primaryFailure).ConfigureAwait(false); }
        catch (Exception ex)
        {
            result = runtime is null || capability is null
                ? WithFailureReports(FallbackFailure("unknown", runtime is null ? "runtime_setup" : "preparation", "platform_preparation_failed", ex, releaseId, currentAttempt), failureReports, primaryFailure)
                : await GlobalFailureAsync(runtime, capability, platforms, firstUnfinishedPlatform, "platform_preparation_failed", cancellationToken, ex, null, releaseId, currentAttempt, "platform_preparation_failed", failureReports, primaryFailure).ConfigureAwait(false);
        }
        finally
        {
            if (runtime is not null)
            {
                if (capability is not null)
                {
                    try { await runtime.CleanupMediaAsync(capability).ConfigureAwait(false); }
                    catch (Exception ex) { cleanupFailure = ex; }
                }
                try { await runtime.DisposeAsync().ConfigureAwait(false); }
                catch (Exception ex) { disposalFailure = ex; }
            }
        }

        result ??= WithFailureReports(FallbackFailure(CurrentPlatform(platforms, firstUnfinishedPlatform), "lifecycle", "platform_preparation_failed", null, releaseId, currentAttempt), failureReports, primaryFailure);
        if (cleanupFailure is not null) result = AppendCleanupFailure(result, CurrentPlatform(platforms, firstUnfinishedPlatform), "media_cleanup", "media_cleanup_failed", cleanupFailure, releaseId, currentAttempt);
        if (disposalFailure is not null) result = AppendCleanupFailure(result, CurrentPlatform(platforms, firstUnfinishedPlatform), "runtime_disposal", "runtime_dispose_failed", disposalFailure, releaseId, currentAttempt);
        return result;

        async Task<SocialPreparationResult> RunCoreAsync()
        {
            runtime = _createRuntime();
            SocialRedeemResult redeemed = await runtime.RedeemAsync(request, cancellationToken).ConfigureAwait(false);
            if (!redeemed.Success) return FallbackFailure("unknown", "redeem", redeemed.ErrorCode!);
            if (!SocialCapability.TryCreate(redeemed.Response!, out SocialCapability? createdCapability) || createdCapability is null)
                return FallbackFailure("unknown", "capability", "media_token_malformed");
            capability = createdCapability;
            platforms = redeemed.Response!.Platforms;
            releaseId = redeemed.Response.ReleaseId;
            var mediaByPlatform = new Dictionary<string, IReadOnlyList<string>>(StringComparer.Ordinal);
            foreach (SocialRedeemPlatform platform in platforms)
                mediaByPlatform.Add(platform.Platform, await runtime.PrepareMediaAsync(capability, platform, cancellationToken).ConfigureAwait(false));
            BrowserPreparationTargets? browserTargets = await runtime.ConnectBrowserAsync(cancellationToken).ConfigureAwait(false);
            for (int index = 0; index < platforms.Count; index++)
            {
                firstUnfinishedPlatform = index;
                currentAttempt = null;
                SocialRedeemPlatform platform = platforms[index];
                SocialStatusResult probe = await runtime.GetStatusAsync(capability, cancellationToken).ConfigureAwait(false);
                if (!probe.Success) return WithFailureReports(FallbackFailure(platform.Platform, "status_probe", probe.ErrorCode!, null, releaseId, currentAttempt), failureReports, primaryFailure);
                SocialPlatformStatus? platformStatus = probe.Status!.Platforms.SingleOrDefault(row => row.Platform == platform.Platform);
                if (platformStatus is null) return WithFailureReports(FallbackFailure(platform.Platform, "status_probe", "platform_not_in_release", null, releaseId, currentAttempt), failureReports, primaryFailure);
                int? attempt = CurrentAttempt(platformStatus.Attempts);
                currentAttempt = attempt;
                SocialPreparationResult? starting = await WriteAsync(runtime, capability, platform.Platform, "starting", null, null, cancellationToken, releaseId, attempt, "status_starting").ConfigureAwait(false);
                if (starting is not null) return WithFailureReports(starting, failureReports, primaryFailure);
                var progress = new ProgressWriter(runtime, capability, platform.Platform, releaseId, attempt);
                PlatformPreparationResult outcome;
                try
                {
                    outcome = await _adapters.GetRequired(platform.Platform).PrepareAsync(
                        new PlatformPreparationContext(platform.Platform, platform.Title, platform.Body, mediaByPlatform[platform.Platform], browserTargets), progress, cancellationToken).ConfigureAwait(false);
                }
                catch (BrowserPreparationException ex) when (ex.Failure == BrowserPreparationFailure.CrossSessionNode)
                { return await GlobalFailureAsync(runtime, capability, platforms, index, "file_chooser_session_mismatch", cancellationToken, ex, ex.SocialDiagnostic, releaseId, attempt, "platform_preparation_failed", failureReports, primaryFailure).ConfigureAwait(false); }
                catch (BrowserPreparationException ex) { outcome = PlatformPreparationResult.Failed(ex.SocialDiagnostic); }
                catch (CdpTransportException ex)
                { return await GlobalFailureAsync(runtime, capability, platforms, index, "cdp_transport_failed", cancellationToken, ex, ex.SocialDiagnostic, releaseId, attempt, "cdp_transport_failed", failureReports, primaryFailure).ConfigureAwait(false); }
                catch (SocialPreparationRuntimeException ex)
                { return await GlobalFailureAsync(runtime, capability, platforms, index, ex.Code, cancellationToken, ex, ex.Diagnostic, releaseId, attempt, "platform_preparation_failed", failureReports, primaryFailure).ConfigureAwait(false); }
                catch (CdpCommandException ex) { outcome = PlatformPreparationResult.Failed(ex.SocialDiagnostic); }
                catch (SocialPreparationTerminalException ex)
                { return await GlobalFailureAsync(runtime, capability, platforms, index, ex.Code, cancellationToken, ex, null, ex.ReleaseId ?? releaseId, ex.Attempt ?? attempt, "platform_preparation_failed", failureReports, primaryFailure).ConfigureAwait(false); }
                catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
                { return WithFailureReports(FallbackFailure(platform.Platform, "preparation", "caller_cancelled", null, releaseId, attempt, SocialPreparationResultCategory.Cancelled), failureReports, primaryFailure); }
                catch (Exception ex) { outcome = PlatformPreparationResult.Failed(CreateDiagnostic(platform.Platform, "preparation", "platform_preparation_failed", ex, null, releaseId, attempt)); }
                string status = outcome.Outcome switch { PlatformPreparationOutcome.Prepared => "prepared", PlatformPreparationOutcome.AuthenticationRequired => "auth_required", _ => "failed" };
                string? detailCode = outcome.Outcome switch { PlatformPreparationOutcome.AuthenticationRequired => "platform_auth_required", PlatformPreparationOutcome.Failed => "platform_preparation_failed", _ => null };
                SocialPreparationDiagnostic? diagnostic = outcome.Diagnostic;
                if (outcome.Outcome == PlatformPreparationOutcome.Failed)
                {
                    diagnostic ??= CreateDiagnostic(platform.Platform, "preparation_result", detailCode!, null, null, releaseId, attempt);
                    Enrich(diagnostic, releaseId, attempt);
                    failureReports.Add(diagnostic.FormatForDisplay());
                    primaryFailure ??= diagnostic;
                }
                SocialPreparationResult? final = await WriteAsync(runtime, capability, platform.Platform, status, detailCode, diagnostic?.Serialize(), cancellationToken, releaseId, attempt, "status_final", diagnostic, diagnostic?.StableCode).ConfigureAwait(false);
                if (final is not null) return WithFailureReports(final, failureReports, primaryFailure);
            }
            return failureReports.Count == 0
                ? SocialPreparationResult.Completed()
                : SocialPreparationResult.Fail(primaryFailure?.StableCode ?? "platform_preparation_failed", SocialPreparationResultCategory.PreparationFailure, string.Join(Environment.NewLine + Environment.NewLine, failureReports));
        }
    }

    private static async Task<SocialPreparationResult?> WriteAsync(ISocialPreparationRuntime runtime, SocialCapability capability, string platform, string status, string? detailCode, string? message, CancellationToken cancellationToken, int? releaseId, int? attempt, string phase, SocialPreparationDiagnostic? primary = null, string? primaryCode = null)
    {
        SocialPlatformStatusResult result;
        try { result = await runtime.PatchAsync(capability, platform, status, detailCode, message, cancellationToken).ConfigureAwait(false); }
        catch (Exception ex)
        {
            if (primary is not null)
            {
                Enrich(primary, releaseId, attempt);
                primary.SetReportingFailure("status_reporting_failed", ex);
                return SocialPreparationResult.Fail(primaryCode ?? primary.StableCode, SocialPreparationResultCategory.PreparationFailure, primary.FormatForDisplay());
            }
            return FallbackFailure(platform, phase, "status_reporting_failed", ex, releaseId, attempt);
        }
        if (result.Success) return null;
        if (primary is not null)
        {
            Enrich(primary, releaseId, attempt);
            primary.SetReportingFailure(result.ErrorCode!);
            return SocialPreparationResult.Fail(primaryCode ?? primary.StableCode, SocialPreparationResultCategory.PreparationFailure, primary.FormatForDisplay());
        }
        return FallbackFailure(platform, phase, result.ErrorCode!, null, releaseId, attempt);
    }

    private static async Task<SocialPreparationResult> GlobalFailureAsync(ISocialPreparationRuntime runtime, SocialCapability capability, IReadOnlyList<SocialRedeemPlatform> platforms, int firstUnfinishedPlatform, string code, CancellationToken cancellationToken, Exception? exception = null, SocialPreparationDiagnostic? diagnostic = null, int? releaseId = null, int? attempt = null, string detailCode = "platform_preparation_failed", IReadOnlyList<string>? failureReports = null, SocialPreparationDiagnostic? existingPrimary = null)
    {
        SocialPreparationDiagnostic globalDiagnostic = CreateDiagnostic(CurrentPlatform(platforms, firstUnfinishedPlatform), "lifecycle", code, exception, diagnostic, releaseId, attempt);
        SocialPreparationDiagnostic primary = existingPrimary ?? globalDiagnostic;
        var reports = failureReports?.ToList() ?? [];
        if (existingPrimary is not null) reports.Add(globalDiagnostic.FormatForDisplay());
        string message = globalDiagnostic.Serialize();
        for (int index = Math.Clamp(firstUnfinishedPlatform, 0, platforms.Count); index < platforms.Count; index++)
        {
            string status = index == firstUnfinishedPlatform ? "failed" : "cancelled";
            SocialPreparationResult? write = await WriteAsync(runtime, capability, platforms[index].Platform, status, detailCode, index == firstUnfinishedPlatform ? message : null, cancellationToken, releaseId, attempt, "status_reporting", primary, primary.StableCode).ConfigureAwait(false);
            if (write is not null) return WithFailureReports(write, reports, primary);
        }
        return WithFailureReports(FailureAfterRedeem(primary.StableCode, primary.FormatForDisplay()), reports, primary);
    }

    private static SocialPreparationResult WithFailureReports(SocialPreparationResult result, IReadOnlyList<string> reports, SocialPreparationDiagnostic? primary)
    {
        if (reports.Count == 0) return result;
        var detail = reports.ToList();
        if (!string.IsNullOrWhiteSpace(result.Detail) && !detail.Contains(result.Detail, StringComparer.Ordinal)) detail.Add(result.Detail);
        return SocialPreparationResult.Fail(primary?.StableCode ?? result.ErrorCode ?? "platform_preparation_failed", result.Category, string.Join(Environment.NewLine + Environment.NewLine, detail));
    }

    private static SocialPreparationResult AppendCleanupFailure(SocialPreparationResult result, string platform, string phase, string code, Exception exception, int? releaseId, int? attempt)
    {
        SocialPreparationDiagnostic diagnostic = CreateDiagnostic(platform, phase, code, exception, null, releaseId, attempt);
        diagnostic.CaptureCleanup(exception);
        if (result.Success) return SocialPreparationResult.Fail(code, SocialPreparationResultCategory.PreparationFailure, diagnostic.FormatForDisplay());
        string detail = string.IsNullOrWhiteSpace(result.Detail) ? diagnostic.FormatForDisplay() : string.Join(Environment.NewLine + Environment.NewLine, result.Detail, diagnostic.FormatForDisplay());
        return result with { Detail = detail };
    }

    private static SocialPreparationResult FallbackFailure(string platform, string phase, string code, Exception? exception = null, int? releaseId = null, int? attempt = null, SocialPreparationResultCategory? category = null)
    {
        string detail = CreateDiagnostic(platform, phase, code, exception, null, releaseId, attempt).FormatForDisplay();
        return code == "attempt_finished" ? SocialPreparationResult.Finished(detail) : SocialPreparationResult.Fail(code, category ?? CategoryFor(code), detail);
    }
    private static SocialPreparationResult FailureAfterRedeem(string code, string detail) => code == "attempt_finished" ? SocialPreparationResult.Finished(detail) : SocialPreparationResult.Fail(code, CategoryFor(code), detail);
    private static SocialPreparationResultCategory CategoryFor(string code) => code switch { "attempt_finished" => SocialPreparationResultCategory.Finished, "attempt_superseded" => SocialPreparationResultCategory.Superseded, "media_token_missing" or "media_token_malformed" or "media_token_invalid" or "media_token_expired" or "attempt_not_active" or "validation_failed" or "platform_not_in_release" => SocialPreparationResultCategory.CapabilityFailure, _ => SocialPreparationResultCategory.PreparationFailure };
    private static SocialPreparationDiagnostic CreateDiagnostic(string platform, string phase, string code, Exception? exception, SocialPreparationDiagnostic? existing, int? releaseId, int? attempt)
    {
        SocialPreparationDiagnostic? attached = AttachedDiagnostic(exception);
        SocialPreparationDiagnostic diagnostic = existing ?? attached ?? new SocialPreparationDiagnostic(platform, phase, code);
        if (existing is null && attached is null && exception is not null) diagnostic.CapturePrimary(exception);
        Enrich(diagnostic, releaseId, attempt);
        return diagnostic;
    }
    private static SocialPreparationDiagnostic? AttachedDiagnostic(Exception? exception) => exception switch { SocialPreparationRuntimeException ex => ex.Diagnostic, CdpTransportException ex => ex.SocialDiagnostic, CdpCommandException ex => ex.SocialDiagnostic, BrowserPreparationException ex => ex.SocialDiagnostic, _ => null };
    private static void Enrich(SocialPreparationDiagnostic diagnostic, int? releaseId, int? attempt) => diagnostic.SetCorrelation(releaseId, attempt);
    private static string CurrentPlatform(IReadOnlyList<SocialRedeemPlatform> platforms, int index) => index >= 0 && index < platforms.Count ? platforms[index].Platform : "unknown";
    private static int? CurrentAttempt(int attempts) => attempts > 0 ? attempts : null;

    private sealed class ProgressWriter(ISocialPreparationRuntime runtime, SocialCapability capability, string platform, int? releaseId, int? attempt) : IPreparationProgress
    {
        private SocialPreparationProgress? _last;
        public async Task ReportAsync(SocialPreparationProgress progress, CancellationToken cancellationToken)
        {
            if (_last == progress) return;
            _last = progress;
            SocialPlatformStatusResult result = await runtime.PatchAsync(capability, platform, progress == SocialPreparationProgress.Preparing ? "preparing" : "uploading", null, null, cancellationToken).ConfigureAwait(false);
            if (!result.Success) throw new SocialPreparationTerminalException(result.ErrorCode!, releaseId, attempt);
        }
    }
    private sealed class SocialPreparationTerminalException(string code, int? releaseId, int? attempt) : Exception(code)
    {
        public string Code { get; } = code;
        public int? ReleaseId { get; } = releaseId;
        public int? Attempt { get; } = attempt;
    }
}
