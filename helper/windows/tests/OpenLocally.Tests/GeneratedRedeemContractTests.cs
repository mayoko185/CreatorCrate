using OpenLocally;

namespace OpenLocally.Tests;

public class GeneratedRedeemContractTests
{
    [Fact]
    public void CurrentServerRedeemResponse_IsConsumedByHelperParser()
    {
        string? fixturePath = Environment.GetEnvironmentVariable("CREATORCRATE_REDEEM_CONTRACT_FIXTURE");
        if (fixturePath is null) return; // Exercised by the JS HTTP contract harness that supplies the exact response bytes.
        byte[] serializedResponse = File.ReadAllBytes(fixturePath);

        Assert.True(SocialRedeemClient.TryParseResponse(serializedResponse, out SocialRedeemResponse? response));
        Assert.Equal(new[] { "bluesky", "patreon", "x" }, response!.Platforms.Select(platform => platform.Platform));
        Assert.All(response.Platforms.SelectMany(platform => platform.Assets), asset => Assert.Equal(".png", asset.Extension));
    }
}
