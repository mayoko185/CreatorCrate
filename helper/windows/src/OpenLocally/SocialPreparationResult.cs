namespace OpenLocally;

public enum SocialPreparationResultCategory
{
    Completed,
    Finished,
    Superseded,
    PreRedeemFailure,
    CapabilityFailure,
    PreparationFailure,
    Cancelled,
}

/// <summary>Safe process result: it deliberately carries no payload, media path, or capability.</summary>
public sealed record SocialPreparationResult(bool Success, string? ErrorCode, SocialPreparationResultCategory Category, string? Detail = null)
{
    public static SocialPreparationResult Completed() => new(true, null, SocialPreparationResultCategory.Completed);
    public static SocialPreparationResult Finished(string? detail = null) => new(true, "attempt_finished", SocialPreparationResultCategory.Finished, detail);
    public static SocialPreparationResult Fail(string code, SocialPreparationResultCategory category, string? detail = null) => new(false, code, category, detail);
}
