using System.Diagnostics;
using System.Runtime.InteropServices;
using OpenLocally;
using OpenLocally.ManualVisualProof;

if (args.Contains("--interactive-uia-proof", StringComparer.Ordinal))
    return InteractiveUiaProof.Run();
if (args.Contains("--drag-proof", StringComparer.Ordinal))
    return DragProof.Run(
        FindRepositoryRoot(),
        args.Contains("--auto-close", StringComparer.Ordinal));

const string TitleFixture = "\nPatreon title\r\ncafé 日本語 😀 ❤️ ✅ e\u0301 👩🏽‍💻\r\n\r\n";
const string Fixture = "line1\n\nline2\nCRLF\r\nlone CR\rUnicode café 日本語 😀 ❤️ ✅ e\u0301 👩🏽‍💻\n\r\n\r";
const string XFixture = "\nX post\r\nline1\n\nline2\nUnicode café 日本語 😀 ❤️ ✅ e\u0301 👩🏽‍💻\r\r";
const string BlueskyFixture = "\rBluesky post\nline1\r\n\rline2\nUnicode café 日本語 😀 ❤️ ✅ e\u0301 👩🏽‍💻\n\n";
const string RuntimePackageVersion = "2.4.0";
const string WinUiPackageVersion = "2.3.6";

int cycles = ArgumentValue("--cycles", 1);
bool autoClose = args.Contains("--auto-close", StringComparer.Ordinal);
int failAfter = ArgumentValue("--fail-after", 0);
bool closeBeforeReady = args.Contains("--close-before-ready", StringComparer.Ordinal);
string? capturePath = ArgumentString("--capture");
if (args.Contains("--light-theme", StringComparer.Ordinal))
{
    Console.Error.WriteLine("--light-theme was removed because it themed only WinUI. Use --theme=Light for the whole production companion.");
    return 64;
}
bool manualVisualProof = args.Contains("--manual-visual-proof", StringComparer.Ordinal) ||
    ArgumentString("--posting-state") is not null || ArgumentString("--theme") is not null;
ProofPostingState postingState = ManualVisualProofFixture.ParsePostingState(ArgumentString("--posting-state"));
ProofTheme proofTheme = ManualVisualProofFixture.ParseTheme(ArgumentString("--theme"));
bool resizeCheck = args.Contains("--resize-check", StringComparer.Ordinal);
bool productionSurfaceCheck = args.Contains("--production-surface-check", StringComparer.Ordinal);
bool productionTextCheck = args.Contains("--production-text-check", StringComparer.Ordinal);
bool accessibilityCheck = args.Contains("--accessibility-check", StringComparer.Ordinal);
bool themeCycleCheck = args.Contains("--theme-cycle-check", StringComparer.Ordinal);
bool expectInitFailure = args.Contains("--expect-init-failure", StringComparer.Ordinal);
bool proofDesktop = !args.Contains("--production-desktop-check", StringComparer.Ordinal);
bool moduleProvenance = !args.Contains("--no-module-provenance", StringComparer.Ordinal);
bool observeShownWindow = manualVisualProof || capturePath is not null || resizeCheck || productionSurfaceCheck ||
    productionTextCheck || accessibilityCheck || themeCycleCheck || moduleProvenance;

Console.WriteLine("proof-build=WP10C2B final presentation harmonization 1");
Console.WriteLine($"windows-app-sdk-runtime-package={RuntimePackageVersion}");
Console.WriteLine($"winui-package={WinUiPackageVersion}");
Console.WriteLine("network-or-server-required=false");

uint userBefore = GuiResources(1);
uint gdiBefore = GuiResources(0);
int completed = 0;
int failed = 0;
Exception? captureFailure = null;
uint? stabilizedUser = null;
uint? stabilizedGdi = null;
uint maximumUserGrowth = 0;
uint maximumGdiGrowth = 0;
var resourceSamples = new List<(uint User, uint Gdi)>();

