using OpenLocally.Tests.Manual;

namespace OpenLocally.Tests;

public sealed class ManualSweepGuardSafetyTests
{
    [Fact]
    public void SweepRefusesBeforeCreatingStagingRootWithoutExplicitOptIn()
    {
        string root = Path.Combine(Path.GetTempPath(), "creatorcrate-m2-sweep-guard-" + Guid.NewGuid().ToString("N"));
        string? priorOptIn = Environment.GetEnvironmentVariable(ManualFoundationGuard.EnvironmentVariable);
        string? priorStagingRoot = Environment.GetEnvironmentVariable("CREATORCRATE_M2_MANUAL_STAGING_ROOT");
        try
        {
            Environment.SetEnvironmentVariable(ManualFoundationGuard.EnvironmentVariable, null);
            Environment.SetEnvironmentVariable("CREATORCRATE_M2_MANUAL_STAGING_ROOT", root);

            Assert.False(Directory.Exists(root));
            Assert.Throws<InvalidOperationException>(() => new ManualFoundationHarnessTests().Sweep_UsesOnlyInjectedRootAndDeletesOnlyOldOwnedDirectory());
            Assert.False(Directory.Exists(root));
        }
        finally
        {
            Environment.SetEnvironmentVariable("CREATORCRATE_M2_MANUAL_STAGING_ROOT", priorStagingRoot);
            Environment.SetEnvironmentVariable(ManualFoundationGuard.EnvironmentVariable, priorOptIn);
        }
    }
}
