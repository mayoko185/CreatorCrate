using Microsoft.Win32;
using System.Runtime.InteropServices;

namespace OpenLocally;

internal enum NativeCompanionThemeMode { Dark, Light, HighContrast }
internal enum NativeCompanionFontRole { ReleaseHeading, SectionHeading, Body, Supporting, Emphasis, Compact }
// Window is the dialog card, Section an inset section card, Nested a field or list inside a section.
internal enum NativeCompanionSurfaceRole { Window, Section, Nested, Footer }
internal enum NativeCompanionTextRole
{
    ReleaseHeading, SectionHeading, Label, Body, Supporting, Status, Success, Danger, Warning,
}
internal enum NativeCompanionChromeRole { Edit, ListView, ListViewHeader, ScrollBar }
internal enum NativeCompanionButtonRole { Primary, Secondary }
// Regular is the refined dialog's 2.25rem action; Small is its 1.875rem .button-small.
internal enum NativeCompanionButtonSize { Regular, Small }
[Flags]
internal enum NativeCompanionButtonState { Normal = 0, Hover = 1, Pressed = 2, Focused = 4, Disabled = 8 }
internal enum NativeCompanionFeedbackTone { Neutral, Success, Error, Warning }
internal enum NativeCompanionControlRole
{
    TopLevel, Heading, Metadata, Card, SectionHeading, Label, Edit,
    PrimaryButton, Button, Status, ListView, ListViewHeader,
}

internal readonly record struct NativeCompanionFontSpec(string Family, int LogicalPixelHeight, int Weight);
internal readonly record struct NativeCompanionSurfaceStyle(
    int Background, int Border, int Radius, bool Decorative);
internal readonly record struct NativeCompanionTextStyle(int Background, int Text);
internal readonly record struct NativeCompanionControlStyle(
    NativeCompanionFontRole FontRole, int Background, int Text, bool CustomDraw);

internal readonly record struct NativeHeaderChromeStyle(
    int Background, int Text, int Divider, int BottomEdge, bool CustomDraw);

internal readonly record struct NativeListViewSelectionStyle(
    int Background, int Text, int Accent, bool CustomDraw);

/// <summary>
/// Owner-drawn push button. The window extends a focus margin beyond the button body so the
/// focus ring never shifts the body; the surface the button sits on fills that margin.
/// ContentOffset moves the whole body down while pressed; Strikeout marks disabled labels.
/// </summary>
internal readonly record struct NativeCompanionButtonStyle(
    int Background, int Text, int Border, int BorderWidth,
    int ContentOffset, bool UsesSystemFrame, int FocusRing = -1, int FocusRingWidth = 0,
    int Radius = 0, NativeCompanionFontRole FontRole = NativeCompanionFontRole.Body,
    int Padding = 0, bool Strikeout = false, int InsetBorder = -1);

/// <summary>One segment of the platform tab strip, drawn over the native SysTabControl32.</summary>
internal readonly record struct NativeCompanionTabStyle(
    int Background, int Text, NativeCompanionFontRole FontRole, int FocusRing, bool CustomDraw);

/// <summary>Parent-drawn frame around a borderless Edit or ListView.</summary>
internal readonly record struct NativeCompanionFieldStyle(
    int Background, int Border, int BorderWidth, int Radius);

/// <summary>Tinted feedback row: an accent bar beside a lightly tinted background, or a plain frame in high contrast.</summary>
internal readonly record struct NativeCompanionFeedbackStyle(
    int Background, int Accent, bool Tinted, bool Framed);

internal readonly record struct NativeCompanionPalette(
    NativeCompanionThemeMode Mode,
    int Page,
    int Surface,
    int Card,
    int Hover,
    int Border,
    int BorderStrong,
    int Text,
    int MutedText,
    int Accent,
    int AccentSecondary,
    int Focus,
    int Success,
    int Danger,
    int SelectionBackground,
    int SelectionText,
    int PrimaryButtonText,
    int ButtonFace,
    int ButtonText,
    int DisabledText)
{
    public bool UsesDecorativeColors => Mode != NativeCompanionThemeMode.HighContrast;
    // CreatorCrate's --warning token is the violet accent; there is no amber family.
    public int Warning => AccentSecondary;

    // CreatorCrate's authoritative web palette from src/static/creatorcrate.css.
    public static NativeCompanionPalette Dark => new(
        NativeCompanionThemeMode.Dark,
        Color("#0d0f13"), Color("#171b22"), Color("#1d222b"), Color("#232a38"),
        Color("#262c37"), Color("#3a4353"), Color("#e8ecf1"), Color("#8b93a3"),
        Color("#22d3ee"), Color("#a78bfa"), Color("#58a6ff"), Color("#34d399"),
        Color("#fb7185"), Color("#232a38"), Color("#e8ecf1"), Color("#06131a"),
        Color("#171b22"), Color("#e8ecf1"), Color("#8b93a3"));

    // CreatorCrate light adaptation. The web application does not define a canonical light palette.
    public static NativeCompanionPalette Light => new(
        NativeCompanionThemeMode.Light,
        Color("#f5f7fa"), Color("#ffffff"), Color("#f8fafc"), Color("#eaf1f8"),
        Color("#d7dee8"), Color("#aab6c5"), Color("#17202b"), Color("#5f6b7a"),
        Color("#0891b2"), Color("#7c3aed"), Color("#0969da"), Color("#087f5b"),
        Color("#c52f48"), Color("#dcebf5"), Color("#17202b"), Color("#06131a"),
        Color("#ffffff"), Color("#17202b"), Color("#5f6b7a"));

    public static NativeCompanionPalette HighContrast => new(
        NativeCompanionThemeMode.HighContrast,
        GetSystemColor(5), GetSystemColor(5), GetSystemColor(5), GetSystemColor(13),
        GetSystemColor(8), GetSystemColor(8), GetSystemColor(8), GetSystemColor(17),
        GetSystemColor(13), GetSystemColor(13), GetSystemColor(13), GetSystemColor(8),
        GetSystemColor(8), GetSystemColor(13), GetSystemColor(14), GetSystemColor(14),
        GetSystemColor(15), GetSystemColor(18), GetSystemColor(17));

    public static NativeCompanionPalette Choose(bool highContrast, bool appsUseLightTheme) =>
        highContrast ? HighContrast : appsUseLightTheme ? Light : Dark;

    internal static int Color(string hex)
    {
        if (hex.Length != 7 || hex[0] != '#') throw new ArgumentException("Expected #RRGGBB.", nameof(hex));
        int red = Convert.ToInt32(hex.AsSpan(1, 2).ToString(), 16);
        int green = Convert.ToInt32(hex.AsSpan(3, 2).ToString(), 16);
        int blue = Convert.ToInt32(hex.AsSpan(5, 2).ToString(), 16);
        return red | green << 8 | blue << 16;
    }

    internal static string Hex(int color) => $"#{color & 0xff:x2}{color >> 8 & 0xff:x2}{color >> 16 & 0xff:x2}";

    /// <summary>Linear sRGB-space blend used for hover and tint derivations of the CSS tokens.</summary>
    internal static int Mix(int from, int to, double amount)
    {
        amount = Math.Clamp(amount, 0, 1);
        int Channel(int shift) => (int)Math.Round(
            (from >> shift & 0xff) * (1 - amount) + (to >> shift & 0xff) * amount);
        return Channel(0) | Channel(8) << 8 | Channel(16) << 16;
    }

    private static int GetSystemColor(int index)
    {
        try { return GetSysColor(index); }
        catch { return index == 13 ? Color("#0078d4") : index == 14 ? Color("#ffffff") : Color("#000000"); }
    }

    [DllImport("user32.dll")] private static extern int GetSysColor(int index);
}

