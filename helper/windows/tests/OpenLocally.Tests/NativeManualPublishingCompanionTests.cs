using OpenLocally;

namespace OpenLocally.Tests;

public class NativeManualPublishingCompanionTests
{
    public static TheoryData<string, string> PresentationNewlineCases => new()
    {
        { "a\nb", "a\r\nb" },
        { "a\r\nb", "a\r\nb" },
        { "a\rb", "a\r\nb" },
        { "a\r\nb\nc\rd", "a\r\nb\r\nc\r\nd" },
        { "a\n\n\nb", "a\r\n\r\n\r\nb" },
        { "\na", "\r\na" },
        { "a\n", "a\r\n" },
        { "a\n\n\n", "a\r\n\r\n\r\n" },
        { string.Empty, string.Empty },
        { "no newline", "no newline" },
        { "  keep surrounding whitespace  ", "  keep surrounding whitespace  " },
        { "雪 e\u0301 🚀\nمرحبا", "雪 e\u0301 🚀\r\nمرحبا" },
        { "café 日本語 😀 ❤️ e\u0301 👩🏽‍💻", "café 日本語 😀 ❤️ e\u0301 👩🏽‍💻" },
    };

    [Theory]
    [MemberData(nameof(PresentationNewlineCases))]
    public void EditPresentation_NormalizesOnlyLineSeparators(string source, string expected) =>
        Assert.Equal(expected, NativeTextPresentation.DisplayText(source));

    [Fact]
    public void EveryPlatform_DisplayNormalizesButCopyReceivesExactOriginalSource()
    {
        const string source = "line1\n\n😀❤️👩🏽‍💻\n";
        const string presentation = "line1\r\n\r\n😀❤️👩🏽‍💻\r\n";
        var model = new ManualPublishingCompanionModel(Session(
            Platform("patreon", source, source),
            Platform("x", "ignored", source),
            Platform("bluesky", "ignored", source)));
        var clipboard = new RecordingClipboard();

        Assert.Equal(presentation, NativeTextPresentation.DisplayText(model.Platform.Title));
        Assert.Equal(presentation, NativeTextPresentation.DisplayText(model.Platform.Body));
        Assert.True(model.TryCopy(ManualCopyCommand.Title, clipboard));
        Assert.True(model.TryCopy(ManualCopyCommand.Body, clipboard));

        model.SelectPlatform(1);
        Assert.Equal(presentation, NativeTextPresentation.DisplayText(model.Platform.Body));
        Assert.True(model.TryCopy(ManualCopyCommand.Post, clipboard));

        model.SelectPlatform(2);
        Assert.Equal(presentation, NativeTextPresentation.DisplayText(model.Platform.Body));
        Assert.True(model.TryCopy(ManualCopyCommand.Post, clipboard));

        Assert.All(clipboard.Values, value => Assert.Equal(source, value));
    }

    [Fact]
    public void Copy_PreservesCrlfMixedNewlinesAndAcceptedEmptyContent()
    {
        string crlf = "title\r\nline\r\n";
        string mixed = "body\r\nline\nnext\rlast\r\n";
        var model = new ManualPublishingCompanionModel(Session(
            Platform("patreon", crlf, mixed),
            Platform("x", "ignored", string.Empty),
            Platform("bluesky", "ignored", mixed)));
        var clipboard = new RecordingClipboard();

        Assert.True(model.TryCopy(ManualCopyCommand.Title, clipboard));
        Assert.True(model.TryCopy(ManualCopyCommand.Body, clipboard));
        model.SelectPlatform(1);
        Assert.True(model.TryCopy(ManualCopyCommand.Post, clipboard));
        model.SelectPlatform(2);
        Assert.True(model.TryCopy(ManualCopyCommand.Post, clipboard));

        Assert.Equal(new[] { crlf, mixed, string.Empty, mixed }, clipboard.Values);
    }

