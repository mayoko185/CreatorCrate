using System.Diagnostics;

namespace OpenLocally;

/// <summary>
/// Provides the narrow host facts needed to locate the operator's installed
/// stable Chrome profile. It never launches, configures, or manipulates Chrome.
/// </summary>
public interface IChromeEnvironment
{
    string? GetLocalAppDataPath();

    bool IsStableChromeRunning();
}

public sealed class ChromeEnvironment : IChromeEnvironment
{
    public string? GetLocalAppDataPath()
    {
        string? localAppData = Environment.GetEnvironmentVariable("LOCALAPPDATA");
        return string.IsNullOrWhiteSpace(localAppData) ? null : localAppData;
    }

    public bool IsStableChromeRunning()
    {
        var stableExecutables = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        AddStableExecutable(stableExecutables, GetLocalAppDataPath());
        AddStableExecutable(stableExecutables, Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles));
        AddStableExecutable(stableExecutables, Environment.GetFolderPath(Environment.SpecialFolder.ProgramFilesX86));

        foreach (Process process in Process.GetProcessesByName("chrome"))
        {
            using (process)
            {
                try
                {
                    if (process.MainModule?.FileName is string executable &&
                        stableExecutables.Contains(executable))
                    {
                        return true;
                    }
                }
                catch (Exception ex) when (ex is InvalidOperationException or System.ComponentModel.Win32Exception)
                {
                    // A protected process cannot prove the stable installation is running.
                }
            }
        }

        return false;
    }

    private static void AddStableExecutable(ISet<string> candidates, string? baseDirectory)
    {
        if (!string.IsNullOrWhiteSpace(baseDirectory))
        {
            candidates.Add(Path.Combine(baseDirectory, "Google", "Chrome", "Application", "chrome.exe"));
        }
    }
}
