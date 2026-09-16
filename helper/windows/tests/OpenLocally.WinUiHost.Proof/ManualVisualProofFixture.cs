using System.Net;
using System.Net.Sockets;
using OpenLocally;

namespace OpenLocally.ManualVisualProof;

internal enum ProofPostingState { Ready, Confirming, Unknown, Posted }
internal enum ProofTheme { Dark, Light }

internal sealed class ManualVisualProofFixture : IDisposable
{
    private const string SessionId = "manual-visual-proof-session";
    private readonly string _fixtureRoot;
    private readonly SocialMediaStager _stager;

    private ManualVisualProofFixture(
        string fixtureRoot, ManualSocialSession session, IManualAssetPreviewAccess previewAccess,
        SocialMediaStager stager)
    {
        _fixtureRoot = fixtureRoot;
        Session = session;
        PreviewAccess = previewAccess;
        _stager = stager;
    }

    internal ManualSocialSession Session { get; }
    internal IManualAssetPreviewAccess PreviewAccess { get; }
    internal IReadOnlyList<string> ExpectedAvailablePaths =>
        Session.Platforms[0].Assets
            .Where(ManualPublishingCompanionModel.IsAvailable)
            .Select(asset => asset.Path)
            .ToArray();

    internal static ManualVisualProofFixture Create(string repositoryRoot)
    {
        string fixtureRoot = Path.GetFullPath(Path.Combine(
            repositoryRoot, "test-results", "manual-publishing-visual-proof", "fixture"));
        Directory.CreateDirectory(fixtureRoot);
        string ordinary = Path.Combine(fixtureRoot, "campaign-cover.bmp");
        string longDirectory = Path.Combine(fixtureRoot, "launch-assets", "final-approved-media");
        Directory.CreateDirectory(longDirectory);
        string longImage = Path.Combine(longDirectory,
            "creatorcrate-autumn-product-launch-behind-the-scenes-wide-preview.bmp");
        string notes = Path.Combine(fixtureRoot, "posting-notes.txt");
        File.WriteAllBytes(ordinary, SolidBmp(36, 36, 34, 211, 238));
        File.WriteAllBytes(longImage, SolidBmp(36, 36, 167, 139, 250));
        File.WriteAllText(notes, "CreatorCrate launch notes\r\nApproved for manual publication.\r\n");

        ManualPreparedAsset[] assets =
        [
            Prepared(9101, "primary", ordinary, fixtureRoot, "campaign-cover.bmp", "image/bmp", true),
            Prepared(9102, "attachment", longImage, fixtureRoot,
                @"launch-assets\final-approved-media\creatorcrate-autumn-product-launch-behind-the-scenes-wide-preview.bmp",
                "image/bmp", true),
            Prepared(9103, "attachment", notes, fixtureRoot, "posting-notes.txt", "text/plain", true),
            new ManualPreparedAsset(
                new SocialRedeemAsset(9104, "attachment", 3, "missing-community-photo.png", ".png",
                    "image/png", 48217, "release/missing-community-photo.png", false, null),
                string.Empty, StagedMediaProvenance.ExternalSource),
        ];

        var session = new ManualSocialSession(
            new Uri("https://creatorcrate.example"), 4242, "Autumn Creator Launch — Behind the Scenes",
            [
                new ManualPreparedPlatform("patreon",
                    "A closer look at our autumn CreatorCrate launch 🍂",
                    "We built this release with creators, not around them.\r\n\r\nHere’s the process, the people, and the details that made it possible. 👩🏽‍💻✨",
                    assets),
                new ManualPreparedPlatform("x", string.Empty,
                    "Behind the scenes of our autumn CreatorCrate launch 🍂 Built with creators, tested in the real workflow, and ready to share.",
                    assets),
                new ManualPreparedPlatform("bluesky", string.Empty,
                    "A look behind the scenes of our autumn CreatorCrate launch 🍂\r\nBuilt with creators and tested in the real manual publishing workflow. ✨",
                    assets),
            ]);

        SocialOrigin origin = SocialOrigin.Parse(session.ServerOrigin);
        var trusted = new FixtureTrustedMediaRootStore(fixtureRoot);
        var resolver = new LocalMediaResolver(trusted, new RejectingMediaPrompt());
        var addressResolver = new LoopbackResolver();
        var trust = new OriginTrustService(new RejectingOriginStore(), new RejectingOriginPrompt(), addressResolver);
        var capabilityClient = new SocialCapabilityClient(
            new SocialHttpClient(addressResolver, () => new NetworkForbiddenHandler()), trust);
        var stager = new SocialMediaStager(capabilityClient, resolver, fixtureRoot);
        var previewAccess = new ManualAssetPreviewAccess(origin, SessionId, resolver, stager);
        return new ManualVisualProofFixture(fixtureRoot, session, previewAccess, stager);
    }

