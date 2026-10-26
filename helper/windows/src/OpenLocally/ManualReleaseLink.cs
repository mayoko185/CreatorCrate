using System.Net.Http.Headers;
using System.Text;
using System.Text.Json;

namespace OpenLocally;

internal enum ManualReleaseLinkTransportOutcome
{
    /// <summary>A contract-shaped success for this session.</summary>
    Authoritative,
    /// <summary>A recognized release-link API rejection.</summary>
    Rejected,
    /// <summary>The server does not speak the release-link contract (older server, login page, redirect).</summary>
    Unsupported,
    /// <summary>No authoritative answer: network failure, timeout, 5xx, or a malformed success.</summary>
    Ambiguous,
}

internal sealed record ManualReleaseLinkTransportResult(
    ManualReleaseLinkTransportOutcome Outcome, string? ReleaseLink, bool? Changed, string? ErrorCode,
    string? CurrentReleaseLink = null)
{
    internal static ManualReleaseLinkTransportResult Authoritative(string? releaseLink, bool? changed = null) =>
        new(ManualReleaseLinkTransportOutcome.Authoritative, releaseLink, changed, null);

    internal static ManualReleaseLinkTransportResult Rejected(string code, string? currentReleaseLink = null) =>
        new(ManualReleaseLinkTransportOutcome.Rejected, null, null, code, currentReleaseLink);

    internal static ManualReleaseLinkTransportResult Unsupported() =>
        new(ManualReleaseLinkTransportOutcome.Unsupported, null, null, "release_link_unsupported");

    internal static ManualReleaseLinkTransportResult Ambiguous() =>
        new(ManualReleaseLinkTransportOutcome.Ambiguous, null, null, "release_link_unavailable");
}

internal interface IManualReleaseLinkTransport : IDisposable
{
    Task<ManualReleaseLinkTransportResult> GetAsync(CancellationToken cancellationToken);
    Task<ManualReleaseLinkTransportResult> PatchAsync(
        string? releaseLink, string? expectedReleaseLink, CancellationToken cancellationToken);
}

/// <summary>Release-link GET/PATCH using the redeemed manual-session bearer; never exposes it.</summary>
internal sealed class ManualReleaseLinkClient : IManualReleaseLinkTransport
{
    private const int MaxJsonBytes = 64 * 1024;

    // Each recognized code is accepted only with the status WP2 sends it with, so a
    // generic 401/404 from an older server is never mistaken for a contract rejection.
    private static readonly Dictionary<string, int> RejectionStatuses = new(StringComparer.Ordinal)
    {
        ["release_link_conflict"] = 409,
        ["validation_failed"] = 422,
        ["release_link_token_missing"] = 401,
        ["release_link_token_malformed"] = 401,
        ["release_link_token_invalid"] = 403,
        ["release_link_token_expired"] = 401,
        ["attempt_superseded"] = 409,
        ["attempt_not_link_editable"] = 409,
        ["release_link_not_eligible"] = 409,
        ["release_not_editable"] = 409,
        ["release_not_found"] = 404,
    };

    private readonly SocialHttpClient _http;
    private readonly OriginTrustService _trust;
    private readonly SocialOrigin _origin;
    private readonly SocialCapability _capability;
    private bool _disposed;

    internal ManualReleaseLinkClient(
        SocialHttpClient http, OriginTrustService trust, SocialOrigin origin, SocialCapability capability)
    {
        _http = http ?? throw new ArgumentNullException(nameof(http));
        _trust = trust ?? throw new ArgumentNullException(nameof(trust));
        _origin = origin ?? throw new ArgumentNullException(nameof(origin));
        _capability = capability ?? throw new ArgumentNullException(nameof(capability));
    }

    public Task<ManualReleaseLinkTransportResult> GetAsync(CancellationToken cancellationToken) =>
        SendAsync(HttpMethod.Get, null, cancellationToken);

    public Task<ManualReleaseLinkTransportResult> PatchAsync(
        string? releaseLink, string? expectedReleaseLink, CancellationToken cancellationToken) =>
        SendAsync(HttpMethod.Patch, RequestBody(releaseLink, expectedReleaseLink), cancellationToken);

