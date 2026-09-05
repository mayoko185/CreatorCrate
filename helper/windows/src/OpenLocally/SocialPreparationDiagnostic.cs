using System.Text.Json;
using System.Text.RegularExpressions;
using System.Text;

namespace OpenLocally;

/// <summary>
/// Payload-free, bounded evidence for a failed social-preparation attempt.
/// This object is the one representation used by normal status reporting and
/// the manual Patreon trace; it intentionally contains no content or browser
/// identity values.
/// </summary>
public sealed class SocialPreparationDiagnostic
{
    public const int MaximumSerializedLength = 6_144;
    public const int MaximumMessageLength = 256;
    private static readonly Regex Url = new(@"\b[a-z][a-z0-9+.-]*://[^\s;,|]+", RegexOptions.IgnoreCase | RegexOptions.CultureInvariant);
    // Helper diagnostics delimit fields with semicolons, commas, or pipes. Consume
    // each private local path through that trusted field delimiter, including spaces.
    private static readonly Regex Path = new(@"(?<!\w)(?:[a-z]:\\|\\\\|/(?!/))[^;,|]+", RegexOptions.IgnoreCase | RegexOptions.CultureInvariant);
    private static readonly Regex HtmlElement = new(@"<[^>]{0,512}>.*?</[^>]{0,512}>", RegexOptions.CultureInvariant);
    private static readonly Regex Html = new(@"<[^>]{0,512}>|<.*$", RegexOptions.CultureInvariant);
    // Sensitive keyed values consume through the same trusted field delimiter;
    // whitespace is content, not a boundary, for titles, notes, and descriptions.
    private static readonly Regex Secret = new(@"\b(?:[\w-]*(?:token|cookie|secret|csrf)[\w-]*|authorization|auth(?:orization)?|bearer|capability|intent|session(?:[-_ ]?id)?|target(?:[-_ ]?id)?|backend[-_ ]?node[-_ ]?id|node[-_ ]?id|creator(?:[-_ ]?vanity)?|vanity|title|body|description|notes)\b\s*(?::|=)\s*[^;,|]+", RegexOptions.IgnoreCase | RegexOptions.CultureInvariant);
    private static readonly Regex NamedId = new(@"\b(?:target|session|backend\s*node|node|frame|object)\s+id\s+[^\s;,|]+", RegexOptions.IgnoreCase | RegexOptions.CultureInvariant);

    private readonly Dictionary<string, bool?> _checkpoints = new(StringComparer.Ordinal);
    private readonly Dictionary<string, bool?> _targetState = new(StringComparer.Ordinal);

    public SocialPreparationDiagnostic(string platform, string phase, string stableCode)
    {
        Platform = FixedPlatform(platform);
        Adapter = $"{Platform}_social_preparation";
        Phase = FixedWord(phase, "unknown");
        StableCode = FixedWord(stableCode, "platform_preparation_failed");
    }

    public string Platform { get; }
    public string Adapter { get; }
    public string Phase { get; private set; }
    public string StableCode { get; private set; }
    public string ErrorClass { get; private set; } = "unexpected";
    public string? CdpOperation { get; private set; }
    public int? CdpCode { get; private set; }
    public string? CdpMessage { get; private set; }
    public string? CleanupErrorClass { get; private set; }
    public int? ReleaseId { get; private set; }
    public int? Attempt { get; private set; }
    public string? ReportingFailure { get; private set; }
    public string? ReportingErrorClass { get; private set; }
    public PatreonCreateResolutionEvidence? CreateResolution { get; private set; }
    internal ManualPreparationEvidence? ManualPreparation { get; private set; }

    internal void SetManualPreparation(ManualPreparationEvidence evidence) => ManualPreparation = evidence;

    internal void SetCreateResolution(PatreonCreateResolutionEvidence? evidence) => CreateResolution = evidence;

    public void SetPhase(string phase) => Phase = FixedWord(phase, "unknown");
    public void SetStableCode(string code) => StableCode = FixedWord(code, "platform_preparation_failed");
    public void Checkpoint(string name, bool? value = true)
    {
        if (_checkpoints.Count < 16 && !_checkpoints.ContainsKey(name)) _checkpoints[FixedWord(name, "unknown")] = value;
    }
    public void TargetState(string name, bool? value)
    {
        if (_targetState.Count < 8 && !_targetState.ContainsKey(name)) _targetState[FixedWord(name, "unknown")] = value;
    }

