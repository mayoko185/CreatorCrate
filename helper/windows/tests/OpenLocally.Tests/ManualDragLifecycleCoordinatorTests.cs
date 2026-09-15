using System.Collections.Concurrent;
using OpenLocally;

namespace OpenLocally.Tests;

public class ManualDragLifecycleCoordinatorTests
{
    [Fact]
    public async Task Preparation_SuppressesDuplicateAndUsesImmutableSelectionSnapshotThenAllowsLaterDrag()
    {
        var first = PendingPreparation();
        var second = PendingPreparation();
        var availability = new QueueAvailability(first, second);
        var posted = NewSignal();
        var dragged = new List<IReadOnlyList<string>>();
        int currentThread = 41;
        var coordinator = Coordinator(
            availability,
            postCompletion: () => { posted.TrySetResult(); return true; },
            runDrag: paths => { dragged.Add(paths); return FileDragResult.Copied; },
            currentThreadId: () => currentThread);
        coordinator.AttachNativeThread();
        var model = new ManualPublishingCompanionModel(Session(
            Platform("x", Prepared(1, "one.png"), Prepared(2, "two.png")),
            Platform("bluesky", Prepared(3, "three.png"))));

        IReadOnlyList<ManualDragAsset> snapshot = model.SnapshotSelectedAssets();
        Assert.True(coordinator.TryBegin(snapshot));
        model.SetNativeSelectedOrdinals([1]);
        model.SelectPlatform(1);
        Assert.False(coordinator.TryBegin(model.SnapshotSelectedAssets()));
        Assert.Single(availability.Selections);
        Assert.Equal(new long[] { 1, 2 }, availability.Selections[0].Select(item => item.Prepared.Asset.AssetId));
        Assert.Empty(dragged);

        first.SetResult(ManualDragPreparation.Ready([@"C:\stage\one.png", @"C:\stage\two.png"]));
        await posted.Task;
        Assert.Empty(dragged);
        Assert.True(coordinator.CompleteOnNativeThread());
        Assert.Equal(new[] { @"C:\stage\one.png", @"C:\stage\two.png" }, dragged.Single());
        Assert.False(coordinator.IsPreparing);

        posted = NewSignal();
        Assert.True(coordinator.TryBegin(model.SnapshotSelectedAssets()));
        Assert.Equal(2, availability.Selections.Count);
        second.SetResult(ManualDragPreparation.Fail("media_unavailable", "three.png"));
        await posted.Task;
        Assert.False(coordinator.CompleteOnNativeThread());
        Assert.False(coordinator.IsPreparing);
    }

    [Fact]
    public async Task Completion_IsPostedFromWorkerAndOleDragRunsOnlyOnBoundStaThread()
    {
        using var queue = new BlockingCollection<Action>();
        var preparation = PendingPreparation();
        var availability = new QueueAvailability(preparation);
        var ready = new TaskCompletionSource<ManualDragLifecycleCoordinator>(TaskCreationOptions.RunContinuationsAsynchronously);
        var uiActivity = NewSignal();
        var posted = NewSignal();
        var dragged = NewSignal();
        using var allowCompletionHandling = new ManualResetEventSlim();
        int nativeThreadId = 0;
        int postThreadId = 0;
        int dragThreadId = 0;
        ApartmentState dragApartment = ApartmentState.Unknown;
        var thread = new Thread(() =>
        {
            ManualDragLifecycleCoordinator? coordinator = null;
            coordinator = new ManualDragLifecycleCoordinator(
                availability,
                () =>
                {
                    postThreadId = Environment.CurrentManagedThreadId;
                    queue.Add(() =>
                    {
                        allowCompletionHandling.Wait();
                        coordinator!.CompleteOnNativeThread();
                    });
                    posted.TrySetResult();
                    return true;
                },
                _ =>
                {
                    dragThreadId = Environment.CurrentManagedThreadId;
                    dragApartment = Thread.CurrentThread.GetApartmentState();
                    dragged.TrySetResult();
                    return FileDragResult.Copied;
                },
                () => true,
                _ => { },
                _ => true);
            coordinator.AttachNativeThread();
            nativeThreadId = Environment.CurrentManagedThreadId;
            Assert.True(coordinator.TryBegin([Asset(1, "one.png")]));
            ready.TrySetResult(coordinator);
            foreach (Action action in queue.GetConsumingEnumerable()) action();
        });
        thread.SetApartmentState(ApartmentState.STA);
        thread.Start();
        ManualDragLifecycleCoordinator lifecycle = await ready.Task;
        try
        {
            queue.Add(() => uiActivity.TrySetResult());
            await uiActivity.Task;
            Assert.True(lifecycle.IsPreparing);
            Assert.False(dragged.Task.IsCompleted);

            await Task.Run(() => preparation.SetResult(ManualDragPreparation.Ready([@"C:\stage\one.png"])));
            await posted.Task;
            Assert.NotEqual(nativeThreadId, postThreadId);
            Assert.False(dragged.Task.IsCompleted);
            allowCompletionHandling.Set();
            await dragged.Task;
            Assert.Equal(nativeThreadId, dragThreadId);
            Assert.Equal(ApartmentState.STA, dragApartment);
            Assert.Equal(nativeThreadId, lifecycle.NativeThreadId);
        }
        finally
        {
            allowCompletionHandling.Set();
            queue.CompleteAdding();
            Assert.True(await Task.Run(() => thread.Join(TimeSpan.FromSeconds(5))));
        }
    }

