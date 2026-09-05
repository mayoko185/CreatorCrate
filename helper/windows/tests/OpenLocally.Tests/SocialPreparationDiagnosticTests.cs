using System.Text.Json;
using OpenLocally;

namespace OpenLocally.Tests;

public class SocialPreparationDiagnosticTests
{
    [Fact]
    public void CreateResolution_AllOutcomesHaveDisplaySerializationParityAndBoundedSchema()
    {
        string[] vocabulary = ["root_unavailable", "zero_matches", "no_usable_candidate", "ambiguous",
            "candidate_limit_exceeded", "malformed_query", "invalid_candidate_identity", "malformed_description",
            "stale_description", "malformed_geometry", "unique_candidate"];
        foreach (PatreonCreateResolutionOutcome outcome in Enum.GetValues<PatreonCreateResolutionOutcome>())
        {
            var report = new SocialPreparationDiagnostic("patreon", "create_activation", "patreon_create_control_missing");
            report.SetCreateResolution(new(outcome, 16, 16, 8, 8, complete: true));
            for (int i = 0; i < 16; i++) report.Checkpoint(new string('a', 60) + i);
            for (int i = 0; i < 8; i++) report.TargetState(new string('b', 60) + i, null);
            report.CapturePrimary(new CdpCommandException(-32000, new string('c', 256), "DOM.getBoxModel"));
            report.CaptureCleanup(new TimeoutException());
            report.SetCorrelation(int.MaxValue, int.MaxValue);
            report.SetReportingFailure(new string('d', 64), new TimeoutException());
            string serialized = report.Serialize();
            Assert.InRange(System.Text.Encoding.UTF8.GetByteCount(serialized), 1, SocialPreparationDiagnostic.MaximumSerializedLength);
            using JsonDocument json = JsonDocument.Parse(serialized);
            JsonElement block = json.RootElement.GetProperty("create_resolution");
            Assert.Equal(vocabulary[(int)outcome], block.GetProperty("outcome").GetString());
            Assert.Equal(9, block.EnumerateObject().Count());
            foreach (JsonProperty field in block.EnumerateObject())
            {
                string value = field.Value.ValueKind == JsonValueKind.True ? "yes" : field.Value.ValueKind == JsonValueKind.False ? "no" : field.Value.ToString();
                Assert.Contains($"{field.Name}: {value}", report.FormatForDisplay());
            }
            Assert.DoesNotContain("node", block.GetRawText(), StringComparison.OrdinalIgnoreCase);
            Assert.DoesNotContain("session", block.GetRawText(), StringComparison.OrdinalIgnoreCase);
            Assert.DoesNotContain("<", block.GetRawText());
        }
    }

    [Fact]
    public void CreateResolution_UnknownIsNotZeroAndPartialCountsAreLabelled()
    {
        var report = new SocialPreparationDiagnostic("patreon", "create_activation", "patreon_create_control_missing");
        report.SetCreateResolution(new(PatreonCreateResolutionOutcome.RootUnavailable));
        using (JsonDocument json = JsonDocument.Parse(report.Serialize()))
            Assert.False(json.RootElement.GetProperty("create_resolution").TryGetProperty("candidate_count", out _));
        Assert.Contains("candidate_count: unknown", report.FormatForDisplay());
        Assert.Contains("complete: no", report.FormatForDisplay());
        report.SetCreateResolution(new(PatreonCreateResolutionOutcome.ZeroMatches, 0, 0, 0, 0, complete: true));
        Assert.Contains("candidate_count: 0", report.FormatForDisplay());
        Assert.DoesNotContain("partial", report.FormatForDisplay());
        report.SetCreateResolution(new(PatreonCreateResolutionOutcome.StaleDescription, 2, 1, 1, 0));
        Assert.Contains("Counts are partial", report.FormatForDisplay());
        report.SetCreateResolution(new(PatreonCreateResolutionOutcome.CandidateLimitExceeded, limitExceeded: true));
        Assert.Contains("limit_exceeded: yes", report.FormatForDisplay());
        report.SetCreateResolution(new());
        Assert.Contains("outcome: unknown", report.FormatForDisplay());
    }