    public void CapturePrimary(Exception exception, bool timedOut = false)
    {
        ErrorClass = Classify(exception, timedOut);
        if (!timedOut && Platform == "patreon" && Phase == "create_activation" &&
            exception is PatreonPreparationException { Code: "patreon_create_control_missing" } &&
            CreateResolution?.Outcome is PatreonCreateResolutionOutcome.RootUnavailable or
                PatreonCreateResolutionOutcome.ZeroMatches or PatreonCreateResolutionOutcome.NoUsableCandidate or
                PatreonCreateResolutionOutcome.StaleDescription)
            ErrorClass = "browser_preparation";
        if (exception is CdpCommandException cdp)
        {
            CdpOperation = CdpOperationName(cdp.Operation);
            CdpCode = cdp.Code;
            CdpMessage = SanitizeMessage(cdp.Message);
        }
    }

    public void CaptureCleanup(Exception exception, bool timedOut = false) => CleanupErrorClass = Classify(exception, timedOut);
    public void SetCorrelation(int? releaseId, int? attempt)
    {
        if (releaseId is > 0) ReleaseId = releaseId;
        if (attempt is >= 0) Attempt = attempt;
    }
    public void SetReportingFailure(string code, Exception? exception = null, bool timedOut = false)
    {
        ReportingFailure = FixedWord(code, "status_reporting_failed");
        if (exception is not null) ReportingErrorClass = Classify(exception, timedOut);
    }

    public string Serialize()
    {
        var payload = new Dictionary<string, object?>
        {
            ["subsystem"] = "social_preparation",
            ["timestamp"] = DateTimeOffset.UtcNow.ToString("O"),
            ["platform"] = Platform,
            ["adapter"] = Adapter,
            ["phase"] = Phase,
            ["stable_code"] = StableCode,
            ["outcome"] = "failed",
            ["error_class"] = ErrorClass,
            ["checkpoints"] = _checkpoints,
            ["target_state"] = _targetState,
        };
        if (CdpOperation is not null) payload["cdp_operation"] = CdpOperation;
        if (CreateResolution is not null) payload["create_resolution"] = CreateResolution.ToPayload();
        if (ManualPreparation is not null) payload["manual_preparation"] = ManualPreparation.ToPayload();
        if (CdpCode is not null) payload["cdp_code"] = CdpCode;
        if (CdpMessage is not null) payload["cdp_message"] = CdpMessage;
        if (CleanupErrorClass is not null) payload["cleanup"] = new Dictionary<string, string> { ["error_class"] = CleanupErrorClass };
        if (ReleaseId is not null) payload["release_id"] = ReleaseId;
        if (Attempt is not null) payload["attempt"] = Attempt;
        if (ReportingFailure is not null)
        {
            var reporting = new Dictionary<string, string> { ["stable_error"] = ReportingFailure };
            if (ReportingErrorClass is not null) reporting["error_class"] = ReportingErrorClass;
            payload["reporting"] = reporting;
        }
        string json = JsonSerializer.Serialize(payload);
        // All independently bounded fields fit well below this limit. This guard
        // keeps the transport deterministic if a future field is added incorrectly.
        return Encoding.UTF8.GetByteCount(json) <= MaximumSerializedLength ? json : JsonSerializer.Serialize(new
        {
            subsystem = "social_preparation", platform = Platform, adapter = Adapter, phase = Phase,
            stable_code = StableCode, outcome = "failed", error_class = ErrorClass, truncated = true,
            manual_preparation = ManualPreparation?.ToPayload(),
        });
    }

