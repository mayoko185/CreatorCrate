using System.Reflection;
using System.Runtime.InteropServices;
using OpenLocally;

namespace OpenLocally.Tests;

/// <summary>
/// Coverage for <see cref="FailureReporter"/>'s channel selection: the GUI
/// subsystem has no console, so failures must go to stderr when a console or
/// redirect exists and to a message box only when no standard-error handle is
/// available (normal protocol activation). The decision is exposed through
/// the internal <see cref="FailureReporter.IsStderrAvailable"/> probe so it
/// can be tested without showing UI or writing to real handles.
/// </summary>
public class FailureReporterTests
{
    [Theory]
    [InlineData(-1, true, false)]
    [InlineData(0, false, false)]
    [InlineData(0, true, true)]
    [InlineData(1, true, false)]
    public void NativeFailureDialog_GetMessageErrorAndUnrequestedQuitAreNotNormalDismissal(int status, bool dismissed, bool expected)
    {
        Assert.Equal(expected, NativeFailureDialog.IsNormalMessageLoopExit(status, dismissed));
    }

    [Theory]
    [InlineData(NativePresentationStage.open_input_desktop)]
    [InlineData(NativePresentationStage.set_thread_desktop)]
    [InlineData(NativePresentationStage.register_window_class)]
    [InlineData(NativePresentationStage.create_main_window)]
    [InlineData(NativePresentationStage.create_report_control)]
    [InlineData(NativePresentationStage.create_copy_button)]
    [InlineData(NativePresentationStage.create_close_button)]
    [InlineData(NativePresentationStage.visibility_check)]
    [InlineData(NativePresentationStage.message_loop)]
    public void NativeFailureDialog_RequiredStageFailureIsNotConfirmation(NativePresentationStage stage)
    {
        var native = new FakePresentationNative(stage);
        NativePresentationResult result = NativeFailureDialog.ShowWithNative(native);
        Assert.Equal(NativePresentationState.Failed, result.State);
        Assert.Equal(stage, result.Stage);
        Assert.Equal(stage == NativePresentationStage.visibility_check ? 0 : 5, result.Win32Code);
        Assert.False(result.NormalDismissal);
        Assert.True(native.Disposed);
        Assert.Equal(stage, native.Stages.Last());
        Assert.Equal(stage != NativePresentationStage.open_input_desktop, result.InputDesktopOpened);
        Assert.Contains("state=failed;stage=" + stage, result.ToMarker());
    }

    [Fact]
    public void NativeFailureDialog_OnlyCompletedPresentationConfirmsAllFlags()
    {
        var native = new FakePresentationNative(null);
        NativePresentationResult result = NativeFailureDialog.ShowWithNative(native);
        Assert.Equal(NativePresentationState.PresentedAndDismissed, result.State);
        Assert.Equal(NativePresentationStage.completed, result.Stage);
        Assert.True(result.InputDesktopOpened && result.ThreadDesktopSelected && result.WindowCreated && result.WindowVisible && result.NormalDismissal);
        Assert.Equal(NativePresentationStage.message_loop, native.Stages.Last());
        Assert.True(native.Disposed);
    }

    [Fact]
    public void NativeFailureDialog_ExceptionOnDialogThreadIsSafeFailure()
    {
        var native = new FakePresentationNative(null) { Throw = true };
        NativePresentationResult result = NativeFailureDialog.ShowWithNative(native);
        Assert.Equal(NativePresentationState.Failed, result.State);
        Assert.Equal(NativePresentationStage.unexpected, result.Stage);
        Assert.DoesNotContain("PRIVATE", result.ToMarker());
        Assert.True(native.Disposed);
        Assert.NotEqual(Environment.CurrentManagedThreadId, native.ThreadId);
    }

