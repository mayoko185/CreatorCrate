using System.Globalization;
using System.Net;
using System.Net.Http.Headers;
using System.Text.Json;

namespace OpenLocally;

internal enum ManualPostingConfirmationStatus
{
    Ready,
    Confirming,
    Posted,
    ConfirmationUnknown,
}

internal sealed record ManualPostingCompletion(int PostedCount, int TotalCount, bool IsComplete);

internal sealed record ManualPostingPlatformState(
    string Platform, ManualPostingConfirmationStatus Status, DateTime? PostedAt, string? Reason);

internal sealed record ManualPostingConfirmationResponse(
    string Platform, string Status, DateTime? PostedAt, ManualPostingCompletion Completion);

internal enum ManualPostingTransportOutcome
{
    Authoritative,
    Rejected,
    Ambiguous,
}

internal sealed record ManualPostingTransportResult(
    ManualPostingTransportOutcome Outcome, ManualPostingConfirmationResponse? Response, string? ErrorCode)
{
    internal static ManualPostingTransportResult Authoritative(ManualPostingConfirmationResponse response) =>
        new(ManualPostingTransportOutcome.Authoritative, response, null);

    internal static ManualPostingTransportResult Rejected(string code) =>
        new(ManualPostingTransportOutcome.Rejected, null, code);

    internal static ManualPostingTransportResult Ambiguous() =>
        new(ManualPostingTransportOutcome.Ambiguous, null, "confirmation_unavailable");
}

internal interface IManualPostingConfirmationTransport : IDisposable
{
    DateTime? ConfirmationExpiresAt { get; }
    Task<ManualPostingTransportResult> PostAsync(string platform, CancellationToken cancellationToken);
    Task<ManualPostingTransportResult> GetAsync(string platform, CancellationToken cancellationToken);
}

/// <summary>Retains the redeemed confirmation authority separately from ManualSocialSession.</summary>
internal sealed class ManualPostingConfirmationClient : IManualPostingConfirmationTransport
{
    private const int MaxJsonBytes = 64 * 1024;
    private static readonly HashSet<string> Platforms = new(StringComparer.Ordinal) { "patreon", "x", "bluesky" };
    private static readonly HashSet<string> RejectionCodes = new(StringComparer.Ordinal)
    {
        "confirmation_token_missing", "confirmation_token_malformed", "confirmation_token_invalid",
        "confirmation_token_expired", "attempt_superseded", "attempt_not_confirmable",
        "confirmation_target_not_owned", "confirmation_target_not_ready", "confirmation_conflict",
        "validation_failed",
    };

    private readonly SocialHttpClient _http;
    private readonly OriginTrustService _trust;
    private readonly SocialOrigin _origin;
    private readonly SocialCapability _capability;
    private bool _disposed;

    internal ManualPostingConfirmationClient(
        SocialHttpClient http, OriginTrustService trust, SocialOrigin origin,
        SocialCapability capability, DateTime? confirmationExpiresAt)
    {
        _http = http ?? throw new ArgumentNullException(nameof(http));
        _trust = trust ?? throw new ArgumentNullException(nameof(trust));
        _origin = origin ?? throw new ArgumentNullException(nameof(origin));
        _capability = capability ?? throw new ArgumentNullException(nameof(capability));
        ConfirmationExpiresAt = confirmationExpiresAt;
    }

    public DateTime? ConfirmationExpiresAt { get; }

    public Task<ManualPostingTransportResult> PostAsync(string platform, CancellationToken cancellationToken) =>
        SendAsync(HttpMethod.Post, platform, cancellationToken);

    public Task<ManualPostingTransportResult> GetAsync(string platform, CancellationToken cancellationToken) =>
        SendAsync(HttpMethod.Get, platform, cancellationToken);