for (int cycle = 0; cycle < cycles; cycle++)
{
    using ManualVisualProofFixture? fixture = manualVisualProof
        ? ManualVisualProofFixture.Create(FindRepositoryRoot())
        : null;
    var automatedSession = new ManualSocialSession(
        new Uri("https://creatorcrate.example"),
        10,
        "WinUI 3 interactive visual proof",
        [
            new ManualPreparedPlatform("patreon", TitleFixture, Fixture, []),
            new ManualPreparedPlatform("x", "ignored", XFixture, []),
            new ManualPreparedPlatform("bluesky", "ignored", BlueskyFixture, []),
        ]);
    ManualSocialSession session = fixture?.Session ?? automatedSession;
    var lifecycle = new ManualCompanionLifecycle();
    ControlledPostingTransport? postingTransport = manualVisualProof ? null : new ControlledPostingTransport();
    FixturePostingTransport? fixturePostingTransport = null;
    using ManualPostingConfirmationController postingController = manualVisualProof
        ? ManualVisualProofFixture.CreatePostingController(
            postingState, session.Platforms.Select(platform => platform.Platform), out fixturePostingTransport)
        : new ManualPostingConfirmationController(
            postingTransport!, session.Platforms.Select(platform => platform.Platform));
    var recordingClipboard = new RecordingClipboard();
    using var windowShown = new ManualResetEventSlim();
    using var fixtureSettled = new ManualResetEventSlim(!manualVisualProof);
    IntPtr capturedMainWindow = IntPtr.Zero;
    var capturedNativeControls = new List<IntPtr>();
    var capturedIslandWindows = new List<IntPtr>();
    Thread? automationThread = null;
    NativeManualPublishingCompanion.NativeWindow? window = null;
    window = new NativeManualPublishingCompanion.NativeWindow(
        new ManualPublishingCompanionModel(session),
        new UnavailableAssets(),
        lifecycle,
        previewAccess: fixture?.PreviewAccess,
        confirmation: postingController,
        clipboardFactory: _ => recordingClipboard,
        winUiProofOptions: new WinUiHostProofOptions(
            TitleFixture,
            Fixture,
            manualVisualProof
                ? "Release ID: 4242   •   Server: creatorcrate.example   •   Manual publishing"
                : $"WP10C2 accessibility proof 1   •   Windows App SDK Runtime {RuntimePackageVersion}   •   WinUI {WinUiPackageVersion}   •   No server/network",
            Theme: manualVisualProof
                ? ManualVisualProofFixture.ElementTheme(proofTheme)
                : Microsoft.UI.Xaml.ElementTheme.Dark,
            FailAfterSurfaceCount: failAfter,
            MainWindowCreated: handle => capturedMainWindow = handle,
            NativeControlsCreated: handles => capturedNativeControls.AddRange(handles),
            InitialNativePalette: manualVisualProof ? ManualVisualProofFixture.Palette(proofTheme) : null,
            WindowShown: observeShownWindow ? (Action<IntPtr>)(handle =>
            {
                try
                {
                    DescribeChildren(handle);
                    if (productionSurfaceCheck)
                        VerifyProductionSurfaces(
                            window ?? throw new InvalidOperationException("Production window was not assigned."),
                            postingTransport ?? throw new InvalidOperationException("Controlled transport was not assigned."), recordingClipboard);
                    if (productionTextCheck)
                        VerifyProductionTextPresentation(
                            window ?? throw new InvalidOperationException("Production window was not assigned."), session);
                    if (themeCycleCheck)
                        VerifyWholeWindowThemeCycle(
                            window ?? throw new InvalidOperationException("Production window was not assigned."));
                    if (accessibilityCheck)
                    {
                        NativeManualPublishingCompanion.NativeWindow productionWindow = window ??
                            throw new InvalidOperationException("Production window was not assigned.");
                        VerifyAccessibilitySystemContracts(productionWindow);
                        automationThread = new Thread(() =>
                        {
                            try { ProductionUiaProbe.Verify(
                                productionWindow, postingController,
                                postingTransport ?? throw new InvalidOperationException("Controlled transport was not assigned."),
                                recordingClipboard); }
                            catch (Exception exception)
                            {
                                captureFailure = exception;
                                Console.WriteLine($"uia-failed={exception}");
                            }
                            finally { productionWindow.RequestClose(); }
                        });
                        automationThread.SetApartmentState(ApartmentState.MTA);
                        automationThread.Start();
                    }
                    if (resizeCheck)
                    {
                        foreach ((int width, int height) in new[] { (1200, 900), (940, 820) })
                        {
                            Console.WriteLine($"resize-check={width}x{height}");
                            if (!SetWindowPos(handle, IntPtr.Zero, 0, 0, width, height, 0x0004 | 0x0010))
                                throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
                            VerifyCurrentIslandBounds(handle,
                                window ?? throw new InvalidOperationException("Production window was not assigned."),
                                width, height);
                        }
                    }
                    if (manualVisualProof)
                    {
                        NativeManualPublishingCompanion.NativeWindow productionWindow = window ??
                            throw new InvalidOperationException("Production window was not assigned.");
                        Console.WriteLine($"manual-proof=true; posting-state={postingState}; theme={proofTheme}; platforms=patreon,x,bluesky");
                        Console.WriteLine($"asset-fixture=production-model; rows={session.Platforms[0].Assets.Count}; available={session.Platforms[0].Assets.Count(ManualPublishingCompanionModel.IsAvailable)}; unavailable={session.Platforms[0].Assets.Count(asset => !ManualPublishingCompanionModel.IsAvailable(asset))}; initially-selected={new ManualPublishingCompanionModel(session).SelectedAssets.Count}");
                        Console.WriteLine("preview-path=ManualAssetPreviewAccess->NativeAssetPreviewPipeline->NativeShellThumbnailExtractor->ListView/ImageList");
                        Console.WriteLine("network-used=false; drag-proof=excluded");
                        foreach (ManualPreparedPlatform platform in session.Platforms)
                        {
                            ManualPostingPlatformState state = postingController.GetState(platform.Platform);
                            Console.WriteLine($"posting-platform={platform.Platform}; state={state.Status}");
                        }
                        NativeProductionThemeProbe themed = productionWindow.ApplyThemeAndCapturePresentationForTesting(
                            ManualVisualProofFixture.Palette(proofTheme), checked((int)GetDpiForWindow(handle)));
                        NativeProductionTextSurfaceProbe text = productionWindow.CaptureTextSurfacesForTesting(0);
                        NativeAssetViewportProbe assets = productionWindow.CaptureAssetViewportForTesting();
                        if (assets.DisplayedAssetCount != 4 || assets.VisibleRowTarget != 4 ||
                            assets.Items.Any(item => item.Bottom > assets.ListClient.Bottom) ||
                            assets.ScrollMaximum - assets.ScrollMinimum + 1 > assets.ScrollPage)
                            throw new InvalidOperationException(
                                "The four-asset production fixture requires vertical ListView scrolling.");
                        Console.WriteLine($"whole-window-theme={themed.Mode}; native={themed.Mode}; winui={text.Theme}; hwnd-preserved=true");
                        Console.WriteLine($"asset-viewport=passed; rows={assets.DisplayedAssetCount}; visible={assets.VisibleRowTarget}; list-height={assets.ListWindow.Height}; header-height={assets.Header.Height}; row-height={assets.Items[0].Height}; vertical-scroll-required=false");
                        automationThread = new Thread(() =>
                        {
                            try
                            {
                                DateTime deadline = DateTime.UtcNow + TimeSpan.FromSeconds(10);
                                while (DateTime.UtcNow < deadline)
                                {
                                    IReadOnlyList<int?> images = productionWindow.CaptureAssetImagesForTesting();
                                    if (images.Count >= 2 && images[0] is >= 3 && images[1] is >= 3)
                                    {
                                        Console.WriteLine($"fixture-thumbnails=settled; real-thumbnails=2; image-indices={string.Join(',', images)}");
                                        return;
                                    }
                                    Thread.Sleep(25);
                                }
                                throw new TimeoutException("Fixture thumbnails did not settle through the production preview path.");
                            }
                            catch (Exception exception)
                            {
                                captureFailure = exception;
                                Console.WriteLine($"fixture-thumbnails=failed; error={exception.Message}");
                            }
                            finally { fixtureSettled.Set(); }
                        }) { IsBackground = true, Name = "Manual visual proof thumbnail readiness" };
                        automationThread.Start();
                    }
                    if (moduleProvenance) DescribeRuntimeModules();
                    if (capturePath is not null)
                        CompositorWindowCapture.CaptureAsync(handle, capturePath).GetAwaiter().GetResult();
                }
                catch (Exception exception)
                {
                    captureFailure = exception;
                    Console.WriteLine($"capture-failed={exception}");
                }
                finally
                {
                    windowShown.Set();
                    if (accessibilityCheck && automationThread is null)
                        window?.RequestClose();
                }
            }) : null,
            SurfaceCreated: handle => capturedIslandWindows.Add(handle)));

    if (closeBeforeReady) window.RequestClose();
    if (autoClose)
        _ = lifecycle.Ready.ContinueWith(
            _ =>
            {
                if (observeShownWindow && !windowShown.Wait(TimeSpan.FromSeconds(10)))
                    Console.WriteLine("window-shown timeout");
                if (manualVisualProof && !fixtureSettled.Wait(TimeSpan.FromSeconds(12)))
                    Console.WriteLine("fixture-settled timeout");
                window.RequestClose();
            },
            CancellationToken.None,
            TaskContinuationOptions.ExecuteSynchronously,
            TaskScheduler.Default);

    NativePresentationResult result = NativeOperatorUiHost.Show(
        proofDesktop ? new VisualProofDesktopNative() : new NativeOperatorUiHost.Native(),
        presentation => window.Run(presentation));
    if (automationThread is not null && !automationThread.Join(TimeSpan.FromSeconds(30)))
    {
        captureFailure = new TimeoutException("The production UI Automation probe did not finish.");
        window.RequestClose();
    }
    try { window.ShutdownAsync(new EmptyLease()).GetAwaiter().GetResult(); }
    catch { }

    bool cyclePassed;
    if (expectInitFailure && result.State == NativePresentationState.Failed && lifecycle.Ready.IsFaulted)
    {
        cyclePassed = true;
    }
    else if (result.State == NativePresentationState.PresentedAndDismissed && captureFailure is null)
    {
        cyclePassed = true;
    }
    else
    {
        cyclePassed = false;
        Console.WriteLine($"cycle={cycle + 1}; state={result.State}; stage={result.Stage}; win32={result.Win32Code}");
        if (lifecycle.Ready.Exception?.GetBaseException() is Exception exception)
            Console.WriteLine(exception);
    }

    bool mainDestroyed = capturedMainWindow != IntPtr.Zero && !IsWindow(capturedMainWindow) && window.WindowHandle == IntPtr.Zero;
    bool nativeControlsDestroyed = capturedNativeControls.All(handle => !IsWindow(handle));
    bool islandsDestroyed = capturedIslandWindows.All(handle => !IsWindow(handle));
    bool expectedNativeControlsObserved = !expectInitFailure || closeBeforeReady || capturedNativeControls.Count > 0;
    int expectedIslandCount = failAfter is 1 or 2 ? failAfter : 0;
    bool expectedIslandsObserved = !expectInitFailure || capturedIslandWindows.Count == expectedIslandCount;
    cyclePassed &= mainDestroyed && nativeControlsDestroyed && islandsDestroyed &&
        expectedNativeControlsObserved && expectedIslandsObserved;

    GC.Collect();
    GC.WaitForPendingFinalizers();
    GC.Collect();
    uint cycleUser = GuiResources(1);
    uint cycleGdi = GuiResources(0);
    resourceSamples.Add((cycleUser, cycleGdi));
    if (stabilizedUser is null)
    {
        stabilizedUser = cycleUser;
        stabilizedGdi = cycleGdi;
    }
    else
    {
        maximumUserGrowth = Math.Max(maximumUserGrowth, cycleUser > stabilizedUser.Value ? cycleUser - stabilizedUser.Value : 0);
        maximumGdiGrowth = Math.Max(maximumGdiGrowth, cycleGdi > stabilizedGdi!.Value ? cycleGdi - stabilizedGdi.Value : 0);
        if (expectInitFailure)
            cyclePassed &= cycleUser <= stabilizedUser.Value && cycleGdi <= stabilizedGdi.Value;
    }

    if (cyclePassed) completed++;
    else failed++;
    Console.WriteLine(
        $"cycle={cycle + 1}; passed={cyclePassed}; main-destroyed={mainDestroyed}; " +
        $"native-controls={capturedNativeControls.Count}; native-controls-destroyed={nativeControlsDestroyed}; " +
        $"islands={capturedIslandWindows.Count}; islands-destroyed={islandsDestroyed}; USER={cycleUser}; GDI={cycleGdi}");
}

