using System.Diagnostics;

namespace OpenLocally.Tests;

public sealed class WinUiAccessibilityProcessTests
{
    [Fact]
    public void ProductionWinUiHost_RestoresBothIslandsAcrossDarkLightHighContrastDarkAndHighContrastLight()
    {
        string root = FindRepositoryRoot();
#if DEBUG
        const string configuration = "Debug";
#else
        const string configuration = "Release";
#endif
        string executable = Path.Combine(
            root, "helper", "windows", "tests", "OpenLocally.WinUiHost.Proof", "bin", configuration,
            "net10.0-windows10.0.17763.0", "win-x64", "OpenLocally.WinUiHost.Proof.exe");
        Assert.True(File.Exists(executable), $"The production WinUI proof was not built: {executable}");

        using var process = new Process
        {
            StartInfo = new ProcessStartInfo(executable)
            {
                WorkingDirectory = root,
                UseShellExecute = false,
                CreateNoWindow = true,
                RedirectStandardOutput = true,
                RedirectStandardError = true,
            },
        };
        process.StartInfo.ArgumentList.Add("--theme-cycle-check");
        process.StartInfo.ArgumentList.Add("--auto-close");
        process.StartInfo.ArgumentList.Add("--no-module-provenance");

        Assert.True(process.Start());
        string output = process.StandardOutput.ReadToEnd();
        string error = process.StandardError.ReadToEnd();
        if (!process.WaitForExit(30_000))
        {
            process.Kill(entireProcessTree: true);
            Assert.Fail("The production WinUI theme-cycle process timed out.");
        }

        Assert.True(process.ExitCode == 0, $"Exit {process.ExitCode}{Environment.NewLine}{error}{Environment.NewLine}{output}");
        Assert.Contains(
            "whole-window-theme-cycle=Dark->Light->HighContrast->Dark; hwnd-and-islands=same; content-and-selection=same",
            output, StringComparison.Ordinal);
        Assert.Contains(
            "whole-window-theme-cycle=Dark->HighContrast->Light; hwnd-and-islands=same; content-and-selection=same",
            output, StringComparison.Ordinal);
        Assert.Contains("theme-resource-stage=HighContrast/Default; surface=title; root=;", output, StringComparison.Ordinal);
        Assert.Contains("theme-resource-stage=HighContrast/Default; surface=body; root=;", output, StringComparison.Ordinal);
        Assert.Contains("theme-resource-stage=Dark restored; surface=title; root=#171b22; editor=#1d222b;", output, StringComparison.Ordinal);
        Assert.Contains("theme-resource-stage=Dark restored; surface=body; root=#171b22; editor=#1d222b;", output, StringComparison.Ordinal);
        Assert.Contains(
            "theme-resource-lifetime=passed; repeated-same-island-cycles=5; USER-growth=0; GDI-growth=0",
            output, StringComparison.Ordinal);
    }

    [Fact]
    public void ProductionCompanion_RequiresAccessiblePostingButtonAndSafeReadOnlyRichEditBoxesAcrossPlatforms()
    {
        string output = RunAccessibilityProof("--accessibility-check");

        Assert.Contains("production-uia-check=passed; mode=deterministic;", output, StringComparison.Ordinal);
        Assert.Contains("expand-collapse-pattern=true", output, StringComparison.Ordinal);
        Assert.Contains("high-contrast-contract=passed", output, StringComparison.Ordinal);
        Assert.Contains("winui-scaling-enabled=true", output, StringComparison.Ordinal);
        Assert.Contains("resize-island-bounds=passed; outer=1200x900;", output, StringComparison.Ordinal);
        Assert.Contains("source=production-layout; immediate=true", output, StringComparison.Ordinal);
        Assert.DoesNotContain("Height = 173", output, StringComparison.Ordinal);
        Assert.Contains("minimum-containment=passed", output, StringComparison.Ordinal);
        Assert.Contains("hidden-title=absent", output, StringComparison.Ordinal);
        Assert.Contains("posting-action-required=true", output, StringComparison.Ordinal);
        Assert.Contains("ready-forward-tab=passed", output, StringComparison.Ordinal);
        Assert.Contains("ready-reverse-tab=passed", output, StringComparison.Ordinal);
        Assert.Contains("richedit-enter=passed", output, StringComparison.Ordinal);
        Assert.Contains("whole-window-theme-cycle=Dark->Light->HighContrast->Dark", output, StringComparison.Ordinal);
        Assert.Contains("native-font-roles=passed", output, StringComparison.Ordinal);
        Assert.Contains("surface-hierarchy=passed", output, StringComparison.Ordinal);
        Assert.Contains("posting-requests=0", output, StringComparison.Ordinal);
        Assert.Contains("copy-invocations=0", output, StringComparison.Ordinal);
        Assert.Contains("mark-enter=passed", output, StringComparison.Ordinal);
        Assert.Contains("retry-tab=passed", output, StringComparison.Ordinal);
        Assert.Contains("retry-enter=passed", output, StringComparison.Ordinal);
        Assert.Contains("escape-with-posting-ui=passed", output, StringComparison.Ordinal);
    }

    [Fact]
    [Trait("Category", "InteractiveDesktop")]
    public void ProductionCompanion_PhysicalUiaFocusInputInvokeAndExpandCollapse()
    {
        string output = RunAccessibilityProof("--interactive-accessibility-check");

        Assert.Contains("production-uia-check=passed; mode=interactive-desktop;", output, StringComparison.Ordinal);
        Assert.Contains("selection-items=Patreon,X,Bluesky; selection-item-pattern=true; collapsed-in-finally=true", output, StringComparison.Ordinal);
        Assert.Contains("typing-paste-rejected=true", output, StringComparison.Ordinal);
        Assert.Contains("uia-invoke=Mark as posted; dispatched=true", output, StringComparison.Ordinal);
    }

    private static string RunAccessibilityProof(string mode)
    {
        string root = FindRepositoryRoot();
#if DEBUG
        const string configuration = "Debug";
#else
        const string configuration = "Release";
#endif
        string executable = Path.Combine(
            root, "helper", "windows", "tests", "OpenLocally.WinUiHost.Proof", "bin", configuration,
            "net10.0-windows10.0.17763.0", "win-x64", "OpenLocally.WinUiHost.Proof.exe");
        Assert.True(File.Exists(executable), $"The production WinUI proof was not built: {executable}");

        using var process = new Process
        {
            StartInfo = new ProcessStartInfo(executable)
            {
                WorkingDirectory = root,
                UseShellExecute = false,
                CreateNoWindow = true,
                RedirectStandardOutput = true,
                RedirectStandardError = true,
            },
        };
        process.StartInfo.ArgumentList.Add(mode);
        process.StartInfo.ArgumentList.Add("--production-surface-check");
        process.StartInfo.ArgumentList.Add("--production-text-check");
        process.StartInfo.ArgumentList.Add("--resize-check");
        process.StartInfo.ArgumentList.Add("--no-module-provenance");

        Assert.True(process.Start());
        string output = process.StandardOutput.ReadToEnd();
        string error = process.StandardError.ReadToEnd();
        if (!process.WaitForExit(30_000))
        {
            process.Kill(entireProcessTree: true);
            Assert.Fail("The production WinUI accessibility process timed out.");
        }

        Assert.True(process.ExitCode == 0, $"Exit {process.ExitCode}{Environment.NewLine}{error}{Environment.NewLine}{output}");
        return output;
    }

    private static string FindRepositoryRoot()
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
}