    /// <summary>
    /// Formats the same bounded, sanitized evidence used for status retention
    /// for the native helper error surface. This deliberately does not use
    /// exception text or browser identities, and does not impose a second
    /// presentation limit on a legal serialized diagnostic.
    /// </summary>
    public string FormatForDisplay()
    {
        var report = new StringBuilder()
            .AppendLine("Social Preparation failed")
            .AppendLine($"Platform: {Platform}")
            .AppendLine($"Adapter: {Adapter}")
            .AppendLine($"Phase: {Phase}")
            .AppendLine($"Stable error: {StableCode}")
            .AppendLine("Outcome: failed")
            .AppendLine($"Error class: {ErrorClass}");

        if (CdpOperation is not null) report.AppendLine($"CDP operation: {CdpOperation}");
        if (CdpCode is not null) report.AppendLine($"CDP code: {CdpCode}");
        if (CdpMessage is not null) report.AppendLine($"CDP message: {CdpMessage}");
        if (ReleaseId is not null) report.AppendLine($"Release ID: {ReleaseId}");
        if (Attempt is not null) report.AppendLine($"Attempt: {Attempt}");

        if (CreateResolution is not null)
        {
            report.AppendLine("Create resolution:");
            foreach ((string name, object? value) in CreateResolution.ToPayload())
                report.AppendLine($"  {name}: {(value is bool flag ? DisplayValue(flag) : value)}");
            if (CreateResolution.Outcome is null) report.AppendLine("  outcome: unknown");
            if (CreateResolution.CandidateCount is null) report.AppendLine("  candidate_count: unknown");
            if (!CreateResolution.Complete) report.AppendLine("  Counts are partial; candidate-set inspection is incomplete.");
        }

        ManualPreparation?.AppendDisplay(report);

        report.AppendLine("Checkpoints:");
        foreach ((string name, bool? value) in _checkpoints)
            report.AppendLine($"  {name}: {DisplayValue(value)}");

        report.AppendLine("Target/lifecycle:");
        foreach ((string name, bool? value) in _targetState)
            report.AppendLine($"  {name}: {DisplayValue(value)}");

        if (CleanupErrorClass is not null)
        {
            report.AppendLine("Cleanup:");
            report.AppendLine($"  Error class: {CleanupErrorClass}");
        }
        if (ReportingFailure is not null)
        {
            report.AppendLine("Reporting/persistence:");
            report.AppendLine($"  Stable error: {ReportingFailure}");
            if (ReportingErrorClass is not null) report.AppendLine($"  Error class: {ReportingErrorClass}");
        }

        return report.ToString().TrimEnd();
    }

    public static string SanitizeMessage(string? message)
    {
        if (string.IsNullOrWhiteSpace(message)) return "unknown";
        string value = message[..Math.Min(message.Length, 1_024)];
        value = new string(value.Select(c => char.IsControl(c) ? ' ' : c).ToArray());
        value = HtmlElement.Replace(value, "[redacted-html]");
        value = Html.Replace(value, "[redacted-html]");
        value = Url.Replace(value, "[redacted-url]");
        value = Path.Replace(value, "[redacted-path]");
        value = Secret.Replace(value, "[redacted]");
        value = NamedId.Replace(value, "[redacted]");
        value = value.Replace(';', ',').Replace('|', ',').Replace('=', ':');
        value = string.Join(' ', value.Split(' ', StringSplitOptions.RemoveEmptyEntries));
        return value.Length <= MaximumMessageLength ? (value.Length == 0 ? "unknown" : value) : string.Concat(value.AsSpan(0, MaximumMessageLength - 11), "[truncated]");
    }

    private static string Classify(Exception exception, bool timedOut) => exception switch
    {
        CdpCommandException => "cdp_command",
        CdpTransportException => "cdp_transport",
        BrowserPreparationException { Failure: BrowserPreparationFailure.InvalidTarget or BrowserPreparationFailure.NotOwnedTarget } => "target_closed",
        BrowserPreparationException => "browser_preparation",
        ObjectDisposedException => "target_closed",
        TimeoutException => "timeout",
        OperationCanceledException when timedOut => "timeout",
        SocialPreparationRuntimeException { Code: "platform_auth_required" } => "authentication_manual_attention",
        SocialPreparationRuntimeException { Code: "validation_failed" } => "validation",
        _ => "unexpected",
    };

    private static string CdpOperationName(string? operation) => operation switch
    {
        "DOM.getDocument" => "get_document", "DOM.querySelector" => "query_selector", "DOM.querySelectorAll" => "query_selector_all",
        "DOM.describeNode" => "describe_node", "DOM.getBoxModel" => "get_box_model", "DOM.scrollIntoViewIfNeeded" => "scroll_into_view",
        "DOM.setFileInputFiles" => "set_file_input_files", "DOM.focus" => "focus", "Page.navigate" => "navigate",
        "Input.dispatchMouseEvent" => "dispatch_mouse_event", "Input.insertText" => "insert_text",
        _ => "unknown",
    };

