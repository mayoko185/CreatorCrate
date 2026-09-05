using OpenLocally.Tests.Manual;

namespace OpenLocally.Tests;

public sealed class ManualFoundationWorkflowTests
{
    [Fact]
    public async Task StagesRunInExplicitOrderAndReportBeforeEachAction()
    {
        var events = new List<string>();
        var reporter = new RecordingReporter(events);
        var workflow = new ManualFoundationWorkflow(
            () => events.Add("guard"),
            reporter,
            new AcceptingConfirmation(),
            [
                Stage("first", context =>
                {
                    events.Add("action:first");
                    context.Checkpoint("first checkpoint");
                    return Task.CompletedTask;
                }),
                Stage("second", _ =>
                {
                    events.Add("action:second");
                    return Task.CompletedTask;
                }),
            ],
            () =>
            {
                events.Add("cleanup");
                return Task.CompletedTask;
            });

        await workflow.RunAsync(CancellationToken.None);

        Assert.Equal(
        [
            "guard",
            "start:first",
            "action:first",
            "checkpoint:first",
            "complete:first",
            "start:second",
            "action:second",
            "complete:second",
            "cleanup",
            "cleanup-complete",
        ],
        events);
    }

    [Fact]
    public async Task StalledStageFailsWithItsNameAndDoesNotStartLaterStages()
    {
        var events = new List<string>();
        var never = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var workflow = new ManualFoundationWorkflow(
            () => { },
            new RecordingReporter(events),
            new AcceptingConfirmation(),
            [
                new ManualWorkflowStage(
                    "stalled",
                    "stalled",
                    TimeSpan.FromMilliseconds(25),
                    (_, _) => never.Task),
                Stage("later", _ => Task.CompletedTask),
            ],
            () =>
            {
                events.Add("cleanup");
                return Task.CompletedTask;
            });

        ManualWorkflowStageTimeoutException error = await Assert.ThrowsAsync<ManualWorkflowStageTimeoutException>(
            () => workflow.RunAsync(CancellationToken.None));

        Assert.Contains("stalled", error.Message, StringComparison.Ordinal);
        Assert.DoesNotContain("start:later", events);
        Assert.Equal(["start:stalled", "failed:stalled", "cleanup", "cleanup-complete"], events);
    }

    [Fact]
    public async Task StageFailureStopsTheWorkflowAndStillExecutesCleanup()
    {
        var events = new List<string>();
        var workflow = new ManualFoundationWorkflow(
            () => { },
            new RecordingReporter(events),
            new AcceptingConfirmation(),
            [
                Stage("failure", _ => throw new InvalidOperationException("stage failure")),
                Stage("later", _ => Task.CompletedTask),
            ],
            () =>
            {
                events.Add("cleanup");
                return Task.CompletedTask;
            });

        InvalidOperationException error = await Assert.ThrowsAsync<InvalidOperationException>(
            () => workflow.RunAsync(CancellationToken.None));

        Assert.Equal("stage failure", error.Message);
        Assert.DoesNotContain("start:later", events);
        Assert.Equal(["start:failure", "failed:failure", "cleanup", "cleanup-complete"], events);
    }

    [Fact]
    public async Task MissingManualOptInBlocksEveryWorkflowStage()
    {
        string? prior = Environment.GetEnvironmentVariable(ManualFoundationGuard.EnvironmentVariable);
        try
        {
            Environment.SetEnvironmentVariable(ManualFoundationGuard.EnvironmentVariable, null);
            var events = new List<string>();
            var workflow = new ManualFoundationWorkflow(
                ManualFoundationGuard.RequireOptIn,
                new RecordingReporter(events),
                new AcceptingConfirmation(),
                [Stage("never", _ => Task.CompletedTask)],
                () =>
                {
                    events.Add("cleanup");
                    return Task.CompletedTask;
                });

            await Assert.ThrowsAsync<InvalidOperationException>(() => workflow.RunAsync(CancellationToken.None));

            Assert.Empty(events);
        }
        finally
        {
            Environment.SetEnvironmentVariable(ManualFoundationGuard.EnvironmentVariable, prior);
        }
    }

