using System.Text.Json;

namespace OpenLocally;

/// <summary>
/// Prepares, but never submits, a Bluesky composer in a helper-owned tab.
/// The adapter deliberately leaves a verified composer open for the operator.
/// </summary>
public sealed class BlueskySocialPreparationAdapter : ISocialPreparationAdapter
{
    internal static readonly TimeSpan StabilityInterval = TimeSpan.FromMilliseconds(250);
    internal static readonly TimeSpan ReadinessPollInterval = TimeSpan.FromMilliseconds(50);
    private readonly Func<BrowserPreparationTargets, IBlueskyPreparationPage> _createPage;
    private readonly bool _requiresBrowserTargets;
    private readonly BlueskyTiming _timing;

    public BlueskySocialPreparationAdapter() : this(targets => new BlueskyPreparationPage(targets), requiresBrowserTargets: true, BlueskyTiming.System) { }

    internal BlueskySocialPreparationAdapter(Func<BrowserPreparationTargets, IBlueskyPreparationPage> createPage, BlueskyTiming? timing = null) : this(createPage, requiresBrowserTargets: false, timing ?? BlueskyTiming.System) { }

    private BlueskySocialPreparationAdapter(Func<BrowserPreparationTargets, IBlueskyPreparationPage> createPage, bool requiresBrowserTargets, BlueskyTiming timing)
    {
        _createPage = createPage ?? throw new ArgumentNullException(nameof(createPage));
        _requiresBrowserTargets = requiresBrowserTargets;
        _timing = timing ?? throw new ArgumentNullException(nameof(timing));
    }

    public string Platform => "bluesky";