GC.Collect();
GC.WaitForPendingFinalizers();
GC.Collect();

Console.WriteLine($"cycles={cycles}; completed={completed}; failed={failed}");
Console.WriteLine($"USER before={userBefore}; after={GuiResources(1)}");
Console.WriteLine($"GDI before={gdiBefore}; after={GuiResources(0)}");
bool resourcesStabilized = expectInitFailure
    ? maximumUserGrowth == 0 && maximumGdiGrowth == 0
    : resourceSamples.Count < 4 || resourceSamples.TakeLast(4).Distinct().Count() == 1;
Console.WriteLine(
    $"one-time-baseline USER={stabilizedUser}; GDI={stabilizedGdi}; " +
    $"maximum-above-first-cycle USER={maximumUserGrowth}; GDI={maximumGdiGrowth}; " +
    $"stabilized={resourcesStabilized}");
return failed == 0 && resourcesStabilized ? 0 : 2;

static void VerifyProductionSurfaces(
    NativeManualPublishingCompanion.NativeWindow window,
    ControlledPostingTransport postingTransport,
    RecordingClipboard clipboard)
{
    bool classicEditFound = false;
    EnumChildWindows(window.WindowHandle, (child, _) =>
    {
        var className = new System.Text.StringBuilder(64);
        GetClassName(child, className, className.Capacity);
        if (string.Equals(className.ToString(), "Edit", StringComparison.Ordinal)) classicEditFound = true;
        return true;
    }, IntPtr.Zero);
    if (classicEditFound) throw new InvalidOperationException("A classic social content Edit HWND still exists.");

    IntPtr? titleWindow = null, bodyWindow = null;
    NativeProductionLayoutProbe minimum = window.ResizeAndCaptureLayoutForTesting(0, 820, 754);
    NativeProductionLayoutProbe normal = window.ResizeAndCaptureLayoutForTesting(0, 980, 920);
    NativeProductionLayoutProbe large = window.ResizeAndCaptureLayoutForTesting(0, 980, 1400);
    NativeProductionLayoutProbe wide = window.ResizeAndCaptureLayoutForTesting(0, 1600, 920);
    if (normal.BodyText.Height <= minimum.BodyText.Height ||
        large.BodyText.Height > 240 * large.Dpi / 96 || large.AssetsCard.Height > 440 * large.Dpi / 96 ||
        wide.PlatformCard.Width != 1152 * wide.Dpi / 96 ||
        wide.PlatformCard.X != (wide.Client.Width - wide.PlatformCard.Width) / 2)
        throw new InvalidOperationException("Production minimum/normal/large/wide growth failed.");
    Console.WriteLine($"production-layout-growth=passed; minimum-body={minimum.BodyText.Height}; normal-body={normal.BodyText.Height}; large-body={large.BodyText.Height}; large-assets={large.AssetsCard.Height}; wide-card={wide.PlatformCard.X},{wide.PlatformCard.Width}");
    foreach ((int index, string platform) in new[] { (0, "patreon"), (1, "x"), (2, "bluesky"), (0, "patreon") })
    {
        NativeProductionTextSurfaceProbe surface = window.CaptureTextSurfacesForTesting(index);
        NativeProductionLayoutProbe layout = window.ResizeToMinimumAndCaptureLayoutForTesting(index);
        if (surface.Platform != platform || surface.SurfaceCount != 2 ||
            !surface.TitleIsReadOnly || !surface.BodyIsReadOnly ||
            !surface.TitleColorFontEnabled || !surface.BodyColorFontEnabled)
            throw new InvalidOperationException($"Invalid production surface configuration for {platform}.");
        if (platform == "patreon")
        {
            if (!surface.TitleVisible || !surface.TitleIsTabStop ||
                surface.TitleAccessibleName != "Patreon title" || surface.BodyAccessibleName != "Patreon body")
                throw new InvalidOperationException("Invalid Patreon production surface state.");
        }
        else
        {
            string expectedName = platform == "x" ? "X post text" : "Bluesky post text";
            if (surface.TitleVisible || surface.TitleIsTabStop || surface.BodyAccessibleName != expectedName)
                throw new InvalidOperationException($"Invalid {platform} production surface state.");
        }
        if (!surface.BodyText.Contains("👩🏽‍💻", StringComparison.Ordinal))
            throw new InvalidOperationException($"The approved emoji fixture did not reach the {platform} RichEditBox.");

        AssertWithin(layout.BodyText, layout.PlatformCard, $"{platform} body");
        if (layout.BodyText.Intersects(layout.CopyMain) || layout.BodyText.Intersects(layout.AssetsCard) ||
            layout.BodyText.Intersects(layout.PostingAction))
            throw new InvalidOperationException($"The {platform} body island overlaps production controls.");
        if (platform == "patreon")
        {
            AssertWithin(layout.TitleText, layout.PlatformCard, "Patreon title");
            if (layout.TitleText.Intersects(layout.CopyTitle) || layout.TitleText.Intersects(layout.AssetsCard))
                throw new InvalidOperationException("The Patreon title island overlaps production controls.");
        }

        titleWindow ??= surface.TitleWindow;
        bodyWindow ??= surface.BodyWindow;
        if (titleWindow != surface.TitleWindow || bodyWindow != surface.BodyWindow)
            throw new InvalidOperationException("Production platform switching recreated a WinUI island.");
        Console.WriteLine($"production-surface={platform}; title-visible={surface.TitleVisible}; body-name={surface.BodyAccessibleName}; body-bounds={layout.BodyText.X},{layout.BodyText.Y},{layout.BodyText.Width},{layout.BodyText.Height}");
    }
    NativeProductionKeyboardProbe keyboard = window.CaptureKeyboardIntegrationForTesting();
    if (!keyboard.PostingActionRequiredAndReady ||
        !keyboard.PatreonForwardTraversal || !keyboard.PatreonReverseTraversal ||
        !keyboard.XForwardTraversal || !keyboard.XReverseTraversal ||
        !keyboard.BlueskyForwardTraversal || !keyboard.BlueskyReverseTraversal ||
        !keyboard.EnterPreservedPostingStateAndText || !keyboard.WindowRemainedAlive)
        throw new InvalidOperationException($"Production keyboard integration failed: {keyboard}.");
    NativePostingActionProbe posting = window.CapturePostingActionForTesting();
    if (posting.Handle == IntPtr.Zero || !posting.IsWindow || !posting.Visible || !posting.Enabled ||
        posting.Text != "Mark as posted")
        throw new InvalidOperationException($"The required production posting action is invalid: {posting}.");
    if (postingTransport.PostCalls != 0 || postingTransport.GetCalls != 0 || clipboard.Values.Count != 0)
        throw new InvalidOperationException("RichEditBox Enter invoked posting or Copy through the controlled seams.");
    VerifyPresentationThemeCycle(window);
    VerifyWholeWindowThemeCycle(window);
    Console.WriteLine(
        $"posting-action-required=true; hwnd=0x{posting.Handle.ToInt64():X}; is-window=true; visible=true; enabled=true; text={posting.Text}");
    Console.WriteLine("ready-forward-tab=passed; platforms=patreon,x,bluesky; posting-and-native-controls=included");
    Console.WriteLine("ready-reverse-tab=passed; platforms=patreon,x,bluesky; hidden-patreon-title-excluded=true");
    Console.WriteLine("richedit-enter=passed; real-posting-action=true; posting-requests=0; copy-invocations=0; window-alive=true");
    Console.WriteLine("production-surface-check=passed; shared-surfaces=2; classic-edits=0; minimum-containment=passed; tab-order=passed; enter-safety=passed");
}

