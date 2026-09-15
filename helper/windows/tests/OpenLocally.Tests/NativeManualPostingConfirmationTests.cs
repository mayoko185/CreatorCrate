using OpenLocally;
using System.Runtime.InteropServices;
using System.Text;

namespace OpenLocally.Tests;

public sealed class NativeManualPostingConfirmationTests
{
    [Fact]
    public void ProductionCompanion_OptsIntoBorrowedConfirmationControllerComposition() =>
        Assert.IsAssignableFrom<IManualPostingConfirmationCompanion>(NativeManualPublishingCompanion.Instance);

    [Fact]
    public async Task CompleteProductionCompanion_MinimumTrackSizeContainsActualChildWindowsForEveryPlatform()
    {
        using var controller = Controller(new RecordingTransport());
        await using NativeWindowHarness harness = await NativeWindowHarness.StartAsync(controller);
        NativeLayoutSize supported = NativeCompanionLayout.SupportedMinimumLogicalClientSize;

        foreach ((int index, string platform) in new[] { (0, "x"), (1, "patreon"), (2, "bluesky") })
        {
            NativeProductionLayoutProbe probe = harness.CaptureMinimumLayout(index);
            int gap = 16 * probe.Dpi / 96;
            Console.WriteLine($"{platform}: {probe.Dpi} DPI, minimum outer {probe.MinimumTrack.Width}x{probe.MinimumTrack.Height}, client {probe.Client.Width}x{probe.Client.Height}, list {probe.AssetList.Width}x{probe.AssetList.Height}");

            Assert.Equal(platform, probe.Platform);
            Assert.Equal(NativeManualPublishingCompanion.NativeWindow.MinimumOuterSizeForDpi(probe.Dpi), probe.MinimumTrack);
            Assert.True(probe.Client.Width >= supported.Width * probe.Dpi / 96);
            Assert.True(probe.Client.Height >= supported.Height * probe.Dpi / 96);
            AssertWithinClient(probe.Header, probe.Client);
            AssertWithinClient(probe.HeaderMetadata, probe.Client);
            AssertWithin(probe.PlatformHeading, probe.PlatformCard);
            AssertWithin(probe.PlatformSelector, probe.PlatformCard);
            AssertWithin(probe.BodyLabel, probe.PlatformCard);
            AssertWithin(probe.BodyText, probe.PlatformCard);
            AssertWithin(probe.CopyMain, probe.PlatformCard);
            AssertWithin(probe.PostingStatus, probe.PlatformCard);
            AssertWithin(probe.PostingHelper, probe.PlatformCard);
            AssertWithin(probe.PostingAction, probe.PlatformCard);
            AssertWithin(probe.PostingAggregate, probe.Footer);
            Assert.False(probe.PostingStatus.Intersects(probe.PostingAction));
            Assert.False(probe.PostingHelper.Intersects(probe.PostingAction));
            Assert.False(probe.BodyText.Intersects(probe.CopyMain));
            Assert.True(probe.PostingStatus.Y >= probe.BodyText.Bottom);
            Assert.Equal(probe.BodyLabel.Y, probe.CopyMain.Y + 5 * probe.Dpi / 96);
            Assert.Equal(probe.PlatformHeading.Y, probe.PlatformSelector.Y + 8 * probe.Dpi / 96);
            Assert.Equal(12 * probe.Dpi / 96, probe.PostingAction.X - probe.PostingStatus.Right);
            if (platform == "patreon")
            {
                AssertWithin(probe.TitleLabel, probe.PlatformCard);
                AssertWithin(probe.TitleText, probe.PlatformCard);
                AssertWithin(probe.CopyTitle, probe.PlatformCard);
                Assert.False(probe.TitleText.Intersects(probe.CopyTitle));
            }

            Assert.Equal(gap, probe.AssetsCard.Y - probe.PlatformCard.Bottom);
            AssertWithin(probe.AssetsHeading, probe.AssetsCard);
            AssertWithin(probe.AssetCount, probe.AssetsCard);
            AssertWithin(probe.DragGuidance, probe.AssetsCard);
            AssertWithin(probe.AssetList, probe.AssetsCard);
            Assert.True(probe.AssetList.Height > 0);
            Assert.True(probe.DragGuidance.Bottom < probe.AssetList.Y);
            Assert.True(probe.Footer.Y - probe.AssetsCard.Bottom >= gap);
            AssertWithin(probe.Status, probe.Footer);
            AssertWithin(probe.Close, probe.Footer);
            AssertWithinClient(probe.Footer, probe.Client);
            Assert.False(probe.AssetList.Intersects(probe.Status));
            Assert.False(probe.AssetList.Intersects(probe.Close));
        }
    }