    [Theory]
    [InlineData(false, false)]
    [InlineData(false, true)]
    [InlineData(true, false)]
    [InlineData(true, true)]
    public void ManualReporter_EmitsOutcomeWithoutChangingPrimaryReport(bool presented, bool stderrFails)
    {
        const string report = "Platform: patreon\nPhase: manual_preflight\nStable error: manual_patreon_validation_command_invalid\nUnicode ✓; full report";
        var stderr = new StringWriter();
        var native = new FakePresentationNative(presented ? null : NativePresentationStage.create_main_window);
        string? marker = null;
        int calls = 0;
        int exit = FailureReporter.ReportManualSocialFailure("primary_failure", report,
            () => stderrFails ? new ThrowingWriter() : stderr,
            (_, actual) => { calls++; Assert.Equal(report, actual); return NativeFailureDialog.ShowWithNative(native); },
            value => marker = value);
        Assert.Equal(1, exit);
        Assert.Equal(1, calls);
        if (!stderrFails) Assert.Equal("primary_failure" + Environment.NewLine + report + Environment.NewLine, stderr.ToString());
        Assert.Matches("^CREATORCRATE_MANUAL_PRESENTATION;state=(presented|failed);stage=[a-z_]+;win32_code=[0-9]+;session_id=[0-9]+;input_desktop=(yes|no);thread_desktop=(yes|no);window_created=(yes|no);window_visible=(yes|no);normal_dismissal=(yes|no)$", marker!);
        Assert.Contains(presented ? "state=presented;stage=completed;win32_code=0" : "state=failed;stage=create_main_window;win32_code=5", marker);
        Assert.DoesNotContain("Unicode", marker);
    }

    [Fact]
    public void ManualReporter_MarkerWriteFailureCannotReplacePrimaryFailure()
    {
        Assert.Equal(1, FailureReporter.ReportManualSocialFailure("primary", null, () => null,
            (_, _) => new NativePresentationResult(), _ => throw new IOException("PRIVATE")));
    }

    private sealed class FakePresentationNative(NativePresentationStage? failAt) : NativeFailureDialog.PresentationNative
    {
        public List<NativePresentationStage> Stages { get; } = [];
        public bool Disposed { get; private set; }
        public bool Throw { get; init; }
        public int ThreadId { get; private set; }
        public override int LastError => 5;
        public override bool Execute(NativePresentationStage stage, NativePresentationResult result)
        {
            ThreadId = Environment.CurrentManagedThreadId;
            Stages.Add(stage);
            if (Throw) throw new InvalidOperationException("PRIVATE path token URL");
            return stage != failAt;
        }
        public override void Dispose() => Disposed = true;
    }

    [Theory]
    [InlineData("x")]
    [InlineData("bluesky")]
    [InlineData("patreon")]
    public void ReportManualSocialFailure_AlwaysPassesTheCompletePlatformDiagnosticToTheNativeBoundary(string platform)
    {
        var diagnostic = new SocialPreparationDiagnostic(platform, "create_activation", "platform_preparation_failed");
        diagnostic.Checkpoint("creator_page_ready");
        diagnostic.Checkpoint("create_activated", false);
        diagnostic.TargetState("owned_target_created", true);
        diagnostic.CapturePrimary(new CdpCommandException(-32000, "Node does not have a layout object", "DOM.scrollIntoViewIfNeeded"));
        diagnostic.CaptureCleanup(new CdpTransportException(CdpTransportFailure.Disconnected));
        string expected = diagnostic.FormatForDisplay();
        string? summary = null;
        string? presented = null;

        int exit = FailureReporter.ReportManualSocialFailure("platform_preparation_failed", expected,
            () => new StringWriter(), (actualSummary, report) => { summary = actualSummary; presented = report; return new NativePresentationResult(); });

        Assert.Equal(1, exit);
        Assert.Equal(expected, presented);
        Assert.Equal("CreatorCrate Social Preparation Failed", NativeFailureDialog.Title);
        Assert.Contains($"{char.ToUpperInvariant(platform[0])}{platform[1..]} preparation failed during create activation.", summary);
        foreach (string required in new[] { "CDP operation: scroll_into_view", "CDP code: -32000", "Node does not have a layout object", "creator_page_ready: yes", "owned_target_created: yes", "Cleanup:" })
            Assert.Contains(required, presented);
    }

