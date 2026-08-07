using OpenLocally;

namespace OpenLocally.Tests;

/// <summary>
/// Records every launcher call so the orchestration can be asserted without
/// opening Explorer.
/// </summary>
internal sealed class RecordingLauncher : IShellLauncher
{
    public List<(string Path, bool Select)> OpenCalls { get; } = new();

    public Exception? ThrowOnOpen { get; set; }

    public void Open(string path, bool select)
    {
        if (ThrowOnOpen is not null)
        {
            throw ThrowOnOpen;
        }

        OpenCalls.Add((path, select));
    }
}

public class OpenLocallyOrchestratorTests
{
    private static string Uri(string path, string select) =>
        $"creatorcrate-open://open?v=2&path={path}&select={select}";

    private static OpenLocallyOrchestrator Create(
        PathValidationResult validationResult,
        RecordingLauncher launcher) =>
        new(_ => validationResult, launcher);

    // --- Valid requests reach the launcher ---

    [Fact]
    public void Run_ValidFolderRequest_OpensFolderWithoutSelect()
    {
        var launcher = new RecordingLauncher();
        OpenLocallyOrchestrator orchestrator = Create(
            PathValidationResult.Ok(@"D:\example\000001-demo"),
            launcher);

        OpenLocallyResult result = orchestrator.Run(Uri(@"D:\example\000001-demo", "0"));

        Assert.True(result.Success);
        Assert.Null(result.Error);
        (string path, bool select) = Assert.Single(launcher.OpenCalls);
        Assert.Equal(@"D:\example\000001-demo", path);
        Assert.False(select);
    }

    [Fact]
    public void Run_ValidFileRequest_OpensFolderAndSelectsFile()
    {
        var launcher = new RecordingLauncher();
        OpenLocallyOrchestrator orchestrator = Create(
            PathValidationResult.Ok(@"D:\example\000001-demo\image.png"),
            launcher);

        OpenLocallyResult result = orchestrator.Run(Uri(@"D:\example\000001-demo\image.png", "1"));

        Assert.True(result.Success);
        Assert.Null(result.Error);
        (string path, bool select) = Assert.Single(launcher.OpenCalls);
        Assert.Equal(@"D:\example\000001-demo\image.png", path);
        Assert.True(select);
    }

    [Fact]
    public void Run_ValidRequest_PassesDecodedPathToLauncher()
    {
        var launcher = new RecordingLauncher();
        OpenLocallyOrchestrator orchestrator = Create(
            PathValidationResult.Ok(@"D:\Proyectos\€ Studios\hero.png"),
            launcher);

        OpenLocallyResult result = orchestrator.Run(
            Uri(@"D:\Proyectos\%E2%82%AC%20Studios\hero.png", "1"));

        Assert.True(result.Success);
        (string path, bool select) = Assert.Single(launcher.OpenCalls);
        Assert.Equal(@"D:\Proyectos\€ Studios\hero.png", path);
        Assert.True(select);
    }

    // --- Invalid URI stops execution ---

    [Fact]
    public void Run_InvalidUri_ReturnsFailureAndNeverCallsLauncher()
    {
        var launcher = new RecordingLauncher();
        OpenLocallyOrchestrator orchestrator = Create(
            PathValidationResult.Ok(@"D:\example\000001-demo"),
            launcher);

        OpenLocallyResult result = orchestrator.Run("not-a-uri");

        Assert.False(result.Success);
        Assert.NotNull(result.Error);
        Assert.Empty(launcher.OpenCalls);
    }

    [Fact]
    public void Run_V1Uri_ReturnsFailureAndNeverCallsLauncher()
    {
        var launcher = new RecordingLauncher();
        OpenLocallyOrchestrator orchestrator = Create(
            PathValidationResult.Ok(@"D:\example\000001-demo"),
            launcher);

        OpenLocallyResult result = orchestrator.Run(
            "creatorcrate-open://open?v=1&mapping=projects&path=000001-demo&select=0");

        Assert.False(result.Success);
        Assert.NotNull(result.Error);
        Assert.Empty(launcher.OpenCalls);
    }

    // --- Invalid path stops execution ---

    [Fact]
    public void Run_InvalidPath_ReturnsFailureAndNeverCallsLauncher()
    {
        var launcher = new RecordingLauncher();
        OpenLocallyOrchestrator orchestrator = Create(
            PathValidationResult.Fail("Path must not be a UNC path."),
            launcher);

        OpenLocallyResult result = orchestrator.Run(Uri(@"\\server\share\folder", "0"));

        Assert.False(result.Success);
        Assert.NotNull(result.Error);
        Assert.Empty(launcher.OpenCalls);
    }

    // --- Launcher failure is reported, not thrown ---

    [Fact]
    public void Run_LauncherFailure_ReturnsFailure()
    {
        var launcher = new RecordingLauncher { ThrowOnOpen = new InvalidOperationException("Explorer could not open the folder.") };
        OpenLocallyOrchestrator orchestrator = Create(
            PathValidationResult.Ok(@"D:\example\000001-demo"),
            launcher);

        OpenLocallyResult result = orchestrator.Run(Uri(@"D:\example\000001-demo", "0"));

        Assert.False(result.Success);
        Assert.NotNull(result.Error);
        Assert.Contains("Explorer could not open", result.Error);
    }
}
