using System.Text.Json;
using OpenLocally;

namespace OpenLocally.Tests;

/// <summary>Shared harmless diagnostic social request data for non-production gate checks.</summary>
internal static class DiagnosticSocialRequest
{
    internal const string EnvironmentVariable = "CREATORCRATE_M2_DIAGNOSTIC_SOCIAL_URI";
    private const string DefinitionFileName = "diagnostic-social-request.json";
    private static readonly Definition Shared = Load();

    internal static string Intent => Shared.Intent;

    internal static string CreateProductionGateUri() => CreateUri(new Uri(Shared.Origin, UriKind.Absolute));

    internal static string CreateUri(Uri origin)
    {
        ArgumentNullException.ThrowIfNull(origin);
        return $"{Shared.Scheme}://{Shared.Action}?v={Shared.Version}&server={Uri.EscapeDataString(origin.AbsoluteUri)}&intent={Shared.Intent}";
    }

    internal static string RequireFromEnvironment() => RequireExactValue(Environment.GetEnvironmentVariable(EnvironmentVariable));

    internal static string RequireExactValue(string? value)
    {
        string expected = CreateProductionGateUri();
        if (!string.Equals(value, expected, StringComparison.Ordinal))
            throw new InvalidOperationException($"The Manual testhost must receive the exact {EnvironmentVariable} value from the parent wrapper.");
        return expected;
    }

    private static Definition Load()
    {
        string path = Path.Combine(AppContext.BaseDirectory, DefinitionFileName);
        try
        {
            Definition definition = JsonSerializer.Deserialize<Definition>(File.ReadAllText(path))
                ?? throw new InvalidOperationException("The diagnostic social request definition is empty.");
            if (definition.Scheme != SocialUriRequestParser.Scheme ||
                definition.Action != SocialUriRequestParser.Host ||
                definition.Version != SocialUriRequestParser.Version ||
                !Uri.TryCreate(definition.Origin, UriKind.Absolute, out Uri? origin) ||
                origin.Scheme != Uri.UriSchemeHttp ||
                origin.UserInfo.Length != 0 ||
                origin.AbsolutePath != "/" ||
                origin.Query.Length != 0 ||
                origin.Fragment.Length != 0 ||
                definition.Intent.Length != 43 ||
                definition.Intent.Any(character => !char.IsAsciiLetterOrDigit(character) && character is not '_' and not '-'))
            {
                throw new InvalidOperationException("The diagnostic social request definition does not satisfy the frozen social URI envelope.");
            }
            return definition;
        }
        catch (Exception error) when (error is IOException or JsonException or InvalidOperationException)
        {
            throw new InvalidOperationException("The shared diagnostic social request definition is unavailable or invalid.", error);
        }
    }

    private sealed record Definition(string Scheme, string Action, string Version, string Origin, string Intent);
}
