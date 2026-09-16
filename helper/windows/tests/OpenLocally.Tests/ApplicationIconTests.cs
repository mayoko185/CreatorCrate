using OpenLocally;
using System.ComponentModel;
using System.Diagnostics;
using System.Runtime.InteropServices;

namespace OpenLocally.Tests;

[Collection("Native header resource isolation")]
public sealed class ApplicationIconTests
{
    private static readonly int[] ExpectedSizes = [16, 20, 24, 32, 40, 48, 64, 128, 256];

    [Fact]
    public void CreatorCrateIcon_IsValidIntentionalMultiResolutionContainer()
    {
        byte[] bytes = File.ReadAllBytes(IconPath());
        Assert.True(bytes.Length >= 6);
        Assert.Equal(0, ReadUInt16(bytes, 0));
        Assert.Equal(1, ReadUInt16(bytes, 2));

        int count = ReadUInt16(bytes, 4);
        Assert.Equal(ExpectedSizes.Length, count);
        Assert.True(bytes.Length >= 6 + count * 16);
        var sizes = new List<int>(count);
        for (int index = 0; index < count; index++)
        {
            int entry = 6 + index * 16;
            int width = bytes[entry] == 0 ? 256 : bytes[entry];
            int height = bytes[entry + 1] == 0 ? 256 : bytes[entry + 1];
            uint length = ReadUInt32(bytes, entry + 8);
            uint offset = ReadUInt32(bytes, entry + 12);

            Assert.Equal(width, height);
            Assert.InRange(width, 1, 256);
            Assert.True(length > 0, $"ICO entry {index} was empty.");
            Assert.True(offset >= 6 + count * 16, $"ICO entry {index} overlapped the entry table.");
            Assert.True((ulong)offset + length <= (ulong)bytes.Length,
                $"ICO entry {index} extended beyond the container.");
            sizes.Add(width);
        }

        Assert.Equal(ExpectedSizes, sizes.Order());
        Assert.Contains(16, sizes);
        Assert.Contains(32, sizes);
        Assert.Contains(48, sizes);
        Assert.Contains(256, sizes);
    }

    [Fact]
    public void ProductionAndProofProjects_EvaluateToTheSameCreatorCrateIcon()
    {
        string root = RepositoryRoot();
        string productionProject = Path.Combine(root, "helper", "windows", "src", "OpenLocally", "OpenLocally.csproj");
        string proofProject = Path.Combine(root, "helper", "windows", "tests", "OpenLocally.WinUiHost.Proof",
            "OpenLocally.WinUiHost.Proof.csproj");

        string productionIcon = EvaluateApplicationIcon(productionProject);
        string proofIcon = EvaluateApplicationIcon(proofProject);

        Assert.Equal(IconPath(), productionIcon, StringComparer.OrdinalIgnoreCase);
        Assert.Equal(IconPath(), proofIcon, StringComparer.OrdinalIgnoreCase);
        Assert.Equal(productionIcon, proofIcon, StringComparer.OrdinalIgnoreCase);
    }

    [Theory]
    [MemberData(nameof(BuiltExecutables))]
    public void BuiltExecutable_ContainsUsableSmallAndLargeApplicationIconResources(string name, string executable)
    {
        Assert.True(File.Exists(executable), $"The {name} executable was not built: {executable}");
        IntPtr module = LoadLibraryEx(executable, IntPtr.Zero, LoadLibraryAsDataFile | LoadLibraryAsImageResource);
        if (module == IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error());
        try
        {
            Assert.NotEqual(IntPtr.Zero, FindResource(module, new IntPtr(ApplicationIconId), new IntPtr(RtGroupIcon)));
            AssertUsableSharedIcon(module, GetSystemMetrics(SmCxSmallIcon), GetSystemMetrics(SmCySmallIcon));
            AssertUsableSharedIcon(module, GetSystemMetrics(SmCxIcon), GetSystemMetrics(SmCyIcon));
        }
        finally { Assert.True(FreeLibrary(module)); }
    }

