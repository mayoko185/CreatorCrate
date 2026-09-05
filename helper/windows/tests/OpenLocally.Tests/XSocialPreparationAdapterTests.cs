using OpenLocally;
using System.Text.Json;

namespace OpenLocally.Tests;

public sealed class XSocialPreparationAdapterTests
{
    [Fact]
    public async Task NoMediaSuccess_UsesExactBodyAndRelinquishes()
    {
        var page = new FakePage();
        var progress = new Progress();

        PlatformPreparationResult result = await Adapter(page).PrepareAsync(Context(), progress, CancellationToken.None);

        Assert.Equal(PlatformPreparationOutcome.Prepared, result.Outcome);
        Assert.Equal(Context().Body, page.Composer.ReplacedText);
        Assert.Equal([SocialPreparationProgress.Preparing], progress.Values);
        Assert.True(page.Relinquished);
        Assert.False(page.Abandoned);
    }

    [Theory]
    [InlineData("AuthenticationRequired")]
    [InlineData("ManualAttentionRequired")]
    public async Task AuthenticationAndManualAttention_PreserveTheOwnedPage(string state)
    {
        var page = new FakePage { Home = Enum.Parse<XHomeState>(state) };

        PlatformPreparationResult result = await Adapter(page).PrepareAsync(Context(), new Progress(), CancellationToken.None);

        Assert.Equal(PlatformPreparationOutcome.AuthenticationRequired, result.Outcome);
        Assert.True(page.Relinquished);
        Assert.False(page.Abandoned);
    }

    [Theory]
    [InlineData("TimedOut", "x_home_timeout")]
    [InlineData("Authenticated", "x_compose_missing")]
    public async Task HomeAndComposeFailures_AreCurated(string state, string code)
    {
        var page = new FakePage { Home = Enum.Parse<XHomeState>(state), ComposeAvailable = code != "x_compose_missing" };
        await AssertFailureAsync(page, code);
    }

    [Fact]
    public async Task MissingComposerAndTextMismatch_AreCurated()
    {
        await AssertFailureAsync(new FakePage { ComposerAvailable = false }, "x_composer_missing");
        var page = new FakePage();
        page.Composer.ReplaceMatches = false;
        await AssertFailureAsync(page, "x_text_mismatch");
    }

    [Fact]
    public async Task InitialTextMismatch_ReportsOnlyBoundedDiagnosticToTheOptInSink()
    {
        const string expected = "A\u00a0\u200b\nZ";
        const string actual = "A\u00a0\u200c\r\nZ";
        const string mediaPath = @"C:\secret\release.png";
        var fixture = new XFixture(actual);
        var (targets, transport, socket) = FixtureTargets(fixture);
        var page = new XPreparationPage(targets, fixture.Timing);
        var diagnostics = new List<BrowserTextMismatchDiagnostic>();
        var adapter = new XSocialPreparationAdapter(_ => page, fixture.Timing, diagnostics.Add);
        try
        {
            SocialPreparationRuntimeException error = await Assert.ThrowsAsync<SocialPreparationRuntimeException>(
                () => adapter.PrepareAsync(Context(body: expected, media: [mediaPath]), new Progress(), CancellationToken.None));

            Assert.Equal("x_text_mismatch", error.Code);
            BrowserTextMismatchDiagnostic diagnostic = Assert.Single(diagnostics);
            Assert.Equal(expected.Length, diagnostic.ExpectedUtf16Length);
            Assert.Equal(actual.Length, diagnostic.ActualUtf16Length);
            Assert.Equal(2, diagnostic.FirstDifferenceIndex);
            Assert.Equal("U+200B", diagnostic.ExpectedCodePoint);
            Assert.Equal("U+200C", diagnostic.ActualCodePoint);
            Assert.Equal(1, diagnostic.ExpectedLfCount);
            Assert.Equal(1, diagnostic.ActualLfCount);
            Assert.Equal(0, diagnostic.ExpectedCrCount);
            Assert.Equal(1, diagnostic.ActualCrCount);
            Assert.True(diagnostic.ExpectedHasNbsp);
            Assert.True(diagnostic.ActualHasNbsp);
            Assert.True(diagnostic.ExpectedHasZeroWidth);
            Assert.True(diagnostic.ActualHasZeroWidth);
            Assert.Equal("x_draft_blocks;contents_found=1;direct_block_count=2;descendant_block_count=2;blocks=0:text=1,br=0,1:text=1,br=0;block_summaries_truncated=0;traversal_bound_reached=0", diagnostic.ReadbackStructure);
            Assert.Empty(fixture.AssignedPaths);
            Assert.DoesNotContain(socket.Sent, message => Method(message) == "DOM.setFileInputFiles");

            string surfaced = diagnostic.ToString();
            Assert.DoesNotContain(expected, surfaced);
            Assert.DoesNotContain(actual, surfaced);
            Assert.DoesNotContain(mediaPath, surfaced);
            Assert.DoesNotContain("<div", surfaced, StringComparison.OrdinalIgnoreCase);
            Assert.DoesNotContain("capability-token", surfaced, StringComparison.OrdinalIgnoreCase);
        }
        finally
        {
            await page.DisposeAsync();
            await transport.DisposeAsync();
        }
    }

    [Fact]
    public async Task InitialTextMismatch_BoundsDirectBlockSummariesWithoutLeakingOmittedText()
    {
        const int expectedRenderedBlockCount = 16;
        const int directBlockCount = expectedRenderedBlockCount + 1;
        const string omittedBlockText = "distinctive-omitted-block-text";
        string actual = string.Join("\n", Enumerable.Range(0, directBlockCount).Select(index =>
            index == directBlockCount - 1 ? omittedBlockText : $"block-{index}"));
        var fixture = new XFixture(actual);
        var (targets, transport, socket) = FixtureTargets(fixture);
        var page = new XPreparationPage(targets, fixture.Timing);
        var diagnostics = new List<BrowserTextMismatchDiagnostic>();
        var adapter = new XSocialPreparationAdapter(_ => page, fixture.Timing, diagnostics.Add);
        try
        {
            SocialPreparationRuntimeException error = await Assert.ThrowsAsync<SocialPreparationRuntimeException>(
                () => adapter.PrepareAsync(Context(body: "expected-body"), new Progress(), CancellationToken.None));

            Assert.Equal("x_text_mismatch", error.Code);
            BrowserTextMismatchDiagnostic diagnostic = Assert.Single(diagnostics);
            Assert.Equal(actual.Length, diagnostic.ActualUtf16Length);
            Assert.Equal(directBlockCount - 1, diagnostic.ActualLfCount);
            Assert.Equal(0, diagnostic.ActualCrCount);

            string expectedBlocks = string.Join(",", Enumerable.Range(0, expectedRenderedBlockCount)
                .Select(index => $"{index}:text=1,br=0"));
            Assert.Equal(
                $"x_draft_blocks;contents_found=1;direct_block_count={directBlockCount};descendant_block_count={directBlockCount};blocks={expectedBlocks};block_summaries_truncated=1;traversal_bound_reached=0",
                diagnostic.ReadbackStructure);
            Assert.DoesNotContain("16:text=", diagnostic.ReadbackStructure);
            Assert.DoesNotContain(omittedBlockText, diagnostic.ReadbackStructure);
            Assert.DoesNotContain("data-contents", diagnostic.ReadbackStructure, StringComparison.OrdinalIgnoreCase);
            Assert.DoesNotContain("data-block", diagnostic.ReadbackStructure, StringComparison.OrdinalIgnoreCase);
            Assert.DoesNotContain("nodeName", diagnostic.ReadbackStructure, StringComparison.OrdinalIgnoreCase);
            Assert.DoesNotContain("attributes", diagnostic.ReadbackStructure, StringComparison.OrdinalIgnoreCase);

            string surfaced = diagnostic.ToString();
            Assert.DoesNotContain(omittedBlockText, surfaced);
            Assert.DoesNotContain("data-contents", surfaced, StringComparison.OrdinalIgnoreCase);
            Assert.DoesNotContain("data-block", surfaced, StringComparison.OrdinalIgnoreCase);
            Assert.DoesNotContain(socket.Sent, message => Method(message) == "DOM.setFileInputFiles");
        }
        finally
        {
            await page.DisposeAsync();
            await transport.DisposeAsync();
        }
    }

