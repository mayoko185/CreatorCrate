using OpenLocally;

namespace OpenLocally.Tests;

public class SocialProtocolRegistrarTests
{
    private const string SocialRoot = SocialProtocolRegistrar.RootKeyPath;
    private const string OpenRoot = ProtocolRegistrar.RootKeyPath;
    private const string SocialCommand = SocialRoot + @"\shell\open\command";

    [Fact]
    public void Register_CreatesOnlySocialProtocolTree()
    {
        var registry = new InMemoryRegistry();
        var registrar = new SocialProtocolRegistrar(registry);

        ProtocolRegistrationResult result = registrar.Register(@"C:\Tools\OpenLocally.exe");

        Assert.True(result.Success);
        Assert.Equal(SocialProtocolRegistrar.Description, registry.Keys[SocialRoot][string.Empty]);
        Assert.Equal(string.Empty, registry.Keys[SocialRoot][SocialProtocolRegistrar.UrlProtocolValueName]);
        Assert.Equal(@"""C:\Tools\OpenLocally.exe"" ""%1""", registry.Keys[SocialCommand][string.Empty]);
        Assert.DoesNotContain(registry.Keys.Keys, key => key.StartsWith(OpenRoot, StringComparison.OrdinalIgnoreCase));
    }

    [Fact]
    public void Unregister_RemovesOnlySocialProtocolTree()
    {
        var registry = new InMemoryRegistry();
        var socialRegistrar = new SocialProtocolRegistrar(registry);
        var openRegistrar = new ProtocolRegistrar(registry);
        openRegistrar.Register(@"C:\Tools\OpenLocally.exe");
        socialRegistrar.Register(@"C:\Tools\OpenLocally.exe");

        ProtocolRegistrationResult result = socialRegistrar.Unregister();

        Assert.True(result.Success);
        Assert.DoesNotContain(registry.Keys.Keys, key => key.StartsWith(SocialRoot, StringComparison.OrdinalIgnoreCase));
        Assert.Contains(OpenRoot, registry.Keys.Keys);
    }

    [Theory]
    [InlineData(null)]
    [InlineData("")]
    public void Register_InvalidExecutablePath_WritesNothing(string? executablePath)
    {
        var registry = new InMemoryRegistry();
        var registrar = new SocialProtocolRegistrar(registry);

        ProtocolRegistrationResult result = registrar.Register(executablePath);

        Assert.False(result.Success);
        Assert.Empty(registry.Keys);
    }
}
