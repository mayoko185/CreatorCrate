using System.Diagnostics;
using System.Runtime.InteropServices;
using OpenLocally.ManualVisualProof;

namespace OpenLocally.Tests;

[Collection("Manual visual proof process isolation")]
public sealed class ManualVisualProofFixtureTests
{
    [Fact]
    public void Fixture_UsesRepresentativeProductionAssetsAndProductionInitialSelection()
    {
        using ManualVisualProofFixture fixture = ManualVisualProofFixture.Create(RepositoryRoot());
        Assert.Equal(new[] { "patreon", "x", "bluesky" }, fixture.Session.Platforms.Select(x => x.Platform));
        foreach (ManualPreparedPlatform platform in fixture.Session.Platforms)
        {
            Assert.Equal(4, platform.Assets.Count);
            Assert.Equal(3, platform.Assets.Count(ManualPublishingCompanionModel.IsAvailable));
            Assert.Single(platform.Assets, asset => !ManualPublishingCompanionModel.IsAvailable(asset));
            Assert.Equal(2, platform.Assets.Count(asset =>
                ManualPublishingCompanionModel.IsAvailable(asset) &&
                NativeManualPublishingCompanion.NativeWindow.IsImageAsset(asset)));
        }
        var model = new ManualPublishingCompanionModel(fixture.Session);
        Assert.Equal(3, model.SelectedAssets.Count);
        Assert.All(model.SelectedAssets, asset => Assert.True(ManualPublishingCompanionModel.IsAvailable(asset)));
        Assert.Contains(model.AssetRows, row => row.File.Length > 50 && row.PathOrStagedName.Length > 70);
        Assert.Contains(model.AssetRows, row => row.Role == "primary");
        Assert.Contains(model.AssetRows, row => row.Role == "attachment");
    }

    [Fact]
    public void Fixture_AvailableImagesUseProductionPreviewAccessAndUnavailableAssetFailsClosed()
    {
        using ManualVisualProofFixture fixture = ManualVisualProofFixture.Create(RepositoryRoot());
        ManualPreparedPlatform platform = fixture.Session.Platforms[0];
        using ManualPreviewFileLease first = AssertPreviewReady(fixture.PreviewAccess.TryAcquireRead(platform.Assets[0], 0));
        using ManualPreviewFileLease second = AssertPreviewReady(fixture.PreviewAccess.TryAcquireRead(platform.Assets[1], 1));
        Assert.Equal(StagedMediaProvenance.ExternalSource, first.Provenance);
        Assert.Equal(StagedMediaProvenance.ExternalSource, second.Provenance);
        Assert.False(fixture.PreviewAccess.TryAcquireRead(platform.Assets[3], 3).Success);
    }

    [Fact]
    public async Task DragProofAvailability_ReturnsExistingFixturePathsInIncomingOrdinalOrder()
    {
        using ManualVisualProofFixture fixture = ManualVisualProofFixture.Create(RepositoryRoot());
        var availability = new FixtureDragAvailability(fixture.Session);
        ManualPreparedPlatform platform = fixture.Session.Platforms[0];
        ManualDragAsset[] selected =
        [
            new(platform.Assets[0], 0),
            new(platform.Assets[1], 1),
            new(platform.Assets[2], 2),
        ];

        ManualDragPreparation prepared = await availability.PrepareAsync(selected, CancellationToken.None);

        Assert.True(prepared.Success);
        Assert.Equal(fixture.ExpectedAvailablePaths, prepared.Paths);
        Assert.All(prepared.Paths, path =>
        {
            Assert.True(Path.IsPathFullyQualified(path));
            Assert.True(File.Exists(path));
        });
    }

    [Fact]
    public async Task DragProofAvailability_RejectsUnavailableFixtureAssetWithoutNetworkOrPartialPaths()
    {
        using ManualVisualProofFixture fixture = ManualVisualProofFixture.Create(RepositoryRoot());
        var availability = new FixtureDragAvailability(fixture.Session);
        ManualPreparedPlatform platform = fixture.Session.Platforms[0];

        ManualDragPreparation prepared = await availability.PrepareAsync(
            [new(platform.Assets[0], 0), new(platform.Assets[3], 3)], CancellationToken.None);

        Assert.False(prepared.Success);
        Assert.Equal("validation_failed", prepared.ErrorCode);
        Assert.Empty(prepared.Paths);
    }

    [Theory]
    [InlineData("Ready", "Ready")]
    [InlineData("Confirming", "Confirming")]
    [InlineData("Unknown", "ConfirmationUnknown")]
    [InlineData("Posted", "Posted")]
    public void PostingModes_ReachRealControllerStates(string modeName, string expectedName)
    {
        ProofPostingState mode = ManualVisualProofFixture.ParsePostingState(modeName);
        ManualPostingConfirmationStatus expected = Enum.Parse<ManualPostingConfirmationStatus>(expectedName);
        string[] platforms = ["patreon", "x", "bluesky"];
        using ManualPostingConfirmationController controller =
            ManualVisualProofFixture.CreatePostingController(mode, platforms, out FixturePostingTransport transport);
        Assert.Equal(expected, controller.GetState("patreon").Status);
        if (mode is ProofPostingState.Unknown or ProofPostingState.Posted)
            Assert.All(platforms, platform => Assert.Equal(expected, controller.GetState(platform).Status));
        if (mode == ProofPostingState.Ready) Assert.Equal(0, transport.PostCalls);
        if (mode == ProofPostingState.Confirming) Assert.Equal(1, transport.PostCalls);
        if (mode == ProofPostingState.Unknown)
        {
            Assert.Equal(3, transport.PostCalls);
            Assert.Equal(3, transport.GetCalls);
        }
        if (mode == ProofPostingState.Posted)
        {
            Assert.Equal(3, transport.PostCalls);
            Assert.Equal(3, controller.Completion!.PostedCount);
            Assert.True(controller.Completion.IsComplete);
        }
    }

