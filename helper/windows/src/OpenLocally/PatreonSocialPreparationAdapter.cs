using System.Globalization;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;

namespace OpenLocally;

/// <summary>
/// Prepares a Patreon draft for a named creator without activating its Publish control.
/// Patreon-owned audience, tier, notification, and paywall settings are intentionally untouched.
/// </summary>
public sealed class PatreonSocialPreparationAdapter : ISocialPreparationAdapter
{
    internal static readonly TimeSpan StabilityInterval = TimeSpan.FromMilliseconds(250);
    internal static readonly TimeSpan ReadinessPollInterval = TimeSpan.FromMilliseconds(50);

    private readonly Func<BrowserPreparationTargets, IPatreonPreparationPage> _createPage;
    private readonly bool _requiresBrowserTargets;
    private readonly PatreonTiming _timing;
    private readonly PatreonManualPreparationDiagnostic? _manualDiagnostic;

    /// <summary>
    /// Creates an adapter for the authenticated Patreon creator dashboard identified by <paramref name="creatorVanity"/>.
    /// Registration and provision of the creator vanity are deliberately owned by the later platform-registration work package.
    /// </summary>
    public PatreonSocialPreparationAdapter(string creatorVanity)
        : this(targets => new PatreonPreparationPage(targets, creatorVanity), true, PatreonTiming.System, null)
    {
    }

    internal PatreonSocialPreparationAdapter(string creatorVanity, PatreonManualPreparationDiagnostic manualDiagnostic)
        : this(targets => new PatreonPreparationPage(targets, creatorVanity, null, manualDiagnostic.ObserveCreateActivation), true, PatreonTiming.System, manualDiagnostic)
    {
    }

    internal PatreonSocialPreparationAdapter(
        Func<BrowserPreparationTargets, IPatreonPreparationPage> createPage,
        PatreonTiming? timing = null,
        PatreonManualPreparationDiagnostic? manualDiagnostic = null)
        : this(createPage, false, timing ?? PatreonTiming.System, manualDiagnostic)
    {
    }

    private PatreonSocialPreparationAdapter(
        Func<BrowserPreparationTargets, IPatreonPreparationPage> createPage,
        bool requiresBrowserTargets,
        PatreonTiming timing,
        PatreonManualPreparationDiagnostic? manualDiagnostic)
    {
        _createPage = createPage ?? throw new ArgumentNullException(nameof(createPage));
        _requiresBrowserTargets = requiresBrowserTargets;
        _timing = timing ?? throw new ArgumentNullException(nameof(timing));
        _manualDiagnostic = manualDiagnostic;
    }

    public string Platform => "patreon";

    public async Task<PlatformPreparationResult> PrepareAsync(
        PlatformPreparationContext context,
        IPreparationProgress progress,
        CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(context);
        ArgumentNullException.ThrowIfNull(progress);
        if (!string.Equals(context.Platform, Platform, StringComparison.Ordinal) || (_requiresBrowserTargets && context.BrowserTargets is null))
            throw new SocialPreparationRuntimeException("patreon_browser_unavailable");

        if (_manualDiagnostic is not null && context.BrowserTargets is not null)
            await _manualDiagnostic.CaptureBaselineAsync(context.BrowserTargets).ConfigureAwait(false);
        using CancellationTokenSource operationDeadline = _timing.CreateDeadlineSource();
        using CancellationTokenSource linked = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken, operationDeadline.Token);
        await using IPatreonPreparationPage page = _createPage(context.BrowserTargets!);
        bool preservePage = false;
        PatreonPreparationPhase phase = PatreonPreparationPhase.Home;
        var diagnostic = new SocialPreparationDiagnostic(Platform, "creator_page_ready", "platform_preparation_failed");

