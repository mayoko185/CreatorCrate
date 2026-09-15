using System.Diagnostics;
using System.Runtime.InteropServices;
using OpenLocally;

if (args.Contains("--interactive-uia-proof", StringComparer.Ordinal))
    return InteractiveUiaProof.Run();

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
bool lightTheme = args.Contains("--light-theme", StringComparer.Ordinal);
bool resizeCheck = args.Contains("--resize-check", StringComparer.Ordinal);
bool productionSurfaceCheck = args.Contains("--production-surface-check", StringComparer.Ordinal);
bool productionTextCheck = args.Contains("--production-text-check", StringComparer.Ordinal);
bool accessibilityCheck = args.Contains("--accessibility-check", StringComparer.Ordinal);
bool expectInitFailure = args.Contains("--expect-init-failure", StringComparer.Ordinal);
bool proofDesktop = !args.Contains("--production-desktop-check", StringComparer.Ordinal);
bool moduleProvenance = !args.Contains("--no-module-provenance", StringComparer.Ordinal);
bool observeShownWindow = capturePath is not null || lightTheme || resizeCheck || productionSurfaceCheck ||
    productionTextCheck || accessibilityCheck || moduleProvenance;

Console.WriteLine("proof-build=WP10C2 accessibility and system integration 1");
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
    var session = new ManualSocialSession(
        new Uri("https://creatorcrate.example"),
        10,
        "WinUI 3 interactive visual proof",
        [
            new ManualPreparedPlatform("patreon", TitleFixture, Fixture, []),
            new ManualPreparedPlatform("x", "ignored", XFixture, []),
            new ManualPreparedPlatform("bluesky", "ignored", BlueskyFixture, []),
        ]);
    var lifecycle = new ManualCompanionLifecycle();
    var postingTransport = new ControlledPostingTransport();
    using var postingController = new ManualPostingConfirmationController(
        postingTransport, session.Platforms.Select(platform => platform.Platform));
    var recordingClipboard = new RecordingClipboard();
    using var windowShown = new ManualResetEventSlim();
    IntPtr capturedMainWindow = IntPtr.Zero;
    var capturedNativeControls = new List<IntPtr>();
    var capturedIslandWindows = new List<IntPtr>();
    Thread? automationThread = null;
    NativeManualPublishingCompanion.NativeWindow? window = null;
    window = new NativeManualPublishingCompanion.NativeWindow(
        new ManualPublishingCompanionModel(session),
        new UnavailableAssets(),
        lifecycle,
        confirmation: postingController,
        clipboardFactory: _ => recordingClipboard,
        winUiProofOptions: new WinUiHostProofOptions(
            TitleFixture,
            Fixture,
            $"WP10C2 accessibility proof 1   •   Windows App SDK Runtime {RuntimePackageVersion}   •   WinUI {WinUiPackageVersion}   •   No server/network",
            Theme: Microsoft.UI.Xaml.ElementTheme.Dark,
            ThemeAfterFirstRender: lightTheme ? Microsoft.UI.Xaml.ElementTheme.Light : null,
            SelectBodyTextAfterRender: lightTheme,
            FailAfterSurfaceCount: failAfter,
            MainWindowCreated: handle => capturedMainWindow = handle,
            NativeControlsCreated: handles => capturedNativeControls.AddRange(handles),
            SurfaceCreated: handle => capturedIslandWindows.Add(handle),
            WindowShown: observeShownWindow ? handle =>
            {
                try
                {
                    DescribeChildren(handle);
                    if (productionSurfaceCheck)
                        VerifyProductionSurfaces(
                            window ?? throw new InvalidOperationException("Production window was not assigned."),
                            postingTransport, recordingClipboard);
                    if (productionTextCheck)
                        VerifyProductionTextPresentation(
                            window ?? throw new InvalidOperationException("Production window was not assigned."), session);
                    if (accessibilityCheck)
                    {
                        NativeManualPublishingCompanion.NativeWindow productionWindow = window ??
                            throw new InvalidOperationException("Production window was not assigned.");
                        VerifyAccessibilitySystemContracts(productionWindow);
                        automationThread = new Thread(() =>
                        {
                            try { ProductionUiaProbe.Verify(
                                productionWindow, postingController, postingTransport, recordingClipboard); }
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
                            VerifyCurrentIslandBounds(handle, window ?? throw new InvalidOperationException("Production window was not assigned."));
                        }
                    }
                    if (lightTheme)
                        Console.WriteLine("requested-theme-transition=Dark->Light; body-selection=0..17; focus=programmatic");
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
            } : null));

    if (closeBeforeReady) window.RequestClose();
    if (autoClose)
        _ = lifecycle.Ready.ContinueWith(
            _ =>
            {
                if (observeShownWindow && !windowShown.Wait(TimeSpan.FromSeconds(10)))
                    Console.WriteLine("window-shown timeout");
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
    Console.WriteLine(
        $"posting-action-required=true; hwnd=0x{posting.Handle.ToInt64():X}; is-window=true; visible=true; enabled=true; text={posting.Text}");
    Console.WriteLine("ready-forward-tab=passed; platforms=patreon,x,bluesky; posting-and-native-controls=included");
    Console.WriteLine("ready-reverse-tab=passed; platforms=patreon,x,bluesky; hidden-patreon-title-excluded=true");
    Console.WriteLine("richedit-enter=passed; real-posting-action=true; posting-requests=0; copy-invocations=0; window-alive=true");
    Console.WriteLine("production-surface-check=passed; shared-surfaces=2; classic-edits=0; minimum-containment=passed; tab-order=passed; enter-safety=passed");
}

static void VerifyPresentationThemeCycle(NativeManualPublishingCompanion.NativeWindow window)
{
    NativeProductionTextSurfaceProbe dark = window.CaptureTextSurfacesForTesting(0);
    AssertPresentation(dark.Presentation, Microsoft.UI.Xaml.ElementTheme.Dark,
        "#1d222b", "#171b22", "#e8ecf1", "#262c37", "#3a4353", "#58a6ff");

    window.SetTextSurfaceThemeForTesting(Microsoft.UI.Xaml.ElementTheme.Light);
    NativeProductionTextSurfaceProbe light = window.CaptureTextSurfacesForTesting(0);
    AssertPresentation(light.Presentation, Microsoft.UI.Xaml.ElementTheme.Light,
        "#f8fafc", "#ffffff", "#17202b", "#d7dee8", "#aab6c5", "#0969da");

    window.SetTextSurfaceThemeForTesting(Microsoft.UI.Xaml.ElementTheme.Dark);
    NativeProductionTextSurfaceProbe darkAgain = window.CaptureTextSurfacesForTesting(0);
    AssertPresentation(darkAgain.Presentation, Microsoft.UI.Xaml.ElementTheme.Dark,
        "#1d222b", "#171b22", "#e8ecf1", "#262c37", "#3a4353", "#58a6ff");

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
        restored.Presentation.RootBackground != "#1d222b" ||
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

static void VerifyCurrentIslandBounds(IntPtr parent, NativeManualPublishingCompanion.NativeWindow window)
{
    if (!GetClientRect(parent, out Rect client)) throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
    int dpi = checked((int)GetDpiForWindow(parent));
    foreach ((int index, bool patreon) in new[] { (0, true), (1, false), (2, false) })
    {
        NativeProductionTextSurfaceProbe surface = window.CaptureTextSurfacesForTesting(index);
        NativeCompanionLayout expected = NativeCompanionLayout.Calculate(client.Right, client.Bottom, dpi, patreon);
        NativeLayoutRect body = ChildRect(parent, surface.BodyWindow);
        if (body != expected.BodyText)
            throw new InvalidOperationException($"Stale body island after resize for {surface.Platform}: expected {expected.BodyText}, actual {body}.");
        if (patreon && ChildRect(parent, surface.TitleWindow) != expected.TitleText)
            throw new InvalidOperationException("Stale Patreon title island after resize.");
    }
    Console.WriteLine($"resize-island-bounds=passed; client={client.Right}x{client.Bottom}; dpi={dpi}");
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
