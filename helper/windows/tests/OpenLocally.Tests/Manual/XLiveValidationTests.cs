using OpenLocally;

namespace OpenLocally.Tests.Manual;

/// <summary>
/// Explicitly opt-in live validation of the production X preparation adapter.
/// It intentionally stops after the adapter has prepared and relinquished the composer.
/// </summary>
[Trait("Category", "Manual")]
public sealed class XLiveValidationTests
{
    [Fact]
    public async Task PrepareAsync_WithExplicitXOptIn_UsesProductionAdapter()
    {
        XLiveValidationReport? report = await XLiveValidationHarness.RunAsync(CancellationToken.None);
        if (report is null)
        {
            Console.WriteLine($"X live validation not run; set {XLiveValidationHarness.EnvironmentVariable}=1 to opt in.");
            return;
        }

        Console.WriteLine(report.FormatForConsole());
        Assert.Equal(PlatformPreparationOutcome.Prepared, report.Outcome);
    }

    [Fact]
    public async Task RunAsync_WhenGateIsAbsent_DoesNotInvokeLiveOperation()
    {
        int fileChecks = 0;
        int liveOperations = 0;

        XLiveValidationReport? report = await XLiveValidationHarness.RunAsync(
            _ => null,
            _ => { fileChecks++; return true; },
            (_, _) =>
            {
                liveOperations++;
                return Task.FromResult(new XLiveValidationReport(PlatformPreparationOutcome.Prepared, null, []));
            },
            CancellationToken.None);

        Assert.Null(report);
        Assert.Equal(0, fileChecks);
        Assert.Equal(0, liveOperations);
    }

    [Fact]
    public async Task RunAsync_WhenImagePathIsMissing_DoesNotInvokeLiveOperation()
    {
        int liveOperations = 0;

        await Assert.ThrowsAsync<InvalidOperationException>(() => XLiveValidationHarness.RunAsync(
            name => name == XLiveValidationHarness.EnvironmentVariable ? "1" : null,
            _ => false,
            (_, _) =>
            {
                liveOperations++;
                return Task.FromResult(new XLiveValidationReport(PlatformPreparationOutcome.Prepared, null, []));
            },
            CancellationToken.None));

        Assert.Equal(0, liveOperations);
    }

    [Fact]
    public void Harness_UsesTheProductionAdapterType()
    {
        Assert.Equal(typeof(XSocialPreparationAdapter), XLiveValidationHarness.ProductionAdapterType);
    }

    [Fact]
    public async Task RunProductionAsync_ReducesTransportFailureWithoutSensitiveDetailsOrRetry()
    {
        var socket = new CdpTestSocket();
        const string sensitive = "transport secret at C:\\top-secret\\x-live.png";
        int operations = 0;

        XLiveValidationReport report = await RunOfflineProductionAsync(socket, (_, _, _) =>
        {
            operations++;
            return Task.FromException<PlatformPreparationResult>(
                new CdpTransportException(CdpTransportFailure.Disconnected, new InvalidOperationException(sensitive)));
        });

        Assert.Equal(PlatformPreparationOutcome.Failed, report.Outcome);
        Assert.Equal("cdp_transport_failed", report.DetailCode);
        Assert.Equal(1, operations);
        AssertSafeReport(report, sensitive);
        AssertTeardown(socket);
    }

    [Fact]
    public async Task RunProductionAsync_ReducesUnexpectedFailureWithoutSensitiveDetailsOrRetry()
    {
        var socket = new CdpTestSocket();
        const string sensitive = "unexpected secret at C:\\top-secret\\x-live.png";
        int operations = 0;

        XLiveValidationReport report = await RunOfflineProductionAsync(socket, (_, _, _) =>
        {
            operations++;
            return Task.FromException<PlatformPreparationResult>(new InvalidOperationException(sensitive));
        });

        Assert.Equal(PlatformPreparationOutcome.Failed, report.Outcome);
        Assert.Equal("unexpected_failure", report.DetailCode);
        Assert.Equal(1, operations);
        AssertSafeReport(report, sensitive);
        AssertTeardown(socket);
    }

    [Fact]
    public async Task RunProductionAsync_PreservesRuntimeFailureCode()
    {
        var socket = new CdpTestSocket();
        int operations = 0;

        XLiveValidationReport report = await RunOfflineProductionAsync(socket, (_, _, _) =>
        {
            operations++;
            return Task.FromException<PlatformPreparationResult>(new SocialPreparationRuntimeException("x_home_timeout"));
        });

        Assert.Equal(PlatformPreparationOutcome.Failed, report.Outcome);
        Assert.Equal("x_home_timeout", report.DetailCode);
        Assert.Equal(1, operations);
        AssertTeardown(socket);
    }

