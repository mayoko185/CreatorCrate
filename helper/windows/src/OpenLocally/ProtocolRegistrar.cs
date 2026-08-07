using System.Security;

namespace OpenLocally;

/// <summary>
/// Outcome of registering or unregistering the custom protocol. Registry
/// failures yield a failure result with an error message instead of an
/// exception.
/// </summary>
public sealed record ProtocolRegistrationResult(bool Success, string? Error)
{
    public static ProtocolRegistrationResult Ok() => new(true, null);

    public static ProtocolRegistrationResult Fail(string error) => new(false, error);
}

/// <summary>
/// Registers and unregisters the "creatorcrate-open://" custom protocol in
/// HKCU\Software\Classes so the current user's shell can launch the helper
/// without administrator privileges.
///
/// Registry structure:
///   creatorcrate-open
///     (Default) = URL:CreatorCrate Open Locally
///     URL Protocol = ""
///     shell
///       open
///         command
///           (Default) = "&lt;exe path&gt;" "%1"
///
/// Pure registration: no installer, no Start menu shortcuts, no config UI,
/// and no automatic registration on launch.
/// </summary>
public sealed class ProtocolRegistrar
{
    public const string Scheme = "creatorcrate-open";

    public const string RootKeyPath = @"Software\Classes\creatorcrate-open";

    public const string Description = "URL:CreatorCrate Open Locally";

    public const string UrlProtocolValueName = "URL Protocol";

    private const string ShellKeyPath = RootKeyPath + @"\shell";

    private const string OpenKeyPath = ShellKeyPath + @"\open";

    private const string CommandKeyPath = OpenKeyPath + @"\command";

    private readonly IRegistry _registry;

    public ProtocolRegistrar()
        : this(new WindowsRegistry())
    {
    }

    internal ProtocolRegistrar(IRegistry registry)
    {
        _registry = registry;
    }

    /// <summary>
    /// Register the custom protocol for the given executable. The command
    /// value quotes both the executable path and the "%1" argument so paths
    /// with spaces are passed as single arguments.
    /// </summary>
    /// <param name="executablePath">Absolute path of the helper executable.</param>
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
            return ProtocolRegistrationResult.Fail($"Protocol registration failed: {ex.Message}");
        }
    }

    /// <summary>
    /// Remove the entire protocol registration tree. A missing registration
    /// is not an error.
    /// </summary>
    public ProtocolRegistrationResult Unregister()
    {
        try
        {
            _registry.DeleteTree(RootKeyPath);
            return ProtocolRegistrationResult.Ok();
        }
        catch (Exception ex) when (ex is UnauthorizedAccessException or IOException or SecurityException or PlatformNotSupportedException)
        {
            return ProtocolRegistrationResult.Fail($"Protocol unregistration failed: {ex.Message}");
        }
    }
}