    [Fact]
    public async Task AvailabilityFailureAndFault_ClearStateProduceLocalFeedbackAndAllowRetry()
    {
        var failure = PendingPreparation();
        var fault = PendingPreparation();
        var success = PendingPreparation();
        var availability = new QueueAvailability(failure, fault, success);
        var posts = new SemaphoreSlim(0);
        var feedback = new List<string>();
        int drags = 0;
        var coordinator = Coordinator(
            availability,
            () => { posts.Release(); return true; },
            _ => { drags++; return FileDragResult.Copied; },
            feedback: feedback);
        coordinator.AttachNativeThread();

        Assert.True(coordinator.TryBegin([Asset(1, "one.png")]));
        failure.SetResult(ManualDragPreparation.Fail("media_unavailable", "one.png"));
        await posts.WaitAsync();
        Assert.False(coordinator.CompleteOnNativeThread());
        Assert.False(coordinator.IsPreparing);
        Assert.Contains(feedback, message => message.Contains("media_unavailable", StringComparison.Ordinal));

        Assert.True(coordinator.TryBegin([Asset(1, "one.png")]));
        fault.SetException(new IOException("availability failed"));
        await posts.WaitAsync();
        Assert.False(coordinator.CompleteOnNativeThread());
        Assert.False(coordinator.IsPreparing);
        Assert.Contains("Unable to prepare", feedback[^1], StringComparison.Ordinal);

        Assert.True(coordinator.TryBegin([Asset(1, "one.png")]));
        success.SetResult(ManualDragPreparation.Ready([@"C:\stage\one.png"]));
        await posts.WaitAsync();
        Assert.True(coordinator.CompleteOnNativeThread());
        Assert.Equal(1, drags);
        Assert.False(coordinator.IsPreparing);
    }

    [Fact]
    public async Task CloseWhilePending_WaitsForTerminationBeforeNativeStateAndLeaseRelease()
    {
        var preparation = PendingPreparation();
        var cancellationObserved = NewSignal();
        var availability = new DelegateAvailability((_, token) =>
        {
            token.Register(() => cancellationObserved.TrySetResult());
            return preparation.Task;
        });
        var events = new List<string>();
        var lease = new RecordingLease(() => events.Add("lease"));
        int posts = 0;
        var coordinator = Coordinator(
            availability,
            () => { posts++; return true; },
            _ => { events.Add("drag"); return FileDragResult.Copied; });
        coordinator.AttachNativeThread();
        Assert.True(coordinator.TryBegin([Asset(1, "one.png")]));

        Task shutdown = coordinator.ShutdownAsync(() => events.Add("native-release"), lease);
        await cancellationObserved.Task;
        events.Add("cancel-observed");
        Assert.False(shutdown.IsCompleted);
        Assert.False(lease.Disposed);
        Assert.DoesNotContain("native-release", events);

        preparation.SetCanceled();
        await shutdown;
        Assert.Equal(new[] { "cancel-observed", "native-release", "lease" }, events);
        Assert.Equal(0, posts);
        Assert.DoesNotContain("drag", events);
        Assert.False(coordinator.IsPreparing);
        Assert.False(coordinator.TryBegin([Asset(1, "one.png")]));
    }

    [Fact]
    public async Task SuccessfulPreparationCompletingAfterClose_IsNotPostedOrDragged()
    {
        var preparation = PendingPreparation();
        int posts = 0;
        int drags = 0;
        var coordinator = Coordinator(
            new QueueAvailability(preparation),
            () => { posts++; return true; },
            _ => { drags++; return FileDragResult.Copied; });
        coordinator.AttachNativeThread();
        Assert.True(coordinator.TryBegin([Asset(1, "one.png")]));

        coordinator.BeginClose();
        preparation.SetResult(ManualDragPreparation.Ready([@"C:\stage\one.png"]));
        await coordinator.StopPendingAsync();

        Assert.Equal(0, posts);
        Assert.Equal(0, drags);
        Assert.False(coordinator.CompleteOnNativeThread());
        Assert.False(coordinator.IsPreparing);
    }