        try
        {
            PatreonHomeState home = await page.NavigateAndWaitForHomeAsync(linked.Token).ConfigureAwait(false);
            if (home is PatreonHomeState.AuthenticationRequired or PatreonHomeState.ManualAttentionRequired)
            {
                preservePage = true;
                try { await page.RelinquishAsync(linked.Token).ConfigureAwait(false); }
                catch (OperationCanceledException) when (operationDeadline.IsCancellationRequested && !cancellationToken.IsCancellationRequested) { }
                catch (OperationCanceledException) { throw; }
                catch { }
                return PlatformPreparationResult.AuthenticationRequired();
            }
            if (home != PatreonHomeState.Authenticated) throw new PatreonPreparationException("patreon_home_timeout");
            _manualDiagnostic?.MarkCreatorPageReady();
            diagnostic.Checkpoint("creator_page_ready");
            diagnostic.TargetState("owned_target_created", true);

            phase = PatreonPreparationPhase.Create;
            diagnostic.SetPhase("create_activation");
            bool createActivated;
            Action? createFound = _manualDiagnostic is null ? null : _manualDiagnostic.MarkCreateFound;
            try
            {
                createActivated = await page.ActivateCreateAsync(createFound, linked.Token).ConfigureAwait(false);
            }
            catch (Exception exception)
            {
                _manualDiagnostic?.MarkCreateActivationFailure(
                    exception,
                    operationDeadline.IsCancellationRequested && !cancellationToken.IsCancellationRequested);
                throw;
            }
            finally { diagnostic.SetCreateResolution(page.CreateResolution); }
            if (!createActivated)
                throw new PatreonPreparationException("patreon_create_control_missing");
            _manualDiagnostic?.MarkCreateActivated();
            diagnostic.Checkpoint("create_activated");

            phase = PatreonPreparationPhase.Post;
            Action? postFound = _manualDiagnostic is null ? null : _manualDiagnostic.MarkPostFound;
            if (!await page.ActivatePostEntryAsync(postFound, linked.Token).ConfigureAwait(false))
                throw new PatreonPreparationException("patreon_post_control_missing");
            _manualDiagnostic?.MarkPostActivated();
            diagnostic.SetPhase("post_activation");
            diagnostic.Checkpoint("post_activated");

            phase = PatreonPreparationPhase.Composer;
            IPatreonComposer? composer = await page.WaitForComposerAsync(linked.Token).ConfigureAwait(false);
            if (composer is null) throw new PatreonPreparationException("patreon_composer_missing");
            _manualDiagnostic?.MarkComposerRouteObserved();
            diagnostic.SetPhase("composer_route");
            diagnostic.Checkpoint("composer_route_observed");

            phase = PatreonPreparationPhase.Title;
            await progress.ReportAsync(SocialPreparationProgress.Preparing, linked.Token).ConfigureAwait(false);
            if (!await composer.ReplaceAndVerifyTitleAsync(context.Title, linked.Token).ConfigureAwait(false))
                throw new PatreonPreparationException("patreon_title_mismatch");

            phase = PatreonPreparationPhase.Body;
            if (!await composer.ReplaceAndVerifyBodyAsync(context.Body, linked.Token).ConfigureAwait(false))
                throw new PatreonPreparationException("patreon_body_mismatch");
            diagnostic.Checkpoint("text_verified");

            var expectedPreviewNodeIds = new List<int>();
            if (context.MediaPaths.Count > 0)
            {
                // Validate the whole caller sequence before attaching any file, so a later unsupported path cannot partially mutate the draft.
                if (context.MediaPaths.Any(path => !PatreonComposer.IsVerifiedImagePath(path)))
                    throw new PatreonPreparationException("patreon_media_unsupported_type");

                IReadOnlyList<int>? initialPreviewNodeIds = (await composer.ReadReadinessAsync(0, linked.Token).ConfigureAwait(false)).PreviewNodeIds;
                if (initialPreviewNodeIds is not { Count: 0 })
                    throw new PatreonPreparationException("patreon_media_preview_incomplete");

                phase = PatreonPreparationPhase.MediaAssignment;
                await progress.ReportAsync(SocialPreparationProgress.Uploading, linked.Token).ConfigureAwait(false);
                foreach (string mediaPath in context.MediaPaths)
                {
                    PatreonMediaAssignment assignment = await composer.AttachImagesAsync(new[] { mediaPath }, linked.Token).ConfigureAwait(false);
                    if (assignment == PatreonMediaAssignment.InputMissing) throw new PatreonPreparationException("patreon_media_input_missing");
                    if (assignment == PatreonMediaAssignment.UnsupportedType) throw new PatreonPreparationException("patreon_media_unsupported_type");
                    if (assignment != PatreonMediaAssignment.Assigned) throw new PatreonPreparationException("patreon_media_assignment_failed");
                    diagnostic.SetPhase("media_assignment");
                    diagnostic.Checkpoint("media_assigned");

                    phase = PatreonPreparationPhase.MediaReadiness;
                    expectedPreviewNodeIds.Add(await RequireNextPreviewNodeIdAsync(composer, expectedPreviewNodeIds, _timing, linked.Token).ConfigureAwait(false));
                }

                await RequireStableReadyAsync(composer, expectedPreviewNodeIds, _timing, linked.Token).ConfigureAwait(false);
                diagnostic.SetPhase("media_readiness");
                diagnostic.Checkpoint("media_ready");
            }

            phase = PatreonPreparationPhase.FinalAssertions;
            if (!await composer.VerifyTitleAsync(context.Title, linked.Token).ConfigureAwait(false) ||
                !await composer.VerifyBodyAsync(context.Body, linked.Token).ConfigureAwait(false))
                throw new PatreonPreparationException("patreon_prepared_assertion_failed");

            if (context.MediaPaths.Count > 0)
                await RequireStableReadyAsync(composer, expectedPreviewNodeIds, _timing, linked.Token).ConfigureAwait(false);

            PatreonFinalState final = await RequireStableFinalStateAsync(composer, _timing, linked.Token).ConfigureAwait(false);
            if (final.HasValidationError) throw new PatreonPreparationException("patreon_validation_error");
            if (!final.SaveIsSaved || !final.PublishExists || !final.PublishEnabled)
                throw new PatreonPreparationException("patreon_prepared_assertion_failed");
            if (!await page.IsExpectedComposerRouteAsync(linked.Token).ConfigureAwait(false))
                throw new PatreonPreparationException("patreon_prepared_assertion_failed");
            diagnostic.SetPhase("final_publish_assertion");
            diagnostic.Checkpoint("final_publish_asserted");

            phase = PatreonPreparationPhase.Relinquish;
            try
            {
                await page.RelinquishAsync(linked.Token).ConfigureAwait(false);
            }
            catch (OperationCanceledException) when (operationDeadline.IsCancellationRequested && !cancellationToken.IsCancellationRequested)
            {
                throw new PatreonPreparationException("patreon_relinquish_failed");
            }
            catch (BrowserPreparationException)
            {
                throw new PatreonPreparationException("patreon_relinquish_failed");
            }
            preservePage = true;
            diagnostic.TargetState("target_relinquished", true);
            return PlatformPreparationResult.Prepared();
        }
        catch (OperationCanceledException) when (operationDeadline.IsCancellationRequested && !cancellationToken.IsCancellationRequested)
        {
            throw Failure(TimeoutCode(phase), diagnostic, phase, new TimeoutException());
        }
        catch (PatreonPreparationException exception)
        {
            throw Failure(exception.Code, diagnostic, phase, exception);
        }
        catch (CdpTransportException exception)
        {
            diagnostic.SetPhase(Phase(phase));
            diagnostic.CapturePrimary(exception);
            exception.AttachSocialDiagnostic(diagnostic);
            throw;
        }
        catch (CdpCommandException exception)
        {
            diagnostic.SetPhase(Phase(phase));
            diagnostic.SetStableCode("platform_preparation_failed");
            diagnostic.CapturePrimary(exception);
            exception.AttachSocialDiagnostic(diagnostic);
            throw;
        }
        catch (BrowserPreparationException exception) when (exception.Failure is BrowserPreparationFailure.InvalidTarget or BrowserPreparationFailure.NotOwnedTarget)
        {
            throw Failure(phase == PatreonPreparationPhase.Relinquish ? "patreon_relinquish_failed" : "patreon_target_closed", diagnostic, phase, exception);
        }
        catch (ObjectDisposedException)
        {
            throw Failure(phase == PatreonPreparationPhase.Relinquish ? "patreon_relinquish_failed" : "patreon_target_closed", diagnostic, phase, new ObjectDisposedException("target"));
        }
        catch (BrowserPreparationException exception)
        {
            diagnostic.SetPhase(Phase(phase));
            diagnostic.SetStableCode("platform_preparation_failed");
            diagnostic.CapturePrimary(exception);
            exception.AttachSocialDiagnostic(diagnostic);
            throw;
        }
        catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
        {
            throw;
        }
        catch (Exception exception)
        {
            throw Failure("platform_preparation_failed", diagnostic, phase, exception);
        }
        finally
        {
            if (!preservePage)
            {
                if (_manualDiagnostic is not null && context.BrowserTargets is not null)
                    await _manualDiagnostic.CaptureTopologyAsync(context.BrowserTargets, page.OwnedTargetId).ConfigureAwait(false);
                diagnostic.TargetState("cleanup_attempted", true);
                try { await page.AbandonAsync(cancellationToken).ConfigureAwait(false); diagnostic.TargetState("cleanup_succeeded", true); }
                catch (Exception exception) { diagnostic.TargetState("cleanup_succeeded", false); diagnostic.CaptureCleanup(exception, operationDeadline.IsCancellationRequested); }
            }
        }
    }

    private static SocialPreparationRuntimeException Failure(string code, SocialPreparationDiagnostic diagnostic, PatreonPreparationPhase phase, Exception exception)
    {
        diagnostic.SetPhase(Phase(phase));
        diagnostic.SetStableCode(code);
        diagnostic.CapturePrimary(exception);
        diagnostic.TargetState("target_still_present", true);
        return new SocialPreparationRuntimeException(code, exception, diagnostic);
    }

    private static string Phase(PatreonPreparationPhase phase) => phase switch
    {
        PatreonPreparationPhase.Home => "creator_page_ready", PatreonPreparationPhase.Create => "create_activation",
        PatreonPreparationPhase.Post => "post_activation", PatreonPreparationPhase.Composer => "composer_route",
        PatreonPreparationPhase.Title => "title", PatreonPreparationPhase.Body => "body", PatreonPreparationPhase.MediaAssignment => "media_assignment",
        PatreonPreparationPhase.MediaReadiness => "media_readiness", PatreonPreparationPhase.FinalAssertions => "final_publish_assertion",
        PatreonPreparationPhase.Relinquish => "relinquish", _ => "unknown",
    };

    private static string TimeoutCode(PatreonPreparationPhase phase) => phase switch
    {
        PatreonPreparationPhase.Home => "patreon_home_timeout",
        PatreonPreparationPhase.Create => "patreon_create_control_missing",
        PatreonPreparationPhase.Post => "patreon_post_control_missing",
        PatreonPreparationPhase.Composer => "patreon_composer_missing",
        PatreonPreparationPhase.Title => "patreon_title_mismatch",
        PatreonPreparationPhase.Body => "patreon_body_mismatch",
        PatreonPreparationPhase.MediaAssignment => "patreon_media_assignment_failed",
        PatreonPreparationPhase.MediaReadiness => "patreon_media_not_ready",
        PatreonPreparationPhase.FinalAssertions => "patreon_prepared_assertion_failed",
        PatreonPreparationPhase.Relinquish => "patreon_relinquish_failed",
        _ => throw new ArgumentOutOfRangeException(nameof(phase)),
    };

    private static async Task<int> RequireNextPreviewNodeIdAsync(
        IPatreonComposer composer,
        IReadOnlyList<int> mappedPreviewNodeIds,
        PatreonTiming timing,
        CancellationToken cancellationToken)
    {
        DateTimeOffset deadline = timing.UtcNow() + timing.ReadinessTimeout;
        PatreonReadiness? last = null;
        while (timing.UtcNow() < deadline)
        {
            last = await composer.ReadReadinessAsync(mappedPreviewNodeIds.Count + 1, cancellationToken).ConfigureAwait(false);
            if (last.HasError) ThrowForReadiness(last, mappedPreviewNodeIds);
            if (HasIrrecoverablePreviewTopology(last.PreviewNodeIds, mappedPreviewNodeIds))
                throw new PatreonPreparationException("patreon_media_preview_incomplete");
            if (TryMapNextPreviewNodeId(last, mappedPreviewNodeIds, out int mappedNodeId)) return mappedNodeId;

            TimeSpan remaining = deadline - timing.UtcNow();
            if (remaining <= TimeSpan.Zero) break;
            await timing.DelayAsync(remaining < ReadinessPollInterval ? remaining : ReadinessPollInterval, cancellationToken).ConfigureAwait(false);
        }

        ThrowForReadiness(last ?? new PatreonReadiness(false, false, false, true, false, false), mappedPreviewNodeIds);
        throw new PatreonPreparationException("patreon_media_not_ready");
    }

    private static async Task RequireStableReadyAsync(
        IPatreonComposer composer,
        IReadOnlyList<int> expectedPreviewNodeIds,
        PatreonTiming timing,
        CancellationToken cancellationToken)
    {
        DateTimeOffset deadline = timing.UtcNow() + timing.ReadinessTimeout;
        PatreonReadiness? first = null;
        PatreonReadiness? last = null;
        while (timing.UtcNow() < deadline)
        {
            last = await composer.ReadReadinessAsync(expectedPreviewNodeIds.Count, cancellationToken).ConfigureAwait(false);
            if (IsReady(last, expectedPreviewNodeIds))
            {
                first = last;
                break;
            }

            TimeSpan remaining = deadline - timing.UtcNow();
            if (remaining <= TimeSpan.Zero) break;
            await timing.DelayAsync(remaining < ReadinessPollInterval ? remaining : ReadinessPollInterval, cancellationToken).ConfigureAwait(false);
        }

        if (first is null) ThrowForReadiness(last ?? new PatreonReadiness(false, false, false, true, false, false), expectedPreviewNodeIds);
        if (timing.UtcNow() >= deadline) throw new PatreonPreparationException("patreon_media_not_ready");
        await timing.DelayAsync(StabilityInterval, cancellationToken).ConfigureAwait(false);
        if (timing.UtcNow() >= deadline) throw new PatreonPreparationException("patreon_media_not_ready");
        ThrowForReadiness(await composer.ReadReadinessAsync(expectedPreviewNodeIds.Count, cancellationToken).ConfigureAwait(false), expectedPreviewNodeIds);
    }

    private static bool TryMapNextPreviewNodeId(PatreonReadiness readiness, IReadOnlyList<int> mappedPreviewNodeIds, out int mappedNodeId)
    {
        mappedNodeId = 0;
        if (!readiness.PreviewCountMatches || !readiness.ImagesRendered || !readiness.OrderObserved || readiness.PreviewNodeIds is null ||
            readiness.PreviewNodeIds.Count != mappedPreviewNodeIds.Count + 1 ||
            !readiness.PreviewNodeIds.Take(mappedPreviewNodeIds.Count).SequenceEqual(mappedPreviewNodeIds)) return false;

        mappedNodeId = readiness.PreviewNodeIds[^1];
        return !mappedPreviewNodeIds.Contains(mappedNodeId) && readiness.PreviewNodeIds.Distinct().Count() == readiness.PreviewNodeIds.Count;
    }

    private static bool HasIrrecoverablePreviewTopology(IReadOnlyList<int>? currentPreviewNodeIds, IReadOnlyList<int> mappedPreviewNodeIds)
    {
        if (currentPreviewNodeIds is null) return false;
        if (currentPreviewNodeIds.Distinct().Count() != currentPreviewNodeIds.Count ||
            currentPreviewNodeIds.Count > mappedPreviewNodeIds.Count + 1) return true;
        for (int index = 0; index < Math.Min(currentPreviewNodeIds.Count, mappedPreviewNodeIds.Count); index++)
        {
            if (currentPreviewNodeIds[index] != mappedPreviewNodeIds[index]) return true;
        }
        return currentPreviewNodeIds.Count < mappedPreviewNodeIds.Count;
    }

    private static bool IsReady(PatreonReadiness readiness, IReadOnlyList<int> expectedPreviewNodeIds) =>
        readiness.PreviewCountMatches && readiness.ImagesRendered && readiness.OrderObserved &&
        readiness.PreviewNodeIds is not null && readiness.PreviewNodeIds.SequenceEqual(expectedPreviewNodeIds) &&
        !readiness.IsBusy && !readiness.HasError && readiness.SaveIsSaved;

    private static void ThrowForReadiness(PatreonReadiness readiness, IReadOnlyList<int> expectedPreviewNodeIds)
    {
        if (readiness.HasError) throw new PatreonPreparationException("patreon_media_error");
        if (!readiness.PreviewCountMatches || !readiness.ImagesRendered || !readiness.OrderObserved ||
            readiness.PreviewNodeIds is null || !readiness.PreviewNodeIds.SequenceEqual(expectedPreviewNodeIds))
            throw new PatreonPreparationException("patreon_media_preview_incomplete");
        if (readiness.IsBusy || !readiness.SaveIsSaved) throw new PatreonPreparationException("patreon_media_not_ready");
    }

    private static async Task<PatreonFinalState> RequireStableFinalStateAsync(
        IPatreonComposer composer,
        PatreonTiming timing,
        CancellationToken cancellationToken)
    {
        DateTimeOffset deadline = timing.UtcNow() + timing.ReadinessTimeout;
        PatreonFinalState? first = null;
        while (timing.UtcNow() < deadline)
        {
            PatreonFinalState current = await composer.ReadFinalStateAsync(cancellationToken).ConfigureAwait(false);
            if (current.HasValidationError) return current;
            if (current.SaveIsSaved)
            {
                first = current;
                break;
            }

            TimeSpan remaining = deadline - timing.UtcNow();
            if (remaining <= TimeSpan.Zero) break;
            await timing.DelayAsync(remaining < ReadinessPollInterval ? remaining : ReadinessPollInterval, cancellationToken).ConfigureAwait(false);
        }

        if (first is null) throw new PatreonPreparationException("patreon_prepared_assertion_failed");
        if (timing.UtcNow() >= deadline) throw new PatreonPreparationException("patreon_prepared_assertion_failed");
        await timing.DelayAsync(StabilityInterval, cancellationToken).ConfigureAwait(false);
        if (timing.UtcNow() >= deadline) throw new PatreonPreparationException("patreon_prepared_assertion_failed");
        return await composer.ReadFinalStateAsync(cancellationToken).ConfigureAwait(false);
    }
}

