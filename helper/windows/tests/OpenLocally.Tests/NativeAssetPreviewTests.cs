using Microsoft.Win32.SafeHandles;
using OpenLocally;
using System.Collections.Concurrent;
using System.Net;
using System.Text;

namespace OpenLocally.Tests;

public sealed class NativeAssetPreviewTests
{
    [Fact]
    public async Task SuccessfulExtraction_HoldsOneLeaseThroughCopy_CachesPixelsAndReleasesResources()
    {
        var access = new FakeAccess();
        var apartment = new FakeApartment();
        var signaled = new SemaphoreSlim(0);
        var extractor = new FakeExtractor((_, size) =>
        {
            Assert.True(access.LeaseAlive);
            return Pixels(size, alpha: 127);
        });
        await using var pipeline = new NativeAssetPreviewPipeline(access, () => Signal(signaled), extractor, apartment);
        NativePreviewRequest request = Request(Prepared(1, "image.png", true), ordinal: 0, generation: 1, platform: 0, size: 48);

        Assert.True(pipeline.TrySchedule(request));
        Assert.True(await signaled.WaitAsync(TimeSpan.FromSeconds(5)));
        NativePreviewResult result = TakeResult(pipeline);

        Assert.Equal(NativePreviewOutcome.Thumbnail, result.Outcome);
        Assert.Equal(127, result.Pixels!.Bgra[3]);
        Assert.Equal(1, access.AcquireCalls);
        Assert.False(access.LeaseAlive);
        Assert.Equal(1, access.LeaseDisposals);
        Assert.Equal(1, pipeline.Cache.Count);

        Assert.True(pipeline.TrySchedule(request));
        Assert.True(await signaled.WaitAsync(TimeSpan.FromSeconds(5)));
        NativePreviewResult cached = TakeResult(pipeline);
        Assert.Equal(127, cached.Pixels!.Bgra[3]);
        Assert.NotSame(result.Pixels.Bgra, cached.Pixels.Bgra);
        Assert.Equal(1, extractor.Calls);
        Assert.Equal(2, access.AcquireCalls);
        Assert.Equal(2, access.LeaseDisposals);
    }

    [Fact]
    public async Task PreviewAccessFailure_IsContainedWithoutShellInvocationOrAvailabilityMutation()
    {
        ManualPreparedAsset prepared = Prepared(1, "image.png", true);
        var model = new ManualPublishingCompanionModel(Session(prepared));
        model.SetNativeSelectedOrdinals([0]);
        var access = new FakeAccess { FailAccess = true };
        var extractor = new FakeExtractor((_, size) => Pixels(size));
        var signaled = new SemaphoreSlim(0);
        await using var pipeline = new NativeAssetPreviewPipeline(access, () => Signal(signaled), extractor, new FakeApartment());

        Assert.True(pipeline.TrySchedule(Request(prepared, 0, 1, 0, 48)));
        Assert.True(await signaled.WaitAsync(TimeSpan.FromSeconds(5)));
        NativePreviewResult result = TakeResult(pipeline);

        Assert.Equal(NativePreviewOutcome.PreviewAccessFailed, result.Outcome);
        Assert.Equal(0, extractor.Calls);
        Assert.True(ManualPublishingCompanionModel.IsAvailable(prepared));
        Assert.Equal([0], model.SelectedOrdinals);
        Assert.Equal([0], model.SnapshotSelectedAssets().Select(item => item.Ordinal));
        Assert.Equal("Available", Assert.Single(model.AssetRows).Status);
    }

    [Fact]
    public async Task ShellFailure_ReleasesLeaseAndProducesOnlyPresentationFailure()
    {
        var access = new FakeAccess();
        var signaled = new SemaphoreSlim(0);
        await using var pipeline = new NativeAssetPreviewPipeline(
            access, () => Signal(signaled), new FakeExtractor((_, _) => null), new FakeApartment());

        Assert.True(pipeline.TrySchedule(Request(Prepared(1, "corrupt.png", true), 0, 1, 0, 48)));
        Assert.True(await signaled.WaitAsync(TimeSpan.FromSeconds(5)));
        NativePreviewResult result = TakeResult(pipeline);

        Assert.Equal(NativePreviewOutcome.ExtractionFailed, result.Outcome);
        Assert.Equal(1, access.LeaseDisposals);
        Assert.False(access.LeaseAlive);
    }

    [Fact]
    public async Task ComInitializationFailure_ProducesPlaceholderResultWithoutLeaseOrCompanionFailure()
    {
        var access = new FakeAccess();
        var signaled = new SemaphoreSlim(0);
        await using var pipeline = new NativeAssetPreviewPipeline(
            access, () => Signal(signaled), new FakeExtractor((_, size) => Pixels(size)), new FailingApartment());

        Assert.True(pipeline.TrySchedule(Request(Prepared(1, "image.png", true), 0, 1, 0, 48)));
        Assert.True(await signaled.WaitAsync(TimeSpan.FromSeconds(5)));
        NativePreviewResult result = TakeResult(pipeline);

        Assert.Equal(NativePreviewOutcome.ComUnavailable, result.Outcome);
        Assert.Equal(1, access.AcquireCalls);
        Assert.Equal(1, access.LeaseDisposals);
    }

    [Fact]
    public async Task DedicatedWorkersReleaseTheirComApartmentResourcesOnClose()
    {
        var apartment = new FakeApartment();
        var pipeline = new NativeAssetPreviewPipeline(
            new FakeAccess(), () => true, new FakeExtractor((_, size) => Pixels(size)), apartment);
        Assert.True(apartment.AllEntered.Wait(TimeSpan.FromSeconds(5)));

        await pipeline.DisposeAsync();

        Assert.Equal(NativeAssetPreviewPipeline.WorkerCount, apartment.EnterCalls);
        Assert.Equal(NativeAssetPreviewPipeline.WorkerCount, apartment.DisposeCalls);
    }

