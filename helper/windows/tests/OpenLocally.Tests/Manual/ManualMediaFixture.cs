using OpenLocally;

namespace OpenLocally.Tests.Manual;

internal sealed record ManualMediaFixture(
    SocialCapability Capability,
    SocialRedeemAsset ApprovedAsset,
    SocialRedeemAsset FallbackAsset,
    string SourcePath,
    string RejectedCandidatePath,
    byte[] MediaBytes)
{
    internal static ManualMediaFixture Create(string root, byte[] mediaBytes)
    {
        string project = Path.Combine(root, "project");
        string source = Path.Combine(project, "media", "approved.bin");
        Directory.CreateDirectory(Path.GetDirectoryName(source)!);
        File.WriteAllBytes(source, mediaBytes);

        string rejectedCandidate = Path.Combine(root, "outside.bin");
        File.WriteAllBytes(rejectedCandidate, mediaBytes);

        return new ManualMediaFixture(
            new SocialCapability(ManualCreatorCrateFixture.SessionId, ManualCreatorCrateFixture.MediaToken),
            new SocialRedeemAsset(1, "attachment", 0, "approved.bin", ".bin", "application/octet-stream", mediaBytes.Length, "media/approved.bin", true, source),
            new SocialRedeemAsset(2, "attachment", 1, "outside.bin", ".bin", "application/octet-stream", mediaBytes.Length, "media/outside.bin", true, rejectedCandidate),
            source,
            rejectedCandidate,
            mediaBytes);
    }
}
