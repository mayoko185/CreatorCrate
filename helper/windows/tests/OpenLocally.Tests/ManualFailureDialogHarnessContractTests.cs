using System.Diagnostics;

namespace OpenLocally.Tests;

/// <summary>
/// Keeps the manual wrapper on the shared native dialog source instead of a
/// console-only or platform-specific reporting branch. Process regressions use
/// explicit offline injection: automated tests never open a blocking desktop UI.
/// </summary>
public class ManualFailureDialogHarnessContractTests
{
    // Exact 886 ASCII bytes / 37 CRLF lines from the retained 2026-09-05 run
    // 01a07248-f9d5-7e90-ba25-fe32410ffde5/patreon-live/capture.txt.
    // The following blank line and Ready coordination suffix belong to the parent,
    // not the child. Preserve the child's terminal CRLF and nested field order.
    private static string LiveChildStderr => string.Join("\r\n", new[] {
        "chrome_connection_prompt_failed",
        "Social Preparation failed",
        "Platform: patreon",
        "Adapter: patreon_social_preparation",
        "Phase: manual_preparation",
        "Stable error: chrome_connection_prompt_failed",
        "Outcome: failed",
        "Error class: unexpected",
        "Manual preparation:",
        "  composition:",
        "    state: completed",
        "  consent:",
        "    state: completed",
        "    parent_requested: yes",
        "    parent_response_accepted: yes",
        "    decision: display_failed",
        "    local_presentation: failed",
        "  discovery:",
        "    state: not_started",
        "    result: unknown",
        "  connection_setup:",
        "    state: not_started",
        "  connection:",
        "    state: not_started",
        "    result: unknown",
        "  browser_setup:",
        "    state: not_started",
        "  adapter_invocation:",
        "    state: not_started",
        "  runtime_disposal:",
        "    state: completed",
        "  failure:",
        "    kind: failure_outcome",
        "    exception_class: unknown",
        "    disposal_exception_class: unknown",
        "Checkpoints:",
        "Target/lifecycle:",
        "",
    });