    [Fact]
    public async Task ProductionWorkersAreStaFromBirth_AndBothExecutePreviewWork()
    {
        var entered = new ConcurrentDictionary<int, ApartmentState>();
        var extracting = new CountdownEvent(NativeAssetPreviewPipeline.WorkerCount);
        var release = new ManualResetEventSlim(false);
        var signal = new SemaphoreSlim(0);
        var hooks = new NativePreviewPipelineTestHooks(
            WorkerApartmentEntered: (threadId, state) => entered[threadId] = state);
        await using var pipeline = new NativeAssetPreviewPipeline(
            new FakeAccess(), () => Signal(signal),
            new FakeExtractor((_, size) =>
            {
                extracting.Signal();
                release.Wait();
                return Pixels(size);
            }), testHooks: hooks);

        Assert.True(SpinWait.SpinUntil(
            () => entered.Count == NativeAssetPreviewPipeline.WorkerCount, TimeSpan.FromSeconds(5)));
        Assert.True(pipeline.TrySchedule(Request(Prepared(1, "first.png", true), 0, 1, 0, 48)));
        Assert.True(pipeline.TrySchedule(Request(Prepared(2, "second.png", true), 1, 1, 0, 48)));
        Assert.True(extracting.Wait(TimeSpan.FromSeconds(5)));
        release.Set();
        Assert.All(entered.Values, state => Assert.Equal(ApartmentState.STA, state));
    }

    [Theory]
    [InlineData(0)]
    [InlineData(1)]
    public void ComApartment_SuccessIsBalancedExactlyOnce(int initializeResult)
    {
        int initializes = 0, uninitializes = 0;
        var apartment = new NativePreviewWorkerApartment(
            model => { Assert.Equal(2u, model); initializes++; return initializeResult; },
            () => uninitializes++);

        IDisposable scope = Assert.IsAssignableFrom<IDisposable>(apartment.TryEnter());
        scope.Dispose();
        scope.Dispose();

        Assert.Equal(1, initializes);
        Assert.Equal(1, uninitializes);
    }

    [Fact]
    public void ComApartment_FailureDoesNotUninitialize()
    {
        int uninitializes = 0;
        var apartment = new NativePreviewWorkerApartment(_ => unchecked((int)0x80010106), () => uninitializes++);

        Assert.Null(apartment.TryEnter());

        Assert.Equal(0, uninitializes);
    }

    [Fact]
    public async Task WorkerApartmentAssignmentFailure_StartsNoMtaFallbackAndRejectsBoundedWork()
    {
        int configured = 0;
        var pipeline = new NativeAssetPreviewPipeline(
            new FakeAccess(), () => true, new FakeExtractor((_, size) => Pixels(size)),
            testHooks: new NativePreviewPipelineTestHooks(
                ConfigureWorkerApartment: _ => Interlocked.Increment(ref configured) != 2));

        Assert.False(pipeline.TrySchedule(Request(Prepared(1, "image.png", true), 0, 1, 0, 48)));
        await pipeline.DisposeAsync();

        Assert.Equal(NativeAssetPreviewPipeline.WorkerCount, configured);
        Assert.Equal(0, pipeline.OutstandingCount);
    }

    [Fact]
    public async Task ProductionPipeline_HelperOwnedRealPng_ReachesShellAndReturnsThumbnailOnOneStaWorker()
    {
        using NativePreviewOwnedPngFixture fixture = await NativePreviewOwnedPngFixture.CreateAsync();
        var signal = new SemaphoreSlim(0);
        var workerEntries = new ConcurrentDictionary<int, ApartmentState>();
        var shellThreads = new ConcurrentBag<int>();
        int shellItemResult = int.MinValue, getImageResult = int.MinValue;
        IntPtr bitmap = IntPtr.Zero;
        bool pixelsCopied = false;
        int bitmapReleased = 0, comReleased = 0;
        var hooks = new NativePreviewPipelineTestHooks(
            WorkerApartmentEntered: (threadId, state) => workerEntries[threadId] = state);
        var extractor = new NativeShellThumbnailExtractor(new NativeShellThumbnailTestHooks(
            () => { shellThreads.Add(Environment.CurrentManagedThreadId); bitmapReleased++; },
            () => { shellThreads.Add(Environment.CurrentManagedThreadId); comReleased++; },
            result => { shellThreads.Add(Environment.CurrentManagedThreadId); shellItemResult = result; },
            (result, value) => { shellThreads.Add(Environment.CurrentManagedThreadId); getImageResult = result; bitmap = value; },
            copied => { shellThreads.Add(Environment.CurrentManagedThreadId); pixelsCopied = copied; }));
        await using var pipeline = new NativeAssetPreviewPipeline(
            fixture.CreateAccess(), () => Signal(signal), extractor, testHooks: hooks);

        Assert.True(pipeline.TrySchedule(Request(fixture.Prepared, 0, 1, 0, 48)));
        Assert.True(await signal.WaitAsync(TimeSpan.FromSeconds(10)));
        NativePreviewResult result = TakeResult(pipeline);

        Assert.Equal(NativePreviewOutcome.Thumbnail, result.Outcome);
        Assert.NotNull(result.Pixels);
        Assert.Equal(48, result.Pixels!.Width);
        Assert.Equal(48, result.Pixels.Height);
        Assert.NotEmpty(result.Pixels.Bgra);
        Assert.Equal(0, shellItemResult);
        Assert.Equal(0, getImageResult);
        Assert.NotEqual(IntPtr.Zero, bitmap);
        Assert.True(pixelsCopied);
        Assert.Equal(1, bitmapReleased);
        Assert.Equal(1, comReleased);
        int shellThread = Assert.Single(shellThreads.Distinct());
        Assert.Equal(ApartmentState.STA, workerEntries[shellThread]);
        Assert.Equal(1, pipeline.Cache.Count);
    }