    private async Task<ManualPostingTransportResult> SendAsync(
        HttpMethod method, string platform, CancellationToken cancellationToken)
    {
        ObjectDisposedException.ThrowIf(_disposed, this);
        if (!Platforms.Contains(platform)) return ManualPostingTransportResult.Rejected("validation_failed");

        using var request = new HttpRequestMessage(
            method, new Uri(_origin.Uri, $"/social-prep/{_capability.SessionId}/platforms/{platform}/posted"));
        request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", _capability.MediaToken);
        // POST intentionally has null Content: the reviewed endpoint requires zero entity bytes.

        try
        {
            OriginTrustResult authorization = await _trust.AuthorizeAsync(_origin, cancellationToken).ConfigureAwait(false);
            if (!authorization.Allowed) return ManualPostingTransportResult.Ambiguous();
            using HttpResponseMessage response = await _http.SendAsync(
                _origin, request, authorization.Transport!, cancellationToken).ConfigureAwait(false);

            int status = (int)response.StatusCode;
            if (response.IsSuccessStatusCode)
            {
                byte[] body = await ReadCappedAsync(response.Content, cancellationToken).ConfigureAwait(false);
                return TryParseResponse(body, _capability.SessionId, platform, out ManualPostingConfirmationResponse? parsed)
                    ? ManualPostingTransportResult.Authoritative(parsed!)
                    : ManualPostingTransportResult.Ambiguous();
            }

            if (status is >= 400 and < 500)
                return ManualPostingTransportResult.Rejected(await ReadBoundedErrorCodeAsync(response.Content, cancellationToken).ConfigureAwait(false));
            return ManualPostingTransportResult.Ambiguous();
        }
        catch (Exception ex) when (ex is HttpRequestException or OperationCanceledException or IOException or JsonException or InvalidOperationException or PayloadTooLargeException)
        {
            return ManualPostingTransportResult.Ambiguous();
        }
    }

    private static bool TryParseResponse(
        ReadOnlySpan<byte> json, string expectedSessionId, string expectedPlatform,
        out ManualPostingConfirmationResponse? result)
    {
        result = null;
        try
        {
            using JsonDocument document = JsonDocument.Parse(json.ToArray());
            JsonElement root = document.RootElement;
            if (root.ValueKind != JsonValueKind.Object ||
                !ExactProperties(root, "ok", "sessionId", "platform", "status", "postedAt", "completion") ||
                root.GetProperty("ok").ValueKind != JsonValueKind.True ||
                RequiredString(root.GetProperty("sessionId")) != expectedSessionId ||
                RequiredString(root.GetProperty("platform")) != expectedPlatform)
                return false;

            string status = RequiredString(root.GetProperty("status"));
            if (status is not ("ready" or "posted")) return false;
            DateTime? postedAt = OptionalTimestamp(root.GetProperty("postedAt"));
            if ((status == "posted") != postedAt.HasValue) return false;

            JsonElement completion = root.GetProperty("completion");
            if (completion.ValueKind != JsonValueKind.Object ||
                !ExactProperties(completion, "postedCount", "totalCount", "isComplete") ||
                !completion.GetProperty("postedCount").TryGetInt32(out int postedCount) || postedCount < 0 ||
                !completion.GetProperty("totalCount").TryGetInt32(out int totalCount) || totalCount < 0 ||
                postedCount > totalCount ||
                completion.GetProperty("isComplete").ValueKind is not (JsonValueKind.True or JsonValueKind.False))
                return false;
            bool isComplete = completion.GetProperty("isComplete").GetBoolean();
            if (isComplete != (totalCount > 0 && postedCount == totalCount)) return false;

            result = new ManualPostingConfirmationResponse(
                expectedPlatform, status, postedAt,
                new ManualPostingCompletion(postedCount, totalCount, isComplete));
            return true;
        }
        catch (Exception ex) when (ex is JsonException or FormatException or InvalidOperationException) { return false; }
    }

    private static async Task<string> ReadBoundedErrorCodeAsync(HttpContent content, CancellationToken cancellationToken)
    {
        try
        {
            byte[] body = await ReadCappedAsync(content, cancellationToken).ConfigureAwait(false);
            using JsonDocument document = JsonDocument.Parse(body);
            JsonElement root = document.RootElement;
            if (root.ValueKind == JsonValueKind.Object && ExactProperties(root, "ok", "error") &&
                root.GetProperty("ok").ValueKind == JsonValueKind.False)
            {
                JsonElement error = root.GetProperty("error");
                if (error.ValueKind == JsonValueKind.Object && ExactProperties(error, "code", "message") &&
                    error.GetProperty("code").ValueKind == JsonValueKind.String &&
                    error.GetProperty("code").GetString() is { } code && RejectionCodes.Contains(code) &&
                    error.GetProperty("message").ValueKind == JsonValueKind.String)
                    return code;
            }
        }
        catch (Exception ex) when (ex is JsonException or InvalidOperationException or IOException or PayloadTooLargeException) { }
        return "confirmation_rejected";
    }