static void VerifyWholeWindowThemeCycle(NativeManualPublishingCompanion.NativeWindow window)
{
    NativeProductionThemeProbe dark = window.ApplyThemeAndCapturePresentationForTesting(
        NativeCompanionPalette.Dark, 96);
    NativeProductionTextSurfaceProbe darkText = window.CaptureTextSurfacesForTesting(0);
    window.SetBodyTextSelectionForTesting(2, 9);
    darkText = window.CaptureCurrentTextSurfacesForTesting();
    NativeProductionThemeProbe light = window.ApplyThemeAndCapturePresentationForTesting(
        NativeCompanionPalette.Light, 144);
    NativeProductionTextSurfaceProbe lightText = window.CaptureCurrentTextSurfacesForTesting();
    NativeProductionThemeProbe highContrast = window.ApplyThemeAndCapturePresentationForTesting(
        NativeCompanionPalette.HighContrast, 192);
    NativeProductionTextSurfaceProbe highContrastText = window.CaptureCurrentTextSurfacesForTesting();
    NativeProductionThemeProbe restored = window.ApplyThemeAndCapturePresentationForTesting(
        NativeCompanionPalette.Dark, 96);
    NativeProductionTextSurfaceProbe restoredText = window.CaptureCurrentTextSurfacesForTesting();
    NativeProductionThemeProbe highContrastAgain = window.ApplyThemeAndCapturePresentationForTesting(
        NativeCompanionPalette.HighContrast, 192);
    NativeProductionTextSurfaceProbe highContrastAgainText = window.CaptureCurrentTextSurfacesForTesting();
    NativeProductionThemeProbe lightRestored = window.ApplyThemeAndCapturePresentationForTesting(
        NativeCompanionPalette.Light, 144);
    NativeProductionTextSurfaceProbe lightRestoredText = window.CaptureCurrentTextSurfacesForTesting();

    IntPtr[] Handles(NativeProductionThemeProbe probe) =>
    [
        probe.Window, probe.Platform, probe.AssetList, probe.AssetHeader,
        probe.TitleIsland, probe.BodyIsland,
        .. probe.Controls.Select(control => control.Handle),
    ];
    if (!Handles(dark).SequenceEqual(Handles(light)) ||
        !Handles(dark).SequenceEqual(Handles(highContrast)) ||
        !Handles(dark).SequenceEqual(Handles(restored)) ||
        !Handles(dark).SequenceEqual(Handles(highContrastAgain)) ||
        !Handles(dark).SequenceEqual(Handles(lightRestored)))
        throw new InvalidOperationException("Whole-window theme refresh recreated a native control or WinUI island.");
    if (dark.AssetListBackground != dark.NestedStyle.Background ||
        light.AssetListBackground != light.NestedStyle.Background ||
        restored.AssetListBackground != restored.NestedStyle.Background ||
        !dark.SectionStyle.Decorative || !light.SectionStyle.Decorative ||
        highContrast.SectionStyle.Decorative || highContrast.SectionStyle.Radius != 0)
        throw new InvalidOperationException("Whole-window surface hierarchy or High Contrast bypass is invalid.");
    DescribeThemeStage("Dark", dark, darkText);
    DescribeThemeStage("Light", light, lightText);
    DescribeThemeStage("HighContrast/Default", highContrast, highContrastText);
    DescribeThemeStage("Dark restored", restored, restoredText);
    DescribeThemeStage("HighContrast/Default before Light restore", highContrastAgain, highContrastAgainText);
    DescribeThemeStage("Light restored", lightRestored, lightRestoredText);

    AssertThemeStage("Dark", dark, darkText, NativeCompanionThemeMode.Dark,
        Microsoft.UI.Xaml.ElementTheme.Dark,
        "#171b22", "#1d222b", "#e8ecf1", "#262c37", "#3a4353", "#58a6ff");
    AssertThemeStage("Light", light, lightText, NativeCompanionThemeMode.Light,
        Microsoft.UI.Xaml.ElementTheme.Light,
        "#ffffff", "#f8fafc", "#17202b", "#d7dee8", "#aab6c5", "#0969da");
    AssertHighContrastStage("HighContrast/Default", highContrast, highContrastText);
    AssertThemeStage("Dark restored", restored, restoredText, NativeCompanionThemeMode.Dark,
        Microsoft.UI.Xaml.ElementTheme.Dark,
        "#171b22", "#1d222b", "#e8ecf1", "#262c37", "#3a4353", "#58a6ff");
    AssertHighContrastStage(
        "HighContrast/Default before Light restore", highContrastAgain, highContrastAgainText);
    AssertThemeStage("Light restored", lightRestored, lightRestoredText, NativeCompanionThemeMode.Light,
        Microsoft.UI.Xaml.ElementTheme.Light,
        "#ffffff", "#f8fafc", "#17202b", "#d7dee8", "#aab6c5", "#0969da");

    foreach (NativeProductionTextSurfaceProbe stage in new[]
             { lightText, highContrastText, restoredText, highContrastAgainText, lightRestoredText })
    {
        AssertThemeValue("content", "host", "platform", darkText.Platform, stage.Platform);
        AssertThemeValue("content", "title", "text", darkText.TitleText, stage.TitleText);
        AssertThemeValue("content", "body", "text", darkText.BodyText, stage.BodyText);
        AssertThemeValue("content", "title", "selection", darkText.TitleSelection, stage.TitleSelection);
        AssertThemeValue("content", "body", "selection", darkText.BodySelection, stage.BodySelection);
    }

    foreach ((NativeProductionThemeProbe probe, int dpi) in new[]
             { (dark, 96), (light, 144), (highContrast, 192), (restored, 96),
               (highContrastAgain, 192), (lightRestored, 144) })
    {
        foreach (NativeProductionControlPresentationProbe control in probe.Controls)
        {
            NativeCompanionFontSpec spec = NativeCompanionTheme.FontSpec(control.FontRole);
            if (control.FontFamily != "Segoe UI" ||
                control.FontHeight != -(spec.LogicalPixelHeight * dpi / 96) ||
                control.FontWeight != spec.Weight)
                throw new InvalidOperationException($"Production native font role is invalid: {control}.");
        }
    }

    uint userBeforeRepeatedThemes = GuiResources(1);
    uint gdiBeforeRepeatedThemes = GuiResources(0);
    for (int cycle = 0; cycle < 5; cycle++)
    {
        NativeProductionThemeProbe repeatedHighContrast = window.ApplyThemeAndCapturePresentationForTesting(
            NativeCompanionPalette.HighContrast, 192);
        NativeProductionTextSurfaceProbe repeatedHighContrastText = window.CaptureCurrentTextSurfacesForTesting();
        AssertHighContrastStage($"Repeated HighContrast/Default {cycle + 1}",
            repeatedHighContrast, repeatedHighContrastText);
        NativeProductionThemeProbe repeatedDark = window.ApplyThemeAndCapturePresentationForTesting(
            NativeCompanionPalette.Dark, 96);
        NativeProductionTextSurfaceProbe repeatedDarkText = window.CaptureCurrentTextSurfacesForTesting();
        AssertThemeStage($"Repeated Dark {cycle + 1}", repeatedDark, repeatedDarkText,
            NativeCompanionThemeMode.Dark, Microsoft.UI.Xaml.ElementTheme.Dark,
            "#171b22", "#1d222b", "#e8ecf1", "#262c37", "#3a4353", "#58a6ff");
        if (!Handles(dark).SequenceEqual(Handles(repeatedDark)))
            throw new InvalidOperationException($"Repeated theme cycle {cycle + 1} recreated a native control or WinUI island.");
        AssertThemeValue($"Repeated Dark {cycle + 1}", "content", "body-selection",
            darkText.BodySelection, repeatedDarkText.BodySelection);
    }
    uint userAfterRepeatedThemes = GuiResources(1);
    uint gdiAfterRepeatedThemes = GuiResources(0);
    AssertThemeValue("Repeated themes", "process", "USER objects", userBeforeRepeatedThemes, userAfterRepeatedThemes);
    AssertThemeValue("Repeated themes", "process", "GDI objects", gdiBeforeRepeatedThemes, gdiAfterRepeatedThemes);

    Console.WriteLine("whole-window-theme-cycle=Dark->Light->HighContrast->Dark; hwnd-and-islands=same; content-and-selection=same; native-font-roles=passed; surface-hierarchy=passed; high-contrast-bypass=passed");
    Console.WriteLine("whole-window-theme-cycle=Dark->HighContrast->Light; hwnd-and-islands=same; content-and-selection=same; resources-current=passed");
    Console.WriteLine("theme-resource-lifetime=passed; repeated-same-island-cycles=5; USER-growth=0; GDI-growth=0");
}