    [Fact]
    public async Task CloseStopsNewWork_LetsActiveLeaseFinish_AndClearsCache()
    {
        var started = new ManualResetEventSlim(false);
        var finish = new ManualResetEventSlim(false);
        var access = new FakeAccess();
        var cache = new NativePreviewCache();
        var pipeline = new NativeAssetPreviewPipeline(
            access, () => true, new FakeExtractor((_, size) =>
            {
                started.Set();
                finish.Wait();
                return Pixels(size);
            }), new FakeApartment(), cache);
        NativePreviewRequest active = Request(Prepared(1, "active.png", true), 0, 3, 0, 48);
        Assert.True(pipeline.TrySchedule(active));
        Assert.True(started.Wait(TimeSpan.FromSeconds(5)));

        pipeline.BeginClose();
        Assert.False(pipeline.TrySchedule(Request(Prepared(2, "late.png", true), 1, 3, 0, 48)));
        finish.Set();
        await pipeline.DisposeAsync();

        Assert.False(access.LeaseAlive);
        Assert.Equal(1, access.LeaseDisposals);
        Assert.True(access.Disposed);
        Assert.Equal(0, cache.Count);
    }

    [Fact]
    public async Task TwoWorkersMayCompleteOutOfOrder_AndResultsRetainStableIdentity()
    {
        var firstGate = new ManualResetEventSlim(false);
        var secondGate = new ManualResetEventSlim(false);
        var bothStarted = new CountdownEvent(2);
        var signal = new SemaphoreSlim(0);
        var extractor = new FakeExtractor((path, size) =>
        {
            bothStarted.Signal();
            (path.EndsWith("first.png", StringComparison.OrdinalIgnoreCase) ? firstGate : secondGate).Wait();
            return Pixels(size);
        });
        await using var pipeline = new NativeAssetPreviewPipeline(
            new FakeAccess(), () => Signal(signal), extractor, new FakeApartment());
        NativePreviewRequest first = Request(Prepared(1, "first.png", true), 0, 7, 0, 48);
        NativePreviewRequest second = Request(Prepared(2, "second.png", true), 1, 7, 0, 48);

        Assert.True(pipeline.TrySchedule(first));
        Assert.True(pipeline.TrySchedule(second));
        Assert.True(bothStarted.Wait(TimeSpan.FromSeconds(5)));
        secondGate.Set();
        Assert.True(await signal.WaitAsync(TimeSpan.FromSeconds(5)));
        NativePreviewResult completedSecond = TakeResult(pipeline);
        firstGate.Set();
        Assert.True(await signal.WaitAsync(TimeSpan.FromSeconds(5)));
        NativePreviewResult completedFirst = TakeResult(pipeline);

        Assert.Equal(1, completedSecond.Request.Ordinal);
        Assert.Equal(2, completedSecond.Request.Prepared.Asset.AssetId);
        Assert.Equal(0, completedFirst.Request.Ordinal);
        Assert.Equal(1, completedFirst.Request.Prepared.Asset.AssetId);
    }

    [Fact]
    public async Task SchedulePausedBeforeAcceptance_CloseCompletes_ThenScheduleRejectsWithoutException()
    {
        var schedulerEntered = new ManualResetEventSlim(false);
        var resumeScheduler = new ManualResetEventSlim(false);
        int hookCalls = 0;
        var pipeline = new NativeAssetPreviewPipeline(
            new FakeAccess(), () => true, new FakeExtractor((_, size) => Pixels(size)), new FakeApartment(),
            testHooks: new NativePreviewPipelineTestHooks(BeforeAcceptanceLock: () =>
            {
                if (Interlocked.Increment(ref hookCalls) != 1) return;
                schedulerEntered.Set();
                resumeScheduler.Wait();
            }));

        Task<bool> scheduling = Task.Run(() => pipeline.TrySchedule(Request(Prepared(1, "racing.png", true), 0, 1, 0, 48)));
        Assert.True(schedulerEntered.Wait(TimeSpan.FromSeconds(5)));
        pipeline.BeginClose();
        resumeScheduler.Set();

        Assert.False(await scheduling.WaitAsync(TimeSpan.FromSeconds(5)));
        Parallel.For(0, 1_000, index =>
            Assert.False(pipeline.TrySchedule(Request(Prepared(index + 2, $"late-{index}.png", true), index, 2, 0, 48))));
        await pipeline.DisposeAsync();
        Assert.Equal(0, pipeline.OutstandingCount);
    }

    [Fact]
    public async Task UiNotDraining_TotalOutstandingAndResultsStayBounded_OverflowRecoversBudget()
    {
        var workersStarted = new CountdownEvent(NativeAssetPreviewPipeline.WorkerCount);
        var releaseWorkers = new ManualResetEventSlim(false);
        var extracted = new CountdownEvent(NativeAssetPreviewPipeline.OutstandingCapacity);
        int notifications = 0, workerStarts = 0;
        var pipeline = new NativeAssetPreviewPipeline(
            new FakeAccess(), () => { Interlocked.Increment(ref notifications); return true; },
            new FakeExtractor((_, size) =>
            {
                if (Interlocked.Increment(ref workerStarts) <= NativeAssetPreviewPipeline.WorkerCount)
                    workersStarted.Signal();
                releaseWorkers.Wait();
                extracted.Signal();
                return Pixels(size);
            }), new FakeApartment());

        for (int index = 0; index < NativeAssetPreviewPipeline.OutstandingCapacity; index++)
            Assert.True(pipeline.TrySchedule(Request(Prepared(index + 1, $"churn-{index}.png", true), index, index % 3, index % 3, 48 + index % 2)));
        Assert.False(pipeline.TrySchedule(Request(Prepared(10_000, "over-budget.png", true), 0, 4, 0, 48)));
        Assert.True(workersStarted.Wait(TimeSpan.FromSeconds(5)));
        Assert.Equal(NativeAssetPreviewPipeline.OutstandingCapacity, pipeline.OutstandingCount);

        releaseWorkers.Set();
        Assert.True(extracted.Wait(TimeSpan.FromSeconds(10)));
        Assert.True(SpinWait.SpinUntil(
            () => pipeline.OutstandingCount == NativeAssetPreviewPipeline.ResultCapacity,
            TimeSpan.FromSeconds(5)));

        Assert.Equal(NativeAssetPreviewPipeline.OutstandingCapacity, pipeline.MaximumOutstandingCount);
        Assert.Equal(NativeAssetPreviewPipeline.ResultCapacity, pipeline.ResultCount);
        Assert.Equal(1, notifications);
        Assert.True(pipeline.NotificationPending);
        Assert.Equal(NativeAssetPreviewPipeline.ResultCapacity, pipeline.DrainResults(_ => { }));
        Assert.Equal(0, pipeline.OutstandingCount);
        Assert.Equal(0, pipeline.ResultCount);
        Assert.False(pipeline.NotificationPending);
        await pipeline.DisposeAsync();
    }

