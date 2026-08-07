using OpenLocally;

namespace OpenLocally.Tests;

/// <summary>
/// In-memory registry used by the tests. Mirrors the HKCU\Software\Classes
/// tree shape; no real registry is ever touched.
/// </summary>
internal sealed class InMemoryRegistry : IRegistry
{
    private readonly Dictionary<string, Dictionary<string, string>> _keys = new(StringComparer.OrdinalIgnoreCase);

    public IReadOnlyDictionary<string, Dictionary<string, string>> Keys => _keys;

    public void CreateKey(string keyPath)
    {
        if (!_keys.ContainsKey(keyPath))
        {
            _keys[keyPath] = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        }
    }

    public void SetValue(string keyPath, string? valueName, string value)
    {
        CreateKey(keyPath);
        _keys[keyPath][valueName ?? string.Empty] = value;
    }

    public void DeleteTree(string keyPath)
    {
        foreach (string existing in _keys.Keys.Where(k => k.Equals(keyPath, StringComparison.OrdinalIgnoreCase) || k.StartsWith(keyPath + "\\", StringComparison.OrdinalIgnoreCase)).ToList())
        {
            _keys.Remove(existing);
        }
    }
}

public class ProtocolRegistrarTests
{
    private const string RootKey = ProtocolRegistrar.RootKeyPath;

    private const string CommandKey = RootKey + @"\shell\open\command";

    private readonly InMemoryRegistry _registry = new();

    private readonly ProtocolRegistrar _registrar;

    public ProtocolRegistrarTests()
    {
        _registrar = new ProtocolRegistrar(_registry);
    }

    private static string DefaultValue(Dictionary<string, string> key) => key[string.Empty];

    // --- Register ---

    [Fact]
    public void Register_CreatesExpectedKeysAndValues()
    {
        ProtocolRegistrationResult result = _registrar.Register(@"C:\Tools\OpenLocally.exe");

        Assert.True(result.Success);
        Assert.Null(result.Error);
        Assert.Equal(ProtocolRegistrar.Description, DefaultValue(_registry.Keys[RootKey]));
        Assert.Equal(string.Empty, _registry.Keys[RootKey][ProtocolRegistrar.UrlProtocolValueName]);
        Assert.True(_registry.Keys.ContainsKey(RootKey + @"\shell"));
        Assert.True(_registry.Keys.ContainsKey(RootKey + @"\shell\open"));
        Assert.True(_registry.Keys.ContainsKey(CommandKey));
    }

    [Fact]
    public void Register_CommandContainsQuotedExecutablePathAndArgument()
    {
        _registrar.Register(@"C:\Tools\OpenLocally.exe");

        Assert.Equal(@"""C:\Tools\OpenLocally.exe"" ""%1""", DefaultValue(_registry.Keys[CommandKey]));
    }

    [Fact]
    public void Register_ExecutablePathWithSpaces_IsQuotedAsSingleArgument()
    {
        _registrar.Register(@"C:\Program Files\CreatorCrate\Open Locally.exe");

        Assert.Equal(@"""C:\Program Files\CreatorCrate\Open Locally.exe"" ""%1""", DefaultValue(_registry.Keys[CommandKey]));
    }

    [Theory]
    [InlineData(null)]
    [InlineData("")]
    [InlineData("   ")]
    public void Register_InvalidExecutablePath_ReturnsFailureAndWritesNothing(string? path)
    {
        ProtocolRegistrationResult result = _registrar.Register(path);

        Assert.False(result.Success);
        Assert.NotNull(result.Error);
        Assert.Empty(_registry.Keys);
    }

    // --- Unregister ---

    [Fact]
    public void Unregister_RemovesTheEntireRegistrationTree()
    {
        _registrar.Register(@"C:\Tools\OpenLocally.exe");

        ProtocolRegistrationResult result = _registrar.Unregister();

        Assert.True(result.Success);
        Assert.Null(result.Error);
        Assert.Empty(_registry.Keys);
    }

    [Fact]
    public void Unregister_WhenNotRegistered_IsNotAnError()
    {
        ProtocolRegistrationResult result = _registrar.Unregister();

        Assert.True(result.Success);
        Assert.Null(result.Error);
    }

    [Fact]
    public void Unregister_RemovesOnlyTheProtocolTree()
    {
        _registry.SetValue(@"Software\Classes\other-protocol", null, "Other");
        _registrar.Register(@"C:\Tools\OpenLocally.exe");

        _registrar.Unregister();

        Assert.True(_registry.Keys.ContainsKey(@"Software\Classes\other-protocol"));
        Assert.DoesNotContain(_registry.Keys.Keys, k => k.StartsWith(RootKey, StringComparison.OrdinalIgnoreCase));
    }
}
