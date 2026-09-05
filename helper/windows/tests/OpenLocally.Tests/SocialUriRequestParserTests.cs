using OpenLocally;

namespace OpenLocally.Tests;

public class SocialUriRequestParserTests
{
    private static readonly string Intent = new('a', 43);

    private static SocialUriParseResult Parse(string uri) => SocialUriRequestParser.Parse(uri);

    private static string BuildUri(string server = "https://creatorcrate.test") =>
        $"creatorcrate-social://prepare?v=1&server={System.Uri.EscapeDataString(server)}&intent={Intent}";

    [Fact]
    public void Parse_ValidUri_ReturnsOriginAndOpaqueIntent()
    {
        SocialUriParseResult result = Parse(BuildUri("https://creatorcrate.test:8443"));

        Assert.True(result.Success);
        Assert.Equal(new System.Uri("https://creatorcrate.test:8443/"), result.Request!.ServerOrigin);
        Assert.Equal(Intent, result.Request.Intent);
    }

    [Fact]
    public void Parse_SharedDiagnosticIntentMatchesTheFrozenTokenContract()
    {
        string expectedIntent = Convert.ToBase64String(new byte[32]).TrimEnd('=').Replace('+', '-').Replace('/', '_');
        string uri = DiagnosticSocialRequest.CreateProductionGateUri();
        SocialUriParseResult result = Parse(uri);

        Assert.Equal(expectedIntent, DiagnosticSocialRequest.Intent);
        Assert.True(result.Success);
        Assert.Equal(DiagnosticSocialRequest.Intent, result.Request!.Intent);
        Assert.Throws<InvalidOperationException>(() => DiagnosticSocialRequest.RequireExactValue(new string('a', 43)));
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
    }

    [Theory]
    [InlineData("server=https%3A%2F%2Fcreatorcrate.test&intent=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")]
    [InlineData("v=1&intent=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")]
    [InlineData("v=1&server=https%3A%2F%2Fcreatorcrate.test")]
    public void Parse_MissingRequiredParameter_ReturnsFailure(string query)
    {
        SocialUriParseResult result = Parse($"creatorcrate-social://prepare?{query}");

        Assert.False(result.Success);
    }

    [Theory]
    [InlineData("v=1&v=1&server=https%3A%2F%2Fcreatorcrate.test&intent=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")]
    [InlineData("v=1&server=https%3A%2F%2Fcreatorcrate.test&server=https%3A%2F%2Fother.test&intent=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")]
    [InlineData("v=1&server=https%3A%2F%2Fcreatorcrate.test&intent=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa&intent=bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb")]
    [InlineData("v=1&server=https%3A%2F%2Fcreatorcrate.test&intent=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa&extra=1")]
    public void Parse_DuplicateOrUnknownParameter_ReturnsFailure(string query)
    {
        Assert.False(Parse($"creatorcrate-social://prepare?{query}").Success);
    }

    [Theory]
    [InlineData("https%3A%2F%2Fcreatorcrate.test%")]
    [InlineData("https%3A%2F%2Fcreatorcrate.test%FF")]
    public void Parse_MalformedPercentEncodingOrUtf8Origin_ReturnsFailure(string server)
    {
        SocialUriParseResult result = Parse($"creatorcrate-social://prepare?v=1&server={server}&intent={Intent}");

        Assert.False(result.Success);
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
        Assert.False(Parse(BuildUri(server)).Success);
    }

    [Theory]
    [InlineData("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")]
    [InlineData("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")]
    [InlineData("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa!")]
    [InlineData("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa=")]
    public void Parse_MalformedIntent_ReturnsFailure(string intent)
    {
        Assert.False(Parse($"creatorcrate-social://prepare?v=1&server=https%3A%2F%2Fcreatorcrate.test&intent={intent}").Success);
    }

    [Fact]
    public void Parse_UnsupportedVersion_ReturnsStableUpdateRequiredCode()
    {
        SocialUriParseResult result = Parse(
            $"creatorcrate-social://prepare?v=2&server=https%3A%2F%2Fcreatorcrate.test&intent={Intent}");

        Assert.False(result.Success);
        Assert.Equal(SocialUriParseFailure.HelperUpdateRequired, result.Failure);
        Assert.Equal("helper_update_required", result.Error);
    }
}