    [Fact]
    public async Task CompletionRacingNotificationReset_IsRepostedWithoutDuplicatePendingMessages()
    {
        var resetEntered = new ManualResetEventSlim(false);
        var resumeReset = new ManualResetEventSlim(false);
        int resetCalls = 0, notifications = 0, extractions = 0;
        var pipeline = new NativeAssetPreviewPipeline(
            new FakeAccess(), () => { Interlocked.Increment(ref notifications); return true; },
            new FakeExtractor((_, size) => { Interlocked.Increment(ref extractions); return Pixels(size); }),
            new FakeApartment(), testHooks: new NativePreviewPipelineTestHooks(BeforeNotificationReset: () =>
            {
                if (Interlocked.Increment(ref resetCalls) != 1) return;
                resetEntered.Set();
                resumeReset.Wait();
            }));

        Assert.True(pipeline.TrySchedule(Request(Prepared(1, "first.png", true), 0, 1, 0, 48)));
        Assert.True(SpinWait.SpinUntil(() => Volatile.Read(ref notifications) == 1, TimeSpan.FromSeconds(5)));
        Task<int> firstDrain = Task.Run(() => pipeline.DrainResults(_ => { }, 1));
        Assert.True(resetEntered.Wait(TimeSpan.FromSeconds(5)));

        Assert.True(pipeline.TrySchedule(Request(Prepared(2, "second.png", true), 1, 2, 1, 72)));
        Assert.True(SpinWait.SpinUntil(() => pipeline.ResultCount == 1, TimeSpan.FromSeconds(5)));
        Assert.Equal(1, notifications);
        resumeReset.Set();

        Assert.Equal(1, await firstDrain.WaitAsync(TimeSpan.FromSeconds(5)));
        Assert.True(SpinWait.SpinUntil(() => Volatile.Read(ref notifications) == 2, TimeSpan.FromSeconds(5)));
        Assert.True(pipeline.NotificationPending);
        Assert.Equal(1, pipeline.DrainResults(_ => { }, 1));
        Assert.Equal(0, pipeline.OutstandingCount);
        Assert.Equal(2, extractions);
        await pipeline.DisposeAsync();
    }

    [Fact]
    public async Task FailedResultNotification_DiscardsPresentationAndRecoversOutstandingBudget()
    {
        var extractorCalled = new ManualResetEventSlim(false);
        var pipeline = new NativeAssetPreviewPipeline(
            new FakeAccess(), () => throw new InvalidOperationException("window closed"),
            new FakeExtractor((_, size) => { extractorCalled.Set(); return Pixels(size); }), new FakeApartment());

        Assert.True(pipeline.TrySchedule(Request(Prepared(1, "orphaned.png", true), 0, 1, 0, 48)));
        Assert.True(extractorCalled.Wait(TimeSpan.FromSeconds(5)));
        Assert.True(SpinWait.SpinUntil(() => pipeline.OutstandingCount == 0, TimeSpan.FromSeconds(5)));
        Assert.Equal(0, pipeline.ResultCount);
        Assert.False(pipeline.NotificationPending);
        await pipeline.DisposeAsync();
    }

    [Fact]
    public async Task CloseWithFullQueueActiveWorkersAndPendingResult_ReleasesAllOutstandingWork()
    {
        var workersStarted = new CountdownEvent(NativeAssetPreviewPipeline.WorkerCount);
        var finish = new ManualResetEventSlim(false);
        int extractionCalls = 0;
        var pipeline = new NativeAssetPreviewPipeline(
            new FakeAccess(), () => true, new FakeExtractor((_, size) =>
            {
                int call = Interlocked.Increment(ref extractionCalls);
                if (call == 1) return Pixels(size);
                if (call <= NativeAssetPreviewPipeline.WorkerCount + 1)
                    workersStarted.Signal();
                finish.Wait();
                return Pixels(size);
            }), new FakeApartment());
        Assert.True(pipeline.TrySchedule(Request(Prepared(1, "completed.png", true), 0, 1, 0, 48)));
        Assert.True(SpinWait.SpinUntil(() => pipeline.ResultCount == 1, TimeSpan.FromSeconds(5)));
        for (int index = 1; index < NativeAssetPreviewPipeline.OutstandingCapacity; index++)
            Assert.True(pipeline.TrySchedule(Request(Prepared(index + 1, $"close-{index}.png", true), index, 1, 0, 48)));
        Assert.True(workersStarted.Wait(TimeSpan.FromSeconds(5)));
        Assert.Equal(NativeAssetPreviewPipeline.OutstandingCapacity, pipeline.OutstandingCount);
        Assert.True(pipeline.NotificationPending);

        pipeline.BeginClose();
        Assert.False(pipeline.TrySchedule(Request(Prepared(20_000, "late.png", true), 0, 2, 0, 48)));
        finish.Set();
        await pipeline.DisposeAsync().AsTask().WaitAsync(TimeSpan.FromSeconds(10));

        Assert.Equal(0, pipeline.OutstandingCount);
        Assert.Equal(0, pipeline.ResultCount);
        Assert.False(pipeline.NotificationPending);
    }