    [Fact]
    public async Task ProductionNativeWindow_RegistersNonOwningLargeAndSmallClassIcons()
    {
        await using var harness = await NativeWindowHarness.StartAsync();
        IntPtr window = harness.Window.WindowHandle;
        Assert.NotEqual(IntPtr.Zero, window);

        IntPtr large = GetClassLongPtr(window, GclpHicon);
        IntPtr small = GetClassLongPtr(window, GclpHiconSm);
        Assert.NotEqual(IntPtr.Zero, large);
        Assert.NotEqual(IntPtr.Zero, small);
        Assert.Equal(large, IconForWindowOrClass(window, IconBig, GclpHicon));
        Assert.Equal(small, IconForWindowOrClass(window, IconSmall, GclpHiconSm));

        // These are LR_SHARED resource/fallback handles owned by Windows; the test must not destroy them.
    }

    public static IEnumerable<object[]> BuiltExecutables()
    {
#if DEBUG
        const string configuration = "Debug";
#else
        const string configuration = "Release";
#endif
        string root = RepositoryRoot();
        yield return ["production", Path.Combine(AppContext.BaseDirectory, "OpenLocally.exe")];
        yield return ["proof", Path.Combine(root, "helper", "windows", "tests", "OpenLocally.WinUiHost.Proof", "bin",
            configuration, "net10.0-windows10.0.17763.0", "win-x64", "OpenLocally.WinUiHost.Proof.exe")];
    }

    private static void AssertUsableSharedIcon(IntPtr module, int width, int height)
    {
        IntPtr icon = LoadImage(module, new IntPtr(ApplicationIconId), ImageIcon, width, height, LrShared);
        Assert.NotEqual(IntPtr.Zero, icon);
        Assert.True(GetIconInfo(icon, out IconInfo info));
        try
        {
            Assert.True(info.hbmColor != IntPtr.Zero || info.hbmMask != IntPtr.Zero);
        }
        finally
        {
            if (info.hbmColor != IntPtr.Zero) Assert.True(DeleteObject(info.hbmColor));
            if (info.hbmMask != IntPtr.Zero) Assert.True(DeleteObject(info.hbmMask));
        }
    }

    private static IntPtr IconForWindowOrClass(IntPtr window, IntPtr size, int classIndex)
    {
        IntPtr icon = SendMessage(window, WmGetIcon, size, IntPtr.Zero);
        return icon != IntPtr.Zero ? icon : GetClassLongPtr(window, classIndex);
    }

    private static string EvaluateApplicationIcon(string project)
    {
        string dotnet = Environment.GetEnvironmentVariable("DOTNET_HOST_PATH") ?? "dotnet";
        var start = new ProcessStartInfo(dotnet)
        {
            WorkingDirectory = RepositoryRoot(),
            UseShellExecute = false,
            CreateNoWindow = true,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
        };
        start.ArgumentList.Add("msbuild");
        start.ArgumentList.Add(project);
        start.ArgumentList.Add("-getProperty:ApplicationIcon");
        start.ArgumentList.Add("-nologo");
        using Process process = Process.Start(start) ?? throw new InvalidOperationException("MSBuild did not start.");
        string output = process.StandardOutput.ReadToEnd();
        string error = process.StandardError.ReadToEnd();
        Assert.True(process.WaitForExit(30_000), $"MSBuild timed out while evaluating {project}.");
        Assert.True(process.ExitCode == 0, $"MSBuild failed for {project}:{Environment.NewLine}{error}{Environment.NewLine}{output}");
        string value = output.Trim();
        Assert.False(string.IsNullOrWhiteSpace(value));
        return Path.GetFullPath(value, Path.GetDirectoryName(project)!);
    }

    private static string IconPath() => Path.Combine(
        RepositoryRoot(), "helper", "windows", "src", "OpenLocally", "CreatorCrate.ico");

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

    private static ushort ReadUInt16(byte[] bytes, int offset) =>
        (ushort)(bytes[offset] | bytes[offset + 1] << 8);

    private static uint ReadUInt32(byte[] bytes, int offset) =>
        (uint)(bytes[offset] | bytes[offset + 1] << 8 | bytes[offset + 2] << 16 | bytes[offset + 3] << 24);