    [Fact]
    public async Task CompleteProductionCompanion_ResizesAndSwitchesWithContainedChildWindows()
    {
        using var controller = Controller(new RecordingTransport());
        await using NativeWindowHarness harness = await NativeWindowHarness.StartAsync(controller);
        NativeProductionLayoutProbe minimum = harness.Window.ResizeAndCaptureLayoutForTesting(1, 820, 754);
        NativeProductionLayoutProbe normal = harness.Window.ResizeAndCaptureLayoutForTesting(1, 980, 920);
        NativeProductionLayoutProbe large = harness.Window.ResizeAndCaptureLayoutForTesting(1, 980, 1400);
        NativeProductionLayoutProbe wide = harness.Window.ResizeAndCaptureLayoutForTesting(1, 1600, 920);

        Assert.True(normal.BodyText.Height > minimum.BodyText.Height);
        Assert.True(normal.AssetList.Height > minimum.AssetList.Height);
        Assert.True(large.BodyText.Height <= 240 * large.Dpi / 96);
        Assert.True(large.AssetsCard.Height <= 440 * large.Dpi / 96);
        Assert.Equal(1152 * wide.Dpi / 96, wide.PlatformCard.Width);
        Assert.Equal((wide.Client.Width - wide.PlatformCard.Width) / 2, wide.PlatformCard.X);

        foreach ((int index, string platform) in new[] { (1, "patreon"), (0, "x"), (2, "bluesky"), (1, "patreon") })
        {
            NativeProductionLayoutProbe probe = harness.Window.ResizeAndCaptureLayoutForTesting(index, 820, 754);
            Assert.Equal(platform, probe.Platform);
            AssertWithin(probe.BodyText, probe.PlatformCard);
            AssertWithin(probe.CopyMain, probe.PlatformCard);
            AssertWithin(probe.PostingStatus, probe.PlatformCard);
            AssertWithin(probe.PostingHelper, probe.PlatformCard);
            AssertWithin(probe.PostingAggregate, probe.Footer);
            Assert.False(probe.BodyText.Intersects(probe.PostingStatus));
            Assert.False(probe.BodyText.Intersects(probe.CopyMain));
            Assert.Equal(probe.BodyLabel.Y, probe.CopyMain.Y + 5 * probe.Dpi / 96);
            Assert.True(probe.AssetsCard.Y >= probe.PlatformCard.Bottom + 16 * probe.Dpi / 96);
            if (platform == "patreon")
            {
                AssertWithin(probe.TitleText, probe.PlatformCard);
                Assert.Equal(probe.TitleLabel.Y, probe.CopyTitle.Y + 5 * probe.Dpi / 96);
                Assert.True(probe.BodyLabel.Y > probe.TitleText.Bottom);
            }
            else Assert.True(probe.BodyLabel.Y < minimum.BodyLabel.Y);
        }
    }

    [Fact]
    public void PresentationMapper_UsesOnlyControllerStateAndCanonicalAggregate()
    {
        ManualPostingConfirmationPresentation ready = Map(ManualPostingConfirmationStatus.Ready);
        Assert.Equal("Ready for manual publishing — not marked as posted", ready.StatusText);
        Assert.Equal("Mark as posted", ready.ActionText);
        Assert.True(ready.ShowAction);
        Assert.True(ready.ActionEnabled);
        Assert.Contains("After you publish this post on X", ready.HelperText);
        Assert.Empty(ready.AggregateText);

        ManualPostingConfirmationPresentation confirming = Map(ManualPostingConfirmationStatus.Confirming);
        Assert.Equal("Marking as posted…", confirming.StatusText);
        Assert.True(confirming.ShowAction);
        Assert.False(confirming.ActionEnabled);

        ManualPostingConfirmationPresentation unknown = Map(ManualPostingConfirmationStatus.ConfirmationUnknown);
        Assert.Equal("Confirmation not received. Retry.", unknown.StatusText);
        Assert.Equal("Retry confirmation", unknown.ActionText);
        Assert.True(unknown.ActionEnabled);

        ManualPostingConfirmationPresentation posted = Map(
            ManualPostingConfirmationStatus.Posted, new ManualPostingCompletion(3, 3, true));
        Assert.Equal("Posted — confirmed by you", posted.StatusText);
        Assert.False(posted.ShowAction);
        Assert.False(posted.ActionEnabled);
        Assert.Equal("All social posts marked as posted.", posted.AggregateText);

        ManualPostingConfirmationPresentation rejected = ManualPostingConfirmationPresentationMapper.Map(
            new ManualPostingPlatformState("x", ManualPostingConfirmationStatus.Ready, null,
                ManualPostingConfirmationController.RejectedReason),
            new ManualPostingCompletion(2, 3, false), "X");
        Assert.Equal(ManualPostingConfirmationController.RejectedReason, rejected.StatusText);
        Assert.False(rejected.ShowAction);
        Assert.False(rejected.ActionEnabled);
        Assert.Equal("2 of 3 platforms marked as posted", rejected.AggregateText);
    }