    [Fact]
    public void PlatformSwitching_ReappliesPresentationWithoutMutatingMixedOriginalStrings()
    {
        string patreonTitle = "Patreon\rtitle\n";
        string patreonBody = "Patreon\nbody\r\n";
        string xBody = "X\r\npost\r";
        string blueskyBody = "Bluesky\n\npost";
        var model = new ManualPublishingCompanionModel(Session(
            Platform("patreon", patreonTitle, patreonBody),
            Platform("x", "ignored", xBody),
            Platform("bluesky", "ignored", blueskyBody)));

        Assert.Equal("Patreon\r\ntitle\r\n", NativeTextPresentation.DisplayText(model.Platform.Title));
        Assert.Equal("Patreon\r\nbody\r\n", NativeTextPresentation.DisplayText(model.Platform.Body));
        model.SelectPlatform(1);
        Assert.Equal("X\r\npost\r\n", NativeTextPresentation.DisplayText(model.Platform.Body));
        model.SelectPlatform(2);
        Assert.Equal("Bluesky\r\n\r\npost", NativeTextPresentation.DisplayText(model.Platform.Body));
        model.SelectPlatform(0);
        Assert.Equal("Patreon\r\ntitle\r\n", NativeTextPresentation.DisplayText(model.Platform.Title));

        Assert.Equal(patreonTitle, model.Session.Platforms[0].Title);
        Assert.Equal(patreonBody, model.Session.Platforms[0].Body);
        Assert.Equal(xBody, model.Session.Platforms[1].Body);
        Assert.Equal(blueskyBody, model.Session.Platforms[2].Body);
    }

    [Fact]
    public void PatreonTitle_PresentationBoundaryAndCopyKeepSeparateContracts()
    {
        const string title = "Line one\n\nLine three\r";
        var model = new ManualPublishingCompanionModel(Session(Platform("patreon", title, string.Empty)));
        var clipboard = new RecordingClipboard();

        Assert.Equal("Line one\r\n\r\nLine three\r\n", NativeTextPresentation.DisplayText(model.Platform.Title));
        Assert.True(model.TryCopy(ManualCopyCommand.Title, clipboard));
        Assert.Equal(title, clipboard.Values.Single());
    }

    [Fact]
    public void ContentAndPlatformSwitching_PreserveExactUnderlyingStrings()
    {
        string title = "Título 雪 🐈\r\nsecond";
        string patreonBody = "Paragraph one\n\nParagraph two ✓";
        string xBody = "Exact X\r\n\r\npost 🚀";
        string blueskyBody = "Exact Bluesky\ntext Ж";
        var model = new ManualPublishingCompanionModel(Session(
            Platform("patreon", title, patreonBody),
            Platform("x", "ignored release title", xBody),
            Platform("bluesky", "ignored release title", blueskyBody)));
        var clipboard = new RecordingClipboard();

        Assert.True(model.IsPatreon);
        Assert.True(model.TryCopy(ManualCopyCommand.Title, clipboard));
        Assert.Equal(title, clipboard.Values[^1]);
        Assert.True(model.TryCopy(ManualCopyCommand.Body, clipboard));
        Assert.Equal(patreonBody, clipboard.Values[^1]);

        model.SelectPlatform(1);
        Assert.False(model.IsPatreon);
        Assert.True(model.TryCopy(ManualCopyCommand.Post, clipboard));
        Assert.Equal(xBody, clipboard.Values[^1]);
        Assert.Throws<InvalidOperationException>(() => model.TextFor(ManualCopyCommand.Title));

        model.SelectPlatform(2);
        Assert.True(model.TryCopy(ManualCopyCommand.Post, clipboard));
        Assert.Equal(blueskyBody, clipboard.Values[^1]);
        Assert.Equal(title, model.Session.Platforms[0].Title);
        Assert.DoesNotContain("Notes", string.Join("|", clipboard.Values));
    }

    [Fact]
    public void ClipboardFailure_IsRecoverableAndRetryUsesSameExactText()
    {
        var model = new ManualPublishingCompanionModel(Session(Platform("x", "Release", "one\n\n雪")));
        var clipboard = new RecordingClipboard { FailuresRemaining = 1 };

        Assert.False(model.TryCopy(ManualCopyCommand.Post, clipboard));
        Assert.True(model.TryCopy(ManualCopyCommand.Post, clipboard));
        Assert.Equal(new[] { "one\n\n雪", "one\n\n雪" }, clipboard.Values);
    }

