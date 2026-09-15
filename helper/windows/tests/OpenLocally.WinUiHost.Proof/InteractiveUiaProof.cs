using System.Diagnostics;
using System.Text;
using OpenLocally;

internal static class InteractiveUiaProof
{
    private static readonly TimeSpan StateTimeout = TimeSpan.FromSeconds(8);

    internal static int Run()
    {
        Console.WriteLine("CreatorCrate WP10C interactive UIA proof");
        Console.WriteLine("production-companion=true; network=false; server=false; registry-changes=false");
        Console.WriteLine("Keep this desktop unlocked and do not switch windows while the proof runs.");

        var passed = new List<string>();
        try
        {
            RunReadyFixture(passed);
            RunRetryFixture(passed);
            Console.WriteLine();
            Console.WriteLine("PASS:");
            foreach (string step in passed) Console.WriteLine($"- {step}");
            return 0;
        }
        catch (ProofStepException exception)
        {
            Console.Error.WriteLine();
            Console.Error.WriteLine("FAIL:");
            Console.Error.WriteLine($"- step={exception.Step}");
            Console.Error.WriteLine($"- exception={exception.InnerException?.GetType().FullName ?? exception.GetType().FullName}");
            Console.Error.WriteLine($"- hresult=0x{(exception.InnerException?.HResult ?? exception.HResult):X8}");
            Console.Error.WriteLine($"- state={exception.SafeState}");
            Console.Error.WriteLine($"- message={exception.InnerException?.Message ?? exception.Message}");
            return 2;
        }
        catch (Exception exception)
        {
            Console.Error.WriteLine();
            Console.Error.WriteLine("FAIL:");
            Console.Error.WriteLine("- step=unclassified proof failure");
            Console.Error.WriteLine($"- exception={exception.GetType().FullName}");
            Console.Error.WriteLine($"- hresult=0x{exception.HResult:X8}");
            Console.Error.WriteLine("- state=no secrets or network data were used");
            Console.Error.WriteLine($"- message={exception.Message}");
            return 2;
        }
    }

    private static void RunReadyFixture(List<string> passed)
    {
        using var transport = new ReadyPostingTransport();
        RunFixture("ready", transport, (window, controller, clipboard) =>
        {
            RunStep("foreground activation and Ready Button discovery", () =>
                RunClient(window, "ready-focus", "Mark as posted"), Safe(window, controller, transport));
            passed.Add("posting UIA Button");
            passed.Add("keyboard focus");
            passed.Add("Copy/Close Button semantics");

            RunStep("RichEdit Enter isolation", () =>
            {
                RunClient(window, "richedit-enter", "Mark as posted");
                if (transport.PostCalls != 0 || transport.GetCalls != 0 || clipboard.Values.Count != 0 ||
                    window.WindowHandle == IntPtr.Zero)
                    throw new InvalidOperationException(
                        $"Enter isolation changed state; posts={transport.PostCalls}; gets={transport.GetCalls}; " +
                        $"copies={clipboard.Values.Count}; open={window.WindowHandle != IntPtr.Zero}.");
            }, Safe(window, controller, transport));
            passed.Add("RichEdit Enter isolation");

            RunStep("InvokePattern Mark as posted", () =>
            {
                RunClient(window, "invoke", "Mark as posted");
                WaitUntil(() => transport.PostCalls == 1 &&
                    controller.GetState("patreon").Status == ManualPostingConfirmationStatus.Confirming,
                    "one confirmation workflow to enter Confirming");
                WaitUntil(() => window.CapturePostingActionForTesting() is
                    { Text: "Mark as posted", Visible: true, Enabled: false },
                    "the production Button to become disabled");
                if (transport.PostCalls != 1 || transport.GetCalls != 0)
                    throw new InvalidOperationException("InvokePattern did not start exactly one POST workflow.");
            }, Safe(window, controller, transport));
            passed.Add("InvokePattern Mark as posted");

            RunStep("disabled semantics", () =>
            {
                RunClient(window, "disabled-invoke", "Mark as posted");
                Thread.Sleep(150);
                if (transport.PostCalls != 1 || transport.GetCalls != 0)
                    throw new InvalidOperationException("Disabled InvokePattern created another workflow.");
            }, Safe(window, controller, transport));
            passed.Add("disabled semantics");

            RunStep("canonical Posted completion", () =>
            {
                transport.CompletePosted();
                WaitUntil(() => controller.GetState("patreon").Status == ManualPostingConfirmationStatus.Posted,
                    "the controller to reach Posted");
                WaitUntil(() => !window.CapturePostingActionForTesting().Visible,
                    "the production posting action to be removed from view");
                RunClient(window, "assert-absent", "Mark as posted");
                if (transport.PostCalls != 1 || transport.GetCalls != 0)
                    throw new InvalidOperationException("Posted completion changed request counts.");
            }, Safe(window, controller, transport));
        });
    }