internal sealed class PatreonTiming
{
    internal static PatreonTiming System { get; } = new(BrowserPreparationSession.DefaultReadinessTimeout, () => DateTimeOffset.UtcNow, Task.Delay);
    private readonly Func<TimeSpan, CancellationTokenSource> _createDeadlineSource;

    internal PatreonTiming(
        TimeSpan readinessTimeout,
        Func<DateTimeOffset> utcNow,
        Func<TimeSpan, CancellationToken, Task> delayAsync,
        Func<TimeSpan, CancellationTokenSource>? createDeadlineSource = null)
    {
        ReadinessTimeout = readinessTimeout > TimeSpan.Zero ? readinessTimeout : throw new ArgumentOutOfRangeException(nameof(readinessTimeout));
        UtcNow = utcNow ?? throw new ArgumentNullException(nameof(utcNow));
        DelayAsync = delayAsync ?? throw new ArgumentNullException(nameof(delayAsync));
        _createDeadlineSource = createDeadlineSource ?? (timeout => new CancellationTokenSource(timeout));
    }

    internal TimeSpan ReadinessTimeout { get; }
    internal Func<DateTimeOffset> UtcNow { get; }
    internal Func<TimeSpan, CancellationToken, Task> DelayAsync { get; }
    internal CancellationTokenSource CreateDeadlineSource() => _createDeadlineSource(ReadinessTimeout);
}

internal enum PatreonPreparationPhase { Home, Create, Post, Composer, Title, Body, MediaAssignment, MediaReadiness, FinalAssertions, Relinquish }
internal enum PatreonCreateActivationStage { NotStarted, NodeReady, ScrollReady, BoxReady, MousePressSent, MouseReleaseSent, Completed }
internal enum PatreonCreateActivationErrorClass { None, BrowserPreparation, CdpCommand, CdpTransport, TargetClosed, Timeout, Unexpected }
internal enum PatreonCreateActivationCdpMethod { None, ScrollIntoView, GetBoxModel, MousePress, MouseRelease, Unknown }
internal enum PatreonHomeState { Authenticated, AuthenticationRequired, ManualAttentionRequired, TimedOut }
internal enum PatreonMediaAssignment { Assigned, InputMissing, UnsupportedType, Failed }
internal sealed record PatreonReadiness(
    bool PreviewCountMatches,
    bool ImagesRendered,
    bool OrderObserved,
    bool IsBusy,
    bool HasError,
    bool SaveIsSaved,
    IReadOnlyList<int>? PreviewNodeIds = null);
internal sealed record PatreonFinalState(bool PublishExists, bool PublishEnabled, bool SaveIsSaved, bool HasValidationError);

internal interface IPatreonPreparationPage : IAsyncDisposable
{
    PatreonCreateResolutionEvidence? CreateResolution => null;
    string? OwnedTargetId { get; }
    Task<PatreonHomeState> NavigateAndWaitForHomeAsync(CancellationToken cancellationToken);
    Task<bool> ActivateCreateAsync(Action? createFound, CancellationToken cancellationToken);
    Task<bool> ActivatePostEntryAsync(Action? postFound, CancellationToken cancellationToken);
    Task<IPatreonComposer?> WaitForComposerAsync(CancellationToken cancellationToken);
    Task<bool> IsExpectedComposerRouteAsync(CancellationToken cancellationToken);
    Task RelinquishAsync(CancellationToken cancellationToken);
    Task AbandonAsync(CancellationToken cancellationToken);
}

internal interface IPatreonComposer
{
    Task<bool> ReplaceAndVerifyTitleAsync(string title, CancellationToken cancellationToken);
    Task<bool> ReplaceAndVerifyBodyAsync(string body, CancellationToken cancellationToken);
    Task<PatreonMediaAssignment> AttachImagesAsync(IReadOnlyList<string> paths, CancellationToken cancellationToken);
    Task<PatreonReadiness> ReadReadinessAsync(int intendedCount, CancellationToken cancellationToken);
    Task<bool> VerifyTitleAsync(string title, CancellationToken cancellationToken);
    Task<bool> VerifyBodyAsync(string body, CancellationToken cancellationToken);
    Task<PatreonFinalState> ReadFinalStateAsync(CancellationToken cancellationToken);
}

internal sealed class PatreonPreparationException(string code) : Exception(code)
{
    internal string Code { get; } = code;
}

/// <summary>Manual-only, bounded Patreon preparation trace. It retains target identities only long enough to compare snapshots.</summary>
internal sealed class PatreonManualPreparationDiagnostic
{
    private const int StableErrorCodeMaxLength = 64;
    internal const int CdpMessageMaxLength = 192;
    private const int CdpMessageSourceMaxLength = 1024;
    private const string CdpMessageTruncationIndicator = "[truncated]";
    internal const int MaximumTraceLength = 658;
    private static readonly Regex UrlPattern = new(@"\b[a-z][a-z0-9+.-]*://[^\s;,]+", RegexOptions.IgnoreCase | RegexOptions.CultureInvariant);
    private static readonly Regex PathPattern = new(@"(?<!\w)(?:[a-z]:\\|/)[^\s;,]+", RegexOptions.IgnoreCase | RegexOptions.CultureInvariant);
    private static readonly Regex HtmlElementPattern = new(@"<[^>]*>.*?</[^>]*>", RegexOptions.CultureInvariant);
    private static readonly Regex HtmlPattern = new(@"<[^>]*>|<.*$", RegexOptions.CultureInvariant);
    private static readonly Regex SensitiveValuePattern = new(@"\b(?:[\w-]*(?:token|cookie)[\w-]*|authorization|session(?:[-_ ]?id)?|target(?:[-_ ]?id)?|session(?:[-_ ]?id)?|backend[-_ ]?node[-_ ]?id|node[-_ ]?id|creator(?:[-_ ]?vanity)?|vanity|title|body)\b\s*(?::|=)\s*[^\s;,]+", RegexOptions.IgnoreCase | RegexOptions.CultureInvariant);
    private static readonly Regex NamedIdPattern = new(@"\b(?:target|session|backend\s*node|node)\s+id\s+[^\s;,]+", RegexOptions.IgnoreCase | RegexOptions.CultureInvariant);

    private HashSet<string>? _baselineTargetIds;
    private bool _creatorPageReady;
    private bool _createFound;
    private bool _createActivated;
    private PatreonCreateActivationStage _createActivationStage;
    private PatreonCreateActivationErrorClass _createActivationErrorClass;
    private PatreonCreateActivationCdpMethod _createActivationCdpMethod;
    private string _createActivationCdpCode = "unknown";
    private string _createActivationCdpMessage = "none";
    private bool _postFound;
    private bool _postActivated;
    private bool _composerRouteObserved;
    private bool? _originalTargetPresent;
    private bool? _replacementTargetAppeared;