    [Theory]
    [InlineData("manual_preflight", "required_manual_input_missing", "validation", "Missing input: CREATORCRATE_PATREON_LIVE_IMAGE_2")]
    [InlineData("capture_preflight", "manual_capture_setup_failed", "io", "Capture: unavailable")]
    [InlineData("helper_launch", "helper_launch_failed", "process_start", "Helper exit code: unavailable")]
    public void ReportManualSocialFailure_PresentsCompleteSafeHarnessReports(string phase, string stableError, string errorClass, string extra)
    {
        string report = $"Platform: patreon\nPhase: {phase}\nStable error: {stableError}\nOutcome: failed\nError class: {errorClass}\n{extra}";
        string? presented = null;

        int exit = FailureReporter.ReportManualSocialFailure(stableError, report,
            () => new StringWriter(), (_, value) => { presented = value; return new NativePresentationResult(); });

        Assert.Equal(1, exit);
        Assert.Equal(report, presented);
        Assert.DoesNotContain("private-value", presented);
    }

    [Fact]
    public void ReportManualSocialFailure_DoesNotTruncateLongUnicodeMultilineOrSemicolonReport()
    {
        string report = "Platform: patreon\nPhase: create_activation\nStable error: platform_preparation_failed\nOutcome: failed\nError class: cdp_command\nCDP message: Unicode ✓; one; two\n" + new string('x', SocialPreparationDiagnostic.MaximumSerializedLength);
        string? presented = null;

        FailureReporter.ReportManualSocialFailure("platform_preparation_failed", report,
            () => new StringWriter(), (_, value) => { presented = value; return new NativePresentationResult(); });

        Assert.Equal(report, presented);
        Assert.Contains("Unicode ✓; one; two", presented);
        Assert.Equal(report.Length, presented!.Length);
    }

    [Fact]
    public void ReportManualSocialFailure_PresentsOnlyTheExistingSanitizedDiagnostic()
    {
        const string vanity = "fictional multiword vanity";
        const string title = "fictional private title";
        const string body = "fictional private body";
        const string notes = "fictional private notes";
        const string path = "C:\\private media\\secret file.png";
        const string token = "fictional-token";
        const string url = "https://private.example/creator";
        const string identifier = "target id fictional-identifier";
        var diagnostic = new SocialPreparationDiagnostic("patreon", "create_activation", "platform_preparation_failed");
        diagnostic.CapturePrimary(new CdpCommandException(-32000,
            $"vanity={vanity}; title={title}; body={body}; Notes={notes}; path={path}; token={token}; url={url}; {identifier}", "DOM.scrollIntoViewIfNeeded"));
        string? presented = null;

        FailureReporter.ReportManualSocialFailure("platform_preparation_failed", diagnostic.FormatForDisplay(),
            () => new StringWriter(), (_, value) => { presented = value; return new NativePresentationResult(); });

        Assert.NotNull(presented);
        foreach (string privateFragment in new[] { vanity, title, body, notes, path, token, url, identifier, "private.example", "secret file" })
            Assert.DoesNotContain(privateFragment, presented!);
    }

    [Theory]
    [InlineData("report Edit control")]
    [InlineData("Copy Report button")]
    [InlineData("Close button")]
    public void NativeFailureDialog_ThreadEscapeHandlingClosesRegardlessOfFocusedChild(string focusedChild)
    {
        Assert.False(string.IsNullOrWhiteSpace(focusedChild));
        int closeRequests = 0;

        bool handled = NativeFailureDialog.TryHandleThreadMessage(0x0100, new IntPtr(0x1B), () => closeRequests++);

        Assert.True(handled);
        Assert.Equal(1, closeRequests);
        Assert.False(NativeFailureDialog.TryHandleThreadMessage(0x0100, new IntPtr(0x0D), () => closeRequests++));
        Assert.Equal(1, closeRequests);
    }

    [Fact]
    public void CopyReport_ProvidesTheEntireReportOnlyWhenTheCopyCommandRuns()
    {
        const string report = "Platform: bluesky\nUnicode ✓; complete report";
        var clipboard = new RecordingClipboard(true);

        Assert.True(NativeFailureDialog.TryCopyReport(report, clipboard));
        Assert.Equal(1, clipboard.Calls);
        Assert.Equal(report, clipboard.LastText);
    }

    [Fact]
    public void CopyReport_FailureDoesNotAlterTheUnderlyingReport()
    {
        const string report = "Platform: x\ncomplete report remains visible";
        var clipboard = new RecordingClipboard(false);

        Assert.False(NativeFailureDialog.TryCopyReport(report, clipboard));
        Assert.Equal(report, clipboard.LastText);
        Assert.Equal("Platform: x\ncomplete report remains visible", report);
    }