    [Fact]
    public async Task QueuedCompletionProcessedAfterClose_IsRejectedWithoutFeedbackOrDrag()
    {
        var preparation = PendingPreparation();
        var posted = NewSignal();
        var feedback = new List<string>();
        int drags = 0;
        var coordinator = Coordinator(
            new QueueAvailability(preparation),
            () => { posted.TrySetResult(); return true; },
            _ => { drags++; return FileDragResult.Copied; },
            feedback: feedback);
        coordinator.AttachNativeThread();
        Assert.True(coordinator.TryBegin([Asset(1, "one.png")]));
        preparation.SetResult(ManualDragPreparation.Ready([@"C:\stage\one.png"]));
        await posted.Task;
        int feedbackBeforeClose = feedback.Count;

        coordinator.BeginClose();
        Assert.False(coordinator.CompleteOnNativeThread());

        Assert.Equal(0, drags);
        Assert.Equal(feedbackBeforeClose, feedback.Count);
        Assert.False(coordinator.IsPreparing);
    }

    [Fact]
    public void CompletionPostingFailure_ClearsPreparationAndDoesNotDragOrHang()
    {
        int posts = 0;
        int drags = 0;
        var coordinator = Coordinator(
            new DelegateAvailability((_, _) => Task.FromResult(ManualDragPreparation.Ready([@"C:\stage\one.png"]))),
            () => { posts++; return false; },
            _ => { drags++; return FileDragResult.Copied; });
        coordinator.AttachNativeThread();

        Assert.True(coordinator.TryBegin([Asset(1, "one.png")]));

        Assert.Equal(1, posts);
        Assert.Equal(0, drags);
        Assert.False(coordinator.IsPreparing);
        Assert.False(coordinator.CompleteOnNativeThread());
    }

    [Theory]
    [InlineData((int)FileDragResult.Copied, "Files dropped")]
    [InlineData((int)FileDragResult.Cancelled, "File drag cancelled")]
    [InlineData((int)FileDragResult.Rejected, "did not accept")]
    [InlineData((int)FileDragResult.Failed, "could not complete")]
    public async Task OleResult_AlwaysResetsStateReportsTruthAndRetainsLeaseUntilShutdown(
        int resultValue, string expectedFeedback)
    {
        FileDragResult result = (FileDragResult)resultValue;
        var posted = NewSignal();
        var feedback = new List<string>();
        var lease = new RecordingLease();
        var coordinator = Coordinator(
            new DelegateAvailability((_, _) => Task.FromResult(ManualDragPreparation.Ready([@"C:\stage\one.png"]))),
            () => { posted.TrySetResult(); return true; },
            _ => result,
            feedback: feedback);
        coordinator.AttachNativeThread();

        Assert.True(coordinator.TryBegin([Asset(1, "one.png")]));
        await posted.Task;
        Assert.True(coordinator.CompleteOnNativeThread());

        Assert.False(coordinator.IsPreparing);
        Assert.Contains(expectedFeedback, feedback[^1], StringComparison.OrdinalIgnoreCase);
        Assert.False(lease.Disposed);
        await coordinator.ShutdownAsync(() => { }, lease);
        Assert.True(lease.Disposed);
    }

    [Fact]
    public async Task NativeOleFailure_ResetsStateRetainsLeaseAndProducesFailureFeedback()
    {
        var feedback = new List<string>();
        var lease = new RecordingLease();
        var coordinator = Coordinator(
            new DelegateAvailability((_, _) => Task.FromResult(ManualDragPreparation.Ready([@"C:\stage\one.png"]))),
            () => true,
            _ => throw new InvalidOperationException("OLE failed"),
            feedback: feedback);
        coordinator.AttachNativeThread();

        Assert.True(coordinator.TryBegin([Asset(1, "one.png")]));
        Assert.False(coordinator.CompleteOnNativeThread());

        Assert.False(coordinator.IsPreparing);
        Assert.Contains("Unable to prepare", feedback[^1], StringComparison.Ordinal);
        Assert.False(lease.Disposed);
        await coordinator.ShutdownAsync(() => { }, lease);
        Assert.True(lease.Disposed);
    }