    internal void MarkCreatorPageReady() => _creatorPageReady = true;
    internal void MarkCreateFound() => _createFound = true;
    internal void MarkCreateActivated() => _createActivated = true;
    internal void ObserveCreateActivation(BrowserPreparationActivationStage stage) => _createActivationStage = stage switch
    {
        BrowserPreparationActivationStage.NodeReady => PatreonCreateActivationStage.NodeReady,
        BrowserPreparationActivationStage.ScrollReady => PatreonCreateActivationStage.ScrollReady,
        BrowserPreparationActivationStage.BoxReady => PatreonCreateActivationStage.BoxReady,
        BrowserPreparationActivationStage.MousePressSent => PatreonCreateActivationStage.MousePressSent,
        BrowserPreparationActivationStage.MouseReleaseSent => PatreonCreateActivationStage.MouseReleaseSent,
        BrowserPreparationActivationStage.Completed => PatreonCreateActivationStage.Completed,
        _ => throw new ArgumentOutOfRangeException(nameof(stage)),
    };
    internal void MarkCreateActivationFailure(Exception exception, bool timedOut)
    {
        _createActivationErrorClass = exception switch
        {
            BrowserPreparationException { Failure: BrowserPreparationFailure.InvalidTarget or BrowserPreparationFailure.NotOwnedTarget } => PatreonCreateActivationErrorClass.TargetClosed,
            BrowserPreparationException => PatreonCreateActivationErrorClass.BrowserPreparation,
            CdpCommandException => PatreonCreateActivationErrorClass.CdpCommand,
            CdpTransportException => PatreonCreateActivationErrorClass.CdpTransport,
            ObjectDisposedException => PatreonCreateActivationErrorClass.TargetClosed,
            TimeoutException => PatreonCreateActivationErrorClass.Timeout,
            OperationCanceledException when timedOut => PatreonCreateActivationErrorClass.Timeout,
            _ => PatreonCreateActivationErrorClass.Unexpected,
        };
        if (exception is CdpCommandException cdpException)
        {
            _createActivationCdpMethod = _createActivationStage switch
            {
                PatreonCreateActivationStage.NodeReady => PatreonCreateActivationCdpMethod.ScrollIntoView,
                PatreonCreateActivationStage.ScrollReady => PatreonCreateActivationCdpMethod.GetBoxModel,
                PatreonCreateActivationStage.BoxReady => PatreonCreateActivationCdpMethod.MousePress,
                PatreonCreateActivationStage.MousePressSent => PatreonCreateActivationCdpMethod.MouseRelease,
                _ => PatreonCreateActivationCdpMethod.Unknown,
            };
            _createActivationCdpCode = cdpException.Code.ToString(CultureInfo.InvariantCulture);
            _createActivationCdpMessage = BoundedCdpMessage(cdpException.Message);
        }
    }
    internal void MarkPostFound() => _postFound = true;
    internal void MarkPostActivated() => _postActivated = true;
    internal void MarkComposerRouteObserved() => _composerRouteObserved = true;

    internal async Task CaptureBaselineAsync(BrowserPreparationTargets targets)
    {
        try
        {
            _baselineTargetIds = (await targets.GetPreparatablePagesAsync(cancellationToken: CancellationToken.None).ConfigureAwait(false))
                .Select(target => target.TargetId)
                .ToHashSet(StringComparer.Ordinal);
        }
        catch
        {
            _baselineTargetIds = null;
        }
    }

    internal async Task CaptureTopologyAsync(BrowserPreparationTargets targets, string? originalTargetId)
    {
        if (_baselineTargetIds is null || string.IsNullOrWhiteSpace(originalTargetId)) return;
        try
        {
            IReadOnlyList<CdpTargetInfo> current = await targets
                .GetPreparatablePagesAsync(cancellationToken: CancellationToken.None)
                .ConfigureAwait(false);
            _originalTargetPresent = current.Any(target => string.Equals(target.TargetId, originalTargetId, StringComparison.Ordinal));
            _replacementTargetAppeared = current.Any(target =>
                !string.Equals(target.TargetId, originalTargetId, StringComparison.Ordinal) &&
                !_baselineTargetIds.Contains(target.TargetId));
        }
        catch
        {
            _originalTargetPresent = null;
            _replacementTargetAppeared = null;
        }
    }

    internal string Format(string errorCode) => string.Join(';',
        "patreon_manual_trace",
        $"creator_page_ready={Boolean(_creatorPageReady)}",
        $"create_found={Boolean(_createFound)}",
        $"create_activated={Boolean(_createActivated)}",
        $"post_found={Boolean(_postFound)}",
        $"post_activated={Boolean(_postActivated)}",
        $"composer_route_observed={Boolean(_composerRouteObserved)}",
        $"create_activation_stage={CreateActivationStage(_createActivationStage)}",
        $"create_activation_error_class={CreateActivationErrorClass(_createActivationErrorClass)}",
        $"create_activation_cdp_method={CreateActivationCdpMethod(_createActivationCdpMethod)}",
        $"create_activation_cdp_code={_createActivationCdpCode}",
        $"create_activation_cdp_message={_createActivationCdpMessage}",
        $"original_target_present={Boolean(_originalTargetPresent)}",
        $"replacement_target_appeared={Boolean(_replacementTargetAppeared)}",
        $"error={StableErrorCode(errorCode)}");

    private static string Boolean(bool value) => value ? "1" : "0";
    private static string Boolean(bool? value) => value is null ? "unknown" : Boolean(value.Value);
    private static string CreateActivationStage(PatreonCreateActivationStage stage) => stage switch
    {
        PatreonCreateActivationStage.NotStarted => "not_started",
        PatreonCreateActivationStage.NodeReady => "node_ready",
        PatreonCreateActivationStage.ScrollReady => "scroll_ready",
        PatreonCreateActivationStage.BoxReady => "box_ready",
        PatreonCreateActivationStage.MousePressSent => "mouse_press_sent",
        PatreonCreateActivationStage.MouseReleaseSent => "mouse_release_sent",
        PatreonCreateActivationStage.Completed => "completed",
        _ => throw new ArgumentOutOfRangeException(nameof(stage)),
    };
    private static string CreateActivationErrorClass(PatreonCreateActivationErrorClass errorClass) => errorClass switch
    {
        PatreonCreateActivationErrorClass.None => "none",
        PatreonCreateActivationErrorClass.BrowserPreparation => "browser_preparation",
        PatreonCreateActivationErrorClass.CdpCommand => "cdp_command",
        PatreonCreateActivationErrorClass.CdpTransport => "cdp_transport",
        PatreonCreateActivationErrorClass.TargetClosed => "target_closed",
        PatreonCreateActivationErrorClass.Timeout => "timeout",
        PatreonCreateActivationErrorClass.Unexpected => "unexpected",
        _ => throw new ArgumentOutOfRangeException(nameof(errorClass)),
    };
    private static string CreateActivationCdpMethod(PatreonCreateActivationCdpMethod method) => method switch
    {
        PatreonCreateActivationCdpMethod.None => "none",
        PatreonCreateActivationCdpMethod.ScrollIntoView => "scroll_into_view",
        PatreonCreateActivationCdpMethod.GetBoxModel => "get_box_model",
        PatreonCreateActivationCdpMethod.MousePress => "mouse_press",
        PatreonCreateActivationCdpMethod.MouseRelease => "mouse_release",
        PatreonCreateActivationCdpMethod.Unknown => "unknown",
        _ => throw new ArgumentOutOfRangeException(nameof(method)),
    };

    private static string BoundedCdpMessage(string? message)
    {
        string sanitized = SocialPreparationDiagnostic.SanitizeMessage(message);
        return sanitized.Length <= CdpMessageMaxLength ? sanitized : string.Concat(sanitized.AsSpan(0, CdpMessageMaxLength - CdpMessageTruncationIndicator.Length), CdpMessageTruncationIndicator);
    }

    private static string StableErrorCode(string errorCode) =>
        !string.IsNullOrWhiteSpace(errorCode) && errorCode.Length <= StableErrorCodeMaxLength && errorCode.All(character =>
            character is >= 'a' and <= 'z' or >= '0' and <= '9' or '_')
            ? errorCode
            : "manual_patreon_validation_failed";
}

/// <summary>Bounded Patreon CDP implementation. It does not evaluate scripts or activate final publication controls.</summary>
internal sealed class PatreonPreparationPage : IPatreonPreparationPage
{
    private const int CreateCandidateLimit = 16;
    private const string Create = "button[data-tag='create-content-button'][aria-label='Create post'][aria-haspopup='menu']";
    private const string PostEntry = "button[data-tag='create-content-option-POST'][role='menuitem']";
    private const string Title = "textarea[aria-label='Title'][placeholder='Title']";
    private const string Editor = "[data-tag='text-editor-remirror-wrapper'] [contenteditable='true'][role='textbox'][aria-label='Text input field for post content']";
    private const string Publish = "button[data-tag='make-a-post-action-publish']";
    private const string LoginControl = "form[action*='login'], input[type='password'], button[data-tag*='login']";
    private const string ManualAttention = "form[action*='challenge'], iframe[src*='captcha'], [data-testid*='captcha'], [data-tag*='challenge'], [data-tag*='verification']";

    private readonly BrowserPreparationTargets _targets;
    private readonly PatreonTiming _timing;
    private readonly string _creatorVanitySegment;
    private readonly string _homeUrl;
    private readonly Action<BrowserPreparationActivationStage>? _createActivationObserver;
    private BrowserPreparationSession? _page;
    private bool _terminal;

