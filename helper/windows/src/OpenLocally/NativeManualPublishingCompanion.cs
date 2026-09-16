using System.Runtime.InteropServices;
using Microsoft.UI.Text;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;

namespace OpenLocally;

internal enum ManualCopyCommand { Title, Body, Post }
internal enum NativeCompanionOwnerDrawTarget { PlatformCombo, PrimaryButton, SecondaryButton }

internal enum ManualCompanionLifecycleState { Initializing, Ready, ClosingOrClosed, Failed }

internal readonly record struct ManualAssetListRow(
    ManualPreparedPlatform Platform, int Ordinal, ManualPreparedAsset Prepared)
{
    public bool IsAvailable => ManualPublishingCompanionModel.IsAvailable(Prepared);
    public string File => Prepared.Asset.Filename;
    public string Role => Prepared.Asset.Role;
    public string Size => $"{Prepared.Asset.SizeBytes:N0} bytes";
    public string Status => IsAvailable ? "Available" : "Unavailable";
    public string PathOrStagedName
    {
        get
        {
            string staged = Path.GetFileName(Prepared.Path ?? string.Empty);
            return string.IsNullOrEmpty(staged) || string.Equals(staged, Prepared.Asset.Filename, StringComparison.OrdinalIgnoreCase)
                ? Prepared.Asset.RelativePath
                : $"{Prepared.Asset.RelativePath} | Staged: {staged}";
        }
    }
}

internal readonly record struct ManualAssetListColumn(string Title, int LogicalWidth);

internal sealed record ManualPostingConfirmationPresentation(
    string StatusText, string HelperText, string ActionText,
    bool ShowAction, bool ActionEnabled, string AggregateText);

internal sealed record NativeProductionLayoutProbe(
    string Platform, NativeLayoutSize Client, NativeLayoutSize MinimumTrack, int Dpi,
    NativeLayoutRect Header, NativeLayoutRect HeaderMetadata,
    NativeLayoutRect PlatformCard, NativeLayoutRect PlatformHeading, NativeLayoutRect PlatformSelector,
    NativeLayoutRect TitleLabel, NativeLayoutRect TitleText, NativeLayoutRect CopyTitle,
    NativeLayoutRect BodyLabel, NativeLayoutRect BodyText, NativeLayoutRect CopyMain,
    NativeLayoutRect PostingStatus, NativeLayoutRect PostingHelper, NativeLayoutRect PostingAction,
    NativeLayoutRect PostingAggregate, NativeLayoutRect AssetsCard, NativeLayoutRect AssetsHeading,
    NativeLayoutRect AssetCount, NativeLayoutRect DragGuidance, NativeLayoutRect AssetList,
    NativeLayoutRect Footer, NativeLayoutRect Status, NativeLayoutRect Close);

internal readonly record struct NativeAuthoritativeTextLayoutProbe(
    string Platform, bool TitleVisible, NativeLayoutRect TitleText, NativeLayoutRect BodyText);

internal sealed record NativeAssetViewportProbe(
    int DisplayedAssetCount, int VisibleRowTarget, int Dpi,
    NativeLayoutRect ListWindow, NativeLayoutRect ListClient, NativeLayoutRect Header,
    IReadOnlyList<NativeLayoutRect> Items, int DesiredListHeight,
    int ScrollMinimum, int ScrollMaximum, int ScrollPage, int ScrollPosition);

internal readonly record struct NativeHeaderDrawStageProbe(uint Stage, IntPtr Result);

internal sealed record NativeHeaderPostpaintProbe(
    NativeLayoutRect Client, IReadOnlyList<NativeLayoutRect> Items,
    NativeLayoutRect Trailing, bool CoordinateMappingSucceeded);

internal readonly record struct NativeListViewRowDrawProbe(
    uint Stage, int ItemIndex, bool Selected, bool CustomDrawReportedSelected,
    bool KeyboardFocused, bool UsesCustomSelection, int Background, int Text,
    NativeLayoutRect Accent, IntPtr Result);

internal readonly record struct NativeListViewBeginDragProbe(
    int OriginItemIndex, IReadOnlyList<int> SelectedItemIndices,
    IReadOnlyList<int> SelectedOrdinals);

internal sealed record NativeProductionTextSurfaceProbe(
    string Platform, string TitleText, string BodyText,
    string TitleAccessibleName, string BodyAccessibleName,
    bool TitleVisible, bool TitleIsTabStop, bool BodyIsTabStop,
    bool TitleIsReadOnly, bool BodyIsReadOnly,
    bool TitleColorFontEnabled, bool BodyColorFontEnabled,
    bool TitleTextScaleEnabled, bool BodyTextScaleEnabled,
    int SurfaceCount, ElementTheme Theme, IntPtr TitleWindow, IntPtr BodyWindow,
    WinUiTextSurfacePresentationProbe Presentation,
    WinUiTextSurfaceResourceProbe TitleResources,
    WinUiTextSurfaceResourceProbe BodyResources,
    WinUiTextSelectionProbe TitleSelection,
    WinUiTextSelectionProbe BodySelection);

internal sealed record WinUiTextSurfaceResourceProbe(
    bool HasDecorativeResourceOverrides,
    bool HasLocalEditorBrushValues,
    string RootBackground, string Background, string Foreground, string Border,
    string PointerBorder, string FocusBorder);

internal readonly record struct WinUiTextSelectionProbe(int Start, int End);

internal sealed record WinUiTextSurfacePresentationProbe(
    string FontFamily,
    double TitleFontSize, ushort TitleFontWeight,
    double BodyFontSize, ushort BodyFontWeight,
    Thickness Padding, Thickness BorderThickness, CornerRadius CornerRadius,
    TextWrapping TextWrapping,
    ScrollBarVisibility VerticalScrollBarVisibility,
    ScrollBarVisibility HorizontalScrollBarVisibility,
    LineSpacingRule LineSpacingRule, float LineSpacing,
    float SpaceBefore, float SpaceAfter,
    bool UsesSystemFocusVisuals,
    bool TitleTextScaleEnabled, bool BodyTextScaleEnabled,
    bool HasDecorativeResourceOverrides,
    bool HasLocalEditorBrushValues,
    string RootBackground, string Background, string Foreground, string Border,
    string PointerBorder, string FocusBorder,
    bool OverridesSelectionHighlight);

internal sealed record NativeProductionKeyboardProbe(
    bool PostingActionRequiredAndReady,
    bool PatreonForwardTraversal, bool PatreonReverseTraversal,
    bool XForwardTraversal, bool XReverseTraversal,
    bool BlueskyForwardTraversal, bool BlueskyReverseTraversal,
    bool EnterPreservedPostingStateAndText, bool WindowRemainedAlive);

internal sealed record NativePostingActionProbe(
    IntPtr Handle, string Text, bool IsWindow, bool Visible, bool Enabled, bool HasKeyboardFocus);

internal sealed record NativePlatformComboProbe(
    IntPtr Handle, string ClassName, uint Style, uint ExtendedStyle,
    int ControlId, IntPtr Parent, string SelectedText, int SelectedIndex, int ItemCount,
    IntPtr ListHandle, string ListClassName, bool KeyboardFocused, bool Dropped,
    bool Hovered, NativeCompanionThemeMode ThemeMode, int Dpi,
    int ListItemHeight, int SelectionFieldHeight);

internal sealed record NativePlatformPopupDiscoveryObservation(
    IntPtr ComboHandle, IntPtr PopupHandle, NativeCompanionThemeMode ThemeMode,
    bool ThemeApplied);

internal sealed record NativeProductionControlPresentationProbe(
    string Name, IntPtr Handle, NativeCompanionFontRole FontRole,
    string FontFamily, int FontHeight, int FontWeight,
    int Background, int Text);

internal sealed record NativeProductionThemeProbe(
    NativeCompanionThemeMode Mode, int Dpi,
    IntPtr Window, IntPtr Platform, IntPtr AssetList, IntPtr AssetHeader,
    IntPtr TitleIsland, IntPtr BodyIsland,
    NativeCompanionSurfaceStyle WindowStyle,
    NativeCompanionSurfaceStyle SectionStyle,
    NativeCompanionSurfaceStyle SectionHeaderStyle,
    NativeCompanionSurfaceStyle NestedStyle,
    NativeCompanionSurfaceStyle FooterStyle,
    int AssetListBackground,
    IReadOnlyList<NativeProductionControlPresentationProbe> Controls);

/// <summary>Maps controller-owned state to safe native control text without adding confirmation decisions.</summary>
internal static class ManualPostingConfirmationPresentationMapper
{
    public static ManualPostingConfirmationPresentation Map(
        ManualPostingPlatformState state, ManualPostingCompletion? completion, string platformLabel)
    {
        ArgumentNullException.ThrowIfNull(state);
        string helper = $"After you publish this post on {platformLabel}, mark it as posted here.";
        string aggregate = completion switch
        {
            { IsComplete: true } => "All social posts marked as posted.",
            { } value => $"{value.PostedCount} of {value.TotalCount} platforms marked as posted.",
            _ => string.Empty,
        };

        return state.Status switch
        {
            ManualPostingConfirmationStatus.Ready when !string.IsNullOrWhiteSpace(state.Reason) =>
                new(state.Reason, helper, "Mark as posted", false, false, aggregate),
            ManualPostingConfirmationStatus.Ready =>
                new("Ready for manual publishing — not marked as posted", helper,
                    "Mark as posted", true, true, aggregate),
            ManualPostingConfirmationStatus.Confirming =>
                new("Marking as posted…", helper, "Mark as posted", true, false, aggregate),
            ManualPostingConfirmationStatus.Posted =>
                new("Posted — confirmed by you", string.Empty, "Mark as posted", false, false, aggregate),
            ManualPostingConfirmationStatus.ConfirmationUnknown =>
                new(ManualPostingConfirmationController.RetryReason, helper,
                    "Retry confirmation", true, true, aggregate),
            _ => throw new ArgumentOutOfRangeException(nameof(state)),
        };
    }
}

/// <summary>Presentation-only newline conversion for the WinUI plain-text document boundary.</summary>
internal static class NativeTextPresentation
{
    public static string DisplayText(string text)
    {
        ArgumentNullException.ThrowIfNull(text);
        if (text.IndexOfAny('\r', '\n') < 0) return text;

        var displayed = new System.Text.StringBuilder(text.Length);
        for (int index = 0; index < text.Length; index++)
        {
            char character = text[index];
            if (character == '\r')
            {
                if (index + 1 < text.Length && text[index + 1] == '\n') index++;
                displayed.Append("\r\n");
            }
            else if (character == '\n')
            {
                displayed.Append("\r\n");
            }
            else
            {
                displayed.Append(character);
            }
        }
        return displayed.ToString();
    }
}

/// <summary>Monotonic readiness and lifetime gate shared by the UI thread and its native callback.</summary>
internal sealed class ManualCompanionLifecycle
{
    private readonly object _gate = new();
    private readonly TaskCompletionSource _ready = new(TaskCreationOptions.RunContinuationsAsynchronously);
    private ManualCompanionLifecycleState _state = ManualCompanionLifecycleState.Initializing;

    public Task Ready => _ready.Task;
    public ManualCompanionLifecycleState State { get { lock (_gate) return _state; } }

    public bool TryCompleteReady(bool windowIsValid)
    {
        lock (_gate)
        {
            if (_state != ManualCompanionLifecycleState.Initializing) return false;
            if (!windowIsValid)
            {
                _state = ManualCompanionLifecycleState.Failed;
                _ready.TrySetException(new InvalidOperationException("Native companion window was invalid before it became ready."));
                return false;
            }
            _state = ManualCompanionLifecycleState.Ready;
            _ready.TrySetResult();
            return true;
        }
    }

    public void BeginClosing()
    {
        lock (_gate)
        {
            if (_state == ManualCompanionLifecycleState.Initializing)
            {
                _state = ManualCompanionLifecycleState.ClosingOrClosed;
                _ready.TrySetException(new InvalidOperationException("Native companion closed before it became ready."));
            }
            else if (_state == ManualCompanionLifecycleState.Ready)
            {
                _state = ManualCompanionLifecycleState.ClosingOrClosed;
            }
        }
    }

    public void Fail(Exception exception)
    {
        ArgumentNullException.ThrowIfNull(exception);
        lock (_gate)
        {
            if (_state is ManualCompanionLifecycleState.ClosingOrClosed or ManualCompanionLifecycleState.Failed) return;
            bool wasInitializing = _state == ManualCompanionLifecycleState.Initializing;
            _state = ManualCompanionLifecycleState.Failed;
            if (wasInitializing) _ready.TrySetException(exception);
        }
    }
}

/// <summary>Framework-independent state and command seam for the native companion.</summary>
internal sealed class ManualPublishingCompanionModel
{
    private readonly ManualSocialSession _session;
    private readonly Dictionary<ManualPreparedPlatform, HashSet<int>> _selection = new(ReferenceEqualityComparer.Instance);

    public ManualPublishingCompanionModel(ManualSocialSession session)
    {
        _session = session ?? throw new ArgumentNullException(nameof(session));
        if (session.Platforms.Count == 0) throw new ArgumentException("At least one platform is required.", nameof(session));
        foreach (ManualPreparedPlatform platform in session.Platforms)
            _selection[platform] = new HashSet<int>(Enumerable.Range(0, platform.Assets.Count).Where(i => IsAvailable(platform.Assets[i])));
    }

    public ManualSocialSession Session => _session;
    public int PlatformIndex { get; private set; }
    public ManualPreparedPlatform Platform => _session.Platforms[PlatformIndex];
    public bool IsPatreon => string.Equals(Platform.Platform, "patreon", StringComparison.OrdinalIgnoreCase);
    public string PlatformLabel => Platform.Platform.ToLowerInvariant() switch { "x" => "X", "bluesky" => "Bluesky", "patreon" => "Patreon", _ => Platform.Platform };
    public IReadOnlyList<ManualAssetListRow> AssetRows => Platform.Assets
        .Select((asset, ordinal) => new ManualAssetListRow(Platform, ordinal, asset)).ToArray();

    public void SelectPlatform(int index)
    {
        if (index < 0 || index >= _session.Platforms.Count) throw new ArgumentOutOfRangeException(nameof(index));
        PlatformIndex = index;
    }

    public string TextFor(ManualCopyCommand command) => command switch
    {
        ManualCopyCommand.Title when IsPatreon => Platform.Title,
        ManualCopyCommand.Body when IsPatreon => Platform.Body,
        ManualCopyCommand.Post when !IsPatreon => Platform.Body,
        _ => throw new InvalidOperationException("The copy command is not available for the selected platform."),
    };

    public bool TryCopy(ManualCopyCommand command, IUnicodeClipboard clipboard)
    {
        try { return clipboard.TrySetText(TextFor(command)); }
        catch { return false; }
    }

    public static bool IsAvailable(ManualPreparedAsset asset) =>
        asset.Asset.IsPresent && !string.IsNullOrWhiteSpace(asset.Path);

    public IReadOnlyList<ManualPreparedAsset> SelectedAssets => _selection[Platform]
        .OrderBy(index => index).Select(index => Platform.Assets[index]).ToArray();
    public IReadOnlyList<int> SelectedOrdinals => _selection[Platform].OrderBy(index => index).ToArray();

    public IReadOnlyList<ManualDragAsset> SnapshotSelectedAssets() => _selection[Platform]
        .OrderBy(index => index).Select(index => new ManualDragAsset(Platform.Assets[index], index)).ToArray();

    public void SetNativeSelectedOrdinals(IEnumerable<int> ordinals)
    {
        HashSet<int> selected = _selection[Platform];
        selected.Clear();
        foreach (int ordinal in ordinals)
            if (ordinal >= 0 && ordinal < Platform.Assets.Count) selected.Add(ordinal);
    }

    public string SelectedCountText => $"{SelectedAssets.Count} of {Platform.Assets.Count} selected";
    public string DragGuidanceText => SelectedOrdinals.Count == 0 ? "Select files to attach." :
        SelectedOrdinals.Any(ordinal => !IsAvailable(Platform.Assets[ordinal]))
            ? "Selection includes unavailable files and cannot be dragged."
            : "Drag any selected file to attach all selected files.";
}

/// <summary>Coordinates one native drag preparation without owning window or selection state.</summary>
internal sealed class ManualDragLifecycleCoordinator
{
    private readonly IManualAssetAvailability _availability;
    private readonly Func<bool> _postCompletion;
    private readonly Func<IReadOnlyList<string>, FileDragResult> _runDrag;
    private readonly Func<bool> _dragGestureActive;
    private readonly Action<string> _showFeedback;
    private readonly Func<string, bool> _pathIsAvailable;
    private readonly Func<int> _currentThreadId;
    private readonly Func<ApartmentState> _currentApartmentState;
    private readonly CancellationTokenSource _closing = new();
    private readonly object _gate = new();
    private Task<ManualDragPreparation>? _pending;
    private int? _nativeThreadId;

    public ManualDragLifecycleCoordinator(
        IManualAssetAvailability availability,
        Func<bool> postCompletion,
        Func<IReadOnlyList<string>, FileDragResult> runDrag,
        Func<bool> dragGestureActive,
        Action<string> showFeedback,
        Func<string, bool>? pathIsAvailable = null,
        Func<int>? currentThreadId = null,
        Func<ApartmentState>? currentApartmentState = null)
    {
        _availability = availability ?? throw new ArgumentNullException(nameof(availability));
        _postCompletion = postCompletion ?? throw new ArgumentNullException(nameof(postCompletion));
        _runDrag = runDrag ?? throw new ArgumentNullException(nameof(runDrag));
        _dragGestureActive = dragGestureActive ?? throw new ArgumentNullException(nameof(dragGestureActive));
        _showFeedback = showFeedback ?? throw new ArgumentNullException(nameof(showFeedback));
        _pathIsAvailable = pathIsAvailable ?? (path => Path.IsPathFullyQualified(path) && File.Exists(path));
        _currentThreadId = currentThreadId ?? (() => Environment.CurrentManagedThreadId);
        _currentApartmentState = currentApartmentState ?? (() => Thread.CurrentThread.GetApartmentState());
    }

    public bool IsPreparing { get { lock (_gate) return _pending is not null; } }
    public int? NativeThreadId { get { lock (_gate) return _nativeThreadId; } }

    public void AttachNativeThread()
    {
        if (_currentApartmentState() != ApartmentState.STA)
            throw new InvalidOperationException("Native file dragging requires an STA companion thread.");
        lock (_gate)
        {
            int current = _currentThreadId();
            if (_nativeThreadId is not null && _nativeThreadId != current)
                throw new InvalidOperationException("The drag coordinator is already attached to another native thread.");
            _nativeThreadId = current;
        }
    }

    public bool TryBegin(IReadOnlyList<ManualDragAsset> selected)
    {
        ArgumentNullException.ThrowIfNull(selected);
        lock (_gate)
        {
            if (_closing.IsCancellationRequested || _pending is not null) return false;
            if (selected.Count == 0)
            {
                ShowFeedback("Select at least one available asset before dragging.");
                return false;
            }

            ShowFeedback("Preparing selected files for drag…");
            try
            {
                Task<ManualDragPreparation> pending = _availability.PrepareAsync(selected, _closing.Token)
                    ?? throw new InvalidOperationException("Asset availability returned no preparation task.");
                _pending = pending;
                _ = pending.ContinueWith(
                    completed => PostCompletedPreparation(completed),
                    CancellationToken.None, TaskContinuationOptions.ExecuteSynchronously, TaskScheduler.Default);
                return true;
            }
            catch
            {
                _pending = null;
                ShowFeedback("Unable to prepare the selected files for dragging. Try again.");
                return false;
            }
        }
    }

    public bool CompleteOnNativeThread()
    {
        Task<ManualDragPreparation>? pending;
        lock (_gate)
        {
            if (_nativeThreadId is null || _nativeThreadId != _currentThreadId()) return false;
            pending = _pending;
            if (_closing.IsCancellationRequested)
            {
                if (pending?.IsCompleted == true) _pending = null;
                return false;
            }
            if (pending is null || !pending.IsCompleted) return false;
        }

        try
        {
            ManualDragPreparation result = pending.GetAwaiter().GetResult();
            if (!result.Success)
            {
                string asset = string.IsNullOrWhiteSpace(result.AssetName) ? string.Empty : $" ({result.AssetName})";
                string reason = result.ErrorCode == "media_token_expired"
                    ? "Authorization expired; reopen the preparation to retry."
                    : $"Selected media is unavailable{asset}: {result.ErrorCode ?? "validation_failed"}.";
                ShowFeedback(reason);
                return false;
            }
            foreach (string path in result.Paths)
            {
                if (!_pathIsAvailable(path))
                {
                    ShowFeedback($"Selected media disappeared before dragging ({Path.GetFileName(path)}). Try again.");
                    return false;
                }
            }
            if (!_dragGestureActive())
            {
                ShowFeedback("File drag cancelled before preparation completed.");
                return false;
            }

            FileDragResult drag = _runDrag(result.Paths);
            ShowFeedback(drag switch
            {
                FileDragResult.Copied => "Files dropped (upload completion is controlled by the target).",
                FileDragResult.Cancelled => "File drag cancelled.",
                FileDragResult.Rejected => "The target did not accept a copy of the files.",
                _ => "Windows could not complete the file drag. Try again.",
            });
            return true;
        }
        catch (OperationCanceledException) when (_closing.IsCancellationRequested) { return false; }
        catch
        {
            ShowFeedback("Unable to prepare the selected files for dragging. Try again.");
            return false;
        }
        finally
        {
            lock (_gate)
                if (ReferenceEquals(_pending, pending)) _pending = null;
        }
    }

    public void BeginClose()
    {
        try { _closing.Cancel(); } catch (ObjectDisposedException) { }
    }

    public async Task StopPendingAsync()
    {
        BeginClose();
        Task<ManualDragPreparation>? pending;
        lock (_gate) pending = _pending;
        if (pending is not null) try { await pending.ConfigureAwait(false); } catch { }
        lock (_gate)
            if (ReferenceEquals(_pending, pending)) _pending = null;
    }

    public async Task ShutdownAsync(Action releaseNativeState, IDisposable mediaLease)
    {
        ArgumentNullException.ThrowIfNull(releaseNativeState);
        ArgumentNullException.ThrowIfNull(mediaLease);
        BeginClose();
        try { await StopPendingAsync().ConfigureAwait(false); }
        finally
        {
            try { releaseNativeState(); }
            finally
            {
                try { mediaLease.Dispose(); }
                finally { _closing.Dispose(); }
            }
        }
    }

