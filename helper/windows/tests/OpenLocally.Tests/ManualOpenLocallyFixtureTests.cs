using OpenLocally;
using OpenLocally.Tests.Manual;

namespace OpenLocally.Tests;

public sealed class ManualOpenLocallyFixtureTests : IDisposable
{
    private readonly string _root = Path.Combine(Path.GetTempPath(), "creatorcrate-m2-open-locally-fixture-" + Guid.NewGuid().ToString("N"));

    [Fact]
    public void ExactManualFixture_RoundTripsAsAFileSelectionWithoutLaunchingExplorer()
    {
        ManualOpenLocallyRequest request = ManualOpenLocallyRequest.Create(_root);

        Assert.True(File.Exists(request.FixturePath));
        Assert.Equal(ManualOpenLocallyRequest.FileName, Path.GetFileName(request.FixturePath));

        UriParseResult parsed = UriRequestParser.Parse(request.Uri);

        Assert.True(parsed.Success);
        Assert.Equal(request.FixturePath, parsed.Request!.Path);
        Assert.True(parsed.Request.Select);

        var launcher = new RecordingLauncher();
        var orchestrator = new OpenLocallyOrchestrator(PathResolver.Validate, launcher);
        int socialCalls = 0;
        var dispatcher = new CommandDispatcher(
            uri => orchestrator.Run(uri),
            _ =>
            {
                socialCalls++;
                return CommandDispatchResult.Ok();
            },
            _ => ProtocolRegistrationResult.Ok(),
            () => ProtocolRegistrationResult.Ok(),
            _ => ProtocolRegistrationResult.Ok(),
            () => ProtocolRegistrationResult.Ok());

        CommandDispatchResult result = dispatcher.Dispatch([request.Uri], @"C:\Tools\OpenLocally.exe");

        Assert.True(result.Success);
        Assert.Equal(0, socialCalls);
        (string path, bool select) = Assert.Single(launcher.OpenCalls);
        Assert.Equal(request.FixturePath, path);
        Assert.True(select);
    }

    public void Dispose()
    {
        if (Directory.Exists(_root)) Directory.Delete(_root, recursive: true);
    }
}
