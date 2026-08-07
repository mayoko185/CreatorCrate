namespace OpenLocally;

/// <summary>
/// Outcome of running an "Open locally" request end to end. Every expected
/// user error (bad URI, invalid path, launcher failure) yields a failure
/// result with an error message instead of an exception.
/// </summary>
public sealed record OpenLocallyResult(bool Success, string? Error)
{
    public static OpenLocallyResult Ok() => new(true, null);

    public static OpenLocallyResult Fail(string error) => new(false, error);
}

/// <summary>
/// Wires the "Open locally" pipeline together: parse the protocol URI,
/// validate the absolute Windows path supplied by CreatorCrate, and hand it
/// to the shell launcher.
///
/// The helper is a stateless protocol handler: it holds no configuration, no
/// mappings, and no knowledge of CreatorCrate's data layout. The path
/// resolver is injected as a delegate and the launcher as an interface so the
/// orchestration can be tested with fakes; the default constructor uses the
/// real components.
/// </summary>
public sealed class OpenLocallyOrchestrator
{
    private readonly Func<string?, PathValidationResult> _validatePath;
    private readonly IShellLauncher _launcher;

    public OpenLocallyOrchestrator(IShellLauncher launcher)
        : this(PathResolver.Validate, launcher)
    {
    }

    internal OpenLocallyOrchestrator(
        Func<string?, PathValidationResult> validatePath,
        IShellLauncher launcher)
    {
        _validatePath = validatePath;
        _launcher = launcher;
    }

    /// <summary>
    /// Run the full pipeline for one protocol URI. Never throws for expected
    /// user errors; returns a failure result with a message instead.
    /// </summary>
    /// <param name="uri">The creatorcrate-open:// protocol URI.</param>
    public OpenLocallyResult Run(string? uri)
    {
        UriParseResult parsed = UriRequestParser.Parse(uri);
        if (!parsed.Success)
        {
            return OpenLocallyResult.Fail(parsed.Error!);
        }

        PathValidationResult validationResult = _validatePath(parsed.Request!.Path);
        if (!validationResult.Success)
        {
            return OpenLocallyResult.Fail(validationResult.Error!);
        }

        try
        {
            _launcher.Open(validationResult.FullPath!, parsed.Request.Select);
        }
        catch (Exception ex) when (ex is ArgumentException or InvalidOperationException)
        {
            return OpenLocallyResult.Fail(ex.Message);
        }

        return OpenLocallyResult.Ok();
    }
}
