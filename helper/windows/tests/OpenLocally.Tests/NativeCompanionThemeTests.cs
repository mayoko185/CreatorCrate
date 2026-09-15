using OpenLocally;
using Microsoft.UI.Xaml;

namespace OpenLocally.Tests;

public sealed class NativeCompanionThemeTests
{
    [Fact]
    public void DarkPalette_MatchesAuthoritativeCreatorCrateCssTokens()
    {
        NativeCompanionPalette palette = NativeCompanionPalette.Choose(highContrast: false, appsUseLightTheme: false);

        Assert.Equal(NativeCompanionThemeMode.Dark, palette.Mode);
        Assert.Equal("#0d0f13", NativeCompanionPalette.Hex(palette.Page));
        Assert.Equal("#171b22", NativeCompanionPalette.Hex(palette.Surface));
        Assert.Equal("#1d222b", NativeCompanionPalette.Hex(palette.Card));
        Assert.Equal("#232a38", NativeCompanionPalette.Hex(palette.Hover));
        Assert.Equal("#262c37", NativeCompanionPalette.Hex(palette.Border));
        Assert.Equal("#3a4353", NativeCompanionPalette.Hex(palette.BorderStrong));
        Assert.Equal("#e8ecf1", NativeCompanionPalette.Hex(palette.Text));
        Assert.Equal("#8b93a3", NativeCompanionPalette.Hex(palette.MutedText));
        Assert.Equal("#22d3ee", NativeCompanionPalette.Hex(palette.Accent));
        Assert.Equal("#a78bfa", NativeCompanionPalette.Hex(palette.AccentSecondary));
        Assert.Equal("#58a6ff", NativeCompanionPalette.Hex(palette.Focus));
        Assert.Equal("#34d399", NativeCompanionPalette.Hex(palette.Success));
        Assert.Equal("#fb7185", NativeCompanionPalette.Hex(palette.Danger));

        string css = File.ReadAllText(Path.Combine(FindRepositoryRoot(), "src", "static", "creatorcrate.css"));
        Assert.Contains("--bg: #0d0f13;", css);
        Assert.Contains("--surface: #171b22;", css);
        Assert.Contains("--surface-card: #1d222b;", css);
        Assert.Contains("--text: #e8ecf1;", css);
        Assert.Contains("--accent: #22d3ee;", css);
        Assert.Contains("--accent-2: #a78bfa;", css);
        Assert.Contains("--focus-ring: #58a6ff;", css);
    }

    [Fact]
    public void LightPalette_IsARestrainedCreatorCrateAdaptation()
    {
        NativeCompanionPalette palette = NativeCompanionPalette.Choose(highContrast: false, appsUseLightTheme: true);

        Assert.Equal(NativeCompanionThemeMode.Light, palette.Mode);
        Assert.Equal("#f5f7fa", NativeCompanionPalette.Hex(palette.Page));
        Assert.Equal("#ffffff", NativeCompanionPalette.Hex(palette.Surface));
        Assert.Equal("#f8fafc", NativeCompanionPalette.Hex(palette.Card));
        Assert.Equal("#0891b2", NativeCompanionPalette.Hex(palette.Accent));
        Assert.Equal("#7c3aed", NativeCompanionPalette.Hex(palette.AccentSecondary));
        Assert.True(palette.UsesDecorativeColors);
    }

