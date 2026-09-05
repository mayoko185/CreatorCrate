using OpenLocally;
using System.Reflection;
using System.Text.Json;

namespace OpenLocally.Tests;

public sealed class PatreonSocialPreparationAdapterTests
{
    [Theory]
    [InlineData("{\"nodeId\":12,\"backendNodeId\":0,\"nodeName\":\"BUTTON\"}", "invalid_candidate_identity")]
    [InlineData("{\"nodeId\":0,\"backendNodeId\":120,\"nodeName\":\"BUTTON\"}", "invalid_candidate_identity")]
    [InlineData("{\"nodeId\":13,\"backendNodeId\":130,\"nodeName\":\"BUTTON\"}", "invalid_candidate_identity")]
    [InlineData("{\"nodeId\":12,\"backendNodeId\":20,\"nodeName\":\"BUTTON\"}", "invalid_candidate_identity")]
    [InlineData("{}", "malformed_description")]
    [InlineData("{\"nodeId\":12,\"backendNodeId\":0}", "malformed_description")]
    public async Task CreateResolution_DescriptionIdentityFailurePreservesParserAndPrivateFullReport(string description, string outcome)
    {
        var fixture = new ProductionFixture { CreateCandidatesResponse = new { nodeIds = new[] { 2, 12 } } };
        fixture.CreateDescriptions[12] = JsonDocument.Parse(description).RootElement.Clone();
        var (targets, transport, socket) = ProductionTargets(fixture);
        await using (transport)
        {
            var error = await Assert.ThrowsAsync<BrowserPreparationException>(() => ProductionAdapter(fixture).PrepareAsync(
                new PlatformPreparationContext("patreon", "private-title", "private-body", [], targets), new Progress(), CancellationToken.None));
            Assert.Equal(BrowserPreparationFailure.InvalidNode, error.Failure);
            Assert.Equal(new BrowserPreparationException(BrowserPreparationFailure.InvalidNode).Message, error.Message);
            Assert.Null(error.InnerException);
            var diagnostic = Assert.IsType<SocialPreparationDiagnostic>(error.SocialDiagnostic);
            Assert.False(diagnostic.CreateResolution!.Complete);
            Assert.Equal(2, diagnostic.CreateResolution.CandidateCount);
            Assert.Equal(1, diagnostic.CreateResolution.InspectedCount);
            Assert.Equal(1, diagnostic.CreateResolution.UsableCount);
            Assert.Equal(0, diagnostic.CreateResolution.LayoutRejectedCount);
            var formatter = typeof(CommandDispatcher).GetMethod("ManualFailure", BindingFlags.NonPublic | BindingFlags.Static)!;
            var dispatch = (CommandDispatchResult)formatter.Invoke(null,
                new object?[] { "patreon", "platform_preparation_failed", error, null })!;
            foreach (string report in new[] { diagnostic.Serialize(), diagnostic.FormatForDisplay(), dispatch.Detail! })
            {
                Assert.Contains(outcome, report);
                foreach (string secret in new[] { "nodeId", "backendNodeId", "patreon-session", "patreon-fixture", "private-title", "private-body" })
                    Assert.DoesNotContain(secret, report);
                // Counts remain allowed; these distinct candidate/description identities do not.
                Assert.DoesNotMatch(@"\b(12|13|20|120|130)\b", report);
            }
            string[] resolution = socket.Sent.SkipWhile(command => !command.Contains("DOM.querySelectorAll") || !command.Contains("create-content-button")).ToArray();
            Assert.Single(resolution.Where(command => Method(command) == "DOM.querySelectorAll"));
            var descriptions = resolution.Where(command => Method(command) == "DOM.describeNode")
                .Select(command => JsonDocument.Parse(command).RootElement.GetProperty("params").GetProperty("nodeId").GetInt32()).ToArray();
            Assert.Equal(new[] { 2, 12 }, descriptions); // Exactly once per candidate; no retry or fallback.
            Assert.Equal(0, fixture.PostLookupCount);
            Assert.DoesNotContain(socket.Sent, command => Method(command) is "DOM.scrollIntoViewIfNeeded" or "Input.dispatchMouseEvent");
        }
    }

    [Theory]
    [InlineData("root_unavailable", null, null, null, null, false)]
    [InlineData("zero_matches", 0, 0, 0, 0, true)]
    [InlineData("no_usable_candidate", 2, 2, 0, 2, true)]
    [InlineData("ambiguous", 2, 2, 2, 0, true)]
    [InlineData("candidate_limit_exceeded", null, null, null, null, false)]
    [InlineData("malformed_query", null, null, null, null, false)]
    [InlineData("invalid_candidate_identity", 2, 0, 0, 0, false)]
    [InlineData("malformed_description", 2, 1, 1, 0, false)]
    [InlineData("stale_description", 2, 1, 1, 0, false)]
    [InlineData("malformed_geometry", 2, 1, 1, 0, false)]
    [InlineData("unique_candidate", 2, 2, 1, 1, true)]
    public async Task CreateResolution_ProductionDiagnosticRetainsSafeReasonAndCounts(string outcome,
        int? candidates, int? inspected, int? usable, int? rejected, bool complete)
    {
        var fixture = new ProductionFixture { CreateCandidatesResponse = new { nodeIds = new[] { 2, 12 } } };
        switch (outcome)
        {
            case "root_unavailable": fixture.RootUnavailableAfterHome = true; break;
            case "zero_matches": fixture.CreateCandidatesResponse = new { nodeIds = Array.Empty<int>() }; break;
            case "no_usable_candidate":
                fixture.UnavailableCreateBox = 120;
                fixture.ResolutionErrorMethod = "DOM.getBoxModel";
                fixture.ResolutionErrorIdentity = 20;
                fixture.ResolutionErrorMessage = "Could not compute box model";
                break;
            case "candidate_limit_exceeded": fixture.CreateCandidatesResponse = new { nodeIds = Enumerable.Range(2, 17).ToArray() }; break;
            case "malformed_query": fixture.CreateCandidatesResponse = new { nodeIds = "private-selector" }; break;
            case "invalid_candidate_identity": fixture.CreateCandidatesResponse = new { nodeIds = new[] { 2, 2 } }; break;
            case "malformed_description": fixture.CreateDescriptions[12] = new { }; break;
            case "stale_description":
                fixture.ResolutionErrorMethod = "DOM.describeNode";
                fixture.ResolutionErrorIdentity = 12;
                fixture.ResolutionErrorMessage = "Could not find node with given id";
                break;
            case "malformed_geometry": fixture.CreateBoxes[120] = new { }; break;
            case "unique_candidate":
                fixture.UnavailableCreateBox = 120;
                fixture.PostAvailableAfterCreate = false;
                fixture.CancelOnFirstDelay = true;
                break;
        }
        var (targets, transport, socket) = ProductionTargets(fixture);
        await using (transport)
        {
            Exception? error = await Record.ExceptionAsync(() => ProductionAdapter(fixture).PrepareAsync(
                new PlatformPreparationContext("patreon", "private-title", "private-body", [], targets), new Progress(), CancellationToken.None));
            SocialPreparationDiagnostic diagnostic;
            if (outcome is "root_unavailable" or "zero_matches" or "no_usable_candidate" or "stale_description" or "unique_candidate")
            {
                var runtime = Assert.IsType<SocialPreparationRuntimeException>(error);
                if (outcome != "unique_candidate") Assert.Equal("patreon_create_control_missing", runtime.Code);
                diagnostic = Assert.IsType<SocialPreparationDiagnostic>(runtime.Diagnostic);
            }
            else
            {
                var browser = Assert.IsType<BrowserPreparationException>(error);
                Assert.Equal(BrowserPreparationFailure.InvalidNode, browser.Failure);
                diagnostic = Assert.IsType<SocialPreparationDiagnostic>(browser.SocialDiagnostic);
            }
            using JsonDocument json = JsonDocument.Parse(diagnostic.Serialize());
            JsonElement evidence = json.RootElement.GetProperty("create_resolution");
            Assert.Equal(outcome, evidence.GetProperty("outcome").GetString());
            Assert.Equal("create_resolution", evidence.GetProperty("stage").GetString());
            Assert.Equal(complete, evidence.GetProperty("complete").GetBoolean());
            Assert.Equal(outcome == "candidate_limit_exceeded", evidence.GetProperty("limit_exceeded").GetBoolean());
            Assert.Equal(16, evidence.GetProperty("candidate_limit").GetInt32());
            foreach ((string key, int? count) in new[] { ("candidate_count", candidates), ("inspected_count", inspected),
                ("usable_count", usable), ("layout_rejected_count", rejected) })
            {
                if (count is null) Assert.False(evidence.TryGetProperty(key, out _));
                else Assert.Equal(count, evidence.GetProperty(key).GetInt32());
            }
            string display = diagnostic.FormatForDisplay();
            Assert.Contains($"outcome: {outcome}", display);
            Assert.Contains($"complete: {(complete ? "yes" : "no")}", display);
            Assert.Equal(outcome == "unique_candidate" ? "timeout" : "browser_preparation", diagnostic.ErrorClass);
            foreach (string secret in new[] { "private-title", "private-body", "private-selector", "private-node", "patreon-session", "patreon-fixture", "backendNodeId", "nodeId", "https://" })
            {
                Assert.DoesNotContain(secret, display);
                Assert.DoesNotContain(secret, diagnostic.Serialize());
            }
            if (outcome != "unique_candidate")
            {
                Assert.Equal(0, fixture.PostLookupCount);
                Assert.DoesNotContain(socket.Sent, command => Method(command) is "DOM.scrollIntoViewIfNeeded" or "Input.dispatchMouseEvent");
            }
            if (outcome is "candidate_limit_exceeded" or "malformed_query" or "invalid_candidate_identity")
            {
                string[] afterQuery = socket.Sent.SkipWhile(command => !command.Contains("DOM.querySelectorAll") || !command.Contains("create-content-button")).Skip(1).ToArray();
                Assert.DoesNotContain(afterQuery, command => Method(command) == "DOM.describeNode");
            }
        }
    }

