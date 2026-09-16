using OpenLocally;
using System.Runtime.InteropServices;

namespace OpenLocally.Tests;

[Collection("Native header resource isolation")]
public sealed class NativeManualPublishingListViewTests
{
    [Theory]
    [InlineData(0)]
    [InlineData(1)]
    [InlineData(4)]
    [InlineData(5)]
    [InlineData(6)]
    public async Task ProductionViewport_UsesContentAwareFiveRowCapWithCompleteNativeRows(int assetCount)
    {
        ManualPreparedAsset[] assets = Enumerable.Range(1, assetCount)
            .Select(index => Prepared(index, $"asset-{index}.png", true)).ToArray();
        await using var harness = await ProductionHeaderHarness.StartAsync(Model(assets));

        NativeProductionLayoutProbe layout =
            harness.Window.ResizeAndCaptureLayoutForTesting(0, 980, 920);
        NativeAssetViewportProbe viewport = harness.Window.CaptureAssetViewportForTesting();

        Assert.Equal(assetCount, viewport.DisplayedAssetCount);
        Assert.Equal(Math.Min(assetCount, 5), viewport.VisibleRowTarget);
        Assert.Equal(viewport.DesiredListHeight, layout.AssetList.Height);
        Assert.Equal(viewport.DesiredListHeight, viewport.ListWindow.Height);
        Assert.Equal(assetCount, viewport.Items.Count);
        Assert.True(viewport.Header.Height > 0);
        Assert.True(viewport.Header.Bottom <= viewport.ListClient.Bottom);

        for (int index = 0; index < Math.Min(assetCount, 5); index++)
            Assert.True(viewport.Items[index].Bottom <= viewport.ListClient.Bottom,
                $"Row {index} was clipped: row bottom {viewport.Items[index].Bottom}, client bottom {viewport.ListClient.Bottom}.");

        if (assetCount <= 5)
        {
            Assert.All(viewport.Items,
                item => Assert.True(item.Bottom <= viewport.ListClient.Bottom));
            if (assetCount > 0)
                Assert.True(viewport.ScrollMaximum - viewport.ScrollMinimum + 1 <= viewport.ScrollPage);
        }
        else
        {
            Assert.True(viewport.Items[5].Bottom > viewport.ListClient.Bottom);
            Assert.True(viewport.ScrollMaximum - viewport.ScrollMinimum + 1 > viewport.ScrollPage);
            NativeAssetViewportProbe scrolled = harness.Window.EnsureLastAssetVisibleForTesting();
            Assert.True(scrolled.Items[^1].Bottom <= scrolled.ListClient.Bottom);
            Assert.True(scrolled.ScrollPosition > scrolled.ScrollMinimum);
        }
    }

    [Theory]
    [InlineData(0)]
    [InlineData(4)]
    [InlineData(5)]
    public async Task AuthoritativeTextLayoutSnapshot_TracksResizePlatformAndMeasuredAssetViewport(int assetCount)
    {
        ManualPreparedAsset[] assets = Enumerable.Range(1, assetCount)
            .Select(index => Prepared(index, $"asset-{index}.png", true)).ToArray();
        var model = new ManualPublishingCompanionModel(Session(
            new ManualPreparedPlatform("patreon", "Release", "Body", assets),
            new ManualPreparedPlatform("x", "Release", "Post", assets),
            new ManualPreparedPlatform("bluesky", "Release", "Post", assets)));
        await using var harness = await ProductionHeaderHarness.StartAsync(model);

        foreach ((int platformIndex, string platform, bool titleVisible) in new[]
                 { (0, "patreon", true), (1, "x", false), (2, "bluesky", false), (0, "patreon", true) })
        {
            NativeProductionLayoutProbe actual =
                harness.Window.ResizeAndCaptureLayoutForTesting(platformIndex, 980, 920);
            NativeAuthoritativeTextLayoutProbe authoritative =
                harness.Window.CaptureAuthoritativeTextLayoutForTesting();
            NativeAssetViewportProbe viewport = harness.Window.CaptureAssetViewportForTesting();

            Assert.Equal(platform, authoritative.Platform);
            Assert.Equal(titleVisible, authoritative.TitleVisible);
            Assert.Equal(authoritative.BodyText, actual.BodyText);
            Assert.Equal(authoritative.TitleText, actual.TitleText);
            Assert.Equal(Math.Min(assetCount, 5), viewport.VisibleRowTarget);
            Assert.Equal(viewport.DesiredListHeight, actual.AssetList.Height);
            if (!titleVisible) Assert.Equal(default, authoritative.TitleText);
        }
    }

    [Fact]
    public async Task ProductionViewport_RecalculatesAcrossPlatformSwitchAndDoesNotKeepStaleHeight()
    {
        ManualPreparedAsset[] Assets(int count, int offset) => Enumerable.Range(1, count)
            .Select(index => Prepared(offset + index, $"asset-{offset + index}.png", true)).ToArray();
        var model = new ManualPublishingCompanionModel(Session(
            new ManualPreparedPlatform("patreon", "Release", "Body", Assets(4, 0)),
            new ManualPreparedPlatform("x", "Release", "Post", Assets(2, 100)),
            new ManualPreparedPlatform("bluesky", "Release", "Post", Assets(7, 200))));
        await using var harness = await ProductionHeaderHarness.StartAsync(model);

        NativeAssetViewportProbe patreon = Capture(0);
        NativeAssetViewportProbe x = Capture(1);
        NativeAssetViewportProbe bluesky = Capture(2);
        NativeAssetViewportProbe patreonAgain = Capture(0);

        Assert.True(x.ListWindow.Height < patreon.ListWindow.Height);
        Assert.True(patreon.ListWindow.Height < bluesky.ListWindow.Height);
        Assert.Equal(patreon.ListWindow.Height, patreonAgain.ListWindow.Height);
        Assert.Equal(5, bluesky.VisibleRowTarget);
        Assert.True(bluesky.Items[5].Bottom > bluesky.ListClient.Bottom);

        NativeAssetViewportProbe Capture(int platformIndex)
        {
            harness.Window.ResizeAndCaptureLayoutForTesting(platformIndex, 980, 920);
            return harness.Window.CaptureAssetViewportForTesting();
        }
    }

    [Fact]
    public async Task ProductionViewport_RemainsFiveRowsAtLargeAndWideSizesWithoutUnboundedGrowth()
    {
        await using var harness = await ProductionHeaderHarness.StartAsync(Model(
            Enumerable.Range(1, 8).Select(index => Prepared(index, $"asset-{index}.png", true)).ToArray()));

        NativeAssetViewportProbe normal = Capture(980, 920);
        NativeAssetViewportProbe large = Capture(980, 1400);
        NativeAssetViewportProbe wide = Capture(1600, 920);

        Assert.Equal(normal.DesiredListHeight, large.ListWindow.Height);
        Assert.Equal(normal.DesiredListHeight, wide.ListWindow.Height);
        Assert.Equal(5, normal.VisibleRowTarget);

        NativeAssetViewportProbe Capture(int width, int height)
        {
            harness.Window.ResizeAndCaptureLayoutForTesting(0, width, height);
            return harness.Window.CaptureAssetViewportForTesting();
        }
    }

