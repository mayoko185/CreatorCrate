using System.Diagnostics;
using System.Text.Json;
using OpenLocally.Tests.Manual;

namespace OpenLocally.Tests;

public sealed class ManualNativeAppHostPreflightTests
{
    [Fact]
    public void Inspect_ConfirmsAnExistingExecutableAndOwnedWorkingDirectoryWithoutLaunching()
    {
        string executable = Environment.ProcessPath
            ?? throw new InvalidOperationException("The test host must expose its executable path.");
        string workingDirectory = Path.Combine(Path.GetTempPath(), "creatorcrate-native-preflight-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(workingDirectory);

        try
        {
            ManualNativeAppHostPreflightResult result = ManualNativeAppHostPreflight.Inspect(executable, workingDirectory);

            Assert.Equal(Path.GetFullPath(executable), result.ExecutablePath);
            Assert.Equal(Path.GetFullPath(workingDirectory), result.WorkingDirectory);
            Assert.NotEmpty(result.ExecutableFinalPath);
            Assert.True(result.ReadAccessConfirmed);
        }
        finally
        {
            if (Directory.Exists(workingDirectory)) Directory.Delete(workingDirectory, recursive: true);
        }
    }

    [Fact]
    public void Inspect_ReportsTheExactFailedPreflightCheckBeforeAnyLaunch()
    {
        string workingDirectory = Path.Combine(Path.GetTempPath(), "creatorcrate-native-preflight-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(workingDirectory);

        try
        {
            InvalidOperationException error = Assert.Throws<InvalidOperationException>(
                () => ManualNativeAppHostPreflight.Inspect(Path.Combine(workingDirectory, "missing.exe"), workingDirectory));

            Assert.Contains("[file-exists]", error.Message, StringComparison.Ordinal);
        }
        finally
        {
            if (Directory.Exists(workingDirectory)) Directory.Delete(workingDirectory, recursive: true);
        }
    }

    [Fact]
    public void RecordTestHostLaunch_WritesOnlySelectedLaunchContext()
    {
        string executable = Environment.ProcessPath
            ?? throw new InvalidOperationException("The test host must expose its executable path.");
        string root = Path.Combine(Path.GetTempPath(), "creatorcrate-native-context-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(root);
        string contextPath = Path.Combine(root, "testhost-context.json");

        try
        {
            ManualNativeAppHostPreflightResult preflight = ManualNativeAppHostPreflight.Inspect(executable, root);
            var start = new ProcessStartInfo(executable)
            {
                WorkingDirectory = root,
                UseShellExecute = false,
                RedirectStandardOutput = true,
                RedirectStandardError = true,
            };
            start.ArgumentList.Add("--diagnostic");

            ManualNativeAppHostPreflight.RecordTestHostLaunch(contextPath, preflight, start);

            ManualNativeAppHostLaunchContext? context = JsonSerializer.Deserialize<ManualNativeAppHostLaunchContext>(
                File.ReadAllText(contextPath));

            Assert.NotNull(context);
            Assert.Equal("VSTest testhost", context!.Launcher);
            Assert.Equal(preflight.ExecutablePath, context.ExecutablePath);
            Assert.True(context.ExecutableExists);
            Assert.True(context.ReadAccessConfirmed);
            Assert.Equal(context.ProcessId, context.TokenProcessId);
            Assert.Contains(context.ElevationType, ["default", "full", "limited", "unknown"]);
            Assert.Matches("^(untrusted|low|medium|medium_plus|high|system|protected|unknown|unknown/[0-9]+)$", context.IntegrityLevel);
            Assert.Equal("ok", context.TokenInspectionStatus);
            Assert.DoesNotContain(context.DotnetEnvironmentVariables, value => !value.StartsWith("DOTNET_", StringComparison.OrdinalIgnoreCase));
            Assert.Equal(1, context.ArgumentCount);
        }
        finally
        {
            if (Directory.Exists(root)) Directory.Delete(root, recursive: true);
        }
    }
}