    internal PatreonPreparationPage(
        BrowserPreparationTargets targets,
        string creatorVanity,
        PatreonTiming? timing = null,
        Action<BrowserPreparationActivationStage>? createActivationObserver = null)
    {
        _targets = targets ?? throw new ArgumentNullException(nameof(targets));
        if (string.IsNullOrWhiteSpace(creatorVanity) || creatorVanity.Contains('/', StringComparison.Ordinal) || creatorVanity.Any(char.IsControl))
            throw new ArgumentException("A single Patreon creator vanity segment is required.", nameof(creatorVanity));
        _creatorVanitySegment = Uri.EscapeDataString(creatorVanity);
        _homeUrl = $"https://www.patreon.com/c/{_creatorVanitySegment}";
        _timing = timing ?? PatreonTiming.System;
        _createActivationObserver = createActivationObserver;
    }

    public async Task<PatreonHomeState> NavigateAndWaitForHomeAsync(CancellationToken cancellationToken)
    {
        _page = await _targets.CreateOwnedAsync(cancellationToken: cancellationToken).ConfigureAwait(false);
        await _page.NavigateAsync(_homeUrl, cancellationToken: cancellationToken).ConfigureAwait(false);
        await _page.WaitForDocumentAsync(cancellationToken: cancellationToken).ConfigureAwait(false);
        while (true)
        {
            if (await IsLoginPageAsync(cancellationToken).ConfigureAwait(false)) return PatreonHomeState.AuthenticationRequired;
            if (await HasRenderedEvidenceAsync(ManualAttention, cancellationToken).ConfigureAwait(false))
                return PatreonHomeState.ManualAttentionRequired;
            if (await FindFreshFromDocumentAsync(Create, cancellationToken).ConfigureAwait(false) is not null)
                return PatreonHomeState.Authenticated;
            await _timing.DelayAsync(PatreonSocialPreparationAdapter.ReadinessPollInterval, cancellationToken).ConfigureAwait(false);
        }
    }

    public string? OwnedTargetId => _page?.TargetId;
    public PatreonCreateResolutionEvidence? CreateResolution { get; private set; }

    public async Task<bool> ActivateCreateAsync(Action? createFound, CancellationToken cancellationToken)
    {
        BrowserDomNode? create = await ResolveCreateAsync(cancellationToken).ConfigureAwait(false);
        if (create is null) return false;
        createFound?.Invoke();
        await RequirePage().ActivateAsync(create, _createActivationObserver, cancellationToken).ConfigureAwait(false);
        ObserveCreateActivationCompleted();
        return true;
    }

    public async Task<bool> ActivatePostEntryAsync(Action? postFound, CancellationToken cancellationToken)
    {
        while (true)
        {
            BrowserDomNode? post = await FindFreshFromDocumentAsync(PostEntry, cancellationToken).ConfigureAwait(false);
            if (post is not null)
            {
                postFound?.Invoke();
                await RequirePage().ActivateAsync(post, cancellationToken).ConfigureAwait(false);
                return true;
            }

            await _timing.DelayAsync(PatreonSocialPreparationAdapter.ReadinessPollInterval, cancellationToken).ConfigureAwait(false);
        }
    }

    public async Task<IPatreonComposer?> WaitForComposerAsync(CancellationToken cancellationToken)
    {
        while (true)
        {
            BrowserDomNode? title = await FindFreshFromDocumentAsync(Title, cancellationToken).ConfigureAwait(false);
            BrowserDomNode? editor = await FindFreshFromDocumentAsync(Editor, cancellationToken).ConfigureAwait(false);
            BrowserDomNode? publish = await FindFreshFromDocumentAsync(Publish, cancellationToken).ConfigureAwait(false);
            if (title is not null && editor is not null && publish is not null)
                return await IsComposerUrlAsync(cancellationToken).ConfigureAwait(false) ? new PatreonComposer(RequirePage()) : null;

            await _timing.DelayAsync(PatreonSocialPreparationAdapter.ReadinessPollInterval, cancellationToken).ConfigureAwait(false);
        }
    }

    public Task<bool> IsExpectedComposerRouteAsync(CancellationToken cancellationToken) =>
        IsComposerUrlAsync(cancellationToken);

    public async Task RelinquishAsync(CancellationToken cancellationToken)
    {
        try { await RequirePage().RelinquishOwnedTargetAsync(cancellationToken: cancellationToken).ConfigureAwait(false); }
        finally { _terminal = true; }
    }

    public async Task AbandonAsync(CancellationToken cancellationToken)
    {
        if (_terminal || _page is null) return;
        try { await _page.CloseOwnedTargetAsync(cancellationToken: cancellationToken).ConfigureAwait(false); }
        catch (OperationCanceledException) { throw; }
        catch { }
        finally { _terminal = true; }
    }

    public async ValueTask DisposeAsync()
    {
        if (_page is null) return;
        if (_terminal) await _page.DisposeLocallyAsync().ConfigureAwait(false);
        else await _page.DisposeAsync().ConfigureAwait(false);
    }

    internal static bool IsStaleFrontendNode(CdpCommandException exception) =>
        exception.Code == -32000 && string.Equals(exception.Message, "Could not find node with given id", StringComparison.Ordinal);

    private static bool IsTemporaryBoxModelUnavailable(CdpCommandException exception) =>
        exception.Code == -32000 && exception.Message.Contains("Could not compute box model", StringComparison.OrdinalIgnoreCase);

    private void ObserveCreateActivationCompleted()
    {
        try { _createActivationObserver?.Invoke(BrowserPreparationActivationStage.Completed); }
        catch { }
    }

    private BrowserPreparationSession RequirePage() => _page ?? throw new InvalidOperationException("Patreon page is not initialized.");

    private async Task<BrowserDomNode?> ResolveCreateAsync(CancellationToken cancellationToken)
    {
        int? candidateCount = null;
        int inspectedCount = 0, usableCount = 0, rejectedCount = 0;
        void Record(PatreonCreateResolutionOutcome? outcome = null, bool complete = false, bool exceeded = false) =>
            CreateResolution = new(outcome, candidateCount, candidateCount is null ? null : inspectedCount,
                candidateCount is null ? null : usableCount, candidateCount is null ? null : rejectedCount, exceeded, complete);
        Record();
        BrowserPreparationSession page = RequirePage();
        JsonElement document = await page.Session.SendCommandAsync("DOM.getDocument",
            JsonSerializer.SerializeToElement(new { depth = 0, pierce = false }), cancellationToken: cancellationToken).ConfigureAwait(false);
        if (!TryRoot(document, out int rootNodeId))
        {
            Record(PatreonCreateResolutionOutcome.RootUnavailable);
            return null;
        }
        JsonElement result = await page.Session.SendCommandAsync("DOM.querySelectorAll",
            JsonSerializer.SerializeToElement(new { nodeId = rootNodeId, selector = Create }), cancellationToken: cancellationToken).ConfigureAwait(false);
        if (result.ValueKind != JsonValueKind.Object || !result.TryGetProperty("nodeIds", out JsonElement ids) ||
            ids.ValueKind != JsonValueKind.Array)
        {
            Record(PatreonCreateResolutionOutcome.MalformedQuery);
            throw new BrowserPreparationException(BrowserPreparationFailure.InvalidNode);
        }
        if (ids.GetArrayLength() > CreateCandidateLimit)
        {
            Record(PatreonCreateResolutionOutcome.CandidateLimitExceeded, exceeded: true);
            throw new BrowserPreparationException(BrowserPreparationFailure.InvalidNode);
        }
        candidateCount = ids.GetArrayLength();
        Record();

        var frontendIds = new HashSet<int>();
        foreach (JsonElement id in ids.EnumerateArray())
            if (id.ValueKind != JsonValueKind.Number || !id.TryGetInt32(out int value) || value <= 0 || !frontendIds.Add(value))
            {
                Record(PatreonCreateResolutionOutcome.InvalidCandidateIdentity);
                throw new BrowserPreparationException(BrowserPreparationFailure.InvalidNode);
            }

        var backendIds = new HashSet<long>();
        BrowserDomNode? usable = null;
        foreach (JsonElement id in ids.EnumerateArray())
        {
            BrowserDomNode node;
            var descriptionFailure = PatreonCreateResolutionOutcome.MalformedDescription;
            try
            {
                node = await page.DescribeNodeAsync(id.GetInt32(), cancellationToken,
                    response => descriptionFailure = ClassifyCreateDescriptionFailure(response, id.GetInt32())).ConfigureAwait(false);
            }
            catch (CdpCommandException exception) when (IsStaleFrontendNode(exception))
            {
                Record(PatreonCreateResolutionOutcome.StaleDescription);
                return null;
            }
            catch (BrowserPreparationException exception) when (exception.Failure == BrowserPreparationFailure.InvalidNode)
            {
                Record(descriptionFailure);
                throw;
            }
            // Shared JSON description parsing throws this exact type for mistyped elements.
            // Transport failures are separately wrapped; exclude ObjectDisposedException.
            catch (InvalidOperationException exception) when (exception.GetType() == typeof(InvalidOperationException))
            {
                Record(PatreonCreateResolutionOutcome.MalformedDescription);
                throw;
            }
            if (node.NodeId != id.GetInt32() || node.BackendNodeId <= 0 ||
                !string.Equals(node.SessionId, page.Session.SessionId, StringComparison.Ordinal) || !backendIds.Add(node.BackendNodeId))
            {
                Record(PatreonCreateResolutionOutcome.InvalidCandidateIdentity);
                throw new BrowserPreparationException(BrowserPreparationFailure.InvalidNode);
            }
            bool hasLayout;
            try { hasLayout = await HasUsableCreateLayoutAsync(node, cancellationToken).ConfigureAwait(false); }
            catch (BrowserPreparationException exception) when (exception.Failure == BrowserPreparationFailure.InvalidNode)
            {
                Record(PatreonCreateResolutionOutcome.MalformedGeometry);
                throw;
            }
            if (hasLayout)
            {
                usable = node;
                usableCount++;
            }
            else rejectedCount++;
            inspectedCount++;
            Record();
        }
        Record(usableCount > 1 ? PatreonCreateResolutionOutcome.Ambiguous : usableCount == 1 ?
            PatreonCreateResolutionOutcome.UniqueCandidate : candidateCount == 0 ?
            PatreonCreateResolutionOutcome.ZeroMatches : PatreonCreateResolutionOutcome.NoUsableCandidate, complete: true);
        if (usableCount > 1) throw new BrowserPreparationException(BrowserPreparationFailure.InvalidNode);
        return usable;
    }