    public async Task<PlatformPreparationResult> PrepareAsync(
        PlatformPreparationContext context,
        IPreparationProgress progress,
        CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(context);
        ArgumentNullException.ThrowIfNull(progress);
        if (!string.Equals(context.Platform, Platform, StringComparison.Ordinal) || (_requiresBrowserTargets && context.BrowserTargets is null))
            throw new SocialPreparationRuntimeException("bluesky_browser_unavailable");

        await using IBlueskyPreparationPage page = _createPage(context.BrowserTargets!);
        bool preservePage = false;
        string phase = "home";
        var diagnostic = new SocialPreparationDiagnostic(Platform, phase, "platform_preparation_failed");
        try
        {
            BlueskyHomeState home = await page.NavigateAndWaitForHomeAsync(cancellationToken).ConfigureAwait(false);
            if (home == BlueskyHomeState.AuthenticationRequired)
            {
                preservePage = true;
                return PlatformPreparationResult.AuthenticationRequired();
            }
            if (home == BlueskyHomeState.ManualAttentionRequired)
            {
                preservePage = true;
                return PlatformPreparationResult.AuthenticationRequired();
            }
            if (home != BlueskyHomeState.Authenticated) throw new BlueskyPreparationException("bluesky_home_timeout");
            diagnostic.Checkpoint("home_ready");
            diagnostic.TargetState("owned_target_created", true);

            phase = "compose_activation";
            if (!await page.ActivateComposeAsync(cancellationToken).ConfigureAwait(false))
                throw new BlueskyPreparationException("bluesky_compose_control_missing");
            diagnostic.Checkpoint("compose_activated");
            phase = "editor_ready";
            IBlueskyComposer? composer = await page.WaitForComposerAsync(cancellationToken).ConfigureAwait(false);
            if (composer is null) throw new BlueskyPreparationException("bluesky_composer_missing");
            diagnostic.Checkpoint("editor_ready");

            phase = "text_verified";
            await progress.ReportAsync(SocialPreparationProgress.Preparing, cancellationToken).ConfigureAwait(false);
            if (!await composer.ReplaceAndVerifyTextAsync(context.Body, cancellationToken).ConfigureAwait(false))
                throw new BlueskyPreparationException("bluesky_text_mismatch");
            diagnostic.Checkpoint("text_verified");

            if (context.MediaPaths.Count > 0)
            {
                phase = "media_assignment";
                await progress.ReportAsync(SocialPreparationProgress.Uploading, cancellationToken).ConfigureAwait(false);
                if (!await composer.AttachMediaAsync(context.MediaPaths, cancellationToken).ConfigureAwait(false))
                    throw new BlueskyPreparationException("bluesky_media_chooser_failed");
                diagnostic.Checkpoint("media_assigned");
                phase = "media_readiness";
                await RequireStableReadyAsync(composer, context.MediaPaths.Count, _timing, cancellationToken).ConfigureAwait(false);
                diagnostic.Checkpoint("media_ready");
            }
            else if (!await composer.IsValidWithoutMediaAsync(cancellationToken).ConfigureAwait(false))
            {
                throw new BlueskyPreparationException("bluesky_validation_error");
            }

            phase = "final_publish_assertion";
            if (!await composer.VerifyTextAsync(context.Body, cancellationToken).ConfigureAwait(false))
                throw new BlueskyPreparationException("bluesky_prepared_assertion_failed");
            diagnostic.Checkpoint("final_publish_asserted");

            phase = "relinquish";
            await page.RelinquishAsync(cancellationToken).ConfigureAwait(false);
            preservePage = true;
            diagnostic.TargetState("target_relinquished", true);
            return PlatformPreparationResult.Prepared();
        }
        catch (BlueskyPreparationException exception)
        {
            throw Failure(exception.Code, diagnostic, phase, exception);
        }
        catch (CdpTransportException exception)
        {
            diagnostic.SetPhase(phase);
            diagnostic.CapturePrimary(exception);
            exception.AttachSocialDiagnostic(diagnostic);
            throw;
        }
        catch (CdpCommandException exception)
        {
            diagnostic.SetPhase(phase);
            diagnostic.SetStableCode("platform_preparation_failed");
            diagnostic.CapturePrimary(exception);
            exception.AttachSocialDiagnostic(diagnostic);
            throw;
        }
        catch (BrowserPreparationException exception) when (exception.Failure is BrowserPreparationFailure.InvalidTarget or BrowserPreparationFailure.NotOwnedTarget)
        {
            throw Failure("bluesky_target_closed", diagnostic, phase, exception);
        }
        catch (ObjectDisposedException)
        {
            throw Failure("bluesky_target_closed", diagnostic, phase, new ObjectDisposedException("target"));
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
                diagnostic.TargetState("cleanup_attempted", true);
                try { await page.AbandonAsync().ConfigureAwait(false); diagnostic.TargetState("cleanup_succeeded", true); }
                catch (Exception exception) { diagnostic.TargetState("cleanup_succeeded", false); diagnostic.CaptureCleanup(exception); }
            }
        }
    }

    private static SocialPreparationRuntimeException Failure(string code, SocialPreparationDiagnostic diagnostic, string phase, Exception exception)
    {
        diagnostic.SetPhase(phase);
        diagnostic.SetStableCode(code);
        diagnostic.CapturePrimary(exception);
        diagnostic.TargetState("target_still_present", true);
        return new SocialPreparationRuntimeException(code, exception, diagnostic);
    }

    private static async Task RequireStableReadyAsync(IBlueskyComposer composer, int intendedCount, BlueskyTiming timing, CancellationToken cancellationToken)
    {
        DateTimeOffset deadline = timing.UtcNow() + timing.ReadinessTimeout;
        using CancellationTokenSource operationDeadline = timing.CreateDeadlineSource();
        using CancellationTokenSource linked = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken, operationDeadline.Token);
        BlueskyReadiness? first = null;
        BlueskyReadiness? last = null;
        try
        {
            while (timing.UtcNow() < deadline)
            {
                last = await composer.ReadReadinessAsync(intendedCount, linked.Token).ConfigureAwait(false);
                if (IsReady(last))
                {
                    first = last;
                    break;
                }

                TimeSpan remaining = deadline - timing.UtcNow();
                if (remaining <= TimeSpan.Zero) break;
                await timing.DelayAsync(remaining < ReadinessPollInterval ? remaining : ReadinessPollInterval, linked.Token).ConfigureAwait(false);
            }

            if (first is null)
            {
                ThrowForReadiness(last ?? new BlueskyReadiness(false, false, false, false, true, false, false));
            }

            if (timing.UtcNow() >= deadline) throw new BlueskyPreparationException("bluesky_media_not_ready");
            await timing.DelayAsync(StabilityInterval, linked.Token).ConfigureAwait(false);
            if (timing.UtcNow() >= deadline) throw new BlueskyPreparationException("bluesky_media_not_ready");
            BlueskyReadiness second = await composer.ReadReadinessAsync(intendedCount, linked.Token).ConfigureAwait(false);
            ThrowForReadiness(second);
        }
        catch (OperationCanceledException) when (operationDeadline.IsCancellationRequested && !cancellationToken.IsCancellationRequested)
        {
            throw new BlueskyPreparationException("bluesky_media_not_ready");
        }
    }

    private static bool IsReady(BlueskyReadiness readiness) =>
        readiness.PreviewCountMatches && readiness.ImagesRendered && readiness.ControlsMatch && readiness.OrderObserved &&
        !readiness.IsBusy && !readiness.HasError && readiness.PublishEnabled;

    private static void ThrowForReadiness(BlueskyReadiness readiness)
    {
        if (readiness.HasError) throw new BlueskyPreparationException("bluesky_media_error");
        if (!readiness.PreviewCountMatches || !readiness.ImagesRendered || !readiness.ControlsMatch || !readiness.OrderObserved)
            throw new BlueskyPreparationException("bluesky_media_preview_incomplete");
        if (readiness.IsBusy) throw new BlueskyPreparationException("bluesky_media_not_ready");
        if (!readiness.PublishEnabled) throw new BlueskyPreparationException("bluesky_validation_error");
    }
}

