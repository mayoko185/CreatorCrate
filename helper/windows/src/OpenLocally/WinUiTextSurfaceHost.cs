using System.Runtime.InteropServices;
using Microsoft.UI.Dispatching;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Automation;
using Microsoft.UI.Xaml.Automation.Peers;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Hosting;
using Microsoft.UI.Xaml.Markup;
using Microsoft.UI.Xaml.Media;
using Microsoft.UI.Xaml.XamlTypeInfo;
using Windows.Foundation;
using Windows.Graphics;
using Microsoft.UI.Text;

namespace OpenLocally;

internal sealed record WinUiHostProofOptions(
    string TitleText,
    string BodyText,
    string HeaderMetadata,
    ElementTheme Theme = ElementTheme.Dark,
    ElementTheme? ThemeAfterFirstRender = null,
    bool SelectBodyTextAfterRender = false,
    int FailAfterSurfaceCount = 0,
    Action<IntPtr>? WindowShown = null,
    Action<IntPtr>? MainWindowCreated = null,
    Action<IReadOnlyList<IntPtr>>? NativeControlsCreated = null,
    Action<IntPtr>? SurfaceCreated = null);

internal sealed class WinUiHostInitializationException : InvalidOperationException
{
    public const string SafeDiagnostic =
        "The WinUI text host could not start. Reinstall CreatorCrate Open Locally and try again.";

    public WinUiHostInitializationException(Exception innerException)
        : base(SafeDiagnostic, innerException) { }
}

internal readonly record struct WinUiTextSurfacePalette(
    int RootBackground, int Background, int PointerBackground,
    int Foreground, int Border, int PointerBorder, int FocusBorder);

internal static class WinUiTextSurfacePresentation
{
    internal const double BodyFontSize = 16;
    internal const double TitleFontSize = 16;
    internal const ushort BodyFontWeight = 400;
    internal const ushort TitleFontWeight = 600;
    internal const double HorizontalPadding = 12;
    internal const double VerticalPadding = 8;
    internal const double BorderWidth = 1;
    internal const double FocusBorderWidth = 2;
    internal const double CornerRadius = 6;
    internal const float LineSpacing = 1.35f;
    internal const string FontFamily = "Segoe UI Variable Text";
    internal static readonly string[] DecorativeResourceKeys =
    [
        "TextControlForeground", "TextControlForegroundPointerOver", "TextControlForegroundFocused",
        "TextControlBackground", "TextControlBackgroundPointerOver", "TextControlBackgroundFocused",
        "TextControlBorderBrush", "TextControlBorderBrushPointerOver", "TextControlBorderBrushFocused",
        "TextControlBorderThemeThicknessFocused", "FocusVisualPrimaryBrush", "FocusVisualSecondaryBrush",
    ];

    internal static WinUiTextSurfacePalette Palette(ElementTheme theme)
    {
        NativeCompanionPalette palette = theme switch
        {
            ElementTheme.Dark => NativeCompanionPalette.Dark,
            ElementTheme.Light => NativeCompanionPalette.Light,
            _ => throw new ArgumentOutOfRangeException(nameof(theme)),
        };
        return new(
            palette.Card, palette.Surface, palette.Surface,
            palette.Text, palette.Border, palette.BorderStrong, palette.Focus);
    }
}

/// <summary>Owns the two production WinUI text islands used by the Win32 social companion.</summary>
internal sealed class WinUiTextSurfaceHost : IDisposable
{
    private readonly Action<int, bool> _takeFocus;
    private DispatcherQueueController? _dispatcher;
    private XamlHostApplication? _application;
    private Surface? _title;
    private Surface? _body;
    private ElementTheme _theme;
    private bool _disposed;

