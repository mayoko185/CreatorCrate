using System.Globalization;
using System.Net;
using System.Net.Http;
using System.Security.Authentication;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;

namespace OpenLocally;

public sealed class SocialRedeemClient
{
    public const int MaxJsonBytes = 8 * 1024 * 1024;
    private static readonly Regex TokenPattern = new("^[A-Za-z0-9_-]{43}$", RegexOptions.CultureInvariant);
    private readonly SocialHttpClient _http;
    private readonly OriginTrustService _trust;

    public SocialRedeemClient(SocialHttpClient http, OriginTrustService trust) =>
        (_http, _trust) = (http ?? throw new ArgumentNullException(nameof(http)), trust ?? throw new ArgumentNullException(nameof(trust)));

    public async Task<SocialRedeemResult> RedeemAsync(SocialOrigin origin, string intent, CancellationToken cancellationToken)
    {
        if (!TokenPattern.IsMatch(intent ?? string.Empty)) return SocialRedeemResult.Fail("invalid_intent");
        OriginTrustResult authorization = await _trust.AuthorizeAsync(origin, cancellationToken).ConfigureAwait(false);
        if (!authorization.Allowed) return SocialRedeemResult.Fail(authorization.ErrorCode!);
        TransportAuthorizationResult transport = authorization.Transport!;

        return await RedeemAuthorizedAsync(origin, intent ?? string.Empty, transport, cancellationToken).ConfigureAwait(false);
    }

    internal async Task<SocialRedeemResult> RedeemAuthorizedAsync(SocialOrigin origin, string intent, TransportAuthorizationResult transport, CancellationToken cancellationToken)
    {
        if (!TokenPattern.IsMatch(intent ?? string.Empty)) return SocialRedeemResult.Fail("invalid_intent");

        using var request = new HttpRequestMessage(HttpMethod.Post, new Uri(origin.Uri, "/social-prep/redeem"))
        {
            Content = new StringContent($"{{\"intent\":\"{intent}\"}}", Encoding.UTF8, "application/json"),
        };

        try
        {
            using HttpResponseMessage response = await _http.SendAsync(origin, request, transport, cancellationToken).ConfigureAwait(false);
            if (response.StatusCode == HttpStatusCode.Unauthorized) return SocialRedeemResult.Fail("invalid_intent");
            if ((int)response.StatusCode is >= 300 and < 400) return SocialRedeemResult.Fail("server_unreachable");
            if (!response.IsSuccessStatusCode) return SocialRedeemResult.Fail("server_unreachable");

            byte[] body = await ReadCappedAsync(response.Content, cancellationToken).ConfigureAwait(false);
            return TryParseResponse(body, out SocialRedeemResponse? parsed)
                ? SocialRedeemResult.Ok(parsed!)
                : SocialRedeemResult.Fail("redeem_payload_invalid");
        }
        catch (PayloadTooLargeException) { return SocialRedeemResult.Fail("redeem_payload_too_large"); }
        catch (HttpRequestException ex) when (IsTlsValidationFailure(ex)) { return SocialRedeemResult.Fail("tls_validation_failed"); }
        catch (HttpRequestException) { return SocialRedeemResult.Fail("server_unreachable"); }
    }

