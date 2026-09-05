using System.Security;

namespace OpenLocally;

/// <summary>
/// Registers only the creatorcrate-social URI scheme under HKCU. It shares
/// the existing executable and registry seam, but cannot alter creatorcrate-open.
/// </summary>
public sealed class SocialProtocolRegistrar
{
    public const string Scheme = "creatorcrate-social";
    public const string RootKeyPath = @"Software\Classes\creatorcrate-social";
    public const string Description = "URL:CreatorCrate Social Preparation";
    public const string UrlProtocolValueName = "URL Protocol";

    private const string ShellKeyPath = RootKeyPath + @"\shell";
    private const string OpenKeyPath = ShellKeyPath + @"\open";
    private const string CommandKeyPath = OpenKeyPath + @"\command";

    private readonly IRegistry _registry;

    public SocialProtocolRegistrar()
        : this(new WindowsRegistry())
    {
    }

    internal SocialProtocolRegistrar(IRegistry registry)
    {
        _registry = registry;
    }

    public ProtocolRegistrationResult Register(string? executablePath)
    {
        if (string.IsNullOrWhiteSpace(executablePath))
        {
            return ProtocolRegistrationResult.Fail("Executable path must not be empty.");
        }

        try
        {
            _registry.CreateKey(RootKeyPath);
            _registry.SetValue(RootKeyPath, null, Description);
            _registry.SetValue(RootKeyPath, UrlProtocolValueName, string.Empty);
            _registry.CreateKey(ShellKeyPath);
            _registry.CreateKey(OpenKeyPath);
            _registry.CreateKey(CommandKeyPath);
            _registry.SetValue(CommandKeyPath, null, $"\"{executablePath}\" \"%1\"");
            return ProtocolRegistrationResult.Ok();
        }
        catch (Exception ex) when (ex is UnauthorizedAccessException or IOException or SecurityException or PlatformNotSupportedException)
        {
            return ProtocolRegistrationResult.Fail($"Social protocol registration failed: {ex.Message}");
        }
    }

    public ProtocolRegistrationResult Unregister()
    {
        try
        {
            _registry.DeleteTree(RootKeyPath);
            return ProtocolRegistrationResult.Ok();
        }
        catch (Exception ex) when (ex is UnauthorizedAccessException or IOException or SecurityException or PlatformNotSupportedException)
        {
            return ProtocolRegistrationResult.Fail($"Social protocol unregistration failed: {ex.Message}");
        }
    }
}
