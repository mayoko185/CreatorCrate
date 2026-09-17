using System.Diagnostics;
using System.Text;
using OpenLocally;

internal static class ProductionUiaProbe
{
    internal static void Verify(
        NativeManualPublishingCompanion.NativeWindow window,
        ManualPostingConfirmationController controller,
        ControlledPostingTransport transport,
        RecordingClipboard clipboard,
        bool interactiveDesktop)
    {
        ArgumentNullException.ThrowIfNull(window);
        string script = Path.Combine(AppContext.BaseDirectory, "production-uia-probe.ps1");
        if (!File.Exists(script))
            throw new FileNotFoundException("The production UIA probe script is missing.", script);

        Exception? uiaFailure = null;
        CaptureFailure(ref uiaFailure, () => VerifyPlatform(
            window, script, 0, "Patreon title", "Patreon body", titleExpected: true,
            "Mark as posted", postingExpectedEnabled: true, verifySharedButtons: true,
            interactiveDesktop: interactiveDesktop));
        Console.WriteLine("uia-ready-probes=completed");
        CaptureFailure(ref uiaFailure, () => VerifyPlatform(
            window, script, 1, null, "X post text", titleExpected: false,
            "Mark as posted", postingExpectedEnabled: true, interactiveDesktop: interactiveDesktop));
        CaptureFailure(ref uiaFailure, () => VerifyPlatform(
            window, script, 2, null, "Bluesky post text", titleExpected: false,
            "Mark as posted", postingExpectedEnabled: true, interactiveDesktop: interactiveDesktop));
        CaptureFailure(ref uiaFailure, () => VerifyPlatform(
            window, script, 0, "Patreon title", "Patreon body", titleExpected: true,
            "Mark as posted", postingExpectedEnabled: true, interactiveDesktop: interactiveDesktop));

        if (transport.PostCalls != 0 || transport.GetCalls != 0 || clipboard.Values.Count != 0)
            throw new InvalidOperationException("UIA RichEditBox input invoked posting or Copy.");

        if (interactiveDesktop)
        {
            CaptureFailure(ref uiaFailure, () => VerifyPlatform(
                window, script, 0, "Patreon title", "Patreon body", titleExpected: true,
                "Mark as posted", postingExpectedEnabled: true,
                postingExpectedFocused: true, verifySharedButtons: true, verifyTextEditors: false,
                focusPostingAfterClientStarts: true, interactiveDesktop: true));
            window.MoveFocusPastPostingActionByTabForTesting();
            CaptureFailure(ref uiaFailure, () => VerifyPlatform(
                window, script, 0, "Patreon title", "Patreon body", titleExpected: true,
                "Mark as posted", postingExpectedEnabled: true,
                postingExpectedFocused: false, verifyTextEditors: false, interactiveDesktop: true));
            CaptureFailure(ref uiaFailure, () => VerifyPlatform(
                window, script, 0, "Patreon title", "Patreon body", titleExpected: true,
                "Mark as posted", postingExpectedEnabled: true,
                invokePostingAction: true, verifyTextEditors: false, interactiveDesktop: true));
        }
        if (transport.PostCalls == 0) window.InvokePostingActionByEnterForTesting();
        WaitUntil(() => transport.PostCalls == 1 &&
            controller.GetState("patreon").Status == ManualPostingConfirmationStatus.Confirming,
            "Mark-as-posted confirmation did not begin");
        NativePostingActionProbe confirming = window.CapturePostingActionForTesting();
        if (!confirming.IsWindow || !confirming.Visible || confirming.Enabled ||
            confirming.Text != "Mark as posted")
            throw new InvalidOperationException($"Invalid confirming posting action: {confirming}.");
        CaptureFailure(ref uiaFailure, () => VerifyPlatform(
            window, script, 0, "Patreon title", "Patreon body", titleExpected: true,
            "Mark as posted", postingExpectedEnabled: false, verifyTextEditors: false,
            interactiveDesktop: interactiveDesktop));
        window.InvokePostingActionByEnterForTesting();
        if (transport.PostCalls != 1 || transport.GetCalls != 0)
            throw new InvalidOperationException("Disabled Mark-as-posted accepted a duplicate Enter activation.");
        Console.WriteLine("mark-enter-probe=completed");

        transport.CompleteFirstPostAsAmbiguous();
        WaitUntil(() => controller.GetState("patreon").Status == ManualPostingConfirmationStatus.ConfirmationUnknown &&
            window.CapturePostingActionForTesting() is { Text: "Retry confirmation", Visible: true, Enabled: true },
            "Retry confirmation presentation did not appear");
        CaptureFailure(ref uiaFailure, () => VerifyPlatform(
            window, script, 0, "Patreon title", "Patreon body", titleExpected: true,
            "Retry confirmation", postingExpectedEnabled: true, interactiveDesktop: interactiveDesktop));
        Console.WriteLine("uia-retry-probe=completed");

        NativeProductionKeyboardProbe retryKeyboard =
            window.CaptureKeyboardIntegrationForTesting("Retry confirmation");
        if (!retryKeyboard.PostingActionRequiredAndReady ||
            !retryKeyboard.PatreonForwardTraversal || !retryKeyboard.PatreonReverseTraversal ||
            !retryKeyboard.EnterPreservedPostingStateAndText || !retryKeyboard.WindowRemainedAlive)
            throw new InvalidOperationException($"Retry keyboard integration failed: {retryKeyboard}.");
        if (transport.PostCalls != 1 || transport.GetCalls != 1 || clipboard.Values.Count != 0)
            throw new InvalidOperationException("Retry-state traversal or RichEditBox Enter invoked an action.");

        window.CaptureTextSurfacesForTesting(0);
        if (window.CapturePostingActionForTesting().Text != "Retry confirmation")
            throw new InvalidOperationException("Platform switching did not restore Patreon's retry action.");
        window.InvokePostingActionByEnterForTesting();
        WaitUntil(() => transport.GetCalls == 2, "Retry confirmation did not invoke the controller retry path");
        if (transport.PostCalls != 1)
            throw new InvalidOperationException("Retry bypassed reconciliation and posted directly.");
        WaitUntil(() => !window.CapturePostingActionForTesting().Visible,
            "Posted presentation did not hide the posting action");
        CaptureFailure(ref uiaFailure, () => VerifyPlatform(
            window, script, 0, "Patreon title", "Patreon body", titleExpected: true,
            "Retry confirmation", postingExpectedEnabled: false, postingExpectedVisible: false,
            verifyTextEditors: false, interactiveDesktop: interactiveDesktop));
        Console.WriteLine("retry-enter-probe=completed");

        int postsBeforeEscape = transport.PostCalls;
        int getsBeforeEscape = transport.GetCalls;
        window.PostEscapeFromBodyForTesting();
        Console.WriteLine("escape-dispatched=true");
        WaitUntil(() => window.WindowHandle == IntPtr.Zero, "Escape did not close the production companion");
        if (transport.PostCalls != postsBeforeEscape || transport.GetCalls != getsBeforeEscape)
            throw new InvalidOperationException("Escape activated the posting action before closing.");

        Console.WriteLine("mark-enter=passed; workflows=1; duplicate-activation=false; confirming-disabled=true");
        Console.WriteLine("retry-tab=passed; hwnd-required=true; text=Retry confirmation; relative-position=after-copy-before-assets");
        Console.WriteLine("retry-enter=passed; reconcile-requests=1; direct-post=false; duplicate-activation=false");
        Console.WriteLine("escape-with-posting-ui=passed; confirmation-requests-unchanged=true; window-closed=true");
        Console.WriteLine("platform-switch-with-posting-ui=passed; action-state=platform-local; rich-edit-enter-safe=true");
        if (uiaFailure is not null)
            throw new InvalidOperationException("The required production posting action failed UI Automation.", uiaFailure);
        Console.WriteLine($"production-uia-check=passed; mode={(interactiveDesktop ? "interactive-desktop" : "deterministic")}; client-process=Windows-PowerShell; control-type=Edit,Button,ComboBox; class=RichEditBox,Button,ComboBox; text-pattern=available; read-only=true; selection=available; keyboard-focusable=true; expand-collapse-pattern=available; posting-enabled-state=verified; hidden-title=absent");
    }

