using OpenLocally;

namespace OpenLocally.Tests;

public class FailureReporterTests
{
    [Theory]
    [InlineData(0, false)]
    [InlineData(-1, false)]
    [InlineData(1, true)]
    public void IsStderrAvailable_RequiresAUsableHandle(int handle, bool expected)
    {
        Assert.Equal(expected, FailureReporter.IsStderrAvailable(new IntPtr(handle)));
    }

    [Fact]
    public void Report_WritesCompleteFailureToStderrWithoutShowingUi()
    {
        var writer = new StringWriter();
        int dialogs = 0;

        int exit = FailureReporter.Report("stable_error", "safe detail", () => writer, _ => dialogs++);

        Assert.Equal(1, exit);
        Assert.Equal("stable_error" + Environment.NewLine + "safe detail" + Environment.NewLine, writer.ToString());
        Assert.Equal(0, dialogs);
    }

    [Fact]
    public void Report_UsesUiWhenStderrIsUnavailable()
    {
        string? shown = null;

        int exit = FailureReporter.Report("stable_error", "safe detail", () => null, report => shown = report);

        Assert.Equal(1, exit);
        Assert.Equal("stable_error" + Environment.NewLine + "safe detail", shown);
    }

    [Fact]
    public void ManualReporter_PresentsTheExistingSafeV2Detail()
    {
        const string report = "Social Preparation failed\nPlatform: unknown\nPhase: manual_preparation\nStable error: manual_companion_failed\nOutcome: failed\nError class: unexpected";
        string? summary = null;
        string? presented = null;

        int exit = FailureReporter.ReportManualSocialFailure(
            "manual_companion_failed",
            report,
            () => new StringWriter(),
            (actualSummary, actualReport) =>
            {
                summary = actualSummary;
                presented = actualReport;
                return new NativePresentationResult();
            });

        Assert.Equal(1, exit);
        Assert.Equal(report, presented);
        Assert.Contains("Stable error: manual_companion_failed", summary);
    }

    [Fact]
    public void StructuredManualReporter_UsesSafeCopyableDetailAndStderr()
    {
        var diagnostic = new ManualSocialDiagnostic(
            "redeem_payload_invalid", ManualSocialDiagnosticStage.RedeemPreparation,
            ManualSocialDiagnosticReason.FilenameExtensionMismatch,
            HttpStatus: 200, PlatformOrdinal: 2, AssetOrdinal: 3, ReleaseId: 42);
        var stderr = new StringWriter();
        string? summary = null;
        string? report = null;

        int exit = FailureReporter.ReportManualSocialFailure(
            diagnostic, () => stderr,
            (actualSummary, actualReport) =>
            {
                summary = actualSummary;
                report = actualReport;
                return new NativePresentationResult();
            });

        Assert.Equal(1, exit);
        Assert.Contains("CreatorCrate could not prepare", summary);
        Assert.Contains("Stage: Redeem preparation", report);
        Assert.Contains("Asset 3 has an extension that does not match its filename.", report);
        Assert.Contains("Platform: 2", report);
        Assert.Contains("Asset: 3", report);
        Assert.Contains("Release ID: 42", report);
        Assert.Contains("HTTP status: 200", report);
        Assert.Contains("Reason: filename_extension_mismatch", report);
        Assert.Contains("Code: redeem_payload_invalid", report);
        Assert.Equal(report + Environment.NewLine, stderr.ToString());
        foreach (string secret in new[]
        {
            "SECRET_INTENT_SENTINEL", "SECRET_BEARER_SENTINEL", "SECRET_POST_BODY_SENTINEL",
            "creatorcrate-social:", "Authorization", "Cookie", "CSRF"
        })
        {
            Assert.DoesNotContain(secret, summary + report + stderr, StringComparison.OrdinalIgnoreCase);
        }
    }

    [Fact]
    public void ManualFallback_DoesNotExposeArbitraryExceptionText()
    {
        const string secret = "private_exception_text";
        var bounded = new ManualSocialDiagnostic(
            secret, ManualSocialDiagnosticStage.ManualPreparation,
            ManualSocialDiagnosticReason.PreparationFailed);
        var stderr = new StringWriter();
        string? report = null;

        FailureReporter.ReportManualSocialFailure(
            secret, null, () => stderr,
            (_, actualReport) => { report = actualReport; return new NativePresentationResult(); });

        Assert.DoesNotContain(secret, report);
        Assert.DoesNotContain(secret, stderr.ToString());
        Assert.DoesNotContain(secret, bounded.ToString());
        Assert.Equal("manual_preparation_failed", bounded.Code);
        Assert.Contains("Stable error: manual_preparation_failed", report);
    }

    [Theory]
    [InlineData(-1, true, false)]
    [InlineData(0, false, false)]
    [InlineData(0, true, true)]
    [InlineData(1, true, false)]
    public void NativeFailureDialog_GetMessageErrorAndUnrequestedQuitAreNotNormalDismissal(
        int status, bool dismissed, bool expected)
    {
        Assert.Equal(expected, NativeFailureDialog.IsNormalMessageLoopExit(status, dismissed));
    }

    [Fact]
    public void CopyReport_UsesTheSharedUnicodeClipboardBoundary()
    {
        const string report = "Manual companion failure ✓";
        var clipboard = new RecordingClipboard();

        Assert.True(NativeFailureDialog.TryCopyReport(report, clipboard));
        Assert.Equal(report, clipboard.Text);
    }

    private sealed class RecordingClipboard : NativeFailureDialog.IFailureReportClipboard
    {
        public string? Text { get; private set; }
        public bool TrySetText(string text)
        {
            Text = text;
            return true;
        }
    }
}
