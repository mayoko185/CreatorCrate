namespace OpenLocally.Tests;

public sealed class ManualWrapperRecoveryContractTests
{
    [Fact]
    public void RecoveryOnlyBranch_RetriesOwnedWorkspaceCleanupAndReturnsBeforeManualExecution()
    {
        string scriptPath = Path.Combine(
            PublishedProductionGateProcessTests.FindRepositoryRoot(),
            "helper",
            "windows",
            "tests",
            "OpenLocally.Tests",
            "Manual",
            "run-m2-foundation.ps1");
        string script = File.ReadAllText(scriptPath);

        int recoveryStart = script.IndexOf("if (-not [string]::IsNullOrWhiteSpace($RecoverFrom))", StringComparison.Ordinal);
        int workflowStart = script.IndexOf("Invoke-ManualWorkflow -RepositoryRoot", StringComparison.Ordinal);
        Assert.True(recoveryStart >= 0);
        Assert.True(workflowStart > recoveryStart);

        string recoveryOnly = script[recoveryStart..workflowStart];
        Assert.Contains("Remove-ManualWorkspaceWithRetry -Workspace $workspace", recoveryOnly, StringComparison.Ordinal);
        Assert.Contains("return", recoveryOnly, StringComparison.Ordinal);
        Assert.DoesNotContain("Invoke-ManualWorkflow", recoveryOnly, StringComparison.Ordinal);
    }
}