    internal static byte[] RequestBody(string? releaseLink, string? expectedReleaseLink)
    {
        using var buffer = new MemoryStream();
        using (var writer = new Utf8JsonWriter(buffer))
        {
            writer.WriteStartObject();
            writer.WriteString("releaseLink", releaseLink);
            // The exact authoritative value, never a trimmed display copy.
            writer.WriteString("expectedReleaseLink", expectedReleaseLink);
            writer.WriteEndObject();
        }
        return buffer.ToArray();
    }

    private async Task<ManualReleaseLinkTransportResult> SendAsync(
        HttpMethod method, byte[]? body, CancellationToken cancellationToken)
    {
        ObjectDisposedException.ThrowIf(_disposed, this);
        bool isPatch = method == HttpMethod.Patch;

        using var request = new HttpRequestMessage(
            method, new Uri(_origin.Uri, $"/social-prep/{Uri.EscapeDataString(_capability.SessionId)}/release-link"));
        request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", _capability.MediaToken);
        request.Headers.Accept.Add(new MediaTypeWithQualityHeaderValue("application/json"));
        if (body is not null)
        {
            request.Content = new ByteArrayContent(body);
            request.Content.Headers.ContentType = new MediaTypeHeaderValue("application/json");
        }

        try
        {
            OriginTrustResult authorization = await _trust.AuthorizeAsync(_origin, cancellationToken).ConfigureAwait(false);
            if (!authorization.Allowed) return ManualReleaseLinkTransportResult.Ambiguous();
            // HttpClient.Timeout stops at the headers (ResponseHeadersRead), so the same
            // RequestTimeout also bounds the body. A timed-out PATCH stays ambiguous below.
            using var deadline = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
            deadline.CancelAfter(_http.RequestTimeout);
            using HttpResponseMessage response = await _http.SendAsync(
                _origin, request, authorization.Transport!, deadline.Token).ConfigureAwait(false);

            int status = (int)response.StatusCode;
            if (status is >= 200 and < 300)
            {
                byte[] payload = await ReadCappedAsync(response.Content, deadline.Token).ConfigureAwait(false);
                if (TryParseSuccess(payload, _capability.SessionId, isPatch, out string? link, out bool? changed))
                    return ManualReleaseLinkTransportResult.Authoritative(link, changed);
                // A non-contract 2xx to GET is an older server (for example an HTML fallback).
                // After a PATCH it cannot prove the write did not commit, so it stays ambiguous.
                return isPatch ? ManualReleaseLinkTransportResult.Ambiguous() : ManualReleaseLinkTransportResult.Unsupported();
            }

            // Redirects are never followed (SocialHttpClient disables them), so a login
            // redirect cannot carry the bearer elsewhere; it means the contract is absent.
            if (status is >= 300 and < 500)
            {
                byte[] payload;
                try { payload = await ReadCappedAsync(response.Content, deadline.Token).ConfigureAwait(false); }
                catch (PayloadTooLargeException) { return ManualReleaseLinkTransportResult.Unsupported(); }
                return TryParseRejection(payload, status, out ManualReleaseLinkTransportResult? rejected)
                    ? rejected! : ManualReleaseLinkTransportResult.Unsupported();
            }
            return ManualReleaseLinkTransportResult.Ambiguous();
        }
        catch (Exception ex) when (ex is HttpRequestException or OperationCanceledException or IOException or JsonException or InvalidOperationException or PayloadTooLargeException)
        {
            return ManualReleaseLinkTransportResult.Ambiguous();
        }
    }

