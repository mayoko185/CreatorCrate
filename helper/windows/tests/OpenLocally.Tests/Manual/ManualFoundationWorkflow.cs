using System.Text;
using System.Text.Json;

namespace OpenLocally.Tests.Manual;

internal sealed record ManualWorkflowStage(
    string Name,
    string Instructions,
    TimeSpan Timeout,
    Func<ManualWorkflowStageContext, CancellationToken, Task> ExecuteAsync);

internal sealed record ManualWorkflowEvent(
    string Kind,
    string? Stage,
    string Message,
    int? TimeoutSeconds = null,
    string? RequestId = null,
    string? QuestionCode = null);

internal sealed record ManualWorkflowConfirmationRequest(
    string RequestId,
    string Stage,
    string QuestionCode,
    string Message);

internal sealed record ManualWorkflowConfirmationResponse(
    string RequestId,
    string Answer);

internal interface IManualWorkflowReporter
{
    void StageStarting(ManualWorkflowStage stage);
    void Checkpoint(string stage, string message);
    void ConfirmationRequested(ManualWorkflowConfirmationRequest request);
    void StageCompleted(string stage);
    void StageFailed(string stage, Exception error);
    void CleanupCompleted();
    void CleanupFailed(Exception error);
}

internal interface IManualWorkflowConfirmation
{
    Task ConfirmAsync(ManualWorkflowConfirmationRequest request, CancellationToken cancellationToken);
}

internal sealed class ManualWorkflowStageContext
{
    private readonly string _stage;
    private readonly IManualWorkflowReporter _reporter;
    private readonly IManualWorkflowConfirmation _confirmation;

    internal ManualWorkflowStageContext(
        string stage,
        IManualWorkflowReporter reporter,
        IManualWorkflowConfirmation confirmation)
    {
        _stage = stage;
        _reporter = reporter;
        _confirmation = confirmation;
    }

    public void Checkpoint(string message) => _reporter.Checkpoint(_stage, message);

    public Task ConfirmAsync(string questionCode, string message, CancellationToken cancellationToken)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(questionCode);
        var request = new ManualWorkflowConfirmationRequest(
            Guid.NewGuid().ToString("N"),
            _stage,
            questionCode,
            message);
        _reporter.ConfirmationRequested(request);
        return _confirmation.ConfirmAsync(request, cancellationToken);
    }
}

internal sealed class ManualWorkflowStageTimeoutException : TimeoutException
{
    internal ManualWorkflowStageTimeoutException(string stage, TimeSpan timeout)
        : base($"Manual workflow stage '{stage}' did not complete within {timeout.TotalMinutes:0.#} minute(s).")
    {
    }
}

internal sealed class ManualFoundationWorkflow
{
    private readonly Action _requireOptIn;
    private readonly IManualWorkflowReporter _reporter;
    private readonly IManualWorkflowConfirmation _confirmation;
    private readonly IReadOnlyList<ManualWorkflowStage> _stages;
    private readonly Func<Task> _cleanupAsync;

    internal ManualFoundationWorkflow(
        Action requireOptIn,
        IManualWorkflowReporter reporter,
        IManualWorkflowConfirmation confirmation,
        IReadOnlyList<ManualWorkflowStage> stages,
        Func<Task> cleanupAsync)
    {
        _requireOptIn = requireOptIn;
        _reporter = reporter;
        _confirmation = confirmation;
        _stages = stages;
        _cleanupAsync = cleanupAsync;
    }

    internal async Task RunAsync(CancellationToken cancellationToken)
    {
        _requireOptIn();

        Exception? stageFailure = null;
        try
        {
            foreach (ManualWorkflowStage stage in _stages)
            {
                await RunStageAsync(stage, cancellationToken);
            }
        }
        catch (Exception error)
        {
            stageFailure = error;
            throw;
        }
        finally
        {
            try
            {
                await _cleanupAsync();
                _reporter.CleanupCompleted();
            }
            catch (Exception cleanupError)
            {
                _reporter.CleanupFailed(cleanupError);
                if (stageFailure is null) throw;
            }
        }
    }

    private async Task RunStageAsync(ManualWorkflowStage stage, CancellationToken cancellationToken)
    {
        _reporter.StageStarting(stage);

        using var stageCancellation = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        ManualWorkflowStageContext context = new(stage.Name, _reporter, _confirmation);
        Task action;
        try
        {
            action = stage.ExecuteAsync(context, stageCancellation.Token);
        }
        catch (Exception error)
        {
            _reporter.StageFailed(stage.Name, error);
            throw;
        }

        Task timeout = Task.Delay(stage.Timeout, cancellationToken);
        Task completed = await Task.WhenAny(action, timeout);

        if (completed != action)
        {
            cancellationToken.ThrowIfCancellationRequested();
            stageCancellation.Cancel();
            ManualWorkflowStageTimeoutException error = new(stage.Name, stage.Timeout);
            _reporter.StageFailed(stage.Name, error);
            throw error;
        }

        try
        {
            await action;
            _reporter.StageCompleted(stage.Name);
        }
        catch (Exception error)
        {
            _reporter.StageFailed(stage.Name, error);
            throw;
        }
    }
}

internal sealed class ManualWorkflowFileReporter : IManualWorkflowReporter
{
    private static readonly object EventWriteLock = new();
    private readonly string? _eventPath;