    [Theory]
    [InlineData("valid")]
    [InlineData("private_cdp")]
    [InlineData("malformed_body")]
    [InlineData("trailing")]
    [InlineData("leading")]
    [InlineData("manual_field")]
    public async Task LiveCapture_RawChildSourceSurvivesMixedResultAtOnePresenter(string mutation)
    {
        string raw = LiveChildStderr;
        Assert.Equal(886, System.Text.Encoding.UTF8.GetByteCount(raw));
        Assert.Equal(37, raw.Count(c => c == '\n'));
        string candidate = mutation switch
        {
            "private_cdp" => raw.Replace("Manual preparation:", "CDP operation: get_box_model\r\nCDP code: -32000\r\nCDP message: https://PRIVATE.invalid token=PRIVATE\r\nManual preparation:"),
            "malformed_body" => raw.Replace("Outcome: failed\r\n", ""),
            "trailing" => raw + "PRIVATE arbitrary stderr\r\n",
            "leading" => "PRIVATE arbitrary stderr\r\n" + raw,
            "manual_field" => raw.Replace("parent_response_accepted: yes", "parent_response_accepted: PRIVATE"),
            _ => raw,
        };
        string directory = Path.Combine(Path.GetTempPath(), "CreatorCrate-live-payload-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(directory);
        try
        {
            File.WriteAllText(Path.Combine(directory, "child-stderr.txt"), candidate);
            var result = await RunOffline("-VerifyFullDetailFailure", "helper_only", "-OfflineReportDirectory", directory);
            Assert.True(result.Exit == 0, result.Output + result.Error);
            Assert.Equal(string.Empty, result.Error);
            Assert.Contains("FULL_DETAIL_PASS=helper_only;count=1;exit_confirmed=true", result.Output);
            Assert.Equal(candidate, File.ReadAllText(Path.Combine(directory, "raw-stderr.txt")));
            string parsed = File.ReadAllText(Path.Combine(directory, "parsed-helper.txt"));
            string report = File.ReadAllText(Path.Combine(directory, "presented.txt"));
            string capture = File.ReadAllText(Path.Combine(directory, "capture.txt"));
            if (mutation == "valid")
            {
                Assert.False(string.IsNullOrEmpty(parsed), "Actual production payload parsed as unavailable.");
                string expected = raw[(raw.IndexOf('\n') + 1)..].TrimEnd('\r', '\n');
                Assert.Equal(expected, parsed);
                Assert.Contains(expected, report); // All headers and every ManualPreparation field, unchanged.
                Assert.DoesNotContain("Helper diagnostic: unavailable", report);
                Assert.DoesNotContain("manual_helper_failed", report);
                Assert.Contains("Stable error: chrome_connection_prompt_failed", report);
            }
            else
            {
                Assert.Equal(string.Empty, parsed); // Atomic rejection, never a promoted prefix.
                Assert.Contains("Helper diagnostic: unavailable", report);
                Assert.Contains("Stable error: manual_helper_failed", report);
                Assert.DoesNotContain("Platform:", report);
                Assert.DoesNotContain("Manual preparation:", report);
            }
            Assert.DoesNotContain("PRIVATE", report);
            Assert.DoesNotContain("987654321", report);
            foreach (string evidence in new[] {
                "Child started: yes", "Child exit confirmed: yes", "Helper exit code: 17",
                "Child coordination: child_exit_confirmed=true; output_collection=completed",
                "Child output: stream=stdout; state=collected", "Child output: stream=stderr; state=collected",
                "Ready coordination: state=failed; reason=presentation",
                "Child presentation: state=failed;stage=set_thread_desktop;win32_code=170" })
                Assert.Contains(evidence, report);
            Assert.Equal("0", File.ReadAllText(Path.Combine(directory, "before-exit-count")));
            Assert.Contains(report, capture);
            var clipboard = new ReportClipboard();
            Assert.True(OpenLocally.NativeFailureDialog.TryCopyReport(report, clipboard));
            Assert.Equal(report, clipboard.Text);
        }
        finally { Directory.Delete(directory, recursive: true); }
    }

    [Theory]
    [InlineData("combined", "patreon", "manual")]
    [InlineData("helper_only", "patreon", "manual")]
    [InlineData("harness_only", "patreon", "manual")]
    [InlineData("missing", "patreon", "manual")]
    [InlineData("presenter_failed", "patreon", "manual")]
    [InlineData("combined", "patreon", "create")]
    [InlineData("combined", "patreon", "cdp")]
    [InlineData("combined", "patreon", "safe_cdp")]
    [InlineData("combined", "x", "cdp")]
    [InlineData("combined", "bluesky", "cdp")]
    [InlineData("helper_only", "x", "cdp")]
    [InlineData("helper_only", "bluesky", "cdp")]
    [InlineData("combined", "patreon", "maximum")]
    [InlineData("combined", "patreon", "identity")]
    [InlineData("combined", "patreon", "create_partial")]
    public async Task FullDetail_ActualParentFallbackMergesFinalEvidenceOnce(string scenario, string platform, string detail)
    {
        string directory = Path.Combine(Path.GetTempPath(), "CreatorCrate-full-detail-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(directory);
        try
        {
            var diagnostic = new OpenLocally.SocialPreparationDiagnostic(platform, "manual_preparation", "chrome_connection_prompt_failed");
            var manual = new OpenLocally.ManualPreparationEvidence
            {
                Composition = OpenLocally.ManualBoundaryState.completed,
                Consent = OpenLocally.ManualBoundaryState.completed,
                RuntimeDisposal = OpenLocally.ManualBoundaryState.completed,
            };
            // Exercise the real bridge's bounded no-response outcome, without UI.
            var consent = new OpenLocally.ManualReadyConsent(new FailedConsent(), directory, Guid.NewGuid().ToString("N"), TimeSpan.Zero);
            manual.ObserveConsent(consent, consent.ConfirmReady());
            manual.CaptureFailure(OpenLocally.ManualFailureKind.failure_outcome);
            diagnostic.SetManualPreparation(manual);
            if (detail == "identity") diagnostic.SetCorrelation(123456789, 87654321);
            if (detail == "create_partial") diagnostic.SetCreateResolution(new OpenLocally.PatreonCreateResolutionEvidence());
            if (detail is "create" or "maximum")
            {
                diagnostic.SetPhase("create_activation");
                diagnostic.SetStableCode("patreon_create_control_missing");
                diagnostic.SetCreateResolution(new OpenLocally.PatreonCreateResolutionEvidence(
                    OpenLocally.PatreonCreateResolutionOutcome.NoUsableCandidate, 3, 3, 0, 3, complete: true));
            }
            if (detail == "safe_cdp") diagnostic.CapturePrimary(new OpenLocally.CdpCommandException(-32000, "Node does not have a layout object", "DOM.getBoxModel"));
            else if (detail is "cdp" or "maximum")
            {
                diagnostic.CapturePrimary(new OpenLocally.CdpCommandException(-32000,
                    "Node unavailable; https://private.invalid; C:\\private\\private-image.png; token=private_token; target=private_target; vanity=private_vanity; title=private_title; body=private_body", "DOM.scrollIntoViewIfNeeded"));
            }
            else diagnostic.CapturePrimary(new InvalidOperationException("raw_exception_secret"));
            diagnostic.Checkpoint("composition_completed");
            diagnostic.TargetState("runtime_disposed", true);
            diagnostic.CaptureCleanup(new TimeoutException("private_cleanup_secret"));
            diagnostic.SetReportingFailure("status_reporting_failed", new IOException("private_io_secret"));
            if (detail == "maximum")
            {
                for (int i = 0; i < 16; i++) diagnostic.Checkpoint(new string('a', 61) + i, i % 2 == 0);
                for (int i = 0; i < 8; i++) diagnostic.TargetState(new string('b', 61) + i, null);
                diagnostic.CapturePrimary(new OpenLocally.CdpCommandException(-32000, new string('c', 256), "DOM.getBoxModel"));
            }
            string helper = diagnostic.FormatForDisplay();
            string safeHelper = string.Join(Environment.NewLine, helper.Split(Environment.NewLine)
                .Where(line => !line.StartsWith("Release ID:", StringComparison.Ordinal) && !line.StartsWith("Attempt:", StringComparison.Ordinal)));
            File.WriteAllText(Path.Combine(directory, "helper-report.txt"), helper);
            var result = await RunOffline("-VerifyFullDetailFailure", scenario, "-OfflineReportDirectory", directory);
            Assert.True(result.Exit == 0, $"Exit={result.Exit}\n{result.Output}\n{result.Error}");
            Assert.Equal(string.Empty, result.Error);
            Assert.Contains($"FULL_DETAIL_PASS={scenario};count=1;exit_confirmed=true", result.Output);
            string report = File.ReadAllText(Path.Combine(directory, "presented.txt"));
            string capture = File.ReadAllText(Path.Combine(directory, "capture.txt"));
            var clipboard = new ReportClipboard();
            Assert.True(OpenLocally.NativeFailureDialog.TryCopyReport(report, clipboard));
            Assert.Equal(report, clipboard.Text);
            Assert.Contains(report, capture); // Same semantic report flushed before presentation, even if it throws.
            if (scenario is not "harness_only" and not "missing")
            {
                Assert.Contains(safeHelper, report); // Every non-identity field and sanitized CDP character survives intact.
                Assert.Contains("parent_requested: yes", report);
                Assert.Contains("parent_response_accepted: no", report);
                Assert.Contains("decision: display_failed", report);
            }
            else
            {
                Assert.Contains("Helper diagnostic: unavailable", report);
                Assert.DoesNotContain("Platform:", report);
                Assert.DoesNotContain("Manual preparation:", report);
            }
            if (scenario != "helper_only")
            {
                Assert.Contains("Harness:", report);
                Assert.Contains("Phase: " + (scenario == "harness_only" ? "process_start" : "ready_coordination"), report);
                Assert.Contains("Stable error: " + (scenario == "harness_only" ? "helper_launch_failed" : "manual_validation_failed"), report);
            }
            else Assert.DoesNotContain("Harness:", report);
            if (scenario != "harness_only")
            {
                Assert.Contains("Child started: yes", report);
                Assert.Contains("Child exit confirmed: yes", report);
                Assert.Contains("state=failed;stage=set_thread_desktop;win32_code=170", report);
                Assert.Contains("input_desktop=yes;thread_desktop=no;window_created=no;window_visible=no;normal_dismissal=no", report);
                Assert.Equal("0", File.ReadAllText(Path.Combine(directory, "before-exit-count")));
                if (scenario != "helper_only")
                {
                    string early = File.ReadAllText(Path.Combine(directory, "primary-before-exit"));
                    Assert.Contains("child_exit_confirmed=false", early);
                    Assert.Contains("phase=ready_coordination", early);
                    Assert.DoesNotContain("=== OPERATOR REPORT ===", early);
                }
            }
            else Assert.Contains("Child started: no", report);
            foreach (string secret in new[] { "raw_exception_secret", @"C:\private", "private-image.png", "https://private.invalid", "private_token", "private_vanity", "private_title", "private_body", "private_target", "987654321", "123456789", "87654321", "private_suffix_secret" })
                Assert.DoesNotContain(secret, report);
            Assert.True(report.Length < 12_000, $"Bounded report length: {report.Length}");
            if (scenario == "presenter_failed") Assert.Contains("Parent presentation: state=failed", capture);
        }
        finally { Directory.Delete(directory, recursive: true); }
    }

    public static IEnumerable<object[]> PreflightReports()
    {
        foreach (string platform in new[] { "patreon", "x" })
        {
            yield return new object[] { platform, "gate", false };
            yield return new object[] { platform, "image", false };
            yield return new object[] { platform, "image", true };
        }
        foreach (string input in new[] { "vanity", "image1" })
        {
            yield return new object[] { "patreon", input, false };
            yield return new object[] { "patreon", input, true };
        }
    }

    private static (OpenLocally.CommandDispatchResult Result, string Input) ProducePreflight(string platform, string input, bool invalid)
    {
        string name = (platform, input) switch
        {
            ("x", "gate") => OpenLocally.CommandDispatcher.XLiveValidationEnvironmentVariable,
            ("x", _) => OpenLocally.CommandDispatcher.XLiveImageEnvironmentVariable,
            (_, "gate") => OpenLocally.CommandDispatcher.PatreonLiveValidationEnvironmentVariable,
            (_, "vanity") => OpenLocally.CommandDispatcher.PatreonLiveCreatorVanityEnvironmentVariable,
            (_, "image1") => OpenLocally.CommandDispatcher.PatreonLiveImage1EnvironmentVariable,
            _ => OpenLocally.CommandDispatcher.PatreonLiveImage2EnvironmentVariable,
        };
        var environment = new Dictionary<string, string>
        {
            [OpenLocally.CommandDispatcher.XLiveValidationEnvironmentVariable] = "1",
            [OpenLocally.CommandDispatcher.XLiveImageEnvironmentVariable] = @"C:\PRIVATE_PATH\PRIVATE_FILE.png",
            [OpenLocally.CommandDispatcher.PatreonLiveValidationEnvironmentVariable] = "1",
            [OpenLocally.CommandDispatcher.PatreonLiveCreatorVanityEnvironmentVariable] = "PRIVATE_VANITY",
            [OpenLocally.CommandDispatcher.PatreonLiveImage1EnvironmentVariable] = @"C:\PRIVATE_PATH\PRIVATE_FILE.png",
            [OpenLocally.CommandDispatcher.PatreonLiveImage2EnvironmentVariable] = @"C:\PRIVATE_PATH\PRIVATE_FILE_2.png",
        };
        if (invalid) environment[name] = "../../PRIVATE_VALUE";
        else environment.Remove(name);
        // All runtime/registration delegates fail closed: only real dispatcher preflight may run.
        var dispatcher = new OpenLocally.CommandDispatcher(
            _ => throw new InvalidOperationException("Unexpected open"),
            _ => throw new InvalidOperationException("Unexpected social"),
            _ => throw new InvalidOperationException("Unexpected registration"),
            () => throw new InvalidOperationException("Unexpected registration"),
            _ => throw new InvalidOperationException("Unexpected registration"),
            () => throw new InvalidOperationException("Unexpected registration"),
            runManualXPreparation: (_, _, _) => throw new InvalidOperationException("Unexpected X runtime"),
            getEnvironmentVariable: key => environment.GetValueOrDefault(key),
            fileExists: _ => throw new InvalidOperationException("Unexpected filesystem access"),
            runManualPatreonPreparation: (_, _, _, _) => throw new InvalidOperationException("Unexpected Patreon runtime"));
        return (dispatcher.Dispatch([platform == "x" ? OpenLocally.CommandDispatcher.ValidateXPreparationCommand
            : OpenLocally.CommandDispatcher.ValidatePatreonPreparationCommand]), name);
    }

    [Theory]
    [MemberData(nameof(PreflightReports))]
    public async Task FullDetail_RealPreflightProducerSurvivesParentFallback(string platform, string input, bool invalid)
    {
        var (result, name) = ProducePreflight(platform, input, invalid);
        Assert.False(result.Success);
        Assert.True(result.RequiresManualFailurePresentation);
        string suffix = input switch { "gate" => "opt_in_required", "vanity" => "creator_vanity_" + (invalid ? "invalid" : "required"),
            "image1" => "image_1_" + (invalid ? "invalid" : "required"),
            _ => (platform == "x" ? "image_" : "image_2_") + (invalid ? "invalid" : "required") };
        Assert.Equal("manual_" + platform + "_validation_" + suffix, result.Error);
        string field = (invalid ? "Invalid input: " : "Missing input: ") + name;
        Assert.Equal(string.Join(Environment.NewLine, "Social Preparation failed", "Platform: " + platform,
            "Adapter: " + platform + "_social_preparation", "Phase: manual_preflight", "Stable error: " + result.Error,
            "Outcome: failed", "Error class: validation", "Checkpoints:", "Target/lifecycle:", field), result.Detail);
        await AssertPreflightFallback(result.Detail!, accepted: true);
    }

    [Theory]
    [InlineData("empty")]
    [InlineData("unknown")]
    [InlineData("private")]
    [InlineData("path")]
    [InlineData("filename")]
    [InlineData("url")]
    [InlineData("environment")]
    [InlineData("suffix")]
    [InlineData("duplicate")]
    [InlineData("both")]
    [InlineData("middle")]
    [InlineData("trailing")]
    [InlineData("before")]
    [InlineData("multiple")]
    [InlineData("case")]
    [InlineData("invalid_private")]
    public async Task FullDetail_MalformedPreflightRejectsWholeProducerReport(string mutation)
    {
        var (result, name) = ProducePreflight("patreon", "image", false);
        string candidate = result.Detail!;
        string nl = Environment.NewLine;
        string field = "Missing input: " + name;
        candidate = mutation switch
        {
            "empty" => candidate.Replace(field, "Missing input:"),
            "unknown" => candidate.Replace(name, "CREATORCRATE_FAKE_UNKNOWN_INPUT"),
            "private" => candidate.Replace(name, "PRIVATE_VALUE"),
            "path" => candidate.Replace(name, "../../secret"),
            "filename" => candidate.Replace(name, "PRIVATE_FILE.png"),
            "url" => candidate.Replace(name, "https://private.invalid"),
            "environment" => candidate.Replace(name, "PATH"),
            "suffix" => candidate + " PRIVATE_SUFFIX",
            "duplicate" => candidate + nl + field,
            "both" => candidate + nl + "Invalid input: " + name,
            "middle" => candidate.Replace(nl + field, "").Replace("Checkpoints:", field + nl + "Checkpoints:"),
            "trailing" => candidate + nl + "PRIVATE_TRAILING",
            "before" => "PRIVATE_STDERR" + nl + candidate,
            "multiple" => candidate + nl + candidate,
            "case" => candidate.Replace(name, name.ToLowerInvariant()),
            "invalid_private" => candidate.Replace(field, "Invalid input: ../../secret"),
            _ => throw new InvalidOperationException(mutation),
        };
        await AssertPreflightFallback(candidate, accepted: false);
    }

    private static async Task AssertPreflightFallback(string candidate, bool accepted)
    {
        string directory = Path.Combine(Path.GetTempPath(), "CreatorCrate-preflight-grammar-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(directory);
        try
        {
            File.WriteAllText(Path.Combine(directory, "helper-report.txt"), candidate);
            var result = await RunOffline("-VerifyFullDetailFailure", "helper_only", "-OfflineReportDirectory", directory);
            Assert.True(result.Exit == 0, result.Output + result.Error);
            Assert.Equal(string.Empty, result.Error);
            Assert.Contains("FULL_DETAIL_PASS=helper_only;count=1;exit_confirmed=true", result.Output);
            string report = File.ReadAllText(Path.Combine(directory, "presented.txt"));
            if (accepted)
            {
                Assert.StartsWith(candidate + Environment.NewLine, report);
                Assert.DoesNotContain("manual_helper_failed", report);
                Assert.DoesNotContain("Helper diagnostic: unavailable", report);
            }
            else
            {
                Assert.Contains("Helper diagnostic: unavailable", report);
                Assert.Contains("Stable error: manual_helper_failed", report);
                foreach (string prefix in new[] { "manual_patreon_validation", "Phase: manual_preflight", "Missing input:", "Invalid input:", "Checkpoints:" })
                    Assert.DoesNotContain(prefix, report);
            }
            Assert.Contains("Child exit confirmed: yes", report);
            Assert.Equal("0", File.ReadAllText(Path.Combine(directory, "before-exit-count")));
            Assert.Contains(report, File.ReadAllText(Path.Combine(directory, "capture.txt")));
            var clipboard = new ReportClipboard();
            Assert.True(OpenLocally.NativeFailureDialog.TryCopyReport(report, clipboard));
            Assert.Equal(report, clipboard.Text);
            foreach (string secret in new[] { "PRIVATE", "../../secret", "https://private.invalid", "CREATORCRATE_FAKE_UNKNOWN_INPUT" })
                Assert.DoesNotContain(secret, report);
            Assert.True(report.Length < 12_000);
        }
        finally { Directory.Delete(directory, recursive: true); }
    }
    private sealed class FailedConsent : OpenLocally.IChromeConnectionConsent
    {
        public OpenLocally.ChromeConnectionConsentDecision ConfirmReady() => OpenLocally.ChromeConnectionConsentDecision.DisplayFailed;
        public OpenLocally.ChromeConnectionConsentDecision ConfirmRetry(string code) => OpenLocally.ChromeConnectionConsentDecision.Cancel;
    }

    public static IEnumerable<object[]> RejectedCandidates()
    {
        foreach (string value in new[] {
            "description=PRIVATE_DESCRIPTION", "target_id=PRIVATE_TARGET", "targetId: PRIVATE_TARGET",
            "session_id=PRIVATE_SESSION", "sessionId: PRIVATE_SESSION", "secret=PRIVATE_SECRET",
            "bearer PRIVATE_BEARER", "bearer: PRIVATE_BEARER", "token: PRIVATE_TOKEN",
            "cookie: PRIVATE_COOKIE", "authorization: PRIVATE_AUTH", "AUTH: PRIVATE_AUTH",
            "csrf: PRIVATE_CSRF", "access-token: PRIVATE_TOKEN", "capability: PRIVATE_CAPABILITY",
            "intent: PRIVATE_INTENT", "backend_node_id: PRIVATE_NODE", "nodeId: PRIVATE_NODE",
            "creator-vanity: PRIVATE_CREATOR", "vanity: PRIVATE_VANITY", "title: PRIVATE_TITLE",
            "body: PRIVATE_BODY", "notes: PRIVATE_NOTES", "frame id PRIVATE_FRAME", "object id PRIVATE_OBJECT",
            "target id PRIVATE_TARGET", "session id PRIVATE_SESSION", "backend node id PRIVATE_NODE",
            "DESCRIPTION: PRIVATE_DESCRIPTION", "https://private.invalid", @"C:\private\file",
            @"\\private\file", "/private/file", "<div>PRIVATE_HTML</div>", "PRIVATE\tCONTROL" })
            yield return new object[] { "cdp", value };
        foreach (string kind in new[] { "unknown", "manual", "create", "cdp_field", "checkpoint", "lifecycle",
            "truncated", "duplicate", "enum", "nested", "before", "after", "multiple", "second_bad",
            "raw", "oversized", "manual_missing", "create_missing", "cleanup", "reporting", "cdp_missing", "create_duplicate", "manual_misplaced", "checkpoint_duplicate", "line_bound", "code_overflow", "partial_missing" })
            yield return new object[] { kind, "PRIVATE_SENTINEL" };
    }

    [Theory]
    [MemberData(nameof(RejectedCandidates))]
    public async Task FullDetail_RejectsWholeUntrustedCandidateAtActualPresenter(string kind, string value)
    {
        var diagnostic = new OpenLocally.SocialPreparationDiagnostic("patreon", "manual_preparation", "helper_specific_failure");
        diagnostic.SetManualPreparation(new OpenLocally.ManualPreparationEvidence());
        diagnostic.SetCreateResolution(new OpenLocally.PatreonCreateResolutionEvidence());
        diagnostic.CapturePrimary(new OpenLocally.CdpCommandException(-32000, "Node does not have a layout object", "DOM.getBoxModel"));
        diagnostic.Checkpoint("early_evidence");
        diagnostic.TargetState("later_evidence", true);
        diagnostic.CaptureCleanup(new TimeoutException());
        diagnostic.SetReportingFailure("status_reporting_failed");
        string candidate = diagnostic.FormatForDisplay();
        string nl = Environment.NewLine;
        candidate = kind switch
        {
            "cdp" => candidate.Replace("Node does not have a layout object", value),
            "unknown" => candidate.Replace("Target/lifecycle:", "PRIVATE_SENTINEL" + nl + "Target/lifecycle:"),
            "manual" => candidate.Replace("    state: not_started", "    state: PRIVATE_SENTINEL"),
            "create" => candidate.Replace("  candidate_limit: 16", "  candidate_limit: 17"),
            "cdp_field" => candidate.Replace("CDP code: -32000", "CDP code: PRIVATE_SENTINEL"),
            "checkpoint" => candidate.Replace("early_evidence: yes", "early_evidence: PRIVATE_SENTINEL"),
            "lifecycle" => candidate.Replace("later_evidence: yes", "later_evidence: PRIVATE_SENTINEL"),
            "truncated" => candidate[..candidate.IndexOf("Target/lifecycle:", StringComparison.Ordinal)],
            "duplicate" => candidate.Replace("Outcome: failed", "Outcome: failed" + nl + "Outcome: failed"),
            "enum" => candidate.Replace("Error class: cdp_command", "Error class: PRIVATE_SENTINEL"),
            "nested" => candidate.Replace("    decision: unknown", "    description: PRIVATE_SENTINEL"),
            "before" => "PRIVATE_SENTINEL" + nl + candidate,
            "after" => candidate + nl + "PRIVATE_SENTINEL",
            "multiple" => candidate + nl + candidate,
            "second_bad" => candidate + nl + "Social Preparation failed" + nl + "PRIVATE_SENTINEL",
            "raw" => @"PRIVATE_SENTINEL at Stack.Method() C:\private\file https://private.invalid token=secret bearer cookie target_id session_id",
            "oversized" => candidate.Replace("Node does not have a layout object", new string('a', 257)),
            "manual_missing" => candidate.Replace("    decision: unknown" + nl, ""),
            "create_missing" => candidate.Replace("  outcome: unknown" + nl, ""),
            "cleanup" => candidate.Replace("  Error class: timeout", "  Error class: PRIVATE_SENTINEL"),
            "reporting" => candidate.Replace("  Stable error: status_reporting_failed", "  token: PRIVATE_SENTINEL"),
            "create_duplicate" => candidate.Replace("  candidate_limit: 16", "  candidate_limit: 16" + nl + "  candidate_limit: 16"),
            "manual_misplaced" => candidate.Replace("    decision: unknown", "    result: unknown"),
            "checkpoint_duplicate" => candidate.Replace("  early_evidence: yes", "  early_evidence: yes" + nl + "  early_evidence: yes"),
            "line_bound" => candidate + string.Concat(Enumerable.Repeat(nl + "  extra: yes", 129)),
            "code_overflow" => candidate.Replace("CDP code: -32000", "CDP code: 9999999999"),
            "partial_missing" => candidate.Replace("  Counts are partial; candidate-set inspection is incomplete." + nl, ""),
            "cdp_missing" => candidate.Replace("CDP code: -32000" + nl, ""),
            _ => throw new InvalidOperationException(kind),
        };
        string directory = Path.Combine(Path.GetTempPath(), "CreatorCrate-parser-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(directory);
        try
        {
            File.WriteAllText(Path.Combine(directory, "helper-report.txt"), candidate);
            var result = await RunOffline("-VerifyFullDetailFailure", "combined", "-OfflineReportDirectory", directory);
            Assert.True(result.Exit == 0, result.Output + result.Error);
            Assert.Equal(string.Empty, result.Error);
            Assert.Contains("FULL_DETAIL_PASS=combined;count=1;exit_confirmed=true", result.Output);
            string report = File.ReadAllText(Path.Combine(directory, "presented.txt"));
            Assert.Contains("Helper diagnostic: unavailable", report);
            Assert.Contains("Harness:", report);
            Assert.Contains("Stable error: manual_validation_failed", report);
            Assert.Contains("Child exit confirmed: yes", report);
            foreach (string rejected in new[] { "PRIVATE", "helper_specific_failure", "early_evidence", "later_evidence", "Manual preparation:", "CDP message:", "Create resolution:" })
                Assert.DoesNotContain(rejected, report);
            Assert.Contains(report, File.ReadAllText(Path.Combine(directory, "capture.txt")));
            var clipboard = new ReportClipboard();
            Assert.True(OpenLocally.NativeFailureDialog.TryCopyReport(report, clipboard));
            Assert.Equal(report, clipboard.Text);
            Assert.Equal("0", File.ReadAllText(Path.Combine(directory, "before-exit-count")));
        }
        finally { Directory.Delete(directory, recursive: true); }
    }

    private sealed class ReportClipboard : OpenLocally.NativeFailureDialog.IFailureReportClipboard
    {
        public string? Text { get; private set; }
        public bool TrySetText(string text) { Text = text; return true; }
    }

    [Theory]
    [InlineData("comparison", false, 17)]
    [InlineData("comparison", true, 17)]
    [InlineData("no_result", false, 1)]
    public async Task ManualHarness_PostHelperFailureIsDurableBeforeCleanupAndMatchesProcessExit(
        string scenario, bool cleanupFails, int expectedExit)
    {
        string directory = Path.Combine(Path.GetTempPath(), "CreatorCrate-reporting-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(directory);
        string capture = Path.Combine(directory, "capture.txt");
        try
        {
            var arguments = new List<string> { "-VerifyManualFailureFullFlow", "-OfflinePostHelperFailure", scenario, "-CapturePath", capture };
            if (cleanupFails) arguments.Add("-OfflineCleanupFails");
            var result = await RunOffline(arguments.ToArray());
            Assert.True(result.Exit == expectedExit, $"Exit={result.Exit}\n{result.Output}\n{result.Error}");
            Assert.Equal(string.Empty, result.Error);
            string atCleanup = File.ReadAllText(capture + ".cleanup-entry");
            string final = File.ReadAllText(capture);
            string phase = scenario == "comparison" ? "result_coordination" : "process_start";
            string stableError = scenario == "comparison" ? "manual_validation_failed" : "helper_launch_failed";
            foreach (string artifact in new[] { atCleanup, final })
            {
                Assert.Equal(1, artifact.Split("=== HARNESS FAILURE ===").Length - 1);
                Assert.Contains($"phase={phase}", artifact);
                Assert.Contains($"stable_error={stableError}", artifact);
                Assert.Contains("outcome=failed", artifact);
                foreach (string secret in new[] { "private_context", "token=SECRET", "https://private.example", @"C:\private\secret.png" })
                    Assert.DoesNotContain(secret, artifact);
            }
            Assert.DoesNotContain("manual_cleanup_recovery_failed", atCleanup);
            Assert.Equal(cleanupFails, final.Contains("Harness supplemental: phase=cleanup; stable_error=manual_cleanup_recovery_failed; error_class=cleanup"));
            Assert.Equal(cleanupFails ? 1 : 0, final.Split("manual_cleanup_recovery_failed").Length - 1);
            string footer = final[(final.LastIndexOf("=== EXIT ===", StringComparison.Ordinal))..];
            Assert.Contains($"harness_exit_code={result.Exit}", footer);
            Assert.Contains("helper_exit_code=" + (scenario == "comparison" ? "17" : "unavailable"), footer);
            if (scenario == "comparison")
            {
                Assert.Contains("offline-stdout", final);
                Assert.Contains("offline-stderr", final);
                Assert.Contains("error_class=harness", atCleanup);
                Assert.Contains("detail=Manual validation harness operation failed.", atCleanup);
            }
            Assert.Contains("OFFLINE_OUTER_CLEANUP_REACHED=1", result.Output);
        }
        finally { Directory.Delete(directory, recursive: true); }
    }

    [Theory]
    [InlineData(23, 1, "False")]
    [InlineData(0, 0, "True")]
    public async Task ManualHarness_PublicationRequiresNativeSuccessEvenWhenExecutableExists(int publishExit, int expectedExit, string continued)
    {
        var result = await RunOffline("-VerifyPublicationContract", "-VerifyPublicationExit", publishExit.ToString());
        Assert.True(result.Exit == expectedExit, result.Output + result.Error);
        Assert.Equal(string.Empty, result.Error);
        Assert.Contains($"PUBLICATION_PASS={publishExit};existing_exe=true;helper_launched=false;ready=false;browser=false;continued={continued}", result.Output);
    }

    [Theory]
    [InlineData("native_apphost_preflight", 1)]
    [InlineData("process_start_info", 1)]
    [InlineData("ready_setup", 1)]
    [InlineData("launch_context", 1)]
    [InlineData("process_setup", 1)]
    [InlineData("start_throw", 1)]
    [InlineData("start_false", 1)]
    [InlineData("stream_setup", 17)]
    [InlineData("stderr_reader", 17)]
    [InlineData("ready_coordination", 17)]
    [InlineData("ready_member", 17)]
    [InlineData("ready_presented", 17)]
    [InlineData("ready_failed", 17)]
    [InlineData("ready_malformed", 17)]
    [InlineData("child_wait", 17)]
    [InlineData("output_collection", 17)]
    [InlineData("result_coordination", 17)]
    [InlineData("presenter_throw", 1)]
    [InlineData("presenter_bootstrap", 1)]
    [InlineData("presentation_interlock", 1)]
    [InlineData("presenter_failed", 1)]
    [InlineData("cleanup_secondary", 1)]
    [InlineData("finalization_secondary", 1)]
    [InlineData("capture_finalization", 17)]
    [InlineData("cleanup", 17)]
    public async Task ManualHarness_PostCaptureFailureIsDurableBeforePresentationAndRetainsChild(string scenario, int expectedExit)
    {
        var result = await RunOffline("-VerifyDurableHarnessFailure", scenario);
        Assert.True(result.Exit == expectedExit, result.Output + result.Error);
        Assert.Equal(string.Empty, result.Error);
        Assert.Contains($"DURABLE_PASS={scenario};", result.Output);
        Assert.Contains("privacy=pass", result.Output);
    }

    private static async Task<(int Exit, string Output, string Error)> RunOffline(params string[] arguments)
    {
        string root = PublishedProductionGateProcessTests.FindRepositoryRoot();
        var start = new ProcessStartInfo(Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.System), "WindowsPowerShell", "v1.0", "powershell.exe"))
        {
            WorkingDirectory = root, UseShellExecute = false, CreateNoWindow = true,
            RedirectStandardOutput = true, RedirectStandardError = true,
        };
        foreach (string argument in new[] { "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File",
            Path.Combine(root, "helper/windows/tests/OpenLocally.Tests/Manual/run-m2-foundation.ps1"), "-RepositoryRoot", root }.Concat(arguments))
            start.ArgumentList.Add(argument);
        foreach (string key in start.Environment.Keys.Where(key => key.StartsWith("CREATORCRATE_", StringComparison.OrdinalIgnoreCase)).ToArray()) start.Environment.Remove(key);
        using Process process = Process.Start(start)!;
        Task<string> stdout = process.StandardOutput.ReadToEndAsync();
        Task<string> stderr = process.StandardError.ReadToEndAsync();
        using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(40));
        try { await process.WaitForExitAsync(timeout.Token); }
        finally { if (!process.HasExited) { process.Kill(true); await process.WaitForExitAsync(); } }
        return (process.ExitCode, await stdout, await stderr);
    }

    [Theory]
    [InlineData("capture_confirmed", 17, 0)]
    [InlineData("capture_failed", 17, 1)]
    [InlineData("timeout_confirmed", 17, 0)]
    [InlineData("timeout_failed", 17, 1)]
    [InlineData("timeout_killed", -1, 1)]
    [InlineData("late_failed", 17, 1)]
    [InlineData("late_confirmed", 17, 0)]
    [InlineData("late_missing", 17, 1)]
    [InlineData("late_malformed", 17, 1)]
    [InlineData("late_capture_failed", 17, 1)]
    public async Task ManualHarness_RealChildRetainsResultAcrossCaptureAndTimeout(
        string scenario, int expectedExit, int fallbacks)
    {
        string root = PublishedProductionGateProcessTests.FindRepositoryRoot();
        var start = new ProcessStartInfo(Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.System),
            "WindowsPowerShell", "v1.0", "powershell.exe"))
        {
            WorkingDirectory = root, UseShellExecute = false, CreateNoWindow = true,
            RedirectStandardOutput = true, RedirectStandardError = true,
        };
        foreach (string argument in new[] { "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File",
            Path.Combine(root, "helper/windows/tests/OpenLocally.Tests/Manual/run-m2-foundation.ps1"),
            "-RepositoryRoot", root, "-VerifyManualCoordinationDefects", scenario }) start.ArgumentList.Add(argument);
        foreach (string key in start.Environment.Keys.Where(key => key.StartsWith("CREATORCRATE_", StringComparison.OrdinalIgnoreCase)).ToArray()) start.Environment.Remove(key);
        using Process process = Process.Start(start)!;
        Task<string> stdout = process.StandardOutput.ReadToEndAsync();
        Task<string> stderr = process.StandardError.ReadToEndAsync();
        using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(40));
        try { await process.WaitForExitAsync(timeout.Token); }
        finally { if (!process.HasExited) { process.Kill(true); await process.WaitForExitAsync(); } }
        string output = await stdout;
        string errors = await stderr;
        Assert.True(process.ExitCode == expectedExit, $"Exit={process.ExitCode}\n{output}\n{errors}");
        Assert.Equal(string.Empty, errors);
        if (scenario.StartsWith("timeout_", StringComparison.Ordinal) || scenario.StartsWith("late_", StringComparison.Ordinal))
            Assert.Contains("COORDINATION_WHILE_ALIVE_FALLBACKS=0", output);
        if (scenario.StartsWith("late_", StringComparison.Ordinal))
        {
            Assert.Contains("COORDINATION_AFTER_GRACE=alive:true;active:true;returned:false;fallbacks:0;drains:live", output);
            Assert.Contains("COORDINATION_EXTENDED_WAIT_REENTERED=1;returned:false;fallbacks:0", output);
            Assert.Contains("COORDINATION_COMPLETE_OUTPUT=", output);
            Assert.Contains("burst_per_stream:131072", output);
        }
        Assert.Contains($"COORDINATION_PASS={scenario};fallbacks={fallbacks};helper_exit={expectedExit}", output);
    }

    [Theory]
    [InlineData(17, false, false, 17)]
    [InlineData(17, false, true, 17)]
    [InlineData(17, true, true, 17)]
    [InlineData(0, false, true, 1)]
    public async Task ManualHarness_FullScriptPreservesRealProcessExit(
        int helperExitCode, bool presentationFails, bool cleanupFails, int expectedExitCode)
    {
        string root = PublishedProductionGateProcessTests.FindRepositoryRoot();
        // Windows PowerShell, deliberately not pwsh: finally/exit semantics matter.
        var start = new ProcessStartInfo(Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.System),
            "WindowsPowerShell", "v1.0", "powershell.exe"))
        {
            WorkingDirectory = root,
            UseShellExecute = false,
            CreateNoWindow = true,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
        };
        foreach (string argument in new[]
        {
            "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File",
            Path.Combine(root, "helper", "windows", "tests", "OpenLocally.Tests", "Manual", "run-m2-foundation.ps1"),
            "-RepositoryRoot", root, "-VerifyManualFailureFullFlow",
            "-OfflineHelperExitCode", helperExitCode.ToString(System.Globalization.CultureInfo.InvariantCulture),
        }) start.ArgumentList.Add(argument);
        if (presentationFails) start.ArgumentList.Add("-OfflinePresentationFails");
        if (cleanupFails) start.ArgumentList.Add("-OfflineCleanupFails");
        // The test needs neither manual opt-in nor inherited private inputs.
        foreach (string key in start.Environment.Keys.Where(key =>
            key.StartsWith("CREATORCRATE_", StringComparison.OrdinalIgnoreCase)).ToArray())
            start.Environment.Remove(key);

        using Process process = Process.Start(start) ?? throw new InvalidOperationException("Could not start Windows PowerShell.");
        Task<string> stdout = process.StandardOutput.ReadToEndAsync();
        Task<string> stderr = process.StandardError.ReadToEndAsync();
        using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(30));
        try { await process.WaitForExitAsync(timeout.Token); }
        finally
        {
            if (!process.HasExited)
            {
                process.Kill(entireProcessTree: true);
                await process.WaitForExitAsync();
            }
        }
        string output = await stdout;
        string errors = await stderr;
        Assert.Equal(expectedExitCode, process.ExitCode);
        if (helperExitCode == 17) Assert.NotEqual(1, process.ExitCode);
        string[] lines = output.Split(['\r', '\n'], StringSplitOptions.RemoveEmptyEntries);
        Assert.Equal(helperExitCode != 0 && presentationFails ? 2 : 1,
            lines.Count(line => line.StartsWith("OFFLINE_NATIVE_PRESENTATION_ATTEMPT=", StringComparison.Ordinal)));
        Assert.Contains("OFFLINE_NATIVE_PRESENTATION_ATTEMPT=" + (helperExitCode == 0 ? "cleanup_recovery" : "helper"), lines);
        Assert.Contains("OFFLINE_OUTER_CLEANUP_REACHED=1", lines);
        Assert.Equal(presentationFails, lines.Contains("OFFLINE_HELPER_PRESENTATION_FAILED=1"));
        Assert.Equal(cleanupFails && helperExitCode != 0, output.Contains("secondary evidence after an authoritative helper failure"));
        if (expectedExitCode == 17) Assert.Equal(string.Empty, errors);
    }

    [Fact]
    public async Task ManualHarness_ActualPublishedChildTraversesReporterAndFallbackCoordination()
    {
        string root = PublishedProductionGateProcessTests.FindRepositoryRoot();
        var start = new ProcessStartInfo(Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.System), "WindowsPowerShell", "v1.0", "powershell.exe"))
        {
            WorkingDirectory = root, UseShellExecute = false, CreateNoWindow = true,
            RedirectStandardOutput = true, RedirectStandardError = true,
        };
        foreach (string argument in new[] { "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File",
            Path.Combine(root, "helper/windows/tests/OpenLocally.Tests/Manual/run-m2-foundation.ps1"),
            "-RepositoryRoot", root, "-VerifyPublishedManualPresentation" }) start.ArgumentList.Add(argument);
        foreach (string key in start.Environment.Keys.Where(key => key.StartsWith("CREATORCRATE_", StringComparison.OrdinalIgnoreCase)).ToArray()) start.Environment.Remove(key);
        using Process process = Process.Start(start)!;
        Task<string> stdout = process.StandardOutput.ReadToEndAsync();
        Task<string> stderr = process.StandardError.ReadToEndAsync();
        using var timeout = new CancellationTokenSource(TimeSpan.FromMinutes(4));
        try { await process.WaitForExitAsync(timeout.Token); }
        finally { if (!process.HasExited) { process.Kill(true); await process.WaitForExitAsync(); } }
        string output = await stdout;
        string errors = await stderr;
        Assert.True(process.ExitCode == 0, output + errors);
        foreach (string scenario in new[] { "presented", "failed", "missing", "malformed", "both_failed" })
            Assert.Contains($"PUBLISHED_OFFLINE_PASS={scenario};fallbacks={(scenario == "presented" ? 0 : 1)};helper_exit=1", output);
    }

    [Fact]
    public void ManualHarness_UsesTheSharedNativeDialogForOfflineAndPreHelperFailures()
    {
        string root = PublishedProductionGateProcessTests.FindRepositoryRoot();
        string script = File.ReadAllText(Path.Combine(root, "helper", "windows", "tests", "OpenLocally.Tests", "Manual", "run-m2-foundation.ps1"));

        Assert.Contains("[switch]$VerifyManualFailureDialog", script);
        Assert.Contains("Add-Type -Path @((Join-Path $RepositoryRoot 'helper\\windows\\src\\OpenLocally\\NativeFailureDialog.cs'), (Join-Path $RepositoryRoot 'helper\\windows\\src\\OpenLocally\\NativeOperatorUiHost.cs'))", script);
        Assert.Contains("[OpenLocally.NativeFailureDialog]::Show($summary, $Report)", script);
        foreach (string stableError in new[] { "required_manual_input_missing", "manual_capture_setup_failed", "helper_launch_failed", "helper_publication_failed" })
            Assert.Contains(stableError, script);
        Assert.Contains("-ManualPlatform 'patreon' -RepositoryRoot $RepositoryRoot", script);
        Assert.Contains("[switch]$VerifyManualFailureRouting", script);
        Assert.Contains("function Invoke-ManualFailureDialogBoundary", script);
        Assert.Contains("trap {", script);
        Assert.Contains("function Get-ManualFailureSafeDetail", script);
        Assert.Contains("function Set-ManualAuthoritativeHelperFailure", script);
        Assert.Contains("function Complete-ManualCleanupOutcome", script);
        Assert.Contains("$script:ManualFailureDialogAttempted = $true", script);
        Assert.Contains("$script:ManualAuthoritativeExitCode = $HelperExitCode", script);
        Assert.Contains("exit $script:ManualAuthoritativeExitCode", script);
        Assert.Contains("secondary evidence after an authoritative helper failure", script);
        foreach (string safeDetail in new[]
        {
            "Capture destination could not be created.",
            "Helper process could not be started.",
            "Parent production-gate preflight timed out.",
            "Cleanup or recovery step failed.",
        })
        {
            Assert.Contains(safeDetail, script);
        }
    }
}