    private static bool TryParseSuccess(
        byte[] json, string expectedSessionId, bool isPatch, out string? releaseLink, out bool? changed)
    {
        releaseLink = null;
        changed = null;
        try
        {
            using JsonDocument document = JsonDocument.Parse(json);
            JsonElement root = document.RootElement;
            if (root.ValueKind != JsonValueKind.Object ||
                !(isPatch
                    ? ExactProperties(root, "ok", "sessionId", "releaseLink", "changed")
                    : ExactProperties(root, "ok", "sessionId", "releaseLink")) ||
                root.GetProperty("ok").ValueKind != JsonValueKind.True ||
                root.GetProperty("sessionId").ValueKind != JsonValueKind.String ||
                !string.Equals(root.GetProperty("sessionId").GetString(), expectedSessionId, StringComparison.Ordinal) ||
                !TryLink(root.GetProperty("releaseLink"), out releaseLink))
                return false;
            if (isPatch)
            {
                JsonElement changedElement = root.GetProperty("changed");
                if (changedElement.ValueKind is not (JsonValueKind.True or JsonValueKind.False)) return false;
                changed = changedElement.GetBoolean();
            }
            return true;
        }
        catch (Exception ex) when (ex is JsonException or InvalidOperationException) { return false; }
    }

    private static bool TryParseRejection(
        byte[] json, int status, out ManualReleaseLinkTransportResult? result)
    {
        result = null;
        try
        {
            using JsonDocument document = JsonDocument.Parse(json);
            JsonElement root = document.RootElement;
            if (root.ValueKind != JsonValueKind.Object || !ExactProperties(root, "ok", "error") ||
                root.GetProperty("ok").ValueKind != JsonValueKind.False)
                return false;
            JsonElement error = root.GetProperty("error");
            if (error.ValueKind != JsonValueKind.Object ||
                !error.TryGetProperty("code", out JsonElement codeElement) || codeElement.ValueKind != JsonValueKind.String ||
                !error.TryGetProperty("message", out JsonElement message) || message.ValueKind != JsonValueKind.String ||
                codeElement.GetString() is not { } code ||
                !RejectionStatuses.TryGetValue(code, out int expectedStatus) || expectedStatus != status)
                return false;

            if (code == "release_link_conflict")
            {
                if (!ExactProperties(error, "code", "message", "currentReleaseLink") ||
                    !TryLink(error.GetProperty("currentReleaseLink"), out string? current))
                    return false;
                result = ManualReleaseLinkTransportResult.Rejected(code, current);
                return true;
            }
            bool shaped = code == "validation_failed"
                ? ExactProperties(error, "code", "message") ||
                  (ExactProperties(error, "code", "message", "issues") &&
                   error.GetProperty("issues").ValueKind == JsonValueKind.Array)
                : ExactProperties(error, "code", "message");
            if (!shaped) return false;
            result = ManualReleaseLinkTransportResult.Rejected(code);
            return true;
        }
        catch (Exception ex) when (ex is JsonException or InvalidOperationException) { return false; }
    }

    // Responses carry null for no link; an empty string is outside the contract.
    private static bool TryLink(JsonElement element, out string? link)
    {
        link = null;
        if (element.ValueKind == JsonValueKind.Null) return true;
        if (element.ValueKind != JsonValueKind.String || element.GetString() is not { Length: > 0 } value) return false;
        link = value;
        return true;
    }

    private static bool ExactProperties(JsonElement element, params string[] expected)
    {
        var seen = new HashSet<string>(StringComparer.Ordinal);
        foreach (JsonProperty property in element.EnumerateObject())
            if (!seen.Add(property.Name) || !expected.Contains(property.Name, StringComparer.Ordinal)) return false;
        return seen.Count == expected.Length;
    }

    private static async Task<byte[]> ReadCappedAsync(HttpContent content, CancellationToken cancellationToken)
    {
        if (content.Headers.ContentLength is long length && length > MaxJsonBytes) throw new PayloadTooLargeException();
        await using Stream source = await content.ReadAsStreamAsync(cancellationToken).ConfigureAwait(false);
        using var target = new MemoryStream();
        byte[] buffer = new byte[8192];
        // WaitAsync keeps the deadline even if a stream does not observe its token.
        for (int read; (read = await source.ReadAsync(buffer, cancellationToken).AsTask()
                 .WaitAsync(cancellationToken).ConfigureAwait(false)) > 0;)
        {
            if (target.Length > MaxJsonBytes - read) throw new PayloadTooLargeException();
            target.Write(buffer, 0, read);
        }
        return target.ToArray();
    }

    public void Dispose() => _disposed = true;

