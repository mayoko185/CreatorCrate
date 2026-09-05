using System.Net;
using System.Net.Security;
using System.Net.Sockets;
using System.Security.Authentication;
using System.Security.Cryptography;
using System.Security.Cryptography.X509Certificates;

namespace OpenLocally.Tests;

/// <summary>Self-signed loopback fixture for ordinary TLS validation tests; no manual wrapper is involved.</summary>
internal sealed class InProcessTlsFixture : IAsyncDisposable
{
    private readonly TcpListener _listener;
    private readonly X509Certificate2 _certificate;
    private readonly CancellationTokenSource _lifetime = new();
    private readonly Task _serveTask;

    private InProcessTlsFixture(TcpListener listener, X509Certificate2 certificate)
    {
        _listener = listener;
        _certificate = certificate;
        _serveTask = ServeAsync();
    }

    internal Uri Origin => new($"https://127.0.0.1:{((IPEndPoint)_listener.LocalEndpoint).Port}/");

    internal static Task<InProcessTlsFixture> StartAsync()
    {
        using ECDsa key = ECDsa.Create(ECCurve.NamedCurves.nistP256);
        var request = new CertificateRequest("CN=CreatorCrate Test TLS Fixture", key, HashAlgorithmName.SHA256);
        request.CertificateExtensions.Add(new X509BasicConstraintsExtension(false, false, 0, false));
        request.CertificateExtensions.Add(new X509SubjectKeyIdentifierExtension(request.PublicKey, false));
        X509Certificate2 certificate = request.CreateSelfSigned(DateTimeOffset.UtcNow.AddMinutes(-1), DateTimeOffset.UtcNow.AddMinutes(5));
        var listener = new TcpListener(IPAddress.Loopback, 0);
        listener.Start();
        return Task.FromResult(new InProcessTlsFixture(listener, certificate));
    }

    public async ValueTask DisposeAsync()
    {
        _lifetime.Cancel();
        _listener.Stop();
        try { await _serveTask.ConfigureAwait(false); } catch (OperationCanceledException) { }
        _certificate.Dispose();
        _lifetime.Dispose();
    }

    private async Task ServeAsync()
    {
        try
        {
            while (!_lifetime.IsCancellationRequested)
            {
                TcpClient client = await _listener.AcceptTcpClientAsync(_lifetime.Token).ConfigureAwait(false);
                _ = RejectWithSelfSignedCertificateAsync(client);
            }
        }
        catch (OperationCanceledException) when (_lifetime.IsCancellationRequested) { }
        catch (ObjectDisposedException) when (_lifetime.IsCancellationRequested) { }
    }

    private async Task RejectWithSelfSignedCertificateAsync(TcpClient client)
    {
        using (client)
        await using (NetworkStream network = client.GetStream())
        await using (var tls = new SslStream(network, leaveInnerStreamOpen: false))
        {
            try { await tls.AuthenticateAsServerAsync(_certificate, clientCertificateRequired: false, checkCertificateRevocation: false).ConfigureAwait(false); }
            catch (AuthenticationException) { }
            catch (IOException) { }
        }
    }
}