    [Fact]
    public void WinUiTextSurfacePalettes_MapCreatorCrateCardSurfaceBorderAndFocusHierarchy()
    {
        WinUiTextSurfacePalette dark = WinUiTextSurfacePresentation.Palette(ElementTheme.Dark);
        WinUiTextSurfacePalette light = WinUiTextSurfacePresentation.Palette(ElementTheme.Light);

        Assert.Equal("#1d222b", NativeCompanionPalette.Hex(dark.RootBackground));
        Assert.Equal("#171b22", NativeCompanionPalette.Hex(dark.Background));
        Assert.Equal("#e8ecf1", NativeCompanionPalette.Hex(dark.Foreground));
        Assert.Equal("#262c37", NativeCompanionPalette.Hex(dark.Border));
        Assert.Equal("#3a4353", NativeCompanionPalette.Hex(dark.PointerBorder));
        Assert.Equal("#58a6ff", NativeCompanionPalette.Hex(dark.FocusBorder));

        Assert.Equal("#f8fafc", NativeCompanionPalette.Hex(light.RootBackground));
        Assert.Equal("#ffffff", NativeCompanionPalette.Hex(light.Background));
        Assert.Equal("#17202b", NativeCompanionPalette.Hex(light.Foreground));
        Assert.Equal("#d7dee8", NativeCompanionPalette.Hex(light.Border));
        Assert.Equal("#aab6c5", NativeCompanionPalette.Hex(light.PointerBorder));
        Assert.Equal("#0969da", NativeCompanionPalette.Hex(light.FocusBorder));
        Assert.Throws<ArgumentOutOfRangeException>(() =>
            WinUiTextSurfacePresentation.Palette(ElementTheme.Default));
    }

    [Fact]
    public void WinUiTextSurfaceTypographySpacingAndChrome_AreEffectivePixelValues()
    {
        Assert.Equal("Segoe UI Variable Text", WinUiTextSurfacePresentation.FontFamily);
        Assert.Equal(16, WinUiTextSurfacePresentation.BodyFontSize);
        Assert.Equal(400, WinUiTextSurfacePresentation.BodyFontWeight);
        Assert.Equal(16, WinUiTextSurfacePresentation.TitleFontSize);
        Assert.Equal(600, WinUiTextSurfacePresentation.TitleFontWeight);
        Assert.Equal(12, WinUiTextSurfacePresentation.HorizontalPadding);
        Assert.Equal(8, WinUiTextSurfacePresentation.VerticalPadding);
        Assert.Equal(1, WinUiTextSurfacePresentation.BorderWidth);
        Assert.Equal(2, WinUiTextSurfacePresentation.FocusBorderWidth);
        Assert.Equal(6, WinUiTextSurfacePresentation.CornerRadius);
        Assert.Equal(1.35f, WinUiTextSurfacePresentation.LineSpacing);
    }

    [Theory]
    [InlineData(96)]
    [InlineData(144)]
    [InlineData(192)]
    public void WinUiTextSurfaceInsets_LeaveUsableMinimumContentAtSupportedDpi(int dpi)
    {
        NativeLayoutSize required = NativeCompanionLayout.SupportedMinimumLogicalClientSize;
        var client = new NativeLayoutSize(required.Width * dpi / 96, required.Height * dpi / 96);
        double scale = dpi / 96d;

        foreach (bool patreon in new[] { true, false })
        {
            NativeCompanionLayout layout = NativeCompanionLayout.Calculate(
                client.Width, client.Height, dpi, patreon);
            IEnumerable<NativeLayoutRect> surfaces = patreon
                ? new[] { layout.TitleText, layout.BodyText }
                : new[] { layout.BodyText };
            foreach (NativeLayoutRect surface in surfaces)
            {
                double usableWidth = surface.Width / scale -
                    2 * (WinUiTextSurfacePresentation.HorizontalPadding + WinUiTextSurfacePresentation.BorderWidth);
                double usableHeight = surface.Height / scale -
                    2 * (WinUiTextSurfacePresentation.VerticalPadding + WinUiTextSurfacePresentation.BorderWidth);
                Assert.True(usableWidth > 0);
                Assert.True(usableHeight > 0);
            }
        }
    }

    [Fact]
    public void HighContrast_OverridesDecorativeAppPalette()
    {
        NativeCompanionPalette palette = NativeCompanionPalette.Choose(highContrast: true, appsUseLightTheme: false);

        Assert.Equal(NativeCompanionThemeMode.HighContrast, palette.Mode);
        Assert.False(palette.UsesDecorativeColors);
        Assert.Equal(palette.SelectionBackground, palette.Accent);
        Assert.Equal(palette.SelectionText, palette.PrimaryButtonText);
    }

