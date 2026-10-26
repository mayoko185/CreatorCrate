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
    public void WinUiTextSurfacePalettes_MapRefinedInputSurfaceBorderAndFocusHierarchy()
    {
        WinUiTextSurfacePalette dark = WinUiTextSurfacePresentation.Palette(ElementTheme.Dark);
        WinUiTextSurfacePalette light = WinUiTextSurfacePresentation.Palette(ElementTheme.Light);

        Assert.Equal("#171b22", NativeCompanionPalette.Hex(dark.RootBackground));
        Assert.Equal("#0d0f13", NativeCompanionPalette.Hex(dark.Background));
        Assert.Equal(dark.Background, dark.PointerBackground);
        Assert.Equal("#e8ecf1", NativeCompanionPalette.Hex(dark.Foreground));
        Assert.Equal("#262c37", NativeCompanionPalette.Hex(dark.Border));
        Assert.Equal("#3a4353", NativeCompanionPalette.Hex(dark.PointerBorder));
        Assert.Equal("#58a6ff", NativeCompanionPalette.Hex(dark.FocusBorder));

        Assert.Equal("#ffffff", NativeCompanionPalette.Hex(light.RootBackground));
        Assert.Equal("#f5f7fa", NativeCompanionPalette.Hex(light.Background));
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
        Assert.Equal(8, WinUiTextSurfacePresentation.CornerRadius);
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
            NativeCompanionSurfaceStyle nested = NativeCompanionTheme.SurfaceStyle(
                NativeCompanionSurfaceRole.Nested, palette);
            NativeCompanionSurfaceStyle footer = NativeCompanionTheme.SurfaceStyle(
                NativeCompanionSurfaceRole.Footer, palette);

            // The refined dialog: a card window, inset section cards, page-dark fields, surface footer.
            Assert.Equal(palette.Card, window.Background);
            Assert.Equal(palette.Surface, section.Background);
            Assert.Equal(palette.Page, nested.Background);
            Assert.Equal(palette.Surface, footer.Background);
            Assert.Equal(palette.Border, section.Border);
            Assert.Equal(12, section.Radius);
            Assert.Equal(8, nested.Radius);
            Assert.True(section.Decorative);
            Assert.True(nested.Decorative);

            NativeCompanionTextStyle heading = NativeCompanionTheme.TextStyle(
                NativeCompanionTextRole.SectionHeading, NativeCompanionSurfaceRole.Section, palette);
            NativeCompanionTextStyle label = NativeCompanionTheme.TextStyle(
                NativeCompanionTextRole.Label, NativeCompanionSurfaceRole.Section, palette);
            NativeCompanionTextStyle helper = NativeCompanionTheme.TextStyle(
                NativeCompanionTextRole.Supporting, NativeCompanionSurfaceRole.Section, palette);
            Assert.Equal(palette.Text, heading.Text);
            Assert.Equal(palette.MutedText, label.Text);
            Assert.Equal(palette.MutedText, helper.Text);
            foreach (NativeCompanionSurfaceRole surface in Enum.GetValues<NativeCompanionSurfaceRole>())
                foreach (NativeCompanionTextRole role in Enum.GetValues<NativeCompanionTextRole>())
                {
                    NativeCompanionTextStyle style = NativeCompanionTheme.TextStyle(role, surface, palette);
                    Assert.True(ContrastRatio(style.Text, style.Background) >= 4.5,
                        $"{palette.Mode} {role} on {surface}: {ContrastRatio(style.Text, style.Background):F2}:1");
                }
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
        Assert.Equal(highContrast.Text, NativeCompanionTheme.TextStyle(
            NativeCompanionTextRole.Warning, NativeCompanionSurfaceRole.Section, highContrast).Text);
    }

    [Fact]
    public void ButtonHierarchy_MatchesTheRefinedDialogActionsAcrossEveryInteractiveState()
    {
        foreach (NativeCompanionPalette palette in new[] { NativeCompanionPalette.Dark, NativeCompanionPalette.Light })
        {
            NativeCompanionButtonStyle Style(NativeCompanionButtonRole role, NativeCompanionButtonState state,
                NativeCompanionButtonSize size = NativeCompanionButtonSize.Regular) =>
                NativeCompanionTheme.ButtonStyle(role, state, palette, 96, size, palette.Surface);
            NativeCompanionButtonStyle primary = Style(NativeCompanionButtonRole.Primary, NativeCompanionButtonState.Normal);
            NativeCompanionButtonStyle primaryHover = Style(NativeCompanionButtonRole.Primary, NativeCompanionButtonState.Hover);
            NativeCompanionButtonStyle primaryPressed = Style(NativeCompanionButtonRole.Primary,
                NativeCompanionButtonState.Hover | NativeCompanionButtonState.Pressed);
            NativeCompanionButtonStyle secondary = Style(NativeCompanionButtonRole.Secondary, NativeCompanionButtonState.Normal);
            NativeCompanionButtonStyle small = Style(NativeCompanionButtonRole.Secondary, NativeCompanionButtonState.Normal,
                NativeCompanionButtonSize.Small);
            NativeCompanionButtonStyle focused = Style(NativeCompanionButtonRole.Secondary,
                NativeCompanionButtonState.Hover | NativeCompanionButtonState.Focused);
            NativeCompanionButtonStyle disabled = Style(NativeCompanionButtonRole.Primary, NativeCompanionButtonState.Disabled);

            // Primary footer action: dark (--bg) outlined in --border-strong, semibold, --radius-sm;
            // hover turns the border to the accent.
            Assert.Equal(palette.Page, primary.Background);
            Assert.Equal(palette.Text, primary.Text);
            Assert.Equal(palette.BorderStrong, primary.Border);
            Assert.Equal(1, primary.BorderWidth);
            Assert.Equal(6, primary.Radius);
            Assert.Equal(12, primary.Padding);
            Assert.Equal(NativeCompanionFontRole.Emphasis, primary.FontRole);
            Assert.Equal(palette.Page, primaryHover.Background);
            Assert.Equal(palette.Accent, primaryHover.Border);
            Assert.Equal(0, primaryHover.ContentOffset);
            Assert.Equal(1, primaryPressed.ContentOffset);
            // Secondary: transparent over its surface, outlined, --refined-control-radius, hover surface.
            Assert.Equal(palette.Surface, secondary.Background);
            Assert.Equal(palette.BorderStrong, secondary.Border);
            Assert.Equal(palette.Text, secondary.Text);
            Assert.Equal(8, secondary.Radius);
            Assert.Equal(14, secondary.Padding);
            Assert.Equal(NativeCompanionFontRole.Body, secondary.FontRole);
            Assert.Equal(NativeCompanionFontRole.Compact, small.FontRole);
            Assert.Equal(10, small.Padding);
            Assert.Equal(palette.Hover, focused.Background);
            Assert.Equal(palette.BorderStrong, focused.Border);
            Assert.Equal(palette.Focus, focused.FocusRing);
            Assert.Equal(2, focused.FocusRingWidth);
            Assert.Equal(-1, secondary.FocusRing);
            Assert.Equal(2 * focused.FocusRingWidth, NativeCompanionTheme.ButtonFocusMargin(96));
            Assert.NotEqual(primary.Radius, secondary.Radius);
            // Disabled primary: card surface, quiet border, muted struck-through label.
            Assert.Equal(palette.Card, disabled.Background);
            Assert.Equal(palette.MutedText, disabled.Text);
            Assert.Equal(palette.Border, disabled.Border);
            Assert.Equal(1, disabled.BorderWidth);
            Assert.Equal(-1, disabled.InsetBorder);
            Assert.True(disabled.Strikeout);
            // Disabled secondary keeps its outline and label, adding the inset --border ring.
            NativeCompanionButtonStyle disabledSecondary = Style(
                NativeCompanionButtonRole.Secondary, NativeCompanionButtonState.Disabled);
            Assert.Equal(palette.Surface, disabledSecondary.Background);
            Assert.Equal(palette.Text, disabledSecondary.Text);
            Assert.Equal(palette.BorderStrong, disabledSecondary.Border);
            Assert.Equal(palette.Border, disabledSecondary.InsetBorder);
            Assert.True(disabledSecondary.Strikeout);
            Assert.False(primary.Strikeout);
            Assert.False(primary.UsesSystemFrame);
            Assert.True(ContrastRatio(disabled.Text, disabled.Background) >= 4.5);
            // Over a tinted feedback row the secondary stays transparent.
            int tinted = NativeCompanionTheme.FeedbackStyle(NativeCompanionFeedbackTone.Error, palette).Background;
            Assert.Equal(tinted, NativeCompanionTheme.ButtonStyle(NativeCompanionButtonRole.Secondary,
                NativeCompanionButtonState.Normal, palette, 96, NativeCompanionButtonSize.Small, tinted).Background);
        }
    }

    [Fact]
    public void ButtonStates_MeetOrdinaryTextContrastAndRemainDistinct()
    {
        NativeCompanionButtonState[] states =
        [
            NativeCompanionButtonState.Normal,
            NativeCompanionButtonState.Hover,
            NativeCompanionButtonState.Pressed,
            NativeCompanionButtonState.Disabled,
        ];

        foreach (NativeCompanionPalette palette in new[] { NativeCompanionPalette.Dark, NativeCompanionPalette.Light })
            foreach (NativeCompanionButtonRole role in Enum.GetValues<NativeCompanionButtonRole>())
            {
                NativeCompanionButtonStyle[] styles = states
                    .Select(state => NativeCompanionTheme.ButtonStyle(role, state, palette, 96))
                    .ToArray();

                Assert.All(styles, style => Assert.True(
                    ContrastRatio(style.Text, style.Background) >= 4.5,
                    $"{palette.Mode} {role} contrast was {ContrastRatio(style.Text, style.Background):F2}:1 for " +
                    $"{NativeCompanionPalette.Hex(style.Text)} on {NativeCompanionPalette.Hex(style.Background)}."));
                Assert.Equal(styles.Length, styles.Distinct().Count());
                // Every enabled state keeps a visible outline against the card it sits on.
                Assert.All(styles.Take(3), style => Assert.NotEqual(palette.Surface, style.Border));
            }
    }

    [Theory]
    [InlineData(96)]
    [InlineData(192)]
    public void HighContrastButtons_UseSystemColorsFrameAndHighlightFocusRing(int dpi)
    {
        NativeCompanionPalette palette = NativeCompanionPalette.HighContrast;
        NativeCompanionButtonStyle normal = NativeCompanionTheme.ButtonStyle(
            NativeCompanionButtonRole.Primary, NativeCompanionButtonState.Normal, palette, dpi);
        NativeCompanionButtonStyle focused = NativeCompanionTheme.ButtonStyle(
            NativeCompanionButtonRole.Secondary, NativeCompanionButtonState.Focused, palette, dpi,
            NativeCompanionButtonSize.Small);
        NativeCompanionButtonStyle disabled = NativeCompanionTheme.ButtonStyle(
            NativeCompanionButtonRole.Secondary, NativeCompanionButtonState.Disabled, palette, dpi);

        Assert.Equal(palette.ButtonFace, normal.Background);
        Assert.Equal(palette.ButtonText, normal.Text);
        Assert.Equal(palette.DisabledText, disabled.Text);
        Assert.True(disabled.Strikeout);
        Assert.True(normal.UsesSystemFrame);
        Assert.True(disabled.UsesSystemFrame);
        Assert.Equal(0, normal.Radius);
        Assert.Equal(-1, normal.FocusRing);
        Assert.Equal(palette.Focus, focused.FocusRing);
        Assert.Equal(NativeCompanionTheme.ButtonFocusRingWidth(dpi), focused.FocusRingWidth);
    }

    [Fact]
    public void PlatformTabs_UseTheViewSwitcherSelectionHoverAndFocusRoles()
    {
        foreach (NativeCompanionPalette palette in new[] { NativeCompanionPalette.Dark, NativeCompanionPalette.Light })
        {
            NativeCompanionTabStyle normal = NativeCompanionTheme.TabStyle(false, false, false, palette);
            NativeCompanionTabStyle hover = NativeCompanionTheme.TabStyle(false, true, false, palette);
            NativeCompanionTabStyle selected = NativeCompanionTheme.TabStyle(true, false, false, palette);
            NativeCompanionTabStyle focused = NativeCompanionTheme.TabStyle(true, true, true, palette);

            Assert.True(normal.CustomDraw);
            Assert.Equal(palette.Surface, normal.Background);
            Assert.Equal(palette.MutedText, normal.Text);
            Assert.Equal(palette.Hover, hover.Background);
            Assert.Equal(palette.Text, hover.Text);
            Assert.Equal(palette.Accent, selected.Background);
            Assert.Equal(palette.PrimaryButtonText, selected.Text);
            Assert.Equal(NativeCompanionFontRole.Emphasis, selected.FontRole);
            Assert.Equal(NativeCompanionFontRole.Body, normal.FontRole);
            Assert.Equal(-1, selected.FocusRing);
            Assert.Equal(palette.Focus, focused.FocusRing);
            Assert.Equal(palette.Accent, focused.Background); // Hover never hides the selection.
            foreach (NativeCompanionTabStyle style in new[] { normal, hover, selected, focused })
                Assert.True(ContrastRatio(style.Text, style.Background) >= 4.5,
                    $"{palette.Mode} tab text {NativeCompanionPalette.Hex(style.Text)} on {NativeCompanionPalette.Hex(style.Background)}");
            Assert.True(ContrastRatio(palette.Focus, palette.Surface) >= 3);
        }

        NativeCompanionTabStyle system = NativeCompanionTheme.TabStyle(true, false, true, NativeCompanionPalette.HighContrast);
        Assert.False(system.CustomDraw);
    }

    [Fact]
    public void FieldAndFeedbackStyles_DistinguishFocusErrorAndWarningInEveryTheme()
    {
        foreach (NativeCompanionPalette palette in new[] { NativeCompanionPalette.Dark, NativeCompanionPalette.Light })
        {
            NativeCompanionFieldStyle idle = NativeCompanionTheme.FieldStyle(false, NativeCompanionFeedbackTone.Neutral, palette, 96);
            NativeCompanionFieldStyle focused = NativeCompanionTheme.FieldStyle(true, NativeCompanionFeedbackTone.Error, palette, 96);
            NativeCompanionFieldStyle error = NativeCompanionTheme.FieldStyle(false, NativeCompanionFeedbackTone.Error, palette, 96);
            NativeCompanionFieldStyle warning = NativeCompanionTheme.FieldStyle(false, NativeCompanionFeedbackTone.Warning, palette, 96);
            Assert.Equal(palette.Page, idle.Background);
            Assert.Equal(palette.Border, idle.Border);
            Assert.Equal(palette.Focus, focused.Border);
            Assert.True(focused.BorderWidth > idle.BorderWidth);
            Assert.Equal(palette.Danger, error.Border);
            Assert.Equal(palette.Warning, warning.Border);
            Assert.Equal(8, idle.Radius);

            NativeCompanionFeedbackStyle neutral = NativeCompanionTheme.FeedbackStyle(NativeCompanionFeedbackTone.Neutral, palette);
            Assert.False(neutral.Tinted);
            Assert.Equal(palette.Surface, neutral.Background);
            foreach ((NativeCompanionFeedbackTone tone, NativeCompanionTextRole role, int accent) in new[]
                     {
                         (NativeCompanionFeedbackTone.Error, NativeCompanionTextRole.Danger, palette.Danger),
                         (NativeCompanionFeedbackTone.Warning, NativeCompanionTextRole.Warning, palette.Warning),
                     })
            {
                NativeCompanionFeedbackStyle feedback = NativeCompanionTheme.FeedbackStyle(tone, palette);
                Assert.True(feedback.Tinted);
                Assert.Equal(accent, feedback.Accent);
                Assert.NotEqual(palette.Surface, feedback.Background);
                foreach (NativeCompanionTextRole text in new[] { role, NativeCompanionTextRole.Supporting, NativeCompanionTextRole.Body })
                {
                    NativeCompanionTextStyle style = NativeCompanionTheme.TextStyle(text, feedback.Background, palette);
                    Assert.True(ContrastRatio(style.Text, style.Background) >= 4.5,
                        $"{palette.Mode} {text} on {tone} feedback: {ContrastRatio(style.Text, style.Background):F2}:1");
                }
            }
        }

        NativeCompanionPalette highContrast = NativeCompanionPalette.HighContrast;
        NativeCompanionFeedbackStyle framed = NativeCompanionTheme.FeedbackStyle(NativeCompanionFeedbackTone.Error, highContrast);
        Assert.False(framed.Tinted);
        Assert.True(framed.Framed);
        Assert.Equal(highContrast.Surface, framed.Background);
        Assert.Equal(highContrast.Text, NativeCompanionTheme.FieldStyle(false, NativeCompanionFeedbackTone.Error, highContrast, 96).Border);
        Assert.Equal(highContrast.Focus, NativeCompanionTheme.FieldStyle(true, NativeCompanionFeedbackTone.Neutral, highContrast, 96).Border);
        Assert.Equal(0, NativeCompanionTheme.FieldStyle(false, NativeCompanionFeedbackTone.Neutral, highContrast, 96).Radius);
    }

    [Theory]
    [InlineData(96, 1, 8, 4, 36, 30)]
    [InlineData(144, 1, 12, 6, 54, 45)]
    [InlineData(192, 2, 16, 8, 72, 60)]
    public void ControlGeometry_ScalesStrokeRadiusFocusMarginAndButtonHeightOnce(
        int dpi, int stroke, int radius, int margin, int buttonHeight, int smallButtonHeight)
    {
        Assert.Equal(stroke, NativeCompanionTheme.StrokeWidth(dpi));
        Assert.Equal(radius, NativeCompanionTheme.ControlRadius(dpi));
        Assert.Equal(margin, NativeCompanionTheme.ButtonFocusMargin(dpi));
        Assert.Equal(buttonHeight, NativeCompanionTheme.ButtonHeight(NativeCompanionButtonSize.Regular, dpi));
        Assert.Equal(smallButtonHeight, NativeCompanionTheme.ButtonHeight(NativeCompanionButtonSize.Small, dpi));
        // Windows text size enlarges the body so labels are never clipped.
        Assert.Equal(buttonHeight * 2, NativeCompanionTheme.ButtonHeight(NativeCompanionButtonSize.Regular, dpi, 200));
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

        Assert.Equal(palette.Card, NativeCompanionTheme.ControlStyle(NativeCompanionControlRole.TopLevel, palette).Background);
        Assert.Equal(NativeCompanionFontRole.ReleaseHeading, NativeCompanionTheme.ControlStyle(NativeCompanionControlRole.Heading, palette).FontRole);
        Assert.Equal(palette.MutedText, NativeCompanionTheme.ControlStyle(NativeCompanionControlRole.Metadata, palette).Text);
        Assert.Equal(palette.Surface, NativeCompanionTheme.ControlStyle(NativeCompanionControlRole.SectionHeading, palette).Background);
        Assert.Equal(palette.Page, NativeCompanionTheme.ControlStyle(NativeCompanionControlRole.Edit, palette).Background);
        Assert.True(NativeCompanionTheme.ControlStyle(NativeCompanionControlRole.Edit, palette).CustomDraw);
        Assert.True(NativeCompanionTheme.ControlStyle(NativeCompanionControlRole.PrimaryButton, palette).CustomDraw);
        Assert.Equal(NativeCompanionFontRole.Emphasis, NativeCompanionTheme.ControlStyle(NativeCompanionControlRole.PrimaryButton, palette).FontRole);
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
    [InlineData((int)NativeCompanionFontRole.ReleaseHeading, 18, 600)]
    [InlineData((int)NativeCompanionFontRole.SectionHeading, 14, 600)]
    [InlineData((int)NativeCompanionFontRole.Body, 14, 400)]
    [InlineData((int)NativeCompanionFontRole.Supporting, 12, 400)]
    [InlineData((int)NativeCompanionFontRole.Emphasis, 14, 600)]
    [InlineData((int)NativeCompanionFontRole.Compact, 13, 400)]
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
    [InlineData(96)]
    [InlineData(144)]
    [InlineData(192)]
    public void SectionHeadingMarks_ScaleOnceAndSitBesideTheirHeadings(int dpi)
    {
        var heading = new NativeLayoutRect(100, 40, 300, 20 * dpi / 96);
        NativeLayoutRect mark = NativeCompanionTheme.AccentMarkBounds(heading, dpi);

        Assert.Equal(Math.Max(1, 3 * dpi / 96), mark.Width);
        Assert.Equal(14 * dpi / 96, mark.Height);
        Assert.Equal(heading.X - NativeCompanionTheme.AccentMarkOffset(dpi), mark.X);
        Assert.True(mark.Right < heading.X);
        Assert.True(mark.Y >= heading.Y && mark.Bottom <= heading.Bottom);
    }

    [Theory]
    [InlineData(96, true)]
    [InlineData(144, true)]
    [InlineData(192, false)]
    public void SectionHeadingRows_KeepHeadingVisibleLabelAndTabsInsideTheirCards(int dpi, bool patreon)
    {
        NativeCompanionLayout layout = NativeCompanionLayout.Calculate(
            980 * dpi / 96, 920 * dpi / 96, dpi, patreon, releaseLink: ReadyLink);

        Assert.True(layout.PlatformCard.Contains(layout.PlatformHeading));
        Assert.True(layout.PlatformCard.Contains(layout.PlatformLabel));
        Assert.True(layout.PlatformCard.Contains(layout.Platform));
        Assert.False(layout.PlatformHeading.Intersects(layout.PlatformLabel));
        Assert.False(layout.PlatformLabel.Intersects(layout.Platform));
        Assert.Equal(layout.PlatformLabel.Right + 8 * dpi / 96, layout.Platform.X);
        Assert.Equal(layout.PlatformCard.Right - 16 * dpi / 96, layout.Platform.Right);
        Assert.True(layout.ReleaseLinkCard.Contains(layout.ReleaseLinkLabel));
        Assert.True(layout.ReleaseLinkCard.Contains(layout.ReleaseLinkField));
        Assert.True(layout.ReleaseLinkField.Contains(layout.ReleaseLinkInput));
        Assert.True(layout.ReleaseLinkCard.Contains(layout.ReleaseLinkSave));
        Assert.Equal(layout.ReleaseLinkField.Y, layout.ReleaseLinkSave.Y);
        Assert.True(layout.ReleaseLinkFeedback.Contains(layout.ReleaseLinkStatus));
        Assert.True(layout.AssetsCard.Contains(layout.AssetsHeading));
        Assert.True(layout.AssetsCard.Contains(layout.AssetCount));
        Assert.False(layout.AssetsHeading.Intersects(layout.AssetCount));
        Assert.True(layout.DragGuidance.Bottom < layout.AssetList.Y);
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

    private static readonly NativeReleaseLinkLayoutRequest ReadyLink = new("Release link is up to date.", false, false, false);
    private static readonly NativeReleaseLinkLayoutRequest FailedLink = new(
        "Couldn't load the Release link. Try again.", true, false, false);
    private static readonly NativeReleaseLinkLayoutRequest ConflictLink = new(
        "The Release link was changed elsewhere to “https://creatorcrate.example/releases/autumn-creator-launch-behind-the-scenes-…”. " +
        "Use the server link, or keep yours — saving it then replaces the newer link.", false, true, true);
    private const string LongTitle =
        "Autumn Creator Launch — Behind the Scenes with the Whole CreatorCrate Studio Team, Part Two of an Extended Series";
    private const string Metadata = "Release ID: 4242   •   Server: https://creatorcrate.example";
    private const string LongPostingStatus =
        "Confirmation was rejected because the targeted platform is no longer owned by this preparation session";
    private const string LongPostingHelper =
        "Publish manually on the social site, then confirm only the corresponding platform here; retry preparation if the target is no longer available.";

    [Theory]
    [InlineData(96, "patreon", 100)]
    [InlineData(96, "x", 100)]
    [InlineData(96, "bluesky", 100)]
    [InlineData(144, "patreon", 100)]
    [InlineData(144, "x", 100)]
    [InlineData(192, "patreon", 100)]
    [InlineData(192, "bluesky", 100)]
    [InlineData(96, "patreon", 150)]
    [InlineData(96, "x", 200)]
    [InlineData(144, "patreon", 225)]
    public void ApprovedNarrowTarget_ScrollsAWellFormedColumnAbovePinnedFooter(int dpi, string platform, int textScale)
    {
        Assert.Equal(640, NativeCompanionLayout.SupportedMinimumLogicalClientWidth);
        Assert.Equal(600, NativeCompanionLayout.RequiredLogicalClientHeight);
        NativeLayoutSize target = NativeCompanionLayout.SupportedMinimumLogicalClientSize;
        var client = new NativeLayoutSize(target.Width * dpi / 96, target.Height * dpi / 96);

        foreach (NativeReleaseLinkLayoutRequest? link in new[] { null, ReadyLink, FailedLink, ConflictLink })
        {
            NativeCompanionLayout Layout(int offset) => NativeCompanionLayout.Calculate(
                client.Width, client.Height, dpi, platform == "patreon", LongPostingStatus, LongPostingHelper,
                operationalStatusText: "Copied to clipboard.", releaseLink: link, scrollOffset: offset,
                textScale: textScale, releaseTitle: LongTitle, headerMetadata: Metadata,
                dragGuidanceText: "Selection includes unavailable files and cannot be dragged.");

            NativeCompanionLayout top = Layout(0);
            NativeCompanionLayout end = Layout(int.MaxValue);
            AssertWellFormed(top, client, dpi);
            AssertWellFormed(end, client, dpi);
            Assert.True(top.IsScrollable, "The approved target cannot hold every section, so the body must scroll.");
            Assert.Equal(0, top.ScrollOffset);
            Assert.Equal(top.MaximumScrollOffset, end.ScrollOffset);
            Assert.Equal(new NativeLayoutRect(0, 0, client.Width, top.Footer.Y), top.Viewport);
            Assert.Equal(client.Height, top.Footer.Bottom);
            Assert.Equal(top.Footer, end.Footer);
            Assert.Equal(top.Close, end.Close);
            Assert.Equal(top.Viewport.Height, top.ScrollBar.Height);
            Assert.Equal(client.Width, top.ScrollBar.Right);
            Assert.True(top.PlatformCard.Right <= top.ScrollBar.X, "Content must clear the scroll bar.");
            Assert.True(top.HeaderTitle.Y > 0);
            Assert.True(end.AssetList.Bottom <= end.Viewport.Bottom, "Scrolling to the end must reveal the whole asset list.");
            if (link is not null)
            {
                Assert.Equal(end.Viewport.Bottom, end.ReleaseLinkCard.Bottom + 16 * dpi / 96);
                // Very large text can make the card taller than the viewport; each of its parts still fits,
                // so keyboard focus can scroll any of them fully into view.
                foreach (NativeLayoutRect part in new[] { end.ReleaseLinkField, end.ReleaseLinkSave, end.ReleaseLinkReload,
                             end.ReleaseLinkDiscard, end.ReleaseLinkKeep }.Where(part => part != default))
                    Assert.True(part.Height <= end.Viewport.Height - 24 * dpi / 96, $"Release link part {part} cannot be revealed.");
                Assert.False(top.Viewport.Contains(top.ReleaseLinkCard),
                    "At the approved target the Release link follows Assets below the fold.");
            }
            Assert.Equal(top.PlatformCard.Height, end.PlatformCard.Height);
            Assert.Equal(top.HeaderTitle.Y - top.MaximumScrollOffset, end.HeaderTitle.Y);
            Assert.True(top.HeaderTitle.Height <= 3 * (24 * dpi * textScale / 9600) + 1);
            Assert.True(top.BodyText.Height >= 88 * dpi / 96);
            Assert.True(top.AssetList.Height >= 124 * dpi / 96);
            if (platform == "patreon") Assert.True(top.TitleText.Height >= 48 * dpi / 96);
        }
    }

    [Theory]
    [InlineData(96)]
    [InlineData(144)]
    [InlineData(192)]
    public void ReleaseLinkFeedback_ReservesItsRowSoRecoveryActionsDoNotMoveThePage(int dpi)
    {
        foreach (int logicalWidth in new[] { 640, 980, 1600 })
        {
            NativeCompanionLayout Layout(NativeReleaseLinkLayoutRequest link) => NativeCompanionLayout.Calculate(
                logicalWidth * dpi / 96, 920 * dpi / 96, dpi, patreon: false, releaseLink: link);
            NativeCompanionLayout ready = Layout(ReadyLink);
            NativeCompanionLayout failed = Layout(FailedLink);
            NativeCompanionLayout discard = Layout(new("Unsaved change: select Save link to set the Release link.", false, true, false));

            Assert.Equal(ready.ReleaseLinkFeedback, failed.ReleaseLinkFeedback);
            Assert.Equal(ready.ReleaseLinkFeedback, discard.ReleaseLinkFeedback);
            Assert.Equal(ready.PlatformCard, failed.PlatformCard);
            Assert.Equal(ready.ReleaseLinkSave, failed.ReleaseLinkSave);
            Assert.Equal(ready.ReleaseLinkField, failed.ReleaseLinkField);
            Assert.True(failed.ReleaseLinkFeedback.Contains(failed.ReleaseLinkReload));
            Assert.False(failed.ReleaseLinkStatus.Intersects(failed.ReleaseLinkReload));
            Assert.Equal(default, ready.ReleaseLinkReload);
        }
    }

    [Theory]
    [InlineData(96)]
    [InlineData(192)]
    public void LongReleaseLinkConflict_StacksItsRecoveryActionsBelowTheWrappedMessageWhenNarrow(int dpi)
    {
        NativeCompanionLayout narrow = NativeCompanionLayout.Calculate(
            640 * dpi / 96, 600 * dpi / 96, dpi, patreon: false, releaseLink: ConflictLink);
        NativeCompanionLayout wide = NativeCompanionLayout.Calculate(
            1600 * dpi / 96, 920 * dpi / 96, dpi, patreon: false, releaseLink: ConflictLink);

        foreach (NativeCompanionLayout layout in new[] { narrow, wide })
        {
            Assert.True(layout.ReleaseLinkFeedback.Contains(layout.ReleaseLinkStatus));
            Assert.True(layout.ReleaseLinkFeedback.Contains(layout.ReleaseLinkDiscard));
            Assert.True(layout.ReleaseLinkFeedback.Contains(layout.ReleaseLinkKeep));
            Assert.False(layout.ReleaseLinkStatus.Intersects(layout.ReleaseLinkDiscard));
            Assert.False(layout.ReleaseLinkStatus.Intersects(layout.ReleaseLinkKeep));
            Assert.False(layout.ReleaseLinkDiscard.Intersects(layout.ReleaseLinkKeep));
            Assert.True(layout.ReleaseLinkDiscard.X < layout.ReleaseLinkKeep.X);
            Assert.True(layout.ReleaseLinkStatus.Height >= 2 * 16 * dpi / 96, "A long conflict message wraps rather than clips.");
        }
        Assert.True(narrow.ReleaseLinkDiscard.Y >= narrow.ReleaseLinkStatus.Bottom);
        Assert.Equal(narrow.ReleaseLinkStatus.Width,
            narrow.ReleaseLinkFeedback.Width - 2 * (10 * dpi / 96));
        Assert.True(wide.ReleaseLinkDiscard.Y < wide.ReleaseLinkStatus.Bottom);
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
        Assert.Equal(outer, NativeManualPublishingCompanion.NativeWindow.OuterSizeForLogicalClient(640, 600, dpi));
        Console.WriteLine($"{dpi} DPI: client {client.Width}x{client.Height}, outer {outer.Width}x{outer.Height}, recovered {recovered.Width}x{recovered.Height}");
    }

    [Fact]
    public void MinimumTrackAndInitialPlacement_RespectASmallWorkArea()
    {
        var minimum = new NativeLayoutSize(1300, 1250); // 640 by 600 client at 200% scaling
        var laptop = new NativeLayoutRect(0, 0, 1366, 728);   // 1366 by 768 with the taskbar
        var roomy = new NativeLayoutRect(-2560, 0, 2560, 1400);

        Assert.Equal(new NativeLayoutSize(1300, 728),
            NativeManualPublishingCompanion.NativeWindow.MinimumTrackSize(minimum, laptop));
        Assert.Equal(minimum, NativeManualPublishingCompanion.NativeWindow.MinimumTrackSize(minimum, roomy));
        Assert.Equal(minimum, NativeManualPublishingCompanion.NativeWindow.MinimumTrackSize(minimum, null));

        NativeLayoutRect fitted = NativeManualPublishingCompanion.NativeWindow.FitToWorkArea(
            new NativeLayoutRect(100, 80, 1980, 1880), laptop);
        Assert.Equal(new NativeLayoutRect(0, 0, 1366, 728), fitted);
        Assert.Equal(new NativeLayoutRect(-1820, 80, 996, 952),
            NativeManualPublishingCompanion.NativeWindow.FitToWorkArea(new NativeLayoutRect(-1820, 80, 996, 952), roomy));
        Assert.Equal(new NativeLayoutRect(-2560, 0, 996, 952),
            NativeManualPublishingCompanion.NativeWindow.FitToWorkArea(new NativeLayoutRect(-3000, -40, 996, 952), roomy));
        Assert.Equal(new NativeLayoutRect(924, 88, 996, 952),
            NativeManualPublishingCompanion.NativeWindow.FitToWorkArea(new NativeLayoutRect(1200, 300, 996, 952), new(0, 0, 1920, 1040)));
    }

    [Fact]
    public void TextSurfacesBelowTheViewportAreShortenedOrParkedAboveTheClient()
    {
        var viewport = new NativeLayoutRect(0, 0, 640, 540);

        Assert.Equal(new NativeLayoutRect(16, 100, 500, 96),
            NativeManualPublishingCompanion.NativeWindow.FitIslandToViewport(new(16, 100, 500, 96), viewport));
        Assert.Equal(new NativeLayoutRect(16, 500, 500, 40),
            NativeManualPublishingCompanion.NativeWindow.FitIslandToViewport(new(16, 500, 500, 96), viewport));
        Assert.Equal(new NativeLayoutRect(16, -20, 500, 96),
            NativeManualPublishingCompanion.NativeWindow.FitIslandToViewport(new(16, -20, 500, 96), viewport));
        NativeLayoutRect parked = NativeManualPublishingCompanion.NativeWindow.FitIslandToViewport(new(16, 560, 500, 96), viewport);
        Assert.Equal(96, parked.Height);
        Assert.True(parked.Bottom < 0);
        Assert.Equal(default, NativeManualPublishingCompanion.NativeWindow.FitIslandToViewport(default, viewport));
    }

    [Fact]
    public void OffsetToReveal_ScrollsTheMinimumDistanceAndAlignsTallTargetsToTheTop()
    {
        NativeCompanionLayout layout = NativeCompanionLayout.Calculate(640, 600, 96, patreon: true, releaseLink: ConflictLink);
        Assert.True(layout.IsScrollable);
        int margin = 12;

        Assert.Equal(0, layout.OffsetToReveal(layout.PlatformHeading, margin));
        int closeToBottom = layout.OffsetToReveal(layout.AssetList, margin);
        NativeCompanionLayout revealed = NativeCompanionLayout.Calculate(640, 600, 96, patreon: true,
            releaseLink: ConflictLink, scrollOffset: closeToBottom);
        Assert.True(closeToBottom > 0);
        Assert.True(revealed.Viewport.Contains(revealed.AssetList));
        Assert.Equal(revealed.Viewport.Bottom - margin, revealed.AssetList.Bottom);
        Assert.Equal(closeToBottom, revealed.OffsetToReveal(revealed.AssetList, margin));
        Assert.True(revealed.OffsetToReveal(revealed.HeaderTitle, margin) < closeToBottom);
        // The Release link sits below Assets, so revealing its field scrolls further still.
        Assert.True(revealed.OffsetToReveal(revealed.ReleaseLinkField, margin) > closeToBottom);
        var tall = new NativeLayoutRect(16, 200, 500, 2000);
        Assert.Equal(Math.Min(layout.MaximumScrollOffset, 200 - margin), layout.OffsetToReveal(tall, margin));
        NativeCompanionLayout fits = NativeCompanionLayout.Calculate(1600, 1400, 96, patreon: true);
        Assert.False(fits.IsScrollable);
        Assert.Equal(0, fits.OffsetToReveal(fits.AssetList, margin));
    }

    [Fact]
    public void XAndBlueskyLayout_OmitsPatreonTitleAndGivesPostTextMoreRoom()
    {
        NativeCompanionLayout patreon = NativeCompanionLayout.Calculate(960, 900, 96, patreon: true);
        NativeCompanionLayout post = NativeCompanionLayout.Calculate(960, 900, 96, patreon: false);

        Assert.Equal(default, post.TitleLabel);
        Assert.Equal(default, post.TitleText);
        Assert.Equal(default, post.CopyTitle);
        Assert.True(post.BodyText.Height >= patreon.BodyText.Height);
        Assert.True(post.BodyLabel.Y < patreon.BodyLabel.Y);
        Assert.True(post.AssetList.Height >= patreon.AssetList.Height);
    }

    [Fact]
    public void ContentAndAssetsShareNormalGrowthAndBoundLargeAndWideWindows()
    {
        NativeCompanionLayout minimum = NativeCompanionLayout.Calculate(640, 600, 96, true);
        NativeCompanionLayout normal = NativeCompanionLayout.Calculate(980, 920, 96, true);
        NativeCompanionLayout large = NativeCompanionLayout.Calculate(980, 1400, 96, true);
        NativeCompanionLayout wide = NativeCompanionLayout.Calculate(1600, 920, 96, true);

        Assert.True(minimum.IsScrollable);
        Assert.False(normal.IsScrollable);
        Assert.False(large.IsScrollable);
        Assert.True(normal.BodyText.Height > minimum.BodyText.Height);
        Assert.True(normal.AssetList.Height > minimum.AssetList.Height);
        Assert.Equal(240, large.BodyText.Height);
        Assert.Equal(176, large.AssetList.Height);
        Assert.Equal(1152, wide.PlatformCard.Width);
        Assert.Equal((1600 - 1152) / 2, wide.PlatformCard.X);
        Assert.Equal(wide.PlatformCard.X, wide.AssetsCard.X);
        Assert.Equal(default, normal.ScrollBar);
    }

    [Theory]
    [InlineData(640, 600)]
    [InlineData(980, 920)]
    [InlineData(1600, 920)]
    public void CompactFooter_PinsAggregateAndSecondaryCloseWithoutPermanentFeedbackArea(int width, int height)
    {
        NativeCompanionLayout layout = NativeCompanionLayout.Calculate(width, height, 96, patreon: true);
        int column = Math.Min(1152, width - 32);
        int columnX = (width - column) / 2;

        Assert.Equal(60, layout.Footer.Height);
        Assert.Equal(height, layout.Footer.Bottom);
        Assert.Equal(columnX + 16, layout.PostingAggregate.X);
        Assert.Equal(columnX + column - 16, layout.Close.Right);
        Assert.Equal(12, layout.Close.Y - layout.Footer.Y);
        Assert.Equal(default, layout.Status);
        Assert.False(layout.PostingAggregate.Intersects(layout.Close));
    }

    [Fact]
    public void ExceptionalFooterFeedback_AddsOnlyMeasuredLinesBeyondTheButtonHeight()
    {
        NativeCompanionLayout oneLine = NativeCompanionLayout.Calculate(
            640, 600, 96, true, operationalStatusText: "Copied to clipboard.");
        NativeCompanionLayout twoLines = NativeCompanionLayout.Calculate(
            640, 600, 96, true,
            operationalStatusText: string.Join(' ', Enumerable.Repeat("unavailable", 70)));

        Assert.Equal(60, oneLine.Footer.Height);
        Assert.Equal(16, oneLine.Status.Height);
        Assert.True(oneLine.Status.Y >= oneLine.PostingAggregate.Bottom);
        Assert.True(oneLine.Status.Bottom <= oneLine.Footer.Bottom - 12);
        Assert.True(twoLines.Footer.Height > oneLine.Footer.Height);
        Assert.Equal(32, twoLines.Status.Height);
        Assert.False(oneLine.Status.Intersects(oneLine.Close));
        Assert.Equal(twoLines.Footer.Y, twoLines.Viewport.Bottom);
    }

    [Fact]
    public void WideFeedback_UsesBoundedFooterWidthAndCannotOverlapClose()
    {
        string feedback = string.Join(' ', Enumerable.Repeat("status", 40));
        NativeCompanionLayout layout = NativeCompanionLayout.Calculate(
            1600, 920, 96, true, operationalStatusText: feedback);

        Assert.Equal(224, layout.PlatformCard.X);
        Assert.Equal(1152, layout.PlatformCard.Width);
        Assert.Equal(layout.PlatformCard.X + 16, layout.Status.X);
        Assert.Equal(32, layout.Status.Height);
        Assert.Equal(12 + 18 + 2 + 32 + 12, layout.Footer.Height);
        Assert.True(layout.Status.Right <= layout.Close.X - 12);
        Assert.False(layout.Status.Intersects(layout.Close));
    }

    [Theory]
    [InlineData("Ready for manual publishing — not marked as posted", "After you publish this post on Patreon, mark it as posted here.")]
    [InlineData("Marking as posted…", "After you publish this post on Patreon, mark it as posted here.")]
    [InlineData("Posted — confirmed by you", "")]
    [InlineData("Confirmation outcome is unknown; retry confirmation", "After you publish this post on Patreon, mark it as posted here.")]
    [InlineData(LongPostingStatus, LongPostingHelper)]
    public void PostingStateTextIsMeasuredAndContained(string status, string helper)
    {
        foreach ((int width, int height) in new[] { (640, 600), (980, 920) })
        {
            NativeCompanionLayout layout = NativeCompanionLayout.Calculate(width, height, 96, true, status, helper);
            Assert.True(layout.PostingStatus.Height >= 20);
            Assert.True(layout.PostingHelper.Y >= layout.PostingStatus.Bottom);
            Assert.True(layout.PostingHelper.Y >= layout.PostingAction.Bottom || layout.PostingAction.X > layout.PostingStatus.Right);
            Assert.True(layout.PostingHelper.Bottom <= layout.PlatformCard.Bottom - 16);
            Assert.True(layout.PostingDivider.Y > layout.BodyText.Bottom);
            Assert.True(layout.PostingStatus.Y > layout.PostingDivider.Bottom);
            Assert.False(layout.PostingStatus.Intersects(layout.PostingAction));
            Assert.False(layout.PostingHelper.Intersects(layout.PostingAction));
            Assert.True(layout.PlatformCard.Contains(layout.PostingAction));
            Assert.True(layout.AssetsCard.Y >= layout.PlatformCard.Bottom + 12);
        }
    }

    private static void AssertWellFormed(NativeCompanionLayout layout, NativeLayoutSize client, int dpi)
    {
        (string Name, NativeLayoutRect Bounds)[] parts =
        [
            ("title", layout.HeaderTitle), ("metadata", layout.HeaderMetadata),
            ("link-heading", layout.ReleaseLinkLabel), ("link-field", layout.ReleaseLinkField),
            ("link-save", layout.ReleaseLinkSave), ("link-reload", layout.ReleaseLinkReload),
            ("link-discard", layout.ReleaseLinkDiscard), ("link-keep", layout.ReleaseLinkKeep),
            ("link-status", layout.ReleaseLinkStatus), ("content-heading", layout.PlatformHeading),
            ("platform-label", layout.PlatformLabel), ("platform", layout.Platform),
            ("title-label", layout.TitleLabel), ("title-text", layout.TitleText), ("copy-title", layout.CopyTitle),
            ("body-label", layout.BodyLabel), ("body-text", layout.BodyText), ("copy-main", layout.CopyMain),
            ("posting-status", layout.PostingStatus), ("posting-action", layout.PostingAction),
            ("posting-helper", layout.PostingHelper), ("assets-heading", layout.AssetsHeading),
            ("asset-count", layout.AssetCount), ("drag-guidance", layout.DragGuidance), ("asset-list", layout.AssetList),
        ];
        parts = parts.Where(part => part.Bounds != default).ToArray();
        foreach ((string name, NativeLayoutRect bounds) in parts)
        {
            Assert.True(bounds.Width > 0 && bounds.Height > 0, $"{name} has no area: {bounds}");
            Assert.True(bounds.X >= 0 && bounds.Right <= client.Width, $"{name} is clipped horizontally: {bounds}");
        }
        for (int first = 0; first < parts.Length; first++)
            for (int second = first + 1; second < parts.Length; second++)
                Assert.False(parts[first].Bounds.Intersects(parts[second].Bounds),
                    $"{parts[first].Name} {parts[first].Bounds} overlaps {parts[second].Name} {parts[second].Bounds}");

        // Content, Assets, then the release-wide Release link as the last card above the footer.
        NativeLayoutRect[] cards = new[] { layout.PlatformCard, layout.AssetsCard, layout.ReleaseLinkCard }
            .Where(card => card != default).ToArray();
        for (int index = 1; index < cards.Length; index++)
            Assert.True(cards[index].Y >= cards[index - 1].Bottom + 12 * dpi / 96);
        Assert.True(cards[0].Y > layout.HeaderMetadata.Bottom);
        if (layout.ReleaseLinkCard != default)
        {
            foreach (NativeLayoutRect part in new[] { layout.ReleaseLinkLabel, layout.ReleaseLinkField, layout.ReleaseLinkSave,
                         layout.ReleaseLinkFeedback })
                Assert.True(layout.ReleaseLinkCard.Contains(part));
            Assert.True(layout.ReleaseLinkField.Contains(layout.ReleaseLinkInput));
            foreach (NativeLayoutRect part in new[] { layout.ReleaseLinkStatus, layout.ReleaseLinkReload,
                         layout.ReleaseLinkDiscard, layout.ReleaseLinkKeep }.Where(part => part != default))
                Assert.True(layout.ReleaseLinkFeedback.Contains(part));
        }
        foreach (NativeLayoutRect part in new[] { layout.PlatformHeading, layout.PlatformLabel, layout.Platform,
                     layout.TitleLabel, layout.TitleText, layout.CopyTitle, layout.BodyLabel, layout.BodyText,
                     layout.CopyMain, layout.PostingStatus, layout.PostingAction, layout.PostingHelper }.Where(part => part != default))
            Assert.True(layout.PlatformCard.Contains(part), $"{part} escapes {layout.PlatformCard}");
        foreach (NativeLayoutRect part in new[] { layout.AssetsHeading, layout.AssetCount, layout.DragGuidance, layout.AssetList })
            Assert.True(layout.AssetsCard.Contains(part));

        // Button rectangles are bodies; each window adds a focus margin that must stay on the
        // surface the button sits on (the card, the tinted feedback row, or the footer).
        int margin = NativeCompanionTheme.ButtonFocusMargin(dpi);
        foreach (NativeLayoutRect button in new[] { layout.CopyTitle, layout.CopyMain, layout.PostingAction }
                     .Where(part => part != default))
            Assert.True(layout.PlatformCard.Contains(button.Inflate(margin)), $"{button} focus margin escapes the card");
        if (layout.ReleaseLinkCard != default)
        {
            Assert.Equal(layout.ReleaseLinkField.Height, layout.ReleaseLinkSave.Height);
            Assert.True(layout.ReleaseLinkCard.Contains(layout.ReleaseLinkSave.Inflate(margin)));
            foreach (NativeLayoutRect button in new[] { layout.ReleaseLinkReload, layout.ReleaseLinkDiscard,
                         layout.ReleaseLinkKeep }.Where(part => part != default))
                Assert.True(layout.ReleaseLinkFeedback.Contains(button.Inflate(margin)),
                    $"{button} focus margin escapes the feedback row {layout.ReleaseLinkFeedback}");
        }
        Assert.True(layout.Footer.Contains(layout.Close.Inflate(margin)));
        Assert.True(layout.Footer.Contains(layout.PostingAggregate));
        if (layout.Status != default) Assert.True(layout.Footer.Contains(layout.Status));
        Assert.False(layout.Close.Intersects(layout.PostingAggregate));
        Assert.False(layout.Close.Intersects(layout.Status));
        Assert.True(layout.Close.Right <= client.Width);
        Assert.Equal(layout.Footer.Y, layout.Viewport.Bottom);
        // The last card (the Release link when present) ends the scrolling column.
        Assert.Equal(cards[^1].Bottom + 16 * dpi / 96 + layout.ScrollOffset, layout.ContentHeight);
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
