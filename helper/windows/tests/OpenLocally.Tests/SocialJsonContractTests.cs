using System.Text;
using OpenLocally;

namespace OpenLocally.Tests;

public class SocialJsonContractTests
{
    [Fact]
    public void ValidMultiPlatformResponse_PreservesOrdering()
    {
        Assert.True(SocialRedeemClient.TryParseResponse(Encoding.UTF8.GetBytes(Valid), out SocialRedeemResponse? result));
        Assert.Equal(new[] { "patreon", "x" }, result!.Platforms.Select(p => p.Platform));
        Assert.Equal(new long[] { 2, 1 }, result.Platforms[0].Assets.Select(a => a.AssetId));
        Assert.Equal("Server body", result.Platforms[0].Body);
        Assert.Equal(42, result.ReleaseId);
    }

    [Theory]
    [InlineData("{\"ok\":true,\"ok\":true}")]
    [InlineData("{\"ok\":true,\"unknown\":1}")]
    [InlineData("{\"ok\":false,\"sessionId\":\"session\",\"attemptDeadlineAt\":\"2026-01-01 12:00:00\",\"platforms\":[],\"mediaToken\":\"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\"}")]
    public void InvalidOrDuplicateMembers_AreRejected(string json) =>
        Assert.False(SocialRedeemClient.TryParseResponse(Encoding.UTF8.GetBytes(json), out _));

    [Fact]
    public void EmptyPatreonBody_IsAcceptedAndPreserved()
    {
        string json = Valid.Replace("\"body\":\"Server body\"", "\"body\":\"\"", StringComparison.Ordinal);

        Assert.True(SocialRedeemClient.TryParseResponse(Encoding.UTF8.GetBytes(json), out SocialRedeemResponse? result));
        Assert.Equal(string.Empty, result!.Platforms.Single(platform => platform.Platform == "patreon").Body);
    }

    [Fact]
    public void MissingPlatformBody_IsRejected()
    {
        string json = Valid.Replace(",\"body\":\"Server body\"", string.Empty, StringComparison.Ordinal);

        Assert.False(SocialRedeemClient.TryParseResponse(Encoding.UTF8.GetBytes(json), out _));
    }

    [Theory]
    [InlineData("null")]
    [InlineData("1")]
    [InlineData("{}")]
    [InlineData("[]")]
    public void NonStringPlatformBody_IsRejected(string body)
    {
        string json = Valid.Replace("\"body\":\"Server body\"", $"\"body\":{body}", StringComparison.Ordinal);

        Assert.False(SocialRedeemClient.TryParseResponse(Encoding.UTF8.GetBytes(json), out _));
    }

    [Fact]
    public void PlatformBody_PreservesWhitespaceAndNewlinesExactly()
    {
        string json = Valid.Replace("\"body\":\"Server body\"", "\"body\":\"  first line\\nsecond line  \"", StringComparison.Ordinal);

        Assert.True(SocialRedeemClient.TryParseResponse(Encoding.UTF8.GetBytes(json), out SocialRedeemResponse? result));
        Assert.Equal("  first line\nsecond line  ", result!.Platforms.Single(platform => platform.Platform == "patreon").Body);
    }

    private const string Valid = "{\"ok\":true,\"sessionId\":\"00000000-0000-0000-0000-000000000001\",\"releaseId\":42,\"attemptDeadlineAt\":\"2026-01-01 12:00:00\",\"platforms\":[{\"platform\":\"patreon\",\"title\":\"Server title\",\"body\":\"Server body\",\"assets\":[{\"assetId\":2,\"role\":\"primary\",\"sortOrder\":0,\"filename\":\"b.png\",\"extension\":\".png\",\"mimeType\":\"image/png\",\"sizeBytes\":2,\"relativePath\":\"final/b.png\",\"isPresent\":1,\"windowsPath\":null},{\"assetId\":1,\"role\":\"attachment\",\"sortOrder\":1,\"filename\":\"a.png\",\"extension\":\".png\",\"mimeType\":\"image/png\",\"sizeBytes\":1,\"relativePath\":\"final/a.png\",\"isPresent\":0,\"windowsPath\":\"D:\\\\a.png\"}]},{\"platform\":\"x\",\"title\":\"X\",\"body\":\"X body\",\"assets\":[]}],\"mediaToken\":\"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\"}";
}