    [Fact]
    public void ChildThemeRoles_CoverTheCompanionAndListViewPalette()
    {
        NativeCompanionPalette palette = NativeCompanionPalette.Dark;

        Assert.Equal(palette.Page, NativeCompanionTheme.ControlStyle(NativeCompanionControlRole.TopLevel, palette).Background);
        Assert.Equal(NativeCompanionFontRole.Heading, NativeCompanionTheme.ControlStyle(NativeCompanionControlRole.Heading, palette).FontRole);
        Assert.Equal(palette.MutedText, NativeCompanionTheme.ControlStyle(NativeCompanionControlRole.Metadata, palette).Text);
        Assert.Equal(palette.Card, NativeCompanionTheme.ControlStyle(NativeCompanionControlRole.SectionHeading, palette).Background);
        Assert.Equal(palette.Page, NativeCompanionTheme.ControlStyle(NativeCompanionControlRole.Edit, palette).Background);
        Assert.True(NativeCompanionTheme.ControlStyle(NativeCompanionControlRole.Combo, palette).CustomDraw);
        Assert.True(NativeCompanionTheme.ControlStyle(NativeCompanionControlRole.PrimaryButton, palette).CustomDraw);
        Assert.True(NativeCompanionTheme.ControlStyle(NativeCompanionControlRole.Button, palette).CustomDraw);
        Assert.Equal(palette.Surface, NativeCompanionTheme.ControlStyle(NativeCompanionControlRole.Status, palette).Background);
        Assert.True(NativeCompanionTheme.ControlStyle(NativeCompanionControlRole.ListView, palette).CustomDraw);
        Assert.Equal(palette.Page, NativeCompanionTheme.ControlStyle(NativeCompanionControlRole.ListView, palette).Background);
        Assert.Equal(palette.Hover, NativeCompanionTheme.ControlStyle(NativeCompanionControlRole.ListViewHeader, palette).Background);
        Assert.True(NativeCompanionTheme.ControlStyle(NativeCompanionControlRole.ListViewHeader, palette).CustomDraw);
    }

    [Fact]
    public void HeaderChrome_UsesCreatorCrateRolesAndBypassesHighContrast()
    {
        NativeHeaderChromeStyle dark = NativeCompanionTheme.HeaderChromeStyle(NativeCompanionPalette.Dark);
        NativeHeaderChromeStyle light = NativeCompanionTheme.HeaderChromeStyle(NativeCompanionPalette.Light);
        NativeHeaderChromeStyle highContrast = NativeCompanionTheme.HeaderChromeStyle(NativeCompanionPalette.HighContrast);

        Assert.Equal(NativeCompanionPalette.Dark.Hover, dark.Background);
        Assert.Equal(NativeCompanionPalette.Dark.Text, dark.Text);
        Assert.Equal(NativeCompanionPalette.Dark.Border, dark.Divider);
        Assert.Equal(NativeCompanionPalette.Dark.BorderStrong, dark.BottomEdge);
        Assert.True(dark.CustomDraw);
        Assert.Equal(NativeCompanionPalette.Light.Hover, light.Background);
        Assert.Equal(NativeCompanionPalette.Light.Text, light.Text);
        Assert.Equal(NativeCompanionPalette.Light.Border, light.Divider);
        Assert.Equal(NativeCompanionPalette.Light.BorderStrong, light.BottomEdge);
        Assert.True(light.CustomDraw);
        Assert.False(highContrast.CustomDraw);
    }

