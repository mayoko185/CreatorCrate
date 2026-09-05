using System.Runtime.ExceptionServices;
using System.Text.Json;

namespace OpenLocally;

/// <summary>One bounded, exact-flattened-session file chooser operation per attached page.</summary>
public sealed class BrowserFileChooser
{
    public static readonly TimeSpan DefaultTimeout = TimeSpan.FromSeconds(15);

    private readonly CdpSession _session;
    private readonly Action? _onEventSubscriptionRegistered;
    private readonly Action? _onCandidateObserved;
    private readonly Func<CancellationToken, Task>? _beforeAssignmentCommitAsync;
    private int _active;
    private int _interceptionStateUncertain;

    public BrowserFileChooser(BrowserPreparationSession page)
        : this(page?.Session ?? throw new ArgumentNullException(nameof(page)))
    {
    }

    internal BrowserFileChooser(
        CdpSession session,
        Action? onEventSubscriptionRegistered = null,
        Action? onCandidateObserved = null,
        Func<CancellationToken, Task>? beforeAssignmentCommitAsync = null)
    {
        _session = session ?? throw new ArgumentNullException(nameof(session));
        _onEventSubscriptionRegistered = onEventSubscriptionRegistered;
        _onCandidateObserved = onCandidateObserved;
        _beforeAssignmentCommitAsync = beforeAssignmentCommitAsync;
    }

    /// <summary>Assigns files to a pre-known backend input node after its matching chooser event.</summary>
    public Task AttachFilesAsync(
        IReadOnlyList<string> paths,
        Func<CancellationToken, Task> triggerChooserAsync,
        long expectedBackendNodeId,
        TimeSpan? timeout = null,
        CancellationToken cancellationToken = default) =>
        AttachFilesAsyncCore(paths, triggerChooserAsync, expectedBackendNodeId, expectedFrameId: null, validateTransientInput: false, timeout, cancellationToken);

    /// <summary>Assigns files after a transient chooser event from the expected composer frame.</summary>
    public Task AttachTransientFilesAsync(
        IReadOnlyList<string> paths,
        string expectedFrameId,
        Func<CancellationToken, Task> triggerChooserAsync,
        TimeSpan? timeout = null,
        CancellationToken cancellationToken = default)
    {
        if (string.IsNullOrWhiteSpace(expectedFrameId)) throw new ArgumentException("A composer frame ID is required.", nameof(expectedFrameId));
        return AttachFilesAsyncCore(paths, triggerChooserAsync, expectedBackendNodeId: null, expectedFrameId, validateTransientInput: true, timeout, cancellationToken);
    }

