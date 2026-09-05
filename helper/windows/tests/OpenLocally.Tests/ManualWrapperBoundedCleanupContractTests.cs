using System.Diagnostics;
using System.Text.RegularExpressions;

namespace OpenLocally.Tests;

public sealed class ManualWrapperBoundedCleanupContractTests
{
    [Fact]
    public void PowerShell51Wrapper_ExercisesBoundedCleanupAndFinalEventDrainWithoutManualOptIn()
    {
        string root = PublishedProductionGateProcessTests.FindRepositoryRoot();
        string script = Path.Combine(
            root,
            "helper",
            "windows",
            "tests",
            "OpenLocally.Tests",
            "Manual",
            "run-m2-foundation.ps1");

        var rootsBefore = Directory.GetDirectories(Path.GetTempPath(), "CreatorCrate-m2-manual-bounded-wrapper-*")
            .ToHashSet(StringComparer.OrdinalIgnoreCase);

        for (int attempt = 1; attempt <= 10; attempt++)
        {
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
                "-NonInteractive",
                "-ExecutionPolicy",
                "Bypass",
                "-File",
                script,
                "-RepositoryRoot",
                root,
                "-VerifyBoundedWorkflowWrapper",
            })
            {
                start.ArgumentList.Add(argument);
            }
            start.Environment.Remove("CREATORCRATE_M2_MANUAL");

            using Process process = Process.Start(start)
                ?? throw new InvalidOperationException("Could not start the bounded-wrapper contract process.");
            Assert.True(process.WaitForExit(45_000), $"The bounded-wrapper contract process timed out on attempt {attempt}.");

            string stdout = process.StandardOutput.ReadToEnd();
            string stderr = process.StandardError.ReadToEnd();
            Assert.True(
                process.ExitCode == 0,
                $"The bounded-wrapper contract process failed on attempt {attempt} with exit code {process.ExitCode}. stdout: {stdout} stderr: {stderr}");
            Assert.Contains("Bounded workflow wrapper self-test passed.", stdout, StringComparison.Ordinal);
            var rootsAfter = Directory.GetDirectories(Path.GetTempPath(), "CreatorCrate-m2-manual-bounded-wrapper-*")
                .ToHashSet(StringComparer.OrdinalIgnoreCase);
            Assert.Empty(rootsAfter.Except(rootsBefore, StringComparer.OrdinalIgnoreCase));
        }
    }

    [Fact]
    public void Wrapper_UsesFiniteWaitForExitCallsAndExplicitTerminationDiagnostics()
    {
        string script = File.ReadAllText(Path.Combine(
            PublishedProductionGateProcessTests.FindRepositoryRoot(),
            "helper",
            "windows",
            "tests",
            "OpenLocally.Tests",
            "Manual",
            "run-m2-foundation.ps1"));

        Assert.DoesNotMatch(new Regex(@"\.WaitForExit\(\s*\)", RegexOptions.CultureInvariant), script);
        Assert.Contains("$ManualWorkflowTerminatorTimeoutMilliseconds = 3000", script, StringComparison.Ordinal);
        Assert.Contains("$ManualWorkflowChildCleanupTimeoutMilliseconds = 5000", script, StringComparison.Ordinal);
        Assert.Contains("$ManualWorkflowControlledFailureExitGraceTimeoutMilliseconds = 15000", script, StringComparison.Ordinal);
        Assert.Contains("terminator_timeout", script, StringComparison.Ordinal);
        Assert.Contains("terminator_nonzero", script, StringComparison.Ordinal);
        Assert.Contains("child_exit_timeout", script, StringComparison.Ordinal);
        Assert.Contains("Complete-ManualWrapperVerifierProcessTeardown", script, StringComparison.Ordinal);
        Assert.Contains("[IO.FileShare]::ReadWrite", script, StringComparison.Ordinal);
        Assert.Contains("verifier root still exists", script, StringComparison.Ordinal);
    }
}
