using OpenLocally;

namespace OpenLocally.Tests;

public class LocalMediaResolverTests : IDisposable
{
    private readonly string _root = Path.Combine(Path.GetTempPath(), "creatorcrate-local-media-" + Guid.NewGuid().ToString("N"));

    [Fact]
    public void ValidCandidate_UsesExactOriginRootApprovalAndDoesNotMutateSource()
    {
        string source = Path.Combine(_root, "project", "final", "a.png");
        Directory.CreateDirectory(Path.GetDirectoryName(source)!);
        File.WriteAllText(source, "abc");
        var store = new Store();
        var prompt = new Prompt(true);
        var resolver = new LocalMediaResolver(store, prompt);
        var asset = new SocialRedeemAsset(1, "attachment", 0, "a.png", ".png", "image/png", 3, "final/a.png", true, source);

        LocalMediaResolution first = resolver.Resolve(Origin("https://one.test"), asset);
        LocalMediaResolution again = resolver.Resolve(Origin("https://one.test"), asset);
        LocalMediaResolution otherOrigin = resolver.Resolve(Origin("https://two.test"), asset);

        Assert.True(first.Resolved);
        Assert.Equal(source, first.Path);
        Assert.Equal("abc", File.ReadAllText(source));
        Assert.Equal(2, prompt.Calls);
        Assert.True(again.Resolved);
        Assert.True(otherOrigin.Resolved);
    }

    [Fact]
    public void BadRelativePathOrSizeFallsBackWithoutPrompt()
    {
        string source = Path.Combine(_root, "project", "final", "a.png");
        Directory.CreateDirectory(Path.GetDirectoryName(source)!);
        File.WriteAllText(source, "abc");
        var prompt = new Prompt(true);
        var resolver = new LocalMediaResolver(new Store(), prompt);

        LocalMediaResolution result = resolver.Resolve(Origin("https://one.test"), new SocialRedeemAsset(1, "attachment", 0, "a.png", ".png", "image/png", 4, "../a.png", true, source));

        Assert.False(result.Resolved);
        Assert.Equal(0, prompt.Calls);
    }

    public void Dispose() { if (Directory.Exists(_root)) Directory.Delete(_root, true); }
    private static SocialOrigin Origin(string value) { Assert.True(SocialOrigin.TryParse(value, out SocialOrigin? origin)); return origin!; }
    private sealed class Store : ITrustedMediaRootStore
    {
        private readonly HashSet<string> _roots = new(StringComparer.OrdinalIgnoreCase);
        public bool IsTrusted(SocialOrigin origin, string root) => _roots.Contains(origin.Identity + "|" + root);
        public void Trust(SocialOrigin origin, string root) => _roots.Add(origin.Identity + "|" + root);
    }
    private sealed class Prompt(bool allowed) : ITrustedMediaRootPrompt { public int Calls { get; private set; } public bool ConfirmTrust(SocialOrigin origin, string root) { Calls++; return allowed; } }
}
