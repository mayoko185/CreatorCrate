namespace OpenLocally;

/// <summary>Generic policy for pages that may safely be prepared. It deliberately has no platform host rules.</summary>
public static class BrowserTargetSelector
{
    public static bool IsPreparatablePage(CdpTargetInfo target)
    {
        ArgumentNullException.ThrowIfNull(target);
        if (!string.Equals(target.Type, "page", StringComparison.OrdinalIgnoreCase))
        {
            return false;
        }

        string url = target.Url.TrimStart();
        return !url.StartsWith("devtools:", StringComparison.OrdinalIgnoreCase) &&
            !url.StartsWith("chrome-devtools:", StringComparison.OrdinalIgnoreCase) &&
            !url.StartsWith("chrome:", StringComparison.OrdinalIgnoreCase) &&
            !url.StartsWith("edge:", StringComparison.OrdinalIgnoreCase);
    }

    public static IReadOnlyList<CdpTargetInfo> FilterPreparatablePages(IEnumerable<CdpTargetInfo> targets)
    {
        ArgumentNullException.ThrowIfNull(targets);
        return targets.Where(IsPreparatablePage).ToArray();
    }
}