    [Theory]
    [InlineData(-1)] [InlineData(17)] [InlineData(int.MaxValue)] [InlineData(int.MinValue)]
    public void CreateResolution_RejectsEveryOutOfRangeCountAndUndefinedEnums(int invalid)
    {
        Assert.Throws<ArgumentOutOfRangeException>(() => new PatreonCreateResolutionEvidence(candidateCount: invalid));
        Assert.Throws<ArgumentOutOfRangeException>(() => new PatreonCreateResolutionEvidence(inspectedCount: invalid));
        Assert.Throws<ArgumentOutOfRangeException>(() => new PatreonCreateResolutionEvidence(usableCount: invalid));
        Assert.Throws<ArgumentOutOfRangeException>(() => new PatreonCreateResolutionEvidence(layoutRejectedCount: invalid));
        Assert.Throws<ArgumentOutOfRangeException>(() => new PatreonCreateResolutionEvidence((PatreonCreateResolutionOutcome)invalid));
        Assert.DoesNotContain(typeof(PatreonCreateResolutionEvidence).GetConstructors(System.Reflection.BindingFlags.Instance | System.Reflection.BindingFlags.NonPublic),
            constructor => constructor.GetParameters().Any(parameter => parameter.ParameterType == typeof(string)));
    }

    [Fact]
    public void CreateResolution_OnlyKnownMissingCreateFailuresOverrideUnexpected()
    {
        var report = new SocialPreparationDiagnostic("patreon", "create_activation", "patreon_create_control_missing");
        report.CapturePrimary(new PatreonPreparationException("patreon_create_control_missing"));
        Assert.Equal("unexpected", report.ErrorClass);
        report.SetCreateResolution(new(PatreonCreateResolutionOutcome.RootUnavailable));
        report.CapturePrimary(new PatreonPreparationException("patreon_create_control_missing"));
        Assert.Equal("browser_preparation", report.ErrorClass);
        report.CapturePrimary(new InvalidOperationException("private arbitrary text"));
        Assert.Equal("unexpected", report.ErrorClass);
        report.CapturePrimary(new PatreonPreparationException("patreon_post_control_missing"));
        Assert.Equal("unexpected", report.ErrorClass);
        report.CapturePrimary(new OperationCanceledException(), timedOut: true);
        Assert.Equal("timeout", report.ErrorClass);
    }

    [Fact]
    public void CdpFailure_PreservesOperationCodeAndSafeMessage()
    {
        var report = new SocialPreparationDiagnostic("x", "media_readiness", "x_media_not_ready");
        report.Checkpoint("home_ready");
        report.TargetState("owned_target_created", true);
        report.CapturePrimary(new CdpCommandException(-32000,
            "Could not find node with given id 99 https://private.test/?token=secret", "DOM.getBoxModel"));
        report.CaptureCleanup(new CdpTransportException(CdpTransportFailure.Disconnected));

        using JsonDocument json = JsonDocument.Parse(report.Serialize());
        JsonElement root = json.RootElement;
        Assert.Equal("x", root.GetProperty("platform").GetString());
        Assert.Equal("media_readiness", root.GetProperty("phase").GetString());
        Assert.Equal("cdp_command", root.GetProperty("error_class").GetString());
        Assert.Equal("get_box_model", root.GetProperty("cdp_operation").GetString());
        Assert.Equal(-32000, root.GetProperty("cdp_code").GetInt32());
        Assert.Contains("Could not find node with given id", root.GetProperty("cdp_message").GetString());
        Assert.DoesNotContain("private.test", root.GetProperty("cdp_message").GetString());
        Assert.Equal("cdp_transport", root.GetProperty("cleanup").GetProperty("error_class").GetString());

        string display = report.FormatForDisplay();
        foreach (string required in new[]
        {
            "Social Preparation failed", "Platform: x", "Adapter: x_social_preparation", "Phase: media_readiness",
            "Stable error: x_media_not_ready", "Outcome: failed", "Error class: cdp_command", "CDP operation: get_box_model",
            "CDP code: -32000", "CDP message: Could not find node with given id", "home_ready: yes",
            "owned_target_created: yes", "Cleanup:", "Error class: cdp_transport",
        })
        {
            Assert.Contains(required, display);
        }
        Assert.DoesNotContain("private.test", display);
    }

