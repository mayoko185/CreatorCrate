using System.Runtime.InteropServices;
using OpenLocally;

namespace OpenLocally.ManualVisualProof;

internal static class DragProof
{
    internal static int Run(string repositoryRoot, bool autoClose)
    {
        using ManualVisualProofFixture fixture = ManualVisualProofFixture.Create(repositoryRoot);
        using ManualPostingConfirmationController postingController =
            ManualVisualProofFixture.CreatePostingController(
                ProofPostingState.Ready,
                fixture.Session.Platforms.Select(platform => platform.Platform),
                out _);
        var lifecycle = new ManualCompanionLifecycle();
        var model = new ManualPublishingCompanionModel(fixture.Session);
        var availability = new FixtureDragAvailability(fixture.Session);
        NativeManualPublishingCompanion.NativeWindow? companion = null;
        LocalDropTargetWindow? receiver = null;
        Exception? failure = null;
        NativeListViewBeginDragProbe? latestDrag = null;
        IntPtr companionHandle = IntPtr.Zero;
        IntPtr targetHandle = IntPtr.Zero;
        bool receiverRevoked = false;

        void DisposeReceiver()
        {
            LocalDropTargetWindow? current = receiver;
            receiver = null;
            if (current is null) return;
            current.Dispose();
            receiverRevoked = current.Revoked;
        }

        void ObserveNextDrag()
        {
            companion!.ObserveNextListViewBeginDragForTesting(observation =>
            {
                latestDrag = observation;
                Console.WriteLine(
                    $"drag-origin={observation.OriginItemIndex}; selected-ordinals={string.Join(',', observation.SelectedOrdinals)}");
                receiver?.SetDisplay(
                    "CreatorCrate local OLE drop proof\r\n\r\nDrop selected CreatorCrate assets here.\r\n\r\n" +
                    $"Waiting for origin {observation.OriginItemIndex}; no Drop received yet.");
                ObserveNextDrag();
            });
        }

        companion = new NativeManualPublishingCompanion.NativeWindow(
            model,
            availability,
            lifecycle,
            previewAccess: fixture.PreviewAccess,
            confirmation: postingController,
            winUiProofOptions: new WinUiHostProofOptions(
                "CreatorCrate local OLE drop proof",
                "Drag selected fixture assets to the separate local target.",
                "Release ID: 4242   •   Server: creatorcrate.example   •   Local OLE drag proof",
                Theme: Microsoft.UI.Xaml.ElementTheme.Dark,
                MainWindowCreated: handle =>
                {
                    companionHandle = handle;
                    receiver = LocalDropTargetWindow.Create(handle);
                    targetHandle = receiver.Handle;
                    receiver.Target.ResultReceived += result =>
                        ReportResult(result, latestDrag, fixture.ExpectedAvailablePaths, receiver);
                    ObserveNextDrag();
                    Console.WriteLine(
                        $"drag-proof-ready=true; companion-hwnd=0x{companionHandle.ToInt64():X}; " +
                        $"target-hwnd=0x{targetHandle.ToInt64():X}; drop-target-registered={receiver.Registered}");
                    foreach ((string path, int ordinal) in fixture.ExpectedAvailablePaths.Select((path, ordinal) => (path, ordinal)))
                        Console.WriteLine($"fixture[{ordinal}]={path}");
                },
                InitialNativePalette: NativeCompanionPalette.Dark,
                WindowClosing: DisposeReceiver));

        Thread? closer = null;
        if (autoClose)
        {
            closer = new Thread(() =>
            {
                try
                {
                    lifecycle.Ready.WaitAsync(TimeSpan.FromSeconds(15)).GetAwaiter().GetResult();
                    IReadOnlyList<int> selected =
                        NativeManualPublishingCompanion.NativeWindow.SelectedOrdinals(
                            companion.AssetListHandleForTesting);
                    bool windowsExist = companionHandle != IntPtr.Zero && targetHandle != IntPtr.Zero &&
                        IsWindow(companionHandle) && IsWindow(targetHandle);
                    bool registered = receiver?.Registered == true;
                    bool selectedState = selected.SequenceEqual([0, 1, 2]);
                    LocalDropTargetWindowProbe probe = receiver?.CaptureProbe() ??
                        throw new InvalidOperationException("The local drop target was not available.");
                    bool targetState = probe.Visible && probe.Enabled &&
                        probe.VisibleWindow == probe.RegisteredWindow &&
                        probe.RegisterDragDropResult == 0 &&
                        probe.WindowAtClientPoint == probe.VisibleWindow &&
                        probe.ClientHitTest == 1 && probe.Registered;
                    Console.WriteLine(
                        $"drop-target-probe=visible:{probe.Visible}; enabled:{probe.Enabled}; " +
                        $"visible-hwnd:0x{probe.VisibleWindow.ToInt64():X}; registered-hwnd:0x{probe.RegisteredWindow.ToInt64():X}; " +
                        $"register-hr:0x{probe.RegisterDragDropResult:X8}; window-from-point:0x{probe.WindowAtClientPoint.ToInt64():X}; " +
                        $"nchittest:{probe.ClientHitTest}; parent:0x{probe.Parent.ToInt64():X}; owner:0x{probe.Owner.ToInt64():X}; " +
                        $"style:0x{probe.Style:X}; ex-style:0x{probe.ExtendedStyle:X}; region-type:{probe.WindowRegionType}");
                    Console.WriteLine(
                        $"drag-proof-smoke={(windowsExist && registered && selectedState && targetState ? "passed" : "failed")}; " +
                        $"companion-window={IsWindow(companionHandle)}; target-window={IsWindow(targetHandle)}; " +
                        $"target-visible={probe.Visible}; target-enabled={probe.Enabled}; target-hit-testable={targetState}; " +
                        $"registered={registered}; selected={string.Join(',', selected)}");
                    if (!windowsExist || !registered || !selectedState || !targetState)
                        failure = new InvalidOperationException("Drag-proof process smoke did not reach the required state.");
                }
                catch (Exception exception)
                {
                    failure = exception;
                    Console.WriteLine($"drag-proof-smoke=failed; error={exception.Message}");
                }
                finally { companion.RequestClose(); }
            }) { IsBackground = true, Name = "CreatorCrate drag-proof smoke closer" };
            closer.SetApartmentState(ApartmentState.MTA);
            closer.Start();
        }

        NativePresentationResult presentation = NativeOperatorUiHost.Show(
            new DragProofDesktopNative(), result => companion.Run(result));
        if (closer is not null && !closer.Join(TimeSpan.FromSeconds(20)))
            failure = new TimeoutException("Drag-proof smoke closer did not finish.");

        try { companion.ShutdownAsync(new EmptyDragProofLease()).GetAwaiter().GetResult(); }
        catch (Exception exception) { failure ??= exception; }
        try { DisposeReceiver(); }
        catch (Exception exception) { failure ??= exception; }

        bool windowsDestroyed = (companionHandle == IntPtr.Zero || !IsWindow(companionHandle)) &&
            (targetHandle == IntPtr.Zero || !IsWindow(targetHandle));
        Console.WriteLine(
            $"drag-proof-cleanup={(windowsDestroyed ? "passed" : "failed")}; " +
            $"companion-destroyed={!IsWindow(companionHandle)}; target-destroyed={!IsWindow(targetHandle)}; " +
            $"drop-target-revoked={receiverRevoked}");
        if (!windowsDestroyed || !receiverRevoked)
            failure ??= new InvalidOperationException("Drag-proof windows were not destroyed and revoked cleanly.");
        if (presentation.State != NativePresentationState.PresentedAndDismissed)
            failure ??= new InvalidOperationException(
                $"Production companion failed at {presentation.Stage} (Win32 {presentation.Win32Code}).");
        if (failure is not null)
        {
            Console.Error.WriteLine(failure);
            return 2;
        }
        return 0;
    }

