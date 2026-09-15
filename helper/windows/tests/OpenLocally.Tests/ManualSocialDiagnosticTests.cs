using System.Text;
using OpenLocally;

namespace OpenLocally.Tests;

public class ManualSocialDiagnosticTests
{
    private const string Valid = "{\"ok\":true,\"sessionId\":\"00000000-0000-0000-0000-000000000001\",\"releaseId\":42,\"attemptDeadlineAt\":\"2026-01-01 12:00:00\",\"platforms\":[{\"platform\":\"patreon\",\"title\":\"Server title\",\"body\":\"Server body\",\"assets\":[{\"assetId\":2,\"role\":\"primary\",\"sortOrder\":0,\"filename\":\"b.png\",\"extension\":\"png\",\"mimeType\":\"image/png\",\"sizeBytes\":2,\"relativePath\":\"final/b.png\",\"isPresent\":1,\"windowsPath\":null},{\"assetId\":1,\"role\":\"attachment\",\"sortOrder\":1,\"filename\":\"a.png\",\"extension\":\".png\",\"mimeType\":\"image/png\",\"sizeBytes\":1,\"relativePath\":\"final/a.png\",\"isPresent\":0,\"windowsPath\":\"D:\\\\a.png\"}]}],\"mediaToken\":\"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\"}";

    public static TheoryData<string, string, ManualSocialDiagnosticReason> RepresentativeFailures => new()
    {
        { "{", string.Empty, ManualSocialDiagnosticReason.MalformedJson },
        { Valid, "\"releaseId\":42,|", ManualSocialDiagnosticReason.MissingRequiredProperty },
        { Valid, "\"00000000-0000-0000-0000-000000000001\"|\"invalid-session\"", ManualSocialDiagnosticReason.InvalidSessionId },
        { Valid, "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa|SECRET_BEARER_SENTINEL", ManualSocialDiagnosticReason.InvalidMediaToken },
        { Valid, "\"platform\":\"patreon\"|\"platform\":\"invalid\"", ManualSocialDiagnosticReason.InvalidPlatform },
        { Valid, "\"platform\":\"patreon\"|\"platform\":\"patreon\",\"duplicate\":true", ManualSocialDiagnosticReason.UnexpectedProperty },
        { Valid, "\"role\":\"primary\"|\"role\":\"invalid\"", ManualSocialDiagnosticReason.InvalidAssetRole },
        { Valid, "\"extension\":\"png\"|\"extension\":\"../SECRET_INTENT_SENTINEL\"", ManualSocialDiagnosticReason.InvalidAssetExtension },
        { Valid, "\"extension\":\"png\"|\"extension\":\"jpg\"", ManualSocialDiagnosticReason.FilenameExtensionMismatch },
        { Valid, "\"mimeType\":\"image/png\"|\"mimeType\":\"invalid\"", ManualSocialDiagnosticReason.InvalidMimeType },
        { Valid, "\"sizeBytes\":2|\"sizeBytes\":-1", ManualSocialDiagnosticReason.InvalidAssetSize },
        { Valid, "\"relativePath\":\"final/b.png\"|\"relativePath\":\"\"", ManualSocialDiagnosticReason.InvalidRelativePath },
        { Valid, "\"assetId\":1|\"assetId\":2", ManualSocialDiagnosticReason.DuplicateAsset },
    };

    [Theory]
    [MemberData(nameof(RepresentativeFailures))]
    public void Parser_ReturnsStableBoundedReason(string source, string replacement, ManualSocialDiagnosticReason expected)
    {
        string json = replacement.Length == 0 ? source : ReplacePair(source, replacement);

        Assert.False(SocialRedeemClient.TryParseResponse(
            Encoding.UTF8.GetBytes(json), out _, out ManualSocialDiagnostic? diagnostic));
        Assert.NotNull(diagnostic);
        Assert.Equal(expected, diagnostic.Reason);
        Assert.Equal("redeem_payload_invalid", diagnostic.Code);
        Assert.DoesNotContain("SECRET_", diagnostic.FormatForDisplay(), StringComparison.Ordinal);
    }

    [Fact]
    public void DuplicatePlatform_ReturnsStableReasonAndSafeOrdinal()
    {
        string second = "{\"platform\":\"patreon\",\"title\":\"Other\",\"body\":\"\",\"assets\":[]}";
        int insertion = Valid.LastIndexOf("],\"mediaToken\"", StringComparison.Ordinal);
        string json = Valid.Insert(insertion, "," + second);

        Assert.False(SocialRedeemClient.TryParseResponse(
            Encoding.UTF8.GetBytes(json), out _, out ManualSocialDiagnostic? diagnostic));
        Assert.Equal(ManualSocialDiagnosticReason.DuplicatePlatform, diagnostic!.Reason);
        Assert.Equal(2, diagnostic.PlatformOrdinal);
    }

    [Fact]
    public void InvalidExtensionPresentation_IsUsefulAndNeverReflectsRejectedValuesOrSecrets()
    {
        const string secretFilename = "SECRET_POST_BODY_SENTINEL.png";
        string json = Valid
            .Replace("\"filename\":\"b.png\"", $"\"filename\":\"{secretFilename}\"", StringComparison.Ordinal)
            .Replace("\"extension\":\"png\"", "\"extension\":\"jpg\"", StringComparison.Ordinal);

        Assert.False(SocialRedeemClient.TryParseResponse(
            Encoding.UTF8.GetBytes(json), out _, out ManualSocialDiagnostic? diagnostic));
        string report = diagnostic!.FormatForDisplay();

        Assert.Contains("Stage: Redeem preparation", report);
        Assert.Contains("Asset 1 has an extension that does not match its filename.", report);
        Assert.Contains("Asset: 1", report);
        Assert.Contains("Code: redeem_payload_invalid", report);
        Assert.DoesNotContain(secretFilename, report);
        Assert.DoesNotContain("jpg", report);
    }

    [Fact]
    public void UnknownProperty_IsNotReflected()
    {
        string json = Valid.Replace("{\"ok\":true", "{\"SECRET_INTENT_SENTINEL\":1,\"ok\":true", StringComparison.Ordinal);

        Assert.False(SocialRedeemClient.TryParseResponse(
            Encoding.UTF8.GetBytes(json), out _, out ManualSocialDiagnostic? diagnostic));

        Assert.Equal(ManualSocialDiagnosticReason.UnexpectedProperty, diagnostic!.Reason);
        Assert.DoesNotContain("SECRET_INTENT_SENTINEL", diagnostic.FormatForDisplay());
    }

    private static string ReplacePair(string source, string pair)
    {
        string[] parts = pair.Split('|', 2);
        return source.Replace(parts[0], parts[1], StringComparison.Ordinal);
    }
}
