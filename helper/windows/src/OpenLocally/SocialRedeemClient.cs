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
    private static readonly Regex ExtensionPattern = new("^\\.?[A-Za-z0-9]{1,16}$", RegexOptions.CultureInvariant);
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

        int? responseStatus = null;
        try
        {
            using HttpResponseMessage response = await _http.SendAsync(origin, request, transport, cancellationToken).ConfigureAwait(false);
            int status = (int)response.StatusCode;
            responseStatus = status;
            if (response.StatusCode == HttpStatusCode.Unauthorized)
                return HttpFailure("invalid_intent", ManualSocialDiagnosticReason.HttpNonSuccess, status);
            if (status is >= 300 and < 400)
                return HttpFailure("server_unreachable", ManualSocialDiagnosticReason.RedirectRejected, status);
            if (!response.IsSuccessStatusCode)
                return HttpFailure("server_unreachable", ManualSocialDiagnosticReason.HttpNonSuccess, status);

            byte[] body = await ReadCappedAsync(response.Content, cancellationToken).ConfigureAwait(false);
            return TryParseResponse(body, out SocialRedeemResponse? parsed, out ManualSocialDiagnostic? diagnostic)
                ? SocialRedeemResult.Ok(parsed!)
                : SocialRedeemResult.Fail("redeem_payload_invalid", diagnostic! with { HttpStatus = status });
        }
        catch (PayloadTooLargeException)
        {
            return SocialRedeemResult.Fail("redeem_payload_too_large", new(
                "redeem_payload_too_large", ManualSocialDiagnosticStage.RedeemPreparation,
                ManualSocialDiagnosticReason.ResponseTooLarge, HttpStatus: responseStatus));
        }
        catch (OperationCanceledException) when (!cancellationToken.IsCancellationRequested)
        {
            return SocialRedeemResult.Fail("server_unreachable", new(
                "server_unreachable", ManualSocialDiagnosticStage.RedeemRequest,
                ManualSocialDiagnosticReason.RequestNotSent));
        }
        catch (HttpRequestException ex) when (IsTlsValidationFailure(ex))
        {
            return SocialRedeemResult.Fail("tls_validation_failed", new(
                "tls_validation_failed", ManualSocialDiagnosticStage.RedeemRequest,
                ManualSocialDiagnosticReason.TlsTransportFailure));
        }
        catch (HttpRequestException)
        {
            return SocialRedeemResult.Fail("server_unreachable", new(
                "server_unreachable", ManualSocialDiagnosticStage.RedeemRequest,
                ManualSocialDiagnosticReason.RequestNotSent));
        }
    }

    internal static bool TryParseResponse(ReadOnlySpan<byte> json, out SocialRedeemResponse? result)
        => TryParseResponse(json, out result, out _);

    internal static bool TryParseResponse(
        ReadOnlySpan<byte> json, out SocialRedeemResponse? result, out ManualSocialDiagnostic? diagnostic)
    {
        result = null;
        diagnostic = null;
        try
        {
            using JsonDocument document = JsonDocument.Parse(json.ToArray());
            JsonElement root = document.RootElement;
            if (root.ValueKind != JsonValueKind.Object) return ParseFailure(out diagnostic, ManualSocialDiagnosticReason.RootNotObject);
            if (!ValidateProperties(root, ["ok", "sessionId", "releaseId", "attemptDeadlineAt", "platforms", "mediaToken"], [], out ManualSocialDiagnosticReason rootPropertyFailure))
                return ParseFailure(out diagnostic, rootPropertyFailure);
            if (root.GetProperty("ok").ValueKind is not (JsonValueKind.True or JsonValueKind.False) || !root.GetProperty("ok").GetBoolean())
                return ParseFailure(out diagnostic, ManualSocialDiagnosticReason.InvalidSuccessIndicator);
            if (!TryRequiredString(root.GetProperty("sessionId"), out string? sessionId) || !Guid.TryParse(sessionId, out _))
                return ParseFailure(out diagnostic, ManualSocialDiagnosticReason.InvalidSessionId);
            if (!root.GetProperty("releaseId").TryGetInt32(out int releaseId) || releaseId <= 0)
                return ParseFailure(out diagnostic, ManualSocialDiagnosticReason.InvalidReleaseId);
            if (!TryRequiredString(root.GetProperty("attemptDeadlineAt"), out string? deadlineText) ||
                !DateTime.TryParseExact(deadlineText, "yyyy-MM-dd HH:mm:ss", CultureInfo.InvariantCulture, DateTimeStyles.None, out DateTime deadline))
                return ParseFailure(out diagnostic, ManualSocialDiagnosticReason.InvalidDeadline);
            if (root.GetProperty("platforms").ValueKind != JsonValueKind.Array)
                return ParseFailure(out diagnostic, ManualSocialDiagnosticReason.InvalidPlatformCollection);
            if (!TryRequiredString(root.GetProperty("mediaToken"), out string? mediaToken) || !TokenPattern.IsMatch(mediaToken!))
                return ParseFailure(out diagnostic, ManualSocialDiagnosticReason.InvalidMediaToken);

            var platforms = new List<SocialRedeemPlatform>();
            var seenPlatforms = new HashSet<string>(StringComparer.Ordinal);
            foreach (JsonElement platform in root.GetProperty("platforms").EnumerateArray())
            {
                int platformOrdinal = platforms.Count + 1;
                if (platform.ValueKind != JsonValueKind.Object) return ParseFailure(out diagnostic, ManualSocialDiagnosticReason.InvalidPlatform, platformOrdinal);
                if (!ValidateProperties(platform, ["platform", "title", "body", "assets"], [], out ManualSocialDiagnosticReason platformPropertyFailure))
                    return ParseFailure(out diagnostic, platformPropertyFailure, platformOrdinal);
                if (!TryRequiredString(platform.GetProperty("platform"), out string? name) ||
                    !new[] { "patreon", "x", "bluesky" }.Contains(name, StringComparer.Ordinal))
                    return ParseFailure(out diagnostic, ManualSocialDiagnosticReason.InvalidPlatform, platformOrdinal);
                if (!seenPlatforms.Add(name!)) return ParseFailure(out diagnostic, ManualSocialDiagnosticReason.DuplicatePlatform, platformOrdinal);
                if (!TryRequiredString(platform.GetProperty("title"), out string? title))
                    return ParseFailure(out diagnostic, ManualSocialDiagnosticReason.InvalidTitle, platformOrdinal);
                if (!TryStringAllowEmpty(platform.GetProperty("body"), out string? body))
                    return ParseFailure(out diagnostic, ManualSocialDiagnosticReason.InvalidBody, platformOrdinal);
                JsonElement assetsElement = platform.GetProperty("assets");
                if (assetsElement.ValueKind != JsonValueKind.Array)
                    return ParseFailure(out diagnostic, ManualSocialDiagnosticReason.InvalidAssetCollection, platformOrdinal);
                var assets = new List<SocialRedeemAsset>();
                var seenAssets = new HashSet<long>();
                foreach (JsonElement asset in assetsElement.EnumerateArray())
                {
                    int assetOrdinal = assets.Count + 1;
                    if (asset.ValueKind != JsonValueKind.Object)
                        return ParseFailure(out diagnostic, ManualSocialDiagnosticReason.InvalidAssetId, platformOrdinal, assetOrdinal);
                    if (!ValidateProperties(asset,
                        ["assetId", "role", "sortOrder", "filename", "extension", "mimeType", "sizeBytes", "relativePath", "isPresent"],
                        ["windowsPath"], out ManualSocialDiagnosticReason assetPropertyFailure))
                        return ParseFailure(out diagnostic, assetPropertyFailure, platformOrdinal, assetOrdinal);
                    if (!TryPositiveInt64(asset.GetProperty("assetId"), out long id))
                        return ParseFailure(out diagnostic, ManualSocialDiagnosticReason.InvalidAssetId, platformOrdinal, assetOrdinal);
                    if (!seenAssets.Add(id)) return ParseFailure(out diagnostic, ManualSocialDiagnosticReason.DuplicateAsset, platformOrdinal, assetOrdinal);
                    if (!TryRequiredString(asset.GetProperty("role"), out string? role) ||
                        !new[] { "primary", "preview", "attachment" }.Contains(role, StringComparer.Ordinal))
                        return ParseFailure(out diagnostic, ManualSocialDiagnosticReason.InvalidAssetRole, platformOrdinal, assetOrdinal);
                    if (!TryNonNegativeInt64(asset.GetProperty("sortOrder"), out long sort))
                        return ParseFailure(out diagnostic, ManualSocialDiagnosticReason.InvalidAssetOrder, platformOrdinal, assetOrdinal);
                    if (!TryRequiredString(asset.GetProperty("filename"), out string? filename))
                        return ParseFailure(out diagnostic, ManualSocialDiagnosticReason.InvalidAssetFilename, platformOrdinal, assetOrdinal);
                    if (!TryRequiredString(asset.GetProperty("extension"), out string? extensionText) || !TryNormalizeExtension(extensionText!, out string? extension))
                        return ParseFailure(out diagnostic, ManualSocialDiagnosticReason.InvalidAssetExtension, platformOrdinal, assetOrdinal);
                    if (!filename!.EndsWith(extension!, StringComparison.OrdinalIgnoreCase))
                        return ParseFailure(out diagnostic, ManualSocialDiagnosticReason.FilenameExtensionMismatch, platformOrdinal, assetOrdinal);
                    if (!TryRequiredString(asset.GetProperty("mimeType"), out string? mime) || !mime!.Contains('/', StringComparison.Ordinal))
                        return ParseFailure(out diagnostic, ManualSocialDiagnosticReason.InvalidMimeType, platformOrdinal, assetOrdinal);
                    if (!TryNonNegativeInt64(asset.GetProperty("sizeBytes"), out long size))
                        return ParseFailure(out diagnostic, ManualSocialDiagnosticReason.InvalidAssetSize, platformOrdinal, assetOrdinal);
                    if (!TryRequiredString(asset.GetProperty("relativePath"), out string? relativePath))
                        return ParseFailure(out diagnostic, ManualSocialDiagnosticReason.InvalidRelativePath, platformOrdinal, assetOrdinal);
                    JsonElement present = asset.GetProperty("isPresent");
                    if (!present.TryGetInt32(out int presentValue) || presentValue is not (0 or 1))
                        return ParseFailure(out diagnostic, ManualSocialDiagnosticReason.InvalidPresence, platformOrdinal, assetOrdinal);
                    string? windowsPath = null;
                    if (asset.TryGetProperty("windowsPath", out JsonElement path))
                    {
                        if (path.ValueKind == JsonValueKind.String) windowsPath = path.GetString();
                        else if (path.ValueKind != JsonValueKind.Null)
                            return ParseFailure(out diagnostic, ManualSocialDiagnosticReason.InvalidWindowsPath, platformOrdinal, assetOrdinal);
                    }
                    assets.Add(new SocialRedeemAsset(id, role!, sort, filename, extension!, mime, size, relativePath!, presentValue == 1, windowsPath));
                }
                platforms.Add(new SocialRedeemPlatform(name!, title!, body!, assets));
            }
            result = new SocialRedeemResponse(sessionId!, deadline, platforms, mediaToken!) { ReleaseId = releaseId };
            return true;
        }
        catch (JsonException) { return ParseFailure(out diagnostic, ManualSocialDiagnosticReason.MalformedJson); }
    }

    private static bool ParseFailure(
        out ManualSocialDiagnostic? diagnostic, ManualSocialDiagnosticReason reason,
        int? platform = null, int? asset = null)
    {
        diagnostic = new ManualSocialDiagnostic(
            "redeem_payload_invalid", ManualSocialDiagnosticStage.RedeemPreparation,
            reason, PlatformOrdinal: platform, AssetOrdinal: asset);
        return false;
    }

    private static bool ValidateProperties(
        JsonElement element, string[] required, string[] optional, out ManualSocialDiagnosticReason failure)
    {
        var allowed = new HashSet<string>(required.Concat(optional), StringComparer.Ordinal);
        var seen = new HashSet<string>(StringComparer.Ordinal);
        foreach (JsonProperty property in element.EnumerateObject())
        {
            if (!allowed.Contains(property.Name) || !seen.Add(property.Name))
            {
                failure = ManualSocialDiagnosticReason.UnexpectedProperty;
                return false;
            }
        }
        if (!required.All(seen.Contains))
        {
            failure = ManualSocialDiagnosticReason.MissingRequiredProperty;
            return false;
        }
        failure = default;
        return true;
    }

    private static bool TryRequiredString(JsonElement element, out string? value)
    {
        value = element.ValueKind == JsonValueKind.String ? element.GetString() : null;
        return value is { Length: > 0 };
    }

    private static bool TryStringAllowEmpty(JsonElement element, out string? value)
    {
        value = element.ValueKind == JsonValueKind.String ? element.GetString() : null;
        return value is not null;
    }

    private static bool TryNormalizeExtension(string extension, out string? normalized)
    {
        normalized = null;
        if (!ExtensionPattern.IsMatch(extension)) return false;
        normalized = (extension.StartsWith(".", StringComparison.Ordinal) ? extension : "." + extension).ToLowerInvariant();
        return true;
    }

    private static bool TryPositiveInt64(JsonElement element, out long value) =>
        element.TryGetInt64(out value) && value > 0;

    private static bool TryNonNegativeInt64(JsonElement element, out long value) =>
        element.TryGetInt64(out value) && value >= 0;

    private static SocialRedeemResult HttpFailure(
        string code, ManualSocialDiagnosticReason reason, int status) =>
        SocialRedeemResult.Fail(code, new ManualSocialDiagnostic(
            code, ManualSocialDiagnosticStage.RedeemRequest, reason, HttpStatus: status));

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