    internal ManualWorkflowFileReporter(string? eventPath = null)
    {
        _eventPath = eventPath ?? Environment.GetEnvironmentVariable("CREATORCRATE_M2_WORKFLOW_EVENTS");
    }

    public void StageStarting(ManualWorkflowStage stage) =>
        Publish("stage-start", stage.Name, stage.Instructions, (int)Math.Ceiling(stage.Timeout.TotalSeconds));

    public void Checkpoint(string stage, string message) =>
        Publish("checkpoint", stage, message);

    public void ConfirmationRequested(ManualWorkflowConfirmationRequest request) =>
        Publish("operator_confirmation_required", request.Stage, request.Message, requestId: request.RequestId, questionCode: request.QuestionCode);

    public void StageCompleted(string stage) =>
        Publish("stage-complete", stage, $"MANUAL CHECK — {stage} completed.");

    public void StageFailed(string stage, Exception error)
    {
        string message = $"MANUAL CHECK — {stage} failed: {error.Message}";
        if (FixturePreparationAdapter.TryGetCleanupDiagnostic(error, out string? cleanupDiagnostic))
        {
            message += $"{Environment.NewLine}MANUAL DIAGNOSTIC — Chrome fixture cleanup: {cleanupDiagnostic}";
        }
        Publish("stage-failed", stage, message);
    }

    public void CleanupCompleted() =>
        Publish("cleanup-complete", null, "MANUAL CHECK — Cleanup completed.");

    public void CleanupFailed(Exception error) =>
        Publish("cleanup-failed", null, $"MANUAL CHECK — Cleanup failed: {error.Message}");

    private void Publish(
        string kind,
        string? stage,
        string message,
        int? timeoutSeconds = null,
        string? requestId = null,
        string? questionCode = null)
    {
        if (string.IsNullOrWhiteSpace(_eventPath))
        {
            Console.WriteLine(message);
            return;
        }

        string? directory = Path.GetDirectoryName(_eventPath);
        if (string.IsNullOrWhiteSpace(directory) || !Directory.Exists(directory))
            throw new InvalidOperationException("The manual wrapper must create the workflow event directory before starting the test.");

        string serialized = JsonSerializer.Serialize(new ManualWorkflowEvent(kind, stage, message, timeoutSeconds, requestId, questionCode));
        lock (EventWriteLock)
        {
            using var stream = new FileStream(_eventPath, FileMode.Append, FileAccess.Write, FileShare.Read);
            using var writer = new StreamWriter(stream, new UTF8Encoding(encoderShouldEmitUTF8Identifier: false));
            writer.Write(serialized);
            writer.Write(Environment.NewLine);
            writer.Flush();
        }
    }
}

internal sealed class ManualFileWorkflowConfirmation : IManualWorkflowConfirmation
{
    internal const string ResponseDirectoryEnvironmentVariable = "CREATORCRATE_M2_OPERATOR_RESPONSE_DIR";
    private readonly string _directory;

    internal ManualFileWorkflowConfirmation(string? directory = null)
    {
        _directory = directory ?? Environment.GetEnvironmentVariable(ResponseDirectoryEnvironmentVariable)
            ?? throw new InvalidOperationException($"The manual wrapper must provide {ResponseDirectoryEnvironmentVariable}.");
    }

    public async Task ConfirmAsync(ManualWorkflowConfirmationRequest request, CancellationToken cancellationToken)
    {
        if (!Guid.TryParseExact(request.RequestId, "N", out _))
            throw new InvalidOperationException("Manual confirmation request ID must be a GUID in N format.");

        string responsePath = Path.Combine(_directory, request.RequestId + ".json");
        string consumedDirectory = Path.Combine(_directory, "consumed");
        string consumedPath = Path.Combine(consumedDirectory, request.RequestId + ".json");
        Directory.CreateDirectory(consumedDirectory);

        while (true)
        {
            cancellationToken.ThrowIfCancellationRequested();

            if (!File.Exists(responsePath))
            {
                await Task.Delay(TimeSpan.FromMilliseconds(200), cancellationToken);
                continue;
            }

            try
            {
                File.Move(responsePath, consumedPath);
            }
            catch (IOException) when (!File.Exists(consumedPath))
            {
                await Task.Delay(TimeSpan.FromMilliseconds(200), cancellationToken);
                continue;
            }

            ManualWorkflowConfirmationResponse? response;
            try
            {
                await using FileStream stream = new(consumedPath, FileMode.Open, FileAccess.Read, FileShare.Read);
                response = await JsonSerializer.DeserializeAsync<ManualWorkflowConfirmationResponse>(stream, cancellationToken: cancellationToken);
            }
            catch (JsonException ex)
            {
                throw new InvalidOperationException($"Manual confirmation response for '{request.Stage}' is malformed.", ex);
            }

            if (response is null || !string.Equals(response.RequestId, request.RequestId, StringComparison.Ordinal))
                throw new InvalidOperationException($"Manual confirmation response for '{request.Stage}' does not match its request.");

            if (string.Equals(response.Answer, "yes", StringComparison.OrdinalIgnoreCase))
                return;

            if (string.Equals(response.Answer, "no", StringComparison.OrdinalIgnoreCase) &&
                string.Equals(request.QuestionCode, "explorer_revealed_fixture", StringComparison.Ordinal))
            {
                throw new InvalidOperationException("Operator reported Explorer did not reveal the fixture.");
            }

            throw new InvalidOperationException($"Manual confirmation for '{request.Stage}' must explicitly answer yes.");
        }
    }
}
