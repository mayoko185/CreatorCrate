using Microsoft.Win32;
using System.Runtime.InteropServices;

namespace OpenLocally;

internal enum NativeCompanionThemeMode { Dark, Light, HighContrast }
internal enum NativeCompanionFontRole { Heading, SectionHeading, Body, Metadata }
internal enum NativeCompanionChromeRole { Edit, Combo, ListView, ListViewHeader }
internal enum NativeCompanionControlRole
{
    TopLevel, Heading, Metadata, Card, SectionHeading, Label, Edit, Combo,
    PrimaryButton, Button, Status, ListView, ListViewHeader,
}

internal readonly record struct NativeCompanionFontSpec(string Family, int PointSize, int Weight);
internal readonly record struct NativeCompanionControlStyle(
    NativeCompanionFontRole FontRole, int Background, int Text, bool CustomDraw);

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
    int PrimaryButtonText)
{
    public bool UsesDecorativeColors => Mode != NativeCompanionThemeMode.HighContrast;

    // CreatorCrate's authoritative web palette from src/static/creatorcrate.css.
    public static NativeCompanionPalette Dark => new(
        NativeCompanionThemeMode.Dark,
        Color("#0d0f13"), Color("#171b22"), Color("#1d222b"), Color("#232a38"),
        Color("#262c37"), Color("#3a4353"), Color("#e8ecf1"), Color("#8b93a3"),
        Color("#22d3ee"), Color("#a78bfa"), Color("#58a6ff"), Color("#34d399"),
        Color("#fb7185"), Color("#232a38"), Color("#e8ecf1"), Color("#06131a"));

    // CreatorCrate light adaptation. The web application does not define a canonical light palette.
    public static NativeCompanionPalette Light => new(
        NativeCompanionThemeMode.Light,
        Color("#f5f7fa"), Color("#ffffff"), Color("#f8fafc"), Color("#eaf1f8"),
        Color("#d7dee8"), Color("#aab6c5"), Color("#17202b"), Color("#5f6b7a"),
        Color("#0891b2"), Color("#7c3aed"), Color("#0969da"), Color("#087f5b"),
        Color("#c52f48"), Color("#dcebf5"), Color("#17202b"), Color("#06131a"));

    public static NativeCompanionPalette HighContrast => new(
        NativeCompanionThemeMode.HighContrast,
        GetSystemColor(5), GetSystemColor(5), GetSystemColor(5), GetSystemColor(13),
        GetSystemColor(8), GetSystemColor(8), GetSystemColor(8), GetSystemColor(17),
        GetSystemColor(13), GetSystemColor(13), GetSystemColor(13), GetSystemColor(8),
        GetSystemColor(8), GetSystemColor(13), GetSystemColor(14), GetSystemColor(14));

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
    private readonly Dictionary<int, IntPtr> _brushes = [];
    private readonly Dictionary<NativeCompanionFontRole, IntPtr> _fonts = [];

    public NativeCompanionTheme(int dpi) => Refresh(dpi);

    public NativeCompanionPalette Palette { get; private set; }
    public int Dpi { get; private set; }

    public static NativeCompanionFontSpec FontSpec(NativeCompanionFontRole role) => role switch
    {
        NativeCompanionFontRole.Heading => new("Segoe UI", 16, 600),
        NativeCompanionFontRole.SectionHeading => new("Segoe UI", 9, 600),
        NativeCompanionFontRole.Metadata => new("Segoe UI", 9, 400),
        _ => new("Segoe UI", 10, 400),
    };

    public static NativeCompanionControlStyle ControlStyle(
        NativeCompanionControlRole role, NativeCompanionPalette palette) => role switch
    {
        NativeCompanionControlRole.TopLevel => new(NativeCompanionFontRole.Body, palette.Page, palette.Text, false),
        NativeCompanionControlRole.Heading => new(NativeCompanionFontRole.Heading, palette.Page, palette.Text, false),
        NativeCompanionControlRole.Metadata => new(NativeCompanionFontRole.Metadata, palette.Page, palette.MutedText, false),
        NativeCompanionControlRole.Card => new(NativeCompanionFontRole.Body, palette.Card, palette.Text, false),
        NativeCompanionControlRole.SectionHeading => new(NativeCompanionFontRole.SectionHeading, palette.Card, palette.MutedText, false),
        NativeCompanionControlRole.Label => new(NativeCompanionFontRole.Body, palette.Card, palette.Text, false),
        NativeCompanionControlRole.Edit => new(NativeCompanionFontRole.Body, palette.Page, palette.Text, false),
        NativeCompanionControlRole.Combo => new(NativeCompanionFontRole.Body, palette.Page, palette.Text, true),
        NativeCompanionControlRole.PrimaryButton => new(NativeCompanionFontRole.Body, palette.Accent, palette.PrimaryButtonText, true),
        NativeCompanionControlRole.Button => new(NativeCompanionFontRole.Body, palette.Surface, palette.Text, true),
        NativeCompanionControlRole.Status => new(NativeCompanionFontRole.Metadata, palette.Surface, palette.MutedText, false),
        NativeCompanionControlRole.ListView => new(NativeCompanionFontRole.Body, palette.Page, palette.Text, true),
        NativeCompanionControlRole.ListViewHeader => new(NativeCompanionFontRole.Metadata, palette.Card, palette.Text, false),
        _ => throw new ArgumentOutOfRangeException(nameof(role)),
    };

    public void Refresh(int dpi)
    {
        ReleaseResources();
        Dpi = Math.Max(96, dpi);
        Palette = NativeCompanionThemeDetector.Detect();
        try
        {
            foreach (NativeCompanionFontRole role in Enum.GetValues<NativeCompanionFontRole>())
            {
                NativeCompanionFontSpec spec = FontSpec(role);
                int height = -MulDiv(spec.PointSize, Dpi, 72);
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
    /// (notably ComboBox arrows and native scrollbars). Owner drawing/control colors remain the readable fallback.
    /// </summary>
    public void ApplyControlChrome(IntPtr control, NativeCompanionChromeRole role)
    {
        if (control == IntPtr.Zero) return;
        string? theme = Palette.Mode == NativeCompanionThemeMode.Dark
            ? role == NativeCompanionChromeRole.Combo ? "DarkMode_CFD" : "DarkMode_Explorer"
            : null;
        try { _ = SetWindowTheme(control, theme, null); }
        catch { }
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
}

internal readonly record struct NativeLayoutSize(int Width, int Height);

internal sealed record NativeCompanionLayout(
    NativeLayoutRect HeaderTitle, NativeLayoutRect HeaderMetadata,
    NativeLayoutRect PlatformCard, NativeLayoutRect PlatformHeading, NativeLayoutRect PlatformLabel, NativeLayoutRect Platform,
    NativeLayoutRect TitleLabel, NativeLayoutRect TitleText, NativeLayoutRect CopyTitle,
    NativeLayoutRect BodyLabel, NativeLayoutRect BodyText, NativeLayoutRect CopyMain,
    NativeLayoutRect PostingStatus, NativeLayoutRect PostingHelper, NativeLayoutRect PostingAction, NativeLayoutRect PostingAggregate,
    NativeLayoutRect AssetsCard, NativeLayoutRect AssetsHeading, NativeLayoutRect AssetCount, NativeLayoutRect SelectAll,
    NativeLayoutRect AssetList, NativeLayoutRect Footer, NativeLayoutRect Status, NativeLayoutRect Close)
{
    // Patreon is the tallest production mode: 24 top inset + 30 heading + 20 metadata +
    // 12 gap + 404 content card + 12 gap + 168 asset card + 12 gap + 72 footer.
    // 820 is the supported usable desktop width; 754 is the current Patreon layout's
    // geometrically required height. The outer tracking size is derived from these
    // logical client dimensions and the window's current DPI/non-client chrome.
    internal const int SupportedMinimumLogicalClientWidth = 820;
    internal const int RequiredLogicalClientHeight = 754;
    internal static NativeLayoutSize SupportedMinimumLogicalClientSize { get; } =
        new(SupportedMinimumLogicalClientWidth, RequiredLogicalClientHeight);

    public static NativeCompanionLayout Calculate(int clientWidth, int clientHeight, int dpi, bool patreon)
    {
        int S(int value) => Math.Max(1, value * Math.Max(96, dpi) / 96);
        int outer = S(24), cardPad = S(16), gap = S(12), controlH = S(36), labelH = S(20);
        int contentWidth = Math.Max(S(480), clientWidth - outer * 2);
        int headerTitleH = S(30), metadataH = S(20);
        var headerTitle = new NativeLayoutRect(outer, outer, contentWidth, headerTitleH);
        var headerMetadata = new NativeLayoutRect(outer, headerTitle.Bottom, contentWidth, metadataH);
        int platformTop = headerMetadata.Bottom + gap;
        int platformHeight = patreon ? S(404) : S(336);
        int footerHeight = S(72);
        int footerTop = clientHeight - footerHeight;
        int assetTop = platformTop + platformHeight + gap;
        int assetHeight = Math.Max(S(168), footerTop - gap - assetTop);
        var platformCard = new NativeLayoutRect(outer, platformTop, contentWidth, platformHeight);
        var footer = new NativeLayoutRect(0, footerTop, clientWidth, footerHeight);
        var assetsCard = new NativeLayoutRect(outer, assetTop, contentWidth, assetHeight);

        int innerX = platformCard.X + cardPad, innerWidth = platformCard.Width - cardPad * 2;
        var platformHeading = new NativeLayoutRect(innerX, platformCard.Y + cardPad, innerWidth, labelH);
        int selectorY = platformHeading.Bottom + S(8);
        var platformLabel = new NativeLayoutRect(innerX, selectorY + S(8), S(76), labelH);
        var platform = new NativeLayoutRect(platformLabel.Right + S(8), selectorY, S(240), S(240));
        int contentY = selectorY + controlH + gap;
        int postingActionWidth = S(168);
        var postingAction = new NativeLayoutRect(platformCard.Right - cardPad - postingActionWidth, contentY, postingActionWidth, controlH);
        int postingTextWidth = Math.Max(S(220), postingAction.X - innerX - gap);
        var postingStatus = new NativeLayoutRect(innerX, contentY, postingTextWidth, labelH);
        var postingHelper = new NativeLayoutRect(innerX, postingStatus.Bottom + S(4), postingTextWidth, labelH);
        var postingAggregate = new NativeLayoutRect(innerX, postingAction.Bottom + S(8), innerWidth, labelH);
        contentY = postingAggregate.Bottom + gap;
        NativeLayoutRect titleLabel = default, titleText = default, copyTitle = default;
        if (patreon)
        {
            titleLabel = new NativeLayoutRect(innerX, contentY, innerWidth, labelH);
            int titleY = titleLabel.Bottom + S(4);
            copyTitle = new NativeLayoutRect(platformCard.Right - cardPad - S(112), titleY, S(112), controlH);
            titleText = new NativeLayoutRect(innerX, titleY, copyTitle.X - innerX - S(8), S(64));
            contentY = titleText.Bottom + gap;
        }
        var bodyLabel = new NativeLayoutRect(innerX, contentY, innerWidth, labelH);
        int bodyY = bodyLabel.Bottom + S(4);
        var copyMain = new NativeLayoutRect(platformCard.Right - cardPad - S(144), platformCard.Bottom - cardPad - controlH, S(144), controlH);
        var bodyText = new NativeLayoutRect(innerX, bodyY, innerWidth, Math.Max(S(52), copyMain.Y - S(8) - bodyY));

        int assetInnerX = assetsCard.X + cardPad, assetInnerWidth = assetsCard.Width - cardPad * 2;
        var assetsHeading = new NativeLayoutRect(assetInnerX, assetsCard.Y + cardPad, S(100), labelH);
        var selectAll = new NativeLayoutRect(assetsCard.Right - cardPad - S(104), assetsCard.Y + S(10), S(104), controlH);
        var assetCount = new NativeLayoutRect(assetsHeading.Right + S(8), assetsHeading.Y, Math.Max(S(80), selectAll.X - assetsHeading.Right - S(16)), labelH);
        int listY = Math.Max(assetsHeading.Bottom, selectAll.Bottom) + S(8);
        var assetList = new NativeLayoutRect(assetInnerX, listY, assetInnerWidth, Math.Max(S(72), assetsCard.Bottom - cardPad - listY));

        var close = new NativeLayoutRect(clientWidth - outer - S(104), footer.Y + S(18), S(104), controlH);
        var status = new NativeLayoutRect(outer, footer.Y + S(14), Math.Max(S(160), close.X - outer - gap), S(44));
        return new(headerTitle, headerMetadata, platformCard, platformHeading, platformLabel, platform,
            titleLabel, titleText, copyTitle, bodyLabel, bodyText, copyMain,
            postingStatus, postingHelper, postingAction, postingAggregate,
            assetsCard, assetsHeading, assetCount, selectAll, assetList, footer, status, close);
    }
}
