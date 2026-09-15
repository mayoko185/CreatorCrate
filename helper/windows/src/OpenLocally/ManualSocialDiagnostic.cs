using System.Globalization;

namespace OpenLocally;

public enum ManualSocialDiagnosticStage
{
    ActivationParsing,
    RedeemRequest,
    RedeemPreparation,
    CapabilityConstruction,
    MediaPreparation,
    CompanionPresentation,
    ManualPreparation,
}

public enum ManualSocialDiagnosticReason
{
    InvalidActivationUri,
    InvalidActivationShape,
    MissingActivationParameter,
    DuplicateActivationParameter,
    UnsupportedActivationParameter,
    InvalidActivationVersion,
    InvalidServerOrigin,
    InvalidIntent,
    MalformedJson,
    RootNotObject,
    UnexpectedProperty,
    MissingRequiredProperty,
    InvalidSuccessIndicator,
    InvalidSessionId,
    InvalidReleaseId,
    InvalidDeadline,
    InvalidPlatformCollection,
    InvalidPlatform,
    DuplicatePlatform,
    InvalidTitle,
    InvalidBody,
    InvalidAssetCollection,
    InvalidAssetId,
    InvalidAssetRole,
    InvalidAssetOrder,
    InvalidAssetFilename,
    InvalidAssetExtension,
    FilenameExtensionMismatch,
    InvalidMimeType,
    InvalidAssetSize,
    InvalidRelativePath,
    InvalidPresence,
    DuplicateAsset,
    InvalidWindowsPath,
    InvalidMediaToken,
    RequestNotSent,
    TlsTransportFailure,
    RedirectRejected,
    HttpNonSuccess,
    ResponseTooLarge,
    CapabilityConstructionFailed,
    PreparationFailed,
    CompanionUnavailable,
}

/// <summary>
/// Bounded, non-secret diagnostic carried by the manual-social path. All text
/// is selected from fixed vocabulary; payload values never enter this model.
/// </summary>
public sealed record ManualSocialDiagnostic
{
    private static readonly HashSet<string> SafeCodes = new(StringComparer.Ordinal)
    {
        "attempt_not_active", "caller_cancelled", "helper_update_required", "insecure_origin_disallowed", "invalid_intent",
        "manual_companion_unavailable", "manual_preparation_failed", "media_aggregate_limit_exceeded",
        "media_download_failed", "media_file_limit_exceeded", "media_file_missing", "media_file_unsafe",
        "media_size_mismatch", "media_source_untrusted", "media_temp_unavailable", "media_token_expired",
        "media_token_invalid", "media_token_malformed", "media_token_missing", "media_unavailable",
        "no_assets_selected", "platform_not_in_release", "redeem_payload_invalid", "redeem_payload_too_large",
        "server_origin_denied", "server_unreachable", "tls_validation_failed", "unsupported_social_version",
        "social_uri_invalid", "validation_failed",
    };

    public ManualSocialDiagnostic(
        string Code,
        ManualSocialDiagnosticStage Stage,
        ManualSocialDiagnosticReason Reason,
        int? HttpStatus = null,
        int? PlatformOrdinal = null,
        int? AssetOrdinal = null,
        int? ReleaseId = null)
    {
        this.Code = SafeCode(Code);
        this.Stage = Stage;
        this.Reason = Reason;
        this.HttpStatus = HttpStatus;
        this.PlatformOrdinal = PlatformOrdinal;
        this.AssetOrdinal = AssetOrdinal;
        this.ReleaseId = ReleaseId;
    }

    public string Code { get; }
    public ManualSocialDiagnosticStage Stage { get; }
    public ManualSocialDiagnosticReason Reason { get; }
    public int? HttpStatus { get; init; }
    public int? PlatformOrdinal { get; }
    public int? AssetOrdinal { get; }
    public int? ReleaseId { get; }

