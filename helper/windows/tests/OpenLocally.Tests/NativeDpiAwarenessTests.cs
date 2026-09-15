using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.Json;

namespace OpenLocally.Tests;

public sealed class NativeDpiAwarenessTests
{
    [Fact]
    public void BuiltExecutable_EmbedsCommonControlsV6AndPerMonitorV2Manifest()
    {
        string manifest = ReadEmbeddedManifest(ProductionExecutable());

        Assert.Contains("Microsoft.Windows.Common-Controls", manifest);
        Assert.Contains("version=\"6.0.0.0\"", manifest);
        Assert.Contains("<dpiAware xmlns=\"http://schemas.microsoft.com/SMI/2005/WindowsSettings\">true/pm</dpiAware>", manifest);
        Assert.Contains("<dpiAwareness xmlns=\"http://schemas.microsoft.com/SMI/2016/WindowsSettings\">PerMonitorV2, PerMonitor</dpiAwareness>", manifest);
    }

    [Fact]
    public void ProductionExecutable_UsesPerMonitorV2AndExercisesNativeDpiChangePath()
    {
        string output = Path.Combine(Path.GetTempPath(), $"creatorcrate-dpi-{Guid.NewGuid():N}.json");
        try
        {
            var start = new ProcessStartInfo(ProductionExecutable())
            {
                UseShellExecute = false,
                CreateNoWindow = true,
            };
            start.ArgumentList.Add("--creatorcrate-verify-dpi-awareness");
            start.ArgumentList.Add(output);
            using Process process = Process.Start(start) ?? throw new InvalidOperationException("The production DPI probe did not start.");
            Assert.True(process.WaitForExit(15_000), "The production DPI probe timed out.");

            string json = File.ReadAllText(output);
            DpiAwarenessProbeResult result = JsonSerializer.Deserialize<DpiAwarenessProbeResult>(json)
                ?? throw new InvalidOperationException($"The production DPI probe returned no result: {json}");

            Assert.Equal(0, process.ExitCode);
            Assert.True(result.ThreadPerMonitorV2);
            Assert.True(result.WindowPerMonitorV2);
            Assert.InRange(result.InitialDpi, 96, 768);
            Assert.True(result.DpiChangedReceived);
            Assert.True(result.SuggestedBoundsProcessed);
            Assert.True(result.ThemeDpiUpdated);
            Assert.True(result.FontResourcesRebuilt);
            Assert.True(result.LayoutUpdated);
            if (result.RealTransitionAttempted)
                Assert.True(result.RealTransitionObserved, result.RealTransitionLimitation);
            else
                Assert.False(string.IsNullOrWhiteSpace(result.RealTransitionLimitation));
        }
        finally
        {
            if (File.Exists(output)) File.Delete(output);
        }
    }

    [Fact]
    public void ProductionDoesNotOverrideManifestDpiAwarenessAtRuntime()
    {
        string sourceDirectory = Path.Combine(FindRepositoryRoot(), "helper", "windows", "src", "OpenLocally");
        string source = string.Join('\n', Directory.EnumerateFiles(sourceDirectory, "*.cs").Select(File.ReadAllText));

        Assert.DoesNotContain("SetProcessDpiAwarenessContext", source);
        Assert.DoesNotContain("SetThreadDpiAwarenessContext", source);
    }

    private static string ProductionExecutable()
    {
        string executable = Path.Combine(AppContext.BaseDirectory, "OpenLocally.exe");
        Assert.True(File.Exists(executable), $"Production executable was not copied beside the test assembly: {executable}");
        return executable;
    }

    private static string ReadEmbeddedManifest(string executable)
    {
        IntPtr module = LoadLibraryEx(executable, IntPtr.Zero, 0x00000002);
        if (module == IntPtr.Zero) throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
        try
        {
            IntPtr resource = FindResource(module, new IntPtr(1), new IntPtr(24));
            if (resource == IntPtr.Zero) throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
            uint size = SizeofResource(module, resource);
            IntPtr loaded = LoadResource(module, resource);
            IntPtr bytes = LockResource(loaded);
            if (size == 0 || loaded == IntPtr.Zero || bytes == IntPtr.Zero)
                throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
            byte[] buffer = new byte[size];
            Marshal.Copy(bytes, buffer, 0, buffer.Length);
            return Encoding.UTF8.GetString(buffer).TrimEnd('\0');
        }
        finally { FreeLibrary(module); }
    }

    private static string FindRepositoryRoot()
    {
        DirectoryInfo? current = new(AppContext.BaseDirectory);
        while (current is not null)
        {
            if (File.Exists(Path.Combine(current.FullName, "helper", "windows", "src", "OpenLocally", "OpenLocally.csproj")))
                return current.FullName;
            current = current.Parent;
        }
        throw new DirectoryNotFoundException("CreatorCrate repository root was not found.");
    }

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern IntPtr LoadLibraryEx(string fileName, IntPtr file, uint flags);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern IntPtr FindResource(IntPtr module, IntPtr name, IntPtr type);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern uint SizeofResource(IntPtr module, IntPtr resource);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern IntPtr LoadResource(IntPtr module, IntPtr resource);
    [DllImport("kernel32.dll")]
    private static extern IntPtr LockResource(IntPtr resource);
    [DllImport("kernel32.dll")]
    private static extern bool FreeLibrary(IntPtr module);
}
