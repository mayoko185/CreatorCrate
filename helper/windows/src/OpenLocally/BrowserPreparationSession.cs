using System.Text;
using System.Text.Json;

namespace OpenLocally;

public enum BrowserPreparationFailure
{
    InvalidTarget,
    NotOwnedTarget,
    NavigationFailed,
    ReadinessTimedOut,
    CrossSessionNode,
    InvalidNode,
    FileChooserTimedOut,
    FileChooserMissingBackendNode,
    FileChooserWrongFrame,
    FileChooserUnexpectedInput,
    FileChooserMultipleFilesUnsupported,
    FileChooserMultipleEvents,
}

internal enum BrowserPreparationActivationStage
{
    NodeReady,
    ScrollReady,
    BoxReady,
    MousePressSent,
    MouseReleaseSent,
    Completed,
}

public sealed class BrowserPreparationException : Exception
{
    public BrowserPreparationException(BrowserPreparationFailure failure)
        : this(failure, null)
    {
    }

    public BrowserPreparationException(BrowserPreparationFailure failure, string? detail)
        : base(string.IsNullOrWhiteSpace(detail) ? failure.ToString() : $"{failure}: {detail}") => Failure = failure;

    public BrowserPreparationFailure Failure { get; }
    public SocialPreparationDiagnostic? SocialDiagnostic { get; private set; }
    internal void AttachSocialDiagnostic(SocialPreparationDiagnostic diagnostic) => SocialDiagnostic ??= diagnostic;
}

/// <summary>Opaque node identity returned by this attached page session.</summary>
public sealed class BrowserDomNode
{
    internal BrowserDomNode(string sessionId, int nodeId, long backendNodeId, string nodeName, bool isContentEditable, bool isFileInput)
    {
        SessionId = sessionId;
        NodeId = nodeId;
        BackendNodeId = backendNodeId;
        NodeName = nodeName;
        IsContentEditable = isContentEditable;
        IsFileInput = isFileInput;
    }

    internal string SessionId { get; }
    internal bool IsContentEditable { get; }
    internal bool IsFileInput { get; }
    public int NodeId { get; }
    public long BackendNodeId { get; }
    public string NodeName { get; }
}
public sealed record BrowserNavigationResult(string FrameId);
public enum BrowserTextVerification { Match, Mismatch, NodeDisappeared, UnsupportedReadback }

/// <summary>Internal live accessibility readback used by bounded preparation verification.</summary>
internal sealed record BrowserTextReadback(BrowserTextVerification Verification, string? Actual, string? Detail = null);

internal sealed record BrowserTextMismatchDiagnostic(
    int ExpectedUtf16Length,
    int? ActualUtf16Length,
    int FirstDifferenceIndex,
    string ExpectedCodePoint,
    string ActualCodePoint,
    int ExpectedLfCount,
    int? ActualLfCount,
    int ExpectedCrCount,
    int? ActualCrCount,
    bool ExpectedHasNbsp,
    bool? ActualHasNbsp,
    bool ExpectedHasZeroWidth,
    bool? ActualHasZeroWidth,
    string? ReadbackStructure)
{
    internal static BrowserTextMismatchDiagnostic Create(string expected, string? actual, string? readbackStructure)
    {
        int difference = FirstDifference(expected, actual);
        return new(
            expected.Length,
            actual?.Length,
            difference,
            CodePointAt(expected, difference),
            CodePointAt(actual, difference),
            expected.Count(character => character == '\n'),
            actual?.Count(character => character == '\n'),
            expected.Count(character => character == '\r'),
            actual?.Count(character => character == '\r'),
            expected.Contains('\u00a0'),
            actual?.Contains('\u00a0'),
            ContainsZeroWidth(expected),
            actual is null ? null : ContainsZeroWidth(actual),
            readbackStructure);
    }

    private static int FirstDifference(string expected, string? actual)
    {
        if (actual is null) return 0;
        int sharedLength = Math.Min(expected.Length, actual.Length);
        for (int index = 0; index < sharedLength; index++)
        {
            if (expected[index] != actual[index]) return index;
        }
        return sharedLength;
    }

    private static string CodePointAt(string? value, int index)
    {
        if (value is null || index >= value.Length) return "<end>";
        int scalarStart = index > 0 && char.IsLowSurrogate(value[index]) && char.IsHighSurrogate(value[index - 1])
            ? index - 1
            : index;
        int codePoint = char.IsHighSurrogate(value[scalarStart]) && scalarStart + 1 < value.Length && char.IsLowSurrogate(value[scalarStart + 1])
            ? char.ConvertToUtf32(value[scalarStart], value[scalarStart + 1])
            : value[scalarStart];
        return $"U+{codePoint:X}";
    }

    private static bool ContainsZeroWidth(string value) =>
        value.IndexOfAny(['\u200b', '\u200c', '\u200d', '\ufeff']) >= 0;
}

