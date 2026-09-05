using System.Diagnostics;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;

namespace OpenLocally.Tests;

public sealed class ManualWrapperLaunchContractTests
{
    [Fact]
    public void Wrapper_PerformsTheParentPublishedHelperPreflightBeforeStartingVSTest()
    {
        string root = PublishedProductionGateProcessTests.FindRepositoryRoot();
        string script = File.ReadAllText(Path.Combine(
            root,
            "helper",
            "windows",
            "tests",
            "OpenLocally.Tests",
            "Manual",
            "run-m2-foundation.ps1"));

        int parentPreflight = script.LastIndexOf(
            "Invoke-ParentProductionGatePreflight -Helper $helper",
            StringComparison.Ordinal);
        int workflow = script.LastIndexOf(
            "Invoke-ManualWorkflow -RepositoryRoot",
            StringComparison.Ordinal);

        Assert.True(parentPreflight >= 0);
        Assert.True(workflow > parentPreflight);
        Assert.Contains("Set-ManualProcessStartInfoArguments", script, StringComparison.Ordinal);
        Assert.Contains("$StartInfo.Arguments = Join-WindowsCommandLineArguments -LogicalArguments $LogicalArguments", script, StringComparison.Ordinal);
        Assert.False(script.Contains(".ArgumentList", StringComparison.Ordinal));
        Assert.Contains("Show-ManualLaunchContextComparison", script, StringComparison.Ordinal);
        Assert.Contains("CREATORCRATE_M2_TESTHOST_LAUNCH_CONTEXT", script, StringComparison.Ordinal);
    }

