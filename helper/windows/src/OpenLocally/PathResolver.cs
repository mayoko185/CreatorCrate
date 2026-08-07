using System.Text.RegularExpressions;

namespace OpenLocally;

/// <summary>
/// Outcome of validating an absolute Windows path. Invalid input yields a
/// failure result with an error message instead of an exception.
/// </summary>
public sealed record PathValidationResult(bool Success, string? FullPath, string? Error)
{
    public static PathValidationResult Ok(string fullPath) => new(true, fullPath, null);

    public static PathValidationResult Fail(string error) => new(false, null, error);
}

/// <summary>
/// Pure path validation for "Open locally" requests.
///
/// Validates the absolute Windows path supplied by CreatorCrate (from
/// <see cref="UriRequest"/>) and returns the normalized absolute form. The
/// caller owns the mapping from its own data to this path; the helper holds
/// no root configuration and performs no containment checks.
///
/// The supplied path is treated as hostile input. It is rejected when it is
/// empty, relative, drive-relative, UNC, a device path, contains traversal
/// or dot segments, control or null characters, Windows reserved device
/// names, or alternate data stream syntax.
///
/// Pure component: no filesystem access, no Explorer launching, no registry,
/// and no config storage. Reparse point/symlink resolution is intentionally
/// out of scope for this phase.
/// </summary>
public static class PathResolver
{
    private static readonly Regex DriveLetterPrefix =
        new(@"^[A-Za-z]:", RegexOptions.Compiled);

    private static readonly Regex DevicePrefix =
        new(@"^\\[.?]\\", RegexOptions.Compiled);

    private static readonly Regex DotSegment =
        new(@"(^|[/\\])\.\.?($|[/\\])", RegexOptions.Compiled);

    private static readonly Regex WindowsReservedName =
        new(@"^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(\..*)?$", RegexOptions.Compiled | RegexOptions.IgnoreCase);

    /// <summary>
    /// Validate the absolute Windows path supplied by CreatorCrate. Returns
    /// the normalized absolute path on success, or a failure result with a
    /// reason. Never touches the filesystem.
    /// </summary>
    public static PathValidationResult Validate(string? path)
    {
        if (string.IsNullOrWhiteSpace(path))
        {
            return PathValidationResult.Fail("Path must not be empty.");
        }

        if (path.Contains('\0'))
        {
            return PathValidationResult.Fail("Path must not contain a null character.");
        }

        if (path.Any(char.IsControl))
        {
            return PathValidationResult.Fail("Path must not contain control characters.");
        }

        // The URI uses forward slashes; normalize before every other check so
        // that both separator styles are treated identically.
        string normalized = path.Replace('/', Path.DirectorySeparatorChar);

        if (DevicePrefix.IsMatch(normalized))
        {
            return PathValidationResult.Fail("Path must not include a device prefix.");
        }

        if (normalized.StartsWith(@"\\", StringComparison.Ordinal))
        {
            return PathValidationResult.Fail("Path must not be a UNC path.");
        }

        if (!DriveLetterPrefix.IsMatch(normalized))
        {
            return PathValidationResult.Fail("Path must be an absolute Windows path with a drive letter.");
        }

        if (normalized.Length < 3 || normalized[2] != Path.DirectorySeparatorChar)
        {
            return PathValidationResult.Fail("Path must be an absolute Windows path with a drive letter.");
        }

        if (normalized.Length == 3)
        {
            return PathValidationResult.Fail("Path must not be the drive root.");
        }

        if (DotSegment.IsMatch(normalized))
        {
            return PathValidationResult.Fail("Path must not contain '.' or '..' path segments.");
        }

        string[] segments = normalized.Split(Path.DirectorySeparatorChar);
        for (int i = 0; i < segments.Length; i++)
        {
            string segment = segments[i];

            if (WindowsReservedName.IsMatch(segment))
            {
                return PathValidationResult.Fail($"Path must not use the reserved device name '{segment}'.");
            }

            // The leading drive segment ("C:") is the drive root, not an
            // alternate data stream; every other segment must not contain a
            // colon.
            if (i > 0 && segment.Contains(':'))
            {
                return PathValidationResult.Fail("Path must not contain an alternate data stream separator ':'.");
            }
        }

        string fullPath;
        try
        {
            fullPath = Path.TrimEndingDirectorySeparator(Path.GetFullPath(normalized));
        }
        catch (Exception ex) when (ex is ArgumentException or NotSupportedException or PathTooLongException)
        {
            return PathValidationResult.Fail("Path could not be resolved.");
        }

        // GetFullPath can collapse odd inputs (e.g. "C:\\") into the drive
        // root ("C:\"); the result must stay an absolute Windows path below
        // the root.
        if (fullPath.Length < 3 || fullPath.Length == 3 || fullPath[2] != Path.DirectorySeparatorChar)
        {
            return PathValidationResult.Fail("Path could not be resolved.");
        }

        return PathValidationResult.Ok(fullPath);
    }
}
