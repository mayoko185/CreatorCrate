namespace OpenLocally;

/// <summary>Small adapter-facing facade that keeps text editing browser-mediated.</summary>
public sealed class BrowserTextEditor
{
    private readonly BrowserPreparationSession _page;

    public BrowserTextEditor(BrowserPreparationSession page) => _page = page ?? throw new ArgumentNullException(nameof(page));

    public Task<BrowserDomNode?> FindAsync(string cssSelector, CancellationToken cancellationToken = default) =>
        _page.FindNodeAsync(cssSelector, cancellationToken);

    public Task ReplaceAsync(BrowserDomNode node, string text, CancellationToken cancellationToken = default) =>
        _page.ReplaceTextAsync(node, text, cancellationToken);

    public Task<BrowserTextVerification> VerifyAsync(BrowserDomNode node, string expected, CancellationToken cancellationToken = default) =>
        _page.VerifyTextAsync(node, expected, cancellationToken);

    internal Task<BrowserTextReadback> ReadAsync(BrowserDomNode node, CancellationToken cancellationToken = default) =>
        _page.ReadTextAsync(node, cancellationToken);
}