    internal static ProofPostingState ParsePostingState(string? value) => value?.ToLowerInvariant() switch
    {
        null or "ready" => ProofPostingState.Ready,
        "confirming" => ProofPostingState.Confirming,
        "unknown" or "retry" => ProofPostingState.Unknown,
        "posted" => ProofPostingState.Posted,
        _ => throw new ArgumentException("Posting state must be Ready, Confirming, Unknown, or Posted."),
    };

    internal static ProofTheme ParseTheme(string? value) => value?.ToLowerInvariant() switch
    {
        null or "dark" => ProofTheme.Dark,
        "light" => ProofTheme.Light,
        _ => throw new ArgumentException("Theme must be Dark or Light."),
    };

    internal static ManualPostingConfirmationController CreatePostingController(
        ProofPostingState state, IEnumerable<string> platforms, out FixturePostingTransport transport)
    {
        transport = new FixturePostingTransport(state);
        var controller = new ManualPostingConfirmationController(transport, platforms);
        string[] names = platforms.ToArray();
        if (state == ProofPostingState.Confirming)
            _ = controller.ConfirmAsync(names[0]);
        else if (state is ProofPostingState.Unknown or ProofPostingState.Posted)
            foreach (string platform in names)
                controller.ConfirmAsync(platform).GetAwaiter().GetResult();
        return controller;
    }

    internal static NativeCompanionPalette Palette(ProofTheme theme) =>
        theme == ProofTheme.Light ? NativeCompanionPalette.Light : NativeCompanionPalette.Dark;

    internal static Microsoft.UI.Xaml.ElementTheme ElementTheme(ProofTheme theme) =>
        theme == ProofTheme.Light
            ? Microsoft.UI.Xaml.ElementTheme.Light
            : Microsoft.UI.Xaml.ElementTheme.Dark;

    public void Dispose()
    {
        PreviewAccess.Dispose();
        _stager.Cleanup(new SocialCapability(SessionId, "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"));
        if (Directory.Exists(_fixtureRoot)) Directory.Delete(_fixtureRoot, recursive: true);
    }

    private static ManualPreparedAsset Prepared(
        long id, string role, string path, string root, string relativePath, string mimeType, bool present)
    {
        var asset = new SocialRedeemAsset(id, role, id - 9101, Path.GetFileName(path), Path.GetExtension(path),
            mimeType, new FileInfo(path).Length, relativePath.Replace('/', '\\'), present, path);
        return new ManualPreparedAsset(asset, path, StagedMediaProvenance.ExternalSource);
    }

    private static byte[] SolidBmp(int width, int height, byte red, byte green, byte blue)
    {
        int stride = (width * 3 + 3) & ~3;
        int pixels = stride * height;
        byte[] value = new byte[54 + pixels];
        value[0] = (byte)'B'; value[1] = (byte)'M';
        BitConverter.GetBytes(value.Length).CopyTo(value, 2);
        BitConverter.GetBytes(54).CopyTo(value, 10);
        BitConverter.GetBytes(40).CopyTo(value, 14);
        BitConverter.GetBytes(width).CopyTo(value, 18);
        BitConverter.GetBytes(height).CopyTo(value, 22);
        BitConverter.GetBytes((short)1).CopyTo(value, 26);
        BitConverter.GetBytes((short)24).CopyTo(value, 28);
        BitConverter.GetBytes(pixels).CopyTo(value, 34);
        for (int y = 0; y < height; y++)
            for (int x = 0; x < width; x++)
            {
                int offset = 54 + y * stride + x * 3;
                value[offset] = blue; value[offset + 1] = green; value[offset + 2] = red;
            }
        return value;
    }

    private sealed class FixtureTrustedMediaRootStore(string root) : ITrustedMediaRootStore
    {
        public bool IsTrusted(SocialOrigin origin, string candidate) =>
            string.Equals(Path.GetFullPath(candidate), Path.GetFullPath(root), StringComparison.OrdinalIgnoreCase);
        public void Trust(SocialOrigin origin, string candidate) { }
    }

