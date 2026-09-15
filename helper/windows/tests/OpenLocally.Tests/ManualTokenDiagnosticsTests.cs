using System.Diagnostics;
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

}