    [Fact]
    public void ListViewSelectionChrome_UsesExistingThemeRolesAndScalesAccentOnce()
    {
        NativeListViewSelectionStyle dark =
            NativeCompanionTheme.ListViewSelectionStyle(NativeCompanionPalette.Dark);
        NativeListViewSelectionStyle light =
            NativeCompanionTheme.ListViewSelectionStyle(NativeCompanionPalette.Light);
        NativeListViewSelectionStyle highContrast =
            NativeCompanionTheme.ListViewSelectionStyle(NativeCompanionPalette.HighContrast);

        Assert.Equal(NativeCompanionPalette.Dark.SelectionBackground, dark.Background);
        Assert.Equal(NativeCompanionPalette.Dark.SelectionText, dark.Text);
        Assert.Equal(NativeCompanionPalette.Dark.Accent, dark.Accent);
        Assert.True(dark.CustomDraw);
        Assert.Equal(NativeCompanionPalette.Light.SelectionBackground, light.Background);
        Assert.Equal(NativeCompanionPalette.Light.Accent, light.Accent);
        Assert.True(light.CustomDraw);
        Assert.False(highContrast.CustomDraw);

        Assert.Equal(2, NativeCompanionTheme.ListViewSelectionAccentWidth(96));
        Assert.Equal(3, NativeCompanionTheme.ListViewSelectionAccentWidth(144));
        Assert.Equal(4, NativeCompanionTheme.ListViewSelectionAccentWidth(192));
        Assert.Equal(new NativeLayoutRect(0, 24, 3, 48),
            NativeCompanionTheme.ListViewSelectionAccentBounds(
                new NativeLayoutRect(0, 0, 800, 400),
                new NativeLayoutRect(-180, 24, 1100, 48), 144));
        Assert.Equal(default,
            NativeCompanionTheme.ListViewSelectionAccentBounds(
                new NativeLayoutRect(0, 0, 800, 400),
                new NativeLayoutRect(-180, 420, 1100, 48), 144));
    }

    [Theory]
    [InlineData(96, 8, 1)]
    [InlineData(144, 12, 1)]
    [InlineData(192, 16, 2)]
    public void HeaderGeometry_ScalesTextInsetsAndStrokesWithoutClipping(int dpi, int inset, int stroke)
    {
        var cell = new NativeLayoutRect(10, 0, 260 * dpi / 96, 28 * dpi / 96);
        NativeLayoutRect text = NativeCompanionTheme.HeaderTextBounds(cell, dpi);

        Assert.Equal(inset, text.X - cell.X);
        Assert.Equal(cell.Width - inset * 2, text.Width);
        Assert.Equal(cell.Height, text.Height);
        Assert.True(text.X >= cell.X && text.Right <= cell.Right);
        Assert.Equal(stroke, NativeCompanionTheme.HeaderStrokeWidth(dpi));
    }

    [Fact]
    public void HeaderTrailingBounds_UsesAlreadyNormalizedHeaderClientCoordinates()
    {
        var normal = new NativeLayoutRect(0, 0, 1000, 28);
        NativeLayoutRect trailing = NativeCompanionTheme.HeaderTrailingBounds(normal,
            [new(0, 0, 260, 28), new(260, 0, 100, 28), new(360, 0, 100, 28)]);
        NativeLayoutRect wide = NativeCompanionTheme.HeaderTrailingBounds(new(0, 0, 1400, 28),
            [new(0, 0, 260, 28), new(260, 0, 100, 28), new(360, 0, 100, 28)]);
        NativeLayoutRect exact = NativeCompanionTheme.HeaderTrailingBounds(normal,
            [new(0, 0, 600, 28), new(600, 0, 400, 28)]);
        NativeLayoutRect overflow = NativeCompanionTheme.HeaderTrailingBounds(normal,
            [new(0, 0, 700, 28), new(700, 0, 700, 28)]);
        NativeLayoutRect inverted = NativeCompanionTheme.HeaderTrailingBounds(
            new(20, 0, -10, 28), [new(0, 0, 30, 28)]);

        Assert.Equal(new NativeLayoutRect(460, 0, 540, 28), trailing);
        Assert.Equal(new NativeLayoutRect(460, 0, 940, 28), wide);
        Assert.Equal(new NativeLayoutRect(1000, 0, 0, 28), exact);
        Assert.Equal(new NativeLayoutRect(1000, 0, 0, 28), overflow);
        Assert.Equal(new NativeLayoutRect(20, 0, 0, 28), inverted);
    }

    [Theory]
    [InlineData((int)NativeCompanionFontRole.Heading, 16, 600)]
    [InlineData((int)NativeCompanionFontRole.SectionHeading, 9, 600)]
    [InlineData((int)NativeCompanionFontRole.Body, 10, 400)]
    [InlineData((int)NativeCompanionFontRole.Metadata, 9, 400)]
    public void Fonts_UseSegoeUiRolesInsteadOfDefaultGuiFont(
        int roleValue, int points, int weight)
    {
        NativeCompanionFontRole role = (NativeCompanionFontRole)roleValue;
        NativeCompanionFontSpec font = NativeCompanionTheme.FontSpec(role);

        Assert.Equal("Segoe UI", font.Family);
        Assert.Equal(points, font.PointSize);
        Assert.Equal(weight, font.Weight);
    }