    [Theory]
    [InlineData(1, 3, false, "1 of 3 platforms marked as posted")]
    [InlineData(2, 3, false, "2 of 3 platforms marked as posted")]
    [InlineData(3, 3, true, "All social posts marked as posted.")]
    public void AggregatePresentation_UsesCanonicalServerValues(
        int posted, int total, bool complete, string expected)
    {
        ManualPostingConfirmationPresentation presentation = Map(
            ManualPostingConfirmationStatus.Ready, new ManualPostingCompletion(posted, total, complete));
        Assert.Equal(expected, presentation.AggregateText);
    }

    [Theory]
    [InlineData(1, 3, false, "1 of 3 platforms marked as posted")]
    [InlineData(2, 3, false, "2 of 3 platforms marked as posted")]
    [InlineData(3, 3, true, "All social posts marked as posted.")]
    public async Task ActualNativeAggregate_UsesCanonicalServerPresentation(
        int posted, int total, bool complete, string expected)
    {
        var transport = new RecordingTransport
        {
            Post = (platform, _) => Task.FromResult(Authoritative(
                platform, "posted", new DateTime(2030, 1, 1), posted, total, complete)),
        };
        using var controller = Controller(transport);
        await using NativeWindowHarness harness = await NativeWindowHarness.StartAsync(controller);
        harness.DrainPresentationSignal();

        SendMessage(harness.Window.PostingActionHandle, BmClick, IntPtr.Zero, IntPtr.Zero);
        harness.WaitForPresentation();

        Assert.Equal(expected, Text(harness.Window.PostingAggregateHandle));
        Assert.Equal("Posted — confirmed by you", Text(harness.Window.PostingStatusHandle));
        Assert.False(IsWindowVisible(harness.Window.PostingActionHandle));
        Assert.True(IsWindowVisible(GetDlgItem(
            harness.Window.WindowHandle, NativeManualPublishingCompanion.NativeWindow.CloseId)));
    }

    [Fact]
    public async Task ActualNativeButton_DisablesWhilePending_AndPlatformSwitchKeepsCapturedResultLocal()
    {
        var held = new TaskCompletionSource<ManualPostingTransportResult>(TaskCreationOptions.RunContinuationsAsynchronously);
        var transport = new RecordingTransport { Post = (_, _) => held.Task };
        using var controller = Controller(transport);
        await using NativeWindowHarness harness = await NativeWindowHarness.StartAsync(controller);

        Assert.NotEqual(IntPtr.Zero, harness.Window.PostingActionHandle);
        Assert.Equal("Ready for manual publishing — not marked as posted", Text(harness.Window.PostingStatusHandle));
        Assert.Equal("Mark as posted", Text(harness.Window.PostingActionHandle));
        Assert.True(IsWindowEnabled(harness.Window.PostingActionHandle));

        SendMessage(harness.Window.PostingActionHandle, BmClick, IntPtr.Zero, IntPtr.Zero);
        Assert.Equal(ManualPostingConfirmationStatus.Confirming, controller.GetState("x").Status);
        Assert.Equal("Marking as posted…", Text(harness.Window.PostingStatusHandle));
        Assert.False(IsWindowEnabled(harness.Window.PostingActionHandle));
        SendMessage(harness.Window.PostingActionHandle, BmClick, IntPtr.Zero, IntPtr.Zero);
        Assert.Equal(1, transport.PostCalls);

        harness.SelectPlatform(1);
        Assert.Equal("Ready for manual publishing — not marked as posted", Text(harness.Window.PostingStatusHandle));
        harness.DrainPresentationSignal();

        held.SetResult(Authoritative("x", "posted", new DateTime(2030, 1, 1), 1, 3, false));
        harness.WaitForPresentation();
        Assert.Equal("Ready for manual publishing — not marked as posted", Text(harness.Window.PostingStatusHandle));
        Assert.Equal("1 of 3 platforms marked as posted", Text(harness.Window.PostingAggregateHandle));

        harness.SelectPlatform(0);
        Assert.Equal("Posted — confirmed by you", Text(harness.Window.PostingStatusHandle));
        Assert.False(IsWindowVisible(harness.Window.PostingActionHandle));
        Assert.False(IsWindowEnabled(harness.Window.PostingActionHandle));
        Assert.Equal(ManualPostingConfirmationStatus.Ready, controller.GetState("patreon").Status);
    }

