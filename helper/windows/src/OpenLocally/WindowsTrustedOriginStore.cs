using Microsoft.Win32;
namespace OpenLocally;
public sealed class WindowsTrustedOriginStore : ITrustedOriginStore
{
    internal const string RegistryPath = @"Software\CreatorCrate\SocialPreparation\TrustedOrigins";
    public bool IsTrusted(SocialOrigin origin)
    {
        using RegistryKey? key = Registry.CurrentUser.OpenSubKey(RegistryPath, writable: false);
        return key?.GetValue(origin.Identity) is string value && value == origin.Identity;
    }
    public void Trust(SocialOrigin origin)
    {
        using RegistryKey key = Registry.CurrentUser.CreateSubKey(RegistryPath, writable: true);
        key.SetValue(origin.Identity, origin.Identity, RegistryValueKind.String);
    }
}
