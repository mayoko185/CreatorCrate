namespace OpenLocally;

public sealed record SocialRedeemAsset(
    long AssetId, string Role, long SortOrder, string Filename, string Extension,
    string MimeType, long SizeBytes, string RelativePath, bool IsPresent, string? WindowsPath);

public sealed record SocialRedeemPlatform(string Platform, string Title, string Body, IReadOnlyList<SocialRedeemAsset> Assets);

public sealed record SocialRedeemResponse(
    string SessionId, DateTime AttemptDeadlineAt, IReadOnlyList<SocialRedeemPlatform> Platforms, string MediaToken)
{
    /// <summary>Non-secret server release correlation, present on production redeem responses.</summary>
    public int? ReleaseId { get; init; }
}

public sealed record SocialRedeemResult(bool Success, string? ErrorCode, SocialRedeemResponse? Response)
{
    public static SocialRedeemResult Ok(SocialRedeemResponse response) => new(true, null, response);
    public static SocialRedeemResult Fail(string errorCode) => new(false, errorCode, null);
}
