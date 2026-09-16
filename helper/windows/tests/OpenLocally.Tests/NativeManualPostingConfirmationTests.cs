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
            Assert.Equal(default, probe.Status);
            AssertWithin(probe.Close, probe.Footer);
            AssertWithinClient(probe.Footer, probe.Client);
            Assert.False(probe.AssetList.Intersects(probe.Status));
            Assert.False(probe.AssetList.Intersects(probe.Close));
            AssertCompactProductionFooter(probe);
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
        Assert.Equal(minimum.AssetList.Height, normal.AssetList.Height);
        Assert.True(large.BodyText.Height <= 240 * large.Dpi / 96);
        Assert.True(large.AssetsCard.Height <= 440 * large.Dpi / 96);
        Assert.Equal(1152 * wide.Dpi / 96, wide.PlatformCard.Width);
        Assert.Equal((wide.Client.Width - wide.PlatformCard.Width) / 2, wide.PlatformCard.X);
        AssertCompactProductionFooter(minimum);
        AssertCompactProductionFooter(normal);
        AssertCompactProductionFooter(wide);

        string feedback = string.Join(' ', Enumerable.Repeat("status", 24));
        NativeProductionLayoutProbe wideFeedback = harness.Window.ResizeAndCaptureLayoutForTesting(
            1, 1600, 920, feedback);
        Assert.Equal(40 * wideFeedback.Dpi / 96, wideFeedback.Status.Height);
        Assert.Equal(wideFeedback.PlatformCard.X + 16 * wideFeedback.Dpi / 96, wideFeedback.Status.X);
        Assert.True(wideFeedback.Status.Right <= wideFeedback.Close.X - 12 * wideFeedback.Dpi / 96);
        Assert.False(wideFeedback.Status.Intersects(wideFeedback.Close));

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
    public async Task PlatformSelector_RemainsOneNativeComboBoxAcrossSwitchThemeFocusAndDropdownCycles()
    {
        using var controller = Controller(new RecordingTransport());
        await using NativeWindowHarness harness = await NativeWindowHarness.StartAsync(controller);

        NativePlatformComboProbe initial = harness.Window.CapturePlatformComboForTesting();
        Assert.Equal("ComboBox", initial.ClassName);
        Assert.Equal(NativeManualPublishingCompanion.NativeWindow.ProductionPlatformRuntimeStyle, initial.Style);
        Assert.Equal(NativeManualPublishingCompanion.NativeWindow.ProductionPlatformExtendedStyle, initial.ExtendedStyle);
        Assert.Equal(NativeManualPublishingCompanion.NativeWindow.PlatformId, initial.ControlId);
        Assert.Equal(harness.Window.WindowHandle, initial.Parent);
        Assert.Equal(3, initial.ItemCount);
        Assert.Equal("ComboLBox", initial.ListClassName);
        Assert.NotEqual(IntPtr.Zero, initial.ListHandle);
        int initialSelectionFieldHeight = initial.SelectionFieldHeight;

        foreach ((int index, string label) in new[]
                 {
                     (1, "Patreon"), (0, "X"), (2, "Bluesky"), (1, "Patreon"),
                 })
        {
            harness.SelectPlatform(index);
            NativePlatformComboProbe switched = harness.Window.CapturePlatformComboForTesting();
            Assert.Equal(initial.Handle, switched.Handle);
            Assert.Equal(index, switched.SelectedIndex);
            Assert.Equal(label, switched.SelectedText);
        }

        NativePlatformComboProbe dark = harness.Window.ApplyThemeAndCapturePlatformForTesting(
            NativeCompanionPalette.Dark, 96);
        NativePlatformComboProbe light = harness.Window.ApplyThemeAndCapturePlatformForTesting(
            NativeCompanionPalette.Light, 144);
        NativePlatformComboProbe highContrast = harness.Window.ApplyThemeAndCapturePlatformForTesting(
            NativeCompanionPalette.HighContrast, 192);
        NativePlatformComboProbe darkAgain = harness.Window.ApplyThemeAndCapturePlatformForTesting(
            NativeCompanionPalette.Dark, 96);
        Assert.All(new[] { dark, light, highContrast, darkAgain }, probe =>
        {
            Assert.Equal(initial.Handle, probe.Handle);
            Assert.Equal("Patreon", probe.SelectedText);
            Assert.Equal(initialSelectionFieldHeight, probe.SelectionFieldHeight);
        });
        Assert.Equal(NativeCompanionThemeMode.Dark, dark.ThemeMode);
        Assert.Equal(NativeCompanionThemeMode.Light, light.ThemeMode);
        Assert.Equal(NativeCompanionThemeMode.HighContrast, highContrast.ThemeMode);
        Assert.Equal(96, dark.Dpi);
        Assert.Equal(144, light.Dpi);
        Assert.Equal(192, highContrast.Dpi);
        Assert.Equal(32, dark.ListItemHeight);
        Assert.Equal(48, light.ListItemHeight);
        Assert.Equal(64, highContrast.ListItemHeight);
        Assert.Equal(32, darkAgain.ListItemHeight);

        Assert.True(harness.Window.FocusPlatformForTesting().KeyboardFocused);
        Assert.True(harness.Window.SetPlatformHoverForTesting(hovered: true).Hovered);
        NativePlatformComboProbe pointerLeft = harness.Window.SetPlatformHoverForTesting(hovered: false);
        Assert.False(pointerLeft.Hovered);
        Assert.True(pointerLeft.KeyboardFocused);

        NativePlatformComboProbe open = harness.Window.ShowPlatformDropdownForTesting(show: true);
        Assert.True(open.Dropped);
        NativePlatformComboProbe closed = harness.Window.ShowPlatformDropdownForTesting(show: false);
        Assert.False(closed.Dropped);
        Assert.Equal("Patreon", closed.SelectedText);
    }

    [Fact]
    public async Task PlatformDropdown_RediscoversAndThemesTheLivePopupOnEveryOpening()
    {
        using var controller = Controller(new RecordingTransport());
        await using NativeWindowHarness harness = await NativeWindowHarness.StartAsync(controller);
        NativePlatformComboProbe initial = harness.Window.CapturePlatformComboForTesting();
        int selectedIndex = initial.SelectedIndex;
        string selectedText = initial.SelectedText;
        var observed = new List<NativePlatformPopupDiscoveryObservation>();
        var perOpening = new List<NativePlatformPopupDiscoveryObservation>();

        harness.Window.SetPlatformPopupDiscoveryObserverForTesting(observed.Add);
        try
        {
            foreach ((NativeCompanionPalette palette, int dpi, NativeCompanionThemeMode mode) in new[]
                     {
                         (NativeCompanionPalette.Dark, 96, NativeCompanionThemeMode.Dark),
                         (NativeCompanionPalette.Light, 144, NativeCompanionThemeMode.Light),
                         (NativeCompanionPalette.HighContrast, 192, NativeCompanionThemeMode.HighContrast),
                         (NativeCompanionPalette.Dark, 96, NativeCompanionThemeMode.Dark),
                     })
            {
                NativePlatformComboProbe themed = harness.Window.ApplyThemeAndCapturePlatformForTesting(palette, dpi);
                Assert.Equal(initial.Handle, themed.Handle);

                // ApplyTheme also discovers the popup. Exclude that event so only the real
                // CB_SHOWDROPDOWN -> CBN_DROPDOWN production route can satisfy this assertion.
                observed.Clear();
                NativePlatformComboProbe open = harness.Window.ShowPlatformDropdownForTesting(show: true);
                Assert.True(open.Dropped);
                NativePlatformPopupDiscoveryObservation observation = Assert.Single(observed);

                ComboBoxInfo actual = new() { cbSize = (uint)Marshal.SizeOf<ComboBoxInfo>() };
                Assert.True(GetComboBoxInfo(initial.Handle, ref actual));
                Assert.Equal(initial.Handle, observation.ComboHandle);
                Assert.Equal(actual.hwndList, observation.PopupHandle);
                Assert.NotEqual(IntPtr.Zero, observation.PopupHandle);
                Assert.True(IsWindow(observation.PopupHandle));
                Assert.Equal("ComboLBox", ClassName(observation.PopupHandle));
                Assert.Equal(mode, observation.ThemeMode);
                Assert.True(observation.ThemeApplied);
                perOpening.Add(observation);

                Assert.False(harness.Window.ShowPlatformDropdownForTesting(show: false).Dropped);
            }
        }
        finally
        {
            harness.Window.SetPlatformPopupDiscoveryObserverForTesting(null);
        }

        Assert.Equal(4, perOpening.Count);
        Assert.All(perOpening, observation => Assert.Equal(initial.Handle, observation.ComboHandle));
        Assert.Equal(selectedIndex, harness.Window.CapturePlatformComboForTesting().SelectedIndex);
        Assert.Equal(selectedText, harness.Window.CapturePlatformComboForTesting().SelectedText);
    }

    [Theory]
    [InlineData((int)NativeCompanionThemeMode.Dark, -1, "DarkMode_Explorer", false)]
    [InlineData((int)NativeCompanionThemeMode.HighContrast, -1, null, false)]
    [InlineData((int)NativeCompanionThemeMode.HighContrast, 0, null, true)]
    public async Task PlatformDropdown_ReportsActualNativeThemeOrSystemResetResult(
        int modeValue, int hresult, string? expectedThemeName, bool expectedApplied)
    {
        using var controller = Controller(new RecordingTransport());
        await using NativeWindowHarness harness = await NativeWindowHarness.StartAsync(controller);
        NativeCompanionThemeMode mode = (NativeCompanionThemeMode)modeValue;
        NativeCompanionPalette palette = mode == NativeCompanionThemeMode.Dark
            ? NativeCompanionPalette.Dark
            : NativeCompanionPalette.HighContrast;
        var nativeCalls = new List<(IntPtr Handle, string? ThemeName)>();
        var observed = new List<NativePlatformPopupDiscoveryObservation>();

        harness.Window.SetPlatformPopupDiscoveryObserverForTesting(observed.Add);
        try
        {
            harness.Window.ApplyThemeAndCapturePlatformForTesting(
                palette,
                96,
                (handle, themeName, _) =>
                {
                    nativeCalls.Add((handle, themeName));
                    return hresult;
                });
            observed.Clear();
            nativeCalls.Clear();

            Assert.True(harness.Window.ShowPlatformDropdownForTesting(show: true).Dropped);
            NativePlatformPopupDiscoveryObservation observation = Assert.Single(observed);
            (IntPtr Handle, string? ThemeName) nativeCall = Assert.Single(nativeCalls);

            Assert.Equal(observation.PopupHandle, nativeCall.Handle);
            Assert.Equal(expectedThemeName, nativeCall.ThemeName);
            Assert.Equal(mode, observation.ThemeMode);
            Assert.Equal(expectedApplied, observation.ThemeApplied);
            Assert.False(harness.Window.ShowPlatformDropdownForTesting(show: false).Dropped);
        }
        finally
        {
            harness.Window.SetPlatformPopupDiscoveryObserverForTesting(null);
        }
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
        Assert.True(Math.Abs(release.FontHeight) > Math.Abs(field.FontHeight));
        Assert.True(Math.Abs(field.FontHeight) > Math.Abs(metadata.FontHeight));
        Assert.Equal(600, release.FontWeight);
        Assert.Equal(600, section.FontWeight);
        Assert.Equal(400, field.FontWeight);
        Assert.Equal(NativeCompanionPalette.Dark.Text, field.Text);
        Assert.Equal(NativeCompanionPalette.Dark.Text, selected.Text);
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

        Assert.Equal(NativeCompanionPalette.Dark.Page, dark.WindowStyle.Background);
        Assert.Equal(NativeCompanionPalette.Dark.Surface, dark.SectionStyle.Background);
        Assert.Equal(NativeCompanionPalette.Dark.Card, dark.SectionHeaderStyle.Background);
        Assert.Equal(NativeCompanionPalette.Dark.Card, dark.NestedStyle.Background);
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

        Assert.Equal(NativeCompanionOwnerDrawTarget.PlatformCombo,
            harness.Window.OwnerDrawTargetForTesting(3, NativeManualPublishingCompanion.NativeWindow.PlatformId, platform));
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
            Func<IntPtr, IUnicodeClipboard>? clipboardFactory,
            ManualSocialSession? session)
        {
            var lifecycle = new ManualCompanionLifecycle();
            Window = new NativeManualPublishingCompanion.NativeWindow(
                new ManualPublishingCompanionModel(session ?? Session()), lifecycle, controller, clipboardFactory,
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
            Func<IntPtr, IUnicodeClipboard>? clipboardFactory = null,
            ManualSocialSession? session = null)
        {
            var harness = new NativeWindowHarness(controller, clipboardFactory, session);
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

    private static void AssertCompactProductionFooter(NativeProductionLayoutProbe probe)
    {
        Assert.Equal(60 * probe.Dpi / 96, probe.Footer.Height);
        Assert.Equal(16 * probe.Dpi / 96, probe.PostingAggregate.X - probe.PlatformCard.X);
        Assert.Equal(16 * probe.Dpi / 96, probe.PlatformCard.Right - probe.Close.Right);
        Assert.Equal(12 * probe.Dpi / 96, probe.Close.Y - probe.Footer.Y);
        Assert.Equal(default, probe.Status);
        Assert.False(probe.PostingAggregate.Intersects(probe.Close));
    }

    private const uint BmClick = 0x00F5, CbSetCurSel = 0x014E, WmClose = 0x0010,
        WmCommand = 0x0111, WmKeyDown = 0x0100;
    private const int CbnSelChange = 1, VkEscape = 0x1B;

    [StructLayout(LayoutKind.Sequential)]
    private struct ComboRect
    {
        public int left;
        public int top;
        public int right;
        public int bottom;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct ComboBoxInfo
    {
        public uint cbSize;
        public ComboRect rcItem;
        public ComboRect rcButton;
        public uint stateButton;
        public IntPtr hwndCombo;
        public IntPtr hwndItem;
        public IntPtr hwndList;
    }

    [DllImport("user32.dll", EntryPoint = "SendMessageW", ExactSpelling = true)]
    private static extern IntPtr SendMessage(IntPtr window, uint message, IntPtr wParam, IntPtr lParam);
    [DllImport("user32.dll", EntryPoint = "PostMessageW", ExactSpelling = true)]
    private static extern bool PostMessage(IntPtr window, uint message, IntPtr wParam, IntPtr lParam);
    [DllImport("user32.dll")] private static extern bool IsWindowEnabled(IntPtr window);
    [DllImport("user32.dll")] private static extern bool IsWindowVisible(IntPtr window);
    [DllImport("user32.dll")] private static extern bool IsWindow(IntPtr window);
    [DllImport("user32.dll")] private static extern bool GetComboBoxInfo(IntPtr combo, ref ComboBoxInfo info);
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
