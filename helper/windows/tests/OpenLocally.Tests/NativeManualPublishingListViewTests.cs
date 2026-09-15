using OpenLocally;
using System.Runtime.InteropServices;

namespace OpenLocally.Tests;

public sealed class NativeManualPublishingListViewTests
{
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
        Assert.Equal("2 selected", model.SelectedCountText);
        harness.BeginDrag(2);
        Assert.Equal([0, 2], Assert.Single(harness.CoordinatorSelections).Select(asset => asset.Ordinal));
    }

    [Fact]
    public void SelectAll_BeginDragNotificationStartsCoordinatorWithAuthoritativeImmutableSnapshot()
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

        harness.SelectAll();
        Assert.Equal([0, 1, 2, 3], harness.NativeSelection);
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
        Assert.Equal("2 selected", model.SelectedCountText);

        harness.BeginDrag(1);

        Assert.Empty(harness.CoordinatorSelections);
        Assert.Equal([0, 1], harness.NativeSelection);
        Assert.Equal("Selected files include unavailable media.", harness.StatusText);
    }

    [Fact]
    public void SelectAll_ExcludesUnavailableRowAndDragsAllAvailableRows()
    {
        var model = Model(Prepared(1, "a.png", true), Prepared(2, "b.png", false), Prepared(3, "c.png", true));
        using var harness = new NotificationHarness(model);
        harness.SetSelection(1);

        harness.SelectAll();

        Assert.Equal([0, 2], harness.NativeSelection);
        Assert.Equal("2 selected", model.SelectedCountText);
        harness.BeginDrag(0);
        Assert.Equal([0, 2], Assert.Single(harness.CoordinatorSelections).Select(asset => asset.Ordinal));
    }

    [Fact]
    public void AvailabilityChangeAfterSelection_PreservesNativeSetAndRejectsBeforeCoordinator()
    {
        ManualPreparedAsset[] assets = [Prepared(1, "a.png", true), Prepared(2, "b.png", true)];
        var model = Model(assets);
        using var harness = new NotificationHarness(model);
        harness.SetSelection(0, 1);

        assets[1] = Prepared(2, "b.png", false);
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
        Assert.Equal("1 selected", model.SelectedCountText);
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
        harness.SetSelection(1);
        model.SelectPlatform(0);
        harness.RestorePlatformSelection();

        Assert.Equal([0, 1], harness.NativeSelection);
        Assert.Equal("2 selected", model.SelectedCountText);
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

            _window = new NativeManualPublishingCompanion.NativeWindow(
                model, RejectingAvailability.Instance, lifecycle: null,
                tryBeginDrag: selected => { CoordinatorSelections.Add(selected); return true; },
                dragSessionAvailable: () => true,
                previewAccess: previewAccess);
            _window.AttachNotificationHarness(Parent, ListView);
            _self = GCHandle.Alloc(this);
            Assert.True(SetWindowSubclass(Parent, ParentProcedure, UIntPtr.Zero, GCHandle.ToIntPtr(_self)));
            NativeManualPublishingCompanion.NativeWindow.ConfigureAssetList(ListView, 96);
            _window.RestorePlatformSelectionForTesting();
        }

        public IntPtr Parent { get; }
        public IntPtr ListView { get; }
        public List<IReadOnlyList<ManualDragAsset>> CoordinatorSelections { get; } = [];
        public SemaphoreSlim PreviewApplied { get; } = new(0);
        public IReadOnlyList<int> NativeSelection =>
            NativeManualPublishingCompanion.NativeWindow.SelectedOrdinals(ListView);
        public string StatusText => _window.StatusText;

        public void SetSelection(params int[] ordinals)
        {
            NativeManualPublishingCompanion.NativeWindow.SetNativeSelection(
                ListView, ordinals.ToHashSet(), _model.Platform.Assets.Count);
            ThrowIfCallbackFailed();
        }

        public void SelectAll()
        {
            _window.SelectAllForTesting();
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
                if (message == WmNotify) return harness._window.HandleNotifyForTesting(lParam);
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

    [DllImport("user32.dll", EntryPoint = "PeekMessageW", ExactSpelling = true)]
    private static extern bool PeekMessage(out NativeMessage message, IntPtr window, uint minimum, uint maximum, uint remove);

    [DllImport("user32.dll")]
    private static extern bool TranslateMessage(ref NativeMessage message);

    [DllImport("user32.dll", EntryPoint = "DispatchMessageW", ExactSpelling = true)]
    private static extern IntPtr DispatchMessage(ref NativeMessage message);

    [DllImport("user32.dll")]
    private static extern bool DestroyWindow(IntPtr window);
}