    [Fact]
    public async Task DraftReaderNullReadback_ReportsBoundedStructureWithoutRawDom()
    {
        const string expected = "distinct-expected-body";
        var fixture = new XFixture("ignored")
        {
            DraftEditorOverride = new
            {
                nodeId = 11,
                backendNodeId = 110L,
                nodeName = "DIV",
                children = new object[]
                {
                    new
                    {
                        nodeName = "DIV",
                        attributes = new[] { "data-contents", "true" },
                        children = new object[]
                        {
                            new
                            {
                                nodeName = "DIV",
                                attributes = Array.Empty<string>(),
                                children = new object[]
                                {
                                    new
                                    {
                                        nodeName = "DIV",
                                        attributes = new[] { "data-block", "true" },
                                        children = new object[]
                                        {
                                            new { nodeName = "SPAN", children = new object[] { new { nodeName = "#text", nodeType = 3, nodeValue = "private-dom-text" } } }
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
            }
        };
        var (targets, transport, _) = FixtureTargets(fixture);
        BrowserPreparationSession session = await targets.AttachAsync("fixture", cancellationToken: CancellationToken.None);
        var composer = new XComposer(session);
        try
        {
            Assert.False(await composer.VerifyTextAsync(expected, CancellationToken.None));

            BrowserTextMismatchDiagnostic diagnostic = Assert.IsType<BrowserTextMismatchDiagnostic>(composer.LastTextMismatchDiagnostic);
            Assert.Null(diagnostic.ActualUtf16Length);
            Assert.Equal(0, diagnostic.FirstDifferenceIndex);
            Assert.Equal("U+64", diagnostic.ExpectedCodePoint);
            Assert.Equal("<end>", diagnostic.ActualCodePoint);
            Assert.Equal("x_draft_blocks;contents_found=1;direct_block_count=0;descendant_block_count=1;blocks=none;block_summaries_truncated=0;traversal_bound_reached=0", diagnostic.ReadbackStructure);
            string surfaced = diagnostic.ToString();
            Assert.DoesNotContain(expected, surfaced);
            Assert.DoesNotContain("private-dom-text", surfaced);
            Assert.DoesNotContain("nodeName", surfaced);
        }
        finally
        {
            await session.DisposeAsync();
            await transport.DisposeAsync();
        }
    }

    [Fact]
    public async Task ExactUnicodeBody_IsNotRecomposedFromTitle()
    {
        PlatformPreparationContext context = Context(title: "ignored", body: "Title\n\nEmoji 😀 — ✓");
        var page = new FakePage();

        await Adapter(page).PrepareAsync(context, new Progress(), CancellationToken.None);

        Assert.Equal(context.Body, page.Composer.ReplacedText);
    }

    [Fact]
    public async Task NoMedia_DoesNotAssignFilesOrReportUploading()
    {
        var page = new FakePage();
        var progress = new Progress();

        await Adapter(page).PrepareAsync(Context(media: []), progress, CancellationToken.None);

        Assert.Empty(page.Composer.AssignedPaths);
        Assert.DoesNotContain(SocialPreparationProgress.Uploading, progress.Values);
    }

    [Fact]
    public async Task OneAndMultipleMedia_PreserveTheExactCallerOrder()
    {
        string[] one = ["C:\\media\\one.png"];
        var onePage = new FakePage();
        await Adapter(onePage).PrepareAsync(Context(media: one), new Progress(), CancellationToken.None);
        Assert.Equal(one, onePage.Composer.AssignedPaths);

        string[] many = ["C:\\media\\first.png", "C:\\media\\second.png"];
        var manyPage = new FakePage();
        await Adapter(manyPage).PrepareAsync(Context(media: many), new Progress(), CancellationToken.None);
        Assert.Equal(many, manyPage.Composer.AssignedPaths);
        Assert.Equal([2, 2], manyPage.Composer.IntendedCounts);
    }

    [Fact]
    public async Task IncompleteDelayedAndStableMedia_UsesTwoCompletedSamples()
    {
        var page = new FakePage();
        page.Composer.Readiness = [Ready() with { GroupCountMatches = false }, Ready(), Ready()];

        PlatformPreparationResult result = await Adapter(page).PrepareAsync(Context(media: ["C:\\media\\one.png"]), new Progress(), CancellationToken.None);

        Assert.Equal(PlatformPreparationOutcome.Prepared, result.Outcome);
        Assert.Equal(3, page.Composer.ReadinessCalls);
    }

    [Theory]
    [InlineData(false, true, true, false, false, true, "x_media_preview_incomplete")]
    [InlineData(true, false, true, false, false, true, "x_media_preview_incomplete")]
    [InlineData(true, true, false, false, false, true, "x_media_preview_incomplete")]
    [InlineData(true, true, true, true, false, true, "x_media_not_ready")]
    [InlineData(true, true, true, false, true, true, "x_validation_error")]
    [InlineData(true, true, true, false, false, false, "x_validation_error")]
    public async Task PartialUnrenderedBusyErrorAndDisabledMedia_NeverPrepare(bool count, bool rendered, bool controls, bool busy, bool error, bool enabled, string code)
    {
        var page = new FakePage();
        page.Composer.Readiness = [new XReadiness(count, rendered, controls, true, busy, error, enabled)];

        await AssertFailureAsync(page, code, media: ["C:\\media\\one.png"]);
    }

    [Fact]
    public async Task StabilityRegressionAndMissingInputAndAssignmentFailure_NeverPrepare()
    {
        var unstable = new FakePage();
        unstable.Composer.Readiness = [Ready(), Ready() with { IsBusy = true }];
        await AssertFailureAsync(unstable, "x_media_not_ready", media: ["C:\\media\\one.png"]);

        var missing = new FakePage();
        missing.Composer.Assignment = XMediaAssignment.InputMissing;
        await AssertFailureAsync(missing, "x_media_input_missing", media: ["C:\\media\\one.png"]);

        var failed = new FakePage();
        failed.Composer.Assignment = XMediaAssignment.Failed;
        await AssertFailureAsync(failed, "x_media_assignment_failed", media: ["C:\\media\\one.png"]);
    }

    [Fact]
    public async Task FinalReadbackAndRelinquishmentFailure_NeverReturnPrepared()
    {
        var text = new FakePage();
        text.Composer.FinalTextMatches = false;
        await AssertFailureAsync(text, "x_prepared_assertion_failed");

        var handoff = new FakePage { RelinquishFailure = new BrowserPreparationException(BrowserPreparationFailure.NotOwnedTarget) };
        await AssertFailureAsync(handoff, "x_target_closed");
    }

    [Fact]
    public async Task CallerCancellation_IsNotMappedToMediaTimeout()
    {
        using var caller = new CancellationTokenSource();
        var page = new FakePage();
        page.Composer.CancelDuringReadiness = caller;

        await Assert.ThrowsAnyAsync<OperationCanceledException>(
            () => Adapter(page).PrepareAsync(Context(media: ["C:\\media\\one.png"]), new Progress(), caller.Token));
    }

    [Fact]
    public void AdapterSurface_HasNoPostOrSubmitOperation()
    {
        Assert.DoesNotContain(typeof(XSocialPreparationAdapter).GetMethods().Select(method => method.Name), name =>
            name.Contains("post", StringComparison.OrdinalIgnoreCase) || name.Contains("submit", StringComparison.OrdinalIgnoreCase) || name.Contains("publish", StringComparison.OrdinalIgnoreCase));
        Assert.DoesNotContain(typeof(IXComposer).GetMethods().Select(method => method.Name), name =>
            name.Contains("post", StringComparison.OrdinalIgnoreCase) || name.Contains("submit", StringComparison.OrdinalIgnoreCase) || name.Contains("publish", StringComparison.OrdinalIgnoreCase));
    }

    [Fact]
    public void DraftFixture_DepthFiveProjection_ReproducesTheMissingTextNodeFailureShape()
    {
        const string body = "CreatorCrate X final validation\n\nUnicode check ✓";
        var fixture = new XFixture(body);

        JsonElement editor = fixture.DraftEditorProjection(5);
        JsonElement contents = Assert.Single(ProjectedChildren(editor));
        Assert.Equal("DIV", contents.GetProperty("nodeName").GetString());
        Assert.Equal(new[] { "data-contents", "true" }, ProjectedAttributes(contents));

        JsonElement[] blocks = ProjectedChildren(contents);
        Assert.Equal(3, blocks.Length);
        Assert.All(blocks, block => Assert.Equal(new[] { "data-block", "true" }, ProjectedAttributes(block)));

        JsonElement firstSpan = Assert.Single(ProjectedChildren(Assert.Single(ProjectedChildren(Assert.Single(ProjectedChildren(blocks[0]))))));
        Assert.Equal("SPAN", firstSpan.GetProperty("nodeName").GetString());
        Assert.Equal(new[] { "data-text", "true" }, ProjectedAttributes(firstSpan));
        Assert.False(firstSpan.TryGetProperty("children", out _));

        JsonElement middleBreak = Assert.Single(ProjectedChildren(blocks[1]));
        Assert.Equal("BR", middleBreak.GetProperty("nodeName").GetString());
        Assert.Equal(new[] { "data-text", "true" }, ProjectedAttributes(middleBreak));

        JsonElement thirdSpan = Assert.Single(ProjectedChildren(Assert.Single(ProjectedChildren(Assert.Single(ProjectedChildren(blocks[2]))))));
        Assert.Equal("SPAN", thirdSpan.GetProperty("nodeName").GetString());
        Assert.Equal(new[] { "data-text", "true" }, ProjectedAttributes(thirdSpan));
        Assert.False(thirdSpan.TryGetProperty("children", out _));
    }

    [Fact]
    public async Task ProductionAdapter_UsesDepth129ForExactDraftReadbackBeforeMedia()
    {
        const string body = "CreatorCrate X final validation\n\nUnicode check ✓";
        var fixture = new XFixture(body);
        var (targets, transport, socket) = FixtureTargets(fixture);
        var page = new XPreparationPage(targets, fixture.Timing);
        var adapter = new XSocialPreparationAdapter(_ => page, fixture.Timing);
        try
        {
            PlatformPreparationResult result = await adapter.PrepareAsync(
                Context(body: body, media: ["C:\\media\\exact-readback.png"]), new Progress(), CancellationToken.None);

            Assert.Equal(PlatformPreparationOutcome.Prepared, result.Outcome);
            Assert.Equal(new[] { "C:\\media\\exact-readback.png" }, fixture.AssignedPaths);
            Assert.Equal(new[] { 0, 0, 0, 129, 0, 129 }, fixture.EditorDescribeDepths);
            Assert.Equal(2, fixture.DraftReadbackCount);

            JsonElement[] transcript = socket.Sent.Select(message => JsonDocument.Parse(message).RootElement.Clone()).ToArray();
            JsonElement[] textReadbacks = transcript.Where(command =>
                command.GetProperty("method").GetString() == "DOM.describeNode" &&
                command.GetProperty("params").GetProperty("nodeId").GetInt32() == 11 &&
                command.GetProperty("params").GetProperty("depth").GetInt32() > 0).ToArray();
            Assert.Equal(2, textReadbacks.Length);
            Assert.All(textReadbacks, command =>
            {
                Assert.Equal(129, command.GetProperty("params").GetProperty("depth").GetInt32());
                Assert.False(command.GetProperty("params").GetProperty("pierce").GetBoolean());
            });

            int initialReadback = Array.FindIndex(transcript, command =>
                command.GetProperty("method").GetString() == "DOM.describeNode" &&
                command.GetProperty("params").GetProperty("nodeId").GetInt32() == 11 &&
                command.GetProperty("params").GetProperty("depth").GetInt32() == 129);
            int mediaAssignment = Array.FindIndex(transcript, command => command.GetProperty("method").GetString() == "DOM.setFileInputFiles");
            Assert.True(initialReadback >= 0);
            Assert.True(mediaAssignment > initialReadback);
            AssertNoSubmitTranscript(socket, fixture);
        }
        finally
        {
            await page.DisposeAsync();
            await transport.DisposeAsync();
        }
    }

    [Fact]
    public async Task ProductionDraftReader_DescribeDepthFollowsThe128NodeTraversalContract()
    {
        const int draftBlockTraversalLimit = 128;
        var fixture = new XFixture("boundary");
        var (targets, transport, _) = FixtureTargets(fixture);
        BrowserPreparationSession session = await targets.AttachAsync("fixture", cancellationToken: CancellationToken.None);
        var composer = new XComposer(session);
        try
        {
            Assert.True(await composer.VerifyTextAsync("boundary", CancellationToken.None));
            int readbackDepth = Assert.Single(fixture.EditorDescribeDepths.Where(depth => depth > 0));
            Assert.Equal(2 + (draftBlockTraversalLimit - 1), readbackDepth);
        }
        finally
        {
            await session.DisposeAsync();
            await transport.DisposeAsync();
        }
    }

    [Fact]
    public async Task ProductionAdapter_NoMediaUsesModalScopedDraftBlocksAndNoSubmitTranscript()
    {
        const string body = "line1\n\nline3 — 😀";
        var fixture = new XFixture(body);
        var (targets, transport, socket) = FixtureTargets(fixture);
        var page = new XPreparationPage(targets, fixture.Timing);
        var adapter = new XSocialPreparationAdapter(_ => page, fixture.Timing);
        try
        {
            PlatformPreparationResult result = await adapter.PrepareAsync(Context(body: body), new Progress(), CancellationToken.None);

            Assert.Equal(PlatformPreparationOutcome.Prepared, result.Outcome);
            Assert.True(fixture.Relinquished);
            AssertNoSubmitTranscript(socket, fixture);
            Assert.DoesNotContain(socket.Sent.Where(message => Method(message) == "DOM.querySelector"), message =>
                JsonDocument.Parse(message).RootElement.GetProperty("params").GetProperty("nodeId").GetInt32() == 1 &&
                JsonDocument.Parse(message).RootElement.GetProperty("params").GetProperty("selector").GetString() is "img" or "[role='group'][aria-label='Media']");
        }
        finally
        {
            await page.DisposeAsync();
            await transport.DisposeAsync();
        }
    }

    [Fact]
    public async Task ProductionAdapter_MediaUsesPersistentInputAndRenderedGroupsInOrder()
    {
        const string body = "line1\n\nline3";
        var fixture = new XFixture(body);
        var (targets, transport, socket) = FixtureTargets(fixture);
        var page = new XPreparationPage(targets, fixture.Timing);
        var adapter = new XSocialPreparationAdapter(_ => page, fixture.Timing);
        string[] paths = ["C:\\media\\first.png", "C:\\media\\second.png"];
        try
        {
            PlatformPreparationResult result = await adapter.PrepareAsync(Context(body: body, media: paths), new Progress(), CancellationToken.None);

            Assert.Equal(PlatformPreparationOutcome.Prepared, result.Outcome);
            Assert.Equal(paths, fixture.AssignedPaths);
            Assert.Equal([20, 30], fixture.MediaGroups);
            AssertNoSubmitTranscript(socket, fixture);
            Assert.Equal(2, socket.Sent.Count(message => Method(message) == "Input.dispatchMouseEvent"));
        }
        finally
        {
            await page.DisposeAsync();
            await transport.DisposeAsync();
        }
    }

    [Fact]
    public async Task ProductionAdapter_IgnoresOutsideDialogMediaAndPostDecoys()
    {
        var fixture = new XFixture("text") { OutsideDialogDecoys = true };
        var (targets, transport, socket) = FixtureTargets(fixture);
        var page = new XPreparationPage(targets, fixture.Timing);
        var adapter = new XSocialPreparationAdapter(_ => page, fixture.Timing);
        try
        {
            Assert.Equal(PlatformPreparationOutcome.Prepared,
                (await adapter.PrepareAsync(Context(body: "text", media: ["C:\\media\\one.png"]), new Progress(), CancellationToken.None)).Outcome);
            Assert.DoesNotContain(socket.Sent.Where(message => Method(message) == "DOM.querySelectorAll"), message =>
                JsonDocument.Parse(message).RootElement.GetProperty("params").GetProperty("nodeId").GetInt32() == 1);
        }
        finally
        {
            await page.DisposeAsync();
            await transport.DisposeAsync();
        }
    }

    [Fact]
    public void NoSubmitTranscript_RejectsEveryNonComposeActivationAndSubmissionShape()
    {
        AssertTranscriptRejects((socket, fixture) =>
        {
            (double x, double y) = fixture.PostCenter;
            EnqueueCommand(socket, "Input.dispatchMouseEvent", new { type = "mousePressed", x, y, button = "left", buttons = 1, clickCount = 1 });
            EnqueueCommand(socket, "Input.dispatchMouseEvent", new { type = "mouseReleased", x, y, button = "left", buttons = 0, clickCount = 1 });
        });
        AssertTranscriptRejects((socket, fixture) =>
        {
            (double x, double y) = fixture.UnrelatedControlCenter;
            EnqueueCommand(socket, "Input.dispatchMouseEvent", new { type = "mousePressed", x, y, button = "left", buttons = 1, clickCount = 1 });
            EnqueueCommand(socket, "Input.dispatchMouseEvent", new { type = "mouseReleased", x, y, button = "left", buttons = 0, clickCount = 1 });
        });
        AssertTranscriptRejects((socket, _) => EnqueueCommand(socket, "Input.dispatchKeyEvent", new { type = "keyDown", key = "Enter", code = "NumpadEnter", windowsVirtualKeyCode = 13, modifiers = 0 }));
        AssertTranscriptRejects((socket, _) => EnqueueCommand(socket, "Input.dispatchKeyEvent", new { type = "keyDown", key = "Enter", code = "Enter", windowsVirtualKeyCode = 13, modifiers = 2 }));
        AssertTranscriptRejects((socket, _) => EnqueueCommand(socket, "Input.dispatchKeyEvent", new { type = "keyDown", key = "Enter", code = "Enter", windowsVirtualKeyCode = 13, modifiers = 4 }));
        AssertTranscriptRejects((socket, _) => EnqueueCommand(socket, "Input.dispatchKeyEvent", new { type = "rawKeyDown", key = "Enter", code = "Enter", windowsVirtualKeyCode = 13, modifiers = 0 }));
        AssertTranscriptRejects((socket, _) => EnqueueCommand(socket, "Runtime.evaluate", new { expression = "document.forms[0].submit()" }));
        AssertTranscriptRejects((socket, _) => EnqueueCommand(socket, "DOM.submit", new { nodeId = 12 }));
        AssertTranscriptRejects((socket, _) => EnqueueCommand(socket, "Network.publicPost", new { body = "text" }));
    }

    [Theory]
    [InlineData("partial", "x_media_preview_incomplete")]
    [InlineData("unrendered", "x_media_preview_incomplete")]
    [InlineData("busy", "x_media_not_ready")]
    [InlineData("error", "x_validation_error")]
    [InlineData("disabled", "x_validation_error")]
    [InlineData("unstable", "x_media_not_ready")]
    [InlineData("missing-input", "x_media_input_missing")]
    [InlineData("assignment-failure", "x_media_assignment_failed")]
    public async Task ProductionFixture_MediaFailuresRemainCurated(string state, string code)
    {
        var fixture = new XFixture("text")
        {
            ObservedGroupCount = state == "partial" ? 0 : null,
            ImageRendered = state != "unrendered",
            Busy = state == "busy",
            HasError = state == "error",
            PostEnabled = state != "disabled",
            UnstableAfterFirstSample = state == "unstable",
            InputPresent = state != "missing-input",
            AssignmentFails = state == "assignment-failure",
        };
        var (targets, transport, _) = FixtureTargets(fixture);
        var page = new XPreparationPage(targets, fixture.Timing);
        var adapter = new XSocialPreparationAdapter(_ => page, fixture.Timing);
        try
        {
            SocialPreparationRuntimeException error = await Assert.ThrowsAsync<SocialPreparationRuntimeException>(
                () => adapter.PrepareAsync(Context(body: "text", media: ["C:\\media\\one.png"]), new Progress(), CancellationToken.None));
            Assert.Equal(code, error.Code);
            Assert.False(fixture.Relinquished);
        }
        finally
        {
            await page.DisposeAsync();
            await transport.DisposeAsync();
        }
    }

    [Fact]
    public async Task ProductionDraftReader_PreservesMultipleBlankLinesAndOrdinalUnicode()
    {
        const string body = "a\n\n\nb 😀";
        var fixture = new XFixture(body);
        var (targets, transport, _) = FixtureTargets(fixture);
        BrowserPreparationSession session = await targets.AttachAsync("fixture", cancellationToken: CancellationToken.None);
        var composer = new XComposer(session);
        try
        {
            Assert.True(await composer.VerifyTextAsync(body, CancellationToken.None));
            Assert.False(await composer.VerifyTextAsync("a\n\nb 😀", CancellationToken.None));
            Assert.StartsWith("x_draft_blocks;contents_found=1;", composer.LastTextMismatchDiagnostic!.ReadbackStructure);
        }
        finally
        {
            await session.DisposeAsync();
            await transport.DisposeAsync();
        }
    }

    [Fact]
    public async Task ProductionDraftReader_PreservesOrdinalLfUnicodeAndWhitespace()
    {
        const string body = "a\n\nUnicode check ✓";
        var fixture = new XFixture(body);
        var (targets, transport, _) = FixtureTargets(fixture);
        BrowserPreparationSession session = await targets.AttachAsync("fixture", cancellationToken: CancellationToken.None);
        var composer = new XComposer(session);
        try
        {
            Assert.True(await composer.VerifyTextAsync(body, CancellationToken.None));
            Assert.False(await composer.VerifyTextAsync("a\nUnicode check ✓", CancellationToken.None));
            Assert.False(await composer.VerifyTextAsync("a\n\nUnicode check ✓\uFE0F", CancellationToken.None));
            Assert.False(await composer.VerifyTextAsync(" a\n\nUnicode check ✓", CancellationToken.None));
            Assert.False(await composer.VerifyTextAsync("a\n\nUnicode check ✓ ", CancellationToken.None));
        }
        finally
        {
            await session.DisposeAsync();
            await transport.DisposeAsync();
        }
    }

    [Fact]
    public async Task ProductionStaleFrontendNode_ReacquiresOnlyTheKnownDescribeFailure()
    {
        var fixture = new XFixture("text") { StaleEditorDescribeAttempts = 1 };
        var (targets, transport, _) = FixtureTargets(fixture);
        BrowserPreparationSession session = await targets.AttachAsync("fixture", cancellationToken: CancellationToken.None);
        var composer = new XComposer(session);
        try
        {
            Assert.True(await composer.VerifyTextAsync("text", CancellationToken.None));
            Assert.Equal(1, fixture.StaleEditorDescribeObserved);
        }
        finally
        {
            await session.DisposeAsync();
            await transport.DisposeAsync();
        }
    }

    [Fact]
    public async Task FinalDraftReadback_StaleNodesStopAtTheSharedPreparationDeadline()
    {
        using var deadline = new CancellationTokenSource();
        var fixture = new XFixture("text")
        {
            StaleFinalTextDescribe = true,
            DeadlineToCancel = deadline,
            CancelDeadlineAfterFinalStales = 3,
        };
        var (targets, transport, _) = FixtureTargets(fixture);
        XTiming timing = DeadlineTiming(fixture, deadline);
        var page = new XPreparationPage(targets, timing);
        var adapter = new XSocialPreparationAdapter(_ => page, timing);
        try
        {
            SocialPreparationRuntimeException error = await Assert.ThrowsAsync<SocialPreparationRuntimeException>(
                () => adapter.PrepareAsync(Context(body: "text"), new Progress(), CancellationToken.None));

            Assert.Equal("x_prepared_assertion_failed", error.Code);
            Assert.True(fixture.FinalStaleDescribeObserved >= 3);
            Assert.Equal(1, fixture.PostAttributeReads);
            Assert.False(fixture.Relinquished);
        }
        finally
        {
            await page.DisposeAsync();
            await transport.DisposeAsync();
        }
    }

    [Fact]
    public async Task SharedPreparationDeadline_CancelsAnUnansweredNavigationWithoutLaterPreparation()
    {
        using var deadline = new CancellationTokenSource();
        var fixture = new XFixture("text") { StallNavigation = true };
        var (targets, transport, socket) = FixtureTargets(fixture);
        XTiming timing = DeadlineTiming(fixture, deadline);
        var page = new XPreparationPage(targets, timing);
        var adapter = new XSocialPreparationAdapter(_ => page, timing);
        try
        {
            Task<PlatformPreparationResult> preparation = adapter.PrepareAsync(Context(body: "text"), new Progress(), CancellationToken.None);
            long stalledId = await fixture.StalledNavigationCommand.Task.WaitAsync(TimeSpan.FromSeconds(5));
            int boundary = socket.Sent.Count;

            deadline.Cancel();

            SocialPreparationRuntimeException error = await Assert.ThrowsAsync<SocialPreparationRuntimeException>(() => preparation);
            Assert.Equal("x_home_timeout", error.Code);
            Assert.Contains(socket.Sent, message => JsonDocument.Parse(message).RootElement.GetProperty("id").GetInt64() == stalledId);
            Assert.DoesNotContain(socket.Sent.Skip(boundary), message => Method(message) is "Page.enable" or "Page.navigate" or "DOM.enable" or "DOM.getDocument" or "DOM.querySelector" or "DOM.describeNode");
            Assert.False(fixture.Relinquished);
        }
        finally
        {
            await page.DisposeAsync();
            await transport.DisposeAsync();
        }
    }

    [Fact]
    public async Task SharedPreparationDeadline_CancelsAnUnansweredFileAssignmentWithoutReadiness()
    {
        using var deadline = new CancellationTokenSource();
        var fixture = new XFixture("text") { StallFileAssignment = true };
        var (targets, transport, socket) = FixtureTargets(fixture);
        XTiming timing = DeadlineTiming(fixture, deadline);
        var page = new XPreparationPage(targets, timing);
        var adapter = new XSocialPreparationAdapter(_ => page, timing);
        try
        {
            Task<PlatformPreparationResult> preparation = adapter.PrepareAsync(
                Context(body: "text", media: ["C:\\media\\one.png"]), new Progress(), CancellationToken.None);
            long stalledId = await fixture.StalledFileAssignmentCommand.Task.WaitAsync(TimeSpan.FromSeconds(5));
            int boundary = socket.Sent.Count;

            deadline.Cancel();

            SocialPreparationRuntimeException error = await Assert.ThrowsAsync<SocialPreparationRuntimeException>(() => preparation);
            Assert.Equal("x_media_assignment_failed", error.Code);
            Assert.Contains(socket.Sent, message => JsonDocument.Parse(message).RootElement.GetProperty("id").GetInt64() == stalledId);
            Assert.DoesNotContain(socket.Sent.Skip(boundary), message => Method(message) is "DOM.querySelectorAll" or "DOM.getBoxModel" or "DOM.getAttributes");
            Assert.False(fixture.Relinquished);
        }
        finally
        {
            await page.DisposeAsync();
            await transport.DisposeAsync();
        }
    }

    [Fact]
    public async Task CallerCancellationDuringPendingXCommand_IsNotMappedToAnInternalTimeout()
    {
        using var caller = new CancellationTokenSource();
        var fixture = new XFixture("text") { StallNavigation = true };
        var (targets, transport, socket) = FixtureTargets(fixture);
        var page = new XPreparationPage(targets, fixture.Timing);
        var adapter = new XSocialPreparationAdapter(_ => page, fixture.Timing);
        try
        {
            Task<PlatformPreparationResult> preparation = adapter.PrepareAsync(Context(body: "text"), new Progress(), caller.Token);
            await fixture.StalledNavigationCommand.Task.WaitAsync(TimeSpan.FromSeconds(5));
            int boundary = socket.Sent.Count;

            caller.Cancel();

            await Assert.ThrowsAnyAsync<OperationCanceledException>(() => preparation);
            Assert.DoesNotContain(socket.Sent.Skip(boundary), message => Method(message) is "Page.enable" or "Page.navigate" or "DOM.enable" or "DOM.getDocument" or "DOM.querySelector" or "DOM.describeNode");
            Assert.False(fixture.Relinquished);
        }
        finally
        {
            await page.DisposeAsync();
            await transport.DisposeAsync();
        }
    }

    [Fact]
    public async Task FinalPostValidation_RunsAfterFinalDraftReadback()
    {
        var fixture = new XFixture("text") { DisablePostAfterFinalDraftReadback = true };
        var (targets, transport, _) = FixtureTargets(fixture);
        var page = new XPreparationPage(targets, fixture.Timing);
        var adapter = new XSocialPreparationAdapter(_ => page, fixture.Timing);
        try
        {
            SocialPreparationRuntimeException error = await Assert.ThrowsAsync<SocialPreparationRuntimeException>(
                () => adapter.PrepareAsync(Context(body: "text"), new Progress(), CancellationToken.None));

            Assert.Equal("x_validation_error", error.Code);
            Assert.Equal(2, fixture.PostAttributeReads);
            Assert.False(fixture.Relinquished);
        }
        finally
        {
            await page.DisposeAsync();
            await transport.DisposeAsync();
        }
    }

    [Fact]
    public async Task SharedMediaDeadline_CancelsAnUnansweredCommandWithoutAReadinessTail()
    {
        using var deadline = new CancellationTokenSource();
        var fixture = new XFixture("text") { StallReadinessQuery = true };
        var (targets, transport, socket) = FixtureTargets(fixture);
        XTiming timing = new(TimeSpan.FromSeconds(1), () => DateTimeOffset.UtcNow, Task.Delay, _ => CancellationTokenSource.CreateLinkedTokenSource(deadline.Token));
        var page = new XPreparationPage(targets, timing);
        var adapter = new XSocialPreparationAdapter(_ => page, timing);
        try
        {
            Task<PlatformPreparationResult> preparation = adapter.PrepareAsync(
                Context(body: "text", media: ["C:\\media\\one.png"]), new Progress(), CancellationToken.None);
            long stalledId = await fixture.StalledReadinessCommand.Task.WaitAsync(TimeSpan.FromSeconds(5));
            int boundary = socket.Sent.Count;

            deadline.Cancel();

            SocialPreparationRuntimeException error = await Assert.ThrowsAsync<SocialPreparationRuntimeException>(() => preparation);
            Assert.Equal("x_media_not_ready", error.Code);
            Assert.Contains(socket.Sent, message => JsonDocument.Parse(message).RootElement.GetProperty("id").GetInt64() == stalledId);
            Assert.DoesNotContain(socket.Sent.Skip(boundary), message => Method(message) is "DOM.querySelectorAll" or "DOM.getBoxModel" or "DOM.getAttributes");
        }
        finally
        {
            await page.DisposeAsync();
            await transport.DisposeAsync();
        }
    }

    [Fact]
    public async Task FailedTargetClose_StaysWithinTheRunDeadlineAndPreservesThePrimaryFailure()
    {
        using var deadline = new CancellationTokenSource();
        var fixture = new XFixture("text") { PostEnabled = false, StallCloseTarget = true };
        var (targets, transport, socket) = FixtureTargets(fixture);
        XTiming timing = DeadlineTiming(fixture, deadline);
        var page = new XPreparationPage(targets, timing);
        var adapter = new XSocialPreparationAdapter(_ => page, timing);
        try
        {
            Task<PlatformPreparationResult> preparation = adapter.PrepareAsync(Context(body: "text"), new Progress(), CancellationToken.None);
            long stalledId = await fixture.StalledCloseTargetCommand.Task.WaitAsync(TimeSpan.FromSeconds(5));

            deadline.Cancel();

            SocialPreparationRuntimeException error = await Assert.ThrowsAsync<SocialPreparationRuntimeException>(
                () => preparation.WaitAsync(TimeSpan.FromSeconds(5)));
            Assert.Equal("x_validation_error", error.Code);
            Assert.Contains(socket.Sent, message => JsonDocument.Parse(message).RootElement.GetProperty("id").GetInt64() == stalledId);
            Assert.DoesNotContain(socket.Sent, message => Method(message) == "Target.detachFromTarget");
        }
        finally
        {
            await page.DisposeAsync();
            await transport.DisposeAsync();
        }
    }

    [Fact]
    public async Task AuthenticationPreservationDetach_StaysWithinTheRunDeadline()
    {
        using var deadline = new CancellationTokenSource();
        var fixture = new XFixture("text") { Home = XHomeState.AuthenticationRequired, StallDetach = true };
        var (targets, transport, socket) = FixtureTargets(fixture);
        XTiming timing = DeadlineTiming(fixture, deadline);
        var page = new XPreparationPage(targets, timing);
        var adapter = new XSocialPreparationAdapter(_ => page, timing);
        try
        {
            Task<PlatformPreparationResult> preparation = adapter.PrepareAsync(Context(body: "text"), new Progress(), CancellationToken.None);
            long stalledId = await fixture.StalledDetachCommand.Task.WaitAsync(TimeSpan.FromSeconds(5));

            deadline.Cancel();

            PlatformPreparationResult result = await preparation.WaitAsync(TimeSpan.FromSeconds(5));
            Assert.Equal(PlatformPreparationOutcome.AuthenticationRequired, result.Outcome);
            Assert.Contains(socket.Sent, message => JsonDocument.Parse(message).RootElement.GetProperty("id").GetInt64() == stalledId);
            Assert.DoesNotContain(socket.Sent, message => Method(message) == "Target.closeTarget");
        }
        finally
        {
            await page.DisposeAsync();
            await transport.DisposeAsync();
        }
    }

    [Fact]
    public async Task CallerCancellationDuringTargetClose_RemainsCancellation()
    {
        using var caller = new CancellationTokenSource();
        var fixture = new XFixture("text") { PostEnabled = false, StallCloseTarget = true };
        var (targets, transport, socket) = FixtureTargets(fixture);
        var page = new XPreparationPage(targets, fixture.Timing);
        var adapter = new XSocialPreparationAdapter(_ => page, fixture.Timing);
        try
        {
            Task<PlatformPreparationResult> preparation = adapter.PrepareAsync(Context(body: "text"), new Progress(), caller.Token);
            await fixture.StalledCloseTargetCommand.Task.WaitAsync(TimeSpan.FromSeconds(5));

            caller.Cancel();

            await Assert.ThrowsAnyAsync<OperationCanceledException>(() => preparation.WaitAsync(TimeSpan.FromSeconds(5)));
            Assert.Single(socket.Sent.Where(message => Method(message) == "Target.closeTarget"));
        }
        finally
        {
            await page.DisposeAsync();
            await transport.DisposeAsync();
        }
    }

    private static XSocialPreparationAdapter Adapter(FakePage page) =>
        new(_ => page, new XTiming(TimeSpan.FromSeconds(1), () => page.Clock, (delay, _) => { page.Clock += delay; return Task.CompletedTask; }));

    private static XTiming DeadlineTiming(XFixture fixture, CancellationTokenSource deadline) =>
        new(TimeSpan.FromSeconds(1), () => fixture.Clock, (delay, _) => { fixture.Clock += delay; return Task.CompletedTask; },
            _ => CancellationTokenSource.CreateLinkedTokenSource(deadline.Token));

    private static PlatformPreparationContext Context(string title = "ignored", string body = "Line 1\n\nLine 3 — ✓", IReadOnlyList<string>? media = null) =>
        new("x", title, body, media ?? [], null);

    private static XReadiness Ready() => new(true, true, true, true, false, false, true);

    private static async Task AssertFailureAsync(FakePage page, string code, IReadOnlyList<string>? media = null)
    {
        SocialPreparationRuntimeException error = await Assert.ThrowsAsync<SocialPreparationRuntimeException>(
            () => Adapter(page).PrepareAsync(Context(media: media), new Progress(), CancellationToken.None));
        Assert.Equal(code, error.Code);
        Assert.True(page.Abandoned);
    }

    private static (BrowserPreparationTargets Targets, CdpTransport Transport, CdpTestSocket Socket) FixtureTargets(XFixture fixture)
    {
        var socket = new CdpTestSocket();
        socket.OnSendAsync = message =>
        {
            using JsonDocument document = JsonDocument.Parse(message);
            JsonElement command = document.RootElement;
            long id = command.GetProperty("id").GetInt64();
            string method = command.GetProperty("method").GetString()!;
            JsonElement parameters = command.TryGetProperty("params", out JsonElement value) ? value : default;
            bool shallowEditorDescribe = method == "DOM.describeNode" && parameters.GetProperty("nodeId").GetInt32() == 11 &&
                (!parameters.TryGetProperty("depth", out JsonElement depth) || depth.GetInt32() == 0);
            if (shallowEditorDescribe && (fixture.StaleEditorDescribeAttempts > 0 || fixture.StaleFinalTextDescribe && fixture.DraftReadbackCount >= 1))
            {
                if (fixture.StaleEditorDescribeAttempts > 0)
                {
                    fixture.StaleEditorDescribeAttempts--;
                    fixture.StaleEditorDescribeObserved++;
                }
                else
                {
                    fixture.FinalStaleDescribeObserved++;
                }
                socket.EnqueueJson(JsonSerializer.Serialize(new { id, error = new { code = -32000, message = "Could not find node with given id" } }));
                if (fixture.FinalStaleDescribeObserved >= fixture.CancelDeadlineAfterFinalStales)
                    fixture.DeadlineToCancel?.Cancel();
                return Task.CompletedTask;
            }
            if (method == "Page.navigate" && fixture.StallNavigation)
            {
                fixture.StalledNavigationCommand.TrySetResult(id);
                return Task.CompletedTask;
            }
            if (method == "Target.closeTarget" && fixture.StallCloseTarget)
            {
                fixture.StalledCloseTargetCommand.TrySetResult(id);
                return Task.CompletedTask;
            }
            if (method == "Target.detachFromTarget" && fixture.StallDetach)
            {
                fixture.StalledDetachCommand.TrySetResult(id);
                return Task.CompletedTask;
            }
            if (method == "DOM.setFileInputFiles" && fixture.AssignmentFails)
            {
                socket.EnqueueJson(JsonSerializer.Serialize(new { id, error = new { code = -32000, message = "File assignment failed" } }));
                return Task.CompletedTask;
            }
            if (method == "DOM.setFileInputFiles" && fixture.StallFileAssignment)
            {
                fixture.StalledFileAssignmentCommand.TrySetResult(id);
                return Task.CompletedTask;
            }
            if (method == "DOM.querySelectorAll" && fixture.StallReadinessQuery &&
                parameters.GetProperty("selector").GetString() == "[role='group'][aria-label='Media']")
            {
                fixture.StalledReadinessCommand.TrySetResult(id);
                return Task.CompletedTask;
            }

            if (method == "DOM.getAttributes" && parameters.GetProperty("nodeId").GetInt32() == 12)
                fixture.PostAttributeReads++;

            object result = method switch
            {
                "Target.getTargets" => new { targetInfos = new[] { new { targetId = "fixture", type = "page", url = "https://x.com/home", title = "X", attached = false } } },
                "Target.createTarget" => new { targetId = "fixture" },
                "Target.attachToTarget" => new { sessionId = "fixture-session" },
                "Target.detachFromTarget" => fixture.Detach(),
                "Page.navigate" => new { frameId = "fixture-frame" },
                "DOM.getDocument" => new { root = Node(1) },
                "DOM.querySelector" => new { nodeId = fixture.Query(parameters.GetProperty("nodeId").GetInt32(), parameters.GetProperty("selector").GetString()!) },
                "DOM.querySelectorAll" => new { nodeIds = fixture.QueryAll(parameters.GetProperty("nodeId").GetInt32(), parameters.GetProperty("selector").GetString()!) },
                "DOM.describeNode" => new { node = fixture.Describe(parameters.GetProperty("nodeId").GetInt32(), parameters.TryGetProperty("depth", out JsonElement requestedDepth) ? requestedDepth.GetInt32() : 0) },
                "DOM.getAttributes" => new { attributes = fixture.Attributes(parameters.GetProperty("nodeId").GetInt32()) },
                "DOM.getBoxModel" => new { model = fixture.Box(parameters.GetProperty("backendNodeId").GetInt64()) },
                "DOM.setFileInputFiles" => fixture.Assign(parameters.GetProperty("files").EnumerateArray().Select(path => path.GetString()!).ToArray()),
                _ => new { },
            };
            EnqueueFixtureJson(socket, JsonSerializer.Serialize(new { id, result }));
            return Task.CompletedTask;
        };
        var transport = new CdpTransport(socket);
        return (new BrowserPreparationTargets(new CdpTargetManager(transport)), transport, socket);
    }

    private static object Node(int id, string name = "DIV", string[]? attributes = null) => new { nodeId = id, backendNodeId = (long)id * 10, nodeName = name, attributes = attributes ?? [] };

    private static void EnqueueFixtureJson(CdpTestSocket socket, string json)
    {
        const int fragmentLength = 1024;
        int byteCount = System.Text.Encoding.UTF8.GetByteCount(json);
        int[] fragments = Enumerable.Range(0, (byteCount + fragmentLength - 1) / fragmentLength)
            .Select(index => Math.Min(fragmentLength, byteCount - index * fragmentLength)).ToArray();
        socket.EnqueueJson(json, fragments);
    }

    private static JsonElement[] ProjectedChildren(JsonElement node) =>
        node.TryGetProperty("children", out JsonElement children) && children.ValueKind == JsonValueKind.Array ? children.EnumerateArray().ToArray() : [];

    private static string[] ProjectedAttributes(JsonElement node) =>
        node.GetProperty("attributes").EnumerateArray().Select(attribute => attribute.GetString()!).ToArray();

    private static string Method(string message) => JsonDocument.Parse(message).RootElement.GetProperty("method").GetString()!;

    private static void AssertNoSubmitTranscript(CdpTestSocket socket, XFixture fixture)
    {
        JsonElement[] commands = socket.Sent.Select(message => JsonDocument.Parse(message).RootElement.Clone()).ToArray();
        Assert.True(fixture.Relinquished);
        Assert.DoesNotContain(commands, command => IsForbiddenSubmissionCommand(command.GetProperty("method").GetString()!));

        JsonElement[] mouse = commands.Where(command => command.GetProperty("method").GetString() == "Input.dispatchMouseEvent").ToArray();
        Assert.Equal(2, mouse.Length);
        AssertComposeMouseEvent(mouse[0].GetProperty("params"), fixture.ComposeCenter, "mousePressed", buttons: 1);
        AssertComposeMouseEvent(mouse[1].GetProperty("params"), fixture.ComposeCenter, "mouseReleased", buttons: 0);

        foreach (JsonElement command in commands.Where(command => command.GetProperty("method").GetString() == "Input.dispatchKeyEvent"))
            Assert.True(IsAllowedTextKeyEvent(command.GetProperty("params")));
    }

    private static void AssertTranscriptRejects(Action<CdpTestSocket, XFixture> inject)
    {
        (CdpTestSocket socket, XFixture fixture) = ValidSuccessfulTranscript();
        AssertNoSubmitTranscript(socket, fixture);

        inject(socket, fixture);

        Assert.ThrowsAny<Exception>(() => AssertNoSubmitTranscript(socket, fixture));
    }

    private static (CdpTestSocket Socket, XFixture Fixture) ValidSuccessfulTranscript()
    {
        var fixture = new XFixture("text");
        fixture.Detach();
        var socket = new CdpTestSocket();
        (double x, double y) = fixture.ComposeCenter;
        EnqueueCommand(socket, "Input.dispatchMouseEvent", new { type = "mousePressed", x, y, button = "left", buttons = 1, clickCount = 1 });
        EnqueueCommand(socket, "Input.dispatchMouseEvent", new { type = "mouseReleased", x, y, button = "left", buttons = 0, clickCount = 1 });
        return (socket, fixture);
    }

    private static void EnqueueCommand(CdpTestSocket socket, string method, object parameters) =>
        socket.Sent.Enqueue(JsonSerializer.Serialize(new { method, @params = parameters }));

    private static void AssertComposeMouseEvent(JsonElement parameters, (double X, double Y) center, string type, int buttons)
    {
        Assert.Equal(type, parameters.GetProperty("type").GetString());
        Assert.Equal(center.X, parameters.GetProperty("x").GetDouble());
        Assert.Equal(center.Y, parameters.GetProperty("y").GetDouble());
        Assert.Equal("left", parameters.GetProperty("button").GetString());
        Assert.Equal(buttons, parameters.GetProperty("buttons").GetInt32());
        Assert.Equal(1, parameters.GetProperty("clickCount").GetInt32());
    }

    private static bool IsForbiddenSubmissionCommand(string method)
    {
        if (method is "Runtime.evaluate" or "Target.closeTarget") return true;
        string normalized = method.Replace("-", string.Empty, StringComparison.Ordinal).ToLowerInvariant();
        return normalized.Contains("submit", StringComparison.Ordinal) || normalized.Contains("publicpost", StringComparison.Ordinal) ||
            normalized.Contains("createpost", StringComparison.Ordinal) || normalized.Contains("publish", StringComparison.Ordinal);
    }

    private static bool IsAllowedTextKeyEvent(JsonElement parameters)
    {
        if (!TryKeyEvent(parameters, out string? type, out string? key, out string? code, out int keyCode, out int modifiers)) return false;
        if (type == "keyDown" && key == "a" && code == "KeyA" && keyCode == 65 && modifiers == 2) return true;
        if (type == "keyUp" && key == "a" && code == "KeyA" && keyCode == 65 && modifiers == 2) return true;
        if (type == "keyUp" && key == "Enter" && code == "Enter" && keyCode == 13 && modifiers == 8) return true;
        return type == "rawKeyDown" && key == "Enter" && code == "Enter" && keyCode == 13 && modifiers == 8 &&
            parameters.TryGetProperty("commands", out JsonElement commands) && commands.ValueKind == JsonValueKind.Array &&
            commands.GetArrayLength() == 1 && commands[0].ValueKind == JsonValueKind.String && commands[0].GetString() == "InsertLineBreak";
    }

    private static bool TryKeyEvent(JsonElement parameters, out string? type, out string? key, out string? code, out int keyCode, out int modifiers)
    {
        type = key = code = null;
        keyCode = modifiers = 0;
        return parameters.TryGetProperty("type", out JsonElement typeValue) && typeValue.ValueKind == JsonValueKind.String &&
            parameters.TryGetProperty("key", out JsonElement keyValue) && keyValue.ValueKind == JsonValueKind.String &&
            parameters.TryGetProperty("code", out JsonElement codeValue) && codeValue.ValueKind == JsonValueKind.String &&
            parameters.TryGetProperty("windowsVirtualKeyCode", out JsonElement keyCodeValue) && keyCodeValue.TryGetInt32(out keyCode) &&
            parameters.TryGetProperty("modifiers", out JsonElement modifiersValue) && modifiersValue.TryGetInt32(out modifiers) &&
            (type = typeValue.GetString()) is not null && (key = keyValue.GetString()) is not null && (code = codeValue.GetString()) is not null;
    }

    private sealed class Progress : IPreparationProgress
    {
        internal List<SocialPreparationProgress> Values { get; } = [];
        public Task ReportAsync(SocialPreparationProgress progress, CancellationToken cancellationToken) { Values.Add(progress); return Task.CompletedTask; }
    }

    private sealed class FakePage : IXPreparationPage
    {
        internal DateTimeOffset Clock { get; set; } = DateTimeOffset.UnixEpoch;
        internal XHomeState Home { get; set; } = XHomeState.Authenticated;
        internal bool ComposeAvailable { get; set; } = true;
        internal bool ComposerAvailable { get; set; } = true;
        internal bool Relinquished { get; private set; }
        internal bool Abandoned { get; private set; }
        internal Exception? RelinquishFailure { get; set; }
        internal FakeComposer Composer { get; } = new();

        public Task<XHomeState> NavigateAndWaitForHomeAsync(CancellationToken cancellationToken) => Task.FromResult(Home);
        public Task<bool> ActivateComposeAsync(CancellationToken cancellationToken) => Task.FromResult(ComposeAvailable);
        public Task<IXComposer?> WaitForComposerAsync(CancellationToken cancellationToken) => Task.FromResult<IXComposer?>(ComposerAvailable ? Composer : null);
        public Task RelinquishAsync(CancellationToken cancellationToken)
        {
            if (RelinquishFailure is not null) return Task.FromException(RelinquishFailure);
            Relinquished = true;
            return Task.CompletedTask;
        }
        public Task AbandonAsync(CancellationToken cancellationToken) { Abandoned = true; return Task.CompletedTask; }
        public ValueTask DisposeAsync() => ValueTask.CompletedTask;
    }

    private sealed class FakeComposer : IXComposer
    {
        internal string? ReplacedText { get; private set; }
        internal List<string> AssignedPaths { get; } = [];
        internal List<int> IntendedCounts { get; } = [];
        internal IReadOnlyList<XReadiness> Readiness { get; set; } = [Ready()];
        internal int ReadinessCalls { get; private set; }
        internal bool ReplaceMatches { get; set; } = true;
        internal bool FinalTextMatches { get; set; } = true;
        internal XMediaAssignment Assignment { get; set; } = XMediaAssignment.Assigned;
        internal CancellationTokenSource? CancelDuringReadiness { get; set; }
        public BrowserTextMismatchDiagnostic? LastTextMismatchDiagnostic { get; set; }

        public Task<bool> ReplaceAndVerifyTextAsync(string text, CancellationToken cancellationToken) { ReplacedText = text; return Task.FromResult(ReplaceMatches); }
        public Task<XMediaAssignment> AttachMediaAsync(IReadOnlyList<string> paths, CancellationToken cancellationToken) { AssignedPaths.AddRange(paths); return Task.FromResult(Assignment); }
        public Task<XReadiness> ReadReadinessAsync(int intendedCount, CancellationToken cancellationToken)
        {
            IntendedCounts.Add(intendedCount);
            CancelDuringReadiness?.Cancel();
            cancellationToken.ThrowIfCancellationRequested();
            XReadiness result = Readiness[Math.Min(ReadinessCalls, Readiness.Count - 1)];
            ReadinessCalls++;
            return Task.FromResult(result);
        }
        public Task<bool> IsReadyForHandoffAsync(CancellationToken cancellationToken) => Task.FromResult(true);
        public Task<bool> VerifyTextAsync(string text, CancellationToken cancellationToken) => Task.FromResult(FinalTextMatches);
    }

    private sealed class XFixture
    {
        private static readonly int[] ComposeBorder = [0, 0, 100, 0, 100, 80, 0, 80];
        private static readonly int[] PostBorder = [100, 0, 200, 0, 200, 80, 100, 80];
        private static readonly int[] UnrelatedControlBorder = [220, 0, 320, 0, 320, 80, 220, 80];

        internal XFixture(string body)
        {
            Body = body;
            Timing = new XTiming(TimeSpan.FromSeconds(1), () => Clock, (delay, _) => { Clock += delay; return Task.CompletedTask; });
        }
        internal string Body { get; }
        internal List<int> EditorDescribeDepths { get; } = [];
        internal XHomeState Home { get; set; } = XHomeState.Authenticated;
        internal List<string> AssignedPaths { get; } = [];
        internal List<int> MediaGroups { get; } = [];
        internal bool Relinquished { get; private set; }
        internal int StaleEditorDescribeAttempts { get; set; }
        internal int StaleEditorDescribeObserved { get; set; }
        internal int? ObservedGroupCount { get; set; }
        internal bool ImageRendered { get; set; } = true;
        internal bool Busy { get; set; }
        internal bool HasError { get; set; }
        internal bool PostEnabled { get; set; } = true;
        internal bool UnstableAfterFirstSample { get; set; }
        internal bool InputPresent { get; set; } = true;
        internal bool AssignmentFails { get; set; }
        internal bool OutsideDialogDecoys { get; set; }
        internal bool StallReadinessQuery { get; set; }
        internal bool StallNavigation { get; set; }
        internal bool StallCloseTarget { get; set; }
        internal bool StallDetach { get; set; }
        internal bool StallFileAssignment { get; set; }
        internal bool StaleFinalTextDescribe { get; set; }
        internal int FinalStaleDescribeObserved { get; set; }
        internal int CancelDeadlineAfterFinalStales { get; set; }
        internal CancellationTokenSource? DeadlineToCancel { get; set; }
        internal bool DisablePostAfterFinalDraftReadback { get; set; }
        internal int DraftReadbackCount { get; private set; }
        internal int PostAttributeReads { get; set; }
        internal object? DraftEditorOverride { get; set; }
        internal TaskCompletionSource<long> StalledReadinessCommand { get; } = new(TaskCreationOptions.RunContinuationsAsynchronously);
        internal TaskCompletionSource<long> StalledNavigationCommand { get; } = new(TaskCreationOptions.RunContinuationsAsynchronously);
        internal TaskCompletionSource<long> StalledCloseTargetCommand { get; } = new(TaskCreationOptions.RunContinuationsAsynchronously);
        internal TaskCompletionSource<long> StalledDetachCommand { get; } = new(TaskCreationOptions.RunContinuationsAsynchronously);
        internal TaskCompletionSource<long> StalledFileAssignmentCommand { get; } = new(TaskCreationOptions.RunContinuationsAsynchronously);
        internal int ReadinessSamples { get; private set; }
        internal DateTimeOffset Clock { get; set; } = DateTimeOffset.UnixEpoch;
        internal XTiming Timing { get; }
        internal (double X, double Y) ComposeCenter => Center(ComposeBorder);
        internal (double X, double Y) PostCenter => Center(PostBorder);
        internal (double X, double Y) UnrelatedControlCenter => Center(UnrelatedControlBorder);

        internal object Detach() { Relinquished = true; return new { }; }
        internal object Assign(string[] paths) { AssignedPaths.AddRange(paths); MediaGroups.Clear(); for (int index = 0; index < paths.Length; index++) MediaGroups.Add(20 + index * 10); return new { }; }
        internal void RecordDraftReadback()
        {
            DraftReadbackCount++;
            if (DisablePostAfterFinalDraftReadback && DraftReadbackCount >= 2) PostEnabled = false;
        }
        internal int Query(int root, string selector) => (root, selector) switch
        {
            (1, "[data-testid='SideNav_NewTweet_Button']") => Home == XHomeState.Authenticated ? 2 : 0,
            (1, "div[role='dialog'][aria-modal='true']") => 10,
            (1, "a[href='/i/flow/login'], a[href*='login']") => Home == XHomeState.AuthenticationRequired ? 3 : 0,
            (1, "form[action*='challenge'], [data-testid='ocfEnterTextTextInput']") => Home == XHomeState.ManualAttentionRequired ? 4 : 0,
            (10, "[data-testid='tweetTextarea_0'][contenteditable='true']") => 11,
            (10, "button[data-testid='tweetButton']") => 12,
            (10, "input[data-testid='fileInput'][type='file']") => InputPresent ? 13 : 0,
            (10, "[data-testid='attachments']") => MediaGroups.Count == 0 ? 0 : 14,
            _ => 0,
        };
        internal int[] QueryAll(int root, string selector)
        {
            if (OutsideDialogDecoys && root == 1 && selector is "[role='group'][aria-label='Media']" or "img" or "[role='alert'], [aria-invalid='true']") return [80];
            if (root == 14 && selector == "[role='group'][aria-label='Media']") { ReadinessSamples++; return MediaGroups.Take(ObservedGroupCount ?? MediaGroups.Count).ToArray(); }
            if (MediaGroups.Contains(root) && selector == "img") return [root + 1];
            if (MediaGroups.Contains(root) && selector == "button[aria-label='Remove media']") return [root + 2];
            if (root == 10 && selector == "[aria-busy='true'], [role='progressbar']" && (Busy || (UnstableAfterFirstSample && ReadinessSamples > 1))) return [90];
            if (root == 10 && selector == "[role='alert'], [aria-invalid='true']" && HasError) return [91];
            return [];
        }
        internal object Describe(int id, int depth)
        {
            if (id != 11) return Node(id, Name(id), Attributes(id));
            EditorDescribeDepths.Add(depth);
            if (depth <= 0) return Node(id, Name(id), Attributes(id));
            RecordDraftReadback();
            return DraftEditorOverride ?? DraftEditorProjection(depth);
        }
        internal string Name(int id) => id switch { 2 => "A", 11 => "DIV", 12 => "BUTTON", 13 => "INPUT", _ => "DIV" };
        internal string[] Attributes(int id) => id switch
        {
            2 => ["data-testid", "SideNav_NewTweet_Button", "role", "link", "aria-label", "Post"],
            10 => ["role", "dialog", "aria-modal", "true"],
            11 => ["data-testid", "tweetTextarea_0", "contenteditable", "true"],
            12 => PostEnabled ? ["data-testid", "tweetButton", "type", "button"] : ["data-testid", "tweetButton", "type", "button", "aria-disabled", "true"],
            13 => ["data-testid", "fileInput", "type", "file", "multiple", ""],
            _ => [],
        };
        internal object Box(long backendNodeId)
        {
            bool image = backendNodeId is > 200 and < 500;
            int width = backendNodeId > 0 && (!image || ImageRendered) ? 100 : 0;
            int height = backendNodeId > 0 && (!image || ImageRendered) ? 80 : 0;
            int[] border = backendNodeId == 120 ? PostBorder : ComposeBorder;
            return new { width, height, border };
        }

        private static (double X, double Y) Center(int[] border) =>
            ((border[0] + border[2] + border[4] + border[6]) / 4d, (border[1] + border[3] + border[5] + border[7]) / 4d);

        internal JsonElement DraftEditorProjection(int depth) =>
            JsonSerializer.SerializeToElement(Project(DraftEditorTree(), Math.Max(0, depth)));

        private DraftFixtureNode DraftEditorTree()
        {
            string[] lines = Body.Split('\n');
            return Element(11, "DIV", Attributes(11),
            [
                Element(111, "DIV", new[] { "data-contents", "true" }, lines.Select(DraftBlock).ToArray())
            ]);
        }

        private DraftFixtureNode DraftBlock(string line, int index)
        {
            if (string.IsNullOrEmpty(line))
                return Element(200 + index, "DIV", new[] { "data-block", "true" },
                    [Element(300 + index, "BR", new[] { "data-text", "true" })]);

            DraftFixtureNode node = new(700 + index, 7000L + index, "#text", [], 3, line, []);
            node = Element(500 + index, "SPAN", new[] { "data-text", "true" }, [node]);
            node = Element(400 + index, "DIV", children: [node]);
            node = Element(300 + index, "DIV", children: [node]);
            return Element(200 + index, "DIV", new[] { "data-block", "true" }, [node]);
        }

        private static DraftFixtureNode Element(int nodeId, string nodeName, string[]? attributes = null, IReadOnlyList<DraftFixtureNode>? children = null) =>
            new(nodeId, (long)nodeId * 10, nodeName, attributes ?? [], null, null, children ?? []);

        private static Dictionary<string, object?> Project(DraftFixtureNode node, int remainingDepth)
        {
            var projection = new Dictionary<string, object?>
            {
                ["nodeId"] = node.NodeId,
                ["backendNodeId"] = node.BackendNodeId,
                ["nodeName"] = node.NodeName,
                ["attributes"] = node.Attributes,
            };
            if (node.NodeType is int nodeType) projection["nodeType"] = nodeType;
            if (node.NodeValue is not null) projection["nodeValue"] = node.NodeValue;
            if (remainingDepth > 0 && node.Children.Count != 0)
                projection["children"] = node.Children.Select(child => Project(child, remainingDepth - 1)).ToArray();
            return projection;
        }

        private sealed record DraftFixtureNode(
            int NodeId,
            long BackendNodeId,
            string NodeName,
            string[] Attributes,
            int? NodeType,
            string? NodeValue,
            IReadOnlyList<DraftFixtureNode> Children);
    }
}