    private static void RunRetryFixture(List<string> passed)
    {
        using var transport = new RetryPostingTransport();
        RunFixture("retry", transport, (window, controller, clipboard) =>
        {
            RunStep("Retry fixture initial InvokePattern", () =>
            {
                RunClient(window, "invoke", "Mark as posted");
                WaitUntil(() => controller.GetState("patreon").Status ==
                    ManualPostingConfirmationStatus.ConfirmationUnknown,
                    "the controlled ambiguous POST to reach ConfirmationUnknown");
                WaitUntil(() => window.CapturePostingActionForTesting() is
                    { Text: "Retry confirmation", Visible: true, Enabled: true },
                    "Retry confirmation to appear");
                if (transport.PostCalls != 1 || transport.GetCalls != 1)
                    throw new InvalidOperationException(
                        $"Unexpected ambiguous workflow counts; posts={transport.PostCalls}; gets={transport.GetCalls}.");
            }, Safe(window, controller, transport));

            RunStep("Retry confirmation InvokePattern", () =>
            {
                RunClient(window, "assert-invoke", "Retry confirmation");
                WaitUntil(() => controller.GetState("patreon").Status == ManualPostingConfirmationStatus.Posted,
                    "the retry reconciliation to apply canonical Posted");
                WaitUntil(() => !window.CapturePostingActionForTesting().Visible,
                    "the Retry confirmation action to be removed from view");
                RunClient(window, "assert-absent", "Retry confirmation");
                if (transport.PostCalls != 1 || transport.GetCalls != 2)
                    throw new InvalidOperationException(
                        $"Retry did not perform exactly one reconciliation GET; posts={transport.PostCalls}; " +
                        $"gets={transport.GetCalls}.");
                if (clipboard.Values.Count != 0)
                    throw new InvalidOperationException("Retry unexpectedly invoked Copy.");
            }, Safe(window, controller, transport));
            passed.Add("Retry confirmation InvokePattern");
        });
    }

    private static void RunFixture(
        string fixtureName,
        CountingPostingTransport transport,
        Action<NativeManualPublishingCompanion.NativeWindow, ManualPostingConfirmationController, RecordingClipboard>
            proof)
    {
        var session = new ManualSocialSession(
            new Uri("https://creatorcrate.invalid"),
            1,
            $"WP10C {fixtureName} fixture",
            [new ManualPreparedPlatform("patreon", "WP10C proof title", "WP10C proof body", [])]);
        var lifecycle = new ManualCompanionLifecycle();
        using var controller = new ManualPostingConfirmationController(transport, ["patreon"]);
        var clipboard = new RecordingClipboard();
        NativeManualPublishingCompanion.NativeWindow? window = null;
        Thread? proofThread = null;
        Exception? proofFailure = null;
        using var proofFinished = new ManualResetEventSlim();

        window = new NativeManualPublishingCompanion.NativeWindow(
            new ManualPublishingCompanionModel(session),
            new UnavailableAssets(),
            lifecycle,
            confirmation: controller,
            clipboardFactory: _ => clipboard,
            winUiProofOptions: new WinUiHostProofOptions(
                "WP10C proof title",
                "WP10C proof body",
                $"WP10C interactive UIA {fixtureName} fixture   •   Local only",
                Theme: Microsoft.UI.Xaml.ElementTheme.Dark,
                WindowShown: _ =>
                {
                    NativeManualPublishingCompanion.NativeWindow shownWindow = window ??
                        throw new InvalidOperationException("The production window was not assigned.");
                    proofThread = new Thread(() =>
                    {
                        try { proof(shownWindow, controller, clipboard); }
                        catch (Exception exception) { proofFailure = exception; }
                        finally
                        {
                            shownWindow.RequestClose();
                            proofFinished.Set();
                        }
                    }) { Name = $"WP10C-{fixtureName}-UIA-client" };
                    proofThread.SetApartmentState(ApartmentState.MTA);
                    proofThread.Start();
                }));

        try
        {
            NativePresentationResult result = NativeOperatorUiHost.Show(
                new NativeOperatorUiHost.Native(), presentation => window.Run(presentation));
            if (!proofFinished.Wait(TimeSpan.FromSeconds(30)))
                throw new TimeoutException($"The {fixtureName} proof did not finish.");
            if (proofThread is not null && !proofThread.Join(TimeSpan.FromSeconds(2)))
                throw new TimeoutException($"The {fixtureName} UIA client thread did not exit.");
            if (proofFailure is not null) throw proofFailure;
            if (result.State != NativePresentationState.PresentedAndDismissed)
                throw new InvalidOperationException(
                    $"Production companion ended in {result.State}; stage={result.Stage}; win32={result.Win32Code}.");
        }
        finally
        {
            window.RequestClose();
            try { window.ShutdownAsync(new EmptyLease()).GetAwaiter().GetResult(); }
            catch { }
        }
    }

