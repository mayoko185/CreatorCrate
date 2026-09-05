using System.Text;
using System.Text.Json;

namespace OpenLocally;

/// <summary>Prepares an X composer without ever activating its Post control.</summary>
public sealed class XSocialPreparationAdapter : ISocialPreparationAdapter
{
    internal static readonly TimeSpan StabilityInterval = TimeSpan.FromMilliseconds(250);
    internal static readonly TimeSpan ReadinessPollInterval = TimeSpan.FromMilliseconds(50);
    private readonly Func<BrowserPreparationTargets, IXPreparationPage> _createPage;
    private readonly bool _requiresBrowserTargets;
    private readonly XTiming _timing;
    private readonly Action<BrowserTextMismatchDiagnostic>? _reportInitialTextMismatch;

    public XSocialPreparationAdapter() : this(targets => new XPreparationPage(targets), true, XTiming.System, null) { }

    internal XSocialPreparationAdapter(Action<BrowserTextMismatchDiagnostic> reportInitialTextMismatch)
        : this(targets => new XPreparationPage(targets), true, XTiming.System, reportInitialTextMismatch) { }

    internal XSocialPreparationAdapter(
        Func<BrowserPreparationTargets, IXPreparationPage> createPage,
        XTiming? timing = null,
        Action<BrowserTextMismatchDiagnostic>? reportInitialTextMismatch = null)
        : this(createPage, false, timing ?? XTiming.System, reportInitialTextMismatch) { }

    private XSocialPreparationAdapter(
        Func<BrowserPreparationTargets, IXPreparationPage> createPage,
        bool requiresBrowserTargets,
        XTiming timing,
        Action<BrowserTextMismatchDiagnostic>? reportInitialTextMismatch)
    {
        _createPage = createPage ?? throw new ArgumentNullException(nameof(createPage));
        _requiresBrowserTargets = requiresBrowserTargets;
        _timing = timing ?? throw new ArgumentNullException(nameof(timing));
        _reportInitialTextMismatch = reportInitialTextMismatch;
    }

    public string Platform => "x";

