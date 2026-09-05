using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Security.Principal;
using System.Text;
using System.Text.Json;
using Microsoft.Win32.SafeHandles;

namespace OpenLocally.Tests.Manual;

internal sealed record ManualNativeAppHostPreflightResult(
    string ExecutablePath,
    string WorkingDirectory,
    string ExecutableFinalPath,
    FileAttributes ExecutableAttributes,
    FileAttributes ExecutableParentAttributes,
    bool ReadAccessConfirmed);

internal sealed record ManualNativeAppHostLaunchContext(
    string Launcher,
    string ParentProcess,
    int ProcessId,
    string Identity,
    bool? IsElevated,
    string ElevationType,
    string IntegrityLevel,
    bool? IsAppContainer,
    string TokenInspectionStatus,
    int TokenProcessId,
    string Architecture,
    string ExecutablePath,
    string PublishDirectory,
    string WorkingDirectory,
    bool WorkingDirectoryExists,
    bool ExecutableExists,
    string ExecutableAttributes,
    string ExecutableParentAttributes,
    bool ReadAccessConfirmed,
    string ExecutableFinalPath,
    string[] DotnetEnvironmentVariables,
    bool UseShellExecute,
    bool RedirectStandardOutput,
    bool RedirectStandardError,
    int ArgumentCount,
    string PublishDescriptor);

internal static class ManualNativeAppHostPreflight
{
    internal static ManualNativeAppHostPreflightResult Inspect(string executablePath, string workingDirectory)
    {
        if (!File.Exists(executablePath))
            throw new InvalidOperationException($"Native apphost preflight [file-exists] failed: '{executablePath}' does not exist.");

        string fullExecutablePath;
        try
        {
            fullExecutablePath = Path.GetFullPath(executablePath);
        }
        catch (Exception error)
        {
            throw new InvalidOperationException($"Native apphost preflight [full-path] failed: {error.Message}", error);
        }

        string? executableParent = Path.GetDirectoryName(fullExecutablePath);
        if (string.IsNullOrWhiteSpace(executableParent) || !Directory.Exists(executableParent))
            throw new InvalidOperationException($"Native apphost preflight [executable-parent] failed: '{executableParent ?? "<none>"}' does not exist.");

        if (!Directory.Exists(workingDirectory))
            throw new InvalidOperationException($"Native apphost preflight [working-directory] failed: '{workingDirectory}' does not exist.");

        try
        {
            FileAttributes executableAttributes = File.GetAttributes(fullExecutablePath);
            FileAttributes parentAttributes = File.GetAttributes(executableParent);
            using var stream = new FileStream(fullExecutablePath, FileMode.Open, FileAccess.Read, FileShare.ReadWrite);
            string finalPath = GetFinalPath(stream.SafeFileHandle);

            return new ManualNativeAppHostPreflightResult(
                fullExecutablePath,
                Path.GetFullPath(workingDirectory),
                finalPath,
                executableAttributes,
                parentAttributes,
                ReadAccessConfirmed: true);
        }
        catch (Exception error) when (error is IOException or UnauthorizedAccessException or System.ComponentModel.Win32Exception)
        {
            throw new InvalidOperationException($"Native apphost preflight [read-attributes-final-path] failed: {error.Message}", error);
        }
    }

    internal static void RecordTestHostLaunch(
        string contextPath,
        ManualNativeAppHostPreflightResult preflight,
        ProcessStartInfo start)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(contextPath);

        using Process current = Process.GetCurrentProcess();
        using WindowsIdentity identity = WindowsIdentity.GetCurrent();
        string parentProcess = DescribeParentProcess(current);
        ManualTokenDiagnostics tokenDiagnostics = ManualTokenDiagnostics.InspectCurrentProcess();
        string[] dotnetEnvironmentVariables = Environment.GetEnvironmentVariables()
            .Keys
            .Cast<object>()
            .Select(key => Convert.ToString(key) ?? string.Empty)
            .Where(key => key.StartsWith("DOTNET_", StringComparison.OrdinalIgnoreCase))
            .OrderBy(key => key, StringComparer.OrdinalIgnoreCase)
            .ToArray();