    internal WinUiTextSurfaceHost(
        IntPtr parentWindow,
        Action<int, bool> takeFocus,
        ElementTheme theme,
        int failAfterSurfaceCount = 0,
        Action<IntPtr>? surfaceCreated = null)
    {
        _takeFocus = takeFocus ?? throw new ArgumentNullException(nameof(takeFocus));
        _theme = theme;
        if (parentWindow == IntPtr.Zero) throw new ArgumentException("A parent HWND is required.", nameof(parentWindow));

        try
        {
            if (failAfterSurfaceCount == -1)
                throw new InvalidOperationException("Injected failure during WinUI host initialization.");

            _dispatcher = DispatcherQueueController.CreateOnCurrentThread();
            _application = new XamlHostApplication();

            _title = CreateSurface(parentWindow, title: true, 0, theme);
            surfaceCreated?.Invoke(WindowHandle(_title));
            if (failAfterSurfaceCount == 1)
                throw new InvalidOperationException("Injected failure after the first WinUI surface.");

            _body = CreateSurface(parentWindow, title: false, 1, theme);
            surfaceCreated?.Invoke(WindowHandle(_body));
            if (failAfterSurfaceCount == 2)
                throw new InvalidOperationException("Injected failure after the second WinUI surface.");
        }
        catch (Exception exception)
        {
            Dispose();
            throw new WinUiHostInitializationException(exception);
        }
    }

    internal RichEditBox TitleEditor => _title?.Editor ?? throw new ObjectDisposedException(nameof(WinUiTextSurfaceHost));
    internal RichEditBox BodyEditor => _body?.Editor ?? throw new ObjectDisposedException(nameof(WinUiTextSurfaceHost));
    internal bool UsesOneSharedDispatcher =>
        _title?.Source.SiteBridge.DispatcherQueue == _dispatcher?.DispatcherQueue &&
        _body?.Source.SiteBridge.DispatcherQueue == _dispatcher?.DispatcherQueue;
    internal ElementTheme Theme => _theme;
    internal bool TitleVisible => _title?.Visible == true;
    internal IntPtr TitleWindow => WindowHandle(_title);
    internal IntPtr BodyWindow => WindowHandle(_body);
    internal int SurfaceCount => (_title is null ? 0 : 1) + (_body is null ? 0 : 1);
    internal string TitleText => ReadText(_title);
    internal string BodyText => ReadText(_body);
    internal string TitleAccessibleName => AutomationProperties.GetName(_title!.Editor);
    internal string BodyAccessibleName => AutomationProperties.GetName(_body!.Editor);
    internal bool TitleIsReadOnly => _title?.Editor.IsReadOnly == true;
    internal bool BodyIsReadOnly => _body?.Editor.IsReadOnly == true;
    internal bool TitleColorFontEnabled => _title?.Editor.IsColorFontEnabled == true;
    internal bool BodyColorFontEnabled => _body?.Editor.IsColorFontEnabled == true;
    internal bool TitleIsTabStop => _title?.Editor.IsTabStop == true;
    internal bool BodyIsTabStop => _body?.Editor.IsTabStop == true;
    internal bool TitleTextScaleEnabled => _title?.Editor.IsTextScaleFactorEnabled == true;
    internal bool BodyTextScaleEnabled => _body?.Editor.IsTextScaleFactorEnabled == true;
    internal WinUiTextSurfacePresentationProbe Presentation => CapturePresentation();

    internal void SetContent(string platform, string title, string body)
    {
        ThrowIfDisposed();
        ArgumentNullException.ThrowIfNull(platform);
        ArgumentNullException.ThrowIfNull(title);
        ArgumentNullException.ThrowIfNull(body);

        bool patreon = string.Equals(platform, "patreon", StringComparison.OrdinalIgnoreCase);
        _title!.SetText(title);
        _body!.SetText(body);
        AutomationProperties.SetName(_title.Editor, "Patreon title");
        AutomationProperties.SetName(_body.Editor, patreon ? "Patreon body" :
            string.Equals(platform, "x", StringComparison.OrdinalIgnoreCase) ? "X post text" : "Bluesky post text");
        _title.SetVisible(patreon);
        _body.SetVisible(true);
    }

    internal void SetBounds(NativeLayoutRect title, NativeLayoutRect body, bool titleVisible)
    {
        ThrowIfDisposed();
        _title!.MoveAndResize(title);
        _title.SetVisible(titleVisible);
        _body!.MoveAndResize(body);
        _body.SetVisible(true);
    }

    internal void SetTheme(ElementTheme theme)
    {
        ThrowIfDisposed();
        ApplyTheme(_title!, theme);
        ApplyTheme(_body!, theme);
        _theme = theme;
    }

    internal void SelectBodyTextForVisualEvidence()
    {
        ThrowIfDisposed();
        _body!.Editor.Document.Selection.SetRange(0, 17);
        _body.Editor.Focus(FocusState.Programmatic);
    }