    private static PatreonCreateResolutionOutcome ClassifyCreateDescriptionFailure(JsonElement response, int requestedId)
    {
        // Only retain a fixed reason. Missing or mistyped structure is not identity evidence.
        if (response.ValueKind == JsonValueKind.Object && response.TryGetProperty("node", out JsonElement node) &&
            node.ValueKind == JsonValueKind.Object &&
            node.TryGetProperty("nodeName", out JsonElement name) && name.ValueKind == JsonValueKind.String &&
            node.TryGetProperty("nodeId", out JsonElement frontend) && frontend.ValueKind == JsonValueKind.Number &&
            frontend.TryGetInt32(out int frontendId) &&
            node.TryGetProperty("backendNodeId", out JsonElement backend) && backend.ValueKind == JsonValueKind.Number &&
            backend.TryGetInt64(out long backendId) &&
            (frontendId <= 0 || frontendId != requestedId || backendId <= 0))
            return PatreonCreateResolutionOutcome.InvalidCandidateIdentity;
        return PatreonCreateResolutionOutcome.MalformedDescription;
    }

    private async Task<bool> HasUsableCreateLayoutAsync(BrowserDomNode node, CancellationToken cancellationToken)
    {
        JsonElement result;
        try
        {
            result = await RequirePage().Session.SendCommandAsync("DOM.getBoxModel",
                JsonSerializer.SerializeToElement(new { backendNodeId = node.BackendNodeId }), cancellationToken: cancellationToken).ConfigureAwait(false);
        }
        catch (CdpCommandException exception) when (IsTemporaryBoxModelUnavailable(exception)) { return false; }
        if (result.ValueKind != JsonValueKind.Object || !result.TryGetProperty("model", out JsonElement model) ||
            model.ValueKind != JsonValueKind.Object || !model.TryGetProperty("border", out JsonElement border) ||
            border.ValueKind != JsonValueKind.Array || border.GetArrayLength() != 8)
            throw new BrowserPreparationException(BrowserPreparationFailure.InvalidNode);
        var coordinates = new double[8];
        for (int i = 0; i < coordinates.Length; i++)
            if (border[i].ValueKind != JsonValueKind.Number || !border[i].TryGetDouble(out coordinates[i]) || !double.IsFinite(coordinates[i]))
                throw new BrowserPreparationException(BrowserPreparationFailure.InvalidNode);
        bool positiveDimensions = true;
        foreach (string dimension in new[] { "width", "height" })
        {
            if (!model.TryGetProperty(dimension, out JsonElement value)) continue;
            if (value.ValueKind != JsonValueKind.Number || !value.TryGetDouble(out double size) || !double.IsFinite(size))
                throw new BrowserPreparationException(BrowserPreparationFailure.InvalidNode);
            positiveDimensions &= size > 0;
        }
        // Match shared activation's center arithmetic; reject overflow before handing off.
        double x = (coordinates[0] + coordinates[2] + coordinates[4] + coordinates[6]) / 4;
        double y = (coordinates[1] + coordinates[3] + coordinates[5] + coordinates[7]) / 4;
        double twiceArea = 0;
        for (int i = 0; i < 8; i += 2)
        {
            int next = (i + 2) % 8;
            twiceArea += (coordinates[i] - coordinates[0]) * (coordinates[next + 1] - coordinates[1]) -
                (coordinates[next] - coordinates[0]) * (coordinates[i + 1] - coordinates[1]);
        }
        if (!double.IsFinite(x) || !double.IsFinite(y) || !double.IsFinite(twiceArea))
            throw new BrowserPreparationException(BrowserPreparationFailure.InvalidNode);
        return positiveDimensions && Math.Abs(twiceArea) > 0;
    }

    private async Task<bool> IsLoginPageAsync(CancellationToken cancellationToken)
    {
        string? url = await CurrentUrlAsync(cancellationToken).ConfigureAwait(false);
        return url is not null && Uri.TryCreate(url, UriKind.Absolute, out Uri? current) &&
            current.AbsolutePath.Contains("/login", StringComparison.OrdinalIgnoreCase) &&
            await HasRenderedEvidenceAsync(LoginControl, cancellationToken).ConfigureAwait(false);
    }

    private async Task<bool> IsComposerUrlAsync(CancellationToken cancellationToken)
    {
        string? url = await CurrentUrlAsync(cancellationToken).ConfigureAwait(false);
        if (url is null || !Uri.TryCreate(url, UriKind.Absolute, out Uri? current) ||
            !string.Equals(current.Host, "www.patreon.com", StringComparison.OrdinalIgnoreCase)) return false;
        string[] segments = current.AbsolutePath.Split('/', StringSplitOptions.RemoveEmptyEntries);
        return segments.Length == 4 &&
            string.Equals(segments[0], _creatorVanitySegment, StringComparison.Ordinal) &&
            string.Equals(segments[1], "posts", StringComparison.Ordinal) &&
            string.Equals(segments[3], "edit", StringComparison.Ordinal) &&
            !string.IsNullOrEmpty(segments[2]);
    }

    private async Task<string?> CurrentUrlAsync(CancellationToken cancellationToken)
    {
        JsonElement history = await RequirePage().Session.SendCommandAsync("Page.getNavigationHistory", cancellationToken: cancellationToken).ConfigureAwait(false);
        if (!history.TryGetProperty("currentIndex", out JsonElement currentIndex) || !currentIndex.TryGetInt32(out int index) ||
            !history.TryGetProperty("entries", out JsonElement entries) || entries.ValueKind != JsonValueKind.Array ||
            index < 0 || index >= entries.GetArrayLength()) return null;
        JsonElement entry = entries[index];
        return entry.TryGetProperty("url", out JsonElement url) && url.ValueKind == JsonValueKind.String ? url.GetString() : null;
    }

    private async Task<BrowserDomNode?> FindFreshFromDocumentAsync(string selector, CancellationToken cancellationToken)
    {
        JsonElement document = await RequirePage().Session.SendCommandAsync(
            "DOM.getDocument",
            JsonSerializer.SerializeToElement(new { depth = 0, pierce = false }),
            cancellationToken: cancellationToken).ConfigureAwait(false);
        if (!TryRoot(document, out int rootNodeId)) return null;
        return await FindFreshWithinAsync(rootNodeId, selector, cancellationToken).ConfigureAwait(false);
    }

    private async Task<bool> HasRenderedEvidenceAsync(string selector, CancellationToken cancellationToken)
    {
        JsonElement document = await RequirePage().Session.SendCommandAsync(
            "DOM.getDocument",
            JsonSerializer.SerializeToElement(new { depth = 0, pierce = false }),
            cancellationToken: cancellationToken).ConfigureAwait(false);
        if (!TryRoot(document, out int rootNodeId)) return false;

        JsonElement result = await RequirePage().Session.SendCommandAsync(
            "DOM.querySelectorAll",
            JsonSerializer.SerializeToElement(new { nodeId = rootNodeId, selector }),
            cancellationToken: cancellationToken).ConfigureAwait(false);
        if (!result.TryGetProperty("nodeIds", out JsonElement nodeIds) || nodeIds.ValueKind != JsonValueKind.Array) return false;
        foreach (JsonElement candidate in nodeIds.EnumerateArray())
        {
            if (!candidate.TryGetInt32(out int nodeId) || nodeId <= 0) return false;
            try
            {
                BrowserDomNode node = await RequirePage().DescribeNodeAsync(nodeId, cancellationToken).ConfigureAwait(false);
                if (await IsRenderedAsync(node, cancellationToken).ConfigureAwait(false)) return true;
            }
            catch (CdpCommandException exception) when (IsStaleFrontendNode(exception)) { }
        }
        return false;
    }

    private async Task<bool> IsRenderedAsync(BrowserDomNode node, CancellationToken cancellationToken)
    {
        try
        {
            JsonElement result = await RequirePage().Session.SendCommandAsync(
                "DOM.getBoxModel",
                JsonSerializer.SerializeToElement(new { backendNodeId = node.BackendNodeId }),
                cancellationToken: cancellationToken).ConfigureAwait(false);
            return result.TryGetProperty("model", out JsonElement model) &&
                model.TryGetProperty("width", out JsonElement width) && width.TryGetDouble(out double w) && w > 0 &&
                model.TryGetProperty("height", out JsonElement height) && height.TryGetDouble(out double h) && h > 0;
        }
        catch (CdpCommandException exception) when (IsTemporaryBoxModelUnavailable(exception))
        {
            return false;
        }
    }