    [Fact]
    public async Task ActualNativeButtons_UseEstablishedButtonWindowContract()
    {
        using var controller = Controller(new RecordingTransport());
        await using NativeWindowHarness harness = await NativeWindowHarness.StartAsync(controller);
        IntPtr[] buttons =
        [
            GetDlgItem(harness.Window.WindowHandle, NativeManualPublishingCompanion.NativeWindow.CopyMainId),
            harness.Window.PostingActionHandle,
            GetDlgItem(harness.Window.WindowHandle, NativeManualPublishingCompanion.NativeWindow.CloseId),
        ];

        foreach (IntPtr button in buttons)
        {
            var className = new StringBuilder(32);
            Assert.True(GetClassName(button, className, className.Capacity) > 0);
            Assert.Equal("Button", className.ToString());
            Assert.Equal(
                NativeManualPublishingCompanion.NativeWindow.ProductionButtonStyle,
                unchecked((uint)GetWindowLongPtr(button, -16).ToInt64()));
            Assert.Equal(
                NativeManualPublishingCompanion.NativeWindow.ProductionButtonExtendedStyle,
                unchecked((uint)GetWindowLongPtr(button, -20).ToInt64()));
        }
    }

    [Fact]
    public async Task EnterOnActualMarkAsPostedButton_BeginsExactlyOneWorkflow_AndDisabledEnterIsIgnored()
    {
        var held = new TaskCompletionSource<ManualPostingTransportResult>(TaskCreationOptions.RunContinuationsAsynchronously);
        var transport = new RecordingTransport { Post = (_, _) => held.Task };
        using var controller = Controller(transport);
        await using NativeWindowHarness harness = await NativeWindowHarness.StartAsync(controller);

        harness.Window.InvokePostingActionByEnterForTesting();
        Assert.Equal(ManualPostingConfirmationStatus.Confirming, controller.GetState("x").Status);
        Assert.Equal(1, transport.PostCalls);
        Assert.False(IsWindowEnabled(harness.Window.PostingActionHandle));

        harness.Window.InvokePostingActionByEnterForTesting();
        Assert.Equal(1, transport.PostCalls);
        held.SetResult(ManualPostingTransportResult.Ambiguous());
    }

    [Fact]
    public async Task DifferentPlatformActions_QueueWithoutFreezingPlatformSwitching()
    {
        var x = new TaskCompletionSource<ManualPostingTransportResult>(TaskCreationOptions.RunContinuationsAsynchronously);
        var patreon = new TaskCompletionSource<ManualPostingTransportResult>(TaskCreationOptions.RunContinuationsAsynchronously);
        var patreonStarted = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var transport = new RecordingTransport
        {
            Post = (platform, _) =>
            {
                if (platform == "patreon") patreonStarted.TrySetResult();
                return platform == "x" ? x.Task : patreon.Task;
            },
        };
        using var controller = Controller(transport);
        await using NativeWindowHarness harness = await NativeWindowHarness.StartAsync(controller);

        SendMessage(harness.Window.PostingActionHandle, BmClick, IntPtr.Zero, IntPtr.Zero);
        harness.SelectPlatform(1);
        SendMessage(harness.Window.PostingActionHandle, BmClick, IntPtr.Zero, IntPtr.Zero);

        Assert.Equal(ManualPostingConfirmationStatus.Confirming, controller.GetState("x").Status);
        Assert.Equal(ManualPostingConfirmationStatus.Confirming, controller.GetState("patreon").Status);
        Assert.Equal("Marking as posted…", Text(harness.Window.PostingStatusHandle));
        Assert.Equal(1, transport.PostCalls);

        harness.DrainPresentationSignal();
        x.SetResult(Authoritative("x", "posted", new DateTime(2030, 1, 1), 1, 3, false));
        await patreonStarted.Task.WaitAsync(TimeSpan.FromSeconds(5));
        harness.WaitForPresentation();
        Assert.Equal("Marking as posted…", Text(harness.Window.PostingStatusHandle));

        harness.DrainPresentationSignal();
        patreon.SetResult(Authoritative("patreon", "posted", new DateTime(2030, 1, 2), 2, 3, false));
        harness.WaitForPresentation();
        Assert.Equal("Posted — confirmed by you", Text(harness.Window.PostingStatusHandle));
        Assert.Equal(2, transport.PostCalls);
    }

