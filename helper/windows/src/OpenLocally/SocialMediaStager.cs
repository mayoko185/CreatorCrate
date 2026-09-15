using Microsoft.Win32.SafeHandles;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;

namespace OpenLocally;

public enum StagedMediaProvenance { ExternalSource, HelperOwned }

public sealed record StagedMedia(bool Success, string? ErrorCode, string? Path, StagedMediaProvenance? Provenance)
{
    public static StagedMedia Source(string path) => new(true, null, path, StagedMediaProvenance.ExternalSource);
    public static StagedMedia Owned(string path) => new(true, null, path, StagedMediaProvenance.HelperOwned);
    public static StagedMedia Fail(string code) => new(false, code, null, null);
}

internal sealed record OwnedMediaReadBoundary(
    string StagingRoot, string SessionDirectory, string MarkerPath, string Path);

/// <summary>Stages downloaded snapshot media under a marker-validated helper-owned directory.</summary>
public sealed class SocialMediaStager
{
    public const long MaxAssetBytes = 2L * 1024 * 1024 * 1024;
    public const long MaxAggregateBytes = 8L * 1024 * 1024 * 1024;
    internal const string MarkerName = ".creatorcrate-social-prep-owner";
    internal const string LastUseName = ".creatorcrate-social-prep-last-use";
    internal const string RecoveryStreamName = ":creatorcrate-social-prep-owner-recovery";
    internal static readonly TimeSpan CompletedRetention = TimeSpan.FromHours(24);
    internal static readonly TimeSpan FutureClockSkewTolerance = TimeSpan.FromMinutes(5);
    private readonly SocialCapabilityClient _capabilities;
    private readonly LocalMediaResolver _localResolver;
    private readonly string _tempRoot;
    private readonly Func<DateTimeOffset> _utcNow;
    private readonly Dictionary<SessionAssetKey, CachedStagedAsset> _stagedAssets = [];
    private readonly Dictionary<RestagingAssetKey, Task<StagedMedia>> _restagingAssets = [];
    private readonly object _stagedAssetsLock = new();
    private readonly Dictionary<string, FileStream> _sessionLeases = new(StringComparer.Ordinal);
    private readonly SocialMediaStagerTestHooks? _testHooks;
    private long _stagedBytes;

    public SocialMediaStager(SocialCapabilityClient capabilities, LocalMediaResolver localResolver, string? tempRoot = null, Func<DateTimeOffset>? utcNow = null)
        : this(capabilities, localResolver, tempRoot, utcNow, null)
    {
    }

    internal SocialMediaStager(
        SocialCapabilityClient capabilities, LocalMediaResolver localResolver, string? tempRoot,
        Func<DateTimeOffset>? utcNow, SocialMediaStagerTestHooks? testHooks)
    {
        _capabilities = capabilities ?? throw new ArgumentNullException(nameof(capabilities));
        _localResolver = localResolver ?? throw new ArgumentNullException(nameof(localResolver));
        _tempRoot = tempRoot ?? Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Temp", "CreatorCrate", "social-prep");
        _utcNow = utcNow ?? (() => DateTimeOffset.UtcNow);
        _testHooks = testHooks;
    }

    public async Task<StagedMedia> StageAsync(SocialOrigin origin, SocialCapability capability, SocialRedeemAsset asset, int ordinal, CancellationToken cancellationToken)
    {
        if (asset.AssetId <= 0 || asset.SizeBytes < 0 || asset.SizeBytes > MaxAssetBytes)
            return StagedMedia.Fail("media_file_limit_exceeded");

        var key = new SessionAssetKey(capability.SessionId, asset.AssetId);
        var metadata = StagedAssetMetadata.From(asset);
        Task<StagedMedia> stagedTask;
        lock (_stagedAssetsLock)
        {
            if (_stagedAssets.TryGetValue(key, out CachedStagedAsset? cached))
            {
                if (cached.Metadata != metadata) return StagedMedia.Fail("validation_failed");
                stagedTask = cached.Result;
            }
            else
            {
                stagedTask = StageUniqueAsync(origin, capability, asset, ordinal, cancellationToken);
                _stagedAssets.Add(key, new CachedStagedAsset(metadata, stagedTask));
            }
        }

        try
        {
            StagedMedia staged = await stagedTask.ConfigureAwait(false);
            if (!staged.Success) RemoveCachedAsset(key, stagedTask);
            return staged;
        }
        catch
        {
            RemoveCachedAsset(key, stagedTask);
            throw;
        }
    }