    private async Task<BrowserDomNode?> FindFreshWithinAsync(int rootNodeId, string selector, CancellationToken cancellationToken)
    {
        while (true)
        {
            JsonElement result = await RequirePage().Session.SendCommandAsync(
                "DOM.querySelector",
                JsonSerializer.SerializeToElement(new { nodeId = rootNodeId, selector }),
                cancellationToken: cancellationToken).ConfigureAwait(false);
            if (!result.TryGetProperty("nodeId", out JsonElement nodeId) || !nodeId.TryGetInt32(out int id) || id <= 0) return null;
            try { return await RequirePage().DescribeNodeAsync(id, cancellationToken).ConfigureAwait(false); }
            catch (CdpCommandException exception) when (IsStaleFrontendNode(exception)) { }
        }
    }

    private static bool TryRoot(JsonElement document, out int rootNodeId)
    {
        rootNodeId = 0;
        return document.TryGetProperty("root", out JsonElement root) &&
            root.TryGetProperty("nodeId", out JsonElement nodeId) &&
            nodeId.TryGetInt32(out rootNodeId) && rootNodeId > 0;
    }
}

/// <summary>Patreon composer-scoped operations. It reads the Remirror DOM directly to exclude Patreon paywall UI.</summary>
internal sealed class PatreonComposer : IPatreonComposer
{
    private const string Title = "textarea[aria-label='Title'][placeholder='Title']";
    private const string Editor = "[data-tag='text-editor-remirror-wrapper'] [contenteditable='true'][role='textbox'][aria-label='Text input field for post content']";
    private const string PhotosInput = "#photosInput[type='file'][multiple]";
    private const string GalleryImage = "img[data-tag='gallery-image'], div[role='button'][aria-roledescription='sortable'] [data-tag='preview-thumbnail-container'] img[alt='Preview']";
    private const string SaveStatus = "div[class*='EditorLayout-module'][class*='actions'] div[class*='CompactSaveStatus-module'][aria-hidden='false'] > p";
    private const string Publish = "button[data-tag='make-a-post-action-publish']";
    private const string Busy = "[aria-busy='true'], [role='progressbar'], progress";
    private const string ValidationError = "[role='alert'], [aria-invalid='true'], [data-tag*='error']";
    private const int BodyTraversalLimit = 128;
    private const int EditorDescribeDepth = BodyTraversalLimit;

    private readonly BrowserPreparationSession _page;

    internal PatreonComposer(BrowserPreparationSession page) => _page = page ?? throw new ArgumentNullException(nameof(page));

    public async Task<bool> ReplaceAndVerifyTitleAsync(string title, CancellationToken cancellationToken)
    {
        BrowserDomNode? field = await FindFreshFromDocumentAsync(Title, cancellationToken).ConfigureAwait(false);
        if (field is null) return false;
        await _page.ReplaceTextAsync(field, title, cancellationToken).ConfigureAwait(false);
        return await VerifyTitleAsync(title, cancellationToken).ConfigureAwait(false);
    }

    public async Task<bool> ReplaceAndVerifyBodyAsync(string body, CancellationToken cancellationToken)
    {
        BrowserDomNode? editor = await FindFreshFromDocumentAsync(Editor, cancellationToken).ConfigureAwait(false);
        if (editor is null) return false;
        await _page.ReplaceTextAsync(editor, body, cancellationToken).ConfigureAwait(false);
        return await VerifyBodyAsync(body, cancellationToken).ConfigureAwait(false);
    }

    public async Task<PatreonMediaAssignment> AttachImagesAsync(IReadOnlyList<string> paths, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(paths);
        if (paths.Any(path => !IsVerifiedImagePath(path))) return PatreonMediaAssignment.UnsupportedType;
        if (paths.Count != 1) return PatreonMediaAssignment.Failed;
        BrowserDomNode? input = await FindFreshFromDocumentAsync(PhotosInput, cancellationToken).ConfigureAwait(false);
        if (input is null) return PatreonMediaAssignment.InputMissing;
        try
        {
            // The adapter assigns one caller-ordered media path at a time through this persistent input.
            await _page.SetFileInputFilesAsync(input, new[] { paths[0] }, cancellationToken).ConfigureAwait(false);
            return PatreonMediaAssignment.Assigned;
        }
        catch (BrowserPreparationException) { return PatreonMediaAssignment.Failed; }
        catch (CdpCommandException) { return PatreonMediaAssignment.Failed; }
    }

    public async Task<PatreonReadiness> ReadReadinessAsync(int intendedCount, CancellationToken cancellationToken)
    {
        if (await TryGetDocumentRootAsync(cancellationToken).ConfigureAwait(false) is not int rootNodeId)
            return new PatreonReadiness(false, false, false, true, false, false);

        IReadOnlyList<BrowserDomNode>? previews = await QueryAllFreshAsync(rootNodeId, GalleryImage, cancellationToken).ConfigureAwait(false);
        if (previews is null)
            return new PatreonReadiness(false, false, false, true, false, false);
        int[] previewNodeIds = previews.Select(preview => preview.NodeId).ToArray();
        bool rendered = previews.Count == intendedCount && await AllRenderedAsync(previews, cancellationToken).ConfigureAwait(false);
        PatreonSaveState save = await ReadSaveStateAsync(cancellationToken).ConfigureAwait(false);
        return new PatreonReadiness(
            PreviewCountMatches: previews.Count == intendedCount,
            ImagesRendered: rendered,
            OrderObserved: previewNodeIds.Distinct().Count() == previewNodeIds.Length,
            IsBusy: await ExistsAsync(rootNodeId, Busy, cancellationToken).ConfigureAwait(false) || save == PatreonSaveState.Saving,
            HasError: await ExistsAsync(rootNodeId, ValidationError, cancellationToken).ConfigureAwait(false),
            SaveIsSaved: save == PatreonSaveState.Saved,
            PreviewNodeIds: previewNodeIds);
    }

    public async Task<bool> VerifyTitleAsync(string title, CancellationToken cancellationToken)
    {
        BrowserDomNode? field = await FindFreshFromDocumentAsync(Title, cancellationToken).ConfigureAwait(false);
        if (field is null) return false;
        return await _page.VerifyTextAsync(field, title, cancellationToken).ConfigureAwait(false) == BrowserTextVerification.Match;
    }

    public async Task<bool> VerifyBodyAsync(string body, CancellationToken cancellationToken)
    {
        BrowserDomNode? editor = await FindFreshFromDocumentAsync(Editor, cancellationToken).ConfigureAwait(false);
        if (editor is null) return false;
        (string? actual, bool readable) = await ReadExactBodyAsync(editor, cancellationToken).ConfigureAwait(false);
        return readable && actual is not null && string.Equals(actual, body, StringComparison.Ordinal);
    }

    public async Task<PatreonFinalState> ReadFinalStateAsync(CancellationToken cancellationToken)
    {
        if (await TryGetDocumentRootAsync(cancellationToken).ConfigureAwait(false) is not int rootNodeId)
            return new PatreonFinalState(false, false, false, true);
        BrowserDomNode? publish = await FindFreshWithinAsync(rootNodeId, Publish, cancellationToken).ConfigureAwait(false);
        PatreonSaveState save = await ReadSaveStateAsync(cancellationToken).ConfigureAwait(false);
        return new PatreonFinalState(
            PublishExists: publish is not null,
            PublishEnabled: publish is not null && await IsEnabledAsync(publish, cancellationToken).ConfigureAwait(false),
            SaveIsSaved: save == PatreonSaveState.Saved,
            HasValidationError: await ExistsAsync(rootNodeId, ValidationError, cancellationToken).ConfigureAwait(false));
    }

    internal static bool TryReadExactBody(JsonElement editor, out string? body)
    {
        body = null;
        if (!HasAttribute(editor, "contenteditable", "true") || !TryChildrenArray(editor, out JsonElement children)) return false;

        var paragraphs = new List<string>();
        int visited = 0;
        foreach (JsonElement child in children.EnumerateArray())
        {
            if (!Visit(ref visited)) return false;
            if (HasAttribute(child, "contenteditable", "false")) continue;
            if (!NodeNameIs(child, "P")) return false;
            if (!TryReadParagraph(child, ref visited, out string paragraph)) return false;
            paragraphs.Add(paragraph);
        }

        body = string.Join("\n\n", paragraphs);
        return true;
    }

    internal static bool IsVerifiedImagePath(string? path)
    {
        if (string.IsNullOrWhiteSpace(path)) return false;
        return Path.GetExtension(path).ToLowerInvariant() switch
        {
            ".jpg" or ".jpeg" or ".png" or ".gif" or ".webp" or ".avif" or ".tiff" or ".tif" or ".heic" or ".heif" => true,
            _ => false,
        };
    }

    private async Task<(string? Actual, bool Readable)> ReadExactBodyAsync(BrowserDomNode editor, CancellationToken cancellationToken)
    {
        while (true)
        {
            try
            {
                JsonElement result = await _page.Session.SendCommandAsync(
                    "DOM.describeNode",
                    JsonSerializer.SerializeToElement(new { nodeId = editor.NodeId, depth = EditorDescribeDepth, pierce = false }),
                    cancellationToken: cancellationToken).ConfigureAwait(false);
                if (!result.TryGetProperty("node", out JsonElement node)) return (null, false);
                return TryReadExactBody(node, out string? body) ? (body, true) : (null, false);
            }
            catch (CdpCommandException exception) when (PatreonPreparationPage.IsStaleFrontendNode(exception))
            {
                BrowserDomNode? refreshed = await FindFreshFromDocumentAsync(Editor, cancellationToken).ConfigureAwait(false);
                if (refreshed is null) return (null, false);
                editor = refreshed;
            }
        }
    }