static void DescribeThemeStage(
    string stage,
    NativeProductionThemeProbe native,
    NativeProductionTextSurfaceProbe text)
{
    Console.WriteLine(
        $"theme-stage={stage}; native-mode={native.Mode}; winui-theme={text.Theme}; " +
        $"title-island=0x{text.TitleWindow.ToInt64():X}; body-island=0x{text.BodyWindow.ToInt64():X}; " +
        $"platform={text.Platform}; title-selection={text.TitleSelection}; body-selection={text.BodySelection}");
    DescribeResourceSurface(stage, "title", text.TitleResources);
    DescribeResourceSurface(stage, "body", text.BodyResources);
}

static void DescribeResourceSurface(
    string stage, string surface, WinUiTextSurfaceResourceProbe resources) =>
    Console.WriteLine(
        $"theme-resource-stage={stage}; surface={surface}; root={resources.RootBackground}; " +
        $"editor={resources.Background}; foreground={resources.Foreground}; border={resources.Border}; " +
        $"pointer-border={resources.PointerBorder}; focus-border={resources.FocusBorder}; " +
        $"decorative={resources.HasDecorativeResourceOverrides}; " +
        $"local-editor-brushes={resources.HasLocalEditorBrushValues}");

static void AssertThemeStage(
    string stage,
    NativeProductionThemeProbe native,
    NativeProductionTextSurfaceProbe text,
    NativeCompanionThemeMode expectedNativeMode,
    Microsoft.UI.Xaml.ElementTheme expectedTheme,
    string root, string background, string foreground,
    string border, string pointerBorder, string focusBorder)
{
    AssertThemeValue(stage, "native", "mode", expectedNativeMode, native.Mode);
    AssertThemeValue(stage, "WinUI", "requested-theme", expectedTheme, text.Theme);
    AssertThemeResources(stage, "title", text.TitleResources,
        root, background, foreground, border, pointerBorder, focusBorder);
    AssertThemeResources(stage, "body", text.BodyResources,
        root, background, foreground, border, pointerBorder, focusBorder);
}

static void AssertThemeResources(
    string stage, string surface, WinUiTextSurfaceResourceProbe actual,
    string root, string background, string foreground,
    string border, string pointerBorder, string focusBorder)
{
    AssertThemeValue(stage, surface, "decorative-overrides", true, actual.HasDecorativeResourceOverrides);
    AssertThemeValue(stage, surface, "local-editor-brushes", true, actual.HasLocalEditorBrushValues);
    AssertThemeValue(stage, surface, "root-background", root, actual.RootBackground);
    AssertThemeValue(stage, surface, "editor-background", background, actual.Background);
    AssertThemeValue(stage, surface, "foreground", foreground, actual.Foreground);
    AssertThemeValue(stage, surface, "border", border, actual.Border);
    AssertThemeValue(stage, surface, "pointer-border", pointerBorder, actual.PointerBorder);
    AssertThemeValue(stage, surface, "focus-border", focusBorder, actual.FocusBorder);
}

static void AssertHighContrastStage(
    string stage, NativeProductionThemeProbe native, NativeProductionTextSurfaceProbe text)
{
    AssertThemeValue(stage, "native", "mode", NativeCompanionThemeMode.HighContrast, native.Mode);
    AssertThemeValue(stage, "WinUI", "requested-theme", Microsoft.UI.Xaml.ElementTheme.Default, text.Theme);
    foreach ((string surface, WinUiTextSurfaceResourceProbe actual) in new[]
             { ("title", text.TitleResources), ("body", text.BodyResources) })
    {
        AssertThemeValue(stage, surface, "decorative-overrides", false, actual.HasDecorativeResourceOverrides);
        AssertThemeValue(stage, surface, "local-editor-brushes", false, actual.HasLocalEditorBrushValues);
        AssertThemeValue(stage, surface, "root-background", string.Empty, actual.RootBackground);
        if (actual.Background.Length == 0 || actual.Foreground.Length == 0 || actual.Border.Length == 0)
            throw new InvalidOperationException(
                $"Theme mismatch: stage={stage}; surface={surface}; property=system-owned-editor-resources; " +
                $"expected=non-empty system values; actual=background:{actual.Background},foreground:{actual.Foreground},border:{actual.Border}.");
    }
}