    [Theory]
    [InlineData("Dark", "Ready", "whole-window-theme=Dark; native=Dark; winui=Dark")]
    [InlineData("Light", "Ready", "whole-window-theme=Light; native=Light; winui=Light")]
    [InlineData("Dark", "Confirming", "posting-platform=patreon; state=Confirming")]
    [InlineData("Dark", "Unknown", "posting-platform=patreon; state=ConfirmationUnknown")]
    [InlineData("Dark", "Posted", "posting-platform=patreon; state=Posted")]
    public void LauncherModes_RenderProductionWindowAndSettleRealThumbnails(string theme, string postingState, string expected)
    {
        string executable = ProofExecutable();
        Assert.True(File.Exists(executable), $"The proof executable was not built: {executable}");
        using var process = new Process
        {
            StartInfo = new ProcessStartInfo(executable)
            {
                WorkingDirectory = RepositoryRoot(), UseShellExecute = false, CreateNoWindow = true,
                RedirectStandardOutput = true, RedirectStandardError = true,
            },
        };
        process.StartInfo.ArgumentList.Add("--manual-visual-proof");
        process.StartInfo.ArgumentList.Add($"--posting-state={postingState}");
        process.StartInfo.ArgumentList.Add($"--theme={theme}");
        process.StartInfo.ArgumentList.Add("--auto-close");
        process.StartInfo.ArgumentList.Add("--no-module-provenance");
        Assert.True(process.Start());
        string output = process.StandardOutput.ReadToEnd();
        string error = process.StandardError.ReadToEnd();
        if (!process.WaitForExit(30_000))
        {
            process.Kill(entireProcessTree: true);
            Assert.Fail("The manual visual proof smoke process timed out.");
        }
        Assert.True(process.ExitCode == 0, $"Exit {process.ExitCode}{Environment.NewLine}{error}{Environment.NewLine}{output}");
        Assert.Contains("class=SysListView32", output, StringComparison.Ordinal);
        Assert.Contains("asset-fixture=production-model; rows=4; available=3; unavailable=1; initially-selected=3", output, StringComparison.Ordinal);
        Assert.Contains("preview-path=ManualAssetPreviewAccess->NativeAssetPreviewPipeline->NativeShellThumbnailExtractor->ListView/ImageList", output, StringComparison.Ordinal);
        Assert.Contains("fixture-thumbnails=settled; real-thumbnails=2", output, StringComparison.Ordinal);
        Assert.Contains(expected, output, StringComparison.Ordinal);
        Assert.DoesNotContain("text-scale=", output, StringComparison.Ordinal); // No option: unscaled default.
    }

