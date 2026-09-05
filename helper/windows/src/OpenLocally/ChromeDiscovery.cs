using System.Globalization;
using System.Text;
using System.Text.RegularExpressions;

namespace OpenLocally;

public interface IChromeDiscoveryFile
{
    string? Read(string path, int maximumCharacters);
}

public sealed class ChromeDiscoveryFile : IChromeDiscoveryFile
{
    public string? Read(string path, int maximumCharacters)
    {
        try
        {
            using var stream = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite);
            var bytes = new byte[maximumCharacters + 1];
            int count = 0;

            while (count < bytes.Length)
            {
                int read = stream.Read(bytes, count, bytes.Length - count);
                if (read == 0)
                {
                    break;
                }

                count += read;
            }

            return count > maximumCharacters ? string.Empty : Encoding.UTF8.GetString(bytes, 0, count);
        }
        catch (Exception ex) when (ex is FileNotFoundException or DirectoryNotFoundException)
        {
            return null;
        }
        catch (IOException)
        {
            return null;
        }
    }
}

public sealed record ChromeEndpoint(Uri Uri)
{
    public int Port => Uri.Port;

    public string BrowserPath => Uri.AbsolutePath;
}

public sealed record ChromeDiscoveryResult(bool Success, string? ErrorCode, ChromeEndpoint? Endpoint)
{
    public static ChromeDiscoveryResult Ok(ChromeEndpoint endpoint) => new(true, null, endpoint);

    public static ChromeDiscoveryResult Fail(string errorCode) => new(false, errorCode, null);
}

/// <summary>
/// Re-reads Chrome's current DevToolsActivePort file for every discovery. The
/// browser-generated ID is intentionally neither retained nor reused here.
/// </summary>
public sealed partial class ChromeDiscovery
{
    internal const int MaximumDiscoveryCharacters = 4096;
    private const string BrowserPathPrefix = "/devtools/browser/";

    private readonly IChromeEnvironment _environment;
    private readonly IChromeDiscoveryFile _file;

    public ChromeDiscovery()
        : this(new ChromeEnvironment(), new ChromeDiscoveryFile())
    {
    }

    internal ChromeDiscovery(IChromeEnvironment environment, IChromeDiscoveryFile file)
    {
        _environment = environment;
        _file = file;
    }

    public ChromeDiscoveryResult Discover()
    {
        if (!_environment.IsStableChromeRunning())
        {
            return ChromeDiscoveryResult.Fail("chrome_not_running");
        }

        string? localAppData = _environment.GetLocalAppDataPath();
        if (string.IsNullOrWhiteSpace(localAppData))
        {
            return ChromeDiscoveryResult.Fail("chrome_discovery_missing");
        }

        string path = Path.Combine(localAppData, "Google", "Chrome", "User Data", "DevToolsActivePort");
        string? content = _file.Read(path, MaximumDiscoveryCharacters);
        return TryParse(content, out ChromeEndpoint? endpoint)
            ? ChromeDiscoveryResult.Ok(endpoint!)
            : ChromeDiscoveryResult.Fail(content is null ? "chrome_discovery_missing" : "chrome_discovery_malformed");
    }

    internal static bool TryParse(string? content, out ChromeEndpoint? endpoint)
    {
        endpoint = null;
        if (content is null || content.Length == 0 || content.Length > MaximumDiscoveryCharacters)
        {
            return false;
        }

        string[] lines = content.Split('\n');
        if (lines.Length is < 2 or > 3 || (lines.Length == 3 && lines[2].Length != 0))
        {
            return false;
        }

        string portText = TrimCarriageReturn(lines[0]);
        string browserPath = TrimCarriageReturn(lines[1]);
        if (portText.Length == 0 || browserPath.Length == 0 ||
            HasControlCharacter(portText) || HasControlCharacter(browserPath) ||
            !int.TryParse(portText, NumberStyles.None, CultureInfo.InvariantCulture, out int port) ||
            port is < 1 or > 65535 ||
            !BrowserPathPattern().IsMatch(browserPath))
        {
            return false;
        }

        endpoint = new ChromeEndpoint(new Uri($"ws://127.0.0.1:{port}{browserPath}", UriKind.Absolute));
        return true;
    }

    private static string TrimCarriageReturn(string value) =>
        value.EndsWith('\r') ? value[..^1] : value;

    private static bool HasControlCharacter(string value) =>
        value.Any(character => character < 0x20 || character == 0x7f);

    [GeneratedRegex("^/devtools/browser/[A-Za-z0-9_-]+$", RegexOptions.CultureInvariant)]
    private static partial Regex BrowserPathPattern();
}
