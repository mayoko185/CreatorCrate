using System.Text;
using System.Text.Json;

namespace OpenLocally;

internal enum ManualBoundaryState { not_started, entered, completed, failed }
internal enum ManualFailureKind { caught_exception, failure_outcome, disposal_failure }
internal enum ManualExceptionClass
{
    invalid_operation, io, unauthorized_access, argument, operation_canceled, object_disposed,
    timeout, websocket_connection, social_preparation_runtime, browser_preparation, cdp_command, cdp_transport, unexpected,
}

/// <summary>One manual run's final, payload-free state. No event stream or private inputs.</summary>
internal sealed class ManualPreparationEvidence
{
    internal ManualBoundaryState Composition { get; set; }
    internal ManualBoundaryState Consent { get; set; }
    internal ManualBoundaryState Discovery { get; set; }
    internal ManualBoundaryState ConnectionSetup { get; set; }
    internal ManualBoundaryState Connection { get; set; }
    internal ManualBoundaryState BrowserSetup { get; set; }
    internal ManualBoundaryState AdapterInvocation { get; set; }
    internal ManualBoundaryState RuntimeDisposal { get; set; }
    private bool? _parentRequested;
    private bool? _parentAccepted;
    private ChromeConnectionConsentDecision? _decision;
    private NativePresentationState? _localPresentation;
    private string? _discoveryResult;
    private string? _connectionResult;
    private ManualFailureKind? _failureKind;
    private ManualExceptionClass? _exceptionClass;
    private ManualExceptionClass? _disposalExceptionClass;

    // Retain the primary report before a finally can replace its exception.
    // Not part of the evidence payload (and never reflected/serialized wholesale).
    internal SocialPreparationDiagnostic? PrimaryDiagnostic { get; set; }

    internal void ObserveConsent(IChromeConnectionConsent consent, ChromeConnectionConsentDecision? decision)
    {
        _decision = decision;
        if (consent is ManualReadyConsent bridge)
        {
            _parentRequested = bridge.Requested;
            _parentAccepted = bridge.Accepted;
            _localPresentation = bridge.LocalPresentation?.State;
        }
        else if (consent is NativeChromeConnectionConsent native)
        {
            _parentRequested = false;
            _parentAccepted = false;
            _localPresentation = native.LastPresentation?.State;
        }
    }

    internal void ObserveDiscovery(ChromeDiscoveryResult result)
    {
        Discovery = result.Success ? ManualBoundaryState.completed : ManualBoundaryState.failed;
        _discoveryResult = result.ErrorCode switch
        {
            "chrome_not_running" => "chrome_not_running",
            "chrome_discovery_missing" => "chrome_discovery_missing",
            "chrome_discovery_malformed" => "chrome_discovery_malformed",
            _ => null,
        };
    }

    internal void ObserveConnection(ChromeConnectionResult result)
    {
        Connection = result.Success ? ManualBoundaryState.completed : ManualBoundaryState.failed;
        _connectionResult = result.ErrorCode switch
        {
            "chrome_connection_cancelled" => "chrome_connection_cancelled",
            "chrome_approval_timeout" => "chrome_approval_timeout",
            "chrome_connection_refused" => "chrome_connection_refused",
            "chrome_approval_denied" => "chrome_approval_denied",
            "chrome_handshake_failed" => "chrome_handshake_failed",
            _ => null,
        };
    }

    internal void CaptureFailure(ManualFailureKind kind, Exception? exception = null)
    {
        if (kind == ManualFailureKind.disposal_failure && exception is not null)
            _disposalExceptionClass = Classify(exception);
        if (_failureKind is not null) return;
        _failureKind = kind;
        _exceptionClass = exception is null ? null : Classify(exception);
    }

