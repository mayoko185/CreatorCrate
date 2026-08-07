using System.Text;

namespace OpenLocally;

/// <summary>
/// Parsed "Open locally" request: the percent-decoded absolute Windows path
/// and the select flag (0 = open folder, 1 = select file).
/// </summary>
public sealed record UriRequest(string Path, bool Select);

/// <summary>
/// Outcome of parsing an "Open locally" URI. Invalid input yields a failure
/// result with an error message instead of an exception.
/// </summary>
public sealed record UriParseResult(bool Success, UriRequest? Request, string? Error)
{
    public static UriParseResult Ok(UriRequest request) => new(true, request, null);

    public static UriParseResult Fail(string error) => new(false, null, error);
}

/// <summary>
/// Parser for the CreatorCrate "Open locally" custom-protocol URI.
///
/// Contract (v2):
///   creatorcrate-open://open?v=2&path=&lt;absolute-windows-path&gt;&amp;select=&lt;0|1&gt;
///
/// Pure parser: no filesystem, registry, launcher, or Windows API access.
/// The path is percent-decoded but never validated or resolved.
/// </summary>
public static class UriRequestParser
{
    public const string Scheme = "creatorcrate-open";
    public const string Host = "open";
    public const string Version = "2";

    private const string SelectZero = "0";
    private const string SelectOne = "1";

    public static UriParseResult Parse(string? uri)
    {
        if (string.IsNullOrEmpty(uri))
        {
            return UriParseResult.Fail("URI must not be empty.");
        }

        int schemeSeparator = uri.IndexOf("://", StringComparison.Ordinal);
        if (schemeSeparator < 0)
        {
            return UriParseResult.Fail("URI must use the 'scheme://' form.");
        }

        string scheme = uri[..schemeSeparator];
        if (scheme != Scheme)
        {
            return UriParseResult.Fail($"Unsupported scheme '{scheme}'.");
        }

        string remainder = uri[(schemeSeparator + 3)..];
        if (remainder.IndexOf('#') >= 0)
        {
            return UriParseResult.Fail("URI must not contain a fragment.");
        }

        int queryStart = remainder.IndexOf('?');
        string authority = queryStart < 0 ? remainder : remainder[..queryStart];

        // Browsers normalize "scheme://host?query" into "scheme://host/?query",
        // appending a root path after the authority. Split the authority from
        // any path so both the bare host and a single trailing "/" are accepted,
        // while a real extra segment (e.g. "open/extra") is still rejected.
        int pathSeparator = authority.IndexOf('/');
        string host = pathSeparator < 0 ? authority : authority[..pathSeparator];
        string hostPath = pathSeparator < 0 ? string.Empty : authority[pathSeparator..];
        if (host != Host)
        {
            return UriParseResult.Fail($"Unsupported host '{host}'.");
        }

        if (hostPath.Length > 0 && hostPath != "/")
        {
            return UriParseResult.Fail($"Unsupported path '{hostPath}'.");
        }

        if (queryStart < 0)
        {
            return UriParseResult.Fail("URI is missing its query string.");
        }

        string query = remainder[(queryStart + 1)..];

        string? version = null;
        string? path = null;
        string? select = null;
        var seen = new HashSet<string>(StringComparer.Ordinal);

        foreach (string pair in query.Split('&'))
        {
            int equals = pair.IndexOf('=');
            if (equals < 0)
            {
                return UriParseResult.Fail($"Malformed query parameter '{pair}'.");
            }

            string key = pair[..equals];
            string value = pair[(equals + 1)..];

            if (key.Length == 0)
            {
                return UriParseResult.Fail("Query parameter name must not be empty.");
            }

            if (!seen.Add(key))
            {
                return UriParseResult.Fail($"Duplicate query parameter '{key}'.");
            }

            switch (key)
            {
                case "v": version = value; break;
                case "path": path = value; break;
                case "select": select = value; break;
                default:
                    return UriParseResult.Fail($"Unknown query parameter '{key}'.");
            }
        }

        if (version is null) return UriParseResult.Fail("Missing query parameter 'v'.");
        if (path is null) return UriParseResult.Fail("Missing query parameter 'path'.");
        if (select is null) return UriParseResult.Fail("Missing query parameter 'select'.");

        if (version.Length == 0) return UriParseResult.Fail("Query parameter 'v' must not be empty.");
        if (path.Length == 0) return UriParseResult.Fail("Query parameter 'path' must not be empty.");
        if (select.Length == 0) return UriParseResult.Fail("Query parameter 'select' must not be empty.");

        if (version != Version) return UriParseResult.Fail($"Unsupported version '{version}'.");
        if (select != SelectZero && select != SelectOne)
        {
            return UriParseResult.Fail($"Invalid select value '{select}'.");
        }

        string? decodedPath = PercentDecode(path);
        if (decodedPath is null)
        {
            return UriParseResult.Fail("Malformed percent encoding in 'path'.");
        }

        return UriParseResult.Ok(new UriRequest(decodedPath, select == SelectOne));
    }

    /// <summary>
    /// Decode RFC 3986 percent escapes as UTF-8. Returns null for malformed
    /// escapes, raw non-ASCII characters, or invalid UTF-8 byte sequences.
    /// </summary>
    private static string? PercentDecode(string value)
    {
        if (!value.Contains('%'))
        {
            return value;
        }

        var bytes = new List<byte>(value.Length);
        for (int i = 0; i < value.Length; i++)
        {
            char c = value[i];
            if (c == '%')
            {
                if (i + 2 >= value.Length)
                {
                    return null;
                }

                int high = HexValue(value[i + 1]);
                int low = HexValue(value[i + 2]);
                if (high < 0 || low < 0)
                {
                    return null;
                }

                bytes.Add((byte)((high << 4) | low));
                i += 2;
            }
            else if (c > 0x7F)
            {
                return null;
            }
            else
            {
                bytes.Add((byte)c);
            }
        }

        try
        {
            return new UTF8Encoding(false, true).GetString(bytes.ToArray());
        }
        catch (DecoderFallbackException)
        {
            return null;
        }
    }

    private static int HexValue(char c) => c switch
    {
        >= '0' and <= '9' => c - '0',
        >= 'a' and <= 'f' => c - 'a' + 10,
        >= 'A' and <= 'F' => c - 'A' + 10,
        _ => -1,
    };
}
