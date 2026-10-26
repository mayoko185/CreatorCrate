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
            FinalPathRoot? verifiedRoot = null;
            foreach (string directory in DirectoryChain(boundaryRoot, parent))
            {
                SafeFileHandle directoryHandle = OpenDirectory(directory);
                bool expected = !directoryHandle.IsInvalid && IsDirectory(directoryHandle) &&
                    TryGetFinalPath(directoryHandle, out string? finalPath) &&
                    (verifiedRoot is null
                        ? (verifiedRoot = FinalPathRoot.Verify(directory, finalPath!, MappedDriveConnection)) is not null
                        : verifiedRoot.Matches(directory, finalPath!));
                if (!expected)
                {
                    directoryHandle.Dispose();
                    return ManualPreviewAccessResult.Fail("media_file_unsafe");
                }
                resources.Add(directoryHandle);
            }
            if (verifiedRoot is null) return ManualPreviewAccessResult.Fail("media_file_unsafe");

            if (markerPath is not null)
            {
                SafeFileHandle markerHandle = OpenFile(markerPath);
                if (markerHandle.IsInvalid || !IsExpectedRegularFile(markerHandle, verifiedRoot, markerPath, MarkerContents.Length))
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
            if (!IsExpectedRegularFile(fileHandle, verifiedRoot, fullPath, prepared.Asset.SizeBytes))
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

    private static bool IsExpectedRegularFile(
        SafeFileHandle handle, FinalPathRoot root, string path, long expectedSize) =>
        IsRegularFile(handle) && NativeMethods.GetFileSizeEx(handle, out long size) && size == expectedSize &&
        TryGetFinalPath(handle, out string? finalPath) && root.Matches(path, finalPath!);

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

    private static bool TryGetFinalPath(SafeFileHandle handle, out string? finalPath)
    {
        var buffer = new char[32768];
        uint length = NativeMethods.GetFinalPathNameByHandleW(
            handle, buffer, (uint)buffer.Length, NativeMethods.FileNameNormalized | NativeMethods.VolumeNameDos);
        finalPath = length == 0 || length >= buffer.Length ? null : new string(buffer, 0, (int)length);
        return finalPath is not null;
    }

    /// <summary>
    /// Converts a GetFinalPathNameByHandleW result to an absolute DOS or UNC path without any
    /// relative resolution. Volume GUID, device, relative, and malformed results are rejected.
    /// </summary>
    internal static string? NormalizeFinalPath(string? finalPath)
    {
        if (finalPath is null) return null;
        string candidate;
        if (finalPath.StartsWith(@"\\?\UNC\", StringComparison.OrdinalIgnoreCase)) candidate = @"\\" + finalPath[8..];
        else if (finalPath.StartsWith(@"\\?\", StringComparison.Ordinal) && finalPath.Length >= 7 &&
            char.IsAsciiLetter(finalPath[4]) && finalPath[5] == ':' && finalPath[6] == '\\') candidate = finalPath[4..];
        else return null;
        return TrySplitAbsolute(candidate, out string[]? segments) ? JoinSegments(segments!) : null;
    }

    /// <summary>
    /// Splits an absolute drive (X:\...) or UNC (\\server\share\...) path into case-insensitively
    /// comparable components. The first component identifies the volume ("X:" or "\\server"; a UNC
    /// share is the second component). Empty, "." and ".." components and forward slashes are rejected.
    /// </summary>
    private static bool TrySplitAbsolute(string path, out string[]? segments)
    {
        segments = null;
        if (path.Contains('/') || path.Contains('\0')) return false;
        string body;
        string volume;
        int minimum;
        if (path.Length >= 3 && char.IsAsciiLetter(path[0]) && path[1] == ':' && path[2] == '\\')
        {
            volume = path[..2];
            body = path[3..];
            minimum = 1;
        }
        else if (path.StartsWith(@"\\", StringComparison.Ordinal) && path.Length > 2 && path[2] != '\\' &&
            path[2] != '?' && path[2] != '.')
        {
            int serverEnd = path.IndexOf('\\', 2);
            if (serverEnd < 0) return false;
            volume = path[..serverEnd];
            body = path[(serverEnd + 1)..];
            minimum = 2;
        }
        else return false;

        if (body.EndsWith('\\')) body = body[..^1];
        string[] rest = body.Length == 0 ? [] : body.Split('\\');
        if (rest.Any(segment => segment.Length == 0 || segment is "." or "..")) return false;
        segments = [volume, .. rest];
        return segments.Length >= minimum;
    }

    private static string JoinSegments(string[] segments) =>
        segments.Length == 1 && segments[0].Length == 2 ? segments[0] + @"\" : string.Join('\\', segments);

    private static bool SegmentsEqual(ReadOnlySpan<string> left, ReadOnlySpan<string> right)
    {
        if (left.Length != right.Length) return false;
        for (int index = 0; index < left.Length; index++)
            if (!string.Equals(left[index], right[index], StringComparison.OrdinalIgnoreCase)) return false;
        return true;
    }

    /// <summary>
    /// Returns the UNC connection of a remote mapped drive letter, or null when the drive is not
    /// remote, not mapped, disconnected, or the lookup fails.
    /// </summary>
    internal static string? MappedDriveConnection(char drive)
    {
        if (!char.IsAsciiLetter(drive)) return null;
        string root = drive + @":\";
        if (NativeMethods.GetDriveTypeW(root) != NativeMethods.DriveRemote) return null;
        uint length = 1024;
        for (int attempt = 0; attempt < 2; attempt++)
        {
            var buffer = new char[length];
            int result = NativeMethods.WNetGetConnectionW(root[..2], buffer, ref length);
            if (result == NativeMethods.NoError)
            {
                int end = Array.IndexOf(buffer, '\0');
                return end <= 0 ? null : new string(buffer, 0, end);
            }
            if (result != NativeMethods.ErrorMoreData || length == 0 || length > 32768) return null;
        }
        return null;
    }

    /// <summary>
    /// A trusted boundary root whose pinned handle's final path has been verified. Local roots must
    /// resolve to themselves; a remote mapped-drive root may resolve only to its own drive connection.
    /// </summary>
    internal sealed class FinalPathRoot
    {
        private readonly string[] _expected;
        private readonly string[] _actual;

        private FinalPathRoot(string[] expected, string[] actual) => (_expected, _actual) = (expected, actual);

        internal static FinalPathRoot? Verify(string expectedRoot, string finalPath, Func<char, string?> mappedDriveConnection)
        {
            string? normalized = NormalizeFinalPath(finalPath);
            if (normalized is null ||
                !TrySplitAbsolute(Path.TrimEndingDirectorySeparator(expectedRoot), out string[]? expected) ||
                expected![0].Length != 2 ||
                !TrySplitAbsolute(normalized, out string[]? actual)) return null;

            if (actual![0].Length == 2) return SegmentsEqual(expected, actual) ? new(expected, actual) : null;

            string? connection;
            try { connection = mappedDriveConnection(expected[0][0]); }
            catch (Exception ex) when (ex is ExternalException or EntryPointNotFoundException or DllNotFoundException)
            {
                return null;
            }
            if (connection is null || !TrySplitAbsolute(connection, out string[]? mapped) || mapped![0].Length == 2)
                return null;
            return SegmentsEqual([.. mapped, .. expected[1..]], actual) ? new(expected, actual) : null;
        }

        /// <summary>Requires the final path to be the expected path's exact relative location under the verified root.</summary>
        internal bool Matches(string expectedPath, string finalPath)
        {
            string? normalized = NormalizeFinalPath(finalPath);
            if (normalized is null ||
                !TrySplitAbsolute(Path.TrimEndingDirectorySeparator(Path.GetFullPath(expectedPath)), out string[]? expected) ||
                !TrySplitAbsolute(normalized, out string[]? actual) ||
                expected!.Length < _expected.Length ||
                !SegmentsEqual(expected.AsSpan(0, _expected.Length), _expected)) return false;
            return SegmentsEqual([.. _actual, .. expected[_expected.Length..]], actual);
        }
    }

    private static bool PathExists(string path) => File.Exists(path) || Directory.Exists(path);

    private static class NativeMethods
    {
        internal const uint DriveRemote = 4;
        internal const int NoError = 0;
        internal const int ErrorMoreData = 234;
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

        [DllImport("kernel32.dll", CharSet = CharSet.Unicode)]
        internal static extern uint GetDriveTypeW(string rootPathName);

        [DllImport("mpr.dll", CharSet = CharSet.Unicode)]
        internal static extern int WNetGetConnectionW(string localName, [Out] char[] remoteName, ref uint length);
    }
}
