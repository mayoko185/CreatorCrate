namespace OpenLocally;

/// <summary>
/// Thin seam over the Windows Shell APIs used by
/// <see cref="ExplorerLauncher"/>. Exists so the launcher's dispatch logic
/// can be tested with a recording fake instead of launching Explorer.
/// </summary>
internal interface INativeShell
{
    /// <summary>
    /// Open a folder in Explorer by invoking the Shell "open" verb on its
    /// absolute path (ShellExecuteExW with SEE_MASK_INVOKEIDLIST). Opens the
    /// folder's own contents; the result reports actual success or failure.
    /// </summary>
    /// <param name="folderPath">Absolute validated path of the folder to open.</param>
    /// <returns>True when the Shell call succeeded.</returns>
    bool OpenFolder(string folderPath);

    /// <summary>
    /// Parse a display name into an absolute PIDL. Returns IntPtr.Zero when
    /// the name cannot be resolved.
    /// </summary>
    IntPtr ParseDisplayName(string path);

    /// <summary>
    /// Open a folder in Explorer with one of its items selected.
    /// </summary>
    /// <param name="folderPidl">Absolute PIDL of the folder to open.</param>
    /// <param name="childPidl">
    /// Child PIDL (relative to <paramref name="folderPidl"/>) of the item to
    /// select. Obtained from <see cref="GetLastId"/>.
    /// </param>
    /// <returns>True when the Shell call succeeded.</returns>
    bool OpenFolderAndSelectItem(IntPtr folderPidl, IntPtr childPidl);

    /// <summary>
    /// Return the last SHITEMID of an absolute PIDL: the child PIDL relative
    /// to the item's parent. The result is borrowed from the input PIDL and
    /// must not be freed.
    /// </summary>
    IntPtr GetLastId(IntPtr pidl);

    /// <summary>
    /// Free a PIDL previously returned by <see cref="ParseDisplayName"/>.
    /// </summary>
    void FreePidl(IntPtr pidl);
}
