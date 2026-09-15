using System.Text;
using System.Text.RegularExpressions;

namespace OpenLocally;

/// <summary>
/// Parsed social preparation activation: a structurally valid HTTP(S) origin
/// and the opaque server-issued intent capability. This parser deliberately
/// performs no origin trust checks or network activity.
/// </summary>
public sealed record SocialUriRequest(int Version, Uri ServerOrigin, string Intent);

public enum SocialUriParseFailure
{
    InvalidRequest,
    HelperUpdateRequired,
}

public enum SocialUriParseFailureReason
{
    InvalidActivationUri,
    InvalidActivationShape,
    MissingActivationParameter,
    DuplicateActivationParameter,
    UnsupportedActivationParameter,
    InvalidActivationVersion,
    InvalidServerOrigin,
    InvalidIntent,
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
    SocialUriParseFailureReason? Reason)
{
    public static SocialUriParseResult Ok(SocialUriRequest request) => new(true, request, null, null);

    public static SocialUriParseResult Fail(SocialUriParseFailureReason reason) =>
        new(false, null, SocialUriParseFailure.InvalidRequest, reason);

    public static SocialUriParseResult HelperUpdateRequired() =>
        new(false, null, SocialUriParseFailure.HelperUpdateRequired, SocialUriParseFailureReason.InvalidActivationVersion);

    public string? Error => Failure switch
    {
        SocialUriParseFailure.InvalidRequest => "social_uri_invalid",
        SocialUriParseFailure.HelperUpdateRequired => "helper_update_required",
        _ => null,
    };
}

/// <summary>
/// Strict parser for creatorcrate-social://prepare?v=&lt;1|2&gt;&amp;server=&lt;origin&gt;&amp;intent=&lt;token&gt;.
/// It parses only the activation envelope; trust, HTTP, media, and manual
/// companion behavior deliberately belong to later social work packages.
/// </summary>
public static partial class SocialUriRequestParser
{
    public const string Scheme = "creatorcrate-social";
    public const string Host = "prepare";
    public const int LegacyVersion = 1;
    public const int ManualVersion = 2;
    private const int IntentLength = 43;

    [GeneratedRegex("^[A-Za-z0-9_-]{43}$", RegexOptions.CultureInvariant)]
    private static partial Regex IntentPattern();

    public static SocialUriParseResult Parse(string? uri)
    {
        if (string.IsNullOrEmpty(uri))
        {
            return SocialUriParseResult.Fail(SocialUriParseFailureReason.InvalidActivationUri);
        }

        int schemeSeparator = uri.IndexOf("://", StringComparison.Ordinal);
        if (schemeSeparator < 0)
        {
            return SocialUriParseResult.Fail(SocialUriParseFailureReason.InvalidActivationUri);
        }

        string scheme = uri[..schemeSeparator];
        if (scheme != Scheme)
        {
            return SocialUriParseResult.Fail(SocialUriParseFailureReason.InvalidActivationUri);
        }

        string remainder = uri[(schemeSeparator + 3)..];
        if (remainder.Contains('#'))
        {
            return SocialUriParseResult.Fail(SocialUriParseFailureReason.InvalidActivationShape);
        }

        int queryStart = remainder.IndexOf('?');
        if (queryStart < 0)
        {
            return SocialUriParseResult.Fail(SocialUriParseFailureReason.InvalidActivationShape);
        }

        string authority = remainder[..queryStart];
        int pathSeparator = authority.IndexOf('/');
        string host = pathSeparator < 0 ? authority : authority[..pathSeparator];
        string hostPath = pathSeparator < 0 ? string.Empty : authority[pathSeparator..];

        if (host != Host)
        {
            return SocialUriParseResult.Fail(SocialUriParseFailureReason.InvalidActivationShape);
        }

        if (hostPath.Length > 0 && hostPath != "/")
        {
            return SocialUriParseResult.Fail(SocialUriParseFailureReason.InvalidActivationShape);
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
                return SocialUriParseResult.Fail(SocialUriParseFailureReason.InvalidActivationShape);
            }

            string key = pair[..equals];
            string value = pair[(equals + 1)..];
            if (key.Length == 0)
            {
                return SocialUriParseResult.Fail(SocialUriParseFailureReason.InvalidActivationShape);
            }

            if (!seen.Add(key))
            {
                return SocialUriParseResult.Fail(SocialUriParseFailureReason.DuplicateActivationParameter);
            }

            switch (key)
            {
                case "v": version = value; break;
                case "server": server = value; break;
                case "intent": intent = value; break;
                default: return SocialUriParseResult.Fail(SocialUriParseFailureReason.UnsupportedActivationParameter);
            }
        }

        if (version is null || server is null || intent is null ||
            version.Length == 0 || server.Length == 0 || intent.Length == 0)
            return SocialUriParseResult.Fail(SocialUriParseFailureReason.MissingActivationParameter);

        int parsedVersion = version switch
        {
            "1" => LegacyVersion,
            "2" => ManualVersion,
            _ => 0,
        };
        if (parsedVersion == 0) return SocialUriParseResult.HelperUpdateRequired();

        if (intent.Length != IntentLength || !IntentPattern().IsMatch(intent))
        {
            return SocialUriParseResult.Fail(SocialUriParseFailureReason.InvalidIntent);
        }

        string? decodedServer = PercentDecode(server);
        if (decodedServer is null)
        {
            return SocialUriParseResult.Fail(SocialUriParseFailureReason.InvalidServerOrigin);
        }

        if (!TryParseOrigin(decodedServer, out Uri? origin))
        {
            return SocialUriParseResult.Fail(SocialUriParseFailureReason.InvalidServerOrigin);
        }

        return SocialUriParseResult.Ok(new SocialUriRequest(parsedVersion, origin!, intent));
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