    [Fact]
    public async Task ActualCopyButton_UsesClipboardOnlyAndNeverConfirmsPosting()
    {
        var transport = new RecordingTransport();
        using var controller = Controller(transport);
        var clipboard = new RecordingClipboard();
        await using NativeWindowHarness harness = await NativeWindowHarness.StartAsync(controller, _ => clipboard);

        SendMessage(GetDlgItem(harness.Window.WindowHandle,
            NativeManualPublishingCompanion.NativeWindow.CopyMainId), BmClick, IntPtr.Zero, IntPtr.Zero);

        Assert.Equal(["X post"], clipboard.Values);
        Assert.Equal(0, transport.PostCalls);
        Assert.Equal(0, transport.GetCalls);
    }

    [Fact]
    public async Task ActualNativeButton_UnknownBecomesRetry_ThenReconcilesToPosted()
    {
        var firstPost = new TaskCompletionSource<ManualPostingTransportResult>(TaskCreationOptions.RunContinuationsAsynchronously);
        var firstGet = new TaskCompletionSource<ManualPostingTransportResult>(TaskCreationOptions.RunContinuationsAsynchronously);
        var secondPost = new TaskCompletionSource<ManualPostingTransportResult>(TaskCreationOptions.RunContinuationsAsynchronously);
        int posts = 0, gets = 0;
        var transport = new RecordingTransport
        {
            Post = (platform, _) => Interlocked.Increment(ref posts) == 1 ? firstPost.Task : secondPost.Task,
            Get = (platform, _) => Interlocked.Increment(ref gets) == 1
                ? firstGet.Task
                : Task.FromResult(Authoritative(platform, "ready", null, 0, 3, false)),
        };
        using var controller = Controller(transport);
        await using NativeWindowHarness harness = await NativeWindowHarness.StartAsync(controller);

        SendMessage(harness.Window.PostingActionHandle, BmClick, IntPtr.Zero, IntPtr.Zero);
        Assert.False(IsWindowEnabled(harness.Window.PostingActionHandle));
        harness.DrainPresentationSignal();
        firstPost.SetResult(ManualPostingTransportResult.Ambiguous());
        firstGet.SetResult(ManualPostingTransportResult.Ambiguous());
        harness.WaitForPresentation();

        Assert.Equal("Confirmation not received. Retry.", Text(harness.Window.PostingStatusHandle));
        Assert.Equal("Retry confirmation", Text(harness.Window.PostingActionHandle));
        Assert.True(IsWindowEnabled(harness.Window.PostingActionHandle));

        SendMessage(harness.Window.PostingActionHandle, BmClick, IntPtr.Zero, IntPtr.Zero);
        Assert.Equal(ManualPostingConfirmationStatus.Confirming, controller.GetState("x").Status);
        Assert.False(IsWindowEnabled(harness.Window.PostingActionHandle));
        harness.DrainPresentationSignal();
        secondPost.SetResult(Authoritative("x", "posted", new DateTime(2030, 1, 2), 1, 3, false));
        harness.WaitForPresentation();

        Assert.Equal("Posted — confirmed by you", Text(harness.Window.PostingStatusHandle));
        Assert.False(IsWindowVisible(harness.Window.PostingActionHandle));
        Assert.Equal(2, transport.PostCalls);
        Assert.Equal(2, transport.GetCalls);
    }