    [Fact]
    public void FocusedCopyButtonMapping_CannotTriggerAnUnrelatedCopyAction()
    {
        Assert.Equal(ManualCopyCommand.Title,
            NativeManualPublishingCompanion.NativeWindow.CopyCommandForControl(
                NativeManualPublishingCompanion.NativeWindow.CopyTitleId, isPatreon: true));
        Assert.Null(NativeManualPublishingCompanion.NativeWindow.CopyCommandForControl(
            NativeManualPublishingCompanion.NativeWindow.CopyTitleId, isPatreon: false));
        Assert.Equal(ManualCopyCommand.Body,
            NativeManualPublishingCompanion.NativeWindow.CopyCommandForControl(
                NativeManualPublishingCompanion.NativeWindow.CopyMainId, isPatreon: true));
        Assert.Equal(ManualCopyCommand.Post,
            NativeManualPublishingCompanion.NativeWindow.CopyCommandForControl(
                NativeManualPublishingCompanion.NativeWindow.CopyMainId, isPatreon: false));
    }

    [Fact]
    public void Assets_KeepServerOrderMetadataAndExactObjectSelection()
    {
        ManualPreparedAsset first = Prepared(11, "primary", "original-one.png", "release/a.png", true, @"C:\stage\0000-11.png", 123);
        ManualPreparedAsset unavailable = Prepared(12, "attachment", "missing.png", "release/missing.png", false, string.Empty, 456);
        ManualPreparedAsset third = Prepared(13, "attachment", "same.png", "release/same.png", true, @"C:\stage\same.png", 789);
        var model = new ManualPublishingCompanionModel(Session(new ManualPreparedPlatform("x", "Release", "Post", [first, unavailable, third])));

        Assert.Equal(new[] { first, third }, model.SelectedAssets);
        Assert.Equal("original-one.png", model.AssetRows[0].File);
        Assert.Equal("primary", model.AssetRows[0].Role);
        Assert.Equal("123 bytes", model.AssetRows[0].Size);
        Assert.Equal("release/a.png | Staged: 0000-11.png", model.AssetRows[0].PathOrStagedName);
        Assert.Equal("Unavailable", model.AssetRows[1].Status);
        Assert.DoesNotContain("Staged:", model.AssetRows[2].PathOrStagedName);

        model.SetNativeSelectedOrdinals([2, 1]);
        Assert.Equal(2, model.SelectedAssets.Count);
        Assert.Same(unavailable, model.SelectedAssets[0]);
        Assert.Same(third, model.SelectedAssets[1]);
        model.SetNativeSelectedOrdinals([2, 0]);
        IReadOnlyList<ManualDragAsset> snapshot = model.SnapshotSelectedAssets();
        Assert.Equal(new[] { first, third }, snapshot.Select(item => item.Prepared));
        Assert.Equal(new[] { 0, 2 }, snapshot.Select(item => item.Ordinal));
        model.SetNativeSelectedOrdinals([0]);
        Assert.Equal(new[] { first, third }, snapshot.Select(item => item.Prepared));
    }

    [Fact]
    public void AssetRows_PreserveAuthoritativeIdentityAndColumnMetadata()
    {
        ManualPreparedAsset first = Prepared(11, "primary", "one.png", "release/one.png", true,
            @"C:\stage\0000-one.png", 1234);
        ManualPreparedAsset duplicateName = Prepared(12, "attachment", "one.png", "release/other/one.png", true,
            @"C:\stage\one.png", 5678);
        var platform = new ManualPreparedPlatform("x", "Release", "Post", [first, duplicateName]);
        var model = new ManualPublishingCompanionModel(Session(platform));

        Assert.Collection(model.AssetRows,
            row =>
            {
                Assert.Same(platform, row.Platform);
                Assert.Equal(0, row.Ordinal);
                Assert.Same(first, row.Prepared);
                Assert.Equal("one.png", row.File);
                Assert.Equal("primary", row.Role);
                Assert.Equal("1,234 bytes", row.Size);
                Assert.Equal("Available", row.Status);
                Assert.Equal("release/one.png | Staged: 0000-one.png", row.PathOrStagedName);
            },
            row =>
            {
                Assert.Equal(1, row.Ordinal);
                Assert.Same(duplicateName, row.Prepared);
                Assert.Equal("release/other/one.png", row.PathOrStagedName);
            });
    }