    [Fact]
    public async Task SupportedMinimum_StaysContainedWhenFiveNativeRowsCannotFitWithoutBreakingContent()
    {
        ManualPreparedAsset[] assets = Enumerable.Range(1, 5)
            .Select(index => Prepared(index, $"asset-{index}.png", true)).ToArray();
        await using var harness = await ProductionHeaderHarness.StartAsync(
            new ManualPublishingCompanionModel(Session(
                new ManualPreparedPlatform("patreon", "Release", "Body", assets))));

        NativeProductionLayoutProbe minimum =
            harness.Window.ResizeAndCaptureLayoutForTesting(0, 820, 754);
        NativeAssetViewportProbe minimumViewport = harness.Window.CaptureAssetViewportForTesting();
        Assert.True(minimumViewport.ListWindow.Height < minimumViewport.DesiredListHeight);
        Assert.True(minimum.PlatformCard.Bottom < minimum.AssetsCard.Y);
        Assert.True(minimum.AssetsCard.Bottom <= minimum.Footer.Y - 16);
        Assert.True(minimum.BodyText.Height >= 72);

        NativeProductionLayoutProbe normal =
            harness.Window.ResizeAndCaptureLayoutForTesting(0, 980, 920);
        NativeAssetViewportProbe normalViewport = harness.Window.CaptureAssetViewportForTesting();
        Assert.Equal(normalViewport.DesiredListHeight, normal.AssetList.Height);
        Assert.All(normalViewport.Items,
            item => Assert.True(item.Bottom <= normalViewport.ListClient.Bottom));
    }

    [Fact]
    public async Task ProductionViewport_UsesRealHeaderAndImageListRowMetricsAtSupportedDpiValues()
    {
        await using var harness = await ProductionHeaderHarness.StartAsync(Model(
            Enumerable.Range(1, 6).Select(index => Prepared(index, $"asset-{index}.png", true)).ToArray()));

        NativeAssetViewportProbe dpi96 = Capture(96, NativeCompanionPalette.Dark);
        NativeAssetViewportProbe dpi144 = Capture(144, NativeCompanionPalette.Dark);
        NativeAssetViewportProbe dpi192 = Capture(192, NativeCompanionPalette.Dark);
        AssertMetricComposition(dpi96);
        AssertMetricComposition(dpi144);
        AssertMetricComposition(dpi192);
        Assert.True(dpi96.Items[0].Height < dpi144.Items[0].Height);
        Assert.True(dpi144.Items[0].Height < dpi192.Items[0].Height);
        Assert.True(dpi96.Header.Height < dpi144.Header.Height);
        Assert.True(dpi144.Header.Height < dpi192.Header.Height);

        int dark = dpi96.DesiredListHeight;
        Assert.Equal(dark, Capture(96, NativeCompanionPalette.Light).DesiredListHeight);
        Assert.Equal(dark, Capture(96, NativeCompanionPalette.HighContrast).DesiredListHeight);

        NativeAssetViewportProbe Capture(int dpi, NativeCompanionPalette palette) =>
            harness.Window.CaptureAssetViewportAtMetricDpiForTesting(palette, dpi);

        static void AssertMetricComposition(NativeAssetViewportProbe viewport)
        {
            int nonClientHeight = viewport.ListWindow.Height - viewport.ListClient.Height;
            int expected = nonClientHeight + viewport.Items[0].Y +
                viewport.Items[0].Height * viewport.VisibleRowTarget;
            Assert.Equal(expected, viewport.DesiredListHeight);
        }
    }

    [Fact]
    public async Task ProductionColumns_UseActualClientWidthAcrossResizeCycleAndPreserveSelection()
    {
        var model = Model(
            Prepared(1, "short.png", true),
            Prepared(2, "a-representative-long-filename-that-clips.png", true),
            Prepared(3, "third.png", true));
        await using var harness = await ProductionHeaderHarness.StartAsync(model);
        IntPtr listView = harness.Window.AssetListHandleForTesting;
        NativeManualPublishingCompanion.NativeWindow.SetNativeSelection(listView, new HashSet<int> { 0, 2 }, 3);
        Assert.Equal([0, 2], NativeManualPublishingCompanion.NativeWindow.SelectedOrdinals(listView));

        (int ClientWidth, int Dpi, int[] Widths) Capture(int logicalWidth)
        {
            NativeProductionLayoutProbe layout =
                harness.Window.ResizeAndCaptureLayoutForTesting(0, logicalWidth, 920);
            Assert.True(GetClientRect(listView, out Rect client));
            int[] widths = ColumnWidths(listView);
            Assert.Equal(
                NativeManualPublishingCompanion.NativeWindow.AssetColumns(client.right, layout.Dpi)
                    .Select(column => column.LogicalWidth),
                widths);
            Assert.Equal([0, 2], NativeManualPublishingCompanion.NativeWindow.SelectedOrdinals(listView));
            Assert.Equal("2 of 3 selected", WindowText(harness.Window.AssetCountHandle));
            Assert.Equal("Drag any selected file to attach all selected files.",
                WindowText(harness.Window.DragGuidanceHandle));
            return (client.right, layout.Dpi, widths);
        }

        var minimum = Capture(820);
        var normal = Capture(980);
        var wide = Capture(1600);
        var minimumAgain = Capture(820);

        Assert.Equal(minimum.Widths, minimumAgain.Widths);
        Assert.True(normal.Widths[0] > minimum.Widths[0]);
        Assert.True(wide.Widths[0] > normal.Widths[0]);
        Assert.Equal(minimum.Widths[1..4], normal.Widths[1..4]);
        Assert.Equal(normal.Widths[1..4], wide.Widths[1..4]);
        Assert.InRange(wide.Widths[4], 180 * wide.Dpi / 96, 280 * wide.Dpi / 96);
        Assert.All(minimum.Widths, width => Assert.True(width > 0));
        Assert.True(minimum.Widths.Sum() >= minimum.ClientWidth);
    }

    [Fact]
    public async Task ProductionColumns_PreserveManualDividerUntilStructuralResize()
    {
        await using var harness = await ProductionHeaderHarness.StartAsync(Model(Prepared(1, "a.png", true)));
        IntPtr listView = harness.Window.AssetListHandleForTesting;
        NativeProductionLayoutProbe normal = harness.Window.ResizeAndCaptureLayoutForTesting(0, 980, 920);
        int manualFileWidth = 333 * normal.Dpi / 96;
        SendMessage(listView, 0x1000 + 30, IntPtr.Zero, new IntPtr(manualFileWidth));

        harness.Window.ResizeAndCaptureLayoutForTesting(0, 980, 920);
        Assert.Equal(manualFileWidth, ColumnWidths(listView)[0]);

        NativeProductionLayoutProbe wide = harness.Window.ResizeAndCaptureLayoutForTesting(0, 1600, 920);
        Assert.True(GetClientRect(listView, out Rect client));
        Assert.Equal(
            NativeManualPublishingCompanion.NativeWindow.AssetColumns(client.right, wide.Dpi)
                .Select(column => column.LogicalWidth),
            ColumnWidths(listView));
    }

    [Fact]
    public async Task ProductionColumns_KeepPlatformLocalSelectionsAcrossResizeAndSwitch()
    {
        var model = new ManualPublishingCompanionModel(Session(
            new ManualPreparedPlatform("patreon", "Release", "Body",
                [Prepared(1, "a.png", true), Prepared(2, "b.png", true), Prepared(3, "c.png", true)]),
            new ManualPreparedPlatform("x", "Release", "Post",
                [Prepared(4, "x.png", true), Prepared(5, "y.png", true)])));
        await using var harness = await ProductionHeaderHarness.StartAsync(model);
        IntPtr listView = harness.Window.AssetListHandleForTesting;

        NativeManualPublishingCompanion.NativeWindow.SetNativeSelection(listView, new HashSet<int> { 0, 2 }, 3);
        harness.Window.ResizeAndCaptureLayoutForTesting(1, 980, 920);
        NativeManualPublishingCompanion.NativeWindow.SetNativeSelection(listView, new HashSet<int> { 1 }, 2);
        harness.Window.ResizeAndCaptureLayoutForTesting(0, 820, 754);
        Assert.Equal([0, 2], NativeManualPublishingCompanion.NativeWindow.SelectedOrdinals(listView));
        Assert.Equal("2 of 3 selected", WindowText(harness.Window.AssetCountHandle));

        NativeProductionLayoutProbe wide = harness.Window.ResizeAndCaptureLayoutForTesting(1, 1600, 920);
        Assert.Equal([1], NativeManualPublishingCompanion.NativeWindow.SelectedOrdinals(listView));
        Assert.Equal("1 of 2 selected", WindowText(harness.Window.AssetCountHandle));
        Assert.True(GetClientRect(listView, out Rect client));
        Assert.Equal(
            NativeManualPublishingCompanion.NativeWindow.AssetColumns(client.right, wide.Dpi)
                .Select(column => column.LogicalWidth),
            ColumnWidths(listView));
    }