internal static class NativeCompanionThemeDetector
{
    private const uint SpiGetHighContrast = 0x0042;
    private const uint HcfHighContrastOn = 0x00000001;

    public static NativeCompanionPalette Detect()
    {
        bool highContrast = false;
        try
        {
            var settings = new HighContrast { cbSize = (uint)Marshal.SizeOf<HighContrast>() };
            highContrast = SystemParametersInfo(SpiGetHighContrast, settings.cbSize, ref settings, 0) &&
                (settings.dwFlags & HcfHighContrastOn) != 0;
        }
        catch { }

        bool light = true;
        try
        {
            using RegistryKey? personalize = Registry.CurrentUser.OpenSubKey(
                @"Software\Microsoft\Windows\CurrentVersion\Themes\Personalize", writable: false);
            if (personalize?.GetValue("AppsUseLightTheme") is int value) light = value != 0;
        }
        catch { }

        return NativeCompanionPalette.Choose(highContrast, light);
    }

    /// <summary>Windows "Make text bigger" (Settings › Accessibility › Text size), 100–225 percent.</summary>
    public static int DetectTextScale()
    {
        try
        {
            using RegistryKey? accessibility = Registry.CurrentUser.OpenSubKey(
                @"Software\Microsoft\Accessibility", writable: false);
            if (accessibility?.GetValue("TextScaleFactor") is int value)
                return NativeCompanionTheme.ClampTextScale(value);
        }
        catch { }
        return 100;
    }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct HighContrast
    {
        public uint cbSize;
        public uint dwFlags;
        public IntPtr lpszDefaultScheme;
    }

    [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool SystemParametersInfo(uint action, uint parameter, ref HighContrast value, uint flags);
}

/// <summary>Owns the bounded GDI palette and DPI-aware fonts used only by native CreatorCrate companion windows.</summary>
internal sealed class NativeCompanionTheme : IDisposable
{
    private const int Transparent = 1;
    private const int DwmwaUseImmersiveDarkMode = 20;
    internal const int MinimumTextScale = 100, MaximumTextScale = 225;
    private readonly Dictionary<int, IntPtr> _brushes = [];
    private readonly Dictionary<NativeCompanionFontRole, IntPtr> _fonts = [];
    private readonly Func<IntPtr, string?, string?, int> _setWindowTheme;
    private readonly int? _fixedTextScale;

    public NativeCompanionTheme(int dpi)
        : this(dpi, NativeCompanionThemeDetector.Detect(), SetWindowTheme, null) { }

    internal NativeCompanionTheme(int dpi, NativeCompanionPalette palette, int textScale = MinimumTextScale)
        : this(dpi, palette, SetWindowTheme, textScale) { }

    internal NativeCompanionTheme(
        int dpi,
        NativeCompanionPalette palette,
        Func<IntPtr, string?, string?, int> setWindowTheme)
        : this(dpi, palette, setWindowTheme, MinimumTextScale) { }

    private NativeCompanionTheme(
        int dpi,
        NativeCompanionPalette palette,
        Func<IntPtr, string?, string?, int> setWindowTheme,
        int? textScale)
    {
        _setWindowTheme = setWindowTheme ?? throw new ArgumentNullException(nameof(setWindowTheme));
        _fixedTextScale = textScale is int fixedScale ? ClampTextScale(fixedScale) : null;
        Refresh(dpi, palette);
    }

    public NativeCompanionPalette Palette { get; private set; }
    public int Dpi { get; private set; }
    /// <summary>Windows text-size percentage applied to every native font and text-bound metric.</summary>
    public int TextScale { get; private set; } = MinimumTextScale;

    internal static int ClampTextScale(int value) => Math.Clamp(value, MinimumTextScale, MaximumTextScale);

    // Matches the refined dialog type scale: 1rem titles, 0.875rem section headings and body,
    // 0.75rem supporting copy. The release identity header stays one step larger.
    public static NativeCompanionFontSpec FontSpec(NativeCompanionFontRole role) => role switch
    {
        NativeCompanionFontRole.ReleaseHeading => new("Segoe UI", 18, 600),
        NativeCompanionFontRole.SectionHeading => new("Segoe UI", 14, 600),
        NativeCompanionFontRole.Supporting => new("Segoe UI", 12, 400),
        NativeCompanionFontRole.Emphasis => new("Segoe UI", 14, 600),
        NativeCompanionFontRole.Compact => new("Segoe UI", 13, 400),
        _ => new("Segoe UI", 14, 400),
    };

    internal static NativeCompanionSurfaceStyle SurfaceStyle(
        NativeCompanionSurfaceRole role, NativeCompanionPalette palette) => role switch
    {
        NativeCompanionSurfaceRole.Window => new(palette.Card, palette.Border, 0, false),
        NativeCompanionSurfaceRole.Section => new(
            palette.Surface, palette.Border, palette.UsesDecorativeColors ? 12 : 0, palette.UsesDecorativeColors),
        NativeCompanionSurfaceRole.Nested => new(
            palette.Page, palette.Border, palette.UsesDecorativeColors ? 8 : 0, palette.UsesDecorativeColors),
        NativeCompanionSurfaceRole.Footer => new(palette.Surface, palette.Border, 0, palette.UsesDecorativeColors),
        _ => throw new ArgumentOutOfRangeException(nameof(role)),
    };

    internal static NativeCompanionTextStyle TextStyle(
        NativeCompanionTextRole role, NativeCompanionSurfaceRole surface,
        NativeCompanionPalette palette) =>
        TextStyle(role, SurfaceStyle(surface, palette).Background, palette);

    internal static NativeCompanionTextStyle TextStyle(
        NativeCompanionTextRole role, int background, NativeCompanionPalette palette) => role switch
    {
        NativeCompanionTextRole.ReleaseHeading or NativeCompanionTextRole.SectionHeading or
            NativeCompanionTextRole.Body or NativeCompanionTextRole.Status => new(background, palette.Text),
        NativeCompanionTextRole.Label or NativeCompanionTextRole.Supporting => new(background, palette.MutedText),
        NativeCompanionTextRole.Success =>
            new(background, palette.UsesDecorativeColors ? palette.Success : palette.Text),
        NativeCompanionTextRole.Danger =>
            new(background, palette.UsesDecorativeColors ? palette.Danger : palette.Text),
        NativeCompanionTextRole.Warning =>
            new(background, palette.UsesDecorativeColors ? palette.Warning : palette.Text),
        _ => new(background, palette.Text),
    };

