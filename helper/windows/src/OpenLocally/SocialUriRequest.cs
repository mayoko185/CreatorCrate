using System.Text;
using System.Text.RegularExpressions;

namespace OpenLocally;

/// <summary>
/// Parsed social preparation activation: a structurally valid HTTP(S) origin
/// and the opaque server-issued intent capability. This parser deliberately
/// performs no origin trust checks or network activity.
/// </summary>
public sealed record SocialUriRequest(Uri ServerOrigin, string Intent);

public enum SocialUriParseFailure
{
    InvalidRequest,
    HelperUpdateRequired,
}

/// <summary>
/// Outcome of parsing a social preparation URI. Unsupported protocol versions
/// are distinguished so command dispatch can produce the stable update code
/// without exposing the activation URI or intent.
/// </summary>
public sealed record SocialUriParseResult(
    bool Success,
    SocialUriRequest? Request,
    SocialUriParseFailure? Failure,
    string? Error)
{
    public static SocialUriParseResult Ok(SocialUriRequest request) => new(true, request, null, null);

    public static SocialUriParseResult Fail(string error) => new(false, null, SocialUriParseFailure.InvalidRequest, error);

    public static SocialUriParseResult HelperUpdateRequired() =>
        new(false, null, SocialUriParseFailure.HelperUpdateRequired, "helper_update_required");
}

/// <summary>
/// Strict parser for creatorcrate-social://prepare?v=1&server=&lt;origin&gt;&amp;intent=&lt;token&gt;.
/// It parses only the activation envelope; trust, HTTP, media, and browser
/// behavior deliberately belong to later social work packages.
/// </summary>
public static partial class SocialUriRequestParser
{
    public const string Scheme = "creatorcrate-social";
    public const string Host = "prepare";
    public const string Version = "1";

    private const int IntentLength = 43;

    [GeneratedRegex("^[A-Za-z0-9_-]{43}$", RegexOptions.CultureInvariant)]
    private static partial Regex IntentPattern();

    public static SocialUriParseResult Parse(string? uri)
    {
        if (string.IsNullOrEmpty(uri))
        {
            return SocialUriParseResult.Fail("Social URI must not be empty.");
        }

        int schemeSeparator = uri.IndexOf("://", StringComparison.Ordinal);
        if (schemeSeparator < 0)
        {
            return SocialUriParseResult.Fail("Social URI must use the 'scheme://' form.");
        }

        string scheme = uri[..schemeSeparator];
        if (scheme != Scheme)
        {
            return SocialUriParseResult.Fail("Unsupported social URI scheme.");
        }

        string remainder = uri[(schemeSeparator + 3)..];
        if (remainder.Contains('#'))
        {
            return SocialUriParseResult.Fail("Social URI must not contain a fragment.");
        }

        int queryStart = remainder.IndexOf('?');
        if (queryStart < 0)
        {
            return SocialUriParseResult.Fail("Social URI is missing its query string.");
        }

        string authority = remainder[..queryStart];
        int pathSeparator = authority.IndexOf('/');
        string host = pathSeparator < 0 ? authority : authority[..pathSeparator];
        string hostPath = pathSeparator < 0 ? string.Empty : authority[pathSeparator..];

        if (host != Host)
        {
            return SocialUriParseResult.Fail("Unsupported social URI action.");
        }

        if (hostPath.Length > 0 && hostPath != "/")
        {
            return SocialUriParseResult.Fail("Unsupported social URI path.");
        }

        string? version = null;
        string? server = null;
        string? intent = null;
        var seen = new HashSet<string>(StringComparer.Ordinal);

        foreach (string pair in remainder[(queryStart + 1)..].Split('&'))
        {
            int equals = pair.IndexOf('=');
            if (equals < 0)
            {
                return SocialUriParseResult.Fail("Malformed social URI query parameter.");
            }

            string key = pair[..equals];
            string value = pair[(equals + 1)..];
            if (key.Length == 0)
            {
                return SocialUriParseResult.Fail("Social URI query parameter name must not be empty.");
            }

            if (!seen.Add(key))
            {
                return SocialUriParseResult.Fail($"Duplicate social URI query parameter '{key}'.");
            }

            switch (key)
            {
                case "v": version = value; break;
                case "server": server = value; break;
                case "intent": intent = value; break;
                default: return SocialUriParseResult.Fail($"Unknown social URI query parameter '{key}'.");
            }
        }

        if (version is null) return SocialUriParseResult.Fail("Missing social URI query parameter 'v'.");
        if (server is null) return SocialUriParseResult.Fail("Missing social URI query parameter 'server'.");
        if (intent is null) return SocialUriParseResult.Fail("Missing social URI query parameter 'intent'.");
        if (version.Length == 0) return SocialUriParseResult.Fail("Social URI query parameter 'v' must not be empty.");
        if (server.Length == 0) return SocialUriParseResult.Fail("Social URI query parameter 'server' must not be empty.");
        if (intent.Length == 0) return SocialUriParseResult.Fail("Social URI query parameter 'intent' must not be empty.");

        if (version != Version)
        {
            return SocialUriParseResult.HelperUpdateRequired();
        }

        if (intent.Length != IntentLength || !IntentPattern().IsMatch(intent))
        {
            return SocialUriParseResult.Fail("Social URI intent is malformed.");
        }

        string? decodedServer = PercentDecode(server);
        if (decodedServer is null)
        {
            return SocialUriParseResult.Fail("Malformed percent encoding in social URI server origin.");
        }

        if (!TryParseOrigin(decodedServer, out Uri? origin))
        {
            return SocialUriParseResult.Fail("Social URI server must be an absolute HTTP or HTTPS origin.");
        }

        return SocialUriParseResult.Ok(new SocialUriRequest(origin, intent));
    }

    private static bool TryParseOrigin(string value, out Uri? origin)
    {
        origin = null;
        if (!Uri.TryCreate(value, UriKind.Absolute, out Uri? parsed) ||
            (parsed.Scheme != Uri.UriSchemeHttp && parsed.Scheme != Uri.UriSchemeHttps) ||
            parsed.UserInfo.Length != 0 ||
            parsed.AbsolutePath != "/" ||
            parsed.Query.Length != 0 ||
            parsed.Fragment.Length != 0)
        {
            return false;
        }

        origin = parsed;
        return true;
    }

    private static string? PercentDecode(string value)
    {
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