    [Fact]
    public async Task FileConfirmationConsumesOnlyItsCorrelatedExplicitResponse()
    {
        string directory = Path.Combine(Path.GetTempPath(), "creatorcrate-m2-confirmation-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(directory);
        try
        {
            var confirmation = new ManualFileWorkflowConfirmation(directory);
            var accepted = new ManualWorkflowConfirmationRequest(Guid.NewGuid().ToString("N"), "Open Locally", "explorer_revealed_fixture", "confirm");
            await File.WriteAllTextAsync(
                Path.Combine(directory, accepted.RequestId + ".json"),
                System.Text.Json.JsonSerializer.Serialize(new ManualWorkflowConfirmationResponse(accepted.RequestId, "yes")));
            await confirmation.ConfirmAsync(accepted, CancellationToken.None);
            Assert.False(File.Exists(Path.Combine(directory, accepted.RequestId + ".json")));
            Assert.True(File.Exists(Path.Combine(directory, "consumed", accepted.RequestId + ".json")));

            var rejected = new ManualWorkflowConfirmationRequest(Guid.NewGuid().ToString("N"), "Open Locally", "explorer_revealed_fixture", "confirm");
            await File.WriteAllTextAsync(
                Path.Combine(directory, rejected.RequestId + ".json"),
                System.Text.Json.JsonSerializer.Serialize(new ManualWorkflowConfirmationResponse(rejected.RequestId, "no")));
            InvalidOperationException negative = await Assert.ThrowsAsync<InvalidOperationException>(
                () => confirmation.ConfirmAsync(rejected, CancellationToken.None));
            Assert.Equal("Operator reported Explorer did not reveal the fixture.", negative.Message);

            var invalid = new ManualWorkflowConfirmationRequest(Guid.NewGuid().ToString("N"), "Open Locally", "explorer_revealed_fixture", "confirm");
            await File.WriteAllTextAsync(
                Path.Combine(directory, invalid.RequestId + ".json"),
                System.Text.Json.JsonSerializer.Serialize(new ManualWorkflowConfirmationResponse(invalid.RequestId, "maybe")));
            InvalidOperationException malformed = await Assert.ThrowsAsync<InvalidOperationException>(
                () => confirmation.ConfirmAsync(invalid, CancellationToken.None));
            Assert.Contains("must explicitly answer yes", malformed.Message, StringComparison.Ordinal);

            var stale = new ManualWorkflowConfirmationRequest(Guid.NewGuid().ToString("N"), "Open Locally", "explorer_revealed_fixture", "confirm");
            await File.WriteAllTextAsync(
                Path.Combine(directory, stale.RequestId + ".json"),
                System.Text.Json.JsonSerializer.Serialize(new ManualWorkflowConfirmationResponse(stale.RequestId, "yes")));
            var waiting = new ManualWorkflowConfirmationRequest(Guid.NewGuid().ToString("N"), "Open Locally", "explorer_revealed_fixture", "confirm");
            using var cancelled = new CancellationTokenSource(TimeSpan.FromMilliseconds(100));
            await Assert.ThrowsAnyAsync<OperationCanceledException>(() => confirmation.ConfirmAsync(waiting, cancelled.Token));
            Assert.True(File.Exists(Path.Combine(directory, stale.RequestId + ".json")));
        }
        finally
        {
            if (Directory.Exists(directory)) Directory.Delete(directory, recursive: true);
        }
    }

    [Fact]
    public async Task ExplorerStageDoesNotCompleteBeforeTheWrapperWritesAnAffirmativeResponse()
    {
        string directory = Path.Combine(Path.GetTempPath(), "creatorcrate-m2-confirmation-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(directory);
        try
        {
            var events = new List<string>();
            var requestSignal = new TaskCompletionSource<ManualWorkflowConfirmationRequest>(TaskCreationOptions.RunContinuationsAsynchronously);
            var workflow = new ManualFoundationWorkflow(
                () => { },
                new RecordingReporter(events, requestSignal),
                new ManualFileWorkflowConfirmation(directory),
                [
                    new ManualWorkflowStage(
                        "Open Locally",
                        "Open Locally",
                        TimeSpan.FromSeconds(1),
                        (context, cancellationToken) => context.ConfirmAsync("explorer_revealed_fixture", "confirm", cancellationToken)),
                ],
                () => Task.CompletedTask);

            Task running = workflow.RunAsync(CancellationToken.None);
            ManualWorkflowConfirmationRequest request = await requestSignal.Task.WaitAsync(TimeSpan.FromSeconds(1));
            Assert.DoesNotContain("complete:Open Locally", events);

            await File.WriteAllTextAsync(
                Path.Combine(directory, request.RequestId + ".json"),
                System.Text.Json.JsonSerializer.Serialize(new ManualWorkflowConfirmationResponse(request.RequestId, "yes")));
            await running;

            Assert.Contains("complete:Open Locally", events);
        }
        finally
        {
            if (Directory.Exists(directory)) Directory.Delete(directory, recursive: true);
        }
    }

    [Fact]
    public async Task NegativeExplorerConfirmationFailsTheStageAndPreventsLaterStages()
    {
        string directory = Path.Combine(Path.GetTempPath(), "creatorcrate-m2-confirmation-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(directory);
        try
        {
            var events = new List<string>();
            var requestSignal = new TaskCompletionSource<ManualWorkflowConfirmationRequest>(TaskCreationOptions.RunContinuationsAsynchronously);
            var workflow = new ManualFoundationWorkflow(
                () => { },
                new RecordingReporter(events, requestSignal),
                new ManualFileWorkflowConfirmation(directory),
                [
                    new ManualWorkflowStage(
                        "Open Locally",
                        "Open Locally",
                        TimeSpan.FromSeconds(1),
                        (context, cancellationToken) => context.ConfirmAsync("explorer_revealed_fixture", "confirm", cancellationToken)),
                    Stage("later", _ => Task.CompletedTask),
                ],
                () => Task.CompletedTask);

            Task running = workflow.RunAsync(CancellationToken.None);
            ManualWorkflowConfirmationRequest request = await requestSignal.Task.WaitAsync(TimeSpan.FromSeconds(1));
            await File.WriteAllTextAsync(
                Path.Combine(directory, request.RequestId + ".json"),
                System.Text.Json.JsonSerializer.Serialize(new ManualWorkflowConfirmationResponse(request.RequestId, "no")));

            InvalidOperationException error = await Assert.ThrowsAsync<InvalidOperationException>(() => running);
            Assert.Equal("Operator reported Explorer did not reveal the fixture.", error.Message);
            Assert.DoesNotContain("start:later", events);
        }
        finally
        {
            if (Directory.Exists(directory)) Directory.Delete(directory, recursive: true);
        }
    }

    [Fact]
    public async Task MissingOperatorResponseTimesOutTheActiveStageAndPreventsLaterStages()
    {
        var events = new List<string>();
        string directory = Path.Combine(Path.GetTempPath(), "creatorcrate-m2-confirmation-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(directory);
        try
        {
            var workflow = new ManualFoundationWorkflow(
                () => { },
                new RecordingReporter(events),
                new ManualFileWorkflowConfirmation(directory),
                [
                    new ManualWorkflowStage(
                        "Open Locally",
                        "Open Locally",
                        TimeSpan.FromMilliseconds(25),
                        (context, cancellationToken) => context.ConfirmAsync("explorer_revealed_fixture", "confirm", cancellationToken)),
                    Stage("later", _ => Task.CompletedTask),
                ],
                () => Task.CompletedTask);

            ManualWorkflowStageTimeoutException error = await Assert.ThrowsAsync<ManualWorkflowStageTimeoutException>(
                () => workflow.RunAsync(CancellationToken.None));

            Assert.Contains("Open Locally", error.Message, StringComparison.Ordinal);
            Assert.DoesNotContain("start:later", events);
        }
        finally
        {
            if (Directory.Exists(directory)) Directory.Delete(directory, recursive: true);
        }
    }

    [Fact]
    public void FileConfirmationWithoutWrapperDirectoryFailsBeforeWaiting()
    {
        string? prior = Environment.GetEnvironmentVariable(ManualFileWorkflowConfirmation.ResponseDirectoryEnvironmentVariable);
        try
        {
            Environment.SetEnvironmentVariable(ManualFileWorkflowConfirmation.ResponseDirectoryEnvironmentVariable, null);
            InvalidOperationException error = Assert.Throws<InvalidOperationException>(
                () => new ManualFileWorkflowConfirmation());
            Assert.Contains(ManualFileWorkflowConfirmation.ResponseDirectoryEnvironmentVariable, error.Message, StringComparison.Ordinal);
        }
        finally
        {
            Environment.SetEnvironmentVariable(ManualFileWorkflowConfirmation.ResponseDirectoryEnvironmentVariable, prior);
        }
    }

    private static ManualWorkflowStage Stage(
        string name,
        Func<ManualWorkflowStageContext, Task> action) =>
        new(name, name, TimeSpan.FromSeconds(1), (context, _) => action(context));

    private sealed class RecordingReporter(List<string> events, TaskCompletionSource<ManualWorkflowConfirmationRequest>? requestSignal = null) : IManualWorkflowReporter
    {
        public void StageStarting(ManualWorkflowStage stage) => events.Add("start:" + stage.Name);
        public void Checkpoint(string stage, string message) => events.Add("checkpoint:" + stage);
        public void ConfirmationRequested(ManualWorkflowConfirmationRequest request)
        {
            events.Add("confirmation:" + request.Stage);
            requestSignal?.TrySetResult(request);
        }
        public void StageCompleted(string stage) => events.Add("complete:" + stage);
        public void StageFailed(string stage, Exception error) => events.Add("failed:" + stage);
        public void CleanupCompleted() => events.Add("cleanup-complete");
        public void CleanupFailed(Exception error) => events.Add("cleanup-failed");
    }

    private sealed class AcceptingConfirmation : IManualWorkflowConfirmation
    {
        public Task ConfirmAsync(ManualWorkflowConfirmationRequest request, CancellationToken cancellationToken) =>
            Task.CompletedTask;
    }
}