        var context = new ManualNativeAppHostLaunchContext(
            Launcher: "VSTest testhost",
            ParentProcess: parentProcess,
            ProcessId: current.Id,
            Identity: identity.Name ?? "<unavailable>",
            IsElevated: tokenDiagnostics.IsElevated,
            ElevationType: tokenDiagnostics.ElevationType,
            IntegrityLevel: tokenDiagnostics.IntegrityLevel,
            IsAppContainer: tokenDiagnostics.IsAppContainer,
            TokenInspectionStatus: tokenDiagnostics.InspectionStatus,
            TokenProcessId: tokenDiagnostics.ProcessId,
            Architecture: Environment.Is64BitProcess ? "x64" : "x86",
            ExecutablePath: preflight.ExecutablePath,
            PublishDirectory: Path.GetDirectoryName(preflight.ExecutablePath) ?? "<unavailable>",
            WorkingDirectory: preflight.WorkingDirectory,
            WorkingDirectoryExists: Directory.Exists(preflight.WorkingDirectory),
            ExecutableExists: File.Exists(preflight.ExecutablePath),
            ExecutableAttributes: preflight.ExecutableAttributes.ToString(),
            ExecutableParentAttributes: preflight.ExecutableParentAttributes.ToString(),
            ReadAccessConfirmed: preflight.ReadAccessConfirmed,
            ExecutableFinalPath: preflight.ExecutableFinalPath,
            DotnetEnvironmentVariables: dotnetEnvironmentVariables,
            UseShellExecute: start.UseShellExecute,
            RedirectStandardOutput: start.RedirectStandardOutput,
            RedirectStandardError: start.RedirectStandardError,
            ArgumentCount: start.ArgumentList.Count,
            PublishDescriptor: Environment.GetEnvironmentVariable("CREATORCRATE_M2_PUBLISH_DESCRIPTOR") ?? "<unavailable>");

        File.WriteAllText(contextPath, JsonSerializer.Serialize(context));
    }

    private static string GetFinalPath(SafeFileHandle handle)
    {
        var buffer = new StringBuilder(32_768);
        uint length = GetFinalPathNameByHandle(handle, buffer, (uint)buffer.Capacity, 0);
        if (length == 0 || length >= buffer.Capacity)
            throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error(), "Windows could not resolve the final executable path.");

        return buffer.ToString();
    }

    private static string DescribeParentProcess(Process current)
    {
        int parentId = GetParentProcessId(current);
        if (parentId <= 0) return "<unavailable>";

        try
        {
            using Process parent = Process.GetProcessById(parentId);
            return $"{parent.ProcessName} ({parent.Id})";
        }
        catch (ArgumentException)
        {
            return $"exited ({parentId})";
        }
    }

    private static int GetParentProcessId(Process process)
    {
        PROCESS_BASIC_INFORMATION information = default;
        int status = NtQueryInformationProcess(
            process.Handle,
            processInformationClass: 0,
            ref information,
            Marshal.SizeOf<PROCESS_BASIC_INFORMATION>(),
            out _);
        return status == 0 ? information.InheritedFromUniqueProcessId.ToInt32() : 0;
    }

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern uint GetFinalPathNameByHandle(
        SafeFileHandle handle,
        StringBuilder path,
        uint pathLength,
        uint flags);

    [DllImport("ntdll.dll")]
    private static extern int NtQueryInformationProcess(
        IntPtr processHandle,
        int processInformationClass,
        ref PROCESS_BASIC_INFORMATION processInformation,
        int processInformationLength,
        out int returnLength);

    [StructLayout(LayoutKind.Sequential)]
    private struct PROCESS_BASIC_INFORMATION
    {
        internal IntPtr Reserved1;
        internal IntPtr PebBaseAddress;
        internal IntPtr Reserved2_0;
        internal IntPtr Reserved2_1;
        internal UIntPtr UniqueProcessId;
        internal IntPtr InheritedFromUniqueProcessId;
    }
}
