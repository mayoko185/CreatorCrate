namespace OpenLocally;

/// <summary>
/// Thin seam over the Windows registry used by <see cref="ProtocolRegistrar"/>.
/// Exists so protocol registration can be tested with an in-memory fake
/// instead of writing to the real user registry.
///
/// All key paths are relative to HKCU; the real implementation never touches
/// HKLM, so registration requires no administrator privileges.
/// </summary>
public interface IRegistry
{
    /// <summary>
    /// Create a key under HKCU, including any missing parent keys.
    /// </summary>
    void CreateKey(string keyPath);

    /// <summary>
    /// Set a value on a key under HKCU, creating the key when needed.
    /// A null <paramref name="valueName"/> addresses the key's default value.
    /// </summary>
    void SetValue(string keyPath, string? valueName, string value);

    /// <summary>
    /// Delete a key and its entire subtree under HKCU. A missing key is
    /// ignored, not an error.
    /// </summary>
    void DeleteTree(string keyPath);
}