    private static bool ExactProperties(JsonElement element, params string[] expected)
    {
        var seen = new HashSet<string>(StringComparer.Ordinal);
        foreach (JsonProperty property in element.EnumerateObject())
            if (!seen.Add(property.Name) || !expected.Contains(property.Name, StringComparer.Ordinal)) return false;
        return seen.Count == expected.Length;
    }

    private static string RequiredString(JsonElement element) =>
        element.ValueKind == JsonValueKind.String && element.GetString() is { Length: > 0 } value
            ? value : throw new FormatException();

    private static DateTime? OptionalTimestamp(JsonElement element)
    {
        if (element.ValueKind == JsonValueKind.Null) return null;
        return DateTime.TryParseExact(RequiredString(element), "yyyy-MM-dd HH:mm:ss", CultureInfo.InvariantCulture,
            DateTimeStyles.None, out DateTime value) ? value : throw new FormatException();
    }

    private static async Task<byte[]> ReadCappedAsync(HttpContent content, CancellationToken cancellationToken)
    {
        if (content.Headers.ContentLength is long length && length > MaxJsonBytes) throw new PayloadTooLargeException();
        await using Stream source = await content.ReadAsStreamAsync(cancellationToken).ConfigureAwait(false);
        using var target = new MemoryStream();
        byte[] buffer = new byte[8192];
        for (int read; (read = await source.ReadAsync(buffer, cancellationToken).ConfigureAwait(false)) > 0;)
        {
            if (target.Length > MaxJsonBytes - read) throw new PayloadTooLargeException();
            target.Write(buffer, 0, read);
        }
        return target.ToArray();
    }

    public void Dispose() => _disposed = true;

    private sealed class PayloadTooLargeException : Exception { }
}

/// <summary>Server-authoritative per-platform confirmation state for one companion lifetime.</summary>
internal sealed class ManualPostingConfirmationController : IDisposable
{
    internal const string RetryReason = "Confirmation not received. Retry.";
    internal const string ExpiredReason = "Posting confirmation expired. Reopen from CreatorCrate.";
    internal const string RejectedReason = "Posting confirmation is no longer available. Reopen from CreatorCrate.";

    private readonly object _gate = new();
    private readonly IManualPostingConfirmationTransport _transport;
    private readonly Func<DateTime> _now;
    private readonly Dictionary<string, ManualPostingPlatformState> _states;
    private readonly Dictionary<string, Task<ManualPostingPlatformState>> _inFlight = new(StringComparer.Ordinal);
    private readonly SemaphoreSlim _workflowGate = new(1, 1);
    private readonly CancellationTokenSource _disposeCancellation = new();
    private ManualPostingCompletion? _completion;
    private bool _disposed;

    internal ManualPostingConfirmationController(
        IManualPostingConfirmationTransport transport, IEnumerable<string> platforms, Func<DateTime>? now = null)
    {
        _transport = transport ?? throw new ArgumentNullException(nameof(transport));
        _now = now ?? (() => DateTime.UtcNow);
        _states = platforms.Distinct(StringComparer.Ordinal).ToDictionary(
            platform => platform,
            platform => new ManualPostingPlatformState(platform, ManualPostingConfirmationStatus.Ready, null, null),
            StringComparer.Ordinal);
        if (_states.Count == 0) throw new ArgumentException("At least one platform is required.", nameof(platforms));
    }

    internal DateTime? ConfirmationExpiresAt => _transport.ConfirmationExpiresAt;

    internal ManualPostingCompletion? Completion
    {
        get { lock (_gate) return _completion; }
    }