    public static NativeCompanionControlStyle ControlStyle(
        NativeCompanionControlRole role, NativeCompanionPalette palette) => role switch
    {
        NativeCompanionControlRole.TopLevel => new(NativeCompanionFontRole.Body, palette.Card, palette.Text, false),
        NativeCompanionControlRole.Heading => new(NativeCompanionFontRole.ReleaseHeading, palette.Card, palette.Text, false),
        NativeCompanionControlRole.Metadata => new(NativeCompanionFontRole.Supporting, palette.Card, palette.MutedText, false),
        NativeCompanionControlRole.Card => new(NativeCompanionFontRole.Body, palette.Surface, palette.Text, false),
        NativeCompanionControlRole.SectionHeading => new(NativeCompanionFontRole.SectionHeading, palette.Surface, palette.Text, false),
        NativeCompanionControlRole.Label => new(NativeCompanionFontRole.Supporting, palette.Surface, palette.MutedText, false),
        NativeCompanionControlRole.Edit => new(NativeCompanionFontRole.Body, palette.Page, palette.Text, true),
        NativeCompanionControlRole.PrimaryButton => new(NativeCompanionFontRole.Emphasis, palette.Page, palette.Text, true),
        NativeCompanionControlRole.Button => new(NativeCompanionFontRole.Body, palette.Surface, palette.Text, true),
        NativeCompanionControlRole.Status => new(NativeCompanionFontRole.Supporting, palette.Surface, palette.MutedText, false),
        NativeCompanionControlRole.ListView => new(NativeCompanionFontRole.Body, palette.Page, palette.Text, true),
        NativeCompanionControlRole.ListViewHeader => new(
            NativeCompanionFontRole.Supporting, palette.Hover, palette.Text, palette.UsesDecorativeColors),
        _ => throw new ArgumentOutOfRangeException(nameof(role)),
    };

    internal static NativeHeaderChromeStyle HeaderChromeStyle(NativeCompanionPalette palette) =>
        new(palette.Hover, palette.Text, palette.Border, palette.BorderStrong, palette.UsesDecorativeColors);

    internal static NativeListViewSelectionStyle ListViewSelectionStyle(NativeCompanionPalette palette) =>
        new(palette.SelectionBackground, palette.SelectionText, palette.Accent, palette.UsesDecorativeColors);

    internal static int StrokeWidth(int dpi) => Math.Max(1, Math.Max(96, dpi) / 96);
    internal static int ControlRadius(int dpi) => Math.Max(1, 8 * Math.Max(96, dpi) / 96);
    // The refined dialog's focus treatment: a 2px outline offset 2px outside the button body.
    internal static int ButtonFocusRingWidth(int dpi) => Math.Max(2, 2 * Math.Max(96, dpi) / 96);
    /// <summary>Space around a button body that the focus ring and its offset occupy.</summary>
    internal static int ButtonFocusMargin(int dpi) => ButtonFocusRingWidth(dpi) * 2;
    /// <summary>Button body height: 2.25rem actions and 1.875rem small actions, following Windows text size.</summary>
    internal static int ButtonHeight(NativeCompanionButtonSize size, int dpi, int textScale = MinimumTextScale) =>
        Math.Max(1, (int)((long)(size == NativeCompanionButtonSize.Small ? 30 : 36) * Math.Max(96, dpi) *
            ClampTextScale(textScale) / (96L * 100)));

    /// <summary>
    /// The refined dialog actions (src/static/creatorcrate.css, "Buttons"): the primary footer
    /// action is a dark outlined button with a semibold label whose border takes the accent on
    /// hover; secondary actions are transparent and outlined, taking the hover surface. Presses
    /// move the button down one pixel. Disabled labels are struck through: a disabled primary
    /// takes the card surface, quiet border and muted label, while a disabled secondary keeps
    /// its outline and label and adds the inset --border ring.
    /// </summary>
    internal static NativeCompanionButtonStyle ButtonStyle(
        NativeCompanionButtonRole role, NativeCompanionButtonState state,
        NativeCompanionPalette palette, int dpi,
        NativeCompanionButtonSize size = NativeCompanionButtonSize.Regular, int? surface = null)
    {
        int scale = Math.Max(96, dpi);
        int S(int value) => Math.Max(1, value * scale / 96);
        int stroke = StrokeWidth(dpi);
        bool disabled = state.HasFlag(NativeCompanionButtonState.Disabled);
        bool pressed = state.HasFlag(NativeCompanionButtonState.Pressed);
        bool hovered = state.HasFlag(NativeCompanionButtonState.Hover);
        bool focused = state.HasFlag(NativeCompanionButtonState.Focused);
        bool primary = role == NativeCompanionButtonRole.Primary;
        bool small = !primary && size == NativeCompanionButtonSize.Small;
        NativeCompanionFontRole font = primary ? NativeCompanionFontRole.Emphasis
            : small ? NativeCompanionFontRole.Compact : NativeCompanionFontRole.Body;
        int padding = primary ? S(12) : small ? S(10) : S(14);
        int focusRing = focused ? palette.Focus : -1;
        int focusWidth = focused ? ButtonFocusRingWidth(dpi) : 0;
        int offset = pressed && !disabled ? stroke : 0;
        if (palette.Mode == NativeCompanionThemeMode.HighContrast)
            return new(
                palette.ButtonFace,
                disabled ? palette.DisabledText : palette.ButtonText,
                palette.ButtonText,
                stroke,
                offset,
                UsesSystemFrame: true, focusRing, focusWidth, 0, font, padding, disabled);

        // Primary: --radius-sm; every other action: --refined-control-radius.
        int radius = primary ? S(6) : ControlRadius(dpi);
        if (disabled)
            return primary
                ? new(palette.Card, palette.MutedText, palette.Border, stroke, 0, false,
                    focusRing, focusWidth, radius, font, padding, Strikeout: true)
                : new(surface ?? palette.Surface, palette.Text, palette.BorderStrong, stroke, 0, false,
                    focusRing, focusWidth, radius, font, padding, Strikeout: true, InsetBorder: palette.Border);

        int background = primary ? palette.Page
            : pressed || hovered ? palette.Hover : surface ?? palette.Surface;
        int border = primary && (hovered || pressed) ? palette.Accent : palette.BorderStrong;
        return new(background, palette.Text, border, stroke, offset, false,
            focusRing, focusWidth, radius, font, padding);
    }

    internal static NativeCompanionTabStyle TabStyle(
        bool selected, bool hovered, bool focused, NativeCompanionPalette palette)
    {
        if (!palette.UsesDecorativeColors)
            return new(palette.ButtonFace, palette.ButtonText, NativeCompanionFontRole.Body, palette.Focus, false);
        // The CreatorCrate view switcher: the current option takes the accent, the rest stay quiet.
        if (selected)
            return new(palette.Accent, palette.PrimaryButtonText, NativeCompanionFontRole.Emphasis,
                focused ? palette.Focus : -1, true);
        return new(hovered ? palette.Hover : palette.Surface, hovered ? palette.Text : palette.MutedText,
            NativeCompanionFontRole.Body, focused ? palette.Focus : -1, true);
    }