    [Fact]
    public void BuildReport_PreservesStableErrorAndEveryLineOfBoundedDiagnostic()
    {
        const string vanity = "private_creator_vanity";
        var diagnostic = new SocialPreparationDiagnostic("patreon", "create_activation", "patreon_preparation_failed");
        diagnostic.Checkpoint("creator_page_ready");
        diagnostic.Checkpoint("create_activated", false);
        diagnostic.TargetState("replacement_target_appeared", false);
        diagnostic.CapturePrimary(new CdpCommandException(-32000,
            $"Could not find node; vanity={vanity}; path=C:\\private\\image.png; token=private", "DOM.scrollIntoViewIfNeeded"));
        diagnostic.CaptureCleanup(new CdpTransportException(CdpTransportFailure.Disconnected));

        string report = FailureReporter.BuildReport("patreon_preparation_failed", diagnostic.FormatForDisplay());

        foreach (string required in new[]
        {
            "patreon_preparation_failed", "Social Preparation failed", "Platform: patreon", "Adapter: patreon_social_preparation",
            "Phase: create_activation", "Stable error: patreon_preparation_failed", "Outcome: failed", "Error class: cdp_command",
            "CDP operation: scroll_into_view", "CDP code: -32000", "CDP message: Could not find node",
            "creator_page_ready: yes", "create_activated: no", "replacement_target_appeared: no", "Cleanup:", "Error class: cdp_transport",
        })
        {
            Assert.Contains(required, report);
        }
        Assert.DoesNotContain(vanity, report);
        Assert.DoesNotContain("private\\image.png", report);
        Assert.DoesNotContain("token:private", report);
    }

    [Fact]
    public void IsStderrAvailable_ZeroHandle_IsFalse()
    {
        // GetStdHandle returns NULL when the process has no console and no
        // redirected standard handle: the message-box branch must trigger.
        Assert.False(FailureReporter.IsStderrAvailable(IntPtr.Zero));
    }

    [Fact]
    public void IsStderrAvailable_InvalidHandle_IsFalse()
    {
        Assert.False(FailureReporter.IsStderrAvailable(new IntPtr(-1)));
    }

    [Fact]
    public void IsStderrAvailable_NonNullValidHandle_IsTrue()
    {
        Assert.True(FailureReporter.IsStderrAvailable(new IntPtr(7)));
    }

    [Fact]
    public void Report_ThrowingPresentationKeepsOriginalNonzeroOutcome()
    {
        int messageBoxCalls = 0;
        int exit = FailureReporter.Report("x_preparation_failed", "full safe detail",
            () => new ThrowingWriter(), _ => { messageBoxCalls++; throw new InvalidOperationException("presentation unavailable"); });
        Assert.Equal(1, exit);
        Assert.Equal(1, messageBoxCalls);
    }

    [Fact]
    public void ReportManualSocialFailure_ThrowingPresentationKeepsOriginalFailureAndSecondaryOutput()
    {
        var stderr = new StringWriter();
        int exit = FailureReporter.ReportManualSocialFailure("platform_preparation_failed", "Platform: x\nStable error: platform_preparation_failed",
            () => stderr, (_, _) => throw new InvalidOperationException("presentation unavailable"));

        Assert.Equal(1, exit);
        Assert.Contains("platform_preparation_failed", stderr.ToString());
    }

    private sealed class ThrowingWriter : StringWriter
    {
        public override void WriteLine(string? value) => throw new IOException("stderr unavailable");
    }

    private sealed class RecordingClipboard(bool succeeds) : NativeFailureDialog.IFailureReportClipboard
    {
        public int Calls { get; private set; }
        public string? LastText { get; private set; }

        public bool TrySetText(string text)
        {
            Calls++;
            LastText = text;
            return succeeds;
        }
    }

    [Fact]
    public void NativeFailureDialog_UsesTheExplicitWideDefaultWindowProcedure()
    {
        MethodInfo method = typeof(NativeFailureDialog)
            .GetMethod("DefWindowProcW", BindingFlags.NonPublic | BindingFlags.Static)!;
        DllImportAttribute import = method.GetCustomAttribute<DllImportAttribute>()!;

        Assert.True(import.ExactSpelling);
        Assert.Equal("DefWindowProcW", import.EntryPoint);
        Assert.Equal(CharSet.Unicode, import.CharSet);
    }
}