    private static void RunClient(
        NativeManualPublishingCompanion.NativeWindow window,
        string operation,
        string postingName)
    {
        string script = Path.Combine(AppContext.BaseDirectory, "interactive-uia-client.ps1");
        if (!File.Exists(script)) throw new FileNotFoundException("The interactive UIA client is missing.", script);
        NativeProductionTextSurfaceProbe surface = window.CaptureTextSurfacesForTesting(0);
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
            "-NoLogo", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script,
            "-WindowHandle", window.WindowHandle.ToInt64().ToString(
                System.Globalization.CultureInfo.InvariantCulture),
            "-Operation", operation,
            "-PostingName", postingName,
            "-BodyName", "Patreon body",
            "-ExpectedBodyBase64", Convert.ToBase64String(Encoding.UTF8.GetBytes(surface.BodyText)),
        }) process.StartInfo.ArgumentList.Add(argument);

        if (!process.Start()) throw new InvalidOperationException("Could not start the out-of-process UIA client.");
        string output = process.StandardOutput.ReadToEnd();
        string error = process.StandardError.ReadToEnd();
        if (!process.WaitForExit(12_000))
        {
            process.Kill(entireProcessTree: true);
            throw new TimeoutException($"UIA client timed out during {operation}.");
        }
        if (process.ExitCode != 0)
            throw new InvalidOperationException(
                $"UIA client failed during {operation} (exit {process.ExitCode}): {error.Trim()} {output.Trim()}");
        Console.Write(output);
    }

    private static void RunStep(string step, Action action, Func<string> safeState)
    {
        try { action(); }
        catch (Exception exception) { throw new ProofStepException(step, safeState(), exception); }
    }

    private static Func<string> Safe(
        NativeManualPublishingCompanion.NativeWindow window,
        ManualPostingConfirmationController controller,
        CountingPostingTransport transport) => () =>
    {
        ManualPostingPlatformState state = controller.GetState("patreon");
        NativePostingActionProbe button = window.CapturePostingActionForTesting();
        return $"controller={state.Status}; button-visible={button.Visible}; button-enabled={button.Enabled}; " +
            $"posts={transport.PostCalls}; gets={transport.GetCalls}; window-open={window.WindowHandle != IntPtr.Zero}";
    };

    private static void WaitUntil(Func<bool> condition, string description)
    {
        if (!SpinWait.SpinUntil(condition, StateTimeout))
            throw new TimeoutException($"Timed out waiting for {description}.");
    }

    private sealed class ProofStepException(string step, string safeState, Exception innerException)
        : Exception($"Interactive proof failed at {step}.", innerException)
    {
        internal string Step { get; } = step;
        internal string SafeState { get; } = safeState;
    }
}

internal abstract class CountingPostingTransport : IManualPostingConfirmationTransport
{
    private int _postCalls;
    private int _getCalls;

    public DateTime? ConfirmationExpiresAt => null;
    internal int PostCalls => Volatile.Read(ref _postCalls);
    internal int GetCalls => Volatile.Read(ref _getCalls);

    public Task<ManualPostingTransportResult> PostAsync(string platform, CancellationToken cancellationToken)
    {
        Interlocked.Increment(ref _postCalls);
        return PostCoreAsync(platform, cancellationToken);
    }

    public Task<ManualPostingTransportResult> GetAsync(string platform, CancellationToken cancellationToken)
    {
        int call = Interlocked.Increment(ref _getCalls);
        return GetCoreAsync(platform, call, cancellationToken);
    }

    protected abstract Task<ManualPostingTransportResult> PostCoreAsync(
        string platform,
        CancellationToken cancellationToken);

    protected abstract Task<ManualPostingTransportResult> GetCoreAsync(
        string platform,
        int call,
        CancellationToken cancellationToken);

    public virtual void Dispose() { }

    protected static ManualPostingTransportResult Posted(string platform) =>
        ManualPostingTransportResult.Authoritative(new ManualPostingConfirmationResponse(
            platform, "posted", DateTime.UtcNow, new ManualPostingCompletion(1, 1, true)));
}

internal sealed class ReadyPostingTransport : CountingPostingTransport
{
    private readonly TaskCompletionSource<ManualPostingTransportResult> _post =
        new(TaskCreationOptions.RunContinuationsAsynchronously);

    protected override Task<ManualPostingTransportResult> PostCoreAsync(
        string platform,
        CancellationToken cancellationToken) => _post.Task.WaitAsync(cancellationToken);

    protected override Task<ManualPostingTransportResult> GetCoreAsync(
        string platform,
        int call,
        CancellationToken cancellationToken) =>
        Task.FromResult(ManualPostingTransportResult.Ambiguous());

    internal void CompletePosted() => _post.TrySetResult(Posted("patreon"));
    public override void Dispose() => _post.TrySetCanceled();
}

internal sealed class RetryPostingTransport : CountingPostingTransport
{
    protected override Task<ManualPostingTransportResult> PostCoreAsync(
        string platform,
        CancellationToken cancellationToken) =>
        Task.FromResult(ManualPostingTransportResult.Ambiguous());

    protected override Task<ManualPostingTransportResult> GetCoreAsync(
        string platform,
        int call,
        CancellationToken cancellationToken) =>
        Task.FromResult(call == 2 ? Posted(platform) : ManualPostingTransportResult.Ambiguous());
}