    public async Task<PlatformPreparationResult> PrepareAsync(
        PlatformPreparationContext context,
        IPreparationProgress progress,
        CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(context);
        ArgumentNullException.ThrowIfNull(progress);
        if (!string.Equals(context.Platform, Platform, StringComparison.Ordinal) || (_requiresBrowserTargets && context.BrowserTargets is null))
            throw new SocialPreparationRuntimeException("x_target_closed");

        using CancellationTokenSource operationDeadline = _timing.CreateDeadlineSource();
        using CancellationTokenSource linked = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken, operationDeadline.Token);
        await using IXPreparationPage page = _createPage(context.BrowserTargets!);
        bool preservePage = false;
        XPreparationPhase phase = XPreparationPhase.Home;
        var diagnostic = new SocialPreparationDiagnostic(Platform, "home", "platform_preparation_failed");
        try
        {
            XHomeState home = await page.NavigateAndWaitForHomeAsync(linked.Token).ConfigureAwait(false);
            if (home is XHomeState.AuthenticationRequired or XHomeState.ManualAttentionRequired)
            {
                preservePage = true;
                try { await page.RelinquishAsync(linked.Token).ConfigureAwait(false); }
                catch (OperationCanceledException) when (operationDeadline.IsCancellationRequested && !cancellationToken.IsCancellationRequested) { }
                catch (OperationCanceledException) { throw; }
                catch { }
                return PlatformPreparationResult.AuthenticationRequired();
            }
            if (home != XHomeState.Authenticated) throw new XPreparationException("x_home_timeout");
            diagnostic.Checkpoint("home_ready");
            diagnostic.TargetState("owned_target_created", true);

            phase = XPreparationPhase.Compose;
            if (!await page.ActivateComposeAsync(linked.Token).ConfigureAwait(false))
                throw new XPreparationException("x_compose_missing");
            diagnostic.SetPhase("compose_activation");
            diagnostic.Checkpoint("compose_activated");
            phase = XPreparationPhase.Composer;
            IXComposer? composer = await page.WaitForComposerAsync(linked.Token).ConfigureAwait(false);
            if (composer is null) throw new XPreparationException("x_composer_missing");
            diagnostic.SetPhase("editor_ready");
            diagnostic.Checkpoint("editor_ready");

            phase = XPreparationPhase.InitialText;
            await progress.ReportAsync(SocialPreparationProgress.Preparing, linked.Token).ConfigureAwait(false);
            if (!await composer.ReplaceAndVerifyTextAsync(context.Body, linked.Token).ConfigureAwait(false))
            {
                if (composer.LastTextMismatchDiagnostic is not null)
                    _reportInitialTextMismatch?.Invoke(composer.LastTextMismatchDiagnostic);
                throw new XPreparationException("x_text_mismatch");
            }
            diagnostic.SetPhase("initial_text");
            diagnostic.Checkpoint("initial_text_verified");

            if (context.MediaPaths.Count > 0)
            {
                phase = XPreparationPhase.MediaAssignment;
                await progress.ReportAsync(SocialPreparationProgress.Uploading, linked.Token).ConfigureAwait(false);
                XMediaAssignment assignment = await composer.AttachMediaAsync(context.MediaPaths, linked.Token).ConfigureAwait(false);
                if (assignment == XMediaAssignment.InputMissing) throw new XPreparationException("x_media_input_missing");
                if (assignment != XMediaAssignment.Assigned) throw new XPreparationException("x_media_assignment_failed");
                diagnostic.SetPhase("media_assignment");
                diagnostic.Checkpoint("media_assigned");
                phase = XPreparationPhase.MediaReadiness;
                await RequireStableReadyAsync(composer, context.MediaPaths.Count, _timing, linked.Token).ConfigureAwait(false);
                diagnostic.SetPhase("media_readiness");
                diagnostic.Checkpoint("media_ready");
            }
            else
            {
                phase = XPreparationPhase.InitialValidation;
                if (!await composer.IsReadyForHandoffAsync(linked.Token).ConfigureAwait(false))
                    throw new XPreparationException("x_validation_error");
            }

            phase = XPreparationPhase.FinalText;
            if (!await composer.VerifyTextAsync(context.Body, linked.Token).ConfigureAwait(false))
                throw new XPreparationException("x_prepared_assertion_failed");
            diagnostic.SetPhase("final_text");
            diagnostic.Checkpoint("final_text_verified");

            phase = XPreparationPhase.FinalValidation;
            if (!await composer.IsReadyForHandoffAsync(linked.Token).ConfigureAwait(false))
                throw new XPreparationException("x_validation_error");
            diagnostic.SetPhase("final_composer_assertion");
            diagnostic.Checkpoint("final_composer_asserted");

            phase = XPreparationPhase.Relinquish;
            await page.RelinquishAsync(linked.Token).ConfigureAwait(false);
            preservePage = true;
            diagnostic.TargetState("target_relinquished", true);
            return PlatformPreparationResult.Prepared();
        }
        catch (OperationCanceledException) when (operationDeadline.IsCancellationRequested && !cancellationToken.IsCancellationRequested)
        {
            throw Failure(TimeoutCode(phase), diagnostic, phase, new TimeoutException());
        }
        catch (XPreparationException exception)
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
            throw Failure("x_target_closed", diagnostic, phase, exception);
        }
        catch (ObjectDisposedException)
        {
            throw Failure("x_target_closed", diagnostic, phase, new ObjectDisposedException("target"));
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
                try { await page.AbandonAsync(linked.Token).ConfigureAwait(false); diagnostic.TargetState("cleanup_succeeded", true); }
                catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested) { throw; }
                catch (Exception exception) { diagnostic.TargetState("cleanup_succeeded", false); diagnostic.CaptureCleanup(exception, operationDeadline.IsCancellationRequested); }
            }
        }
    }

    private static SocialPreparationRuntimeException Failure(string code, SocialPreparationDiagnostic diagnostic, XPreparationPhase phase, Exception exception)
    {
        diagnostic.SetPhase(Phase(phase));
        diagnostic.SetStableCode(code);
        diagnostic.CapturePrimary(exception);
        diagnostic.TargetState("target_still_present", true);
        return new SocialPreparationRuntimeException(code, exception, diagnostic);
    }

    private static string Phase(XPreparationPhase phase) => phase switch
    {
        XPreparationPhase.Home => "home", XPreparationPhase.Compose => "compose_activation", XPreparationPhase.Composer => "editor_ready",
        XPreparationPhase.InitialText => "initial_text", XPreparationPhase.MediaAssignment => "media_assignment",
        XPreparationPhase.MediaReadiness => "media_readiness", XPreparationPhase.InitialValidation => "initial_validation",
        XPreparationPhase.FinalText => "final_text", XPreparationPhase.FinalValidation => "final_composer_assertion",
        XPreparationPhase.Relinquish => "relinquish", _ => "unknown",
    };

    private static string TimeoutCode(XPreparationPhase phase) => phase switch
    {
        XPreparationPhase.Home => "x_home_timeout",
        XPreparationPhase.Compose => "x_compose_missing",
        XPreparationPhase.Composer => "x_composer_missing",
        XPreparationPhase.InitialText => "x_text_mismatch",
        XPreparationPhase.MediaAssignment => "x_media_assignment_failed",
        XPreparationPhase.MediaReadiness => "x_media_not_ready",
        XPreparationPhase.InitialValidation => "x_validation_error",
        XPreparationPhase.FinalText => "x_prepared_assertion_failed",
        XPreparationPhase.FinalValidation => "x_validation_error",
        XPreparationPhase.Relinquish => "x_target_closed",
        _ => throw new ArgumentOutOfRangeException(nameof(phase)),
    };

    private static async Task RequireStableReadyAsync(IXComposer composer, int intendedCount, XTiming timing, CancellationToken cancellationToken)
    {
        DateTimeOffset deadline = timing.UtcNow() + timing.ReadinessTimeout;
        XReadiness? first = null;
        XReadiness? last = null;
        while (timing.UtcNow() < deadline)
        {
            last = await composer.ReadReadinessAsync(intendedCount, cancellationToken).ConfigureAwait(false);
            if (IsReady(last))
            {
                first = last;
                break;
            }

            TimeSpan remaining = deadline - timing.UtcNow();
            if (remaining <= TimeSpan.Zero) break;
            await timing.DelayAsync(remaining < ReadinessPollInterval ? remaining : ReadinessPollInterval, cancellationToken).ConfigureAwait(false);
        }

        if (first is null) ThrowForReadiness(last ?? new XReadiness(false, false, false, false, true, false, false));
        if (timing.UtcNow() >= deadline) throw new XPreparationException("x_media_not_ready");
        await timing.DelayAsync(StabilityInterval, cancellationToken).ConfigureAwait(false);
        if (timing.UtcNow() >= deadline) throw new XPreparationException("x_media_not_ready");
        ThrowForReadiness(await composer.ReadReadinessAsync(intendedCount, cancellationToken).ConfigureAwait(false));
    }

    private static bool IsReady(XReadiness readiness) =>
        readiness.GroupCountMatches && readiness.ImagesRendered && readiness.ControlsMatch && readiness.OrderObserved &&
        !readiness.IsBusy && !readiness.HasError && readiness.PostEnabled;

    private static void ThrowForReadiness(XReadiness readiness)
    {
        if (readiness.HasError) throw new XPreparationException("x_validation_error");
        if (!readiness.GroupCountMatches || !readiness.ImagesRendered || !readiness.ControlsMatch || !readiness.OrderObserved)
            throw new XPreparationException("x_media_preview_incomplete");
        if (readiness.IsBusy) throw new XPreparationException("x_media_not_ready");
        if (!readiness.PostEnabled) throw new XPreparationException("x_validation_error");
    }
}