    [Fact]
    public async Task RunProductionAsync_PropagatesCallerCancellationAndStillTearsDown()
    {
        var socket = new CdpTestSocket();
        using var cancellation = new CancellationTokenSource();
        int operations = 0;

        Task<XLiveValidationReport> run = RunOfflineProductionAsync(socket, (_, _, _) =>
        {
            operations++;
            cancellation.Cancel();
            return Task.FromCanceled<PlatformPreparationResult>(cancellation.Token);
        }, cancellation.Token);

        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => run);
        Assert.Equal(1, operations);
        AssertTeardown(socket);
    }

    [Fact]
    public async Task RunProductionAsync_StopsTransportBeforeClosingConnectionAndDisposesBothOnce()
    {
        var socket = new CdpTestSocket();
        socket.OnCloseAsync = _ =>
        {
            Assert.Equal(0, socket.ReceiveCancellations);
            socket.EnqueueClose();
            return Task.CompletedTask;
        };
        int operations = 0;

        XLiveValidationReport report = await RunOfflineProductionAsync(socket, async (_, _, _) =>
        {
            operations++;
            await socket.ReceiveStarted.WaitAsync(TimeSpan.FromSeconds(1));
            return PlatformPreparationResult.Prepared();
        });

        Assert.Equal(PlatformPreparationOutcome.Prepared, report.Outcome);
        Assert.Equal(1, operations);
        AssertTeardown(socket);
    }

    private static readonly ChromeEndpoint Endpoint = new(new Uri("ws://127.0.0.1:9222/devtools/browser/x-live-validation"));

    private static Task<XLiveValidationReport> RunOfflineProductionAsync(
        CdpTestSocket socket,
        Func<BrowserPreparationTargets, IPreparationProgress, CancellationToken, Task<PlatformPreparationResult>> prepare,
        CancellationToken cancellationToken = default)
    {
        socket.OnCloseAsync ??= _ =>
        {
            socket.EnqueueClose();
            return Task.CompletedTask;
        };
        var connection = new ChromeConnection(() => socket, TimeSpan.FromSeconds(1), TimeSpan.FromSeconds(1));
        return XLiveValidationHarness.RunProductionAsync(
            new XLiveValidationHarness.XLiveValidationInput("C:\\top-secret\\x-live.png"),
            connection,
            token => connection.ConnectAsync(Endpoint, token),
            async (targets, progress, token) =>
            {
                await socket.ReceiveStarted.WaitAsync(TimeSpan.FromSeconds(1));
                return await prepare(targets, progress, token);
            },
            cancellationToken);
    }

    private static void AssertSafeReport(XLiveValidationReport report, string sensitive)
    {
        string output = report.FormatForConsole();
        Assert.DoesNotContain(sensitive, output, StringComparison.Ordinal);
        Assert.DoesNotContain("C:\\top-secret", output, StringComparison.Ordinal);
        Assert.DoesNotContain(nameof(InvalidOperationException), output, StringComparison.Ordinal);
    }

    private static void AssertTeardown(CdpTestSocket socket)
    {
        Assert.Equal(1, socket.CloseCalls);
        Assert.Equal(1, socket.DisposeCalls);
        Assert.Equal(0, socket.ReceiveCancellations);
    }
}

internal static class XLiveValidationHarness
{
    internal const string EnvironmentVariable = "CREATORCRATE_RUN_X_LIVE_VALIDATION";
    internal const string ImagePathEnvironmentVariable = "CREATORCRATE_X_LIVE_IMAGE";
    internal const string ExactBody = "CreatorCrate X final validation\n\nUnicode check ✓";

    internal static Type ProductionAdapterType => typeof(XSocialPreparationAdapter);

    internal static Task<XLiveValidationReport?> RunAsync(CancellationToken cancellationToken) =>
        RunAsync(Environment.GetEnvironmentVariable, File.Exists, RunProductionAsync, cancellationToken);

    internal static async Task<XLiveValidationReport?> RunAsync(
        Func<string, string?> getEnvironmentVariable,
        Func<string, bool> fileExists,
        Func<XLiveValidationInput, CancellationToken, Task<XLiveValidationReport>> runProduction,
        CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(getEnvironmentVariable);
        ArgumentNullException.ThrowIfNull(fileExists);
        ArgumentNullException.ThrowIfNull(runProduction);

        XLiveValidationInput? input = ReadInput(getEnvironmentVariable, fileExists);
        return input is null ? null : await runProduction(input, cancellationToken).ConfigureAwait(false);
    }

