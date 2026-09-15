using OpenLocally;

namespace OpenLocally.Tests;

public class SocialUriRequestParserTests
{
    private static readonly string Intent = new('a', 43);

    private static SocialUriParseResult Parse(string uri) => SocialUriRequestParser.Parse(uri);

    private static string BuildUri(string server = "https://creatorcrate.test", int version = 2) =>
        $"creatorcrate-social://prepare?v={version}&server={System.Uri.EscapeDataString(server)}&intent={Intent}";

    [Fact]
    public void Parse_ValidUri_ReturnsOriginAndOpaqueIntent()
    {
        SocialUriParseResult result = Parse(BuildUri("https://creatorcrate.test:8443"));

        Assert.True(result.Success);
        Assert.Equal(2, result.Request!.Version);
        Assert.Equal(new System.Uri("https://creatorcrate.test:8443/"), result.Request!.ServerOrigin);
        Assert.Equal(Intent, result.Request.Intent);
    }

    [Theory]
    [InlineData("creatorcrate-open://prepare?v=1&server=https%3A%2F%2Fcreatorcrate.test&intent=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")]
    [InlineData("creatorcrate-social://redeem?v=1&server=https%3A%2F%2Fcreatorcrate.test&intent=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")]
    [InlineData("creatorcrate-social://prepare/extra?v=1&server=https%3A%2F%2Fcreatorcrate.test&intent=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")]
    public void Parse_WrongSchemeOrAction_ReturnsFailure(string uri)
    {
        SocialUriParseResult result = Parse(uri);

        Assert.False(result.Success);
        Assert.Equal(SocialUriParseFailure.InvalidRequest, result.Failure);
        Assert.NotNull(result.Reason);
        Assert.Equal("social_uri_invalid", result.Error);
    }

    [Theory]
    [InlineData("server=https%3A%2F%2Fcreatorcrate.test&intent=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")]
    [InlineData("v=1&intent=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")]
    [InlineData("v=1&server=https%3A%2F%2Fcreatorcrate.test")]
    public void Parse_MissingRequiredParameter_ReturnsFailure(string query)
    {
        SocialUriParseResult result = Parse($"creatorcrate-social://prepare?{query}");

        Assert.False(result.Success);
        Assert.Equal(SocialUriParseFailureReason.MissingActivationParameter, result.Reason);
    }

    [Theory]
    [InlineData("v=1&v=1&server=https%3A%2F%2Fcreatorcrate.test&intent=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")]
    [InlineData("v=1&server=https%3A%2F%2Fcreatorcrate.test&server=https%3A%2F%2Fother.test&intent=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")]
    [InlineData("v=1&server=https%3A%2F%2Fcreatorcrate.test&intent=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa&intent=bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb")]
    [InlineData("v=1&server=https%3A%2F%2Fcreatorcrate.test&intent=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa&extra=1")]
    public void Parse_DuplicateOrUnknownParameter_ReturnsFailure(string query)
    {
        SocialUriParseResult result = Parse($"creatorcrate-social://prepare?{query}");

        Assert.False(result.Success);
        Assert.True(result.Reason is SocialUriParseFailureReason.DuplicateActivationParameter or
            SocialUriParseFailureReason.UnsupportedActivationParameter);
    }

    [Theory]
    [InlineData("https%3A%2F%2Fcreatorcrate.test%")]
    [InlineData("https%3A%2F%2Fcreatorcrate.test%FF")]
    public void Parse_MalformedPercentEncodingOrUtf8Origin_ReturnsFailure(string server)
    {
        SocialUriParseResult result = Parse($"creatorcrate-social://prepare?v=1&server={server}&intent={Intent}");

        Assert.False(result.Success);
        Assert.Equal(SocialUriParseFailureReason.InvalidServerOrigin, result.Reason);
    }

    [Theory]
    [InlineData("ftp://creatorcrate.test")]
    [InlineData("https://user:pass@creatorcrate.test")]
    [InlineData("https://creatorcrate.test/social")]
    [InlineData("https://creatorcrate.test?next=1")]
    [InlineData("https://creatorcrate.test#fragment")]
    [InlineData("not an origin")]
    public void Parse_InvalidServerOrigin_ReturnsFailure(string server)
    {
        SocialUriParseResult result = Parse(BuildUri(server));
        Assert.False(result.Success);
        Assert.Equal(SocialUriParseFailureReason.InvalidServerOrigin, result.Reason);
    }

    [Theory]
    [InlineData("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")]
    [InlineData("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")]
    [InlineData("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa!")]
    [InlineData("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa=")]
    public void Parse_MalformedIntent_ReturnsFailure(string intent)
    {
        SocialUriParseResult result = Parse($"creatorcrate-social://prepare?v=1&server=https%3A%2F%2Fcreatorcrate.test&intent={intent}");
        Assert.False(result.Success);
        Assert.Equal(SocialUriParseFailureReason.InvalidIntent, result.Reason);
    }

    [Fact]
    public void Parse_LegacyVersion_RemainsExplicitlyRecognized()
    {
        SocialUriParseResult result = Parse(BuildUri(version: 1));

        Assert.True(result.Success);
        Assert.Equal(1, result.Request!.Version);
    }

    [Theory]
    [InlineData("0")]
    [InlineData("3")]
    [InlineData("999")]
    [InlineData("future")]
    [InlineData("02")]
    public void Parse_UnsupportedVersion_ReturnsStableUpdateRequiredCode(string version)
    {
        SocialUriParseResult result = Parse(
            $"creatorcrate-social://prepare?v={version}&server=https%3A%2F%2Fcreatorcrate.test&intent={Intent}");

        Assert.False(result.Success);
        Assert.Equal(SocialUriParseFailure.HelperUpdateRequired, result.Failure);
        Assert.Equal(SocialUriParseFailureReason.InvalidActivationVersion, result.Reason);
        Assert.Equal("helper_update_required", result.Error);
    }
}