internal sealed class XTiming
{
    internal static XTiming System { get; } = new(BrowserPreparationSession.DefaultReadinessTimeout, () => DateTimeOffset.UtcNow, Task.Delay);
    private readonly Func<TimeSpan, CancellationTokenSource> _createDeadlineSource;

    internal XTiming(TimeSpan readinessTimeout, Func<DateTimeOffset> utcNow, Func<TimeSpan, CancellationToken, Task> delayAsync,
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

internal enum XPreparationPhase { Home, Compose, Composer, InitialText, MediaAssignment, MediaReadiness, InitialValidation, FinalText, FinalValidation, Relinquish }
internal enum XHomeState { Authenticated, AuthenticationRequired, ManualAttentionRequired, TimedOut }
internal enum XMediaAssignment { Assigned, InputMissing, Failed }
internal sealed record XReadiness(bool GroupCountMatches, bool ImagesRendered, bool ControlsMatch, bool OrderObserved, bool IsBusy, bool HasError, bool PostEnabled);

internal interface IXPreparationPage : IAsyncDisposable
{
    Task<XHomeState> NavigateAndWaitForHomeAsync(CancellationToken cancellationToken);
    Task<bool> ActivateComposeAsync(CancellationToken cancellationToken);
    Task<IXComposer?> WaitForComposerAsync(CancellationToken cancellationToken);
    Task RelinquishAsync(CancellationToken cancellationToken);
    Task AbandonAsync(CancellationToken cancellationToken);
}

internal interface IXComposer
{
    BrowserTextMismatchDiagnostic? LastTextMismatchDiagnostic { get; }
    Task<bool> ReplaceAndVerifyTextAsync(string text, CancellationToken cancellationToken);
    Task<XMediaAssignment> AttachMediaAsync(IReadOnlyList<string> paths, CancellationToken cancellationToken);
    Task<XReadiness> ReadReadinessAsync(int intendedCount, CancellationToken cancellationToken);
    Task<bool> IsReadyForHandoffAsync(CancellationToken cancellationToken);
    Task<bool> VerifyTextAsync(string text, CancellationToken cancellationToken);
}

internal sealed class XPreparationException(string code) : Exception(code)
{
    internal string Code { get; } = code;
}

/// <summary>Bounded X CDP page implementation. It scopes every composer query to the modal and never evaluates page script.</summary>
internal sealed class XPreparationPage : IXPreparationPage
{
    private const string HomeUrl = "https://x.com/home";
    private const string Compose = "[data-testid='SideNav_NewTweet_Button']";
    private const string Modal = "div[role='dialog'][aria-modal='true']";
    private const string Editor = "[data-testid='tweetTextarea_0'][contenteditable='true']";
    private const string Post = "button[data-testid='tweetButton']";
    private readonly BrowserPreparationTargets _targets;
    private readonly XTiming _timing;
    private BrowserPreparationSession? _page;
    private bool _terminal;

    internal XPreparationPage(BrowserPreparationTargets targets, XTiming? timing = null)
    {
        _targets = targets ?? throw new ArgumentNullException(nameof(targets));
        _timing = timing ?? XTiming.System;
    }

    public async Task<XHomeState> NavigateAndWaitForHomeAsync(CancellationToken cancellationToken)
    {
        _page = await _targets.CreateOwnedAsync(cancellationToken: cancellationToken).ConfigureAwait(false);
        await _page.NavigateAsync(HomeUrl, cancellationToken: cancellationToken).ConfigureAwait(false);
        await _page.WaitForDocumentAsync(cancellationToken: cancellationToken).ConfigureAwait(false);
        while (true)
        {
            if (await FindFreshFromDocumentAsync(Compose, cancellationToken).ConfigureAwait(false) is not null) return XHomeState.Authenticated;
            if (await FindFreshFromDocumentAsync("a[href='/i/flow/login'], a[href*='login']", cancellationToken).ConfigureAwait(false) is not null)
                return XHomeState.AuthenticationRequired;
            if (await FindFreshFromDocumentAsync("form[action*='challenge'], [data-testid='ocfEnterTextTextInput']", cancellationToken).ConfigureAwait(false) is not null)
                return XHomeState.ManualAttentionRequired;
            await _timing.DelayAsync(XSocialPreparationAdapter.ReadinessPollInterval, cancellationToken).ConfigureAwait(false);
        }
    }

    public async Task<bool> ActivateComposeAsync(CancellationToken cancellationToken)
    {
        BrowserDomNode? compose = await FindFreshFromDocumentAsync(Compose, cancellationToken).ConfigureAwait(false);
        if (compose is null) return false;
        await RequirePage().ActivateAsync(compose, cancellationToken).ConfigureAwait(false);
        return true;
    }

    public async Task<IXComposer?> WaitForComposerAsync(CancellationToken cancellationToken)
    {
        while (true)
        {
            BrowserDomNode? modal = await FindFreshFromDocumentAsync(Modal, cancellationToken).ConfigureAwait(false);
            if (modal is not null && await FindFreshWithinAsync(modal.NodeId, Editor, cancellationToken).ConfigureAwait(false) is not null &&
                await FindFreshWithinAsync(modal.NodeId, Post, cancellationToken).ConfigureAwait(false) is not null)
                return new XComposer(RequirePage());

            await _timing.DelayAsync(XSocialPreparationAdapter.ReadinessPollInterval, cancellationToken).ConfigureAwait(false);
        }
    }

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

    private BrowserPreparationSession RequirePage() => _page ?? throw new InvalidOperationException("X page is not initialized.");

    private async Task<BrowserDomNode?> FindFreshFromDocumentAsync(string selector, CancellationToken cancellationToken)
    {
        while (true)
        {
            JsonElement document = await RequirePage().Session.SendCommandAsync("DOM.getDocument", JsonSerializer.SerializeToElement(new { depth = 0, pierce = false }), cancellationToken: cancellationToken).ConfigureAwait(false);
            if (!TryRoot(document, out int rootNodeId)) return null;
            BrowserDomNode? node = await FindFreshWithinAsync(rootNodeId, selector, cancellationToken).ConfigureAwait(false);
            return node;
        }
    }

    private async Task<BrowserDomNode?> FindFreshWithinAsync(int rootNodeId, string selector, CancellationToken cancellationToken)
    {
        while (true)
        {
            JsonElement result = await RequirePage().Session.SendCommandAsync("DOM.querySelector", JsonSerializer.SerializeToElement(new { nodeId = rootNodeId, selector }), cancellationToken: cancellationToken).ConfigureAwait(false);
            if (!result.TryGetProperty("nodeId", out JsonElement nodeId) || !nodeId.TryGetInt32(out int id) || id <= 0) return null;
            try { return await RequirePage().DescribeNodeAsync(id, cancellationToken).ConfigureAwait(false); }
            catch (CdpCommandException exception) when (IsStaleFrontendNode(exception)) { }
        }
    }

    private static bool TryRoot(JsonElement document, out int rootNodeId)
    {
        rootNodeId = 0;
        return document.TryGetProperty("root", out JsonElement root) && root.TryGetProperty("nodeId", out JsonElement nodeId) && nodeId.TryGetInt32(out rootNodeId) && rootNodeId > 0;
    }

    internal static bool IsStaleFrontendNode(CdpCommandException exception) =>
        exception.Code == -32000 && string.Equals(exception.Message, "Could not find node with given id", StringComparison.Ordinal);
}

/// <summary>X modal-scoped composer operations, including exact Draft.js logical-block readback.</summary>
internal sealed class XComposer : IXComposer
{
    private const string Modal = "div[role='dialog'][aria-modal='true']";
    private const string Editor = "[data-testid='tweetTextarea_0'][contenteditable='true']";
    private const string FileInput = "input[data-testid='fileInput'][type='file']";
    private const string Attachments = "[data-testid='attachments']";
    private const string MediaGroup = "[role='group'][aria-label='Media']";
    private const string RemoveMedia = "button[aria-label='Remove media']";
    private const string Post = "button[data-testid='tweetButton']";
    private const int DraftBlockTraversalLimit = 128;
    private const int DraftEditorDescribeDepth = 2 + (DraftBlockTraversalLimit - 1);
    private readonly BrowserPreparationSession _page;

    internal XComposer(BrowserPreparationSession page) => _page = page ?? throw new ArgumentNullException(nameof(page));
    internal BrowserTextMismatchDiagnostic? LastTextMismatchDiagnostic { get; private set; }
    BrowserTextMismatchDiagnostic? IXComposer.LastTextMismatchDiagnostic => LastTextMismatchDiagnostic;

    public async Task<bool> ReplaceAndVerifyTextAsync(string text, CancellationToken cancellationToken)
    {
        BrowserDomNode? editor = await FindEditorAsync(cancellationToken).ConfigureAwait(false);
        if (editor is null) return false;
        await _page.ReplaceTextAsync(editor, text, cancellationToken).ConfigureAwait(false);
        return await VerifyTextAsync(text, cancellationToken).ConfigureAwait(false);
    }

    public async Task<XMediaAssignment> AttachMediaAsync(IReadOnlyList<string> paths, CancellationToken cancellationToken)
    {
        BrowserDomNode? modal = await FindModalAsync(cancellationToken).ConfigureAwait(false);
        if (modal is null) return XMediaAssignment.InputMissing;
        BrowserDomNode? input = await FindFreshWithinAsync(modal.NodeId, FileInput, cancellationToken).ConfigureAwait(false);
        if (input is null) return XMediaAssignment.InputMissing;
        try
        {
            await _page.SetFileInputFilesAsync(input, paths, cancellationToken).ConfigureAwait(false);
            return XMediaAssignment.Assigned;
        }
        catch (BrowserPreparationException) { return XMediaAssignment.Failed; }
        catch (CdpCommandException) { return XMediaAssignment.Failed; }
    }

    public async Task<XReadiness> ReadReadinessAsync(int intendedCount, CancellationToken cancellationToken)
    {
        BrowserDomNode? modal = await FindModalAsync(cancellationToken).ConfigureAwait(false);
        if (modal is null) return new XReadiness(false, false, false, false, true, false, false);
        BrowserDomNode? attachments = await FindFreshWithinAsync(modal.NodeId, Attachments, cancellationToken).ConfigureAwait(false);
        IReadOnlyList<BrowserDomNode> groups = attachments is null ? [] : await QueryAllFreshAsync(attachments.NodeId, MediaGroup, cancellationToken).ConfigureAwait(false);
        bool rendered = groups.Count == intendedCount;
        bool controls = groups.Count == intendedCount;
        foreach (BrowserDomNode group in groups)
        {
            IReadOnlyList<BrowserDomNode> images = await QueryAllFreshAsync(group.NodeId, "img", cancellationToken).ConfigureAwait(false);
            rendered &= images.Count == 1 && await AllRenderedAsync(images, cancellationToken).ConfigureAwait(false);
            controls &= (await QueryAllFreshAsync(group.NodeId, RemoveMedia, cancellationToken).ConfigureAwait(false)).Count == 1;
        }
        bool busy = await ExistsAsync(modal.NodeId, "[aria-busy='true'], [role='progressbar']", cancellationToken).ConfigureAwait(false);
        bool error = await ExistsAsync(modal.NodeId, "[role='alert'], [aria-invalid='true']", cancellationToken).ConfigureAwait(false);
        return new XReadiness(
            groups.Count == intendedCount,
            rendered,
            controls,
            groups.Count == intendedCount,
            busy,
            error,
            await IsPostEnabledAsync(modal.NodeId, cancellationToken).ConfigureAwait(false));
    }

    public async Task<bool> IsReadyForHandoffAsync(CancellationToken cancellationToken)
    {
        BrowserDomNode? modal = await FindModalAsync(cancellationToken).ConfigureAwait(false);
        return modal is not null &&
            !await ExistsAsync(modal.NodeId, "[aria-busy='true'], [role='progressbar']", cancellationToken).ConfigureAwait(false) &&
            !await ExistsAsync(modal.NodeId, "[role='alert'], [aria-invalid='true']", cancellationToken).ConfigureAwait(false) &&
            await IsPostEnabledAsync(modal.NodeId, cancellationToken).ConfigureAwait(false);
    }

    public async Task<bool> VerifyTextAsync(string text, CancellationToken cancellationToken)
    {
        (string? actual, string structure) = await ReadDraftTextAsync(cancellationToken).ConfigureAwait(false);
        bool matches = actual is not null && string.Equals(actual, text, StringComparison.Ordinal);
        LastTextMismatchDiagnostic = matches ? null : BrowserTextMismatchDiagnostic.Create(text, actual, structure);
        return matches;
    }

    private async Task<(string? Actual, string Structure)> ReadDraftTextAsync(CancellationToken cancellationToken)
    {
        while (true)
        {
            BrowserDomNode? editor = await FindEditorAsync(cancellationToken).ConfigureAwait(false);
            if (editor is null) return (null, "x_draft_blocks;editor_found=0");
            try
            {
                JsonElement result = await _page.Session.SendCommandAsync("DOM.describeNode", JsonSerializer.SerializeToElement(new { nodeId = editor.NodeId, depth = DraftEditorDescribeDepth, pierce = false }), cancellationToken: cancellationToken).ConfigureAwait(false);
                if (!result.TryGetProperty("node", out JsonElement node)) return (null, "x_draft_blocks;describe_node_missing=1");
                return TryReadDraftText(node, out string? text, out string structure) ? (text, structure) : (null, structure);
            }
            catch (CdpCommandException exception) when (XPreparationPage.IsStaleFrontendNode(exception)) { }
        }
    }

    private async Task<BrowserDomNode?> FindModalAsync(CancellationToken cancellationToken)
    {
        JsonElement document = await _page.Session.SendCommandAsync("DOM.getDocument", JsonSerializer.SerializeToElement(new { depth = 0, pierce = false }), cancellationToken: cancellationToken).ConfigureAwait(false);
        if (!document.TryGetProperty("root", out JsonElement root) || !root.TryGetProperty("nodeId", out JsonElement rootId) || !rootId.TryGetInt32(out int nodeId) || nodeId <= 0) return null;
        return await FindFreshWithinAsync(nodeId, Modal, cancellationToken).ConfigureAwait(false);
    }

    private async Task<BrowserDomNode?> FindEditorAsync(CancellationToken cancellationToken)
    {
        BrowserDomNode? modal = await FindModalAsync(cancellationToken).ConfigureAwait(false);
        return modal is null ? null : await FindFreshWithinAsync(modal.NodeId, Editor, cancellationToken).ConfigureAwait(false);
    }

    private async Task<bool> ExistsAsync(int rootNodeId, string selector, CancellationToken cancellationToken) =>
        (await QueryAllFreshAsync(rootNodeId, selector, cancellationToken).ConfigureAwait(false)).Count != 0;

    private async Task<BrowserDomNode?> FindFreshWithinAsync(int rootNodeId, string selector, CancellationToken cancellationToken)
    {
        while (true)
        {
            JsonElement result = await _page.Session.SendCommandAsync("DOM.querySelector", JsonSerializer.SerializeToElement(new { nodeId = rootNodeId, selector }), cancellationToken: cancellationToken).ConfigureAwait(false);
            if (!result.TryGetProperty("nodeId", out JsonElement nodeId) || !nodeId.TryGetInt32(out int id) || id <= 0) return null;
            try { return await _page.DescribeNodeAsync(id, cancellationToken).ConfigureAwait(false); }
            catch (CdpCommandException exception) when (XPreparationPage.IsStaleFrontendNode(exception)) { }
        }
    }

    private async Task<IReadOnlyList<BrowserDomNode>> QueryAllFreshAsync(int rootNodeId, string selector, CancellationToken cancellationToken)
    {
        while (true)
        {
            JsonElement result = await _page.Session.SendCommandAsync("DOM.querySelectorAll", JsonSerializer.SerializeToElement(new { nodeId = rootNodeId, selector }), cancellationToken: cancellationToken).ConfigureAwait(false);
            if (!result.TryGetProperty("nodeIds", out JsonElement nodeIds) || nodeIds.ValueKind != JsonValueKind.Array) return [];
            var nodes = new List<BrowserDomNode>();
            try
            {
                foreach (JsonElement value in nodeIds.EnumerateArray())
                {
                    if (!value.TryGetInt32(out int nodeId) || nodeId <= 0) return [];
                    nodes.Add(await _page.DescribeNodeAsync(nodeId, cancellationToken).ConfigureAwait(false));
                }
                return nodes;
            }
            catch (CdpCommandException exception) when (XPreparationPage.IsStaleFrontendNode(exception)) { }
        }
    }

    private async Task<bool> AllRenderedAsync(IReadOnlyList<BrowserDomNode> images, CancellationToken cancellationToken)
    {
        foreach (BrowserDomNode image in images)
        {
            try
            {
                JsonElement result = await _page.Session.SendCommandAsync("DOM.getBoxModel", JsonSerializer.SerializeToElement(new { backendNodeId = image.BackendNodeId }), cancellationToken: cancellationToken).ConfigureAwait(false);
                if (!result.TryGetProperty("model", out JsonElement model) || !model.TryGetProperty("width", out JsonElement width) || !width.TryGetDouble(out double w) || w <= 0 ||
                    !model.TryGetProperty("height", out JsonElement height) || !height.TryGetDouble(out double h) || h <= 0) return false;
            }
            catch (CdpCommandException exception) when (IsTemporaryBoxModelUnavailable(exception)) { return false; }
        }
        return true;
    }

    private async Task<bool> IsPostEnabledAsync(int modalNodeId, CancellationToken cancellationToken)
    {
        BrowserDomNode? post = await FindFreshWithinAsync(modalNodeId, Post, cancellationToken).ConfigureAwait(false);
        if (post is null) return false;
        JsonElement result;
        try
        {
            result = await _page.Session.SendCommandAsync("DOM.getAttributes", JsonSerializer.SerializeToElement(new { nodeId = post.NodeId }), cancellationToken: cancellationToken).ConfigureAwait(false);
        }
        catch (CdpCommandException exception) when (XPreparationPage.IsStaleFrontendNode(exception))
        {
            BrowserDomNode? currentModal = await FindModalAsync(cancellationToken).ConfigureAwait(false);
            return currentModal is not null && await IsPostEnabledAsync(currentModal.NodeId, cancellationToken).ConfigureAwait(false);
        }
        if (!result.TryGetProperty("attributes", out JsonElement attributes) || attributes.ValueKind != JsonValueKind.Array) return false;
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

    private static bool IsTemporaryBoxModelUnavailable(CdpCommandException exception) =>
        exception.Code == -32000 && exception.Message.Contains("Could not compute box model", StringComparison.OrdinalIgnoreCase);

    private static bool TryReadDraftText(JsonElement editor, out string? text, out string structure)
    {
        text = null;
        DraftReadbackStructureSummary summary = DraftReadbackStructureSummary.Create(editor);
        structure = summary.Format();
        if (!TryChildren(editor, out JsonElement contents) || !HasAttribute(contents, "data-contents", "true") || !TryChildrenArray(contents, out JsonElement blocks)) return false;
        var lines = new List<string>();
        foreach (JsonElement block in blocks.EnumerateArray())
        {
            if (!HasAttribute(block, "data-block", "true")) continue;
            var builder = new StringBuilder();
            int visited = 0;
            if (!AppendText(block, builder, ref visited, DraftBlockTraversalLimit))
            {
                structure = summary.Format(traversalBoundReached: true);
                return false;
            }
            if (builder.Length == 0 && !ContainsEmptyDraftBreak(block, ref visited, DraftBlockTraversalLimit))
            {
                structure = summary.Format(traversalBoundReached: visited > DraftBlockTraversalLimit);
                return false;
            }
            lines.Add(builder.ToString());
        }
        text = string.Join("\n", lines);
        return lines.Count != 0;
    }

    private sealed class DraftReadbackStructureSummary
    {
        private const int DirectBlockSummaryLimit = 16;
        private readonly List<(int TextNodes, int DraftBreaks)> _blocks = [];

        private DraftReadbackStructureSummary(bool contentsFound, int directBlockCount, int descendantBlockCount, bool traversalBoundReached)
        {
            ContentsFound = contentsFound;
            DirectBlockCount = directBlockCount;
            DescendantBlockCount = descendantBlockCount;
            TraversalBoundReached = traversalBoundReached;
        }

        private bool ContentsFound { get; }
        private int DirectBlockCount { get; }
        private int DescendantBlockCount { get; }
        private bool TraversalBoundReached { get; }

        internal static DraftReadbackStructureSummary Create(JsonElement editor)
        {
            if (!TryChildren(editor, out JsonElement contents) || !HasAttribute(contents, "data-contents", "true") || !TryChildrenArray(contents, out JsonElement children))
                return new(false, 0, 0, false);

            int directBlockCount = 0;
            int descendantBlockCount = 0;
            int descendantVisited = 0;
            bool traversalBoundReached = false;
            var blockCounts = new List<(int TextNodes, int DraftBreaks)>(DirectBlockSummaryLimit);
            foreach (JsonElement child in children.EnumerateArray())
            {
                if (HasAttribute(child, "data-block", "true"))
                {
                    directBlockCount++;
                    if (blockCounts.Count < DirectBlockSummaryLimit)
                    {
                        (int textNodes, int draftBreaks, bool bounded) = CountBlockStructure(child);
                        blockCounts.Add((textNodes, draftBreaks));
                        traversalBoundReached |= bounded;
                    }
                }
                CountDescendantBlocks(child, ref descendantBlockCount, ref traversalBoundReached, ref descendantVisited);
            }
            var summary = new DraftReadbackStructureSummary(true, directBlockCount, descendantBlockCount, traversalBoundReached);
            summary._blocks.AddRange(blockCounts);
            return summary;
        }

        internal string Format(bool traversalBoundReached = false)
        {
            string blocks = _blocks.Count == 0
                ? "none"
                : string.Join(",", _blocks.Select((block, index) => $"{index}:text={block.TextNodes},br={block.DraftBreaks}"));
            bool blockSummariesTruncated = DirectBlockCount > _blocks.Count;
            return $"x_draft_blocks;contents_found={(ContentsFound ? 1 : 0)};direct_block_count={DirectBlockCount};descendant_block_count={DescendantBlockCount};blocks={blocks};block_summaries_truncated={(blockSummariesTruncated ? 1 : 0)};traversal_bound_reached={(TraversalBoundReached || traversalBoundReached ? 1 : 0)}";
        }

        private static (int TextNodes, int DraftBreaks, bool Bounded) CountBlockStructure(JsonElement block)
        {
            int visited = 0;
            int textNodes = 0;
            int draftBreaks = 0;
            bool bounded = CountBlockNodes(block, ref visited, ref textNodes, ref draftBreaks);
            return (textNodes, draftBreaks, bounded);
        }

        private static bool CountBlockNodes(JsonElement node, ref int visited, ref int textNodes, ref int draftBreaks)
        {
            if (++visited > DraftBlockTraversalLimit) return true;
            if (node.TryGetProperty("nodeType", out JsonElement type) && type.TryGetInt32(out int value) && value == 3) textNodes++;
            if (NodeNameIs(node, "BR") && HasAttribute(node, "data-text", "true")) draftBreaks++;
            if (!TryChildrenArray(node, out JsonElement children)) return false;
            foreach (JsonElement child in children.EnumerateArray())
            {
                if (CountBlockNodes(child, ref visited, ref textNodes, ref draftBreaks)) return true;
            }
            return false;
        }

        private static void CountDescendantBlocks(JsonElement node, ref int count, ref bool traversalBoundReached, ref int visited)
        {
            if (++visited > DraftBlockTraversalLimit)
            {
                traversalBoundReached = true;
                return;
            }
            if (HasAttribute(node, "data-block", "true")) count++;
            if (!TryChildrenArray(node, out JsonElement children)) return;
            foreach (JsonElement child in children.EnumerateArray())
                CountDescendantBlocks(child, ref count, ref traversalBoundReached, ref visited);
        }
    }

    private static bool TryChildren(JsonElement node, out JsonElement child)
    {
        child = default;
        if (!TryChildrenArray(node, out JsonElement children)) return false;
        foreach (JsonElement candidate in children.EnumerateArray())
        {
            if (HasAttribute(candidate, "data-contents", "true")) { child = candidate; return true; }
        }
        return false;
    }

    private static bool TryChildrenArray(JsonElement node, out JsonElement children) =>
        node.TryGetProperty("children", out children) && children.ValueKind == JsonValueKind.Array;

    private static bool AppendText(JsonElement node, StringBuilder text, ref int visited, int limit)
    {
        if (++visited > limit) return false;
        if (node.TryGetProperty("nodeType", out JsonElement type) && type.TryGetInt32(out int value) && value == 3 &&
            node.TryGetProperty("nodeValue", out JsonElement nodeValue) && nodeValue.ValueKind == JsonValueKind.String)
            text.Append(nodeValue.GetString());
        if (!TryChildrenArray(node, out JsonElement children)) return true;
        foreach (JsonElement child in children.EnumerateArray()) if (!AppendText(child, text, ref visited, limit)) return false;
        return true;
    }

    private static bool ContainsEmptyDraftBreak(JsonElement node, ref int visited, int limit)
    {
        if (++visited > limit) return false;
        if (NodeNameIs(node, "BR") && HasAttribute(node, "data-text", "true")) return true;
        if (!TryChildrenArray(node, out JsonElement children)) return false;
        foreach (JsonElement child in children.EnumerateArray()) if (ContainsEmptyDraftBreak(child, ref visited, limit)) return true;
        return false;
    }

    private static bool NodeNameIs(JsonElement node, string value) =>
        node.TryGetProperty("nodeName", out JsonElement name) && name.ValueKind == JsonValueKind.String && string.Equals(name.GetString(), value, StringComparison.OrdinalIgnoreCase);

    private static bool HasAttribute(JsonElement node, string expectedName, string expectedValue)
    {
        if (!node.TryGetProperty("attributes", out JsonElement attributes) || attributes.ValueKind != JsonValueKind.Array) return false;
        for (int index = 0; index + 1 < attributes.GetArrayLength(); index += 2)
        {
            if (attributes[index].ValueKind == JsonValueKind.String && attributes[index + 1].ValueKind == JsonValueKind.String &&
                string.Equals(attributes[index].GetString(), expectedName, StringComparison.OrdinalIgnoreCase) && string.Equals(attributes[index + 1].GetString(), expectedValue, StringComparison.Ordinal)) return true;
        }
        return false;
    }
}
