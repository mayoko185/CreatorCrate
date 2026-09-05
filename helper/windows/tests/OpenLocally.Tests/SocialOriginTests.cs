using System.Net;
using OpenLocally;

namespace OpenLocally.Tests;

public class SocialOriginTests
{
    [Theory]
    [InlineData("HTTPS://CreatorCrate.test:443", "https://creatorcrate.test")]
    [InlineData("http://creatorcrate.test:8080", "http://creatorcrate.test:8080")]
    [InlineData("https://bücher.example", "https://xn--bcher-kva.example")]
    [InlineData("http://[::1]", "http://[::1]")]
    public void TryParse_NormalizesExactOrigin(string input, string expected)
    {
        Assert.True(SocialOrigin.TryParse(input, out SocialOrigin? origin));
        Assert.Equal(expected, origin!.Identity);
    }

    [Theory]
    [InlineData("https://user:pass@creatorcrate.test")]
    [InlineData("https://creatorcrate.test/path")]
    [InlineData("https://creatorcrate.test/?q=1")]
    [InlineData("https://creatorcrate.test/#fragment")]
    [InlineData("ftp://creatorcrate.test")]
    public void TryParse_RejectsNonOrigin(string input) =>
        Assert.False(SocialOrigin.TryParse(input, out _));

    [Fact]
    public void DifferentSchemeHostOrPort_HaveDistinctIdentity()
    {
        SocialOrigin.TryParse("https://creatorcrate.test", out SocialOrigin? https);
        SocialOrigin.TryParse("http://creatorcrate.test", out SocialOrigin? http);
        SocialOrigin.TryParse("https://creatorcrate.test:8443", out SocialOrigin? port);
        Assert.NotEqual(https!.Identity, http!.Identity);
        Assert.NotEqual(https.Identity, port!.Identity);
    }

    [Theory]
    [InlineData("127.0.0.1", true)]
    [InlineData("10.1.2.3", true)]
    [InlineData("172.16.1.1", true)]
    [InlineData("192.168.1.1", true)]
    [InlineData("8.8.8.8", false)]
    [InlineData("169.254.1.1", false)]
    [InlineData("fc00::1", true)]
    [InlineData("fe80::1", false)]
    public void PlaintextAddressPolicy_IsStrict(string value, bool expected) =>
        Assert.Equal(expected, SocialTransportPolicy.IsPermittedPlaintextAddress(IPAddress.Parse(value)));
}
