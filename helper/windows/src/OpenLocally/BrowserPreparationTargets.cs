namespace OpenLocally;

/// <summary>
/// Bounded target selection and session lifecycle capability for platform
/// preparation adapters. It can create tracked targets and attach to pages,
/// but cannot expose raw CDP commands or close an arbitrary target.
/// </summary>
public sealed class BrowserPreparationTargets
{
    private readonly CdpTargetManager _targets;

    internal BrowserPreparationTargets(CdpTargetManager targets) =>
        _targets = targets ?? throw new ArgumentNullException(nameof(targets));

    public Task<IReadOnlyList<CdpTargetInfo>> GetPreparatablePagesAsync(
        TimeSpan? timeout = null,
        CancellationToken cancellationToken = default) =>
        BrowserPreparationSession.GetPreparatablePagesAsync(_targets, timeout, cancellationToken);

    public Task<BrowserPreparationSession> CreateOwnedAsync(
        TimeSpan? timeout = null,
        CancellationToken cancellationToken = default) =>
        BrowserPreparationSession.CreateOwnedAsync(_targets, timeout, cancellationToken);

    public Task<BrowserPreparationSession> AttachAsync(
        string targetId,
        TimeSpan? timeout = null,
        CancellationToken cancellationToken = default) =>
        BrowserPreparationSession.AttachAsync(_targets, targetId, timeout, cancellationToken);
}
