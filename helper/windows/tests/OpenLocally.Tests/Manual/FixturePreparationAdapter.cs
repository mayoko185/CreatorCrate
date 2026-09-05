using System.Text.Json;
using OpenLocally;

namespace OpenLocally.Tests.Manual;

/// <summary>
/// Test-only preparation adapter. Its browser runtime is injected through the
/// normal preparation context; it never constructs a socket or a transport.
/// </summary>
internal sealed class FixturePreparationAdapter(ManualBrowserFixture fixture) : ISocialPreparationAdapter, IAsyncDisposable
{
    internal static readonly TimeSpan OwnedTargetCleanupTimeout = TimeSpan.FromSeconds(3);
    internal const string CleanupDiagnosticDataKey = "OpenLocally.Manual.FixtureOwnedTargetCleanup";
    private readonly List<BrowserPreparationSession> _ownedTargets = [];
    private int _disposed;

    public string Platform => "fixture";

    internal IReadOnlyList<string> OwnedTargetIds => _ownedTargets.Select(target => target.TargetId).ToArray();

    public async Task<PlatformPreparationResult> PrepareAsync(PlatformPreparationContext context, IPreparationProgress progress, CancellationToken cancellationToken)
    {
        ManualFoundationGuard.RequireOptIn();
        ArgumentNullException.ThrowIfNull(context);
        ArgumentNullException.ThrowIfNull(progress);
        if (!string.Equals(context.Platform, Platform, StringComparison.Ordinal) || context.BrowserTargets is null)
            throw new SocialPreparationRuntimeException("fixture_browser_unavailable");
        if (_ownedTargets.Count != 0) throw new InvalidOperationException("The fixture adapter supports one preparation run.");
        if (context.MediaPaths.Count == 0 || context.MediaPaths.Any(path => string.IsNullOrWhiteSpace(path) || !File.Exists(path)))
            throw new SocialPreparationRuntimeException("fixture_media_missing");

        return await ExecutePreparationLifecycleAsync(async token =>
        {
            await progress.ReportAsync(SocialPreparationProgress.Preparing, token).ConfigureAwait(false);
            BrowserPreparationSession page = await context.BrowserTargets.CreateOwnedAsync(cancellationToken: token).ConfigureAwait(false);
            TrackOwnedTarget(page);

            await page.NavigateAsync(fixture.Origin.AbsoluteUri, cancellationToken: token).ConfigureAwait(false);
            await page.WaitForDocumentAsync(cancellationToken: token).ConfigureAwait(false);

            await ReplaceAndVerifyAsync(page, targetOrdinal: 1, "#fixture-title", ManualBrowserFixture.Title, token).ConfigureAwait(false);
            await ReplaceAndVerifyAsync(page, targetOrdinal: 1, "#fixture-body", ManualBrowserFixture.Body, token).ConfigureAwait(false);

            BrowserDomNode media = await page.WaitForNodeAsync("#fixture-media", cancellationToken: token).ConfigureAwait(false);
            await page.SetFileInputFilesAsync(media, context.MediaPaths, token).ConfigureAwait(false);

            string readiness = ExpectedReadiness(context.MediaPaths);
            await VerifyExactAsync(page, targetOrdinal: 1, "#fixture-upload-ready", readiness, commandCompleted: true, cancellationToken: token).ConfigureAwait(false);
            await progress.ReportAsync(SocialPreparationProgress.Uploading, token).ConfigureAwait(false);
            return PlatformPreparationResult.Prepared();
        }, cancellationToken).ConfigureAwait(false);
    }

    internal async Task<PlatformPreparationResult> ExecutePreparationLifecycleAsync(
        Func<CancellationToken, Task<PlatformPreparationResult>> prepareAsync,
        CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(prepareAsync);
        try
        {
            return await prepareAsync(cancellationToken).ConfigureAwait(false);
        }
        catch (Exception primaryError)
        {
            try
            {
                FixtureOwnedTargetCleanupResult? cleanup = await CleanupOwnedTargetsAsync().ConfigureAwait(false);
                if (cleanup is { Succeeded: false })
                {
                    primaryError.Data[CleanupDiagnosticDataKey] = cleanup.FormatDiagnostic(prepareCompleted: false, primaryError);
                }
            }
            catch (Exception cleanupError)
            {
                primaryError.Data[CleanupDiagnosticDataKey] =
                    FixtureOwnedTargetCleanupResult.FormatUnexpectedFailure(primaryError, cleanupError);
            }
            throw;
        }
    }

