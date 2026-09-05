using System.Diagnostics;
using System.Reflection;

namespace OpenLocally.Tests;

public sealed class PublishedProductionGateProcessTests
{
    [Fact]
    public async Task PublishedHelper_UsesProductionAdapterGateFromDistinctWorkingDirectory()
    {
        string root = Path.Combine(Path.GetTempPath(), "creatorcrate-production-gate-process-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(root);

        try
        {
            string repositoryRoot = FindRepositoryRoot();
            string artifacts = Path.Combine(root, "artifacts");
            string publish = Path.Combine(root, "publish");
            string callerWorkingDirectory = Path.Combine(root, "caller");
            Directory.CreateDirectory(callerWorkingDirectory);

            ProcessResult published = Run(
                "dotnet",
                repositoryRoot,
                [
                    "publish",
                    Path.Combine(repositoryRoot, "helper", "windows", "src", "OpenLocally", "OpenLocally.csproj"),
                    "-c", "Release",
                    "-r", "win-x64",
                    "--self-contained", "true",
                    "-p:PublishSingleFile=true",
                    "--artifacts-path", artifacts,
                    "-o", publish,
                ],
                timeoutMilliseconds: 120_000);
            Assert.True(published.ExitCode == 0, published.Diagnostics("Publishing the isolated helper failed."));

            string helper = Path.Combine(publish, "OpenLocally.exe");
            Assert.True(File.Exists(helper));
            Assert.False(string.Equals(
                Path.TrimEndingDirectorySeparator(publish),
                Path.TrimEndingDirectorySeparator(callerWorkingDirectory),
                StringComparison.OrdinalIgnoreCase));

            await using var fixture = await InProcessCreatorCrateFixture.StartAsync();
            string uri = DiagnosticSocialRequest.CreateUri(fixture.Origin);
            ProcessResult result = Run(
                helper,
                callerWorkingDirectory,
                [uri],
                timeoutMilliseconds: 30_000,
                environment => environment.Remove("CREATORCRATE_M2_MANUAL"));

            Assert.NotEqual(0, result.ExitCode);
            Assert.Equal(string.Empty, result.Stdout);
            Assert.Equal("production_adapters_unavailable", result.Stderr.Trim());
            Assert.DoesNotContain("intent is malformed", result.Stderr, StringComparison.OrdinalIgnoreCase);
            Assert.Equal(0, fixture.RequestCount);
        }
        finally
        {
            if (Directory.Exists(root)) Directory.Delete(root, recursive: true);
        }
    }

    private static ProcessResult Run(
        string fileName,
        string workingDirectory,
        IReadOnlyList<string> arguments,
        int timeoutMilliseconds,
        Action<IDictionary<string, string?>>? configureEnvironment = null)
    {
        var start = new ProcessStartInfo(fileName)
        {
            WorkingDirectory = workingDirectory,
            UseShellExecute = false,
            CreateNoWindow = true,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
        };
        foreach (string argument in arguments) start.ArgumentList.Add(argument);
        configureEnvironment?.Invoke(start.Environment);

        using Process process = Process.Start(start) ?? throw new InvalidOperationException($"Could not start '{fileName}'.");
        Assert.True(process.WaitForExit(timeoutMilliseconds), $"Timed out running '{fileName}'.");
        return new ProcessResult(process.ExitCode, process.StandardOutput.ReadToEnd(), process.StandardError.ReadToEnd(), fileName, workingDirectory);
    }

    internal static string FindRepositoryRoot()
    {
        string? embeddedRoot = typeof(PublishedProductionGateProcessTests).Assembly
            .GetCustomAttributes<AssemblyMetadataAttribute>()
            .SingleOrDefault(attribute => attribute.Key == "CreatorCrate.RepositoryRoot")
            ?.Value;
        if (!string.IsNullOrWhiteSpace(embeddedRoot) &&
            File.Exists(Path.Combine(embeddedRoot, "helper", "windows", "src", "OpenLocally", "OpenLocally.csproj")))
        {
            return embeddedRoot;
        }

        foreach (string start in new[] { Directory.GetCurrentDirectory(), AppContext.BaseDirectory })
        {
            for (DirectoryInfo? current = new(start); current is not null; current = current.Parent)
            {
                if (File.Exists(Path.Combine(current.FullName, "helper", "windows", "src", "OpenLocally", "OpenLocally.csproj")))
                    return current.FullName;
            }
        }

        throw new InvalidOperationException("Could not locate the CreatorCrate repository root.");
    }

    private sealed record ProcessResult(int ExitCode, string Stdout, string Stderr, string ExecutablePath, string WorkingDirectory)
    {
        internal string Diagnostics(string heading) =>
            $"{heading}\nExit code: {ExitCode}\nExecutable path: {ExecutablePath}\nWorking directory: {WorkingDirectory}\nstdout:\n{Stdout}\nstderr:\n{Stderr}";
    }
}