    private sealed class PayloadTooLargeException : Exception { }
}

internal enum ManualReleaseLinkPhase
{
    /// <summary>No load has been attempted yet.</summary>
    NotLoaded,
    Loading,
    /// <summary>The authoritative value is known; the draft may or may not differ.</summary>
    Ready,
    Saving,
    /// <summary>The last explicit save was confirmed by the server.</summary>
    Saved,
    /// <summary>The server value changed; the draft is kept and must be resolved explicitly.</summary>
    Conflict,
    /// <summary>The server rejected the proposed link; the draft is kept.</summary>
    Invalid,
    /// <summary>A save may or may not have committed and readback could not settle it.</summary>
    Uncertain,
    /// <summary>A retryable load or save failure with no write committed.</summary>
    Failed,
    /// <summary>Editing is unavailable for this companion (older server, lost authority, ineligible).</summary>
    Unavailable,
}

/// <summary>Immutable display model for WP4. It never carries bearer material.</summary>
internal sealed record ManualReleaseLinkState(
    ManualReleaseLinkPhase Phase,
    bool IsLoaded,
    string? AuthoritativeLink,
    string Draft,
    bool IsDirty,
    string? Message,
    string? ErrorCode,
    bool? LastSaveChanged,
    long Revision)
{
    /// <summary>The authoritative link as a user would read it; empty when there is none.</summary>
    internal string DisplayLink => ManualReleaseLinkController.Display(AuthoritativeLink);
    internal bool IsBusy => Phase is ManualReleaseLinkPhase.Loading or ManualReleaseLinkPhase.Saving;
    internal bool CanEdit => IsLoaded && Phase != ManualReleaseLinkPhase.Unavailable;
    internal bool CanSave => CanEdit && !IsBusy && Phase != ManualReleaseLinkPhase.Conflict;
}


/// <summary>
/// Release-link request state for one companion lifetime. Loads and saves are
/// single-flight; the exact server value is retained as the compare-and-set token.
/// Independent of ManualPostingConfirmationController and never touches its state.
/// </summary>
internal sealed class ManualReleaseLinkController : IDisposable
{
    internal const string UnsupportedMessage = "Release link editing isn't available on this CreatorCrate server.";
    internal const string ExpiredMessage = "Release link editing expired. Reopen from CreatorCrate.";
    internal const string AuthorityMessage = "Release link editing is no longer available. Reopen from CreatorCrate.";
    internal const string NotEditableMessage = "This release's link can't be edited from here.";
    internal const string LoadFailedMessage = "Couldn't load the Release link. Try again.";
    internal const string SaveFailedMessage = "Release link wasn't saved. Try again.";
    internal const string InvalidMessage = "Enter a valid web address, or leave it blank to clear it.";
    internal const string ConflictMessage = "The Release link was changed elsewhere. Review it before saving.";
    internal const string UncertainMessage = "Couldn't confirm whether the Release link was saved. Reload to check.";

    private enum Operation { None, Load, Save }
    private enum Reconciliation { Committed, NotCommitted, Conflict }

    private readonly object _gate = new();
    private readonly IManualReleaseLinkTransport _transport;
    private readonly CancellationTokenSource _disposeCancellation = new();
    private ManualReleaseLinkPhase _phase = ManualReleaseLinkPhase.NotLoaded;
    private bool _loaded;
    private string? _authoritative;
    private string _draft = string.Empty;
    private string? _message;
    private string? _errorCode;
    private bool? _lastSaveChanged;
    private long _revision;
    private bool _authorityLost;
    // A save whose outcome is unknown: the value it proposed and the exact value it expected to replace.
    private (string? Submitted, string? Previous)? _unresolvedSave;
    private Operation _operation;
    private Task<ManualReleaseLinkState>? _inFlight;
    // Managed thread ids currently running a StateChanged subscriber; one entry per nested delivery.
    private readonly List<int> _deliveringThreads = [];
    private bool _disposed;

    internal ManualReleaseLinkController(IManualReleaseLinkTransport transport) =>
        _transport = transport ?? throw new ArgumentNullException(nameof(transport));

