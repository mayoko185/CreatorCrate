using System.Diagnostics;
using Xunit;

namespace OpenLocally.Tests;

public sealed class ManualOperatorInputContractTests
{
    [Fact]
    public void PowerShell51Wrapper_BoundsOperatorInputAndWaitsForChildCleanup()
    {
        var repositoryRoot = FindRepositoryRoot();
        var script = Path.Combine(repositoryRoot, "helper", "windows", "tests", "OpenLocally.Tests", "Manual", "run-m2-foundation.ps1");
        var powershell = Path.Combine(Environment.SystemDirectory, "WindowsPowerShell", "v1.0", "powershell.exe");

        var startInfo = new ProcessStartInfo
        {
            FileName = powershell,
            UseShellExecute = false,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            CreateNoWindow = true,
        };
        startInfo.ArgumentList.Add("-NoProfile");
        startInfo.ArgumentList.Add("-NonInteractive");
        startInfo.ArgumentList.Add("-ExecutionPolicy");
        startInfo.ArgumentList.Add("Bypass");
        startInfo.ArgumentList.Add("-File");
        startInfo.ArgumentList.Add(script);
        startInfo.ArgumentList.Add("-RepositoryRoot");
        startInfo.ArgumentList.Add(repositoryRoot);
        startInfo.ArgumentList.Add("-VerifyOperatorInputDeadline");

        using var process = Process.Start(startInfo);
        Assert.NotNull(process);

        var stdout = process.StandardOutput.ReadToEnd();
        var stderr = process.StandardError.ReadToEnd();
        Assert.True(
            process.WaitForExit(45_000),
            $"The bounded operator-input contract verifier did not finish. stdout: {stdout} stderr: {stderr}");
        Assert.True(
            process.ExitCode == 0,
            $"The bounded operator-input contract verifier failed with exit code {process.ExitCode}. stdout: {stdout} stderr: {stderr}");
    }

    private static string FindRepositoryRoot()
    {
        for (var directory = new DirectoryInfo(AppContext.BaseDirectory); directory is not null; directory = directory.Parent)
        {
            if (File.Exists(Path.Combine(directory.FullName, "package.json"))
                && Directory.Exists(Path.Combine(directory.FullName, "helper", "windows")))
            {
                return directory.FullName;
            }
        }

        throw new DirectoryNotFoundException("Could not locate the CreatorCrate repository root from the test output directory.");
    }
}
