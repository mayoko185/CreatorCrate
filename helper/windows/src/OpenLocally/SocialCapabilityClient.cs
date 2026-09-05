using System.Globalization;
using System.Net;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;

namespace OpenLocally;

/// <summary>Owns media-token bearer transport and preserves server capability outcomes without exposing response text.</summary>
public sealed class SocialCapabilityClient
{
    private const int MaxJsonBytes = 1024 * 1024;
    private static readonly Regex TokenPattern = new("^[A-Za-z0-9_-]{43}$", RegexOptions.CultureInvariant);
    private static readonly HashSet<string> Platforms = new(StringComparer.Ordinal) { "patreon", "x", "bluesky" };
    private static readonly HashSet<string> Statuses = new(StringComparer.Ordinal) { "pending", "starting", "preparing", "uploading", "auth_required", "prepared", "failed", "cancelled" };
    private readonly SocialHttpClient _http;
    private readonly OriginTrustService _trust;

    public SocialCapabilityClient(SocialHttpClient http, OriginTrustService trust) =>
        (_http, _trust) = (http ?? throw new ArgumentNullException(nameof(http)), trust ?? throw new ArgumentNullException(nameof(trust)));

    internal static bool IsValidToken(string? token) => TokenPattern.IsMatch(token ?? string.Empty);

    public static bool TryCreateCapability(SocialRedeemResponse response, out SocialCapability? capability) =>
        SocialCapability.TryCreate(response, out capability);

    public async Task<SocialStatusResult> GetStatusAsync(SocialOrigin origin, SocialCapability capability, CancellationToken cancellationToken)
    {
        using var request = CreateRequest(origin, HttpMethod.Get, $"/social-prep/{capability.SessionId}/status", capability);
        try
        {
            using HttpResponseMessage response = await SendAsync(origin, request, cancellationToken).ConfigureAwait(false);
            if (!response.IsSuccessStatusCode) return SocialStatusResult.Fail(await ErrorCodeAsync(response, cancellationToken).ConfigureAwait(false));
            byte[] body = await ReadCappedAsync(response.Content, cancellationToken).ConfigureAwait(false);
            return TryParseStatus(body, out SocialStatusResponse? status) ? SocialStatusResult.Ok(status!) : SocialStatusResult.Fail("server_unreachable");
        }
        catch (HttpRequestException) { return SocialStatusResult.Fail("server_unreachable"); }
    }

    public async Task<SocialPlatformStatusResult> PatchPlatformStatusAsync(
        SocialOrigin origin, SocialCapability capability, string platform, string status, string? detailCode, string? message, CancellationToken cancellationToken)
    {
        if (!Platforms.Contains(platform) || !Statuses.Contains(status)) return SocialPlatformStatusResult.Fail("validation_failed");
        string body = JsonSerializer.Serialize(new { status, detailCode, message });
        using var request = CreateRequest(origin, HttpMethod.Patch, $"/social-prep/{capability.SessionId}/platforms/{platform}", capability);
        request.Content = new StringContent(body, Encoding.UTF8, "application/json");
        try
        {
            using HttpResponseMessage response = await SendAsync(origin, request, cancellationToken).ConfigureAwait(false);
            if (!response.IsSuccessStatusCode) return SocialPlatformStatusResult.Fail(await ErrorCodeAsync(response, cancellationToken).ConfigureAwait(false));
            byte[] responseBody = await ReadCappedAsync(response.Content, cancellationToken).ConfigureAwait(false);
            return TryParsePlatformUpdate(responseBody, out SocialPlatformStatus? parsed)
                ? SocialPlatformStatusResult.Ok(parsed!)
                : SocialPlatformStatusResult.Fail("server_unreachable");
        }
        catch (HttpRequestException) { return SocialPlatformStatusResult.Fail("server_unreachable"); }
    }