    internal static NativeCompanionFieldStyle FieldStyle(
        bool focused, NativeCompanionFeedbackTone tone, NativeCompanionPalette palette, int dpi)
    {
        int stroke = StrokeWidth(dpi);
        int border = focused ? palette.Focus
            : !palette.UsesDecorativeColors ? palette.Text
            : tone == NativeCompanionFeedbackTone.Error ? palette.Danger
            : tone == NativeCompanionFeedbackTone.Warning ? palette.Warning
            : palette.Border;
        return new(palette.Page, border, focused ? stroke * 2 : stroke,
            palette.UsesDecorativeColors ? ControlRadius(dpi) : 0);
    }

    internal static NativeCompanionFeedbackStyle FeedbackStyle(
        NativeCompanionFeedbackTone tone, NativeCompanionPalette palette)
    {
        bool attention = tone is NativeCompanionFeedbackTone.Error or NativeCompanionFeedbackTone.Warning;
        if (!palette.UsesDecorativeColors)
            return new(palette.Surface, palette.Text, false, attention);
        if (!attention) return new(palette.Surface, palette.Border, false, false);
        int accent = tone == NativeCompanionFeedbackTone.Error ? palette.Danger : palette.Warning;
        return new(NativeCompanionPalette.Mix(palette.Surface, accent,
            palette.Mode == NativeCompanionThemeMode.Light ? 0.08 : 0.12), accent, true, false);
    }

    internal static int RoundedRectEllipseDiameter(int radius) => Math.Max(0, radius) * 2;

    /// <summary>The refined section heading's 3 by 14 pixel accent mark, centred on the heading row.</summary>
    internal static NativeLayoutRect AccentMarkBounds(NativeLayoutRect heading, int dpi)
    {
        int scale = Math.Max(96, dpi);
        int width = Math.Max(1, 3 * scale / 96);
        int height = Math.Min(heading.Height, 14 * scale / 96);
        return new(heading.X - AccentMarkOffset(dpi), heading.Y + (heading.Height - height) / 2, width, height);
    }

    internal static int AccentMarkOffset(int dpi) => 11 * Math.Max(96, dpi) / 96;

    internal static int ListViewSelectionAccentWidth(int dpi) =>
        Math.Max(1, 2 * Math.Max(96, dpi) / 96);

    internal static NativeLayoutRect ListViewSelectionAccentBounds(
        NativeLayoutRect client, NativeLayoutRect row, int dpi)
    {
        int left = Math.Max(client.X, row.X);
        int top = Math.Max(client.Y, row.Y);
        int right = Math.Min(client.Right, row.Right);
        int bottom = Math.Min(client.Bottom, row.Bottom);
        if (right <= left || bottom <= top) return default;
        int width = Math.Min(ListViewSelectionAccentWidth(dpi), right - left);
        return new(left, top, width, bottom - top);
    }

    internal static int HeaderTextInset(int dpi) => Math.Max(1, 8 * Math.Max(96, dpi) / 96);

    internal static NativeLayoutRect HeaderTextBounds(NativeLayoutRect cell, int dpi)
    {
        int inset = HeaderTextInset(dpi);
        return new(cell.X + inset, cell.Y, Math.Max(0, cell.Width - inset * 2), cell.Height);
    }

    internal static NativeLayoutRect HeaderTrailingBounds(NativeLayoutRect client, IEnumerable<NativeLayoutRect> items)
    {
        int clientRight = Math.Max(client.X, client.Right);
        int finalRight = items.Select(item => item.Right).DefaultIfEmpty(client.X).Max();
        int left = Math.Clamp(finalRight, client.X, clientRight);
        return new(left, client.Y, clientRight - left, Math.Max(0, client.Height));
    }

    internal static int HeaderStrokeWidth(int dpi) => Math.Max(1, Math.Max(96, dpi) / 96);

    public void Refresh(int dpi) => Refresh(dpi, null);

    private void Refresh(int dpi, NativeCompanionPalette? palette)
    {
        ReleaseResources();
        Dpi = Math.Max(96, dpi);
        Palette = palette ?? NativeCompanionThemeDetector.Detect();
        TextScale = _fixedTextScale ?? NativeCompanionThemeDetector.DetectTextScale();
        try
        {
            foreach (NativeCompanionFontRole role in Enum.GetValues<NativeCompanionFontRole>())
            {
                NativeCompanionFontSpec spec = FontSpec(role);
                int height = -MulDiv(spec.LogicalPixelHeight * TextScale, Dpi, 96 * 100);
                IntPtr font = CreateFont(height, 0, 0, 0, spec.Weight, 0, 0, 0, 1, 0, 0, 5, 0, spec.Family);
                if (font == IntPtr.Zero) throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
                _fonts[role] = font;
            }
        }
        catch { ReleaseResources(); throw; }
    }

    public IntPtr Font(NativeCompanionFontRole role) => _fonts[role];

    public IntPtr Brush(int color)
    {
        if (_brushes.TryGetValue(color, out IntPtr brush)) return brush;
        brush = CreateSolidBrush(color);
        if (brush == IntPtr.Zero) throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
        _brushes[color] = brush;
        return brush;
    }

    public IntPtr PrepareTextDevice(IntPtr device, int textColor, int backgroundColor, bool transparent = false)
    {
        SetTextColor(device, textColor);
        SetBkColor(device, backgroundColor);
        if (transparent) SetBkMode(device, Transparent);
        return Brush(backgroundColor);
    }

    public void ApplyTitleBar(IntPtr window)
    {
        if (window == IntPtr.Zero) return;
        int dark = Palette.Mode == NativeCompanionThemeMode.Dark ? 1 : 0;
        try { _ = DwmSetWindowAttribute(window, DwmwaUseImmersiveDarkMode, ref dark, sizeof(int)); }
        catch { }
    }

    /// <summary>
    /// Best-effort, window-local theme-name hint for common-control chrome that color messages cannot reach
    /// (notably native scrollbars). Owner drawing/control colors remain the readable fallback.
    /// </summary>
    public bool ApplyControlChrome(IntPtr control, NativeCompanionChromeRole role)
    {
        if (control == IntPtr.Zero) return false;
        string? theme = Palette.Mode == NativeCompanionThemeMode.Dark ? "DarkMode_Explorer" : null;
        try { return _setWindowTheme(control, theme, null) >= 0; }
        catch { return false; }
    }

    public void Dispose()
    {
        ReleaseResources();
        GC.SuppressFinalize(this);
    }

    private void ReleaseResources()
    {
        foreach (IntPtr brush in _brushes.Values) if (brush != IntPtr.Zero) DeleteObject(brush);
        foreach (IntPtr font in _fonts.Values) if (font != IntPtr.Zero) DeleteObject(font);
        _brushes.Clear();
        _fonts.Clear();
    }

