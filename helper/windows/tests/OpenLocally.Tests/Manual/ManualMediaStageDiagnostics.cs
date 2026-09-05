using OpenLocally;

namespace OpenLocally.Tests.Manual;

internal sealed class ManualMediaStageState
{
    internal bool StrategyAAttempted { get; private set; }
    internal bool StrategyAAccepted { get; private set; }
    internal string StrategyAOutcome { get; private set; } = "not_started";
    internal bool StrategyBRequested { get; private set; }
    internal int MediaRequestCount { get; private set; }
    internal int? MediaResponseStatus { get; private set; }
    internal string StrategyBOutcome { get; private set; } = "not_started";
    internal StagedMediaProvenance? Provenance { get; private set; }
    internal bool ResultFileExists { get; private set; }
    internal bool ByteVerificationCompleted { get; private set; }
    internal bool? ByteVerificationPassed { get; private set; }
    internal string CleanupOutcome { get; private set; } = "not_attempted";

    internal void BeginStrategyA() => StrategyAAttempted = true;

    internal void RecordStrategyAResult(StagedMedia result)
    {
        StrategyAAttempted = true;
        StrategyAAccepted = result.Success && result.Provenance == StagedMediaProvenance.ExternalSource;
        StrategyAOutcome = result.Success
            ? StrategyAAccepted ? "accepted" : "unexpected_provenance"
            : FailureOutcome(result.ErrorCode);
        RecordResult(result);
    }

    internal void RecordStrategyARejection(string reason)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(reason);
        StrategyAAttempted = true;
        StrategyAAccepted = false;
        StrategyAOutcome = "rejected";
        StrategyARejection = reason;
    }

    internal void RecordStrategyBResult(StagedMedia result, int mediaRequestCount, int? mediaResponseStatus)
    {
        ArgumentOutOfRangeException.ThrowIfNegative(mediaRequestCount);
        MediaRequestCount = mediaRequestCount;
        StrategyBRequested = mediaRequestCount > 0;
        MediaResponseStatus = StrategyBRequested ? mediaResponseStatus : null;
        StrategyBOutcome = result.Success
            ? "success"
            : StrategyBRequested ? FailureOutcome(result.ErrorCode) : "not_requested";
        RecordResult(result);
    }

    internal void RecordByteVerification(bool passed)
    {
        ByteVerificationCompleted = true;
        ByteVerificationPassed = passed;
    }

    internal void RecordCleanup(bool succeeded) =>
        CleanupOutcome = succeeded ? "success" : "failed";

    internal string? StrategyARejection { get; private set; }

    internal string FormatDiagnostic(string heading) =>
        $"{heading}\nStrategy A attempted: {Boolean(StrategyAAttempted)}\nStrategy A accepted: {Boolean(StrategyAAccepted)}\nStrategy A outcome: {StrategyAOutcome}\nStrategy A rejection: {StrategyARejection ?? "none"}\nStrategy B requested: {Boolean(StrategyBRequested)}\nFixture media GET count: {MediaRequestCount}\nMedia response status: {MediaResponseStatus?.ToString() ?? "not_requested"}\nStrategy B outcome: {StrategyBOutcome}\nReturned provenance: {Provenance?.ToString() ?? "none"}\nResult file exists: {Boolean(ResultFileExists)}\nByte verification completed: {Boolean(ByteVerificationCompleted)}\nByte verification passed: {Boolean(ByteVerificationPassed)}\nCleanup result: {CleanupOutcome}";

    private void RecordResult(StagedMedia result)
    {
        Provenance = result.Provenance;
        ResultFileExists = result.Path is not null && File.Exists(result.Path);
    }

    private static string FailureOutcome(string? errorCode) =>
        string.IsNullOrWhiteSpace(errorCode) ? "failed:unknown" : $"failed:{errorCode}";

    private static string Boolean(bool? value) =>
        value.HasValue ? value.Value ? "true" : "false" : "not_attempted";
}

internal static class ManualMediaStageVerification
{
    internal static bool HasExactExpectedBytes(string? path, byte[] expectedBytes)
    {
        ArgumentNullException.ThrowIfNull(expectedBytes);
        if (string.IsNullOrWhiteSpace(path)) return false;

        try
        {
            return File.ReadAllBytes(path).AsSpan().SequenceEqual(expectedBytes);
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or ArgumentException or NotSupportedException)
        {
            return false;
        }
    }
}