    private async Task<StagedMedia> StageUniqueAsync(
        SocialOrigin origin, SocialCapability capability, SocialRedeemAsset asset, int ordinal, CancellationToken cancellationToken,
        bool allowLocalSource = true, bool countTowardAggregate = true)
    {
        if (countTowardAggregate && _stagedBytes > MaxAggregateBytes - asset.SizeBytes) return StagedMedia.Fail("media_aggregate_limit_exceeded");

        if (allowLocalSource)
        {
            LocalMediaResolution local = _localResolver.Resolve(origin, asset);
            if (local.Resolved) return StagedMedia.Source(local.Path!);
        }

        string directory;
        try
        {
            directory = EnsureOwnedDirectory(capability.SessionId);
            EnsureSessionLease(capability.SessionId, directory);
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or ArgumentException or NotSupportedException) { return StagedMedia.Fail("media_temp_unavailable"); }

        string finalName = FinalName(asset, ordinal);
        string finalPath = Path.Combine(directory, finalName);
        string partialPath = Path.Combine(directory, $".{finalName}.{Guid.NewGuid():N}.partial");
        try
        {
            await using (var target = new FileStream(partialPath, FileMode.CreateNew, FileAccess.Write, FileShare.None, 81920, FileOptions.Asynchronous | FileOptions.SequentialScan))
            {
                long remaining = countTowardAggregate ? MaxAggregateBytes - _stagedBytes : MaxAssetBytes;
                SocialMediaDownloadResult downloaded = await _capabilities.DownloadAssetAsync(origin, capability, asset, target, Math.Min(MaxAssetBytes, remaining), cancellationToken).ConfigureAwait(false);
                if (!downloaded.Success) return StagedMedia.Fail(downloaded.ErrorCode!);
                await target.FlushAsync(cancellationToken).ConfigureAwait(false);
                if (countTowardAggregate) _stagedBytes += downloaded.BytesWritten;
            }
            _testHooks?.BeforeFinalMove?.Invoke(partialPath, finalPath);
            try
            {
                File.Move(partialPath, finalPath, overwrite: false);
            }
            catch (IOException)
            {
                return ReuseFinalizationWinner(finalPath, asset.SizeBytes, directory);
            }
            TouchLastUse(directory);
            return StagedMedia.Owned(finalPath);
        }
        catch (OperationCanceledException) { throw; }
        catch (IOException) { return StagedMedia.Fail("media_temp_unavailable"); }
        catch (UnauthorizedAccessException) { return StagedMedia.Fail("media_temp_unavailable"); }
        finally
        {
            try { if (File.Exists(partialPath)) File.Delete(partialPath); } catch (IOException) { } catch (UnauthorizedAccessException) { }
        }
    }

    /// <summary>Ends this process's active use without deleting retained completed media.</summary>
    public bool Cleanup(SocialCapability capability)
    {
        lock (_stagedAssetsLock)
        {
            if (!_sessionLeases.Remove(capability.SessionId, out FileStream? lease)) return true;
            lease.Dispose();
            return true;
        }
    }

    /// <summary>Transfers this process's active-use marker to a longer-lived local owner.</summary>
    public IDisposable DetachLease(SocialCapability capability)
    {
        lock (_stagedAssetsLock)
        {
            return _sessionLeases.Remove(capability.SessionId, out FileStream? lease)
                ? lease
                : EmptyMediaLease.Instance;
        }
    }

    /// <summary>Derives the exact helper-owned path boundary without touching retention or availability state.</summary>
    internal bool TryGetOwnedReadBoundary(
        string sessionId, SocialRedeemAsset asset, int ordinal, string expectedPath,
        out OwnedMediaReadBoundary? boundary)
    {
        boundary = null;
        if (!Guid.TryParse(sessionId, out _) || asset.AssetId <= 0 || asset.SizeBytes < 0 || ordinal < 0 ||
            string.IsNullOrWhiteSpace(expectedPath)) return false;
        try
        {
            if (!LocalMediaResolver.TryNormalizeAbsolute(
                    Path.TrimEndingDirectorySeparator(_tempRoot), out string? normalizedRoot) ||
                !LocalMediaResolver.TryNormalizeAbsolute(expectedPath, out string? normalizedExpected)) return false;
            string root = normalizedRoot!;
            string directory = Path.TrimEndingDirectorySeparator(Path.GetFullPath(SessionDirectory(sessionId)));
            string path = Path.GetFullPath(Path.Combine(directory, FinalName(asset, ordinal)));
            if (!string.Equals(Path.GetDirectoryName(directory), root, StringComparison.OrdinalIgnoreCase) ||
                !string.Equals(normalizedExpected, path, StringComparison.OrdinalIgnoreCase)) return false;
            boundary = new OwnedMediaReadBoundary(root, directory, Path.Combine(directory, MarkerName), path);
            return true;
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or ArgumentException or NotSupportedException)
        {
            return false;
        }
    }


    /// <summary>Checks the exact expected file immediately before use and extends completed retention on success.</summary>
    public StagedMedia Revalidate(SocialOrigin origin, SocialCapability capability, SocialRedeemAsset asset, int ordinal, StagedMedia media)
    {
        if (!media.Success || string.IsNullOrWhiteSpace(media.Path) || media.Provenance is null)
            return StagedMedia.Fail("validation_failed");

        if (media.Provenance == StagedMediaProvenance.ExternalSource)
        {
            LocalMediaAvailability availability = _localResolver.Revalidate(origin, asset, media.Path);
            return availability.Available ? media : StagedMedia.Fail(availability.ErrorCode!);
        }

        try
        {
            string directory = SessionDirectory(capability.SessionId);
            string expectedPath = Path.Combine(directory, FinalName(asset, ordinal));
            if (!string.Equals(Path.GetFullPath(media.Path), Path.GetFullPath(expectedPath), StringComparison.OrdinalIgnoreCase))
                return StagedMedia.Fail("validation_failed");
            if (InspectDirectoryChain(directory) != DirectoryPathState.Safe || !HasMarker(directory))
                return StagedMedia.Fail("media_file_unsafe");
            EnsureSessionLease(capability.SessionId, directory);
            OwnedFileState state = InspectOwnedFile(expectedPath, asset.SizeBytes);
            if (state != OwnedFileState.Ready) return StagedMedia.Fail(state switch
            {
                OwnedFileState.Missing => "media_file_missing",
                OwnedFileState.SizeMismatch => "media_size_mismatch",
                _ => "media_file_unsafe",
            });
            TouchLastUse(directory);
            return media;
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or ArgumentException or NotSupportedException)
        {
            return StagedMedia.Fail("media_file_unsafe");
        }
    }