    internal ManualPostingPlatformState GetState(string platform)
    {
        lock (_gate) return _states.TryGetValue(platform, out ManualPostingPlatformState? state)
            ? state : throw new ArgumentOutOfRangeException(nameof(platform));
    }

    internal Task<ManualPostingPlatformState> ConfirmAsync(string platform, CancellationToken cancellationToken = default)
    {
        lock (_gate)
        {
            ObjectDisposedException.ThrowIf(_disposed, this);
            if (!_states.TryGetValue(platform, out ManualPostingPlatformState? state))
                throw new ArgumentOutOfRangeException(nameof(platform));
            if (state.Status == ManualPostingConfirmationStatus.Posted)
                return Task.FromResult(state);
            if (_inFlight.TryGetValue(platform, out Task<ManualPostingPlatformState>? existing))
                return existing;

            bool reconcileFirst = state.Status == ManualPostingConfirmationStatus.ConfirmationUnknown;
            _states[platform] = state with { Status = ManualPostingConfirmationStatus.Confirming, Reason = null };
            var completion = new TaskCompletionSource<ManualPostingPlatformState>(
                TaskCreationOptions.RunContinuationsAsynchronously);
            Task<ManualPostingPlatformState> operation = completion.Task;
            _inFlight[platform] = operation;
            _ = CompleteOperationAsync(platform, reconcileFirst, cancellationToken, completion);
            return operation;
        }
    }

    private async Task CompleteOperationAsync(
        string platform, bool reconcileFirst, CancellationToken cancellationToken,
        TaskCompletionSource<ManualPostingPlatformState> completion)
    {
        ManualPostingPlatformState? result = null;
        Exception? failure = null;
        try { result = await RunAsync(platform, reconcileFirst, cancellationToken).ConfigureAwait(false); }
        catch (Exception exception) { failure = exception; }

        RemoveInFlight(platform, completion.Task);
        if (failure is not null) completion.TrySetException(failure);
        else completion.TrySetResult(result!);
    }