    public async ValueTask DisposeAsync()
    {
        FixtureOwnedTargetCleanupResult? cleanup = await CleanupOwnedTargetsAsync().ConfigureAwait(false);
        if (cleanup is { Succeeded: false })
        {
            throw new FixtureOwnedTargetCleanupException(cleanup);
        }
    }

    internal void TrackOwnedTarget(BrowserPreparationSession target)
    {
        ArgumentNullException.ThrowIfNull(target);
        _ownedTargets.Add(target);
    }

    internal static bool TryGetCleanupDiagnostic(Exception error, out string? diagnostic)
    {
        ArgumentNullException.ThrowIfNull(error);
        diagnostic = error.Data[CleanupDiagnosticDataKey] as string;
        return diagnostic is not null;
    }

    private async Task<FixtureOwnedTargetCleanupResult?> CleanupOwnedTargetsAsync()
    {
        if (Interlocked.Exchange(ref _disposed, 1) != 0) return null;
        BrowserPreparationSession[] targets = _ownedTargets.ToArray();
        _ownedTargets.Clear();
        return await CloseOwnedTargetsAsync(targets).ConfigureAwait(false);
    }

    internal static async Task<FixtureOwnedTargetCleanupResult> CloseOwnedTargetsAsync(
        IReadOnlyList<BrowserPreparationSession> targets,
        TimeSpan? timeout = null)
    {
        ArgumentNullException.ThrowIfNull(targets);
        TimeSpan effectiveTimeout = timeout ?? OwnedTargetCleanupTimeout;
        if (effectiveTimeout <= TimeSpan.Zero || effectiveTimeout > TimeSpan.FromSeconds(10))
            throw new ArgumentOutOfRangeException(nameof(timeout), "Owned-target cleanup must use a short positive timeout.");

        var attempts = targets
            .Select((target, index) => new FixtureOwnedTargetCleanupAttempt(index + 1, target))
            .ToArray();
        string transportStateBefore = targets.Count == 0 ? "not_applicable" : targets[0].TransportDiagnosticState;
        using var deadline = new CancellationTokenSource(effectiveTimeout);

        foreach (FixtureOwnedTargetCleanupAttempt attempt in attempts)
        {
            if (!attempt.Target.OwnsTarget) continue;
            if (deadline.IsCancellationRequested)
            {
                attempt.CloseError = new FixtureCleanupError("CleanupTimeout", "deadline_expired");
                continue;
            }
            if (attempt.Target.IsTransportTerminal)
            {
                attempt.CloseError = new FixtureCleanupError("CdpTransportException", attempt.Target.TransportDiagnosticState);
                continue;
            }

            attempt.CloseAttempted = true;
            try
            {
                await attempt.Target.CloseOwnedTargetAsync(effectiveTimeout, deadline.Token).ConfigureAwait(false);
                attempt.CloseCompleted = true;
            }
            catch (Exception error)
            {
                attempt.CloseException = error;
                attempt.CloseError = FixtureCleanupError.FromException(error, deadline.IsCancellationRequested);
            }
        }

        foreach (FixtureOwnedTargetCleanupAttempt attempt in attempts)
        {
            await attempt.Target.DisposeLocallyAsync().ConfigureAwait(false);
        }

        string transportStateAfter = targets.Count == 0 ? "not_applicable" : targets[0].TransportDiagnosticState;
        return new FixtureOwnedTargetCleanupResult(transportStateBefore, transportStateAfter, attempts);
    }

    private static async Task ReplaceAndVerifyAsync(BrowserPreparationSession page, int targetOrdinal, string selector, string value, CancellationToken cancellationToken)
    {
        var editor = new BrowserTextEditor(page);
        BrowserDomNode node = await page.WaitForNodeAsync(selector, cancellationToken: cancellationToken).ConfigureAwait(false);
        await editor.ReplaceAsync(node, value, cancellationToken).ConfigureAwait(false);
        await VerifyExactAsync(page, targetOrdinal, selector, value, commandCompleted: true, cancellationToken: cancellationToken).ConfigureAwait(false);
    }