static void AssertThemeValue<T>(
    string stage, string surface, string property, T expected, T actual)
{
    if (!EqualityComparer<T>.Default.Equals(expected, actual))
        throw new InvalidOperationException(
            $"Theme mismatch: stage={stage}; surface={surface}; property={property}; expected={expected}; actual={actual}.");
}

static void VerifyPresentationThemeCycle(NativeManualPublishingCompanion.NativeWindow window)
{
    NativeProductionTextSurfaceProbe dark = window.CaptureTextSurfacesForTesting(0);
    AssertPresentation(dark.Presentation, Microsoft.UI.Xaml.ElementTheme.Dark,
        "#171b22", "#1d222b", "#e8ecf1", "#262c37", "#3a4353", "#58a6ff");

    window.SetTextSurfaceThemeForTesting(Microsoft.UI.Xaml.ElementTheme.Light);
    NativeProductionTextSurfaceProbe light = window.CaptureTextSurfacesForTesting(0);
    AssertPresentation(light.Presentation, Microsoft.UI.Xaml.ElementTheme.Light,
        "#ffffff", "#f8fafc", "#17202b", "#d7dee8", "#aab6c5", "#0969da");

    window.SetTextSurfaceThemeForTesting(Microsoft.UI.Xaml.ElementTheme.Dark);
    NativeProductionTextSurfaceProbe darkAgain = window.CaptureTextSurfacesForTesting(0);
    AssertPresentation(darkAgain.Presentation, Microsoft.UI.Xaml.ElementTheme.Dark,
        "#171b22", "#1d222b", "#e8ecf1", "#262c37", "#3a4353", "#58a6ff");

    if (dark.TitleWindow != light.TitleWindow || dark.BodyWindow != light.BodyWindow ||
        dark.TitleWindow != darkAgain.TitleWindow || dark.BodyWindow != darkAgain.BodyWindow ||
        dark.TitleText != light.TitleText || dark.BodyText != light.BodyText ||
        dark.TitleText != darkAgain.TitleText || dark.BodyText != darkAgain.BodyText ||
        dark.Platform != light.Platform || dark.Platform != darkAgain.Platform)
        throw new InvalidOperationException("Dark-Light-Dark presentation refresh recreated an island or changed its content/platform.");

    Console.WriteLine("presentation-theme-cycle=Dark->Light->Dark; islands=same; content=same; platform=same; resources=current");
}

static void VerifyAccessibilitySystemContracts(NativeManualPublishingCompanion.NativeWindow window)
{
    NativeProductionTextSurfaceProbe original = window.CaptureTextSurfacesForTesting(0);
    if (!original.TitleTextScaleEnabled || !original.BodyTextScaleEnabled ||
        !original.Presentation.TitleTextScaleEnabled || !original.Presentation.BodyTextScaleEnabled ||
        original.Presentation.TitleFontSize != 16 || original.Presentation.BodyFontSize != 16)
        throw new InvalidOperationException("Production RichEditBox text scaling is disabled or FontSize is not defined in effective pixels.");

    window.SetTextSurfaceThemeForTesting(Microsoft.UI.Xaml.ElementTheme.Default);
    NativeProductionTextSurfaceProbe highContrast = window.CaptureTextSurfacesForTesting(0);
    if (highContrast.Theme != Microsoft.UI.Xaml.ElementTheme.Default ||
        highContrast.Presentation.HasDecorativeResourceOverrides ||
        highContrast.Presentation.HasLocalEditorBrushValues ||
        highContrast.Presentation.RootBackground.Length != 0 ||
        highContrast.Presentation.Background.Length == 0 ||
        highContrast.Presentation.Foreground.Length == 0 ||
        highContrast.Presentation.Border.Length == 0)
        throw new InvalidOperationException($"High Contrast left CreatorCrate resources active: {highContrast.Presentation}.");

    window.SetTextSurfaceThemeForTesting(Microsoft.UI.Xaml.ElementTheme.Dark);
    NativeProductionTextSurfaceProbe restored = window.CaptureTextSurfacesForTesting(0);
    if (restored.TitleWindow != original.TitleWindow || restored.BodyWindow != original.BodyWindow ||
        restored.TitleText != original.TitleText || restored.BodyText != original.BodyText)
        throw new InvalidOperationException("Accessibility theme refresh recreated an island or changed content.");
    if (!restored.Presentation.HasDecorativeResourceOverrides ||
        restored.Presentation.RootBackground != "#171b22" ||
        restored.Presentation.PointerBorder != "#3a4353" ||
        restored.Presentation.FocusBorder != "#58a6ff")
        throw new InvalidOperationException("CreatorCrate resources were not restored after the High Contrast contract check.");

    try
    {
        double factor = new Windows.UI.ViewManagement.UISettings().TextScaleFactor;
        Console.WriteLine($"windows-text-scale-factor={factor:0.###}; source=UISettings; production-font-size=16-effective-pixels; winui-scaling-enabled=true");
    }
    catch (Exception exception)
    {
        Console.WriteLine($"windows-text-scale-factor=unavailable; optional-api={exception.GetType().Name}; winui-scaling-enabled=true");
    }
    Console.WriteLine("high-contrast-contract=passed; requested-theme=Default; decorative-resources=cleared; islands=same; content=same; dark-resources=restored");
}

static void AssertPresentation(
    WinUiTextSurfacePresentationProbe presentation,
    Microsoft.UI.Xaml.ElementTheme expectedTheme,
    string root, string background, string foreground,
    string border, string pointerBorder, string focusBorder)
{
    if (presentation.FontFamily != WinUiTextSurfacePresentation.FontFamily ||
        presentation.TitleFontSize != WinUiTextSurfacePresentation.TitleFontSize ||
        presentation.TitleFontWeight != WinUiTextSurfacePresentation.TitleFontWeight ||
        presentation.BodyFontSize != WinUiTextSurfacePresentation.BodyFontSize ||
        presentation.BodyFontWeight != WinUiTextSurfacePresentation.BodyFontWeight ||
        presentation.Padding != new Microsoft.UI.Xaml.Thickness(12, 8, 12, 8) ||
        presentation.BorderThickness != new Microsoft.UI.Xaml.Thickness(1) ||
        presentation.CornerRadius != new Microsoft.UI.Xaml.CornerRadius(6) ||
        presentation.TextWrapping != Microsoft.UI.Xaml.TextWrapping.Wrap ||
        presentation.VerticalScrollBarVisibility != Microsoft.UI.Xaml.Controls.ScrollBarVisibility.Auto ||
        presentation.HorizontalScrollBarVisibility != Microsoft.UI.Xaml.Controls.ScrollBarVisibility.Disabled ||
        presentation.LineSpacingRule != Microsoft.UI.Text.LineSpacingRule.Multiple ||
        Math.Abs(presentation.LineSpacing - 1.35f) > 0.001f ||
        presentation.SpaceBefore != 0 || presentation.SpaceAfter != 0 ||
        !presentation.UsesSystemFocusVisuals || !presentation.TitleTextScaleEnabled ||
        !presentation.BodyTextScaleEnabled || !presentation.HasDecorativeResourceOverrides ||
        presentation.OverridesSelectionHighlight ||
        presentation.RootBackground != root || presentation.Background != background ||
        presentation.Foreground != foreground || presentation.Border != border ||
        presentation.PointerBorder != pointerBorder || presentation.FocusBorder != focusBorder)
        throw new InvalidOperationException($"Invalid {expectedTheme} WinUI presentation configuration: {presentation}.");
}