    public async Task<SocialMediaDownloadResult> DownloadAssetAsync(
        SocialOrigin origin, SocialCapability capability, SocialRedeemAsset asset, Stream destination, long maxBytes, CancellationToken cancellationToken)
    {
        if (asset.AssetId <= 0 || asset.SizeBytes < 0 || asset.SizeBytes > maxBytes) return SocialMediaDownloadResult.Fail("media_file_limit_exceeded");
        using var request = CreateRequest(origin, HttpMethod.Get, $"/social-prep/{capability.SessionId}/assets/{asset.AssetId}", capability);
        try
        {
            using HttpResponseMessage response = await SendAsync(origin, request, cancellationToken).ConfigureAwait(false);
            if (!response.IsSuccessStatusCode) return SocialMediaDownloadResult.Fail(await ErrorCodeAsync(response, cancellationToken).ConfigureAwait(false));
            if (response.Content.Headers.ContentLength is long contentLength && contentLength != asset.SizeBytes)
                return SocialMediaDownloadResult.Fail("media_size_mismatch");

            await using Stream source = await response.Content.ReadAsStreamAsync(cancellationToken).ConfigureAwait(false);
            byte[] buffer = new byte[81920];
            long written = 0;
            for (int read; (read = await source.ReadAsync(buffer, cancellationToken).ConfigureAwait(false)) > 0;)
            {
                if (written > maxBytes - read) return SocialMediaDownloadResult.Fail("media_file_limit_exceeded");
                written += read;
                if (written > asset.SizeBytes) return SocialMediaDownloadResult.Fail("media_size_mismatch");
                await destination.WriteAsync(buffer.AsMemory(0, read), cancellationToken).ConfigureAwait(false);
            }
            return written == asset.SizeBytes
                ? SocialMediaDownloadResult.Ok(written)
                : SocialMediaDownloadResult.Fail("media_size_mismatch");
        }
        catch (HttpRequestException) { return SocialMediaDownloadResult.Fail("media_download_failed"); }
    }

    private async Task<HttpResponseMessage> SendAsync(SocialOrigin origin, HttpRequestMessage request, CancellationToken cancellationToken)
    {
        OriginTrustResult authorization = await _trust.AuthorizeAsync(origin, cancellationToken).ConfigureAwait(false);
        if (!authorization.Allowed) throw new HttpRequestException(authorization.ErrorCode);
        return await _http.SendAsync(origin, request, authorization.Transport!, cancellationToken).ConfigureAwait(false);
    }

    private static HttpRequestMessage CreateRequest(SocialOrigin origin, HttpMethod method, string path, SocialCapability capability)
    {
        var request = new HttpRequestMessage(method, new Uri(origin.Uri, path));
        request.Headers.Authorization = new System.Net.Http.Headers.AuthenticationHeaderValue("Bearer", capability.MediaToken);
        return request;
    }

    private static async Task<string> ErrorCodeAsync(HttpResponseMessage response, CancellationToken cancellationToken)
    {
        try
        {
            byte[] body = await ReadCappedAsync(response.Content, cancellationToken).ConfigureAwait(false);
            using JsonDocument document = JsonDocument.Parse(body);
            JsonElement root = document.RootElement;
            if (root.ValueKind == JsonValueKind.Object && ExactProperties(root, "ok", "error") && !root.GetProperty("ok").GetBoolean())
            {
                JsonElement error = root.GetProperty("error");
                if (error.ValueKind == JsonValueKind.Object && ExactProperties(error, "code", "message") &&
                    error.GetProperty("code").ValueKind == JsonValueKind.String && error.GetProperty("code").GetString() is { Length: > 0 } code &&
                    error.GetProperty("message").ValueKind == JsonValueKind.String)
                    return code;
            }
        }
        catch (Exception ex) when (ex is JsonException or PayloadTooLargeException or InvalidOperationException) { }
        return "server_unreachable";
    }

    internal static bool TryParseStatus(ReadOnlySpan<byte> json, out SocialStatusResponse? result)
    {
        result = null;
        try
        {
            using JsonDocument document = JsonDocument.Parse(json.ToArray());
            JsonElement root = document.RootElement;
            if (root.ValueKind != JsonValueKind.Object || !ExactProperties(root, "ok", "sessionId", "state", "attemptDeadlineAt", "platforms") || !root.GetProperty("ok").GetBoolean()) return false;
            string sessionId = RequiredGuid(root.GetProperty("sessionId"));
            string state = RequiredExact(root.GetProperty("state"), "redeemed");
            DateTime deadline = RequiredTimestamp(root.GetProperty("attemptDeadlineAt"));
            if (root.GetProperty("platforms").ValueKind != JsonValueKind.Array) return false;
            var platforms = new List<SocialPlatformStatus>();
            var seen = new HashSet<string>(StringComparer.Ordinal);
            foreach (JsonElement platform in root.GetProperty("platforms").EnumerateArray())
            {
                if (!TryParsePlatform(platform, out SocialPlatformStatus? parsed) || !seen.Add(parsed!.Platform)) return false;
                platforms.Add(parsed);
            }
            result = new SocialStatusResponse(sessionId, state, deadline, platforms);
            return true;
        }
        catch (Exception ex) when (ex is JsonException or FormatException or InvalidOperationException) { return false; }
    }

