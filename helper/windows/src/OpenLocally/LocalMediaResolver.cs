using System.Text.RegularExpressions;

namespace OpenLocally;

public sealed record LocalMediaResolution(bool Resolved, string? Path, string? Root)
{
    public static LocalMediaResolution Fallback() => new(false, null, null);
    public static LocalMediaResolution Source(string path, string root) => new(true, path, root);
}

public sealed record LocalMediaAvailability(bool Available, string? ErrorCode)
{
    public static LocalMediaAvailability Ready() => new(true, null);
    public static LocalMediaAvailability Fail(string code) => new(false, code);
}

internal sealed record LocalMediaReadBoundary(string Path, string Root);

/// <summary>Validates a server hint as a Windows source file only after exact origin/root approval.</summary>
public sealed class LocalMediaResolver
{
    private static readonly Regex DrivePath = new(@"^[A-Za-z]:\\", RegexOptions.CultureInvariant);
    private readonly ITrustedMediaRootStore _store;
    private readonly ITrustedMediaRootPrompt _prompt;

    public LocalMediaResolver(ITrustedMediaRootStore store, ITrustedMediaRootPrompt prompt) =>
        (_store, _prompt) = (store ?? throw new ArgumentNullException(nameof(store)), prompt ?? throw new ArgumentNullException(nameof(prompt)));

    public LocalMediaResolution Resolve(SocialOrigin origin, SocialRedeemAsset asset)
    {
        if (string.IsNullOrWhiteSpace(asset.WindowsPath) || asset.SizeBytes < 0 ||
            !TryDeriveRoot(asset.WindowsPath, asset.RelativePath, out string? candidate, out string? root)) return LocalMediaResolution.Fallback();

        if (!IsSafeExistingFile(candidate!, root!, asset.SizeBytes)) return LocalMediaResolution.Fallback();
        if (!_store.IsTrusted(origin, root!) && !_prompt.ConfirmTrust(origin, root!)) return LocalMediaResolution.Fallback();

        if (!_store.IsTrusted(origin, root!)) _store.Trust(origin, root!);
        return LocalMediaResolution.Source(candidate!, root!);
    }

    /// <summary>Revalidates an already-approved external source without prompting or mutating it.</summary>
    public LocalMediaAvailability Revalidate(SocialOrigin origin, SocialRedeemAsset asset, string expectedPath)
    {
        if (!TryGetTrustedReadBoundary(origin, asset, expectedPath, out LocalMediaReadBoundary? boundary, out string? errorCode))
            return LocalMediaAvailability.Fail(errorCode!);
        return InspectExistingFile(boundary!.Path, boundary.Root, asset.SizeBytes) switch
        {
            ExistingFileState.Ready => LocalMediaAvailability.Ready(),
            ExistingFileState.Missing => LocalMediaAvailability.Fail("media_file_missing"),
            ExistingFileState.SizeMismatch => LocalMediaAvailability.Fail("media_size_mismatch"),
            _ => LocalMediaAvailability.Fail("media_file_unsafe"),
        };
    }

    /// <summary>Resolves an already-approved path/root pair without inspecting or mutating the filesystem.</summary>
    internal bool TryGetTrustedReadBoundary(
        SocialOrigin origin, SocialRedeemAsset asset, string expectedPath,
        out LocalMediaReadBoundary? boundary, out string? errorCode)
    {
        boundary = null;
        errorCode = null;
        if (!TryDeriveRoot(asset.WindowsPath ?? string.Empty, asset.RelativePath, out string? candidate, out string? root) ||
            !string.Equals(candidate, expectedPath, StringComparison.OrdinalIgnoreCase))
        {
            errorCode = "validation_failed";
            return false;
        }
        if (!_store.IsTrusted(origin, root!))
        {
            errorCode = "media_source_untrusted";
            return false;
        }
        boundary = new LocalMediaReadBoundary(candidate!, root!);
        return true;
    }

