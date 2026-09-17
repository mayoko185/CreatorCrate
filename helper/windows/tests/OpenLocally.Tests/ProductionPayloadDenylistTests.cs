using System.Diagnostics;
using System.Reflection;

namespace OpenLocally.Tests;

public sealed class ProductionPayloadDenylistTests
{
    public static TheoryData<string, string> ForbiddenArtifacts => new()
    {
        { "d1", "USER-OBJECT-ISOLATION.md" },
        { "d1", Path.Combine("diagnostics", "UserObjectIsolationProof.dll") },
        { "d2a", "USER-OBJECT-ISOLATION.md" },
        { "d2a", Path.Combine("diagnostics", "UserObjectIsolationProcessTests.dll") },
        { "d2a", Path.Combine("diagnostics", "OpenLocally.WinUiHost.Proof.dll") },
        { "d2a", Path.Combine("diagnostics", "OpenLocally.WinUiHost.Proof.Helper.dll") },
        { "d2a", Path.Combine("diagnostics", "LocalOleDropTargetTests.dll") },
        { "d2a", Path.Combine("diagnostics", "LocalOleDropTargetSomethingElse.bin") },
        { "d2a", Path.Combine("diagnostics", "ManualVisualProofFixture.dll") },
        { "d2a", Path.Combine("diagnostics", "ManualVisualProofFixtureData.json") },
        { "d2a", Path.Combine("diagnostics", "OpenLocally.WinUiHost.Proof.Helper", "payload.bin") },
        { "d2a", Path.Combine("diagnostics", "localoledroptargettests", "payload.bin") },
        { "d2a", Path.Combine("diagnostics", "ManualVisualProofFixtureData", "payload.bin") }
    };

    [Theory]
    [MemberData(nameof(ForbiddenArtifacts))]
    public void Validator_RejectsProofOrTestArtifact_AndReportsPath(
        string validator,
        string relativePath)
    {
        using var fixture = new TemporaryDirectory();
        string artifactPath = Path.Combine(fixture.Path, relativePath);
        Directory.CreateDirectory(Path.GetDirectoryName(artifactPath)!);
        File.WriteAllText(artifactPath, "proof-only");

        ProcessResult result = RunFixtureValidator(validator, fixture.Path);

        Assert.NotEqual(0, result.ExitCode);
        Assert.Contains(relativePath, result.CombinedOutput, StringComparison.OrdinalIgnoreCase);
    }

    [Theory]
    [InlineData("d1")]
    [InlineData("d2a")]
    public void Validator_AllowsGenericUserObjectAndIsolationNames(string validator)
    {
        using var fixture = new TemporaryDirectory();
        foreach (string fileName in new[] { "CustomerUser.json", "ObjectModel.json", "IsolationRuntime.json" })
        {
            File.WriteAllText(Path.Combine(fixture.Path, fileName), "production-content");
        }

        ProcessResult result = RunFixtureValidator(validator, fixture.Path);

        Assert.True(result.ExitCode == 0, result.CombinedOutput);
    }

    [Fact]
    public void ProductionValidator_WithoutArguments_ValidatesCanonicalRepositoryPublish()
    {
        string root = RepositoryRoot();
        string expectedPath = CanonicalPublishPath(root);

        ProcessResult result = RunProductionValidator(
            ProductionValidatorPath(root),
            root);

        Assert.True(result.ExitCode == 0, result.CombinedOutput);
        Assert.DoesNotContain("-PublishPath", result.Arguments);
        Assert.DoesNotContain("-DenylistFixturePath", result.Arguments);
        Assert.Contains($"Publish path: {expectedPath}", result.CombinedOutput,
            StringComparison.OrdinalIgnoreCase);
        Assert.Contains("Publish files: 450", result.CombinedOutput, StringComparison.Ordinal);
        Assert.Contains("PDB files: 0", result.CombinedOutput, StringComparison.Ordinal);
        Assert.Contains("Proof/test artifacts: 0", result.CombinedOutput, StringComparison.Ordinal);
    }

    [Fact]
    public void ProductionValidator_WithoutArguments_FromOutsideRepository_UsesCanonicalRepositoryPublish()
    {
        string root = RepositoryRoot();
        string expectedPath = CanonicalPublishPath(root);
        using var workingDirectory = new TemporaryDirectory();

        ProcessResult result = RunProductionValidator(
            ProductionValidatorPath(root),
            workingDirectory.Path);

        Assert.True(result.ExitCode == 0, result.CombinedOutput);
        Assert.DoesNotContain("-PublishPath", result.Arguments);
        Assert.DoesNotContain("-DenylistFixturePath", result.Arguments);
        Assert.Contains($"Publish path: {expectedPath}", result.CombinedOutput,
            StringComparison.OrdinalIgnoreCase);
    }