    internal static bool TryParsePlatformUpdate(ReadOnlySpan<byte> json, out SocialPlatformStatus? result)
    {
        result = null;
        try
        {
            using JsonDocument document = JsonDocument.Parse(json.ToArray());
            JsonElement root = document.RootElement;
            if (root.ValueKind != JsonValueKind.Object || !ExactProperties(root, "ok", "sessionId", "platform") || !root.GetProperty("ok").GetBoolean() ||
                !Guid.TryParse(RequiredString(root.GetProperty("sessionId")), out _)) return false;
            return TryParsePlatform(root.GetProperty("platform"), out result);
        }
        catch (Exception ex) when (ex is JsonException or FormatException or InvalidOperationException) { return false; }
    }

    private static bool TryParsePlatform(JsonElement element, out SocialPlatformStatus? result)
    {
        result = null;
        if (element.ValueKind != JsonValueKind.Object || !ExactProperties(element, "platform", "status", "detailCode", "attempts", "preparedAt")) return false;
        string platform = RequiredString(element.GetProperty("platform"));
        string status = RequiredString(element.GetProperty("status"));
        if (!Platforms.Contains(platform) || !Statuses.Contains(status) || !element.GetProperty("attempts").TryGetInt32(out int attempts) || attempts < 0) return false;
        string? detail = OptionalString(element.GetProperty("detailCode"));
        DateTime? prepared = OptionalTimestamp(element.GetProperty("preparedAt"));
        result = new SocialPlatformStatus(platform, status, detail, attempts, prepared);
        return true;
    }

    private static bool ExactProperties(JsonElement element, params string[] expected)
    {
        var seen = new HashSet<string>(StringComparer.Ordinal);
        foreach (JsonProperty property in element.EnumerateObject())
            if (!seen.Add(property.Name) || !expected.Contains(property.Name, StringComparer.Ordinal)) return false;
        return seen.Count == expected.Length;
    }
    private static string RequiredGuid(JsonElement element) { string value = RequiredString(element); if (!Guid.TryParse(value, out _)) throw new FormatException(); return value; }
    private static string RequiredExact(JsonElement element, string expected) { string value = RequiredString(element); if (value != expected) throw new FormatException(); return value; }
    private static string RequiredString(JsonElement element) => element.ValueKind == JsonValueKind.String && element.GetString() is { Length: > 0 } value ? value : throw new FormatException();
    private static string? OptionalString(JsonElement element) => element.ValueKind == JsonValueKind.Null ? null : RequiredString(element);
    private static DateTime RequiredTimestamp(JsonElement element) => DateTime.TryParseExact(RequiredString(element), "yyyy-MM-dd HH:mm:ss", CultureInfo.InvariantCulture, DateTimeStyles.None, out DateTime value) ? value : throw new FormatException();
    private static DateTime? OptionalTimestamp(JsonElement element) => element.ValueKind == JsonValueKind.Null ? null : RequiredTimestamp(element);

    private static async Task<byte[]> ReadCappedAsync(HttpContent content, CancellationToken cancellationToken)
    {
        if (content.Headers.ContentLength is long length && length > MaxJsonBytes) throw new PayloadTooLargeException();
        await using Stream source = await content.ReadAsStreamAsync(cancellationToken).ConfigureAwait(false);
        using var target = new MemoryStream();
        byte[] buffer = new byte[81920];
        for (int read; (read = await source.ReadAsync(buffer, cancellationToken).ConfigureAwait(false)) > 0;)
        {
            if (target.Length > MaxJsonBytes - read) throw new PayloadTooLargeException();
            target.Write(buffer, 0, read);
        }
        return target.ToArray();
    }

    private sealed class PayloadTooLargeException : Exception { }
}