internal sealed class BlueskyTiming
{
    internal static BlueskyTiming System { get; } = new(BrowserPreparationSession.DefaultReadinessTimeout, () => DateTimeOffset.UtcNow, Task.Delay);
    private readonly Func<TimeSpan, CancellationTokenSource> _createDeadlineSource;

    internal BlueskyTiming(TimeSpan readinessTimeout, Func<DateTimeOffset> utcNow, Func<TimeSpan, CancellationToken, Task> delayAsync,
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

internal enum BlueskyHomeState { Authenticated, AuthenticationRequired, ManualAttentionRequired, TimedOut }

internal sealed record BlueskyReadiness(
    bool PreviewCountMatches, bool ImagesRendered, bool ControlsMatch, bool OrderObserved,
    bool IsBusy, bool HasError, bool PublishEnabled);

internal interface IBlueskyPreparationPage : IAsyncDisposable
{
    Task<BlueskyHomeState> NavigateAndWaitForHomeAsync(CancellationToken cancellationToken);
    Task<bool> ActivateComposeAsync(CancellationToken cancellationToken);
    Task<IBlueskyComposer?> WaitForComposerAsync(CancellationToken cancellationToken);
    Task RelinquishAsync(CancellationToken cancellationToken);
    Task AbandonAsync();
}

internal interface IBlueskyComposer
{
    Task<bool> ReplaceAndVerifyTextAsync(string text, CancellationToken cancellationToken);
    Task<bool> AttachMediaAsync(IReadOnlyList<string> paths, CancellationToken cancellationToken);
    Task<BlueskyReadiness> ReadReadinessAsync(int intendedCount, CancellationToken cancellationToken);
    Task<bool> IsValidWithoutMediaAsync(CancellationToken cancellationToken);
    Task<bool> VerifyTextAsync(string text, CancellationToken cancellationToken);
}

internal sealed class BlueskyPreparationException(string code) : Exception(code)
{
    internal string Code { get; } = code;
}

/// <summary>Bounded production implementation. It uses only DOM inspection and input primitives; no page script is evaluated.</summary>
internal sealed class BlueskyPreparationPage : IBlueskyPreparationPage
{
    private const string HomeUrl = "https://bsky.app/";
    private const string Compose = "button[aria-label='Compose new post']";
    private const string Modal = "[role='dialog'][aria-modal='true']";
    private const string Editor = "div.tiptap.ProseMirror[contenteditable='true']";
    private const string Publish = "button[data-testid='composerPublishBtn']";
    private const string Media = "button[data-testid='openMediaBtn']";
    private readonly BrowserPreparationTargets _targets;
    private readonly BlueskyTiming _timing;
    private BrowserPreparationSession? _page;
    private BrowserNavigationResult? _navigation;
    private bool _terminal;

    internal BlueskyPreparationPage(BrowserPreparationTargets targets, BlueskyTiming? timing = null)
    {
        _targets = targets ?? throw new ArgumentNullException(nameof(targets));
        _timing = timing ?? BlueskyTiming.System;
    }

    public async Task<BlueskyHomeState> NavigateAndWaitForHomeAsync(CancellationToken cancellationToken)
    {
        _page = await _targets.CreateOwnedAsync(cancellationToken: cancellationToken).ConfigureAwait(false);
        _navigation = await _page.NavigateAsync(HomeUrl, cancellationToken: cancellationToken).ConfigureAwait(false);
        await _page.WaitForDocumentAsync(cancellationToken: cancellationToken).ConfigureAwait(false);
        using var deadline = new CancellationTokenSource(BrowserPreparationSession.DefaultReadinessTimeout);
        using var linked = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken, deadline.Token);
        try
        {
            while (true)
            {
                if (await _page.FindNodeAsync(Compose, linked.Token).ConfigureAwait(false) is not null)
                {
                    // The current live composer evidence required a short home stabilization
                    // window before activating Compose; this is bounded and rechecks the control.
                    await _timing.DelayAsync(TimeSpan.FromSeconds(3), linked.Token).ConfigureAwait(false);
                    return await _page.FindNodeAsync(Compose, linked.Token).ConfigureAwait(false) is not null
                        ? BlueskyHomeState.Authenticated
                        : BlueskyHomeState.TimedOut;
                }
                if (await _page.FindNodeAsync("a[href='/login'], a[href*='login']", linked.Token).ConfigureAwait(false) is not null)
                    return BlueskyHomeState.AuthenticationRequired;
                if (await _page.FindNodeAsync("[role='alert'][aria-live='assertive']", linked.Token).ConfigureAwait(false) is not null)
                    return BlueskyHomeState.ManualAttentionRequired;
                await _timing.DelayAsync(BlueskySocialPreparationAdapter.ReadinessPollInterval, linked.Token).ConfigureAwait(false);
            }
        }
        catch (OperationCanceledException) when (deadline.IsCancellationRequested && !cancellationToken.IsCancellationRequested)
        {
            return BlueskyHomeState.TimedOut;
        }
    }

    public async Task<bool> ActivateComposeAsync(CancellationToken cancellationToken)
    {
        BrowserDomNode? compose = await RequirePage().FindNodeAsync(Compose, cancellationToken).ConfigureAwait(false);
        if (compose is null) return false;
        await RequirePage().ActivateAsync(compose, cancellationToken).ConfigureAwait(false);
        return true;
    }

    public async Task<IBlueskyComposer?> WaitForComposerAsync(CancellationToken cancellationToken)
    {
        DateTimeOffset deadline = _timing.UtcNow() + _timing.ReadinessTimeout;
        using CancellationTokenSource operationDeadline = _timing.CreateDeadlineSource();
        using CancellationTokenSource linked = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken, operationDeadline.Token);
        try
        {
            while (_timing.UtcNow() < deadline)
            {
                BrowserDomNode? modal = await FindModalAsync(linked.Token).ConfigureAwait(false);
                if (modal is not null)
                {
                    BrowserDomNode? editor = await FindNodeWithinAsync(modal.NodeId, Editor, linked.Token).ConfigureAwait(false);
                    BrowserDomNode? publish = await FindNodeWithinAsync(modal.NodeId, Publish, linked.Token).ConfigureAwait(false);
                    BrowserDomNode? media = await FindNodeWithinAsync(modal.NodeId, Media, linked.Token).ConfigureAwait(false);
                    if (editor is not null && publish is not null && media is not null)
                        return new BlueskyComposer(RequirePage(), _navigation!.FrameId, modal, editor, media, publish);
                }

                TimeSpan remaining = deadline - _timing.UtcNow();
                if (remaining <= TimeSpan.Zero) break;
                await _timing.DelayAsync(remaining < BlueskySocialPreparationAdapter.ReadinessPollInterval ? remaining : BlueskySocialPreparationAdapter.ReadinessPollInterval, linked.Token).ConfigureAwait(false);
            }
        }
        catch (OperationCanceledException) when (operationDeadline.IsCancellationRequested && !cancellationToken.IsCancellationRequested)
        {
            return null;
        }
        return null;
    }

