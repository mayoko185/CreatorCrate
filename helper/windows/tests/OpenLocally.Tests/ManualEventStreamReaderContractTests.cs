using System.Diagnostics;

namespace OpenLocally.Tests;

public sealed class ManualEventStreamReaderContractTests
{
    [Fact]
    public void EventStreamReader_HandlesSplitMultipleAndTerminalRecordsWithoutManualOptIn()
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
            "-VerifyEventStreamReader",
        })
        {
            start.ArgumentList.Add(argument);
        }
        start.Environment.Remove("CREATORCRATE_M2_MANUAL");

        using Process process = Process.Start(start)
            ?? throw new InvalidOperationException("Could not start the event-stream reader contract process.");
        Assert.True(process.WaitForExit(30_000), "The event-stream reader contract process timed out.");

        string stdout = process.StandardOutput.ReadToEnd();
        string stderr = process.StandardError.ReadToEnd();
        Assert.True(
            process.ExitCode == 0,
            $"The event-stream reader contract process failed with exit code {process.ExitCode}. stdout: {stdout} stderr: {stderr}");
        Assert.Contains("Event stream framing self-test passed.", stdout, StringComparison.Ordinal);
    }
}