    /// <summary>Coordinates validation and authenticated recovery for helper-owned staged media.</summary>
    public async Task<StagedMedia> EnsureAvailableAsync(
        SocialOrigin origin, SocialCapability capability, SocialRedeemAsset asset, int ordinal, StagedMedia media, CancellationToken cancellationToken)
    {
        if (media.Provenance != StagedMediaProvenance.HelperOwned)
            return Revalidate(origin, capability, asset, ordinal, media);

        var key = new SessionAssetKey(capability.SessionId, asset.AssetId);
        var restagingKey = new RestagingAssetKey(capability.SessionId, FinalName(asset, ordinal));
        Task<StagedMedia> restagingTask;
        lock (_stagedAssetsLock)
        {
            if (!_restagingAssets.TryGetValue(restagingKey, out restagingTask!))
            {
                restagingTask = EnsureOwnedAvailableAsync(origin, capability, asset, ordinal, media, cancellationToken);
                _restagingAssets.Add(restagingKey, restagingTask);
                _stagedAssets.Remove(key);
            }
        }

        try
        {
            StagedMedia restaged = await restagingTask.ConfigureAwait(false);
            if (restaged.Success)
            {
                lock (_stagedAssetsLock)
                    _stagedAssets[key] = new CachedStagedAsset(StagedAssetMetadata.From(asset), restagingTask);
            }
            return restaged;
        }
        finally
        {
            lock (_stagedAssetsLock)
                if (_restagingAssets.TryGetValue(restagingKey, out Task<StagedMedia>? current) && current == restagingTask)
                    _restagingAssets.Remove(restagingKey);
        }
    }

    private async Task<StagedMedia> EnsureOwnedAvailableAsync(
        SocialOrigin origin, SocialCapability capability, SocialRedeemAsset asset, int ordinal,
        StagedMedia media, CancellationToken cancellationToken)
    {
        StagedMedia checkedMedia = Revalidate(origin, capability, asset, ordinal, media);
        if (checkedMedia.Success) return checkedMedia;
        if (checkedMedia.ErrorCode is not ("media_file_missing" or "media_size_mismatch")) return checkedMedia;

        string directory = SessionDirectory(capability.SessionId);
        string expectedPath = Path.Combine(directory, FinalName(asset, ordinal));
        if (checkedMedia.ErrorCode == "media_size_mismatch")
        {
            OwnedFileState recovery = PrepareMismatchedFileForRestaging(expectedPath, asset.SizeBytes);
            if (recovery == OwnedFileState.Ready)
                return Revalidate(origin, capability, asset, ordinal, media);
            if (recovery != OwnedFileState.Missing)
                return StagedMedia.Fail(recovery == OwnedFileState.SizeMismatch ? "media_size_mismatch" : "media_file_unsafe");
        }

        StagedMedia restaged = await StageUniqueAsync(
            origin, capability, asset, ordinal, cancellationToken,
            allowLocalSource: false, countTowardAggregate: false).ConfigureAwait(false);
        return restaged.Success ? Revalidate(origin, capability, asset, ordinal, restaged) : restaged;
    }