    [DllImport("gdi32.dll", SetLastError = true)] private static extern IntPtr CreateSolidBrush(int color);
    [DllImport("gdi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern IntPtr CreateFont(int height, int width, int escapement, int orientation, int weight,
        uint italic, uint underline, uint strikeOut, uint charSet, uint outputPrecision, uint clipPrecision,
        uint quality, uint pitchAndFamily, string faceName);
    [DllImport("gdi32.dll")] private static extern bool DeleteObject(IntPtr value);
    [DllImport("gdi32.dll")] private static extern int SetTextColor(IntPtr device, int color);
    [DllImport("gdi32.dll")] private static extern int SetBkColor(IntPtr device, int color);
    [DllImport("gdi32.dll")] private static extern int SetBkMode(IntPtr device, int mode);
    [DllImport("kernel32.dll")] private static extern int MulDiv(int number, int numerator, int denominator);
    [DllImport("dwmapi.dll")] private static extern int DwmSetWindowAttribute(IntPtr window, int attribute, ref int value, int size);
    [DllImport("uxtheme.dll", CharSet = CharSet.Unicode)] private static extern int SetWindowTheme(IntPtr window, string? subAppName, string? subIdList);
}

internal readonly record struct NativeLayoutRect(int X, int Y, int Width, int Height)
{
    public int Right => X + Width;
    public int Bottom => Y + Height;
    public bool Intersects(NativeLayoutRect other) => X < other.Right && Right > other.X && Y < other.Bottom && Bottom > other.Y;
    public bool Contains(NativeLayoutRect other) =>
        other.X >= X && other.Y >= Y && other.Right <= Right && other.Bottom <= Bottom;
    public NativeLayoutRect Offset(int dy) => this == default ? default : this with { Y = Y + dy };
    public NativeLayoutRect Inflate(int amount) => new(X - amount, Y - amount, Width + amount * 2, Height + amount * 2);
}

internal readonly record struct NativeLayoutSize(int Width, int Height);

/// <summary>Measures the pixel height of word-wrapped text at a width in the given font role.</summary>
internal delegate int NativeTextMeasure(string text, int width, NativeCompanionFontRole role);

/// <summary>Visible parts of the release-wide Release link section; it sits below, and outside, the platform tabs and Assets.</summary>
internal sealed record NativeReleaseLinkLayoutRequest(
    string StatusText, bool ShowReload, bool ShowDiscard, bool ShowKeep);

/// <summary>
/// Responsive layout for the Posting Helper. Header, Content, Assets and Release link form one
/// vertically scrolling column above a pinned footer, mirroring the refined dialog's scrolling body
/// and fixed footer. Every rectangle is in client coordinates with the scroll offset applied.
/// </summary>
internal sealed record NativeCompanionLayout
{
    // 640 by 600 is the approved narrow-window target for the usable client area. Below the
    // height the content needs, the body scrolls instead of compressing or overlapping controls.
    internal const int SupportedMinimumLogicalClientWidth = 640;
    internal const int RequiredLogicalClientHeight = 600;
    internal static NativeLayoutSize SupportedMinimumLogicalClientSize { get; } =
        new(SupportedMinimumLogicalClientWidth, RequiredLogicalClientHeight);
    internal const int MaximumLogicalContentWidth = 1152;

    public NativeLayoutRect HeaderTitle { get; init; }
    public NativeLayoutRect HeaderMetadata { get; init; }
    public NativeLayoutRect HeaderDivider { get; init; }
    public NativeLayoutRect ReleaseLinkCard { get; init; }
    public NativeLayoutRect ReleaseLinkLabel { get; init; }
    public NativeLayoutRect ReleaseLinkField { get; init; }
    public NativeLayoutRect ReleaseLinkInput { get; init; }
    public NativeLayoutRect ReleaseLinkSave { get; init; }
    public NativeLayoutRect ReleaseLinkReload { get; init; }
    public NativeLayoutRect ReleaseLinkDiscard { get; init; }
    public NativeLayoutRect ReleaseLinkKeep { get; init; }
    public NativeLayoutRect ReleaseLinkFeedback { get; init; }
    public NativeLayoutRect ReleaseLinkStatus { get; init; }
    public NativeLayoutRect PlatformCard { get; init; }
    public NativeLayoutRect PlatformHeading { get; init; }
    public NativeLayoutRect PlatformLabel { get; init; }
    public NativeLayoutRect Platform { get; init; }
    public NativeLayoutRect TitleLabel { get; init; }
    public NativeLayoutRect TitleText { get; init; }
    public NativeLayoutRect CopyTitle { get; init; }
    public NativeLayoutRect BodyLabel { get; init; }
    public NativeLayoutRect BodyText { get; init; }
    public NativeLayoutRect CopyMain { get; init; }
    public NativeLayoutRect PostingDivider { get; init; }
    public NativeLayoutRect PostingStatus { get; init; }
    public NativeLayoutRect PostingHelper { get; init; }
    public NativeLayoutRect PostingAction { get; init; }
    public NativeLayoutRect AssetsCard { get; init; }
    public NativeLayoutRect AssetsHeading { get; init; }
    public NativeLayoutRect AssetCount { get; init; }
    public NativeLayoutRect DragGuidance { get; init; }
    public NativeLayoutRect AssetList { get; init; }
    public NativeLayoutRect Footer { get; init; }
    public NativeLayoutRect PostingAggregate { get; init; }
    public NativeLayoutRect Status { get; init; }
    public NativeLayoutRect Close { get; init; }
    /// <summary>The scrolling region above the footer; scrolled controls are clipped to it.</summary>
    public NativeLayoutRect Viewport { get; init; }
    public NativeLayoutRect ScrollBar { get; init; }
    public int ContentHeight { get; init; }
    public int ScrollOffset { get; init; }
    public int MaximumScrollOffset => Math.Max(0, ContentHeight - Viewport.Height);
    public bool IsScrollable => MaximumScrollOffset > 0;