internal sealed record RichAccessibleTextReadback(string? Actual, string Detail);

/// <summary>
/// An attached flattened page session. Disposing only detaches; it never closes a tab
/// unless CloseOwnedTargetAsync is explicitly requested for a target this instance created.
/// </summary>
public sealed class BrowserPreparationSession : IAsyncDisposable
{
    public static readonly TimeSpan DefaultReadinessTimeout = TimeSpan.FromSeconds(15);

    private readonly CdpTargetManager _targets;
    private readonly object _terminalDetachGate = new();
    private Task? _terminalDetachTask;
    private int _disposed;
    private int _sessionDisposed;

    private BrowserPreparationSession(CdpTargetManager targets, string targetId, CdpSession session, bool ownsTarget)
    {
        _targets = targets;
        TargetId = targetId;
        Session = session;
        OwnsTarget = ownsTarget;
    }

    public string TargetId { get; }
    internal bool IsTransportTerminal => _targets.IsTransportTerminal;
    internal string TransportDiagnosticState => _targets.TransportDiagnosticState;
    // Keep the generic CDP command surface inside the helper. Preparation
    // adapters receive only the bounded operations on this session.
    internal CdpSession Session { get; }
    public bool OwnsTarget { get; }

    internal static async Task<IReadOnlyList<CdpTargetInfo>> GetPreparatablePagesAsync(
        CdpTargetManager targets, TimeSpan? timeout = null, CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(targets);
        return BrowserTargetSelector.FilterPreparatablePages(await targets.GetTargetsAsync(timeout, cancellationToken));
    }

    internal static async Task<BrowserPreparationSession> CreateOwnedAsync(
        CdpTargetManager targets, TimeSpan? timeout = null, CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(targets);
        string targetId = await targets.CreateTargetAsync(timeout: timeout, cancellationToken: cancellationToken);
        try
        {
            CdpSession session = await targets.AttachToTargetAsync(targetId, timeout, cancellationToken);
            return new BrowserPreparationSession(targets, targetId, session, ownsTarget: true);
        }
        catch
        {
            try { await targets.CloseTargetAsync(targetId, timeout, cancellationToken); } catch { }
            throw;
        }
    }

    internal static async Task<BrowserPreparationSession> AttachAsync(
        CdpTargetManager targets, string targetId, TimeSpan? timeout = null, CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(targets);
        if (string.IsNullOrWhiteSpace(targetId)) throw new ArgumentException("A CDP target ID is required.", nameof(targetId));
        CdpTargetInfo? target = (await targets.GetTargetsAsync(timeout, cancellationToken)).SingleOrDefault(item => item.TargetId == targetId);
        if (target is null || !BrowserTargetSelector.IsPreparatablePage(target))
        {
            throw new BrowserPreparationException(BrowserPreparationFailure.InvalidTarget);
        }
        return new BrowserPreparationSession(targets, targetId, await targets.AttachToTargetAsync(targetId, timeout, cancellationToken), ownsTarget: false);
    }

    public Task<CdpBrowserVersion> GetBrowserVersionAsync(TimeSpan? timeout = null, CancellationToken cancellationToken = default) =>
        _targets.GetBrowserVersionAsync(timeout, cancellationToken);

    public async Task<BrowserNavigationResult> NavigateAsync(string url, TimeSpan? timeout = null, CancellationToken cancellationToken = default)
    {
        ThrowIfDisposed();
        if (!Uri.TryCreate(url, UriKind.Absolute, out Uri? destination) ||
            (destination.Scheme is not "http" and not "https" and not "about"))
        {
            throw new ArgumentException("A valid absolute browser navigation URL is required.", nameof(url));
        }
        await Session.SendCommandAsync("Page.enable", timeout: timeout, cancellationToken: cancellationToken);
        JsonElement result = await Session.SendCommandAsync("Page.navigate", JsonSerializer.SerializeToElement(new { url }), timeout, cancellationToken);
        if (result.TryGetProperty("errorText", out JsonElement errorText) && errorText.ValueKind == JsonValueKind.String)
        {
            throw new BrowserPreparationException(BrowserPreparationFailure.NavigationFailed);
        }
        if (!TryString(result, "frameId", out string? frameId))
        {
            throw new BrowserPreparationException(BrowserPreparationFailure.NavigationFailed);
        }
        return new BrowserNavigationResult(frameId!);
    }