    internal bool NavigateFromNative(IntPtr current, IntPtr platform, IntPtr copyTitle, IntPtr copyBody, bool previous)
    {
        ThrowIfDisposed();
        Surface? target = previous
            ? current == copyTitle ? _title : current == copyBody ? _body : null
            : current == platform ? (_title!.Visible ? _title : _body) : current == copyTitle ? _body : null;
        if (target is null || !target.Visible) return false;

        XamlSourceFocusNavigationReason reason = previous
            ? XamlSourceFocusNavigationReason.Last
            : XamlSourceFocusNavigationReason.First;
        return target.Source.NavigateFocus(new XamlSourceFocusNavigationRequest(reason)).WasFocusMoved;
    }

    internal bool PreTranslateMessage(ref NativeManualPublishingCompanion.NativeWindow.Message message) =>
        ContentPreTranslateMessage(ref message);

    internal void QueueAfterRender(Action action)
    {
        ArgumentNullException.ThrowIfNull(action);
        ThrowIfDisposed();
        if (!_dispatcher!.DispatcherQueue.TryEnqueue(DispatcherQueuePriority.Low, () =>
            _dispatcher.DispatcherQueue.TryEnqueue(DispatcherQueuePriority.Low, () => action())))
            throw new InvalidOperationException("Could not queue the WinUI proof callback.");
    }

    public void Dispose()
    {
        if (_disposed) return;
        _disposed = true;

        DisposeSurface(ref _body);
        DisposeSurface(ref _title);

        _application?.DisposeXaml();
        _application = null;
        _dispatcher?.ShutdownQueue();
        _dispatcher = null;
    }

    private Surface CreateSurface(IntPtr parentWindow, bool title, int index, ElementTheme theme)
    {
        var source = new DesktopWindowXamlSource();
        try
        {
            source.Initialize(new Microsoft.UI.WindowId { Value = unchecked((ulong)parentWindow.ToInt64()) });
            var root = new Grid();
            ApplyThemeResources(root, theme);
            root.RequestedTheme = theme;

            var editor = new RichEditBox
            {
                IsReadOnly = true,
                IsColorFontEnabled = true,
                TextWrapping = TextWrapping.Wrap,
                IsEnabled = true,
                IsTabStop = true,
                IsTextScaleFactorEnabled = true,
                FontFamily = new FontFamily(WinUiTextSurfacePresentation.FontFamily),
                FontSize = title ? WinUiTextSurfacePresentation.TitleFontSize : WinUiTextSurfacePresentation.BodyFontSize,
                FontWeight = title ? FontWeights.SemiBold : FontWeights.Normal,
                Padding = new Thickness(
                    WinUiTextSurfacePresentation.HorizontalPadding,
                    WinUiTextSurfacePresentation.VerticalPadding,
                    WinUiTextSurfacePresentation.HorizontalPadding,
                    WinUiTextSurfacePresentation.VerticalPadding),
                BorderThickness = new Thickness(WinUiTextSurfacePresentation.BorderWidth),
                CornerRadius = new CornerRadius(WinUiTextSurfacePresentation.CornerRadius),
                UseSystemFocusVisuals = true,
            };
            ScrollViewer.SetVerticalScrollBarVisibility(editor, ScrollBarVisibility.Auto);
            ScrollViewer.SetHorizontalScrollBarVisibility(editor, ScrollBarVisibility.Disabled);
            AutomationProperties.SetName(editor, title ? "Patreon title" : "Patreon body");
            AutomationProperties.SetAccessibilityView(editor, AccessibilityView.Content);

            root.Children.Add(editor);
            source.Content = root;

            Surface? surface = null;
            TypedEventHandler<DesktopWindowXamlSource, DesktopWindowXamlSourceTakeFocusRequestedEventArgs> handler =
                (_, args) => _takeFocus(index, args.Request.Reason == XamlSourceFocusNavigationReason.Last);
            source.TakeFocusRequested += handler;
            surface = new Surface(source, root, editor, handler);
            return surface;
        }
        catch
        {
            source.Dispose();
            throw;
        }
    }

    private static void DisposeSurface(ref Surface? surface)
    {
        Surface? value = surface;
        surface = null;
        if (value is null) return;
        value.Source.TakeFocusRequested -= value.FocusHandler;
        value.Source.SiteBridge.Hide();
        value.Source.SiteBridge.Dispose();
        value.Source.Dispose();
    }