    private async Task<ManualPostingPlatformState> RunAsync(
        string platform, bool reconcileFirst, CancellationToken cancellationToken)
    {
        using var linked = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken, _disposeCancellation.Token);
        bool enteredWorkflow = false;
        try
        {
            await _workflowGate.WaitAsync(linked.Token).ConfigureAwait(false);
            enteredWorkflow = true;

            lock (_gate)
                if (_disposed) return _states[platform];

            if (ConfirmationExpiresAt is DateTime deadline && _now() >= deadline)
                return SetNonPosted(platform, ManualPostingConfirmationStatus.Ready, ExpiredReason);

            if (reconcileFirst)
            {
                ManualPostingTransportResult initialRead = await SafeGetAsync(platform, linked.Token).ConfigureAwait(false);
                if (initialRead.Outcome == ManualPostingTransportOutcome.Authoritative)
                {
                    ManualPostingPlatformState reconciled = ApplyAuthoritative(platform, initialRead.Response!);
                    if (reconciled.Status == ManualPostingConfirmationStatus.Posted) return reconciled;
                    SetConfirming(platform);
                }
                else if (initialRead.Outcome == ManualPostingTransportOutcome.Rejected)
                    return SetNonPosted(platform, ManualPostingConfirmationStatus.Ready, ReasonFor(initialRead.ErrorCode));
                else return SetNonPosted(platform, ManualPostingConfirmationStatus.ConfirmationUnknown, RetryReason);
            }

            ManualPostingTransportResult posted = await SafePostAsync(platform, linked.Token).ConfigureAwait(false);
            if (posted.Outcome == ManualPostingTransportOutcome.Authoritative)
                return ApplyAuthoritative(platform, posted.Response!);
            if (posted.Outcome == ManualPostingTransportOutcome.Rejected)
                return SetNonPosted(platform, ManualPostingConfirmationStatus.Ready, ReasonFor(posted.ErrorCode));

            lock (_gate)
                if (_disposed) return _states[platform];

            ManualPostingTransportResult readback = await SafeGetAsync(platform, linked.Token).ConfigureAwait(false);
            return readback.Outcome switch
            {
                ManualPostingTransportOutcome.Authoritative => ApplyAuthoritative(platform, readback.Response!),
                ManualPostingTransportOutcome.Rejected => SetNonPosted(
                    platform, ManualPostingConfirmationStatus.Ready, ReasonFor(readback.ErrorCode)),
                _ => SetNonPosted(platform, ManualPostingConfirmationStatus.ConfirmationUnknown, RetryReason),
            };
        }
        catch (OperationCanceledException) when (linked.IsCancellationRequested)
        {
            lock (_gate)
                if (_disposed) return _states[platform];
            return SetNonPosted(platform, ManualPostingConfirmationStatus.ConfirmationUnknown, RetryReason);
        }
        finally
        {
            if (enteredWorkflow) _workflowGate.Release();
        }
    }

    private ManualPostingPlatformState ApplyAuthoritative(string platform, ManualPostingConfirmationResponse response)
    {
        lock (_gate)
        {
            if (_disposed) return _states[platform];
            _completion = response.Completion;
            ManualPostingPlatformState state = response.Status == "posted"
                ? new(platform, ManualPostingConfirmationStatus.Posted, response.PostedAt, null)
                : new(platform, ManualPostingConfirmationStatus.Ready, null, null);
            _states[platform] = state;
            return state;
        }
    }

    private ManualPostingPlatformState SetNonPosted(
        string platform, ManualPostingConfirmationStatus status, string reason)
    {
        lock (_gate)
        {
            if (_disposed) return _states[platform];
            var state = new ManualPostingPlatformState(platform, status, null, reason);
            _states[platform] = state;
            return state;
        }
    }

    private void SetConfirming(string platform)
    {
        lock (_gate)
        {
            if (_disposed) return;
            ManualPostingPlatformState current = _states[platform];
            _states[platform] = current with
            {
                Status = ManualPostingConfirmationStatus.Confirming,
                PostedAt = null,
                Reason = null,
            };
        }
    }

    private async Task<ManualPostingTransportResult> SafePostAsync(string platform, CancellationToken cancellationToken)
    {
        try
        {
            ManualPostingTransportResult result = await _transport.PostAsync(platform, cancellationToken).ConfigureAwait(false);
            return WithUsableAggregate(result);
        }
        catch (Exception ex) when (ex is not (StackOverflowException or OutOfMemoryException)) { return ManualPostingTransportResult.Ambiguous(); }
    }

    private async Task<ManualPostingTransportResult> SafeGetAsync(string platform, CancellationToken cancellationToken)
    {
        try
        {
            ManualPostingTransportResult result = await _transport.GetAsync(platform, cancellationToken).ConfigureAwait(false);
            return WithUsableAggregate(result);
        }
        catch (Exception ex) when (ex is not (StackOverflowException or OutOfMemoryException)) { return ManualPostingTransportResult.Ambiguous(); }
    }

    private static ManualPostingTransportResult WithUsableAggregate(ManualPostingTransportResult result)
    {
        if (result.Outcome != ManualPostingTransportOutcome.Authoritative) return result;
        ManualPostingCompletion? completion = result.Response?.Completion;
        return completion is not null && completion.PostedCount >= 0 && completion.TotalCount >= 0 &&
            completion.PostedCount <= completion.TotalCount &&
            completion.IsComplete == (completion.TotalCount > 0 && completion.PostedCount == completion.TotalCount)
                ? result : ManualPostingTransportResult.Ambiguous();
    }

    private static string ReasonFor(string? errorCode) =>
        errorCode == "confirmation_token_expired" ? ExpiredReason : RejectedReason;

    private void RemoveInFlight(string platform, Task<ManualPostingPlatformState> operation)
    {
        lock (_gate)
            if (_inFlight.TryGetValue(platform, out Task<ManualPostingPlatformState>? current) && ReferenceEquals(current, operation))
                _inFlight.Remove(platform);
    }

    public void Dispose()
    {
        lock (_gate)
        {
            if (_disposed) return;
            _disposed = true;
        }
        _disposeCancellation.Cancel();
        _transport.Dispose();
        _disposeCancellation.Dispose();
    }
}