    [Fact]
    public void ResultIdentityRejectsPlatformGenerationDpiAndAssetChanges()
    {
        ManualPreparedAsset asset = Prepared(1, "image.png", true);
        ManualPreparedPlatform platform = Session(asset).Platforms[0];
        NativePreviewRequest request = Request(asset, 0, 4, 0, 48);

        Assert.True(NativeManualPublishingCompanion.NativeWindow.PreviewResultMatches(request, 4, 0, platform, 48));
        Assert.False(NativeManualPublishingCompanion.NativeWindow.PreviewResultMatches(request, 5, 0, platform, 48));
        Assert.False(NativeManualPublishingCompanion.NativeWindow.PreviewResultMatches(request, 4, 1, platform, 48));
        Assert.False(NativeManualPublishingCompanion.NativeWindow.PreviewResultMatches(request, 4, 0, platform, 72));
        var replaced = new ManualPreparedPlatform(platform.Platform, platform.Title, platform.Body,
            [Prepared(1, "image.png", true)]);
        Assert.False(NativeManualPublishingCompanion.NativeWindow.PreviewResultMatches(request, 4, 0, replaced, 48));
    }

    [Fact]
    public void CacheUsesAssetPathSizeDpiAndPinnedFileIdentity_IsBoundedAndDropsPixelsOnDispose()
    {
        using var cache = new NativePreviewCache(2);
        ManualPreparedAsset first = Prepared(1, "same.png", true);
        ManualPreparedAsset second = Prepared(2, "same.png", true);
        NativePreviewCacheKey first48 = Key(first, 48, Identity(1));
        NativePreviewCacheKey first72 = Key(first, 72, Identity(1));
        NativePreviewCacheKey second48 = Key(second, 48, Identity(2));
        cache.Store(first48, Pixels(48));
        cache.Store(first72, Pixels(72));
        Assert.True(cache.TryGet(first48, out _));
        cache.Store(second48, Pixels(48));

        Assert.True(cache.TryGet(first48, out _));
        Assert.False(cache.TryGet(first72, out _));
        Assert.True(cache.TryGet(second48, out _));
        Assert.Equal(2, cache.Count);
        cache.Dispose();
        Assert.Equal(0, cache.Count);
        Assert.False(cache.TryGet(first48, out _));
    }

    [Fact]
    public async Task RealFile_UnchangedReacquisitionHitsCacheAfterFreshLease()
    {
        using var file = new PreviewFileFixture([11, 12, 13]);
        var access = new RealFileAccess();
        var extractor = new FakeExtractor((path, size) => FilePixels(path, size));
        var signaled = new SemaphoreSlim(0);
        await using var pipeline = new NativeAssetPreviewPipeline(
            access, () => Signal(signaled), extractor, new FakeApartment());
        NativePreviewRequest request = Request(file.Prepared, 0, 1, 0, 48);

        Assert.True(pipeline.TrySchedule(request));
        Assert.True(await signaled.WaitAsync(TimeSpan.FromSeconds(5)));
        Assert.Equal(11, TakeResult(pipeline).Pixels!.Bgra[0]);
        Assert.True(pipeline.TrySchedule(request with { Generation = 2 }));
        Assert.True(await signaled.WaitAsync(TimeSpan.FromSeconds(5)));
        Assert.Equal(11, TakeResult(pipeline).Pixels!.Bgra[0]);

        Assert.Equal(2, access.AcquireCalls);
        Assert.Equal(2, access.LeaseDisposals);
        Assert.Equal(1, extractor.Calls);
    }

    [Fact]
    public async Task RealFile_SamePathSameSizeReplacementMissesOldCache()
    {
        using var file = new PreviewFileFixture([21, 22, 23]);
        var access = new RealFileAccess();
        var extractor = new FakeExtractor((path, size) => FilePixels(path, size));
        var signaled = new SemaphoreSlim(0);
        await using var pipeline = new NativeAssetPreviewPipeline(
            access, () => Signal(signaled), extractor, new FakeApartment());

        Assert.True(pipeline.TrySchedule(Request(file.Prepared, 0, 1, 0, 48)));
        Assert.True(await signaled.WaitAsync(TimeSpan.FromSeconds(5)));
        Assert.Equal(21, TakeResult(pipeline).Pixels!.Bgra[0]);
        file.Replace([31, 32, 33]);
        Assert.True(pipeline.TrySchedule(Request(file.Prepared, 0, 2, 0, 48)));
        Assert.True(await signaled.WaitAsync(TimeSpan.FromSeconds(5)));
        Assert.Equal(31, TakeResult(pipeline).Pixels!.Bgra[0]);

        Assert.Equal(2, extractor.Calls);
        Assert.Equal(2, pipeline.Cache.Count);
    }

    [Fact]
    public async Task RealFile_SameObjectSameSizeModificationMissesOldCache()
    {
        using var file = new PreviewFileFixture([41, 42, 43]);
        var access = new RealFileAccess();
        var extractor = new FakeExtractor((path, size) => FilePixels(path, size));
        var signaled = new SemaphoreSlim(0);
        await using var pipeline = new NativeAssetPreviewPipeline(
            access, () => Signal(signaled), extractor, new FakeApartment());

        Assert.True(pipeline.TrySchedule(Request(file.Prepared, 0, 1, 0, 48)));
        Assert.True(await signaled.WaitAsync(TimeSpan.FromSeconds(5)));
        Assert.Equal(41, TakeResult(pipeline).Pixels!.Bgra[0]);
        file.Modify([51, 52, 53]);
        Assert.True(pipeline.TrySchedule(Request(file.Prepared, 0, 2, 0, 48)));
        Assert.True(await signaled.WaitAsync(TimeSpan.FromSeconds(5)));
        Assert.Equal(51, TakeResult(pipeline).Pixels!.Bgra[0]);

        Assert.Equal(2, extractor.Calls);
    }