    private static string DisplayValue(bool? value) => value switch { true => "yes", false => "no", _ => "unknown" };
    private static string FixedPlatform(string value) => value is "x" or "bluesky" or "patreon" ? value : "unknown";
    private static string FixedWord(string? value, string fallback) => !string.IsNullOrWhiteSpace(value) && value.Length <= 64 && value.All(c => c is >= 'a' and <= 'z' or >= '0' and <= '9' or '_') ? value : fallback;
}

public enum PatreonCreateResolutionOutcome
{
    RootUnavailable, ZeroMatches, NoUsableCandidate, Ambiguous, CandidateLimitExceeded,
    MalformedQuery, InvalidCandidateIdentity, MalformedDescription, StaleDescription,
    MalformedGeometry, UniqueCandidate,
}

/// <summary>Identity-free snapshot. Null counts/outcome mean not yet known, never zero.
/// Inspected counts include only candidates whose description and layout check finished.
/// Complete means the entire accepted candidate set was inspected, not that selection succeeded.</summary>
public sealed class PatreonCreateResolutionEvidence
{
    public const int CandidateLimit = 16;
    public PatreonCreateResolutionOutcome? Outcome { get; }
    public int? CandidateCount { get; }
    public int? InspectedCount { get; }
    public int? UsableCount { get; }
    public int? LayoutRejectedCount { get; }
    public bool LimitExceeded { get; }
    public bool Complete { get; }

    internal PatreonCreateResolutionEvidence(PatreonCreateResolutionOutcome? outcome = null,
        int? candidateCount = null, int? inspectedCount = null, int? usableCount = null,
        int? layoutRejectedCount = null, bool limitExceeded = false, bool complete = false)
    {
        if (outcome is not null && !Enum.IsDefined(outcome.Value)) throw new ArgumentOutOfRangeException(nameof(outcome));
        foreach (int? count in new[] { candidateCount, inspectedCount, usableCount, layoutRejectedCount })
            if (count is < 0 or > CandidateLimit) throw new ArgumentOutOfRangeException(nameof(count));
        Outcome = outcome;
        CandidateCount = candidateCount;
        InspectedCount = inspectedCount;
        UsableCount = usableCount;
        LayoutRejectedCount = layoutRejectedCount;
        LimitExceeded = limitExceeded;
        Complete = complete;
    }

    internal Dictionary<string, object?> ToPayload()
    {
        var payload = new Dictionary<string, object?>
        {
            ["stage"] = "create_resolution", ["candidate_limit"] = CandidateLimit,
            ["limit_exceeded"] = LimitExceeded, ["complete"] = Complete,
        };
        if (Outcome is not null) payload["outcome"] = Outcome.Value switch
        {
            PatreonCreateResolutionOutcome.RootUnavailable => "root_unavailable",
            PatreonCreateResolutionOutcome.ZeroMatches => "zero_matches",
            PatreonCreateResolutionOutcome.NoUsableCandidate => "no_usable_candidate",
            PatreonCreateResolutionOutcome.Ambiguous => "ambiguous",
            PatreonCreateResolutionOutcome.CandidateLimitExceeded => "candidate_limit_exceeded",
            PatreonCreateResolutionOutcome.MalformedQuery => "malformed_query",
            PatreonCreateResolutionOutcome.InvalidCandidateIdentity => "invalid_candidate_identity",
            PatreonCreateResolutionOutcome.MalformedDescription => "malformed_description",
            PatreonCreateResolutionOutcome.StaleDescription => "stale_description",
            PatreonCreateResolutionOutcome.MalformedGeometry => "malformed_geometry",
            PatreonCreateResolutionOutcome.UniqueCandidate => "unique_candidate",
            _ => throw new InvalidOperationException(),
        };
        if (CandidateCount is not null) payload["candidate_count"] = CandidateCount;
        if (InspectedCount is not null) payload["inspected_count"] = InspectedCount;
        if (UsableCount is not null) payload["usable_count"] = UsableCount;
        if (LayoutRejectedCount is not null) payload["layout_rejected_count"] = LayoutRejectedCount;
        return payload;
    }
}
