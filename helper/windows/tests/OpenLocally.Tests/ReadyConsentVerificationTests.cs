using OpenLocally;

namespace OpenLocally.Tests;

public class ReadyConsentVerificationTests
{
    [Fact]
    public void HarnessVerifierUsesOwnedWorkspacePrefixAndExistingLauncher()
    {
        string root = PublishedProductionGateProcessTests.FindRepositoryRoot();
        string script = File.ReadAllText(Path.Combine(root, "helper/windows/tests/OpenLocally.Tests/Manual/run-m2-foundation.ps1"));
        Assert.Contains("'CreatorCrate-m2-manual-ready-'", script);
        Assert.Contains("-LogicalArguments @('--verify-ready-consent') -CaptureResult -ReadyConsentAssembly", script);
        Assert.Contains("if ($env:CREATORCRATE_M2_MANUAL -cne '1') { throw 'Ready verification", script);
        Assert.Contains("[Reflection.Assembly]::Load([IO.File]::ReadAllBytes($ReadyConsentAssembly))", script);
        Assert.Contains("if (-not $cleanup.Succeeded) { throw 'Offline Ready workspace cleanup failed.' }", script);
    }

    [Fact]
    public void ParentAssemblyCanBeRemovedWhileItsReadyTypeRemainsLoaded()
    {
        string path = Path.Combine(Path.GetTempPath(), "CreatorCrate-ready-load-" + Guid.NewGuid().ToString("N") + ".dll");
        try
        {
            File.Copy(typeof(CommandDispatcher).Assembly.Location, path);
            var assembly = System.Reflection.Assembly.Load(File.ReadAllBytes(path));
            Assert.NotNull(assembly.GetType("OpenLocally.ManualReadyConsentParent"));
            File.Delete(path);
            Assert.False(File.Exists(path));
        }
        finally { File.Delete(path); }
    }

    [Theory]
    [InlineData("--verify-ready-consent", null)]
    [InlineData("--verify-ready-consent", "0")]
    [InlineData("--other", "1")]
    public void RequiresBothExplicitSelections(string command, string? gate)
    {
        int factories = 0;
        var result = CommandDispatcher.VerifyReadyConsent([command], _ => gate,
            () => { factories++; throw new Exception("Must not construct dependencies"); }, _ => Assert.Fail());
        Assert.False(result.Success);
        Assert.Equal(0, factories);
    }

    [Theory]
    [InlineData(ChromeConnectionConsentDecision.Continue, true)]
    [InlineData(ChromeConnectionConsentDecision.Cancel, true)]
    [InlineData(ChromeConnectionConsentDecision.DisplayFailed, false)]
    public void OfflineDecisionReturnsDirectlyWithoutBrowserFactory(ChromeConnectionConsentDecision decision, bool success)
    {
        var consent = new FixedConsent(decision);
        var markers = new List<string>();
        var result = CommandDispatcher.VerifyReadyConsent(["--verify-ready-consent"], _ => "1", () => consent, markers.Add);
        Assert.Equal(success, result.Success);
        Assert.Equal(1, consent.Calls);
        Assert.Contains("decision=" + decision, Assert.Single(markers));
    }

    [Fact]
    public void ExtraArgumentsAreRejectedBeforeConsentFactory()
    {
        var result = CommandDispatcher.VerifyReadyConsent(["--verify-ready-consent", "extra"], _ => "1",
            () => throw new Exception("Must not invoke"), _ => Assert.Fail());
        Assert.False(result.Success);
    }

    private sealed class FixedConsent(ChromeConnectionConsentDecision decision) : IChromeConnectionConsent
    {
        public int Calls { get; private set; }
        public ChromeConnectionConsentDecision ConfirmReady() { Calls++; return decision; }
        public ChromeConnectionConsentDecision ConfirmRetry(string errorCode) => throw new Exception("No retry in verifier");
    }
}
