using Microsoft.Win32.SafeHandles;
using System.Runtime.InteropServices;
using System.Text;

namespace OpenLocally;

internal sealed record ManualPreviewAccessResult(
    bool Success, string? ErrorCode, ManualPreviewFileLease? Lease)
{
    public static ManualPreviewAccessResult Ready(ManualPreviewFileLease lease) => new(true, null, lease);
    public static ManualPreviewAccessResult Fail(string code) => new(false, code, null);
}

/// <summary>Cache-safe identity/version data obtained from an already-pinned file handle.</summary>
internal readonly record struct ManualPreviewFileCacheIdentity(
    ulong VolumeSerialNumber, ulong FileIdLow, ulong FileIdHigh, long Size,
    long LastWriteTime, long ChangeTime)
{
    internal static ManualPreviewFileCacheIdentity? TryCreate(SafeFileHandle handle)
    {
        if (handle.IsInvalid || handle.IsClosed ||
            !NativeMethods.GetFileInformationByHandleEx(
                handle, NativeMethods.FileInfoByHandleClass.FileIdInfo,
                out NativeMethods.FileIdInfo id, (uint)Marshal.SizeOf<NativeMethods.FileIdInfo>()) ||
            !NativeMethods.GetFileInformationByHandleEx(
                handle, NativeMethods.FileInfoByHandleClass.FileBasicInfo,
                out NativeMethods.FileBasicInfo basic, (uint)Marshal.SizeOf<NativeMethods.FileBasicInfo>()) ||
            !NativeMethods.GetFileSizeEx(handle, out long size) ||
            id.VolumeSerialNumber == 0 || (id.FileIdLow == 0 && id.FileIdHigh == 0) ||
            basic.ChangeTime <= 0)
            return null;

        return new(
            id.VolumeSerialNumber, id.FileIdLow, id.FileIdHigh, size,
            basic.LastWriteTime, basic.ChangeTime);
    }

    private static class NativeMethods
    {
        internal enum FileInfoByHandleClass
        {
            FileBasicInfo = 0,
            FileIdInfo = 18,
        }

        [StructLayout(LayoutKind.Sequential)]
        internal struct FileBasicInfo
        {
            internal long CreationTime;
            internal long LastAccessTime;
            internal long LastWriteTime;
            internal long ChangeTime;
            internal uint FileAttributes;
        }

        [StructLayout(LayoutKind.Sequential)]
        internal struct FileIdInfo
        {
            internal ulong VolumeSerialNumber;
            internal ulong FileIdLow;
            internal ulong FileIdHigh;
        }

        [DllImport("kernel32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        internal static extern bool GetFileInformationByHandleEx(
            SafeFileHandle file, FileInfoByHandleClass fileInformationClass,
            out FileIdInfo fileInformation, uint bufferSize);

        [DllImport("kernel32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        internal static extern bool GetFileInformationByHandleEx(
            SafeFileHandle file, FileInfoByHandleClass fileInformationClass,
            out FileBasicInfo fileInformation, uint bufferSize);

        [DllImport("kernel32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        internal static extern bool GetFileSizeEx(SafeFileHandle file, out long fileSize);
    }
}

/// <summary>Pins one validated local file path for the duration of a bounded preview read.</summary>
internal sealed class ManualPreviewFileLease : IDisposable
{
    private IReadOnlyList<IDisposable>? _resources;

    internal ManualPreviewFileLease(
        string path, long assetId, StagedMediaProvenance provenance,
        SafeFileHandle readHandle, IReadOnlyList<IDisposable> resources,
        ManualPreviewFileCacheIdentity? cacheIdentity = null)
    {
        Path = path;
        AssetId = assetId;
        Provenance = provenance;
        ReadHandle = readHandle;
        CacheIdentity = cacheIdentity;
        _resources = resources;
    }

    public string Path { get; }
    public long AssetId { get; }
    public StagedMediaProvenance Provenance { get; }
    internal SafeFileHandle ReadHandle { get; }
    internal ManualPreviewFileCacheIdentity? CacheIdentity { get; }
    internal bool IsDisposed => Volatile.Read(ref _resources) is null;

    public void Dispose()
    {
        IReadOnlyList<IDisposable>? resources = Interlocked.Exchange(ref _resources, null);
        if (resources is null) return;
        for (int index = resources.Count - 1; index >= 0; index--) resources[index].Dispose();
    }
}

/// <summary>
/// Side-effect-free local preview boundary. It never downloads, restages, prompts,
/// refreshes retention, or mutates drag availability.
/// </summary>
internal interface IManualAssetPreviewAccess : IDisposable
{
    ManualPreviewAccessResult TryAcquireRead(ManualPreparedAsset prepared, int ordinal);
}

internal sealed class ManualAssetPreviewAccess : IManualAssetPreviewAccess
{
    private const string MarkerContents = "creatorcrate-social-prep-v1";
    private readonly SocialOrigin _origin;
    private readonly string _sessionId;
    private readonly LocalMediaResolver _localResolver;
    private readonly SocialMediaStager _stager;
    private int _disposed;

    public ManualAssetPreviewAccess(
        SocialOrigin origin, string sessionId, LocalMediaResolver localResolver, SocialMediaStager stager) =>
        (_origin, _sessionId, _localResolver, _stager) =
        (origin ?? throw new ArgumentNullException(nameof(origin)),
         sessionId ?? throw new ArgumentNullException(nameof(sessionId)),
         localResolver ?? throw new ArgumentNullException(nameof(localResolver)),
         stager ?? throw new ArgumentNullException(nameof(stager)));

    public ManualPreviewAccessResult TryAcquireRead(ManualPreparedAsset prepared, int ordinal)
    {
        ArgumentNullException.ThrowIfNull(prepared);
        if (Volatile.Read(ref _disposed) != 0) return ManualPreviewAccessResult.Fail("preview_access_closed");
        if (prepared.Asset.SizeBytes < 0 || string.IsNullOrWhiteSpace(prepared.Path))
            return ManualPreviewAccessResult.Fail("validation_failed");

        string path;
        string boundaryRoot;
        string? markerPath = null;
        if (prepared.Provenance == StagedMediaProvenance.HelperOwned)
        {
            if (!_stager.TryGetOwnedReadBoundary(
                _sessionId, prepared.Asset, ordinal, prepared.Path, out OwnedMediaReadBoundary? owned))
                return ManualPreviewAccessResult.Fail("validation_failed");
            path = owned!.Path;
            boundaryRoot = owned.StagingRoot;
            markerPath = owned.MarkerPath;
        }
        else if (prepared.Provenance == StagedMediaProvenance.ExternalSource)
        {
            if (!_localResolver.TryGetTrustedReadBoundary(
                _origin, prepared.Asset, prepared.Path, out LocalMediaReadBoundary? external, out string? errorCode))
                return ManualPreviewAccessResult.Fail(errorCode!);
            path = external!.Path;
            boundaryRoot = external.Root;
        }
        else return ManualPreviewAccessResult.Fail("validation_failed");

        return TryPin(prepared, boundaryRoot, path, markerPath);
    }

    public void Dispose() => Interlocked.Exchange(ref _disposed, 1);

    private static ManualPreviewAccessResult TryPin(
        ManualPreparedAsset prepared, string boundaryRoot, string path, string? markerPath)
    {
        var resources = new List<IDisposable>();
        bool completed = false;
        try
        {
            string fullPath = Path.GetFullPath(path);
            string parent = Path.GetDirectoryName(fullPath) ?? throw new IOException();
            foreach (string directory in DirectoryChain(boundaryRoot, parent))
            {
                SafeFileHandle directoryHandle = OpenDirectory(directory);
                if (directoryHandle.IsInvalid || !IsExpectedDirectory(directoryHandle, directory))
                {
                    directoryHandle.Dispose();
                    return ManualPreviewAccessResult.Fail("media_file_unsafe");
                }
                resources.Add(directoryHandle);
            }

            if (markerPath is not null)
            {
                SafeFileHandle markerHandle = OpenFile(markerPath);
                if (markerHandle.IsInvalid || !IsExpectedRegularFile(markerHandle, markerPath, MarkerContents.Length))
                {
                    markerHandle.Dispose();
                    return ManualPreviewAccessResult.Fail("media_file_unsafe");
                }
                var markerStream = new FileStream(markerHandle, FileAccess.Read);
                resources.Add(markerStream);
                Span<byte> marker = stackalloc byte[MarkerContents.Length];
                markerStream.ReadExactly(marker);
                if (!marker.SequenceEqual(Encoding.ASCII.GetBytes(MarkerContents)))
                    return ManualPreviewAccessResult.Fail("media_file_unsafe");
            }

            SafeFileHandle fileHandle = OpenFile(fullPath);
            if (fileHandle.IsInvalid)
            {
                fileHandle.Dispose();
                return ManualPreviewAccessResult.Fail(PathExists(fullPath) ? "media_file_unsafe" : "media_file_missing");
            }
            if (!IsExpectedRegularFile(fileHandle, fullPath, prepared.Asset.SizeBytes))
            {
                bool sizeMismatch = IsRegularFile(fileHandle) && NativeMethods.GetFileSizeEx(fileHandle, out long size) &&
                    size != prepared.Asset.SizeBytes;
                fileHandle.Dispose();
                return ManualPreviewAccessResult.Fail(sizeMismatch ? "media_size_mismatch" : "media_file_unsafe");
            }
            resources.Add(fileHandle);

            ManualPreviewFileCacheIdentity? cacheIdentity = ManualPreviewFileCacheIdentity.TryCreate(fileHandle);
            var lease = new ManualPreviewFileLease(
                fullPath, prepared.Asset.AssetId, prepared.Provenance, fileHandle, resources.AsReadOnly(), cacheIdentity);
            completed = true;
            return ManualPreviewAccessResult.Ready(lease);
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or ArgumentException or NotSupportedException)
        {
            return ManualPreviewAccessResult.Fail(PathExists(path) ? "media_file_unsafe" : "media_file_missing");
        }
        finally
        {
            if (!completed)
                for (int index = resources.Count - 1; index >= 0; index--) resources[index].Dispose();
        }
    }

    private static IEnumerable<string> DirectoryChain(string boundaryRoot, string directory)
    {
        string full = Path.GetFullPath(directory);
        string root = Path.TrimEndingDirectorySeparator(Path.GetFullPath(boundaryRoot));
        if (!string.Equals(full, root, StringComparison.OrdinalIgnoreCase) &&
            !full.StartsWith(root + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase))
            throw new IOException();
        yield return root;
        string current = root;
        foreach (string segment in full[root.Length..].Split(
            [Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar], StringSplitOptions.RemoveEmptyEntries))
        {
            current = Path.Combine(current, segment);
            yield return current;
        }
    }

    private static SafeFileHandle OpenDirectory(string path) => NativeMethods.CreateFileW(
        path, NativeMethods.FileReadAttributes, FileShare.Read | FileShare.Write, IntPtr.Zero,
        FileMode.Open, NativeMethods.FileFlagBackupSemantics | NativeMethods.FileFlagOpenReparsePoint, IntPtr.Zero);

    private static SafeFileHandle OpenFile(string path) => NativeMethods.CreateFileW(
        path, NativeMethods.GenericRead, FileShare.Read, IntPtr.Zero,
        FileMode.Open, NativeMethods.FileFlagOpenReparsePoint, IntPtr.Zero);

    private static bool IsExpectedDirectory(SafeFileHandle handle, string path) =>
        IsDirectory(handle) && FinalPathMatches(handle, path);

    private static bool IsExpectedRegularFile(SafeFileHandle handle, string path, long expectedSize) =>
        IsRegularFile(handle) && NativeMethods.GetFileSizeEx(handle, out long size) && size == expectedSize &&
        FinalPathMatches(handle, path);

    private static bool IsDirectory(SafeFileHandle handle) =>
        TryGetAttributes(handle, out uint attributes) &&
        (attributes & ((uint)FileAttributes.Directory | (uint)FileAttributes.ReparsePoint)) == (uint)FileAttributes.Directory;

    private static bool IsRegularFile(SafeFileHandle handle) =>
        TryGetAttributes(handle, out uint attributes) &&
        (attributes & ((uint)FileAttributes.Directory | (uint)FileAttributes.ReparsePoint)) == 0;

    private static bool TryGetAttributes(SafeFileHandle handle, out uint attributes)
    {
        bool result = NativeMethods.GetFileInformationByHandleEx(
            handle, NativeMethods.FileInfoByHandleClass.FileAttributeTagInfo,
            out NativeMethods.FileAttributeTagInfo information,
            (uint)Marshal.SizeOf<NativeMethods.FileAttributeTagInfo>());
        attributes = information.FileAttributes;
        return result;
    }

    private static bool FinalPathMatches(SafeFileHandle handle, string expectedPath)
    {
        var buffer = new char[32768];
        uint length = NativeMethods.GetFinalPathNameByHandleW(
            handle, buffer, (uint)buffer.Length, NativeMethods.FileNameNormalized | NativeMethods.VolumeNameDos);
        if (length == 0 || length >= buffer.Length) return false;
        string actual = new(buffer, 0, (int)length);
        if (actual.StartsWith(@"\\?\", StringComparison.Ordinal)) actual = actual[4..];
        return string.Equals(
            Path.TrimEndingDirectorySeparator(Path.GetFullPath(actual)),
            Path.TrimEndingDirectorySeparator(Path.GetFullPath(expectedPath)),
            StringComparison.OrdinalIgnoreCase);
    }

    private static bool PathExists(string path) => File.Exists(path) || Directory.Exists(path);

    private static class NativeMethods
    {
        internal const uint GenericRead = 0x80000000;
        internal const uint FileReadAttributes = 0x00000080;
        internal const uint FileFlagBackupSemantics = 0x02000000;
        internal const uint FileFlagOpenReparsePoint = 0x00200000;
        internal const uint FileNameNormalized = 0x0;
        internal const uint VolumeNameDos = 0x0;

        internal enum FileInfoByHandleClass { FileAttributeTagInfo = 9 }

        [StructLayout(LayoutKind.Sequential)]
        internal struct FileAttributeTagInfo
        {
            internal uint FileAttributes;
            internal uint ReparseTag;
        }

        [DllImport("kernel32.dll", EntryPoint = "CreateFileW", SetLastError = true, CharSet = CharSet.Unicode)]
        internal static extern SafeFileHandle CreateFileW(
            string fileName, uint desiredAccess, FileShare shareMode, IntPtr securityAttributes,
            FileMode creationDisposition, uint flagsAndAttributes, IntPtr templateFile);

        [DllImport("kernel32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        internal static extern bool GetFileInformationByHandleEx(
            SafeFileHandle file, FileInfoByHandleClass fileInformationClass,
            out FileAttributeTagInfo fileInformation, uint bufferSize);

        [DllImport("kernel32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        internal static extern bool GetFileSizeEx(SafeFileHandle file, out long fileSize);

        [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
        internal static extern uint GetFinalPathNameByHandleW(
            SafeFileHandle file, [Out] char[] filePath, uint filePathSize, uint flags);
    }
}