    [Theory]
    [InlineData("x")]
    [InlineData("bluesky")]
    [InlineData("patreon")]
    public void DisplayFormat_IsSharedAndDoesNotShortenLegalBoundedReports(string platform)
    {
        var report = new SocialPreparationDiagnostic(platform, "create_activation", "platform_preparation_failed");
        for (int index = 0; index < 16; index++) report.Checkpoint($"checkpoint_{index}", index % 2 == 0);
        for (int index = 0; index < 8; index++) report.TargetState($"lifecycle_{index}", index % 2 == 0);
        report.CapturePrimary(new CdpCommandException(-32000, new string('a', SocialPreparationDiagnostic.MaximumMessageLength), "DOM.scrollIntoViewIfNeeded"));

        string display = report.FormatForDisplay();

        Assert.Contains($"Platform: {platform}", display);
        Assert.Contains("CDP code: -32000", display);
        Assert.Contains(new string('a', SocialPreparationDiagnostic.MaximumMessageLength), display);
        foreach (int index in Enumerable.Range(0, 16)) Assert.Contains($"checkpoint_{index}:", display);
        foreach (int index in Enumerable.Range(0, 8)) Assert.Contains($"lifecycle_{index}:", display);
    }

    [Fact]
    public void Serialization_RedactsPrivateValuesAndIsDeterministicallyBounded()
    {
        const string vanity = "distinctive_creator_vanity";
        const string title = "orchid lantern meridian";
        const string body = "cerulean fjord mosaic";
        const string media = @"C:\private media\distinctive.png";
        const string token = "capability-token=distinctive-token";
        string source = $"Could not find node with given id;vanity={vanity};title={title};body={body};path={media};https://private.example.test/path?{token};<div>distinctive-html</div>;" + new string('x', 2_000);
        var report = new SocialPreparationDiagnostic("patreon", "create_activation", "patreon_create_control_missing");
        report.CapturePrimary(new CdpCommandException(-32000, source, "DOM.scrollIntoViewIfNeeded"));

        string serialized = report.Serialize();
        Assert.True(serialized.Length <= SocialPreparationDiagnostic.MaximumSerializedLength);
        Assert.DoesNotContain(vanity, serialized);
        Assert.DoesNotContain(title, serialized);
        Assert.DoesNotContain("orchid", serialized);
        Assert.DoesNotContain("lantern", serialized);
        Assert.DoesNotContain("meridian", serialized);
        Assert.DoesNotContain(body, serialized);
        Assert.DoesNotContain("cerulean", serialized);
        Assert.DoesNotContain("fjord", serialized);
        Assert.DoesNotContain("mosaic", serialized);
        Assert.DoesNotContain(media, serialized);
        Assert.DoesNotContain("private", serialized);
        Assert.DoesNotContain("media", serialized);
        Assert.DoesNotContain("distinctive.png", serialized);
        Assert.DoesNotContain("private.example.test", serialized);
        Assert.DoesNotContain("distinctive-token", serialized);
        Assert.DoesNotContain("distinctive-html", serialized);
        Assert.Contains("Could not find node with given id", serialized);
        Assert.Contains("[truncated]", serialized);
    }

    [Fact]
    public void Display_ContainsSafeReleasePlatformAndAttemptCorrelationOnly()
    {
        var report = new SocialPreparationDiagnostic("bluesky", "media_readiness", "bluesky_media_not_ready");
        report.SetCorrelation(123, 4);
        report.SetReportingFailure("status_patch_failed");
        string display = report.FormatForDisplay();
        Assert.Contains("Platform: bluesky", display);
        Assert.Contains("Release ID: 123", display);
        Assert.Contains("Attempt: 4", display);
        Assert.Contains("status_patch_failed", display);
        Assert.DoesNotContain("capability", display, StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain("session", display, StringComparison.OrdinalIgnoreCase);
    }

    [Fact]
    public void ReportingFailure_PreservesOnlyTheSafeExceptionClass()
    {
        var report = new SocialPreparationDiagnostic("x", "media_readiness", "x_media_not_ready");
        report.SetReportingFailure("status_reporting_failed", new TimeoutException("private timeout at C:\\private\\reporting"));

        using JsonDocument json = JsonDocument.Parse(report.Serialize());
        JsonElement reporting = json.RootElement.GetProperty("reporting");
        Assert.Equal("status_reporting_failed", reporting.GetProperty("stable_error").GetString());
        Assert.Equal("timeout", reporting.GetProperty("error_class").GetString());
        Assert.Contains("Error class: timeout", report.FormatForDisplay());
        Assert.DoesNotContain("private timeout", report.FormatForDisplay());
    }
}