    public async Task<BrowserDomNode> WaitForDocumentAsync(TimeSpan? timeout = null, CancellationToken cancellationToken = default)
    {
        ThrowIfDisposed();
        TimeSpan effectiveTimeout = ValidateTimeout(timeout ?? DefaultReadinessTimeout);
        await Session.SendCommandAsync("DOM.enable", cancellationToken: cancellationToken);
        using var deadline = new CancellationTokenSource(effectiveTimeout);
        using var linked = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken, deadline.Token);
        while (true)
        {
            try
            {
                BrowserDomNode? root = await GetDocumentAsync(linked.Token);
                if (root is not null) return root;
            }
            catch (CdpCommandException) when (!cancellationToken.IsCancellationRequested)
            {
                // Navigation can replace the document between CDP commands; retry within the bounded readiness window.
            }
            try { await Task.Delay(TimeSpan.FromMilliseconds(50), linked.Token); }
            catch (OperationCanceledException) when (deadline.IsCancellationRequested && !cancellationToken.IsCancellationRequested)
            {
                throw new BrowserPreparationException(BrowserPreparationFailure.ReadinessTimedOut);
            }
        }
    }

    public async Task<BrowserDomNode?> FindNodeAsync(string cssSelector, CancellationToken cancellationToken = default)
    {
        ThrowIfDisposed();
        if (string.IsNullOrWhiteSpace(cssSelector)) throw new ArgumentException("A CSS selector is required.", nameof(cssSelector));
        BrowserDomNode? root = await GetDocumentAsync(cancellationToken);
        if (root is null) return null;
        JsonElement query = await Session.SendCommandAsync("DOM.querySelector", JsonSerializer.SerializeToElement(new { nodeId = root.NodeId, selector = cssSelector }), cancellationToken: cancellationToken);
        if (!query.TryGetProperty("nodeId", out JsonElement nodeIdElement) || !nodeIdElement.TryGetInt32(out int nodeId) || nodeId == 0)
        {
            return null;
        }
        return await DescribeNodeAsync(nodeId, cancellationToken);
    }

    public async Task FocusAsync(BrowserDomNode node, CancellationToken cancellationToken = default)
    {
        EnsureNode(node);
        await Session.SendCommandAsync("DOM.focus", JsonSerializer.SerializeToElement(new { nodeId = node.NodeId }), cancellationToken: cancellationToken);
    }

    /// <summary>Activates an already-resolved preparation control by its on-page box; it never accepts a selector or script.</summary>
    public Task ActivateAsync(BrowserDomNode node, CancellationToken cancellationToken = default) =>
        ActivateAsync(node, null, cancellationToken);

    internal async Task ActivateAsync(
        BrowserDomNode node,
        Action<BrowserPreparationActivationStage>? observer,
        CancellationToken cancellationToken = default)
    {
        EnsureNode(node);
        ObserveActivation(observer, BrowserPreparationActivationStage.NodeReady);
        await Session.SendCommandAsync(
            "DOM.scrollIntoViewIfNeeded",
            JsonSerializer.SerializeToElement(new { backendNodeId = node.BackendNodeId }),
            cancellationToken: cancellationToken);
        ObserveActivation(observer, BrowserPreparationActivationStage.ScrollReady);
        JsonElement result = await Session.SendCommandAsync(
            "DOM.getBoxModel",
            JsonSerializer.SerializeToElement(new { backendNodeId = node.BackendNodeId }),
            cancellationToken: cancellationToken);
        if (!result.TryGetProperty("model", out JsonElement model) ||
            !model.TryGetProperty("border", out JsonElement border) ||
            border.ValueKind != JsonValueKind.Array ||
            border.GetArrayLength() != 8)
        {
            throw new BrowserPreparationException(BrowserPreparationFailure.InvalidNode);
        }

        double x = (border[0].GetDouble() + border[2].GetDouble() + border[4].GetDouble() + border[6].GetDouble()) / 4;
        double y = (border[1].GetDouble() + border[3].GetDouble() + border[5].GetDouble() + border[7].GetDouble()) / 4;
        if (!double.IsFinite(x) || !double.IsFinite(y)) throw new BrowserPreparationException(BrowserPreparationFailure.InvalidNode);
        ObserveActivation(observer, BrowserPreparationActivationStage.BoxReady);

        await Session.SendCommandAsync(
            "Input.dispatchMouseEvent",
            JsonSerializer.SerializeToElement(new { type = "mousePressed", x, y, button = "left", buttons = 1, clickCount = 1 }),
            cancellationToken: cancellationToken);
        ObserveActivation(observer, BrowserPreparationActivationStage.MousePressSent);
        await Session.SendCommandAsync(
            "Input.dispatchMouseEvent",
            JsonSerializer.SerializeToElement(new { type = "mouseReleased", x, y, button = "left", buttons = 0, clickCount = 1 }),
            cancellationToken: cancellationToken);
        ObserveActivation(observer, BrowserPreparationActivationStage.MouseReleaseSent);
    }

    /// <summary>Assigns local files to a known file-input node without chooser interception.</summary>
    public async Task SetFileInputFilesAsync(BrowserDomNode node, IReadOnlyList<string> paths, CancellationToken cancellationToken = default)
    {
        EnsureNode(node);
        if (!node.IsFileInput) throw new BrowserPreparationException(BrowserPreparationFailure.InvalidNode);
        ArgumentNullException.ThrowIfNull(paths);
        if (paths.Count == 0 || paths.Any(string.IsNullOrWhiteSpace))
            throw new ArgumentException("At least one local path is required.", nameof(paths));

        await Session.SendCommandAsync(
            "DOM.setFileInputFiles",
            JsonSerializer.SerializeToElement(new { files = paths.ToArray(), backendNodeId = node.BackendNodeId }),
            cancellationToken: cancellationToken);
    }

    public async Task ReplaceTextAsync(BrowserDomNode node, string text, CancellationToken cancellationToken = default)
    {
        EnsureNode(node);
        ArgumentNullException.ThrowIfNull(text);
        await FocusAsync(node, cancellationToken);
        await DispatchSelectAllAsync(cancellationToken);
        if (!node.IsContentEditable || !text.Contains('\n'))
        {
            await InsertTextAsync(text, cancellationToken);
            return;
        }

        int offset = 0;
        while (true)
        {
            int newline = text.IndexOf('\n', offset);
            if (newline < 0) break;
            if (newline > offset) await InsertTextAsync(text[offset..newline], cancellationToken);
            await DispatchLineBreakAsync(cancellationToken);
            offset = newline + 1;
        }
        if (offset < text.Length) await InsertTextAsync(text[offset..], cancellationToken);
    }

    public async Task<BrowserTextVerification> VerifyTextAsync(BrowserDomNode node, string expected, CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(expected);
        BrowserTextReadback readback = await ReadTextAsync(node, cancellationToken).ConfigureAwait(false);
        return readback.Verification != BrowserTextVerification.Mismatch ? readback.Verification :
            string.Equals(readback.Actual, expected, StringComparison.Ordinal) ? BrowserTextVerification.Match : BrowserTextVerification.Mismatch;
    }

    internal async Task<BrowserTextReadback> ReadTextAsync(BrowserDomNode node, CancellationToken cancellationToken = default)
    {
        EnsureNode(node);
        await Session.SendCommandAsync("Accessibility.enable", cancellationToken: cancellationToken);
        JsonElement result = await Session.SendCommandAsync(
            "Accessibility.getPartialAXTree",
            JsonSerializer.SerializeToElement(new { backendNodeId = node.BackendNodeId, fetchRelatives = node.IsContentEditable }),
            cancellationToken: cancellationToken);
        RichAccessibleTextReadback? richReadback = node.IsContentEditable
            ? await ReadRichAccessibleTextAsync(result, node.BackendNodeId, cancellationToken).ConfigureAwait(false)
            : null;
        string? actual = richReadback is null ? FindAccessibleValue(result) : richReadback.Actual;
        return actual is null
            ? new BrowserTextReadback(BrowserTextVerification.UnsupportedReadback, null, richReadback?.Detail)
            : new BrowserTextReadback(BrowserTextVerification.Mismatch, actual, richReadback?.Detail);
    }

    public async Task<BrowserDomNode> WaitForNodeAsync(string cssSelector, TimeSpan? timeout = null, CancellationToken cancellationToken = default)
    {
        TimeSpan effectiveTimeout = ValidateTimeout(timeout ?? DefaultReadinessTimeout);
        using var deadline = new CancellationTokenSource(effectiveTimeout);
        using var linked = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken, deadline.Token);
        while (true)
        {
            BrowserDomNode? node = await FindNodeAsync(cssSelector, linked.Token);
            if (node is not null) return node;
            try { await Task.Delay(TimeSpan.FromMilliseconds(50), linked.Token); }
            catch (OperationCanceledException) when (deadline.IsCancellationRequested && !cancellationToken.IsCancellationRequested)
            {
                throw new BrowserPreparationException(BrowserPreparationFailure.ReadinessTimedOut);
            }
        }
    }

    public async Task CloseOwnedTargetAsync(TimeSpan? timeout = null, CancellationToken cancellationToken = default)
    {
        ThrowIfDisposed();
        if (!OwnsTarget) throw new BrowserPreparationException(BrowserPreparationFailure.NotOwnedTarget);
        await _targets.CloseTargetAsync(TargetId, timeout, cancellationToken);
    }

    /// <summary>Detaches a helper-owned target while intentionally leaving its Chrome tab open for the operator.</summary>
    public async Task RelinquishOwnedTargetAsync(TimeSpan? timeout = null, CancellationToken cancellationToken = default)
    {
        ThrowIfDisposed();
        if (!OwnsTarget) throw new BrowserPreparationException(BrowserPreparationFailure.NotOwnedTarget);
        await DetachTerminalAsync(timeout, cancellationToken);
    }

    public async ValueTask DisposeAsync()
    {
        await DetachTerminalAsync();
        if (Interlocked.Exchange(ref _sessionDisposed, 1) == 0)
        {
            await Session.DisposeAsync();
        }
    }

    internal ValueTask DisposeLocallyAsync()
    {
        return Interlocked.Exchange(ref _disposed, 1) == 0
            ? Session.DisposeAsync()
            : ValueTask.CompletedTask;
    }

    private Task DetachTerminalAsync(TimeSpan? timeout = null, CancellationToken cancellationToken = default)
    {
        TaskCompletionSource? completion = null;
        lock (_terminalDetachGate)
        {
            if (Volatile.Read(ref _disposed) != 0) return Task.CompletedTask;
            if (_terminalDetachTask is not null) return _terminalDetachTask;

            completion = new(TaskCreationOptions.RunContinuationsAsynchronously);
            _terminalDetachTask = completion.Task;
        }

        _ = CompleteTerminalDetachAsync(completion, timeout, cancellationToken);
        return completion.Task;
    }

    private async Task CompleteTerminalDetachAsync(TaskCompletionSource completion, TimeSpan? timeout, CancellationToken cancellationToken)
    {
        try
        {
            await _targets.DetachFromTargetAsync(Session, timeout, cancellationToken);
            Interlocked.Exchange(ref _disposed, 1);
            completion.TrySetResult();
        }
        catch (Exception exception)
        {
            lock (_terminalDetachGate)
            {
                if (ReferenceEquals(_terminalDetachTask, completion.Task))
                {
                    _terminalDetachTask = null;
                }
            }
            completion.TrySetException(exception);
        }
    }

    private async Task<BrowserDomNode?> GetDocumentAsync(CancellationToken cancellationToken)
    {
        JsonElement result = await Session.SendCommandAsync("DOM.getDocument", JsonSerializer.SerializeToElement(new { depth = 0, pierce = false }), cancellationToken: cancellationToken);
        if (!result.TryGetProperty("root", out JsonElement root) || !root.TryGetProperty("nodeId", out JsonElement nodeId) || !nodeId.TryGetInt32(out int id) || id == 0)
        {
            return null;
        }
        return ParseNode(root);
    }

    internal Task<BrowserDomNode> DescribeNodeAsync(int nodeId, CancellationToken cancellationToken) =>
        DescribeNodeAsync(nodeId, cancellationToken, null);

    internal async Task<BrowserDomNode> DescribeNodeAsync(int nodeId, CancellationToken cancellationToken,
        Action<JsonElement>? beforeParse)
    {
        JsonElement result = await Session.SendCommandAsync("DOM.describeNode", JsonSerializer.SerializeToElement(new { nodeId, depth = 0, pierce = false }), cancellationToken: cancellationToken);
        // Diagnostic observers cannot replace the authoritative shared parse result or failure.
        try { beforeParse?.Invoke(result); }
        catch { }
        if (!result.TryGetProperty("node", out JsonElement node)) throw new BrowserPreparationException(BrowserPreparationFailure.InvalidNode);
        return ParseNode(node) ?? throw new BrowserPreparationException(BrowserPreparationFailure.InvalidNode);
    }

    private async Task DispatchSelectAllAsync(CancellationToken cancellationToken)
    {
        JsonElement down = JsonSerializer.SerializeToElement(new { type = "keyDown", key = "a", code = "KeyA", windowsVirtualKeyCode = 65, modifiers = 2 });
        JsonElement up = JsonSerializer.SerializeToElement(new { type = "keyUp", key = "a", code = "KeyA", windowsVirtualKeyCode = 65, modifiers = 2 });
        await Session.SendCommandAsync("Input.dispatchKeyEvent", down, cancellationToken: cancellationToken);
        await Session.SendCommandAsync("Input.dispatchKeyEvent", up, cancellationToken: cancellationToken);
    }

    private Task InsertTextAsync(string text, CancellationToken cancellationToken) =>
        Session.SendCommandAsync("Input.insertText", JsonSerializer.SerializeToElement(new { text }), cancellationToken: cancellationToken);

    private async Task DispatchLineBreakAsync(CancellationToken cancellationToken)
    {
        JsonElement down = JsonSerializer.SerializeToElement(new
        {
            type = "rawKeyDown",
            key = "Enter",
            code = "Enter",
            windowsVirtualKeyCode = 13,
            modifiers = 8,
            commands = new[] { "InsertLineBreak" },
        });
        JsonElement up = JsonSerializer.SerializeToElement(new { type = "keyUp", key = "Enter", code = "Enter", windowsVirtualKeyCode = 13, modifiers = 8 });
        await Session.SendCommandAsync("Input.dispatchKeyEvent", down, cancellationToken: cancellationToken);
        await Session.SendCommandAsync("Input.dispatchKeyEvent", up, cancellationToken: cancellationToken);
    }

    private static void ObserveActivation(Action<BrowserPreparationActivationStage>? observer, BrowserPreparationActivationStage stage)
    {
        try { observer?.Invoke(stage); }
        catch { }
    }

    private void EnsureNode(BrowserDomNode node)
    {
        ThrowIfDisposed();
        ArgumentNullException.ThrowIfNull(node);
        if (!string.Equals(node.SessionId, Session.SessionId, StringComparison.Ordinal)) throw new BrowserPreparationException(BrowserPreparationFailure.CrossSessionNode);
        if (node.NodeId <= 0 || node.BackendNodeId <= 0) throw new BrowserPreparationException(BrowserPreparationFailure.InvalidNode);
    }

    private void ThrowIfDisposed() => ObjectDisposedException.ThrowIf(Volatile.Read(ref _disposed) != 0, this);
    private static TimeSpan ValidateTimeout(TimeSpan value) => value > TimeSpan.Zero && value <= CdpTransport.MaximumCommandTimeout ? value : throw new ArgumentOutOfRangeException(nameof(value));

    private BrowserDomNode? ParseNode(JsonElement node) =>
        node.TryGetProperty("nodeId", out JsonElement nodeId) && nodeId.TryGetInt32(out int id) && id > 0 &&
        node.TryGetProperty("backendNodeId", out JsonElement backendId) && backendId.TryGetInt64(out long backend) && backend > 0 &&
        TryString(node, "nodeName", out string? nodeName)
            ? new BrowserDomNode(Session.SessionId, id, backend, nodeName!, IsContentEditable(node), IsFileInput(nodeName!, node)) : null;

    private static bool IsContentEditable(JsonElement node)
    {
        if (!node.TryGetProperty("attributes", out JsonElement attributes) || attributes.ValueKind != JsonValueKind.Array) return false;
        JsonElement.ArrayEnumerator values = attributes.EnumerateArray();
        while (values.MoveNext())
        {
            string? name = values.Current.ValueKind == JsonValueKind.String ? values.Current.GetString() : null;
            if (!values.MoveNext()) return false;
            string? value = values.Current.ValueKind == JsonValueKind.String ? values.Current.GetString() : null;
            if (string.Equals(name, "contenteditable", StringComparison.OrdinalIgnoreCase))
            {
                return string.IsNullOrEmpty(value) ||
                    string.Equals(value, "true", StringComparison.OrdinalIgnoreCase) ||
                    string.Equals(value, "plaintext-only", StringComparison.OrdinalIgnoreCase);
            }
        }
        return false;
    }

    private static bool IsFileInput(string nodeName, JsonElement node)
    {
        if (!string.Equals(nodeName, "INPUT", StringComparison.Ordinal)) return false;
        if (!node.TryGetProperty("attributes", out JsonElement attributes) || attributes.ValueKind != JsonValueKind.Array) return false;
        JsonElement.ArrayEnumerator values = attributes.EnumerateArray();
        while (values.MoveNext())
        {
            string? name = values.Current.ValueKind == JsonValueKind.String ? values.Current.GetString() : null;
            if (!values.MoveNext()) return false;
            string? value = values.Current.ValueKind == JsonValueKind.String ? values.Current.GetString() : null;
            if (string.Equals(name, "type", StringComparison.OrdinalIgnoreCase) &&
                string.Equals(value, "file", StringComparison.OrdinalIgnoreCase)) return true;
        }
        return false;
    }

    private const int MaximumRichAxNodes = 128;
    private const int MaximumRichAxDepth = 16;

    private enum AxChildIdsState { Missing, Valid, Malformed }

    private async Task<RichAccessibleTextReadback> ReadRichAccessibleTextAsync(JsonElement result, long backendNodeId, CancellationToken cancellationToken)
    {
        if (!TryGetAxNodes(result, out List<JsonElement>? initialNodes) || initialNodes is null || initialNodes.Count == 0)
        {
            return new RichAccessibleTextReadback(null, "rich_ax=unavailable");
        }

        var nodesById = new Dictionary<string, JsonElement>(StringComparer.Ordinal);
        var duplicateNodeIds = new HashSet<string>(StringComparer.Ordinal);
        foreach (JsonElement axNode in initialNodes)
        {
            AddAxNode(axNode, nodesById, duplicateNodeIds);
        }

        JsonElement? root = null;
        foreach (JsonElement axNode in initialNodes)
        {
            if (TryGetAxBackendDomNodeId(axNode, out long axBackendNodeId) && axBackendNodeId == backendNodeId)
            {
                root = axNode;
                break;
            }
        }
        if (root is null || !TryGetAxNodeId(root.Value, out string? rootId) || !nodesById.ContainsKey(rootId!))
        {
            return new RichAccessibleTextReadback(null, $"rich_ax=missing_root; requested_backend_dom_node_id={backendNodeId}");
        }

        JsonElement rootNode = root.Value;
        string? rootRole = FindAxString(rootNode, "role");
        string? rootValue = FindAxString(rootNode, "value");
        var visited = new HashSet<string>(StringComparer.Ordinal);
        var text = new StringBuilder();
        int staticTextNodeCount = 0;
        int lineBreakNodeCount = 0;

        async Task<bool> AppendNodeAsync(string id, int depth)
        {
            if (depth > MaximumRichAxDepth || !visited.Add(id) || visited.Count > MaximumRichAxNodes || duplicateNodeIds.Contains(id)) return false;
            if (!nodesById.TryGetValue(id, out JsonElement axNode)) return false;

            string? role = FindAxString(axNode, "role");
            if (string.Equals(role, "LineBreak", StringComparison.OrdinalIgnoreCase))
            {
                lineBreakNodeCount++;
                text.Append('\n');
                return true;
            }

            if (string.Equals(role, "StaticText", StringComparison.OrdinalIgnoreCase))
            {
                staticTextNodeCount++;
                if (TryFindAxString(axNode, "name", out string? staticText) ||
                    TryFindAxString(axNode, "value", out staticText))
                {
                    text.Append(staticText);
                }
                return true;
            }

            if (string.Equals(role, "InlineTextBox", StringComparison.OrdinalIgnoreCase)) return true;

            AxChildIdsState childIdsState = GetAxChildIds(axNode, out List<string>? childIds);
            if (childIdsState == AxChildIdsState.Malformed) return false;
            if (childIdsState == AxChildIdsState.Missing) return true;
            List<string> resolvedChildIds = childIds!;
            if (resolvedChildIds.Any(childId => !nodesById.ContainsKey(childId)))
            {
                JsonElement children = await Session.SendCommandAsync(
                    "Accessibility.getChildAXNodes",
                    JsonSerializer.SerializeToElement(new { id }),
                    cancellationToken: cancellationToken).ConfigureAwait(false);
                if (!TryGetAxNodes(children, out List<JsonElement>? childNodes) || childNodes is null) return false;
                foreach (JsonElement child in childNodes)
                {
                    AddAxNode(child, nodesById, duplicateNodeIds);
                }
            }

            foreach (string childId in resolvedChildIds)
            {
                if (!await AppendNodeAsync(childId, depth + 1).ConfigureAwait(false)) return false;
            }
            return true;
        }

        bool complete = await AppendNodeAsync(rootId!, 0).ConfigureAwait(false);
        string? actual = complete ? text.ToString() : FindAxAccessibleValue(rootNode);
        string detail = $"rich_ax; root_id={rootId}; root_backend_dom_node_id={backendNodeId}; root_role={rootRole ?? "<missing>"}; root_value_utf16_length={rootValue?.Length.ToString() ?? "<missing>"}; reconstructed_utf16_length={(complete ? actual?.Length.ToString() : null) ?? "<unavailable>"}; static_text_nodes={staticTextNodeCount}; line_break_nodes={lineBreakNodeCount}; subtree_complete={complete.ToString().ToLowerInvariant()}";
        return new RichAccessibleTextReadback(actual, detail);
    }

    private static bool TryGetAxNodes(JsonElement result, out List<JsonElement>? nodes)
    {
        nodes = null;
        if (!result.TryGetProperty("nodes", out JsonElement values) || values.ValueKind != JsonValueKind.Array) return false;
        nodes = values.EnumerateArray().Where(value => value.ValueKind == JsonValueKind.Object).ToList();
        return true;
    }

    private static bool TryGetAxNodeId(JsonElement node, out string? id) => TryString(node, "nodeId", out id);

    private static bool TryGetAxBackendDomNodeId(JsonElement node, out long backendNodeId)
    {
        backendNodeId = default;
        return node.TryGetProperty("backendDOMNodeId", out JsonElement value) &&
            value.ValueKind == JsonValueKind.Number && value.TryGetInt64(out backendNodeId);
    }

    private static void AddAxNode(JsonElement node, Dictionary<string, JsonElement> nodesById, HashSet<string> duplicateNodeIds)
    {
        if (TryGetAxNodeId(node, out string? id) && !nodesById.TryAdd(id!, node)) duplicateNodeIds.Add(id!);
    }

    private static AxChildIdsState GetAxChildIds(JsonElement node, out List<string>? childIds)
    {
        childIds = null;
        if (!node.TryGetProperty("childIds", out JsonElement values)) return AxChildIdsState.Missing;
        if (values.ValueKind != JsonValueKind.Array) return AxChildIdsState.Malformed;
        childIds = new List<string>();
        foreach (JsonElement value in values.EnumerateArray())
        {
            if (value.ValueKind != JsonValueKind.String || string.IsNullOrWhiteSpace(value.GetString())) return AxChildIdsState.Malformed;
            childIds.Add(value.GetString()!);
        }
        return AxChildIdsState.Valid;
    }

    private static string? FindAxString(JsonElement node, string property) =>
        TryFindAxString(node, property, out string? value) ? value : null;

    private static bool TryFindAxString(JsonElement node, string property, out string? value)
    {
        value = null;
        return node.TryGetProperty(property, out JsonElement axValue) &&
            axValue.ValueKind == JsonValueKind.Object &&
            axValue.TryGetProperty("value", out JsonElement text) &&
            text.ValueKind == JsonValueKind.String &&
            (value = text.GetString()) is not null;
    }

    private static string? FindAccessibleValue(JsonElement result)
    {
        if (!TryGetAxNodes(result, out List<JsonElement>? nodes) || nodes is null) return null;
        foreach (JsonElement node in nodes)
        {
            foreach (string property in new[] { "value", "name" })
            {
                if (TryFindAxString(node, property, out string? text)) return text;
            }
        }
        return null;
    }

    private static string? FindAxAccessibleValue(JsonElement node)
    {
        foreach (string property in new[] { "value", "name" })
        {
            if (TryFindAxString(node, property, out string? text)) return text;
        }
        return null;
    }

    private static bool TryString(JsonElement element, string name, out string? value)
    {
        value = null;
        return element.ValueKind == JsonValueKind.Object && element.TryGetProperty(name, out JsonElement property) && property.ValueKind == JsonValueKind.String && !string.IsNullOrWhiteSpace(value = property.GetString());
    }
}