    [Fact]
    public void ReadyProbe_OnlyCompletesAfterItsMessageIsProcessedThroughThePump()
    {
        var lifecycle = new ManualCompanionLifecycle();
        var messages = new Queue<(int, NativeManualPublishingCompanion.NativeWindow.Message)>([
            (1, Message(0x0400)),
            (1, Message(NativeManualPublishingCompanion.NativeWindow.ReadyProbeMessage)),
            (1, Message(0x0401)),
            (0, default),
        ]);
        var ordinary = new List<uint>();

        NativeManualPublishingCompanion.NativeWindow.PumpMessages(
            messages.Dequeue,
            message =>
            {
                if (!ProcessLifecycleMessage(message.message, lifecycle)) ordinary.Add(message.message);
            },
            () => new InvalidOperationException("get-message failed"), lifecycle);

        Assert.True(lifecycle.Ready.IsCompletedSuccessfully);
        Assert.Equal(ManualCompanionLifecycleState.ClosingOrClosed, lifecycle.State);
        Assert.Equal(new uint[] { 0x0400, 0x0401 }, ordinary);
    }

    [Fact]
    public void FirstGetMessageFailure_NeverCompletesReady()
    {
        var lifecycle = new ManualCompanionLifecycle();

        InvalidOperationException failure = Assert.Throws<InvalidOperationException>(() =>
            NativeManualPublishingCompanion.NativeWindow.PumpMessages(
                () => (-1, default),
                message => ProcessLifecycleMessage(message.message, lifecycle),
                () => new InvalidOperationException("get-message failed"), lifecycle));

        Assert.Equal("get-message failed", failure.Message);
        AssertReadyFailed(lifecycle);
        Assert.Equal(ManualCompanionLifecycleState.Failed, lifecycle.State);
    }

    [Fact]
    public void LaterGetMessageFailureBeforeReadyProbe_NeverCompletesReady()
    {
        var lifecycle = new ManualCompanionLifecycle();
        var messages = new Queue<(int, NativeManualPublishingCompanion.NativeWindow.Message)>([
            (1, Message(0x0400)),
            (-1, default),
        ]);

        Assert.Throws<InvalidOperationException>(() =>
            NativeManualPublishingCompanion.NativeWindow.PumpMessages(
                messages.Dequeue,
                message => ProcessLifecycleMessage(message.message, lifecycle),
                () => new InvalidOperationException("get-message failed"), lifecycle));

        AssertReadyFailed(lifecycle);
        Assert.Equal(ManualCompanionLifecycleState.Failed, lifecycle.State);
    }

    [Fact]
    public void QueuedCloseThenStaleReadyProbeThenQuit_NeverCompletesReady()
    {
        var lifecycle = new ManualCompanionLifecycle();
        var messages = new Queue<(int, NativeManualPublishingCompanion.NativeWindow.Message)>([
            (1, Message(NativeManualPublishingCompanion.NativeWindow.CloseMessage)),
            (1, Message(NativeManualPublishingCompanion.NativeWindow.ReadyProbeMessage)),
        ]);
        bool destroyed = false;

        NativeManualPublishingCompanion.NativeWindow.PumpMessages(
            messages.Dequeue,
            message => NativeManualPublishingCompanion.NativeWindow.ProcessLifecycleMessage(
                message.message, lifecycle, () => !destroyed,
                () =>
                {
                    destroyed = true;
                    ProcessLifecycleMessage(NativeManualPublishingCompanion.NativeWindow.DestroyMessage, lifecycle,
                        postQuit: () => messages.Enqueue((0, default)));
                },
                () => messages.Enqueue((0, default))),
            () => new InvalidOperationException("get-message failed"), lifecycle);

        Assert.True(destroyed);
        AssertReadyFailed(lifecycle);
        Assert.Equal(ManualCompanionLifecycleState.ClosingOrClosed, lifecycle.State);
    }