    internal static async Task VerifyExactAsync(
        BrowserPreparationSession page,
        int targetOrdinal,
        string selector,
        string expected,
        bool commandCompleted,
        TimeSpan? timeout = null,
        CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(page);
        ArgumentOutOfRangeException.ThrowIfNegativeOrZero(targetOrdinal);
        ArgumentException.ThrowIfNullOrWhiteSpace(selector);
        ArgumentNullException.ThrowIfNull(expected);

        TimeSpan effectiveTimeout = timeout ?? BrowserPreparationSession.DefaultReadinessTimeout;
        using var deadline = new CancellationTokenSource(effectiveTimeout);
        using var linked = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken, deadline.Token);
        var editor = new BrowserTextEditor(page);
        BrowserTextReadback lastReadback = new(BrowserTextVerification.UnsupportedReadback, null);
        string? lastObservedState = null;
        string elementType = "unknown";
        int attempts = 0;

        try
        {
            while (true)
            {
                // The verifier owns readiness polling so selector absence remains observable.
                BrowserDomNode? node = await page.FindNodeAsync(selector, linked.Token).ConfigureAwait(false);
                attempts++;
                if (node is null)
                {
                    lastObservedState = "selector_missing";
                }
                else
                {
                    elementType = node.NodeName;
                    lastReadback = await editor.ReadAsync(node, linked.Token).ConfigureAwait(false);
                    lastObservedState = null;
                    if (lastReadback.Verification == BrowserTextVerification.Mismatch &&
                        string.Equals(lastReadback.Actual, expected, StringComparison.Ordinal))
                    {
                        return;
                    }
                }

                await Task.Delay(TimeSpan.FromMilliseconds(50), linked.Token).ConfigureAwait(false);
            }
        }
        catch (OperationCanceledException) when (deadline.IsCancellationRequested && !cancellationToken.IsCancellationRequested)
        {
            string observed = lastObservedState ?? SafeFixtureValue(lastReadback.Actual, lastReadback.Verification);
            string structural = lastReadback.Detail is null ? string.Empty : $"; {lastReadback.Detail}";
            string diagnostic = $"manual_fixture_text_verification_timeout; detail_code=text_verification_timeout; target={targetOrdinal}; selector={selector}; element={elementType}; phase=readback; command_completed={commandCompleted.ToString().ToLowerInvariant()}; attempts={attempts}; observed={observed}; expected={SafeFixtureValue(expected, BrowserTextVerification.Mismatch)}{structural}";
            throw new BrowserPreparationException(BrowserPreparationFailure.ReadinessTimedOut, diagnostic);
        }
    }

    private static string SafeFixtureValue(string? value, BrowserTextVerification verification) => value is not null
        ? JsonSerializer.Serialize(value)
        : verification switch
        {
            BrowserTextVerification.NodeDisappeared => "<node-disappeared>",
            BrowserTextVerification.UnsupportedReadback => "<unsupported-readback>",
            _ => "<no-value>",
        };

    private static string ExpectedReadiness(IReadOnlyList<string> paths) =>
        $"ready:{paths.Count}:{string.Join("|", paths.Select(Path.GetFileName))}";
}

internal sealed class FixtureOwnedTargetCleanupAttempt(int targetOrdinal, BrowserPreparationSession target)
{
    internal int TargetOrdinal { get; } = targetOrdinal;
    internal BrowserPreparationSession Target { get; } = target;
    internal bool CloseAttempted { get; set; }
    internal bool CloseCompleted { get; set; }
    internal FixtureCleanupError? CloseError { get; set; }
    internal Exception? CloseException { get; set; }
}