    [Theory]
    [InlineData("unknown fixture failure")]
    [InlineData("Node does not have a layout object")]
    public async Task CreateResolution_PreflightCdpErrorRemainsAuthoritativeInFullReport(string message)
    {
        var fixture = new ProductionFixture
        {
            CreateCandidatesResponse = new { nodeIds = new[] { 2, 12 } },
            ResolutionErrorMethod = "DOM.getBoxModel", ResolutionErrorIdentity = 120, ResolutionErrorMessage = message,
        };
        var (targets, transport, socket) = ProductionTargets(fixture);
        await using (transport)
        {
            var error = await Assert.ThrowsAsync<CdpCommandException>(() => ProductionAdapter(fixture).PrepareAsync(
                new PlatformPreparationContext("patreon", "Title", "Body", [], targets), new Progress(), CancellationToken.None));
            Assert.Equal(-32000, error.Code);
            Assert.Equal(message, error.Message);
            var diagnostic = Assert.IsType<SocialPreparationDiagnostic>(error.SocialDiagnostic);
            Assert.Equal("cdp_command", diagnostic.ErrorClass);
            Assert.Equal("get_box_model", diagnostic.CdpOperation);
            Assert.Equal(message, diagnostic.CdpMessage);
            Assert.Contains(message, diagnostic.FormatForDisplay());
            Assert.Null(diagnostic.CreateResolution!.Outcome);
            Assert.False(diagnostic.CreateResolution.Complete);
            Assert.Equal(1, diagnostic.CreateResolution.InspectedCount);
            Assert.DoesNotContain(socket.Sent, command => Method(command) is "DOM.scrollIntoViewIfNeeded" or "Input.dispatchMouseEvent");
        }
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task CreateResolution_ProductionCancellationKeepsCallerAndDeadlineContracts(bool deadline)
    {
        using var caller = new CancellationTokenSource();
        var fixture = new ProductionFixture
        {
            ResolutionErrorMethod = "DOM.querySelectorAll", ResolutionDeadlineCancellation = deadline,
            ResolutionCancellation = deadline ? null : caller,
        };
        var (targets, transport, socket) = ProductionTargets(fixture);
        await using (transport)
        {
            Task<PlatformPreparationResult> attempt = ProductionAdapter(fixture).PrepareAsync(
                new PlatformPreparationContext("patreon", "Title", "Body", [], targets), new Progress(), caller.Token);
            if (deadline)
            {
                var error = await Assert.ThrowsAsync<SocialPreparationRuntimeException>(() => attempt);
                Assert.Equal("patreon_create_control_missing", error.Code);
                Assert.Equal("timeout", error.Diagnostic!.ErrorClass);
                Assert.False(error.Diagnostic.CreateResolution!.Complete);
                Assert.Null(error.Diagnostic.CreateResolution.Outcome);
                Assert.Null(error.Diagnostic.CreateResolution.CandidateCount);
            }
            else await Assert.ThrowsAnyAsync<OperationCanceledException>(() => attempt);
            Assert.DoesNotContain(socket.Sent, command => Method(command) is "DOM.scrollIntoViewIfNeeded" or "Input.dispatchMouseEvent");
            Assert.Single(socket.Sent.Where(command => command.Contains("DOM.querySelectorAll") && command.Contains("create-content-button")));
        }
    }

    [Theory]
    [InlineData("[]")]
    [InlineData("null")]
    [InlineData("{\"nodeId\":\"private-node\"}")]
    public async Task CreateResolution_MistypedDescriptionRetainsOriginalJsonFailure(string description)
    {
        var fixture = new ProductionFixture { CreateCandidatesResponse = new { nodeIds = new[] { 2, 12 } } };
        fixture.CreateDescriptions[12] = JsonDocument.Parse(description).RootElement.Clone();
        var (targets, transport, socket) = ProductionTargets(fixture);
        await using (transport)
        {
            var error = await Assert.ThrowsAsync<SocialPreparationRuntimeException>(() => ProductionAdapter(fixture).PrepareAsync(
                new PlatformPreparationContext("patreon", "Title", "Body", [], targets), new Progress(), CancellationToken.None));
            Assert.IsType<InvalidOperationException>(error.InnerException);
            Assert.Equal("platform_preparation_failed", error.Code);
            Assert.Equal("unexpected", error.Diagnostic!.ErrorClass);
            Assert.Equal(PatreonCreateResolutionOutcome.MalformedDescription, error.Diagnostic.CreateResolution!.Outcome);
            Assert.False(error.Diagnostic.CreateResolution.Complete);
            Assert.Equal(1, error.Diagnostic.CreateResolution.InspectedCount);
            Assert.DoesNotContain("private-node", error.Diagnostic.FormatForDisplay());
            Assert.DoesNotContain(socket.Sent, command => Method(command) is "DOM.scrollIntoViewIfNeeded" or "Input.dispatchMouseEvent");
        }
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task CreateResolution_InspectsEveryCandidateAndSelectsUniqueLayout(bool reversed)
    {
        var fixture = new ProductionFixture
        {
            CreateCandidatesResponse = new { nodeIds = reversed ? new[] { 2, 12 } : new[] { 12, 2 } },
            UnavailableCreateBox = 120,
        };
        var (targets, transport, socket) = ProductionTargets(fixture);
        await using (transport)
        await using (var page = new PatreonPreparationPage(targets, "creator", fixture.Timing))
        {
            await page.NavigateAndWaitForHomeAsync(CancellationToken.None);
            int start = socket.Sent.Count;
            int foundAt = -1;
            Assert.True(await page.ActivateCreateAsync(() => foundAt = socket.Sent.Count, CancellationToken.None));
            JsonElement[] commands = socket.Sent.Skip(start).Select(text => JsonDocument.Parse(text).RootElement.Clone()).ToArray();
            Assert.Equal(new[] { "DOM.getDocument", "DOM.querySelectorAll", "DOM.describeNode", "DOM.getBoxModel",
                "DOM.describeNode", "DOM.getBoxModel", "DOM.scrollIntoViewIfNeeded", "DOM.getBoxModel",
                "Input.dispatchMouseEvent", "Input.dispatchMouseEvent" }, commands.Select(Method));
            Assert.Equal(start + 6, foundAt);
            Assert.Equal(PatreonCreateResolutionOutcome.UniqueCandidate, page.CreateResolution!.Outcome);
            Assert.True(page.CreateResolution.Complete);
            Assert.Equal(2, page.CreateResolution.InspectedCount);
            Assert.Equal(1, page.CreateResolution.UsableCount);
            Assert.Equal(20, commands[6].GetProperty("params").GetProperty("backendNodeId").GetInt64());
            Assert.Equal("mousePressed", commands[8].GetProperty("params").GetProperty("type").GetString());
            Assert.Equal("mouseReleased", commands[9].GetProperty("params").GetProperty("type").GetString());
        }
    }

    [Theory]
    [InlineData("{}")] [InlineData("[]")] [InlineData("{\"nodeIds\":{}}")] [InlineData("{\"nodeIds\":null}")]
    [InlineData("{\"nodeIds\":[0]}")] [InlineData("{\"nodeIds\":[-1]}")] [InlineData("{\"nodeIds\":[1.5]}")]
    [InlineData("{\"nodeIds\":[2,2]}")] [InlineData("{\"nodeIds\":[2,\"bad\"]}")]
    [InlineData("{\"nodeIds\":[2,null]}")]
    public async Task CreateResolution_RejectsEntireMalformedListBeforeDescriptions(string json)
    {
        var fixture = new ProductionFixture { CreateCandidatesResponse = JsonDocument.Parse(json).RootElement.Clone() };
        await AssertCreateResolutionFailsAsync(fixture, noDescriptions: true);
    }

    [Fact]
    public async Task CreateResolution_CeilingIsNotPrefixSelection()
    {
        int limit = IntConstant(typeof(PatreonPreparationPage), "CreateCandidateLimit");
        var fixture = new ProductionFixture { CreateCandidatesResponse = new { nodeIds = Enumerable.Range(2, limit + 1).ToArray() } };
        await AssertCreateResolutionFailsAsync(fixture, noDescriptions: true);
    }

    [Theory]
    [InlineData("zero")] [InlineData("none")] [InlineData("ambiguous")]
    public async Task CreateResolution_RequiresExactlyOneUsableCandidate(string state)
    {
        var fixture = new ProductionFixture { CreateCandidatesResponse = new { nodeIds = state == "zero" ? Array.Empty<int>() : new[] { 2, 12 } } };
        if (state == "none")
        {
            fixture.UnavailableCreateBox = 120;
            fixture.CreateBoxes[20] = new { width = 0, height = 0, border = new int[8] };
        }
        await AssertCreateResolutionFailsAsync(fixture, returnsFalse: state != "ambiguous");
    }

    [Theory]
    [InlineData("{}")] [InlineData("{\"nodeId\":12,\"backendNodeId\":0,\"nodeName\":\"BUTTON\"}")]
    [InlineData("{\"nodeId\":13,\"backendNodeId\":130,\"nodeName\":\"BUTTON\"}")]
    [InlineData("{\"nodeId\":12,\"backendNodeId\":20,\"nodeName\":\"BUTTON\"}")]
    public async Task CreateResolution_MalformedLaterDescriptionNeverActivatesEarlierCandidate(string json)
    {
        var fixture = new ProductionFixture { CreateCandidatesResponse = new { nodeIds = new[] { 2, 12 } } };
        fixture.CreateDescriptions[12] = JsonDocument.Parse(json).RootElement.Clone();
        var evidence = await AssertCreateResolutionFailsAsync(fixture);
        using JsonDocument description = JsonDocument.Parse(json);
        bool invalidIdentity = description.RootElement.TryGetProperty("backendNodeId", out _);
        Assert.Equal(invalidIdentity ? PatreonCreateResolutionOutcome.InvalidCandidateIdentity : PatreonCreateResolutionOutcome.MalformedDescription, evidence.Outcome);
        Assert.Equal(1, evidence.InspectedCount);
        Assert.False(evidence.Complete);
    }

    [Theory]
    [InlineData("{}")] [InlineData("[]")] [InlineData("{\"border\":[0,0]}")]
    [InlineData("{\"border\":[0,0,20,0,20,20,0,\"bad\"]}")]
    [InlineData("{\"border\":[0,0,20,0,20,20,0,1e400]}")]
    [InlineData("{\"border\":[0,0,20,0,20,20,0,20],\"width\":1e400}")]
    [InlineData("{\"border\":[0,0,20,0,20,20,0,20],\"height\":\"bad\"}")]
    [InlineData("{\"border\":[1e308,0,1e308,0,1e308,20,1e308,20]}")]
    public async Task CreateResolution_MalformedLaterGeometryNeverActivatesEarlierCandidate(string json)
    {
        var fixture = new ProductionFixture { CreateCandidatesResponse = new { nodeIds = new[] { 2, 12 } } };
        fixture.CreateBoxes[120] = JsonDocument.Parse(json).RootElement.Clone();
        await AssertCreateResolutionFailsAsync(fixture);
    }

    [Theory]
    [InlineData("DOM.describeNode", true)] [InlineData("DOM.describeNode", false)]
    [InlineData("DOM.getBoxModel", false)]
    public async Task CreateResolution_StaleAbortsAndUnknownErrorsPropagateWithoutRetry(string method, bool stale)
    {
        var fixture = new ProductionFixture { CreateCandidatesResponse = new { nodeIds = new[] { 2, 12 } } };
        var (targets, transport, socket) = ProductionTargets(fixture);
        await using (transport)
        await using (var page = new PatreonPreparationPage(targets, "creator", fixture.Timing))
        {
            await page.NavigateAndWaitForHomeAsync(CancellationToken.None);
            fixture.ResolutionErrorMethod = method;
            fixture.ResolutionErrorIdentity = method == "DOM.describeNode" ? 12 : 120;
            fixture.ResolutionErrorMessage = stale ? "Could not find node with given id" : "unknown fixture failure";
            int start = socket.Sent.Count;
            if (stale) Assert.False(await page.ActivateCreateAsync(null, CancellationToken.None));
            else Assert.Equal(fixture.ResolutionErrorMessage, (await Assert.ThrowsAsync<CdpCommandException>(() => page.ActivateCreateAsync(null, CancellationToken.None))).Message);
            Assert.Equal(2, socket.Sent.Skip(start).Count(command => Method(command) == method));
            Assert.DoesNotContain(socket.Sent, command => Method(command) is "DOM.scrollIntoViewIfNeeded" or "Input.dispatchMouseEvent");
        }
    }

    [Fact]
    public async Task CreateResolution_CancellationPropagatesWithoutActivationOrRetry()
    {
        var fixture = new ProductionFixture();
        var (targets, transport, socket) = ProductionTargets(fixture);
        await using (transport)
        await using (var page = new PatreonPreparationPage(targets, "creator", fixture.Timing))
        using (var cancellation = new CancellationTokenSource())
        {
            await page.NavigateAndWaitForHomeAsync(CancellationToken.None);
            fixture.ResolutionCancellation = cancellation;
            fixture.ResolutionErrorMethod = "DOM.querySelectorAll";
            int start = socket.Sent.Count;
            await Assert.ThrowsAnyAsync<OperationCanceledException>(() => page.ActivateCreateAsync(null, cancellation.Token));
            Assert.Single(socket.Sent.Skip(start).Where(command => Method(command) == "DOM.querySelectorAll"));
            Assert.DoesNotContain(socket.Sent, command => Method(command) is "DOM.scrollIntoViewIfNeeded" or "Input.dispatchMouseEvent");
        }
    }

    private static async Task<PatreonCreateResolutionEvidence> AssertCreateResolutionFailsAsync(ProductionFixture fixture, bool returnsFalse = false, bool noDescriptions = false)
    {
        var (targets, transport, socket) = ProductionTargets(fixture);
        await using (transport)
        await using (var page = new PatreonPreparationPage(targets, "creator", fixture.Timing))
        {
            await page.NavigateAndWaitForHomeAsync(CancellationToken.None);
            int start = socket.Sent.Count;
            bool found = false;
            if (returnsFalse) Assert.False(await page.ActivateCreateAsync(() => found = true, CancellationToken.None));
            else await Assert.ThrowsAsync<BrowserPreparationException>(() => page.ActivateCreateAsync(() => found = true, CancellationToken.None));
            Assert.False(found);
            Assert.Equal(0, fixture.PostLookupCount);
            Assert.DoesNotContain(socket.Sent, command => Method(command) is "DOM.scrollIntoViewIfNeeded" or "Input.dispatchMouseEvent");
            if (noDescriptions) Assert.DoesNotContain(socket.Sent.Skip(start), command => Method(command) == "DOM.describeNode");
            var evidence = Assert.IsType<PatreonCreateResolutionEvidence>(page.CreateResolution);
            Assert.NotNull(evidence.Outcome);
            return evidence;
        }
    }

    [Fact]
    public async Task CreateResolution_ZeroCandidatesPreservesCreateMissingFailure()
    {
        var fixture = new ProductionFixture { CreateCandidatesResponse = new { nodeIds = Array.Empty<int>() } };
        var (targets, transport, socket) = ProductionTargets(fixture);
        await using (transport)
        {
            SocialPreparationRuntimeException error = await Assert.ThrowsAsync<SocialPreparationRuntimeException>(() =>
                ProductionAdapter(fixture).PrepareAsync(new PlatformPreparationContext("patreon", "Title", "Body", [], targets), new Progress(), CancellationToken.None));
            Assert.Equal("patreon_create_control_missing", error.Code);
            Assert.Equal(0, fixture.PostLookupCount);
            Assert.DoesNotContain(socket.Sent, command => Method(command) is "DOM.scrollIntoViewIfNeeded" or "Input.dispatchMouseEvent");
        }
    }

    [Fact]
    public async Task AuthenticatedDashboard_PreparesExactOwnedFieldsAndRelinquishes()
    {
        var page = new FakePage();
        var progress = new Progress();
        PlatformPreparationContext context = Context(title: "Release title", body: "One\n\nTwo ✓");

        PlatformPreparationResult result = await Adapter(page).PrepareAsync(context, progress, CancellationToken.None);

        Assert.Equal(PlatformPreparationOutcome.Prepared, result.Outcome);
        Assert.Equal(context.Title, page.Composer.ReplacedTitle);
        Assert.Equal(context.Body, page.Composer.ReplacedBody);
        Assert.Equal([SocialPreparationProgress.Preparing], progress.Values);
        Assert.Equal(["create", "post"], page.Activations);
        Assert.True(page.Relinquished);
        Assert.False(page.Abandoned);
        Assert.Empty(page.SettingsMutations);
        Assert.False(page.Composer.PublishActivated);
    }

    [Theory]
    [InlineData("AuthenticationRequired")]
    [InlineData("ManualAttentionRequired")]
    public async Task ExplicitAuthenticationOrManualAttention_PreservesTheUsefulPage(string state)
    {
        var page = new FakePage { Home = Enum.Parse<PatreonHomeState>(state) };

        PlatformPreparationResult result = await Adapter(page).PrepareAsync(Context(), new Progress(), CancellationToken.None);

        Assert.Equal(PlatformPreparationOutcome.AuthenticationRequired, result.Outcome);
        Assert.True(page.Relinquished);
        Assert.False(page.Abandoned);
        Assert.Empty(page.Activations);
    }

    [Theory]
    [InlineData("TimedOut", true, true, "patreon_home_timeout")]
    [InlineData("Authenticated", false, true, "patreon_create_control_missing")]
    [InlineData("Authenticated", true, false, "patreon_post_control_missing")]
    public async Task NavigationAndMenuFailures_AreCurated(string state, bool create, bool post, string code)
    {
        var page = new FakePage { Home = Enum.Parse<PatreonHomeState>(state), CreateAvailable = create, PostAvailable = post };
        await AssertFailureAsync(page, code);
        Assert.False(page.AuthenticationClassified);
    }

    [Fact]
    public async Task UnknownComposer_FailsRatherThanBeingClassifiedAsAuthentication()
    {
        var page = new FakePage { ComposerAvailable = false };

        await AssertFailureAsync(page, "patreon_composer_missing");

        Assert.False(page.AuthenticationClassified);
        Assert.True(page.Abandoned);
    }

    [Fact]
    public async Task ManualDiagnostic_MissingPostRecordsCurrentPreComposerCheckpoints()
    {
        var page = new FakePage { PostAvailable = false };
        var diagnostic = new PatreonManualPreparationDiagnostic();

        SocialPreparationRuntimeException error = await Assert.ThrowsAsync<SocialPreparationRuntimeException>(
            () => Adapter(page, diagnostic).PrepareAsync(Context(), new Progress(), CancellationToken.None));

        Assert.Equal("patreon_post_control_missing", error.Code);
        Assert.Equal(
            "patreon_manual_trace;creator_page_ready=1;create_found=1;create_activated=1;post_found=0;post_activated=0;composer_route_observed=0;create_activation_stage=not_started;create_activation_error_class=none;create_activation_cdp_method=none;create_activation_cdp_code=unknown;create_activation_cdp_message=none;original_target_present=unknown;replacement_target_appeared=unknown;error=patreon_post_control_missing",
            diagnostic.Format(error.Code));
    }

    [Fact]
    public async Task ManualDiagnostic_MissingCreateStopsAtCreatorPage()
    {
        var page = new FakePage { CreateAvailable = false };
        var diagnostic = new PatreonManualPreparationDiagnostic();

        SocialPreparationRuntimeException error = await Assert.ThrowsAsync<SocialPreparationRuntimeException>(
            () => Adapter(page, diagnostic).PrepareAsync(Context(), new Progress(), CancellationToken.None));

        Assert.Equal("patreon_create_control_missing", error.Code);
        Assert.Equal(
            "patreon_manual_trace;creator_page_ready=1;create_found=0;create_activated=0;post_found=0;post_activated=0;composer_route_observed=0;create_activation_stage=not_started;create_activation_error_class=none;create_activation_cdp_method=none;create_activation_cdp_code=unknown;create_activation_cdp_message=none;original_target_present=unknown;replacement_target_appeared=unknown;error=patreon_create_control_missing",
            diagnostic.Format(error.Code));
    }

    [Fact]
    public async Task ManualDiagnostic_MissingComposerRecordsSuccessfulPostActivation()
    {
        var page = new FakePage { ComposerAvailable = false };
        var diagnostic = new PatreonManualPreparationDiagnostic();

        SocialPreparationRuntimeException error = await Assert.ThrowsAsync<SocialPreparationRuntimeException>(
            () => Adapter(page, diagnostic).PrepareAsync(Context(), new Progress(), CancellationToken.None));

        Assert.Equal("patreon_composer_missing", error.Code);
        Assert.Contains("post_found=1;post_activated=1;composer_route_observed=0", diagnostic.Format(error.Code));
    }

    [Fact]
    public async Task ManualDiagnostic_SuccessfulComposerRouteIsObserved()
    {
        var diagnostic = new PatreonManualPreparationDiagnostic();

        PlatformPreparationResult result = await Adapter(new FakePage(), diagnostic).PrepareAsync(Context(), new Progress(), CancellationToken.None);

        Assert.Equal(PlatformPreparationOutcome.Prepared, result.Outcome);
        Assert.Contains("composer_route_observed=1", diagnostic.Format("manual_patreon_validation_failed"));
    }

    [Fact]
    public void ManualDiagnostic_StableErrorCodeAcceptsValidValuesThroughInclusiveBound()
    {
        var diagnostic = new PatreonManualPreparationDiagnostic();
        int maximumErrorCodeLength = IntConstant(typeof(PatreonManualPreparationDiagnostic), "StableErrorCodeMaxLength");
        const string normalCode = "patreon_post_control_missing";
        string maximumLengthCode = new('a', maximumErrorCodeLength);

        Assert.EndsWith($"error={normalCode}", diagnostic.Format(normalCode));
        Assert.EndsWith($"error={maximumLengthCode}", diagnostic.Format(maximumLengthCode));
    }

    [Fact]
    public void ManualDiagnostic_StableErrorCodeRejectsOverlongAndInvalidValuesWithBoundedTrace()
    {
        var diagnostic = new PatreonManualPreparationDiagnostic();
        int maximumErrorCodeLength = IntConstant(typeof(PatreonManualPreparationDiagnostic), "StableErrorCodeMaxLength");
        int maximumTraceLength = IntConstant(typeof(PatreonManualPreparationDiagnostic), "MaximumTraceLength");
        const string fallbackCode = "manual_patreon_validation_failed";
        string fallbackTrace = diagnostic.Format(fallbackCode);
        string maximumTrace = diagnostic.Format(new string('a', maximumErrorCodeLength));
        string veryLargeCode = new('a', 4096);
        string veryLargeTrace = diagnostic.Format(veryLargeCode);

        Assert.Equal(fallbackTrace, diagnostic.Format(new string('a', maximumErrorCodeLength + 1)));
        Assert.Contains($"error={fallbackCode}", veryLargeTrace);
        Assert.DoesNotContain(veryLargeCode, veryLargeTrace, StringComparison.Ordinal);
        Assert.True(veryLargeTrace.Length <= maximumTrace.Length);
        Assert.True(maximumTrace.Length <= maximumTraceLength);
        foreach (string invalidCode in new[] { "contains space", "contains\nnewline", "contains/slash", "https://example.test/error", "Exception: failure" })
            Assert.Equal(fallbackTrace, diagnostic.Format(invalidCode));
    }

    [Fact]
    public async Task ExactTitleAndBody_AreInsertedWithoutNormalization()
    {
        string title = "  Title ✓  ";
        string body = "  leading\n\nEmoji 😀\n\ntrailing  ";
        var page = new FakePage();

        await Adapter(page).PrepareAsync(Context(title, body), new Progress(), CancellationToken.None);

        Assert.Equal(title, page.Composer.ReplacedTitle);
        Assert.Equal(body, page.Composer.ReplacedBody);
    }

    [Fact]
    public async Task EmptyTitleAndOrdinalReadbackMismatches_NeverPrepare()
    {
        await AssertFailureAsync(new FakePage(), "patreon_prepared_assertion_failed", title: "", body: "");

        var titleMismatch = new FakePage();
        titleMismatch.Composer.TitleMatches = false;
        await AssertFailureAsync(titleMismatch, "patreon_title_mismatch");

        var bodyMismatch = new FakePage();
        bodyMismatch.Composer.BodyMatches = false;
        await AssertFailureAsync(bodyMismatch, "patreon_body_mismatch");
    }

    [Fact]
    public async Task EmptyBody_IsValidWhenEveryOtherComposerAssertionPasses()
    {
        var page = new FakePage();

        PlatformPreparationResult result = await Adapter(page).PrepareAsync(Context(body: ""), new Progress(), CancellationToken.None);

        Assert.Equal(PlatformPreparationOutcome.Prepared, result.Outcome);
        Assert.Equal("", page.Composer.ReplacedBody);
    }

    [Fact]
    public void PatreonBodyReader_ReconstructsParagraphsAndExcludesThePaywall()
    {
        JsonElement editor = Editor(
            NonEditable("Paid members only"),
            Paragraph(Text("Patreon CreatorCrate test")),
            Paragraph(Text("Unicode check ✓")));

        Assert.True(PatreonComposer.TryReadExactBody(editor, out string? body));
        Assert.Equal("Patreon CreatorCrate test\n\nUnicode check ✓", body);
    }

    [Fact]
    public void PatreonBodyReader_PreservesRepeatedBlankLinesWhitespaceAndUnicodeOrdinally()
    {
        JsonElement editor = Editor(
            Paragraph(Text("  leading")),
            Paragraph(),
            Paragraph(Br()),
            Paragraph(Text("surrogate 😀  ")));

        Assert.True(PatreonComposer.TryReadExactBody(editor, out string? body));
        Assert.Equal("  leading\n\n\n\n\n\n\nsurrogate 😀  ", body);
    }

    [Fact]
    public void PatreonBodyReader_FailsClosedForMalformedOrUnreadableStructures()
    {
        JsonElement directSpan = Editor(Element("SPAN", Text("not an authored paragraph")));
        JsonElement missingChildren = JsonDocument.Parse("{\"nodeName\":\"DIV\",\"attributes\":[\"contenteditable\",\"true\"]}").RootElement.Clone();
        JsonElement mixedBreak = Editor(Paragraph(Text("one"), Br(), Text("two")));

        Assert.False(PatreonComposer.TryReadExactBody(directSpan, out _));
        Assert.False(PatreonComposer.TryReadExactBody(missingChildren, out _));
        Assert.True(PatreonComposer.TryReadExactBody(mixedBreak, out string? body));
        Assert.Equal("one\ntwo", body);
    }

    [Theory]
    [InlineData(@"C:\media\image.jpg", true)]
    [InlineData(@"C:\media\image.JPEG", true)]
    [InlineData(@"C:\media\image.avif", true)]
    [InlineData(@"C:\media\clip.mp4", false)]
    [InlineData(@"C:\media\audio.mp3", false)]
    [InlineData(@"C:\media\unknown.bin", false)]
    public void VerifiedImagePathClassification_DoesNotMisrouteUnverifiedMedia(string path, bool expected)
    {
        Assert.Equal(expected, PatreonComposer.IsVerifiedImagePath(path));
    }

    [Fact]
    public async Task ZeroOneAndMultipleImages_UsePersistentInputInExactCallerOrder()
    {
        var zero = new FakePage();
        await Adapter(zero).PrepareAsync(Context(media: []), new Progress(), CancellationToken.None);
        Assert.Empty(zero.Composer.AssignedPaths);
        Assert.DoesNotContain(SocialPreparationProgress.Uploading, zero.Progress.Values);

        string[] one = [@"C:\media\one.png"];
        var onePage = new FakePage();
        await Adapter(onePage).PrepareAsync(Context(media: one), new Progress(), CancellationToken.None);
        Assert.Equal(one, onePage.Composer.AssignedPaths);
        Assert.True(onePage.Composer.PersistentPhotosInputAssigned);

        string[] many = [@"C:\media\first.png", @"C:\media\second.webp", @"C:\media\third.heic"];
        var manyPage = new FakePage();
        var manyProgress = new Progress();
        await Adapter(manyPage).PrepareAsync(Context(media: many), manyProgress, CancellationToken.None);
        Assert.Equal(many, manyPage.Composer.AssignedPaths);
        Assert.Equal([0, 1, 2, 3, 3, 3, 3, 3], manyPage.Composer.IntendedCounts);
        Assert.Equal([SocialPreparationProgress.Preparing, SocialPreparationProgress.Uploading], manyProgress.Values);
    }

    [Fact]
    public async Task UnsupportedAndMissingOrFailedImageInput_NeverPrepare()
    {
        var unsupported = new FakePage();
        unsupported.Composer.Assignment = PatreonMediaAssignment.UnsupportedType;
        await AssertFailureAsync(unsupported, "patreon_media_unsupported_type", media: [@"C:\media\one.png", @"C:\media\unverified.mp4"]);
        Assert.Empty(unsupported.Composer.AssignedPaths);

        var missing = new FakePage();
        missing.Composer.Assignment = PatreonMediaAssignment.InputMissing;
        await AssertFailureAsync(missing, "patreon_media_input_missing", media: [@"C:\media\one.png"]);

        var failed = new FakePage();
        failed.Composer.Assignment = PatreonMediaAssignment.Failed;
        await AssertFailureAsync(failed, "patreon_media_assignment_failed", media: [@"C:\media\one.png"]);
    }

    [Fact]
    public async Task MediaReadiness_RequiresStableRenderedSavedOrderedPreviews()
    {
        var page = new FakePage();
        page.Composer.Readiness = [NotReady() with { PreviewCountMatches = false }, Ready(), Ready(), Ready(), Ready()];

        PlatformPreparationResult result = await Adapter(page).PrepareAsync(Context(media: [@"C:\media\one.png"]), new Progress(), CancellationToken.None);

        Assert.Equal(PlatformPreparationOutcome.Prepared, result.Outcome);
        Assert.Equal(6, page.Composer.ReadinessCalls);
    }

    [Theory]
    [InlineData(false, true, true, false, false, true, "patreon_media_preview_incomplete")]
    [InlineData(true, false, true, false, false, true, "patreon_media_preview_incomplete")]
    [InlineData(true, true, false, false, false, true, "patreon_media_preview_incomplete")]
    [InlineData(true, true, true, true, false, true, "patreon_media_not_ready")]
    [InlineData(true, true, true, false, true, true, "patreon_media_error")]
    [InlineData(true, true, true, false, false, false, "patreon_media_not_ready")]
    public async Task PartialPreviewSavingErrorOrNoRenderedBox_NeverPrepares(
        bool count,
        bool rendered,
        bool ordered,
        bool busy,
        bool error,
        bool saved,
        string code)
    {
        var page = new FakePage();
        page.Composer.Readiness = [new PatreonReadiness(count, rendered, ordered, busy, error, saved)];

        await AssertFailureAsync(page, code, media: [@"C:\media\one.png"]);
    }

    [Fact]
    public async Task PerpetualSavingAndSecondSampleRegression_NeverPrepare()
    {
        var saving = new FakePage();
        saving.Composer.Readiness = [Ready() with { SaveIsSaved = false, IsBusy = true }];
        await AssertFailureAsync(saving, "patreon_media_not_ready", media: [@"C:\media\one.png"]);

        var regression = new FakePage();
        regression.Composer.Readiness = [Ready(), Ready() with { ImagesRendered = false }];
        await AssertFailureAsync(regression, "patreon_media_preview_incomplete", media: [@"C:\media\one.png"]);
    }

    [Theory]
    [InlineData("finalTitle", "patreon_prepared_assertion_failed")]
    [InlineData("finalBody", "patreon_prepared_assertion_failed")]
    [InlineData("mediaRevalidation", "patreon_media_preview_incomplete")]
    [InlineData("publishMissing", "patreon_prepared_assertion_failed")]
    [InlineData("publishDisabled", "patreon_prepared_assertion_failed")]
    [InlineData("validation", "patreon_validation_error")]
    [InlineData("relinquish", "patreon_relinquish_failed")]
    public async Task FinalAssertionsAndRelinquishment_NeverReturnPrepared(string state, string code)
    {
        var page = new FakePage();
        IReadOnlyList<string>? media = null;
        switch (state)
        {
            case "finalTitle":
                page.Composer.FinalTitleMatches = false;
                break;
            case "finalBody":
                page.Composer.FinalBodyMatches = false;
                break;
            case "mediaRevalidation":
                media = [@"C:\media\one.png"];
                page.Composer.Readiness = [Ready(), Ready(), NotReady() with { ImagesRendered = false }];
                break;
            case "publishMissing":
                page.Composer.Final = new PatreonFinalState(false, false, true, false);
                break;
            case "publishDisabled":
                page.Composer.Final = new PatreonFinalState(true, false, true, false);
                break;
            case "validation":
                page.Composer.Final = new PatreonFinalState(true, true, true, true);
                break;
            case "relinquish":
                page.RelinquishFailure = new BrowserPreparationException(BrowserPreparationFailure.NotOwnedTarget);
                break;
        }

        await AssertFailureAsync(page, code, media: media);
        Assert.False(page.Composer.PublishActivated);
    }

    [Fact]
    public void ProductionSelectors_UseTheReviewedCreatePostAndOwnedFieldContracts()
    {
        Assert.Equal("button[data-tag='create-content-button'][aria-label='Create post'][aria-haspopup='menu']", Constant(typeof(PatreonPreparationPage), "Create"));
        Assert.Equal("button[data-tag='create-content-option-POST'][role='menuitem']", Constant(typeof(PatreonPreparationPage), "PostEntry"));
        Assert.Equal("textarea[aria-label='Title'][placeholder='Title']", Constant(typeof(PatreonPreparationPage), "Title"));
        Assert.Equal("#photosInput[type='file'][multiple]", Constant(typeof(PatreonComposer), "PhotosInput"));
        Assert.Equal("img[data-tag='gallery-image'], div[role='button'][aria-roledescription='sortable'] [data-tag='preview-thumbnail-container'] img[alt='Preview']", Constant(typeof(PatreonComposer), "GalleryImage"));
        Assert.Equal("div[class*='EditorLayout-module'][class*='actions'] div[class*='CompactSaveStatus-module'][aria-hidden='false'] > p", Constant(typeof(PatreonComposer), "SaveStatus"));
        Assert.Equal("button[data-tag='make-a-post-action-publish']", Constant(typeof(PatreonComposer), "Publish"));
    }

    [Theory]
    [InlineData(1)]
    [InlineData(2)]
    [InlineData(3)]
    public async Task ProductionPreviewIdentity_CausallyMapsSequentialObservedNodeIds(int mediaCount)
    {
        var fixture = new ProductionFixture();
        int[][] previewOrders = mediaCount switch
        {
            1 => [[71]],
            2 => [[71], [71, 932]],
            3 => [[71], [71, 932], [71, 932, 415]],
            _ => throw new ArgumentOutOfRangeException(nameof(mediaCount)),
        };
        foreach (int[] previewOrder in previewOrders) fixture.PreviewOrdersAfterAssignments.Add(previewOrder);
        string[] media = Enumerable.Range(1, mediaCount).Select(index => $"C:/media/{index}.png").ToArray();
        var (targets, transport, _) = ProductionTargets(fixture);
        try
        {
            PlatformPreparationResult result = await ProductionAdapter(fixture).PrepareAsync(
                new PlatformPreparationContext("patreon", "Release title", "Body", media, targets), new Progress(), CancellationToken.None);

            Assert.Equal(PlatformPreparationOutcome.Prepared, result.Outcome);
            Assert.Equal(media, fixture.AssignedPaths);
            Assert.Equal(mediaCount, fixture.AssignmentBatches.Count);
            Assert.All(fixture.AssignmentBatches, batch => Assert.Single(batch));
            Assert.Contains(fixture.ObservedPreviewNodeOrders, order => order.SequenceEqual(previewOrders[^1]));
        }
        finally
        {
            await transport.DisposeAsync();
        }
    }

    [Fact]
    public async Task ProductionPreviewIdentity_PreexistingPreviewFailsBeforeM0Assignment()
    {
        var fixture = new ProductionFixture { InitialPreviewNodeIds = [401] };
        // This is the hypothetical post-assignment state; the baseline must fail before it can be observed.
        fixture.PreviewOrdersAfterAssignments.Add([401]);
        var (targets, transport, socket) = ProductionTargets(fixture);
        try
        {
            SocialPreparationRuntimeException error = await Assert.ThrowsAsync<SocialPreparationRuntimeException>(
                () => ProductionAdapter(fixture).PrepareAsync(
                    new PlatformPreparationContext("patreon", "Release title", "Body", ["C:/media/one.png"], targets), new Progress(), CancellationToken.None));

            Assert.Equal("patreon_media_preview_incomplete", error.Code);
            Assert.Empty(fixture.AssignedPaths);
            Assert.Empty(fixture.AssignmentBatches);
            Assert.False(fixture.Detached);

            JsonElement[] commands = socket.Sent.Select(message => JsonDocument.Parse(message).RootElement.Clone()).ToArray();
            Assert.DoesNotContain(commands, command => command.GetProperty("method").GetString() == "DOM.setFileInputFiles");
            Assert.Equal(4, commands.Count(command => command.GetProperty("method").GetString() == "Input.dispatchMouseEvent"));
        }
        finally
        {
            await transport.DisposeAsync();
        }
    }

    [Fact]
    public async Task ProductionPreviewIdentity_PreexistingPreviewCannotBeAdoptedAsM0()
    {
        var fixture = new ProductionFixture { InitialPreviewNodeIds = [401] };
        fixture.PreviewOrdersAfterAssignments.Add([401, 402]);
        var (targets, transport, socket) = ProductionTargets(fixture);
        try
        {
            SocialPreparationRuntimeException error = await Assert.ThrowsAsync<SocialPreparationRuntimeException>(
                () => ProductionAdapter(fixture).PrepareAsync(
                    new PlatformPreparationContext("patreon", "Release title", "Body", ["C:/media/one.png"], targets), new Progress(), CancellationToken.None));

            Assert.Equal("patreon_media_preview_incomplete", error.Code);
            Assert.Empty(fixture.AssignmentBatches);
            Assert.False(fixture.Detached);
            Assert.DoesNotContain(socket.Sent, message => JsonDocument.Parse(message).RootElement.GetProperty("method").GetString() == "DOM.setFileInputFiles");
        }
        finally
        {
            await transport.DisposeAsync();
        }
    }

    [Theory]
    [InlineData("missingNodeIds")]
    [InlineData("malformedNodeIds")]
    [InlineData("invalidNodeId")]
    public async Task ProductionPreviewIdentity_UnreadableBaselineFailsBeforeM0Assignment(string response)
    {
        var fixture = new ProductionFixture
        {
            InitialPreviewQueryResponse = response switch
            {
                "missingNodeIds" => PreviewQueryResponse.MissingNodeIds,
                "malformedNodeIds" => PreviewQueryResponse.MalformedNodeIds,
                "invalidNodeId" => PreviewQueryResponse.InvalidNodeId,
                _ => throw new ArgumentOutOfRangeException(nameof(response)),
            },
        };
        // If this unreadable baseline were accepted as empty, the subsequent valid state would otherwise permit M0.
        fixture.PreviewOrdersAfterAssignments.Add([701]);
        var (targets, transport, socket) = ProductionTargets(fixture);
        try
        {
            SocialPreparationRuntimeException error = await Assert.ThrowsAsync<SocialPreparationRuntimeException>(
                () => ProductionAdapter(fixture).PrepareAsync(
                    new PlatformPreparationContext("patreon", "Release title", "Body", ["C:/media/one.png"], targets), new Progress(), CancellationToken.None));

            Assert.Equal("patreon_media_preview_incomplete", error.Code);
            Assert.Empty(fixture.AssignedPaths);
            Assert.Empty(fixture.AssignmentBatches);
            Assert.Empty(fixture.ObservedPreviewNodeOrders);
            Assert.False(fixture.Detached);
            JsonElement[] commands = socket.Sent.Select(message => JsonDocument.Parse(message).RootElement.Clone()).ToArray();
            Assert.DoesNotContain(commands, command => command.GetProperty("method").GetString() == "DOM.setFileInputFiles");
            Assert.Equal(4, commands.Count(command => command.GetProperty("method").GetString() == "Input.dispatchMouseEvent"));
        }
        finally
        {
            await transport.DisposeAsync();
        }
    }

    [Theory]
    [InlineData("reordered")]
    [InlineData("replaced")]
    [InlineData("multipleNew")]
    [InlineData("noNew")]
    [InlineData("previousDisappeared")]
    public async Task ProductionPreviewIdentity_FailsClosedForNonCausalTopology(string defect)
    {
        var fixture = new ProductionFixture();
        fixture.PreviewOrdersAfterAssignments.Add([401]);
        fixture.PreviewOrdersAfterAssignments.Add(defect switch
        {
            "reordered" => [502, 401],
            "replaced" => [502, 503],
            "multipleNew" => [401, 502, 503],
            "noNew" => [401],
            "previousDisappeared" => [502],
            _ => throw new ArgumentOutOfRangeException(nameof(defect)),
        });
        var (targets, transport, _) = ProductionTargets(fixture);
        try
        {
            SocialPreparationRuntimeException error = await Assert.ThrowsAsync<SocialPreparationRuntimeException>(
                () => ProductionAdapter(fixture).PrepareAsync(
                    new PlatformPreparationContext("patreon", "Release title", "Body", ["C:/media/one.png", "C:/media/two.png"], targets), new Progress(), CancellationToken.None));

            Assert.Equal("patreon_media_preview_incomplete", error.Code);
            Assert.False(fixture.Detached);
        }
        finally
        {
            await transport.DisposeAsync();
        }
    }

    [Fact]
    public async Task ProductionPreviewIdentity_FinalOrderRevalidationRejectsLaterReorder()
    {
        var fixture = new ProductionFixture { PreviewOrderAfterFinalBodyVerification = [824, 701] };
        fixture.PreviewOrdersAfterAssignments.Add([701]);
        fixture.PreviewOrdersAfterAssignments.Add([701, 824]);
        var (targets, transport, _) = ProductionTargets(fixture);
        try
        {
            SocialPreparationRuntimeException error = await Assert.ThrowsAsync<SocialPreparationRuntimeException>(
                () => ProductionAdapter(fixture).PrepareAsync(
                    new PlatformPreparationContext("patreon", "Release title", "Body", ["C:/media/one.png", "C:/media/two.png"], targets), new Progress(), CancellationToken.None));

            Assert.Equal("patreon_media_preview_incomplete", error.Code);
            Assert.False(fixture.Detached);
        }
        finally
        {
            await transport.DisposeAsync();
        }
    }

    [Fact]
    public async Task ProductionSaveState_UsesVisibleComposerScopedSavedStatus()
    {
        var fixture = new ProductionFixture();
        var (targets, transport, _) = ProductionTargets(fixture);
        try
        {
            PlatformPreparationResult result = await ProductionAdapter(fixture).PrepareAsync(
                new PlatformPreparationContext("patreon", "Release title", "Body", [], targets), new Progress(), CancellationToken.None);

            Assert.Equal(PlatformPreparationOutcome.Prepared, result.Outcome);
        }
        finally
        {
            await transport.DisposeAsync();
        }
    }

    [Theory]
    [InlineData("saving")]
    [InlineData("missing")]
    [InlineData("hidden")]
    public async Task ProductionSaveState_UnrelatedDocumentSavedNeverSatisfiesComposerReadiness(string state)
    {
        var fixture = new ProductionFixture();
        fixture.SaveStatusSamples = state switch
        {
            "saving" => [new ProductionFixture.SaveStatusSample(111, "Saving", true)],
            "missing" => [],
            "hidden" => [new ProductionFixture.SaveStatusSample(111, "Saved", false)],
            _ => throw new ArgumentOutOfRangeException(nameof(state)),
        };
        var (targets, transport, _) = ProductionTargets(fixture);
        try
        {
            SocialPreparationRuntimeException error = await Assert.ThrowsAsync<SocialPreparationRuntimeException>(
                () => ProductionAdapter(fixture).PrepareAsync(
                    new PlatformPreparationContext("patreon", "Release title", "Body", ["C:/media/one.png"], targets), new Progress(), CancellationToken.None));

            Assert.Equal("patreon_media_not_ready", error.Code);
            Assert.False(fixture.Detached);
        }
        finally
        {
            await transport.DisposeAsync();
        }
    }

    [Fact]
    public async Task ProductionSaveState_SavingThenSavedRequiresStableSamplesAndAllowsNodeReplacement()
    {
        var fixture = new ProductionFixture();
        fixture.SaveStatusSamples =
        [
            new ProductionFixture.SaveStatusSample(111, "Saving", true),
            new ProductionFixture.SaveStatusSample(222, "Saved", true),
            new ProductionFixture.SaveStatusSample(333, "Saved", true),
            new ProductionFixture.SaveStatusSample(444, "Saved", true),
            new ProductionFixture.SaveStatusSample(555, "Saved", true),
        ];
        var (targets, transport, _) = ProductionTargets(fixture);
        try
        {
            PlatformPreparationResult result = await ProductionAdapter(fixture).PrepareAsync(
                new PlatformPreparationContext("patreon", "Release title", "Body", ["C:/media/one.png"], targets), new Progress(), CancellationToken.None);

            Assert.Equal(PlatformPreparationOutcome.Prepared, result.Outcome);
            Assert.Equal([111, 222, 333], fixture.ObservedSaveStatusNodeIds.Take(3));
        }
        finally
        {
            await transport.DisposeAsync();
        }
    }

    [Fact]
    public async Task ProductionSaveState_SavedThenSavingRegressionNeverPrepares()
    {
        var fixture = new ProductionFixture();
        fixture.SaveStatusSamples =
        [
            new ProductionFixture.SaveStatusSample(111, "Saved", true),
            new ProductionFixture.SaveStatusSample(222, "Saved", true),
            new ProductionFixture.SaveStatusSample(333, "Saving", true),
        ];
        var (targets, transport, _) = ProductionTargets(fixture);
        try
        {
            SocialPreparationRuntimeException error = await Assert.ThrowsAsync<SocialPreparationRuntimeException>(
                () => ProductionAdapter(fixture).PrepareAsync(
                    new PlatformPreparationContext("patreon", "Release title", "Body", ["C:/media/one.png"], targets), new Progress(), CancellationToken.None));

            Assert.Equal("patreon_media_not_ready", error.Code);
            Assert.False(fixture.Detached);
        }
        finally
        {
            await transport.DisposeAsync();
        }
    }

    [Fact]
    public async Task NoSubmitTranscript_AllowsOnlyCreateAndPostAndLeavesSettingsUntouched()
    {
        var page = new FakePage();
        await Adapter(page).PrepareAsync(Context(media: [@"C:\media\one.png"]), new Progress(), CancellationToken.None);

        Assert.Equal(page.ExpectedActivations, page.Activations);
        Assert.Empty(page.SettingsMutations);
        Assert.False(page.Composer.PublishActivated);
        Assert.DoesNotContain(typeof(PatreonSocialPreparationAdapter).GetMethods().Select(method => method.Name), name =>
            name.Contains("publish", StringComparison.OrdinalIgnoreCase) ||
            name.Contains("post", StringComparison.OrdinalIgnoreCase) ||
            name.Contains("submit", StringComparison.OrdinalIgnoreCase) ||
            name.Contains("confirm", StringComparison.OrdinalIgnoreCase));
        Assert.DoesNotContain(typeof(IPatreonComposer).GetMethods().Select(method => method.Name), name =>
            name.Contains("publish", StringComparison.OrdinalIgnoreCase) ||
            name.Contains("post", StringComparison.OrdinalIgnoreCase) ||
            name.Contains("submit", StringComparison.OrdinalIgnoreCase) ||
            name.Contains("confirm", StringComparison.OrdinalIgnoreCase));
    }

    [Fact]
    public async Task ProductionNoSubmitTranscript_UsesOnlyCreatePostAndPersistentImageInput()
    {
        var fixture = new ProductionFixture();
        var (targets, transport, socket) = ProductionTargets(fixture);
        var adapter = new PatreonSocialPreparationAdapter(
            targets => new PatreonPreparationPage(targets, "creator", fixture.Timing),
            fixture.Timing);
        try
        {
            PlatformPreparationResult result = await adapter.PrepareAsync(
                new PlatformPreparationContext("patreon", "Release title", "Body\n\nUnicode ✓", [@"C:\media\one.png"], targets),
                new Progress(),
                CancellationToken.None);

            Assert.Equal(PlatformPreparationOutcome.Prepared, result.Outcome);
            Assert.Equal([@"C:\media\one.png"], fixture.AssignedPaths);
            Assert.True(fixture.Detached);

            JsonElement[] commands = socket.Sent.Select(message => JsonDocument.Parse(message).RootElement.Clone()).ToArray();
            string[] methods = commands.Select(command => command.GetProperty("method").GetString()!).ToArray();
            Assert.DoesNotContain(methods, method =>
                method is "Runtime.evaluate" or "Target.closeTarget" ||
                method.Contains("submit", StringComparison.OrdinalIgnoreCase) ||
                method.Contains("publish", StringComparison.OrdinalIgnoreCase) ||
                method.Contains("fetch", StringComparison.OrdinalIgnoreCase) ||
                method.Contains("graphql", StringComparison.OrdinalIgnoreCase));

            JsonElement[] mouse = commands.Where(command => command.GetProperty("method").GetString() == "Input.dispatchMouseEvent").ToArray();
            Assert.Equal(4, mouse.Length);
            AssertMouse(mouse[0], 10, 10, "mousePressed", 1);
            AssertMouse(mouse[1], 10, 10, "mouseReleased", 0);
            AssertMouse(mouse[2], 30, 10, "mousePressed", 1);
            AssertMouse(mouse[3], 30, 10, "mouseReleased", 0);
            Assert.Single(commands.Where(command => command.GetProperty("method").GetString() == "DOM.setFileInputFiles"));

            foreach (JsonElement keyEvent in commands.Where(command => command.GetProperty("method").GetString() == "Input.dispatchKeyEvent"))
                AssertApprovedTextKeyEvent(keyEvent);
        }
        finally
        {
            await transport.DisposeAsync();
        }
    }

    [Theory]
    [InlineData("simple text")]
    [InlineData("one\nline")]
    [InlineData("one\n\nline")]
    [InlineData("one\n\n\nline")]
    [InlineData("  leading whitespace")]
    [InlineData("trailing whitespace  ")]
    [InlineData("Unicode ✓")]
    [InlineData("surrogate 😀")]
    public async Task ProductionBodyReadback_ReconstructsTheActualEditingTranscriptOrdinally(string body)
    {
        var fixture = new ProductionFixture();
        var (targets, transport, _) = ProductionTargets(fixture);
        try
        {
            PlatformPreparationResult result = await ProductionAdapter(fixture).PrepareAsync(
                new PlatformPreparationContext("patreon", "Release title", body, [], targets), new Progress(), CancellationToken.None);

            Assert.Equal(PlatformPreparationOutcome.Prepared, result.Outcome);
            Assert.Equal(body, fixture.BodyFromEditingTranscript);
            Assert.DoesNotContain("Paid members only", fixture.BodyFromEditingTranscript, StringComparison.Ordinal);
        }
        finally
        {
            await transport.DisposeAsync();
        }
    }

    [Fact]
    public async Task ProductionBodyReadback_DeliberateMismatchNeverPrepares()
    {
        var fixture = new ProductionFixture { CorruptBodyReadback = true };
        var (targets, transport, _) = ProductionTargets(fixture);
        try
        {
            SocialPreparationRuntimeException error = await Assert.ThrowsAsync<SocialPreparationRuntimeException>(
                () => ProductionAdapter(fixture).PrepareAsync(
                    new PlatformPreparationContext("patreon", "Release title", "exact body", [], targets), new Progress(), CancellationToken.None));

            Assert.Equal("patreon_body_mismatch", error.Code);
            Assert.False(fixture.Detached);
        }
        finally
        {
            await transport.DisposeAsync();
        }
    }

    [Fact]
    public async Task ProductionComposerRoute_RequiresTheRequestedCreatorVanity()
    {
        var fixture = new ProductionFixture { CurrentUrl = "https://www.patreon.com/other-creator/posts/draft/edit" };
        var (targets, transport, _) = ProductionTargets(fixture);
        try
        {
            SocialPreparationRuntimeException error = await Assert.ThrowsAsync<SocialPreparationRuntimeException>(
                () => ProductionAdapter(fixture).PrepareAsync(
                    new PlatformPreparationContext("patreon", "Release title", "Body", [], targets), new Progress(), CancellationToken.None));

            Assert.Equal("patreon_composer_missing", error.Code);
            Assert.False(fixture.Detached);
        }
        finally
        {
            await transport.DisposeAsync();
        }
    }

    [Theory]
    [InlineData("https://www.patreon.com/other-creator/posts/draft/edit")]
    [InlineData("https://www.patreon.com/creator/posts/draft")]
    public async Task ProductionFinalRouteRevalidation_NeverRelinquishesAsPrepared(string changedUrl)
    {
        var fixture = new ProductionFixture { RouteAfterFinalBodyVerification = changedUrl };
        var (targets, transport, _) = ProductionTargets(fixture);
        try
        {
            SocialPreparationRuntimeException error = await Assert.ThrowsAsync<SocialPreparationRuntimeException>(
                () => ProductionAdapter(fixture).PrepareAsync(
                    new PlatformPreparationContext("patreon", "Release title", "Body", [], targets), new Progress(), CancellationToken.None));

            Assert.Equal("patreon_prepared_assertion_failed", error.Code);
            Assert.False(fixture.Detached);
        }
        finally
        {
            await transport.DisposeAsync();
        }
    }

    [Fact]
    public async Task HiddenChallengeWithVisibleCreate_ContinuesButVisibleChallengeRequiresAuthentication()
    {
        var hidden = new ProductionFixture { ChallengeVisible = false };
        var (hiddenTargets, hiddenTransport, _) = ProductionTargets(hidden);
        try
        {
            PlatformPreparationResult result = await ProductionAdapter(hidden).PrepareAsync(
                new PlatformPreparationContext("patreon", "Release title", "Body", [], hiddenTargets), new Progress(), CancellationToken.None);
            Assert.Equal(PlatformPreparationOutcome.Prepared, result.Outcome);
        }
        finally
        {
            await hiddenTransport.DisposeAsync();
        }

        var visible = new ProductionFixture { ChallengeVisible = true };
        var (visibleTargets, visibleTransport, _) = ProductionTargets(visible);
        try
        {
            PlatformPreparationResult result = await ProductionAdapter(visible).PrepareAsync(
                new PlatformPreparationContext("patreon", "Release title", "Body", [], visibleTargets), new Progress(), CancellationToken.None);
            Assert.Equal(PlatformPreparationOutcome.AuthenticationRequired, result.Outcome);
        }
        finally
        {
            await visibleTransport.DisposeAsync();
        }
    }

    [Fact]
    public async Task VisibleLoginRequiresAuthentication_WhileHiddenLoginAndChallengeWithoutControlsFailOrdinarily()
    {
        var visibleLogin = new ProductionFixture
        {
            CurrentUrl = "https://www.patreon.com/login",
            LoginVisible = true,
            CreateAvailable = false,
        };
        var (loginTargets, loginTransport, _) = ProductionTargets(visibleLogin);
        try
        {
            PlatformPreparationResult result = await ProductionAdapter(visibleLogin).PrepareAsync(
                new PlatformPreparationContext("patreon", "Release title", "Body", [], loginTargets), new Progress(), CancellationToken.None);
            Assert.Equal(PlatformPreparationOutcome.AuthenticationRequired, result.Outcome);
        }
        finally
        {
            await loginTransport.DisposeAsync();
        }

        var hiddenEvidence = new ProductionFixture
        {
            CurrentUrl = "https://www.patreon.com/login",
            LoginVisible = false,
            ChallengeVisible = false,
            CreateAvailable = false,
            CancelOnFirstDelay = true,
        };
        var (hiddenTargets, hiddenTransport, _) = ProductionTargets(hiddenEvidence);
        try
        {
            SocialPreparationRuntimeException error = await Assert.ThrowsAsync<SocialPreparationRuntimeException>(
                () => ProductionAdapter(hiddenEvidence).PrepareAsync(
                    new PlatformPreparationContext("patreon", "Release title", "Body", [], hiddenTargets), new Progress(), CancellationToken.None));
            Assert.Equal("patreon_home_timeout", error.Code);
        }
        finally
        {
            await hiddenTransport.DisposeAsync();
        }
    }

    [Theory]
    [InlineData("false", false, true)]
    [InlineData("true", false, false)]
    [InlineData(null, false, false)]
    [InlineData("", false, false)]
    [InlineData("False", false, false)]
    [InlineData("unexpected", false, false)]
    [InlineData("false", true, false)]
    public async Task ProductionPublishReadiness_RequiresPositiveAriaDisabledFalse(string? ariaDisabled, bool nativeDisabled, bool prepares)
    {
        var fixture = new ProductionFixture { PublishAriaDisabled = ariaDisabled, PublishNativeDisabled = nativeDisabled };
        var (targets, transport, _) = ProductionTargets(fixture);
        try
        {
            Task<PlatformPreparationResult> attempt = ProductionAdapter(fixture).PrepareAsync(
                new PlatformPreparationContext("patreon", "Release title", "Body", [], targets), new Progress(), CancellationToken.None);
            if (prepares)
                Assert.Equal(PlatformPreparationOutcome.Prepared, (await attempt).Outcome);
            else
            {
                SocialPreparationRuntimeException error = await Assert.ThrowsAsync<SocialPreparationRuntimeException>(() => attempt);
                Assert.Equal("patreon_prepared_assertion_failed", error.Code);
            }
        }
        finally
        {
            await transport.DisposeAsync();
        }
    }

    [Fact]
    public async Task ManualDiagnostic_BaselineFailureCannotPoisonFreshPreparationDeadline()
    {
        var fixture = new ProductionFixture { CancelDeadlineAndFailBaselineInventory = true };
        var diagnostic = new PatreonManualPreparationDiagnostic();
        var (targets, transport, _) = ProductionTargets(fixture);
        try
        {
            PlatformPreparationResult result = await ProductionAdapter(fixture, diagnostic).PrepareAsync(
                new PlatformPreparationContext("patreon", "Distinctive title", "Distinctive body", [], targets), new Progress(), CancellationToken.None);

            Assert.Equal(PlatformPreparationOutcome.Prepared, result.Outcome);
            Assert.False(fixture.DeadlineWasPresentDuringBaseline);
            Assert.True(fixture.PrimaryDeadlineCreatedAfterBaseline);
            Assert.True(fixture.PrimaryDeadlineWasUncancelledAfterBaseline);
            Assert.Equal(1, fixture.DeadlineCreationCount);
            Assert.Contains("original_target_present=unknown;replacement_target_appeared=unknown", diagnostic.Format("manual_patreon_validation_failed"));
        }
        finally
        {
            await transport.DisposeAsync();
        }
    }

    [Fact]
    public async Task ProductionDelayedPost_IsPolledUntilTheControlAppearsThenPrepares()
    {
        var fixture = new ProductionFixture { PostMissingLookupsBeforeAvailable = 2 };
        var (targets, transport, _) = ProductionTargets(fixture);
        try
        {
            PlatformPreparationResult result = await ProductionAdapter(fixture).PrepareAsync(
                new PlatformPreparationContext("patreon", "Distinctive title", "Distinctive body", [], targets), new Progress(), CancellationToken.None);

            Assert.Equal(PlatformPreparationOutcome.Prepared, result.Outcome);
            Assert.Equal(3, fixture.PostLookupCount);
        }
        finally
        {
            await transport.DisposeAsync();
        }
    }

    [Fact]
    public async Task ProductionPostNeverAppearsUntilDeadline_FailsWithoutPreparingComposer()
    {
        var fixture = new ProductionFixture { PostAvailableAfterCreate = false, CancelOnFirstDelay = true };
        var diagnostic = new PatreonManualPreparationDiagnostic();
        var progress = new Progress();
        var (targets, transport, socket) = ProductionTargets(fixture);
        try
        {
            SocialPreparationRuntimeException error = await Assert.ThrowsAsync<SocialPreparationRuntimeException>(
                () => ProductionAdapter(fixture, diagnostic).PrepareAsync(
                    new PlatformPreparationContext("patreon", "Distinctive title", "Distinctive body", [], targets), progress, CancellationToken.None));

            Assert.Equal("patreon_post_control_missing", error.Code);
            Assert.Equal(1, fixture.PostLookupCount);
            Assert.Empty(progress.Values);
            Assert.Contains("post_found=0;post_activated=0;composer_route_observed=0", diagnostic.Format(error.Code));
            JsonElement[] commands = socket.Sent.Select(message => JsonDocument.Parse(message).RootElement.Clone()).ToArray();
            Assert.DoesNotContain(commands, command => Method(command) == "DOM.querySelector" &&
                command.GetProperty("params").GetProperty("selector").GetString() == "textarea[aria-label='Title'][placeholder='Title']");
            Assert.DoesNotContain(commands, command => Method(command) == "DOM.querySelector" &&
                command.GetProperty("params").GetProperty("selector").GetString() == "button[data-tag='make-a-post-action-publish']");
        }
        finally
        {
            await transport.DisposeAsync();
        }
    }

    [Fact]
    public async Task ManualDiagnostic_ProductionPostActivationThenMissingComposerPreservesComposerFailure()
    {
        var fixture = new ProductionFixture { ComposerAvailableAfterPost = false, CancelOnFirstDelay = true };
        var diagnostic = new PatreonManualPreparationDiagnostic();
        var (targets, transport, _) = ProductionTargets(fixture);
        try
        {
            SocialPreparationRuntimeException error = await Assert.ThrowsAsync<SocialPreparationRuntimeException>(
                () => ProductionAdapter(fixture, diagnostic).PrepareAsync(
                    new PlatformPreparationContext("patreon", "Distinctive title", "Distinctive body", [], targets), new Progress(), CancellationToken.None));

            Assert.Equal("patreon_composer_missing", error.Code);
            Assert.Contains("post_found=1;post_activated=1;composer_route_observed=0", diagnostic.Format(error.Code));
        }
        finally
        {
            await transport.DisposeAsync();
        }
    }

    [Fact]
    public async Task ManualDiagnostic_ProductionCreateActivationInvalidBoxRecordsScrollReadyAndBrowserPreparation()
    {
        var fixture = new ProductionFixture { ActivationFailure = ProductionActivationFailure.InvalidBox };
        var diagnostic = new PatreonManualPreparationDiagnostic();
        var (targets, transport, socket) = ProductionTargets(fixture);
        try
        {
            await Assert.ThrowsAsync<BrowserPreparationException>(() => ProductionAdapter(fixture, diagnostic).PrepareAsync(
                new PlatformPreparationContext("patreon", "Distinctive title", "Distinctive body", [], targets), new Progress(), CancellationToken.None));

            string trace = diagnostic.Format("manual_patreon_validation_failed");
            Assert.Contains("create_found=1;create_activated=0", trace);
            Assert.Contains("create_activation_stage=scroll_ready;create_activation_error_class=browser_preparation", trace);
            Assert.DoesNotContain(socket.Sent, command => Method(command) == "Input.dispatchMouseEvent");
        }
        finally
        {
            await transport.DisposeAsync();
        }
    }

    [Fact]
    public async Task ManualDiagnostic_ProductionLongestReachableTraceMatchesMaximum()
    {
        var fixture = new ProductionFixture
        {
            ActivationFailure = ProductionActivationFailure.MouseReleaseCommand,
            ActivationFailureCode = int.MinValue,
            ActivationFailureMessage = new string('x', PatreonManualPreparationDiagnostic.CdpMessageMaxLength + 1),
            FailTopologyInventory = true,
        };
        var diagnostic = new PatreonManualPreparationDiagnostic();
        int maximumTraceLength = IntConstant(typeof(PatreonManualPreparationDiagnostic), "MaximumTraceLength");
        string stableErrorCode = new('a', 64);
        var (targets, transport, _) = ProductionTargets(fixture);
        try
        {
            await Assert.ThrowsAsync<CdpCommandException>(() => ProductionAdapter(fixture, diagnostic).PrepareAsync(
                new PlatformPreparationContext("patreon", "Distinctive title", "Distinctive body", [], targets), new Progress(), CancellationToken.None));

            string trace = diagnostic.Format(stableErrorCode);
            Assert.Equal(64, stableErrorCode.Length);
            Assert.EndsWith($"error={stableErrorCode}", trace);
            Assert.Contains("create_activation_stage=mouse_press_sent;create_activation_error_class=cdp_command;create_activation_cdp_method=mouse_release;create_activation_cdp_code=-2147483648", trace);
            Assert.Contains($"create_activation_cdp_message={new string('x', PatreonManualPreparationDiagnostic.CdpMessageMaxLength - "[truncated]".Length)}[truncated]", trace);
            Assert.Contains("original_target_present=unknown;replacement_target_appeared=unknown", trace);
            Assert.Equal(658, trace.Length);
            Assert.Equal(maximumTraceLength, trace.Length);
            Assert.True(trace.Length <= maximumTraceLength);
        }
        finally
        {
            await transport.DisposeAsync();
        }
    }

    [Theory]
    [InlineData("Could not find node with given id")]
    [InlineData("Node does not have a layout object")]
    public async Task ManualDiagnostic_ProductionCreateActivationScrollCommandFailureRecordsNodeReadyAndSkipsBoxAndMouse(string message)
    {
        var fixture = new ProductionFixture
        {
            ActivationFailure = ProductionActivationFailure.ScrollCommand,
            ActivationFailureCode = -32000,
            ActivationFailureMessage = message,
        };
        var diagnostic = new PatreonManualPreparationDiagnostic();
        var (targets, transport, socket) = ProductionTargets(fixture);
        try
        {
            CdpCommandException failure = await Assert.ThrowsAsync<CdpCommandException>(() => ProductionAdapter(fixture, diagnostic).PrepareAsync(
                new PlatformPreparationContext("patreon", "Distinctive title", "Distinctive body", [], targets), new Progress(), CancellationToken.None));
            Assert.Equal(-32000, failure.Code);
            Assert.Equal(message, failure.Message);
            Assert.Equal(PatreonCreateResolutionOutcome.UniqueCandidate, failure.SocialDiagnostic!.CreateResolution!.Outcome);
            Assert.True(failure.SocialDiagnostic.CreateResolution.Complete);
            Assert.Contains("CDP operation: scroll_into_view", failure.SocialDiagnostic.FormatForDisplay());
            Assert.Contains(message, failure.SocialDiagnostic.FormatForDisplay());
            Assert.Equal(0, fixture.PostLookupCount);

            string trace = diagnostic.Format("manual_patreon_validation_failed");
            Assert.Contains($"create_activation_stage=node_ready;create_activation_error_class=cdp_command;create_activation_cdp_method=scroll_into_view;create_activation_cdp_code=-32000;create_activation_cdp_message={message}", trace);
            Assert.Contains("create_found=1;create_activated=0", trace);
            Assert.Single(socket.Sent.Where(command => Method(command) == "DOM.getBoxModel" &&
                JsonDocument.Parse(command).RootElement.GetProperty("params").GetProperty("backendNodeId").GetInt64() == 20));
            Assert.Equal(1, socket.Sent.Count(command => Method(command) == "DOM.scrollIntoViewIfNeeded"));
            IEnumerable<string> afterScroll = socket.Sent.SkipWhile(command => Method(command) != "DOM.scrollIntoViewIfNeeded").Skip(1);
            Assert.DoesNotContain(afterScroll, command => Method(command) == "DOM.getBoxModel");
            Assert.DoesNotContain(socket.Sent, command => Method(command) == "Input.dispatchMouseEvent");
        }
        finally
        {
            await transport.DisposeAsync();
        }
    }

    [Fact]
    public async Task ManualDiagnostic_ProductionCreateActivationBoxCommandFailureRecordsScrollReadyAndSkipsMouse()
    {
        var fixture = new ProductionFixture
        {
            ActivationFailure = ProductionActivationFailure.BoxCommand,
            ActivationFailureCode = -32001,
            ActivationFailureMessage = "Could not compute box model",
        };
        var diagnostic = new PatreonManualPreparationDiagnostic();
        var (targets, transport, socket) = ProductionTargets(fixture);
        try
        {
            await Assert.ThrowsAsync<CdpCommandException>(() => ProductionAdapter(fixture, diagnostic).PrepareAsync(
                new PlatformPreparationContext("patreon", "Distinctive title", "Distinctive body", [], targets), new Progress(), CancellationToken.None));

            string trace = diagnostic.Format("manual_patreon_validation_failed");
            Assert.Contains("create_activation_stage=scroll_ready;create_activation_error_class=cdp_command;create_activation_cdp_method=get_box_model;create_activation_cdp_code=-32001;create_activation_cdp_message=Could not compute box model", trace);
            Assert.Equal(1, socket.Sent.Count(command => Method(command) == "DOM.scrollIntoViewIfNeeded"));
            IEnumerable<string> afterScroll = socket.Sent.SkipWhile(command => Method(command) != "DOM.scrollIntoViewIfNeeded").Skip(1);
            Assert.Equal(1, afterScroll.Count(command => Method(command) == "DOM.getBoxModel"));
            Assert.DoesNotContain(socket.Sent, command => Method(command) == "Input.dispatchMouseEvent");
        }
        finally
        {
            await transport.DisposeAsync();
        }
    }

    [Fact]
    public async Task ManualDiagnostic_CdpMessageSanitizesBoundsAndRedactsSensitiveValues()
    {
        const string vanity = "distinctive-creator-vanity";
        const string title = "distinctive-title";
        const string body = "distinctive-body";
        const string mediaPath = @"C:\private-media\distinctive.png";
        const string url = "https://private.example.test/path?capability-token=distinctive-token";
        const string token = "capability-token=distinctive-token";
        const string dom = "<div>distinctive-private-dom</div>";
        string message = $"Chrome diagnostic\r\n\t\u0001vanity={vanity};title={title};body={body};{mediaPath};{url};{token};{dom};session id distinctive-session " + new string('z', 512);
        var fixture = new ProductionFixture
        {
            ActivationFailure = ProductionActivationFailure.ScrollCommand,
            ActivationFailureCode = -32000,
            ActivationFailureMessage = message,
        };
        var diagnostic = new PatreonManualPreparationDiagnostic();
        var (targets, transport, _) = ProductionTargets(fixture);
        try
        {
            await Assert.ThrowsAsync<CdpCommandException>(() => ProductionAdapter(fixture, diagnostic).PrepareAsync(
                new PlatformPreparationContext("patreon", title, body, [mediaPath], targets), new Progress(), CancellationToken.None));

            string trace = diagnostic.Format("manual_patreon_validation_failed");
            string cdpMessage = trace.Split(';').Single(field => field.StartsWith("create_activation_cdp_message=", StringComparison.Ordinal))["create_activation_cdp_message=".Length..];
            Assert.DoesNotContain('\r', trace);
            Assert.DoesNotContain('\n', trace);
            Assert.DoesNotContain('\t', trace);
            Assert.DoesNotContain(trace, char.IsControl);
            Assert.True(cdpMessage.Length <= PatreonManualPreparationDiagnostic.CdpMessageMaxLength);
            Assert.EndsWith("[truncated]", cdpMessage);
            Assert.Contains("Chrome diagnostic", cdpMessage);
            Assert.DoesNotContain(vanity, trace);
            Assert.DoesNotContain(title, trace);
            Assert.DoesNotContain(body, trace);
            Assert.DoesNotContain(mediaPath, trace);
            Assert.DoesNotContain(url, trace);
            Assert.DoesNotContain("distinctive-token", trace);
            Assert.DoesNotContain("distinctive-session", trace);
            Assert.DoesNotContain("distinctive-private-dom", trace);
            Assert.DoesNotContain("<div", trace, StringComparison.OrdinalIgnoreCase);
        }
        finally
        {
            await transport.DisposeAsync();
        }
    }

    [Theory]
    [InlineData(ProductionActivationFailure.MousePressCommand, "box_ready", "mouse_press", 1)]
    [InlineData(ProductionActivationFailure.MouseReleaseCommand, "mouse_press_sent", "mouse_release", 2)]
    public async Task ManualDiagnostic_ProductionCreateActivationMouseFailuresRecordCompletedMilestones(
        ProductionActivationFailure failure,
        string stage,
        string cdpMethod,
        int mouseCommands)
    {
        var fixture = new ProductionFixture { ActivationFailure = failure };
        var diagnostic = new PatreonManualPreparationDiagnostic();
        var (targets, transport, socket) = ProductionTargets(fixture);
        try
        {
            await Assert.ThrowsAsync<CdpCommandException>(() => ProductionAdapter(fixture, diagnostic).PrepareAsync(
                new PlatformPreparationContext("patreon", "Distinctive title", "Distinctive body", [], targets), new Progress(), CancellationToken.None));

            string trace = diagnostic.Format("manual_patreon_validation_failed");
            Assert.Contains($"create_activation_stage={stage};create_activation_error_class=cdp_command;create_activation_cdp_method={cdpMethod};create_activation_cdp_code=-32001;create_activation_cdp_message=fixture command failure", trace);
            Assert.Equal(mouseCommands, socket.Sent.Count(command => Method(command) == "Input.dispatchMouseEvent"));
        }
        finally
        {
            await transport.DisposeAsync();
        }
    }

    [Fact]
    public async Task ManualDiagnostic_ProductionCreateActivationDeadlineRecordsTimeout()
    {
        var fixture = new ProductionFixture { ActivationFailure = ProductionActivationFailure.Timeout };
        var diagnostic = new PatreonManualPreparationDiagnostic();
        var (targets, transport, socket) = ProductionTargets(fixture);
        try
        {
            SocialPreparationRuntimeException error = await Assert.ThrowsAsync<SocialPreparationRuntimeException>(
                () => ProductionAdapter(fixture, diagnostic).PrepareAsync(
                    new PlatformPreparationContext("patreon", "Distinctive title", "Distinctive body", [], targets), new Progress(), CancellationToken.None));

            Assert.Equal("patreon_create_control_missing", error.Code);
            Assert.Contains("create_activation_stage=scroll_ready;create_activation_error_class=timeout", diagnostic.Format(error.Code));
            Assert.Contains("create_activation_cdp_method=none;create_activation_cdp_code=unknown;create_activation_cdp_message=none", diagnostic.Format(error.Code));
            Assert.DoesNotContain(socket.Sent, command => Method(command) == "Input.dispatchMouseEvent");
        }
        finally
        {
            await transport.DisposeAsync();
        }
    }

    [Fact]
    public async Task ManualDiagnostic_ProductionCreateActivationDisposedSessionRecordsTargetClosed()
    {
        var fixture = new ProductionFixture();
        var diagnostic = new PatreonManualPreparationDiagnostic();
        PatreonPreparationPage? page = null;
        var adapter = new PatreonSocialPreparationAdapter(targets =>
        {
            page = new PatreonPreparationPage(targets, "creator", fixture.Timing, stage =>
            {
                diagnostic.ObserveCreateActivation(stage);
                if (stage != BrowserPreparationActivationStage.NodeReady) return;
                BrowserPreparationSession session = Assert.IsType<BrowserPreparationSession>(typeof(PatreonPreparationPage)
                    .GetField("_page", BindingFlags.Instance | BindingFlags.NonPublic)!.GetValue(page));
                DisposeSynchronously(session);
            });
            return page;
        }, fixture.Timing, diagnostic);
        var (targets, transport, socket) = ProductionTargets(fixture);
        try
        {
            SocialPreparationRuntimeException error = await Assert.ThrowsAsync<SocialPreparationRuntimeException>(
                () => adapter.PrepareAsync(
                    new PlatformPreparationContext("patreon", "Distinctive title", "Distinctive body", [], targets), new Progress(), CancellationToken.None));

            Assert.Equal("patreon_target_closed", error.Code);
            Assert.Contains("create_activation_stage=node_ready;create_activation_error_class=target_closed", diagnostic.Format(error.Code));
            Assert.DoesNotContain(socket.Sent, command => Method(command) == "Input.dispatchMouseEvent");
        }
        finally
        {
            await transport.DisposeAsync();
        }
    }

    [Fact]
    public async Task ProductionEntryControls_AreLocalAndActivatedImmediatelyAfterTheirFreshLookup()
    {
        var fixture = new ProductionFixture();
        var (targets, transport, socket) = ProductionTargets(fixture);
        try
        {
            PlatformPreparationResult result = await ProductionAdapter(fixture).PrepareAsync(
                new PlatformPreparationContext("patreon", "Distinctive title", "Distinctive body", [], targets), new Progress(), CancellationToken.None);

            Assert.Equal(PlatformPreparationOutcome.Prepared, result.Outcome);
            Assert.Null(typeof(PatreonPreparationPage).GetField("_create", BindingFlags.Instance | BindingFlags.NonPublic));
            Assert.Null(typeof(PatreonPreparationPage).GetField("_postEntry", BindingFlags.Instance | BindingFlags.NonPublic));

            JsonElement[] commands = socket.Sent.Select(message => JsonDocument.Parse(message).RootElement.Clone()).ToArray();
            int createDescription = Array.FindLastIndex(commands, command => Method(command) == "DOM.describeNode" &&
                command.GetProperty("params").GetProperty("nodeId").GetInt32() == 2);
            int postDescription = Array.FindIndex(commands, command => Method(command) == "DOM.describeNode" &&
                command.GetProperty("params").GetProperty("nodeId").GetInt32() == 3);
            Assert.Equal("DOM.getBoxModel", Method(commands[createDescription + 1]));
            Assert.Equal(createDescription + 2, Array.FindIndex(commands, createDescription + 1, command => Method(command) == "DOM.scrollIntoViewIfNeeded" &&
                command.GetProperty("params").GetProperty("backendNodeId").GetInt64() == 20));
            Assert.Equal(postDescription + 1, Array.FindIndex(commands, postDescription + 1, command => Method(command) == "DOM.scrollIntoViewIfNeeded" &&
                command.GetProperty("params").GetProperty("backendNodeId").GetInt64() == 30));
        }
        finally
        {
            await transport.DisposeAsync();
        }
    }

    [Fact]
    public async Task ManualDiagnostic_ProductionCreateActivationSuccessRecordsCompletedAndNoExtraCdpCommands()
    {
        var fixture = new ProductionFixture { PostAvailableAfterCreate = false, CancelOnFirstDelay = true };
        var diagnostic = new PatreonManualPreparationDiagnostic();
        var stages = new List<BrowserPreparationActivationStage>();
        var adapter = new PatreonSocialPreparationAdapter(targets => new PatreonPreparationPage(
            targets,
            "creator",
            fixture.Timing,
            stage =>
            {
                diagnostic.ObserveCreateActivation(stage);
                stages.Add(stage);
            }), fixture.Timing, diagnostic);
        var (targets, transport, socket) = ProductionTargets(fixture);
        try
        {
            SocialPreparationRuntimeException error = await Assert.ThrowsAsync<SocialPreparationRuntimeException>(
                () => adapter.PrepareAsync(
                new PlatformPreparationContext("patreon", "Distinctive title", "Distinctive body", [], targets), new Progress(), CancellationToken.None));

            Assert.Equal("patreon_post_control_missing", error.Code);
            Assert.Contains("create_found=1;create_activated=1", diagnostic.Format(error.Code));
            Assert.Contains("create_activation_stage=completed;create_activation_error_class=none", diagnostic.Format(error.Code));
            Assert.Equal(
                [
                    BrowserPreparationActivationStage.NodeReady,
                    BrowserPreparationActivationStage.ScrollReady,
                    BrowserPreparationActivationStage.BoxReady,
                    BrowserPreparationActivationStage.MousePressSent,
                    BrowserPreparationActivationStage.MouseReleaseSent,
                    BrowserPreparationActivationStage.Completed,
                ],
                stages);
            Assert.Equal(2, socket.Sent.Count(command => Method(command) == "Input.dispatchMouseEvent"));
            Assert.Equal(1, socket.Sent.Count(command => Method(command) == "DOM.scrollIntoViewIfNeeded"));
            Assert.Equal(3, socket.Sent.Count(command => Method(command) == "DOM.getBoxModel"));
        }
        finally
        {
            await transport.DisposeAsync();
        }
    }

    [Fact]
    public async Task ManualDiagnostic_ProductionComposerRouteObservationIsRecorded()
    {
        var fixture = new ProductionFixture();
        var diagnostic = new PatreonManualPreparationDiagnostic();
        var (targets, transport, _) = ProductionTargets(fixture);
        try
        {
            PlatformPreparationResult result = await ProductionAdapter(fixture, diagnostic).PrepareAsync(
                new PlatformPreparationContext("patreon", "Distinctive title", "Distinctive body", [], targets), new Progress(), CancellationToken.None);

            Assert.Equal(PlatformPreparationOutcome.Prepared, result.Outcome);
            Assert.Contains("composer_route_observed=1", diagnostic.Format("manual_patreon_validation_failed"));
        }
        finally
        {
            await transport.DisposeAsync();
        }
    }

    [Fact]
    public async Task ManualDiagnostic_OriginalTargetLossIsRecordedBeforeCleanup()
    {
        var fixture = new ProductionFixture { PostAvailableAfterCreate = false, CancelOnFirstDelay = true, RemoveOriginalTargetAfterCreate = true };
        var diagnostic = new PatreonManualPreparationDiagnostic();
        var (targets, transport, _) = ProductionTargets(fixture);
        try
        {
            SocialPreparationRuntimeException error = await Assert.ThrowsAsync<SocialPreparationRuntimeException>(
                () => ProductionAdapter(fixture, diagnostic).PrepareAsync(
                    new PlatformPreparationContext("patreon", "Distinctive title", "Distinctive body", [], targets), new Progress(), CancellationToken.None));

            Assert.Equal("patreon_post_control_missing", error.Code);
            Assert.Contains("original_target_present=0;replacement_target_appeared=0", diagnostic.Format(error.Code));
        }
        finally
        {
            await transport.DisposeAsync();
        }
    }

    [Fact]
    public async Task ManualDiagnostic_ReplacementTargetExcludesBaselineOperatorTabs()
    {
        var fixture = new ProductionFixture { PostAvailableAfterCreate = false, CancelOnFirstDelay = true, AddReplacementTargetAfterCreate = true };
        fixture.AddBaselineTarget("operator-tab");
        var diagnostic = new PatreonManualPreparationDiagnostic();
        var (targets, transport, _) = ProductionTargets(fixture);
        try
        {
            SocialPreparationRuntimeException error = await Assert.ThrowsAsync<SocialPreparationRuntimeException>(
                () => ProductionAdapter(fixture, diagnostic).PrepareAsync(
                    new PlatformPreparationContext("patreon", "Distinctive title", "Distinctive body", [], targets), new Progress(), CancellationToken.None));

            string trace = diagnostic.Format(error.Code);
            Assert.Equal("patreon_post_control_missing", error.Code);
            Assert.Contains("original_target_present=1;replacement_target_appeared=1", trace);
            Assert.DoesNotContain("operator-tab", trace);
            Assert.DoesNotContain("example.test", trace);
            Assert.DoesNotContain("Fixture page", trace);
        }
        finally
        {
            await transport.DisposeAsync();
        }
    }

    [Fact]
    public async Task ManualDiagnostic_OrdinaryCleanupFollowsTopologyCaptureWithoutChangingPrimaryError()
    {
        var fixture = new ProductionFixture { PostAvailableAfterCreate = false, CancelOnFirstDelay = true };
        var diagnostic = new PatreonManualPreparationDiagnostic();
        var (targets, transport, _) = ProductionTargets(fixture);
        try
        {
            SocialPreparationRuntimeException error = await Assert.ThrowsAsync<SocialPreparationRuntimeException>(
                () => ProductionAdapter(fixture, diagnostic).PrepareAsync(
                    new PlatformPreparationContext("patreon", "Distinctive title", "Distinctive body", [], targets), new Progress(), CancellationToken.None));

            Assert.Equal("patreon_post_control_missing", error.Code);
            Assert.Contains("original_target_present=1;replacement_target_appeared=0", diagnostic.Format(error.Code));
            Assert.Equal(["patreon-fixture"], fixture.ClosedTargetIds);
        }
        finally
        {
            await transport.DisposeAsync();
        }
    }

    [Fact]
    public async Task ManualDiagnostic_TopologyFailureIsIsolatedFromThePrimaryError()
    {
        var fixture = new ProductionFixture { PostAvailableAfterCreate = false, CancelOnFirstDelay = true, FailTopologyInventory = true };
        var diagnostic = new PatreonManualPreparationDiagnostic();
        var (targets, transport, _) = ProductionTargets(fixture);
        try
        {
            SocialPreparationRuntimeException error = await Assert.ThrowsAsync<SocialPreparationRuntimeException>(
                () => ProductionAdapter(fixture, diagnostic).PrepareAsync(
                    new PlatformPreparationContext("patreon", "Distinctive title", "Distinctive body", [], targets), new Progress(), CancellationToken.None));

            string trace = diagnostic.Format(error.Code);
            Assert.Equal("patreon_post_control_missing", error.Code);
            Assert.Contains("original_target_present=unknown;replacement_target_appeared=unknown", trace);
            Assert.DoesNotContain("malformed", trace, StringComparison.OrdinalIgnoreCase);
            Assert.Equal(["patreon-fixture"], fixture.ClosedTargetIds);
        }
        finally
        {
            await transport.DisposeAsync();
        }
    }

    private static PatreonSocialPreparationAdapter Adapter(FakePage page, PatreonManualPreparationDiagnostic? diagnostic = null) =>
        new(_ => page, Timing(page), diagnostic);

    private static PatreonSocialPreparationAdapter ProductionAdapter(
        ProductionFixture fixture,
        PatreonManualPreparationDiagnostic? diagnostic = null) =>
        new(targets => new PatreonPreparationPage(
            targets,
            "creator",
            fixture.Timing,
            diagnostic is null ? null : diagnostic.ObserveCreateActivation), fixture.Timing, diagnostic);

    private static PatreonTiming Timing(FakePage page) =>
        new(TimeSpan.FromMilliseconds(400), () => page.Now, (delay, cancellationToken) =>
        {
            cancellationToken.ThrowIfCancellationRequested();
            page.Now += delay;
            return Task.CompletedTask;
        }, _ => new CancellationTokenSource());

    private static PlatformPreparationContext Context(
        string title = "Release title",
        string body = "Patreon body\n\nUnicode ✓",
        IReadOnlyList<string>? media = null) =>
        new("patreon", title, body, media ?? [], null);

    private static PatreonReadiness Ready() => new(true, true, true, false, false, true);
    private static PatreonReadiness NotReady() => new(false, false, false, true, false, false);

    private static async Task AssertFailureAsync(
        FakePage page,
        string code,
        string title = "Release title",
        string body = "Patreon body\n\nUnicode ✓",
        IReadOnlyList<string>? media = null)
    {
        SocialPreparationRuntimeException error = await Assert.ThrowsAsync<SocialPreparationRuntimeException>(
            () => Adapter(page).PrepareAsync(Context(title, body, media), new Progress(), CancellationToken.None));
        Assert.Equal(code, error.Code);
        Assert.True(page.Abandoned || page.Relinquished);
    }

    private static string Constant(Type type, string name) =>
        Assert.IsType<string>(type.GetField(name, BindingFlags.Static | BindingFlags.NonPublic)!.GetRawConstantValue());

    private static int IntConstant(Type type, string name) =>
        Assert.IsType<int>(type.GetField(name, BindingFlags.Static | BindingFlags.NonPublic)!.GetRawConstantValue());

    private static (BrowserPreparationTargets Targets, CdpTransport Transport, CdpTestSocket Socket) ProductionTargets(ProductionFixture fixture)
    {
        var socket = new CdpTestSocket();
        socket.OnSendAsync = message =>
        {
            using JsonDocument document = JsonDocument.Parse(message);
            JsonElement command = document.RootElement;
            long id = command.GetProperty("id").GetInt64();
            string method = command.GetProperty("method").GetString()!;
            JsonElement parameters = command.TryGetProperty("params", out JsonElement value) ? value : default;
            fixture.ObserveActivationCommand(method, parameters);
            if (fixture.CancelActivationCommand(method)) return Task.CompletedTask;
            if (fixture.TryActivationFailure(method, parameters, out object? error))
            {
                socket.EnqueueJson(JsonSerializer.Serialize(new { id, error }));
                return Task.CompletedTask;
            }
            object result = method switch
            {
                "Target.getTargets" => fixture.TargetsResponse(),
                "Target.createTarget" => fixture.CreateTarget(),
                "Target.closeTarget" => fixture.CloseTarget(parameters.GetProperty("targetId").GetString()!),
                "Target.attachToTarget" => new { sessionId = "patreon-session" },
                "Target.detachFromTarget" => fixture.Detach(),
                "Page.navigate" => new { frameId = "patreon-frame" },
                "Page.getNavigationHistory" => new
                {
                    currentIndex = 0,
                    entries = new[] { new { id = 1, url = fixture.CurrentUrl, title = "Patreon draft" } },
                },
                "DOM.getDocument" => fixture.Document(),
                "DOM.querySelector" => new { nodeId = fixture.Query(parameters.GetProperty("nodeId").GetInt32(), parameters.GetProperty("selector").GetString()!) },
                "DOM.querySelectorAll" => fixture.QueryAllResponse(parameters.GetProperty("nodeId").GetInt32(), parameters.GetProperty("selector").GetString()!),
                "DOM.describeNode" => new { node = fixture.Describe(parameters.GetProperty("nodeId").GetInt32(), parameters.TryGetProperty("depth", out JsonElement depth) ? depth.GetInt32() : 0) },
                "DOM.getAttributes" => new { attributes = fixture.Attributes(parameters.GetProperty("nodeId").GetInt32()) },
                "DOM.getBoxModel" => new { model = fixture.Box(parameters.GetProperty("backendNodeId").GetInt64()) },
                "Input.dispatchMouseEvent" => fixture.MouseEvent(parameters),
                "DOM.setFileInputFiles" => fixture.Assign(parameters.GetProperty("files").EnumerateArray().Select(path => path.GetString()!).ToArray()),
                "DOM.focus" => fixture.Focus(parameters.GetProperty("nodeId").GetInt32()),
                "Input.dispatchKeyEvent" => fixture.KeyEvent(parameters),
                "Input.insertText" => fixture.InsertText(parameters.GetProperty("text").GetString()!),
                "Accessibility.getPartialAXTree" => new { nodes = new[] { new { value = new { value = fixture.TitleFromEditingTranscript } } } },
                _ => new { },
            };
            socket.EnqueueJson(JsonSerializer.Serialize(new { id, result }));
            return Task.CompletedTask;
        };
        var transport = new CdpTransport(socket);
        return (new BrowserPreparationTargets(new CdpTargetManager(transport)), transport, socket);
    }

    private static void DisposeSynchronously(BrowserPreparationSession session) =>
        session.DisposeAsync().AsTask().GetAwaiter().GetResult();

    private static string Method(string command)
    {
        using JsonDocument document = JsonDocument.Parse(command);
        return document.RootElement.GetProperty("method").GetString()!;
    }

    private static string Method(JsonElement command) => command.GetProperty("method").GetString()!;

    private static void AssertMouse(JsonElement command, int x, int y, string type, int buttons)
    {
        JsonElement parameters = command.GetProperty("params");
        Assert.Equal(type, parameters.GetProperty("type").GetString());
        Assert.Equal(x, parameters.GetProperty("x").GetDouble());
        Assert.Equal(y, parameters.GetProperty("y").GetDouble());
        Assert.Equal("left", parameters.GetProperty("button").GetString());
        Assert.Equal(buttons, parameters.GetProperty("buttons").GetInt32());
    }

    private static void AssertApprovedTextKeyEvent(JsonElement command)
    {
        JsonElement parameters = command.GetProperty("params");
        if (!parameters.TryGetProperty("key", out JsonElement key) || key.GetString() != "Enter") return;
        Assert.Equal(8, parameters.GetProperty("modifiers").GetInt32());
        string type = parameters.GetProperty("type").GetString()!;
        if (type == "rawKeyDown")
            Assert.Equal(["InsertLineBreak"], parameters.GetProperty("commands").EnumerateArray().Select(command => command.GetString()).ToArray());
        else
            Assert.Equal("keyUp", type);
    }

    private static JsonElement Editor(params object[] children) =>
        Node("DIV", ["contenteditable", "true", "role", "textbox", "aria-label", "Text input field for post content"], children);

    private static object Paragraph(params object[] children) =>
        new { nodeName = "P", attributes = Array.Empty<string>(), children };

    private static object NonEditable(string text) =>
        new { nodeName = "DIV", attributes = new[] { "contenteditable", "false" }, children = new object[] { Text(text) } };

    private static object Br() => new { nodeName = "BR", attributes = Array.Empty<string>() };
    private static object Text(string value) => new { nodeName = "#text", nodeValue = value };
    private static object Element(string name, params object[] children) => new { nodeName = name, attributes = Array.Empty<string>(), children };

    private static JsonElement Node(string name, string[] attributes, object[] children)
    {
        using JsonDocument document = JsonDocument.Parse(JsonSerializer.Serialize(new { nodeName = name, attributes, children }));
        return document.RootElement.Clone();
    }

    private sealed class Progress : IPreparationProgress
    {
        internal List<SocialPreparationProgress> Values { get; } = [];
        public Task ReportAsync(SocialPreparationProgress progress, CancellationToken cancellationToken)
        {
            Values.Add(progress);
            return Task.CompletedTask;
        }
    }

    private sealed class FakePage : IPatreonPreparationPage
    {
        public string? OwnedTargetId => "fake-patreon-target";
        internal PatreonHomeState Home { get; set; } = PatreonHomeState.Authenticated;
        internal bool CreateAvailable { get; set; } = true;
        internal bool PostAvailable { get; set; } = true;
        internal bool ComposerAvailable { get; set; } = true;
        internal bool Relinquished { get; private set; }
        internal bool Abandoned { get; private set; }
        internal bool AuthenticationClassified { get; private set; }
        internal Exception? RelinquishFailure { get; set; }
        internal List<string> Activations { get; } = [];
        internal List<string> ExpectedActivations { get; } = ["create", "post"];
        internal List<string> SettingsMutations { get; } = [];
        internal FakeComposer Composer { get; } = new();
        internal Progress Progress { get; } = new();
        internal DateTimeOffset Now { get; set; } = DateTimeOffset.UnixEpoch;

        public Task<PatreonHomeState> NavigateAndWaitForHomeAsync(CancellationToken cancellationToken)
        {
            AuthenticationClassified = Home is PatreonHomeState.AuthenticationRequired or PatreonHomeState.ManualAttentionRequired;
            return Task.FromResult(Home);
        }

        public Task<bool> ActivateCreateAsync(Action? createFound, CancellationToken cancellationToken)
        {
            if (!CreateAvailable) return Task.FromResult(false);
            createFound?.Invoke();
            Activations.Add("create");
            return Task.FromResult(true);
        }

        public Task<bool> ActivatePostEntryAsync(Action? postFound, CancellationToken cancellationToken)
        {
            if (!PostAvailable) return Task.FromResult(false);
            postFound?.Invoke();
            Activations.Add("post");
            return Task.FromResult(true);
        }

        public Task<IPatreonComposer?> WaitForComposerAsync(CancellationToken cancellationToken) =>
            Task.FromResult<IPatreonComposer?>(ComposerAvailable ? Composer : null);

        public Task<bool> IsExpectedComposerRouteAsync(CancellationToken cancellationToken) => Task.FromResult(true);

        public Task RelinquishAsync(CancellationToken cancellationToken)
        {
            if (RelinquishFailure is not null) return Task.FromException(RelinquishFailure);
            Relinquished = true;
            return Task.CompletedTask;
        }

        public Task AbandonAsync(CancellationToken cancellationToken)
        {
            Abandoned = true;
            return Task.CompletedTask;
        }

        public ValueTask DisposeAsync() => ValueTask.CompletedTask;
    }

    private sealed class FakeComposer : IPatreonComposer
    {
        private readonly Queue<PatreonReadiness> _readiness = new([Ready()]);

        internal string? ReplacedTitle { get; private set; }
        internal string? ReplacedBody { get; private set; }
        internal List<string> AssignedPaths { get; } = [];
        internal List<int> IntendedCounts { get; } = [];
        internal int ReadinessCalls { get; private set; }
        internal bool PersistentPhotosInputAssigned { get; private set; }
        internal bool PublishActivated { get; private set; }
        internal bool TitleMatches { get; set; } = true;
        internal bool BodyMatches { get; set; } = true;
        internal bool FinalTitleMatches { get; set; } = true;
        internal bool FinalBodyMatches { get; set; } = true;
        internal PatreonMediaAssignment Assignment { get; set; } = PatreonMediaAssignment.Assigned;
        internal PatreonFinalState Final { get; set; } = new(true, true, true, false);

        internal IReadOnlyList<PatreonReadiness> Readiness
        {
            set
            {
                _readiness.Clear();
                foreach (PatreonReadiness readiness in value) _readiness.Enqueue(readiness);
            }
        }

        public Task<bool> ReplaceAndVerifyTitleAsync(string title, CancellationToken cancellationToken)
        {
            ReplacedTitle = title;
            return Task.FromResult(TitleMatches);
        }

        public Task<bool> ReplaceAndVerifyBodyAsync(string body, CancellationToken cancellationToken)
        {
            ReplacedBody = body;
            return Task.FromResult(BodyMatches);
        }

        public Task<PatreonMediaAssignment> AttachImagesAsync(IReadOnlyList<string> paths, CancellationToken cancellationToken)
        {
            if (Assignment == PatreonMediaAssignment.Assigned)
            {
                AssignedPaths.AddRange(paths);
                PersistentPhotosInputAssigned = true;
            }
            return Task.FromResult(Assignment);
        }

        public Task<PatreonReadiness> ReadReadinessAsync(int intendedCount, CancellationToken cancellationToken)
        {
            ReadinessCalls++;
            IntendedCounts.Add(intendedCount);
            PatreonReadiness readiness = _readiness.Count > 1 ? _readiness.Dequeue() : _readiness.Peek();
            return Task.FromResult(readiness.PreviewNodeIds is null
                ? readiness with { PreviewNodeIds = Enumerable.Range(1, intendedCount).ToArray() }
                : readiness);
        }

        public Task<bool> VerifyTitleAsync(string title, CancellationToken cancellationToken) =>
            Task.FromResult(FinalTitleMatches && string.Equals(title, ReplacedTitle, StringComparison.Ordinal));

        public Task<bool> VerifyBodyAsync(string body, CancellationToken cancellationToken) =>
            Task.FromResult(FinalBodyMatches && string.Equals(body, ReplacedBody, StringComparison.Ordinal));

        public Task<PatreonFinalState> ReadFinalStateAsync(CancellationToken cancellationToken)
        {
            if (ReplacedTitle?.Length == 0) return Task.FromResult(Final with { PublishEnabled = false });
            return Task.FromResult(Final);
        }
    }

    private sealed class ProductionFixture
    {
        private const string OriginalTargetId = "patreon-fixture";
        private const string ReplacementTargetId = "replacement-fixture";
        private readonly List<BodyPart> _body = [];
        private readonly List<TargetSample> _targets = [];
        private CancellationTokenSource? _deadline;
        private int _focusedNodeId;
        private int _bodyDescribeCount;
        private List<int> _previewNodeIds = [];
        private readonly Queue<SaveStatusSample> _saveStatusSamples = new([new SaveStatusSample(111, "Saved", true)]);
        private SaveStatusSample _currentSaveStatus = new(111, "Saved", true);
        private int _targetInventoryRequests;
        private bool _createActivationStarted;
        private bool _homeCreateDescribed;
        private bool _resolutionStarted;
        internal bool ResolutionDeadlineCancellation { get; set; }
        internal bool RootUnavailableAfterHome { get; set; }
        internal object Document() => RootUnavailableAfterHome && _homeCreateDescribed ? new { } : new { root = Node(1) };
        internal object? CreateCandidatesResponse { get; set; }
        internal Dictionary<int, object> CreateDescriptions { get; } = [];
        internal Dictionary<long, object> CreateBoxes { get; } = [];
        internal long? UnavailableCreateBox { get; set; }
        internal string? ResolutionErrorMethod { get; set; }
        internal long? ResolutionErrorIdentity { get; set; }
        internal string ResolutionErrorMessage { get; set; } = "unknown fixture failure";
        internal CancellationTokenSource? ResolutionCancellation { get; set; }

        internal List<string> AssignedPaths { get; } = [];
        internal List<IReadOnlyList<string>> AssignmentBatches { get; } = [];
        internal List<IReadOnlyList<int>> ObservedPreviewNodeOrders { get; } = [];
        internal List<int> ObservedSaveStatusNodeIds { get; } = [];
        internal List<IReadOnlyList<int>> PreviewOrdersAfterAssignments { get; } = [];
        internal IReadOnlyList<int>? InitialPreviewNodeIds
        {
            set => _previewNodeIds = value?.ToList() ?? [];
        }
        internal IReadOnlyList<int>? PreviewOrderAfterFinalBodyVerification { get; set; }
        internal PreviewQueryResponse InitialPreviewQueryResponse { get; set; }
        internal IReadOnlyList<SaveStatusSample> SaveStatusSamples
        {
            set
            {
                _saveStatusSamples.Clear();
                foreach (SaveStatusSample sample in value) _saveStatusSamples.Enqueue(sample);
                _currentSaveStatus = _saveStatusSamples.Count == 0 ? new SaveStatusSample(0, "", false) : _saveStatusSamples.Peek();
            }
        }
        internal bool Detached { get; private set; }
        internal DateTimeOffset Now { get; set; } = DateTimeOffset.UnixEpoch;
        internal PatreonTiming Timing { get; }
        internal string CurrentUrl { get; set; } = "https://www.patreon.com/creator/posts/draft/edit";
        internal string? RouteAfterFinalBodyVerification { get; set; }
        internal bool ChallengeVisible { get; set; }
        internal bool LoginVisible { get; set; }
        internal bool CreateAvailable { get; set; } = true;
        internal bool PostAvailable { get; private set; } = true;
        internal bool PostAvailableAfterCreate { get; set; } = true;
        internal int PostMissingLookupsBeforeAvailable { get; set; }
        internal int PostLookupCount { get; private set; }
        internal bool ComposerAvailable { get; private set; } = true;
        internal bool ComposerAvailableAfterPost { get; set; } = true;
        internal bool RemoveOriginalTargetAfterCreate { get; set; }
        internal bool AddReplacementTargetAfterCreate { get; set; }
        internal bool FailTopologyInventory { get; set; }
        internal bool CancelDeadlineAndFailBaselineInventory { get; set; }
        internal bool DeadlineWasPresentDuringBaseline { get; private set; }
        internal bool PrimaryDeadlineCreatedAfterBaseline { get; private set; }
        internal bool PrimaryDeadlineWasUncancelledAfterBaseline { get; private set; }
        internal int DeadlineCreationCount { get; private set; }
        internal List<string> ClosedTargetIds { get; } = [];
        internal bool CancelOnFirstDelay { get; set; }
        internal bool CorruptBodyReadback { get; set; }
        internal ProductionActivationFailure ActivationFailure { get; set; }
        internal int ActivationFailureCode { get; set; } = -32001;
        internal string ActivationFailureMessage { get; set; } = "fixture command failure";
        internal string? PublishAriaDisabled { get; set; } = "false";
        internal bool PublishNativeDisabled { get; set; }
        internal string TitleFromEditingTranscript { get; private set; } = string.Empty;
        internal string BodyFromEditingTranscript => string.Concat(_body.Select(part => part.Text));

        internal ProductionFixture()
        {
            Timing = new PatreonTiming(
                TimeSpan.FromSeconds(1),
                () => Now,
                (delay, cancellationToken) =>
                {
                    cancellationToken.ThrowIfCancellationRequested();
                    Now += delay;
                    if (CancelOnFirstDelay) _deadline?.Cancel();
                    return Task.CompletedTask;
                },
                _ =>
                {
                    DeadlineCreationCount++;
                    PrimaryDeadlineCreatedAfterBaseline = CancelDeadlineAndFailBaselineInventory && _targetInventoryRequests > 0;
                    _deadline = new CancellationTokenSource();
                    PrimaryDeadlineWasUncancelledAfterBaseline = !_deadline.IsCancellationRequested;
                    return _deadline;
                });
        }

        internal object Detach()
        {
            Detached = true;
            return new { };
        }

        internal void AddBaselineTarget(string targetId) => _targets.Add(new TargetSample(targetId));

        internal object TargetsResponse()
        {
            _targetInventoryRequests++;
            if (CancelDeadlineAndFailBaselineInventory && _targetInventoryRequests == 1)
            {
                DeadlineWasPresentDuringBaseline = _deadline is not null;
                _deadline?.Cancel();
                return new { targetInfos = "malformed" };
            }
            if (FailTopologyInventory && _targetInventoryRequests > 1)
                return new { targetInfos = "malformed" };
            return new
            {
                targetInfos = _targets.Select(target => new
                {
                    targetId = target.TargetId,
                    type = "page",
                    url = "https://example.test/",
                    title = "Fixture page",
                    attached = false,
                }).ToArray(),
            };
        }

        internal object CreateTarget()
        {
            _targets.Add(new TargetSample(OriginalTargetId));
            return new { targetId = OriginalTargetId };
        }

        internal object CloseTarget(string targetId)
        {
            ClosedTargetIds.Add(targetId);
            _targets.RemoveAll(target => target.TargetId == targetId);
            return new { success = true };
        }

        internal void ObserveActivationCommand(string method, JsonElement parameters)
        {
            if (method == "DOM.querySelectorAll" && parameters.GetProperty("selector").GetString()!.Contains("create-content-button")) _resolutionStarted = true;
            if (method == "DOM.describeNode" && parameters.GetProperty("nodeId").GetInt32() == 2) _homeCreateDescribed = true;
            if (method == "DOM.scrollIntoViewIfNeeded" &&
                parameters.TryGetProperty("backendNodeId", out JsonElement backendNodeId) && backendNodeId.GetInt64() == 20)
                _createActivationStarted = true;
        }

        internal bool CancelActivationCommand(string method)
        {
            if (_resolutionStarted && method == ResolutionErrorMethod && ResolutionDeadlineCancellation)
            {
                _deadline!.Cancel();
                return true;
            }
            if (_resolutionStarted && ResolutionCancellation is not null && method == ResolutionErrorMethod)
            {
                ResolutionCancellation.Cancel();
                return true;
            }
            if (ActivationFailure != ProductionActivationFailure.Timeout || !_createActivationStarted || method != "DOM.getBoxModel") return false;
            _deadline!.Cancel();
            return true;
        }

        internal bool TryActivationFailure(string method, JsonElement parameters, out object? error)
        {
            error = null;
            if ((_resolutionStarted && method == ResolutionErrorMethod && (ResolutionErrorIdentity is null ||
                parameters.GetProperty(method == "DOM.describeNode" ? "nodeId" : "backendNodeId").GetInt64() == ResolutionErrorIdentity)) || (method == "DOM.getBoxModel" &&
                parameters.GetProperty("backendNodeId").GetInt64() == UnavailableCreateBox))
            {
                error = new { code = -32000, message = method == ResolutionErrorMethod ? ResolutionErrorMessage : "Could not compute box model." };
                return true;
            }
            if (ActivationFailure == ProductionActivationFailure.InvalidBox && method == "DOM.getBoxModel")
            {
                error = null;
                return false;
            }
            string? mouseType = method == "Input.dispatchMouseEvent" && parameters.TryGetProperty("type", out JsonElement type)
                ? type.GetString()
                : null;
            if ((ActivationFailure == ProductionActivationFailure.ScrollCommand && _createActivationStarted && method == "DOM.scrollIntoViewIfNeeded") ||
                (ActivationFailure == ProductionActivationFailure.BoxCommand && _createActivationStarted && method == "DOM.getBoxModel") ||
                (ActivationFailure == ProductionActivationFailure.MousePressCommand && mouseType == "mousePressed") ||
                (ActivationFailure == ProductionActivationFailure.MouseReleaseCommand && mouseType == "mouseReleased"))
            {
                error = new { code = ActivationFailureCode, message = ActivationFailureMessage };
                return true;
            }
            return false;
        }

        internal object MouseEvent(JsonElement parameters)
        {
            if (!parameters.TryGetProperty("type", out JsonElement type) || type.GetString() != "mouseReleased" ||
                !parameters.TryGetProperty("x", out JsonElement x)) return new { };
            if (x.GetDouble() == 10)
            {
                PostAvailable = PostAvailableAfterCreate;
                if (RemoveOriginalTargetAfterCreate)
                    _targets.RemoveAll(target => target.TargetId == OriginalTargetId);
                if (AddReplacementTargetAfterCreate && _targets.All(target => target.TargetId != ReplacementTargetId))
                    _targets.Add(new TargetSample(ReplacementTargetId));
            }
            else if (x.GetDouble() == 30)
            {
                ComposerAvailable = ComposerAvailableAfterPost;
            }
            return new { };
        }

        internal object Assign(string[] paths)
        {
            AssignedPaths.AddRange(paths);
            AssignmentBatches.Add(paths);
            int assignmentIndex = AssignmentBatches.Count - 1;
            _previewNodeIds = assignmentIndex < PreviewOrdersAfterAssignments.Count
                ? PreviewOrdersAfterAssignments[assignmentIndex].ToList()
                : [.. _previewNodeIds, 100 + AssignmentBatches.Count];
            return new { };
        }

        internal object Focus(int nodeId)
        {
            _focusedNodeId = nodeId;
            return new { };
        }

        internal object KeyEvent(JsonElement parameters)
        {
            if (!parameters.TryGetProperty("type", out JsonElement type) || (type.GetString() is not "keyDown" and not "rawKeyDown") ||
                !parameters.TryGetProperty("key", out JsonElement key)) return new { };
            if (key.GetString() == "a" && parameters.TryGetProperty("modifiers", out JsonElement modifiers) && modifiers.GetInt32() == 2)
            {
                if (_focusedNodeId == 4) TitleFromEditingTranscript = string.Empty;
                if (_focusedNodeId == 5) _body.Clear();
            }
            else if (key.GetString() == "Enter" && parameters.TryGetProperty("commands", out JsonElement commands) &&
                commands.ValueKind == JsonValueKind.Array && commands.EnumerateArray().Any(command => command.GetString() == "InsertLineBreak") && _focusedNodeId == 5)
            {
                _body.Add(new BodyPart("\n", true));
            }
            return new { };
        }

        internal object InsertText(string text)
        {
            if (_focusedNodeId == 4) TitleFromEditingTranscript += text;
            if (_focusedNodeId == 5) _body.Add(new BodyPart(text, false));
            return new { };
        }

        internal int Query(int root, string selector)
        {
            if (root == 1 && selector == "button[data-tag='create-content-option-POST'][role='menuitem']")
            {
                PostLookupCount++;
                return PostAvailable && PostLookupCount > PostMissingLookupsBeforeAvailable ? 3 : 0;
            }

            return (root, selector) switch
            {
                (1, "button[data-tag='create-content-button'][aria-label='Create post'][aria-haspopup='menu']") when CreateAvailable => 2,
                (1, "textarea[aria-label='Title'][placeholder='Title']") when ComposerAvailable => 4,
                (1, "[data-tag='text-editor-remirror-wrapper'] [contenteditable='true'][role='textbox'][aria-label='Text input field for post content']") when ComposerAvailable => 5,
                (1, "button[data-tag='make-a-post-action-publish']") when ComposerAvailable => 6,
                (1, "#photosInput[type='file'][multiple]") => 7,
                (1, "div[class*='EditorLayout-module'][class*='actions'] div[class*='CompactSaveStatus-module'][aria-hidden='false'] > p") => NextSaveStatusNodeId(),
                (1, "form[action*='login'], input[type='password'], button[data-tag*='login']") when CurrentUrl.Contains("/login", StringComparison.Ordinal) => 10,
                _ => 0,
            };
        }

        internal int[] QueryAll(int root, string selector)
        {
            if (root != 1) return [];
            if (selector == "img[data-tag='gallery-image'], div[role='button'][aria-roledescription='sortable'] [data-tag='preview-thumbnail-container'] img[alt='Preview']")
            {
                int[] previews = _previewNodeIds.ToArray();
                ObservedPreviewNodeOrders.Add(previews);
                return previews;
            }
            return selector switch
            {
                "form[action*='challenge'], iframe[src*='captcha'], [data-testid*='captcha'], [data-tag*='challenge'], [data-tag*='verification']" => [9],
                "form[action*='login'], input[type='password'], button[data-tag*='login']" when CurrentUrl.Contains("/login", StringComparison.Ordinal) => [10],
                _ => [],
            };
        }

        internal object QueryAllResponse(int root, string selector)
        {
            if (root == 1 && selector == "button[data-tag='create-content-button'][aria-label='Create post'][aria-haspopup='menu']")
                return CreateCandidatesResponse ?? new { nodeIds = new[] { 2 } };
            const string galleryImage = "img[data-tag='gallery-image'], div[role='button'][aria-roledescription='sortable'] [data-tag='preview-thumbnail-container'] img[alt='Preview']";
            if (root == 1 && selector == galleryImage && InitialPreviewQueryResponse != PreviewQueryResponse.Valid)
            {
                PreviewQueryResponse response = InitialPreviewQueryResponse;
                InitialPreviewQueryResponse = PreviewQueryResponse.Valid;
                return response switch
                {
                    PreviewQueryResponse.MissingNodeIds => new { },
                    PreviewQueryResponse.MalformedNodeIds => new { nodeIds = "malformed" },
                    PreviewQueryResponse.InvalidNodeId => new { nodeIds = new object[] { 0 } },
                    _ => throw new ArgumentOutOfRangeException(nameof(response)),
                };
            }
            return new { nodeIds = QueryAll(root, selector) };
        }

        internal object Describe(int id, int depth)
        {
            if (CreateDescriptions.TryGetValue(id, out object? description)) return description;
            if (id == _currentSaveStatus.NodeId && id > 0 && depth > 0) return SaveStatusNode(_currentSaveStatus);
            if (id == 1 && depth > 0)
                return new
                {
                    nodeId = 1,
                    backendNodeId = 10L,
                    nodeName = "HTML",
                    attributes = Array.Empty<string>(),
                    children = new object[]
                    {
                        new { nodeId = 9, backendNodeId = 90L, nodeName = "#text", nodeValue = "Saved" },
                    },
                };
            if (id == 5 && depth > 0)
            return new
            {
                    nodeId = 5,
                    backendNodeId = 50L,
                    nodeName = "DIV",
                    attributes = Attributes(5),
                    children = new object[]
                    {
                        new
                        {
                            nodeId = 51,
                            backendNodeId = 510L,
                            nodeName = "DIV",
                            attributes = new[] { "contenteditable", "false" },
                            children = new object[] { new { nodeId = 52, backendNodeId = 520L, nodeName = "#text", nodeValue = "Paid members only" } },
                        },
                        BodyParagraph(),
                    },
                };
            return Node(id);
        }

        internal object Node(int id) => new
        {
            nodeId = id,
            backendNodeId = (long)id * 10,
            nodeName = Name(id),
            attributes = Attributes(id),
        };

        internal string Name(int id) => id switch
        {
            4 => "TEXTAREA",
            5 => "DIV",
            6 => "BUTTON",
            7 => "INPUT",
            8 => "IMG",
            9 => "IFRAME",
            10 => "FORM",
            _ => "BUTTON",
        };

        internal string[] Attributes(int id)
        {
            if (id == 6)
            {
                var attributes = new List<string> { "data-tag", "make-a-post-action-publish", "type", "button" };
                if (PublishNativeDisabled) attributes.AddRange(["disabled", ""]);
                if (PublishAriaDisabled is not null) attributes.AddRange(["aria-disabled", PublishAriaDisabled]);
                return attributes.ToArray();
            }
            return id switch
            {
                2 => ["data-tag", "create-content-button", "aria-label", "Create post", "aria-haspopup", "menu"],
                3 => ["data-tag", "create-content-option-POST", "role", "menuitem"],
                4 => ["aria-label", "Title", "placeholder", "Title"],
                5 => ["contenteditable", "true", "role", "textbox", "aria-label", "Text input field for post content"],
                7 => ["id", "photosInput", "type", "file", "multiple", ""],
                8 => ["data-tag", "gallery-image"],
                9 => ["src", "https://captcha.test/challenge"],
                10 => ["action", "/login"],
                _ => [],
            };
        }

        internal object Box(long backendNodeId)
        {
            if (CreateBoxes.TryGetValue(backendNodeId, out object? box)) return box;
            if (_createActivationStarted && ActivationFailure == ProductionActivationFailure.InvalidBox && backendNodeId == 20)
                return new { border = new[] { 0, 0, 20, 0 } };
            int[] border = backendNodeId switch
            {
                20 => [0, 0, 20, 0, 20, 20, 0, 20],
                30 => [20, 0, 40, 0, 40, 20, 20, 20],
                _ => [0, 0, 20, 0, 20, 20, 0, 20],
            };
            bool hiddenEvidence = (backendNodeId == 90 && !ChallengeVisible) || (backendNodeId == 100 && !LoginVisible) ||
                (backendNodeId == (long)_currentSaveStatus.NodeId * 10 && !_currentSaveStatus.Visible);
            return new { width = hiddenEvidence ? 0 : 100, height = hiddenEvidence ? 0 : 80, border };
        }

        private object BodyParagraph()
        {
            _bodyDescribeCount++;
            if (_bodyDescribeCount == 2)
            {
                if (RouteAfterFinalBodyVerification is not null) CurrentUrl = RouteAfterFinalBodyVerification;
                if (PreviewOrderAfterFinalBodyVerification is not null) _previewNodeIds = PreviewOrderAfterFinalBodyVerification.ToList();
            }
            var children = new List<object>();
            int nodeId = 53;
            foreach (BodyPart part in _body)
            {
                children.Add(part.IsLineBreak
                    ? new { nodeId = nodeId++, backendNodeId = (long)nodeId * 10, nodeName = "BR", attributes = Array.Empty<string>() }
                    : new { nodeId = nodeId++, backendNodeId = (long)nodeId * 10, nodeName = "#text", nodeValue = CorruptBodyReadback ? part.Text + "!" : part.Text });
            }
            return new { nodeId = 52, backendNodeId = 520L, nodeName = "P", attributes = Array.Empty<string>(), children = children.ToArray() };
        }

        private int NextSaveStatusNodeId()
        {
            if (_saveStatusSamples.Count == 0) return 0;
            _currentSaveStatus = _saveStatusSamples.Count > 1 ? _saveStatusSamples.Dequeue() : _saveStatusSamples.Peek();
            ObservedSaveStatusNodeIds.Add(_currentSaveStatus.NodeId);
            return _currentSaveStatus.NodeId;
        }

        private static object SaveStatusNode(SaveStatusSample sample) => new
        {
            nodeId = sample.NodeId,
            backendNodeId = (long)sample.NodeId * 10,
            nodeName = "P",
            attributes = Array.Empty<string>(),
            children = sample.Text == "Saving"
                ? new object[]
                {
                    new { nodeId = sample.NodeId + 1, backendNodeId = (long)(sample.NodeId + 1) * 10, nodeName = "#text", nodeValue = "Saving" },
                    new
                    {
                        nodeId = sample.NodeId + 2,
                        backendNodeId = (long)(sample.NodeId + 2) * 10,
                        nodeName = "SPAN",
                        attributes = new[] { "aria-hidden", "true" },
                        children = new object[] { new { nodeId = sample.NodeId + 3, backendNodeId = (long)(sample.NodeId + 3) * 10, nodeName = "#text", nodeValue = "..." } },
                    },
                }
                : new object[] { new { nodeId = sample.NodeId + 1, backendNodeId = (long)(sample.NodeId + 1) * 10, nodeName = "#text", nodeValue = sample.Text } },
        };

        internal sealed record SaveStatusSample(int NodeId, string Text, bool Visible);
        private sealed record BodyPart(string Text, bool IsLineBreak);
        private sealed record TargetSample(string TargetId);
    }

    private enum PreviewQueryResponse { Valid, MissingNodeIds, MalformedNodeIds, InvalidNodeId }
    public enum ProductionActivationFailure { None, InvalidBox, ScrollCommand, BoxCommand, MousePressCommand, MouseReleaseCommand, Timeout }
}