static void VerifyProductionTextPresentation(
    NativeManualPublishingCompanion.NativeWindow window,
    ManualSocialSession session)
{
    IntPtr? titleWindow = null;
    IntPtr? bodyWindow = null;
    foreach ((int index, string platform) in new[] { (0, "patreon"), (1, "x"), (2, "bluesky"), (0, "patreon") })
    {
        ManualPreparedPlatform model = session.Platforms[index];
        NativeProductionTextSurfaceProbe surface = window.CaptureTextSurfacesForTesting(index);
        if (!string.Equals(surface.Platform, platform, StringComparison.Ordinal))
            throw new InvalidOperationException($"Wrong platform content was selected: expected {platform}, actual {surface.Platform}.");

        AssertRichEditDocument(surface.BodyText, NativeTextPresentation.DisplayText(model.Body), $"{platform} body");
        if (platform == "patreon")
        {
            if (!surface.TitleVisible)
                throw new InvalidOperationException("The Patreon title RichEditBox is hidden.");
            AssertRichEditDocument(surface.TitleText, NativeTextPresentation.DisplayText(model.Title), "patreon title");
        }
        else if (surface.TitleVisible)
        {
            throw new InvalidOperationException($"The {platform} title RichEditBox is visible.");
        }

        titleWindow ??= surface.TitleWindow;
        bodyWindow ??= surface.BodyWindow;
        if (titleWindow != surface.TitleWindow || bodyWindow != surface.BodyWindow)
            throw new InvalidOperationException("Platform switching recreated a production RichEditBox island.");
    }

    if (session.Platforms[0].Title != TitleFixture || session.Platforms[0].Body != Fixture ||
        session.Platforms[1].Body != XFixture || session.Platforms[2].Body != BlueskyFixture)
        throw new InvalidOperationException("Production presentation mutated immutable model text.");

    var clipboard = new RecordingClipboard();
    var modelCopy = new ManualPublishingCompanionModel(session);
    if (!modelCopy.TryCopy(ManualCopyCommand.Title, clipboard) ||
        !modelCopy.TryCopy(ManualCopyCommand.Body, clipboard))
        throw new InvalidOperationException("Patreon model-backed Copy failed.");
    modelCopy.SelectPlatform(1);
    if (!modelCopy.TryCopy(ManualCopyCommand.Post, clipboard))
        throw new InvalidOperationException("X model-backed Copy failed.");
    modelCopy.SelectPlatform(2);
    if (!modelCopy.TryCopy(ManualCopyCommand.Post, clipboard))
        throw new InvalidOperationException("Bluesky model-backed Copy failed.");
    string[] expectedCopies = [TitleFixture, Fixture, XFixture, BlueskyFixture];
    if (!clipboard.Values.SequenceEqual(expectedCopies, StringComparer.Ordinal))
        throw new InvalidOperationException("Copy did not preserve the original model strings exactly.");

    Console.WriteLine(
        "production-text-check=passed; platforms=patreon-title,patreon-body,x,bluesky; " +
        "blank-leading-trailing-lines=preserved; unicode-code-units=preserved; " +
        "platform-switch=shared-surfaces; copy=exact-model-text");
}

static void AssertRichEditDocument(string actualReadback, string expectedPresentation, string name)
{
    string expectedLogical = NormalizeRichEditNewlines(expectedPresentation);
    string actualLogical = NormalizeRichEditNewlines(actualReadback);

    // RichEditBox's text document exposes its final paragraph mark as one extra CR.
    // Remove only that control-owned sentinel; all model-owned leading, blank, and trailing lines remain asserted.
    bool hadImplicitFinalParagraph = actualLogical == expectedLogical + "\n";
    if (hadImplicitFinalParagraph) actualLogical = actualLogical[..^1];
    if (!string.Equals(expectedLogical, actualLogical, StringComparison.Ordinal))
        throw new InvalidOperationException(
            $"The {name} RichEditBox document differs from presentation text. " +
            $"Expected {DescribeCodeUnits(expectedLogical)}, actual {DescribeCodeUnits(actualLogical)}.");
    Console.WriteLine(
        $"richedit-document={name}; readback-newlines={DescribeNewlines(actualReadback)}; " +
        $"implicit-final-paragraph={hadImplicitFinalParagraph}; logical-code-units={actualLogical.Length}");
}

static string NormalizeRichEditNewlines(string text)
{
    var normalized = new System.Text.StringBuilder(text.Length);
    for (int index = 0; index < text.Length; index++)
    {
        if (text[index] == '\r')
        {
            if (index + 1 < text.Length && text[index + 1] == '\n') index++;
            normalized.Append('\n');
        }
        else normalized.Append(text[index]);
    }
    return normalized.ToString();
}

static string DescribeCodeUnits(string text) =>
    $"length={text.Length}, value={text.Replace("\r", "<CR>", StringComparison.Ordinal).Replace("\n", "<LF>", StringComparison.Ordinal)}";

static string DescribeNewlines(string text)
{
    bool crlf = text.Contains("\r\n", StringComparison.Ordinal);
    bool loneCr = false;
    bool loneLf = false;
    for (int index = 0; index < text.Length; index++)
    {
        if (text[index] == '\r')
        {
            if (index + 1 < text.Length && text[index + 1] == '\n') index++;
            else loneCr = true;
        }
        else if (text[index] == '\n') loneLf = true;
    }
    return $"crlf={crlf},lone-cr={loneCr},lone-lf={loneLf}";
}

static void AssertWithin(NativeLayoutRect actual, NativeLayoutRect container, string name)
{
    if (actual.Width <= 0 || actual.Height <= 0 || actual.X < container.X || actual.Y < container.Y ||
        actual.Right > container.Right || actual.Bottom > container.Bottom)
        throw new InvalidOperationException($"{name} is outside the Platform Content card.");
}

static void VerifyCurrentIslandBounds(
    IntPtr parent, NativeManualPublishingCompanion.NativeWindow window, int outerWidth, int outerHeight)
{
    if (!GetClientRect(parent, out Rect client)) throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
    int dpi = checked((int)GetDpiForWindow(parent));
    foreach ((int index, bool patreon) in new[] { (0, true), (1, false), (2, false) })
    {
        NativeProductionTextSurfaceProbe surface = window.CaptureTextSurfacesForTesting(index);
        NativeAuthoritativeTextLayoutProbe authoritative = window.CaptureAuthoritativeTextLayoutForTesting();
        if (authoritative.Platform != surface.Platform || authoritative.TitleVisible != patreon)
            throw new InvalidOperationException($"Authoritative text layout state does not match {surface.Platform}.");
        NativeLayoutRect body = ChildRect(parent, surface.BodyWindow);
        if (body != authoritative.BodyText)
            throw new InvalidOperationException(
                $"Stale body island after resize for {surface.Platform}: authoritative {authoritative.BodyText}, actual {body}.");
        NativeLayoutRect title = ChildRect(parent, surface.TitleWindow);
        if (title != authoritative.TitleText || surface.TitleVisible != patreon)
            throw new InvalidOperationException(
                $"Stale title island after resize for {surface.Platform}: authoritative {authoritative.TitleText}, actual {title}, visible={surface.TitleVisible}.");
        if (!patreon && authoritative.TitleText != default)
            throw new InvalidOperationException($"Hidden {surface.Platform} title layout was not zeroed: {authoritative.TitleText}.");
        if (outerWidth == 1200 && outerHeight == 900 && authoritative.BodyText.Height != 240 * dpi / 96)
            throw new InvalidOperationException(
                $"The 1200x900 authoritative body height was {authoritative.BodyText.Height}, expected {240 * dpi / 96} at {dpi} DPI.");
        Console.WriteLine(
            $"resize-island-platform={surface.Platform}; authoritative-body={authoritative.BodyText}; actual-body={body}; " +
            $"authoritative-title={authoritative.TitleText}; actual-title={title}; title-visible={surface.TitleVisible}; immediate=true");
    }
    Console.WriteLine($"resize-island-bounds=passed; outer={outerWidth}x{outerHeight}; client={client.Right}x{client.Bottom}; dpi={dpi}; source=production-layout; immediate=true");
}