    /// <summary>
    /// Raised after each state change, on the caller's thread for draft changes and on a
    /// thread-pool thread for request results. WP4 marshals to its UI thread; never raised after disposal.
    /// </summary>
    internal event Action<ManualReleaseLinkState>? StateChanged;

    internal ManualReleaseLinkState State
    {
        get { lock (_gate) return Snapshot(); }
    }

    /// <summary>Updates the editable draft. Allowed at any time, including while a request is pending.</summary>
    internal ManualReleaseLinkState SetDraft(string? draft) => Mutate(() =>
    {
        string next = draft ?? string.Empty;
        if (string.Equals(next, _draft, StringComparison.Ordinal)) return false;
        _draft = next;
        if (_phase is ManualReleaseLinkPhase.Saved or ManualReleaseLinkPhase.Invalid) Clear(ManualReleaseLinkPhase.Ready);
        return true;
    });

    /// <summary>Replaces the draft with the authoritative value, resolving a conflict in the server's favour.</summary>
    internal ManualReleaseLinkState DiscardDraft() => Mutate(() =>
    {
        if (!_loaded || _operation != Operation.None ||
            _phase is ManualReleaseLinkPhase.Unavailable or ManualReleaseLinkPhase.Uncertain)
            return false;
        _draft = Display(_authoritative);
        Clear(ManualReleaseLinkPhase.Ready);
        return true;
    });

    /// <summary>
    /// Keeps the draft after a conflict. The next explicit save compares against the
    /// newly recorded server value, so it is a deliberate user choice, not a stale retry.
    /// </summary>
    internal ManualReleaseLinkState KeepDraftAfterConflict() => Mutate(() =>
    {
        if (_phase != ManualReleaseLinkPhase.Conflict) return false;
        Clear(ManualReleaseLinkPhase.Ready);
        return true;
    });

    /// <summary>
    /// Loads (or explicitly reloads) the authoritative link. Joins a pending request
    /// instead of starting another. Transport failures become state, never exceptions.
    /// </summary>
    internal Task<ManualReleaseLinkState> LoadAsync(CancellationToken cancellationToken = default)
    {
        ManualReleaseLinkState state;
        Task<ManualReleaseLinkState> operation;
        lock (_gate)
        {
            if (_disposed || _authorityLost || IsUnsupported()) return Task.FromResult(Snapshot());
            if (_inFlight is not null) return _inFlight;
            _phase = ManualReleaseLinkPhase.Loading;
            operation = Begin(Operation.Load, RunLoadAsync, cancellationToken);
            state = Changed();
        }
        Notify(state);
        return operation;
    }

    /// <summary>
    /// Submits the current draft once. A second call while saving returns the same task;
    /// a call while loading, before the first load, during a conflict, or when unavailable sends nothing.
    /// </summary>
    internal Task<ManualReleaseLinkState> SaveAsync(CancellationToken cancellationToken = default)
    {
        ManualReleaseLinkState state;
        Task<ManualReleaseLinkState> operation;
        lock (_gate)
        {
            if (_inFlight is not null && _operation == Operation.Save) return _inFlight;
            if (_disposed || _inFlight is not null || !_loaded || _authorityLost ||
                _phase is ManualReleaseLinkPhase.Conflict or ManualReleaseLinkPhase.Unavailable)
                return Task.FromResult(Snapshot());
            string? submitted = Proposed(_draft);
            string? expected = _authoritative;
            bool reconcileFirst = _unresolvedSave is not null;
            Clear(ManualReleaseLinkPhase.Saving);
            operation = Begin(Operation.Save,
                token => RunSaveAsync(submitted, expected, reconcileFirst, token), cancellationToken);
            state = Changed();
        }
        Notify(state);
        return operation;
    }

