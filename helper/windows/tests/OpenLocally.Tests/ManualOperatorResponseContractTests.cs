using System.Diagnostics;

namespace OpenLocally.Tests;

public sealed class ManualOperatorResponseContractTests
{
    [Fact]
    public void WrapperOperatorResponseChannel_WritesOnlyAtomicCorrelatedJsonWithoutManualOptIn()
    {
        string root = PublishedProductionGateProcessTests.FindRepositoryRoot();
        string script = Path.Combine(root, "helper", "windows", "tests", "OpenLocally.Tests", "Manual", "run-m2-foundation.ps1");
        var start = new ProcessStartInfo("powershell.exe")
        {
            WorkingDirectory = root,
            UseShellExecute = false,
            CreateNoWindow = true,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
        };
        foreach (string argument in new[]
        {
            "-NoProfile",
            "-ExecutionPolicy",
            "Bypass",
            "-File",
            script,
            "-RepositoryRoot",
            root,
            "-VerifyOperatorResponseChannel",
        })
        {
            start.ArgumentList.Add(argument);
        }
        start.Environment.Remove("CREATORCRATE_M2_MANUAL");

        using Process process = Process.Start(start)
            ?? throw new InvalidOperationException("Could not start the operator-response contract process.");
        Assert.True(process.WaitForExit(30_000), "The operator-response contract process timed out.");

        string stdout = process.StandardOutput.ReadToEnd();
        string stderr = process.StandardError.ReadToEnd();
        Assert.True(process.ExitCode == 0, $"The operator-response contract process failed with exit code {process.ExitCode}. stdout: {stdout} stderr: {stderr}");
        Assert.Contains("Operator response channel self-test passed.", stdout, StringComparison.Ordinal);

        string wrapper = File.ReadAllText(script);
        Assert.Contains("'operator_confirmation_required'", wrapper, StringComparison.Ordinal);
        Assert.Contains("RequestId = $RequestId; Answer = $Answer", wrapper, StringComparison.Ordinal);
        Assert.DoesNotContain("Press Enter to continue the active Manual stage", wrapper, StringComparison.Ordinal);
    }
}