    [Fact]
    public async Task RealFile_MissingAfterCacheDoesNotRenderStalePixels()
    {
        using var file = new PreviewFileFixture([61, 62, 63]);
        var access = new RealFileAccess();
        var extractor = new FakeExtractor((path, size) => FilePixels(path, size));
        var signaled = new SemaphoreSlim(0);
        await using var pipeline = new NativeAssetPreviewPipeline(
            access, () => Signal(signaled), extractor, new FakeApartment());

        Assert.True(pipeline.TrySchedule(Request(file.Prepared, 0, 1, 0, 48)));
        Assert.True(await signaled.WaitAsync(TimeSpan.FromSeconds(5)));
        Assert.Equal(NativePreviewOutcome.Thumbnail, TakeResult(pipeline).Outcome);
        file.Remove();
        Assert.True(pipeline.TrySchedule(Request(file.Prepared, 0, 2, 0, 48)));
        Assert.True(await signaled.WaitAsync(TimeSpan.FromSeconds(5)));
        NativePreviewResult missing = TakeResult(pipeline);

        Assert.Equal(NativePreviewOutcome.PreviewAccessFailed, missing.Outcome);
        Assert.Null(missing.Pixels);
        Assert.Equal(1, extractor.Calls);
    }

    [Fact]
    public async Task MissingStrongIdentityExtractsWithoutCacheReuse()
    {
        var access = new FakeAccess { Identity = _ => null };
        var extractor = new FakeExtractor((_, size) => Pixels(size));
        var signaled = new SemaphoreSlim(0);
        await using var pipeline = new NativeAssetPreviewPipeline(
            access, () => Signal(signaled), extractor, new FakeApartment());
        NativePreviewRequest request = Request(Prepared(1, "non-cacheable.png", true), 0, 1, 0, 48);

        for (int generation = 1; generation <= 2; generation++)
        {
            Assert.True(pipeline.TrySchedule(request with { Generation = generation }));
            Assert.True(await signaled.WaitAsync(TimeSpan.FromSeconds(5)));
            Assert.Equal(NativePreviewOutcome.Thumbnail, TakeResult(pipeline).Outcome);
        }

        Assert.Equal(2, extractor.Calls);
        Assert.Equal(0, pipeline.Cache.Count);
    }

    [Fact]
    public async Task TwoWorkersSharingOneFileLeaveCacheValidAndBounded()
    {
        using var file = new PreviewFileFixture([71, 72, 73]);
        var bothExtracting = new CountdownEvent(NativeAssetPreviewPipeline.WorkerCount);
        var release = new ManualResetEventSlim(false);
        var signal = new SemaphoreSlim(0);
        var extractor = new FakeExtractor((path, size) =>
        {
            bothExtracting.Signal();
            release.Wait();
            return FilePixels(path, size);
        });
        await using var pipeline = new NativeAssetPreviewPipeline(
            new RealFileAccess(), () => Signal(signal), extractor, new FakeApartment(), new NativePreviewCache(1));

        Assert.True(pipeline.TrySchedule(Request(file.Prepared, 0, 1, 0, 48)));
        Assert.True(pipeline.TrySchedule(Request(file.Prepared, 0, 2, 0, 48)));
        Assert.True(bothExtracting.Wait(TimeSpan.FromSeconds(5)));
        release.Set();
        Assert.True(await signal.WaitAsync(TimeSpan.FromSeconds(5)));
        Assert.True(SpinWait.SpinUntil(() => pipeline.ResultCount == 2, TimeSpan.FromSeconds(5)));
        Assert.Equal(2, pipeline.DrainResults(result => Assert.Equal(71, result.Pixels!.Bgra[0])));

        Assert.Equal(1, pipeline.Cache.Count);
        Assert.Equal(2, extractor.Calls);

        Assert.True(pipeline.TrySchedule(Request(file.Prepared, 0, 3, 0, 48)));
        Assert.True(pipeline.TrySchedule(Request(file.Prepared, 0, 4, 0, 48)));
        Assert.True(await signal.WaitAsync(TimeSpan.FromSeconds(5)));
        Assert.True(SpinWait.SpinUntil(() => pipeline.ResultCount == 2, TimeSpan.FromSeconds(5)));
        Assert.Equal(2, pipeline.DrainResults(result => Assert.Equal(71, result.Pixels!.Bgra[0])));
        Assert.Equal(1, pipeline.Cache.Count);
        Assert.Equal(2, extractor.Calls);
    }

    [Fact]
    public void PlaceholderPixelsAreTransparentOutsideGlyphAndDistinctForUnavailableAndFailure()
    {
        NativeThumbnailPixels generic = NativePreviewPlaceholders.Create(48, 0x00ffffff, false, false);
        NativeThumbnailPixels unavailable = NativePreviewPlaceholders.Create(48, 0x00ffffff, true, false);
        NativeThumbnailPixels failed = NativePreviewPlaceholders.Create(48, 0x00ffffff, false, true);

        Assert.Equal(0, generic.Bgra[3]);
        Assert.NotEqual(generic.Bgra, unavailable.Bgra);
        Assert.NotEqual(unavailable.Bgra, failed.Bgra);
        Assert.Contains((byte)255, failed.Bgra.Where((_, index) => index % 4 == 3));
    }

    [Fact]
    public void NonImageAssetsUseGenericPresentationWithoutEnteringShellPreviewPath()
    {
        Assert.True(NativeManualPublishingCompanion.NativeWindow.IsImageAsset(Prepared(1, "photo.png", true)));
        Assert.False(NativeManualPublishingCompanion.NativeWindow.IsImageAsset(Prepared(2, "notes.txt", true)));
        Assert.False(NativeManualPublishingCompanion.NativeWindow.IsImageAsset(Prepared(3, "archive.zip", true)));
    }

    [Fact]
    public void ImageListUses32BitPixelsAndCopiesBeforeCallerCanReleaseBitmapStorage()
    {
        IntPtr images = NativeImageListStorage.Create(48);
        Assert.NotEqual(IntPtr.Zero, images);
        try
        {
            NativeThumbnailPixels pixels = Pixels(48, alpha: 96);
            Assert.Equal(0, NativeImageListStorage.Add(images, pixels));
            Array.Clear(pixels.Bgra);
            Assert.Equal(1, NativeImageListStorage.Add(images, Pixels(48, alpha: 255)));
        }
        finally { NativeImageListStorage.Destroy(images); }
    }