    // Called under _gate while not disposed; the linked token is created before the first await.
    private Task<ManualReleaseLinkState> Begin(
        Operation kind, Func<CancellationToken, Task> run, CancellationToken cancellationToken)
    {
        var completion = new TaskCompletionSource<ManualReleaseLinkState>(TaskCreationOptions.RunContinuationsAsynchronously);
        _operation = kind;
        _inFlight = completion.Task;
        var linked = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken, _disposeCancellation.Token);
        _ = RunOperationAsync(kind, run, linked, completion);
        return completion.Task;
    }

    private async Task RunOperationAsync(
        Operation kind, Func<CancellationToken, Task> run, CancellationTokenSource linked,
        TaskCompletionSource<ManualReleaseLinkState> completion)
    {
        try
        {
            await Task.Yield();
            await run(linked.Token).ConfigureAwait(false);
        }
        catch (Exception ex) when (ex is not (StackOverflowException or OutOfMemoryException))
        {
            lock (_gate)
                if (!_disposed)
                    FailureLocked(ManualReleaseLinkTransportResult.Ambiguous(), kind == Operation.Save);
        }
        finally { linked.Dispose(); }

        ManualReleaseLinkState state;
        bool notify;
        lock (_gate)
        {
            if (ReferenceEquals(_inFlight, completion.Task))
            {
                _inFlight = null;
                _operation = Operation.None;
            }
            notify = !_disposed;
            state = notify ? Changed() : Snapshot();
        }
        if (notify) Notify(state);
        completion.TrySetResult(state);
    }

    private async Task RunLoadAsync(CancellationToken cancellationToken)
    {
        ManualReleaseLinkTransportResult read = await SafeAsync(_transport.GetAsync, cancellationToken).ConfigureAwait(false);
        lock (_gate)
        {
            if (_disposed) return;
            if (read.Outcome != ManualReleaseLinkTransportOutcome.Authoritative) FailureLocked(read, isSave: false);
            else if (_unresolvedSave is not null) ReconcileLocked(read.ReleaseLink);
            else LoadedLocked(read.ReleaseLink);
        }
    }

    private async Task RunSaveAsync(
        string? submitted, string? expected, bool reconcileFirst, CancellationToken cancellationToken)
    {
        if (reconcileFirst)
        {
            // An earlier save is unresolved: read before writing so a committed write
            // is recognized and never blindly repeated.
            ManualReleaseLinkTransportResult check = await SafeAsync(_transport.GetAsync, cancellationToken).ConfigureAwait(false);
            lock (_gate)
            {
                if (_disposed) return;
                if (check.Outcome != ManualReleaseLinkTransportOutcome.Authoritative)
                {
                    FailureLocked(check, isSave: true);
                    return;
                }
                Reconciliation earlier = ReconcileLocked(check.ReleaseLink);
                if (earlier == Reconciliation.Conflict ||
                    (earlier == Reconciliation.Committed && string.Equals(_authoritative, submitted, StringComparison.Ordinal)))
                    return;
                expected = _authoritative;
                Clear(ManualReleaseLinkPhase.Saving);
            }
        }

        ManualReleaseLinkTransportResult written = await SafeAsync(
            token => _transport.PatchAsync(submitted, expected, token), cancellationToken).ConfigureAwait(false);
        lock (_gate)
        {
            if (_disposed) return;
            // The server stores exactly the proposed value (trimmed, blank as null), so a success
            // reporting anything else does not confirm this write and is settled by readback.
            if (written.Outcome == ManualReleaseLinkTransportOutcome.Authoritative &&
                string.Equals(written.ReleaseLink, submitted, StringComparison.Ordinal))
            {
                SavedLocked(submitted, written.ReleaseLink, written.Changed ?? false);
                return;
            }
            if (written.Outcome is not (ManualReleaseLinkTransportOutcome.Ambiguous or ManualReleaseLinkTransportOutcome.Authoritative))
            {
                FailureLocked(written, isSave: true);
                return;
            }
            // The write may have committed before the response was lost or contradicted it.
            _unresolvedSave = (submitted, expected);
            if (cancellationToken.IsCancellationRequested)
            {
                Set(ManualReleaseLinkPhase.Uncertain, UncertainMessage, "release_link_uncertain");
                return;
            }
        }

        // One bounded readback; never an automatic re-PATCH.
        ManualReleaseLinkTransportResult readback = await SafeAsync(_transport.GetAsync, cancellationToken).ConfigureAwait(false);
        lock (_gate)
        {
            if (_disposed) return;
            if (readback.Outcome == ManualReleaseLinkTransportOutcome.Authoritative) ReconcileLocked(readback.ReleaseLink);
            else FailureLocked(readback, isSave: true);
        }
    }

    /// <summary>
    /// Settles an unresolved save against an authoritative read. Success is claimed only
    /// when the server holds exactly the submitted value; the exact prior value proves no
    /// commit. Comparisons use stored values, never trimmed display copies.
    /// </summary>
    private Reconciliation ReconcileLocked(string? server)
    {
        (string? submitted, string? previous) = _unresolvedSave!.Value;
        _unresolvedSave = null;
        bool draftUntouched = Proposed(_draft) == submitted;
        _authoritative = server;
        _loaded = true;

        if (string.Equals(server, submitted, StringComparison.Ordinal))
        {
            _lastSaveChanged = !string.Equals(server, previous, StringComparison.Ordinal);
            if (draftUntouched) _draft = Display(server);
            Clear(draftUntouched ? ManualReleaseLinkPhase.Saved : ManualReleaseLinkPhase.Ready);
            return Reconciliation.Committed;
        }
        if (string.Equals(server, previous, StringComparison.Ordinal))
        {
            Set(ManualReleaseLinkPhase.Failed, SaveFailedMessage, "release_link_not_saved");
            return Reconciliation.NotCommitted;
        }
        Set(ManualReleaseLinkPhase.Conflict, ConflictMessage, "release_link_conflict");
        return Reconciliation.Conflict;
    }

    private void LoadedLocked(string? server)
    {
        // Replace the draft only when the user has not edited it away from the old value.
        bool draftUntouched = !_loaded || Proposed(_draft) == Proposed(_authoritative);
        _authoritative = server;
        _loaded = true;
        if (draftUntouched) _draft = Display(server);
        Clear(ManualReleaseLinkPhase.Ready);
    }

    private void SavedLocked(string? submitted, string? server, bool changed)
    {
        bool draftUntouched = Proposed(_draft) == submitted;
        _authoritative = server;
        _loaded = true;
        _unresolvedSave = null;
        _lastSaveChanged = changed;
        // A draft edited while the request was pending is newer than this response.
        if (draftUntouched) _draft = Display(server);
        Clear(draftUntouched ? ManualReleaseLinkPhase.Saved : ManualReleaseLinkPhase.Ready);
    }

    private void FailureLocked(ManualReleaseLinkTransportResult result, bool isSave)
    {
        switch (result.Outcome)
        {
            case ManualReleaseLinkTransportOutcome.Unsupported:
                Set(ManualReleaseLinkPhase.Unavailable, UnsupportedMessage, "release_link_unsupported");
                return;
            case ManualReleaseLinkTransportOutcome.Rejected when result.ErrorCode == "release_link_conflict":
                // A CAS rejection proves this write did not commit. Record the server value; keep the draft.
                _authoritative = result.CurrentReleaseLink;
                _loaded = true;
                _unresolvedSave = null;
                Set(ManualReleaseLinkPhase.Conflict, ConflictMessage, "release_link_conflict");
                return;
            case ManualReleaseLinkTransportOutcome.Rejected when result.ErrorCode == "validation_failed" && isSave:
                _unresolvedSave = null;
                Set(ManualReleaseLinkPhase.Invalid, InvalidMessage, "validation_failed");
                return;
            case ManualReleaseLinkTransportOutcome.Rejected when result.ErrorCode != "validation_failed":
                string code = result.ErrorCode!;
                if (code is "release_link_token_missing" or "release_link_token_malformed" or
                    "release_link_token_invalid" or "release_link_token_expired" or
                    "attempt_superseded" or "attempt_not_link_editable")
                    _authorityLost = true;
                Set(ManualReleaseLinkPhase.Unavailable, code switch
                {
                    "release_link_token_expired" => ExpiredMessage,
                    "release_link_not_eligible" or "release_not_editable" or "release_not_found" => NotEditableMessage,
                    _ => AuthorityMessage,
                }, code);
                return;
        }
        if (_unresolvedSave is not null)
            Set(ManualReleaseLinkPhase.Uncertain, UncertainMessage, "release_link_uncertain");
        else
            Set(ManualReleaseLinkPhase.Failed, isSave ? SaveFailedMessage : LoadFailedMessage, "release_link_unavailable");
    }

    private static async Task<ManualReleaseLinkTransportResult> SafeAsync(
        Func<CancellationToken, Task<ManualReleaseLinkTransportResult>> send, CancellationToken cancellationToken)
    {
        try { return await send(cancellationToken).ConfigureAwait(false) ?? ManualReleaseLinkTransportResult.Ambiguous(); }
        catch (Exception ex) when (ex is not (StackOverflowException or OutOfMemoryException))
        {
            return ManualReleaseLinkTransportResult.Ambiguous();
        }
    }

    private ManualReleaseLinkState Mutate(Func<bool> change)
    {
        ManualReleaseLinkState state;
        lock (_gate)
        {
            if (_disposed || !change()) return Snapshot();
            state = Changed();
        }
        Notify(state);
        return state;
    }

    private bool IsUnsupported() =>
        _phase == ManualReleaseLinkPhase.Unavailable && _errorCode == "release_link_unsupported";

    private void Set(ManualReleaseLinkPhase phase, string message, string code) =>
        (_phase, _message, _errorCode) = (phase, message, code);

    private void Clear(ManualReleaseLinkPhase phase) => (_phase, _message, _errorCode) = (phase, null, null);

    private ManualReleaseLinkState Changed()
    {
        _revision++;
        return Snapshot();
    }

    private ManualReleaseLinkState Snapshot() => new(
        _phase, _loaded, _authoritative, _draft,
        _loaded && Proposed(_draft) != Proposed(_authoritative),
        _message, _errorCode, _lastSaveChanged, _revision);

    // Disposal is checked before each subscriber, so one that disposes stops the rest. A
    // delivery in progress on another thread is awaited by Dispose, like a token callback.
    private void Notify(ManualReleaseLinkState state)
    {
        Action<ManualReleaseLinkState>? handler;
        lock (_gate)
        {
            if (_disposed) return;
            handler = StateChanged;
        }
        if (handler is null) return;
        int thread = Environment.CurrentManagedThreadId;
        foreach (Delegate subscriber in handler.GetInvocationList())
        {
            lock (_gate)
            {
                if (_disposed) return;
                _deliveringThreads.Add(thread);
            }
            try { ((Action<ManualReleaseLinkState>)subscriber)(state); }
            catch (Exception ex) when (ex is not (StackOverflowException or OutOfMemoryException)) { }
            finally
            {
                lock (_gate)
                {
                    _deliveringThreads.Remove(thread);
                    Monitor.PulseAll(_gate);
                }
            }
        }
    }

    /// <summary>The value the server would store: trimmed, with blank meaning no link.</summary>
    internal static string? Proposed(string? value)
    {
        if (value is null) return null;
        int start = 0, end = value.Length;
        while (start < end && IsTrimmable(value[start])) start++;
        while (end > start && IsTrimmable(value[end - 1])) end--;
        return start == end ? null : value[start..end];
    }

    internal static string Display(string? value) => Proposed(value) ?? string.Empty;

    // Matches JavaScript String.prototype.trim, which the server applies.
    private static bool IsTrimmable(char character) => char.IsWhiteSpace(character) || character == '﻿';

    /// <summary>
    /// Stops all further notifications. Waits for a subscriber already running on another
    /// thread (never for the calling thread, so disposing from a subscriber is safe); after
    /// the first call returns no subscriber runs. Subscribers must not block on the disposing thread.
    /// </summary>
    public void Dispose()
    {
        lock (_gate)
        {
            if (_disposed) return;
            _disposed = true;
            StateChanged = null;
            int thread = Environment.CurrentManagedThreadId;
            while (_deliveringThreads.Exists(id => id != thread)) Monitor.Wait(_gate);
        }
        _disposeCancellation.Cancel();
        _transport.Dispose();
        _disposeCancellation.Dispose();
    }
}