    public async Task RelinquishAsync(CancellationToken cancellationToken)
    {
        try
        {
            await RequirePage().RelinquishOwnedTargetAsync(cancellationToken: cancellationToken).ConfigureAwait(false);
        }
        finally
        {
            // A detach attempt can report that Chrome already discarded the session.
            // Do not let disposal issue a second detach and obscure that primary outcome.
            _terminal = true;
        }
    }

    public async Task AbandonAsync()
    {
        if (_terminal || _page is null) return;
        try { await _page.CloseOwnedTargetAsync().ConfigureAwait(false); } catch { }
        _terminal = true;
    }

    public async ValueTask DisposeAsync()
    {
        if (_page is null) return;
        if (_terminal) await _page.DisposeLocallyAsync().ConfigureAwait(false);
        else await _page.DisposeAsync().ConfigureAwait(false);
    }

    private BrowserPreparationSession RequirePage() => _page ?? throw new InvalidOperationException("Bluesky page is not initialized.");

    private async Task<BrowserDomNode?> FindModalAsync(CancellationToken cancellationToken)
    {
        JsonElement document = await RequirePage().Session.SendCommandAsync("DOM.getDocument", JsonSerializer.SerializeToElement(new { depth = 0, pierce = false }), cancellationToken: cancellationToken).ConfigureAwait(false);
        if (!document.TryGetProperty("root", out JsonElement root) || !root.TryGetProperty("nodeId", out JsonElement rootId) || !rootId.TryGetInt32(out int nodeId) || nodeId <= 0) return null;
        return await FindNodeWithinAsync(nodeId, Modal, cancellationToken).ConfigureAwait(false);
    }