    [Theory]
    [InlineData("button")]
    [InlineData("wm-close")]
    [InlineData("escape")]
    public async Task NativeClosePaths_FromReady_DoNotSendConfirmation(string closePath)
    {
        var transport = new RecordingTransport();
        using var controller = Controller(transport);
        await using NativeWindowHarness harness = await NativeWindowHarness.StartAsync(controller);

        harness.SelectPlatform(1);
        Assert.Equal(0, transport.PostCalls);

        if (closePath == "button")
            SendMessage(GetDlgItem(harness.Window.WindowHandle, NativeManualPublishingCompanion.NativeWindow.CloseId),
                BmClick, IntPtr.Zero, IntPtr.Zero);
        else if (closePath == "wm-close")
            SendMessage(harness.Window.WindowHandle, WmClose, IntPtr.Zero, IntPtr.Zero);
        else
            PostMessage(harness.Window.WindowHandle, WmKeyDown, new IntPtr(VkEscape), IntPtr.Zero);

        await harness.WaitForCloseAsync();
        Assert.Equal(0, transport.PostCalls);
        Assert.Equal(0, transport.GetCalls);
    }

    [Fact]
    public async Task CloseWhileConfirming_ClosesNormallyAndLateCancellationCannotTouchDestroyedWindow()
    {
        var started = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var cancelled = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var transport = new RecordingTransport
        {
            Post = async (_, token) =>
            {
                started.TrySetResult();
                try { await Task.Delay(Timeout.InfiniteTimeSpan, token); }
                catch (OperationCanceledException) when (token.IsCancellationRequested)
                {
                    cancelled.TrySetResult();
                    throw;
                }
                return ManualPostingTransportResult.Ambiguous();
            },
        };
        var controller = Controller(transport);
        try
        {
            await using NativeWindowHarness harness = await NativeWindowHarness.StartAsync(controller);
            SendMessage(harness.Window.PostingActionHandle, BmClick, IntPtr.Zero, IntPtr.Zero);
            await started.Task.WaitAsync(TimeSpan.FromSeconds(5));
            Assert.False(IsWindowEnabled(harness.Window.PostingActionHandle));

            harness.Window.RequestClose();
            await harness.WaitForCloseAsync();
            controller.Dispose();
            await cancelled.Task.WaitAsync(TimeSpan.FromSeconds(5));

            Assert.Equal(1, transport.PostCalls);
            Assert.Equal(0, transport.GetCalls);
            Assert.Equal(IntPtr.Zero, harness.Window.WindowHandle);
        }
        finally { controller.Dispose(); }
    }

    [Fact]
    public void OnlyExplicitPostingButtonMapsToConfirmationWorkflow()
    {
        Assert.True(NativeManualPublishingCompanion.NativeWindow.IsPostingConfirmationCommand(
            NativeManualPublishingCompanion.NativeWindow.PostingConfirmationId));
        Assert.False(NativeManualPublishingCompanion.NativeWindow.IsPostingConfirmationCommand(
            NativeManualPublishingCompanion.NativeWindow.PlatformId));
        Assert.False(NativeManualPublishingCompanion.NativeWindow.IsPostingConfirmationCommand(
            NativeManualPublishingCompanion.NativeWindow.CopyTitleId));
        Assert.False(NativeManualPublishingCompanion.NativeWindow.IsPostingConfirmationCommand(
            NativeManualPublishingCompanion.NativeWindow.CopyMainId));
        Assert.False(NativeManualPublishingCompanion.NativeWindow.IsPostingConfirmationCommand(
            NativeManualPublishingCompanion.NativeWindow.CloseId));
    }

    [Fact]
    public async Task ProductionAssetsHeader_ExposesZeroCountAndGuidanceWithoutSelectAllControl()
    {
        using var controller = Controller(new RecordingTransport());
        await using NativeWindowHarness harness = await NativeWindowHarness.StartAsync(controller);
        Assert.Equal(IntPtr.Zero, GetDlgItem(harness.Window.WindowHandle, 207));
        Assert.Equal("0 of 0 selected", Text(harness.Window.AssetCountHandle));
        Assert.Equal("Select files to attach.", Text(harness.Window.DragGuidanceHandle));
        Assert.Equal("Static", ClassName(harness.Window.AssetCountHandle));
        Assert.Equal("Static", ClassName(harness.Window.DragGuidanceHandle));
    }

