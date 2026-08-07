using Microsoft.Win32;

namespace OpenLocally;

/// <summary>
/// Real registry implementation backed by HKCU (Microsoft.Win32.Registry).
/// All key paths are relative to <see cref="Registry.CurrentUser"/>, so
/// registration needs no administrator privileges.
/// </summary>
internal sealed class WindowsRegistry : IRegistry
{
    public void CreateKey(string keyPath)
    {
        using RegistryKey key = Registry.CurrentUser.CreateSubKey(keyPath);
    }

    public void SetValue(string keyPath, string? valueName, string value)
    {
        using RegistryKey key = Registry.CurrentUser.CreateSubKey(keyPath);
        key.SetValue(valueName, value);
    }

    public void DeleteTree(string keyPath)
    {
        Registry.CurrentUser.DeleteSubKeyTree(keyPath, throwOnMissingSubKey: false);
    }
}