    [Fact]
    public void RealWindowsShellExtractorReadsPngIntoTransparent32BitOwnedPixels()
    {
        string path = Path.Combine(Path.GetTempPath(), $"creatorcrate-preview-{Guid.NewGuid():N}.png");
        int bitmapReleased = 0, comReleased = 0;
        File.WriteAllBytes(path, Convert.FromBase64String(
            "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAFElEQVR42mP8z8Dwn4GBgYGJAQoAHgQCAf2fqxQAAAAASUVORK5CYII="));
        try
        {
            var hooks = new NativeShellThumbnailTestHooks(
                () => bitmapReleased++, () => comReleased++);
            NativeThumbnailPixels? pixels = new NativeShellThumbnailExtractor(hooks).TryExtract(path, 48);
            Assert.NotNull(pixels);
            Assert.Equal(48 * 48 * 4, pixels!.Bgra.Length);
            Assert.Contains(pixels.Bgra.Where((_, index) => index % 4 == 3), alpha => alpha != 0);
            Assert.Equal(1, bitmapReleased);
            Assert.Equal(1, comReleased);
        }
        finally { File.Delete(path); }
    }

    private static NativeThumbnailPixels Pixels(int size, byte alpha = 255)
    {
        byte[] bytes = new byte[size * size * 4];
        for (int index = 0; index < bytes.Length; index += 4)
        {
            bytes[index] = 10; bytes[index + 1] = 20; bytes[index + 2] = 30; bytes[index + 3] = alpha;
        }
        return new NativeThumbnailPixels(size, size, bytes);
    }

    private static NativeThumbnailPixels FilePixels(string path, int size)
    {
        byte value = File.ReadAllBytes(path)[0];
        NativeThumbnailPixels pixels = Pixels(size);
        for (int index = 0; index < pixels.Bgra.Length; index += 4) pixels.Bgra[index] = value;
        return pixels;
    }

    private static ManualPreviewFileCacheIdentity Identity(long value, long changeTime = 1) =>
        new(1, (ulong)value, 0, 100, changeTime, changeTime);

    private static NativePreviewCacheKey Key(
        ManualPreparedAsset prepared, int size, ManualPreviewFileCacheIdentity identity) =>
        new(prepared.Asset.AssetId, prepared.Provenance, Path.GetFullPath(prepared.Path).ToUpperInvariant(),
            prepared.Asset.SizeBytes, size, identity);

    private static bool Signal(SemaphoreSlim signal)
    {
        signal.Release();
        return true;
    }

    private static NativePreviewResult TakeResult(NativeAssetPreviewPipeline pipeline)
    {
        NativePreviewResult? result = null;
        Assert.Equal(1, pipeline.DrainResults(value => result = value, 1));
        return Assert.IsType<NativePreviewResult>(result);
    }

    private static ManualPreparedAsset Prepared(long id, string filename, bool available) =>
        new(new SocialRedeemAsset(id, "attachment", id, filename, Path.GetExtension(filename),
            filename.EndsWith(".png", StringComparison.OrdinalIgnoreCase) ? "image/png" : "application/octet-stream",
            100, $"release/{filename}", available, null),
            available ? $@"C:\preview\{filename}" : string.Empty, StagedMediaProvenance.HelperOwned);

    private static ManualSocialSession Session(params ManualPreparedAsset[] assets) =>
        new(new Uri("https://creatorcrate.test/"), 42, "Release",
            [new ManualPreparedPlatform("x", "Release", "Post", assets)]);

    private static NativePreviewRequest Request(
        ManualPreparedAsset prepared, int ordinal, long generation, int platform, int size)
    {
        return new NativePreviewRequest(generation, platform, "x", ordinal, prepared, size);
    }

    private sealed class FakeAccess : IManualAssetPreviewAccess
    {
        public bool FailAccess { get; init; }
        public Func<ManualPreparedAsset, ManualPreviewFileCacheIdentity?> Identity { get; init; } =
            prepared => NativeAssetPreviewTests.Identity(prepared.Asset.AssetId);
        public int AcquireCalls { get; private set; }
        public int LeaseDisposals { get; private set; }
        public bool LeaseAlive { get; private set; }
        public bool Disposed { get; private set; }

        public ManualPreviewAccessResult TryAcquireRead(ManualPreparedAsset prepared, int ordinal)
        {
            AcquireCalls++;
            if (FailAccess) return ManualPreviewAccessResult.Fail("media_file_unsafe");
            LeaseAlive = true;
            var release = new CallbackDisposable(() => { LeaseAlive = false; LeaseDisposals++; });
            var handle = new SafeFileHandle(IntPtr.Zero, ownsHandle: false);
            return ManualPreviewAccessResult.Ready(new ManualPreviewFileLease(
                prepared.Path, prepared.Asset.AssetId, prepared.Provenance, handle, [release, handle], Identity(prepared)));
        }

        public void Dispose() => Disposed = true;
    }

    private sealed class RealFileAccess : IManualAssetPreviewAccess
    {
        private int _acquireCalls;
        private int _leaseDisposals;
        public int AcquireCalls => Volatile.Read(ref _acquireCalls);
        public int LeaseDisposals => Volatile.Read(ref _leaseDisposals);

        public ManualPreviewAccessResult TryAcquireRead(ManualPreparedAsset prepared, int ordinal)
        {
            Interlocked.Increment(ref _acquireCalls);
            try
            {
                SafeFileHandle handle = File.OpenHandle(
                    prepared.Path, FileMode.Open, FileAccess.Read, FileShare.Read);
                if (RandomAccess.GetLength(handle) != prepared.Asset.SizeBytes)
                {
                    handle.Dispose();
                    return ManualPreviewAccessResult.Fail("media_size_mismatch");
                }
                var release = new CallbackDisposable(() => Interlocked.Increment(ref _leaseDisposals));
                return ManualPreviewAccessResult.Ready(new ManualPreviewFileLease(
                    Path.GetFullPath(prepared.Path), prepared.Asset.AssetId, prepared.Provenance,
                    handle, [release, handle], ManualPreviewFileCacheIdentity.TryCreate(handle)));
            }
            catch (IOException) { return ManualPreviewAccessResult.Fail("media_file_missing"); }
        }