    [Fact]
    public void DestroyBeforeReadyProbe_NeverCompletesReady()
    {
        var lifecycle = new ManualCompanionLifecycle();
        ProcessLifecycleMessage(NativeManualPublishingCompanion.NativeWindow.DestroyMessage, lifecycle);
        ProcessLifecycleMessage(NativeManualPublishingCompanion.NativeWindow.ReadyProbeMessage, lifecycle, windowIsValid: false);

        AssertReadyFailed(lifecycle);
        Assert.Equal(ManualCompanionLifecycleState.ClosingOrClosed, lifecycle.State);
    }

    [Fact]
    public void QuitBeforeReadyProbe_NeverCompletesReady()
    {
        var lifecycle = new ManualCompanionLifecycle();

        NativeManualPublishingCompanion.NativeWindow.PumpMessages(
            () => (0, default),
            message => ProcessLifecycleMessage(message.message, lifecycle),
            () => new InvalidOperationException("get-message failed"), lifecycle);

        ProcessLifecycleMessage(NativeManualPublishingCompanion.NativeWindow.ReadyProbeMessage, lifecycle);
        AssertReadyFailed(lifecycle);
        Assert.Equal(ManualCompanionLifecycleState.ClosingOrClosed, lifecycle.State);
    }

    [Fact]
    public void PostMessageFailure_FailsReadyWithoutHanging()
    {
        var lifecycle = new ManualCompanionLifecycle();

        Assert.Throws<InvalidOperationException>(() =>
            NativeManualPublishingCompanion.NativeWindow.PostReadyProbe(
                () => false, lifecycle, () => new InvalidOperationException("post failed")));

        AssertReadyFailed(lifecycle);
        Assert.Equal(ManualCompanionLifecycleState.Failed, lifecycle.State);
    }

    [Fact]
    public void CallbackFailureBeforeReadyProbe_FailsReadyAndRequestsQuit()
    {
        var lifecycle = new ManualCompanionLifecycle();
        bool quitPosted = false;

        NativeManualPublishingCompanion.NativeWindow.CaptureCallbackFailure(
            lifecycle, new InvalidOperationException("callback failed"), () => quitPosted = true);
        ProcessLifecycleMessage(NativeManualPublishingCompanion.NativeWindow.ReadyProbeMessage, lifecycle);

        Assert.True(quitPosted);
        AssertReadyFailed(lifecycle);
        Assert.Equal(ManualCompanionLifecycleState.Failed, lifecycle.State);
    }

    [Fact]
    public void DispatchFailureBeforeReadyProbe_FailsReady()
    {
        var lifecycle = new ManualCompanionLifecycle();

        Assert.Throws<InvalidOperationException>(() =>
            NativeManualPublishingCompanion.NativeWindow.PumpMessages(
                () => (1, Message(0x0400)),
                _ => throw new InvalidOperationException("dispatch failed"),
                () => new InvalidOperationException("get-message failed"), lifecycle));

        AssertReadyFailed(lifecycle);
        Assert.Equal(ManualCompanionLifecycleState.Failed, lifecycle.State);
    }

    [Fact]
    public void DuplicateReadyProbeMessages_CompleteReadyExactlyOnce()
    {
        var lifecycle = new ManualCompanionLifecycle();
        int successfulTransitions = 0;
        var messages = new Queue<(int, NativeManualPublishingCompanion.NativeWindow.Message)>([
            (1, Message(NativeManualPublishingCompanion.NativeWindow.ReadyProbeMessage)),
            (1, Message(NativeManualPublishingCompanion.NativeWindow.ReadyProbeMessage)),
            (0, default),
        ]);

        NativeManualPublishingCompanion.NativeWindow.PumpMessages(
            messages.Dequeue,
            message =>
            {
                if (message.message == NativeManualPublishingCompanion.NativeWindow.ReadyProbeMessage &&
                    lifecycle.TryCompleteReady(windowIsValid: true)) successfulTransitions++;
            },
            () => new InvalidOperationException("get-message failed"), lifecycle);

        Assert.True(lifecycle.Ready.IsCompletedSuccessfully);
        Assert.Equal(1, successfulTransitions);
    }