    [Fact]
    public void NormalBranch_RefusesWithoutCallerOptInBeforeAnyManualSetup()
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
        var before = Directory.GetDirectories(Path.GetTempPath(), "CreatorCrate-m2-manual-*")
            .ToHashSet(StringComparer.OrdinalIgnoreCase);

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
        })
        {
            start.ArgumentList.Add(argument);
        }
        start.Environment.Remove("CREATORCRATE_M2_MANUAL");

        using Process process = Process.Start(start)
            ?? throw new InvalidOperationException("Could not start the fail-closed wrapper contract process.");
        Assert.True(process.WaitForExit(30_000), "The fail-closed wrapper contract process timed out.");

        string stdout = process.StandardOutput.ReadToEnd();
        string stderr = process.StandardError.ReadToEnd();
        var after = Directory.GetDirectories(Path.GetTempPath(), "CreatorCrate-m2-manual-*")
            .ToHashSet(StringComparer.OrdinalIgnoreCase);

        Assert.NotEqual(0, process.ExitCode);
        Assert.Contains("Manual workflow is disabled. Set CREATORCRATE_M2_MANUAL=1 explicitly to run it.", stderr, StringComparison.Ordinal);
        Assert.Empty(after.Except(before, StringComparer.Ordinal));
        Assert.DoesNotContain("$env:CREATORCRATE_M2_MANUAL = '1'", File.ReadAllText(script), StringComparison.Ordinal);

        string source = File.ReadAllText(script);
        int guard = source.IndexOf("if ($env:CREATORCRATE_M2_MANUAL -cne '1')", StringComparison.Ordinal);
        Assert.True(guard >= 0);
        Assert.True(source.IndexOf("$work = Join-Path", StringComparison.Ordinal) > guard);
        Assert.True(source.IndexOf("dotnet publish", StringComparison.Ordinal) > guard);
        Assert.True(source.LastIndexOf("Invoke-ParentProductionGatePreflight", StringComparison.Ordinal) > guard);
        Assert.True(source.LastIndexOf("Invoke-ManualWorkflow -RepositoryRoot", StringComparison.Ordinal) > guard);
        Assert.DoesNotContain("Manual harness preparation completed.", stdout, StringComparison.Ordinal);
    }

    [Fact]
    public void ParentPreflight_UsesTheSingleNamedPowerShellContractWithoutManualOptIn()
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
            "-VerifyNativeAppHostPreflight",
        })
        {
            start.ArgumentList.Add(argument);
        }
        start.Environment.Remove("CREATORCRATE_M2_MANUAL");

        using Process process = Process.Start(start)
            ?? throw new InvalidOperationException("Could not start the parent-preflight contract process.");
        Assert.True(process.WaitForExit(30_000), "The parent-preflight contract process timed out.");

        string stdout = process.StandardOutput.ReadToEnd();
        string stderr = process.StandardError.ReadToEnd();
        Assert.True(
            process.ExitCode == 0,
            $"The parent-preflight contract process failed with exit code {process.ExitCode}. stdout: {stdout} stderr: {stderr}");

        using JsonDocument document = JsonDocument.Parse(stdout);
        JsonElement result = document.RootElement;
        Assert.Equal("parent-wrapper", result.GetProperty("Invocation").GetString());
        Assert.Equal(new[] { "__AllParameterSets" }, result.GetProperty("ParameterSets").EnumerateArray().Select(value => value.GetString()));
        Assert.True(result.GetProperty("ReadAccessConfirmed").GetBoolean());
        Assert.True(File.Exists(result.GetProperty("ExecutablePath").GetString()));
        Assert.True(Directory.Exists(result.GetProperty("WorkingDirectory").GetString()));

        string parentInvocation = "Test-NativeAppHostPreflight -Executable $Helper -WorkingDirectory $WorkingDirectory";
        Assert.Contains(parentInvocation, File.ReadAllText(script), StringComparison.Ordinal);
    }

    [Fact]
    public void PowerShell51Wrapper_RoundTripsActualProcessStartInfoArgumentsWithoutManualOptIn()
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
            "-VerifyProcessStartInfoArguments",
        })
        {
            start.ArgumentList.Add(argument);
        }
        start.Environment.Remove("CREATORCRATE_M2_MANUAL");

        using Process process = Process.Start(start)
            ?? throw new InvalidOperationException("Could not start the PowerShell 5.1 argument contract process.");
        Assert.True(process.WaitForExit(30_000), "The PowerShell 5.1 argument contract process timed out.");

        string stdout = process.StandardOutput.ReadToEnd();
        string stderr = process.StandardError.ReadToEnd();
        Assert.True(
            process.ExitCode == 0,
            $"The PowerShell 5.1 argument contract process failed with exit code {process.ExitCode}. stdout: {stdout} stderr: {stderr}");

        using JsonDocument document = JsonDocument.Parse(stdout);
        JsonElement result = document.RootElement;
        Assert.Equal("powershell-5.1-process-start-info-arguments", result.GetProperty("Invocation").GetString());
        Assert.StartsWith("5.1.", result.GetProperty("PowerShellVersion").GetString());

        JsonElement.ArrayEnumerator cases = result.GetProperty("Cases").EnumerateArray();
        Assert.Equal(
            new[] { "social-uri", "spaces", "quotes-and-backslashes", "empty", "switches" },
            cases.Select(value => value.GetProperty("Name").GetString()));
        Assert.Equal(
            new[] { 1, 1, 3, 1, 2 },
            result.GetProperty("Cases").EnumerateArray().Select(value => value.GetProperty("ArgumentCount").GetInt32()));
    }

    [Fact]
    public void ParentAndTestHost_UseTheExactSharedDiagnosticSocialUriWithoutPrintingIt()
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

        (int exitCode, string stdout, string stderr) = RunParentVerifier(root, script, "-VerifyDiagnosticSocialUri");
        Assert.True(exitCode == 0, $"The diagnostic URI verifier failed with exit code {exitCode}. stdout: {stdout} stderr: {stderr}");

        using JsonDocument document = JsonDocument.Parse(stdout);
        JsonElement result = document.RootElement;
        string expectedUri = DiagnosticSocialRequest.CreateProductionGateUri();
        string expectedHash = Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(expectedUri))).ToLowerInvariant();
        SocialUriParseResult parsed = SocialUriRequestParser.Parse(expectedUri);
        string harness = File.ReadAllText(Path.Combine(
            root,
            "helper",
            "windows",
            "tests",
            "OpenLocally.Tests",
            "Manual",
            "ManualFoundationHarnessTests.cs"));
        string wrapper = File.ReadAllText(script);

        Assert.Equal("parent-wrapper-diagnostic-social-uri", result.GetProperty("Invocation").GetString());
        Assert.Equal(1, result.GetProperty("ArgumentCount").GetInt32());
        Assert.Equal(expectedHash, result.GetProperty("UriSha256").GetString());
        Assert.True(parsed.Success);
        Assert.Contains("$env:CREATORCRATE_M2_DIAGNOSTIC_SOCIAL_URI = $diagnosticUri", wrapper, StringComparison.Ordinal);
        Assert.Contains("DiagnosticSocialRequest.RequireFromEnvironment()", harness, StringComparison.Ordinal);
    }

    [Fact]
    public void TestHost_RecordsPreflightDiagnosticsBeforeLaunchingThePublishedHelper()
    {
        string root = PublishedProductionGateProcessTests.FindRepositoryRoot();
        string harness = File.ReadAllText(Path.Combine(
            root,
            "helper",
            "windows",
            "tests",
            "OpenLocally.Tests",
            "Manual",
            "ManualFoundationHarnessTests.cs"));

        int preflight = harness.IndexOf(
            "ManualNativeAppHostPreflight.Inspect(helper, start.WorkingDirectory)",
            StringComparison.Ordinal);
        int record = harness.IndexOf(
            "ManualNativeAppHostPreflight.RecordTestHostLaunch",
            StringComparison.Ordinal);
        int start = harness.IndexOf(
            "Process.Start(start)",
            StringComparison.Ordinal);

        Assert.True(preflight >= 0);
        Assert.True(record > preflight);
        Assert.True(start > record);
    }

    private static (int ExitCode, string Stdout, string Stderr) RunParentVerifier(string root, string script, string verifier)
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
            "-ExecutionPolicy",
            "Bypass",
            "-File",
            script,
            "-RepositoryRoot",
            root,
            verifier,
        })
        {
            start.ArgumentList.Add(argument);
        }
        start.Environment.Remove("CREATORCRATE_M2_MANUAL");

        using Process process = Process.Start(start)
            ?? throw new InvalidOperationException("Could not start the parent diagnostic contract process.");
        Assert.True(process.WaitForExit(30_000), "The parent diagnostic contract process timed out.");
        return (process.ExitCode, process.StandardOutput.ReadToEnd(), process.StandardError.ReadToEnd());
    }
}