    public string ReasonCode => Reason switch
    {
        ManualSocialDiagnosticReason.InvalidActivationUri => "invalid_activation_uri",
        ManualSocialDiagnosticReason.InvalidActivationShape => "invalid_activation_shape",
        ManualSocialDiagnosticReason.MissingActivationParameter => "missing_activation_parameter",
        ManualSocialDiagnosticReason.DuplicateActivationParameter => "duplicate_activation_parameter",
        ManualSocialDiagnosticReason.UnsupportedActivationParameter => "unsupported_activation_parameter",
        ManualSocialDiagnosticReason.InvalidActivationVersion => "invalid_activation_version",
        ManualSocialDiagnosticReason.InvalidServerOrigin => "invalid_server_origin",
        ManualSocialDiagnosticReason.InvalidIntent => "invalid_intent",
        ManualSocialDiagnosticReason.MalformedJson => "malformed_json",
        ManualSocialDiagnosticReason.RootNotObject => "root_not_object",
        ManualSocialDiagnosticReason.UnexpectedProperty => "unexpected_property",
        ManualSocialDiagnosticReason.MissingRequiredProperty => "missing_required_property",
        ManualSocialDiagnosticReason.InvalidSuccessIndicator => "invalid_success_indicator",
        ManualSocialDiagnosticReason.InvalidSessionId => "invalid_session_id",
        ManualSocialDiagnosticReason.InvalidReleaseId => "invalid_release_id",
        ManualSocialDiagnosticReason.InvalidDeadline => "invalid_deadline",
        ManualSocialDiagnosticReason.InvalidPlatformCollection => "invalid_platform_collection",
        ManualSocialDiagnosticReason.InvalidPlatform => "invalid_platform",
        ManualSocialDiagnosticReason.DuplicatePlatform => "duplicate_platform",
        ManualSocialDiagnosticReason.InvalidTitle => "invalid_title",
        ManualSocialDiagnosticReason.InvalidBody => "invalid_body",
        ManualSocialDiagnosticReason.InvalidAssetCollection => "invalid_asset_collection",
        ManualSocialDiagnosticReason.InvalidAssetId => "invalid_asset_id",
        ManualSocialDiagnosticReason.InvalidAssetRole => "invalid_asset_role",
        ManualSocialDiagnosticReason.InvalidAssetOrder => "invalid_asset_order",
        ManualSocialDiagnosticReason.InvalidAssetFilename => "invalid_asset_filename",
        ManualSocialDiagnosticReason.InvalidAssetExtension => "invalid_asset_extension",
        ManualSocialDiagnosticReason.FilenameExtensionMismatch => "filename_extension_mismatch",
        ManualSocialDiagnosticReason.InvalidMimeType => "invalid_mime_type",
        ManualSocialDiagnosticReason.InvalidAssetSize => "invalid_asset_size",
        ManualSocialDiagnosticReason.InvalidRelativePath => "invalid_relative_path",
        ManualSocialDiagnosticReason.InvalidPresence => "invalid_presence",
        ManualSocialDiagnosticReason.DuplicateAsset => "duplicate_asset",
        ManualSocialDiagnosticReason.InvalidWindowsPath => "invalid_windows_path",
        ManualSocialDiagnosticReason.InvalidMediaToken => "invalid_media_token",
        ManualSocialDiagnosticReason.RequestNotSent => "request_not_sent",
        ManualSocialDiagnosticReason.TlsTransportFailure => "tls_transport_failure",
        ManualSocialDiagnosticReason.RedirectRejected => "redirect_rejected",
        ManualSocialDiagnosticReason.HttpNonSuccess => "http_non_success",
        ManualSocialDiagnosticReason.ResponseTooLarge => "response_too_large",
        ManualSocialDiagnosticReason.CapabilityConstructionFailed => "capability_construction_failed",
        ManualSocialDiagnosticReason.CompanionUnavailable => "companion_unavailable",
        _ => "preparation_failed",
    };

    public string FormatForDisplay()
    {
        var lines = new List<string>
        {
            "CreatorCrate could not prepare this release for manual publishing.",
            string.Empty,
            "Stage: " + StageLabel(),
            "Problem: " + ProblemLabel(),
        };
        string? expected = ExpectedLabel();
        if (expected is not null) lines.Add("Expected: " + expected);
        if (PlatformOrdinal is > 0) lines.Add("Platform: " + PlatformOrdinal.Value.ToString(CultureInfo.InvariantCulture));
        if (AssetOrdinal is > 0) lines.Add("Asset: " + AssetOrdinal.Value.ToString(CultureInfo.InvariantCulture));
        if (ReleaseId is > 0) lines.Add("Release ID: " + ReleaseId.Value.ToString(CultureInfo.InvariantCulture));
        if (HttpStatus is >= 100 and <= 599) lines.Add("HTTP status: " + HttpStatus.Value.ToString(CultureInfo.InvariantCulture));
        lines.Add("Reason: " + ReasonCode);
        lines.Add("Code: " + SafeCode(Code));
        return string.Join(Environment.NewLine, lines);
    }

    public string Summary => "CreatorCrate could not prepare this release for manual publishing." +
        Environment.NewLine + Environment.NewLine + "Stage: " + StageLabel() +
        Environment.NewLine + "Code: " + SafeCode(Code);

    private string StageLabel() => Stage switch
    {
        ManualSocialDiagnosticStage.ActivationParsing => "Open publishing companion",
        ManualSocialDiagnosticStage.RedeemRequest => "Redeem request",
        ManualSocialDiagnosticStage.RedeemPreparation => "Redeem preparation",
        ManualSocialDiagnosticStage.CapabilityConstruction => "Capability construction",
        ManualSocialDiagnosticStage.MediaPreparation => "Media preparation",
        ManualSocialDiagnosticStage.CompanionPresentation => "Manual publishing window",
        _ => "Manual preparation",
    };

