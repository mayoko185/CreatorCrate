using OpenLocally;
using Xunit.Abstractions;

namespace OpenLocally.Tests.Manual;

/// <summary>Explicit operator smoke for consent UX only: it never creates a CDP target.</summary>
[Trait("Category", "Manual")]
public sealed class ManualChromeConnectionConsentTests(ITestOutputHelper output)
{
    [Fact]
    public async Task ConnectsOnlyAfterReadinessConfirmationAndCleansUpTheSingleSocket()
    {
        ManualFoundationGuard.RequireOptIn();
        var connection = new ChromeConnection();
        var consent = new NativeChromeConnectionConsent();
        var workflow = new ChromeConnectionWorkflow(
            new ChromeDiscovery(),
            connection,
            consent);

        try
        {
            ChromeConnectionResult result = await workflow.ConnectAsync(CancellationToken.None);

            Assert.True(result.Success, $"Chrome connection-only smoke failed: {result.ErrorCode}; native diagnostic: {consent.LastNativeDiagnostic}");
            Assert.NotNull(connection.Socket);
        }
        finally
        {
            await connection.DisposeAsync();
        }

        WebSocketCloseOutcome close = Assert.IsType<WebSocketCloseOutcome>(connection.CloseOutcome);
        output.WriteLine(close.Kind == WebSocketCloseOutcomeKind.GracefulClosed
            ? "WEBSOCKET CLOSE: GRACEFUL — peer close observed, final state Closed, no abort fallback"
            : $"WEBSOCKET CLOSE: FALLBACK — {close.FallbackReason}, abort used");
        output.WriteLine(
            $"state before={close.StateBefore}; attempted={close.GracefulCloseAttempted}; completed={close.CloseAsyncCompletedNormally}; " +
            $"elapsed={close.Elapsed.TotalMilliseconds:F1}ms; final={close.FinalState}; peer status={close.PeerCloseStatus?.ToString() ?? "none"}; " +
            $"peer description present={close.PeerCloseDescriptionPresent}; fallback={close.FallbackReason}; " +
            $"abort={close.AbortCalled}; dispose={close.DisposeCalled}");
    }

    [Fact]
    public async Task DismissedChromeApproval_ShowsRetryBeforeTheNextSuccessfulConnection()
    {
        ManualFoundationGuard.RequireOptIn();
        await using var connection = new ChromeConnection();
        var consent = new RecordingNativeConsent();
        var workflow = new ChromeConnectionWorkflow(new ChromeDiscovery(), connection, consent);

        ChromeConnectionResult result = await workflow.ConnectAsync(CancellationToken.None);

        Assert.True(result.Success, $"Chrome recovery smoke failed: {result.ErrorCode}");
        Assert.True(consent.RetryCalls > 0, "Dismiss the first Chrome approval prompt, then choose Retry and approve the second prompt.");
        Assert.NotNull(connection.Socket);
    }

    private sealed class RecordingNativeConsent : IChromeConnectionConsent
    {
        private readonly NativeChromeConnectionConsent _inner = new();
        public int RetryCalls { get; private set; }
        public ChromeConnectionConsentDecision ConfirmReady() => _inner.ConfirmReady();
        public ChromeConnectionConsentDecision ConfirmRetry(string errorCode)
        {
            RetryCalls++;
            return _inner.ConfirmRetry(errorCode);
        }
    }
}