        public void Dispose() { }
    }

    private sealed class PreviewFileFixture : IDisposable
    {
        private readonly string _directory = System.IO.Path.Combine(
            System.IO.Path.GetTempPath(), "creatorcrate-cache-freshness-" + Guid.NewGuid().ToString("N"));

        public PreviewFileFixture(byte[] bytes)
        {
            Directory.CreateDirectory(_directory);
            Path = System.IO.Path.Combine(_directory, "preview.png");
            File.WriteAllBytes(Path, bytes);
            var asset = new SocialRedeemAsset(
                1001, "attachment", 0, "preview.png", ".png", "image/png", bytes.Length,
                "release/preview.png", true, Path);
            Prepared = new ManualPreparedAsset(asset, Path, StagedMediaProvenance.ExternalSource);
        }

        public string Path { get; }
        public ManualPreparedAsset Prepared { get; }

        public void Replace(byte[] bytes)
        {
            string replacement = System.IO.Path.Combine(_directory, "replacement.png");
            File.WriteAllBytes(replacement, bytes);
            File.Delete(Path);
            File.Move(replacement, Path);
        }

        public void Modify(byte[] bytes) => File.WriteAllBytes(Path, bytes);
        public void Remove() => File.Delete(Path);

        public void Dispose()
        {
            if (Directory.Exists(_directory)) Directory.Delete(_directory, recursive: true);
        }
    }

    private sealed class FakeExtractor(Func<string, int, NativeThumbnailPixels?> extract) : INativeShellThumbnailExtractor
    {
        public int Calls;
        public NativeThumbnailPixels? TryExtract(string path, int pixelSize)
        {
            Interlocked.Increment(ref Calls);
            return extract(path, pixelSize);
        }
    }

    private sealed class FakeApartment : INativePreviewWorkerApartment
    {
        public CountdownEvent AllEntered { get; } = new(NativeAssetPreviewPipeline.WorkerCount);
        public int EnterCalls;
        public int DisposeCalls;
        public IDisposable TryEnter()
        {
            Interlocked.Increment(ref EnterCalls);
            AllEntered.Signal();
            return new CallbackDisposable(() => Interlocked.Increment(ref DisposeCalls));
        }
    }

    private sealed class FailingApartment : INativePreviewWorkerApartment
    {
        public IDisposable? TryEnter() => null;
    }

    private sealed class CallbackDisposable(Action callback) : IDisposable
    {
        private int _disposed;
        public void Dispose()
        {
            if (Interlocked.Exchange(ref _disposed, 1) == 0) callback();
        }
    }
}

internal sealed class NativePreviewOwnedPngFixture : IDisposable
{
    private static readonly byte[] Png = Convert.FromBase64String(
        "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAFElEQVR42mP8z8Dwn4GBgYGJAQoAHgQCAf2fqxQAAAAASUVORK5CYII=");
    private readonly string _root;
    private readonly SocialOrigin _origin;
    private readonly SocialCapability _capability;
    private readonly LocalMediaResolver _resolver;
    private readonly SocialMediaStager _stager;

    private NativePreviewOwnedPngFixture(
        string root, SocialOrigin origin, SocialCapability capability,
        LocalMediaResolver resolver, SocialMediaStager stager, ManualPreparedAsset prepared) =>
        (_root, _origin, _capability, _resolver, _stager, Prepared) =
        (root, origin, capability, resolver, stager, prepared);

    public ManualPreparedAsset Prepared { get; }

    public static async Task<NativePreviewOwnedPngFixture> CreateAsync()
    {
        string root = Path.Combine(Path.GetTempPath(), "creatorcrate-real-preview-" + Guid.NewGuid().ToString("N"));
        SocialOrigin origin = SocialCapabilityClientTests.Origin();
        var resolver = new LocalMediaResolver(new EmptyTrustedStore(), new RejectingPrompt());
        var handler = new PngHandler();
        var stager = new SocialMediaStager(SocialCapabilityClientTests.CreateClient(handler), resolver, root);
        var capability = new SocialCapability(Guid.NewGuid().ToString(), "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
        var asset = new SocialRedeemAsset(
            7001, "attachment", 0, "preview.png", ".png", "image/png", Png.Length,
            "release/preview.png", true, null);
        StagedMedia media = await stager.StageAsync(origin, capability, asset, 0, CancellationToken.None);
        Assert.True(media.Success, media.ErrorCode);
        Assert.Equal(StagedMediaProvenance.HelperOwned, media.Provenance);
        string marker = Path.Combine(Path.GetDirectoryName(media.Path!)!, SocialMediaStager.MarkerName);
        Assert.Equal("creatorcrate-social-prep-v1", File.ReadAllText(marker));
        return new NativePreviewOwnedPngFixture(
            root, origin, capability, resolver, stager,
            new ManualPreparedAsset(asset, media.Path!, StagedMediaProvenance.HelperOwned));
    }

    public ManualAssetPreviewAccess CreateAccess() =>
        new(_origin, _capability.SessionId, _resolver, _stager);

    public void Dispose()
    {
        _stager.Cleanup(_capability);
        if (Directory.Exists(_root)) Directory.Delete(_root, recursive: true);
    }

    private sealed class EmptyTrustedStore : ITrustedMediaRootStore
    {
        public bool IsTrusted(SocialOrigin origin, string root) => false;
        public void Trust(SocialOrigin origin, string root) { }
    }

    private sealed class RejectingPrompt : ITrustedMediaRootPrompt
    {
        public bool ConfirmTrust(SocialOrigin origin, string root) => false;
    }

    private sealed class PngHandler : HttpMessageHandler
    {
        protected override Task<HttpResponseMessage> SendAsync(
            HttpRequestMessage request, CancellationToken cancellationToken) =>
            Task.FromResult(new HttpResponseMessage(HttpStatusCode.OK)
            {
                Content = new ByteArrayContent(Png),
            });
    }
}