    private static void ReportResult(
        LocalDropResult result,
        NativeListViewBeginDragProbe? drag,
        IReadOnlyList<string> availablePaths,
        LocalDropTargetWindow receiver)
    {
        int[] selectedOrdinals = drag?.SelectedOrdinals.ToArray() ?? [];
        string[] expected = selectedOrdinals
            .Where(ordinal => ordinal >= 0 && ordinal < availablePaths.Count)
            .Select(ordinal => availablePaths[ordinal])
            .ToArray();
        bool expectedSelection = drag is not null && selectedOrdinals.Length == expected.Length;
        bool passed = result.DropReceived && result.Effect == WindowsFileDrag.DropEffectCopy &&
            expectedSelection && result.Paths.SequenceEqual(expected, StringComparer.OrdinalIgnoreCase);

        Console.WriteLine(passed ? "DROP PASS" : "DROP FAIL");
        Console.WriteLine($"origin={drag?.OriginItemIndex.ToString() ?? "unknown"}");
        Console.WriteLine($"count={result.Count}");
        Console.WriteLine($"effect={(result.Effect == WindowsFileDrag.DropEffectCopy ? "COPY" : "NONE")}");
        for (int index = 0; index < result.Paths.Count; index++)
            Console.WriteLine($"actual[{index}]={result.Paths[index]}");
        if (!passed)
        {
            for (int index = 0; index < expected.Length; index++)
                Console.WriteLine($"expected[{index}]={expected[index]}");
            if (!string.IsNullOrWhiteSpace(result.Error)) Console.WriteLine($"error={result.Error}");
        }
        receiver.SetDisplay(passed
            ? $"PASS — received {result.Count} file{(result.Count == 1 ? string.Empty : "s")} in release order.\r\n\r\norigin={drag?.OriginItemIndex.ToString() ?? "unknown"}"
            : $"FAIL — received {result.Count} file{(result.Count == 1 ? string.Empty : "s")}.\r\n\r\nSee console for expected and actual order.");
    }

    [DllImport("user32.dll")]
    private static extern bool IsWindow(IntPtr window);

    private sealed class EmptyDragProofLease : IDisposable
    {
        public void Dispose() { }
    }

    private sealed class DragProofDesktopNative : NativeOperatorUiHost.Native
    {
        internal override IntPtr OpenInputDesktopHandle() => GetCurrentThreadDesktopHandle();
        internal override bool SetThreadDesktopHandle(IntPtr desktopHandle) => desktopHandle != IntPtr.Zero;
        internal override bool CloseDesktopHandle(IntPtr desktopHandle) => true;
    }
}