    private async Task AttachFilesAsyncCore(
        IReadOnlyList<string> paths,
        Func<CancellationToken, Task> triggerChooserAsync,
        long? expectedBackendNodeId,
        string? expectedFrameId,
        bool validateTransientInput,
        TimeSpan? timeout,
        CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(paths);
        ArgumentNullException.ThrowIfNull(triggerChooserAsync);
        if (paths.Count == 0 || paths.Any(string.IsNullOrWhiteSpace)) throw new ArgumentException("At least one local path is required.", nameof(paths));
        if (expectedBackendNodeId is <= 0) throw new ArgumentOutOfRangeException(nameof(expectedBackendNodeId));

        TimeSpan effectiveTimeout = timeout ?? DefaultTimeout;
        if (effectiveTimeout <= TimeSpan.Zero || effectiveTimeout > CdpTransport.MaximumCommandTimeout) throw new ArgumentOutOfRangeException(nameof(timeout));
        if (Volatile.Read(ref _interceptionStateUncertain) != 0) throw new InvalidOperationException("File chooser interception state is uncertain for this page session.");
        if (Interlocked.CompareExchange(ref _active, 1, 0) != 0) throw new InvalidOperationException("A file chooser operation is already active for this page session.");

        var opened = new TaskCompletionSource<FileChooserOpened>(TaskCreationOptions.RunContinuationsAsynchronously);
        var unexpected = new TaskCompletionSource<Exception>(TaskCreationOptions.RunContinuationsAsynchronously);
        var observation = new FileChooserObservation();
        bool eventSubscriptionActive = false;
        bool interceptionEnabled = false;
        bool triggerStarted = false;
        bool triggerCompleted = false;
        int ignoredEventCount = 0;

        async Task ObserveAsync(CdpEvent @event)
        {
            if (!string.Equals(@event.Method, "Page.fileChooserOpened", StringComparison.Ordinal))
            {
                return;
            }

            if (validateTransientInput)
            {
                switch (observation.Observe())
                {
                    case FileChooserObservation.Result.Candidate:
                        _onCandidateObserved?.Invoke();
                        break;
                    case FileChooserObservation.Result.Ambiguous:
                        _onCandidateObserved?.Invoke();
                        unexpected.TrySetResult(new BrowserPreparationException(BrowserPreparationFailure.FileChooserMultipleEvents));
                        return;
                }
            }

            if (@event.Parameters is not JsonElement parameters)
            {
                if (validateTransientInput)
                {
                    opened.TrySetException(new BrowserPreparationException(BrowserPreparationFailure.FileChooserMissingBackendNode));
                }

                return;
            }

            if (!parameters.TryGetProperty("backendNodeId", out JsonElement backendNodeId) ||
                !backendNodeId.TryGetInt64(out long id) || id <= 0)
            {
                opened.TrySetException(new BrowserPreparationException(BrowserPreparationFailure.FileChooserMissingBackendNode));
                return;
            }

            if (expectedBackendNodeId is long expected && id != expected)
            {
                Interlocked.Increment(ref ignoredEventCount);
                return;
            }

            if (expectedFrameId is not null &&
                (!parameters.TryGetProperty("frameId", out JsonElement frameId) ||
                 frameId.ValueKind != JsonValueKind.String ||
                 !string.Equals(frameId.GetString(), expectedFrameId, StringComparison.Ordinal)))
            {
                opened.TrySetException(new BrowserPreparationException(BrowserPreparationFailure.FileChooserWrongFrame));
                return;
            }

            if (validateTransientInput)
            {
                opened.TrySetResult(new FileChooserOpened(id));
                return;
            }

            switch (observation.Observe())
            {
                case FileChooserObservation.Result.Candidate:
                    _onCandidateObserved?.Invoke();
                    opened.TrySetResult(new FileChooserOpened(id));
                    break;
                case FileChooserObservation.Result.Ambiguous:
                    _onCandidateObserved?.Invoke();
                    unexpected.TrySetResult(new BrowserPreparationException(BrowserPreparationFailure.FileChooserMultipleEvents));
                    break;
            }
            await Task.CompletedTask;
        }

        ExceptionDispatchInfo? primaryFailure = null;
        ExceptionDispatchInfo? cleanupFailure = null;
        _session.EventReceived += ObserveAsync;
        eventSubscriptionActive = true;
        try
        {
            _onEventSubscriptionRegistered?.Invoke();
            await _session.SendCommandAsync(
                "Page.setInterceptFileChooserDialog",
                JsonSerializer.SerializeToElement(new { enabled = true }),
                cancellationToken: cancellationToken);
            interceptionEnabled = true;

            triggerStarted = true;
            await triggerChooserAsync(cancellationToken);
            triggerCompleted = true;

            Task<Exception> transportTermination = _session.TransportTermination;
            try
            {
                await Task.WhenAny(opened.Task, unexpected.Task, transportTermination).WaitAsync(effectiveTimeout, cancellationToken);
            }
            catch (TimeoutException)
            {
                throw new BrowserPreparationException(
                    BrowserPreparationFailure.FileChooserTimedOut,
                    $"phase=waiting_for_fileChooserOpened; session_attached=true; interception_enabled={interceptionEnabled.ToString().ToLowerInvariant()}; event_subscription_active=true; trigger_started={triggerStarted.ToString().ToLowerInvariant()}; trigger_completed={triggerCompleted.ToString().ToLowerInvariant()}; file_chooser_event_received=false; expected_backend_node_id={expectedBackendNodeId?.ToString() ?? "unknown"}; ignored_event_count={Volatile.Read(ref ignoredEventCount)}; paths_count={paths.Count}; timeout_ms={effectiveTimeout.TotalMilliseconds:0}");
            }

            if (unexpected.Task.IsCompleted) throw await unexpected.Task;
            if (!opened.Task.IsCompleted) throw await transportTermination;

            FileChooserOpened chooser = await opened.Task;
            if (validateTransientInput)
            {
                await ValidateTransientInputAsync(chooser.BackendNodeId, paths.Count, cancellationToken);
            }

            if (_beforeAssignmentCommitAsync is not null)
            {
                await _beforeAssignmentCommitAsync(cancellationToken);
            }
            if (!observation.TryCommit())
            {
                throw new BrowserPreparationException(BrowserPreparationFailure.FileChooserMultipleEvents);
            }

            _session.EventReceived -= ObserveAsync;
            eventSubscriptionActive = false;
            await _session.SendCommandAsync(
                "DOM.setFileInputFiles",
                JsonSerializer.SerializeToElement(new { files = paths.ToArray(), backendNodeId = chooser.BackendNodeId }),
                cancellationToken: cancellationToken);
        }
        catch (Exception exception)
        {
            primaryFailure = ExceptionDispatchInfo.Capture(exception);
        }
        finally
        {
            if (eventSubscriptionActive)
            {
                _session.EventReceived -= ObserveAsync;
            }
            try
            {
                await _session.SendCommandAsync(
                    "Page.setInterceptFileChooserDialog",
                    JsonSerializer.SerializeToElement(new { enabled = false }),
                    cancellationToken: CancellationToken.None);
            }
            catch (Exception exception)
            {
                if (exception is CdpCommandException)
                {
                    Volatile.Write(ref _interceptionStateUncertain, 1);
                }
                cleanupFailure = ExceptionDispatchInfo.Capture(exception);
            }
            Volatile.Write(ref _active, 0);
        }

        if (primaryFailure is not null)
        {
            if (cleanupFailure is not null)
            {
                RetainCleanupFailure(primaryFailure.SourceException, cleanupFailure.SourceException);
            }
            primaryFailure.Throw();
        }

        cleanupFailure?.Throw();
    }