    [Fact]
    public void ProductionValidator_WithoutArguments_WhenCanonicalPublishIsMissing_ReportsDirectoryNotFound()
    {
        using var isolatedRepository = new TemporaryDirectory();
        string scriptsDirectory = Path.Combine(
            isolatedRepository.Path, "helper", "windows", "scripts");
        Directory.CreateDirectory(scriptsDirectory);
        string isolatedValidatorPath = Path.Combine(
            scriptsDirectory, "validate-production-publish.ps1");
        File.Copy(ProductionValidatorPath(RepositoryRoot()), isolatedValidatorPath);
        string expectedMissingPath = CanonicalPublishPath(isolatedRepository.Path);

        ProcessResult result = RunProductionValidator(
            isolatedValidatorPath,
            isolatedRepository.Path);

        Assert.NotEqual(0, result.ExitCode);
        Assert.DoesNotContain("-PublishPath", result.Arguments);
        Assert.DoesNotContain("-DenylistFixturePath", result.Arguments);
        Assert.Contains(
            "Production publish directory not found:",
            result.CombinedOutput,
            StringComparison.Ordinal);
        Assert.Contains(expectedMissingPath, result.CombinedOutput,
            StringComparison.OrdinalIgnoreCase);
    }

    [Fact]
    public void ProductionValidator_AcceptsExplicitCanonicalPublishPath()
    {
        string root = RepositoryRoot();
        string publishPath = CanonicalPublishPath(root);

        ProcessResult result = RunProductionValidator(
            ProductionValidatorPath(root),
            root,
            publishPath);

        Assert.True(result.ExitCode == 0, result.CombinedOutput);
        Assert.Contains("-PublishPath", result.Arguments);
        Assert.DoesNotContain("-DenylistFixturePath", result.Arguments);
        Assert.Contains($"Publish path: {publishPath}", result.CombinedOutput,
            StringComparison.OrdinalIgnoreCase);
    }

    private static ProcessResult RunFixtureValidator(string validator, string fixturePath)
    {
        string root = RepositoryRoot();
        string scriptPath;
        string fixtureParameter;
        if (validator == "d1")
        {
            scriptPath = Path.Combine(root, "helper", "windows", "scripts", "validate-production-publish.ps1");
            fixtureParameter = "-DenylistFixturePath";
        }
        else
        {
            scriptPath = Path.Combine(root, "helper", "windows", "installer", "validate-installer.ps1");
            fixtureParameter = "-PayloadDenylistFixturePath";
        }

        var arguments = new List<string>();
        if (validator == "d1")
        {
            arguments.Add("-PublishPath");
            arguments.Add(fixturePath);
        }
        arguments.Add(fixtureParameter);
        arguments.Add(fixturePath);

        return RunPowerShellScript(scriptPath, root, arguments);
    }

    private static ProcessResult RunProductionValidator(
        string scriptPath,
        string workingDirectory,
        string? publishPath = null)
    {
        var arguments = new List<string>();
        if (publishPath is not null)
        {
            arguments.Add("-PublishPath");
            arguments.Add(publishPath);
        }

        return RunPowerShellScript(scriptPath, workingDirectory, arguments);
    }

    private static ProcessResult RunPowerShellScript(
        string scriptPath,
        string workingDirectory,
        IReadOnlyList<string> scriptArguments)
    {
        var start = new ProcessStartInfo("pwsh")
        {
            WorkingDirectory = workingDirectory,
            UseShellExecute = false,
            CreateNoWindow = true,
            RedirectStandardOutput = true,
            RedirectStandardError = true
        };
        var arguments = new List<string>
        {
            "-NoProfile",
            "-ExecutionPolicy",
            "Bypass",
            "-File",
            scriptPath
        };
        arguments.AddRange(scriptArguments);
        foreach (string argument in arguments)
        {
            start.ArgumentList.Add(argument);
        }

        using Process process = Process.Start(start)!;
        string standardOutput = process.StandardOutput.ReadToEnd();
        string standardError = process.StandardError.ReadToEnd();
        process.WaitForExit();
        return new ProcessResult(process.ExitCode, standardOutput + standardError, arguments);
    }

    private static string ProductionValidatorPath(string repositoryRoot) => Path.Combine(
        repositoryRoot, "helper", "windows", "scripts", "validate-production-publish.ps1");

    private static string CanonicalPublishPath(string repositoryRoot) => Path.GetFullPath(Path.Combine(
        repositoryRoot, "dist", "windows-helper", "production", "win-x64"));

    private static string RepositoryRoot()
    {
        string? root = Assembly.GetExecutingAssembly()
            .GetCustomAttributes<AssemblyMetadataAttribute>()
            .SingleOrDefault(attribute => attribute.Key == "CreatorCrate.RepositoryRoot")
            ?.Value;
        return root ?? throw new InvalidOperationException("Repository root assembly metadata is missing.");
    }

    private sealed class TemporaryDirectory : IDisposable
    {
        public TemporaryDirectory()
        {
            Path = System.IO.Path.Combine(
                System.IO.Path.GetTempPath(),
                "CreatorCrate-PayloadDenylist-" + Guid.NewGuid().ToString("N"));
            Directory.CreateDirectory(Path);
        }

        public string Path { get; }

        public void Dispose() => Directory.Delete(Path, recursive: true);
    }

    private sealed record ProcessResult(
        int ExitCode,
        string CombinedOutput,
        IReadOnlyList<string> Arguments);
}