    public int SweepAbandonedDirectories()
    {
        DirectoryPathState root = InspectDirectoryChain(_tempRoot);
        if (root != DirectoryPathState.Safe) return 0;
        int deleted = 0;
        DateTimeOffset now = _utcNow();
        DateTimeOffset cutoff = now.Subtract(CompletedRetention);
        foreach (string directory in Directory.EnumerateDirectories(_tempRoot))
        {
            try
            {
                using SessionDirectoryBoundary? boundary = TryOpenSessionDirectoryBoundary(_tempRoot, directory);
                if (boundary is null) continue;
                using SweepLease? sweepLease = TryAcquireSweepLease(directory);
                if (sweepLease is null) continue;
                if (!MarkerContentsValid(sweepLease.Stream)) continue;
                if (!TryInspectSessionContents(directory, out List<string>? files)) continue;
                if (!CleanPartialFiles(files)) continue;
                RetentionState retention = GetRetentionState(directory, now, cutoff);
                if (retention == RetentionState.Retain) continue;
                if (retention == RetentionState.Unsafe) continue;
                if (DeleteOwnedDirectory(directory, boundary, sweepLease)) deleted++;
            }
            catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or ArgumentException) { }
        }
        return deleted;
    }

    private string EnsureOwnedDirectory(string sessionId)
    {
        EnsureSafeDirectoryPath(_tempRoot);
        string directory = SessionDirectory(sessionId);
        switch (InspectDirectoryChain(directory))
        {
            case DirectoryPathState.Safe:
                if (!HasMarker(directory)) throw new IOException("The session staging directory is not helper-owned.");
                return directory;
            case DirectoryPathState.Unsafe:
                throw new IOException("The session staging directory is unsafe.");
            case DirectoryPathState.Missing:
                Directory.CreateDirectory(directory);
                if (InspectDirectoryChain(directory) != DirectoryPathState.Safe)
                    throw new IOException("The session staging directory is unsafe.");
                WriteMarker(directory);
                return directory;
            default:
                throw new InvalidOperationException("Unknown staging directory state.");
        }
    }

    private void EnsureSessionLease(string sessionId, string directory)
    {
        lock (_stagedAssetsLock)
        {
            if (_sessionLeases.ContainsKey(sessionId)) return;
            string marker = Path.Combine(directory, MarkerName);
            FileStream lease = new(marker, FileMode.Open, FileAccess.Read, FileShare.Read);
            if (!MarkerContentsValid(lease)) { lease.Dispose(); throw new IOException("The session staging marker is invalid."); }
            _sessionLeases.Add(sessionId, lease);
        }
    }

    private string SessionDirectory(string sessionId)
    {
        byte[] digest = SHA256.HashData(Encoding.UTF8.GetBytes(sessionId));
        return Path.Combine(_tempRoot, Convert.ToHexString(digest.AsSpan(0, 16)).ToLowerInvariant());
    }

    private static string SafeExtension(string extension)
    {
        if (string.IsNullOrWhiteSpace(extension)) return ".bin";
        string value = extension.Trim();
        return Regex.IsMatch(value, @"^\.[A-Za-z0-9]{1,16}$", RegexOptions.CultureInvariant) &&
            !IsReserved(Path.GetFileNameWithoutExtension("x" + value)) ? value.ToLowerInvariant() : ".bin";
    }

    private static string FinalName(SocialRedeemAsset asset, int ordinal) => $"{ordinal:D4}-{asset.AssetId}{SafeExtension(asset.Extension)}";

    private static bool IsReserved(string value)
    {
        string name = value.ToUpperInvariant();
        return name is "CON" or "PRN" or "AUX" or "NUL" ||
            (name.Length == 4 && (name.StartsWith("COM", StringComparison.Ordinal) || name.StartsWith("LPT", StringComparison.Ordinal)) && name[3] is >= '1' and <= '9');
    }

    private static bool HasMarker(string directory)
    {
        string marker = Path.Combine(directory, MarkerName);
        try
        {
            FileAttributes attributes = File.GetAttributes(marker);
            if ((attributes & (FileAttributes.ReparsePoint | FileAttributes.Directory)) != 0) return false;
            using var stream = new FileStream(marker, FileMode.Open, FileAccess.Read, FileShare.Read);
            return MarkerContentsValid(stream);
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or ArgumentException or NotSupportedException) { return false; }
    }

    private static void WriteMarker(string directory)
    {
        string marker = Path.Combine(directory, MarkerName);
        using var stream = new FileStream(marker, FileMode.CreateNew, FileAccess.Write, FileShare.None);
        byte[] contents = Encoding.ASCII.GetBytes("creatorcrate-social-prep-v1");
        stream.Write(contents, 0, contents.Length);
    }

    private bool DeleteOwnedDirectory(string directory, SessionDirectoryBoundary boundary, SweepLease markerLease)
    {
        try
        {
            if (!boundary.IsValid || !MarkerContentsValid(markerLease.Stream)) return false;
            if (!TryInspectSessionContents(directory, out List<string>? files)) return false;
            foreach (string file in files)
            {
                if (Path.GetFileName(file) == MarkerName) continue;
                _testHooks?.BeforeDeleteFile?.Invoke(file);
                File.Delete(file);
            }

            // An alternate stream does not make the directory non-empty, so it can
            // retain durable ownership while the ordinary marker is committed last.
            using RecoveryLease? recovery = TryCreateRecoveryLease(directory);
            if (recovery is null) return false;
            if (!markerLease.MarkDeletePending()) return false;
            markerLease.ReleaseMarker();
            _testHooks?.BeforeFinalDirectoryDisposition?.Invoke(directory);
            if (boundary.MarkDeletePending()) return true;

            RestoreMarkerFromRecovery(directory, recovery);
            return false;
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or ArgumentException or NotSupportedException)
        {
            if (!markerLease.IsActive)
            {
                using RecoveryLease? recovery = TryOpenRecoveryLease(directory);
                if (recovery is not null) RestoreMarkerFromRecovery(directory, recovery);
            }
            return false;
        }
    }

    private static SweepLease? TryAcquireSweepLease(string directory)
    {
        SweepLease? markerLease = TryOpenMarkerLease(directory);
        if (markerLease is not null)
        {
            if (MarkerContentsValid(markerLease.Stream)) return markerLease;
            using RecoveryLease? recovery = TryOpenRecoveryLease(directory);
            if (recovery is null || !markerLease.MarkDeletePending())
            {
                markerLease.Dispose();
                return null;
            }
            markerLease.ReleaseMarker();
            RestoreMarkerFromRecovery(directory, recovery);
            return TryOpenValidMarkerLease(directory);
        }

        if (File.Exists(Path.Combine(directory, MarkerName))) return null;
        using (RecoveryLease? recovery = TryOpenRecoveryLease(directory))
        {
            if (recovery is null) return null;
            RestoreMarkerFromRecovery(directory, recovery);
        }
        return TryOpenValidMarkerLease(directory);
    }

    private static SweepLease? TryOpenValidMarkerLease(string directory)
    {
        SweepLease? lease = TryOpenMarkerLease(directory);
        if (lease is null) return null;
        if (MarkerContentsValid(lease.Stream)) return lease;
        lease.Dispose();
        return null;
    }

    private static SweepLease? TryOpenMarkerLease(string directory)
    {
        try
        {
            string marker = Path.Combine(directory, MarkerName);
            SafeFileHandle handle = NativeMethods.CreateFileW(
                marker,
                NativeMethods.GenericRead | NativeMethods.Delete,
                FileShare.None,
                IntPtr.Zero,
                FileMode.Open,
                NativeMethods.FileFlagOpenReparsePoint,
                IntPtr.Zero);
            if (handle.IsInvalid) { handle.Dispose(); return null; }
            var stream = new FileStream(handle, FileAccess.Read);
            FileAttributes attributes = File.GetAttributes(marker);
            if ((attributes & (FileAttributes.Directory | FileAttributes.ReparsePoint)) != 0)
            {
                stream.Dispose();
                return null;
            }
            return new SweepLease(stream);
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or ArgumentException or NotSupportedException) { return null; }
    }

    private static RecoveryLease? TryCreateRecoveryLease(string directory)
    {
        try
        {
            var stream = new FileStream(directory + RecoveryStreamName, FileMode.OpenOrCreate, FileAccess.ReadWrite, FileShare.Delete);
            byte[] contents = Encoding.ASCII.GetBytes("creatorcrate-social-prep-v1");
            stream.Position = 0;
            stream.SetLength(0);
            stream.Write(contents, 0, contents.Length);
            stream.Flush(flushToDisk: true);
            stream.Position = 0;
            if (MarkerContentsValid(stream)) return new RecoveryLease(stream);
            stream.Dispose();
            return null;
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or ArgumentException or NotSupportedException) { return null; }
    }

    private static RecoveryLease? TryOpenRecoveryLease(string directory)
    {
        try
        {
            var stream = new FileStream(directory + RecoveryStreamName, FileMode.Open, FileAccess.ReadWrite, FileShare.Delete);
            if (MarkerContentsValid(stream)) return new RecoveryLease(stream);
            stream.Dispose();
            return null;
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or ArgumentException or NotSupportedException) { return null; }
    }

    private static void RestoreMarkerFromRecovery(string directory, RecoveryLease recovery)
    {
        if (!MarkerContentsValid(recovery.Stream) || HasMarker(directory)) return;
        try { WriteMarker(directory); }
        catch (IOException) { }
        catch (UnauthorizedAccessException) { }
        catch (ArgumentException) { }
        catch (NotSupportedException) { }
    }

    private static SessionDirectoryBoundary? TryOpenSessionDirectoryBoundary(string rootDirectory, string sessionDirectory)
    {
        string root = Path.TrimEndingDirectorySeparator(Path.GetFullPath(rootDirectory));
        string session = Path.TrimEndingDirectorySeparator(Path.GetFullPath(sessionDirectory));
        if (!string.Equals(Path.GetDirectoryName(session), root, StringComparison.OrdinalIgnoreCase)) return null;

        var handles = new List<SafeFileHandle>();
        bool completed = false;
        try
        {
            SafeFileHandle rootHandle = OpenPinnedDirectory(root, isSession: false);
            if (rootHandle.IsInvalid || !IsSafeDirectoryHandle(rootHandle))
            {
                rootHandle.Dispose();
                return null;
            }
            handles.Add(rootHandle);

            SafeFileHandle sessionHandle = OpenPinnedDirectory(session, isSession: true);
            if (sessionHandle.IsInvalid || !IsSafeDirectoryHandle(sessionHandle))
            {
                sessionHandle.Dispose();
                return null;
            }
            handles.Add(sessionHandle);
            completed = true;
            return new SessionDirectoryBoundary(handles);
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or ArgumentException or NotSupportedException)
        {
            return null;
        }
        finally
        {
            if (!completed)
                for (int index = handles.Count - 1; index >= 0; index--) handles[index].Dispose();
        }
    }

    private static SafeFileHandle OpenPinnedDirectory(string directory, bool isSession) => NativeMethods.CreateFileW(
        directory,
        NativeMethods.FileReadAttributes | (isSession ? NativeMethods.Delete : 0),
        FileShare.Read | FileShare.Write,
        IntPtr.Zero,
        FileMode.Open,
        NativeMethods.FileFlagBackupSemantics | NativeMethods.FileFlagOpenReparsePoint,
        IntPtr.Zero);

    private static bool IsSafeDirectoryHandle(SafeFileHandle handle)
    {
        if (!NativeMethods.GetFileInformationByHandleEx(
            handle,
            NativeMethods.FileInfoByHandleClass.FileAttributeTagInfo,
            out NativeMethods.FileAttributeTagInfo information,
            (uint)Marshal.SizeOf<NativeMethods.FileAttributeTagInfo>())) return false;
        const uint directory = (uint)FileAttributes.Directory;
        const uint reparse = (uint)FileAttributes.ReparsePoint;
        return (information.FileAttributes & (directory | reparse)) == directory;
    }

    private static bool MarkerContentsValid(FileStream stream)
    {
        try
        {
            stream.Position = 0;
            if (stream.Length > 64) return false;
            using var reader = new StreamReader(stream, Encoding.ASCII, detectEncodingFromByteOrderMarks: false, bufferSize: 64, leaveOpen: true);
            string contents = reader.ReadToEnd();
            stream.Position = 0;
            return contents == "creatorcrate-social-prep-v1";
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or NotSupportedException) { return false; }
    }

    private void TouchLastUse(string directory)
    {
        string path = Path.Combine(directory, LastUseName);
        if (Directory.Exists(path)) throw new IOException("The staging retention metadata is unsafe.");
        if (File.Exists(path))
        {
            if ((File.GetAttributes(path) & (FileAttributes.Directory | FileAttributes.ReparsePoint)) != 0 ||
                !MetadataContentsValid(path, "creatorcrate-social-prep-last-use-v1"))
                throw new IOException("The staging retention metadata is unsafe.");
        }
        else File.WriteAllText(path, "creatorcrate-social-prep-last-use-v1", Encoding.ASCII);
        File.SetLastWriteTimeUtc(path, _utcNow().UtcDateTime);
    }

    private static bool TryInspectSessionContents(string directory, out List<string> files)
    {
        files = [];
        try
        {
            foreach (string entry in Directory.EnumerateFileSystemEntries(directory, "*", SearchOption.TopDirectoryOnly))
            {
                FileAttributes attributes = File.GetAttributes(entry);
                if ((attributes & (FileAttributes.Directory | FileAttributes.ReparsePoint)) != 0) return false;
                string name = Path.GetFileName(entry);
                if (!IsExpectedStagingEntry(name)) return false;
                files.Add(entry);
            }
            return files.Any(file => Path.GetFileName(file) == MarkerName);
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or ArgumentException or NotSupportedException)
        {
            files = [];
            return false;
        }
    }

    private static bool IsExpectedStagingEntry(string name) =>
        name == MarkerName || name == LastUseName || name.EndsWith(".partial", StringComparison.OrdinalIgnoreCase) ||
        Regex.IsMatch(name, @"^\d{4}-\d+\.[A-Za-z0-9]{1,16}$", RegexOptions.CultureInvariant);

    private static bool CleanPartialFiles(IEnumerable<string> files)
    {
        try
        {
            foreach (string file in files.Where(file => file.EndsWith(".partial", StringComparison.OrdinalIgnoreCase)))
            {
                if ((File.GetAttributes(file) & (FileAttributes.Directory | FileAttributes.ReparsePoint)) != 0) return false;
                File.Delete(file);
            }
            return true;
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or ArgumentException or NotSupportedException) { return false; }
    }

    private static RetentionState GetRetentionState(string directory, DateTimeOffset now, DateTimeOffset cutoff)
    {
        try
        {
            string lastUse = Path.Combine(directory, LastUseName);
            if (Directory.Exists(lastUse)) return RetentionState.Unsafe;
            if (File.Exists(lastUse))
            {
                if ((File.GetAttributes(lastUse) & (FileAttributes.Directory | FileAttributes.ReparsePoint)) != 0) return RetentionState.Unsafe;
                // Contents are validated with a fixed 64-byte cap. If corrupted, the
                // safe file timestamp remains a bounded compatibility fallback.
                _ = MetadataContentsValid(lastUse, "creatorcrate-social-prep-last-use-v1");
                DateTime modified = File.GetLastWriteTimeUtc(lastUse);
                if (ExceedsFutureClockSkew(modified, now.UtcDateTime))
                {
                    File.SetLastWriteTimeUtc(lastUse, now.UtcDateTime);
                    modified = now.UtcDateTime;
                }
                return modified < cutoff.UtcDateTime ? RetentionState.Expired : RetentionState.Retain;
            }

            // Legacy v1 directories have no last-use file. Preserve completed files by
            // their newest filesystem timestamp; failed/partial-only directories expire now.
            DateTime newest = DateTime.MinValue;
            bool completed = false;
            foreach (string file in Directory.EnumerateFiles(directory, "*", SearchOption.TopDirectoryOnly))
            {
                string name = Path.GetFileName(file);
                if (name == MarkerName || name.EndsWith(".partial", StringComparison.OrdinalIgnoreCase)) continue;
                if ((File.GetAttributes(file) & (FileAttributes.Directory | FileAttributes.ReparsePoint)) != 0) return RetentionState.Unsafe;
                completed = true;
                DateTime modified = File.GetLastWriteTimeUtc(file);
                if (modified > newest) newest = modified;
            }
            if (!completed) return RetentionState.Expired;
            DateTime legacyUse = newest > Directory.GetLastWriteTimeUtc(directory) ? newest : Directory.GetLastWriteTimeUtc(directory);
            if (ExceedsFutureClockSkew(legacyUse, now.UtcDateTime))
            {
                WriteNormalizedLastUse(directory, now.UtcDateTime);
                legacyUse = now.UtcDateTime;
            }
            return legacyUse < cutoff.UtcDateTime ? RetentionState.Expired : RetentionState.Retain;
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or ArgumentException or NotSupportedException) { return RetentionState.Unsafe; }
    }

    private static OwnedFileState InspectOwnedFile(string path, long expectedSize)
    {
        try
        {
            var info = new FileInfo(path);
            if (!info.Exists) return OwnedFileState.Missing;
            if ((info.Attributes & (FileAttributes.Directory | FileAttributes.ReparsePoint)) != 0) return OwnedFileState.Unsafe;
            return info.Length == expectedSize ? OwnedFileState.Ready : OwnedFileState.SizeMismatch;
        }
        catch (Exception ex) when (ex is DirectoryNotFoundException or FileNotFoundException) { return OwnedFileState.Missing; }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or ArgumentException or NotSupportedException) { return OwnedFileState.Unsafe; }
    }

    private OwnedFileState PrepareMismatchedFileForRestaging(string path, long expectedSize)
    {
        using SafeFileHandle handle = NativeMethods.CreateFileW(
            path,
            NativeMethods.GenericRead | NativeMethods.FileReadAttributes | NativeMethods.Delete,
            FileShare.Read | FileShare.Write | FileShare.Delete,
            IntPtr.Zero,
            FileMode.Open,
            NativeMethods.FileFlagOpenReparsePoint,
            IntPtr.Zero);
        if (handle.IsInvalid)
        {
            OwnedFileState current = InspectOwnedFile(path, expectedSize);
            return current is OwnedFileState.Ready or OwnedFileState.Missing ? current : OwnedFileState.Unsafe;
        }

        if (!NativeMethods.GetFileInformationByHandleEx(
            handle,
            NativeMethods.FileInfoByHandleClass.FileAttributeTagInfo,
            out NativeMethods.FileAttributeTagInfo information,
            (uint)Marshal.SizeOf<NativeMethods.FileAttributeTagInfo>())) return OwnedFileState.Unsafe;
        if ((information.FileAttributes & ((uint)FileAttributes.Directory | (uint)FileAttributes.ReparsePoint)) != 0)
            return OwnedFileState.Unsafe;
        if (!NativeMethods.GetFileSizeEx(handle, out long length)) return OwnedFileState.Unsafe;
        if (length == expectedSize) return OwnedFileState.Ready;

        _testHooks?.BeforeMismatchDisposition?.Invoke(path);
        var disposition = new NativeMethods.FileDispositionInfo { DeleteFile = true };
        if (!NativeMethods.SetFileInformationByHandle(
            handle,
            NativeMethods.FileInfoByHandleClass.FileDispositionInfo,
            ref disposition,
            (uint)Marshal.SizeOf<NativeMethods.FileDispositionInfo>()))
        {
            OwnedFileState current = InspectOwnedFile(path, expectedSize);
            return current is OwnedFileState.Ready or OwnedFileState.Missing ? current : OwnedFileState.Unsafe;
        }

        handle.Dispose();
        return InspectOwnedFile(path, expectedSize);
    }

    private StagedMedia ReuseFinalizationWinner(string finalPath, long expectedSize, string directory)
    {
        if (InspectDirectoryChain(directory) != DirectoryPathState.Safe || !HasMarker(directory))
            return StagedMedia.Fail("media_file_unsafe");

        OwnedFileState winner = InspectOwnedFile(finalPath, expectedSize);
        if (winner != OwnedFileState.Ready)
        {
            return StagedMedia.Fail(winner switch
            {
                OwnedFileState.SizeMismatch => "media_size_mismatch",
                OwnedFileState.Unsafe => "media_file_unsafe",
                _ => "media_temp_unavailable",
            });
        }

        try
        {
            TouchLastUse(directory);
            return StagedMedia.Owned(finalPath);
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or ArgumentException or NotSupportedException)
        {
            return StagedMedia.Fail("media_file_unsafe");
        }
    }

    private static bool ExceedsFutureClockSkew(DateTime timestamp, DateTime now) =>
        timestamp > now && timestamp - now > FutureClockSkewTolerance;

    private static void WriteNormalizedLastUse(string directory, DateTime normalized)
    {
        string path = Path.Combine(directory, LastUseName);
        using (var stream = new FileStream(path, FileMode.CreateNew, FileAccess.Write, FileShare.None))
        {
            byte[] contents = Encoding.ASCII.GetBytes("creatorcrate-social-prep-last-use-v1");
            stream.Write(contents, 0, contents.Length);
        }
        File.SetLastWriteTimeUtc(path, normalized);
    }

    private static bool MetadataContentsValid(string path, string expected)
    {
        try
        {
            using var stream = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.Read | FileShare.Delete);
            if (stream.Length > 64) return false;
            Span<byte> bytes = stackalloc byte[(int)stream.Length];
            stream.ReadExactly(bytes);
            return bytes.SequenceEqual(Encoding.ASCII.GetBytes(expected));
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or ArgumentException or NotSupportedException) { return false; }
    }

    private static void EnsureSafeDirectoryPath(string directory)
    {
        string fullPath = Path.GetFullPath(directory);
        string root = Path.GetPathRoot(fullPath) ?? throw new ArgumentException("A staging directory must be rooted.", nameof(directory));
        if (InspectDirectory(root) != DirectoryPathState.Safe) throw new IOException("The staging root is unsafe.");

        string current = root;
        foreach (string segment in PathSegments(fullPath, root))
        {
            current = Path.Combine(current, segment);
            switch (InspectDirectory(current))
            {
                case DirectoryPathState.Safe:
                    break;
                case DirectoryPathState.Unsafe:
                    throw new IOException("The staging root is unsafe.");
                case DirectoryPathState.Missing:
                    Directory.CreateDirectory(current);
                    if (InspectDirectory(current) != DirectoryPathState.Safe)
                        throw new IOException("The staging root is unsafe.");
                    break;
            }
        }
    }

    private static DirectoryPathState InspectDirectoryChain(string directory)
    {
        try
        {
            string fullPath = Path.GetFullPath(directory);
            string root = Path.GetPathRoot(fullPath) ?? throw new ArgumentException("A staging directory must be rooted.", nameof(directory));
            if (InspectDirectory(root) is not DirectoryPathState.Safe) return InspectDirectory(root);

            string current = root;
            foreach (string segment in PathSegments(fullPath, root))
            {
                current = Path.Combine(current, segment);
                DirectoryPathState state = InspectDirectory(current);
                if (state != DirectoryPathState.Safe) return state;
            }
            return DirectoryPathState.Safe;
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or ArgumentException or NotSupportedException)
        {
            return DirectoryPathState.Unsafe;
        }
    }

    private static DirectoryPathState InspectDirectory(string directory)
    {
        try
        {
            FileAttributes attributes = File.GetAttributes(directory);
            return (attributes & (FileAttributes.ReparsePoint | FileAttributes.Directory)) == FileAttributes.Directory
                ? DirectoryPathState.Safe : DirectoryPathState.Unsafe;
        }
        catch (Exception ex) when (ex is DirectoryNotFoundException or FileNotFoundException) { return DirectoryPathState.Missing; }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or ArgumentException or NotSupportedException) { return DirectoryPathState.Unsafe; }
    }

    private static IEnumerable<string> PathSegments(string fullPath, string root) =>
        fullPath[root.Length..].Split([Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar], StringSplitOptions.RemoveEmptyEntries);

    private void RemoveCachedAsset(SessionAssetKey key, Task<StagedMedia> result)
    {
        lock (_stagedAssetsLock)
            if (_stagedAssets.TryGetValue(key, out CachedStagedAsset? cached) && cached.Result == result)
                _stagedAssets.Remove(key);
    }

    internal sealed class SocialMediaStagerTestHooks
    {
        public Action<string, string>? BeforeFinalMove { get; init; }
        public Action<string>? BeforeMismatchDisposition { get; init; }
        public Action<string>? BeforeDeleteFile { get; init; }
        public Action<string>? BeforeFinalDirectoryDisposition { get; init; }
    }

    private sealed class SweepLease(FileStream stream) : IDisposable
    {
        private FileStream? _stream = stream;
        public FileStream Stream => _stream ?? throw new ObjectDisposedException(nameof(SweepLease));
        public bool IsActive => _stream is not null;

        public bool MarkDeletePending()
        {
            var disposition = new NativeMethods.FileDispositionInfo { DeleteFile = true };
            return NativeMethods.SetFileInformationByHandle(
                Stream.SafeFileHandle,
                NativeMethods.FileInfoByHandleClass.FileDispositionInfo,
                ref disposition,
                (uint)Marshal.SizeOf<NativeMethods.FileDispositionInfo>());
        }

        public void ReleaseMarker()
        {
            _stream?.Dispose();
            _stream = null;
        }

        public void Dispose() => ReleaseMarker();
    }

    private sealed class EmptyMediaLease : IDisposable
    {
        public static EmptyMediaLease Instance { get; } = new();
        public void Dispose() { }
    }

    private sealed class RecoveryLease(FileStream stream) : IDisposable
    {
        public FileStream Stream { get; } = stream;
        public void Dispose() => Stream.Dispose();
    }

    private sealed class SessionDirectoryBoundary(List<SafeFileHandle> handles) : IDisposable
    {
        private readonly List<SafeFileHandle> _handles = handles;
        public bool IsValid => _handles.Count > 0 && !_handles[^1].IsInvalid && !_handles[^1].IsClosed;

        public bool MarkDeletePending()
        {
            var disposition = new NativeMethods.FileDispositionInfo { DeleteFile = true };
            return NativeMethods.SetFileInformationByHandle(
                _handles[^1],
                NativeMethods.FileInfoByHandleClass.FileDispositionInfo,
                ref disposition,
                (uint)Marshal.SizeOf<NativeMethods.FileDispositionInfo>());
        }

        public void Dispose()
        {
            for (int index = _handles.Count - 1; index >= 0; index--) _handles[index].Dispose();
        }
    }

    private static class NativeMethods
    {
        internal const uint Delete = 0x00010000;
        internal const uint GenericRead = 0x80000000;
        internal const uint FileReadAttributes = 0x00000080;
        internal const uint FileFlagBackupSemantics = 0x02000000;
        internal const uint FileFlagOpenReparsePoint = 0x00200000;

        internal enum FileInfoByHandleClass { FileDispositionInfo = 4, FileAttributeTagInfo = 9 }

        [StructLayout(LayoutKind.Sequential)]
        internal struct FileDispositionInfo
        {
            [MarshalAs(UnmanagedType.Bool)]
            internal bool DeleteFile;
        }

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
        internal static extern bool SetFileInformationByHandle(
            SafeFileHandle file, FileInfoByHandleClass fileInformationClass,
            ref FileDispositionInfo fileInformation, uint bufferSize);

        [DllImport("kernel32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        internal static extern bool GetFileInformationByHandleEx(
            SafeFileHandle file, FileInfoByHandleClass fileInformationClass,
            out FileAttributeTagInfo fileInformation, uint bufferSize);

        [DllImport("kernel32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        internal static extern bool GetFileSizeEx(SafeFileHandle file, out long fileSize);
    }

    private enum DirectoryPathState { Missing, Safe, Unsafe }
    private enum OwnedFileState { Ready, Missing, SizeMismatch, Unsafe }
    private enum RetentionState { Retain, Expired, Unsafe }

    private sealed record StagedAssetMetadata(
        string Role, long SortOrder, string Filename, string Extension, string MimeType, long SizeBytes, string RelativePath, bool IsPresent, string? WindowsPath)
    {
        public static StagedAssetMetadata From(SocialRedeemAsset asset) =>
            new(asset.Role, asset.SortOrder, asset.Filename, asset.Extension, asset.MimeType, asset.SizeBytes, asset.RelativePath, asset.IsPresent, asset.WindowsPath);
    }

    private sealed record CachedStagedAsset(StagedAssetMetadata Metadata, Task<StagedMedia> Result);
    private sealed record SessionAssetKey(string SessionId, long AssetId);
    private sealed record RestagingAssetKey(string SessionId, string FinalName);
}
