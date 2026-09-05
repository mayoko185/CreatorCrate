using System.Diagnostics;
using System.Text.Json;
using OpenLocally.Tests.Manual;

namespace OpenLocally.Tests;

public sealed class ManualTokenDiagnosticsTests
{
    [Theory]
    [InlineData(1, "default")]
    [InlineData(2, "full")]
    [InlineData(3, "limited")]
    [InlineData(99, "unknown")]
    public void NormalizeElevationType_UsesTheSharedStableVocabulary(int rawValue, string expected)
    {
        ManualTokenDiagnostics result = ManualTokenDiagnostics.FromTokenInformation(
            processId: 1,
            elevation: 1,
            elevationType: rawValue,
            integrityRid: 0x2000,
            isAppContainer: 0,
            inspectionStatus: "synthetic");

        Assert.Equal(expected, result.ElevationType);
    }

    [Theory]
    [InlineData(0x1000, "low")]
    [InlineData(0x2000, "medium")]
    [InlineData(0x3000, "high")]
    [InlineData(0x4000, "system")]
    [InlineData(0x2fff, "unknown/12287")]
    public void NormalizeIntegrityLevel_UsesExactMandatoryIntegrityRids(int rawRid, string expected)
    {
        ManualTokenDiagnostics result = ManualTokenDiagnostics.FromTokenInformation(
            processId: 1,
            elevation: 0,
            elevationType: 3,
            integrityRid: rawRid,
            isAppContainer: 1,
            inspectionStatus: "synthetic");

        Assert.Equal(expected, result.IntegrityLevel);
    }

    [Fact]
    public void FromTokenInformation_UsesComparableBooleanAndUnknownValues()
    {
        ManualTokenDiagnostics known = ManualTokenDiagnostics.FromTokenInformation(
            processId: 42,
            elevation: 1,
            elevationType: 2,
            integrityRid: 0x2100,
            isAppContainer: 0,
            inspectionStatus: "synthetic");
        ManualTokenDiagnostics unknown = ManualTokenDiagnostics.FromTokenInformation(
            processId: 42,
            elevation: 7,
            elevationType: null,
            integrityRid: null,
            isAppContainer: 7,
            inspectionStatus: "synthetic");

        Assert.True(known.IsElevated);
        Assert.Equal("full", known.ElevationType);
        Assert.Equal("medium_plus", known.IntegrityLevel);
        Assert.False(known.IsAppContainer);
        Assert.Null(unknown.IsElevated);
        Assert.Equal("unknown", unknown.ElevationType);
        Assert.Equal("unknown", unknown.IntegrityLevel);
        Assert.Null(unknown.IsAppContainer);
    }

    [Fact]
    public void InspectCurrentProcess_ReadsOnlyNormalizedCurrentProcessTokenFacts()
    {
        using Process current = Process.GetCurrentProcess();

        ManualTokenDiagnostics result = ManualTokenDiagnostics.InspectCurrentProcess();

        Assert.Equal(current.Id, result.ProcessId);
        Assert.Contains(result.ElevationType, ["default", "full", "limited", "unknown"]);
        Assert.Matches("^(untrusted|low|medium|medium_plus|high|system|protected|unknown|unknown/[0-9]+)$", result.IntegrityLevel);
        Assert.Equal("ok", result.InspectionStatus);
    }

    [Fact]
    public void PowerShellWrapper_ReportsTheCommonTokenDiagnosticSchemaWithoutManualOptIn()
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
            "-VerifyTokenDiagnostics",
        })
        {
            start.ArgumentList.Add(argument);
        }
        start.Environment.Remove("CREATORCRATE_M2_MANUAL");

        using Process process = Process.Start(start)
            ?? throw new InvalidOperationException("Could not start the token-diagnostic contract process.");
        Assert.True(process.WaitForExit(30_000), "The token-diagnostic contract process timed out.");

        string stdout = process.StandardOutput.ReadToEnd();
        string stderr = process.StandardError.ReadToEnd();
        Assert.True(
            process.ExitCode == 0,
            $"The token-diagnostic contract process failed with exit code {process.ExitCode}. stdout: {stdout} stderr: {stderr}");

        using JsonDocument document = JsonDocument.Parse(stdout);
        JsonElement rootElement = document.RootElement;
        Assert.Equal(JsonValueKind.Number, rootElement.GetProperty("ProcessId").ValueKind);
        AssertBooleanOrNull(rootElement.GetProperty("IsElevated"));
        Assert.Equal(JsonValueKind.String, rootElement.GetProperty("ElevationType").ValueKind);
        Assert.Equal(JsonValueKind.String, rootElement.GetProperty("IntegrityLevel").ValueKind);
        AssertBooleanOrNull(rootElement.GetProperty("IsAppContainer"));
        Assert.Equal(JsonValueKind.String, rootElement.GetProperty("InspectionStatus").ValueKind);

        ManualTokenDiagnostics csharp = ManualTokenDiagnostics.FromTokenInformation(
            processId: 1,
            elevation: 0,
            elevationType: 3,
            integrityRid: 0x2000,
            isAppContainer: 0,
            inspectionStatus: "synthetic");
        using JsonDocument csharpDocument = JsonDocument.Parse(JsonSerializer.Serialize(csharp));
        JsonElement csharpElement = csharpDocument.RootElement;

        string[] expectedProperties =
        [
            "ProcessId",
            "IsElevated",
            "ElevationType",
            "IntegrityLevel",
            "IsAppContainer",
            "InspectionStatus",
        ];
        Assert.Equal(expectedProperties.OrderBy(name => name), rootElement.EnumerateObject().Select(property => property.Name).OrderBy(name => name));
        Assert.Equal(expectedProperties.OrderBy(name => name), csharpElement.EnumerateObject().Select(property => property.Name).OrderBy(name => name));
        foreach (string property in expectedProperties)
        {
            Assert.Equal(csharpElement.GetProperty(property).ValueKind, rootElement.GetProperty(property).ValueKind);
        }
    }

    private static void AssertBooleanOrNull(JsonElement value)
        => Assert.True(value.ValueKind is JsonValueKind.True or JsonValueKind.False or JsonValueKind.Null);
}