    private string ProblemLabel() => Reason switch
    {
        ManualSocialDiagnosticReason.InvalidActivationUri => "The publishing-companion activation link is invalid.",
        ManualSocialDiagnosticReason.InvalidActivationShape => "The publishing-companion activation link has an invalid shape.",
        ManualSocialDiagnosticReason.MissingActivationParameter => "The activation link is missing a required parameter.",
        ManualSocialDiagnosticReason.DuplicateActivationParameter => "The activation link repeats a parameter.",
        ManualSocialDiagnosticReason.UnsupportedActivationParameter => "The activation link contains an unsupported parameter.",
        ManualSocialDiagnosticReason.InvalidActivationVersion => "The activation link has an invalid version.",
        ManualSocialDiagnosticReason.InvalidServerOrigin => "The activation link has an invalid server origin.",
        ManualSocialDiagnosticReason.InvalidIntent => "The activation link has an invalid intent.",
        ManualSocialDiagnosticReason.MalformedJson => "The server response is malformed JSON.",
        ManualSocialDiagnosticReason.RootNotObject => "The server response root is not an object.",
        ManualSocialDiagnosticReason.UnexpectedProperty => "The response contains an unsupported property.",
        ManualSocialDiagnosticReason.MissingRequiredProperty => "The response is missing a required property.",
        ManualSocialDiagnosticReason.InvalidSuccessIndicator => "The response has an invalid success indicator.",
        ManualSocialDiagnosticReason.InvalidSessionId => "The response has an invalid session identifier.",
        ManualSocialDiagnosticReason.InvalidReleaseId => "The response has an invalid release identifier.",
        ManualSocialDiagnosticReason.InvalidDeadline => "The response has an invalid preparation deadline.",
        ManualSocialDiagnosticReason.InvalidPlatformCollection => "The response has an invalid platform collection.",
        ManualSocialDiagnosticReason.InvalidPlatform => AtPlatform("has an invalid platform."),
        ManualSocialDiagnosticReason.DuplicatePlatform => AtPlatform("duplicates an earlier platform."),
        ManualSocialDiagnosticReason.InvalidTitle => AtPlatform("has an invalid title."),
        ManualSocialDiagnosticReason.InvalidBody => AtPlatform("has an invalid post body."),
        ManualSocialDiagnosticReason.InvalidAssetCollection => AtPlatform("has an invalid asset collection."),
        ManualSocialDiagnosticReason.InvalidAssetId => AtAsset("has an invalid identifier."),
        ManualSocialDiagnosticReason.InvalidAssetRole => AtAsset("has an invalid role."),
        ManualSocialDiagnosticReason.InvalidAssetOrder => AtAsset("has an invalid order."),
        ManualSocialDiagnosticReason.InvalidAssetFilename => AtAsset("has an invalid filename."),
        ManualSocialDiagnosticReason.InvalidAssetExtension => AtAsset("has an invalid extension."),
        ManualSocialDiagnosticReason.FilenameExtensionMismatch => AtAsset("has an extension that does not match its filename."),
        ManualSocialDiagnosticReason.InvalidMimeType => AtAsset("has an invalid MIME type."),
        ManualSocialDiagnosticReason.InvalidAssetSize => AtAsset("has an invalid size."),
        ManualSocialDiagnosticReason.InvalidRelativePath => AtAsset("has an invalid relative path."),
        ManualSocialDiagnosticReason.InvalidPresence => AtAsset("has an invalid presence flag."),
        ManualSocialDiagnosticReason.DuplicateAsset => AtAsset("duplicates an earlier asset."),
        ManualSocialDiagnosticReason.InvalidWindowsPath => AtAsset("has an invalid Windows path value."),
        ManualSocialDiagnosticReason.InvalidMediaToken => "The response has an invalid media capability.",
        ManualSocialDiagnosticReason.RequestNotSent => "The redeem request could not be sent.",
        ManualSocialDiagnosticReason.TlsTransportFailure => "The secure connection could not be validated.",
        ManualSocialDiagnosticReason.RedirectRejected => "The redeem endpoint returned a redirect, which was rejected.",
        ManualSocialDiagnosticReason.HttpNonSuccess => "The redeem endpoint returned a non-success response.",
        ManualSocialDiagnosticReason.ResponseTooLarge => "The redeem response exceeded the safe size limit.",
        ManualSocialDiagnosticReason.CapabilityConstructionFailed => "The redeemed media capability could not be constructed.",
        ManualSocialDiagnosticReason.CompanionUnavailable => "The manual publishing window could not be opened.",
        _ => "Manual preparation failed.",
    };

    private string? ExpectedLabel() => Reason switch
    {
        ManualSocialDiagnosticReason.InvalidAssetExtension => "A safe file extension of 1 to 16 letters or digits.",
        ManualSocialDiagnosticReason.FilenameExtensionMismatch => "A safe file extension matching the asset filename.",
        ManualSocialDiagnosticReason.InvalidMediaToken => "A valid bounded media capability token.",
        ManualSocialDiagnosticReason.ResponseTooLarge => "A redeem response no larger than 8 MiB.",
        _ => null,
    };

    private string AtPlatform(string text) => PlatformOrdinal is > 0 ? $"Platform {PlatformOrdinal.Value} {text}" : "A platform " + text;
    private string AtAsset(string text) => AssetOrdinal is > 0 ? $"Asset {AssetOrdinal.Value} {text}" : "An asset " + text;

    internal static string SafeCode(string? code) =>
        code is not null && SafeCodes.Contains(code) ? code : "manual_preparation_failed";
}