    private static ManualPostingConfirmationPresentation Map(
        ManualPostingConfirmationStatus status, ManualPostingCompletion? completion = null) =>
        ManualPostingConfirmationPresentationMapper.Map(
            new ManualPostingPlatformState("x", status, status == ManualPostingConfirmationStatus.Posted
                ? new DateTime(2030, 1, 1) : null, null), completion, "X");

    private static ManualPostingConfirmationController Controller(RecordingTransport transport) =>
        new(transport, ["x", "patreon", "bluesky"]);

    private static ManualPostingTransportResult Authoritative(
        string platform, string status, DateTime? postedAt, int posted, int total, bool complete) =>
        ManualPostingTransportResult.Authoritative(new ManualPostingConfirmationResponse(
            platform, status, postedAt, new ManualPostingCompletion(posted, total, complete)));

    private static string Text(IntPtr window)
    {
        int length = GetWindowTextLength(window);
        var value = new StringBuilder(length + 1);
        GetWindowText(window, value, value.Capacity);
        return value.ToString();
    }

    private static string ClassName(IntPtr window)
    {
        var value = new StringBuilder(64);
        GetClassName(window, value, value.Capacity);
        return value.ToString();
    }

    private sealed class NativeWindowHarness : IAsyncDisposable
    {
        private readonly AutoResetEvent _presentation = new(false);
        private readonly TaskCompletionSource<Exception?> _closed = new(TaskCreationOptions.RunContinuationsAsynchronously);
        private readonly Thread _thread;

        private NativeWindowHarness(
            ManualPostingConfirmationController controller,
            Func<IntPtr, IUnicodeClipboard>? clipboardFactory)
        {
            var lifecycle = new ManualCompanionLifecycle();
            Window = new NativeManualPublishingCompanion.NativeWindow(
                new ManualPublishingCompanionModel(Session()), lifecycle, controller, clipboardFactory,
                disableWinUiForNativeOnlyTests: true);
            Window.PostingPresentationChanged += () => _presentation.Set();
            _thread = new Thread(() => Run(lifecycle)) { IsBackground = true, Name = "Native confirmation test" };
            _thread.SetApartmentState(ApartmentState.STA);
            Lifecycle = lifecycle;
        }

        public NativeManualPublishingCompanion.NativeWindow Window { get; }
        private ManualCompanionLifecycle Lifecycle { get; }

        public static async Task<NativeWindowHarness> StartAsync(
            ManualPostingConfirmationController controller,
            Func<IntPtr, IUnicodeClipboard>? clipboardFactory = null)
        {
            var harness = new NativeWindowHarness(controller, clipboardFactory);
            harness._thread.Start();
            await harness.Lifecycle.Ready.WaitAsync(TimeSpan.FromSeconds(5));
            return harness;
        }

        public void SelectPlatform(int index)
        {
            SendMessage(Window.PlatformHandle, CbSetCurSel, new IntPtr(index), IntPtr.Zero);
            SendMessage(Window.WindowHandle, WmCommand,
                new IntPtr(NativeManualPublishingCompanion.NativeWindow.PlatformId | CbnSelChange << 16),
                Window.PlatformHandle);
        }

        public NativeProductionLayoutProbe CaptureMinimumLayout(int index) =>
            Window.ResizeToMinimumAndCaptureLayoutForTesting(index);

        public void DrainPresentationSignal()
        {
            while (_presentation.WaitOne(0)) { }
        }

        public void WaitForPresentation() => Assert.True(_presentation.WaitOne(TimeSpan.FromSeconds(5)));

        public async Task WaitForCloseAsync()
        {
            Exception? failure = await _closed.Task.WaitAsync(TimeSpan.FromSeconds(5));
            if (failure is not null) throw failure;
        }

        public async ValueTask DisposeAsync()
        {
            if (!_closed.Task.IsCompleted) Window.RequestClose();
            await WaitForCloseAsync();
            _presentation.Dispose();
        }

        private void Run(ManualCompanionLifecycle lifecycle)
        {
            Exception? failure = null;
            try { Window.Run(new NativePresentationResult()); }
            catch (Exception exception) { failure = exception; }
            finally
            {
                try { Window.ShutdownAsync(new NoOpLease()).GetAwaiter().GetResult(); }
                catch (Exception exception) { failure ??= exception; }
                _closed.TrySetResult(failure);
            }
        }
    }