    private static IntPtr WindowHandle(Surface? surface) => surface is null
        ? IntPtr.Zero
        : new IntPtr(unchecked((long)surface.Source.SiteBridge.WindowId.Value));

    private static string ReadText(Surface? surface)
    {
        if (surface is null) return string.Empty;
        surface.Editor.Document.GetText(TextGetOptions.None, out string text);
        return text;
    }

    private WinUiTextSurfacePresentationProbe CapturePresentation()
    {
        Surface title = _title ?? throw new ObjectDisposedException(nameof(WinUiTextSurfaceHost));
        Surface body = _body ?? throw new ObjectDisposedException(nameof(WinUiTextSurfaceHost));
        ITextParagraphFormat paragraph = body.Editor.Document.GetRange(0, 0).ParagraphFormat;
        return new(
            title.Editor.FontFamily.Source,
            title.Editor.FontSize, title.Editor.FontWeight.Weight,
            body.Editor.FontSize, body.Editor.FontWeight.Weight,
            body.Editor.Padding, body.Editor.BorderThickness, body.Editor.CornerRadius,
            body.Editor.TextWrapping,
            ScrollViewer.GetVerticalScrollBarVisibility(body.Editor),
            ScrollViewer.GetHorizontalScrollBarVisibility(body.Editor),
            paragraph.LineSpacingRule, paragraph.LineSpacing,
            paragraph.SpaceBefore, paragraph.SpaceAfter,
            body.Editor.UseSystemFocusVisuals,
            title.Editor.IsTextScaleFactorEnabled, body.Editor.IsTextScaleFactorEnabled,
            body.Root.Resources.Keys.Cast<object>().Any(key =>
                WinUiTextSurfacePresentation.DecorativeResourceKeys.Contains(key as string, StringComparer.Ordinal)),
            HasLocalBrushValue(body.Editor, Control.BackgroundProperty) ||
                HasLocalBrushValue(body.Editor, Control.ForegroundProperty) ||
                HasLocalBrushValue(body.Editor, Control.BorderBrushProperty),
            BrushColor(body.Root.Background), BrushColor(body.Editor.Background),
            BrushColor(body.Editor.Foreground), BrushColor(body.Editor.BorderBrush),
            ResourceBrushColor(body.Root, "TextControlBorderBrushPointerOver"),
            ResourceBrushColor(body.Root, "TextControlBorderBrushFocused"),
            body.Root.Resources.Keys.Cast<object>().Any(key =>
                Equals(key, "TextControlSelectionHighlightColor")));
    }

    private static void ApplyTheme(Surface surface, ElementTheme theme)
    {
        ApplyThemeResources(surface.Root, theme);
        surface.Root.RequestedTheme = theme;
        if (theme == ElementTheme.Default)
        {
            surface.Editor.ClearValue(Control.ForegroundProperty);
            surface.Editor.ClearValue(Control.BackgroundProperty);
            surface.Editor.ClearValue(Control.BorderBrushProperty);
        }
    }

    private static void ApplyThemeResources(Grid root, ElementTheme theme)
    {
        foreach (string key in WinUiTextSurfacePresentation.DecorativeResourceKeys) root.Resources.Remove(key);

        if (theme is not (ElementTheme.Dark or ElementTheme.Light))
        {
            root.ClearValue(Grid.BackgroundProperty);
            return;
        }

        WinUiTextSurfacePalette palette = WinUiTextSurfacePresentation.Palette(theme);
        SolidColorBrush foreground = Brush(palette.Foreground);
        SolidColorBrush background = Brush(palette.Background);
        root.Background = Brush(palette.RootBackground);
        root.Resources["TextControlForeground"] = foreground;
        root.Resources["TextControlForegroundPointerOver"] = foreground;
        root.Resources["TextControlForegroundFocused"] = foreground;
        root.Resources["TextControlBackground"] = background;
        root.Resources["TextControlBackgroundPointerOver"] = Brush(palette.PointerBackground);
        root.Resources["TextControlBackgroundFocused"] = background;
        root.Resources["TextControlBorderBrush"] = Brush(palette.Border);
        root.Resources["TextControlBorderBrushPointerOver"] = Brush(palette.PointerBorder);
        root.Resources["TextControlBorderBrushFocused"] = Brush(palette.FocusBorder);
        root.Resources["TextControlBorderThemeThicknessFocused"] = new Thickness(WinUiTextSurfacePresentation.FocusBorderWidth);
        root.Resources["FocusVisualPrimaryBrush"] = Brush(palette.FocusBorder);
        root.Resources["FocusVisualSecondaryBrush"] = background;
    }