    [Fact]
    public void CloseAfterReady_PreservesSuccessfulReadiness()
    {
        var lifecycle = new ManualCompanionLifecycle();
        Assert.True(lifecycle.TryCompleteReady(windowIsValid: true));

        ProcessLifecycleMessage(NativeManualPublishingCompanion.NativeWindow.CloseMessage, lifecycle);

        Assert.True(lifecycle.Ready.IsCompletedSuccessfully);
        Assert.Equal(ManualCompanionLifecycleState.ClosingOrClosed, lifecycle.State);
    }

    [Fact]
    public void PlatformLocalSelection_RestoresValidOrdinalsAndCountsNativeSelection()
    {
        ManualPreparedAsset first = Prepared(11, "primary", "a.png", "release/a.png", true, @"C:\stage\a.png", 123);
        ManualPreparedAsset unavailable = Prepared(12, "attachment", "missing.png", "release/missing.png", false, string.Empty, 456);
        ManualPreparedAsset third = Prepared(13, "attachment", "c.png", "release/c.png", true, @"C:\stage\c.png", 789);
        ManualPreparedAsset xOnly = Prepared(14, "primary", "x.png", "release/x.png", true, @"C:\stage\x.png", 100);
        var model = new ManualPublishingCompanionModel(Session(
            new ManualPreparedPlatform("patreon", "Release", "Post", [first, unavailable, third]),
            new ManualPreparedPlatform("x", "Release", "Post", [xOnly])));

        model.SetNativeSelectedOrdinals([2, 1]);
        Assert.Equal([1, 2], model.SelectedOrdinals);
        Assert.Equal("2 of 3 selected", model.SelectedCountText);
        Assert.Equal("Selection includes unavailable files and cannot be dragged.", model.DragGuidanceText);
        model.SelectPlatform(1);
        Assert.Equal([0], model.SelectedOrdinals);
        model.SetNativeSelectedOrdinals([]);
        Assert.Equal("0 of 1 selected", model.SelectedCountText);
        Assert.Equal("Select files to attach.", model.DragGuidanceText);
        model.SelectPlatform(0);
        Assert.Equal([1, 2], model.SelectedOrdinals);
        Assert.Equal("2 of 3 selected", model.SelectedCountText);
    }

    [Fact]
    public void AssetListStyle_UsesReportScrollingPersistentSelectionAndNativeMultiSelect()
    {
        const uint wsHorizontalScroll = 0x00100000;
        const uint wsVerticalScroll = 0x00200000;
        const uint lvsReport = 0x0001;
        const uint lvsSingleSel = 0x0004;
        const uint lvsShowSelAlways = 0x0008;
        const uint lvsExFullRowSelect = 0x00000020;
        const uint lvsExHeaderDragDrop = 0x00000010;
        const uint lvsExDoubleBuffer = 0x00010000;

        uint style = NativeManualPublishingCompanion.NativeWindow.AssetListStyle;

        Assert.Equal(wsHorizontalScroll, style & wsHorizontalScroll);
        Assert.Equal(wsVerticalScroll, style & wsVerticalScroll);
        Assert.Equal(lvsReport, style & lvsReport);
        Assert.Equal(lvsShowSelAlways, style & lvsShowSelAlways);
        Assert.Equal(0u, style & lvsSingleSel);
        Assert.Equal(0u, NativeManualPublishingCompanion.NativeWindow.AssetListExtendedStyle & lvsExHeaderDragDrop);
        Assert.Equal(lvsExFullRowSelect, NativeManualPublishingCompanion.NativeWindow.AssetListExtendedStyle & lvsExFullRowSelect);
        Assert.Equal(lvsExDoubleBuffer, NativeManualPublishingCompanion.NativeWindow.AssetListExtendedStyle & lvsExDoubleBuffer);
    }