    private static ManualSocialSession Session() => new(
        new Uri("https://creatorcrate.test/"), 42, "Release title",
        [new ManualPreparedPlatform("x", "Release title", "X post", []),
         new ManualPreparedPlatform("patreon", "Patreon title", "Patreon body", []),
         new ManualPreparedPlatform("bluesky", "Release title", "Bluesky post", [])]);

    private sealed class NoOpLease : IDisposable { public void Dispose() { } }

    private sealed class RecordingClipboard : IUnicodeClipboard
    {
        public List<string> Values { get; } = [];
        public bool TrySetText(string text) { Values.Add(text); return true; }
    }

    private sealed class RecordingTransport : IManualPostingConfirmationTransport
    {
        private int _postCalls, _getCalls;
        public DateTime? ConfirmationExpiresAt => null;
        public int PostCalls => Volatile.Read(ref _postCalls);
        public int GetCalls => Volatile.Read(ref _getCalls);
        public Func<string, CancellationToken, Task<ManualPostingTransportResult>> Post { get; init; } =
            (_, _) => Task.FromResult(ManualPostingTransportResult.Ambiguous());
        public Func<string, CancellationToken, Task<ManualPostingTransportResult>> Get { get; init; } =
            (_, _) => Task.FromResult(ManualPostingTransportResult.Ambiguous());
        public Task<ManualPostingTransportResult> PostAsync(string platform, CancellationToken cancellationToken)
        {
            Interlocked.Increment(ref _postCalls);
            return Post(platform, cancellationToken);
        }
        public Task<ManualPostingTransportResult> GetAsync(string platform, CancellationToken cancellationToken)
        {
            Interlocked.Increment(ref _getCalls);
            return Get(platform, cancellationToken);
        }
        public void Dispose() { }
    }

    private static void AssertWithin(NativeLayoutRect actual, NativeLayoutRect container)
    {
        Assert.True(actual.Width > 0 && actual.Height > 0);
        Assert.True(actual.X >= container.X && actual.Y >= container.Y);
        Assert.True(actual.Right <= container.Right && actual.Bottom <= container.Bottom);
    }

    private static void AssertWithinClient(NativeLayoutRect actual, NativeLayoutSize client)
    {
        Assert.True(actual.Width > 0 && actual.Height > 0);
        Assert.True(actual.X >= 0 && actual.Y >= 0);
        Assert.True(actual.Right <= client.Width && actual.Bottom <= client.Height);
    }

    private const uint BmClick = 0x00F5, CbSetCurSel = 0x014E, WmClose = 0x0010,
        WmCommand = 0x0111, WmKeyDown = 0x0100;
    private const int CbnSelChange = 1, VkEscape = 0x1B;

    [DllImport("user32.dll", EntryPoint = "SendMessageW", ExactSpelling = true)]
    private static extern IntPtr SendMessage(IntPtr window, uint message, IntPtr wParam, IntPtr lParam);
    [DllImport("user32.dll", EntryPoint = "PostMessageW", ExactSpelling = true)]
    private static extern bool PostMessage(IntPtr window, uint message, IntPtr wParam, IntPtr lParam);
    [DllImport("user32.dll")] private static extern bool IsWindowEnabled(IntPtr window);
    [DllImport("user32.dll")] private static extern bool IsWindowVisible(IntPtr window);
    [DllImport("user32.dll")] private static extern IntPtr GetDlgItem(IntPtr parent, int id);
    [DllImport("user32.dll", EntryPoint = "GetClassNameW", CharSet = CharSet.Unicode, ExactSpelling = true)]
    private static extern int GetClassName(IntPtr window, StringBuilder className, int maximumCount);
    [DllImport("user32.dll", EntryPoint = "GetWindowLongPtrW", ExactSpelling = true)]
    private static extern IntPtr GetWindowLongPtr(IntPtr window, int index);
    [DllImport("user32.dll", EntryPoint = "GetWindowTextLengthW", CharSet = CharSet.Unicode, ExactSpelling = true)]
    private static extern int GetWindowTextLength(IntPtr window);
    [DllImport("user32.dll", EntryPoint = "GetWindowTextW", CharSet = CharSet.Unicode, ExactSpelling = true)]
    private static extern int GetWindowText(IntPtr window, StringBuilder text, int maximumCount);
}