    private static XLiveValidationInput? ReadInput(Func<string, string?> getEnvironmentVariable, Func<string, bool> fileExists)
    {
        if (!string.Equals(getEnvironmentVariable(EnvironmentVariable), "1", StringComparison.Ordinal)) return null;

        string? imagePath = getEnvironmentVariable(ImagePathEnvironmentVariable);
        if (string.IsNullOrWhiteSpace(imagePath) || !fileExists(imagePath))
            throw new InvalidOperationException($"Set {ImagePathEnvironmentVariable} to an existing harmless local image before starting X live validation.");

        return new XLiveValidationInput(imagePath);
    }

    private static async Task<XLiveValidationReport> RunProductionAsync(XLiveValidationInput input, CancellationToken cancellationToken)
    {
        var connection = new ChromeConnection();
        var workflow = new ChromeConnectionWorkflow(
            new ChromeDiscovery(),
            connection,
            new NativeChromeConnectionConsent());

        return await RunProductionAsync(
            input,
            connection,
            workflow.ConnectAsync,
            async (targets, progress, token) =>
            {
                var adapter = new XSocialPreparationAdapter();
                var context = new PlatformPreparationContext(
                    adapter.Platform,
                    "CreatorCrate X final validation",
                    ExactBody,
                    [input.ImagePath],
                    targets);
                return await adapter.PrepareAsync(context, progress, token).ConfigureAwait(false);
            },
            cancellationToken).ConfigureAwait(false);
    }

    internal static async Task<XLiveValidationReport> RunProductionAsync(
        XLiveValidationInput input,
        ChromeConnection connection,
        Func<CancellationToken, Task<ChromeConnectionResult>> connect,
        Func<BrowserPreparationTargets, IPreparationProgress, CancellationToken, Task<PlatformPreparationResult>> prepare,
        CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(input);
        ArgumentNullException.ThrowIfNull(connection);
        ArgumentNullException.ThrowIfNull(connect);
        ArgumentNullException.ThrowIfNull(prepare);

        CdpTransport? transport = null;
        var progress = new RecordingProgress();
        try
        {
            ChromeConnectionResult connected = await connect(cancellationToken).ConfigureAwait(false);
            if (!connected.Success) return new XLiveValidationReport(PlatformPreparationOutcome.Failed, connected.ErrorCode, []);
            if (connection.Socket is null) return new XLiveValidationReport(PlatformPreparationOutcome.Failed, "chrome_handshake_failed", []);

            transport = new CdpTransport(connection.Socket);
            var targets = new BrowserPreparationTargets(new CdpTargetManager(transport));
            PlatformPreparationResult result = await prepare(targets, progress, cancellationToken).ConfigureAwait(false);
            return new XLiveValidationReport(result.Outcome, null, progress.Values);
        }
        catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
        {
            throw;
        }
        catch (SocialPreparationRuntimeException exception)
        {
            return new XLiveValidationReport(PlatformPreparationOutcome.Failed, exception.Code, progress.Values);
        }
        catch (CdpTransportException)
        {
            return new XLiveValidationReport(PlatformPreparationOutcome.Failed, "cdp_transport_failed", progress.Values);
        }
        catch (Exception)
        {
            return new XLiveValidationReport(PlatformPreparationOutcome.Failed, "unexpected_failure", progress.Values);
        }
        finally
        {
            if (transport is not null)
            {
                transport.StopForGracefulSocketClose();
                try
                {
                    await connection.DisposeAsync().ConfigureAwait(false);
                }
                finally
                {
                    await transport.DisposeAsync().ConfigureAwait(false);
                }
            }
            else
            {
                await connection.DisposeAsync().ConfigureAwait(false);
            }
        }
    }

    internal sealed record XLiveValidationInput(string ImagePath);

    private sealed class RecordingProgress : IPreparationProgress
    {
        internal List<SocialPreparationProgress> Values { get; } = [];

        public Task ReportAsync(SocialPreparationProgress progress, CancellationToken cancellationToken)
        {
            Values.Add(progress);
            return Task.CompletedTask;
        }
    }
}

internal sealed record XLiveValidationReport(
    PlatformPreparationOutcome Outcome,
    string? DetailCode,
    IReadOnlyList<SocialPreparationProgress> Progress)
{
    internal string FormatForConsole() =>
        $"X live validation outcome={Outcome}; detail_code={DetailCode ?? "none"}; progress=[{string.Join(',', Progress)}]";
}
