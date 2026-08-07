using OpenLocally;

namespace OpenLocally.Tests;

/// <summary>
/// Records every Shell call made through the INativeShell seam so the
/// launcher's behavior can be asserted without launching Explorer.
/// </summary>
internal sealed class RecordingShell : INativeShell
{
    private readonly Dictionary<string, IntPtr> _pidls = new();
    private int _nextPidl;

    public List<string> OpenFolderCalls { get; } = new();

    public List<(string FolderPath, string? ChildPath)> OpenCalls { get; } = new();

    public List<string> ParsedPaths { get; } = new();

    public List<string> FreedPidls { get; } = new();

    public List<string> UnresolvablePaths { get; } = new();

    public bool OpenResult { get; set; } = true;

    public bool OpenFolder(string folderPath)
    {
        OpenFolderCalls.Add(folderPath);
        return OpenResult;
    }

    public IntPtr ParseDisplayName(string path)
    {
        ParsedPaths.Add(path);
        if (UnresolvablePaths.Contains(path))
        {
            return IntPtr.Zero;
        }

        if (!_pidls.TryGetValue(path, out IntPtr pidl))
        {
            pidl = new IntPtr(++_nextPidl);
            _pidls[path] = pidl;
        }

        return pidl;
    }

    public bool OpenFolderAndSelectItem(IntPtr folderPidl, IntPtr childPidl)
    {
        string folderPath = _pidls.First(p => p.Value == folderPidl).Key;
        string childPath = _pidls.First(p => p.Value == childPidl).Key;
        OpenCalls.Add((folderPath, childPath));
        return OpenResult;
    }

    public IntPtr GetLastId(IntPtr pidl)
    {
        // The real ILFindLastID borrows the last SHITEMID of the absolute
        // PIDL; the fake mirrors that by returning the same PIDL value.
        return pidl;
    }

    public void FreePidl(IntPtr pidl)
    {
        FreedPidls.Add(_pidls.First(p => p.Value == pidl).Key);
    }
}

public class ExplorerLauncherTests
{
    private readonly RecordingShell _shell = new();
    private readonly ExplorerLauncher _launcher;

    public ExplorerLauncherTests()
    {
        _launcher = new ExplorerLauncher(_shell);
    }

    [Fact]
    public void Open_SelectFalse_UsesTheFolderOpenNativePath()
    {
        // select=0 must open the folder itself (ShellExecuteExW "open" verb),
        // not reveal it from its parent: no PIDL parsing and no reveal/select
        // call may happen.
        _launcher.Open(@"D:\example\000001-demo", select: false);

        string folderPath = Assert.Single(_shell.OpenFolderCalls);
        Assert.Equal(@"D:\example\000001-demo", folderPath);
        Assert.Empty(_shell.OpenCalls);
        Assert.Empty(_shell.ParsedPaths);
    }

    [Fact]
    public void Open_SelectTrue_KeepsUsingTheFileSelectionPath()
    {
        // select=1 must keep the reveal/select semantics: containing folder
        // is parsed, file PIDL is reduced, SHOpenFolderAndSelectItems is
        // called with the child PIDL, and no folder-open call happens.
        _launcher.Open(@"D:\example\000001-demo\assets\hero.png", select: true);

        (string folderPath, string? childPath) = Assert.Single(_shell.OpenCalls);
        Assert.Equal(@"D:\example\000001-demo\assets", folderPath);
        Assert.Equal(@"D:\example\000001-demo\assets\hero.png", childPath);
        Assert.Empty(_shell.OpenFolderCalls);
    }

    [Fact]
    public void Open_SelectFalse_PathWithSpaces_IsPassedAsSingleValue()
    {
        _launcher.Open(@"D:\example\000001-demo\my hero asset", select: false);

        string folderPath = Assert.Single(_shell.OpenFolderCalls);
        Assert.Equal(@"D:\example\000001-demo\my hero asset", folderPath);
    }

    [Fact]
    public void Open_SelectTrue_PathWithSpaces_IsPassedAsSingleValue()
    {
        _launcher.Open(@"D:\example\000001-demo\my hero asset.png", select: true);

        (string folderPath, string? childPath) = Assert.Single(_shell.OpenCalls);
        Assert.Equal(@"D:\example\000001-demo", folderPath);
        Assert.Equal(@"D:\example\000001-demo\my hero asset.png", childPath);
    }

    [Fact]
    public void Open_SelectFalse_UnicodePath_IsPreserved()
    {
        _launcher.Open(@"D:\example\000001-demo\€ logo", select: false);

        string folderPath = Assert.Single(_shell.OpenFolderCalls);
        Assert.Equal(@"D:\example\000001-demo\€ logo", folderPath);
    }

    [Fact]
    public void Open_SelectTrue_UnicodePath_IsPreserved()
    {
        _launcher.Open(@"D:\example\000001-demo\€ logo.png", select: true);

        (string folderPath, string? childPath) = Assert.Single(_shell.OpenCalls);
        Assert.Equal(@"D:\example\000001-demo", folderPath);
        Assert.Equal(@"D:\example\000001-demo\€ logo.png", childPath);
    }

    [Fact]
    public void Open_SelectTrue_ReceivesTheExpectedValidatedPath()
    {
        // The launcher must receive the exact absolute path produced by
        // PathResolver, unmodified.
        PathValidationResult validated = PathResolver.Validate(@"D:\example\000001-demo\assets\hero.png");
        Assert.True(validated.Success);

        _launcher.Open(validated.FullPath!, select: true);

        (string folderPath, string? childPath) = Assert.Single(_shell.OpenCalls);
        Assert.Equal(@"D:\example\000001-demo\assets", folderPath);
        Assert.Equal(validated.FullPath, childPath);
    }

    [Fact]
    public void Open_SelectTrue_FilePidlIsFreed()
    {
        _launcher.Open(@"D:\example\000001-demo\hero.png", select: true);

        Assert.Contains(@"D:\example\000001-demo\hero.png", _shell.FreedPidls);
        Assert.Contains(@"D:\example\000001-demo", _shell.FreedPidls);
    }

    [Fact]
    public void Open_SelectFalse_DoesNotAllocateAnyPidl()
    {
        // The folder-open path passes the path to ShellExecuteExW directly;
        // no PIDL is ever created, so there is nothing to free.
        _launcher.Open(@"D:\example\000001-demo", select: false);

        Assert.Empty(_shell.FreedPidls);
    }

    [Fact]
    public void Open_SelectTrue_ShellFailure_Throws()
    {
        _shell.OpenResult = false;

        Assert.Throws<InvalidOperationException>(() =>
            _launcher.Open(@"D:\example\000001-demo\hero.png", select: true));
    }

    [Fact]
    public void Open_SelectFalse_NativeFolderOpenFailure_PropagatesAsFailure()
    {
        // A false result from the native folder-open call (ShellExecuteExW
        // failing) must surface as a launch failure, not be swallowed.
        _shell.OpenResult = false;

        Assert.Throws<InvalidOperationException>(() =>
            _launcher.Open(@"D:\example\000001-demo", select: false));
    }

    [Fact]
    public void Open_UnresolvableFile_Throws()
    {
        _shell.UnresolvablePaths.Add(@"D:\example\000001-demo\missing.png");

        Assert.Throws<InvalidOperationException>(() =>
            _launcher.Open(@"D:\example\000001-demo\missing.png", select: true));
    }

    [Theory]
    [InlineData(null)]
    [InlineData("")]
    [InlineData("   ")]
    public void Open_InvalidPath_Throws(string? path)
    {
        Assert.ThrowsAny<ArgumentException>(() => _launcher.Open(path!, select: false));
    }
}