    private async Task<BrowserDomNode?> FindNodeWithinAsync(int rootNodeId, string selector, CancellationToken cancellationToken)
    {
        JsonElement result = await RequirePage().Session.SendCommandAsync("DOM.querySelector", JsonSerializer.SerializeToElement(new { nodeId = rootNodeId, selector }), cancellationToken: cancellationToken).ConfigureAwait(false);
        if (!result.TryGetProperty("nodeId", out JsonElement nodeId) || !nodeId.TryGetInt32(out int id) || id <= 0) return null;
        return await RequirePage().DescribeNodeAsync(id, cancellationToken).ConfigureAwait(false);
    }
}

/// <summary>Composer-scoped DOM inspection. It never evaluates JavaScript or activates the publish control.</summary>
internal sealed class BlueskyComposer : IBlueskyComposer
{
    private readonly BrowserPreparationSession _page;
    private readonly string _frameId;
    private readonly BrowserDomNode _modal;
    private readonly BrowserDomNode _editor;
    private readonly BrowserDomNode _media;
    private readonly BrowserDomNode _publish;

    internal BrowserTextMismatchDiagnostic? LastTextMismatchDiagnostic { get; private set; }

    internal BlueskyComposer(BrowserPreparationSession page, string frameId, BrowserDomNode modal, BrowserDomNode editor, BrowserDomNode media, BrowserDomNode publish) =>
        (_page, _frameId, _modal, _editor, _media, _publish) = (page, frameId, modal, editor, media, publish);

