using System.Security.Cryptography;
using System.Text;
using Microsoft.Win32;

namespace OpenLocally;

public sealed class WindowsTrustedMediaRootStore : ITrustedMediaRootStore
{
    internal const string RegistryPath = @"Software\CreatorCrate\SocialPreparation\TrustedMediaRoots";

    public bool IsTrusted(SocialOrigin origin, string normalizedRoot)
    {
        string identity = Identity(origin, normalizedRoot);
        using RegistryKey? key = Registry.CurrentUser.OpenSubKey(RegistryPath, writable: false);
        return key?.GetValue(ValueName(identity)) is string stored && stored == identity;
    }

    public void Trust(SocialOrigin origin, string normalizedRoot)
    {
        string identity = Identity(origin, normalizedRoot);
        using RegistryKey key = Registry.CurrentUser.CreateSubKey(RegistryPath, writable: true);
        key.SetValue(ValueName(identity), identity, RegistryValueKind.String);
    }

    private static string Identity(SocialOrigin origin, string root) => $"{origin.Identity}\u001f{root}";
    private static string ValueName(string value) => Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(value)));
}
