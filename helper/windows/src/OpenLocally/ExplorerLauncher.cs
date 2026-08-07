using System.Runtime.InteropServices;

namespace OpenLocally;

/// <summary>
/// Launches Windows Explorer through the Shell API.
///
/// A folder (select=0) is opened directly through ShellExecuteExW with the
/// fixed "open" verb: Explorer shows the folder's own contents. A file
/// (select=1) is revealed through SHOpenFolderAndSelectItems: the containing
/// folder opens with the file selected.
///
/// No cmd.exe, no PowerShell, and no command string is ever built: paths are
/// passed as typed Shell arguments, so spaces and unicode characters are
/// preserved verbatim. The path is expected to be absolute and already
/// validated by <see cref="PathResolver"/>.
/// </summary>
public sealed class ExplorerLauncher : IShellLauncher
{
    private readonly INativeShell _shell;

    public ExplorerLauncher()
        : this(new NativeShell())
    {
    }

    internal ExplorerLauncher(INativeShell shell)
    {
        _shell = shell;
    }

    /// <summary>
    /// Open the given path in Explorer.
    /// </summary>
    /// <param name="path">Absolute validated path to open.</param>
    /// <param name="select">
    /// When false, <paramref name="path"/> is a folder and is opened directly.
    /// When true, <paramref name="path"/> is a file: the containing folder is
    /// opened and the file is selected.
    /// </param>
    /// <exception cref="ArgumentNullException">When <paramref name="path"/> is null.</exception>
    /// <exception cref="ArgumentException">When <paramref name="path"/> is empty or whitespace.</exception>
    /// <exception cref="InvalidOperationException">When Explorer cannot resolve or open the path.</exception>
    public void Open(string path, bool select)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(path);

        if (select)
        {
            OpenAndSelectFile(path);
        }
        else
        {
            OpenFolder(path);
        }
    }

    private void OpenFolder(string folderPath)
    {
        if (!_shell.OpenFolder(folderPath))
        {
            throw new InvalidOperationException($"Explorer could not open the folder '{folderPath}'.");
        }
    }

    private void OpenAndSelectFile(string filePath)
    {
        string? parent = Path.GetDirectoryName(filePath);
        if (parent is null)
        {
            throw new ArgumentException("Path has no containing folder.", nameof(filePath));
        }

        IntPtr folderPidl = _shell.ParseDisplayName(parent);
        if (folderPidl == IntPtr.Zero)
        {
            throw new InvalidOperationException($"Explorer could not resolve the folder '{parent}'.");
        }

        IntPtr filePidl = _shell.ParseDisplayName(filePath);
        if (filePidl == IntPtr.Zero)
        {
            _shell.FreePidl(folderPidl);
            throw new InvalidOperationException($"Explorer could not resolve the item '{filePath}'.");
        }

        try
        {
            // SHOpenFolderAndSelectItems expects child PIDLs relative to the
            // folder PIDL; the absolute file PIDL is reduced to its last
            // SHITEMID, which is borrowed and must not be freed.
            IntPtr childPidl = _shell.GetLastId(filePidl);
            if (!_shell.OpenFolderAndSelectItem(folderPidl, childPidl))
            {
                throw new InvalidOperationException($"Explorer could not select the item '{filePath}'.");
            }
        }
        finally
        {
            _shell.FreePidl(filePidl);
            _shell.FreePidl(folderPidl);
        }
    }
}