    public static NativeCompanionLayout Calculate(int clientWidth, int clientHeight, int dpi, bool patreon,
        string postingStatusText = "", string postingHelperText = "", bool hasPosting = true,
        string operationalStatusText = "", int desiredAssetListHeight = 0,
        NativeReleaseLinkLayoutRequest? releaseLink = null,
        int scrollOffset = 0, int textScale = 100, NativeTextMeasure? measure = null,
        int minimumAssetListHeight = 0, string releaseTitle = "", string headerMetadata = "",
        int platformTabsWidth = 0, string dragGuidanceText = "", int scrollBarWidth = 0)
    {
        int scale = Math.Max(96, dpi);
        int text = NativeCompanionTheme.ClampTextScale(textScale);
        int S(int value) => Math.Max(1, value * scale / 96);
        // Text-bound sizes follow the Windows text-size setting as well as DPI.
        int T(int value) => Math.Max(1, (int)((long)value * scale * text / (96L * 100)));
        int stroke = NativeCompanionTheme.StrokeWidth(dpi);
        int outer = S(16), gap = S(12), padTop = S(12), padX = S(16), padBottom = S(16);
        int headingH = T(20), headingGap = S(10), labelH = T(18), fieldH = T(36);
        // Button rectangles are the visible bodies; the window adds ButtonFocusMargin around each.
        int buttonH = NativeCompanionTheme.ButtonHeight(NativeCompanionButtonSize.Regular, dpi, text);
        int smallButtonH = NativeCompanionTheme.ButtonHeight(NativeCompanionButtonSize.Small, dpi, text);
        int accent = NativeCompanionTheme.AccentMarkOffset(dpi);
        int rowGap = S(8);
        int sbWidth = scrollBarWidth > 0 ? scrollBarWidth : S(17);

        int Measure(string value, int width, NativeCompanionFontRole role)
        {
            int line = role switch
            {
                NativeCompanionFontRole.ReleaseHeading => T(24),
                NativeCompanionFontRole.Supporting => T(16),
                _ => T(20),
            };
            if (string.IsNullOrEmpty(value) || width <= 0) return line;
            if (measure is not null) return Math.Max(line, measure(value, width, role));
            int character = role switch
            {
                NativeCompanionFontRole.ReleaseHeading => 9,
                NativeCompanionFontRole.Supporting => 6,
                _ => 7,
            };
            int columns = Math.Max(1, width / Math.Max(1, T(character)));
            int lines = 1, used = 0;
            foreach (string word in value.Split(' ', StringSplitOptions.RemoveEmptyEntries))
            {
                int length = word.Length + (used == 0 ? 0 : 1);
                if (used > 0 && used + length > columns) { lines++; used = word.Length; }
                else used += length;
            }
            return lines * line;
        }

        int Lines(int height, int line, int maximum) => Math.Min(height, line * maximum);

        // Footer: full client width, pinned to the bottom, aligned with the content column.
        int FooterColumnWidth(int available) =>
            Math.Min(S(MaximumLogicalContentWidth), Math.Max(S(200), available - outer * 2));
        int footerColumn = FooterColumnWidth(clientWidth);
        int footerColumnX = (clientWidth - footerColumn) / 2;
        int closeW = T(96);
        int footerTextX = footerColumnX + padX;
        int closeX = footerColumnX + footerColumn - padX - closeW;
        int footerTextW = Math.Max(S(80), closeX - S(12) - footerTextX);
        int aggregateH = hasPosting ? labelH : 0;
        int footerStatusH = string.IsNullOrWhiteSpace(operationalStatusText) ? 0
            : Lines(Measure(operationalStatusText, footerTextW, NativeCompanionFontRole.Supporting), T(16), 2);
        int footerTextH = aggregateH + (footerStatusH > 0 ? (aggregateH > 0 ? S(2) : 0) + footerStatusH : 0);
        int footerContentH = Math.Max(buttonH, footerTextH);
        int footerH = S(12) + footerContentH + S(12);
        int footerTop = Math.Max(0, clientHeight - footerH);
        var footer = new NativeLayoutRect(0, footerTop, clientWidth, footerH);
        var close = new NativeLayoutRect(closeX, footerTop + S(12) + (footerContentH - buttonH) / 2, closeW, buttonH);
        int footerTextY = footerTop + S(12) + (footerContentH - footerTextH) / 2;
        var aggregate = hasPosting ? new NativeLayoutRect(footerTextX, footerTextY, footerTextW, aggregateH) : default;
        var status = footerStatusH > 0
            ? new NativeLayoutRect(footerTextX, footerTextY + (hasPosting ? aggregateH + S(2) : 0), footerTextW, footerStatusH)
            : default;
        var viewport = new NativeLayoutRect(0, 0, clientWidth, footerTop);

        int bodyMin = T(88), bodyMax = T(240);
        int listDesired = desiredAssetListHeight > 0 ? desiredAssetListHeight : S(176);
        int listMin = Math.Min(listDesired,
            minimumAssetListHeight > 0 ? minimumAssetListHeight : desiredAssetListHeight > 0 ? listDesired : S(124));

        NativeCompanionLayout Build(int availableWidth, int bodyH, int listH)
        {
            int contentWidth = Math.Min(S(MaximumLogicalContentWidth), Math.Max(S(200), availableWidth - outer * 2));
            int contentX = Math.Max(0, (availableWidth - contentWidth) / 2);
            int innerX = contentX + padX, innerW = Math.Max(S(120), contentWidth - padX * 2);
            int y = outer;

            int titleH = Lines(Measure(releaseTitle, contentWidth, NativeCompanionFontRole.ReleaseHeading), T(24), 3);
            var headerTitle = new NativeLayoutRect(contentX, y, contentWidth, titleH);
            y = headerTitle.Bottom + S(2);
            int metadataH = Lines(Measure(headerMetadata, contentWidth, NativeCompanionFontRole.Supporting), T(16), 2);
            var headerMetadataRect = new NativeLayoutRect(contentX, y, contentWidth, metadataH);
            y = headerMetadataRect.Bottom + S(12);
            var headerDivider = new NativeLayoutRect(contentX, y, contentWidth, stroke);
            y = headerDivider.Bottom + S(12);

            // Content: section heading with the platform tab strip, prepared text, posting confirmation.
            int platformY = y, py = y + padTop;
            int tabsW = Math.Min(innerW, platformTabsWidth > 0 ? platformTabsWidth : T(88) * 3 + S(4));
            int tabH = T(36);
            int headingTextW = T(84);
            int platformLabelW = T(60);
            NativeLayoutRect platformHeading, platformLabel, platform;
            // The tab strip and its visible label share the heading row when they fit beside it.
            if (innerW - accent - headingTextW - S(12) >= platformLabelW + rowGap + tabsW)
            {
                int rowH = Math.Max(headingH, tabH);
                platform = new NativeLayoutRect(innerX + innerW - tabsW, py + (rowH - tabH) / 2, tabsW, tabH);
                platformLabel = new NativeLayoutRect(platform.X - rowGap - platformLabelW,
                    py + (rowH - labelH) / 2, platformLabelW, labelH);
                platformHeading = new NativeLayoutRect(innerX + accent, py + (rowH - headingH) / 2,
                    Math.Max(0, platformLabel.X - S(12) - innerX - accent), headingH);
                py += rowH + headingGap;
            }
            else
            {
                platformHeading = new NativeLayoutRect(innerX + accent, py, innerW - accent, headingH);
                py = platformHeading.Bottom + rowGap;
                int stripW = Math.Min(tabsW, innerW - platformLabelW - rowGap);
                platformLabel = new NativeLayoutRect(innerX, py + (tabH - labelH) / 2, platformLabelW, labelH);
                platform = new NativeLayoutRect(platformLabel.Right + rowGap, py, Math.Max(S(80), stripW), tabH);
                py = platform.Bottom + headingGap;
            }

            NativeLayoutRect titleLabel = default, titleText = default, copyTitle = default;
            int copyW = T(132);
            if (patreon)
            {
                copyTitle = new NativeLayoutRect(innerX + innerW - copyW, py, copyW, buttonH);
                titleLabel = new NativeLayoutRect(innerX, py + (buttonH - labelH) / 2,
                    Math.Max(0, copyTitle.X - innerX - rowGap), labelH);
                titleText = new NativeLayoutRect(innerX, copyTitle.Bottom + S(4), innerW, T(48));
                py = titleText.Bottom + gap;
            }
            var copyMain = new NativeLayoutRect(innerX + innerW - copyW, py, copyW, buttonH);
            var bodyLabel = new NativeLayoutRect(innerX, py + (buttonH - labelH) / 2,
                Math.Max(0, copyMain.X - innerX - rowGap), labelH);
            var bodyText = new NativeLayoutRect(innerX, copyMain.Bottom + S(4), innerW, bodyH);
            py = bodyText.Bottom;

            NativeLayoutRect postingDivider = default, postingStatus = default, postingAction = default,
                postingHelper = default;
            if (hasPosting)
            {
                py += gap;
                postingDivider = new NativeLayoutRect(innerX, py, innerW, stroke);
                py = postingDivider.Bottom + gap;
                int actionW = T(168);
                int sideW = innerW - actionW - gap;
                if (sideW >= S(220))
                {
                    int textH = Measure(postingStatusText, sideW, NativeCompanionFontRole.Body);
                    int rowH = Math.Max(buttonH, textH);
                    postingStatus = new NativeLayoutRect(innerX, py + (rowH - textH) / 2, sideW, textH);
                    postingAction = new NativeLayoutRect(postingStatus.Right + gap, py + (rowH - buttonH) / 2, actionW, buttonH);
                    py += rowH;
                }
                else
                {
                    int textH = Measure(postingStatusText, innerW, NativeCompanionFontRole.Body);
                    postingStatus = new NativeLayoutRect(innerX, py, innerW, textH);
                    postingAction = new NativeLayoutRect(innerX, postingStatus.Bottom + rowGap, actionW, buttonH);
                    py = postingAction.Bottom;
                }
                // One helper line stays reserved so the Posted state does not pull the Assets card up.
                int helperH = Measure(postingHelperText, innerW, NativeCompanionFontRole.Supporting);
                postingHelper = new NativeLayoutRect(innerX, py + S(4), innerW, helperH);
                py = postingHelper.Bottom;
            }
            var platformCard = new NativeLayoutRect(contentX, platformY, contentWidth, py + padBottom - platformY);
            y = platformCard.Bottom + gap;

            int assetsY = y, ay = y + padTop;
            int countW = Math.Min(T(180), innerW / 2);
            var assetCount = new NativeLayoutRect(innerX + innerW - countW, ay + (headingH - labelH) / 2, countW, labelH);
            var assetsHeading = new NativeLayoutRect(innerX + accent, ay,
                Math.Max(0, assetCount.X - rowGap - innerX - accent), headingH);
            ay = assetsHeading.Bottom + S(4);
            int guidanceH = Lines(Measure(dragGuidanceText, innerW, NativeCompanionFontRole.Supporting), T(16), 2);
            var dragGuidance = new NativeLayoutRect(innerX, ay, innerW, Math.Max(labelH, guidanceH));
            ay = dragGuidance.Bottom + rowGap;
            var assetList = new NativeLayoutRect(innerX + stroke, ay + stroke, innerW - stroke * 2, listH);
            ay = assetList.Bottom + stroke;
            var assetsCard = new NativeLayoutRect(contentX, assetsY, contentWidth, ay + padBottom - assetsY);

            // Release link: release-wide, so it follows the platform content and Assets as the last
            // card of the scrolling column, above the pinned footer.
            y = assetsCard.Bottom + gap;
            NativeLayoutRect linkCard = default, linkLabel = default, linkField = default, linkInput = default,
                linkSave = default, linkReload = default, linkDiscard = default, linkKeep = default,
                linkFeedback = default, linkStatus = default;
            if (releaseLink is not null)
            {
                int cy = y + padTop;
                linkLabel = new NativeLayoutRect(innerX + accent, cy, innerW - accent, headingH);
                cy = linkLabel.Bottom + headingGap;
                int saveW = T(104);
                bool saveInline = innerW - saveW - rowGap >= S(220);
                linkField = new NativeLayoutRect(innerX, cy, saveInline ? innerW - saveW - rowGap : innerW, fieldH);
                int inputH = T(20), inputInset = S(10);
                linkInput = new NativeLayoutRect(linkField.X + inputInset, linkField.Y + (fieldH - inputH) / 2,
                    Math.Max(S(40), linkField.Width - inputInset * 2), inputH);
                if (saveInline) linkSave = new NativeLayoutRect(linkField.Right + rowGap, cy, saveW, buttonH);
                cy = linkField.Bottom + S(6);

                // Feedback row: the status message and its recovery actions share one row that always
                // reserves an action's height, so actions appearing or disappearing do not move the page.
                // Recovery actions are small secondary buttons, like the web dialog's conflict actions.
                var actions = new List<(int Width, int Height, Action<NativeLayoutRect> Assign)>();
                if (!saveInline) actions.Add((saveW, buttonH, rect => linkSave = rect));
                if (releaseLink.ShowReload) actions.Add((T(80), smallButtonH, rect => linkReload = rect));
                if (releaseLink.ShowDiscard) actions.Add((T(124), smallButtonH, rect => linkDiscard = rect));
                if (releaseLink.ShowKeep) actions.Add((T(112), smallButtonH, rect => linkKeep = rect));
                int actionsW = actions.Sum(action => action.Width) + Math.Max(0, actions.Count - 1) * rowGap;
                int actionRowH = saveInline ? smallButtonH : buttonH;
                // The padding also holds each action's focus margin inside the tinted row.
                int feedbackPad = S(10), feedbackPadY = S(6);
                int statusSideW = innerW - feedbackPad * 2 - actionsW - (actions.Count > 0 ? S(12) : 0);
                // Below about 48 characters a long conflict message would need many lines beside its
                // actions, so the actions move under the message, wrapping as widely as the row allows.
                bool stacked = actions.Count > 0 && statusSideW < S(340);
                int statusW = stacked || actions.Count == 0 ? innerW - feedbackPad * 2 : statusSideW;
                int statusH = Measure(releaseLink.StatusText, statusW, NativeCompanionFontRole.Supporting);
                var placed = new List<NativeLayoutRect>();
                int actionRows = 0;
                if (stacked)
                {
                    int rowLeft = innerX + feedbackPad;
                    int rowRight = innerX + innerW - feedbackPad;
                    int x = rowLeft, row = 0;
                    foreach ((int width, int height, _) in actions)
                    {
                        int clamped = Math.Min(width, rowRight - rowLeft);
                        if (x > rowLeft && x + clamped > rowRight) { row++; x = rowLeft; }
                        placed.Add(new NativeLayoutRect(x, row * (actionRowH + rowGap) + (actionRowH - height) / 2,
                            clamped, height));
                        x += clamped + rowGap;
                    }
                    actionRows = row + 1;
                }
                int feedbackH = stacked
                    ? feedbackPadY + statusH + rowGap + actionRows * actionRowH + (actionRows - 1) * rowGap + feedbackPadY
                    : Math.Max(actionRowH, statusH) + feedbackPadY * 2;
                linkFeedback = new NativeLayoutRect(innerX, cy, innerW, feedbackH);
                linkStatus = new NativeLayoutRect(innerX + feedbackPad,
                    stacked ? cy + feedbackPadY : cy + (feedbackH - statusH) / 2, statusW, statusH);
                int actionY = stacked ? linkStatus.Bottom + rowGap : cy + (feedbackH - actionRowH) / 2;
                int actionX = innerX + innerW - feedbackPad - actionsW;
                for (int index = 0; index < actions.Count; index++)
                {
                    (int width, int height, Action<NativeLayoutRect> assign) = actions[index];
                    if (stacked) assign(placed[index].Offset(actionY));
                    else
                    {
                        assign(new NativeLayoutRect(actionX, actionY + (actionRowH - height) / 2, width, height));
                        actionX += width + rowGap;
                    }
                }
                cy = linkFeedback.Bottom;
                linkCard = new NativeLayoutRect(contentX, y, contentWidth, cy + padBottom - y);
            }

            return new NativeCompanionLayout
            {
                HeaderTitle = headerTitle, HeaderMetadata = headerMetadataRect, HeaderDivider = headerDivider,
                ReleaseLinkCard = linkCard, ReleaseLinkLabel = linkLabel, ReleaseLinkField = linkField,
                ReleaseLinkInput = linkInput, ReleaseLinkSave = linkSave, ReleaseLinkReload = linkReload,
                ReleaseLinkDiscard = linkDiscard, ReleaseLinkKeep = linkKeep, ReleaseLinkFeedback = linkFeedback,
                ReleaseLinkStatus = linkStatus,
                PlatformCard = platformCard, PlatformHeading = platformHeading, PlatformLabel = platformLabel,
                Platform = platform,
                TitleLabel = titleLabel, TitleText = titleText, CopyTitle = copyTitle,
                BodyLabel = bodyLabel, BodyText = bodyText, CopyMain = copyMain,
                PostingDivider = postingDivider, PostingStatus = postingStatus,
                PostingHelper = postingHelper, PostingAction = postingAction,
                AssetsCard = assetsCard, AssetsHeading = assetsHeading, AssetCount = assetCount,
                DragGuidance = dragGuidance, AssetList = assetList,
                ContentHeight = (linkCard != default ? linkCard.Bottom : assetsCard.Bottom) + outer,
            };
        }

        NativeCompanionLayout Fit(int availableWidth)
        {
            NativeCompanionLayout minimum = Build(availableWidth, bodyMin, listMin);
            int extra = Math.Max(0, footerTop - minimum.ContentHeight);
            // Extra height first lets Assets show its measured rows (up to five), then gives the
            // prepared text its preferred and finally its largest size. Anything short of the
            // minimums scrolls instead.
            int list = listMin + Math.Min(extra, Math.Max(0, listDesired - listMin));
            extra -= list - listMin;
            int body = bodyMin + Math.Min(extra, bodyMax - bodyMin);
            return body == bodyMin && list == listMin ? minimum : Build(availableWidth, body, list);
        }

        NativeCompanionLayout layout = Fit(clientWidth);
        NativeLayoutRect scrollBar = default;
        if (layout.ContentHeight > footerTop)
        {
            layout = Fit(Math.Max(0, clientWidth - sbWidth));
            scrollBar = new NativeLayoutRect(clientWidth - sbWidth, 0, sbWidth, footerTop);
        }
        int maximumOffset = Math.Max(0, layout.ContentHeight - footerTop);
        int offset = Math.Clamp(scrollOffset, 0, maximumOffset);
        int dy = -offset;
        return layout with
        {
            HeaderTitle = layout.HeaderTitle.Offset(dy), HeaderMetadata = layout.HeaderMetadata.Offset(dy),
            HeaderDivider = layout.HeaderDivider.Offset(dy),
            ReleaseLinkCard = layout.ReleaseLinkCard.Offset(dy), ReleaseLinkLabel = layout.ReleaseLinkLabel.Offset(dy),
            ReleaseLinkField = layout.ReleaseLinkField.Offset(dy), ReleaseLinkInput = layout.ReleaseLinkInput.Offset(dy),
            ReleaseLinkSave = layout.ReleaseLinkSave.Offset(dy), ReleaseLinkReload = layout.ReleaseLinkReload.Offset(dy),
            ReleaseLinkDiscard = layout.ReleaseLinkDiscard.Offset(dy), ReleaseLinkKeep = layout.ReleaseLinkKeep.Offset(dy),
            ReleaseLinkFeedback = layout.ReleaseLinkFeedback.Offset(dy), ReleaseLinkStatus = layout.ReleaseLinkStatus.Offset(dy),
            PlatformCard = layout.PlatformCard.Offset(dy), PlatformHeading = layout.PlatformHeading.Offset(dy),
            PlatformLabel = layout.PlatformLabel.Offset(dy), Platform = layout.Platform.Offset(dy),
            TitleLabel = layout.TitleLabel.Offset(dy), TitleText = layout.TitleText.Offset(dy),
            CopyTitle = layout.CopyTitle.Offset(dy), BodyLabel = layout.BodyLabel.Offset(dy),
            BodyText = layout.BodyText.Offset(dy), CopyMain = layout.CopyMain.Offset(dy),
            PostingDivider = layout.PostingDivider.Offset(dy), PostingStatus = layout.PostingStatus.Offset(dy),
            PostingHelper = layout.PostingHelper.Offset(dy), PostingAction = layout.PostingAction.Offset(dy),
            AssetsCard = layout.AssetsCard.Offset(dy), AssetsHeading = layout.AssetsHeading.Offset(dy),
            AssetCount = layout.AssetCount.Offset(dy), DragGuidance = layout.DragGuidance.Offset(dy),
            AssetList = layout.AssetList.Offset(dy),
            Footer = footer, PostingAggregate = aggregate, Status = status, Close = close,
            Viewport = viewport, ScrollBar = scrollBar, ScrollOffset = offset,
        };
    }

    /// <summary>The scroll offset that brings <paramref name="target"/> (current client coordinates) into the viewport.</summary>
    internal int OffsetToReveal(NativeLayoutRect target, int margin)
    {
        if (target == default || !IsScrollable) return ScrollOffset;
        int top = Viewport.Y + margin, bottom = Viewport.Bottom - margin;
        int offset = ScrollOffset;
        if (target.Height > bottom - top || target.Y < top) offset += target.Y - top;
        else if (target.Bottom > bottom) offset += target.Bottom - bottom;
        return Math.Clamp(offset, 0, MaximumScrollOffset);
    }
}