    public async Task<bool> ReplaceAndVerifyTextAsync(string text, CancellationToken cancellationToken)
    {
        await _page.ReplaceTextAsync(_editor, text, cancellationToken).ConfigureAwait(false);
        return await VerifyTextAsync(text, cancellationToken).ConfigureAwait(false);
    }

    public async Task<bool> AttachMediaAsync(IReadOnlyList<string> paths, CancellationToken cancellationToken)
    {
        try
        {
            await new BrowserFileChooser(_page).AttachTransientFilesAsync(paths, _frameId, token => _page.ActivateAsync(_media, token), cancellationToken: cancellationToken).ConfigureAwait(false);
            return true;
        }
        catch (BrowserPreparationException) { return false; }
    }

    public async Task<BlueskyReadiness> ReadReadinessAsync(int intendedCount, CancellationToken cancellationToken)
    {
        IReadOnlyList<BrowserDomNode> views = await QueryAllAsync("[data-testid='selectedPhotosView']", cancellationToken).ConfigureAwait(false);
        bool rendered = views.Count == intendedCount;
        bool controls = views.Count == intendedCount;
        foreach (BrowserDomNode view in views)
        {
            IReadOnlyList<BrowserDomNode> images = await QueryAllAsync(view.NodeId, "[data-testid='selectedPhotoImage']", cancellationToken).ConfigureAwait(false);
            bool viewControls = (await QueryAllAsync(view.NodeId, "[data-testid='removePhotoButton']", cancellationToken).ConfigureAwait(false)).Count == 1 &&
                (await QueryAllAsync(view.NodeId, "[data-testid='editPhotoButton']", cancellationToken).ConfigureAwait(false)).Count == 1 &&
                (await QueryAllAsync(view.NodeId, "[data-testid='altTextButton']", cancellationToken).ConfigureAwait(false)).Count == 1;
            rendered &= images.Count == 1 && await AllRenderedAsync(images, cancellationToken).ConfigureAwait(false);
            controls &= viewControls;
        }
        bool busy = await ExistsAsync("[aria-busy='true'], progress, [role='progressbar']", cancellationToken).ConfigureAwait(false);
        bool error = await ExistsAsync("[role='alert'], [aria-invalid='true']", cancellationToken).ConfigureAwait(false);
        return new BlueskyReadiness(
            PreviewCountMatches: views.Count == intendedCount,
            ImagesRendered: rendered,
            ControlsMatch: controls,
            // Bluesky exposes DOM order but not filenames, so this records only the ordered preview sequence.
            OrderObserved: views.Count == intendedCount,
            IsBusy: busy,
            HasError: error,
            PublishEnabled: await IsEnabledAsync(_publish, cancellationToken).ConfigureAwait(false));
    }

    public async Task<bool> IsValidWithoutMediaAsync(CancellationToken cancellationToken) =>
        !await ExistsAsync("[role='alert'], [aria-invalid='true']", cancellationToken).ConfigureAwait(false) &&
        !await ExistsAsync("[aria-busy='true'], progress, [role='progressbar']", cancellationToken).ConfigureAwait(false) &&
        await IsEnabledAsync(_publish, cancellationToken).ConfigureAwait(false);

    public async Task<bool> VerifyTextAsync(string text, CancellationToken cancellationToken)
    {
        BrowserTextReadback readback = await _page.ReadTextAsync(_editor, cancellationToken).ConfigureAwait(false);
        bool matches = readback.Actual is not null && string.Equals(readback.Actual, text, StringComparison.Ordinal);
        LastTextMismatchDiagnostic = matches ? null : BrowserTextMismatchDiagnostic.Create(text, readback.Actual, readback.Detail);
        return matches;
    }

    private async Task<bool> ExistsAsync(string selector, CancellationToken cancellationToken) =>
        (await QueryAllAsync(selector, cancellationToken).ConfigureAwait(false)).Count != 0;