    private sealed class RejectingMediaPrompt : ITrustedMediaRootPrompt
    {
        public bool ConfirmTrust(SocialOrigin origin, string root) => false;
    }

    private sealed class LoopbackResolver : IOriginAddressResolver
    {
        public Task<IReadOnlyList<IPAddress>> ResolveAsync(string host, CancellationToken cancellationToken) =>
            Task.FromResult<IReadOnlyList<IPAddress>>([IPAddress.Loopback]);
    }

    private sealed class RejectingOriginStore : ITrustedOriginStore
    {
        public bool IsTrusted(SocialOrigin origin) => false;
        public void Trust(SocialOrigin origin) { }
    }

    private sealed class RejectingOriginPrompt : IOriginTrustPrompt
    {
        public bool ConfirmTrust(SocialOrigin origin) => false;
    }

    private sealed class NetworkForbiddenHandler : HttpMessageHandler
    {
        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken) =>
            throw new InvalidOperationException("The manual visual proof must not use the network.");
    }
}

internal sealed class FixtureDragAvailability(ManualSocialSession session) : IManualAssetAvailability
{
    public Task<ManualDragPreparation> PrepareAsync(
        IReadOnlyList<ManualDragAsset> selected,
        CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(selected);
        cancellationToken.ThrowIfCancellationRequested();
        if (selected.Count == 0)
            return Task.FromResult(ManualDragPreparation.Fail("no_assets_selected"));

        IReadOnlyList<ManualPreparedAsset> fixtureAssets = session.Platforms[0].Assets;
        var paths = new List<string>(selected.Count);
        foreach (ManualDragAsset item in selected)
        {
            if (item.Ordinal < 0 || item.Ordinal >= fixtureAssets.Count)
                return Task.FromResult(ManualDragPreparation.Fail("validation_failed"));
            ManualPreparedAsset expected = fixtureAssets[item.Ordinal];
            if (expected.Asset.AssetId != item.Prepared.Asset.AssetId ||
                !string.Equals(expected.Path, item.Prepared.Path, StringComparison.OrdinalIgnoreCase) ||
                !ManualPublishingCompanionModel.IsAvailable(expected) ||
                !Path.IsPathFullyQualified(expected.Path) ||
                !File.Exists(expected.Path))
                return Task.FromResult(ManualDragPreparation.Fail(
                    "validation_failed", item.Prepared.Asset.Filename));
            paths.Add(expected.Path);
        }
        return Task.FromResult(ManualDragPreparation.Ready(paths));
    }
}

internal sealed class FixturePostingTransport(ProofPostingState mode) : IManualPostingConfirmationTransport
{
    private readonly TaskCompletionSource<ManualPostingTransportResult> _pending =
        new(TaskCreationOptions.RunContinuationsAsynchronously);
    private int _posted;

    public DateTime? ConfirmationExpiresAt => null;
    internal int PostCalls { get; private set; }
    internal int GetCalls { get; private set; }

    public Task<ManualPostingTransportResult> PostAsync(string platform, CancellationToken cancellationToken)
    {
        PostCalls++;
        return mode switch
        {
            ProofPostingState.Confirming => _pending.Task.WaitAsync(cancellationToken),
            ProofPostingState.Unknown => Task.FromResult(ManualPostingTransportResult.Ambiguous()),
            ProofPostingState.Posted => Task.FromResult(Posted(platform)),
            _ => Task.FromResult(ManualPostingTransportResult.Rejected("validation_failed")),
        };
    }

    public Task<ManualPostingTransportResult> GetAsync(string platform, CancellationToken cancellationToken)
    {
        GetCalls++;
        return Task.FromResult(mode == ProofPostingState.Posted
            ? Posted(platform)
            : ManualPostingTransportResult.Ambiguous());
    }

    public void Dispose() => _pending.TrySetCanceled();

    private ManualPostingTransportResult Posted(string platform)
    {
        int posted = Math.Min(3, Interlocked.Increment(ref _posted));
        return ManualPostingTransportResult.Authoritative(new ManualPostingConfirmationResponse(
            platform, "posted", new DateTime(2026, 9, 15, 14, 30, 0, DateTimeKind.Utc),
            new ManualPostingCompletion(posted, 3, posted == 3)));
    }
}
