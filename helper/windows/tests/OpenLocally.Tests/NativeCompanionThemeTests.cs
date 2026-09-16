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

        Assert.Equal("#171b22", NativeCompanionPalette.Hex(dark.RootBackground));
        Assert.Equal("#1d222b", NativeCompanionPalette.Hex(dark.Background));
        Assert.Equal("#e8ecf1", NativeCompanionPalette.Hex(dark.Foreground));
        Assert.Equal("#262c37", NativeCompanionPalette.Hex(dark.Border));
        Assert.Equal("#3a4353", NativeCompanionPalette.Hex(dark.PointerBorder));
        Assert.Equal("#58a6ff", NativeCompanionPalette.Hex(dark.FocusBorder));

        Assert.Equal("#ffffff", NativeCompanionPalette.Hex(light.RootBackground));
        Assert.Equal("#f8fafc", NativeCompanionPalette.Hex(light.Background));
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
    public void SurfaceAndStaticTextRoles_PreserveOneHierarchyAcrossThemesAndBypassDecorationInHighContrast()
    {
        foreach (NativeCompanionPalette palette in new[]
                 { NativeCompanionPalette.Dark, NativeCompanionPalette.Light })
        {
            NativeCompanionSurfaceStyle window = NativeCompanionTheme.SurfaceStyle(
                NativeCompanionSurfaceRole.Window, palette);
            NativeCompanionSurfaceStyle section = NativeCompanionTheme.SurfaceStyle(
                NativeCompanionSurfaceRole.Section, palette);
            NativeCompanionSurfaceStyle header = NativeCompanionTheme.SurfaceStyle(
                NativeCompanionSurfaceRole.SectionHeader, palette);
            NativeCompanionSurfaceStyle nested = NativeCompanionTheme.SurfaceStyle(
                NativeCompanionSurfaceRole.Nested, palette);
            NativeCompanionSurfaceStyle footer = NativeCompanionTheme.SurfaceStyle(
                NativeCompanionSurfaceRole.Footer, palette);

            Assert.Equal(palette.Page, window.Background);
            Assert.Equal(palette.Surface, section.Background);
            Assert.Equal(palette.Card, header.Background);
            Assert.Equal(palette.Card, nested.Background);
            Assert.Equal(palette.Surface, footer.Background);
            Assert.Equal(12, section.Radius);
            Assert.Equal(8, header.Radius);
            Assert.Equal(6, nested.Radius);
            Assert.True(section.Decorative);
            Assert.True(header.Decorative);
            Assert.True(nested.Decorative);

            NativeCompanionTextStyle heading = NativeCompanionTheme.TextStyle(
                NativeCompanionTextRole.SectionHeading, NativeCompanionSurfaceRole.SectionHeader, palette);
            NativeCompanionTextStyle label = NativeCompanionTheme.TextStyle(
                NativeCompanionTextRole.Label, NativeCompanionSurfaceRole.Section, palette);
            NativeCompanionTextStyle helper = NativeCompanionTheme.TextStyle(
                NativeCompanionTextRole.Supporting, NativeCompanionSurfaceRole.Section, palette);
            Assert.Equal(palette.Text, heading.Text);
            Assert.Equal(palette.Text, label.Text);
            Assert.Equal(palette.MutedText, helper.Text);
        }

        NativeCompanionPalette highContrast = NativeCompanionPalette.HighContrast;
        Assert.All(Enum.GetValues<NativeCompanionSurfaceRole>(), role =>
        {
            NativeCompanionSurfaceStyle style = NativeCompanionTheme.SurfaceStyle(role, highContrast);
            Assert.False(style.Decorative);
            Assert.Equal(0, style.Radius);
        });
        Assert.Equal(highContrast.Text, NativeCompanionTheme.TextStyle(
            NativeCompanionTextRole.Success, NativeCompanionSurfaceRole.Footer, highContrast).Text);
        Assert.Equal(highContrast.Text, NativeCompanionTheme.TextStyle(
            NativeCompanionTextRole.Danger, NativeCompanionSurfaceRole.Section, highContrast).Text);
    }

    [Fact]
    public void ButtonHierarchy_UsesCreatorCrateRolesAcrossEveryInteractiveState()
    {
        foreach (NativeCompanionPalette palette in new[] { NativeCompanionPalette.Dark, NativeCompanionPalette.Light })
        {
            NativeCompanionButtonStyle primary = NativeCompanionTheme.ButtonStyle(
                NativeCompanionButtonRole.Primary, NativeCompanionButtonState.Normal, palette, 96);
            NativeCompanionButtonStyle secondary = NativeCompanionTheme.ButtonStyle(
                NativeCompanionButtonRole.Secondary, NativeCompanionButtonState.Normal, palette, 96);
            NativeCompanionButtonStyle hover = NativeCompanionTheme.ButtonStyle(
                NativeCompanionButtonRole.Primary, NativeCompanionButtonState.Hover, palette, 96);
            NativeCompanionButtonStyle pressed = NativeCompanionTheme.ButtonStyle(
                NativeCompanionButtonRole.Primary, NativeCompanionButtonState.Pressed, palette, 96);
            NativeCompanionButtonStyle focused = NativeCompanionTheme.ButtonStyle(
                NativeCompanionButtonRole.Secondary,
                NativeCompanionButtonState.Hover | NativeCompanionButtonState.Focused, palette, 96);
            NativeCompanionButtonStyle disabled = NativeCompanionTheme.ButtonStyle(
                NativeCompanionButtonRole.Primary, NativeCompanionButtonState.Disabled, palette, 96);

            Assert.Equal(palette.Accent, primary.Background);
            Assert.Equal(palette.PrimaryButtonText, primary.Text);
            Assert.Equal(palette.Surface, secondary.Background);
            Assert.NotEqual(primary.Background, secondary.Background);
            Assert.Equal(palette.Focus, hover.Background);
            Assert.Equal(palette.AccentSecondary, pressed.Background);
            Assert.True(pressed.ContentOffset > 0);
            Assert.Equal(palette.Focus, focused.Border);
            Assert.True(focused.BorderWidth > secondary.BorderWidth);
            Assert.Equal(palette.Card, disabled.Background);
            Assert.Equal(palette.MutedText, disabled.Text);
            Assert.False(primary.UsesSystemFrame);
        }
    }

    [Fact]
    public void LightButtonStates_MeetOrdinaryTextContrastAndRemainDistinct()
    {
        NativeCompanionPalette palette = NativeCompanionPalette.Light;
        NativeCompanionButtonState[] states =
        [
            NativeCompanionButtonState.Normal,
            NativeCompanionButtonState.Hover,
            NativeCompanionButtonState.Pressed,
            NativeCompanionButtonState.Disabled,
        ];

        foreach (NativeCompanionButtonRole role in Enum.GetValues<NativeCompanionButtonRole>())
        {
            NativeCompanionButtonStyle[] styles = states
                .Select(state => NativeCompanionTheme.ButtonStyle(role, state, palette, 96))
                .ToArray();

            Assert.All(styles, style => Assert.True(
                ContrastRatio(style.Text, style.Background) >= 4.5,
                $"{role} contrast was {ContrastRatio(style.Text, style.Background):F2}:1 for " +
                $"{NativeCompanionPalette.Hex(style.Text)} on {NativeCompanionPalette.Hex(style.Background)}."));
            if (role == NativeCompanionButtonRole.Primary)
                Assert.Equal(styles.Length, styles.Select(style => style.Background).Distinct().Count());
            else
                Assert.Equal(styles.Length, styles.Distinct().Count());
        }
    }

    [Fact]
    public void HighContrastButtons_UseSystemFaceTextDisabledTextAndFrame()
    {
        NativeCompanionPalette palette = NativeCompanionPalette.HighContrast;
        NativeCompanionButtonStyle normal = NativeCompanionTheme.ButtonStyle(
            NativeCompanionButtonRole.Primary, NativeCompanionButtonState.Normal, palette, 192);
        NativeCompanionButtonStyle disabled = NativeCompanionTheme.ButtonStyle(
            NativeCompanionButtonRole.Secondary, NativeCompanionButtonState.Disabled, palette, 192);

        Assert.Equal(palette.ButtonFace, normal.Background);
        Assert.Equal(palette.ButtonText, normal.Text);
        Assert.Equal(palette.DisabledText, disabled.Text);
        Assert.True(normal.UsesSystemFrame);
        Assert.True(disabled.UsesSystemFrame);
    }

    [Fact]
    public void PlatformCombo_UsesCreatorCrateSurfaceHoverFocusAndSelectionRoles()
    {
        foreach (NativeCompanionPalette palette in new[] { NativeCompanionPalette.Dark, NativeCompanionPalette.Light })
        {
            NativeCompanionComboStyle normal = NativeCompanionTheme.ComboStyle(
                NativeCompanionComboState.Normal, palette, 96);
            NativeCompanionComboStyle hover = NativeCompanionTheme.ComboStyle(
                NativeCompanionComboState.Hover, palette, 96);
            NativeCompanionComboStyle focused = NativeCompanionTheme.ComboStyle(
                NativeCompanionComboState.Hover | NativeCompanionComboState.Focused, palette, 96);
            NativeCompanionComboItemStyle item = NativeCompanionTheme.ComboItemStyle(
                selected: false, disabled: false, focused: false, palette);
            NativeCompanionComboItemStyle selected = NativeCompanionTheme.ComboItemStyle(
                selected: true, disabled: false, focused: true, palette);

            Assert.Equal(palette.Surface, normal.Background);
            Assert.Equal(palette.Text, normal.Text);
            Assert.Equal(palette.Text, normal.Arrow);
            Assert.Equal(palette.Border, normal.Border);
            Assert.False(normal.UsesSystemChrome);
            Assert.Equal(palette.Hover, hover.Background);
            Assert.Equal(palette.BorderStrong, hover.Border);
            Assert.Equal(palette.Focus, focused.Border);
            Assert.True(focused.BorderWidth > normal.BorderWidth);
            Assert.Equal(palette.Surface, item.Background);
            Assert.Equal(palette.Text, item.Text);
            Assert.Equal(palette.SelectionBackground, selected.Background);
            Assert.Equal(palette.SelectionText, selected.Text);
            Assert.True(selected.DrawFocusCue);
            Assert.True(ContrastRatio(normal.Text, normal.Background) >= 4.5);
            Assert.True(ContrastRatio(selected.Text, selected.Background) >= 4.5);
        }
    }

    [Fact]
    public void PlatformCombo_HighContrastUsesOnlySystemChromeAndColors()
    {
        NativeCompanionPalette palette = NativeCompanionPalette.HighContrast;
        NativeCompanionComboStyle normal = NativeCompanionTheme.ComboStyle(
            NativeCompanionComboState.Focused, palette, 192);
        NativeCompanionComboStyle disabled = NativeCompanionTheme.ComboStyle(
            NativeCompanionComboState.Disabled, palette, 192);
        NativeCompanionComboItemStyle selected = NativeCompanionTheme.ComboItemStyle(
            selected: true, disabled: false, focused: true, palette);
        NativeCompanionComboItemStyle disabledItem = NativeCompanionTheme.ComboItemStyle(
            selected: false, disabled: true, focused: false, palette);

        Assert.True(normal.UsesSystemChrome);
        Assert.Equal(palette.ButtonFace, normal.Background);
        Assert.Equal(palette.ButtonText, normal.Text);
        Assert.Equal(palette.ButtonText, normal.Arrow);
        Assert.Equal(palette.DisabledText, disabled.Text);
        Assert.Equal(palette.SelectionBackground, selected.Background);
        Assert.Equal(palette.SelectionText, selected.Text);
        Assert.True(selected.DrawFocusCue);
        Assert.Equal(palette.DisabledText, disabledItem.Text);
    }

    [Theory]
    [InlineData(96, 12, 32, 32, 1)]
    [InlineData(144, 18, 48, 48, 2)]
    [InlineData(192, 24, 64, 64, 2)]
    public void PlatformComboGeometry_ScalesInsetsArrowAndItemsExactlyOnce(
        int dpi, int textInset, int arrowWidth, int itemHeight, int strokeWidth)
    {
        Assert.Equal(textInset, NativeCompanionTheme.ComboTextInset(dpi));
        Assert.Equal(textInset, NativeCompanionTheme.ComboItemInset(dpi));
        Assert.Equal(arrowWidth, NativeCompanionTheme.ComboArrowWidth(dpi));
        Assert.Equal(itemHeight, NativeCompanionTheme.ComboItemHeight(dpi));
        Assert.Equal(strokeWidth, NativeCompanionTheme.ComboStrokeWidth(dpi));
    }

    [Theory]
    [InlineData(-1, 0)]
    [InlineData(0, 0)]
    [InlineData(6, 12)]
    [InlineData(8, 16)]
    public void RoundedRectRadius_IsConvertedToWin32EllipseDiameter(int radius, int expected) =>
        Assert.Equal(expected, NativeCompanionTheme.RoundedRectEllipseDiameter(radius));

    [Fact]
    public void ChildThemeRoles_CoverTheCompanionAndListViewPalette()
    {
        NativeCompanionPalette palette = NativeCompanionPalette.Dark;

        Assert.Equal(palette.Page, NativeCompanionTheme.ControlStyle(NativeCompanionControlRole.TopLevel, palette).Background);
        Assert.Equal(NativeCompanionFontRole.ReleaseHeading, NativeCompanionTheme.ControlStyle(NativeCompanionControlRole.Heading, palette).FontRole);
        Assert.Equal(palette.MutedText, NativeCompanionTheme.ControlStyle(NativeCompanionControlRole.Metadata, palette).Text);
        Assert.Equal(palette.Card, NativeCompanionTheme.ControlStyle(NativeCompanionControlRole.SectionHeading, palette).Background);
        Assert.Equal(palette.Card, NativeCompanionTheme.ControlStyle(NativeCompanionControlRole.Edit, palette).Background);
        Assert.True(NativeCompanionTheme.ControlStyle(NativeCompanionControlRole.Combo, palette).CustomDraw);
        Assert.True(NativeCompanionTheme.ControlStyle(NativeCompanionControlRole.PrimaryButton, palette).CustomDraw);
        Assert.True(NativeCompanionTheme.ControlStyle(NativeCompanionControlRole.Button, palette).CustomDraw);
        Assert.Equal(palette.Surface, NativeCompanionTheme.ControlStyle(NativeCompanionControlRole.Status, palette).Background);
        Assert.True(NativeCompanionTheme.ControlStyle(NativeCompanionControlRole.ListView, palette).CustomDraw);
        Assert.Equal(palette.Card, NativeCompanionTheme.ControlStyle(NativeCompanionControlRole.ListView, palette).Background);
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
    [InlineData((int)NativeCompanionFontRole.ReleaseHeading, 20, 600)]
    [InlineData((int)NativeCompanionFontRole.SectionHeading, 12, 600)]
    [InlineData((int)NativeCompanionFontRole.Body, 14, 400)]
    [InlineData((int)NativeCompanionFontRole.Supporting, 12, 400)]
    public void Fonts_UseSegoeUiRolesInsteadOfDefaultGuiFont(
        int roleValue, int logicalPixelHeight, int weight)
    {
        NativeCompanionFontRole role = (NativeCompanionFontRole)roleValue;
        NativeCompanionFontSpec font = NativeCompanionTheme.FontSpec(role);

        Assert.Equal("Segoe UI", font.Family);
        Assert.Equal(logicalPixelHeight, font.LogicalPixelHeight);
        Assert.Equal(weight, font.Weight);
    }

    [Theory]
    [InlineData(96, 8, 44, 32)]
    [InlineData(144, 12, 66, 48)]
    [InlineData(192, 16, 88, 64)]
    public void SectionHeaderStrips_ScaleOnceAndRemainInset(
        int dpi, int inset, int contentHeight, int assetsHeight)
    {
        var section = new NativeLayoutRect(24, 80, 900, 400);
        NativeLayoutRect content = NativeCompanionTheme.SectionHeaderBounds(section, dpi, true);
        NativeLayoutRect assets = NativeCompanionTheme.SectionHeaderBounds(section, dpi, false);

        Assert.Equal(section.X + inset, content.X);
        Assert.Equal(section.Right - inset, content.Right);
        Assert.Equal(section.Y + inset, content.Y);
        Assert.Equal(contentHeight, content.Height);
        Assert.Equal(assetsHeight, assets.Height);
        Assert.True(content.Right <= section.Right && content.Bottom <= section.Bottom);
        Assert.True(assets.Right <= section.Right && assets.Bottom <= section.Bottom);
    }

    [Theory]
    [InlineData(96)]
    [InlineData(144)]
    [InlineData(192)]
    public void ProductionSectionHeaderPanels_ContainOnlyTheirFrozenHeaderRows(int dpi)
    {
        NativeCompanionLayout layout = NativeCompanionLayout.Calculate(
            820 * dpi / 96, 754 * dpi / 96, dpi, patreon: true);
        NativeLayoutRect content = NativeCompanionTheme.SectionHeaderBounds(
            layout.PlatformCard, dpi, includesPlatformSelector: true);
        NativeLayoutRect assets = NativeCompanionTheme.SectionHeaderBounds(
            layout.AssetsCard, dpi, includesPlatformSelector: false);

        static bool Contains(NativeLayoutRect outer, NativeLayoutRect inner) =>
            inner.X >= outer.X && inner.Y >= outer.Y && inner.Right <= outer.Right && inner.Bottom <= outer.Bottom;

        Assert.True(Contains(content, layout.PlatformHeading));
        Assert.True(Contains(content, layout.PlatformLabel));
        Assert.True(Contains(content, layout.Platform));
        Assert.True(Contains(assets, layout.AssetsHeading));
        Assert.True(Contains(assets, layout.AssetCount));
        Assert.False(assets.Intersects(layout.DragGuidance));
    }

    [Theory]
    [InlineData(96)]
    [InlineData(144)]
    [InlineData(192)]
    public void ThemeResources_RecreateFontsAndBrushesAcrossDpiChanges(int dpi)
    {
        using var theme = new NativeCompanionTheme(dpi);

        Assert.Equal(dpi, theme.Dpi);
        Assert.NotEqual(IntPtr.Zero, theme.Font(NativeCompanionFontRole.ReleaseHeading));
        Assert.NotEqual(IntPtr.Zero, theme.Font(NativeCompanionFontRole.Body));
        Assert.NotEqual(IntPtr.Zero, theme.Font(NativeCompanionFontRole.Supporting));
        Assert.NotEqual(IntPtr.Zero, theme.Brush(theme.Palette.Page));

        theme.Refresh(dpi == 192 ? 96 : dpi + 48);
        Assert.NotEqual(IntPtr.Zero, theme.Font(NativeCompanionFontRole.SectionHeading));
        Assert.NotEqual(IntPtr.Zero, theme.Brush(theme.Palette.Card));
    }

    [Theory]
    [InlineData(int.MinValue, false)]
    [InlineData(-1, false)]
    [InlineData(0, true)]
    [InlineData(1, true)]
    public void ApplyControlChrome_ReportsAnyNonnegativeHResultAsSuccess(int hresult, bool expected)
    {
        using var theme = new NativeCompanionTheme(
            96, NativeCompanionPalette.Dark, (_, _, _) => hresult);

        Assert.Equal(expected, theme.ApplyControlChrome(new IntPtr(1), NativeCompanionChromeRole.ListView));
    }

    [Fact]
    public void ApplyControlChrome_ReportsNativeCallExceptionAsFailure()
    {
        using var theme = new NativeCompanionTheme(
            96, NativeCompanionPalette.Dark,
            (_, _, _) => throw new InvalidOperationException("Simulated native theme failure."));

        Assert.False(theme.ApplyControlChrome(new IntPtr(1), NativeCompanionChromeRole.ListView));
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
        Assert.Equal(default, layout.Status);
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
    [InlineData(820, 754)]
    [InlineData(980, 920)]
    [InlineData(1600, 920)]
    public void CompactFooter_ContainsAggregateAndSecondaryCloseWithoutPermanentFeedbackArea(
        int width, int height)
    {
        NativeCompanionLayout layout = NativeCompanionLayout.Calculate(width, height, 96, patreon: true);

        Assert.Equal(60, layout.Footer.Height);
        Assert.Equal(layout.PlatformCard.X + 16, layout.PostingAggregate.X);
        Assert.Equal(16, layout.PlatformCard.Right - layout.Close.Right);
        Assert.Equal(12, layout.Close.Y - layout.Footer.Y);
        Assert.Equal(default, layout.Status);
        Assert.False(layout.PostingAggregate.Intersects(layout.Close));
    }

    [Fact]
    public void ExceptionalFooterFeedback_AddsOnlyMeasuredSecondLine()
    {
        NativeCompanionLayout oneLine = NativeCompanionLayout.Calculate(
            820, 754, 96, true, operationalStatusText: "Copied to clipboard.");
        NativeCompanionLayout twoLines = NativeCompanionLayout.Calculate(
            820, 754, 96, true,
            operationalStatusText: string.Join(' ', Enumerable.Repeat("unavailable", 70)));

        Assert.Equal(76, oneLine.Footer.Height);
        Assert.Equal(20, oneLine.Status.Height);
        Assert.True(oneLine.Status.Y >= oneLine.PostingAggregate.Bottom);
        Assert.True(oneLine.Status.Bottom <= oneLine.Footer.Bottom - 12);
        Assert.True(twoLines.Footer.Height > oneLine.Footer.Height);
        Assert.True(twoLines.Status.Height > oneLine.Status.Height);
        Assert.False(oneLine.Status.Intersects(oneLine.Close));
    }

    [Fact]
    public void WideFeedback_UsesBoundedFooterWidthAndCannotOverlapClose()
    {
        string feedback = string.Join(' ', Enumerable.Repeat("status", 24));
        NativeCompanionLayout layout = NativeCompanionLayout.Calculate(
            1600, 920, 96, true, operationalStatusText: feedback);

        Assert.Equal(224, layout.PlatformCard.X);
        Assert.Equal(1152, layout.PlatformCard.Width);
        Assert.Equal(layout.PlatformCard.X + 16, layout.Status.X);
        Assert.Equal(40, layout.Status.Height);
        Assert.Equal(96, layout.Footer.Height);
        Assert.True(layout.Status.Right <= layout.Close.X - 12);
        Assert.False(layout.Status.Intersects(layout.Close));
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

    private static double ContrastRatio(int foreground, int background)
    {
        static double Luminance(int color)
        {
            static double Linear(int component)
            {
                double channel = component / 255d;
                return channel <= 0.04045 ? channel / 12.92 : Math.Pow((channel + 0.055) / 1.055, 2.4);
            }

            return 0.2126 * Linear(color & 0xff) +
                0.7152 * Linear(color >> 8 & 0xff) +
                0.0722 * Linear(color >> 16 & 0xff);
        }

        double lighter = Math.Max(Luminance(foreground), Luminance(background));
        double darker = Math.Min(Luminance(foreground), Luminance(background));
        return (lighter + 0.05) / (darker + 0.05);
    }

    private static void AssertWithinClient(NativeLayoutRect rectangle, NativeLayoutSize client)
    {
        if (rectangle == default) return;
        Assert.True(rectangle.X >= 0 && rectangle.Y >= 0);
        Assert.True(rectangle.Width > 0 && rectangle.Height > 0);
        Assert.True(rectangle.Right <= client.Width);
        Assert.True(rectangle.Bottom <= client.Height);
    }
}