internal sealed class FixtureOwnedTargetCleanupResult(
    string transportStateBefore,
    string transportStateAfter,
    IReadOnlyList<FixtureOwnedTargetCleanupAttempt> attempts)
{
    internal string TransportStateBefore { get; } = transportStateBefore;
    internal string TransportStateAfter { get; } = transportStateAfter;
    internal IReadOnlyList<FixtureOwnedTargetCleanupAttempt> Attempts { get; } = attempts;
    internal bool Succeeded => Attempts.Where(attempt => attempt.Target.OwnsTarget).All(attempt => attempt.CloseCompleted);

    internal string FormatDiagnostic(bool prepareCompleted, Exception? primaryError)
    {
        FixtureCleanupError? cleanupError = Attempts
            .Where(attempt => attempt.Target.OwnsTarget)
            .Select(attempt => attempt.CloseError)
            .FirstOrDefault(error => error is not null);
        string primary = primaryError is null
            ? "none"
            : FixtureCleanupError.FromException(primaryError, cleanupDeadlineExpired: false).ToString();

        var fields = new List<string>
        {
            $"prepare_completed={prepareCompleted.ToString().ToLowerInvariant()}",
            $"primary_error={primary}",
            "phase=cleanup",
            "detail_code=owned_target_cleanup_failed",
            "cleanup_started=true",
            $"cleanup_status={(Succeeded ? "completed" : "failed")}",
            $"cleanup_error={cleanupError?.Type ?? "none"}",
            $"cleanup_detail={cleanupError?.Detail ?? "none"}",
            $"transport_state_before_cleanup={TransportStateBefore}",
            $"owned_target_count={Attempts.Count(attempt => attempt.Target.OwnsTarget)}",
        };
        fields.AddRange(Attempts
            .Where(attempt => attempt.Target.OwnsTarget)
            .Select(attempt =>
                $"target={{target_ordinal={attempt.TargetOrdinal},close_attempted={attempt.CloseAttempted.ToString().ToLowerInvariant()},close_completed={attempt.CloseCompleted.ToString().ToLowerInvariant()},close_error={attempt.CloseError?.ToString() ?? "none"}}}"));
        fields.Add($"transport_state_after_cleanup={TransportStateAfter}");
        return string.Join("; ", fields);
    }

    internal static string FormatUnexpectedFailure(Exception primaryError, Exception cleanupError)
    {
        FixtureCleanupError primary = FixtureCleanupError.FromException(primaryError, cleanupDeadlineExpired: false);
        FixtureCleanupError cleanup = FixtureCleanupError.FromException(cleanupError, cleanupDeadlineExpired: false);
        return $"prepare_completed=false; primary_error={primary.Type}/{primary.Detail}; phase=cleanup; detail_code=owned_target_cleanup_failed; cleanup_started=true; cleanup_status=failed; cleanup_error={cleanup.Type}; cleanup_detail={cleanup.Detail}; transport_state_before_cleanup=unknown; owned_target_count=unknown; transport_state_after_cleanup=unknown";
    }
}

internal sealed record FixtureCleanupError(string Type, string Detail)
{
    internal static FixtureCleanupError FromException(Exception error, bool cleanupDeadlineExpired) => error switch
    {
        CdpTransportException transport => new(nameof(CdpTransportException), transport.Failure.ToString()),
        CdpCommandException command => new(nameof(CdpCommandException), command.Code.ToString()),
        BrowserPreparationException preparation => new(nameof(BrowserPreparationException), preparation.Failure.ToString()),
        OperationCanceledException when cleanupDeadlineExpired => new(nameof(OperationCanceledException), "cleanup_timeout"),
        OperationCanceledException => new(nameof(OperationCanceledException), "caller_cancellation"),
        TimeoutException => new(nameof(TimeoutException), "command_timeout"),
        _ => new(error.GetType().Name, "none"),
    };

    public override string ToString() => $"{Type}/{Detail}";
}

internal sealed class FixtureOwnedTargetCleanupException : Exception
{
    internal FixtureOwnedTargetCleanupException(FixtureOwnedTargetCleanupResult result)
        : base(
            result.FormatDiagnostic(prepareCompleted: true, primaryError: null),
            result.Attempts.Select(attempt => attempt.CloseException).FirstOrDefault(error => error is not null))
    {
        Result = result;
    }

    internal FixtureOwnedTargetCleanupResult Result { get; }
}
