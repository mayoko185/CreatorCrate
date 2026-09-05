namespace OpenLocally;

public sealed record SocialCapabilityOutcome(bool Success, string? ErrorCode)
{
    public static SocialCapabilityOutcome Ok() => new(true, null);
    public static SocialCapabilityOutcome Fail(string errorCode) => new(false, errorCode);
}

public sealed class SocialCapability
{
    public string SessionId { get; }
    internal string MediaToken { get; }

    internal SocialCapability(string sessionId, string mediaToken) => (SessionId, MediaToken) = (sessionId, mediaToken);

    internal static bool TryCreate(SocialRedeemResponse response, out SocialCapability? capability)
    {
        capability = null;
        if (response is null || !Guid.TryParse(response.SessionId, out _) || !SocialCapabilityClient.IsValidToken(response.MediaToken))
            return false;
        capability = new SocialCapability(response.SessionId, response.MediaToken);
        return true;
    }
}

public sealed record SocialPlatformStatus(string Platform, string Status, string? DetailCode, int Attempts, DateTime? PreparedAt);
public sealed record SocialStatusResponse(string SessionId, string State, DateTime AttemptDeadlineAt, IReadOnlyList<SocialPlatformStatus> Platforms);
public sealed record SocialStatusResult(bool Success, string? ErrorCode, SocialStatusResponse? Status)
{
    public static SocialStatusResult Ok(SocialStatusResponse status) => new(true, null, status);
    public static SocialStatusResult Fail(string code) => new(false, code, null);
}
public sealed record SocialPlatformStatusResult(bool Success, string? ErrorCode, SocialPlatformStatus? Platform)
{
    public static SocialPlatformStatusResult Ok(SocialPlatformStatus platform) => new(true, null, platform);
    public static SocialPlatformStatusResult Fail(string code) => new(false, code, null);
}
public sealed record SocialMediaDownloadResult(bool Success, string? ErrorCode, long BytesWritten)
{
    public static SocialMediaDownloadResult Ok(long bytesWritten) => new(true, null, bytesWritten);
    public static SocialMediaDownloadResult Fail(string code) => new(false, code, 0);
}
