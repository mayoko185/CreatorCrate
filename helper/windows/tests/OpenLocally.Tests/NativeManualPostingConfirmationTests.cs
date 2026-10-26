using OpenLocally;
using System.Runtime.InteropServices;
using System.Text;

namespace OpenLocally.Tests;

[Collection("Native header resource isolation")]
public sealed class NativeManualPostingConfirmationTests
{
    [Fact]
    public void ProductionCompanion_OptsIntoBorrowedConfirmationControllerComposition() =>
        Assert.IsAssignableFrom<IManualPostingConfirmationCompanion>(NativeManualPublishingCompanion.Instance);
    [Fact]
    public async Task CompleteProductionCompanion_ApprovedNarrowTargetScrollsActualChildWindowsAbovePinnedFooter()
    {
        using var controller = Controller(new RecordingTransport());
        await using NativeWindowHarness harness = await NativeWindowHarness.StartAsync(controller);
        NativeLayoutSize supported = NativeCompanionLayout.SupportedMinimumLogicalClientSize;

        foreach ((int index, string platform) in new[] { (0, "x"), (1, "patreon"), (2, "bluesky") })
        {
            NativeProductionLayoutProbe probe = harness.CaptureMinimumLayout(index);
            int gap = 12 * probe.Dpi / 96;
            Console.WriteLine($"{platform}: {probe.Dpi} DPI, minimum outer {probe.MinimumTrack.Width}x{probe.MinimumTrack.Height}, client {probe.Client.Width}x{probe.Client.Height}, content {probe.ContentHeight}, viewport {probe.Viewport.Height}");

            Assert.Equal(platform, probe.Platform);
            NativeLayoutSize minimumOuter = NativeManualPublishingCompanion.NativeWindow.MinimumOuterSizeForDpi(probe.Dpi);
            Assert.True(probe.MinimumTrack.Width <= minimumOuter.Width && probe.MinimumTrack.Height <= minimumOuter.Height);
            Assert.Equal(supported.Width * probe.Dpi / 96, probe.Client.Width);
            Assert.Equal(supported.Height * probe.Dpi / 96, probe.Client.Height);
            Assert.True(probe.ScrollBarVisible);
            Assert.True(probe.ScrollMaximum > 0);
            Assert.Equal(0, probe.ScrollOffset);
            Assert.Equal(probe.Footer.Y, probe.Viewport.Bottom);
            Assert.Equal(probe.Viewport.Height, probe.ScrollBar.Height);
            AssertScrolledChildrenStayAboveFooter(probe);
            AssertWithinClient(probe.Header, probe.Client);
            AssertWithin(probe.PlatformHeading, probe.PlatformCard);
            AssertWithin(probe.PlatformSelector, probe.PlatformCard);
            AssertWithin(probe.BodyLabel, probe.PlatformCard);
            AssertWithin(probe.BodyText, probe.PlatformCard);
            AssertWithin(probe.CopyMain, probe.PlatformCard);
            Assert.False(probe.BodyText.Intersects(probe.CopyMain));
            Assert.True(probe.PlatformSelector.Right <= probe.ScrollBar.X);
            if (platform == "patreon")
            {
                AssertWithin(probe.TitleLabel, probe.PlatformCard);
                AssertWithin(probe.TitleText, probe.PlatformCard);
                AssertWithin(probe.CopyTitle, probe.PlatformCard);
                Assert.False(probe.TitleText.Intersects(probe.CopyTitle));
            }
            AssertWithin(probe.PostingAggregate, probe.Footer);
            AssertWithin(probe.Close, probe.Footer);
            AssertWithinClient(probe.Footer, probe.Client);
            AssertCompactProductionFooter(probe);

            NativeProductionLayoutProbe end = harness.Window.ScrollContentToForTesting(int.MaxValue);
            Assert.Equal(end.ScrollMaximum, end.ScrollOffset);
            AssertScrolledChildrenStayAboveFooter(end);
            AssertWithin(end.PostingStatus, end.PlatformCard);
            AssertWithin(end.PostingHelper, end.PlatformCard);
            AssertWithin(end.PostingAction, end.PlatformCard);
            Assert.False(end.PostingStatus.Intersects(end.PostingAction));
            Assert.True(end.AssetsCard.Y - end.PlatformCard.Bottom >= gap);
            AssertWithin(end.AssetsHeading, end.AssetsCard);
            AssertWithin(end.AssetCount, end.AssetsCard);
            AssertWithin(end.DragGuidance, end.AssetsCard);
            AssertWithin(end.AssetList, end.AssetsCard);
            Assert.True(end.AssetList.Bottom <= end.Viewport.Bottom, "The end of the scroll range reveals the whole asset list.");
            Assert.True(end.DragGuidance.Bottom < end.AssetList.Y);
            Assert.Equal(probe.Close, end.Close);
            Assert.Equal(probe.Footer, end.Footer);
            harness.Window.ScrollContentToForTesting(0);
        }
    }

    [Fact]
    public async Task CompleteProductionCompanion_WheelScrollBarAndResizeKeepTheScrollOffsetWithinRange()
    {
        using var controller = Controller(new RecordingTransport());
        await using NativeWindowHarness harness = await NativeWindowHarness.StartAsync(controller);
        NativeProductionLayoutProbe start = harness.CaptureMinimumLayout(1);
        Assert.Equal(0, start.ScrollOffset);

        NativeProductionLayoutProbe wheeled = harness.Window.ScrollContentByWheelForTesting(-120);
        Assert.True(wheeled.ScrollOffset > 0);
        Assert.Equal(start.PlatformCard.Y - wheeled.ScrollOffset, wheeled.PlatformCard.Y);
        Assert.Equal(start.Close, wheeled.Close);
        AssertScrolledChildrenStayAboveFooter(wheeled);

        NativeProductionLayoutProbe bottom = harness.Window.ScrollContentByBarForTesting(7); // SB_BOTTOM
        Assert.Equal(bottom.ScrollMaximum, bottom.ScrollOffset);
        NativeProductionLayoutProbe lineUp = harness.Window.ScrollContentByBarForTesting(0); // SB_LINEUP
        Assert.True(lineUp.ScrollOffset < bottom.ScrollOffset);
        NativeProductionLayoutProbe beyond = harness.Window.ScrollContentByWheelForTesting(-120 * 40);
        Assert.Equal(beyond.ScrollMaximum, beyond.ScrollOffset);

        // Growing the window past the content clears the offset and hides the scroll bar.
        NativeProductionLayoutProbe roomy = harness.Window.ResizeAndCaptureLayoutForTesting(1, 1200, 1400);
        Assert.Equal(0, roomy.ScrollOffset);
        Assert.Equal(0, roomy.ScrollMaximum);
        Assert.False(roomy.ScrollBarVisible);
        NativeProductionLayoutProbe narrowAgain = harness.Window.ResizeAndCaptureLayoutForTesting(1, 640, 600);
        Assert.True(narrowAgain.ScrollBarVisible);
        NativeProductionLayoutProbe top = harness.Window.ScrollContentByBarForTesting(6); // SB_TOP
        Assert.Equal(0, top.ScrollOffset);
    }

    [Fact]
    public async Task CompleteProductionCompanion_TabFocusScrollsEachTargetFullyIntoViewAtTheNarrowTarget()
    {
        var link = new ScriptedTransport();
        link.Gets.Enqueue(_ => Task.FromResult(ManualReleaseLinkTransportResult.Authoritative("https://old.test/a")));
        using var releaseLink = new ManualReleaseLinkController(link);
        using var controller = Controller(new RecordingTransport());
        var clipboard = new RecordingClipboard();
        await using NativeWindowHarness harness = await NativeWindowHarness.StartAsync(
            controller, _ => clipboard, releaseLink: releaseLink);
        await releaseLink.LoadAsync();
        harness.WaitForReleaseLinkStatus("Release link is up to date.");

        foreach ((int index, string platform) in new[] { (1, "patreon"), (0, "x") })
        {
            harness.Window.ResizeAndCaptureLayoutForTesting(index, 640, 600);
            // Tab wraps from Close to the tabs, then follows the column: content, Assets, and the Release
            // link last. Save link is disabled until the draft changes, so Tab leaves the input for Close.
            // This native-only harness has no WinUI islands; the proof process covers island focus.
            IReadOnlyList<NativeFocusVisibilityProbe> forward =
                harness.Window.TraverseFocusAndCaptureVisibilityForTesting(platform == "patreon" ? 7 : 6);
            string[] expected = platform == "patreon"
                ? ["tabs", "copy-title", "copy-main", "posting", "assets", "link-input", "close"]
                : ["tabs", "copy-main", "posting", "assets", "link-input", "close"];
            Assert.Equal(expected, forward.Select(FocusName));
            Assert.All(forward, step => Assert.True(step.FullyVisible,
                $"{platform}: focus target {FocusName(step)} at {step.Bounds} was not scrolled into view (offset {step.ScrollOffset})."));
            Assert.True(forward.Single(step => FocusName(step) == "link-input").ScrollOffset > 0,
                "Reaching the Release link at 640 by 600 scrolls the content.");
            Assert.True(forward.Single(step => FocusName(step) == "link-input").ScrollOffset >
                    forward.Single(step => FocusName(step) == "assets").ScrollOffset,
                "The Release link follows Assets, so focusing it scrolls further down.");

            IReadOnlyList<NativeFocusVisibilityProbe> reverse =
                harness.Window.TraverseFocusAndCaptureVisibilityForTesting(4, previous: true);
            Assert.Equal(["link-input", "assets", "posting", "copy-main"], reverse.Select(FocusName));
            Assert.All(reverse, step => Assert.True(step.FullyVisible));
        }

        static string FocusName(NativeFocusVisibilityProbe step) => step.Island.Length > 0 ? step.Island : step.ControlId switch
        {
            NativeManualPublishingCompanion.NativeWindow.PlatformId => "tabs",
            NativeManualPublishingCompanion.NativeWindow.CopyTitleId => "copy-title",
            NativeManualPublishingCompanion.NativeWindow.CopyMainId => "copy-main",
            NativeManualPublishingCompanion.NativeWindow.PostingConfirmationId => "posting",
            NativeManualPublishingCompanion.NativeWindow.AssetListId => "assets",
            NativeManualPublishingCompanion.NativeWindow.CloseId => "close",
            NativeManualPublishingCompanion.NativeWindow.ReleaseLinkInputId => "link-input",
            NativeManualPublishingCompanion.NativeWindow.ReleaseLinkSaveId => "link-save",
            int id => $"control-{id}",
        };
        Assert.Empty(clipboard.Values);
        Assert.All(new[] { "x", "patreon", "bluesky" }, platform =>
            Assert.Equal(ManualPostingConfirmationStatus.Ready, controller.GetState(platform).Status));
    }