    private sealed class NativeWindowHarness : IAsyncDisposable
    {
        private readonly ManualCompanionLifecycle _lifecycle = new();
        private readonly TaskCompletionSource<Exception?> _closed =
            new(TaskCreationOptions.RunContinuationsAsynchronously);
        private readonly Thread _thread;

        private NativeWindowHarness()
        {
            var session = new ManualSocialSession(new Uri("https://creatorcrate.test/"), 42, "Release title",
                [new ManualPreparedPlatform("x", "Release title", "Post", [])]);
            Window = new NativeManualPublishingCompanion.NativeWindow(
                new ManualPublishingCompanionModel(session), _lifecycle,
                disableWinUiForNativeOnlyTests: true);
            _thread = new Thread(Run) { IsBackground = true, Name = "Production window icon test" };
            _thread.SetApartmentState(ApartmentState.STA);
        }

        public NativeManualPublishingCompanion.NativeWindow Window { get; }

        public static async Task<NativeWindowHarness> StartAsync()
        {
            var harness = new NativeWindowHarness();
            harness._thread.Start();
            await harness._lifecycle.Ready.WaitAsync(TimeSpan.FromSeconds(5));
            return harness;
        }

        public async ValueTask DisposeAsync()
        {
            if (!_closed.Task.IsCompleted) Window.RequestClose();
            Exception? failure = await _closed.Task.WaitAsync(TimeSpan.FromSeconds(5));
            Assert.True(_thread.Join(TimeSpan.FromSeconds(5)));
            if (failure is not null) throw failure;
        }

        private void Run()
        {
            Exception? failure = null;
            try { Window.Run(new NativePresentationResult()); }
            catch (Exception exception) { failure = exception; }
            finally
            {
                try { Window.ShutdownAsync(new NoOpLease()).GetAwaiter().GetResult(); }
                catch (Exception exception) { failure ??= exception; }
                _closed.TrySetResult(failure);
            }
        }
    }

    private sealed class NoOpLease : IDisposable { public void Dispose() { } }

    private const int ApplicationIconId = 32512;
    private const int RtGroupIcon = 14;
    private const uint LoadLibraryAsDataFile = 0x00000002;
    private const uint LoadLibraryAsImageResource = 0x00000020;
    private const uint ImageIcon = 1;
    private const uint LrShared = 0x00008000;
    private const int SmCxIcon = 11;
    private const int SmCyIcon = 12;
    private const int SmCxSmallIcon = 49;
    private const int SmCySmallIcon = 50;
    private const uint WmGetIcon = 0x007F;
    private static readonly IntPtr IconSmall = IntPtr.Zero;
    private static readonly IntPtr IconBig = new(1);
    private const int GclpHicon = -14;
    private const int GclpHiconSm = -34;

    [StructLayout(LayoutKind.Sequential)]
    private struct IconInfo
    {
        [MarshalAs(UnmanagedType.Bool)] public bool fIcon;
        public uint xHotspot;
        public uint yHotspot;
        public IntPtr hbmMask;
        public IntPtr hbmColor;
    }

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern IntPtr LoadLibraryEx(string fileName, IntPtr file, uint flags);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern IntPtr FindResource(IntPtr module, IntPtr name, IntPtr type);
    [DllImport("kernel32.dll")]
    private static extern bool FreeLibrary(IntPtr module);
    [DllImport("user32.dll", EntryPoint = "LoadImageW", SetLastError = true)]
    private static extern IntPtr LoadImage(IntPtr instance, IntPtr name, uint type, int width, int height, uint flags);
    [DllImport("user32.dll", SetLastError = true)]
    private static extern bool GetIconInfo(IntPtr icon, out IconInfo info);
    [DllImport("gdi32.dll", SetLastError = true)]
    private static extern bool DeleteObject(IntPtr value);
    [DllImport("user32.dll")]
    private static extern int GetSystemMetrics(int index);
    [DllImport("user32.dll", EntryPoint = "GetClassLongPtrW", SetLastError = true)]
    private static extern IntPtr GetClassLongPtr(IntPtr window, int index);
    [DllImport("user32.dll", EntryPoint = "SendMessageW", ExactSpelling = true)]
    private static extern IntPtr SendMessage(IntPtr window, uint message, IntPtr wParam, IntPtr lParam);
}