    private static SolidColorBrush Brush(int color) => new(ToColor(color));

    private static Windows.UI.Color ToColor(int color) => Windows.UI.Color.FromArgb(
        byte.MaxValue,
        (byte)(color & 0xff),
        (byte)(color >> 8 & 0xff),
        (byte)(color >> 16 & 0xff));

    private static string BrushColor(Brush? brush) => brush is null
        ? string.Empty
        : brush is SolidColorBrush solid
        ? NativeCompanionPalette.Hex(solid.Color.R | solid.Color.G << 8 | solid.Color.B << 16)
        : brush.GetType().Name;

    private static string ResourceBrushColor(Grid root, string key) =>
        root.Resources.TryGetValue(key, out object? value) && value is Brush brush
            ? BrushColor(brush)
            : string.Empty;

    private static bool HasLocalBrushValue(Control control, DependencyProperty property) =>
        control.ReadLocalValue(property) != DependencyProperty.UnsetValue;

    private void ThrowIfDisposed()
    {
        if (_disposed) throw new ObjectDisposedException(nameof(WinUiTextSurfaceHost));
    }

    private sealed class Surface(
        DesktopWindowXamlSource source,
        Grid root,
        RichEditBox editor,
        TypedEventHandler<DesktopWindowXamlSource, DesktopWindowXamlSourceTakeFocusRequestedEventArgs> focusHandler)
    {
        internal DesktopWindowXamlSource Source { get; } = source;
        internal Grid Root { get; } = root;
        internal RichEditBox Editor { get; } = editor;
        internal TypedEventHandler<DesktopWindowXamlSource, DesktopWindowXamlSourceTakeFocusRequestedEventArgs> FocusHandler { get; } = focusHandler;
        internal bool Visible { get; private set; }

        internal void MoveAndResize(NativeLayoutRect rect) =>
            Source.SiteBridge.MoveAndResize(new RectInt32(rect.X, rect.Y, rect.Width, rect.Height));

        internal void SetVisible(bool visible)
        {
            Editor.IsTabStop = visible;
            Editor.IsHitTestVisible = visible;
            AutomationProperties.SetAccessibilityView(Editor, visible ? AccessibilityView.Content : AccessibilityView.Raw);
            if (visible) Source.SiteBridge.Show();
            else Source.SiteBridge.Hide();
            if (visible) Source.SiteBridge.MoveInZOrderAtTop();
            Visible = visible;
        }


        internal void SetText(string text)
        {
            Editor.IsReadOnly = false;
            try
            {
                Editor.Document.SetText(TextSetOptions.None, text);
                ITextParagraphFormat paragraph = Editor.Document.GetRange(0, text.Length).ParagraphFormat;
                paragraph.SpaceBefore = 0;
                paragraph.SpaceAfter = 0;
                paragraph.SetLineSpacing(LineSpacingRule.Multiple, WinUiTextSurfacePresentation.LineSpacing);
                Editor.Document.Selection.SetRange(0, 0);
            }
            finally { Editor.IsReadOnly = true; }
        }
    }

    private sealed class XamlHostApplication : Application, IXamlMetadataProvider
    {
        private readonly XamlControlsXamlMetaDataProvider _controlsProvider = new();
        private readonly WindowsXamlManager _xamlManager;

        internal XamlHostApplication()
        {
            _xamlManager = WindowsXamlManager.InitializeForCurrentThread();
            Resources.MergedDictionaries.Add(new XamlControlsResources());
        }

        IXamlType? IXamlMetadataProvider.GetXamlType(string fullName) =>
            _controlsProvider.GetXamlType(fullName);

        IXamlType? IXamlMetadataProvider.GetXamlType(Type type) =>
            _controlsProvider.GetXamlType(type);

        XmlnsDefinition[] IXamlMetadataProvider.GetXmlnsDefinitions() =>
            _controlsProvider.GetXmlnsDefinitions();

        internal void DisposeXaml() => _xamlManager.Dispose();
    }

    [DllImport("Microsoft.UI.Windowing.Core.dll", ExactSpelling = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool ContentPreTranslateMessage(
        ref NativeManualPublishingCompanion.NativeWindow.Message message);
}