    [Fact]
    public void EmptyOrIneligibleSelection_DoesNotPrepareOrInvokeOle()
    {
        var availability = new QueueAvailability();
        var feedback = new List<string>();
        int drags = 0;
        var coordinator = Coordinator(
            availability,
            () => true,
            _ => { drags++; return FileDragResult.Copied; },
            feedback: feedback);
        coordinator.AttachNativeThread();
        var model = new ManualPublishingCompanionModel(Session(
            new ManualPreparedPlatform("x", "Release", "Post", [Prepared(1, "missing.png", present: false)])));

        Assert.False(coordinator.TryBegin([]));
        Assert.False(coordinator.TryBegin(model.SnapshotSelectedAssets()));

        Assert.Empty(availability.Selections);
        Assert.Equal(0, drags);
        Assert.False(coordinator.IsPreparing);
        Assert.All(feedback, message => Assert.Contains("Select at least one", message, StringComparison.Ordinal));
    }

    [Fact]
    public async Task CompletionOnWrongThread_CannotInvokeOleAndNativeThreadCanStillHandlePostedResult()
    {
        var preparation = PendingPreparation();
        var posted = NewSignal();
        int currentThread = 10;
        int drags = 0;
        var coordinator = Coordinator(
            new QueueAvailability(preparation),
            () => { posted.TrySetResult(); return true; },
            _ => { drags++; return FileDragResult.Copied; },
            currentThreadId: () => currentThread);
        coordinator.AttachNativeThread();
        Assert.True(coordinator.TryBegin([Asset(1, "one.png")]));
        preparation.SetResult(ManualDragPreparation.Ready([@"C:\stage\one.png"]));
        await posted.Task;

        currentThread = 99;
        Assert.False(coordinator.CompleteOnNativeThread());
        Assert.Equal(0, drags);
        Assert.True(coordinator.IsPreparing);

        currentThread = 10;
        Assert.True(coordinator.CompleteOnNativeThread());
        Assert.Equal(1, drags);
        Assert.False(coordinator.IsPreparing);
    }

    private static ManualDragLifecycleCoordinator Coordinator(
        IManualAssetAvailability availability,
        Func<bool> postCompletion,
        Func<IReadOnlyList<string>, FileDragResult> runDrag,
        List<string>? feedback = null,
        Func<int>? currentThreadId = null) =>
        new(
            availability,
            postCompletion,
            runDrag,
            () => true,
            message => feedback?.Add(message),
            _ => true,
            currentThreadId ?? (() => 1),
            () => ApartmentState.STA);

    private static TaskCompletionSource<ManualDragPreparation> PendingPreparation() =>
        new(TaskCreationOptions.RunContinuationsAsynchronously);

    private static TaskCompletionSource NewSignal() =>
        new(TaskCreationOptions.RunContinuationsAsynchronously);

    private static ManualDragAsset Asset(long id, string filename) => new(Prepared(id, filename), checked((int)id - 1));

    private static ManualPreparedAsset Prepared(long id, string filename, bool present = true) =>
        new(new SocialRedeemAsset(id, "attachment", id, filename, ".png", "image/png", 10,
            $"release/{filename}", present, null), $@"C:\stage\{filename}", StagedMediaProvenance.HelperOwned);

    private static ManualPreparedPlatform Platform(string platform, params ManualPreparedAsset[] assets) =>
        new(platform, "Release", "Post", assets);

    private static ManualSocialSession Session(params ManualPreparedPlatform[] platforms) =>
        new(new Uri("https://creatorcrate.test/"), 42, "Release", platforms);

    private sealed class QueueAvailability(params TaskCompletionSource<ManualDragPreparation>[] responses) : IManualAssetAvailability
    {
        private readonly Queue<TaskCompletionSource<ManualDragPreparation>> _responses = new(responses);
        public List<IReadOnlyList<ManualDragAsset>> Selections { get; } = [];

        public Task<ManualDragPreparation> PrepareAsync(
            IReadOnlyList<ManualDragAsset> selected, CancellationToken cancellationToken)
        {
            Selections.Add(selected.ToArray());
            return _responses.Dequeue().Task;
        }
    }

    private sealed class DelegateAvailability(
        Func<IReadOnlyList<ManualDragAsset>, CancellationToken, Task<ManualDragPreparation>> prepare) : IManualAssetAvailability
    {
        public Task<ManualDragPreparation> PrepareAsync(
            IReadOnlyList<ManualDragAsset> selected, CancellationToken cancellationToken) => prepare(selected, cancellationToken);
    }

    private sealed class RecordingLease(Action? onDispose = null) : IDisposable
    {
        public bool Disposed { get; private set; }
        public void Dispose()
        {
            Disposed = true;
            onDispose?.Invoke();
        }
    }
}