    [Theory]
    [InlineData(96)]
    [InlineData(144)]
    [InlineData(192)]
    public void AssetColumns_AreDpiScaledResponsiveAndKeepUsefulMinimums(int dpi)
    {
        int Scale(int logical) => logical * dpi / 96;
        IReadOnlyList<ManualAssetListColumn> narrow =
            NativeManualPublishingCompanion.NativeWindow.AssetColumns(Scale(640), dpi);
        IReadOnlyList<ManualAssetListColumn> normal =
            NativeManualPublishingCompanion.NativeWindow.AssetColumns(Scale(880), dpi);
        IReadOnlyList<ManualAssetListColumn> wide =
            NativeManualPublishingCompanion.NativeWindow.AssetColumns(Scale(1120), dpi);

        Assert.Equal(["File", "Role", "Size", "Status", "Path / staged name"], narrow.Select(column => column.Title));
        Assert.Equal([Scale(220), Scale(88), Scale(112), Scale(104), Scale(180)],
            narrow.Select(column => column.LogicalWidth));
        Assert.True(narrow.Sum(column => column.LogicalWidth) > Scale(640));

        Assert.Equal(Scale(880), normal.Sum(column => column.LogicalWidth));
        Assert.Equal(Scale(1120), wide.Sum(column => column.LogicalWidth));
        Assert.True(normal[0].LogicalWidth > narrow[0].LogicalWidth);
        Assert.True(wide[0].LogicalWidth > normal[0].LogicalWidth);
        Assert.Equal(narrow.Skip(1).Take(3).Select(column => column.LogicalWidth),
            normal.Skip(1).Take(3).Select(column => column.LogicalWidth));
        Assert.Equal(normal.Skip(1).Take(3).Select(column => column.LogicalWidth),
            wide.Skip(1).Take(3).Select(column => column.LogicalWidth));
        Assert.InRange(normal[4].LogicalWidth, Scale(180), Scale(280));
        Assert.Equal(Scale(280), wide[4].LogicalWidth);
        Assert.All(wide, column => Assert.True(column.LogicalWidth > 0));
    }

    [Fact]
    public void AssetColumns_UseIntegerRemainderWithoutOverflowOrDrift()
    {
        IReadOnlyList<ManualAssetListColumn> columns =
            NativeManualPublishingCompanion.NativeWindow.AssetColumns(1001, 144);

        Assert.Equal(1056, columns.Sum(column => column.LogicalWidth));
        Assert.All(columns, column => Assert.True(column.LogicalWidth > 0));
        Assert.Equal([330, 132, 168, 156, 270], columns.Select(column => column.LogicalWidth));
    }

    private static NativeManualPublishingCompanion.NativeWindow.Message Message(uint id) => new() { message = id };

    private static bool ProcessLifecycleMessage(
        uint message, ManualCompanionLifecycle lifecycle, bool windowIsValid = true, Action? postQuit = null) =>
        NativeManualPublishingCompanion.NativeWindow.ProcessLifecycleMessage(
            message, lifecycle, () => windowIsValid, () => { }, postQuit ?? (() => { }));

    private static void AssertReadyFailed(ManualCompanionLifecycle lifecycle)
    {
        Assert.True(lifecycle.Ready.IsFaulted);
        Assert.NotNull(lifecycle.Ready.Exception);
    }

    private static ManualSocialSession Session(params ManualPreparedPlatform[] platforms) =>
        new(new Uri("https://creatorcrate.test/"), 42, "Release title", platforms);

    private static ManualPreparedPlatform Platform(string platform, string title, string body) => new(platform, title, body, []);

    private static ManualPreparedAsset Prepared(long id, string role, string filename, string relativePath, bool present, string path, long size) =>
        new(new SocialRedeemAsset(id, role, id, filename, ".png", "image/png", size, relativePath, present, null), path,
            StagedMediaProvenance.HelperOwned);

    private sealed class RecordingClipboard : IUnicodeClipboard
    {
        public int FailuresRemaining { get; set; }
        public List<string> Values { get; } = [];
        public bool TrySetText(string text)
        {
            Values.Add(text);
            if (FailuresRemaining <= 0) return true;
            FailuresRemaining--;
            return false;
        }
    }

}