    internal static SocialPreparationDiagnostic? AttachedDiagnostic(Exception? exception)
    {
        // Known diagnostic-bearing families only, including one wrapped by an
        // otherwise unrecognized exception. Never inspect Data or arbitrary properties.
        for (int depth = 0; exception is not null && depth < 8; depth++, exception = exception.InnerException)
        {
            SocialPreparationDiagnostic? diagnostic = exception switch
            {
                SocialPreparationRuntimeException runtime => runtime.Diagnostic,
                CdpTransportException transport => transport.SocialDiagnostic,
                CdpCommandException command => command.SocialDiagnostic,
                BrowserPreparationException browser => browser.SocialDiagnostic,
                _ => null,
            };
            if (diagnostic is not null) return diagnostic;
        }
        return null;
    }

    private static ManualExceptionClass Classify(Exception exception) => exception switch
    {
        CdpCommandException => ManualExceptionClass.cdp_command,
        CdpTransportException => ManualExceptionClass.cdp_transport,
        BrowserPreparationException => ManualExceptionClass.browser_preparation,
        SocialPreparationRuntimeException => ManualExceptionClass.social_preparation_runtime,
        WebSocketConnectionException => ManualExceptionClass.websocket_connection,
        ObjectDisposedException => ManualExceptionClass.object_disposed,
        InvalidOperationException => ManualExceptionClass.invalid_operation,
        UnauthorizedAccessException => ManualExceptionClass.unauthorized_access,
        IOException => ManualExceptionClass.io,
        ArgumentException => ManualExceptionClass.argument,
        OperationCanceledException => ManualExceptionClass.operation_canceled,
        TimeoutException => ManualExceptionClass.timeout,
        _ => ManualExceptionClass.unexpected,
    };

    private static string Word<T>(T value) where T : struct, Enum => Enum.IsDefined(value) ? value.ToString() : "unknown";
    private static object Boundary(ManualBoundaryState state) => new { state = Word(state) };

    internal object ToPayload() => new
    {
        composition = Boundary(Composition),
        consent = new
        {
            state = Word(Consent), parent_requested = _parentRequested, parent_response_accepted = _parentAccepted,
            decision = _decision switch
            {
                ChromeConnectionConsentDecision.Continue => "continue",
                ChromeConnectionConsentDecision.Cancel => "cancel",
                ChromeConnectionConsentDecision.DisplayFailed => "display_failed",
                _ => "unknown",
            },
            local_presentation = _localPresentation switch
            {
                NativePresentationState.PresentedAndDismissed => "presented_and_dismissed",
                NativePresentationState.Failed => "failed",
                _ => "unknown",
            },
        },
        discovery = new { state = Word(Discovery), result = _discoveryResult },
        connection_setup = Boundary(ConnectionSetup),
        connection = new { state = Word(Connection), result = _connectionResult },
        browser_setup = Boundary(BrowserSetup),
        adapter_invocation = Boundary(AdapterInvocation),
        runtime_disposal = Boundary(RuntimeDisposal),
        failure = new
        {
            kind = _failureKind is { } kind ? Word(kind) : null,
            exception_class = _exceptionClass is { } exceptionClass ? Word(exceptionClass) : null,
            disposal_exception_class = _disposalExceptionClass is { } disposalClass ? Word(disposalClass) : null,
        },
    };

    internal void AppendDisplay(StringBuilder report)
    {
        report.AppendLine("Manual preparation:");
        // The same fixed payload supplies both surfaces; unknown is never success.
        foreach (JsonProperty boundary in JsonSerializer.SerializeToElement(ToPayload()).EnumerateObject())
        {
            report.AppendLine($"  {boundary.Name}:");
            foreach (JsonProperty field in boundary.Value.EnumerateObject())
            {
                string value = field.Value.ValueKind switch
                {
                    JsonValueKind.True => "yes", JsonValueKind.False => "no",
                    JsonValueKind.Null => "unknown", _ => field.Value.ToString(),
                };
                report.AppendLine($"    {field.Name}: {value}");
            }
        }
    }
}
