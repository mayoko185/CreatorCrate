namespace OpenLocally;

/// <summary>Preparation phases an adapter may report to the helper.</summary>
public enum SocialPreparationProgress
{
    Preparing,
    Uploading,
}

/// <summary>The only terminal outcomes an adapter may return. It cannot submit content.</summary>
public enum PlatformPreparationOutcome
{
    Prepared,
    AuthenticationRequired,
    Failed,
}

public sealed record PlatformPreparationResult(PlatformPreparationOutcome Outcome, SocialPreparationDiagnostic? Diagnostic = null)
{
    public static PlatformPreparationResult Prepared() => new(PlatformPreparationOutcome.Prepared);
    public static PlatformPreparationResult AuthenticationRequired() => new(PlatformPreparationOutcome.AuthenticationRequired);
    public static PlatformPreparationResult Failed(SocialPreparationDiagnostic? diagnostic = null) => new(PlatformPreparationOutcome.Failed, diagnostic);
}

/// <summary>
/// Server-authoritative input for preparing one composer. Media order is the
/// order returned by CreatorCrate and is never interpreted by this seam.
/// </summary>
public sealed record PlatformPreparationContext(
    string Platform,
    string Title,
    string Body,
    IReadOnlyList<string> MediaPaths,
    BrowserPreparationTargets? BrowserTargets);

/// <summary>Restricted adapter-to-helper progress channel; server writes stay helper-owned.</summary>
public interface IPreparationProgress
{
    Task ReportAsync(SocialPreparationProgress progress, CancellationToken cancellationToken);
}

/// <summary>
/// Platform-specific composer preparation seam. Implementations prepare only;
/// this API intentionally contains no submit, post, publish, or confirmation operation.
/// </summary>
public interface ISocialPreparationAdapter
{
    string Platform { get; }

    Task<PlatformPreparationResult> PrepareAsync(
        PlatformPreparationContext context,
        IPreparationProgress progress,
        CancellationToken cancellationToken);
}