    [Theory]
    [InlineData(96)]
    [InlineData(144)]
    [InlineData(192)]
    public void ThemeResources_RecreateFontsAndBrushesAcrossDpiChanges(int dpi)
    {
        using var theme = new NativeCompanionTheme(dpi);

        Assert.Equal(dpi, theme.Dpi);
        Assert.NotEqual(IntPtr.Zero, theme.Font(NativeCompanionFontRole.Heading));
        Assert.NotEqual(IntPtr.Zero, theme.Font(NativeCompanionFontRole.Body));
        Assert.NotEqual(IntPtr.Zero, theme.Font(NativeCompanionFontRole.Metadata));
        Assert.NotEqual(IntPtr.Zero, theme.Brush(theme.Palette.Page));

        theme.Refresh(dpi == 192 ? 96 : dpi + 48);
        Assert.NotEqual(IntPtr.Zero, theme.Font(NativeCompanionFontRole.SectionHeading));
        Assert.NotEqual(IntPtr.Zero, theme.Brush(theme.Palette.Card));
    }

    [Theory]
    [InlineData(96, "patreon")]
    [InlineData(144, "patreon")]
    [InlineData(192, "patreon")]
    [InlineData(96, "x")]
    [InlineData(144, "x")]
    [InlineData(192, "x")]
    [InlineData(96, "bluesky")]
    [InlineData(144, "bluesky")]
    [InlineData(192, "bluesky")]
    public void SupportedClientMinimum_ProvidesLayoutWithoutOverlapAtSupportedDpi(int dpi, string platform)
    {
        Assert.Equal(820, NativeCompanionLayout.SupportedMinimumLogicalClientWidth);
        Assert.Equal(754, NativeCompanionLayout.RequiredLogicalClientHeight);
        NativeLayoutSize required = NativeCompanionLayout.SupportedMinimumLogicalClientSize;
        var client = new NativeLayoutSize(required.Width * dpi / 96, required.Height * dpi / 96);

        NativeCompanionLayout layout = NativeCompanionLayout.Calculate(
            client.Width, client.Height, dpi, platform == "patreon");

        Assert.Equal(24 * dpi / 96, layout.HeaderTitle.X);
        Assert.Equal(30 * dpi / 96, layout.CopyMain.Height);
        Assert.True(layout.PlatformCard.Bottom < layout.AssetsCard.Y);
        Assert.True(layout.AssetsCard.Bottom < layout.Footer.Y);
        Assert.Equal(16 * dpi / 96, layout.AssetsCard.Y - layout.PlatformCard.Bottom);
        Assert.True(layout.Footer.Y - layout.AssetsCard.Bottom >= 16 * dpi / 96);
        Assert.False(layout.TitleText.Intersects(layout.CopyTitle));
        Assert.False(layout.BodyText.Intersects(layout.CopyMain));
        Assert.False(layout.PostingStatus.Intersects(layout.PostingAction));
        Assert.False(layout.PostingHelper.Intersects(layout.PostingAction));
        Assert.True(layout.PostingAggregate.Y >= layout.Footer.Y);
        if (platform == "patreon") Assert.Equal(layout.TitleLabel.Y, layout.CopyTitle.Y + 5 * dpi / 96);
        Assert.Equal(layout.BodyLabel.Y, layout.CopyMain.Y + 5 * dpi / 96);
        Assert.Equal(layout.PlatformHeading.Y, layout.PlatformLabel.Y);
        Assert.True(layout.PostingStatus.Y >= layout.BodyText.Bottom);
        Assert.Equal(12 * dpi / 96, layout.PostingAction.X - layout.PostingStatus.Right);
        Assert.True(layout.BodyText.Height >= 96 * dpi / 96);
        Assert.True(layout.DragGuidance.Bottom < layout.AssetList.Y);
        Assert.False(layout.AssetCount.Intersects(layout.AssetsHeading));
        Assert.True(layout.CopyTitle.Right <= client.Width);
        Assert.True(layout.CopyMain.Right <= client.Width);
        Assert.True(layout.PostingAction.Right <= client.Width);
        Assert.True(layout.PostingAggregate.Right <= client.Width);
        Assert.True(layout.Close.Right <= client.Width);
        Assert.True(layout.Status.Width >= 160 * dpi / 96);
        Assert.True(layout.AssetList.Width > 0);
        Assert.True(layout.AssetList.Height > 0);
        Assert.True(layout.AssetList.Right <= client.Width);
        Assert.True(layout.AssetList.Bottom <= client.Height);
        Assert.True(layout.Footer.Right <= client.Width);
        Assert.True(layout.Footer.Bottom <= client.Height);
        Assert.All(Rectangles(layout), rectangle => AssertWithinClient(rectangle, client));
    }

