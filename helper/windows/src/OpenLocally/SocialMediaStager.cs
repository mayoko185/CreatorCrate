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

/// <summary>Stages downloaded snapshot media under a marker-validated helper-owned directory.</summary>
public sealed class SocialMediaStager
{
    public const long MaxAssetBytes = 2L * 1024 * 1024 * 1024;
    public const long MaxAggregateBytes = 8L * 1024 * 1024 * 1024;
    internal const string MarkerName = ".creatorcrate-social-prep-owner";
    private readonly SocialCapabilityClient _capabilities;
    private readonly LocalMediaResolver _localResolver;
    private readonly string _tempRoot;
    private readonly Func<DateTimeOffset> _utcNow;
    private readonly Dictionary<SessionAssetKey, CachedStagedAsset> _stagedAssets = [];
    private readonly object _stagedAssetsLock = new();
    private long _stagedBytes;

    public SocialMediaStager(SocialCapabilityClient capabilities, LocalMediaResolver localResolver, string? tempRoot = null, Func<DateTimeOffset>? utcNow = null)
    {
        _capabilities = capabilities ?? throw new ArgumentNullException(nameof(capabilities));
        _localResolver = localResolver ?? throw new ArgumentNullException(nameof(localResolver));
        _tempRoot = tempRoot ?? Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Temp", "CreatorCrate", "social-prep");
        _utcNow = utcNow ?? (() => DateTimeOffset.UtcNow);
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

    private async Task<StagedMedia> StageUniqueAsync(SocialOrigin origin, SocialCapability capability, SocialRedeemAsset asset, int ordinal, CancellationToken cancellationToken)
    {
        if (_stagedBytes > MaxAggregateBytes - asset.SizeBytes) return StagedMedia.Fail("media_aggregate_limit_exceeded");

        LocalMediaResolution local = _localResolver.Resolve(origin, asset);
        if (local.Resolved) return StagedMedia.Source(local.Path!);

        string directory;
        try { directory = EnsureOwnedDirectory(capability.SessionId); }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or ArgumentException or NotSupportedException) { return StagedMedia.Fail("media_temp_unavailable"); }

        string finalName = $"{ordinal:D4}-{asset.AssetId}{SafeExtension(asset.Extension)}";
        string finalPath = Path.Combine(directory, finalName);
        string partialPath = Path.Combine(directory, $".{finalName}.{Guid.NewGuid():N}.partial");
        try
        {
            await using (var target = new FileStream(partialPath, FileMode.CreateNew, FileAccess.Write, FileShare.None, 81920, FileOptions.Asynchronous | FileOptions.SequentialScan))
            {
                long remaining = MaxAggregateBytes - _stagedBytes;
                SocialMediaDownloadResult downloaded = await _capabilities.DownloadAssetAsync(origin, capability, asset, target, Math.Min(MaxAssetBytes, remaining), cancellationToken).ConfigureAwait(false);
                if (!downloaded.Success) return StagedMedia.Fail(downloaded.ErrorCode!);
                await target.FlushAsync(cancellationToken).ConfigureAwait(false);
                _stagedBytes += downloaded.BytesWritten;
            }
            File.Move(partialPath, finalPath, overwrite: false);
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

    public bool Cleanup(SocialCapability capability)
    {
        try { return DeleteOwnedDirectory(SessionDirectory(capability.SessionId)); }
        finally { RemoveCachedSession(capability.SessionId); }
    }

    public int SweepAbandonedDirectories()
    {
        DirectoryPathState root = InspectDirectoryChain(_tempRoot);
        if (root != DirectoryPathState.Safe) return 0;
        int deleted = 0;
        DateTimeOffset cutoff = _utcNow().AddHours(-24);
        foreach (string directory in Directory.EnumerateDirectories(_tempRoot))
        {
            try
            {
                if (InspectDirectoryChain(directory) != DirectoryPathState.Safe || !HasMarker(directory)) continue;
                if (Directory.GetLastWriteTimeUtc(directory) >= cutoff.UtcDateTime) continue;
                if (DeleteOwnedDirectory(directory)) deleted++;
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
            return (attributes & (FileAttributes.ReparsePoint | FileAttributes.Directory)) == 0 &&
                File.ReadAllText(marker, Encoding.ASCII) == "creatorcrate-social-prep-v1";
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

    private static bool DeleteOwnedDirectory(string directory)
    {
        try
        {
            DirectoryPathState state = InspectDirectoryChain(directory);
            if (state == DirectoryPathState.Missing) return true;
            if (state != DirectoryPathState.Safe || !HasMarker(directory)) return false;
            DeleteTree(directory);
            return InspectDirectoryChain(directory) == DirectoryPathState.Missing;
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or ArgumentException) { return false; }
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

    private void RemoveCachedSession(string sessionId)
    {
        lock (_stagedAssetsLock)
            foreach (SessionAssetKey key in _stagedAssets.Keys.Where(key => key.SessionId == sessionId).ToArray())
                _stagedAssets.Remove(key);
    }

    private static void DeleteTree(string directory)
    {
        foreach (string file in Directory.EnumerateFiles(directory))
        {
            if ((File.GetAttributes(file) & FileAttributes.ReparsePoint) != 0) throw new IOException("reparse point");
            File.Delete(file);
        }
        foreach (string child in Directory.EnumerateDirectories(directory))
        {
            if ((File.GetAttributes(child) & FileAttributes.ReparsePoint) != 0) throw new IOException("reparse point");
            DeleteTree(child);
        }
        Directory.Delete(directory, recursive: false);
    }

    private enum DirectoryPathState { Missing, Safe, Unsafe }

    private sealed record StagedAssetMetadata(
        string Role, long SortOrder, string Filename, string Extension, string MimeType, long SizeBytes, string RelativePath, bool IsPresent, string? WindowsPath)
    {
        public static StagedAssetMetadata From(SocialRedeemAsset asset) =>
            new(asset.Role, asset.SortOrder, asset.Filename, asset.Extension, asset.MimeType, asset.SizeBytes, asset.RelativePath, asset.IsPresent, asset.WindowsPath);
    }

    private sealed record CachedStagedAsset(StagedAssetMetadata Metadata, Task<StagedMedia> Result);
    private sealed record SessionAssetKey(string SessionId, long AssetId);
}
