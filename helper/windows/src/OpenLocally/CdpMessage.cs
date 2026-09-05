using System.Text.Json;
using System.Net.WebSockets;

namespace OpenLocally;

/// <summary>Owned CDP event data. A null session ID denotes a browser-level event.</summary>
public sealed record CdpEvent(string Method, string? SessionId, JsonElement? Parameters);

public enum CdpTransportFailure
{
    Closed,
    Disconnected,
    MalformedMessage,
    MessageTooLarge,
    UnexpectedBinaryMessage,
    EventQueueOverflow,
    Disposed,
    CommandIdExhausted,
}

public sealed class CdpTransportException : Exception
{
    public CdpTransportException(CdpTransportFailure failure, Exception? innerException = null, CdpTransportDiagnostic? diagnostic = null)
        : base(failure.ToString(), innerException)
    {
        Failure = failure;
        Diagnostic = diagnostic;
    }

    public CdpTransportFailure Failure { get; }
    public CdpTransportDiagnostic? Diagnostic { get; private set; }
    public SocialPreparationDiagnostic? SocialDiagnostic { get; private set; }

    internal void AttachDiagnostic(CdpTransportDiagnostic diagnostic) => Diagnostic ??= diagnostic;
    internal void AttachSocialDiagnostic(SocialPreparationDiagnostic diagnostic) => SocialDiagnostic ??= diagnostic;
}

/// <summary>Bounded, payload-free context for a terminal CDP transport failure.</summary>
public sealed record CdpTransportDiagnostic(
    string? CommandMethod,
    string? CommandPhase,
    WebSocketState WebSocketState,
    bool CallerTokenCancelled,
    bool CommandTimeoutFired,
    bool TransportLifetimeCancelled,
    string FirstTerminalReason);

public sealed class CdpCommandException : Exception
{
    public CdpCommandException(int code, string message, string? operation = null)
        : base(message)
    {
        Code = code;
        Operation = operation;
    }

    public int Code { get; }
    public string? Operation { get; }
    public SocialPreparationDiagnostic? SocialDiagnostic { get; private set; }
    internal void AttachSocialDiagnostic(SocialPreparationDiagnostic diagnostic) => SocialDiagnostic ??= diagnostic;
}

public sealed class CdpEventHandlerException : Exception
{
    public CdpEventHandlerException(Exception innerException)
        : base("A CDP event handler failed.", innerException)
    {
    }
}