    [Theory]
    [InlineData(96)]
    [InlineData(144)]
    [InlineData(192)]
    public void ProductionOuterMinimum_UsesDpiAwareNonClientAdjustment(int dpi)
    {
        NativeLayoutSize required = NativeCompanionLayout.SupportedMinimumLogicalClientSize;
        NativeLayoutSize client = new(required.Width * dpi / 96, required.Height * dpi / 96);
        NativeLayoutSize outer = NativeManualPublishingCompanion.NativeWindow.MinimumOuterSizeForDpi(dpi);
        NativeLayoutSize recovered = NativeManualPublishingCompanion.NativeWindow.ClientSizeFromOuterForDpi(outer, dpi);

        Assert.Equal(client, recovered);
        Assert.Equal(outer, NativeManualPublishingCompanion.NativeWindow.OuterSizeForLogicalClient(820, 754, dpi));
        Console.WriteLine($"{dpi} DPI: client {client.Width}x{client.Height}, outer {outer.Width}x{outer.Height}, recovered {recovered.Width}x{recovered.Height}");
    }

    [Fact]
    public void XAndBlueskyLayout_OmitsPatreonTitleAndExpandsAssets()
    {
        NativeCompanionLayout patreon = NativeCompanionLayout.Calculate(960, 760, 96, patreon: true);
        NativeCompanionLayout post = NativeCompanionLayout.Calculate(960, 760, 96, patreon: false);

        Assert.Equal(default, post.TitleLabel);
        Assert.Equal(default, post.TitleText);
        Assert.Equal(default, post.CopyTitle);
        Assert.True(post.BodyText.Height > patreon.BodyText.Height);
        Assert.True(post.AssetsCard.Height > patreon.AssetsCard.Height);
    }

    [Fact]
    public void ContentAndAssetsShareNormalGrowthAndBoundLargeAndWideWindows()
    {
        NativeCompanionLayout minimum = NativeCompanionLayout.Calculate(820, 754, 96, true);
        NativeCompanionLayout normal = NativeCompanionLayout.Calculate(980, 920, 96, true);
        NativeCompanionLayout large = NativeCompanionLayout.Calculate(980, 1400, 96, true);
        NativeCompanionLayout wide = NativeCompanionLayout.Calculate(1600, 920, 96, true);

        Assert.True(normal.BodyText.Height > minimum.BodyText.Height);
        Assert.True(normal.AssetList.Height > minimum.AssetList.Height);
        Assert.True(large.BodyText.Height <= 240);
        Assert.True(large.AssetsCard.Height <= 440);
        Assert.True(large.Footer.Y - large.AssetsCard.Bottom >= 16);
        Assert.Equal(1152, wide.PlatformCard.Width);
        Assert.Equal((1600 - 1152) / 2, wide.PlatformCard.X);
        Assert.Equal(wide.PlatformCard.X, wide.AssetsCard.X);
    }