    internal static bool TryParseResponse(ReadOnlySpan<byte> json, out SocialRedeemResponse? result)
    {
        result = null;
        try
        {
            using JsonDocument document = JsonDocument.Parse(json.ToArray());
            JsonElement root = document.RootElement;
            if (root.ValueKind != JsonValueKind.Object || !ExactProperties(root, "ok", "sessionId", "releaseId", "attemptDeadlineAt", "platforms", "mediaToken") ||
                !root.GetProperty("ok").GetBoolean()) return false;
            string sessionId = RequiredString(root.GetProperty("sessionId"));
            string mediaToken = RequiredString(root.GetProperty("mediaToken"));
            int releaseId = checked((int)RequiredPositiveInt(root.GetProperty("releaseId")));
            if (!Guid.TryParse(sessionId, out _) || !TokenPattern.IsMatch(mediaToken)) return false;
            if (!DateTime.TryParseExact(RequiredString(root.GetProperty("attemptDeadlineAt")), "yyyy-MM-dd HH:mm:ss", CultureInfo.InvariantCulture, DateTimeStyles.None, out DateTime deadline)) return false;
            if (root.GetProperty("platforms").ValueKind != JsonValueKind.Array) return false;

            var platforms = new List<SocialRedeemPlatform>();
            var seenPlatforms = new HashSet<string>(StringComparer.Ordinal);
            foreach (JsonElement platform in root.GetProperty("platforms").EnumerateArray())
            {
                if (platform.ValueKind != JsonValueKind.Object || !ExactProperties(platform, "platform", "title", "body", "assets")) return false;
                string name = RequiredString(platform.GetProperty("platform"));
                if (!new[] { "patreon", "x", "bluesky" }.Contains(name, StringComparer.Ordinal) || !seenPlatforms.Add(name)) return false;
                string title = RequiredString(platform.GetProperty("title"));
                string body = RequiredStringAllowEmpty(platform.GetProperty("body"));
                JsonElement assetsElement = platform.GetProperty("assets");
                if (assetsElement.ValueKind != JsonValueKind.Array) return false;
                var assets = new List<SocialRedeemAsset>();
                var seenAssets = new HashSet<long>();
                foreach (JsonElement asset in assetsElement.EnumerateArray())
                {
                    if (asset.ValueKind != JsonValueKind.Object || !PropertiesMatch(asset, new[] { "assetId", "role", "sortOrder", "filename", "extension", "mimeType", "sizeBytes", "relativePath", "isPresent" }, "windowsPath")) return false;
                    long id = RequiredPositiveInt(asset.GetProperty("assetId"));
                    string role = RequiredString(asset.GetProperty("role"));
                    long sort = RequiredNonNegativeInt(asset.GetProperty("sortOrder"));
                    string filename = RequiredString(asset.GetProperty("filename"));
                    string extension = RequiredString(asset.GetProperty("extension"));
                    string mime = RequiredString(asset.GetProperty("mimeType"));
                    long size = RequiredNonNegativeInt(asset.GetProperty("sizeBytes"));
                    string relativePath = RequiredString(asset.GetProperty("relativePath"));
                    JsonElement present = asset.GetProperty("isPresent");
                    if (!present.TryGetInt32(out int presentValue) || presentValue is not (0 or 1) || !seenAssets.Add(id) ||
                        !new[] { "primary", "preview", "attachment" }.Contains(role, StringComparer.Ordinal) ||
                        !extension.StartsWith(".", StringComparison.Ordinal) || extension.Length < 2 ||
                        !filename.EndsWith(extension, StringComparison.OrdinalIgnoreCase) || !mime.Contains('/', StringComparison.Ordinal) || string.IsNullOrEmpty(relativePath)) return false;
                    string? windowsPath = asset.TryGetProperty("windowsPath", out JsonElement path) ? path.ValueKind switch
                    {
                        JsonValueKind.Null => null,
                        JsonValueKind.String => path.GetString(),
                        _ => throw new FormatException(),
                    } : null;
                    assets.Add(new SocialRedeemAsset(id, role, sort, filename, extension, mime, size, relativePath, presentValue == 1, windowsPath));
                }
                platforms.Add(new SocialRedeemPlatform(name, title, body, assets));
            }
            result = new SocialRedeemResponse(sessionId, deadline, platforms, mediaToken) { ReleaseId = releaseId };
            return true;
        }
        catch (JsonException) { return false; }
        catch (FormatException) { return false; }
        catch (InvalidOperationException) { return false; }
    }

    private static bool ExactProperties(JsonElement element, params string[] expected)
    {
        var seen = new HashSet<string>(StringComparer.Ordinal);
        foreach (JsonProperty property in element.EnumerateObject())
            if (!seen.Add(property.Name) || !expected.Contains(property.Name, StringComparer.Ordinal)) return false;
        return seen.Count == expected.Length;
    }
    private static bool PropertiesMatch(JsonElement element, string[] required, params string[] optional)
    {
        var allowed = new HashSet<string>(required.Concat(optional), StringComparer.Ordinal);
        var seen = new HashSet<string>(StringComparer.Ordinal);
        foreach (JsonProperty property in element.EnumerateObject()) if (!allowed.Contains(property.Name) || !seen.Add(property.Name)) return false;
        return required.All(seen.Contains);
    }
    private static string RequiredString(JsonElement element) =>
        element.ValueKind == JsonValueKind.String && element.GetString() is { Length: > 0 } value ? value : throw new FormatException();
    private static string RequiredStringAllowEmpty(JsonElement element) =>
        element.ValueKind == JsonValueKind.String && element.GetString() is { } value ? value : throw new FormatException();
    private static long RequiredPositiveInt(JsonElement element) =>
        element.TryGetInt64(out long value) && value > 0 ? value : throw new FormatException();
    private static long RequiredNonNegativeInt(JsonElement element) =>
        element.TryGetInt64(out long value) && value >= 0 ? value : throw new FormatException();

    private static async Task<byte[]> ReadCappedAsync(HttpContent content, CancellationToken cancellationToken)
    {
        if (content.Headers.ContentLength is long length && length > MaxJsonBytes) throw new PayloadTooLargeException();
        await using Stream source = await content.ReadAsStreamAsync(cancellationToken).ConfigureAwait(false);
        using var target = new MemoryStream();
        byte[] buffer = new byte[81920];
        for (int read; (read = await source.ReadAsync(buffer, cancellationToken).ConfigureAwait(false)) > 0;)
        {
            if (target.Length + read > MaxJsonBytes) throw new PayloadTooLargeException();
            target.Write(buffer, 0, read);
        }
        return target.ToArray();
    }

    private static bool IsTlsValidationFailure(Exception error)
    {
        int remainingInnerExceptions = 16;
        for (Exception? current = error; current is not null && remainingInnerExceptions-- > 0; current = current.InnerException)
        {
            if (current is AuthenticationException) return true;
            if (current is HttpRequestException { HttpRequestError: HttpRequestError.SecureConnectionError }) return true;
        }
        return false;
    }

    private sealed class PayloadTooLargeException : Exception { }
}