    private void PostCompletedPreparation(Task<ManualDragPreparation> completed)
    {
        lock (_gate)
            if (!ReferenceEquals(_pending, completed) || _closing.IsCancellationRequested) return;

        bool posted;
        try { posted = _postCompletion(); }
        catch { posted = false; }
        if (posted) return;

        lock (_gate)
            if (ReferenceEquals(_pending, completed)) _pending = null;
    }

    private void ShowFeedback(string message)
    {
        try { _showFeedback(message); } catch { }
    }
}

/// <summary>Production raw-Win32 manual publishing preparation window.</summary>
internal sealed class NativeManualPublishingCompanion :
    IManualSocialCompanion, IManualSocialPreviewCompanion, IManualPostingConfirmationCompanion
{
    public static NativeManualPublishingCompanion Instance { get; } = new();

    public IManualSocialCompanionLifetime Open(
        ManualSocialSession session, IDisposable mediaLease, IManualAssetAvailability availability) =>
        new Lifetime(session, mediaLease, availability, null, null);

    public IManualSocialCompanionLifetime OpenWithPreviews(
        ManualSocialSession session, IDisposable mediaLease, IManualAssetAvailability availability,
        IManualAssetPreviewAccess previewAccess) =>
        new Lifetime(session, mediaLease, availability, previewAccess, null);

    public IManualSocialCompanionLifetime OpenWithPostingConfirmation(
        ManualSocialSession session, IDisposable mediaLease, IManualAssetAvailability availability,
        IManualAssetPreviewAccess? previewAccess, ManualPostingConfirmationController confirmation) =>
        new Lifetime(session, mediaLease, availability, previewAccess,
            confirmation ?? throw new ArgumentNullException(nameof(confirmation)));

    private sealed class Lifetime : IManualSocialCompanionLifetime
    {
        private readonly TaskCompletionSource _closed = new(TaskCreationOptions.RunContinuationsAsynchronously);
        private readonly ManualCompanionLifecycle _lifecycle = new();
        private readonly NativeWindow _window;

        public Lifetime(
            ManualSocialSession session, IDisposable mediaLease, IManualAssetAvailability availability,
            IManualAssetPreviewAccess? previewAccess, ManualPostingConfirmationController? confirmation)
        {
            ArgumentNullException.ThrowIfNull(mediaLease);
            ArgumentNullException.ThrowIfNull(availability);
            _window = new NativeWindow(
                new ManualPublishingCompanionModel(session), availability, _lifecycle,
                previewAccess: previewAccess, confirmation: confirmation);
            _ = Task.Run(async () =>
            {
                try
                {
                    NativePresentationResult result = NativeOperatorUiHost.Show(
                        new NativeOperatorUiHost.Native(), presentation =>
                        {
                            try { _window.Run(presentation); }
                            catch (Exception exception) { _lifecycle.Fail(exception); throw; }
                        });
                    if (!_lifecycle.Ready.IsCompleted)
                        _lifecycle.Fail(new InvalidOperationException($"Native companion failed at {result.Stage}."));
                }
                catch (Exception exception) { _lifecycle.Fail(exception); }
                finally
                {
                    try { await _window.ShutdownAsync(mediaLease).ConfigureAwait(false); }
                    catch { }
                    finally { _closed.TrySetResult(); }
                }
            });
        }

        public Task Ready => _lifecycle.Ready;
        public Task Closed => _closed.Task;
        public void Dispose() => _window.RequestClose();
    }

    internal sealed class NativeWindow
    {
        private enum StatusKind { Neutral, Success, Error }
        private const string ClassName = "CreatorCrate.ManualPublishingCompanion";
        private const string WindowTitle = "CreatorCrate Manual Publishing Preparation";
        internal const uint ReadyProbeMessage = 0x8000 + 0x51;
        internal const uint DragPreparedMessage = 0x8000 + 0x52;
        internal const uint PreviewReadyMessage = 0x8000 + 0x53;
        internal const uint PostingConfirmationCompletedMessage = 0x8000 + 0x54;
        private const uint TestingInvokeMessage = 0x8000 + 0x55;
        private const uint WM_NCCREATE = 0x0081, WM_SIZE = 0x0005, WM_SETFOCUS = 0x0007, WM_KILLFOCUS = 0x0008,
            WM_GETMINMAXINFO = 0x0024, WM_COMMAND = 0x0111, WM_NOTIFY = 0x004E, WM_CLOSE = 0x0010, WM_DESTROY = 0x0002,
            WM_SETFONT = 0x0030, WM_GETFONT = 0x0031, WM_KEYDOWN = 0x0100, WM_PAINT = 0x000F,
            WM_LBUTTONDOWN = 0x0201, WM_LBUTTONUP = 0x0202, WM_MOUSEMOVE = 0x0200, WM_MOUSELEAVE = 0x02A3,
            WM_ERASEBKGND = 0x0014, WM_DRAWITEM = 0x002B, WM_MEASUREITEM = 0x002C,
            WM_CTLCOLORSTATIC = 0x0138, WM_CTLCOLORLISTBOX = 0x0134,
            WM_SETTINGCHANGE = 0x001A, WM_SYSCOLORCHANGE = 0x0015, WM_THEMECHANGED = 0x031A, WM_DPICHANGED = 0x02E0;
        internal const uint ProductionWindowStyle = 0x00CF0000; // WS_OVERLAPPEDWINDOW
        internal const uint ProductionWindowExtendedStyle = 0;
        private const uint WS_VISIBLE = 0x10000000, WS_CHILD = 0x40000000,
            WS_TABSTOP = 0x00010000, WS_BORDER = 0x00800000, WS_HSCROLL = 0x00100000, WS_VSCROLL = 0x00200000,
            BS_OWNERDRAW = 0x0000000B,
            CBS_DROPDOWNLIST = 0x0003, CBS_OWNERDRAWFIXED = 0x0010, CBS_HASSTRINGS = 0x0200,
            LVS_REPORT = 0x0001, LVS_SHOWSELALWAYS = 0x0008;
        internal const uint ProductionButtonStyle = WS_CHILD | WS_VISIBLE | WS_TABSTOP | BS_OWNERDRAW;
        internal const uint ProductionButtonExtendedStyle = 0;
        internal const uint ProductionPlatformStyle = WS_CHILD | WS_VISIBLE | WS_TABSTOP |
            CBS_DROPDOWNLIST | CBS_OWNERDRAWFIXED | CBS_HASSTRINGS | WS_VSCROLL;
        // USER32 owns the popup ListBox scrollbar and normalizes WS_VSCROLL off the ComboBox HWND.
        internal const uint ProductionPlatformRuntimeStyle = ProductionPlatformStyle & ~WS_VSCROLL;
        internal const uint ProductionPlatformExtendedStyle = 0;
        internal const uint AssetListStyle = WS_TABSTOP | WS_BORDER | WS_HSCROLL | WS_VSCROLL | LVS_REPORT | LVS_SHOWSELALWAYS;
        internal const uint AssetListExtendedStyle = 0x00000020 | 0x00010000; // LVS_EX_FULLROWSELECT | LVS_EX_DOUBLEBUFFER
        private const int SW_SHOW = 5, SW_HIDE = 0, VK_ESCAPE = 0x1B, VK_RETURN = 0x0D, VK_TAB = 0x09,
            GWLP_USERDATA = -21, GWL_STYLE = -16, GWL_EXSTYLE = -20,
            CBN_SELCHANGE = 1, CBN_DROPDOWN = 7, CBN_CLOSEUP = 8;
        private const int ImageIcon = 1, SmCxIcon = 11, SmCyIcon = 12, SmCxSmallIcon = 49, SmCySmallIcon = 50;
        private const uint LrShared = 0x00008000;
        private const int SbVert = 1;
        private const uint SifAll = 0x0017;
        private const uint OdtComboBox = 3, OdtButton = 4,
            OdsSelected = 0x0001, OdsDisabled = 0x0004, OdsFocus = 0x0010,
            DtCenter = 0x00000001, DtVCenter = 0x00000004, DtSingleLine = 0x00000020,
            DtNoPrefix = 0x00000800, DtEndEllipsis = 0x00008000,
            TmeLeave = 0x00000002,
            SwpNoZOrder = 0x0004, SwpNoActivate = 0x0010,
            CdrfDodefault = 0x00000000, CdrfNewFont = 0x00000002, CdrfSkipDefault = 0x00000004,
            CdrfNotifyPostpaint = 0x00000010, CdrfNotifyItemDraw = 0x00000020,
            CddsPrepaint = 0x00000001, CddsPostpaint = 0x00000002,
            CddsItemPrepaint = 0x00010001, CddsItemPostpaint = 0x00010002;
        private const uint DfcButton = 4, DfcsButtonPush = 0x0010, DfcsInactive = 0x0100,
            DfcsPushed = 0x0200, DfcsHot = 0x1000;
        private const uint BM_CLICK = 0x00F5, CB_GETCOUNT = 0x0146, CB_ADDSTRING = 0x0143,
            CB_GETCURSEL = 0x0147, CB_GETLBTEXT = 0x0148, CB_GETLBTEXTLEN = 0x0149,
            CB_SETCURSEL = 0x014E, CB_SHOWDROPDOWN = 0x014F, CB_SETITEMHEIGHT = 0x0153,
            CB_GETITEMHEIGHT = 0x0154, CB_GETDROPPEDSTATE = 0x0157,
            LVM_FIRST = 0x1000, LVM_GETITEM = LVM_FIRST + 75, LVM_INSERTITEM = LVM_FIRST + 77,
            LVM_DELETEALLITEMS = LVM_FIRST + 9, LVM_GETITEMCOUNT = LVM_FIRST + 4,
            LVM_GETSELECTEDCOUNT = LVM_FIRST + 50, LVM_GETNEXTITEM = LVM_FIRST + 12,
            LVM_GETITEMSTATE = LVM_FIRST + 44, LVM_GETITEMRECT = LVM_FIRST + 14,
            LVM_SETITEMSTATE = LVM_FIRST + 43, LVM_SETITEMTEXT = LVM_FIRST + 116,
            LVM_SCROLL = LVM_FIRST + 20, LVM_ENSUREVISIBLE = LVM_FIRST + 19,
            LVM_INSERTCOLUMN = LVM_FIRST + 97, LVM_SETCOLUMNWIDTH = LVM_FIRST + 30,
            LVM_SETEXTENDEDLISTVIEWSTYLE = LVM_FIRST + 54, LVM_GETHEADER = LVM_FIRST + 31,
            LVM_SETIMAGELIST = LVM_FIRST + 3, LVM_SETITEM = LVM_FIRST + 76,
            LVM_SETBKCOLOR = LVM_FIRST + 1, LVM_GETBKCOLOR = LVM_FIRST + 0, LVM_SETTEXTCOLOR = LVM_FIRST + 36,
            LVM_SETTEXTBKCOLOR = LVM_FIRST + 38,
            HDM_FIRST = 0x1200, HDM_GETITEMCOUNT = HDM_FIRST, HDM_GETITEMRECT = HDM_FIRST + 7;
        private const uint LvifText = 0x0001, LvifImage = 0x0002, LvifParam = 0x0004,
            LvisFocused = 0x0001, LvisSelected = 0x0002,
            LvniSelected = 0x0002, LvcfFmt = 0x0001, LvcfWidth = 0x0002, LvcfText = 0x0004,
            LvifState = 0x0008, CdisSelected = 0x0001;
        internal const int LvnItemChanged = -101, LvnBeginDrag = -109, NmCustomDraw = -12;
        internal const int PlatformId = 201;
        internal const int CopyTitleId = 204, CopyMainId = 205;
        internal const uint CloseMessage = WM_CLOSE, DestroyMessage = WM_DESTROY;
        private const int AssetListId = 206;
        internal const int CloseId = 208, PostingConfirmationId = 209;
        private static readonly WindowProc Procedure = WindowProcedure;
        private static readonly SubclassProc ButtonProcedure = ButtonWindowProcedure;
        private static readonly SubclassProc PlatformComboProcedure = PlatformComboWindowProcedure;
        private static readonly SubclassProc AssetListProcedure = AssetListWindowProcedure;

        private readonly WindowState _state;
        private readonly ManualCompanionLifecycle _lifecycle;
        private readonly ManualDragLifecycleCoordinator _drag;
        private readonly Func<IReadOnlyList<ManualDragAsset>, bool> _tryBeginDrag;
        private readonly Func<bool> _dragSessionAvailable;
        private readonly Func<IntPtr, IUnicodeClipboard> _clipboardFactory;
        private readonly IManualAssetPreviewAccess? _previewAccess;
        // Borrowed for the native window lifetime. ManualSocialPreparationOrchestrator is the sole owner/disposer.
        private readonly ManualPostingConfirmationController? _confirmation;
        private NativeAssetPreviewPipeline? _previews;
        private OleThreadLifetime? _ole;
        private NativeCompanionTheme? _theme;
        private NativeCompanionLayout? _layout;
        private readonly WinUiHostProofOptions? _winUiProofOptions;
        private readonly bool _disableWinUiForNativeOnlyTests;
        private readonly HashSet<IntPtr> _hoveredButtons = [];
        private WinUiTextSurfaceHost? _winUiTextSurfaces;
        private StatusKind _statusKind;
        private StatusKind _postingStatusKind;
        private bool _suppressAssetNotifications;
        private bool _aggregateComplete;
        private bool _platformHovered;
        private IntPtr _window;
        private IntPtr _imageList;
        private long _previewGeneration;
        private int _thumbnailPixelSize;
        private int _pendingImageIndex = -1, _unavailableImageIndex = -1, _failedImageIndex = -1;
        private int _previewClosing;
        private int _confirmationClosing;
        private int _closeRequested;
        private int _assetColumnClientWidth = -1;
        private int _assetColumnDpi = -1;
        private uint _uiThreadId;
        private GCHandle _assetListSubclassHandle;
        private Action<uint, IntPtr>? _headerDrawObserver;
        private Action<NativeHeaderPostpaintProbe>? _headerPostpaintObserver;
        private Action<NativeListViewRowDrawProbe>? _listViewDrawObserver;
        private Action<NativeListViewBeginDragProbe>? _listViewBeginDragObserver;
        private Action<NativePlatformPopupDiscoveryObservation>? _platformPopupDiscoveryObserver;

        public NativeWindow(
            ManualPublishingCompanionModel model, ManualCompanionLifecycle? lifecycle = null,
            ManualPostingConfirmationController? confirmation = null,
            Func<IntPtr, IUnicodeClipboard>? clipboardFactory = null,
            bool disableWinUiForNativeOnlyTests = false)
            : this(model, RejectingAssetAvailability.Instance, lifecycle,
                confirmation: confirmation, clipboardFactory: clipboardFactory,
                disableWinUiForNativeOnlyTests: disableWinUiForNativeOnlyTests) { }

        public NativeWindow(
            ManualPublishingCompanionModel model, IManualAssetAvailability availability,
            ManualCompanionLifecycle? lifecycle,
            Func<IReadOnlyList<ManualDragAsset>, bool>? tryBeginDrag = null,
            Func<bool>? dragSessionAvailable = null,
            IManualAssetPreviewAccess? previewAccess = null,
            INativeShellThumbnailExtractor? previewExtractor = null,
            INativePreviewWorkerApartment? previewApartment = null,
            ManualPostingConfirmationController? confirmation = null,
            Func<IntPtr, IUnicodeClipboard>? clipboardFactory = null,
            WinUiHostProofOptions? winUiProofOptions = null,
            bool disableWinUiForNativeOnlyTests = false)
        {
            _lifecycle = lifecycle ?? new ManualCompanionLifecycle();
            _state = new WindowState(model, _lifecycle);
            _state.Attach(this);
            _drag = new ManualDragLifecycleCoordinator(
                availability ?? throw new ArgumentNullException(nameof(availability)),
                () => { IntPtr window = _window; return window != IntPtr.Zero && PostMessage(window, DragPreparedMessage, IntPtr.Zero, IntPtr.Zero); },
                paths => WindowsFileDrag.Run(paths),
                () => (GetAsyncKeyState(0x01) & 0x8000) != 0,
                message => SetStatus(message, StatusKind.Neutral));
            _tryBeginDrag = tryBeginDrag ?? _drag.TryBegin;
            _dragSessionAvailable = dragSessionAvailable ?? (() => _ole?.Available == true);
            _clipboardFactory = clipboardFactory ?? (window => new NativeUnicodeClipboard(window));
            _previewAccess = previewAccess;
            _confirmation = confirmation;
            _winUiProofOptions = winUiProofOptions;
            _disableWinUiForNativeOnlyTests = disableWinUiForNativeOnlyTests;
            if (previewAccess is not null)
                _previews = new NativeAssetPreviewPipeline(
                    previewAccess,
                    () => { IntPtr window = _window; return window != IntPtr.Zero && PostMessage(window, PreviewReadyMessage, IntPtr.Zero, IntPtr.Zero); },
                    previewExtractor, previewApartment);
        }

        internal string StatusText { get; private set; } = string.Empty;
        internal IntPtr WindowHandle => _window;
        internal IntPtr PlatformHandle => _state.Platform;
        internal IntPtr PostingStatusHandle => _state.PostingStatus;
        internal IntPtr PostingHelperHandle => _state.PostingHelper;
        internal IntPtr PostingActionHandle => _state.PostingAction;
        internal IntPtr PostingAggregateHandle => _state.PostingAggregate;
        internal IntPtr AssetCountHandle => _state.AssetCount;
        internal IntPtr DragGuidanceHandle => _state.DragGuidance;
        internal event Action? PostingPresentationChanged;

        internal IReadOnlyList<int?> CaptureAssetImagesForTesting() =>
            RunOnUiThreadForTesting(() => Enumerable.Range(0, _state.Model.Platform.Assets.Count)
                .Select(index => ItemImage(_state.AssetList, index)).ToArray());

        internal NativeAssetViewportProbe CaptureAssetViewportForTesting() =>
            RunOnUiThreadForTesting(CaptureAssetViewportCore);

        internal NativeAssetViewportProbe CaptureAssetViewportAtMetricDpiForTesting(
            NativeCompanionPalette palette, int dpi) =>
            RunOnUiThreadForTesting(() =>
            {
                ApplyThemeForTesting(palette, dpi);
                RebuildPreviewImageList(dpi);
                _suppressAssetNotifications = true;
                try
                {
                    PopulateAssetRowsWithPlaceholders();
                    ApplySelectionCore();
                }
                finally { _suppressAssetNotifications = false; }
                MoveWindow(_state.AssetList, 0, 0, Scale(800, dpi), Scale(800, dpi), true);
                ResizeAssetColumnsToClient(dpi);
                return CaptureAssetViewportCore() with { Dpi = dpi };
            });

        internal NativeAssetViewportProbe EnsureLastAssetVisibleForTesting() =>
            RunOnUiThreadForTesting(() =>
            {
                int count = checked((int)SendMessage(
                    _state.AssetList, LVM_GETITEMCOUNT, IntPtr.Zero, IntPtr.Zero).ToInt64());
                if (count > 0)
                    SendMessage(_state.AssetList, LVM_ENSUREVISIBLE, new IntPtr(count - 1), new IntPtr(1));
                return CaptureAssetViewportCore();
            });

        internal NativePlatformComboProbe CapturePlatformComboForTesting() =>
            RunOnUiThreadForTesting(CapturePlatformComboCore);

        internal NativePlatformComboProbe ApplyThemeAndCapturePlatformForTesting(
            NativeCompanionPalette palette, int dpi,
            Func<IntPtr, string?, string?, int>? setWindowTheme = null) =>
            RunOnUiThreadForTesting(() =>
            {
                ApplyThemeForTesting(palette, dpi, setWindowTheme);
                return CapturePlatformComboCore();
            });

        internal NativePlatformComboProbe ShowPlatformDropdownForTesting(bool show) =>
            RunOnUiThreadForTesting(() =>
            {
                SendMessage(_state.Platform, CB_SHOWDROPDOWN, new IntPtr(show ? 1 : 0), IntPtr.Zero);
                return CapturePlatformComboCore();
            });

        internal NativePlatformComboProbe FocusPlatformForTesting() =>
            RunOnUiThreadForTesting(() =>
            {
                SetFocus(_state.Platform);
                return CapturePlatformComboCore();
            });

        internal NativePlatformComboProbe SetPlatformHoverForTesting(bool hovered) =>
            RunOnUiThreadForTesting(() =>
            {
                SendMessage(_state.Platform, hovered ? WM_MOUSEMOVE : WM_MOUSELEAVE, IntPtr.Zero, IntPtr.Zero);
                return CapturePlatformComboCore();
            });

        private NativePlatformComboProbe CapturePlatformComboCore()
        {
            IntPtr combo = _state.Platform;
            ComboBoxInfo info = new() { cbSize = (uint)Marshal.SizeOf<ComboBoxInfo>() };
            if (!GetComboBoxInfo(combo, ref info)) throw NativeFailure();
            int selected = unchecked((int)SendMessage(combo, CB_GETCURSEL, IntPtr.Zero, IntPtr.Zero).ToInt64());
            int count = unchecked((int)SendMessage(combo, CB_GETCOUNT, IntPtr.Zero, IntPtr.Zero).ToInt64());
            return new NativePlatformComboProbe(
                combo, WindowClassName(combo),
                unchecked((uint)GetWindowLongPtr(combo, GWL_STYLE).ToInt64()),
                unchecked((uint)GetWindowLongPtr(combo, GWL_EXSTYLE).ToInt64()),
                GetDlgCtrlID(combo), GetParent(combo), ComboItemText(combo, uint.MaxValue), selected, count,
                info.hwndList, WindowClassName(info.hwndList), GetFocus() == combo,
                SendMessage(combo, CB_GETDROPPEDSTATE, IntPtr.Zero, IntPtr.Zero) != IntPtr.Zero,
                _platformHovered, _theme?.Palette.Mode ?? NativeCompanionThemeMode.Light,
                _theme?.Dpi ?? DpiForWindow(_window),
                unchecked((int)SendMessage(combo, CB_GETITEMHEIGHT, IntPtr.Zero, IntPtr.Zero).ToInt64()),
                unchecked((int)SendMessage(combo, CB_GETITEMHEIGHT, new IntPtr(-1), IntPtr.Zero).ToInt64()));
        }

        internal void SetPlatformPopupDiscoveryObserverForTesting(
            Action<NativePlatformPopupDiscoveryObservation>? observer) =>
            RunOnUiThreadForTesting(() =>
            {
                _platformPopupDiscoveryObserver = observer;
                return true;
            });

        internal NativeCompanionOwnerDrawTarget? OwnerDrawTargetForTesting(
            uint controlType, uint controlId, IntPtr itemWindow) =>
            ResolveOwnerDrawTarget(controlType, controlId, itemWindow);

        internal NativeCompanionButtonRole? ButtonRoleForTesting(IntPtr button)
        {
            int controlId = GetDlgCtrlID(button);
            NativeCompanionOwnerDrawTarget? target = ResolveOwnerDrawTarget(
                OdtButton, unchecked((uint)controlId), button);
            return target switch
            {
                NativeCompanionOwnerDrawTarget.PrimaryButton => NativeCompanionButtonRole.Primary,
                NativeCompanionOwnerDrawTarget.SecondaryButton => NativeCompanionButtonRole.Secondary,
                _ => null,
            };
        }

        internal NativeProductionLayoutProbe ResizeToMinimumAndCaptureLayoutForTesting(int platformIndex) =>
            RunOnUiThreadForTesting(() => ResizeToMinimumAndCaptureLayoutCore(platformIndex));

        internal NativeProductionLayoutProbe ResizeAndCaptureLayoutForTesting(
            int platformIndex, int logicalWidth, int logicalHeight, string operationalStatusText = "") =>
            RunOnUiThreadForTesting(() => ResizeAndCaptureLayoutCore(
                platformIndex, logicalWidth, logicalHeight, operationalStatusText: operationalStatusText));

        internal NativeAuthoritativeTextLayoutProbe CaptureAuthoritativeTextLayoutForTesting() =>
            RunOnUiThreadForTesting(() =>
            {
                NativeCompanionLayout layout = _layout ??
                    throw new InvalidOperationException("The production companion layout is not available.");
                return new NativeAuthoritativeTextLayoutProbe(
                    _state.Model.Platform.Platform, _state.Model.IsPatreon,
                    layout.TitleText, layout.BodyText);
            });

        private NativeProductionLayoutProbe ResizeToMinimumAndCaptureLayoutCore(int platformIndex)
        {
            if (_window == IntPtr.Zero) throw new InvalidOperationException("The production companion window is not running.");
            int dpi = DpiForWindow(_window);
            IntPtr pointer = Marshal.AllocHGlobal(Marshal.SizeOf<MinMaxInfo>());
            NativeLayoutSize minimum;
            try
            {
                Marshal.StructureToPtr(new MinMaxInfo(), pointer, false);
                SendMessage(_window, WM_GETMINMAXINFO, IntPtr.Zero, pointer);
                MinMaxInfo info = Marshal.PtrToStructure<MinMaxInfo>(pointer);
                minimum = new(info.ptMinTrackSize.x, info.ptMinTrackSize.y);
            }
            finally { Marshal.FreeHGlobal(pointer); }

            return ResizeAndCaptureLayoutCore(platformIndex, 820, 754, minimum);
        }

        private NativeProductionLayoutProbe ResizeAndCaptureLayoutCore(
            int platformIndex, int logicalWidth, int logicalHeight, NativeLayoutSize? minimumTrack = null,
            string operationalStatusText = "")
        {
            if (_window == IntPtr.Zero) throw new InvalidOperationException("The production companion window is not running.");
            SendMessage(_state.Platform, CB_SETCURSEL, new IntPtr(platformIndex), IntPtr.Zero);
            HandleCommand(PlatformId, CBN_SELCHANGE, _state.Platform);
            if (!string.IsNullOrEmpty(operationalStatusText))
                SetStatus(operationalStatusText, StatusKind.Neutral);
            int dpi = DpiForWindow(_window);
            NativeLayoutSize outer = OuterSizeForLogicalClient(logicalWidth, logicalHeight, dpi);
            if (!SetWindowPos(_window, IntPtr.Zero, 0, 0, outer.Width, outer.Height, SwpNoZOrder | SwpNoActivate))
                throw NativeFailure();
            Layout();
            if (!GetClientRect(_window, out Rect client) || _layout is null) throw NativeFailure();

            NativeLayoutRect Actual(IntPtr child)
            {
                if (child == IntPtr.Zero) return default;
                if (!GetWindowRect(child, out Rect rectangle)) throw NativeFailure();
                var points = new[] { new Point { x = rectangle.left, y = rectangle.top }, new Point { x = rectangle.right, y = rectangle.bottom } };
                SetLastError(0);
                if (MapWindowPoints(IntPtr.Zero, _window, points, 2) == 0 && Marshal.GetLastWin32Error() != 0) throw NativeFailure();
                return new(points[0].x, points[0].y, points[1].x - points[0].x, points[1].y - points[0].y);
            }

            return new(
                _state.Model.Platform.Platform, new(client.right, client.bottom),
                minimumTrack ?? MinimumOuterSizeForDpi(dpi), dpi,
                Actual(_state.Header), Actual(_state.HeaderMetadata), _layout.PlatformCard,
                Actual(_state.PlatformHeading), Actual(_state.Platform), Actual(_state.TitleLabel),
                _winUiTextSurfaces is null ? _layout.TitleText : Actual(_winUiTextSurfaces.TitleWindow),
                Actual(_state.CopyTitle), Actual(_state.BodyLabel),
                _winUiTextSurfaces is null ? _layout.BodyText : Actual(_winUiTextSurfaces.BodyWindow),
                Actual(_state.CopyMain), Actual(_state.PostingStatus),
                Actual(_state.PostingHelper), Actual(_state.PostingAction), Actual(_state.PostingAggregate),
                _layout.AssetsCard, Actual(_state.AssetLabel), Actual(_state.AssetCount), Actual(_state.DragGuidance),
                Actual(_state.AssetList), _layout.Footer, Actual(_state.Status), Actual(_state.Close));
        }

        internal NativeProductionTextSurfaceProbe CaptureTextSurfacesForTesting(int platformIndex) =>
            RunOnUiThreadForTesting(() =>
            {
                SendMessage(_state.Platform, CB_SETCURSEL, new IntPtr(platformIndex), IntPtr.Zero);
                HandleCommand(PlatformId, CBN_SELCHANGE, _state.Platform);
                return CaptureTextSurfacesCore();
            });

        internal NativeProductionTextSurfaceProbe CaptureCurrentTextSurfacesForTesting() =>
            RunOnUiThreadForTesting(CaptureTextSurfacesCore);

        internal void SetBodyTextSelectionForTesting(int start, int end) =>
            RunOnUiThreadForTesting(() =>
            {
                (_winUiTextSurfaces ?? throw new InvalidOperationException(
                    "Production WinUI text surfaces are not running.")).SetBodySelectionForTesting(start, end);
                return true;
            });

        internal void SetTextSurfaceThemeForTesting(ElementTheme theme) =>
            RunOnUiThreadForTesting(() =>
            {
                (_winUiTextSurfaces ?? throw new InvalidOperationException(
                    "Production WinUI text surfaces are not running.")).SetTheme(theme);
                return true;
            });

        private NativeProductionTextSurfaceProbe CaptureTextSurfacesCore()
        {
            WinUiTextSurfaceHost host = _winUiTextSurfaces ??
                throw new InvalidOperationException("Production WinUI text surfaces are not running.");
            return new NativeProductionTextSurfaceProbe(
                _state.Model.Platform.Platform, host.TitleText, host.BodyText,
                host.TitleAccessibleName, host.BodyAccessibleName,
                host.TitleVisible, host.TitleIsTabStop, host.BodyIsTabStop,
                host.TitleIsReadOnly, host.BodyIsReadOnly,
                host.TitleColorFontEnabled, host.BodyColorFontEnabled,
                host.TitleTextScaleEnabled, host.BodyTextScaleEnabled,
                host.SurfaceCount, host.Theme, host.TitleWindow, host.BodyWindow,
                host.Presentation, host.TitleResources, host.BodyResources,
                host.TitleSelection, host.BodySelection);
        }

        internal NativeProductionKeyboardProbe CaptureKeyboardIntegrationForTesting(
            string expectedPostingAction = "Mark as posted") =>
            RunOnUiThreadForTesting(() =>
            {
                WinUiTextSurfaceHost host = _winUiTextSurfaces ??
                    throw new InvalidOperationException("Production WinUI text surfaces are not running.");

                bool postingReady = _state.PostingAction != IntPtr.Zero && IsWindow(_state.PostingAction) &&
                    IsWindowVisible(_state.PostingAction) && IsWindowEnabled(_state.PostingAction) &&
                    WindowText(_state.PostingAction) == expectedPostingAction;

                bool Forward(int platformIndex, bool patreon)
                {
                    SelectPlatformForKeyboardProbe(platformIndex);
                    SetFocus(_state.Platform);
                    MoveFocusByTab(previous: false);
                    bool valid = FocusWithin(patreon ? host.TitleWindow : host.BodyWindow);
                    if (patreon)
                    {
                        TakeFocusFromWinUi(0, previous: false);
                        valid &= GetFocus() == _state.CopyTitle;
                        SetFocus(_state.CopyTitle);
                        MoveFocusByTab(previous: false);
                        valid &= FocusWithin(host.BodyWindow);
                    }
                    TakeFocusFromWinUi(1, previous: false);
                    valid &= GetFocus() == _state.CopyMain;
                    SetFocus(_state.CopyMain);
                    MoveFocusByTab(previous: false);
                    valid &= GetFocus() == _state.PostingAction;
                    SetFocus(_state.PostingAction);
                    MoveFocusByTab(previous: false);
                    valid &= GetFocus() == _state.AssetList;
                    SetFocus(_state.AssetList);
                    MoveFocusByTab(previous: false);
                    return valid && GetFocus() == _state.Close;
                }

                bool Reverse(int platformIndex, bool patreon)
                {
                    SelectPlatformForKeyboardProbe(platformIndex);
                    SetFocus(_state.PostingAction);
                    MoveFocusByTab(previous: true);
                    bool valid = GetFocus() == _state.CopyMain;
                    SetFocus(_state.CopyMain);
                    MoveFocusByTab(previous: true);
                    valid &= FocusWithin(host.BodyWindow);
                    TakeFocusFromWinUi(1, previous: true);
                    if (patreon)
                    {
                        valid &= GetFocus() == _state.CopyTitle;
                        SetFocus(_state.CopyTitle);
                        MoveFocusByTab(previous: true);
                        valid &= FocusWithin(host.TitleWindow);
                        TakeFocusFromWinUi(0, previous: true);
                    }
                    return valid && GetFocus() == _state.Platform &&
                        (patreon || (!host.TitleVisible && !host.TitleIsTabStop));
                }

                bool EnterSafe(int platformIndex, bool title)
                {
                    SelectPlatformForKeyboardProbe(platformIndex);
                    IntPtr surface = title ? host.TitleWindow : host.BodyWindow;
                    string textBefore = title ? host.TitleText : host.BodyText;
                    string postingBefore = WindowText(_state.PostingStatus);
                    string actionBefore = WindowText(_state.PostingAction);
                    SetFocus(surface);
                    Message enter = new() { hwnd = surface, message = WM_KEYDOWN, wParam = new IntPtr(VK_RETURN) };
                    ProcessMessage(enter);
                    string textAfter = title ? host.TitleText : host.BodyText;
                    return FocusWithin(surface) && textAfter == textBefore &&
                        WindowText(_state.PostingStatus) == postingBefore &&
                        WindowText(_state.PostingAction) == actionBefore;
                }

                bool patreonForward = Forward(0, patreon: true);
                bool patreonReverse = Reverse(0, patreon: true);
                bool xForward = Forward(1, patreon: false);
                bool xReverse = Reverse(1, patreon: false);
                bool blueskyForward = Forward(2, patreon: false);
                bool blueskyReverse = Reverse(2, patreon: false);
                bool enterSafe = EnterSafe(0, title: true) && EnterSafe(0, title: false) &&
                    EnterSafe(1, title: false) && EnterSafe(2, title: false);

                return new NativeProductionKeyboardProbe(
                    postingReady, patreonForward, patreonReverse, xForward, xReverse,
                    blueskyForward, blueskyReverse, enterSafe,
                    _window != IntPtr.Zero && IsWindow(_window));
            });

        internal NativePostingActionProbe CapturePostingActionForTesting() =>
            RunOnUiThreadForTesting(() => new NativePostingActionProbe(
                _state.PostingAction,
                _state.PostingAction == IntPtr.Zero ? string.Empty : WindowText(_state.PostingAction),
                _state.PostingAction != IntPtr.Zero && IsWindow(_state.PostingAction),
                _state.PostingAction != IntPtr.Zero && IsWindowVisible(_state.PostingAction),
                _state.PostingAction != IntPtr.Zero && IsWindowEnabled(_state.PostingAction),
                _state.PostingAction != IntPtr.Zero && GetFocus() == _state.PostingAction));

        internal void FocusPostingActionByTabForTesting() =>
            RunOnUiThreadForTesting(() =>
            {
                SelectPlatformForKeyboardProbe(0);
                SetFocus(_state.CopyMain);
                MoveFocusByTab(previous: false);
                if (GetFocus() != _state.PostingAction)
                    throw new InvalidOperationException("Tab did not focus the production posting action.");
                return true;
            });

        internal void MoveFocusPastPostingActionByTabForTesting() =>
            RunOnUiThreadForTesting(() =>
            {
                if (GetFocus() != _state.PostingAction)
                    throw new InvalidOperationException("The production posting action did not own focus.");
                MoveFocusByTab(previous: false);
                if (GetFocus() != _state.AssetList)
                    throw new InvalidOperationException("Tab did not move focus beyond the production posting action.");
                return true;
            });

        internal void InvokePostingActionByEnterForTesting() =>
            RunOnUiThreadForTesting(() =>
            {
                if (_state.PostingAction == IntPtr.Zero || !IsWindow(_state.PostingAction))
                    throw new InvalidOperationException("The production posting action does not exist.");
                SetFocus(_state.PostingAction);
                Message enter = new() { hwnd = _state.PostingAction, message = WM_KEYDOWN, wParam = new IntPtr(VK_RETURN) };
                ProcessMessage(enter);
                return true;
            });

        internal void PostEscapeFromBodyForTesting() =>
            RunOnUiThreadForTesting(() =>
            {
                WinUiTextSurfaceHost host = _winUiTextSurfaces ??
                    throw new InvalidOperationException("Production WinUI text surfaces are not running.");
                SetFocus(host.BodyWindow);
                if (!PostMessage(_window, WM_KEYDOWN, new IntPtr(VK_ESCAPE), IntPtr.Zero))
                    throw NativeFailure();
                return true;
            });

        private void SelectPlatformForKeyboardProbe(int platformIndex)
        {
            SendMessage(_state.Platform, CB_SETCURSEL, new IntPtr(platformIndex), IntPtr.Zero);
            HandleCommand(PlatformId, CBN_SELCHANGE, _state.Platform);
        }

        private bool FocusWithin(IntPtr parent)
        {
            IntPtr focus = GetFocus();
            return focus == parent || (focus != IntPtr.Zero && IsChild(parent, focus));
        }

        internal void AttachNotificationHarness(IntPtr parentWindow, IntPtr assetList,
            IntPtr assetCount = default, IntPtr dragGuidance = default)
        {
            _window = parentWindow;
            _state.Window = parentWindow;
            _state.AssetList = assetList;
            _state.AssetHeader = IntPtr.Zero;
            _state.AssetCount = assetCount;
            _state.DragGuidance = dragGuidance;
            AttachAssetHeaderNotifications();
        }

        internal IntPtr HandleNotifyForTesting(IntPtr pointer) => HandleNotify(pointer);
        internal IntPtr AssetHeaderHandleForTesting => ResolveAssetHeader();
        internal IntPtr AssetListHandleForTesting => _state.AssetList;

        internal void ObserveNextListViewBeginDragForTesting(Action<NativeListViewBeginDragProbe> observer) =>
            RunOnUiThreadForTesting(() =>
            {
                _listViewBeginDragObserver = observer ?? throw new ArgumentNullException(nameof(observer));
                return true;
            });

        internal IReadOnlyList<NativeHeaderDrawStageProbe> PaintHeaderForTesting(NativeCompanionPalette palette) =>
            RunOnUiThreadForTesting(() =>
            {
                ApplyThemeForTesting(palette, DpiForWindow(_window));
                var draws = new List<NativeHeaderDrawStageProbe>();
                _headerDrawObserver = (stage, result) => draws.Add(new(stage, result));
                try
                {
                    IntPtr header = ResolveAssetHeader();
                    if (header == IntPtr.Zero) throw NativeFailure();
                    InvalidateRect(header, IntPtr.Zero, true);
                    UpdateWindow(header);
                    return (IReadOnlyList<NativeHeaderDrawStageProbe>)draws.ToArray();
                }
                finally { _headerDrawObserver = null; }
            });

        internal NativeHeaderPostpaintProbe PaintHeaderPostpaintForTesting(NativeCompanionPalette palette) =>
            RunOnUiThreadForTesting(() =>
            {
                ApplyThemeForTesting(palette, DpiForWindow(_window));
                NativeHeaderPostpaintProbe? probe = null;
                _headerPostpaintObserver = value => probe = value;
                try
                {
                    IntPtr header = ResolveAssetHeader();
                    if (header == IntPtr.Zero) throw NativeFailure();
                    InvalidateRect(header, IntPtr.Zero, true);
                    UpdateWindow(header);
                    return probe ?? throw new InvalidOperationException("Header postpaint did not run.");
                }
                finally { _headerPostpaintObserver = null; }
            });

        internal IReadOnlyList<NativeListViewRowDrawProbe> PaintAssetRowsForTesting(
            NativeCompanionPalette palette, int dpi, bool listHasKeyboardFocus, int focusedItem = 0) =>
            RunOnUiThreadForTesting(() =>
            {
                ApplyThemeForTesting(palette, dpi);
                SetNativeFocusedItem(_state.AssetList, focusedItem);
                SetFocus(listHasKeyboardFocus ? _state.AssetList : _state.Close);
                var draws = new List<NativeListViewRowDrawProbe>();
                _listViewDrawObserver = draws.Add;
                try
                {
                    InvalidateRect(_state.AssetList, IntPtr.Zero, true);
                    UpdateWindow(_state.AssetList);
                    return (IReadOnlyList<NativeListViewRowDrawProbe>)draws.ToArray();
                }
                finally { _listViewDrawObserver = null; }
            });

        internal void ScrollAssetListHorizontallyForTesting(int pixels) =>
            RunOnUiThreadForTesting(() =>
            {
                SendMessage(_state.AssetList, LVM_SCROLL, new IntPtr(pixels), IntPtr.Zero);
                return true;
            });

        internal void ApplyThemeForTesting(
            NativeCompanionPalette palette,
            int dpi,
            Func<IntPtr, string?, string?, int>? setWindowTheme = null)
        {
            NativeCompanionTheme? previous = _theme;
            _theme = setWindowTheme is null
                ? new NativeCompanionTheme(dpi, palette)
                : new NativeCompanionTheme(dpi, palette, setWindowTheme);
            try
            {
                ApplyTheme();
                _winUiTextSurfaces?.SetTheme(ElementThemeFor(palette.Mode));
            }
            finally { previous?.Dispose(); }
        }

        internal IReadOnlyList<IntPtr> ApplyThemeAndCaptureButtonHandlesForTesting(
            NativeCompanionPalette palette) =>
            RunOnUiThreadForTesting(() =>
            {
                ApplyThemeForTesting(palette, DpiForWindow(_window));
                return (IReadOnlyList<IntPtr>)_state.Buttons.ToArray();
            });

        internal NativeProductionThemeProbe ApplyThemeAndCapturePresentationForTesting(
            NativeCompanionPalette palette, int dpi) =>
            RunOnUiThreadForTesting(() =>
            {
                ApplyThemeForTesting(palette, dpi);
                NativeProductionControlPresentationProbe Control(
                    string name, IntPtr handle, NativeCompanionFontRole fontRole)
                {
                    NativeCompanionTextStyle style = StaticTextStyle(handle, palette);
                    IntPtr font = SendMessage(handle, WM_GETFONT, IntPtr.Zero, IntPtr.Zero);
                    var native = new LogFont();
                    if (font == IntPtr.Zero || GetObject(font, Marshal.SizeOf<LogFont>(), ref native) == 0)
                        throw NativeFailure();
                    return new(name, handle, fontRole, native.lfFaceName ?? string.Empty,
                        native.lfHeight, native.lfWeight, style.Background, style.Text);
                }

                return new NativeProductionThemeProbe(
                    palette.Mode, _theme?.Dpi ?? dpi,
                    _window, _state.Platform, _state.AssetList, ResolveAssetHeader(),
                    _winUiTextSurfaces?.TitleWindow ?? IntPtr.Zero,
                    _winUiTextSurfaces?.BodyWindow ?? IntPtr.Zero,
                    NativeCompanionTheme.SurfaceStyle(NativeCompanionSurfaceRole.Window, palette),
                    NativeCompanionTheme.SurfaceStyle(NativeCompanionSurfaceRole.Section, palette),
                    NativeCompanionTheme.SurfaceStyle(NativeCompanionSurfaceRole.SectionHeader, palette),
                    NativeCompanionTheme.SurfaceStyle(NativeCompanionSurfaceRole.Nested, palette),
                    NativeCompanionTheme.SurfaceStyle(NativeCompanionSurfaceRole.Footer, palette),
                    unchecked((int)SendMessage(_state.AssetList, LVM_GETBKCOLOR, IntPtr.Zero, IntPtr.Zero).ToInt64()),
                    [
                        Control("release-title", _state.Header, NativeCompanionFontRole.ReleaseHeading),
                        Control("release-metadata", _state.HeaderMetadata, NativeCompanionFontRole.Supporting),
                        Control("content-heading", _state.PlatformHeading, NativeCompanionFontRole.SectionHeading),
                        Control("field-label", _state.BodyLabel, NativeCompanionFontRole.Body),
                        Control("posting-status", _state.PostingStatus, NativeCompanionFontRole.Body),
                        Control("posting-helper", _state.PostingHelper, NativeCompanionFontRole.Supporting),
                        Control("assets-heading", _state.AssetLabel, NativeCompanionFontRole.SectionHeading),
                        Control("selected-count", _state.AssetCount, NativeCompanionFontRole.Supporting),
                        Control("drag-guidance", _state.DragGuidance, NativeCompanionFontRole.Supporting),
                        Control("footer-aggregate", _state.PostingAggregate, NativeCompanionFontRole.Supporting),
                    ]);
            });

        internal void DisposeThemeForTesting()
        {
            _theme?.Dispose();
            _theme = null;
            DetachAssetHeaderNotifications();
        }

        internal void RestorePlatformSelectionForTesting()
        {
            _suppressAssetNotifications = true;
            try
            {
                PopulateAssetRows(_state.AssetList, _state.Model.AssetRows);
                ApplySelectionCore();
            }
            finally { _suppressAssetNotifications = false; }
            UpdateSelectedCount();
        }

        internal void StartPreviewsForTesting(int dpi)
        {
            RebuildPreviewImageList(dpi);
            _suppressAssetNotifications = true;
            try
            {
                PopulateAssetRowsWithPlaceholders();
                ApplySelectionCore();
            }
            finally { _suppressAssetNotifications = false; }
            UpdateSelectedCount();
            ScheduleCurrentPlatformPreviews();
        }

        internal void HandlePreviewReadyForTesting() => DrainPreviewResults();

        internal async ValueTask StopPreviewsForTesting()
        {
            Interlocked.Exchange(ref _previewClosing, 1);
            _previews?.BeginClose();
            if (_previews is not null)
            {
                await _previews.DisposeAsync().ConfigureAwait(false);
                _previews = null;
            }
            else _previewAccess?.Dispose();
        }

        public void Run(NativePresentationResult result)
        {
            bool messageLoopStarted = false;
            try
            {
                _uiThreadId = GetCurrentThreadId();
                _drag.AttachNativeThread();
                _ole = OleThreadLifetime.Initialize();
                IntPtr instance = GetModuleHandle(null);
                result.Stage = NativePresentationStage.register_window_class;
                if (RegisterClassOnce(instance) == 0) throw NativeFailure();
                _state.Handle = GCHandle.Alloc(_state);
                int dpi = SystemDpi();
                _theme = _winUiProofOptions?.InitialNativePalette is { } initialPalette
                    ? new NativeCompanionTheme(dpi, initialPalette)
                    : new NativeCompanionTheme(dpi);
                result.Stage = NativePresentationStage.create_main_window;
                NativeLayoutSize initialOuter = OuterSizeForLogicalClient(980, 920, dpi);
                _window = CreateWindowEx(ProductionWindowExtendedStyle, ClassName, WindowTitle, ProductionWindowStyle,
                    100, 80, initialOuter.Width, initialOuter.Height, IntPtr.Zero, IntPtr.Zero, instance, GCHandle.ToIntPtr(_state.Handle));
                if (_window == IntPtr.Zero) throw NativeFailure();
                _state.Window = _window;
                _theme.ApplyTitleBar(_window);
                result.WindowCreated = true;
                _winUiProofOptions?.MainWindowCreated?.Invoke(_window);
                if (Volatile.Read(ref _closeRequested) != 0)
                {
                    BeginClose();
                    throw new OperationCanceledException("Native companion was closed before it became ready.");
                }
                CreateControls(instance);
                _winUiProofOptions?.NativeControlsCreated?.Invoke(
                    _state.RequiredControls.Concat(_state.PostingControls).Where(handle => handle != IntPtr.Zero).ToArray());
                if (!_disableWinUiForNativeOnlyTests)
                    _winUiTextSurfaces = new WinUiTextSurfaceHost(
                        _window,
                        TakeFocusFromWinUi,
                        _winUiProofOptions?.Theme ?? ElementThemeFor(_theme.Palette.Mode),
                        _winUiProofOptions?.FailAfterSurfaceCount ?? 0,
                        _winUiProofOptions?.SurfaceCreated);
                ApplyTheme();
                PopulatePlatforms();
                RefreshPlatform();
                if (!_ole.Available)
                    SetStatus(_ole.Result == OleThreadLifetime.RpcEChangedMode
                        ? "File dragging is unavailable because OLE could not use this UI thread."
                        : $"File dragging is unavailable (0x{_ole.Result:X8}).", StatusKind.Error);
                Layout();
                result.Stage = NativePresentationStage.show_window;
                ShowWindow(_window, SW_SHOW);
                UpdateWindow(_window);
                SetForegroundWindow(_window);
                if (_winUiTextSurfaces is not null && _winUiProofOptions?.WindowShown is not null)
                    _winUiTextSurfaces.QueueAfterRender(() =>
                    {
                        if (_winUiProofOptions.ThemeAfterFirstRender is { } theme)
                            _winUiTextSurfaces.SetTheme(theme);
                        if (_winUiProofOptions.SelectBodyTextAfterRender)
                            _winUiTextSurfaces.SelectBodyTextForVisualEvidence();
                        _winUiTextSurfaces.QueueAfterRender(() => _winUiProofOptions.WindowShown(_window));
                    });
                result.Stage = NativePresentationStage.visibility_check;
                if (!IsWindowVisible(_window)) throw new InvalidOperationException("Native companion did not become visible.");
                result.WindowVisible = true;
                result.Stage = NativePresentationStage.message_loop;
                PostReadyProbe(
                    () => PostMessage(_window, ReadyProbeMessage, IntPtr.Zero, IntPtr.Zero),
                    _lifecycle, NativeFailure);
                messageLoopStarted = true;
                RunMessageLoop();
                if (_state.Handle.IsAllocated) _state.Handle.Free();
                _window = IntPtr.Zero;
                result.NormalDismissal = true;
                result.State = NativePresentationState.PresentedAndDismissed;
                result.Stage = NativePresentationStage.completed;
            }
            catch (Exception exception)
            {
                _lifecycle.Fail(exception);
                if (!messageLoopStarted)
                {
                    try { CleanupOwnedWindowBeforeMessageLoop(); }
                    catch (Exception cleanupException)
                    {
                        throw new AggregateException(
                            "Native companion initialization and owned-window cleanup both failed.",
                            exception, cleanupException);
                    }
                }
                throw;
            }
            finally
            {
                _platformPopupDiscoveryObserver = null;
                DisposeWinUiTextSurfaces();
                _ole?.Dispose();
                _ole = null;
                DetachAssetHeaderNotifications();
                _theme?.Dispose();
                _theme = null;
            }
        }

        private void CleanupOwnedWindowBeforeMessageLoop()
        {
            Exception? cleanupFailure = null;
            try { BeginClose(); }
            catch (Exception exception) { cleanupFailure = exception; }
            try { DisposeWinUiTextSurfaces(); }
            catch (Exception exception) { cleanupFailure ??= exception; }

            IntPtr window = _window;
            if (window != IntPtr.Zero && IsWindow(window))
            {
                try
                {
                    if (!DestroyWindow(window)) cleanupFailure ??= NativeFailure();
                }
                catch (Exception exception) { cleanupFailure ??= exception; }
            }

            if (window == IntPtr.Zero || !IsWindow(window))
            {
                if (_state.Handle.IsAllocated) _state.Handle.Free();
                _window = IntPtr.Zero;
            }

            if (cleanupFailure is not null)
                throw new InvalidOperationException("Native companion initialization cleanup failed.", cleanupFailure);
        }

        public void RequestClose()
        {
            Interlocked.Exchange(ref _closeRequested, 1);
            BeginClose();
            IntPtr window = _window;
            if (window != IntPtr.Zero) PostMessage(window, WM_CLOSE, IntPtr.Zero, IntPtr.Zero);
        }

        public void Release()
        {
            if (_state.Handle.IsAllocated) _state.Handle.Free();
            _window = IntPtr.Zero;
        }

        public Task StopPendingAsync() => _drag.StopPendingAsync();

        public async Task ShutdownAsync(IDisposable mediaLease)
        {
            _previews?.BeginClose();
            if (_previews is not null)
            {
                await _previews.DisposeAsync().ConfigureAwait(false);
                _previews = null;
            }
            else _previewAccess?.Dispose();
            IntPtr imageList = Interlocked.Exchange(ref _imageList, IntPtr.Zero);
            NativeImageListStorage.Destroy(imageList);
            await _drag.ShutdownAsync(Release, mediaLease).ConfigureAwait(false);
        }

        private void CreateControls(IntPtr instance)
        {
            var commonControls = new InitCommonControls
            {
                dwSize = (uint)Marshal.SizeOf<InitCommonControls>(),
                dwICC = 0x00000001, // ICC_LISTVIEW_CLASSES
            };
            if (!InitCommonControlsEx(ref commonControls)) throw NativeFailure();
            _state.Header = Child("Static", _state.Model.Session.ReleaseTitle, 0, 0, instance);
            _state.HeaderMetadata = Child("Static", HeaderMetadataText(), 0, 0, instance);
            _state.PlatformHeading = Child("Static", "CONTENT", 0, 0, instance);
            _state.PlatformLabel = Child("Static", "Platform:", 0, 0, instance);
            _state.Platform = Child("ComboBox", string.Empty,
                WS_TABSTOP | CBS_DROPDOWNLIST | CBS_OWNERDRAWFIXED | CBS_HASSTRINGS | WS_VSCROLL,
                PlatformId, instance);
            _state.TitleLabel = Child("Static", "Title:", 0, 0, instance);
            _state.CopyTitle = Child("Button", "Copy title", WS_TABSTOP | BS_OWNERDRAW, CopyTitleId, instance);
            _state.BodyLabel = Child("Static", "Body:", 0, 0, instance);
            _state.CopyMain = Child("Button", "Copy body", WS_TABSTOP | BS_OWNERDRAW, CopyMainId, instance);
            if (_confirmation is not null)
            {
                _state.PostingStatus = Child("Static", string.Empty, 0, 0, instance);
                _state.PostingHelper = Child("Static", string.Empty, 0, 0, instance);
                _state.PostingAction = Child("Button", "Mark as posted", WS_TABSTOP | BS_OWNERDRAW, PostingConfirmationId, instance);
                _state.PostingAggregate = Child("Static", string.Empty, 0, 0, instance);
            }
            _state.AssetLabel = Child("Static", "Assets", 0, 0, instance);
            _state.AssetCount = Child("Static", string.Empty, 0x00000002, 0, instance); // SS_RIGHT
            _state.DragGuidance = Child("Static", string.Empty, 0, 0, instance);
            _state.AssetList = Child("SysListView32", string.Empty, AssetListStyle, AssetListId, instance);
            _state.Status = Child("Static", string.Empty, 0, 0, instance);
            _state.Close = Child("Button", "Close", WS_TABSTOP | BS_OWNERDRAW, CloseId, instance);
            if (_state.RequiredControls.Any(control => control == IntPtr.Zero) ||
                (_confirmation is not null && _state.PostingControls.Any(control => control == IntPtr.Zero)))
                throw NativeFailure();
            foreach (IntPtr button in _state.Buttons)
                if (!SetWindowSubclass(button, ButtonProcedure, UIntPtr.Zero, IntPtr.Zero))
                    throw NativeFailure();
            if (!SetWindowSubclass(_state.Platform, PlatformComboProcedure, UIntPtr.Zero, IntPtr.Zero))
                throw NativeFailure();
            ConfigureAssetList(_state.AssetList, _theme?.Dpi ?? SystemDpi());
            if (ResolveAssetHeader() == IntPtr.Zero) throw NativeFailure();
            AttachAssetHeaderNotifications();
            RebuildPreviewImageList(_theme?.Dpi ?? SystemDpi());
        }

        private IntPtr Child(string className, string text, uint style, int id, IntPtr instance) =>
            CreateWindowEx(0, className, text, WS_CHILD | WS_VISIBLE | style, 0, 0, 0, 0, _window, new IntPtr(id), instance, IntPtr.Zero);

        private string HeaderMetadataText() => _winUiProofOptions?.HeaderMetadata ??
            $"Release ID: {_state.Model.Session.ReleaseId}   •   Server: {_state.Model.Session.ServerOrigin.GetLeftPart(UriPartial.Authority)}";

        private void PopulatePlatforms()
        {
            foreach (ManualPreparedPlatform platform in _state.Model.Session.Platforms)
            {
                string label = platform.Platform.ToLowerInvariant() switch { "x" => "X", "bluesky" => "Bluesky", "patreon" => "Patreon", _ => platform.Platform };
                SendString(_state.Platform, CB_ADDSTRING, label);
            }
            SendMessage(_state.Platform, CB_SETCURSEL, IntPtr.Zero, IntPtr.Zero);
        }

        private void RefreshPlatform()
        {
            ManualPreparedPlatform platform = _state.Model.Platform;
            bool patreon = _state.Model.IsPatreon;
            _winUiTextSurfaces?.SetContent(
                platform.Platform,
                NativeTextPresentation.DisplayText(platform.Title),
                NativeTextPresentation.DisplayText(platform.Body));
            SetWindowText(_state.BodyLabel, patreon ? "Body:" : "Post text:");
            SetWindowText(_state.CopyMain, patreon ? "Copy body" : "Copy post text");
            ShowWindow(_state.TitleLabel, patreon ? SW_SHOW : SW_HIDE);
            ShowWindow(_state.CopyTitle, patreon ? SW_SHOW : SW_HIDE);
            RebuildPreviewImageList(_theme?.Dpi ?? DpiForWindow(_window));
            _suppressAssetNotifications = true;
            try
            {
                PopulateAssetRowsWithPlaceholders();
                ApplySelectionCore();
            }
            finally { _suppressAssetNotifications = false; }
            UpdateSelectedCount();
            SetStatus(string.Empty, StatusKind.Neutral);
            RefreshPostingConfirmation();
            Layout();
            ScheduleCurrentPlatformPreviews();
        }

        private void ApplySelectionCore()
        {
            HashSet<int> selected = _state.Model.SelectedOrdinals.ToHashSet();
            SetNativeSelection(_state.AssetList, selected, _state.Model.Platform.Assets.Count);
        }

        private void CaptureSelection()
        {
            IReadOnlyList<int> native = SelectedOrdinals(_state.AssetList);
            _state.Model.SetNativeSelectedOrdinals(native);
            UpdateSelectedCount();
        }

        private void UpdateSelectedCount()
        {
            IReadOnlyList<int> ordinals = SelectedOrdinals(_state.AssetList);
            int selected = checked((int)SendMessage(_state.AssetList, LVM_GETSELECTEDCOUNT, IntPtr.Zero, IntPtr.Zero).ToInt64());
            int rows = checked((int)SendMessage(_state.AssetList, LVM_GETITEMCOUNT, IntPtr.Zero, IntPtr.Zero).ToInt64());
            if (_state.AssetCount != IntPtr.Zero) SetWindowText(_state.AssetCount, $"{selected} of {rows} selected");
            if (_state.DragGuidance != IntPtr.Zero)
            {
                string guidance = selected == 0 ? "Select files to attach." :
                    ordinals.Any(ordinal => ordinal >= 0 && ordinal < _state.Model.Platform.Assets.Count &&
                        !ManualPublishingCompanionModel.IsAvailable(_state.Model.Platform.Assets[ordinal]))
                        ? "Selection includes unavailable files and cannot be dragged."
                        : "Drag any selected file to attach all selected files.";
                SetWindowText(_state.DragGuidance, guidance);
            }
        }

        internal static IReadOnlyList<ManualAssetListColumn> AssetColumns(int clientWidth, int dpi)
        {
            int ScaleColumn(int width) => width * Math.Max(96, dpi) / 96;
            int fileMinimum = ScaleColumn(220);
            int filePreferred = ScaleColumn(360);
            int role = ScaleColumn(88);
            int size = ScaleColumn(112);
            int status = ScaleColumn(104);
            int pathMinimum = ScaleColumn(180);
            int pathMaximum = ScaleColumn(280);
            int minimumTotal = fileMinimum + role + size + status + pathMinimum;
            int remaining = Math.Max(0, clientWidth - minimumTotal);

            int file = fileMinimum + Math.Min(remaining, filePreferred - fileMinimum);
            remaining -= file - fileMinimum;
            int path = pathMinimum + Math.Min(remaining, pathMaximum - pathMinimum);
            remaining -= path - pathMinimum;
            file += remaining;

            return
            [
                new("File", file),
                new("Role", role),
                new("Size", size),
                new("Status", status),
                new("Path / staged name", path),
            ];
        }

        internal static void ConfigureAssetList(IntPtr listView, int dpi)
        {
            SendMessage(listView, LVM_SETEXTENDEDLISTVIEWSTYLE,
                new IntPtr(AssetListExtendedStyle), new IntPtr(AssetListExtendedStyle));
            int index = 0;
            foreach (ManualAssetListColumn column in AssetColumns(0, dpi))
            {
                var native = new ListViewColumn
                {
                    mask = LvcfFmt | LvcfWidth | LvcfText,
                    fmt = 0,
                    cx = column.LogicalWidth,
                    pszText = column.Title,
                };
                if (SendMessageListViewColumn(listView, LVM_INSERTCOLUMN, new IntPtr(index), ref native).ToInt64() < 0)
                    throw NativeFailure();
                index++;
            }
        }

        internal static void PopulateAssetRows(IntPtr listView, IEnumerable<ManualAssetListRow> rows)
        {
            SendMessage(listView, LVM_DELETEALLITEMS, IntPtr.Zero, IntPtr.Zero);
            foreach (ManualAssetListRow row in rows) InsertAssetRow(listView, row);
        }

        internal static void PopulateAssetRows(
            IntPtr listView, IEnumerable<ManualAssetListRow> rows, Func<ManualAssetListRow, int> imageIndex)
        {
            SendMessage(listView, LVM_DELETEALLITEMS, IntPtr.Zero, IntPtr.Zero);
            foreach (ManualAssetListRow row in rows) InsertAssetRow(listView, row, imageIndex(row));
        }

        private void PopulateAssetRowsWithPlaceholders()
        {
            SendMessage(_state.AssetList, LVM_DELETEALLITEMS, IntPtr.Zero, IntPtr.Zero);
            foreach (ManualAssetListRow row in _state.Model.AssetRows)
                InsertAssetRow(_state.AssetList, row,
                    row.IsAvailable ? _pendingImageIndex : _unavailableImageIndex);
        }

        private static void InsertAssetRow(IntPtr listView, ManualAssetListRow row, int imageIndex = -1)
        {
            var item = new ListViewItem
            {
                mask = LvifText | LvifParam | (imageIndex >= 0 ? LvifImage : 0),
                iItem = row.Ordinal,
                iSubItem = 0,
                pszText = row.File,
                iImage = imageIndex,
                lParam = new IntPtr(row.Ordinal),
            };
            int itemIndex = checked((int)SendMessageListViewItem(
                listView, LVM_INSERTITEM, IntPtr.Zero, ref item).ToInt64());
            if (itemIndex < 0) throw NativeFailure();
            SetAssetSubItem(listView, itemIndex, 1, row.Role);
            SetAssetSubItem(listView, itemIndex, 2, row.Size);
            SetAssetSubItem(listView, itemIndex, 3, row.Status);
            SetAssetSubItem(listView, itemIndex, 4, row.PathOrStagedName);
        }

        private static void SetAssetSubItem(IntPtr listView, int itemIndex, int subItem, string text)
        {
            var item = new ListViewItem { iSubItem = subItem, pszText = text };
            SendMessageListViewItem(listView, LVM_SETITEMTEXT, new IntPtr(itemIndex), ref item);
        }

        internal static void SetNativeSelection(IntPtr listView, IReadOnlySet<int> ordinals, int itemCount)
        {
            for (int itemIndex = 0; itemIndex < itemCount; itemIndex++)
            {
                int? ordinal = ItemOrdinal(listView, itemIndex);
                var item = new ListViewItem
                {
                    stateMask = LvisSelected,
                    state = ordinal is not null && ordinals.Contains(ordinal.Value) ? LvisSelected : 0,
                };
                SendMessageListViewItem(listView, LVM_SETITEMSTATE, new IntPtr(itemIndex), ref item);
            }
        }

        private static void SetNativeFocusedItem(IntPtr listView, int focusedItem)
        {
            int itemCount = checked((int)SendMessage(listView, LVM_GETITEMCOUNT, IntPtr.Zero, IntPtr.Zero).ToInt64());
            for (int itemIndex = 0; itemIndex < itemCount; itemIndex++)
            {
                var item = new ListViewItem
                {
                    stateMask = LvisFocused,
                    state = itemIndex == focusedItem ? LvisFocused : 0,
                };
                SendMessageListViewItem(listView, LVM_SETITEMSTATE, new IntPtr(itemIndex), ref item);
            }
        }

        private static uint NativeItemState(IntPtr listView, int itemIndex, uint mask) =>
            unchecked((uint)SendMessage(listView, LVM_GETITEMSTATE, new IntPtr(itemIndex), new IntPtr(mask)).ToInt64());

        internal static IReadOnlyList<int> SelectedOrdinals(IntPtr listView)
        {
            var selected = new List<int>();
            foreach (int itemIndex in SelectedItemIndices(listView))
                if (ItemOrdinal(listView, itemIndex) is int ordinal) selected.Add(ordinal);
            selected.Sort();
            return selected;
        }

        internal static IReadOnlyList<int> SelectedItemIndices(IntPtr listView)
        {
            var selected = new List<int>();
            int itemIndex = -1;
            while (true)
            {
                itemIndex = checked((int)SendMessage(listView, LVM_GETNEXTITEM, new IntPtr(itemIndex), new IntPtr(LvniSelected)).ToInt64());
                if (itemIndex < 0) break;
                selected.Add(itemIndex);
            }
            return selected;
        }

        internal static int? ItemOrdinal(IntPtr listView, int itemIndex)
        {
            var item = new ListViewItem { mask = LvifParam, iItem = itemIndex };
            return SendMessageListViewItem(listView, LVM_GETITEM, IntPtr.Zero, ref item) != IntPtr.Zero
                ? checked((int)item.lParam.ToInt64())
                : null;
        }


        internal static int? ItemImage(IntPtr listView, int itemIndex)
        {
            var item = new ListViewItem { mask = LvifImage, iItem = itemIndex };
            return SendMessageListViewItem(listView, LVM_GETITEM, IntPtr.Zero, ref item) != IntPtr.Zero
                ? item.iImage
                : null;
        }

        private void BeginListViewDrag(int itemIndex)
        {
            if (itemIndex < 0 || ItemOrdinal(_state.AssetList, itemIndex) is not int originOrdinal) return;
            IReadOnlyList<int> selected = SelectedOrdinals(_state.AssetList);
            if (!TryCreateDragSnapshot(_state.Model, originOrdinal, selected, out IReadOnlyList<ManualDragAsset> snapshot))
            {
                UpdateSelectedCount();
                if (selected.Any(ordinal => ordinal >= 0 && ordinal < _state.Model.Platform.Assets.Count &&
                    !ManualPublishingCompanionModel.IsAvailable(_state.Model.Platform.Assets[ordinal])))
                    SetStatus("Selected files include unavailable media.", StatusKind.Error);
                return;
            }
            UpdateSelectedCount();
            BeginDragPreparation(snapshot);
        }

        internal static bool TryCreateDragSnapshot(
            ManualPublishingCompanionModel model,
            int? originOrdinal,
            IEnumerable<int> selectedOrdinals,
            out IReadOnlyList<ManualDragAsset> snapshot)
        {
            ArgumentNullException.ThrowIfNull(model);
            ArgumentNullException.ThrowIfNull(selectedOrdinals);
            int[] selected = selectedOrdinals.Distinct().OrderBy(ordinal => ordinal).ToArray();
            model.SetNativeSelectedOrdinals(selected);
            bool validOrigin = originOrdinal is int origin && origin >= 0 && origin < model.Platform.Assets.Count &&
                selected.Contains(origin);
            bool allEligible = selected.All(ordinal => ordinal >= 0 && ordinal < model.Platform.Assets.Count &&
                ManualPublishingCompanionModel.IsAvailable(model.Platform.Assets[ordinal]));
            if (!validOrigin || !allEligible || selected.Length == 0)
            {
                snapshot = Array.Empty<ManualDragAsset>();
                return false;
            }
            snapshot = model.SnapshotSelectedAssets();
            return true;
        }

        private void BeginDragPreparation(IReadOnlyList<ManualDragAsset> selected)
        {
            if (!_dragSessionAvailable())
            {
                SetStatus("File dragging is unavailable in this companion session.", StatusKind.Error);
                return;
            }
            _tryBeginDrag(selected);
        }

        private void CompleteDragPreparation() => _drag.CompleteOnNativeThread();

        private void Copy(ManualCopyCommand command)
        {
            bool copied = _state.Model.TryCopy(command, _clipboardFactory(_window));
            SetStatus(copied ? "Copied to clipboard." : "Unable to copy. Try again.", copied ? StatusKind.Success : StatusKind.Error);
        }

        private void SetStatus(string message, StatusKind kind)
        {
            StatusText = message;
            _statusKind = kind;
            if (_state.Status != IntPtr.Zero)
            {
                SetWindowText(_state.Status, message);
                InvalidateRect(_state.Status, IntPtr.Zero, true);
            }
            Layout();
        }

        private void RefreshPostingConfirmation()
        {
            if (_confirmation is null || _state.PostingStatus == IntPtr.Zero) return;
            ManualPostingPlatformState state = _confirmation.GetState(_state.Model.Platform.Platform);
            ManualPostingConfirmationPresentation presentation = ManualPostingConfirmationPresentationMapper.Map(
                state, _confirmation.Completion, _state.Model.PlatformLabel);
            SetWindowText(_state.PostingStatus, presentation.StatusText);
            SetWindowText(_state.PostingHelper, presentation.HelperText);
            SetWindowText(_state.PostingAction, presentation.ActionText);
            SetWindowText(_state.PostingAggregate, presentation.AggregateText);
            _postingStatusKind = state.Status switch
            {
                ManualPostingConfirmationStatus.Posted => StatusKind.Success,
                ManualPostingConfirmationStatus.ConfirmationUnknown => StatusKind.Error,
                ManualPostingConfirmationStatus.Ready when !string.IsNullOrWhiteSpace(state.Reason) => StatusKind.Error,
                _ => StatusKind.Neutral,
            };
            _aggregateComplete = _confirmation.Completion?.IsComplete == true;
            ShowWindow(_state.PostingAction, presentation.ShowAction ? SW_SHOW : SW_HIDE);
            EnableWindow(_state.PostingAction, presentation.ActionEnabled);
            foreach (IntPtr control in new[]
                     { _state.PostingStatus, _state.PostingHelper, _state.PostingAction, _state.PostingAggregate })
                InvalidateRect(control, IntPtr.Zero, true);
            Layout();
            PostingPresentationChanged?.Invoke();
        }

        private void BeginPostingConfirmation()
        {
            if (_confirmation is null || Volatile.Read(ref _confirmationClosing) != 0) return;
            string platform = _state.Model.Platform.Platform;
            ManualPostingConfirmationPresentation presentation = ManualPostingConfirmationPresentationMapper.Map(
                _confirmation.GetState(platform), _confirmation.Completion, _state.Model.PlatformLabel);
            if (!presentation.ActionEnabled) return;

            Task<ManualPostingPlatformState> operation;
            try { operation = _confirmation.ConfirmAsync(platform); }
            catch (ObjectDisposedException) { return; }
            RefreshPostingConfirmation();
            _ = NotifyPostingConfirmationCompletedAsync(operation);
        }

        private async Task NotifyPostingConfirmationCompletedAsync(Task<ManualPostingPlatformState> operation)
        {
            try { await operation.ConfigureAwait(false); }
            catch { }
            PostPostingConfirmationCompletion();
        }

        private void PostPostingConfirmationCompletion()
        {
            if (Volatile.Read(ref _confirmationClosing) != 0) return;
            IntPtr window = _window;
            if (window != IntPtr.Zero)
                PostMessage(window, PostingConfirmationCompletedMessage, IntPtr.Zero, IntPtr.Zero);
        }

        private void HandleCommand(int id, int notification, IntPtr control)
        {
            if (id == PlatformId && control != _state.Platform) return;
            if (id == PlatformId && notification is CBN_DROPDOWN or CBN_CLOSEUP)
            {
                if (notification == CBN_DROPDOWN) ApplyCurrentPlatformPopupTheme();
                InvalidateRect(_state.Platform, IntPtr.Zero, false);
            }
            else if (id == PlatformId && notification == CBN_SELCHANGE)
            {
                int index = unchecked((int)SendMessage(_state.Platform, CB_GETCURSEL, IntPtr.Zero, IntPtr.Zero).ToInt64());
                if (index >= 0)
                {
                    _state.Model.SelectPlatform(index);
                    RefreshPlatform();
                    InvalidateRect(_state.Platform, IntPtr.Zero, false);
                }
            }
            else if (CopyCommandForControl(id, _state.Model.IsPatreon) is ManualCopyCommand command) Copy(command);
            else if (IsPostingConfirmationCommand(id)) BeginPostingConfirmation();
            else if (id == CloseId) { BeginClose(); DisposeWinUiTextSurfaces(); DestroyWindow(_window); }
        }

        private void BeginClose()
        {
            _listViewBeginDragObserver = null;
            Interlocked.Exchange(ref _confirmationClosing, 1);
            Interlocked.Exchange(ref _previewClosing, 1);
            Interlocked.Increment(ref _previewGeneration);
            _previews?.BeginClose();
            _drag.BeginClose();
            _lifecycle.BeginClosing();
        }

        internal static ManualCopyCommand? CopyCommandForControl(int controlId, bool isPatreon) => controlId switch
        {
            CopyTitleId when isPatreon => ManualCopyCommand.Title,
            CopyMainId when isPatreon => ManualCopyCommand.Body,
            CopyMainId => ManualCopyCommand.Post,
            _ => null,
        };

        internal static bool IsPostingConfirmationCommand(int controlId) => controlId == PostingConfirmationId;

        private void RunMessageLoop()
        {
            PumpMessages(() =>
            {
                int status = GetMessage(out Message message, IntPtr.Zero, 0, 0);
                return (status, message);
            }, ProcessMessage, NativeFailure, _lifecycle);
        }

        internal static void PumpMessages(
            Func<(int Status, Message Message)> readMessage,
            Action<Message> processMessage,
            Func<Exception> nativeFailure,
            ManualCompanionLifecycle lifecycle)
        {
            while (true)
            {
                (int status, Message message) = readMessage();
                if (status < 0)
                {
                    Exception failure = nativeFailure();
                    lifecycle.Fail(failure);
                    throw failure;
                }
                if (status == 0) { lifecycle.BeginClosing(); return; }
                try { processMessage(message); }
                catch (Exception exception) { lifecycle.Fail(exception); throw; }
            }
        }

        internal static void PostReadyProbe(
            Func<bool> postMessage, ManualCompanionLifecycle lifecycle, Func<Exception> nativeFailure)
        {
            if (postMessage()) return;
            Exception failure = nativeFailure();
            lifecycle.Fail(failure);
            throw failure;
        }

        private void ProcessMessage(Message message)
        {
            if (_winUiTextSurfaces?.PreTranslateMessage(ref message) == true) return;
            if (message.message == WM_KEYDOWN && (int)message.wParam == VK_ESCAPE) { BeginClose(); DisposeWinUiTextSurfaces(); DestroyWindow(_window); return; }
            if (message.message == WM_KEYDOWN && (int)message.wParam == VK_TAB)
            {
                MoveFocusByTab(IsShiftPressed());
                return;
            }
            if (message.message == WM_KEYDOWN && (int)message.wParam == VK_RETURN)
            {
                IntPtr focus = GetFocus();
                int id = GetDlgCtrlID(focus);
                if (id is CopyTitleId or CopyMainId or CloseId or PostingConfirmationId)
                    SendMessage(focus, BM_CLICK, IntPtr.Zero, IntPtr.Zero);
                return;
            }
            TranslateMessage(ref message);
            DispatchMessage(ref message);
        }

        private void MoveFocusByTab(bool previous)
        {
            IntPtr focus = GetFocus();
            if (_winUiTextSurfaces?.NavigateFromNative(
                    focus, _state.Platform, _state.CopyTitle, _state.CopyMain, previous) == true)
                return;
            IntPtr next = GetNextDlgTabItem(_window, focus, previous);
            if (next != IntPtr.Zero) SetFocus(next);
        }

        private void TakeFocusFromWinUi(int surfaceIndex, bool previous)
        {
            IntPtr target = surfaceIndex switch
            {
                0 when previous => _state.Platform,
                0 => _state.CopyTitle,
                1 when previous => _winUiTextSurfaces?.TitleVisible == true ? _state.CopyTitle : _state.Platform,
                _ => _state.CopyMain,
            };
            if (target != IntPtr.Zero) SetFocus(target);
        }

        private void DisposeWinUiTextSurfaces()
        {
            WinUiTextSurfaceHost? host = _winUiTextSurfaces;
            _winUiTextSurfaces = null;
            host?.Dispose();
        }

        private static ElementTheme ElementThemeFor(NativeCompanionThemeMode mode) => mode switch
        {
            NativeCompanionThemeMode.Dark => ElementTheme.Dark,
            NativeCompanionThemeMode.Light => ElementTheme.Light,
            _ => ElementTheme.Default,
        };

        private void ApplyTheme()
        {
            if (_theme is null) return;
            ApplyFont(_state.Header, NativeCompanionFontRole.ReleaseHeading);
            ApplyFont(_state.HeaderMetadata, NativeCompanionFontRole.Supporting);
            ApplyFont(_state.PlatformHeading, NativeCompanionFontRole.SectionHeading);
            ApplyFont(_state.AssetLabel, NativeCompanionFontRole.SectionHeading);
            ApplyFont(_state.AssetCount, NativeCompanionFontRole.Supporting);
            ApplyFont(_state.DragGuidance, NativeCompanionFontRole.Supporting);
            ApplyFont(_state.Status, NativeCompanionFontRole.Supporting);
            ApplyFont(_state.PostingStatus, NativeCompanionFontRole.Body);
            ApplyFont(_state.PostingHelper, NativeCompanionFontRole.Supporting);
            ApplyFont(_state.PostingAggregate, NativeCompanionFontRole.Supporting);
            foreach (IntPtr control in new[] { _state.PlatformLabel, _state.Platform, _state.TitleLabel,
                         _state.CopyTitle, _state.BodyLabel, _state.CopyMain, _state.AssetList,
                         _state.PostingAction, _state.Close })
                ApplyFont(control, NativeCompanionFontRole.Body);
            _theme.ApplyControlChrome(_state.Platform, NativeCompanionChromeRole.Combo);
            ApplyPlatformListItemHeight();
            ApplyCurrentPlatformPopupTheme();
            _theme.ApplyControlChrome(_state.AssetList, NativeCompanionChromeRole.ListView);
            IntPtr header = ResolveAssetHeader();
            _theme.ApplyControlChrome(header, NativeCompanionChromeRole.ListViewHeader);
            ApplyFont(header, NativeCompanionFontRole.Supporting);
            ApplyListViewPalette();
            _theme.ApplyTitleBar(_window);
            InvalidateRect(_window, IntPtr.Zero, true);
            foreach (IntPtr control in _state.Controls) InvalidateRect(control, IntPtr.Zero, true);
            if (header != IntPtr.Zero) InvalidateRect(header, IntPtr.Zero, true);
        }

        private void ApplyPlatformListItemHeight()
        {
            if (_theme is null || _state.Platform == IntPtr.Zero || !IsWindow(_state.Platform)) return;
            SendMessage(_state.Platform, CB_SETITEMHEIGHT, IntPtr.Zero,
                new IntPtr(NativeCompanionTheme.ComboItemHeight(_theme.Dpi)));
        }

        private IntPtr ApplyCurrentPlatformPopupTheme()
        {
            if (_theme is null || _state.Platform == IntPtr.Zero || !IsWindow(_state.Platform))
                return IntPtr.Zero;
            ComboBoxInfo comboInfo = new() { cbSize = (uint)Marshal.SizeOf<ComboBoxInfo>() };
            if (!GetComboBoxInfo(_state.Platform, ref comboInfo)) return IntPtr.Zero;
            IntPtr popup = comboInfo.hwndList;
            if (popup == IntPtr.Zero || !IsWindow(popup) || WindowClassName(popup) != "ComboLBox")
                return IntPtr.Zero;
            bool themeApplied = _theme.ApplyControlChrome(popup, NativeCompanionChromeRole.ListView);
            _platformPopupDiscoveryObserver?.Invoke(new NativePlatformPopupDiscoveryObservation(
                _state.Platform, popup, _theme.Palette.Mode, themeApplied));
            InvalidateRect(popup, IntPtr.Zero, true);
            return popup;
        }

        private IntPtr ResolveAssetHeader()
        {
            if (_state.AssetList == IntPtr.Zero || !IsWindow(_state.AssetList))
            {
                _state.AssetHeader = IntPtr.Zero;
                return IntPtr.Zero;
            }

            IntPtr header = SendMessage(_state.AssetList, LVM_GETHEADER, IntPtr.Zero, IntPtr.Zero);
            _state.AssetHeader = header != IntPtr.Zero && IsWindow(header) ? header : IntPtr.Zero;
            return _state.AssetHeader;
        }

        private bool IsAssetHeader(IntPtr candidate)
        {
            if (candidate == IntPtr.Zero) return false;
            IntPtr header = _state.AssetHeader;
            if (header == IntPtr.Zero || !IsWindow(header) || GetParent(header) != _state.AssetList)
                header = ResolveAssetHeader();
            return candidate == header;
        }

        private void AttachAssetHeaderNotifications()
        {
            if (_state.AssetList == IntPtr.Zero || _assetListSubclassHandle.IsAllocated) return;
            if (ResolveAssetHeader() == IntPtr.Zero) throw NativeFailure();
            _assetListSubclassHandle = GCHandle.Alloc(this);
            if (SetWindowSubclass(_state.AssetList, AssetListProcedure, UIntPtr.Zero,
                    GCHandle.ToIntPtr(_assetListSubclassHandle))) return;
            _assetListSubclassHandle.Free();
            throw NativeFailure();
        }

        private void DetachAssetHeaderNotifications()
        {
            if (!_assetListSubclassHandle.IsAllocated) return;
            if (_state.AssetList != IntPtr.Zero && IsWindow(_state.AssetList))
                RemoveWindowSubclass(_state.AssetList, AssetListProcedure, UIntPtr.Zero);
            _assetListSubclassHandle.Free();
        }

        private void ApplyFont(IntPtr control, NativeCompanionFontRole role)
        {
            if (control != IntPtr.Zero && _theme is not null)
                SendMessage(control, WM_SETFONT, _theme.Font(role), new IntPtr(1));
        }

        private void RefreshTheme(int dpi)
        {
            NativeCompanionTheme replacement = new(dpi);
            NativeCompanionTheme? previous = _theme;
            _theme = replacement;
            try
            {
                ApplyTheme();
                _winUiTextSurfaces?.SetTheme(ElementThemeFor(replacement.Palette.Mode));
            }
            finally { previous?.Dispose(); }
            if (_state.AssetList != IntPtr.Zero)
            {
                RebuildPreviewImageList(replacement.Dpi);
                _suppressAssetNotifications = true;
                try
                {
                    PopulateAssetRowsWithPlaceholders();
                    ApplySelectionCore();
                }
                finally { _suppressAssetNotifications = false; }
                UpdateSelectedCount();
                ScheduleCurrentPlatformPreviews();
            }
            Layout();
        }

        private void ResizeAssetColumnsToClient(int dpi)
        {
            if (_state.AssetList == IntPtr.Zero || !GetClientRect(_state.AssetList, out Rect client)) return;
            int clientWidth = Math.Max(0, client.right - client.left);
            if (clientWidth == _assetColumnClientWidth && dpi == _assetColumnDpi) return;
            _assetColumnClientWidth = clientWidth;
            _assetColumnDpi = dpi;

            int index = 0;
            foreach (ManualAssetListColumn column in AssetColumns(clientWidth, dpi))
                SendMessage(_state.AssetList, LVM_SETCOLUMNWIDTH, new IntPtr(index++), new IntPtr(column.LogicalWidth));
            IntPtr header = ResolveAssetHeader();
            if (header != IntPtr.Zero) InvalidateRect(header, IntPtr.Zero, false);
        }

        private void RebuildPreviewImageList(int dpi)
        {
            if (_state.AssetList == IntPtr.Zero) return;
            int pixelSize = Math.Max(16, Scale(48, dpi > 0 ? dpi : 96));
            IntPtr replacement = NativeImageListStorage.Create(pixelSize);
            if (replacement == IntPtr.Zero) return;
            NativeCompanionPalette palette = _theme?.Palette ?? NativeCompanionPalette.Dark;
            int pending = NativeImageListStorage.Add(replacement,
                NativePreviewPlaceholders.Create(pixelSize, palette.MutedText, unavailable: false, failed: false));
            int unavailable = NativeImageListStorage.Add(replacement,
                NativePreviewPlaceholders.Create(pixelSize, palette.BorderStrong, unavailable: true, failed: false));
            int failed = NativeImageListStorage.Add(replacement,
                NativePreviewPlaceholders.Create(pixelSize, palette.Danger, unavailable: false, failed: true));
            if (pending < 0 || unavailable < 0 || failed < 0)
            {
                NativeImageListStorage.Destroy(replacement);
                return;
            }

            IntPtr previous = SendMessage(_state.AssetList, LVM_SETIMAGELIST, new IntPtr(1), replacement); // LVSIL_SMALL
            _imageList = replacement;
            _thumbnailPixelSize = pixelSize;
            _pendingImageIndex = pending;
            _unavailableImageIndex = unavailable;
            _failedImageIndex = failed;
            Interlocked.Increment(ref _previewGeneration);
            if (previous != IntPtr.Zero && previous != replacement) NativeImageListStorage.Destroy(previous);
        }

        private void ScheduleCurrentPlatformPreviews()
        {
            if (_previews is null || _thumbnailPixelSize <= 0 || _imageList == IntPtr.Zero) return;
            long generation = Volatile.Read(ref _previewGeneration);
            int platformIndex = _state.Model.PlatformIndex;
            ManualPreparedPlatform platform = _state.Model.Platform;
            for (int ordinal = 0; ordinal < platform.Assets.Count; ordinal++)
            {
                ManualPreparedAsset prepared = platform.Assets[ordinal];
                if (!ManualPublishingCompanionModel.IsAvailable(prepared) || !IsImageAsset(prepared)) continue;
                var request = new NativePreviewRequest(
                    generation, platformIndex, platform.Platform, ordinal, prepared, _thumbnailPixelSize);
                _previews.TrySchedule(request);
            }
        }

        private void DrainPreviewResults()
        {
            if (_previews is null) return;
            _previews.DrainResults(ApplyPreviewResult);
        }

        private void ApplyPreviewResult(NativePreviewResult result)
        {
            if (Volatile.Read(ref _previewClosing) != 0) return;
            if (!PreviewResultMatches(
                result.Request, _previewGeneration, _state.Model.PlatformIndex,
                _state.Model.Platform, _thumbnailPixelSize)) return;
            int row = FindRowByOrdinal(_state.AssetList, result.Request.Ordinal);
            if (row < 0) return;
            int imageIndex = _failedImageIndex;
            if (result.Outcome == NativePreviewOutcome.Thumbnail && result.Pixels is not null)
            {
                int added = NativeImageListStorage.Add(_imageList, result.Pixels);
                if (added >= 0) imageIndex = added;
            }
            SetItemImage(_state.AssetList, row, imageIndex);
        }

        internal static bool PreviewResultMatches(
            NativePreviewRequest request, long generation, int platformIndex,
            ManualPreparedPlatform platform, int pixelSize) =>
            request.Generation == generation && request.PlatformIndex == platformIndex &&
            string.Equals(request.Platform, platform.Platform, StringComparison.Ordinal) &&
            request.PixelSize == pixelSize && request.Ordinal >= 0 && request.Ordinal < platform.Assets.Count &&
            ReferenceEquals(request.Prepared, platform.Assets[request.Ordinal]);

        internal static bool IsImageAsset(ManualPreparedAsset prepared) =>
            prepared.Asset.MimeType.StartsWith("image/", StringComparison.OrdinalIgnoreCase) ||
            prepared.Asset.Extension.Equals(".png", StringComparison.OrdinalIgnoreCase) ||
            prepared.Asset.Extension.Equals(".jpg", StringComparison.OrdinalIgnoreCase) ||
            prepared.Asset.Extension.Equals(".jpeg", StringComparison.OrdinalIgnoreCase) ||
            prepared.Asset.Extension.Equals(".gif", StringComparison.OrdinalIgnoreCase) ||
            prepared.Asset.Extension.Equals(".webp", StringComparison.OrdinalIgnoreCase) ||
            prepared.Asset.Extension.Equals(".bmp", StringComparison.OrdinalIgnoreCase) ||
            prepared.Asset.Extension.Equals(".tif", StringComparison.OrdinalIgnoreCase) ||
            prepared.Asset.Extension.Equals(".tiff", StringComparison.OrdinalIgnoreCase);

        private static int FindRowByOrdinal(IntPtr listView, int ordinal)
        {
            for (int row = 0; ; row++)
            {
                int? current = ItemOrdinal(listView, row);
                if (current is null) return -1;
                if (current == ordinal) return row;
            }
        }

        internal static void SetItemImage(IntPtr listView, int row, int imageIndex)
        {
            var item = new ListViewItem { mask = LvifImage, iItem = row, iSubItem = 0, iImage = imageIndex };
            SendMessageListViewItem(listView, LVM_SETITEM, IntPtr.Zero, ref item);
        }

        private void ApplyListViewPalette()
        {
            if (_theme is null || _state.AssetList == IntPtr.Zero) return;
            NativeCompanionPalette palette = _theme.Palette;
            NativeCompanionSurfaceStyle nested = NativeCompanionTheme.SurfaceStyle(
                NativeCompanionSurfaceRole.Nested, palette);
            SendMessage(_state.AssetList, LVM_SETBKCOLOR, IntPtr.Zero, new IntPtr(nested.Background));
            SendMessage(_state.AssetList, LVM_SETTEXTBKCOLOR, IntPtr.Zero, new IntPtr(nested.Background));
            SendMessage(_state.AssetList, LVM_SETTEXTCOLOR, IntPtr.Zero, new IntPtr(palette.Text));
        }

        private IntPtr ControlColor(uint message, IntPtr device, IntPtr control)
        {
            if (_theme is null) return IntPtr.Zero;
            NativeCompanionPalette palette = _theme.Palette;
            if (message == WM_CTLCOLORLISTBOX)
            {
                ComboBoxInfo info = new() { cbSize = (uint)Marshal.SizeOf<ComboBoxInfo>() };
                if (!GetComboBoxInfo(_state.Platform, ref info) || control != info.hwndList)
                    return IntPtr.Zero;
                int listBackground = palette.Mode == NativeCompanionThemeMode.HighContrast
                    ? palette.Page : palette.Surface;
                return _theme.PrepareTextDevice(device, palette.Text, listBackground);
            }
            NativeCompanionTextStyle style = StaticTextStyle(control, palette);
            return _theme.PrepareTextDevice(device, style.Text, style.Background, transparent: true);
        }

        private NativeCompanionTextStyle StaticTextStyle(IntPtr control, NativeCompanionPalette palette)
        {
            NativeCompanionSurfaceRole surface = control == _state.Header || control == _state.HeaderMetadata
                ? NativeCompanionSurfaceRole.Window
                : control == _state.Status || control == _state.PostingAggregate
                    ? NativeCompanionSurfaceRole.Footer
                    : control == _state.PlatformHeading || control == _state.PlatformLabel ||
                        control == _state.AssetLabel || control == _state.AssetCount
                        ? NativeCompanionSurfaceRole.SectionHeader
                        : NativeCompanionSurfaceRole.Section;
            NativeCompanionTextRole role = control == _state.Header ? NativeCompanionTextRole.ReleaseHeading :
                control == _state.PlatformHeading || control == _state.AssetLabel ? NativeCompanionTextRole.SectionHeading :
                control == _state.HeaderMetadata || control == _state.DragGuidance || control == _state.PostingHelper
                    ? NativeCompanionTextRole.Supporting :
                control == _state.PlatformLabel || control == _state.TitleLabel || control == _state.BodyLabel ||
                    control == _state.AssetCount ? NativeCompanionTextRole.Label :
                control == _state.Status ? StatusTextRole(_statusKind) :
                control == _state.PostingStatus ? StatusTextRole(_postingStatusKind) :
                control == _state.PostingAggregate && _aggregateComplete ? NativeCompanionTextRole.Success :
                control == _state.PostingAggregate ? NativeCompanionTextRole.Supporting :
                NativeCompanionTextRole.Body;
            return NativeCompanionTheme.TextStyle(role, surface, palette);
        }

        private static NativeCompanionTextRole StatusTextRole(StatusKind kind) => kind switch
        {
            StatusKind.Success => NativeCompanionTextRole.Success,
            StatusKind.Error => NativeCompanionTextRole.Danger,
            _ => NativeCompanionTextRole.Status,
        };

        private void PaintWindow()
        {
            if (_theme is null) return;
            IntPtr device = BeginPaint(_window, out PaintStruct paint);
            if (device == IntPtr.Zero) return;
            try
            {
                GetClientRect(_window, out Rect client);
                NativeCompanionPalette palette = _theme.Palette;
                NativeCompanionSurfaceStyle window = NativeCompanionTheme.SurfaceStyle(
                    NativeCompanionSurfaceRole.Window, palette);
                FillRect(device, ref client, _theme.Brush(window.Background));
                if (_layout is null) return;
                PaintSection(device, _layout.PlatformCard, includesPlatformSelector: true);
                PaintSection(device, _layout.AssetsCard, includesPlatformSelector: false);
                Rect footer = ToRect(_layout.Footer);
                NativeCompanionSurfaceStyle footerStyle = NativeCompanionTheme.SurfaceStyle(
                    NativeCompanionSurfaceRole.Footer, palette);
                FillRect(device, ref footer, _theme.Brush(footerStyle.Background));
                Rect divider = new() { left = footer.left, top = footer.top, right = footer.right, bottom = footer.top + Math.Max(1, Scale(1, _theme.Dpi)) };
                FillRect(device, ref divider, _theme.Brush(footerStyle.Border));
            }
            finally { EndPaint(_window, ref paint); }
        }

        private void PaintSection(IntPtr device, NativeLayoutRect bounds, bool includesPlatformSelector)
        {
            if (_theme is null) return;
            NativeCompanionSurfaceStyle section = NativeCompanionTheme.SurfaceStyle(
                NativeCompanionSurfaceRole.Section, _theme.Palette);
            Rect sectionRect = ToRect(bounds);
            if (section.Decorative)
                DrawRoundedRect(device, ref sectionRect, section.Background, section.Border,
                    Scale(section.Radius, _theme.Dpi));
            else
            {
                FillRect(device, ref sectionRect, _theme.Brush(section.Background));
                FrameRect(device, ref sectionRect, _theme.Brush(section.Border));
                return;
            }

            NativeCompanionSurfaceStyle header = NativeCompanionTheme.SurfaceStyle(
                NativeCompanionSurfaceRole.SectionHeader, _theme.Palette);
            Rect headerRect = ToRect(NativeCompanionTheme.SectionHeaderBounds(
                bounds, _theme.Dpi, includesPlatformSelector));
            DrawRoundedRect(device, ref headerRect, header.Background, header.Border,
                Scale(header.Radius, _theme.Dpi));
        }

        private IntPtr HandleNotify(IntPtr pointer)
        {
            if (pointer == IntPtr.Zero || _window == IntPtr.Zero) return IntPtr.Zero;
            NotifyHeader header = Marshal.PtrToStructure<NotifyHeader>(pointer);
            if (header.hwndFrom != _state.AssetList) return IntPtr.Zero;

            if (header.code == LvnItemChanged)
            {
                if (!_suppressAssetNotifications)
                {
                    NotifyListView changed = Marshal.PtrToStructure<NotifyListView>(pointer);
                    if ((changed.uChanged & LvifState) != 0 &&
                        ((changed.uOldState ^ changed.uNewState) & LvisSelected) != 0)
                        CaptureSelection();
                }
                return IntPtr.Zero;
            }
            if (header.code == LvnBeginDrag)
            {
                NotifyListView drag = Marshal.PtrToStructure<NotifyListView>(pointer);
                Action<NativeListViewBeginDragProbe>? observer = _listViewBeginDragObserver;
                _listViewBeginDragObserver = null;
                observer?.Invoke(new NativeListViewBeginDragProbe(
                    drag.iItem, SelectedItemIndices(_state.AssetList),
                    SelectedOrdinals(_state.AssetList)));
                BeginListViewDrag(drag.iItem);
                return IntPtr.Zero;
            }
            if (header.code == NmCustomDraw) return DrawListView(pointer);
            return IntPtr.Zero;
        }

        private IntPtr DrawHeader(IntPtr pointer)
        {
            NativeCustomDraw draw = Marshal.PtrToStructure<NativeCustomDraw>(pointer);
            IntPtr result = new(CdrfDodefault);
            if (_theme is not null && _theme.Palette.UsesDecorativeColors)
            {
                if (draw.dwDrawStage == CddsPrepaint)
                    result = new IntPtr(CdrfNotifyItemDraw | CdrfNotifyPostpaint);
                else if (draw.dwDrawStage == CddsItemPrepaint)
                {
                    PaintHeaderItem(draw);
                    result = new IntPtr(CdrfSkipDefault);
                }
                else if (draw.dwDrawStage == CddsPostpaint)
                    PaintHeaderTrailingArea(draw.hdc);
            }
            _headerDrawObserver?.Invoke(draw.dwDrawStage, result);
            return result;
        }

        private void PaintHeaderItem(NativeCustomDraw draw)
        {
            if (_theme is null || draw.hdc == IntPtr.Zero) return;
            NativeHeaderChromeStyle style = NativeCompanionTheme.HeaderChromeStyle(_theme.Palette);
            Rect cell = draw.rc;
            FillRect(draw.hdc, ref cell, _theme.Brush(style.Background));

            int itemIndex = checked((int)draw.dwItemSpec.ToUInt64());
            IReadOnlyList<ManualAssetListColumn> columns = AssetColumns(0, _theme.Dpi);
            string text = itemIndex >= 0 && itemIndex < columns.Count ? columns[itemIndex].Title : string.Empty;
            NativeLayoutRect textLayout = NativeCompanionTheme.HeaderTextBounds(ToLayoutRect(cell), _theme.Dpi);
            Rect textBounds = ToRect(textLayout);
            IntPtr previousFont = SelectObject(draw.hdc, _theme.Font(NativeCompanionFontRole.Supporting));
            try
            {
                _theme.PrepareTextDevice(draw.hdc, style.Text, style.Background, transparent: true);
                DrawText(draw.hdc, text, -1, ref textBounds, DtVCenter | DtSingleLine | DtNoPrefix | DtEndEllipsis);
            }
            finally
            {
                if (previousFont != IntPtr.Zero && previousFont != new IntPtr(-1)) SelectObject(draw.hdc, previousFont);
            }

            int stroke = NativeCompanionTheme.HeaderStrokeWidth(_theme.Dpi);
            Rect divider = new()
            {
                left = Math.Max(cell.left, cell.right - stroke),
                top = cell.top,
                right = cell.right,
                bottom = cell.bottom,
            };
            FillRect(draw.hdc, ref divider, _theme.Brush(style.Divider));
            PaintHeaderBottomEdge(draw.hdc, ref cell, style.BottomEdge, stroke);
        }

        private void PaintHeaderTrailingArea(IntPtr device)
        {
            if (_theme is null || device == IntPtr.Zero || _state.AssetHeader == IntPtr.Zero ||
                !GetClientRect(_state.AssetHeader, out Rect client)) return;
            NativeHeaderChromeStyle style = NativeCompanionTheme.HeaderChromeStyle(_theme.Palette);
            int itemCount = SendMessage(_state.AssetHeader, HDM_GETITEMCOUNT, IntPtr.Zero, IntPtr.Zero).ToInt32();
            if (itemCount < 0)
            {
                SkipHeaderTrailingFill(device, ref client, style, []);
                return;
            }
            var items = new List<NativeLayoutRect>(Math.Max(0, itemCount));
            for (int index = 0; index < itemCount; index++)
            {
                if (!SendMessageHeaderRect(_state.AssetHeader, HDM_GETITEMRECT, new IntPtr(index), out Rect item))
                {
                    SkipHeaderTrailingFill(device, ref client, style, items);
                    return;
                }
                var points = new[]
                {
                    new Point { x = item.left, y = item.top },
                    new Point { x = item.right, y = item.bottom },
                };
                SetLastError(0);
                if (MapWindowPoints(_state.AssetList, _state.AssetHeader, points, 2) == 0 &&
                    Marshal.GetLastWin32Error() != 0)
                {
                    SkipHeaderTrailingFill(device, ref client, style, items);
                    return;
                }
                items.Add(new NativeLayoutRect(
                    points[0].x, points[0].y,
                    points[1].x - points[0].x, points[1].y - points[0].y));
            }
            NativeLayoutRect trailingLayout = NativeCompanionTheme.HeaderTrailingBounds(ToLayoutRect(client), items);
            _headerPostpaintObserver?.Invoke(new(
                ToLayoutRect(client), items.ToArray(), trailingLayout, CoordinateMappingSucceeded: true));
            Rect trailing = ToRect(trailingLayout);
            if (trailing.right > trailing.left)
                FillRect(device, ref trailing, _theme.Brush(style.Background));
            int stroke = NativeCompanionTheme.HeaderStrokeWidth(_theme.Dpi);
            PaintHeaderBottomEdge(device, ref client, style.BottomEdge, stroke);
        }

        private void SkipHeaderTrailingFill(
            IntPtr device, ref Rect client, NativeHeaderChromeStyle style,
            IReadOnlyList<NativeLayoutRect> mappedItems)
        {
            if (_theme is null) return;
            _headerPostpaintObserver?.Invoke(new(
                ToLayoutRect(client), mappedItems.ToArray(), default, CoordinateMappingSucceeded: false));
            PaintHeaderBottomEdge(device, ref client, style.BottomEdge,
                NativeCompanionTheme.HeaderStrokeWidth(_theme.Dpi));
        }

        private void PaintHeaderBottomEdge(IntPtr device, ref Rect bounds, int color, int stroke)
        {
            if (_theme is null || bounds.bottom <= bounds.top) return;
            Rect bottom = new()
            {
                left = bounds.left,
                top = Math.Max(bounds.top, bounds.bottom - stroke),
                right = bounds.right,
                bottom = bounds.bottom,
            };
            FillRect(device, ref bottom, _theme.Brush(color));
        }

        private IntPtr DrawListView(IntPtr pointer)
        {
            ListViewCustomDraw draw = Marshal.PtrToStructure<ListViewCustomDraw>(pointer);
            bool custom = _theme is not null && _theme.Palette.UsesDecorativeColors;
            if (draw.nmcd.dwDrawStage == CddsPrepaint)
            {
                IntPtr prepaintResult = new(custom ? CdrfNotifyItemDraw : CdrfDodefault);
                _listViewDrawObserver?.Invoke(new(
                    draw.nmcd.dwDrawStage, -1, false, false, false, custom, 0, 0, default, prepaintResult));
                return prepaintResult;
            }
            if (!custom || _theme is null) return new IntPtr(CdrfDodefault);
            if (draw.nmcd.dwDrawStage != CddsItemPrepaint && draw.nmcd.dwDrawStage != CddsItemPostpaint)
                return new IntPtr(CdrfDodefault);

            int itemIndex = checked((int)draw.nmcd.dwItemSpec.ToUInt64());
            uint nativeState = NativeItemState(_state.AssetList, itemIndex, LvisSelected | LvisFocused);
            bool selected = (nativeState & LvisSelected) != 0;
            bool keyboardFocused = GetFocus() == _state.AssetList && (nativeState & LvisFocused) != 0;
            bool customDrawReportedSelected = (draw.nmcd.uItemState & CdisSelected) != 0;
            NativeListViewSelectionStyle style = NativeCompanionTheme.ListViewSelectionStyle(_theme.Palette);
            NativeLayoutRect accent = default;
            IntPtr result = new(CdrfDodefault);

            if (draw.nmcd.dwDrawStage == CddsItemPrepaint)
            {
                draw.clrText = selected ? style.Text : _theme.Palette.Text;
                draw.clrTextBk = selected ? style.Background : NativeCompanionTheme.SurfaceStyle(
                    NativeCompanionSurfaceRole.Nested, _theme.Palette).Background;
                Marshal.StructureToPtr(draw, pointer, false);
                result = new IntPtr(CdrfNewFont | (selected ? CdrfNotifyPostpaint : 0));
            }
            else if (selected && GetClientRect(_state.AssetList, out Rect client))
            {
                Rect row = draw.nmcd.rc;
                row.left = 0; // LVIR_BOUNDS
                if (!SendMessageListViewRect(_state.AssetList, LVM_GETITEMRECT, new IntPtr(itemIndex), ref row))
                    row = draw.nmcd.rc;
                accent = NativeCompanionTheme.ListViewSelectionAccentBounds(
                    ToLayoutRect(client), ToLayoutRect(row), _theme.Dpi);
                if (accent.Width > 0 && accent.Height > 0)
                {
                    Rect accentRect = ToRect(accent);
                    FillRect(draw.nmcd.hdc, ref accentRect, _theme.Brush(style.Accent));
                }
            }

            _listViewDrawObserver?.Invoke(new(
                draw.nmcd.dwDrawStage, itemIndex, selected, customDrawReportedSelected,
                keyboardFocused, true, selected ? style.Background : NativeCompanionTheme.SurfaceStyle(
                    NativeCompanionSurfaceRole.Nested, _theme.Palette).Background,
                selected ? style.Text : _theme.Palette.Text, accent, result));
            return result;
        }

        private void DrawRoundedRect(
            IntPtr device, ref Rect rect, int fill, int border, int radius, int borderWidth = 0)
        {
            if (_theme is null) return;
            IntPtr pen = CreatePen(0,
                borderWidth > 0 ? borderWidth : Math.Max(1, Scale(1, _theme.Dpi)), border);
            if (pen == IntPtr.Zero) throw NativeFailure();
            IntPtr previousPen = SelectObject(device, pen);
            IntPtr previousBrush = SelectObject(device, _theme.Brush(fill));
            int ellipse = NativeCompanionTheme.RoundedRectEllipseDiameter(radius);
            try { RoundRect(device, rect.left, rect.top, rect.right, rect.bottom, ellipse, ellipse); }
            finally
            {
                if (previousBrush != IntPtr.Zero && previousBrush != new IntPtr(-1)) SelectObject(device, previousBrush);
                if (previousPen != IntPtr.Zero && previousPen != new IntPtr(-1)) SelectObject(device, previousPen);
                DeleteObject(pen);
            }
        }

        private NativeCompanionOwnerDrawTarget? ResolveOwnerDrawTarget(
            uint controlType, uint controlId, IntPtr itemWindow)
        {
            if (itemWindow == IntPtr.Zero || !IsWindow(itemWindow) || GetParent(itemWindow) != _window)
                return null;

            if (controlType == OdtComboBox)
                return controlId == PlatformId && itemWindow == _state.Platform
                    ? NativeCompanionOwnerDrawTarget.PlatformCombo
                    : null;

            if (controlType != OdtButton) return null;
            return controlId switch
            {
                CopyTitleId when itemWindow == _state.CopyTitle => NativeCompanionOwnerDrawTarget.SecondaryButton,
                CopyMainId when itemWindow == _state.CopyMain => NativeCompanionOwnerDrawTarget.SecondaryButton,
                PostingConfirmationId when itemWindow == _state.PostingAction => NativeCompanionOwnerDrawTarget.PrimaryButton,
                CloseId when itemWindow == _state.Close => NativeCompanionOwnerDrawTarget.SecondaryButton,
                _ => null,
            };
        }

        private bool DrawItem(IntPtr pointer)
        {
            if (_theme is null || pointer == IntPtr.Zero) return false;
            DrawItemStruct item = Marshal.PtrToStructure<DrawItemStruct>(pointer);
            NativeCompanionOwnerDrawTarget? target = ResolveOwnerDrawTarget(item.CtlType, item.CtlID, item.hwndItem);
            if (target is null) return false;

            NativeCompanionPalette palette = _theme.Palette;
            bool disabled = (item.itemState & OdsDisabled) != 0;
            bool selected = (item.itemState & OdsSelected) != 0;
            bool focused = (item.itemState & OdsFocus) != 0;
            bool button = target is NativeCompanionOwnerDrawTarget.PrimaryButton or
                NativeCompanionOwnerDrawTarget.SecondaryButton;
            int background, foreground;
            NativeCompanionButtonStyle buttonStyle = default;
            NativeCompanionComboItemStyle comboItemStyle = default;
            if (button)
            {
                NativeCompanionButtonState state = disabled ? NativeCompanionButtonState.Disabled :
                    NativeCompanionButtonState.Normal;
                if (selected) state |= NativeCompanionButtonState.Pressed;
                if (_hoveredButtons.Contains(item.hwndItem)) state |= NativeCompanionButtonState.Hover;
                if (focused) state |= NativeCompanionButtonState.Focused;
                NativeCompanionButtonRole role = target == NativeCompanionOwnerDrawTarget.PrimaryButton
                    ? NativeCompanionButtonRole.Primary
                    : NativeCompanionButtonRole.Secondary;
                buttonStyle = NativeCompanionTheme.ButtonStyle(
                    role, state, palette, _theme.Dpi);
                background = buttonStyle.Background;
                foreground = buttonStyle.Text;
            }
            else
            {
                comboItemStyle = NativeCompanionTheme.ComboItemStyle(selected, disabled, focused, palette);
                background = comboItemStyle.Background;
                foreground = comboItemStyle.Text;
            }
            if (button && buttonStyle.UsesSystemFrame)
            {
                uint frameState = DfcsButtonPush |
                    (disabled ? DfcsInactive : 0) |
                    (selected ? DfcsPushed : 0) |
                    (_hoveredButtons.Contains(item.hwndItem) ? DfcsHot : 0);
                DrawFrameControl(item.hDC, ref item.rcItem, DfcButton, frameState);
            }
            else if (button)
                DrawRoundedRect(item.hDC, ref item.rcItem, background, buttonStyle.Border,
                    Scale(6, _theme.Dpi), buttonStyle.BorderWidth);
            else
            {
                FillRect(item.hDC, ref item.rcItem, _theme.Brush(background));
            }
            string text = button ? WindowText(item.hwndItem) : ComboItemText(item.hwndItem, item.itemID);
            Rect textRect = item.rcItem;
            int inset = button ? Scale(8, _theme.Dpi) : NativeCompanionTheme.ComboItemInset(_theme.Dpi);
            textRect.left += inset; textRect.right -= inset;
            if (buttonStyle.ContentOffset > 0)
            {
                textRect.left += buttonStyle.ContentOffset;
                textRect.right += buttonStyle.ContentOffset;
                textRect.top += buttonStyle.ContentOffset;
                textRect.bottom += buttonStyle.ContentOffset;
            }
            IntPtr previousFont = IntPtr.Zero;
            if (!button) previousFont = SelectObject(item.hDC, _theme.Font(NativeCompanionFontRole.Body));
            try
            {
                _theme.PrepareTextDevice(item.hDC, foreground, background, transparent: true);
                uint format = DtVCenter | DtSingleLine | DtEndEllipsis | DtNoPrefix;
                if (button) format |= DtCenter;
                DrawText(item.hDC, text, text.Length, ref textRect, format);
            }
            finally
            {
                if (previousFont != IntPtr.Zero && previousFont != new IntPtr(-1))
                    SelectObject(item.hDC, previousFont);
            }
            if (focused || (!button && comboItemStyle.DrawFocusCue))
            {
                Rect focus = item.rcItem;
                int focusInset = Math.Max(2, Scale(3, _theme.Dpi));
                focus.left += focusInset; focus.top += focusInset;
                focus.right -= focusInset; focus.bottom -= focusInset;
                DrawFocusRect(item.hDC, ref focus);
            }
            return true;
        }

        private void PaintPlatformCombo(IntPtr combo)
        {
            if (_theme is null) return;
            IntPtr device = BeginPaint(combo, out PaintStruct paint);
            if (device == IntPtr.Zero) return;
            try
            {
                if (!GetClientRect(combo, out Rect client)) return;
                NativeCompanionPalette palette = _theme.Palette;
                FillRect(device, ref client, _theme.Brush(palette.Card));

                NativeCompanionComboState state = NativeCompanionComboState.Normal;
                if (_platformHovered) state |= NativeCompanionComboState.Hover;
                if (GetFocus() == combo) state |= NativeCompanionComboState.Focused;
                if (!IsWindowEnabled(combo)) state |= NativeCompanionComboState.Disabled;
                if (SendMessage(combo, CB_GETDROPPEDSTATE, IntPtr.Zero, IntPtr.Zero) != IntPtr.Zero)
                    state |= NativeCompanionComboState.Dropped;
                NativeCompanionComboStyle style = NativeCompanionTheme.ComboStyle(state, palette, _theme.Dpi);

                Rect control = client;
                DrawRoundedRect(device, ref control, style.Background, style.Border,
                    Scale(6, _theme.Dpi), style.BorderWidth);

                int arrowWidth = Math.Min(client.right - client.left,
                    NativeCompanionTheme.ComboArrowWidth(_theme.Dpi));
                int arrowCenterX = client.right - arrowWidth / 2;
                int arrowCenterY = (client.top + client.bottom) / 2;
                int arrowHalfWidth = Math.Max(2, Scale(4, _theme.Dpi));
                int arrowHalfHeight = Math.Max(1, Scale(2, _theme.Dpi));
                IntPtr arrowPen = CreatePen(0, NativeCompanionTheme.ComboStrokeWidth(_theme.Dpi), style.Arrow);
                if (arrowPen == IntPtr.Zero) throw NativeFailure();
                IntPtr previousPen = SelectObject(device, arrowPen);
                try
                {
                    MoveToEx(device, arrowCenterX - arrowHalfWidth, arrowCenterY - arrowHalfHeight, IntPtr.Zero);
                    LineTo(device, arrowCenterX, arrowCenterY + arrowHalfHeight);
                    LineTo(device, arrowCenterX + arrowHalfWidth, arrowCenterY - arrowHalfHeight);
                }
                finally
                {
                    if (previousPen != IntPtr.Zero && previousPen != new IntPtr(-1)) SelectObject(device, previousPen);
                    DeleteObject(arrowPen);
                }

                Rect text = client;
                text.left += NativeCompanionTheme.ComboTextInset(_theme.Dpi);
                text.right -= arrowWidth;
                IntPtr previousFont = SelectObject(device, _theme.Font(NativeCompanionFontRole.Body));
                try
                {
                    _theme.PrepareTextDevice(device, style.Text, style.Background, transparent: true);
                    string value = ComboItemText(combo, uint.MaxValue);
                    DrawText(device, value, value.Length, ref text,
                        DtVCenter | DtSingleLine | DtEndEllipsis | DtNoPrefix);
                }
                finally
                {
                    if (previousFont != IntPtr.Zero && previousFont != new IntPtr(-1)) SelectObject(device, previousFont);
                }

                if (state.HasFlag(NativeCompanionComboState.Focused))
                {
                    Rect focus = client;
                    int focusInset = Math.Max(2, Scale(3, _theme.Dpi));
                    focus.left += focusInset; focus.top += focusInset;
                    focus.right -= focusInset; focus.bottom -= focusInset;
                    DrawFocusRect(device, ref focus);
                }
            }
            finally { EndPaint(combo, ref paint); }
        }

        private string ComboItemText(IntPtr combo, uint itemId)
        {
            int index = itemId == uint.MaxValue
                ? unchecked((int)SendMessage(combo, CB_GETCURSEL, IntPtr.Zero, IntPtr.Zero).ToInt64())
                : checked((int)itemId);
            if (index < 0) return string.Empty;
            int length = unchecked((int)SendMessage(combo, CB_GETLBTEXTLEN, new IntPtr(index), IntPtr.Zero).ToInt64());
            if (length < 0) return string.Empty;
            var buffer = new System.Text.StringBuilder(length + 1);
            SendMessageBuilder(combo, CB_GETLBTEXT, new IntPtr(index), buffer);
            return buffer.ToString();
        }

        private static string WindowText(IntPtr window)
        {
            int length = GetWindowTextLength(window);
            var text = new System.Text.StringBuilder(length + 1);
            GetWindowText(window, text, text.Capacity);
            return text.ToString();
        }

        private static string WindowClassName(IntPtr window)
        {
            if (window == IntPtr.Zero) return string.Empty;
            var name = new System.Text.StringBuilder(64);
            return GetClassName(window, name, name.Capacity) > 0 ? name.ToString() : string.Empty;
        }

        private static NativeLayoutRect ToLayoutRect(Rect rect) =>
            new(rect.left, rect.top, Math.Max(0, rect.right - rect.left), Math.Max(0, rect.bottom - rect.top));

        private static Rect ToRect(NativeLayoutRect rect) => new()
        {
            left = rect.X, top = rect.Y, right = rect.Right, bottom = rect.Bottom,
        };

        private void Layout()
        {
            if (_window == IntPtr.Zero || !GetClientRect(_window, out Rect client)) return;
            int dpi = DpiForWindow(_window);
            NativeCompanionLayout bootstrap = NativeCompanionLayout.Calculate(
                client.right, client.bottom, dpi, _state.Model.IsPatreon,
                WindowText(_state.PostingStatus), WindowText(_state.PostingHelper), _confirmation is not null,
                StatusText);
            if (!GetWindowRect(_state.AssetList, out Rect currentList) || currentList.bottom <= currentList.top)
            {
                Move(_state.AssetList, bootstrap.AssetList);
                ResizeAssetColumnsToClient(dpi);
            }
            int desiredAssetListHeight = MeasureDesiredAssetListHeight();
            _layout = NativeCompanionLayout.Calculate(client.right, client.bottom, dpi, _state.Model.IsPatreon,
                WindowText(_state.PostingStatus), WindowText(_state.PostingHelper), _confirmation is not null,
                StatusText, desiredAssetListHeight);
            Move(_state.Header, _layout.HeaderTitle);
            Move(_state.HeaderMetadata, _layout.HeaderMetadata);
            Move(_state.PlatformHeading, _layout.PlatformHeading);
            Move(_state.PlatformLabel, _layout.PlatformLabel);
            Move(_state.Platform, _layout.Platform);
            if (_state.Model.IsPatreon)
            {
                Move(_state.TitleLabel, _layout.TitleLabel);
                Move(_state.CopyTitle, _layout.CopyTitle);
            }
            Move(_state.BodyLabel, _layout.BodyLabel);
            _winUiTextSurfaces?.SetBounds(_layout.TitleText, _layout.BodyText, _state.Model.IsPatreon);
            Move(_state.CopyMain, _layout.CopyMain);
            Move(_state.PostingStatus, _layout.PostingStatus);
            Move(_state.PostingHelper, _layout.PostingHelper);
            Move(_state.PostingAction, _layout.PostingAction);
            Move(_state.PostingAggregate, _layout.PostingAggregate);
            Move(_state.AssetLabel, _layout.AssetsHeading);
            Move(_state.AssetCount, _layout.AssetCount);
            Move(_state.DragGuidance, _layout.DragGuidance);
            Move(_state.AssetList, _layout.AssetList);
            ResizeAssetColumnsToClient(dpi);
            Move(_state.Status, _layout.Status);
            Move(_state.Close, _layout.Close);
            InvalidateRect(_window, IntPtr.Zero, true);
        }

        private int MeasureDesiredAssetListHeight()
        {
            if (_state.AssetList == IntPtr.Zero || !GetWindowRect(_state.AssetList, out Rect window) ||
                !GetClientRect(_state.AssetList, out Rect client))
                throw NativeFailure();
            IntPtr headerHandle = ResolveAssetHeader();
            if (headerHandle == IntPtr.Zero || !GetWindowRect(headerHandle, out Rect headerWindow))
                throw NativeFailure();
            NativeLayoutRect header = ToParentLayoutRect(_state.AssetList, headerWindow);
            int count = checked((int)SendMessage(
                _state.AssetList, LVM_GETITEMCOUNT, IntPtr.Zero, IntPtr.Zero).ToInt64());
            int requiredClientBottom = header.Bottom;
            if (count > 0)
            {
                var firstItem = new Rect();
                if (!SendMessageListViewRect(
                        _state.AssetList, LVM_GETITEMRECT, IntPtr.Zero, ref firstItem))
                    throw NativeFailure();
                int rowHeight = firstItem.bottom - firstItem.top;
                if (rowHeight <= 0) throw new InvalidOperationException("The production ListView reported an invalid row height.");
                requiredClientBottom = Math.Max(requiredClientBottom,
                    firstItem.top + rowHeight * Math.Min(count, 5));
            }
            int windowHeight = Math.Max(0, window.bottom - window.top);
            int clientHeight = Math.Max(0, client.bottom - client.top);
            return Math.Max(0, windowHeight - clientHeight) + requiredClientBottom;
        }

        private NativeAssetViewportProbe CaptureAssetViewportCore()
        {
            if (_state.AssetList == IntPtr.Zero || !GetWindowRect(_state.AssetList, out Rect window) ||
                !GetClientRect(_state.AssetList, out Rect client))
                throw NativeFailure();

            NativeLayoutRect listWindow = ToParentLayoutRect(_window, window);
            NativeLayoutRect listClient = ToLayoutRect(client);
            IntPtr headerHandle = ResolveAssetHeader();
            NativeLayoutRect header = default;
            if (headerHandle != IntPtr.Zero && GetWindowRect(headerHandle, out Rect headerWindow))
                header = ToParentLayoutRect(_state.AssetList, headerWindow);

            int count = checked((int)SendMessage(
                _state.AssetList, LVM_GETITEMCOUNT, IntPtr.Zero, IntPtr.Zero).ToInt64());
            var items = new List<NativeLayoutRect>(count);
            for (int index = 0; index < count; index++)
            {
                var item = new Rect();
                if (!SendMessageListViewRect(_state.AssetList, LVM_GETITEMRECT, new IntPtr(index), ref item))
                    throw NativeFailure();
                items.Add(ToLayoutRect(item));
            }

            int visibleRowTarget = Math.Min(count, 5);
            int requiredClientBottom = header.Bottom;
            if (visibleRowTarget > 0)
            {
                NativeLayoutRect first = items[0];
                int rowHeight = first.Height;
                if (rowHeight <= 0) throw new InvalidOperationException("The production ListView reported an invalid row height.");
                requiredClientBottom = Math.Max(requiredClientBottom, first.Y + rowHeight * visibleRowTarget);
            }
            int nonClientHeight = Math.Max(0, listWindow.Height - listClient.Height);
            int desiredListHeight = nonClientHeight + requiredClientBottom;

            var scroll = new ScrollInfo { cbSize = (uint)Marshal.SizeOf<ScrollInfo>(), fMask = SifAll };
            if (!GetScrollInfo(_state.AssetList, SbVert, ref scroll)) scroll = default;
            return new(
                count, visibleRowTarget, DpiForWindow(_window), listWindow, listClient, header,
                items, desiredListHeight, scroll.nMin, scroll.nMax, checked((int)scroll.nPage), scroll.nPos);
        }

        private static NativeLayoutRect ToParentLayoutRect(IntPtr parent, Rect screen)
        {
            var points = new[]
            {
                new Point { x = screen.left, y = screen.top },
                new Point { x = screen.right, y = screen.bottom },
            };
            SetLastError(0);
            if (MapWindowPoints(IntPtr.Zero, parent, points, 2) == 0 && Marshal.GetLastWin32Error() != 0)
                throw NativeFailure();
            return new(points[0].x, points[0].y,
                points[1].x - points[0].x, points[1].y - points[0].y);
        }

        private static void Move(IntPtr window, NativeLayoutRect rect) =>
            MoveWindow(window, rect.X, rect.Y, rect.Width, rect.Height, true);

        private static IntPtr WindowProcedure(IntPtr window, uint message, IntPtr wParam, IntPtr lParam)
        {
            WindowState? state = null;
            try
            {
                if (message == WM_NCCREATE)
                {
                    CreateStruct create = Marshal.PtrToStructure<CreateStruct>(lParam);
                    IntPtr result = DefWindowProcW(window, message, wParam, lParam);
                    if (result != IntPtr.Zero) SetWindowLongPtr(window, GWLP_USERDATA, create.lpCreateParams);
                    return result;
                }
                state = State(window);
                if (message == DragPreparedMessage) { state?.Owner.CompleteDragPreparation(); return IntPtr.Zero; }
                if (message == PreviewReadyMessage) { state?.Owner.DrainPreviewResults(); return IntPtr.Zero; }
                if (message == PostingConfirmationCompletedMessage)
                {
                    state?.Owner.RefreshPostingConfirmation();
                    return IntPtr.Zero;
                }
                if (message == TestingInvokeMessage)
                {
                    state?.Owner.ExecuteTestingInvocation(lParam);
                    return IntPtr.Zero;
                }
                if (state is not null && ProcessLifecycleMessage(
                    message, state.Lifecycle,
                    () => window != IntPtr.Zero && IsWindow(window),
                    () =>
                    {
                        state.Owner.BeginClose();
                        state.Owner._winUiProofOptions?.WindowClosing?.Invoke();
                        state.Owner.DisposeWinUiTextSurfaces();
                        DestroyWindow(window);
                    },
                    () => { state.Owner.BeginClose(); PostQuitMessage(0); })) return IntPtr.Zero;
                if (message == WM_PAINT) { state?.Owner.PaintWindow(); return IntPtr.Zero; }
                if (message == WM_ERASEBKGND) return new IntPtr(1);
                if (message == WM_SIZE) { state?.Owner.Layout(); return IntPtr.Zero; }
                if (message == WM_SETFOCUS) { if (state is not null) SetFocus(state.Platform); return IntPtr.Zero; }
                if (message == WM_GETMINMAXINFO) { SetMinimum(window, lParam); return IntPtr.Zero; }
                if (message == WM_COMMAND) { state?.Owner.HandleCommand(LowWord(wParam), HighWord(wParam), lParam); return IntPtr.Zero; }
                if (message == WM_NOTIFY) return state?.Owner.HandleNotify(lParam) ?? IntPtr.Zero;
                if (message is WM_CTLCOLORSTATIC or WM_CTLCOLORLISTBOX)
                    return state?.Owner.ControlColor(message, wParam, lParam) ?? IntPtr.Zero;
                if (message == WM_DRAWITEM && state?.Owner.DrawItem(lParam) == true) return new IntPtr(1);
                if (message == WM_MEASUREITEM && state is not null)
                {
                    MeasureItemStruct measure = Marshal.PtrToStructure<MeasureItemStruct>(lParam);
                    if (measure.CtlType != OdtComboBox || measure.CtlID != PlatformId)
                        return DefWindowProcW(window, message, wParam, lParam);
                    measure.itemHeight = (uint)NativeCompanionTheme.ComboItemHeight(
                        state.Owner._theme?.Dpi ?? DpiForWindow(window));
                    Marshal.StructureToPtr(measure, lParam, false);
                    return new IntPtr(1);
                }
                if (message is WM_SETTINGCHANGE or WM_SYSCOLORCHANGE or WM_THEMECHANGED)
                {
                    state?.Owner.RefreshTheme(DpiForWindow(window));
                    return IntPtr.Zero;
                }
                if (message == WM_DPICHANGED && state is not null)
                {
                    NativeDpiChange.Apply(window, wParam, lParam, state.Owner.RefreshTheme);
                    return IntPtr.Zero;
                }
                if (message == WM_CLOSE) { state?.Owner.DisposeWinUiTextSurfaces(); DestroyWindow(window); return IntPtr.Zero; }
                if (message == WM_DESTROY) { PostQuitMessage(0); return IntPtr.Zero; }
                return DefWindowProcW(window, message, wParam, lParam);
            }
            catch (Exception exception)
            {
                if (state is not null) CaptureCallbackFailure(state.Lifecycle, exception, () => PostQuitMessage(1));
                else PostQuitMessage(1);
                return IntPtr.Zero;
            }
        }

        private static IntPtr ButtonWindowProcedure(
            IntPtr window, uint message, IntPtr wParam, IntPtr lParam,
            UIntPtr subclassId, IntPtr referenceData)
        {
            NativeWindow? owner = State(GetParent(window))?.Owner;
            if (message == WM_MOUSEMOVE && owner is not null && owner._hoveredButtons.Add(window))
            {
                var tracking = new TrackMouseEventStruct
                {
                    cbSize = (uint)Marshal.SizeOf<TrackMouseEventStruct>(),
                    dwFlags = TmeLeave,
                    hwndTrack = window,
                };
                TrackMouseEvent(ref tracking);
                InvalidateRect(window, IntPtr.Zero, false);
            }
            else if (message == WM_MOUSELEAVE && owner is not null && owner._hoveredButtons.Remove(window))
                InvalidateRect(window, IntPtr.Zero, false);
            return DefSubclassProc(window, message, wParam, lParam);
        }

        private static IntPtr PlatformComboWindowProcedure(
            IntPtr window, uint message, IntPtr wParam, IntPtr lParam,
            UIntPtr subclassId, IntPtr referenceData)
        {
            NativeWindow? owner = State(GetParent(window))?.Owner;
            bool customChrome = owner?._theme?.Palette.Mode is
                NativeCompanionThemeMode.Dark or NativeCompanionThemeMode.Light;
            if (customChrome && message == WM_PAINT)
            {
                owner!.PaintPlatformCombo(window);
                return IntPtr.Zero;
            }
            if (customChrome && message == WM_ERASEBKGND) return new IntPtr(1);

            if (message == WM_MOUSEMOVE && owner is not null && !owner._platformHovered)
            {
                owner._platformHovered = true;
                var tracking = new TrackMouseEventStruct
                {
                    cbSize = (uint)Marshal.SizeOf<TrackMouseEventStruct>(),
                    dwFlags = TmeLeave,
                    hwndTrack = window,
                };
                TrackMouseEvent(ref tracking);
                InvalidateRect(window, IntPtr.Zero, false);
            }
            else if (message == WM_MOUSELEAVE && owner is not null && owner._platformHovered)
            {
                owner._platformHovered = false;
                InvalidateRect(window, IntPtr.Zero, false);
            }

            IntPtr result = DefSubclassProc(window, message, wParam, lParam);
            if (owner is not null &&
                message is WM_SETFOCUS or WM_KILLFOCUS or WM_LBUTTONDOWN or WM_LBUTTONUP)
                InvalidateRect(window, IntPtr.Zero, false);
            return result;
        }

        private static IntPtr AssetListWindowProcedure(
            IntPtr window, uint message, IntPtr wParam, IntPtr lParam,
            UIntPtr subclassId, IntPtr referenceData)
        {
            NativeWindow? owner = referenceData == IntPtr.Zero
                ? null
                : GCHandle.FromIntPtr(referenceData).Target as NativeWindow;
            if (message == WM_NOTIFY && owner is not null && lParam != IntPtr.Zero)
            {
                NotifyHeader header = Marshal.PtrToStructure<NotifyHeader>(lParam);
                if (header.code == NmCustomDraw && owner.IsAssetHeader(header.hwndFrom))
                    return owner.DrawHeader(lParam);
            }
            IntPtr result = DefSubclassProc(window, message, wParam, lParam);
            if ((message == WM_SETFOCUS || message == WM_KILLFOCUS) && owner is not null)
                InvalidateRect(window, IntPtr.Zero, false);
            return result;
        }

        internal static bool ProcessLifecycleMessage(
            uint message, ManualCompanionLifecycle lifecycle, Func<bool> windowIsValid,
            Action destroyWindow, Action postQuit)
        {
            if (message == ReadyProbeMessage)
            {
                lifecycle.TryCompleteReady(windowIsValid());
                return true;
            }
            if (message == WM_CLOSE)
            {
                lifecycle.BeginClosing();
                destroyWindow();
                return true;
            }
            if (message == WM_DESTROY)
            {
                lifecycle.BeginClosing();
                postQuit();
                return true;
            }
            return false;
        }

        internal static void CaptureCallbackFailure(
            ManualCompanionLifecycle lifecycle, Exception exception, Action postQuit)
        {
            lifecycle.Fail(exception);
            postQuit();
        }

        private static WindowState? State(IntPtr window)
        {
            IntPtr value = GetWindowLongPtr(window, GWLP_USERDATA);
            return value == IntPtr.Zero ? null : GCHandle.FromIntPtr(value).Target as WindowState;
        }

        private static ushort RegisterClassOnce(IntPtr instance)
        {
            IntPtr largeIcon = LoadApplicationIcon(instance, SmCxIcon, SmCyIcon);
            IntPtr smallIcon = LoadApplicationIcon(instance, SmCxSmallIcon, SmCySmallIcon);
            var definition = new WindowClass { cbSize = (uint)Marshal.SizeOf<WindowClass>(), hInstance = instance,
                lpszClassName = ClassName, lpfnWndProc = Marshal.GetFunctionPointerForDelegate(Procedure),
                hCursor = LoadCursor(IntPtr.Zero, new IntPtr(32512)), hIcon = largeIcon, hIconSm = smallIcon,
                hbrBackground = IntPtr.Zero };
            ushort atom = RegisterClassEx(ref definition);
            return atom != 0 || Marshal.GetLastWin32Error() == 1410 ? (ushort)1 : (ushort)0;
        }

        private static IntPtr LoadApplicationIcon(IntPtr instance, int widthMetric, int heightMetric)
        {
            IntPtr icon = LoadImage(instance, new IntPtr(32512), ImageIcon,
                GetSystemMetrics(widthMetric), GetSystemMetrics(heightMetric), LrShared);
            return icon != IntPtr.Zero ? icon : LoadIcon(IntPtr.Zero, new IntPtr(32512));
        }

        private static void SetMinimum(IntPtr window, IntPtr pointer)
        {
            MinMaxInfo info = Marshal.PtrToStructure<MinMaxInfo>(pointer);
            NativeLayoutSize outer = MinimumOuterSizeForDpi(DpiForWindow(window));
            info.ptMinTrackSize.x = outer.Width;
            info.ptMinTrackSize.y = outer.Height;
            Marshal.StructureToPtr(info, pointer, false);
        }

        internal static NativeLayoutSize MinimumOuterSizeForDpi(int dpi)
        {
            NativeLayoutSize required = NativeCompanionLayout.SupportedMinimumLogicalClientSize;
            return OuterSizeForLogicalClient(required.Width, required.Height, dpi);
        }

        internal static NativeLayoutSize OuterSizeForLogicalClient(int logicalWidth, int logicalHeight, int dpi)
        {
            int effectiveDpi = Math.Max(96, dpi);
            var rectangle = new Rect
            {
                right = Scale(logicalWidth, effectiveDpi),
                bottom = Scale(logicalHeight, effectiveDpi),
            };
            if (!AdjustWindowRectExForDpi(
                ref rectangle, ProductionWindowStyle, false, ProductionWindowExtendedStyle, (uint)effectiveDpi))
                throw NativeFailure();
            return new(rectangle.right - rectangle.left, rectangle.bottom - rectangle.top);
        }

        internal static NativeLayoutSize ClientSizeFromOuterForDpi(NativeLayoutSize outer, int dpi)
        {
            int effectiveDpi = Math.Max(96, dpi);
            var nonClient = new Rect();
            if (!AdjustWindowRectExForDpi(
                ref nonClient, ProductionWindowStyle, false, ProductionWindowExtendedStyle, (uint)effectiveDpi))
                throw NativeFailure();
            return new(
                outer.Width - (nonClient.right - nonClient.left),
                outer.Height - (nonClient.bottom - nonClient.top));
        }

        private static void SendString(IntPtr control, uint message, string value)
        {
            IntPtr text = Marshal.StringToHGlobalUni(value);
            try { SendMessage(control, message, IntPtr.Zero, text); }
            finally { Marshal.FreeHGlobal(text); }
        }

        private static Exception NativeFailure() => new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());

        private T RunOnUiThreadForTesting<T>(Func<T> action)
        {
            if (_uiThreadId == GetCurrentThreadId()) return action();
            var invocation = new TestingInvocation<T>(action);
            GCHandle handle = GCHandle.Alloc(invocation);
            try { SendMessage(_window, TestingInvokeMessage, IntPtr.Zero, GCHandle.ToIntPtr(handle)); }
            finally { handle.Free(); }
            if (invocation.Exception is not null)
                throw new InvalidOperationException("The production companion test invocation failed.", invocation.Exception);
            return invocation.Result!;
        }

        private void ExecuteTestingInvocation(IntPtr pointer)
        {
            if (pointer != IntPtr.Zero)
                ((ITestingInvocation)GCHandle.FromIntPtr(pointer).Target!).Execute();
        }

        private interface ITestingInvocation { void Execute(); }

        private sealed class TestingInvocation<T>(Func<T> action) : ITestingInvocation
        {
            internal T? Result { get; private set; }
            internal Exception? Exception { get; private set; }

            public void Execute()
            {
                try { Result = action(); }
                catch (Exception exception) { Exception = exception; }
            }
        }
        private static int LowWord(IntPtr value) => unchecked((ushort)value.ToInt64());
        private static int HighWord(IntPtr value) => unchecked((ushort)(value.ToInt64() >> 16));
        private static int Scale(int value, int dpi) => value * dpi / 96;
        private static bool IsShiftPressed() => (GetKeyState(0x10) & 0x8000) != 0;
        private static int SystemDpi() { try { return checked((int)GetDpiForSystem()); } catch { return 96; } }
        private static int DpiForWindow(IntPtr window) { try { return checked((int)GetDpiForWindow(window)); } catch { return SystemDpi(); } }

        private sealed class WindowState
        {
            public WindowState(ManualPublishingCompanionModel model, ManualCompanionLifecycle lifecycle)
            {
                Model = model;
                Lifecycle = lifecycle;
            }
            public ManualPublishingCompanionModel Model { get; }
            public ManualCompanionLifecycle Lifecycle { get; }
            public NativeWindow Owner => _owner ?? throw new InvalidOperationException();
            private NativeWindow? _owner;
            public void Attach(NativeWindow owner) { _owner = owner; }
            public GCHandle Handle; public IntPtr Window, Header, HeaderMetadata, PlatformHeading, PlatformLabel, Platform,
                TitleLabel, CopyTitle, BodyLabel, CopyMain, AssetLabel, AssetCount, DragGuidance, AssetList,
                AssetHeader, PostingStatus, PostingHelper, PostingAction, PostingAggregate, Status, Close;
            public IEnumerable<IntPtr> Buttons => new[] { CopyTitle, CopyMain, PostingAction, Close }.Where(value => value != IntPtr.Zero);
            public IEnumerable<IntPtr> RequiredControls => new[] { Header, HeaderMetadata, PlatformHeading, PlatformLabel, Platform,
                TitleLabel, CopyTitle, BodyLabel, CopyMain, AssetLabel, AssetCount, DragGuidance, AssetList,
                Status, Close };
            public IEnumerable<IntPtr> PostingControls => new[] { PostingStatus, PostingHelper, PostingAction, PostingAggregate };
            public IEnumerable<IntPtr> Controls => new[] { Header, HeaderMetadata, PlatformHeading, PlatformLabel, Platform,
                TitleLabel, CopyTitle, BodyLabel, CopyMain, PostingStatus, PostingHelper,
                PostingAction, PostingAggregate, AssetLabel, AssetCount, DragGuidance, AssetList, Status, Close }
                .Where(value => value != IntPtr.Zero);
        }

        private sealed class RejectingAssetAvailability : IManualAssetAvailability
        {
            public static RejectingAssetAvailability Instance { get; } = new();
            public Task<ManualDragPreparation> PrepareAsync(IReadOnlyList<ManualDragAsset> selected, CancellationToken cancellationToken) =>
                Task.FromResult(ManualDragPreparation.Fail("validation_failed"));
        }

        [UnmanagedFunctionPointer(CallingConvention.Winapi)] private delegate IntPtr WindowProc(IntPtr window, uint message, IntPtr wParam, IntPtr lParam);
        [UnmanagedFunctionPointer(CallingConvention.Winapi)] private delegate IntPtr SubclassProc(
            IntPtr window, uint message, IntPtr wParam, IntPtr lParam, UIntPtr subclassId, IntPtr referenceData);
        [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)] private struct WindowClass { public uint cbSize, style; public IntPtr lpfnWndProc; public int cbClsExtra, cbWndExtra; public IntPtr hInstance, hIcon, hCursor, hbrBackground; public string? lpszMenuName, lpszClassName; public IntPtr hIconSm; }
        [StructLayout(LayoutKind.Sequential)] private struct CreateStruct { public IntPtr lpCreateParams, hInstance, hMenu, hwndParent; public int cy, cx, y, x, style; public IntPtr lpszName, lpszClass; public uint dwExStyle; }
        [StructLayout(LayoutKind.Sequential)] internal struct Message { public IntPtr hwnd; public uint message; public IntPtr wParam, lParam; public uint time; public Point pt; public uint lPrivate; }
        [StructLayout(LayoutKind.Sequential)] internal struct Point { public int x, y; }
        [StructLayout(LayoutKind.Sequential)] private struct Rect { public int left, top, right, bottom; }
        [StructLayout(LayoutKind.Sequential)] private struct ScrollInfo
        {
            public uint cbSize, fMask;
            public int nMin, nMax;
            public uint nPage;
            public int nPos, nTrackPos;
        }
        [StructLayout(LayoutKind.Sequential)] private struct MinMaxInfo { public Point ptReserved, ptMaxSize, ptMaxPosition, ptMinTrackSize, ptMaxTrackSize; }
        [StructLayout(LayoutKind.Sequential)] private struct InitCommonControls { public uint dwSize, dwICC; }
        [StructLayout(LayoutKind.Sequential)] private struct NotifyHeader
        {
            public IntPtr hwndFrom;
            public UIntPtr idFrom;
            public int code;
        }
        [StructLayout(LayoutKind.Sequential)] private struct NotifyListView
        {
            public NotifyHeader hdr;
            public int iItem, iSubItem;
            public uint uNewState, uOldState, uChanged;
            public Point ptAction;
            public IntPtr lParam;
        }
        [StructLayout(LayoutKind.Sequential)] private struct NativeCustomDraw
        {
            public NotifyHeader hdr;
            public uint dwDrawStage;
            public IntPtr hdc;
            public Rect rc;
            public UIntPtr dwItemSpec;
            public uint uItemState;
            public IntPtr lItemlParam;
        }
        [StructLayout(LayoutKind.Sequential)] private struct ListViewCustomDraw
        {
            public NativeCustomDraw nmcd;
            public int clrText, clrTextBk;
        }
        [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)] private struct ListViewColumn
        {
            public uint mask;
            public int fmt, cx;
            [MarshalAs(UnmanagedType.LPWStr)] public string? pszText;
            public int cchTextMax, iSubItem, iImage, iOrder, cxMin, cxDefault, cxIdeal;
        }
        [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)] private struct ListViewItem
        {
            public uint mask;
            public int iItem, iSubItem;
            public uint state, stateMask;
            [MarshalAs(UnmanagedType.LPWStr)] public string? pszText;
            public int cchTextMax, iImage;
            public IntPtr lParam;
            public int iIndent, iGroupId;
            public uint cColumns;
            public IntPtr puColumns, piColFmt;
            public int iGroup;
        }
        [StructLayout(LayoutKind.Sequential)] private struct DrawItemStruct
        {
            public uint CtlType, CtlID, itemID, itemAction, itemState;
            public IntPtr hwndItem, hDC;
            public Rect rcItem;
            public UIntPtr itemData;
        }
        [StructLayout(LayoutKind.Sequential)] private struct MeasureItemStruct
        {
            public uint CtlType, CtlID, itemID, itemWidth, itemHeight;
            public UIntPtr itemData;
        }
        [StructLayout(LayoutKind.Sequential)] private struct PaintStruct
        {
            public IntPtr hdc;
            public int fErase;
            public Rect rcPaint;
            public int fRestore, fIncUpdate;
            [MarshalAs(UnmanagedType.ByValArray, SizeConst = 32)] public byte[] rgbReserved;
        }
        [StructLayout(LayoutKind.Sequential)] private struct TrackMouseEventStruct
        {
            public uint cbSize, dwFlags;
            public IntPtr hwndTrack;
            public uint dwHoverTime;
        }
        [StructLayout(LayoutKind.Sequential)] private struct ComboBoxInfo
        {
            public uint cbSize;
            public Rect rcItem, rcButton;
            public uint stateButton;
            public IntPtr hwndCombo, hwndItem, hwndList;
        }
        [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)] private struct LogFont
        {
            public int lfHeight, lfWidth, lfEscapement, lfOrientation, lfWeight;
            public byte lfItalic, lfUnderline, lfStrikeOut, lfCharSet;
            public byte lfOutPrecision, lfClipPrecision, lfQuality, lfPitchAndFamily;
            [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)] public string? lfFaceName;
        }

        [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] private static extern IntPtr GetModuleHandle(string? moduleName);
        [DllImport("kernel32.dll")] private static extern uint GetCurrentThreadId();
        [DllImport("kernel32.dll")] private static extern void SetLastError(uint errorCode);
        [DllImport("user32.dll", EntryPoint = "RegisterClassExW", CharSet = CharSet.Unicode, ExactSpelling = true, SetLastError = true)] private static extern ushort RegisterClassEx(ref WindowClass windowClass);
        [DllImport("user32.dll", EntryPoint = "CreateWindowExW", CharSet = CharSet.Unicode, ExactSpelling = true, SetLastError = true)] private static extern IntPtr CreateWindowEx(uint extendedStyle, string className, string title, uint style, int x, int y, int width, int height, IntPtr parent, IntPtr menu, IntPtr instance, IntPtr parameter);
        [DllImport("user32.dll", EntryPoint = "DefWindowProcW", CharSet = CharSet.Unicode, ExactSpelling = true)] private static extern IntPtr DefWindowProcW(IntPtr window, uint message, IntPtr wParam, IntPtr lParam);
        [DllImport("user32.dll")] private static extern bool DestroyWindow(IntPtr window);
        [DllImport("user32.dll")] private static extern bool ShowWindow(IntPtr window, int command);
        [DllImport("user32.dll")] private static extern bool EnableWindow(IntPtr window, bool enable);
        [DllImport("user32.dll")] private static extern bool IsWindowEnabled(IntPtr window);
        [DllImport("user32.dll")] private static extern bool UpdateWindow(IntPtr window);
        [DllImport("user32.dll")] private static extern bool SetForegroundWindow(IntPtr window);
        [DllImport("user32.dll")] private static extern bool IsWindowVisible(IntPtr window);
        [DllImport("user32.dll")] private static extern bool IsWindow(IntPtr window);
        [DllImport("user32.dll", SetLastError = true)] private static extern int GetMessage(out Message message, IntPtr window, uint minimum, uint maximum);
        [DllImport("user32.dll")] private static extern bool TranslateMessage(ref Message message);
        [DllImport("user32.dll")] private static extern IntPtr DispatchMessage(ref Message message);
        [DllImport("user32.dll")] private static extern void PostQuitMessage(int code);
        [DllImport("user32.dll", EntryPoint = "PostMessageW", ExactSpelling = true, SetLastError = true)] private static extern bool PostMessage(IntPtr window, uint message, IntPtr wParam, IntPtr lParam);
        [DllImport("user32.dll", EntryPoint = "SetWindowTextW", CharSet = CharSet.Unicode, ExactSpelling = true)] private static extern bool SetWindowText(IntPtr window, string text);
        [DllImport("user32.dll", EntryPoint = "GetWindowTextLengthW", CharSet = CharSet.Unicode, ExactSpelling = true)] private static extern int GetWindowTextLength(IntPtr window);
        [DllImport("user32.dll", EntryPoint = "GetWindowTextW", CharSet = CharSet.Unicode, ExactSpelling = true)] private static extern int GetWindowText(IntPtr window, System.Text.StringBuilder text, int maximumCount);
        [DllImport("user32.dll", EntryPoint = "GetClassNameW", CharSet = CharSet.Unicode, ExactSpelling = true)] private static extern int GetClassName(IntPtr window, System.Text.StringBuilder className, int maximumCount);
        [DllImport("user32.dll")] private static extern bool GetComboBoxInfo(IntPtr combo, ref ComboBoxInfo info);
        [DllImport("user32.dll", EntryPoint = "SendMessageW", CharSet = CharSet.Unicode, ExactSpelling = true)] private static extern IntPtr SendMessage(IntPtr window, uint message, IntPtr wParam, IntPtr lParam);
        [DllImport("user32.dll", SetLastError = true)] private static extern bool GetScrollInfo(IntPtr window, int bar, ref ScrollInfo info);
        [DllImport("user32.dll", EntryPoint = "SendMessageW", ExactSpelling = true)]
        private static extern bool SendMessageHeaderRect(IntPtr window, uint message, IntPtr wParam, out Rect rectangle);
        [DllImport("user32.dll", EntryPoint = "SendMessageW", ExactSpelling = true)]
        private static extern bool SendMessageListViewRect(IntPtr window, uint message, IntPtr wParam, ref Rect rectangle);
        [DllImport("user32.dll", EntryPoint = "SendMessageW", CharSet = CharSet.Unicode, ExactSpelling = true)] private static extern IntPtr SendMessageBuilder(IntPtr window, uint message, IntPtr wParam, System.Text.StringBuilder lParam);
        [DllImport("user32.dll", EntryPoint = "SendMessageW", CharSet = CharSet.Unicode, ExactSpelling = true)] private static extern IntPtr SendMessageListViewItem(IntPtr window, uint message, IntPtr wParam, ref ListViewItem item);
        [DllImport("user32.dll", EntryPoint = "SendMessageW", CharSet = CharSet.Unicode, ExactSpelling = true)] private static extern IntPtr SendMessageListViewColumn(IntPtr window, uint message, IntPtr wParam, ref ListViewColumn column);
        [DllImport("user32.dll")] private static extern bool MoveWindow(IntPtr window, int x, int y, int width, int height, bool repaint);
        [DllImport("user32.dll")] private static extern bool SetWindowPos(IntPtr window, IntPtr insertAfter, int x, int y, int width, int height, uint flags);
        [DllImport("user32.dll")] private static extern bool GetClientRect(IntPtr window, out Rect rect);
        [DllImport("user32.dll", SetLastError = true)] private static extern bool GetWindowRect(IntPtr window, out Rect rect);
        [DllImport("user32.dll", SetLastError = true)] private static extern int MapWindowPoints(IntPtr from, IntPtr to, [In, Out] Point[] points, uint count);
        [DllImport("user32.dll")] private static extern IntPtr GetWindowLongPtr(IntPtr window, int index);
        [DllImport("user32.dll")] private static extern IntPtr SetWindowLongPtr(IntPtr window, int index, IntPtr value);
        [DllImport("user32.dll")] private static extern IntPtr GetNextDlgTabItem(IntPtr window, IntPtr control, bool previous);
        [DllImport("user32.dll")] private static extern IntPtr GetFocus();
        [DllImport("user32.dll")] private static extern bool IsChild(IntPtr parent, IntPtr window);
        [DllImport("user32.dll")] private static extern IntPtr SetFocus(IntPtr window);
        [DllImport("user32.dll")] private static extern IntPtr GetParent(IntPtr window);
        [DllImport("user32.dll")] private static extern int GetDlgCtrlID(IntPtr control);
        [DllImport("user32.dll")] private static extern short GetKeyState(int key);
        [DllImport("user32.dll")] private static extern short GetAsyncKeyState(int key);
        [DllImport("gdi32.dll")] private static extern IntPtr SelectObject(IntPtr device, IntPtr value);
        [DllImport("gdi32.dll", EntryPoint = "GetObjectW", CharSet = CharSet.Unicode)]
        private static extern int GetObject(IntPtr value, int bufferSize, ref LogFont buffer);
        [DllImport("gdi32.dll", SetLastError = true)] private static extern IntPtr CreatePen(int style, int width, int color);
        [DllImport("gdi32.dll")] private static extern bool DeleteObject(IntPtr value);
        [DllImport("gdi32.dll")] private static extern bool MoveToEx(IntPtr device, int x, int y, IntPtr previousPoint);
        [DllImport("gdi32.dll")] private static extern bool LineTo(IntPtr device, int x, int y);
        [DllImport("user32.dll")] private static extern IntPtr LoadCursor(IntPtr instance, IntPtr cursor);
        [DllImport("user32.dll")] private static extern IntPtr LoadIcon(IntPtr instance, IntPtr icon);
        [DllImport("user32.dll", EntryPoint = "LoadImageW", ExactSpelling = true)]
        private static extern IntPtr LoadImage(IntPtr instance, IntPtr name, uint type, int width, int height, uint loadFlags);
        [DllImport("user32.dll")] private static extern int GetSystemMetrics(int index);
        [DllImport("user32.dll")] private static extern IntPtr BeginPaint(IntPtr window, out PaintStruct paint);
        [DllImport("user32.dll")] private static extern bool EndPaint(IntPtr window, ref PaintStruct paint);
        [DllImport("user32.dll")] private static extern int FillRect(IntPtr device, ref Rect rect, IntPtr brush);
        [DllImport("user32.dll")] private static extern int FrameRect(IntPtr device, ref Rect rect, IntPtr brush);
        [DllImport("user32.dll")] private static extern bool DrawFrameControl(IntPtr device, ref Rect rect, uint type, uint state);
        [DllImport("gdi32.dll")] private static extern bool RoundRect(IntPtr device, int left, int top, int right, int bottom, int width, int height);
        [DllImport("user32.dll")] private static extern bool DrawFocusRect(IntPtr device, ref Rect rect);
        [DllImport("user32.dll", EntryPoint = "DrawTextW", CharSet = CharSet.Unicode, ExactSpelling = true)]
        private static extern int DrawText(IntPtr device, string text, int count, ref Rect rect, uint format);
        [DllImport("user32.dll")] private static extern bool InvalidateRect(IntPtr window, IntPtr rect, bool erase);
        [DllImport("user32.dll")] private static extern bool TrackMouseEvent(ref TrackMouseEventStruct tracking);
        [DllImport("user32.dll")] private static extern uint GetDpiForSystem();
        [DllImport("user32.dll")] private static extern uint GetDpiForWindow(IntPtr window);
        [DllImport("user32.dll", SetLastError = true)]
        private static extern bool AdjustWindowRectExForDpi(
            ref Rect rectangle, uint style, bool hasMenu, uint extendedStyle, uint dpi);
        [DllImport("comctl32.dll", SetLastError = true)] private static extern bool InitCommonControlsEx(ref InitCommonControls controls);
        [DllImport("comctl32.dll")] private static extern bool SetWindowSubclass(
            IntPtr window, SubclassProc procedure, UIntPtr subclassId, IntPtr referenceData);
        [DllImport("comctl32.dll")] private static extern bool RemoveWindowSubclass(
            IntPtr window, SubclassProc procedure, UIntPtr subclassId);
        [DllImport("comctl32.dll")] private static extern IntPtr DefSubclassProc(
            IntPtr window, uint message, IntPtr wParam, IntPtr lParam);
    }
}