    [Theory]
    [InlineData("Ready for manual publishing — not marked as posted", "After you publish this post on Patreon, mark it as posted here.")]
    [InlineData("Marking as posted…", "After you publish this post on Patreon, mark it as posted here.")]
    [InlineData("Posted — confirmed by you", "")]
    [InlineData("Confirmation outcome is unknown; retry confirmation", "After you publish this post on Patreon, mark it as posted here.")]
    [InlineData("Confirmation was rejected because the targeted platform is no longer owned by this preparation session", "Publish manually on the social site, then confirm only the corresponding platform here; retry preparation if the target is no longer available.")]
    public void PostingStateTextIsMeasuredAndContained(string status, string helper)
    {
        NativeCompanionLayout layout = NativeCompanionLayout.Calculate(820, 754, 96, true, status, helper);
        Assert.True(layout.PostingStatus.Height >= 30);
        Assert.True(layout.PostingHelper.Y >= layout.PostingStatus.Bottom);
        Assert.True(layout.PostingHelper.Bottom <= layout.PlatformCard.Bottom - 16);
        Assert.False(layout.PostingHelper.Intersects(layout.AssetsCard));
        Assert.False(layout.BodyText.Intersects(layout.PostingStatus));
        Assert.True(layout.AssetsCard.Bottom <= layout.Footer.Y - 16);
    }

    [Fact]
    public void ApplicationManifest_ActivatesCommonControlsV6ThroughTheProject()
    {
        string root = FindRepositoryRoot();
        string project = File.ReadAllText(Path.Combine(root, "helper", "windows", "src", "OpenLocally", "OpenLocally.csproj"));
        string manifest = File.ReadAllText(Path.Combine(root, "helper", "windows", "src", "OpenLocally", "OpenLocally.CommonControls.manifest"));

        Assert.Contains("<ApplicationManifest>OpenLocally.CommonControls.manifest</ApplicationManifest>", project);
        Assert.DoesNotContain("CopyToOutputDirectory", project);
        Assert.Contains("name=\"CreatorCrate.OpenLocally.CommonControls\"", manifest);
        Assert.Contains("version=\"1.0.0.0\"", manifest);
        Assert.Contains("Microsoft.Windows.Common-Controls", manifest);
        Assert.Contains("version=\"6.0.0.0\"", manifest);
        Assert.Contains("<dpiAware xmlns=\"http://schemas.microsoft.com/SMI/2005/WindowsSettings\">true/pm</dpiAware>", manifest);
        Assert.Contains("<dpiAwareness xmlns=\"http://schemas.microsoft.com/SMI/2016/WindowsSettings\">PerMonitorV2, PerMonitor</dpiAwareness>", manifest);
    }

    private static string FindRepositoryRoot()
    {
        DirectoryInfo? current = new(AppContext.BaseDirectory);
        while (current is not null)
        {
            if (File.Exists(Path.Combine(current.FullName, "helper", "windows", "src", "OpenLocally", "OpenLocally.csproj")))
                return current.FullName;
            current = current.Parent;
        }
        throw new DirectoryNotFoundException("CreatorCrate repository root was not found.");
    }

    private static IReadOnlyList<NativeLayoutRect> Rectangles(NativeCompanionLayout layout) =>
    [
        layout.HeaderTitle, layout.HeaderMetadata,
        layout.PlatformCard, layout.PlatformHeading, layout.PlatformLabel, layout.Platform,
        layout.TitleLabel, layout.TitleText, layout.CopyTitle,
        layout.BodyLabel, layout.BodyText, layout.CopyMain,
        layout.PostingStatus, layout.PostingHelper, layout.PostingAction, layout.PostingAggregate,
        layout.AssetsCard, layout.AssetsHeading, layout.AssetCount, layout.DragGuidance, layout.AssetList,
        layout.Footer, layout.Status, layout.Close,
    ];

    private static void AssertWithinClient(NativeLayoutRect rectangle, NativeLayoutSize client)
    {
        if (rectangle == default) return;
        Assert.True(rectangle.X >= 0 && rectangle.Y >= 0);
        Assert.True(rectangle.Width > 0 && rectangle.Height > 0);
        Assert.True(rectangle.Right <= client.Width);
        Assert.True(rectangle.Bottom <= client.Height);
    }
}