    private async Task<IReadOnlyList<BrowserDomNode>> QueryAllAsync(string selector, CancellationToken cancellationToken)
    {
        return await QueryAllAsync(_modal.NodeId, selector, cancellationToken).ConfigureAwait(false);
    }

    private async Task<IReadOnlyList<BrowserDomNode>> QueryAllAsync(int rootNodeId, string selector, CancellationToken cancellationToken)
    {
        JsonElement result = await _page.Session.SendCommandAsync("DOM.querySelectorAll", JsonSerializer.SerializeToElement(new { nodeId = rootNodeId, selector }), cancellationToken: cancellationToken).ConfigureAwait(false);
        if (!result.TryGetProperty("nodeIds", out JsonElement ids) || ids.ValueKind != JsonValueKind.Array) return [];
        var nodes = new List<BrowserDomNode>();
        foreach (JsonElement id in ids.EnumerateArray())
        {
            if (!id.TryGetInt32(out int nodeId) || nodeId <= 0) return [];
            JsonElement described = await _page.Session.SendCommandAsync("DOM.describeNode", JsonSerializer.SerializeToElement(new { nodeId, depth = 0, pierce = false }), cancellationToken: cancellationToken).ConfigureAwait(false);
            if (!described.TryGetProperty("node", out JsonElement node) ||
                !node.TryGetProperty("backendNodeId", out JsonElement backend) || !backend.TryGetInt64(out long backendNodeId) || backendNodeId <= 0 ||
                !node.TryGetProperty("nodeName", out JsonElement nodeName) || nodeName.ValueKind != JsonValueKind.String) return [];
            nodes.Add(new BrowserDomNode(_page.Session.SessionId, nodeId, backendNodeId, nodeName.GetString()!, false, false));
        }
        return nodes;
    }

    private async Task<bool> AllRenderedAsync(IReadOnlyList<BrowserDomNode> nodes, CancellationToken cancellationToken)
    {
        foreach (BrowserDomNode node in nodes)
        {
            JsonElement result;
            try
            {
                result = await _page.Session.SendCommandAsync("DOM.getBoxModel", JsonSerializer.SerializeToElement(new { backendNodeId = node.BackendNodeId }), cancellationToken: cancellationToken).ConfigureAwait(false);
            }
            catch (CdpCommandException exception) when (IsTemporarilyUnavailableBoxModel(exception))
            {
                return false;
            }
            if (!result.TryGetProperty("model", out JsonElement model) || !model.TryGetProperty("width", out JsonElement width) || !width.TryGetDouble(out double w) || w <= 0 ||
                !model.TryGetProperty("height", out JsonElement height) || !height.TryGetDouble(out double h) || h <= 0) return false;
        }
        return true;
    }

    private static bool IsTemporarilyUnavailableBoxModel(CdpCommandException exception) =>
        exception.Code == -32000 && exception.Message.Contains("Could not compute box model", StringComparison.OrdinalIgnoreCase);

    private async Task<bool> IsEnabledAsync(BrowserDomNode node, CancellationToken cancellationToken)
    {
        JsonElement described = await _page.Session.SendCommandAsync("DOM.describeNode", JsonSerializer.SerializeToElement(new { nodeId = node.NodeId, depth = 0, pierce = false }), cancellationToken: cancellationToken).ConfigureAwait(false);
        if (!described.TryGetProperty("node", out JsonElement element) || !element.TryGetProperty("attributes", out JsonElement attributes) || attributes.ValueKind != JsonValueKind.Array) return false;
        for (int index = 0; index + 1 < attributes.GetArrayLength(); index += 2)
        {
            if (attributes[index].ValueKind != JsonValueKind.String || attributes[index + 1].ValueKind != JsonValueKind.String) return false;
            string name = attributes[index].GetString()!;
            string value = attributes[index + 1].GetString()!;
            if (string.Equals(name, "disabled", StringComparison.OrdinalIgnoreCase) ||
                (string.Equals(name, "aria-disabled", StringComparison.OrdinalIgnoreCase) && string.Equals(value, "true", StringComparison.OrdinalIgnoreCase))) return false;
        }
        return true;
    }
}