    [Fact]
    public async Task CompleteProductionCompanion_ResizesAndSwitchesWithContainedChildWindows()
    {
        using var controller = Controller(new RecordingTransport());
        await using NativeWindowHarness harness = await NativeWindowHarness.StartAsync(controller);
        NativeProductionLayoutProbe minimum = harness.Window.ResizeAndCaptureLayoutForTesting(1, 640, 600);
        NativeProductionLayoutProbe normal = harness.Window.ResizeAndCaptureLayoutForTesting(1, 980, 920);
        NativeProductionLayoutProbe large = harness.Window.ResizeAndCaptureLayoutForTesting(1, 980, 1400);
        NativeProductionLayoutProbe wide = harness.Window.ResizeAndCaptureLayoutForTesting(1, 1600, 920);

        Assert.True(minimum.ScrollBarVisible);
        Assert.False(normal.ScrollBarVisible);
        Assert.False(large.ScrollBarVisible);
        Assert.True(normal.BodyText.Height >= minimum.BodyText.Height);
        Assert.True(large.BodyText.Height <= 240 * large.Dpi / 96);
        Assert.True(large.AssetsCard.Height <= 440 * large.Dpi / 96);
        Assert.Equal(1152 * wide.Dpi / 96, wide.PlatformCard.Width);
        Assert.Equal((wide.Client.Width - wide.PlatformCard.Width) / 2, wide.PlatformCard.X);
        AssertCompactProductionFooter(minimum);
        AssertCompactProductionFooter(normal);
        AssertCompactProductionFooter(wide);

        string feedback = string.Join(' ', Enumerable.Repeat("status", 60));
        NativeProductionLayoutProbe wideFeedback = harness.Window.ResizeAndCaptureLayoutForTesting(
            1, 1600, 920, feedback);
        Assert.True(wideFeedback.Status.Height > 16 * wideFeedback.Dpi / 96, "Long feedback wraps to a second line.");
        Assert.True(wideFeedback.Status.Height <= 32 * wideFeedback.Dpi / 96 + 2);
        Assert.Equal(wideFeedback.PlatformCard.X + 16 * wideFeedback.Dpi / 96, wideFeedback.Status.X);
        Assert.True(wideFeedback.Status.Right <= wideFeedback.Close.X +
            NativeCompanionTheme.ButtonFocusMargin(wideFeedback.Dpi) - 12 * wideFeedback.Dpi / 96);
        Assert.False(wideFeedback.Status.Intersects(wideFeedback.Close));
        AssertWithin(wideFeedback.Status, wideFeedback.Footer);

        foreach ((int index, string platform) in new[] { (1, "patreon"), (0, "x"), (2, "bluesky"), (1, "patreon") })
        {
            NativeProductionLayoutProbe probe = harness.Window.ResizeAndCaptureLayoutForTesting(index, 640, 600);
            Assert.Equal(platform, probe.Platform);
            AssertScrolledChildrenStayAboveFooter(probe);
            AssertWithin(probe.BodyText, probe.PlatformCard);
            AssertWithin(probe.CopyMain, probe.PlatformCard);
            AssertWithin(probe.PostingStatus, probe.PlatformCard);
            AssertWithin(probe.PostingHelper, probe.PlatformCard);
            AssertWithin(probe.PostingAggregate, probe.Footer);
            Assert.False(probe.BodyText.Intersects(probe.PostingStatus));
            Assert.False(probe.BodyText.Intersects(probe.CopyMain));
            AssertVerticallyCentred(probe.BodyLabel, probe.CopyMain);
            Assert.True(probe.AssetsCard.Y >= probe.PlatformCard.Bottom + 12 * probe.Dpi / 96);
            if (platform == "patreon")
            {
                AssertWithin(probe.TitleText, probe.PlatformCard);
                AssertVerticallyCentred(probe.TitleLabel, probe.CopyTitle);
                Assert.True(probe.BodyLabel.Y > probe.TitleText.Bottom);
            }
            else Assert.True(probe.BodyLabel.Y < minimum.BodyLabel.Y);
        }
    }

    [Fact]
    public async Task CompleteProductionCompanion_FitsFiveRowsAndScrollsTheSixthAtNormalLaunchSize()
    {
        static ManualPreparedAsset Asset(long id) => new(
            new SocialRedeemAsset(id, "attachment", id, $"asset-{id}.png", ".png", "image/png",
                id * 100, $"release/asset-{id}.png", true, null),
            $@"C:\stage\asset-{id}.png", StagedMediaProvenance.HelperOwned);
        var session = new ManualSocialSession(
            new Uri("https://creatorcrate.test/"), 42, "Release title",
            [
                new ManualPreparedPlatform("x", "Release title", "X post", []),
                new ManualPreparedPlatform("patreon", "Patreon title", "Patreon body",
                    Enumerable.Range(1, 5).Select(index => Asset(index)).ToArray()),
                new ManualPreparedPlatform("bluesky", "Release title", "Bluesky post",
                    Enumerable.Range(1, 6).Select(index => Asset(100 + index)).ToArray()),
            ]);
        using var controller = Controller(new RecordingTransport());
        await using NativeWindowHarness harness = await NativeWindowHarness.StartAsync(
            controller, session: session);

        harness.Window.ResizeAndCaptureLayoutForTesting(1, 980, 920);
        NativeAssetViewportProbe five = harness.Window.CaptureAssetViewportForTesting();
        Assert.Equal(5, five.DisplayedAssetCount);
        Assert.All(five.Items, item => Assert.True(item.Bottom <= five.ListClient.Bottom));
        Assert.True(five.ScrollMaximum - five.ScrollMinimum + 1 <= five.ScrollPage);

        harness.Window.ResizeAndCaptureLayoutForTesting(2, 980, 920);
        NativeAssetViewportProbe six = harness.Window.CaptureAssetViewportForTesting();
        Assert.Equal(5, six.VisibleRowTarget);
        Assert.True(six.Items[4].Bottom <= six.ListClient.Bottom);
        Assert.True(six.Items[5].Bottom > six.ListClient.Bottom);
        Assert.True(six.ScrollMaximum - six.ScrollMinimum + 1 > six.ScrollPage);

        int firstFiveRowHeight = -1;
        for (int logicalHeight = NativeCompanionLayout.RequiredLogicalClientHeight;
             logicalHeight <= 920; logicalHeight++)
        {
            harness.Window.ResizeAndCaptureLayoutForTesting(1, 820, logicalHeight);
            NativeAssetViewportProbe candidate = harness.Window.CaptureAssetViewportForTesting();
            if (candidate.Items.All(item => item.Bottom <= candidate.ListClient.Bottom))
            {
                firstFiveRowHeight = logicalHeight;
                break;
            }
        }
        Assert.True(firstFiveRowHeight > NativeCompanionLayout.RequiredLogicalClientHeight);
        harness.Window.ResizeAndCaptureLayoutForTesting(1, 820, firstFiveRowHeight - 1);
        NativeAssetViewportProbe predecessor = harness.Window.CaptureAssetViewportForTesting();
        Assert.Contains(predecessor.Items, item => item.Bottom > predecessor.ListClient.Bottom);
        Console.WriteLine($"First 96-DPI logical client height fitting five production rows: {firstFiveRowHeight}");
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
        Assert.Equal("2 of 3 platforms marked as posted.", rejected.AggregateText);
    }

    [Theory]
    [InlineData(0, 3, false, "0 of 3 platforms marked as posted.")]
    [InlineData(1, 3, false, "1 of 3 platforms marked as posted.")]
    [InlineData(2, 3, false, "2 of 3 platforms marked as posted.")]
    [InlineData(3, 3, true, "All social posts marked as posted.")]
    public void AggregatePresentation_UsesCanonicalServerValues(
        int posted, int total, bool complete, string expected)
    {
        ManualPostingConfirmationPresentation presentation = Map(
            ManualPostingConfirmationStatus.Ready, new ManualPostingCompletion(posted, total, complete));
        Assert.Equal(expected, presentation.AggregateText);
    }

    [Theory]
    [InlineData(0, 3, false, "0 of 3 platforms marked as posted.")]
    [InlineData(1, 3, false, "1 of 3 platforms marked as posted.")]
    [InlineData(2, 3, false, "2 of 3 platforms marked as posted.")]
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
        Assert.Equal("1 of 3 platforms marked as posted.", Text(harness.Window.PostingAggregateHandle));

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
        harness.SelectPlatform(1);
        (IntPtr Handle, NativeCompanionButtonRole Role)[] buttons =
        [
            (GetDlgItem(harness.Window.WindowHandle, NativeManualPublishingCompanion.NativeWindow.CopyTitleId), NativeCompanionButtonRole.Secondary),
            (GetDlgItem(harness.Window.WindowHandle, NativeManualPublishingCompanion.NativeWindow.CopyMainId), NativeCompanionButtonRole.Secondary),
            (harness.Window.PostingActionHandle, NativeCompanionButtonRole.Primary),
            (GetDlgItem(harness.Window.WindowHandle, NativeManualPublishingCompanion.NativeWindow.CloseId), NativeCompanionButtonRole.Secondary),
        ];