    private static void CaptureFailure(ref Exception? firstFailure, Action action)
    {
        try { action(); }
        catch (Exception exception)
        {
            firstFailure ??= exception;
            Console.WriteLine($"uia-probe-failure={exception.Message}");
        }
    }

    private static void WaitUntil(Func<bool> condition, string failure)
    {
        if (!SpinWait.SpinUntil(condition, TimeSpan.FromSeconds(5)))
            throw new TimeoutException(failure + ".");
    }

    private static void VerifyPlatform(
        NativeManualPublishingCompanion.NativeWindow window,
        string script,
        int platformIndex,
        string? titleName,
        string bodyName,
        bool titleExpected,
        string postingActionName,
        bool postingExpectedEnabled,
        bool postingExpectedVisible = true,
        bool? postingExpectedFocused = null,
        bool invokePostingAction = false,
        bool verifySharedButtons = false,
        bool verifyTextEditors = true,
        bool focusPostingAfterClientStarts = false,
        bool interactiveDesktop = false)
    {
        NativeProductionTextSurfaceProbe surface = window.CaptureTextSurfacesForTesting(platformIndex);
        using var process = new Process
        {
            StartInfo = new ProcessStartInfo("powershell.exe")
            {
                UseShellExecute = false,
                CreateNoWindow = true,
                RedirectStandardOutput = true,
                RedirectStandardError = true,
            },
        };
        foreach (string argument in new[]
        {
            "-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", script,
            "-WindowHandle", window.WindowHandle.ToInt64().ToString(System.Globalization.CultureInfo.InvariantCulture),
            "-PlatformHandle", window.PlatformHandle.ToInt64().ToString(
                System.Globalization.CultureInfo.InvariantCulture),
            "-PlatformSelection", PlatformLabel(surface.Platform),
            "-BodyName", bodyName,
            "-BodyTextBase64", Convert.ToBase64String(Encoding.UTF8.GetBytes(surface.BodyText)),
            "-TitleExpected", titleExpected ? "true" : "false",
            "-PostingActionHandle", window.PostingActionHandle.ToInt64().ToString(
                System.Globalization.CultureInfo.InvariantCulture),
            "-PostingActionName", postingActionName,
            "-PostingExpectedEnabled", postingExpectedEnabled ? "true" : "false",
            "-PostingExpectedVisible", postingExpectedVisible ? "true" : "false",
            "-PostingExpectedFocused", postingExpectedFocused?.ToString().ToLowerInvariant() ?? "none",
            "-InvokePostingAction", invokePostingAction ? "true" : "false",
            "-VerifySharedButtons", verifySharedButtons ? "true" : "false",
            "-VerifyTextEditors", verifyTextEditors ? "true" : "false",
            "-InteractiveDesktop", interactiveDesktop ? "true" : "false",
        }) process.StartInfo.ArgumentList.Add(argument);
        if (titleExpected)
        {
            process.StartInfo.ArgumentList.Add("-TitleName");
            process.StartInfo.ArgumentList.Add(titleName!);
            process.StartInfo.ArgumentList.Add("-TitleTextBase64");
            process.StartInfo.ArgumentList.Add(Convert.ToBase64String(Encoding.UTF8.GetBytes(surface.TitleText)));
        }

        if (!process.Start()) throw new InvalidOperationException("Could not start the Windows UIA client process.");
        if (focusPostingAfterClientStarts) window.FocusPostingActionByTabForTesting();
        string output = process.StandardOutput.ReadToEnd();
        string error = process.StandardError.ReadToEnd();
        if (!process.WaitForExit(15_000))
        {
            process.Kill(entireProcessTree: true);
            throw new TimeoutException($"UIA timed out for {bodyName}.");
        }
        if (process.ExitCode != 0)
            throw new InvalidOperationException($"UIA failed for {bodyName} (exit {process.ExitCode}): {error}{output}");
        Console.Write(output);
    }

    private static string PlatformLabel(string platform) => platform.ToLowerInvariant() switch
    {
        "x" => "X",
        "bluesky" => "Bluesky",
        "patreon" => "Patreon",
        _ => platform,
    };
}