    [Fact]
    public async Task NativeHeaderPostpaint_NormalizesParentRectanglesAfterHorizontalScrollAndResize()
    {
        await using var harness = await ProductionHeaderHarness.StartAsync(Model(Prepared(1, "a.png", true)));
        IntPtr listView = harness.Window.AssetListHandleForTesting;

        SendMessage(listView, 0x1000 + 30, new IntPtr(4), new IntPtr(600));
        harness.Window.ScrollAssetListHorizontallyForTesting(180);
        AssertPostpaintUsesHeaderClientCoordinates(harness, listView);
        AssertHeaderCustomDrawStages(harness.Window.PaintHeaderForTesting(NativeCompanionPalette.Dark));

        harness.Window.ResizeAndCaptureLayoutForTesting(0, 900, 800);
        SendMessage(listView, 0x1000 + 30, new IntPtr(4), new IntPtr(600));
        harness.Window.ScrollAssetListHorizontallyForTesting(180);
        AssertPostpaintUsesHeaderClientCoordinates(harness, listView);
        AssertHeaderCustomDrawStages(harness.Window.PaintHeaderForTesting(NativeCompanionPalette.Dark));
    }

    [Fact]
    public void EmptyAndLongRows_DoNotChangeStableColumnPolicy()
    {
        using var harness = new NotificationHarness(Model());
        int[] empty = ColumnWidths(harness.ListView);
        NativeManualPublishingCompanion.NativeWindow.PopulateAssetRows(harness.ListView,
        [
            new ManualAssetListRow(
                new ManualPreparedPlatform("x", "Release", "Post", []), 0,
                new ManualPreparedAsset(
                    new SocialRedeemAsset(1, new string('r', 200), 1, new string('f', 200) + ".png",
                        ".png", "image/png", long.MaxValue, "release/" + new string('p', 300), true, null),
                    @"C:\stage\" + new string('s', 200) + ".png", StagedMediaProvenance.HelperOwned))
        ]);

        Assert.Equal(empty, ColumnWidths(harness.ListView));
    }

    private static void AssertPostpaintUsesHeaderClientCoordinates(
        ProductionHeaderHarness harness, IntPtr listView)
    {
        NativeHeaderPostpaintProbe probe =
            harness.Window.PaintHeaderPostpaintForTesting(NativeCompanionPalette.Dark);
        Assert.True(probe.CoordinateMappingSucceeded);
        Assert.True(GetClientRect(harness.Header, out Rect client));
        Assert.Equal(new NativeLayoutRect(0, 0, client.right, client.bottom), probe.Client);

        int itemCount = SendMessage(harness.Header, 0x1200, IntPtr.Zero, IntPtr.Zero).ToInt32();
        var parentItems = new List<NativeLayoutRect>(itemCount);
        var expectedItems = new List<NativeLayoutRect>(itemCount);
        for (int index = 0; index < itemCount; index++)
        {
            Assert.True(SendMessageHeaderRect(harness.Header, 0x1200 + 7, new IntPtr(index), out Rect item));
            parentItems.Add(new(item.left, item.top, item.right - item.left, item.bottom - item.top));
            var points = new[]
            {
                new Point { x = item.left, y = item.top },
                new Point { x = item.right, y = item.bottom },
            };
            SetLastError(0);
            Assert.True(MapWindowPoints(listView, harness.Header, points, 2) != 0 ||
                Marshal.GetLastWin32Error() == 0);
            expectedItems.Add(new(points[0].x, points[0].y,
                points[1].x - points[0].x, points[1].y - points[0].y));
        }

        Assert.Equal(expectedItems, probe.Items);
        Assert.NotEqual(parentItems[0].X, expectedItems[0].X);
        NativeLayoutRect expectedTrailing = NativeCompanionTheme.HeaderTrailingBounds(probe.Client, expectedItems);
        Assert.Equal(expectedTrailing, probe.Trailing);
        Assert.All(expectedItems.Where(item => item.Right > probe.Client.X && item.X < probe.Client.Right),
            item => Assert.True(probe.Trailing.Width == 0 || probe.Trailing.X >= item.Right));
    }

    private static int[] ColumnWidths(IntPtr listView) =>
        Enumerable.Range(0, 5)
            .Select(index => SendMessage(listView, 0x1000 + 29, new IntPtr(index), IntPtr.Zero).ToInt32())
            .ToArray();

    private static string WindowText(IntPtr window)
    {
        var value = new System.Text.StringBuilder(256);
        GetWindowText(window, value, value.Capacity);
        return value.ToString();
    }

    [Fact]
    public async Task NativeHeaderCustomDraw_UsesRealProductionHeaderNotificationPathAndDocumentedStageFlags()
    {
        await using var harness = await ProductionHeaderHarness.StartAsync(Model(Prepared(1, "a.png", true)));

        Assert.NotEqual(IntPtr.Zero, harness.Header);
        Assert.Equal("SysHeader32", harness.HeaderClassName);
        Assert.Equal(["File", "Role", "Size", "Status", "Path / staged name"], harness.HeaderTexts);

        harness.Window.ResizeAndCaptureLayoutForTesting(0, 820, 754);
        IReadOnlyList<NativeHeaderDrawStageProbe> dark = harness.Window.PaintHeaderForTesting(NativeCompanionPalette.Dark);
        AssertHeaderCustomDrawStages(dark);
        AssertHeaderCustomDrawStages(harness.Window.PaintHeaderForTesting(NativeCompanionPalette.Light));
        AssertHeaderCustomDrawStages(harness.Window.PaintHeaderForTesting(NativeCompanionPalette.Dark));

        IReadOnlyList<NativeHeaderDrawStageProbe> highContrastDraws =
            harness.Window.PaintHeaderForTesting(NativeCompanionPalette.HighContrast);
        NativeHeaderDrawStageProbe highContrast = Assert.Single(highContrastDraws);
        Assert.Equal(0x00000001u, highContrast.Stage);
        Assert.Equal(IntPtr.Zero, highContrast.Result);
    }

    [Fact]
    public async Task NativeRowCustomDraw_UsesRealSelectedStateAndPersistsWhenFocusLeavesListView()
    {
        await using var harness = await ProductionHeaderHarness.StartAsync(Model(
            Prepared(1, "a.png", true), Prepared(2, "b.png", false), Prepared(3, "c.png", true)));
        IntPtr listView = harness.Window.AssetListHandleForTesting;
        NativeManualPublishingCompanion.NativeWindow.SetNativeSelection(listView, new HashSet<int> { 0, 1 }, 3);

        IReadOnlyList<NativeListViewRowDrawProbe> focused =
            harness.Window.PaintAssetRowsForTesting(NativeCompanionPalette.Dark, 96, true, focusedItem: 0);
        AssertRowSelection(focused, NativeCompanionPalette.Dark, [0, 1], focusedItem: 0);

        IReadOnlyList<NativeListViewRowDrawProbe> focusElsewhere =
            harness.Window.PaintAssetRowsForTesting(NativeCompanionPalette.Dark, 96, false, focusedItem: 0);
        AssertRowSelection(focusElsewhere, NativeCompanionPalette.Dark, [0, 1], focusedItem: null);
        Assert.Equal([0, 1], NativeManualPublishingCompanion.NativeWindow.SelectedOrdinals(listView));
        Assert.All(ItemPrepaints(focusElsewhere), draw => Assert.False(draw.KeyboardFocused));

        // The previous implementation had no selected-item postpaint stage, so this
        // production assertion proves the old weak row path would fail the regression.
        Assert.Equal([0, 1], ItemPostpaints(focusElsewhere).Select(draw => draw.ItemIndex).Order());
    }

    [Fact]
    public async Task NativeRowCustomDraw_TracksZeroOneMultipleAndDeselectWithoutStaleAccent()
    {
        await using var harness = await ProductionHeaderHarness.StartAsync(Model(
            Prepared(1, "a.png", true), Prepared(2, "b.png", true), Prepared(3, "c.png", true)));
        IntPtr listView = harness.Window.AssetListHandleForTesting;

        NativeManualPublishingCompanion.NativeWindow.SetNativeSelection(listView, new HashSet<int>(), 3);
        IReadOnlyList<NativeListViewRowDrawProbe> zero =
            harness.Window.PaintAssetRowsForTesting(NativeCompanionPalette.Light, 96, false);
        AssertRowSelection(zero, NativeCompanionPalette.Light, [], focusedItem: null);
        Assert.Empty(ItemPostpaints(zero));

        NativeManualPublishingCompanion.NativeWindow.SetNativeSelection(listView, new HashSet<int> { 1 }, 3);
        IReadOnlyList<NativeListViewRowDrawProbe> one =
            harness.Window.PaintAssetRowsForTesting(NativeCompanionPalette.Light, 96, false);
        AssertRowSelection(one, NativeCompanionPalette.Light, [1], focusedItem: null);

        NativeManualPublishingCompanion.NativeWindow.SetNativeSelection(listView, new HashSet<int> { 0, 1, 2 }, 3);
        IReadOnlyList<NativeListViewRowDrawProbe> multiple =
            harness.Window.PaintAssetRowsForTesting(NativeCompanionPalette.Light, 96, false);
        AssertRowSelection(multiple, NativeCompanionPalette.Light, [0, 1, 2], focusedItem: null);

        NativeManualPublishingCompanion.NativeWindow.SetNativeSelection(listView, new HashSet<int> { 0, 2 }, 3);
        IReadOnlyList<NativeListViewRowDrawProbe> deselected =
            harness.Window.PaintAssetRowsForTesting(NativeCompanionPalette.Light, 96, false);
        AssertRowSelection(deselected, NativeCompanionPalette.Light, [0, 2], focusedItem: null);
        Assert.DoesNotContain(ItemPostpaints(deselected), draw => draw.ItemIndex == 1);
    }

    [Fact]
    public async Task NativeRowCustomDraw_FollowsPlatformRestoreResizeAndVisibleLeadingEdgeAfterHorizontalScroll()
    {
        var model = new ManualPublishingCompanionModel(Session(
            new ManualPreparedPlatform("patreon", "Release", "Body",
                [Prepared(1, "a.png", true), Prepared(2, "b.png", true), Prepared(3, "c.png", true)]),
            new ManualPreparedPlatform("x", "Release", "Post",
                [Prepared(4, "x.png", true), Prepared(5, "y.png", true)])));
        await using var harness = await ProductionHeaderHarness.StartAsync(model);
        IntPtr listView = harness.Window.AssetListHandleForTesting;

        NativeManualPublishingCompanion.NativeWindow.SetNativeSelection(listView, new HashSet<int> { 0, 2 }, 3);
        harness.Window.ResizeAndCaptureLayoutForTesting(1, 980, 920);
        NativeManualPublishingCompanion.NativeWindow.SetNativeSelection(listView, new HashSet<int> { 1 }, 2);
        SendMessage(listView, 0x1000 + 30, new IntPtr(4), new IntPtr(600));
        harness.Window.ScrollAssetListHorizontallyForTesting(180);
        IReadOnlyList<NativeListViewRowDrawProbe> x =
            harness.Window.PaintAssetRowsForTesting(NativeCompanionPalette.Dark, 144, false);
        AssertRowSelection(x, NativeCompanionPalette.Dark, [1], focusedItem: null);
        Assert.All(ItemPostpaints(x), draw =>
        {
            Assert.Equal(0, draw.Accent.X);
            Assert.Equal(3, draw.Accent.Width);
        });

        harness.Window.ResizeAndCaptureLayoutForTesting(0, 980, 920);
        IReadOnlyList<NativeListViewRowDrawProbe> patreon =
            harness.Window.PaintAssetRowsForTesting(NativeCompanionPalette.Dark, 192, false);
        AssertRowSelection(patreon, NativeCompanionPalette.Dark, [0, 2], focusedItem: null);
        Assert.All(ItemPostpaints(patreon), draw => Assert.Equal(4, draw.Accent.Width));
    }

    [Fact]
    public async Task NativeRowCustomDraw_HighContrastDefersToSystemSelectionAndFocus()
    {
        await using var harness = await ProductionHeaderHarness.StartAsync(Model(
            Prepared(1, "a.png", true), Prepared(2, "b.png", true)));
        IntPtr listView = harness.Window.AssetListHandleForTesting;
        NativeManualPublishingCompanion.NativeWindow.SetNativeSelection(listView, new HashSet<int> { 0, 1 }, 2);

        IReadOnlyList<NativeListViewRowDrawProbe> draws =
            harness.Window.PaintAssetRowsForTesting(NativeCompanionPalette.HighContrast, 192, true);

        NativeListViewRowDrawProbe prepaint = Assert.Single(draws);
        Assert.Equal(0x00000001u, prepaint.Stage);
        Assert.False(prepaint.UsesCustomSelection);
        Assert.Equal(IntPtr.Zero, prepaint.Result);
        Assert.Equal(default, prepaint.Accent);
        Assert.Equal([0, 1], NativeManualPublishingCompanion.NativeWindow.SelectedOrdinals(listView));
    }

    private static IReadOnlyList<NativeListViewRowDrawProbe> ItemPrepaints(
        IReadOnlyList<NativeListViewRowDrawProbe> draws) =>
        draws.Where(draw => draw.Stage == 0x00010001).ToArray();

    private static IReadOnlyList<NativeListViewRowDrawProbe> ItemPostpaints(
        IReadOnlyList<NativeListViewRowDrawProbe> draws) =>
        draws.Where(draw => draw.Stage == 0x00010002).ToArray();

    private static void AssertRowSelection(
        IReadOnlyList<NativeListViewRowDrawProbe> draws, NativeCompanionPalette palette,
        IReadOnlyList<int> selectedItems, int? focusedItem)
    {
        int[] expected = selectedItems.Order().ToArray();
        NativeListViewRowDrawProbe[] prepaints = ItemPrepaints(draws).ToArray();
        Assert.NotEmpty(prepaints);
        Assert.Equal(expected, prepaints.Where(draw => draw.Selected).Select(draw => draw.ItemIndex).Order());
        Assert.Equal(expected, ItemPostpaints(draws).Select(draw => draw.ItemIndex).Order());
        Assert.All(prepaints.Where(draw => draw.Selected), draw =>
        {
            Assert.True(draw.UsesCustomSelection);
            Assert.Equal(palette.SelectionBackground, draw.Background);
            Assert.Equal(palette.SelectionText, draw.Text);
            Assert.Equal(new IntPtr(0x00000002 | 0x00000010), draw.Result);
        });
        Assert.All(prepaints.Where(draw => !draw.Selected), draw =>
        {
            Assert.Equal(NativeCompanionTheme.SurfaceStyle(
                NativeCompanionSurfaceRole.Nested, palette).Background, draw.Background);
            Assert.Equal(palette.Text, draw.Text);
            Assert.Equal(new IntPtr(0x00000002), draw.Result);
        });
        Assert.Equal(focusedItem is null ? [] : [focusedItem.Value],
            prepaints.Where(draw => draw.KeyboardFocused).Select(draw => draw.ItemIndex));
        Assert.All(ItemPostpaints(draws), draw =>
        {
            Assert.Equal(0, draw.Accent.X);
            Assert.True(draw.Accent.Width > 0);
            Assert.True(draw.Accent.Height > 0);
        });
    }

    private static void AssertHeaderCustomDrawStages(IReadOnlyList<NativeHeaderDrawStageProbe> draws)
    {
        Assert.Contains(draws, draw =>
            draw.Stage == 0x00000001 && draw.Result == new IntPtr(0x00000020 | 0x00000010));
        Assert.True(5 == draws.Count(draw =>
                draw.Stage == 0x00010001 && draw.Result == new IntPtr(0x00000004)),
            string.Join(", ", draws.Select(draw => $"0x{draw.Stage:X8}=0x{draw.Result.ToInt64():X}")));
        Assert.Contains(draws, draw => draw.Stage == 0x00000002);
    }

    [Fact]
    public async Task NativeHeaderCustomDraw_RepeatedOpenCloseKeepsGuiResourceCountsStable()
    {
        async Task ExerciseAsync()
        {
            await using var harness = await ProductionHeaderHarness.StartAsync(Model(Prepared(1, "a.png", true)));
            AssertHeaderCustomDrawStages(harness.Window.PaintHeaderForTesting(NativeCompanionPalette.Dark));
            AssertHeaderCustomDrawStages(harness.Window.PaintHeaderForTesting(NativeCompanionPalette.Light));
            Assert.NotEmpty(harness.Window.PaintAssetRowsForTesting(NativeCompanionPalette.Dark, 96, true));
            Assert.NotEmpty(harness.Window.PaintAssetRowsForTesting(NativeCompanionPalette.Light, 192, false));
            IReadOnlyList<IntPtr> darkButtons = harness.Window.ApplyThemeAndCaptureButtonHandlesForTesting(
                NativeCompanionPalette.Dark);
            Assert.Equal(darkButtons, harness.Window.ApplyThemeAndCaptureButtonHandlesForTesting(
                NativeCompanionPalette.Light));
            Assert.Equal(darkButtons, harness.Window.ApplyThemeAndCaptureButtonHandlesForTesting(
                NativeCompanionPalette.Dark));
            IntPtr platform = harness.Window.CapturePlatformComboForTesting().Handle;
            int selectionFieldHeight = harness.Window.CapturePlatformComboForTesting().SelectionFieldHeight;
            foreach ((NativeCompanionPalette palette, int dpi) in new[]
                     {
                         (NativeCompanionPalette.Dark, 96),
                         (NativeCompanionPalette.Light, 144),
                         (NativeCompanionPalette.HighContrast, 192),
                         (NativeCompanionPalette.Dark, 96),
                     })
            {
                NativePlatformComboProbe themed =
                    harness.Window.ApplyThemeAndCapturePlatformForTesting(palette, dpi);
                Assert.Equal(platform, themed.Handle);
                Assert.Equal(NativeCompanionTheme.ComboItemHeight(dpi), themed.ListItemHeight);
                Assert.Equal(selectionFieldHeight, themed.SelectionFieldHeight);
                Assert.True(harness.Window.ShowPlatformDropdownForTesting(show: true).Dropped);
                Assert.False(harness.Window.ShowPlatformDropdownForTesting(show: false).Dropped);
            }
        }

        static void CollectFinalizers()
        {
            GC.Collect();
            GC.WaitForPendingFinalizers();
            GC.Collect();
        }

        for (int warmup = 0; warmup < 10; warmup++) await ExerciseAsync();
        CollectFinalizers();
        uint gdiBefore = GetGuiResources(GetCurrentProcess(), 0);
        uint userBefore = GetGuiResources(GetCurrentProcess(), 1);
        for (int iteration = 0; iteration < 5; iteration++) await ExerciseAsync();
        CollectFinalizers();
        uint gdiAfter = GetGuiResources(GetCurrentProcess(), 0);
        uint userAfter = GetGuiResources(GetCurrentProcess(), 1);

        Assert.True(gdiAfter <= gdiBefore + 1, $"GDI resources grew from {gdiBefore} to {gdiAfter}.");
        Assert.True(userAfter <= userBefore + 1, $"USER resources grew from {userBefore} to {userAfter}.");
    }

    [Fact]
    public void ThreeAvailableRows_StartSelectedWithCountAndDragGuidance()
    {
        var model = Model(Prepared(1, "a.png", true), Prepared(2, "b.png", true), Prepared(3, "c.png", true));
        using var harness = new NotificationHarness(model);
        Assert.Equal([0, 1, 2], harness.NativeSelection);
        Assert.Equal("3 of 3 selected", harness.CountText);
        Assert.Equal("Drag any selected file to attach all selected files.", harness.GuidanceText);
    }

    [Fact]
    public async Task ProductionPreviewMessage_ReplacesRealPngPlaceholderWithoutChangingSelectionOrIdentity()
    {
        using NativePreviewOwnedPngFixture fixture = await NativePreviewOwnedPngFixture.CreateAsync();
        var model = Model(fixture.Prepared);
        using var harness = new NotificationHarness(model, fixture.CreateAccess());
        harness.SetSelection(0);

        harness.StartPreviews();
        int placeholder = Assert.IsType<int>(
            NativeManualPublishingCompanion.NativeWindow.ItemImage(harness.ListView, 0));
        Assert.True(placeholder >= 0);
        Assert.True(harness.WaitForPreview(TimeSpan.FromSeconds(10)));
        int thumbnail = Assert.IsType<int>(
            NativeManualPublishingCompanion.NativeWindow.ItemImage(harness.ListView, 0));

        Assert.True(thumbnail > placeholder);
        Assert.Equal(0, NativeManualPublishingCompanion.NativeWindow.ItemOrdinal(harness.ListView, 0));
        Assert.Equal([0], harness.NativeSelection);
        Assert.Equal([0], model.SelectedOrdinals);
        Assert.Equal("1 of 1 selected", harness.CountText);
    }

    [Fact]
    public void PreviewImagesPopulateFirstColumnWithoutChangingOrdinalIdentityOrSelection()
    {
        var model = Model(Prepared(1, "a.png", true), Prepared(2, "b.png", false), Prepared(3, "c.png", true));
        using var harness = new NotificationHarness(model);
        harness.SetSelection(0, 2);

        NativeManualPublishingCompanion.NativeWindow.PopulateAssetRows(
            harness.ListView, model.AssetRows, row => row.IsAvailable ? 4 : 5);
        NativeManualPublishingCompanion.NativeWindow.SetNativeSelection(
            harness.ListView, new HashSet<int> { 0, 2 }, model.Platform.Assets.Count);

        Assert.Equal([0, 1, 2], Enumerable.Range(0, 3)
            .Select(index => NativeManualPublishingCompanion.NativeWindow.ItemOrdinal(harness.ListView, index)));
        Assert.Equal([4, 5, 4], Enumerable.Range(0, 3)
            .Select(index => NativeManualPublishingCompanion.NativeWindow.ItemImage(harness.ListView, index)));
        Assert.Equal([0, 2], harness.NativeSelection);
        NativeManualPublishingCompanion.NativeWindow.SetItemImage(harness.ListView, 2, 9);
        Assert.Equal(9, NativeManualPublishingCompanion.NativeWindow.ItemImage(harness.ListView, 2));
        Assert.Equal([0, 2], harness.NativeSelection);
        Assert.Equal("2 of 3 selected", model.SelectedCountText);
        harness.BeginDrag(2);
        Assert.Equal([0, 2], Assert.Single(harness.CoordinatorSelections).Select(asset => asset.Ordinal));
    }

    [Fact]
    public void InitialAvailableSelection_BeginDragNotificationStartsCoordinatorWithAuthoritativeImmutableSnapshot()
    {
        ManualPreparedAsset[] assets =
        [
            Prepared(1, "a.png", true), Prepared(2, "b.png", true),
            Prepared(3, "c.png", true), Prepared(4, "d.png", true),
        ];
        var model = new ManualPublishingCompanionModel(Session(
            new ManualPreparedPlatform("patreon", "Release", "Body", assets),
            new ManualPreparedPlatform("x", "Release", "Post", [Prepared(5, "x.png", true)])));
        using var harness = new NotificationHarness(model);

        Assert.Equal([0, 1, 2, 3], harness.NativeSelection);
        Assert.Equal("4 of 4 selected", harness.CountText);
        harness.BeginDrag(1);

        IReadOnlyList<ManualDragAsset> snapshot = Assert.Single(harness.CoordinatorSelections);
        Assert.Equal([0, 1, 2, 3], snapshot.Select(asset => asset.Ordinal));
        Assert.Equal(["a.png", "b.png", "c.png", "d.png"], snapshot.Select(asset => asset.Prepared.Asset.Filename));

        harness.SetSelection(3);
        model.SelectPlatform(1);
        harness.RestorePlatformSelection();
        Assert.Equal([0, 1, 2, 3], snapshot.Select(asset => asset.Ordinal));
        Assert.Equal(["a.png", "b.png", "c.png", "d.png"], snapshot.Select(asset => asset.Prepared.Asset.Filename));
    }

    [Fact]
    public void CtrlSelection_BeginDragNotificationUsesNativeSetInAuthoritativeOrder()
    {
        var model = Model(Prepared(1, "a.png", true), Prepared(2, "b.png", true),
            Prepared(3, "c.png", true), Prepared(4, "d.png", true));
        using var harness = new NotificationHarness(model);

        harness.SetSelection(3, 1);
        Assert.Equal([1, 3], harness.NativeSelection);
        harness.BeginDrag(3);

        Assert.Equal([1, 3], Assert.Single(harness.CoordinatorSelections).Select(asset => asset.Ordinal));
    }

    [Fact]
    public void ShiftRange_BeginDragNotificationUsesCompleteNativeRange()
    {
        var model = Model(
            Prepared(1, "a.png", true), Prepared(2, "b.png", true), Prepared(3, "c.png", true),
            Prepared(4, "d.png", true), Prepared(5, "e.png", true));
        using var harness = new NotificationHarness(model);

        harness.SetSelection(1, 2, 3, 4);
        harness.BeginDrag(3);

        Assert.Equal([1, 2, 3, 4], Assert.Single(harness.CoordinatorSelections).Select(asset => asset.Ordinal));
    }

    [Fact]
    public void DragUnselectedRow_UsesNativeSelectionAfterListViewSelectionSemantics()
    {
        var model = Model(Prepared(1, "a.png", true), Prepared(2, "b.png", true), Prepared(3, "c.png", true));
        using var harness = new NotificationHarness(model);
        harness.SetSelection(0, 2);

        harness.SetSelection(1);
        harness.BeginDrag(1);

        Assert.Equal([1], Assert.Single(harness.CoordinatorSelections).Select(asset => asset.Ordinal));
    }

    [Fact]
    public void UnavailableManualSelection_RemainsNativeAndRejectsWholeDragWithFeedback()
    {
        var model = Model(Prepared(1, "a.png", true), Prepared(2, "b.png", false), Prepared(3, "c.png", true));
        using var harness = new NotificationHarness(model);

        harness.SetSelection(0, 1);
        Assert.Equal([0, 1], harness.NativeSelection);
        Assert.Equal([0, 1], model.SelectedOrdinals);
        Assert.Equal("2 of 3 selected", model.SelectedCountText);

        harness.BeginDrag(1);

        Assert.Empty(harness.CoordinatorSelections);
        Assert.Equal([0, 1], harness.NativeSelection);
        Assert.Equal("Selected files include unavailable media.", harness.StatusText);
    }

    [Fact]
    public void InitialSelection_ExcludesUnavailableRowAndDragsAllAvailableRows()
    {
        var model = Model(Prepared(1, "a.png", true), Prepared(2, "b.png", false), Prepared(3, "c.png", true));
        using var harness = new NotificationHarness(model);
        Assert.Equal([0, 2], harness.NativeSelection);
        Assert.Equal("2 of 3 selected", harness.CountText);
        Assert.Equal("Drag any selected file to attach all selected files.", harness.GuidanceText);
        harness.BeginDrag(0);
        Assert.Equal([0, 2], Assert.Single(harness.CoordinatorSelections).Select(asset => asset.Ordinal));
    }

    [Fact]
    public void NativeSelection_UpdatesCountAndGuidanceForUnavailableAndZeroSets()
    {
        var model = Model(Prepared(1, "a.png", true), Prepared(2, "b.png", false), Prepared(3, "c.png", true));
        using var harness = new NotificationHarness(model);
        Assert.Equal([0, 2], harness.NativeSelection);
        Assert.Equal("2 of 3 selected", harness.CountText);

        harness.SetSelection(0, 1, 2);
        Assert.Equal([0, 1, 2], harness.NativeSelection);
        Assert.Equal("3 of 3 selected", harness.CountText);
        Assert.Equal("Selection includes unavailable files and cannot be dragged.", harness.GuidanceText);

        harness.SetSelection();
        Assert.Equal("0 of 3 selected", harness.CountText);
        Assert.Equal("Select files to attach.", harness.GuidanceText);
        harness.BeginDrag(0);
        Assert.Empty(harness.CoordinatorSelections);
    }

    [Fact]
    public void AvailabilityChangeAfterSelection_PreservesNativeSetAndRejectsBeforeCoordinator()
    {
        ManualPreparedAsset[] assets = [Prepared(1, "a.png", true), Prepared(2, "b.png", true)];
        var model = Model(assets);
        using var harness = new NotificationHarness(model);
        harness.SetSelection(0, 1);

        assets[1] = Prepared(2, "b.png", false);
        harness.RestorePlatformSelection();
        Assert.Equal("2 of 2 selected", harness.CountText);
        Assert.Equal("Selection includes unavailable files and cannot be dragged.", harness.GuidanceText);
        harness.BeginDrag(0);

        Assert.Equal([0, 1], harness.NativeSelection);
        Assert.Equal([0, 1], model.SelectedOrdinals);
        Assert.Empty(harness.CoordinatorSelections);
        Assert.Equal("Selected files include unavailable media.", harness.StatusText);
    }

    [Fact]
    public void SelectionChangeAndBackgroundNotification_DoNotStartCoordinator()
    {
        var model = Model(Prepared(1, "a.png", true), Prepared(2, "b.png", true));
        using var harness = new NotificationHarness(model);

        harness.SetSelection(1);
        Assert.Equal([1], harness.NativeSelection);
        Assert.Equal([1], model.SelectedOrdinals);
        Assert.Equal("1 of 2 selected", model.SelectedCountText);
        Assert.Empty(harness.CoordinatorSelections);

        harness.BeginDrag(-1);
        Assert.Empty(harness.CoordinatorSelections);
    }

    [Fact]
    public void PlatformSwitch_RestoresStableUnavailableSelectionAndRejectsItsDrag()
    {
        ManualPreparedAsset[] patreon =
            [Prepared(1, "a.png", true), Prepared(2, "b.png", false), Prepared(3, "c.png", true)];
        ManualPreparedAsset[] x = [Prepared(4, "x.png", true), Prepared(5, "y.png", true)];
        var model = new ManualPublishingCompanionModel(Session(
            new ManualPreparedPlatform("patreon", "Release", "Body", patreon),
            new ManualPreparedPlatform("x", "Release", "Post", x)));
        using var harness = new NotificationHarness(model);

        harness.SetSelection(0, 1);
        model.SelectPlatform(1);
        harness.RestorePlatformSelection();
        Assert.Equal("2 of 2 selected", harness.CountText);
        harness.SetSelection(1);
        model.SelectPlatform(0);
        harness.RestorePlatformSelection();

        Assert.Equal([0, 1], harness.NativeSelection);
        Assert.Equal("2 of 3 selected", model.SelectedCountText);
        Assert.Equal("2 of 3 selected", harness.CountText);
        Assert.Equal("Selection includes unavailable files and cannot be dragged.", harness.GuidanceText);
        harness.BeginDrag(0);
        Assert.Empty(harness.CoordinatorSelections);
        Assert.Equal("Selected files include unavailable media.", harness.StatusText);
    }

    private static ManualPublishingCompanionModel Model(params ManualPreparedAsset[] assets) =>
        new(Session(new ManualPreparedPlatform("x", "Release", "Post", assets)));

    private static ManualSocialSession Session(params ManualPreparedPlatform[] platforms) =>
        new(new Uri("https://creatorcrate.test/"), 42, "Release title", platforms);

    private static ManualPreparedAsset Prepared(long id, string filename, bool present) =>
        new(new SocialRedeemAsset(id, "attachment", id, filename, ".png", "image/png", id * 100,
            $"release/{filename}", present, null), present ? $@"C:\stage\{filename}" : string.Empty,
            StagedMediaProvenance.HelperOwned);

    private sealed class ProductionHeaderHarness : IAsyncDisposable
    {
        private readonly TaskCompletionSource<Exception?> _closed = new(TaskCreationOptions.RunContinuationsAsynchronously);
        private readonly Thread _thread;

        private ProductionHeaderHarness(ManualPublishingCompanionModel model)
        {
            Lifecycle = new ManualCompanionLifecycle();
            Window = new NativeManualPublishingCompanion.NativeWindow(
                model, Lifecycle, confirmation: null, disableWinUiForNativeOnlyTests: true);
            _thread = new Thread(Run) { IsBackground = true, Name = "Native header custom-draw test" };
            _thread.SetApartmentState(ApartmentState.STA);
        }

        public NativeManualPublishingCompanion.NativeWindow Window { get; }
        private ManualCompanionLifecycle Lifecycle { get; }
        public IntPtr Header => Window.AssetHeaderHandleForTesting;
        public string HeaderClassName
        {
            get
            {
                var value = new System.Text.StringBuilder(64);
                GetClassName(Header, value, value.Capacity);
                return value.ToString();
            }
        }
        public IReadOnlyList<string> HeaderTexts => Enumerable.Range(0,
            SendMessage(Header, 0x1200, IntPtr.Zero, IntPtr.Zero).ToInt32()).Select(HeaderText).ToArray();

        public static async Task<ProductionHeaderHarness> StartAsync(ManualPublishingCompanionModel model)
        {
            var harness = new ProductionHeaderHarness(model);
            harness._thread.Start();
            await harness.Lifecycle.Ready.WaitAsync(TimeSpan.FromSeconds(5));
            return harness;
        }

        public async ValueTask DisposeAsync()
        {
            if (!_closed.Task.IsCompleted) Window.RequestClose();
            Exception? failure = await _closed.Task.WaitAsync(TimeSpan.FromSeconds(5));
            Assert.True(_thread.Join(TimeSpan.FromSeconds(5)));
            if (failure is not null) throw failure;
        }

        private string HeaderText(int index)
        {
            IntPtr buffer = Marshal.AllocHGlobal(512);
            try
            {
                var item = new HeaderItem { mask = 0x0002, pszText = buffer, cchTextMax = 256 };
                Assert.NotEqual(IntPtr.Zero,
                    SendMessageHeaderItem(Header, 0x1200 + 11, new IntPtr(index), ref item));
                return Marshal.PtrToStringUni(buffer) ?? string.Empty;
            }
            finally { Marshal.FreeHGlobal(buffer); }
        }

        private void Run()
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

    private sealed class NoOpLease : IDisposable { public void Dispose() { } }

    private sealed class NotificationHarness : IDisposable
    {
        private const uint WmNotify = 0x004E;
        private const uint WsChildVisible = 0x50000000;
        private static readonly SubclassProc ParentProcedure = ParentWindowProcedure;
        private readonly ManualPublishingCompanionModel _model;
        private readonly NativeManualPublishingCompanion.NativeWindow _window;
        private readonly GCHandle _self;
        private Exception? _callbackFailure;

        public NotificationHarness(
            ManualPublishingCompanionModel model,
            IManualAssetPreviewAccess? previewAccess = null)
        {
            _model = model;
            var controls = new InitCommonControls
                { dwSize = (uint)Marshal.SizeOf<InitCommonControls>(), dwICC = 0x00000001 };
            Assert.True(InitCommonControlsEx(ref controls));
            Parent = CreateWindowEx(0, "Static", string.Empty, 0, 0, 0, 1000, 400,
                IntPtr.Zero, IntPtr.Zero, IntPtr.Zero, IntPtr.Zero);
            Assert.NotEqual(IntPtr.Zero, Parent);
            ListView = CreateWindowEx(0, "SysListView32", string.Empty,
                WsChildVisible | NativeManualPublishingCompanion.NativeWindow.AssetListStyle,
                0, 0, 1000, 400, Parent, new IntPtr(206), IntPtr.Zero, IntPtr.Zero);
            Assert.NotEqual(IntPtr.Zero, ListView);
            AssetCount = CreateWindowEx(0, "Static", string.Empty, WsChildVisible,
                0, 0, 160, 20, Parent, IntPtr.Zero, IntPtr.Zero, IntPtr.Zero);
            DragGuidance = CreateWindowEx(0, "Static", string.Empty, WsChildVisible,
                0, 0, 600, 20, Parent, IntPtr.Zero, IntPtr.Zero, IntPtr.Zero);
            Assert.NotEqual(IntPtr.Zero, AssetCount);
            Assert.NotEqual(IntPtr.Zero, DragGuidance);

            _window = new NativeManualPublishingCompanion.NativeWindow(
                model, RejectingAvailability.Instance, lifecycle: null,
                tryBeginDrag: selected => { CoordinatorSelections.Add(selected); return true; },
                dragSessionAvailable: () => true,
                previewAccess: previewAccess);
            _window.AttachNotificationHarness(Parent, ListView, AssetCount, DragGuidance);
            _self = GCHandle.Alloc(this);
            Assert.True(SetWindowSubclass(Parent, ParentProcedure, UIntPtr.Zero, GCHandle.ToIntPtr(_self)));
            NativeManualPublishingCompanion.NativeWindow.ConfigureAssetList(ListView, 96);
            _window.RestorePlatformSelectionForTesting();
        }

        public IntPtr Parent { get; }
        public IntPtr ListView { get; }
        public IntPtr AssetCount { get; }
        public IntPtr DragGuidance { get; }
        public List<IReadOnlyList<ManualDragAsset>> CoordinatorSelections { get; } = [];
        public SemaphoreSlim PreviewApplied { get; } = new(0);
        public IReadOnlyList<int> NativeSelection =>
            NativeManualPublishingCompanion.NativeWindow.SelectedOrdinals(ListView);
        public string StatusText => _window.StatusText;
        public string CountText => Text(AssetCount);
        public string GuidanceText => Text(DragGuidance);

        private static string Text(IntPtr window)
        {
            var value = new System.Text.StringBuilder(256);
            GetWindowText(window, value, value.Capacity);
            return value.ToString();
        }

        public void SetSelection(params int[] ordinals)
        {
            NativeManualPublishingCompanion.NativeWindow.SetNativeSelection(
                ListView, ordinals.ToHashSet(), _model.Platform.Assets.Count);
            ThrowIfCallbackFailed();
        }

        public void RestorePlatformSelection()
        {
            _window.RestorePlatformSelectionForTesting();
            ThrowIfCallbackFailed();
        }

        public void BeginDrag(int itemIndex)
        {
            var notification = new NotifyListView
            {
                hdr = new NotifyHeader
                    { hwndFrom = ListView, idFrom = new UIntPtr(206), code = NativeManualPublishingCompanion.NativeWindow.LvnBeginDrag },
                iItem = itemIndex,
            };
            IntPtr pointer = Marshal.AllocHGlobal(Marshal.SizeOf<NotifyListView>());
            try
            {
                Marshal.StructureToPtr(notification, pointer, false);
                SendMessage(Parent, WmNotify, new IntPtr(206), pointer);
            }
            finally { Marshal.FreeHGlobal(pointer); }
            ThrowIfCallbackFailed();
        }

        public void StartPreviews()
        {
            _window.StartPreviewsForTesting(96);
            ThrowIfCallbackFailed();
        }

        public bool WaitForPreview(TimeSpan timeout)
        {
            DateTime deadline = DateTime.UtcNow + timeout;
            while (DateTime.UtcNow < deadline)
            {
                while (PeekMessage(out NativeMessage message, IntPtr.Zero, 0, 0, 1))
                {
                    TranslateMessage(ref message);
                    DispatchMessage(ref message);
                }
                ThrowIfCallbackFailed();
                if (PreviewApplied.Wait(0)) return true;
                Thread.Yield();
            }
            return false;
        }

        public void Dispose()
        {
            _window.StopPreviewsForTesting().AsTask().GetAwaiter().GetResult();
            _window.DisposeThemeForTesting();
            RemoveWindowSubclass(Parent, ParentProcedure, UIntPtr.Zero);
            if (_self.IsAllocated) _self.Free();
            if (Parent != IntPtr.Zero) Assert.True(DestroyWindow(Parent));
        }

        private void ThrowIfCallbackFailed()
        {
            if (_callbackFailure is not null)
                throw new InvalidOperationException("Notification harness callback failed.", _callbackFailure);
        }

        private static IntPtr ParentWindowProcedure(
            IntPtr window, uint message, IntPtr wParam, IntPtr lParam, UIntPtr subclassId, IntPtr reference)
        {
            var harness = (NotificationHarness?)GCHandle.FromIntPtr(reference).Target;
            if (harness is null) return DefSubclassProc(window, message, wParam, lParam);
            try
            {
                if (message == WmNotify)
                    return harness._window.HandleNotifyForTesting(lParam);
                if (message == NativeManualPublishingCompanion.NativeWindow.PreviewReadyMessage)
                {
                    harness._window.HandlePreviewReadyForTesting();
                    harness.PreviewApplied.Release();
                    return IntPtr.Zero;
                }
            }
            catch (Exception exception) { harness._callbackFailure = exception; }
            return DefSubclassProc(window, message, wParam, lParam);
        }
    }

    private sealed class RejectingAvailability : IManualAssetAvailability
    {
        public static RejectingAvailability Instance { get; } = new();
        public Task<ManualDragPreparation> PrepareAsync(
            IReadOnlyList<ManualDragAsset> selected, CancellationToken cancellationToken) =>
            Task.FromResult(ManualDragPreparation.Fail("unexpected_test_coordinator_call"));
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct InitCommonControls { public uint dwSize, dwICC; }

    [StructLayout(LayoutKind.Sequential)]
    private struct Point { public int x, y; }

    [StructLayout(LayoutKind.Sequential)]
    private struct Rect { public int left, top, right, bottom; }

    [StructLayout(LayoutKind.Sequential)]
    private struct NotifyHeader { public IntPtr hwndFrom; public UIntPtr idFrom; public int code; }

    [StructLayout(LayoutKind.Sequential)]
    private struct NotifyListView
    {
        public NotifyHeader hdr;
        public int iItem, iSubItem;
        public uint uNewState, uOldState, uChanged;
        public Point ptAction;
        public IntPtr lParam;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct HeaderItem
    {
        public uint mask;
        public int cxy;
        public IntPtr pszText, hbm;
        public int cchTextMax, fmt;
        public IntPtr lParam;
        public int iImage, iOrder;
        public uint type;
        public IntPtr pvFilter;
        public uint state;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct NativeMessage
    {
        public IntPtr hwnd;
        public uint message;
        public UIntPtr wParam;
        public IntPtr lParam;
        public uint time;
        public Point pt;
    }

    [UnmanagedFunctionPointer(CallingConvention.Winapi)]
    private delegate IntPtr SubclassProc(
        IntPtr window, uint message, IntPtr wParam, IntPtr lParam, UIntPtr subclassId, IntPtr reference);

    [DllImport("comctl32.dll", SetLastError = true)]
    private static extern bool InitCommonControlsEx(ref InitCommonControls controls);

    [DllImport("kernel32.dll")]
    private static extern IntPtr GetCurrentProcess();

    [DllImport("kernel32.dll")]
    private static extern void SetLastError(uint errorCode);

    [DllImport("user32.dll")]
    private static extern uint GetGuiResources(IntPtr process, uint flags);

    [DllImport("comctl32.dll", SetLastError = true)]
    private static extern bool SetWindowSubclass(
        IntPtr window, SubclassProc callback, UIntPtr subclassId, IntPtr reference);

    [DllImport("comctl32.dll", SetLastError = true)]
    private static extern bool RemoveWindowSubclass(IntPtr window, SubclassProc callback, UIntPtr subclassId);

    [DllImport("comctl32.dll")]
    private static extern IntPtr DefSubclassProc(IntPtr window, uint message, IntPtr wParam, IntPtr lParam);

    [DllImport("user32.dll", EntryPoint = "CreateWindowExW", CharSet = CharSet.Unicode, ExactSpelling = true, SetLastError = true)]
    private static extern IntPtr CreateWindowEx(uint extendedStyle, string className, string title, uint style,
        int x, int y, int width, int height, IntPtr parent, IntPtr menu, IntPtr instance, IntPtr parameter);

    [DllImport("user32.dll", EntryPoint = "SendMessageW", ExactSpelling = true)]
    private static extern IntPtr SendMessage(IntPtr window, uint message, IntPtr wParam, IntPtr lParam);

    [DllImport("user32.dll", EntryPoint = "SendMessageW", ExactSpelling = true)]
    private static extern bool SendMessageHeaderRect(IntPtr window, uint message, IntPtr wParam, out Rect rectangle);

    [DllImport("user32.dll")]
    private static extern bool GetClientRect(IntPtr window, out Rect rectangle);

    [DllImport("user32.dll", SetLastError = true)]
    private static extern int MapWindowPoints(IntPtr from, IntPtr to, [In, Out] Point[] points, uint count);

    [DllImport("user32.dll", EntryPoint = "SendMessageW", ExactSpelling = true)]
    private static extern IntPtr SendMessageHeaderItem(IntPtr window, uint message, IntPtr wParam, ref HeaderItem item);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern int GetClassName(IntPtr window, System.Text.StringBuilder className, int maximum);

    [DllImport("user32.dll", EntryPoint = "GetWindowTextW", CharSet = CharSet.Unicode, ExactSpelling = true)]
    private static extern int GetWindowText(IntPtr window, System.Text.StringBuilder value, int maximum);

    [DllImport("user32.dll", EntryPoint = "PeekMessageW", ExactSpelling = true)]
    private static extern bool PeekMessage(out NativeMessage message, IntPtr window, uint minimum, uint maximum, uint remove);

    [DllImport("user32.dll")]
    private static extern bool TranslateMessage(ref NativeMessage message);

    [DllImport("user32.dll", EntryPoint = "DispatchMessageW", ExactSpelling = true)]
    private static extern IntPtr DispatchMessage(ref NativeMessage message);

    [DllImport("user32.dll")]
    private static extern bool DestroyWindow(IntPtr window);
}

[CollectionDefinition("Native header resource isolation", DisableParallelization = true)]
public sealed class NativeHeaderResourceIsolationCollection;
