using OpenLocally;

namespace OpenLocally.Tests;

public class BrowserTargetSelectorTests
{
    [Fact]
    public void FilterPreparatablePages_ExcludesNonPageAndInternalTargets()
    {
        CdpTargetInfo[] targets =
        [
            new("operator", "page", "https://example.test", "Operator", false),
            new("blank", "page", "about:blank", "Blank", false),
            new("devtools", "page", "devtools://devtools", "DevTools", false),
            new("browser", "browser", "", "", false),
            new("worker", "service_worker", "https://example.test/worker.js", "", false),
        ];

        Assert.Equal(["operator", "blank"], BrowserTargetSelector.FilterPreparatablePages(targets).Select(target => target.TargetId));
    }
}
