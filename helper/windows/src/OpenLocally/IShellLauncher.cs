namespace OpenLocally;

/// <summary>
/// Opens a validated local path in the platform file manager.
///
/// The path is expected to be absolute and already validated by
/// <see cref="PathResolver"/>; the launcher performs no path validation of
/// its own beyond a null/empty guard. Implementations must not require a
/// shell (cmd.exe, PowerShell) or a command string.
/// </summary>
public interface IShellLauncher
{
    /// <summary>
    /// Open the given path in the file manager.
    /// </summary>
    /// <param name="path">Absolute validated path to open.</param>
    /// <param name="select">
    /// When false, <paramref name="path"/> is a folder and is opened directly.
    /// When true, <paramref name="path"/> is a file: the containing folder is
    /// opened and the file is selected.
    /// </param>
    void Open(string path, bool select);
}