    private async Task ValidateTransientInputAsync(long backendNodeId, int pathCount, CancellationToken cancellationToken)
    {
        JsonElement result = await _session.SendCommandAsync(
            "DOM.describeNode",
            JsonSerializer.SerializeToElement(new { backendNodeId, depth = 0, pierce = false }),
            cancellationToken: cancellationToken);
        if (!result.TryGetProperty("node", out JsonElement node) ||
            !node.TryGetProperty("backendNodeId", out JsonElement describedBackendNodeId) ||
            !describedBackendNodeId.TryGetInt64(out long describedId) ||
            describedId != backendNodeId ||
            !string.Equals(NodeName(node), "INPUT", StringComparison.Ordinal) ||
            !TryParseAttributes(node, out IReadOnlyDictionary<string, string> attributes) ||
            !attributes.TryGetValue("type", out string? type) ||
            !string.Equals(type, "file", StringComparison.OrdinalIgnoreCase) ||
            attributes.ContainsKey("disabled"))
        {
            throw new BrowserPreparationException(BrowserPreparationFailure.FileChooserUnexpectedInput);
        }
        if (pathCount > 1 && !attributes.ContainsKey("multiple"))
        {
            throw new BrowserPreparationException(BrowserPreparationFailure.FileChooserMultipleFilesUnsupported);
        }
    }

    private static string? NodeName(JsonElement node) =>
        node.TryGetProperty("nodeName", out JsonElement nodeName) && nodeName.ValueKind == JsonValueKind.String
            ? nodeName.GetString() : null;

    private static bool TryParseAttributes(JsonElement node, out IReadOnlyDictionary<string, string> attributes)
    {
        attributes = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        if (!node.TryGetProperty("attributes", out JsonElement values) || values.ValueKind != JsonValueKind.Array)
        {
            return false;
        }

        var parsed = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        JsonElement.ArrayEnumerator enumerator = values.EnumerateArray();
        while (enumerator.MoveNext())
        {
            if (enumerator.Current.ValueKind != JsonValueKind.String)
            {
                return false;
            }

            string? name = enumerator.Current.GetString();
            if (string.IsNullOrEmpty(name) ||
                !enumerator.MoveNext() ||
                enumerator.Current.ValueKind != JsonValueKind.String)
            {
                return false;
            }

            string? value = enumerator.Current.GetString();
            if (value is null || !parsed.TryAdd(name, value))
            {
                return false;
            }
        }

        attributes = parsed;
        return true;
    }

    private sealed class FileChooserObservation
    {
        private readonly object _sync = new();
        private State _state;

        internal Result Observe()
        {
            lock (_sync)
            {
                return _state switch
                {
                    State.Waiting => Transition(State.Candidate, Result.Candidate),
                    State.Candidate => Transition(State.Ambiguous, Result.Ambiguous),
                    _ => Result.Ignored,
                };
            }
        }

        internal bool TryCommit()
        {
            lock (_sync)
            {
                if (_state != State.Candidate)
                {
                    return false;
                }

                _state = State.Committed;
                return true;
            }
        }

        private Result Transition(State next, Result result)
        {
            _state = next;
            return result;
        }

        private enum State
        {
            Waiting,
            Candidate,
            Ambiguous,
            Committed,
        }

        internal enum Result
        {
            Candidate,
            Ambiguous,
            Ignored,
        }
    }

    private static void RetainCleanupFailure(Exception primaryFailure, Exception cleanupFailure)
    {
        primaryFailure.Data["file_chooser_cleanup_phase"] = "cleanup";
        primaryFailure.Data["file_chooser_cleanup_operation"] = "disable_file_chooser_interception";
        primaryFailure.Data["file_chooser_cleanup_error_type"] = cleanupFailure.GetType().Name;
        switch (cleanupFailure)
        {
            case CdpCommandException commandFailure:
                primaryFailure.Data["file_chooser_cleanup_error"] = commandFailure.Code;
                break;
            case CdpTransportException transportFailure:
                primaryFailure.Data["file_chooser_cleanup_error"] = transportFailure.Failure.ToString();
                primaryFailure.Data["file_chooser_cleanup_transport_state"] = transportFailure.Failure.ToString();
                break;
            default:
                primaryFailure.Data["file_chooser_cleanup_error"] = "unknown";
                break;
        }
    }

    private sealed record FileChooserOpened(long BackendNodeId);
}