    private static bool TryReadParagraph(JsonElement paragraph, ref int visited, out string text)
    {
        text = string.Empty;
        if (!TryChildrenArray(paragraph, out JsonElement children)) return true;
        var builder = new StringBuilder();
        foreach (JsonElement child in children.EnumerateArray())
        {
            if (!AppendParagraphText(child, builder, ref visited)) return false;
        }
        text = builder.ToString();
        return true;
    }

    private static bool AppendParagraphText(JsonElement node, StringBuilder text, ref int visited)
    {
        if (!Visit(ref visited)) return false;
        if (HasAttribute(node, "contenteditable", "false")) return true;
        if (NodeNameIs(node, "#text"))
        {
            if (!node.TryGetProperty("nodeValue", out JsonElement value) || value.ValueKind != JsonValueKind.String) return false;
            text.Append(value.GetString());
            return true;
        }
        if (NodeNameIs(node, "BR"))
        {
            text.Append('\n');
            return true;
        }
        if (!TryChildrenArray(node, out JsonElement children)) return false;
        foreach (JsonElement child in children.EnumerateArray())
        {
            if (!AppendParagraphText(child, text, ref visited)) return false;
        }
        return true;
    }

    private static bool Visit(ref int visited) => ++visited <= BodyTraversalLimit;

    private async Task<PatreonSaveState> ReadSaveStateAsync(CancellationToken cancellationToken)
    {
        // Re-query the live composer action status for every sample; Patreon may replace this node while saving.
        BrowserDomNode? status = await FindFreshFromDocumentAsync(SaveStatus, cancellationToken).ConfigureAwait(false);
        if (status is null) return PatreonSaveState.Unknown;
        if (!await AllRenderedAsync(new[] { status }, cancellationToken).ConfigureAwait(false)) return PatreonSaveState.Unknown;

        JsonElement result = await _page.Session.SendCommandAsync(
            "DOM.describeNode",
            JsonSerializer.SerializeToElement(new { nodeId = status.NodeId, depth = 2, pierce = false }),
            cancellationToken: cancellationToken).ConfigureAwait(false);
        return result.TryGetProperty("node", out JsonElement paragraph) && TryReadSaveStatus(paragraph, out PatreonSaveState state)
            ? state
            : PatreonSaveState.Unknown;
    }

    private static bool TryReadSaveStatus(JsonElement paragraph, out PatreonSaveState state)
    {
        state = PatreonSaveState.Unknown;
        if (!NodeNameIs(paragraph, "P") || !TryChildrenArray(paragraph, out JsonElement children)) return false;
        var directText = new StringBuilder();
        foreach (JsonElement child in children.EnumerateArray())
        {
            if (NodeNameIs(child, "#text"))
            {
                if (!child.TryGetProperty("nodeValue", out JsonElement value) || value.ValueKind != JsonValueKind.String) return false;
                directText.Append(value.GetString());
            }
            else if (!HasAttribute(child, "aria-hidden", "true"))
            {
                return false;
            }
        }

        state = directText.ToString() switch
        {
            "Saving" => PatreonSaveState.Saving,
            "Saved" => PatreonSaveState.Saved,
            _ => PatreonSaveState.Unknown,
        };
        return state != PatreonSaveState.Unknown;
    }

    private async Task<int?> TryGetDocumentRootAsync(CancellationToken cancellationToken)
    {
        JsonElement document = await _page.Session.SendCommandAsync(
            "DOM.getDocument",
            JsonSerializer.SerializeToElement(new { depth = 0, pierce = false }),
            cancellationToken: cancellationToken).ConfigureAwait(false);
        return document.TryGetProperty("root", out JsonElement root) &&
            root.TryGetProperty("nodeId", out JsonElement nodeId) && nodeId.TryGetInt32(out int id) && id > 0
            ? id
            : null;
    }

    private async Task<BrowserDomNode?> FindFreshFromDocumentAsync(string selector, CancellationToken cancellationToken)
    {
        int? rootNodeId = await TryGetDocumentRootAsync(cancellationToken).ConfigureAwait(false);
        return rootNodeId is null ? null : await FindFreshWithinAsync(rootNodeId.Value, selector, cancellationToken).ConfigureAwait(false);
    }

    private async Task<BrowserDomNode?> FindFreshWithinAsync(int rootNodeId, string selector, CancellationToken cancellationToken)
    {
        while (true)
        {
            JsonElement result = await _page.Session.SendCommandAsync(
                "DOM.querySelector",
                JsonSerializer.SerializeToElement(new { nodeId = rootNodeId, selector }),
                cancellationToken: cancellationToken).ConfigureAwait(false);
            if (!result.TryGetProperty("nodeId", out JsonElement nodeId) || !nodeId.TryGetInt32(out int id) || id <= 0) return null;
            try { return await _page.DescribeNodeAsync(id, cancellationToken).ConfigureAwait(false); }
            catch (CdpCommandException exception) when (PatreonPreparationPage.IsStaleFrontendNode(exception)) { }
        }
    }

    private async Task<IReadOnlyList<BrowserDomNode>?> QueryAllFreshAsync(int rootNodeId, string selector, CancellationToken cancellationToken)
    {
        while (true)
        {
            JsonElement result = await _page.Session.SendCommandAsync(
                "DOM.querySelectorAll",
                JsonSerializer.SerializeToElement(new { nodeId = rootNodeId, selector }),
                cancellationToken: cancellationToken).ConfigureAwait(false);
            if (!result.TryGetProperty("nodeIds", out JsonElement nodeIds) || nodeIds.ValueKind != JsonValueKind.Array) return null;
            var nodes = new List<BrowserDomNode>();
            try
            {
                foreach (JsonElement id in nodeIds.EnumerateArray())
                {
                    if (!id.TryGetInt32(out int nodeId) || nodeId <= 0) return null;
                    nodes.Add(await _page.DescribeNodeAsync(nodeId, cancellationToken).ConfigureAwait(false));
                }
                return nodes;
            }
            catch (CdpCommandException exception) when (PatreonPreparationPage.IsStaleFrontendNode(exception)) { }
        }
    }

    private async Task<bool> ExistsAsync(int rootNodeId, string selector, CancellationToken cancellationToken) =>
        (await QueryAllFreshAsync(rootNodeId, selector, cancellationToken).ConfigureAwait(false)) is not { Count: 0 };

    private async Task<bool> AllRenderedAsync(IReadOnlyList<BrowserDomNode> images, CancellationToken cancellationToken)
    {
        foreach (BrowserDomNode image in images)
        {
            try
            {
                JsonElement result = await _page.Session.SendCommandAsync(
                    "DOM.getBoxModel",
                    JsonSerializer.SerializeToElement(new { backendNodeId = image.BackendNodeId }),
                    cancellationToken: cancellationToken).ConfigureAwait(false);
                if (!result.TryGetProperty("model", out JsonElement model) ||
                    !model.TryGetProperty("width", out JsonElement width) || !width.TryGetDouble(out double w) || w <= 0 ||
                    !model.TryGetProperty("height", out JsonElement height) || !height.TryGetDouble(out double h) || h <= 0) return false;
            }
            catch (CdpCommandException exception) when (IsTemporaryBoxModelUnavailable(exception)) { return false; }
        }
        return true;
    }

    private async Task<bool> IsEnabledAsync(BrowserDomNode node, CancellationToken cancellationToken)
    {
        JsonElement result = await _page.Session.SendCommandAsync(
            "DOM.getAttributes",
            JsonSerializer.SerializeToElement(new { nodeId = node.NodeId }),
            cancellationToken: cancellationToken).ConfigureAwait(false);
        if (!result.TryGetProperty("attributes", out JsonElement attributes) || attributes.ValueKind != JsonValueKind.Array) return false;
        bool ariaDisabledFalse = false;
        for (int index = 0; index + 1 < attributes.GetArrayLength(); index += 2)
        {
            if (attributes[index].ValueKind != JsonValueKind.String || attributes[index + 1].ValueKind != JsonValueKind.String) return false;
            string name = attributes[index].GetString()!;
            string value = attributes[index + 1].GetString()!;
            if (string.Equals(name, "disabled", StringComparison.OrdinalIgnoreCase))
                return false;
            if (string.Equals(name, "aria-disabled", StringComparison.OrdinalIgnoreCase))
                ariaDisabledFalse = string.Equals(value, "false", StringComparison.Ordinal);
        }
        return ariaDisabledFalse;
    }

    private static bool IsTemporaryBoxModelUnavailable(CdpCommandException exception) =>
        exception.Code == -32000 && exception.Message.Contains("Could not compute box model", StringComparison.OrdinalIgnoreCase);

    private static bool TryChildrenArray(JsonElement node, out JsonElement children)
    {
        children = default;
        return node.TryGetProperty("children", out children) && children.ValueKind == JsonValueKind.Array;
    }

    private static bool NodeNameIs(JsonElement node, string expected) =>
        node.TryGetProperty("nodeName", out JsonElement name) && name.ValueKind == JsonValueKind.String &&
        string.Equals(name.GetString(), expected, StringComparison.OrdinalIgnoreCase);

    private static bool HasAttribute(JsonElement node, string expectedName, string expectedValue)
    {
        if (!node.TryGetProperty("attributes", out JsonElement attributes) || attributes.ValueKind != JsonValueKind.Array) return false;
        for (int index = 0; index + 1 < attributes.GetArrayLength(); index += 2)
        {
            if (attributes[index].ValueKind == JsonValueKind.String && attributes[index + 1].ValueKind == JsonValueKind.String &&
                string.Equals(attributes[index].GetString(), expectedName, StringComparison.OrdinalIgnoreCase) &&
                string.Equals(attributes[index + 1].GetString(), expectedValue, StringComparison.OrdinalIgnoreCase))
                return true;
        }
        return false;
    }

    private enum PatreonSaveState { Unknown, Saving, Saved }
}