static NativeLayoutRect ChildRect(IntPtr parent, IntPtr child)
{
    if (!GetWindowRect(child, out Rect rectangle)) throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
    var points = new[] { new Point { X = rectangle.Left, Y = rectangle.Top }, new Point { X = rectangle.Right, Y = rectangle.Bottom } };
    MapWindowPoints(IntPtr.Zero, parent, points, 2);
    return new(points[0].X, points[0].Y, points[1].X - points[0].X, points[1].Y - points[0].Y);
}

int ArgumentValue(string name, int fallback)
{
    string prefix = name + "=";
    string? value = args.FirstOrDefault(argument => argument.StartsWith(prefix, StringComparison.Ordinal));
    return value is not null && int.TryParse(value[prefix.Length..], out int parsed) ? parsed : fallback;
}

string? ArgumentString(string name)
{
    string prefix = name + "=";
    string? value = args.FirstOrDefault(argument => argument.StartsWith(prefix, StringComparison.Ordinal));
    return value?[prefix.Length..];
}

static string FindRepositoryRoot()
{
    DirectoryInfo? current = new(AppContext.BaseDirectory);
    while (current is not null)
    {
        if (File.Exists(Path.Combine(current.FullName, "helper", "windows", "CreatorCrate.OpenLocally.sln")))
            return current.FullName;
        current = current.Parent;
    }
    throw new DirectoryNotFoundException("CreatorCrate repository root was not found.");
}

static void DescribeChildren(IntPtr parent)
{
    EnumChildWindows(parent, (window, _) =>
    {
        var className = new System.Text.StringBuilder(256);
        GetClassName(window, className, className.Capacity);
        GetWindowRect(window, out Rect rect);
        Console.WriteLine(
            $"child=0x{window.ToInt64():X}; class={className}; visible={IsWindowVisible(window)}; " +
            $"rect={rect.Left},{rect.Top},{rect.Right - rect.Left},{rect.Bottom - rect.Top}");
        return true;
    }, IntPtr.Zero);
}

static void DescribeRuntimeModules()
{
    string[] prefixes =
        ["Microsoft.UI", "Microsoft.WindowsAppRuntime", "WinUIEdit", "vcruntime", "msvcp", "ucrtbase"];
    foreach (ProcessModule module in Process.GetCurrentProcess().Modules.Cast<ProcessModule>()
        .Where(module => prefixes.Any(prefix => module.ModuleName.StartsWith(prefix, StringComparison.OrdinalIgnoreCase)))
        .OrderBy(module => module.ModuleName, StringComparer.OrdinalIgnoreCase))
        Console.WriteLine($"module={module.ModuleName}; path={module.FileName}; version={module.FileVersionInfo.FileVersion}");
}

static uint GuiResources(uint flag) => GetGuiResources(Process.GetCurrentProcess().Handle, flag);

[DllImport("user32.dll")]
static extern uint GetGuiResources(IntPtr process, uint flag);

[DllImport("user32.dll")]
static extern bool GetWindowRect(IntPtr window, out Rect rect);

[DllImport("user32.dll", SetLastError = true)]
static extern bool GetClientRect(IntPtr window, out Rect rect);

[DllImport("user32.dll")]
static extern uint GetDpiForWindow(IntPtr window);

[DllImport("user32.dll")]
static extern int MapWindowPoints(IntPtr from, IntPtr to, [In, Out] Point[] points, uint count);

[DllImport("user32.dll")]
static extern bool EnumChildWindows(IntPtr parent, EnumWindowProc callback, IntPtr parameter);

[DllImport("user32.dll", CharSet = CharSet.Unicode)]
static extern int GetClassName(IntPtr window, System.Text.StringBuilder className, int maximumCount);

[DllImport("user32.dll")]
static extern bool IsWindowVisible(IntPtr window);

[DllImport("user32.dll")]
static extern bool IsWindow(IntPtr window);

[DllImport("user32.dll", SetLastError = true)]
static extern bool SetWindowPos(IntPtr window, IntPtr insertAfter, int x, int y, int width, int height, uint flags);

[StructLayout(LayoutKind.Sequential)]
struct Rect
{
    public int Left, Top, Right, Bottom;
}

[StructLayout(LayoutKind.Sequential)]
struct Point
{
    public int X, Y;
}

delegate bool EnumWindowProc(IntPtr window, IntPtr parameter);

sealed class UnavailableAssets : IManualAssetAvailability
{
    public Task<ManualDragPreparation> PrepareAsync(
        IReadOnlyList<ManualDragAsset> selected,
        CancellationToken cancellationToken) =>
        Task.FromResult(ManualDragPreparation.Fail("validation_failed"));
}

sealed class RecordingClipboard : IUnicodeClipboard
{
    internal List<string> Values { get; } = [];

    public bool TrySetText(string text)
    {
        Values.Add(text);
        return true;
    }
}

sealed class ControlledPostingTransport : IManualPostingConfirmationTransport
{
    private readonly TaskCompletionSource<ManualPostingTransportResult> _firstPost =
        new(TaskCreationOptions.RunContinuationsAsynchronously);
    private int _postCalls;
    private int _getCalls;

    public DateTime? ConfirmationExpiresAt => null;
    internal int PostCalls => Volatile.Read(ref _postCalls);
    internal int GetCalls => Volatile.Read(ref _getCalls);

    public Task<ManualPostingTransportResult> PostAsync(string platform, CancellationToken cancellationToken)
    {
        if (Interlocked.Increment(ref _postCalls) == 1)
            return _firstPost.Task.WaitAsync(cancellationToken);
        return Task.FromResult(ManualPostingTransportResult.Ambiguous());
    }

    public Task<ManualPostingTransportResult> GetAsync(string platform, CancellationToken cancellationToken)
    {
        int call = Interlocked.Increment(ref _getCalls);
        return Task.FromResult(call == 2
            ? ManualPostingTransportResult.Authoritative(new ManualPostingConfirmationResponse(
                platform, "posted", DateTime.UtcNow, new ManualPostingCompletion(1, 3, false)))
            : ManualPostingTransportResult.Ambiguous());
    }

    internal void CompleteFirstPostAsAmbiguous() =>
        _firstPost.TrySetResult(ManualPostingTransportResult.Ambiguous());

    public void Dispose() => CompleteFirstPostAsAmbiguous();
}

sealed class EmptyLease : IDisposable
{
    public void Dispose() { }
}

sealed class VisualProofDesktopNative : NativeOperatorUiHost.Native
{
    internal override IntPtr OpenInputDesktopHandle() => GetCurrentThreadDesktopHandle();
    internal override bool SetThreadDesktopHandle(IntPtr desktopHandle) => desktopHandle != IntPtr.Zero;
    internal override bool CloseDesktopHandle(IntPtr desktopHandle) => true;
}