    internal static bool TryDeriveRoot(string candidate, string relativePath, out string? normalizedCandidate, out string? normalizedRoot)
    {
        normalizedCandidate = normalizedRoot = null;
        if (!TryNormalizeAbsolute(candidate, out string? path) || !TryRelativeSegments(relativePath, out string[]? relative)) return false;
        string[] parts = path!.Split('\\', StringSplitOptions.None);
        if (parts.Length <= relative!.Length || !parts[^relative.Length..].SequenceEqual(relative, StringComparer.OrdinalIgnoreCase)) return false;
        string root = string.Join('\\', parts[..^relative.Length]);
        if (!TryNormalizeAbsolute(root, out string? canonicalRoot)) return false;
        normalizedCandidate = path;
        normalizedRoot = canonicalRoot;
        return true;
    }

    internal static bool TryNormalizeAbsolute(string value, out string? path)
    {
        path = null;
        if (string.IsNullOrWhiteSpace(value)) return false;
        string candidate = value.Replace('/', '\\');
        if (!DrivePath.IsMatch(candidate) || candidate.StartsWith(@"\\?\", StringComparison.Ordinal) ||
            candidate.StartsWith(@"\\.\", StringComparison.Ordinal) || candidate.StartsWith(@"\\", StringComparison.Ordinal)) return false;
        string[] segments = candidate.Split('\\', StringSplitOptions.None);
        if (segments.Length < 2 || segments.Skip(1).Any(x => x.Length == 0 || x is "." or ".." || x.IndexOfAny(Path.GetInvalidPathChars()) >= 0 || x.Contains(':'))) return false;
        try
        {
            string full = Path.GetFullPath(candidate);
            if (!DrivePath.IsMatch(full)) return false;
            path = full.TrimEnd('\\');
            return path.Length > 3 && !HasReservedSegment(path);
        }
        catch (Exception ex) when (ex is ArgumentException or NotSupportedException or PathTooLongException) { return false; }
    }

    private static bool TryRelativeSegments(string value, out string[]? segments)
    {
        segments = null;
        if (string.IsNullOrWhiteSpace(value) || Path.IsPathRooted(value)) return false;
        string[] result = value.Replace('/', '\\').Split('\\', StringSplitOptions.None);
        if (result.Length == 0 || result.Any(x => x.Length == 0 || x is "." or ".." || x.IndexOfAny(Path.GetInvalidPathChars()) >= 0 || x.Contains(':'))) return false;
        segments = result;
        return true;
    }

    private static bool IsSafeExistingFile(string path, string root, long expectedSize)
        => InspectExistingFile(path, root, expectedSize) == ExistingFileState.Ready;

    private static ExistingFileState InspectExistingFile(string path, string root, long expectedSize)
    {
        try
        {
            if (!path.StartsWith(root + "\\", StringComparison.OrdinalIgnoreCase) || HasReparsePointInChain(root, path)) return ExistingFileState.Unsafe;
            var info = new FileInfo(path);
            if (!info.Exists) return ExistingFileState.Missing;
            if ((info.Attributes & (FileAttributes.Directory | FileAttributes.ReparsePoint)) != 0) return ExistingFileState.Unsafe;
            return info.Length == expectedSize ? ExistingFileState.Ready : ExistingFileState.SizeMismatch;
        }
        catch (Exception ex) when (ex is DirectoryNotFoundException or FileNotFoundException) { return ExistingFileState.Missing; }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or ArgumentException or NotSupportedException) { return ExistingFileState.Unsafe; }
    }

    private static bool HasReparsePointInChain(string root, string file)
    {
        string current = root;
        if ((File.GetAttributes(current) & FileAttributes.ReparsePoint) != 0) return true;
        string suffix = file[(root.Length + 1)..];
        foreach (string part in suffix.Split('\\'))
        {
            current = Path.Combine(current, part);
            if ((File.GetAttributes(current) & FileAttributes.ReparsePoint) != 0) return true;
        }
        return false;
    }

    private static bool HasReservedSegment(string path) => path.Split('\\').Skip(1).Any(segment =>
    {
        string name = Path.GetFileNameWithoutExtension(segment).ToUpperInvariant();
        return name is "CON" or "PRN" or "AUX" or "NUL" or "CLOCK$" ||
            (name.Length == 4 && (name.StartsWith("COM", StringComparison.Ordinal) || name.StartsWith("LPT", StringComparison.Ordinal)) && name[3] is >= '1' and <= '9');
    });

    private enum ExistingFileState { Ready, Missing, SizeMismatch, Unsafe }
}
