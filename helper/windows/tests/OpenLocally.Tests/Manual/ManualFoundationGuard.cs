namespace OpenLocally.Tests.Manual;

/// <summary>One explicit gate for every live/manual side effect in this test-only harness.</summary>
internal static class ManualFoundationGuard
{
    internal const string EnvironmentVariable = "CREATORCRATE_M2_MANUAL";

    internal static void RequireOptIn()
    {
        if (!string.Equals(Environment.GetEnvironmentVariable(EnvironmentVariable), "1", StringComparison.Ordinal))
            throw new InvalidOperationException("The Milestone 2 manual foundation harness requires CREATORCRATE_M2_MANUAL=1.");
    }
}