    [Fact]
    public void Instructions_RequireLaunchBeforeGenuineWindowsHighContrastAndExcludeFakeArgument()
    {
        string proofRoot = Path.Combine(RepositoryRoot(), "helper", "windows", "tests", "OpenLocally.WinUiHost.Proof");
        string instructions = File.ReadAllText(Path.Combine(proofRoot, "INTERACTIVE-PROOF.txt"));
        Assert.Contains("run-manual-visual-proof.ps1 -PostingState Ready -Theme Dark", instructions, StringComparison.Ordinal);
        Assert.Contains("Ready, Confirming, Unknown, or Posted", instructions, StringComparison.Ordinal);
        // Check the High Contrast procedure by its numbered steps and their meaning, not by exact prose.
        int section = instructions.IndexOf("Theme and High Contrast", StringComparison.Ordinal);
        Assert.True(section >= 0, "The instructions must keep a Theme and High Contrast section.");
        string[] steps = NumberedSteps(instructions[section..]);
        int launch = Array.FindIndex(steps, step => step.StartsWith("Launch", StringComparison.Ordinal) &&
            step.Contains("proof", StringComparison.OrdinalIgnoreCase));
        int keepOpen = Array.FindIndex(steps, step => step.Contains("open", StringComparison.OrdinalIgnoreCase) &&
            step.Contains("window", StringComparison.OrdinalIgnoreCase));
        int enable = Array.FindIndex(steps, step => step.Contains("genuine Windows Contrast Theme", StringComparison.Ordinal) &&
            step.Contains("Windows Settings", StringComparison.Ordinal));
        int inspect = Array.FindIndex(steps, step => step.StartsWith("Inspect", StringComparison.Ordinal) &&
            step.Contains("SAME", StringComparison.Ordinal) && step.Contains("window", StringComparison.OrdinalIgnoreCase));
        Assert.True(launch >= 0 && keepOpen > launch && enable > keepOpen && inspect > enable,
            "The manual contract must launch the proof window, keep it open, enable a genuine Windows Contrast Theme, " +
            $"then inspect that same running window. Steps: {string.Join(" | ", steps)}");
        Assert.Contains(steps, step => step.Contains("settings-change", StringComparison.OrdinalIgnoreCase));

        string themeSection = instructions[section..instructions.IndexOf("1. Launch", section, StringComparison.Ordinal)];
        Assert.Matches(@"(?i)\bno\s+High\s?Contrast\s+(launch(er)?\s+)?(argument|option)", themeSection);
        Assert.Matches(@"(?i)\bDark\b[^.]*\bLight\b[^.]*\bnot\s+substitute\b[^.]*genuine Windows High Contrast", themeSection);
        Assert.Matches(@"(?i)multi-file[^.]*\bproven\b", instructions);
        Assert.DoesNotContain("-Theme HighContrast", instructions, StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain("--theme=HighContrast", instructions, StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain("F6 switches", instructions, StringComparison.Ordinal);
        Assert.Contains("-Theme Dark", instructions, StringComparison.Ordinal);
        Assert.Contains("-Theme Light", instructions, StringComparison.Ordinal);
    }

    [Fact]
    public void LegacyLightTheme_RealEntryPointRejectsBeforeCreatingCompanionWindow()
    {
        ProcessRunResult result = RunProcess(ProofStartInfo("--light-theme"), TimeSpan.FromSeconds(20));

        Assert.Equal(64, result.ExitCode);
        Assert.Contains("--light-theme was removed", result.StandardError, StringComparison.Ordinal);
        Assert.Contains("Use --theme=Light for the whole production companion", result.StandardError, StringComparison.Ordinal);
        Assert.True(result.ObservedProofProcess);
        Assert.False(result.ObservedProofWindow);
        AssertRejectedLaunchLeftNoSideEffects(result);
    }

    [Theory]
    [InlineData("-PostingState", "Bogus", "PostingState", "Ready|Confirming|Unknown|Posted")]
    [InlineData("-Theme", "Bogus", "Theme", "Dark|Light")]
    public void InvalidLauncherValue_PowerShellValidationRejectsBeforeProofLaunch(
        string parameter, string invalidValue, string diagnosticName, string allowedValues)
    {
        ProcessStartInfo start = PowerShellLauncherStartInfo(parameter, invalidValue);
        ProcessRunResult result = RunProcess(start, TimeSpan.FromSeconds(20));
        string diagnostic = result.StandardError + Environment.NewLine + result.StandardOutput;

        Assert.NotEqual(0, result.ExitCode);
        Assert.Contains(diagnosticName, diagnostic, StringComparison.OrdinalIgnoreCase);
        Assert.Contains(invalidValue, diagnostic, StringComparison.OrdinalIgnoreCase);
        Assert.Contains("ParameterArgumentValidationError", diagnostic, StringComparison.OrdinalIgnoreCase);
        foreach (string allowedValue in allowedValues.Split('|'))
        {
            Assert.Contains(allowedValue, diagnostic, StringComparison.OrdinalIgnoreCase);
        }

        Assert.False(result.ObservedProofProcess);
        Assert.False(result.ObservedProofWindow);
        AssertRejectedLaunchLeftNoSideEffects(result);
    }

    [Theory]
    [InlineData("PostingState", "Ready|Confirming|Unknown|Posted")]
    [InlineData("Theme", "Dark|Light")]
    public void LauncherValidateSetMetadata_MatchesExactExpectedSet(
        string parameterName, string expectedValues)
    {
        string[] actualValues = ReadValidateSetValues(LauncherScript(), parameterName);

        AssertValidateSetEquals(expectedValues.Split('|'), actualValues);
    }

    [Fact]
    public void LauncherValidateSetMetadata_RejectsUnexpectedExtraValue()
    {
        string temporaryLauncher = CreateTemporaryLauncher(
            "[ValidateSet('Dark', 'Light')]",
            "[ValidateSet('Dark', 'Light', 'Sepia')]");
        try
        {
            string[] actualValues = ReadValidateSetValues(temporaryLauncher, "Theme");

            Xunit.Sdk.XunitException exception = Assert.ThrowsAny<Xunit.Sdk.XunitException>(
                () => AssertValidateSetEquals(["Dark", "Light"], actualValues));
            Assert.Contains("Expected: {Dark, Light}", exception.Message, StringComparison.Ordinal);
            Assert.Contains("Actual: {Dark, Light, Sepia}", exception.Message, StringComparison.Ordinal);
        }
        finally
        {
            Directory.Delete(Path.GetDirectoryName(temporaryLauncher)!, recursive: true);
        }
    }

    [Fact]
    public void LauncherValidateSetMetadata_AllowsDeclarationOrderChanges()
    {
        string temporaryLauncher = CreateTemporaryLauncher(
            "[ValidateSet('Dark', 'Light')]",
            "[ValidateSet('Light', 'Dark')]");
        try
        {
            string[] actualValues = ReadValidateSetValues(temporaryLauncher, "Theme");

            AssertValidateSetEquals(["Dark", "Light"], actualValues);
        }
        finally
        {
            Directory.Delete(Path.GetDirectoryName(temporaryLauncher)!, recursive: true);
        }
    }

    [Fact]
    public void ValidateSetComparison_IsCaseInsensitive()
    {
        AssertValidateSetEquals(["Dark", "Light"], ["DARK", "light"]);
    }

    [Fact]
    public void ValidLauncher_RealPowerShellPathCreatesAndClosesProductionCompanion()
    {
        ProcessStartInfo start = PowerShellLauncherStartInfo(
            "-PostingState", "Ready", "-Theme", "Dark", "-AutoClose");
        ProcessRunResult result = RunProcess(start, TimeSpan.FromSeconds(90));
        string diagnostic = result.StandardError + Environment.NewLine + result.StandardOutput;

        Assert.True(result.ExitCode == 0, $"Exit {result.ExitCode}{Environment.NewLine}{diagnostic}");
        Assert.True(result.ObservedProofProcess, "The PowerShell launcher did not start the real proof process.");
        Assert.True(result.ObservedProofWindow, "The real proof process did not create a visible production companion window.");
        Assert.Contains("manual-proof=true; posting-state=Ready; theme=Dark", result.StandardOutput, StringComparison.Ordinal);
        Assert.Contains("class=SysListView32", result.StandardOutput, StringComparison.Ordinal);
        Assert.Contains("fixture-thumbnails=settled; real-thumbnails=2", result.StandardOutput, StringComparison.Ordinal);
        AssertNoNewProofProcesses(result.ProofProcessIdsBefore);
        Assert.False(Directory.Exists(FixtureDirectory()), "The valid launcher smoke left its fixture directory behind.");
    }

    [Fact]
    public void DragProofLauncher_StartsRealCompanionAndRegisteredLocalTargetThenCleansUp()
    {
        ProcessRunResult result = RunProcess(
            PowerShellLauncherStartInfo("-DragProof", "-AutoClose"),
            TimeSpan.FromSeconds(90));
        string diagnostic = result.StandardError + Environment.NewLine + result.StandardOutput;

        Assert.True(result.ExitCode == 0, $"Exit {result.ExitCode}{Environment.NewLine}{diagnostic}");
        Assert.True(result.ObservedProofProcess);
        Assert.True(result.ObservedProofWindow);
        Assert.Contains("drag-proof-ready=true", result.StandardOutput, StringComparison.Ordinal);
        Assert.Contains("drop-target-registered=True", result.StandardOutput, StringComparison.Ordinal);
        Assert.Contains("drag-proof-smoke=passed", result.StandardOutput, StringComparison.Ordinal);
        Assert.Contains("visible-hwnd:", result.StandardOutput, StringComparison.Ordinal);
        Assert.Contains("registered-hwnd:", result.StandardOutput, StringComparison.Ordinal);
        Assert.Contains("register-hr:0x00000000", result.StandardOutput, StringComparison.Ordinal);
        Assert.Contains("nchittest:1", result.StandardOutput, StringComparison.Ordinal);
        Assert.Contains("companion-window=True; target-window=True; target-visible=True; target-enabled=True; target-hit-testable=True; registered=True; selected=0,1,2", result.StandardOutput, StringComparison.Ordinal);
        Assert.Contains("drag-proof-cleanup=passed", result.StandardOutput, StringComparison.Ordinal);
        Assert.Contains("drop-target-revoked=True", result.StandardOutput, StringComparison.Ordinal);
        AssertNoNewProofProcesses(result.ProofProcessIdsBefore);
        Assert.False(Directory.Exists(FixtureDirectory()), "The drag proof smoke left its fixture directory behind.");
    }

    [Theory]
    [InlineData("not-a-number")]
    [InlineData("")]
    [InlineData("99")]
    [InlineData("226")]
    [InlineData("-150")]
    [InlineData("0")]
    [InlineData("150.5")]
    [InlineData("+150")]
    [InlineData(" 150")]
    public void InvalidTextScale_DirectProofHostRejectsBeforeCreatingCompanionWindow(string value)
    {
        ProcessRunResult result = RunProcess(
            ProofStartInfo("--manual-visual-proof", $"--text-scale={value}", "--auto-close", "--no-module-provenance"),
            TimeSpan.FromSeconds(20));

        Assert.Equal(64, result.ExitCode);
        Assert.Contains($"Invalid --text-scale value '{value}'", result.StandardError, StringComparison.Ordinal);
        Assert.Contains("100 through 225", result.StandardError, StringComparison.Ordinal);
        Assert.DoesNotContain("text-scale=", result.StandardOutput, StringComparison.Ordinal);
        Assert.False(result.ObservedProofWindow);
        AssertRejectedLaunchLeftNoSideEffects(result);
    }

    [Fact]
    public void TextScaleWithoutValue_DirectProofHostRejectsBeforeCreatingCompanionWindow()
    {
        ProcessRunResult result = RunProcess(
            ProofStartInfo("--manual-visual-proof", "--text-scale", "--auto-close", "--no-module-provenance"),
            TimeSpan.FromSeconds(20));

        Assert.Equal(64, result.ExitCode);
        Assert.Contains("Invalid --text-scale value ''", result.StandardError, StringComparison.Ordinal);
        Assert.False(result.ObservedProofWindow);
        AssertRejectedLaunchLeftNoSideEffects(result);
    }

    [Theory]
    [InlineData(100)]
    [InlineData(150)]
    [InlineData(225)]
    public void ValidTextScale_DirectProofHostAppliesScaleAtNarrowMinimum(int textScale)
    {
        ProcessRunResult result = RunProcess(
            ProofStartInfo("--manual-visual-proof", $"--text-scale={textScale}", "--auto-close", "--no-module-provenance"),
            TimeSpan.FromSeconds(60));
        string diagnostic = result.StandardError + Environment.NewLine + result.StandardOutput;

        Assert.True(result.ExitCode == 0, $"Exit {result.ExitCode}{Environment.NewLine}{diagnostic}");
        Assert.True(result.ObservedProofWindow);
        Assert.Contains($"text-scale={textScale}; client=640x600;", result.StandardOutput, StringComparison.Ordinal);
        Assert.Contains("cycle=1; passed=True;", result.StandardOutput, StringComparison.Ordinal);
        Assert.DoesNotContain("text-scale-proof=failed", result.StandardOutput, StringComparison.Ordinal);
        AssertNoNewProofProcesses(result.ProofProcessIdsBefore);
    }

    [Fact]
    public void TextScale_WindowClosedBeforeReady_FailsInsteadOfPassingUnappliedScale()
    {
        // --expect-init-failure passes a cycle whose window closed before it became ready, so the same launch
        // without --text-scale passes and only the never-run scaling can fail it.
        string[] closedBeforeReady = ["--close-before-ready", "--expect-init-failure", "--no-module-provenance"];
        ProcessRunResult unscaled = RunProcess(ProofStartInfo(closedBeforeReady), TimeSpan.FromSeconds(30));
        Assert.True(unscaled.ExitCode == 0, $"Exit {unscaled.ExitCode}{Environment.NewLine}{unscaled.StandardOutput}");

        ProcessRunResult result = RunProcess(
            ProofStartInfo([.. closedBeforeReady, "--text-scale=150"]), TimeSpan.FromSeconds(30));

        Assert.Equal(2, result.ExitCode);
        Assert.Contains(
            "text-scale-proof=failed; requested=150; reason=the proof window closed or failed before it became ready",
            result.StandardOutput, StringComparison.Ordinal);
        Assert.Contains("cycle=1; passed=False;", result.StandardOutput, StringComparison.Ordinal);
        Assert.DoesNotContain("passed=True", result.StandardOutput, StringComparison.Ordinal);
        Assert.DoesNotContain("text-scale=150;", result.StandardOutput, StringComparison.Ordinal);
        AssertNoNewProofProcesses(result.ProofProcessIdsBefore);
    }

    [Fact]
    public void TextScale_OperatorClosesWindowDuringProof_NeverPassesUnappliedScale()
    {
        // Closing as soon as the window is shown races the delayed scaling, so either the scale was applied
        // first and printed, or the proof names it as unapplied; it never passes without the scale.
        ProcessRunResult result = RunProcessClosingWindowAfter(
            ProofStartInfo("--manual-visual-proof", "--text-scale=150", "--auto-close", "--no-module-provenance"),
            "manual-proof=true", TimeSpan.FromSeconds(60));
        string diagnostic = result.StandardError + Environment.NewLine + result.StandardOutput;

        bool applied = result.StandardOutput.Contains("text-scale=150; client=640x600;", StringComparison.Ordinal);
        bool reportedUnapplied = result.StandardOutput.Contains(
            "text-scale-proof=failed; requested=150;", StringComparison.Ordinal);
        Assert.True(applied != reportedUnapplied, diagnostic);
        Assert.True(result.ExitCode != 0, diagnostic);
        Assert.Contains("cycle=1; passed=False;", result.StandardOutput, StringComparison.Ordinal);
        Assert.DoesNotContain("passed=True", result.StandardOutput, StringComparison.Ordinal);
        AssertNoNewProofProcesses(result.ProofProcessIdsBefore);
    }

    [Theory]
    [InlineData("button", 0, null)]
    [InlineData("escape", 0, null)]
    [InlineData("system", 0, null)]
    [InlineData("button", 1, null)]
    [InlineData("escape", 1, null)]
    [InlineData("system", 3, null)]
    [InlineData("button", 1, "--release-link=loading")]
    [InlineData("escape", 1, "--posting-state=Confirming")]
    public void OperatorClose_SettledProductionWindow_ExitsEvenWhenFurtherClosesOverlapTeardown(
        string firstClose, int overlappingSystemCloses, string? activeOperation)
    {
        // A settled production window with real WinUI surfaces: an ordinary close, then optionally SC_CLOSE
        // about 300 ms later while WinUI disposal may still be running, must still exit the process.
        var arguments = new List<string> { "--manual-visual-proof", "--no-module-provenance" };
        if (activeOperation is not null) arguments.Add(activeOperation);
        ProcessStartInfo start = ProofStartInfo(arguments.ToArray());
        HashSet<int> proofProcessIdsBefore = CurrentProofProcessIds();
        using var process = new Process { StartInfo = start };
        using var settled = new ManualResetEventSlim();
        var output = new System.Text.StringBuilder();
        process.OutputDataReceived += (_, line) =>
        {
            if (line.Data is null) return;
            lock (output) output.AppendLine(line.Data);
            if (line.Data.StartsWith("fixture-thumbnails=", StringComparison.Ordinal)) settled.Set();
        };
        Assert.True(process.Start());
        process.BeginOutputReadLine();
        Task<string> errorTask = process.StandardError.ReadToEndAsync();
        try
        {
            Assert.True(settled.Wait(TimeSpan.FromSeconds(60)), $"The proof window did not settle.{Environment.NewLine}{output}");
            IntPtr window = VisibleTopLevelWindow(process.Id);
            Assert.True(window != IntPtr.Zero, $"No visible proof window.{Environment.NewLine}{output}");
            switch (firstClose)
            {
                case "button":
                    IntPtr closeButton = FindWindowEx(window, IntPtr.Zero, "Button", "Close");
                    Assert.True(closeButton != IntPtr.Zero, "The native Close button was not found.");
                    Assert.True(PostMessage(closeButton, BM_CLICK, IntPtr.Zero, IntPtr.Zero));
                    break;
                case "escape":
                    Assert.True(PostMessage(window, WM_KEYDOWN, new IntPtr(VK_ESCAPE), IntPtr.Zero));
                    break;
                default:
                    Assert.True(PostMessage(window, WM_SYSCOMMAND, new IntPtr(SC_CLOSE), IntPtr.Zero));
                    break;
            }
            for (int index = 0; index < overlappingSystemCloses; index++)
            {
                Thread.Sleep(index == 0 ? 300 : 100);
                // The window may already be gone; a stale or failed post is part of what is exercised.
                PostMessage(window, WM_SYSCOMMAND, new IntPtr(SC_CLOSE), IntPtr.Zero);
            }

            Assert.True(process.WaitForExit(20_000),
                $"The proof process did not exit after {firstClose} close.{Environment.NewLine}{output}");
            process.WaitForExit(); // Drains the asynchronous stdout reader.
            string diagnostic = errorTask.GetAwaiter().GetResult() + Environment.NewLine + output;
            Assert.True(process.ExitCode == 0, $"Exit {process.ExitCode}{Environment.NewLine}{diagnostic}");
            Assert.Contains("fixture-thumbnails=settled", diagnostic, StringComparison.Ordinal);
            Assert.Contains("cycle=1; passed=True; main-destroyed=True", diagnostic, StringComparison.Ordinal);
            Assert.Contains("native-controls-destroyed=True; islands=2; islands-destroyed=True", diagnostic, StringComparison.Ordinal);
            AssertNoNewProofProcesses(proofProcessIdsBefore);
            Assert.False(Directory.Exists(FixtureDirectory()), "The close proof left its fixture directory behind.");
        }
        finally
        {
            if (!process.HasExited)
            {
                process.Kill(entireProcessTree: true);
                process.WaitForExit(10_000);
            }
            CleanupNewProofProcesses(proofProcessIdsBefore);
        }
    }

    private static string[] NumberedSteps(string text)
    {
        var steps = new List<string>();
        foreach (string line in text.Split(["\r\n", "\n"], StringSplitOptions.None))
        {
            System.Text.RegularExpressions.Match step =
                System.Text.RegularExpressions.Regex.Match(line, @"^\d+\.\s+(.+)$");
            if (step.Success) steps.Add(step.Groups[1].Value);
            else if (steps.Count > 0) break;
        }
        return steps.ToArray();
    }

    private static ManualPreviewFileLease AssertPreviewReady(ManualPreviewAccessResult result)
    {
        Assert.True(result.Success, result.ErrorCode);
        return Assert.IsType<ManualPreviewFileLease>(result.Lease);
    }

    private static string ProofExecutable()
    {
#if DEBUG
        const string configuration = "Debug";
#else
        const string configuration = "Release";
#endif
        return Path.Combine(RepositoryRoot(), "helper", "windows", "tests", "OpenLocally.WinUiHost.Proof",
            "bin", configuration, "net10.0-windows10.0.17763.0", "win-x64", "OpenLocally.WinUiHost.Proof.exe");
    }

    private static ProcessStartInfo ProofStartInfo(params string[] arguments)
    {
        var start = new ProcessStartInfo(ProofExecutable())
        {
            WorkingDirectory = RepositoryRoot(),
            UseShellExecute = false,
            CreateNoWindow = true,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
        };
        foreach (string argument in arguments) start.ArgumentList.Add(argument);
        return start;
    }

    private static ProcessStartInfo PowerShellLauncherStartInfo(params string[] arguments)
    {
        var start = new ProcessStartInfo("powershell.exe")
        {
            WorkingDirectory = RepositoryRoot(),
            UseShellExecute = false,
            CreateNoWindow = true,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
        };
        start.ArgumentList.Add("-NoProfile");
        start.ArgumentList.Add("-NonInteractive");
        start.ArgumentList.Add("-ExecutionPolicy");
        start.ArgumentList.Add("Bypass");
        start.ArgumentList.Add("-File");
        start.ArgumentList.Add(Path.Combine(RepositoryRoot(), "helper", "windows", "tests",
            "OpenLocally.WinUiHost.Proof", "run-manual-visual-proof.ps1"));
        foreach (string argument in arguments) start.ArgumentList.Add(argument);
        return start;
    }

    private static string LauncherScript() => Path.Combine(
        RepositoryRoot(), "helper", "windows", "tests", "OpenLocally.WinUiHost.Proof",
        "run-manual-visual-proof.ps1");

    private static string[] ReadValidateSetValues(string launcherScript, string parameterName)
    {
        const string inspectMetadata =
            "$ErrorActionPreference = 'Stop'; " +
            "$command = Get-Command -Name $env:CREATORCRATE_METADATA_SCRIPT -CommandType ExternalScript; " +
            "$attribute = @($command.Parameters[$env:CREATORCRATE_METADATA_PARAMETER].Attributes | " +
            "Where-Object { $_ -is [System.Management.Automation.ValidateSetAttribute] }); " +
            "if ($attribute.Count -ne 1) { throw \"Expected exactly one ValidateSetAttribute; found $($attribute.Count).\" }; " +
            "$attribute[0].ValidValues | ForEach-Object { [Console]::Out.WriteLine($_) }";
        var start = new ProcessStartInfo("powershell.exe")
        {
            WorkingDirectory = RepositoryRoot(),
            UseShellExecute = false,
            CreateNoWindow = true,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
        };
        start.ArgumentList.Add("-NoProfile");
        start.ArgumentList.Add("-NonInteractive");
        start.ArgumentList.Add("-ExecutionPolicy");
        start.ArgumentList.Add("Bypass");
        start.ArgumentList.Add("-Command");
        start.ArgumentList.Add(inspectMetadata);
        start.Environment["CREATORCRATE_METADATA_SCRIPT"] = launcherScript;
        start.Environment["CREATORCRATE_METADATA_PARAMETER"] = parameterName;

        using var process = new Process { StartInfo = start };
        Assert.True(process.Start());
        string output = process.StandardOutput.ReadToEnd();
        string error = process.StandardError.ReadToEnd();
        Assert.True(process.WaitForExit(20_000), "PowerShell metadata inspection timed out.");
        Assert.True(process.ExitCode == 0,
            $"PowerShell metadata inspection failed with exit {process.ExitCode}:{Environment.NewLine}{error}");
        return output.Split(["\r\n", "\n"], StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries);
    }

    private static void AssertValidateSetEquals(IEnumerable<string> expectedValues, IEnumerable<string> actualValues)
    {
        string[] expected = expectedValues.ToArray();
        string[] actual = actualValues.ToArray();
        var comparer = StringComparer.OrdinalIgnoreCase;
        string expectedDisplay = FormatSet(expected);
        string actualDisplay = FormatSet(actual);
        string[] expectedDuplicates = expected.GroupBy(value => value, comparer)
            .Where(group => group.Count() > 1).Select(group => group.Key).ToArray();
        string[] actualDuplicates = actual.GroupBy(value => value, comparer)
            .Where(group => group.Count() > 1).Select(group => group.Key).ToArray();

        Assert.True(expectedDuplicates.Length == 0,
            $"Expected set contains duplicate values: {string.Join(", ", expectedDuplicates)}. " +
            $"Expected: {expectedDisplay}; Actual: {actualDisplay}");
        Assert.True(actualDuplicates.Length == 0,
            $"Actual ValidateSet contains duplicate values: {string.Join(", ", actualDuplicates)}. " +
            $"Expected: {expectedDisplay}; Actual: {actualDisplay}");
        Assert.True(new HashSet<string>(expected, comparer).SetEquals(actual),
            $"ValidateSet values differ. Expected: {expectedDisplay}; Actual: {actualDisplay}");
    }

    private static string FormatSet(IEnumerable<string> values) =>
        "{" + string.Join(", ", values.OrderBy(value => value, StringComparer.OrdinalIgnoreCase)) + "}";

    private static string CreateTemporaryLauncher(string oldText, string newText)
    {
        string source = File.ReadAllText(LauncherScript());
        string mutated = source.Replace(oldText, newText, StringComparison.Ordinal);
        Assert.NotEqual(source, mutated);
        string temporaryDirectory = Path.Combine(Path.GetTempPath(), $"creatorcrate-validateset-{Guid.NewGuid():N}");
        Directory.CreateDirectory(temporaryDirectory);
        string temporaryLauncher = Path.Combine(temporaryDirectory, "run-manual-visual-proof.ps1");
        File.WriteAllText(temporaryLauncher, mutated);
        return temporaryLauncher;
    }

    private static ProcessRunResult RunProcess(ProcessStartInfo start, TimeSpan timeout)
    {
        HashSet<int> proofProcessIdsBefore = CurrentProofProcessIds();
        bool fixtureExistedBefore = Directory.Exists(FixtureDirectory());
        using var process = new Process { StartInfo = start };
        Assert.True(process.Start());
        Task<string> outputTask = process.StandardOutput.ReadToEndAsync();
        Task<string> errorTask = process.StandardError.ReadToEndAsync();
        bool observedProofProcess = false;
        bool observedProofWindow = false;
        DateTime deadline = DateTime.UtcNow + timeout;

        while (!process.WaitForExit(10))
        {
            foreach (int processId in CurrentProofProcessIds().Except(proofProcessIdsBefore))
            {
                observedProofProcess = true;
                observedProofWindow |= HasVisibleTopLevelWindow(processId);
            }
            if (DateTime.UtcNow < deadline) continue;
            process.Kill(entireProcessTree: true);
            process.WaitForExit(10_000);
            CleanupNewProofProcesses(proofProcessIdsBefore);
            Assert.Fail($"Process timed out after {timeout}: {start.FileName}");
        }

        foreach (int processId in CurrentProofProcessIds().Except(proofProcessIdsBefore))
        {
            observedProofProcess = true;
            observedProofWindow |= HasVisibleTopLevelWindow(processId);
        }
        process.WaitForExit();
        return new ProcessRunResult(
            process.ExitCode,
            outputTask.GetAwaiter().GetResult(),
            errorTask.GetAwaiter().GetResult(),
            observedProofProcess,
            observedProofWindow,
            fixtureExistedBefore,
            proofProcessIdsBefore);
    }

    /// <summary>
    /// Runs the proof and, once a stdout line starts with <paramref name="marker"/>, closes its visible window
    /// the way the title-bar Close button does.
    /// </summary>
    private static ProcessRunResult RunProcessClosingWindowAfter(ProcessStartInfo start, string marker, TimeSpan timeout)
    {
        HashSet<int> proofProcessIdsBefore = CurrentProofProcessIds();
        bool fixtureExistedBefore = Directory.Exists(FixtureDirectory());
        using var process = new Process { StartInfo = start };
        using var markerSeen = new ManualResetEventSlim();
        var output = new System.Text.StringBuilder();
        process.OutputDataReceived += (_, line) =>
        {
            if (line.Data is null) return;
            lock (output) output.AppendLine(line.Data);
            if (line.Data.StartsWith(marker, StringComparison.Ordinal)) markerSeen.Set();
        };
        Assert.True(process.Start());
        process.BeginOutputReadLine();
        Task<string> errorTask = process.StandardError.ReadToEndAsync();

        bool closed = markerSeen.Wait(timeout) && CloseVisibleWindows(process.Id) > 0;
        if (!process.WaitForExit((int)timeout.TotalMilliseconds))
        {
            process.Kill(entireProcessTree: true);
            process.WaitForExit(10_000);
            CleanupNewProofProcesses(proofProcessIdsBefore);
            Assert.Fail($"Process timed out after {timeout}: {start.FileName}{Environment.NewLine}{output}");
        }
        process.WaitForExit(); // Drains the asynchronous stdout reader.
        Assert.True(closed, $"The proof window was not closed after '{marker}'.{Environment.NewLine}{output}");
        lock (output)
            return new ProcessRunResult(process.ExitCode, output.ToString(), errorTask.GetAwaiter().GetResult(),
                true, true, fixtureExistedBefore, proofProcessIdsBefore);
    }

    private static int CloseVisibleWindows(int processId)
    {
        const uint WM_SYSCOMMAND = 0x0112;
        const int SC_CLOSE = 0xF060;
        int closed = 0;
        EnumWindows((window, _) =>
        {
            GetWindowThreadProcessId(window, out uint ownerProcessId);
            if (ownerProcessId == (uint)processId && IsWindowVisible(window) &&
                PostMessage(window, WM_SYSCOMMAND, new IntPtr(SC_CLOSE), IntPtr.Zero))
                closed++;
            return true;
        }, IntPtr.Zero);
        return closed;
    }

    private static void AssertRejectedLaunchLeftNoSideEffects(ProcessRunResult result)
    {
        Assert.Equal(result.FixtureExistedBefore, Directory.Exists(FixtureDirectory()));
        AssertNoNewProofProcesses(result.ProofProcessIdsBefore);
    }

    private static void AssertNoNewProofProcesses(HashSet<int> processIdsBefore)
    {
        DateTime deadline = DateTime.UtcNow + TimeSpan.FromSeconds(5);
        HashSet<int> remaining;
        do
        {
            remaining = CurrentProofProcessIds();
            remaining.ExceptWith(processIdsBefore);
            if (remaining.Count == 0) return;
            Thread.Sleep(25);
        } while (DateTime.UtcNow < deadline);

        CleanupNewProofProcesses(processIdsBefore);
        Assert.Fail($"Proof processes remained after the test: {string.Join(", ", remaining)}");
    }

    private static HashSet<int> CurrentProofProcessIds()
    {
        var result = new HashSet<int>();
        foreach (Process process in Process.GetProcessesByName("OpenLocally.WinUiHost.Proof"))
        {
            using (process)
                try { result.Add(process.Id); }
                catch (InvalidOperationException) { }
        }
        return result;
    }

    private static void CleanupNewProofProcesses(HashSet<int> processIdsBefore)
    {
        foreach (int processId in CurrentProofProcessIds().Except(processIdsBefore))
            try
            {
                using Process process = Process.GetProcessById(processId);
                process.Kill(entireProcessTree: true);
                process.WaitForExit(5_000);
            }
            catch (ArgumentException) { }
            catch (InvalidOperationException) { }
    }

    private static IntPtr VisibleTopLevelWindow(int processId)
    {
        IntPtr found = IntPtr.Zero;
        EnumWindows((window, _) =>
        {
            GetWindowThreadProcessId(window, out uint ownerProcessId);
            if (ownerProcessId != (uint)processId || !IsWindowVisible(window)) return true;
            found = window;
            return false;
        }, IntPtr.Zero);
        return found;
    }

    private static bool HasVisibleTopLevelWindow(int processId)
    {
        bool found = false;
        EnumWindows((window, _) =>
        {
            GetWindowThreadProcessId(window, out uint ownerProcessId);
            if (ownerProcessId == (uint)processId && IsWindowVisible(window))
            {
                found = true;
                return false;
            }
            return true;
        }, IntPtr.Zero);
        return found;
    }

    private static string FixtureDirectory() => Path.Combine(
        RepositoryRoot(), "test-results", "manual-publishing-visual-proof", "fixture");

    private static string RepositoryRoot()
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

    private sealed record ProcessRunResult(
        int ExitCode,
        string StandardOutput,
        string StandardError,
        bool ObservedProofProcess,
        bool ObservedProofWindow,
        bool FixtureExistedBefore,
        HashSet<int> ProofProcessIdsBefore);

    private delegate bool EnumWindowsCallback(IntPtr window, IntPtr parameter);

    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool EnumWindows(EnumWindowsCallback callback, IntPtr parameter);

    [DllImport("user32.dll")]
    private static extern uint GetWindowThreadProcessId(IntPtr window, out uint processId);

    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool IsWindowVisible(IntPtr window);

    [DllImport("user32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool PostMessage(IntPtr window, uint message, IntPtr wParam, IntPtr lParam);

    private const uint BM_CLICK = 0x00F5, WM_KEYDOWN = 0x0100, WM_SYSCOMMAND = 0x0112;
    private const int VK_ESCAPE = 0x1B, SC_CLOSE = 0xF060;

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern IntPtr FindWindowEx(IntPtr parent, IntPtr childAfter, string? className, string? windowName);
}

[CollectionDefinition("Manual visual proof process isolation", DisableParallelization = true)]
public sealed class ManualVisualProofProcessIsolationCollection;
