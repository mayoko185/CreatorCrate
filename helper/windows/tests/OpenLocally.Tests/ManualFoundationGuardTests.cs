using OpenLocally.Tests.Manual;

namespace OpenLocally.Tests;

public sealed class ManualFoundationGuardTests
{
    [Fact]
    public async Task FixtureRefusesToCreateListenerWithoutExplicitOptIn()
    {
        string? prior = Environment.GetEnvironmentVariable(ManualFoundationGuard.EnvironmentVariable);
        try
        {
            Environment.SetEnvironmentVariable(ManualFoundationGuard.EnvironmentVariable, null);
            await Assert.ThrowsAsync<InvalidOperationException>(() => ManualCreatorCrateFixture.StartAsync());
        }
        finally
        {
            Environment.SetEnvironmentVariable(ManualFoundationGuard.EnvironmentVariable, prior);
        }
    }
}
