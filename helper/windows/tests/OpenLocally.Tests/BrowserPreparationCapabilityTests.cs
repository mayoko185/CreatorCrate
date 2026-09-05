using System.Reflection;
using OpenLocally;

namespace OpenLocally.Tests;

public sealed class BrowserPreparationCapabilityTests
{
    [Fact]
    public void AdapterContext_ExposesBoundedTargetsWithoutRawCdpOrArbitraryLifecycle()
    {
        PropertyInfo browserTargets = typeof(PlatformPreparationContext)
            .GetProperty(nameof(PlatformPreparationContext.BrowserTargets))!;

        Assert.Equal(typeof(BrowserPreparationTargets), browserTargets.PropertyType);
        Assert.False(typeof(CdpTargetManager).IsPublic);
        Assert.Null(typeof(BrowserPreparationTargets).GetMethod("CloseTargetAsync", PublicInstanceMethods));
        Assert.Null(typeof(BrowserPreparationTargets).GetMethod("CreateTargetAsync", PublicInstanceMethods));
        Assert.DoesNotContain(typeof(BrowserPreparationTargets).GetMethods(PublicInstanceMethods), method =>
            method.ReturnType == typeof(CdpSession) ||
            method.ReturnType == typeof(CdpTargetManager) ||
            method.GetParameters().Any(parameter => parameter.ParameterType == typeof(CdpSession) || parameter.ParameterType == typeof(CdpTargetManager)));
        Assert.DoesNotContain(typeof(BrowserPreparationSession).GetProperties(PublicInstanceMethods), property => property.PropertyType == typeof(CdpSession));
        Assert.DoesNotContain(typeof(BrowserPreparationSession).GetMethods(PublicInstanceMethods), method =>
            method.IsStatic && method.GetParameters().Any(parameter => parameter.ParameterType == typeof(CdpTargetManager)));
    }

    private static readonly BindingFlags PublicInstanceMethods = BindingFlags.Instance |
        BindingFlags.Public |
        BindingFlags.DeclaredOnly;
}
