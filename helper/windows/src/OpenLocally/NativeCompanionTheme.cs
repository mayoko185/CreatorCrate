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

internal readonly record struct NativeHeaderChromeStyle(
    int Background, int Text, int Divider, int BottomEdge, bool CustomDraw);

internal readonly record struct NativeListViewSelectionStyle(
    int Background, int Text, int Accent, bool CustomDraw);

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

    internal NativeCompanionTheme(int dpi, NativeCompanionPalette palette) => Refresh(dpi, palette);

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
        NativeCompanionControlRole.ListViewHeader => new(
            NativeCompanionFontRole.Metadata, palette.Hover, palette.Text, palette.UsesDecorativeColors),
        _ => throw new ArgumentOutOfRangeException(nameof(role)),
    };

    internal static NativeHeaderChromeStyle HeaderChromeStyle(NativeCompanionPalette palette) =>
        new(palette.Hover, palette.Text, palette.Border, palette.BorderStrong, palette.UsesDecorativeColors);

    internal static NativeListViewSelectionStyle ListViewSelectionStyle(NativeCompanionPalette palette) =>
        new(palette.SelectionBackground, palette.SelectionText, palette.Accent, palette.UsesDecorativeColors);

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
    NativeLayoutRect AssetsCard, NativeLayoutRect AssetsHeading, NativeLayoutRect AssetCount, NativeLayoutRect DragGuidance,
    NativeLayoutRect AssetList, NativeLayoutRect Footer, NativeLayoutRect Status, NativeLayoutRect Close)
{
    // 820 by 754 is the supported usable client minimum. Content height is measured
    // from its visible groups; extra height is shared with the editor and Assets.
    internal const int SupportedMinimumLogicalClientWidth = 820;
    internal const int RequiredLogicalClientHeight = 754;
    internal static NativeLayoutSize SupportedMinimumLogicalClientSize { get; } =
        new(SupportedMinimumLogicalClientWidth, RequiredLogicalClientHeight);

    public static NativeCompanionLayout Calculate(int clientWidth, int clientHeight, int dpi, bool patreon,
        string postingStatusText = "", string postingHelperText = "", bool hasPosting = true)
    {
        int S(int value) => Math.Max(1, value * Math.Max(96, dpi) / 96);
        int outer = S(24), cardPad = S(16), sectionGap = S(16), fieldGap = S(12);
        int actionH = S(30), labelH = S(20), selectorH = S(36);
        int contentWidth = Math.Min(S(1152), Math.Max(S(480), clientWidth - outer * 2));
        int contentX = (clientWidth - contentWidth) / 2;
        int headerTitleH = S(30), metadataH = S(20);
        var headerTitle = new NativeLayoutRect(contentX, outer, contentWidth, headerTitleH);
        var headerMetadata = new NativeLayoutRect(contentX, headerTitle.Bottom, contentWidth, metadataH);
        int platformTop = headerMetadata.Bottom + S(12);
        int footerHeight = S(72);
        int footerTop = clientHeight - footerHeight;
        var footer = new NativeLayoutRect(0, footerTop, clientWidth, footerHeight);
        int innerX = contentX + cardPad, innerWidth = contentWidth - cardPad * 2;
        var platformHeading = new NativeLayoutRect(innerX, platformTop + cardPad + S(8), S(112), labelH);
        var platformLabel = new NativeLayoutRect(platformHeading.Right + S(12), platformHeading.Y, S(76), labelH);
        var platform = new NativeLayoutRect(platformLabel.Right + S(8), platformTop + cardPad, S(240), selectorH);
        int contentY = platformTop + cardPad + selectorH + S(8);

        // Native Static controls wrap at word boundaries. Reserve the number of lines
        // implied by the current bounded text instead of a permanent posting row.
        int postingTextWidth = Math.Min(S(320), innerWidth - S(168) - fieldGap);
        int Lines(string value, int width)
        {
            if (string.IsNullOrEmpty(value)) return 1;
            int columns = Math.Max(1, width * 96 / Math.Max(96, dpi) / 7);
            int lines = 1, used = 0;
            foreach (string word in value.Split(' ', StringSplitOptions.RemoveEmptyEntries))
            {
                int length = word.Length + (used == 0 ? 0 : 1);
                if (used > 0 && used + length > columns) { lines++; used = word.Length; }
                else used += length;
            }
            return lines;
        }
        int statusH = hasPosting ? Math.Max(actionH, S(20 * Lines(postingStatusText, postingTextWidth))) : 0;
        int helperH = hasPosting ? S(20 * Lines(postingHelperText, innerWidth)) : 0;
        int postingH = hasPosting ? statusH + S(4) + helperH + fieldGap : 0;
        int titleGroupH = patreon ? actionH + S(4) + S(48) + fieldGap : 0;
        int plannedBodyH = patreon ? S(96) : S(144);
        int fixedHeight = cardPad + selectorH + S(8) + titleGroupH + actionH + S(4) +
            postingH + cardPad;
        int maximumCardHeight = footerTop - sectionGap - S(152) - sectionGap - platformTop;
        int bodyBaseH = Math.Min(plannedBodyH, Math.Max(S(72), maximumCardHeight - fixedHeight));
        int minimumCardHeight = fixedHeight + bodyBaseH;
        int availableCardHeight = Math.Max(minimumCardHeight,
            maximumCardHeight);
        int editorGrowth = Math.Min(S(240) - bodyBaseH, Math.Max(0, availableCardHeight - minimumCardHeight) / 2);
        int bodyH = bodyBaseH + editorGrowth;
        int platformHeight = fixedHeight + bodyH;
        var platformCard = new NativeLayoutRect(contentX, platformTop, contentWidth, platformHeight);
        int assetTop = platformCard.Bottom + sectionGap;
        int assetHeight = Math.Min(S(440), Math.Max(S(152), footerTop - sectionGap - assetTop));
        var assetsCard = new NativeLayoutRect(contentX, assetTop, contentWidth, assetHeight);
        NativeLayoutRect titleLabel = default, titleText = default, copyTitle = default;
        if (patreon)
        {
            copyTitle = new NativeLayoutRect(innerX + innerWidth - S(112), contentY, S(112), actionH);
            titleLabel = new NativeLayoutRect(innerX, contentY + S(5), copyTitle.X - innerX - S(8), labelH);
            titleText = new NativeLayoutRect(innerX, copyTitle.Bottom + S(4), innerWidth, S(48));
            contentY = titleText.Bottom + fieldGap;
        }
        var copyMain = new NativeLayoutRect(innerX + innerWidth - S(144), contentY, S(144), actionH);
        var bodyLabel = new NativeLayoutRect(innerX, contentY + S(5), copyMain.X - innerX - S(8), labelH);
        var bodyText = new NativeLayoutRect(innerX, copyMain.Bottom + S(4), innerWidth, bodyH);
        contentY = bodyText.Bottom + (hasPosting ? fieldGap : 0);
        var postingStatus = hasPosting ? new NativeLayoutRect(innerX, contentY, postingTextWidth, statusH) : default;
        var postingAction = hasPosting ? new NativeLayoutRect(postingStatus.Right + fieldGap, contentY, S(168), actionH) : default;
        var postingHelper = hasPosting ? new NativeLayoutRect(innerX, postingStatus.Bottom + S(4), innerWidth, helperH) : default;
        int footerActionX = clientWidth - outer - S(104);
        var postingAggregate = hasPosting ? new NativeLayoutRect(contentX, footer.Y + S(4),
            Math.Min(contentWidth, footerActionX - contentX - fieldGap), labelH) : default;

        int assetInnerX = assetsCard.X + cardPad, assetInnerWidth = assetsCard.Width - cardPad * 2;
        var assetsHeading = new NativeLayoutRect(assetInnerX, assetsCard.Y + cardPad, S(100), labelH);
        var assetCount = new NativeLayoutRect(assetsCard.Right - cardPad - S(160), assetsHeading.Y, S(160), labelH);
        var dragGuidance = new NativeLayoutRect(assetInnerX, assetsHeading.Bottom + S(4), assetInnerWidth, labelH);
        int listY = dragGuidance.Bottom + S(8);
        var assetList = new NativeLayoutRect(assetInnerX, listY, assetInnerWidth, Math.Max(S(72), assetsCard.Bottom - cardPad - listY));

        var close = new NativeLayoutRect(clientWidth - outer - S(104), footer.Y + S(18), S(104), S(36));
        var status = new NativeLayoutRect(contentX, footer.Y + S(27),
            Math.Max(S(160), close.X - contentX - fieldGap), S(32));
        return new(headerTitle, headerMetadata, platformCard, platformHeading, platformLabel, platform,
            titleLabel, titleText, copyTitle, bodyLabel, bodyText, copyMain,
            postingStatus, postingHelper, postingAction, postingAggregate,
            assetsCard, assetsHeading, assetCount, dragGuidance, assetList, footer, status, close);
    }
}