        foreach ((IntPtr button, NativeCompanionButtonRole role) in buttons)
        {
            var className = new StringBuilder(32);
            Assert.True(GetClassName(button, className, className.Capacity) > 0);
            Assert.Equal("Button", className.ToString());
            Assert.Equal(role, harness.Window.ButtonRoleForTesting(button));
            Assert.Equal(
                NativeManualPublishingCompanion.NativeWindow.ProductionButtonStyle,
                unchecked((uint)GetWindowLongPtr(button, -16).ToInt64()));
            Assert.Equal(
                NativeManualPublishingCompanion.NativeWindow.ProductionButtonExtendedStyle,
                unchecked((uint)GetWindowLongPtr(button, -20).ToInt64()));
        }
    }

    [Fact]
    public async Task PlatformTabs_AreOneNativeTabControlInServerOrderAcrossSwitchThemeAndFocusCycles()
    {
        var transport = new RecordingTransport();
        using var controller = Controller(transport);
        var clipboard = new RecordingClipboard();
        await using NativeWindowHarness harness = await NativeWindowHarness.StartAsync(controller, _ => clipboard);

        NativePlatformTabsProbe initial = harness.Window.CapturePlatformTabsForTesting();
        Assert.Equal("SysTabControl32", initial.ClassName);
        Assert.Equal(NativeManualPublishingCompanion.NativeWindow.ProductionPlatformClass, initial.ClassName);
        Assert.Equal(NativeManualPublishingCompanion.NativeWindow.ProductionPlatformStyle,
            initial.Style & NativeManualPublishingCompanion.NativeWindow.ProductionPlatformStyle);
        Assert.Equal(NativeManualPublishingCompanion.NativeWindow.PlatformId, initial.ControlId);
        Assert.Equal(harness.Window.WindowHandle, initial.Parent);
        Assert.Equal(NativeManualPublishingCompanion.NativeWindow.ProductionPlatformName, initial.WindowText);
        Assert.Equal(["X", "Patreon", "Bluesky"], initial.Labels);
        Assert.Equal(0, initial.SelectedIndex);
        Assert.Equal("x", initial.ModelPlatform);
        Assert.True(initial.Bounds.Width > 0 && initial.Bounds.Height > 0);

        foreach ((int index, string platform) in new[]
                 {
                     (1, "patreon"), (0, "x"), (2, "bluesky"), (1, "patreon"),
                 })
        {
            harness.SelectPlatform(index);
            NativePlatformTabsProbe switched = harness.Window.CapturePlatformTabsForTesting();
            Assert.Equal(initial.Handle, switched.Handle);
            Assert.Equal(index, switched.SelectedIndex);
            Assert.Equal(platform, switched.ModelPlatform);
            Assert.Equal(initial.Labels, switched.Labels);
        }

        foreach ((NativeCompanionPalette palette, int dpi) in new[]
                 {
                     (NativeCompanionPalette.Dark, 96), (NativeCompanionPalette.Light, 144),
                     (NativeCompanionPalette.HighContrast, 192), (NativeCompanionPalette.Dark, 96),
                 })
        {
            NativePlatformTabsProbe themed = harness.Window.ApplyThemeAndCapturePlatformTabsForTesting(palette, dpi);
            Assert.Equal(initial.Handle, themed.Handle);
            Assert.Equal(1, themed.SelectedIndex);
            Assert.Equal("patreon", themed.ModelPlatform);
        }

        Assert.True(harness.Window.FocusPlatformTabsForTesting().KeyboardFocused);
        Assert.Equal(0, transport.PostCalls);
        Assert.Equal(0, transport.GetCalls);
        Assert.Empty(clipboard.Values);
    }

    [Fact]
    public async Task PlatformTabs_KeyboardArrowsHomeAndEndUseTheProductionSelectionRouteWithoutSideEffects()
    {
        var transport = new RecordingTransport();
        using var controller = Controller(transport);
        var clipboard = new RecordingClipboard();
        await using NativeWindowHarness harness = await NativeWindowHarness.StartAsync(controller, _ => clipboard);
        harness.DrainPresentationSignal();

        NativePlatformTabsProbe right = harness.Window.PressKeyOnPlatformTabsForTesting(VkRight);
        Assert.True(right.KeyboardFocused);
        Assert.Equal(1, right.SelectedIndex);
        Assert.Equal("patreon", right.ModelPlatform);
        Assert.Equal("Ready for manual publishing — not marked as posted", Text(harness.Window.PostingStatusHandle));
        Assert.Contains("Patreon", Text(harness.Window.PostingHelperHandle));

        NativePlatformTabsProbe end = harness.Window.PressKeyOnPlatformTabsForTesting(VkEnd);
        Assert.Equal(2, end.SelectedIndex);
        Assert.Equal("bluesky", end.ModelPlatform);
        Assert.True(end.KeyboardFocused);

        NativePlatformTabsProbe left = harness.Window.PressKeyOnPlatformTabsForTesting(VkLeft);
        Assert.Equal(1, left.SelectedIndex);
        Assert.Equal("patreon", left.ModelPlatform);

        NativePlatformTabsProbe home = harness.Window.PressKeyOnPlatformTabsForTesting(VkHome);
        Assert.Equal(0, home.SelectedIndex);
        Assert.Equal("x", home.ModelPlatform);

        // Enter and Space on the tab strip neither copy nor confirm.
        NativePlatformTabsProbe enter = harness.Window.PressKeyOnPlatformTabsForTesting(VkReturn);
        Assert.Equal(0, enter.SelectedIndex);
        harness.Window.PressKeyOnPlatformTabsForTesting(VkSpace);

        Assert.Equal(0, transport.PostCalls);
        Assert.Equal(0, transport.GetCalls);
        Assert.Empty(clipboard.Values);
        Assert.All(new[] { "x", "patreon", "bluesky" }, platform =>
            Assert.Equal(ManualPostingConfirmationStatus.Ready, controller.GetState(platform).Status));
    }

    [Fact]
    public async Task PlatformTabs_PaintTheThemedStripInDarkAndLightAndLeaveHighContrastToTheSystem()
    {
        using var controller = Controller(new RecordingTransport());
        await using NativeWindowHarness harness = await NativeWindowHarness.StartAsync(controller);
        NativePlatformTabsProbe before = harness.Window.CapturePlatformTabsForTesting();

        Assert.True(harness.Window.PaintPlatformTabsForTesting(NativeCompanionPalette.Dark));
        Assert.True(harness.Window.PaintPlatformTabsForTesting(NativeCompanionPalette.Light));
        Assert.False(harness.Window.PaintPlatformTabsForTesting(NativeCompanionPalette.HighContrast));
        Assert.True(harness.Window.PaintPlatformTabsForTesting(NativeCompanionPalette.Dark));

        NativePlatformTabsProbe after = harness.Window.CapturePlatformTabsForTesting();
        Assert.Equal(before.Handle, after.Handle);
        Assert.Equal("SysTabControl32", after.ClassName);
        Assert.Equal(before.Labels, after.Labels);
        Assert.Equal(before.SelectedIndex, after.SelectedIndex);
        // Every platform keeps a segment at least as wide as the shared minimum, so "X" is not a sliver.
        Assert.True(after.Bounds.Width >= after.Labels.Count * 88 * harness.Window.CaptureLayoutDpiForTesting() / 96);
    }

    [Theory]
    [InlineData(150)]
    [InlineData(200)]
    public async Task EnlargedWindowsTextKeepsTheNarrowTargetScrollableWithoutOverlap(int textScale)
    {
        var link = new ScriptedTransport();
        link.Gets.Enqueue(_ => Task.FromResult(ManualReleaseLinkTransportResult.Authoritative("https://old.test/a")));
        using var releaseLink = new ManualReleaseLinkController(link);
        using var controller = Controller(new RecordingTransport());
        await using NativeWindowHarness harness = await NativeWindowHarness.StartAsync(controller, releaseLink: releaseLink);
        await releaseLink.LoadAsync();
        harness.WaitForReleaseLinkStatus("Release link is up to date.");

        foreach (int platformIndex in new[] { 1, 0 })
        {
            NativeProductionLayoutProbe probe = harness.Window.ApplyTextScaleAndCaptureLayoutForTesting(
                textScale, platformIndex, 640, 600);
            Assert.Equal(textScale, harness.Window.TextScaleForTesting);
            Assert.True(probe.ScrollBarVisible);
            AssertScrolledChildrenStayAboveFooter(probe);
            bool patreon = probe.Platform == "patreon";
            NativeLayoutRect[] controls = new[]
                {
                    probe.Header, probe.HeaderMetadata, probe.PlatformHeading, probe.PlatformSelector,
                    patreon ? probe.TitleLabel : default, patreon ? probe.CopyTitle : default, // hidden for X
                    probe.BodyLabel, probe.CopyMain, probe.PostingStatus,
                    probe.PostingAction, probe.PostingHelper, probe.AssetsHeading, probe.AssetCount,
                    probe.DragGuidance, probe.AssetList,
                }
                .Where(rect => rect != default && rect.Width > 0 && rect.Height > 0).ToArray();
            for (int first = 0; first < controls.Length; first++)
                for (int second = first + 1; second < controls.Length; second++)
                    Assert.False(controls[first].Intersects(controls[second]), $"{controls[first]} overlaps {controls[second]}");
            Assert.True(probe.CopyMain.Height >= 36 * textScale / 100 - 1);
            Assert.True(probe.Close.Height >= 36 * textScale / 100 - 1);
            AssertWithin(probe.Close, probe.Footer);
            NativeProductionLayoutProbe end = harness.Window.ScrollContentToForTesting(int.MaxValue);
            Assert.True(end.AssetList.Bottom <= end.Viewport.Bottom);
            AssertScrolledChildrenStayAboveFooter(end);
        }
        harness.Window.ApplyTextScaleAndCaptureLayoutForTesting(100, 1, 980, 920);
    }

    [Fact]
    public async Task ProductionButtons_DarkLightDarkThemeSwitchPreservesEveryNativeHandleAndRole()
    {
        using var controller = Controller(new RecordingTransport());
        await using NativeWindowHarness harness = await NativeWindowHarness.StartAsync(controller);

        IReadOnlyList<IntPtr> dark = harness.Window.ApplyThemeAndCaptureButtonHandlesForTesting(
            NativeCompanionPalette.Dark);
        IReadOnlyList<IntPtr> light = harness.Window.ApplyThemeAndCaptureButtonHandlesForTesting(
            NativeCompanionPalette.Light);
        IReadOnlyList<IntPtr> darkAgain = harness.Window.ApplyThemeAndCaptureButtonHandlesForTesting(
            NativeCompanionPalette.Dark);

        Assert.Equal(dark, light);
        Assert.Equal(dark, darkAgain);
        Assert.Equal(
            [NativeCompanionButtonRole.Secondary, NativeCompanionButtonRole.Secondary,
             NativeCompanionButtonRole.Primary, NativeCompanionButtonRole.Secondary],
            dark.Select(button => harness.Window.ButtonRoleForTesting(button)!.Value));
        Assert.All(dark, button => Assert.Equal("Button", ClassName(button)));
    }

    [Fact]
    public async Task ProductionTypographyAndSurfaceRoles_ScaleAndSurviveDarkLightHighContrastDark()
    {
        using var controller = Controller(new RecordingTransport());
        await using NativeWindowHarness harness = await NativeWindowHarness.StartAsync(controller);

        NativeProductionThemeProbe dark = harness.Window.ApplyThemeAndCapturePresentationForTesting(
            NativeCompanionPalette.Dark, 96);
        NativeProductionThemeProbe light = harness.Window.ApplyThemeAndCapturePresentationForTesting(
            NativeCompanionPalette.Light, 144);
        NativeProductionThemeProbe highContrast = harness.Window.ApplyThemeAndCapturePresentationForTesting(
            NativeCompanionPalette.HighContrast, 192);
        NativeProductionThemeProbe darkAgain = harness.Window.ApplyThemeAndCapturePresentationForTesting(
            NativeCompanionPalette.Dark, 96);

        IntPtr[] Handles(NativeProductionThemeProbe probe) =>
        [
            probe.Window, probe.Platform, probe.AssetList, probe.AssetHeader,
            .. probe.Controls.Select(control => control.Handle),
        ];
        Assert.Equal(Handles(dark), Handles(light));
        Assert.Equal(Handles(dark), Handles(highContrast));
        Assert.Equal(Handles(dark), Handles(darkAgain));
        Assert.All(dark.Controls, control => Assert.Equal("Segoe UI", control.FontFamily));

        NativeProductionControlPresentationProbe release = dark.Controls.Single(control => control.Name == "release-title");
        NativeProductionControlPresentationProbe field = dark.Controls.Single(control => control.Name == "field-label");
        NativeProductionControlPresentationProbe metadata = dark.Controls.Single(control => control.Name == "release-metadata");
        NativeProductionControlPresentationProbe section = dark.Controls.Single(control => control.Name == "content-heading");
        NativeProductionControlPresentationProbe selected = dark.Controls.Single(control => control.Name == "selected-count");
        // Refined hierarchy: identity title, then section headings, then muted field labels and metadata.
        Assert.True(Math.Abs(release.FontHeight) > Math.Abs(section.FontHeight));
        Assert.True(Math.Abs(section.FontHeight) > Math.Abs(field.FontHeight));
        Assert.Equal(Math.Abs(metadata.FontHeight), Math.Abs(field.FontHeight));
        Assert.Equal(600, release.FontWeight);
        Assert.Equal(600, section.FontWeight);
        Assert.Equal(400, field.FontWeight);
        Assert.Equal(NativeCompanionPalette.Dark.Text, section.Text);
        Assert.Equal(NativeCompanionPalette.Dark.MutedText, field.Text);
        Assert.Equal(NativeCompanionPalette.Dark.MutedText, selected.Text);
        Assert.Equal(NativeCompanionPalette.Dark.MutedText, metadata.Text);

        foreach ((NativeProductionThemeProbe probe, int dpi) in new[]
                 { (dark, 96), (light, 144), (highContrast, 192), (darkAgain, 96) })
        {
            foreach (NativeProductionControlPresentationProbe control in probe.Controls)
            {
                NativeCompanionFontSpec expected = NativeCompanionTheme.FontSpec(control.FontRole);
                Assert.Equal(-(expected.LogicalPixelHeight * dpi / 96), control.FontHeight);
                Assert.Equal(expected.Weight, control.FontWeight);
            }
            Assert.Equal(probe.NestedStyle.Background, probe.AssetListBackground);
        }

        Assert.Equal(NativeCompanionPalette.Dark.Card, dark.WindowStyle.Background);
        Assert.Equal(NativeCompanionPalette.Dark.Surface, dark.SectionStyle.Background);
        Assert.Equal(NativeCompanionPalette.Dark.Page, dark.NestedStyle.Background);
        Assert.Equal(NativeCompanionPalette.Dark.Surface, dark.FooterStyle.Background);
        Assert.True(dark.SectionStyle.Decorative);
        Assert.True(light.SectionStyle.Decorative);
        Assert.False(highContrast.SectionStyle.Decorative);
        Assert.Equal(0, highContrast.SectionStyle.Radius);
        Assert.All(highContrast.Controls, control =>
            Assert.Contains(control.Text, new[]
            {
                NativeCompanionPalette.HighContrast.Text,
                NativeCompanionPalette.HighContrast.MutedText,
            }));
    }

    [Fact]
    public async Task OwnerDrawRouting_RequiresExactProductionTypeIdHandleAndParent()
    {
        using var controller = Controller(new RecordingTransport());
        await using NativeWindowHarness harness = await NativeWindowHarness.StartAsync(controller);
        harness.SelectPlatform(1);

        IntPtr window = harness.Window.WindowHandle;
        IntPtr platform = harness.Window.PlatformHandle;
        IntPtr copyTitle = GetDlgItem(window, NativeManualPublishingCompanion.NativeWindow.CopyTitleId);
        IntPtr copyMain = GetDlgItem(window, NativeManualPublishingCompanion.NativeWindow.CopyMainId);
        IntPtr posting = harness.Window.PostingActionHandle;
        IntPtr close = GetDlgItem(window, NativeManualPublishingCompanion.NativeWindow.CloseId);

        // The platform tabs are a standard (not owner-drawn) common control.
        Assert.Null(harness.Window.OwnerDrawTargetForTesting(3, NativeManualPublishingCompanion.NativeWindow.PlatformId, platform));
        Assert.Null(harness.Window.OwnerDrawTargetForTesting(4, NativeManualPublishingCompanion.NativeWindow.PlatformId, platform));
        Assert.Equal(NativeCompanionOwnerDrawTarget.PrimaryButton,
            harness.Window.OwnerDrawTargetForTesting(4, NativeManualPublishingCompanion.NativeWindow.PostingConfirmationId, posting));
        Assert.Equal(NativeCompanionOwnerDrawTarget.SecondaryButton,
            harness.Window.OwnerDrawTargetForTesting(4, NativeManualPublishingCompanion.NativeWindow.CopyTitleId, copyTitle));
        Assert.Equal(NativeCompanionOwnerDrawTarget.SecondaryButton,
            harness.Window.OwnerDrawTargetForTesting(4, NativeManualPublishingCompanion.NativeWindow.CopyMainId, copyMain));
        Assert.Equal(NativeCompanionOwnerDrawTarget.SecondaryButton,
            harness.Window.OwnerDrawTargetForTesting(4, NativeManualPublishingCompanion.NativeWindow.CloseId, close));

        Assert.Null(harness.Window.OwnerDrawTargetForTesting(
            4, NativeManualPublishingCompanion.NativeWindow.PostingConfirmationId, platform));
        Assert.Null(harness.Window.OwnerDrawTargetForTesting(
            4, NativeManualPublishingCompanion.NativeWindow.CopyTitleId, posting));
        Assert.Null(harness.Window.OwnerDrawTargetForTesting(
            4, NativeManualPublishingCompanion.NativeWindow.PostingConfirmationId, copyTitle));
        Assert.Null(harness.Window.OwnerDrawTargetForTesting(
            4, NativeManualPublishingCompanion.NativeWindow.CloseId, posting));
        Assert.Null(harness.Window.OwnerDrawTargetForTesting(4, 999, platform));
        Assert.Null(harness.Window.OwnerDrawTargetForTesting(
            1, NativeManualPublishingCompanion.NativeWindow.PostingConfirmationId, posting));
        Assert.Null(harness.Window.OwnerDrawTargetForTesting(
            3, NativeManualPublishingCompanion.NativeWindow.PlatformId, posting));
        Assert.Null(harness.Window.OwnerDrawTargetForTesting(
            3, NativeManualPublishingCompanion.NativeWindow.CopyMainId, platform));
        Assert.Null(harness.Window.OwnerDrawTargetForTesting(
            4, NativeManualPublishingCompanion.NativeWindow.CloseId, window));
        Assert.Null(harness.Window.OwnerDrawTargetForTesting(
            4, NativeManualPublishingCompanion.NativeWindow.CloseId, IntPtr.Zero));
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
        Assert.Equal(NativeCompanionButtonRole.Primary,
            harness.Window.ButtonRoleForTesting(harness.Window.PostingActionHandle));
        NativeProductionThemeProbe unknown = harness.Window.ApplyThemeAndCapturePresentationForTesting(
            NativeCompanionPalette.Dark, 96);
        Assert.Equal(NativeCompanionPalette.Dark.Danger,
            unknown.Controls.Single(control => control.Name == "posting-status").Text);

        SendMessage(harness.Window.PostingActionHandle, BmClick, IntPtr.Zero, IntPtr.Zero);
        Assert.Equal(ManualPostingConfirmationStatus.Confirming, controller.GetState("x").Status);
        Assert.False(IsWindowEnabled(harness.Window.PostingActionHandle));
        harness.DrainPresentationSignal();
        secondPost.SetResult(Authoritative("x", "posted", new DateTime(2030, 1, 2), 1, 3, false));
        harness.WaitForPresentation();

        Assert.Equal("Posted — confirmed by you", Text(harness.Window.PostingStatusHandle));
        Assert.False(IsWindowVisible(harness.Window.PostingActionHandle));
        NativeProductionThemeProbe posted = harness.Window.ApplyThemeAndCapturePresentationForTesting(
            NativeCompanionPalette.Dark, 96);
        Assert.Equal(NativeCompanionPalette.Dark.Success,
            posted.Controls.Single(control => control.Name == "posting-status").Text);
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

    // ------------------------------------------------------------------ WP4 platform tabs: per-platform state

    [Fact]
    public async Task PlatformTabs_PreserveAssetSelectionsPreparedTextAndPostingStatePerPlatform()
    {
        static ManualPreparedAsset Asset(long id) => new(
            new SocialRedeemAsset(id, "attachment", id, $"asset-{id}.png", ".png", "image/png",
                id * 100, $"release/asset-{id}.png", true, null),
            $@"C:\stage\asset-{id}.png", StagedMediaProvenance.HelperOwned);
        var session = new ManualSocialSession(
            new Uri("https://creatorcrate.test/"), 42, "Release title",
            [
                new ManualPreparedPlatform("x", "Release title", "X post\nline two", [Asset(1), Asset(2), Asset(3)]),
                new ManualPreparedPlatform("patreon", "Patreon title", "Patreon body", [Asset(11), Asset(12)]),
                new ManualPreparedPlatform("bluesky", "Release title", "Bluesky post", [Asset(21)]),
            ]);
        var model = new ManualPublishingCompanionModel(session);
        var held = new TaskCompletionSource<ManualPostingTransportResult>(TaskCreationOptions.RunContinuationsAsynchronously);
        var transport = new RecordingTransport { Post = (_, _) => held.Task };
        using var controller = Controller(transport);
        var clipboard = new RecordingClipboard();
        await using NativeWindowHarness harness = await NativeWindowHarness.StartAsync(
            controller, _ => clipboard, session: session);
        IntPtr list = harness.Window.AssetListHandleForTesting;

        // Narrow X to its second asset, then start an X confirmation that is still pending.
        NativeManualPublishingCompanion.NativeWindow.SetNativeSelection(list, new HashSet<int> { 1 }, 3);
        Assert.Equal([1], NativeManualPublishingCompanion.NativeWindow.SelectedOrdinals(list));
        SendMessage(harness.Window.PostingActionHandle, BmClick, IntPtr.Zero, IntPtr.Zero);
        Assert.Equal(ManualPostingConfirmationStatus.Confirming, controller.GetState("x").Status);

        harness.SelectPlatform(1);
        Assert.Equal([0, 1], NativeManualPublishingCompanion.NativeWindow.SelectedOrdinals(list));
        Assert.Equal("Ready for manual publishing — not marked as posted", Text(harness.Window.PostingStatusHandle));
        NativeManualPublishingCompanion.NativeWindow.SetNativeSelection(list, new HashSet<int> { 0 }, 2);
        SendMessage(GetDlgItem(harness.Window.WindowHandle, NativeManualPublishingCompanion.NativeWindow.CopyTitleId),
            BmClick, IntPtr.Zero, IntPtr.Zero);
        SendMessage(GetDlgItem(harness.Window.WindowHandle, NativeManualPublishingCompanion.NativeWindow.CopyMainId),
            BmClick, IntPtr.Zero, IntPtr.Zero);

        harness.SelectPlatform(2);
        Assert.Equal([0], NativeManualPublishingCompanion.NativeWindow.SelectedOrdinals(list));
        harness.SelectPlatform(0);
        Assert.Equal([1], NativeManualPublishingCompanion.NativeWindow.SelectedOrdinals(list));
        Assert.Equal("Marking as posted…", Text(harness.Window.PostingStatusHandle));
        SendMessage(GetDlgItem(harness.Window.WindowHandle, NativeManualPublishingCompanion.NativeWindow.CopyMainId),
            BmClick, IntPtr.Zero, IntPtr.Zero);
        harness.SelectPlatform(1);
        Assert.Equal([0], NativeManualPublishingCompanion.NativeWindow.SelectedOrdinals(list));

        // Copy reads the exact authoritative strings; Patreon title and body stay separate.
        Assert.Equal(["Patreon title", "Patreon body", "X post\nline two"], clipboard.Values);
        Assert.Equal(1, transport.PostCalls);

        // The late X result lands on X even though Patreon is the active tab.
        harness.DrainPresentationSignal();
        held.SetResult(Authoritative("x", "posted", new DateTime(2030, 1, 1), 1, 3, false));
        harness.WaitForPresentation();
        Assert.Equal("Ready for manual publishing — not marked as posted", Text(harness.Window.PostingStatusHandle));
        Assert.Equal(ManualPostingConfirmationStatus.Posted, controller.GetState("x").Status);
        Assert.Equal(ManualPostingConfirmationStatus.Ready, controller.GetState("patreon").Status);
        harness.SelectPlatform(0);
        Assert.Equal("Posted — confirmed by you", Text(harness.Window.PostingStatusHandle));
        Assert.Equal(1, transport.PostCalls);
    }

    // ------------------------------------------------------------------ WP4 release link editor

    [Theory]
    [InlineData("https://example.test/release/42", "Release link is up to date.")]
    [InlineData(null, "No Release link is set. Paste one and select Save link.")]
    public async Task ReleaseLink_StartsReadOnlyThenShowsTheServerValueOrAnEmptyInput(string? server, string status)
    {
        var get = new TaskCompletionSource<ManualReleaseLinkTransportResult>(TaskCreationOptions.RunContinuationsAsynchronously);
        var link = new ScriptedTransport();
        link.Gets.Enqueue(_ => get.Task);
        using var releaseLink = new ManualReleaseLinkController(link);
        using var controller = Controller(new RecordingTransport());
        await using NativeWindowHarness harness = await NativeWindowHarness.StartAsync(controller, releaseLink: releaseLink);

        NativeReleaseLinkProbe waiting = harness.WaitForReleaseLinkStatus("Waiting to load the Release link…");
        Assert.Equal("Release link", waiting.Label.Text);
        Assert.Equal("Edit", ClassName(waiting.Input.Handle));
        Assert.True(waiting.InputReadOnly);
        Assert.Equal(string.Empty, waiting.Input.Text);
        Assert.False(waiting.Save.Enabled);
        Assert.False(waiting.Reload.Visible || waiting.Discard.Visible || waiting.Keep.Visible);
        Assert.True(waiting.Label.Bounds.Y >= waiting.AssetsCard.Bottom, "The Release link follows Assets.");

        _ = releaseLink.LoadAsync();
        harness.WaitForReleaseLinkStatus("Loading the Release link…");
        get.SetResult(ManualReleaseLinkTransportResult.Authoritative(server));

        NativeReleaseLinkProbe ready = harness.WaitForReleaseLinkStatus(status);
        Assert.Equal(server ?? string.Empty, ready.Input.Text);
        Assert.False(ready.InputReadOnly);
        Assert.False(ready.Save.Enabled);
        Assert.Equal(ManualReleaseLinkTone.Neutral, ready.Tone);
        Assert.False(ready.Reload.Visible || ready.Discard.Visible || ready.Keep.Visible);
    }

    [Fact]
    public async Task ReleaseLink_DraftSurvivesTabsAndBusySave_AndExplicitSaveNeverTouchesPosting()
    {
        var link = new ScriptedTransport();
        link.Gets.Enqueue(_ => Task.FromResult(ManualReleaseLinkTransportResult.Authoritative("https://old.test/a")));
        var patch = new TaskCompletionSource<ManualReleaseLinkTransportResult>(TaskCreationOptions.RunContinuationsAsynchronously);
        link.Patches.Enqueue((_, _, _) => patch.Task);
        using var releaseLink = new ManualReleaseLinkController(link);
        var posting = new RecordingTransport();
        using var controller = Controller(posting);
        var clipboard = new RecordingClipboard();
        await using NativeWindowHarness harness = await NativeWindowHarness.StartAsync(
            controller, _ => clipboard, releaseLink: releaseLink);
        await releaseLink.LoadAsync();
        harness.WaitForReleaseLinkStatus("Release link is up to date.");

        harness.Window.SetReleaseLinkInputTextForTesting("  https://new.test/b  ");
        Assert.Equal("  https://new.test/b  ", releaseLink.State.Draft);
        Assert.True(releaseLink.State.IsDirty);
        NativeReleaseLinkProbe dirty = harness.WaitForReleaseLinkStatus(
            "Unsaved change: saving replaces the current Release link “https://old.test/a”.");
        Assert.True(dirty.Save.Enabled);
        Assert.True(dirty.Discard.Visible);
        Assert.Equal(ManualReleaseLinkPresentationMapper.DiscardEditsText, dirty.Discard.Text);

        foreach (int index in new[] { 1, 2, 0 })
        {
            harness.SelectPlatform(index);
            NativeReleaseLinkProbe afterSwitch = harness.Window.CaptureReleaseLinkForTesting();
            Assert.Equal("  https://new.test/b  ", afterSwitch.Input.Text);
            Assert.Equal(dirty.Status.Text, afterSwitch.Status.Text);
            Assert.True(afterSwitch.Save.Visible && afterSwitch.Save.Enabled);
        }
        Assert.Empty(link.PatchCalls);

        harness.Window.ClickReleaseLinkActionForTesting(NativeManualPublishingCompanion.NativeWindow.ReleaseLinkSaveId);
        NativeReleaseLinkProbe saving = harness.WaitForReleaseLinkStatus("Saving the Release link…");
        Assert.Equal("Saving…", saving.Save.Text);
        Assert.False(saving.Save.Enabled);
        harness.Window.ClickReleaseLinkActionForTesting(NativeManualPublishingCompanion.NativeWindow.ReleaseLinkSaveId);

        // Posting Helper work continues while the link request is pending.
        harness.SelectPlatform(1);
        SendMessage(GetDlgItem(harness.Window.WindowHandle, NativeManualPublishingCompanion.NativeWindow.CopyMainId),
            BmClick, IntPtr.Zero, IntPtr.Zero);
        Assert.Equal(["Patreon body"], clipboard.Values);
        Assert.Equal("Saving the Release link…", harness.Window.CaptureReleaseLinkForTesting().Status.Text);

        patch.SetResult(ManualReleaseLinkTransportResult.Authoritative("https://new.test/b", true));
        NativeReleaseLinkProbe saved = harness.WaitForReleaseLinkStatus("Release link saved.");
        Assert.Equal(ManualReleaseLinkTone.Success, saved.Tone);
        Assert.Equal("https://new.test/b", saved.Input.Text);
        Assert.False(saved.Save.Enabled);
        Assert.Equal([("https://new.test/b", "https://old.test/a")], link.PatchCalls);

        Assert.Equal(0, posting.PostCalls);
        Assert.Equal(0, posting.GetCalls);
        Assert.All(new[] { "x", "patreon", "bluesky" }, platform =>
            Assert.Equal(ManualPostingConfirmationStatus.Ready, controller.GetState(platform).Status));
        Assert.Equal("patreon", harness.Window.CapturePlatformTabsForTesting().ModelPlatform);
        Assert.Equal("Ready for manual publishing — not marked as posted", Text(harness.Window.PostingStatusHandle));
        Assert.NotEqual(IntPtr.Zero, harness.Window.WindowHandle);
    }

    [Fact]
    public async Task ReleaseLink_ClearingSendsNoLinkAndReportsCleared()
    {
        var link = new ScriptedTransport();
        link.Gets.Enqueue(_ => Task.FromResult(ManualReleaseLinkTransportResult.Authoritative("https://old.test/a")));
        link.Patches.Enqueue((_, _, _) => Task.FromResult(ManualReleaseLinkTransportResult.Authoritative(null, true)));
        using var releaseLink = new ManualReleaseLinkController(link);
        using var controller = Controller(new RecordingTransport());
        await using NativeWindowHarness harness = await NativeWindowHarness.StartAsync(controller, releaseLink: releaseLink);
        await releaseLink.LoadAsync();
        harness.WaitForReleaseLinkStatus("Release link is up to date.");

        harness.Window.SetReleaseLinkInputTextForTesting(string.Empty);
        NativeReleaseLinkProbe pending = harness.WaitForReleaseLinkStatus(
            "Unsaved change: saving clears the current Release link “https://old.test/a”.");
        Assert.True(pending.Save.Enabled);
        harness.Window.ClickReleaseLinkActionForTesting(NativeManualPublishingCompanion.NativeWindow.ReleaseLinkSaveId);

        NativeReleaseLinkProbe cleared = harness.WaitForReleaseLinkStatus("Release link cleared.");
        Assert.Equal(string.Empty, cleared.Input.Text);
        Assert.Equal([((string?)null, (string?)"https://old.test/a")], link.PatchCalls);
    }

    [Fact]
    public async Task ReleaseLink_InvalidFeedbackIsVisible_AndDiscardRestoresTheServerValueIntoTheInput()
    {
        var link = new ScriptedTransport();
        link.Gets.Enqueue(_ => Task.FromResult(ManualReleaseLinkTransportResult.Authoritative("https://old.test/a")));
        link.Patches.Enqueue((_, _, _) => Task.FromResult(ManualReleaseLinkTransportResult.Rejected("validation_failed")));
        using var releaseLink = new ManualReleaseLinkController(link);
        using var controller = Controller(new RecordingTransport());
        await using NativeWindowHarness harness = await NativeWindowHarness.StartAsync(controller, releaseLink: releaseLink);
        await releaseLink.LoadAsync();
        harness.WaitForReleaseLinkStatus("Release link is up to date.");

        harness.Window.SetReleaseLinkInputTextForTesting("not a url");
        harness.Window.ClickReleaseLinkActionForTesting(NativeManualPublishingCompanion.NativeWindow.ReleaseLinkSaveId);
        NativeReleaseLinkProbe invalid = harness.WaitForReleaseLinkStatus(ManualReleaseLinkController.InvalidMessage);
        Assert.Equal(ManualReleaseLinkTone.Error, invalid.Tone);
        Assert.Equal("not a url", invalid.Input.Text);
        Assert.False(invalid.InputReadOnly);
        Assert.True(invalid.Discard.Visible);
        Assert.True(invalid.Status.Visible && invalid.Status.Bounds.Height > 0);
        NativeProductionThemeProbe _ = harness.Window.ApplyThemeAndCapturePresentationForTesting(NativeCompanionPalette.Dark, 96);

        harness.Window.ClickReleaseLinkActionForTesting(NativeManualPublishingCompanion.NativeWindow.ReleaseLinkDiscardId);
        NativeReleaseLinkProbe restored = harness.WaitForReleaseLinkStatus("Release link is up to date.");
        Assert.Equal("https://old.test/a", restored.Input.Text);
        Assert.False(restored.Discard.Visible);
        Assert.Equal(restored.Input.Handle, restored.Focus);
        Assert.Single(link.PatchCalls);
    }

    [Fact]
    public async Task ReleaseLink_ConflictExplainsChoices_AndKeepingRequiresASecondExplicitSaveAgainstTheNewerValue()
    {
        var link = new ScriptedTransport();
        link.Gets.Enqueue(_ => Task.FromResult(ManualReleaseLinkTransportResult.Authoritative("https://old.test/a")));
        link.Patches.Enqueue((_, _, _) => Task.FromResult(
            ManualReleaseLinkTransportResult.Rejected("release_link_conflict", "https://theirs.test/c")));
        link.Patches.Enqueue((value, _, _) => Task.FromResult(ManualReleaseLinkTransportResult.Authoritative(value, true)));
        using var releaseLink = new ManualReleaseLinkController(link);
        using var controller = Controller(new RecordingTransport());
        await using NativeWindowHarness harness = await NativeWindowHarness.StartAsync(controller, releaseLink: releaseLink);
        await releaseLink.LoadAsync();
        harness.WaitForReleaseLinkStatus("Release link is up to date.");

        harness.Window.SetReleaseLinkInputTextForTesting("https://mine.test/b");
        harness.Window.ClickReleaseLinkActionForTesting(NativeManualPublishingCompanion.NativeWindow.ReleaseLinkSaveId);
        NativeReleaseLinkProbe conflict = harness.WaitForReleaseLink(probe => probe.Keep.Visible);
        Assert.Contains("changed elsewhere to “https://theirs.test/c”", conflict.Status.Text);
        Assert.Contains("saving it then replaces the newer link", conflict.Status.Text);
        Assert.Equal(ManualReleaseLinkTone.Warning, conflict.Tone);
        Assert.Equal("https://mine.test/b", conflict.Input.Text);
        Assert.False(conflict.Save.Enabled);
        Assert.False(conflict.Reload.Visible);
        Assert.True(conflict.Discard.Visible);
        Assert.Equal(ManualReleaseLinkPresentationMapper.UseServerLinkText, conflict.Discard.Text);
        Assert.Equal("Keep my link", conflict.Keep.Text);
        Assert.False(conflict.Keep.Bounds.Intersects(conflict.Discard.Bounds));
        Assert.False(conflict.Input.Bounds.Intersects(conflict.Save.Bounds));
        Assert.True(conflict.Status.Bounds.Y >= conflict.AssetsCard.Bottom);

        harness.Window.ClickReleaseLinkActionForTesting(NativeManualPublishingCompanion.NativeWindow.ReleaseLinkKeepId);
        NativeReleaseLinkProbe kept = harness.WaitForReleaseLinkStatus(
            "Unsaved change: saving replaces the current Release link “https://theirs.test/c”.");
        Assert.False(kept.Keep.Visible);
        Assert.True(kept.Save.Enabled);
        Assert.Equal(kept.Input.Handle, kept.Focus);
        Assert.Single(link.PatchCalls);

        harness.Window.ClickReleaseLinkActionForTesting(NativeManualPublishingCompanion.NativeWindow.ReleaseLinkSaveId);
        harness.WaitForReleaseLinkStatus("Release link saved.");
        Assert.Equal(
            [("https://mine.test/b", "https://old.test/a"), ("https://mine.test/b", "https://theirs.test/c")],
            link.PatchCalls);
    }

    [Fact]
    public async Task ReleaseLink_ConflictUseServerLinkReplacesTheDraftWithoutSaving()
    {
        var link = new ScriptedTransport();
        link.Gets.Enqueue(_ => Task.FromResult(ManualReleaseLinkTransportResult.Authoritative("https://old.test/a")));
        link.Patches.Enqueue((_, _, _) => Task.FromResult(
            ManualReleaseLinkTransportResult.Rejected("release_link_conflict", "https://theirs.test/c")));
        using var releaseLink = new ManualReleaseLinkController(link);
        using var controller = Controller(new RecordingTransport());
        await using NativeWindowHarness harness = await NativeWindowHarness.StartAsync(controller, releaseLink: releaseLink);
        await releaseLink.LoadAsync();
        harness.WaitForReleaseLinkStatus("Release link is up to date.");
        harness.Window.SetReleaseLinkInputTextForTesting("https://mine.test/b");
        harness.Window.ClickReleaseLinkActionForTesting(NativeManualPublishingCompanion.NativeWindow.ReleaseLinkSaveId);
        harness.WaitForReleaseLink(probe => probe.Keep.Visible);

        harness.Window.ClickReleaseLinkActionForTesting(NativeManualPublishingCompanion.NativeWindow.ReleaseLinkDiscardId);
        NativeReleaseLinkProbe server = harness.WaitForReleaseLinkStatus("Release link is up to date.");
        Assert.Equal("https://theirs.test/c", server.Input.Text);
        Assert.False(server.Keep.Visible || server.Discard.Visible || server.Save.Enabled);
        Assert.Single(link.PatchCalls);
    }

    [Fact]
    public async Task ReleaseLink_UncertainSaveOffersReloadOnly_AndReloadReconcilesTheCommittedValue()
    {
        var link = new ScriptedTransport();
        link.Gets.Enqueue(_ => Task.FromResult(ManualReleaseLinkTransportResult.Authoritative("https://old.test/a")));
        link.Patches.Enqueue((_, _, _) => Task.FromResult(ManualReleaseLinkTransportResult.Ambiguous()));
        link.Gets.Enqueue(_ => Task.FromResult(ManualReleaseLinkTransportResult.Ambiguous()));
        link.Gets.Enqueue(_ => Task.FromResult(ManualReleaseLinkTransportResult.Authoritative("https://new.test/b")));
        using var releaseLink = new ManualReleaseLinkController(link);
        using var controller = Controller(new RecordingTransport());
        await using NativeWindowHarness harness = await NativeWindowHarness.StartAsync(controller, releaseLink: releaseLink);
        await releaseLink.LoadAsync();
        harness.WaitForReleaseLinkStatus("Release link is up to date.");

        harness.Window.SetReleaseLinkInputTextForTesting("https://new.test/b");
        harness.Window.ClickReleaseLinkActionForTesting(NativeManualPublishingCompanion.NativeWindow.ReleaseLinkSaveId);
        NativeReleaseLinkProbe uncertain = harness.WaitForReleaseLinkStatus(ManualReleaseLinkController.UncertainMessage);
        Assert.Equal(ManualReleaseLinkTone.Warning, uncertain.Tone);
        Assert.True(uncertain.Reload.Visible && uncertain.Reload.Enabled);
        Assert.False(uncertain.Discard.Visible);
        Assert.False(uncertain.Keep.Visible);
        Assert.NotEqual("Release link saved.", uncertain.Status.Text);

        harness.Window.ClickReleaseLinkActionForTesting(NativeManualPublishingCompanion.NativeWindow.ReleaseLinkReloadId);
        NativeReleaseLinkProbe reconciled = harness.WaitForReleaseLinkStatus("Release link saved.");
        Assert.False(reconciled.Reload.Visible);
        Assert.Single(link.PatchCalls);
    }

    [Theory]
    [InlineData("unsupported", ManualReleaseLinkController.UnsupportedMessage, (int)ManualReleaseLinkTone.Neutral)]
    [InlineData("release_link_token_expired", ManualReleaseLinkController.ExpiredMessage, (int)ManualReleaseLinkTone.Error)]
    [InlineData("attempt_superseded", ManualReleaseLinkController.AuthorityMessage, (int)ManualReleaseLinkTone.Error)]
    public async Task ReleaseLink_UnavailableAuthorityOrOlderServerLeavesEveryPostingInteractionUsable(
        string outcome, string message, int tone)
    {
        var link = new ScriptedTransport();
        link.Gets.Enqueue(_ => Task.FromResult(outcome == "unsupported"
            ? ManualReleaseLinkTransportResult.Unsupported()
            : ManualReleaseLinkTransportResult.Rejected(outcome)));
        using var releaseLink = new ManualReleaseLinkController(link);
        var held = new TaskCompletionSource<ManualPostingTransportResult>(TaskCreationOptions.RunContinuationsAsynchronously);
        var posting = new RecordingTransport { Post = (_, _) => held.Task };
        using var controller = Controller(posting);
        var clipboard = new RecordingClipboard();
        await using NativeWindowHarness harness = await NativeWindowHarness.StartAsync(
            controller, _ => clipboard, releaseLink: releaseLink);
        await releaseLink.LoadAsync();

        NativeReleaseLinkProbe unavailable = harness.WaitForReleaseLinkStatus(message);
        Assert.Equal((ManualReleaseLinkTone)tone, unavailable.Tone);
        Assert.True(unavailable.InputReadOnly);
        Assert.False(unavailable.Save.Enabled);
        Assert.False(unavailable.Reload.Visible || unavailable.Discard.Visible || unavailable.Keep.Visible);

        harness.SelectPlatform(2);
        SendMessage(GetDlgItem(harness.Window.WindowHandle, NativeManualPublishingCompanion.NativeWindow.CopyMainId),
            BmClick, IntPtr.Zero, IntPtr.Zero);
        Assert.Equal(["Bluesky post"], clipboard.Values);
        SendMessage(harness.Window.PostingActionHandle, BmClick, IntPtr.Zero, IntPtr.Zero);
        Assert.Equal(ManualPostingConfirmationStatus.Confirming, controller.GetState("bluesky").Status);
        harness.DrainPresentationSignal();
        held.SetResult(Authoritative("bluesky", "posted", new DateTime(2030, 1, 1), 1, 3, false));
        harness.WaitForPresentation();
        Assert.Equal("Posted — confirmed by you", Text(harness.Window.PostingStatusHandle));
        Assert.Empty(link.PatchCalls);
    }

    [Fact]
    public async Task ReleaseLink_LoadFailureOffersRetryThatLoadsTheServerValue()
    {
        var link = new ScriptedTransport();
        link.Gets.Enqueue(_ => Task.FromResult(ManualReleaseLinkTransportResult.Ambiguous()));
        link.Gets.Enqueue(_ => Task.FromResult(ManualReleaseLinkTransportResult.Authoritative("https://ok.test/a")));
        using var releaseLink = new ManualReleaseLinkController(link);
        using var controller = Controller(new RecordingTransport());
        await using NativeWindowHarness harness = await NativeWindowHarness.StartAsync(controller, releaseLink: releaseLink);
        await releaseLink.LoadAsync();

        NativeReleaseLinkProbe failed = harness.WaitForReleaseLinkStatus(ManualReleaseLinkController.LoadFailedMessage);
        Assert.Equal(ManualReleaseLinkTone.Error, failed.Tone);
        Assert.True(failed.InputReadOnly);
        Assert.True(failed.Reload.Visible);
        Assert.False(failed.Save.Enabled);

        harness.Window.ClickReleaseLinkActionForTesting(NativeManualPublishingCompanion.NativeWindow.ReleaseLinkReloadId);
        NativeReleaseLinkProbe loaded = harness.WaitForReleaseLinkStatus("Release link is up to date.");
        Assert.Equal("https://ok.test/a", loaded.Input.Text);
        Assert.False(loaded.Reload.Visible);
    }

    [Fact]
    public async Task ReleaseLink_EnterInTheInputNeitherSavesNorConfirms_AndTabOrderFollowsTheVisualOrder()
    {
        var link = new ScriptedTransport();
        link.Gets.Enqueue(_ => Task.FromResult(ManualReleaseLinkTransportResult.Authoritative(null)));
        using var releaseLink = new ManualReleaseLinkController(link);
        var posting = new RecordingTransport();
        using var controller = Controller(posting);
        await using NativeWindowHarness harness = await NativeWindowHarness.StartAsync(controller, releaseLink: releaseLink);
        await releaseLink.LoadAsync();
        harness.WaitForReleaseLinkStatus("No Release link is set. Paste one and select Save link.");

        // Not dirty: Save is disabled and skipped, so Tab reaches the footer's Close button; Shift+Tab
        // returns to the asset list that precedes the Release link.
        Assert.Equal([NativeManualPublishingCompanion.NativeWindow.CloseId],
            harness.Window.TraverseFocusFromReleaseLinkInputForTesting(1, previous: false));
        Assert.Equal([NativeManualPublishingCompanion.NativeWindow.AssetListId],
            harness.Window.TraverseFocusFromReleaseLinkInputForTesting(1, previous: true));

        harness.Window.SetReleaseLinkInputTextForTesting("https://typed.test/x");
        harness.WaitForReleaseLink(probe => probe.Save.Enabled);
        Assert.Equal(
            [NativeManualPublishingCompanion.NativeWindow.ReleaseLinkSaveId,
             NativeManualPublishingCompanion.NativeWindow.ReleaseLinkDiscardId,
             NativeManualPublishingCompanion.NativeWindow.CloseId],
            harness.Window.TraverseFocusFromReleaseLinkInputForTesting(3, previous: false));

        string postingStatus = Text(harness.Window.PostingStatusHandle);
        harness.Window.PressEnterInReleaseLinkInputForTesting();
        harness.Window.PressEnterInReleaseLinkInputForTesting();
        Assert.Equal("https://typed.test/x", harness.Window.CaptureReleaseLinkForTesting().Input.Text);
        Assert.Empty(link.PatchCalls);
        Assert.Equal(0, posting.PostCalls);
        Assert.Equal(postingStatus, Text(harness.Window.PostingStatusHandle));
        Assert.Equal(ManualPostingConfirmationStatus.Ready, controller.GetState("x").Status);
    }

    [Fact]
    public async Task ReleaseLink_WorkerNotificationsArePostedAndCoalescedWhileTheUiThreadIsBlocked()
    {
        var link = new ScriptedTransport();
        link.Gets.Enqueue(_ => Task.FromResult(ManualReleaseLinkTransportResult.Authoritative("https://old.test/a")));
        var releaseLink = new ManualReleaseLinkController(link);
        using var controller = Controller(new RecordingTransport());
        await using NativeWindowHarness harness = await NativeWindowHarness.StartAsync(controller, releaseLink: releaseLink);
        await releaseLink.LoadAsync();
        harness.WaitForReleaseLinkStatus("Release link is up to date.");

        using var entered = new ManualResetEventSlim();
        using var release = new ManualResetEventSlim();
        Task blocked = Task.Run(() => harness.Window.BlockUiThreadForTesting(entered, release));
        Assert.True(entered.Wait(TimeSpan.FromSeconds(5)));
        int before = harness.ReleaseLinkPresentations;

        // Each SetDraft raises StateChanged on this worker thread; none may wait for the blocked UI thread.
        Task burst = Task.Run(() =>
        {
            for (int index = 0; index < 20; index++) releaseLink.SetDraft($"https://worker.test/{index}");
        });
        Assert.True(await CompletesWithinAsync(burst, TimeSpan.FromSeconds(2)), "StateChanged waited for the blocked UI thread.");
        Assert.Equal(before, harness.ReleaseLinkPresentations);

        // Disposal waits only for subscribers already running elsewhere; ours never blocks, so this returns.
        Assert.True(await CompletesWithinAsync(Task.Run(releaseLink.Dispose), TimeSpan.FromSeconds(2)), "Controller disposal deadlocked.");

        release.Set();
        await blocked.WaitAsync(TimeSpan.FromSeconds(5));
        NativeReleaseLinkProbe rendered = harness.WaitForReleaseLink(probe => probe.Input.Text == "https://worker.test/19");
        await Task.Delay(200);
        Assert.Equal(before + 1, harness.ReleaseLinkPresentations);
        Assert.Equal("https://worker.test/19", rendered.Input.Text);
    }

    [Theory]
    [InlineData("save")]
    [InlineData("load")]
    public async Task ReleaseLink_ClosingDuringAPendingRequestDoesNotDeadlockOrUpdateDestroyedControls(string pending)
    {
        var started = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var held = new TaskCompletionSource<ManualReleaseLinkTransportResult>(TaskCreationOptions.RunContinuationsAsynchronously);
        var link = new ScriptedTransport();
        if (pending == "load")
            link.Gets.Enqueue(_ => { started.TrySetResult(); return held.Task; });
        else
        {
            link.Gets.Enqueue(_ => Task.FromResult(ManualReleaseLinkTransportResult.Authoritative("https://old.test/a")));
            link.Patches.Enqueue((_, _, _) => { started.TrySetResult(); return held.Task; });
        }
        var releaseLink = new ManualReleaseLinkController(link);
        using var controller = Controller(new RecordingTransport());
        try
        {
            await using NativeWindowHarness harness = await NativeWindowHarness.StartAsync(controller, releaseLink: releaseLink);
            Task<ManualReleaseLinkState> load = releaseLink.LoadAsync();
            if (pending == "save")
            {
                await load;
                harness.WaitForReleaseLinkStatus("Release link is up to date.");
                harness.Window.SetReleaseLinkInputTextForTesting("https://new.test/b");
                harness.Window.ClickReleaseLinkActionForTesting(NativeManualPublishingCompanion.NativeWindow.ReleaseLinkSaveId);
            }
            await started.Task.WaitAsync(TimeSpan.FromSeconds(5));
            harness.WaitForReleaseLink(probe => probe.Status.Text.EndsWith("the Release link…", StringComparison.Ordinal));

            harness.Window.RequestClose();
            await harness.WaitForCloseAsync();
            int presentations = harness.ReleaseLinkPresentations;

            // The late result still notifies (the controller is not disposed yet) but nothing reaches the window.
            held.SetResult(ManualReleaseLinkTransportResult.Authoritative("https://new.test/b", true));
            await WaitUntilAsync(() => !releaseLink.State.IsBusy);
            releaseLink.SetDraft("https://after-close.test/");
            Assert.True(await CompletesWithinAsync(Task.Run(releaseLink.Dispose), TimeSpan.FromSeconds(5)), "Controller disposal deadlocked.");
            await Task.Delay(100);

            Assert.Equal(presentations, harness.ReleaseLinkPresentations);
            Assert.Equal(IntPtr.Zero, harness.Window.WindowHandle);
        }
        finally { releaseLink.Dispose(); }
    }

    [Fact]
    public async Task ReleaseLink_SectionFollowsAssetsAsTheLastCardWithoutOverlapAtNormalAndMinimumSizes()
    {
        var link = new ScriptedTransport();
        link.Gets.Enqueue(_ => Task.FromResult(ManualReleaseLinkTransportResult.Authoritative("https://old.test/a")));
        link.Patches.Enqueue((_, _, _) => Task.FromResult(
            ManualReleaseLinkTransportResult.Rejected("release_link_conflict", "https://theirs.test/" + new string('c', 120))));
        using var releaseLink = new ManualReleaseLinkController(link);
        using var controller = Controller(new RecordingTransport());
        await using NativeWindowHarness harness = await NativeWindowHarness.StartAsync(controller, releaseLink: releaseLink);
        await releaseLink.LoadAsync();
        harness.WaitForReleaseLinkStatus("Release link is up to date.");
        harness.Window.SetReleaseLinkInputTextForTesting("https://mine.test/b");
        harness.Window.ClickReleaseLinkActionForTesting(NativeManualPublishingCompanion.NativeWindow.ReleaseLinkSaveId);
        harness.WaitForReleaseLink(probe => probe.Keep.Visible);

        foreach ((int width, int height) in new[] { (980, 920), (640, 600), (1600, 920) })
        {
            harness.Window.ResizeAndCaptureLayoutForTesting(1, width, height);
            // The section is the last card, so the end of the scroll range reveals all of it.
            NativeProductionLayoutProbe layout = harness.Window.ScrollContentByBarForTesting(7); // SB_BOTTOM
            NativeReleaseLinkProbe section = harness.Window.CaptureReleaseLinkForTesting();
            NativeReleaseLinkControlProbe[] visible = new[]
                { section.Label, section.Input, section.Save, section.Reload, section.Discard, section.Keep, section.Status }
                .Where(control => control.Visible).ToArray();
            Assert.Equal(6, visible.Length);
            Assert.Equal(ManualReleaseLinkTone.Warning, section.Tone);
            foreach (NativeReleaseLinkControlProbe control in visible)
            {
                AssertWithinClient(control.Bounds, layout.Client);
                AssertWithin(control.Bounds, section.Card);
                Assert.True(control.Bounds.Y >= layout.AssetsCard.Bottom);
                Assert.True(control.Bounds.Bottom <= layout.Viewport.Bottom, "The Release link stays above the pinned footer.");
                foreach (NativeReleaseLinkControlProbe other in visible)
                    if (other.Handle != control.Handle) Assert.False(control.Bounds.Intersects(other.Bounds));
            }
            // The integrated section: the borderless edit sits inside its painted field, and the
            // wrapped conflict message shares the tinted feedback row with both recovery actions.
            AssertWithin(section.Input.Bounds, section.Field);
            AssertWithin(section.Status.Bounds, section.Feedback);
            AssertWithin(section.Discard.Bounds, section.Feedback);
            AssertWithin(section.Keep.Bounds, section.Feedback);
            Assert.True(section.Status.Bounds.Height > 20 * layout.Dpi / 96, "The long conflict message wraps.");
            Assert.Equal(ManualReleaseLinkPresentationMapper.UseServerLinkText, section.Discard.Text);
            Assert.True(layout.AssetsCard.Bottom + 12 * layout.Dpi / 96 <= section.Card.Y);
            Assert.True(layout.PlatformCard.Bottom <= layout.AssetsCard.Y);
            Assert.Equal(section.Card.Bottom + 16 * layout.Dpi / 96, layout.ContentHeight - layout.ScrollOffset);
            AssertScrolledChildrenStayAboveFooter(layout);
            AssertWithin(layout.PlatformSelector, layout.PlatformCard);
            AssertWithin(layout.PostingAction, layout.PlatformCard);
            AssertWithin(layout.AssetList, layout.AssetsCard);
            AssertWithin(layout.Close, layout.Footer);
            Assert.True(layout.AssetList.Height > 0);
        }
        NativeReleaseLinkProbe announced = harness.Window.CaptureReleaseLinkForTesting();
        Assert.True(announced.LiveRegionConfigured);
        Assert.Equal(1, announced.Announcements);
        Assert.Contains("changed elsewhere", announced.LastAnnouncement);
    }

    [Fact]
    public async Task ReleaseLink_AnnouncesOnlyRequestOutcomesThroughItsLiveRegion()
    {
        var link = new ScriptedTransport();
        link.Gets.Enqueue(_ => Task.FromResult(ManualReleaseLinkTransportResult.Authoritative("https://old.test/a")));
        link.Patches.Enqueue((_, _, _) => Task.FromResult(ManualReleaseLinkTransportResult.Authoritative("https://new.test/b", changed: true)));
        using var releaseLink = new ManualReleaseLinkController(link);
        using var controller = Controller(new RecordingTransport());
        await using NativeWindowHarness harness = await NativeWindowHarness.StartAsync(controller, releaseLink: releaseLink);
        await releaseLink.LoadAsync();
        NativeReleaseLinkProbe ready = harness.WaitForReleaseLinkStatus("Release link is up to date.");
        Assert.True(ready.LiveRegionConfigured);
        Assert.Equal(0, ready.Announcements);

        harness.Window.SetReleaseLinkInputTextForTesting("https://new.test/b");
        NativeReleaseLinkProbe unsaved = harness.WaitForReleaseLink(probe => probe.Tone == ManualReleaseLinkTone.Unsaved);
        Assert.Equal(0, unsaved.Announcements);
        harness.Window.ClickReleaseLinkActionForTesting(NativeManualPublishingCompanion.NativeWindow.ReleaseLinkSaveId);
        NativeReleaseLinkProbe saved = harness.WaitForReleaseLink(probe => probe.Tone == ManualReleaseLinkTone.Success);
        Assert.Equal(1, saved.Announcements);
        Assert.Equal("Release link saved.", saved.LastAnnouncement);
        harness.Window.ResizeAndCaptureLayoutForTesting(1, 640, 600);
        Assert.Equal(1, harness.Window.CaptureReleaseLinkForTesting().Announcements);

        Assert.True(ManualReleaseLinkPresentationMapper.ShouldAnnounce(null,
            new("Release link wasn't saved. Try again.", ManualReleaseLinkTone.Error, false, "Save link", true, true, false, "", false)));
        var busy = new ManualReleaseLinkPresentation("Saving the Release link…", ManualReleaseLinkTone.Busy,
            true, "Saving…", false, false, false, "", false);
        Assert.False(ManualReleaseLinkPresentationMapper.ShouldAnnounce(null, busy));
        var conflict = new ManualReleaseLinkPresentation("changed elsewhere", ManualReleaseLinkTone.Warning,
            false, "Save link", false, false, true, "Use server link", true);
        Assert.True(ManualReleaseLinkPresentationMapper.ShouldAnnounce(busy, conflict));
        Assert.False(ManualReleaseLinkPresentationMapper.ShouldAnnounce(conflict, conflict with { SaveEnabled = true }));
    }

    [Fact]
    public void ReleaseLinkPresentation_MapsEveryControllerPhaseWithoutAddingDecisions()
    {
        static ManualReleaseLinkState State(ManualReleaseLinkPhase phase, bool loaded = true, string? server = "https://a.test/",
            string draft = "https://a.test/", string? message = null, string? code = null, bool? changed = null) =>
            new(phase, loaded, server, draft,
                loaded && ManualReleaseLinkController.Proposed(draft) != ManualReleaseLinkController.Proposed(server),
                message, code, changed, 1);

        ManualReleaseLinkPresentation notLoaded = ManualReleaseLinkPresentationMapper.Map(
            State(ManualReleaseLinkPhase.NotLoaded, loaded: false, server: null, draft: ""));
        Assert.True(notLoaded.InputReadOnly);
        Assert.False(notLoaded.SaveEnabled);

        ManualReleaseLinkPresentation reloading = ManualReleaseLinkPresentationMapper.Map(State(ManualReleaseLinkPhase.Loading));
        Assert.Equal("Reloading the Release link…", reloading.StatusText);
        Assert.False(reloading.SaveEnabled);

        Assert.Equal("Release link was already up to date.",
            ManualReleaseLinkPresentationMapper.Map(State(ManualReleaseLinkPhase.Saved, changed: false)).StatusText);

        ManualReleaseLinkPresentation saving = ManualReleaseLinkPresentationMapper.Map(
            State(ManualReleaseLinkPhase.Saving, draft: "https://b.test/"));
        Assert.Equal("Saving…", saving.SaveText);
        Assert.False(saving.SaveEnabled);
        Assert.False(saving.ShowDiscard);

        ManualReleaseLinkPresentation failedSave = ManualReleaseLinkPresentationMapper.Map(State(
            ManualReleaseLinkPhase.Failed, draft: "https://b.test/", message: ManualReleaseLinkController.SaveFailedMessage,
            code: "release_link_unavailable"));
        Assert.Equal(ManualReleaseLinkController.SaveFailedMessage, failedSave.StatusText);
        Assert.True(failedSave.SaveEnabled);
        Assert.True(failedSave.ShowReload);
        Assert.True(failedSave.ShowDiscard);
        Assert.Equal(ManualReleaseLinkTone.Error, failedSave.Tone);

        ManualReleaseLinkPresentation notEditable = ManualReleaseLinkPresentationMapper.Map(State(
            ManualReleaseLinkPhase.Unavailable, message: ManualReleaseLinkController.NotEditableMessage,
            code: "release_not_editable"));
        Assert.True(notEditable.InputReadOnly);
        Assert.False(notEditable.SaveEnabled || notEditable.ShowReload || notEditable.ShowDiscard || notEditable.ShowKeep);
        Assert.Equal(ManualReleaseLinkController.NotEditableMessage, notEditable.StatusText);

        string longLink = "https://long.test/" + new string('x', 200);
        ManualReleaseLinkPresentation conflict = ManualReleaseLinkPresentationMapper.Map(State(
            ManualReleaseLinkPhase.Conflict, server: longLink, draft: "https://mine.test/",
            message: ManualReleaseLinkController.ConflictMessage, code: "release_link_conflict"));
        Assert.True(conflict.ShowKeep);
        Assert.False(conflict.SaveEnabled);
        Assert.DoesNotContain(longLink, conflict.StatusText);
        Assert.Contains("…”", conflict.StatusText);
    }

    private static async Task<bool> CompletesWithinAsync(Task task, TimeSpan timeout) =>
        await Task.WhenAny(task, Task.Delay(timeout)) == task;

    private static async Task WaitUntilAsync(Func<bool> condition)
    {
        DateTime deadline = DateTime.UtcNow + TimeSpan.FromSeconds(5);
        while (!condition())
        {
            if (DateTime.UtcNow > deadline) throw new TimeoutException("Condition was not reached.");
            await Task.Delay(10);
        }
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

        private readonly AutoResetEvent _releaseLinkPresentation = new(false);
        private int _releaseLinkPresentations;

        private NativeWindowHarness(
            ManualPostingConfirmationController controller,
            Func<IntPtr, IUnicodeClipboard>? clipboardFactory,
            ManualSocialSession? session,
            ManualReleaseLinkController? releaseLink)
        {
            var lifecycle = new ManualCompanionLifecycle();
            Window = new NativeManualPublishingCompanion.NativeWindow(
                new ManualPublishingCompanionModel(session ?? Session()), RejectingAvailability.Instance, lifecycle,
                confirmation: controller, clipboardFactory: clipboardFactory,
                disableWinUiForNativeOnlyTests: true, releaseLink: releaseLink);
            Window.PostingPresentationChanged += () => _presentation.Set();
            Window.ReleaseLinkPresentationChanged += () =>
            {
                Interlocked.Increment(ref _releaseLinkPresentations);
                _releaseLinkPresentation.Set();
            };
            _thread = new Thread(() => Run(lifecycle)) { IsBackground = true, Name = "Native confirmation test" };
            _thread.SetApartmentState(ApartmentState.STA);
            Lifecycle = lifecycle;
        }

        public NativeManualPublishingCompanion.NativeWindow Window { get; }
        private ManualCompanionLifecycle Lifecycle { get; }

        public int ReleaseLinkPresentations => Volatile.Read(ref _releaseLinkPresentations);

        public static async Task<NativeWindowHarness> StartAsync(
            ManualPostingConfirmationController controller,
            Func<IntPtr, IUnicodeClipboard>? clipboardFactory = null,
            ManualSocialSession? session = null,
            ManualReleaseLinkController? releaseLink = null)
        {
            var harness = new NativeWindowHarness(controller, clipboardFactory, session, releaseLink);
            harness._thread.Start();
            await harness.Lifecycle.Ready.WaitAsync(TimeSpan.FromSeconds(5));
            return harness;
        }

        // TCM_SETCURFOCUS on a non-button tab control selects and raises the real TCN_SELCHANGE.
        public void SelectPlatform(int index)
        {
            SendMessage(Window.PlatformHandle, TcmSetCurFocus, new IntPtr(index), IntPtr.Zero);
            Assert.Equal(index, SendMessage(Window.PlatformHandle, TcmGetCurSel, IntPtr.Zero, IntPtr.Zero).ToInt32());
        }

        public NativeProductionLayoutProbe CaptureMinimumLayout(int index) =>
            Window.ResizeToMinimumAndCaptureLayoutForTesting(index);

        // Release-link refreshes are posted asynchronously, so tests wait for the rendered state.
        public NativeReleaseLinkProbe WaitForReleaseLink(Func<NativeReleaseLinkProbe, bool> condition)
        {
            DateTime deadline = DateTime.UtcNow + TimeSpan.FromSeconds(5);
            while (true)
            {
                NativeReleaseLinkProbe probe = Window.CaptureReleaseLinkForTesting();
                if (condition(probe)) return probe;
                if (DateTime.UtcNow > deadline)
                    throw new TimeoutException($"Release link UI did not reach the expected state; status='{probe.Status.Text}', input='{probe.Input.Text}'.");
                _releaseLinkPresentation.WaitOne(25);
            }
        }

        public NativeReleaseLinkProbe WaitForReleaseLinkStatus(string status) =>
            WaitForReleaseLink(probe => probe.Status.Text == status);

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
            _releaseLinkPresentation.Dispose();
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

    private sealed class RejectingAvailability : IManualAssetAvailability
    {
        public static RejectingAvailability Instance { get; } = new();
        public Task<ManualDragPreparation> PrepareAsync(IReadOnlyList<ManualDragAsset> selected, CancellationToken cancellationToken) =>
            Task.FromResult(ManualDragPreparation.Fail("validation_failed"));
    }

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

    // The pinned footer aligns with the content column of the full client width, so the scroll
    // bar appearing never moves Close.
    private static void AssertCompactProductionFooter(NativeProductionLayoutProbe probe)
    {
        int column = Math.Min(1152 * probe.Dpi / 96, probe.Client.Width - 32 * probe.Dpi / 96);
        int columnX = (probe.Client.Width - column) / 2;
        Assert.Equal(60 * probe.Dpi / 96, probe.Footer.Height);
        Assert.Equal(probe.Client.Height, probe.Footer.Bottom);
        Assert.Equal(columnX + 16 * probe.Dpi / 96, probe.PostingAggregate.X);
        // The Close window adds the focus margin around its 2.25rem body, which aligns with the column.
        NativeLayoutRect closeBody = probe.Close.Inflate(-NativeCompanionTheme.ButtonFocusMargin(probe.Dpi));
        Assert.Equal(columnX + column - 16 * probe.Dpi / 96, closeBody.Right);
        Assert.Equal(12 * probe.Dpi / 96, closeBody.Y - probe.Footer.Y);
        Assert.Equal(NativeCompanionTheme.ButtonHeight(NativeCompanionButtonSize.Regular, probe.Dpi), closeBody.Height);
        Assert.Equal(default, probe.Status);
        Assert.False(probe.PostingAggregate.Intersects(probe.Close));
    }

    // Every scrolled control (and text island) shows nothing below the viewport, so nothing can
    // paint over or take clicks from the pinned footer.
    private static void AssertScrolledChildrenStayAboveFooter(NativeProductionLayoutProbe probe)
    {
        Assert.NotNull(probe.VisibleChildren);
        Assert.NotEmpty(probe.VisibleChildren!);
        foreach (NativeVisibleChildProbe child in probe.VisibleChildren!)
        {
            if (child.Visible == default) continue;
            Assert.True(child.Visible.Bottom <= probe.Viewport.Bottom,
                $"Control {child.ControlId} ({child.Handle}) shows {child.Visible} below the viewport {probe.Viewport}.");
            Assert.True(child.Visible.X >= 0 && child.Visible.Right <= probe.Client.Width,
                $"Control {child.ControlId} is clipped horizontally: {child.Visible}.");
            Assert.False(child.Visible.Intersects(probe.Footer));
        }
    }

    private static void AssertVerticallyCentred(NativeLayoutRect label, NativeLayoutRect button) =>
        Assert.InRange(label.Y + label.Height / 2 - (button.Y + button.Height / 2), -1, 1);

    private const uint BmClick = 0x00F5, WmClose = 0x0010, WmKeyDown = 0x0100,
        TcmGetCurSel = 0x130B, TcmSetCurFocus = 0x1330;
    private const int VkEscape = 0x1B, VkReturn = 0x0D, VkSpace = 0x20,
        VkLeft = 0x25, VkRight = 0x27, VkHome = 0x24, VkEnd = 0x23;

    [DllImport("user32.dll", EntryPoint = "SendMessageW", ExactSpelling = true)]
    private static extern IntPtr SendMessage(IntPtr window, uint message, IntPtr wParam, IntPtr lParam);
    [DllImport("user32.dll", EntryPoint = "PostMessageW", ExactSpelling = true)]
    private static extern bool PostMessage(IntPtr window, uint message, IntPtr wParam, IntPtr lParam);
    [DllImport("user32.dll")] private static extern bool IsWindowEnabled(IntPtr window);
    [DllImport("user32.dll")] private static extern bool IsWindowVisible(IntPtr window);
    [DllImport("user32.dll")] private static extern bool IsWindow(IntPtr window);
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
