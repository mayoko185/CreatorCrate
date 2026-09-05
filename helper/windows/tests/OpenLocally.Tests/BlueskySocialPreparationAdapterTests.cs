using OpenLocally;
using System.Text.Json;

namespace OpenLocally.Tests;

public sealed class BlueskySocialPreparationAdapterTests
{
    [Fact]
    public async Task AuthenticatedHome_UsesExactBodyAndRelinquishesPreparedComposer()
    {
        var page = new FakePage();
        var progress = new Progress();
        PlatformPreparationResult result = await Adapter(page).PrepareAsync(Context(), progress, CancellationToken.None);

        Assert.Equal(PlatformPreparationOutcome.Prepared, result.Outcome);
        Assert.Equal("Line 1\n\nLine 3 — ✓", page.Composer.ReplacedText);
        Assert.Equal([SocialPreparationProgress.Preparing], progress.Values);
        Assert.Equal(1, page.ComposeActivations);
        Assert.True(page.Relinquished);
        Assert.False(page.Abandoned);
    }

    [Theory]
    [InlineData("login")]
    [InlineData("challenge")]
    public async Task LoginOrManualAttention_ReturnsAuthenticationRequiredAndPreservesPage(string state)
    {
        var page = new FakePage { Home = state == "login" ? BlueskyHomeState.AuthenticationRequired : BlueskyHomeState.ManualAttentionRequired };

        PlatformPreparationResult result = await Adapter(page).PrepareAsync(Context(), new Progress(), CancellationToken.None);

        Assert.Equal(PlatformPreparationOutcome.AuthenticationRequired, result.Outcome);
        Assert.False(page.Abandoned);
        Assert.False(page.Relinquished);
    }

    [Fact]
    public async Task HomeTimeout_FailsWithCuratedCodeAndAbandonsOwnedTarget() =>
        await AssertFailureAsync(new FakePage { Home = BlueskyHomeState.TimedOut }, "bluesky_home_timeout");

    [Fact]
    public async Task MissingComposeControl_FailsBeforeComposerActivation() =>
        await AssertFailureAsync(new FakePage { ComposeAvailable = false }, "bluesky_compose_control_missing");

    [Fact]
    public async Task MissingComposer_FailsWithCuratedCode() =>
        await AssertFailureAsync(new FakePage { ComposerAvailable = false }, "bluesky_composer_missing");

    [Fact]
    public async Task ExactMultilineUnicodeBody_IsNotRecomposedFromTitle()
    {
        var page = new FakePage();
        PlatformPreparationContext context = Context(title: "Ignored title", body: "Title\n\nDescription — ✓");

        PlatformPreparationResult result = await Adapter(page).PrepareAsync(context, new Progress(), CancellationToken.None);

        Assert.Equal(PlatformPreparationOutcome.Prepared, result.Outcome);
        Assert.Equal(context.Body, page.Composer.ReplacedText);
    }

    [Fact]
    public async Task EditorReadbackMismatch_FailsWithCuratedCode()
    {
        var page = new FakePage();
        page.Composer.ReplaceMatches = false;
        await AssertFailureAsync(page, "bluesky_text_mismatch");
    }

    [Fact]
    public async Task NoMedia_DoesNotAttachOrReportUploading()
    {
        var page = new FakePage();
        var progress = new Progress();
        await Adapter(page).PrepareAsync(Context(media: []), progress, CancellationToken.None);

        Assert.Empty(page.Composer.AttachedPaths);
        Assert.DoesNotContain(SocialPreparationProgress.Uploading, progress.Values);
    }

    [Fact]
    public async Task OneImage_AttachesExactPathAndTakesTwoReadySamples()
    {
        var page = new FakePage();
        var progress = new Progress();
        string[] paths = ["C:\\media\\one.png"];
        await Adapter(page).PrepareAsync(Context(media: paths), progress, CancellationToken.None);

        Assert.Equal(paths, page.Composer.AttachedPaths);
        Assert.Equal(2, page.Composer.ReadinessCalls);
        Assert.Equal([SocialPreparationProgress.Preparing, SocialPreparationProgress.Uploading], progress.Values);
    }

    [Fact]
    public async Task IncompleteThenReadyThenStable_ConvergesBeforeStabilityConfirmation()
    {
        var page = new FakePage();
        page.Composer.Readiness = [Ready() with { PreviewCountMatches = false }, Ready(), Ready()];

        PlatformPreparationResult result = await Adapter(page).PrepareAsync(Context(media: ["C:\\media\\one.png"]), new Progress(), CancellationToken.None);

        Assert.Equal(PlatformPreparationOutcome.Prepared, result.Outcome);
        Assert.Equal(3, page.Composer.ReadinessCalls);
    }

    [Fact]
    public async Task PermanentlyIncompleteMedia_FailsOnlyAfterTheBoundedConvergenceWindow()
    {
        var page = new FakePage();
        page.Composer.Readiness = [Ready() with { PreviewCountMatches = false }];

        await AssertFailureAsync(page, "bluesky_media_preview_incomplete", media: ["C:\\media\\one.png"]);
        Assert.True(page.Composer.ReadinessCalls > 1);
    }

    [Fact]
    public async Task MultipleImages_PreservesExactCallerOrder()
    {
        var page = new FakePage();
        string[] paths = ["C:\\media\\first.png", "C:\\media\\second.png"];
        await Adapter(page).PrepareAsync(Context(media: paths), new Progress(), CancellationToken.None);

        Assert.Equal(paths, page.Composer.AttachedPaths);
        Assert.Equal([2, 2], page.Composer.IntendedCounts);
    }

    [Theory]
    [InlineData(false, true, true, false, false, true, "bluesky_media_preview_incomplete")]
    [InlineData(true, false, true, false, false, true, "bluesky_media_preview_incomplete")]
    [InlineData(true, true, false, false, false, true, "bluesky_media_preview_incomplete")]
    [InlineData(true, true, true, true, false, true, "bluesky_media_not_ready")]
    [InlineData(true, true, true, false, true, true, "bluesky_media_error")]
    [InlineData(true, true, true, false, false, false, "bluesky_validation_error")]
    public async Task IncompleteOrInvalidMedia_NeverPrepares(bool count, bool rendered, bool controls, bool busy, bool error, bool enabled, string expectedCode)
    {
        var page = new FakePage();
        page.Composer.Readiness = [new BlueskyReadiness(count, rendered, controls, true, busy, error, enabled)];
        await AssertFailureAsync(page, expectedCode, media: ["C:\\media\\one.png"]);
    }

    [Fact]
    public async Task StabilityRegressionOnSecondSample_NeverPrepares()
    {
        var page = new FakePage();
        page.Composer.Readiness = [Ready(), Ready() with { IsBusy = true }];
        await AssertFailureAsync(page, "bluesky_media_not_ready", media: ["C:\\media\\one.png"]);
        Assert.Equal(2, page.Composer.ReadinessCalls);
    }

    [Fact]
    public async Task ChooserFailure_MapsToCuratedBlueskyCode()
    {
        var page = new FakePage();
        page.Composer.AttachSucceeds = false;
        await AssertFailureAsync(page, "bluesky_media_chooser_failed", media: ["C:\\media\\one.png"]);
    }

    [Fact]
    public async Task FinalTextOrRelinquishmentFailure_NeverReturnsPrepared()
    {
        var textPage = new FakePage();
        textPage.Composer.FinalTextMatches = false;
        await AssertFailureAsync(textPage, "bluesky_prepared_assertion_failed");

        var handoffPage = new FakePage { RelinquishFailure = new BrowserPreparationException(BrowserPreparationFailure.NotOwnedTarget) };
        await AssertFailureAsync(handoffPage, "bluesky_target_closed");
    }

    [Fact]
    public void AdapterSurface_CannotActivatePublishOrSubmit()
    {
        string[] names = typeof(BlueskySocialPreparationAdapter).GetMethods().Select(method => method.Name).ToArray();
        Assert.DoesNotContain(names, name => name.Contains("publish", StringComparison.OrdinalIgnoreCase) || name.Contains("submit", StringComparison.OrdinalIgnoreCase));
        Assert.DoesNotContain(typeof(IBlueskyComposer).GetMethods().Select(method => method.Name), name => name.Contains("publish", StringComparison.OrdinalIgnoreCase) || name.Contains("submit", StringComparison.OrdinalIgnoreCase));
    }

    [Fact]
    public async Task ProductionComposerDiscovery_UsesTheModalAndEmitsNoSubmitTranscript()
    {
        var (page, transport, socket) = ProductionPage();
        try
        {
            Assert.Equal(BlueskyHomeState.Authenticated, await page.NavigateAndWaitForHomeAsync(CancellationToken.None));
            Assert.True(await page.ActivateComposeAsync(CancellationToken.None));
            Assert.NotNull(await page.WaitForComposerAsync(CancellationToken.None));

            string[] commands = socket.Sent.Select(message => JsonDocument.Parse(message).RootElement.GetProperty("method").GetString()!).ToArray();
            Assert.Contains("DOM.querySelector", commands);
            Assert.DoesNotContain("Input.dispatchKeyEvent", commands);
            Assert.DoesNotContain("Runtime.evaluate", commands);
            Assert.DoesNotContain(commands, command => command.Contains("submit", StringComparison.OrdinalIgnoreCase) || command.Contains("uploadBlob", StringComparison.OrdinalIgnoreCase) || command.Contains("createRecord", StringComparison.OrdinalIgnoreCase));
            Assert.Equal(2, commands.Count(command => command == "Input.dispatchMouseEvent"));
        }
        finally
        {
            await page.DisposeAsync();
            await transport.DisposeAsync();
        }
    }

    [Fact]
    public async Task ProductionPrepare_NoMedia_CompletesTheRealNoSubmitTranscript()
    {
        var (page, transport, socket) = ProductionPage();
        var progress = new Progress();
        var adapter = new BlueskySocialPreparationAdapter(_ => page);
        try
        {
            PlatformPreparationResult result = await adapter.PrepareAsync(Context(), progress, CancellationToken.None);

            Assert.Equal(PlatformPreparationOutcome.Prepared, result.Outcome);
            Assert.Equal([SocialPreparationProgress.Preparing], progress.Values);
            string[] commands = socket.Sent.Select(message => JsonDocument.Parse(message).RootElement.GetProperty("method").GetString()!).ToArray();
            Assert.Equal(2, commands.Count(method => method == "Input.dispatchMouseEvent"));
            Assert.DoesNotContain("Runtime.evaluate", commands);
            Assert.DoesNotContain(commands, method => method.Contains("submit", StringComparison.OrdinalIgnoreCase) || method.Contains("uploadBlob", StringComparison.OrdinalIgnoreCase) || method.Contains("createRecord", StringComparison.OrdinalIgnoreCase));
        }
        finally
        {
            await page.DisposeAsync();
            await transport.DisposeAsync();
        }
    }

    [Theory]
    [MemberData(nameof(ProductionTextCases))]
    public async Task ProductionPrepare_PreservesExactEditorTextRepresentations(string body, int expectedLineBreaks)
    {
        var (page, transport, socket) = ProductionPage(readbackText: body);
        var adapter = new BlueskySocialPreparationAdapter(_ => page);
        try
        {
            PlatformPreparationResult result = await adapter.PrepareAsync(Context(body: body), new Progress(), CancellationToken.None);

            Assert.Equal(PlatformPreparationOutcome.Prepared, result.Outcome);
            JsonElement[] commands = socket.Sent.Select(message => JsonDocument.Parse(message).RootElement.Clone()).ToArray();
            string insertedText = string.Concat(commands
                .Where(command => command.GetProperty("method").GetString() == "Input.insertText")
                .Select(command => command.GetProperty("params").GetProperty("text").GetString()));
            int lineBreaks = commands.Count(command =>
                command.GetProperty("method").GetString() == "Input.dispatchKeyEvent" &&
                command.GetProperty("params").TryGetProperty("commands", out JsonElement values) &&
                values.EnumerateArray().Any(value => value.GetString() == "InsertLineBreak"));
            JsonElement[] readbacks = commands
                .Where(command => command.GetProperty("method").GetString() == "Accessibility.getPartialAXTree")
                .ToArray();

            Assert.Equal(body.Replace("\n", string.Empty, StringComparison.Ordinal), insertedText);
            Assert.Equal(expectedLineBreaks, lineBreaks);
            Assert.NotEmpty(readbacks);
            Assert.All(readbacks, command => Assert.True(command.GetProperty("params").GetProperty("fetchRelatives").GetBoolean()));
        }
        finally
        {
            await page.DisposeAsync();
            await transport.DisposeAsync();
        }
    }

    [Fact]
    public async Task ProductionComposer_TextMismatchDiagnosticIsStructuralAndDoesNotContainBodies()
    {
        const string expected = "private expected body \ud83d\ude00";
        const string actual = "private actual body\u00a0\u200b";
        var (page, transport, _) = ProductionPage(readbackText: actual);
        try
        {
            Assert.Equal(BlueskyHomeState.Authenticated, await page.NavigateAndWaitForHomeAsync(CancellationToken.None));
            Assert.True(await page.ActivateComposeAsync(CancellationToken.None));
            BlueskyComposer composer = Assert.IsType<BlueskyComposer>(await page.WaitForComposerAsync(CancellationToken.None));

            Assert.False(await composer.ReplaceAndVerifyTextAsync(expected, CancellationToken.None));
            BrowserTextMismatchDiagnostic diagnostic = Assert.IsType<BrowserTextMismatchDiagnostic>(composer.LastTextMismatchDiagnostic);
            string rendered = diagnostic.ToString();

            Assert.Equal(expected.Length, diagnostic.ExpectedUtf16Length);
            Assert.Equal(actual.Length, diagnostic.ActualUtf16Length);
            Assert.True(diagnostic.FirstDifferenceIndex >= 0);
            Assert.True(diagnostic.ActualHasNbsp);
            Assert.True(diagnostic.ActualHasZeroWidth);
            Assert.DoesNotContain(expected, rendered, StringComparison.Ordinal);
            Assert.DoesNotContain(actual, rendered, StringComparison.Ordinal);
            Assert.Contains("line_break_nodes=0", diagnostic.ReadbackStructure, StringComparison.Ordinal);
        }
        finally
        {
            await page.DisposeAsync();
            await transport.DisposeAsync();
        }
    }

    [Fact]
    public async Task ProductionPrepare_OneMedia_CompletesTheFullNoSubmitTranscript()
    {
        var fixture = new ProductionMediaFixture(1, incompleteSamples: 2);
        var (page, transport, socket) = ProductionPage(media: fixture);
        var adapter = new BlueskySocialPreparationAdapter(_ => page, fixture.Timing);
        var progress = new Progress();
        try
        {
            PlatformPreparationResult result = await adapter.PrepareAsync(Context(media: ["C:\\media\\one.png"]), progress, CancellationToken.None);

            Assert.Equal(PlatformPreparationOutcome.Prepared, result.Outcome);
            Assert.Equal([SocialPreparationProgress.Preparing, SocialPreparationProgress.Uploading], progress.Values);
            Assert.Equal(["C:\\media\\one.png"], fixture.AssignedPaths);
            Assert.True(fixture.ReadinessSamples >= 4);
            AssertNoSubmitTranscript(socket, fixture);
        }
        finally
        {
            await page.DisposeAsync();
            await transport.DisposeAsync();
        }
    }

    [Fact]
    public async Task ProductionPrepare_MultipleMedia_PreservesOrderAndEachPreviewReadiness()
    {
        var fixture = new ProductionMediaFixture(2);
        var (page, transport, socket) = ProductionPage(media: fixture);
        var adapter = new BlueskySocialPreparationAdapter(_ => page, fixture.Timing);
        string[] paths = ["C:\\media\\first.png", "C:\\media\\second.png"];
        try
        {
            PlatformPreparationResult result = await adapter.PrepareAsync(Context(media: paths), new Progress(), CancellationToken.None);

            Assert.Equal(PlatformPreparationOutcome.Prepared, result.Outcome);
            Assert.Equal(paths, fixture.AssignedPaths);
            Assert.Equal([20, 30], fixture.LastPreviewOrder);
            Assert.Equal(2, fixture.RenderedPreviewCount);
            AssertNoSubmitTranscript(socket, fixture);
        }
        finally
        {
            await page.DisposeAsync();
            await transport.DisposeAsync();
        }
    }

    [Fact]
    public void MediaNoSubmitTranscript_RejectsPublishActivationAtCanonicalCenter()
    {
        var fixture = new ProductionMediaFixture(1);
        var socket = new CdpTestSocket();
        EnqueuePrimaryActivationPair(socket, fixture.ComposeActivationCenter);
        EnqueuePrimaryActivationPair(socket, fixture.AddMediaActivationCenter);
        EnqueuePrimaryActivationPair(socket, fixture.PublishActivationCenter);

        Assert.ThrowsAny<Exception>(() => AssertNoSubmitTranscript(socket, fixture));
    }

    [Theory]
    [InlineData(ProductionMediaFailure.PermanentInvalidBoxModel, "bluesky_media_preview_incomplete")]
    [InlineData(ProductionMediaFailure.MalformedControls, "bluesky_media_preview_incomplete")]
    [InlineData(ProductionMediaFailure.StabilityRegression, "bluesky_validation_error")]
    [InlineData(ProductionMediaFailure.PublishDisabled, "bluesky_validation_error")]
    public async Task ProductionPrepare_MediaReadinessFailuresRemainCurated(ProductionMediaFailure failure, string expectedCode)
    {
        var fixture = new ProductionMediaFixture(2, failure: failure);
        var (page, transport, socket) = ProductionPage(media: fixture);
        var adapter = new BlueskySocialPreparationAdapter(_ => page, fixture.Timing);
        try
        {
            SocialPreparationRuntimeException error = await Assert.ThrowsAsync<SocialPreparationRuntimeException>(
                () => adapter.PrepareAsync(Context(media: ["C:\\media\\one.png", "C:\\media\\two.png"]), new Progress(), CancellationToken.None));

            Assert.Equal(expectedCode, error.Code);
            Assert.False(fixture.Relinquished);
            AssertNoPublishActivation(socket, fixture);
        }
        finally
        {
            await page.DisposeAsync();
            await transport.DisposeAsync();
        }
    }

    [Fact]
    public async Task ProductionPrepare_InvalidBoxModelThenValid_Converges()
    {
        var fixture = new ProductionMediaFixture(1, temporaryBoxModelResponses: 2);
        var (page, transport, _) = ProductionPage(media: fixture);
        var adapter = new BlueskySocialPreparationAdapter(_ => page, fixture.Timing);
        try
        {
            Assert.Equal(PlatformPreparationOutcome.Prepared,
                (await adapter.PrepareAsync(Context(media: ["C:\\media\\one.png"]), new Progress(), CancellationToken.None)).Outcome);
            Assert.Equal(2, fixture.TemporaryBoxModelResponsesObserved);
        }
        finally
        {
            await page.DisposeAsync();
            await transport.DisposeAsync();
        }
    }

    [Fact]
    public async Task ProductionPrepare_ReadinessCommandStall_MapsToCuratedFailureWithoutFurtherReadiness()
    {
        using var deadline = new CancellationTokenSource();
        var fixture = new ProductionMediaFixture(1, failure: ProductionMediaFailure.StallReadiness, deadline: deadline);
        var (page, transport, socket) = ProductionPage(media: fixture);
        var adapter = new BlueskySocialPreparationAdapter(_ => page, fixture.Timing);
        try
        {
            Task<PlatformPreparationResult> preparation = adapter.PrepareAsync(
                Context(media: ["C:\\media\\one.png"]), new Progress(), CancellationToken.None);
            long stalledCommandId = await fixture.StalledReadinessCommand.WaitAsync(TimeSpan.FromSeconds(5));
            int transcriptBoundary = socket.Sent.Count;
            Assert.True(fixture.StalledReadinessResponseSuppressed);

            deadline.Cancel();
            SocialPreparationRuntimeException error = await Assert.ThrowsAsync<SocialPreparationRuntimeException>(
                () => preparation);

            Assert.Equal("bluesky_media_not_ready", error.Code);
            Assert.Equal(1, fixture.ReadinessSamples);
            Assert.False(fixture.Relinquished);
            Assert.True(deadline.IsCancellationRequested);
            Assert.Contains(socket.Sent, message => CommandId(message) == stalledCommandId);
            Assert.DoesNotContain(socket.Sent.Skip(transcriptBoundary), IsReadinessOrStabilityCommand);
            Assert.DoesNotContain("Target.detachFromTarget", CommandMethods(socket));
            Assert.DoesNotContain(fixture.Delays, delay => delay == BlueskySocialPreparationAdapter.StabilityInterval);
        }
        finally
        {
            await page.DisposeAsync();
            await transport.DisposeAsync();
        }
    }

    [Fact]
    public async Task ProductionPrepare_IncrementalComposer_ProceedsButPartialComposerFailsWithinOneDeadline()
    {
        var incremental = new ProductionMediaFixture(1, composerPassesBeforeComplete: 2);
        var (incrementalPage, incrementalTransport, _) = ProductionPage(media: incremental);
        var incrementalAdapter = new BlueskySocialPreparationAdapter(_ => incrementalPage, incremental.Timing);
        try
        {
            Assert.Equal(PlatformPreparationOutcome.Prepared,
                (await incrementalAdapter.PrepareAsync(Context(media: ["C:\\media\\one.png"]), new Progress(), CancellationToken.None)).Outcome);
        }
        finally
        {
            await incrementalPage.DisposeAsync();
            await incrementalTransport.DisposeAsync();
        }

        var partial = new ProductionMediaFixture(1, failure: ProductionMediaFailure.PartialComposer);
        var (partialPage, partialTransport, _) = ProductionPage(media: partial);
        var partialAdapter = new BlueskySocialPreparationAdapter(_ => partialPage, partial.Timing);
        try
        {
            SocialPreparationRuntimeException error = await Assert.ThrowsAsync<SocialPreparationRuntimeException>(
                () => partialAdapter.PrepareAsync(Context(media: ["C:\\media\\one.png"]), new Progress(), CancellationToken.None));
            Assert.Equal("bluesky_composer_missing", error.Code);
            Assert.False(partial.MediaActivated);
        }
        finally
        {
            await partialPage.DisposeAsync();
            await partialTransport.DisposeAsync();
        }
    }

    [Fact]
    public async Task ProductionPrepare_OutsideDecoysIgnoredAndTransportFailureRemainsTerminal()
    {
        var decoys = new ProductionMediaFixture(1, outsideDecoys: true);
        var (decoyPage, decoyTransport, _) = ProductionPage(media: decoys);
        var decoyAdapter = new BlueskySocialPreparationAdapter(_ => decoyPage, decoys.Timing);
        try
        {
            Assert.Equal(PlatformPreparationOutcome.Prepared,
                (await decoyAdapter.PrepareAsync(Context(media: ["C:\\media\\one.png"]), new Progress(), CancellationToken.None)).Outcome);
        }
        finally
        {
            await decoyPage.DisposeAsync();
            await decoyTransport.DisposeAsync();
        }

        var transportFailure = new ProductionMediaFixture(1, failure: ProductionMediaFailure.TransportFailure);
        var (failurePage, failureTransport, _) = ProductionPage(media: transportFailure);
        var failureAdapter = new BlueskySocialPreparationAdapter(_ => failurePage, transportFailure.Timing);
        try
        {
            await Assert.ThrowsAsync<CdpTransportException>(
                () => failureAdapter.PrepareAsync(Context(media: ["C:\\media\\one.png"]), new Progress(), CancellationToken.None));
            Assert.False(transportFailure.Relinquished);
        }
        finally
        {
            try { await failurePage.DisposeAsync(); }
            catch (CdpTransportException) { }
            await failureTransport.DisposeAsync();
        }
    }

    [Fact]
    public async Task ProductionPrepare_ExternalCancellationRemainsDistinctAndRelinquishmentFailureNeverPrepares()
    {
        using var caller = new CancellationTokenSource();
        var cancelled = new ProductionMediaFixture(1, failure: ProductionMediaFailure.StallReadiness);
        var (cancelledPage, cancelledTransport, _) = ProductionPage(media: cancelled);
        var cancelledAdapter = new BlueskySocialPreparationAdapter(_ => cancelledPage, cancelled.Timing);
        try
        {
            Task<PlatformPreparationResult> preparation = cancelledAdapter.PrepareAsync(
                Context(media: ["C:\\media\\one.png"]), new Progress(), caller.Token);
            await cancelled.StalledReadinessCommand.WaitAsync(TimeSpan.FromSeconds(5));
            caller.Cancel();
            await Assert.ThrowsAnyAsync<OperationCanceledException>(
                () => preparation);
        }
        finally
        {
            await cancelledPage.DisposeAsync();
            await cancelledTransport.DisposeAsync();
        }

        var relinquishFailure = new ProductionMediaFixture(1, failure: ProductionMediaFailure.RelinquishFailure);
        var (relinquishPage, relinquishTransport, _) = ProductionPage(media: relinquishFailure);
        var relinquishAdapter = new BlueskySocialPreparationAdapter(_ => relinquishPage, relinquishFailure.Timing);
        try
        {
            await Assert.ThrowsAsync<CdpCommandException>(
                () => relinquishAdapter.PrepareAsync(Context(media: ["C:\\media\\one.png"]), new Progress(), CancellationToken.None));
            Assert.Equal(1, relinquishFailure.RelinquishAttempts);
        }
        finally
        {
            await relinquishPage.DisposeAsync();
            await relinquishTransport.DisposeAsync();
        }
    }

    [Theory]
    [InlineData("login", "AuthenticationRequired")]
    [InlineData("challenge", "ManualAttentionRequired")]
    public async Task ProductionHome_UsesCurrentAuthenticationSelectors(string state, string expected)
    {
        var (page, transport, _) = ProductionPage(state);
        try
        {
            Assert.Equal(Enum.Parse<BlueskyHomeState>(expected), await page.NavigateAndWaitForHomeAsync(CancellationToken.None));
        }
        finally
        {
            await page.DisposeAsync();
            await transport.DisposeAsync();
        }
    }

    [Fact]
    public async Task ProductionReadiness_IsModalScopedAndRequiresRenderedPerPreviewControls()
    {
        var (composer, session, transport, socket) = await ProductionReadinessComposerAsync();
        try
        {
            BlueskyReadiness readiness = await composer.ReadReadinessAsync(1, CancellationToken.None);

            Assert.True(readiness.PreviewCountMatches && readiness.ImagesRendered && readiness.ControlsMatch && readiness.OrderObserved);
            Assert.DoesNotContain(socket.Sent.Where(message => JsonDocument.Parse(message).RootElement.GetProperty("method").GetString() == "DOM.querySelectorAll"), message =>
                JsonDocument.Parse(message).RootElement.GetProperty("params").GetProperty("nodeId").GetInt32() == 1);
        }
        finally
        {
            await session.DisposeAsync();
            await transport.DisposeAsync();
        }
    }

    [Fact]
    public async Task ProductionReadiness_RejectsControlsConcentratedUnderOnePreview()
    {
        var (composer, session, transport, _) = await ProductionReadinessComposerAsync(concentratedControls: true);
        try
        {
            BlueskyReadiness readiness = await composer.ReadReadinessAsync(2, CancellationToken.None);
            Assert.False(readiness.ControlsMatch);
        }
        finally
        {
            await session.DisposeAsync();
            await transport.DisposeAsync();
        }
    }

    [Fact]
    public async Task ProductionReadiness_InvalidBoxModelThenValid_ConvergesInsteadOfEscapingProtocolError()
    {
        var (composer, session, transport, _) = await ProductionReadinessComposerAsync(unavailableBoxModelResponses: 1);
        try
        {
            Assert.False((await composer.ReadReadinessAsync(1, CancellationToken.None)).ImagesRendered);
            Assert.True((await composer.ReadReadinessAsync(1, CancellationToken.None)).ImagesRendered);
        }
        finally
        {
            await session.DisposeAsync();
            await transport.DisposeAsync();
        }
    }

    [Fact]
    public async Task ProductionReadiness_PermanentInvalidBoxModel_RemainsIncomplete()
    {
        var (composer, session, transport, _) = await ProductionReadinessComposerAsync(unavailableBoxModelResponses: int.MaxValue);
        try
        {
            Assert.False((await composer.ReadReadinessAsync(1, CancellationToken.None)).ImagesRendered);
            Assert.False((await composer.ReadReadinessAsync(1, CancellationToken.None)).ImagesRendered);
        }
        finally
        {
            await session.DisposeAsync();
            await transport.DisposeAsync();
        }
    }

    [Fact]
    public async Task ProductionReadiness_TransportFailureRemainsTerminal()
    {
        var (composer, session, transport, _) = await ProductionReadinessComposerAsync(transportFailureOnBoxModel: true);
        try
        {
            await Assert.ThrowsAsync<CdpTransportException>(() => composer.ReadReadinessAsync(1, CancellationToken.None));
        }
        finally
        {
            try { await session.DisposeAsync(); }
            catch (CdpTransportException) { }
            await transport.DisposeAsync();
        }
    }

    [Fact]
    public async Task ReadinessDeadline_CancelsNestedOperationAndMapsToCuratedFailure()
    {
        using var deadline = new CancellationTokenSource();
        var timing = new FakeTiming();
        var composer = new CancellingComposer(deadline.Cancel);
        var page = new ComposerPage(composer);
        var adapter = new BlueskySocialPreparationAdapter(_ => page,
            new BlueskyTiming(TimeSpan.FromSeconds(1), () => timing.UtcNow, timing.DelayAsync, _ => deadline));

        SocialPreparationRuntimeException error = await Assert.ThrowsAsync<SocialPreparationRuntimeException>(
            () => adapter.PrepareAsync(Context(media: ["C:\\media\\one.png"]), new Progress(), CancellationToken.None));

        Assert.Equal("bluesky_media_not_ready", error.Code);
        Assert.Equal(1, composer.ReadinessCalls);
        Assert.True(page.Abandoned);
    }

    [Fact]
    public async Task CallerCancellation_IsNotMappedToMediaTimeout()
    {
        using var caller = new CancellationTokenSource();
        var timing = new FakeTiming();
        var page = new ComposerPage(new CancellingComposer(caller.Cancel));
        var adapter = new BlueskySocialPreparationAdapter(_ => page,
            new BlueskyTiming(TimeSpan.FromSeconds(1), () => timing.UtcNow, timing.DelayAsync));

        await Assert.ThrowsAnyAsync<OperationCanceledException>(
            () => adapter.PrepareAsync(Context(media: ["C:\\media\\one.png"]), new Progress(), caller.Token));
    }

    [Fact]
    public async Task ProductionComposerDeadline_CancelsStalledCdpCommandAndReturnsCuratedFailure()
    {
        using var deadline = new CancellationTokenSource();
        var clock = new FakeTiming();
        bool composeActivated = false;
        BlueskyTiming timing = new(TimeSpan.FromSeconds(1), () => clock.UtcNow, clock.DelayAsync, _ => deadline);
        var (page, transport, socket) = ProductionPage(
            timing: timing,
            onCommand: method => composeActivated |= method == "Input.dispatchMouseEvent",
            stallCommand: method => composeActivated && method == "DOM.getDocument",
            onStalledCommand: deadline.Cancel);
        var adapter = new BlueskySocialPreparationAdapter(_ => page, timing);
        try
        {
            SocialPreparationRuntimeException error = await Assert.ThrowsAsync<SocialPreparationRuntimeException>(
                () => adapter.PrepareAsync(Context(), new Progress(), CancellationToken.None));

            Assert.Equal("bluesky_composer_missing", error.Code);
            string[] methods = socket.Sent.Select(message => JsonDocument.Parse(message).RootElement.GetProperty("method").GetString()!).ToArray();
            int stalled = Array.LastIndexOf(methods, "DOM.getDocument");
            Assert.Equal("DOM.getDocument", methods[stalled]);
            Assert.DoesNotContain(methods.Skip(stalled + 1), method => method is "DOM.querySelector" or "DOM.describeNode");
        }
        finally
        {
            await page.DisposeAsync();
            await transport.DisposeAsync();
        }
    }

    private static async Task<(BlueskyComposer Composer, BrowserPreparationSession Session, CdpTransport Transport, CdpTestSocket Socket)> ProductionReadinessComposerAsync(
        bool concentratedControls = false, int unavailableBoxModelResponses = 0, bool transportFailureOnBoxModel = false)
    {
        var socket = new CdpTestSocket();
        socket.OnSendAsync = message =>
        {
            using JsonDocument document = JsonDocument.Parse(message);
            JsonElement command = document.RootElement;
            long id = command.GetProperty("id").GetInt64();
            string method = command.GetProperty("method").GetString()!;
            JsonElement parameters = command.TryGetProperty("params", out JsonElement value) ? value : default;
            bool unavailableBoxModel = method == "DOM.getBoxModel" && unavailableBoxModelResponses > 0;
            if (unavailableBoxModel) unavailableBoxModelResponses--;
            object result = method switch
            {
                "Target.getTargets" => new { targetInfos = new[] { new { targetId = "fixture", type = "page", url = "https://fixture.test", title = "Fixture", attached = false } } },
                "Target.attachToTarget" => new { sessionId = "fixture-session" },
                "Target.detachFromTarget" => new { },
                "DOM.querySelectorAll" => new { nodeIds = ReadinessNodes(parameters.GetProperty("nodeId").GetInt32(), parameters.GetProperty("selector").GetString()!, concentratedControls) },
                "DOM.describeNode" => new { node = Node(parameters.GetProperty("nodeId").GetInt32(), null) },
                "DOM.getBoxModel" => new { model = new { width = 100, height = 50 } },
                _ => new { },
            };
            if (method == "DOM.getBoxModel" && transportFailureOnBoxModel)
            {
                socket.EnqueueFailure(new IOException("fixture transport failure"));
                return Task.CompletedTask;
            }
            if (unavailableBoxModel)
            {
                socket.EnqueueJson(JsonSerializer.Serialize(new { id, error = new { code = -32000, message = "Could not compute box model." } }));
                return Task.CompletedTask;
            }
            socket.EnqueueJson(JsonSerializer.Serialize(new { id, result }));
            return Task.CompletedTask;
        };

        var transport = new CdpTransport(socket);
        var targets = new BrowserPreparationTargets(new CdpTargetManager(transport));
        BrowserPreparationSession session = await targets.AttachAsync("fixture", cancellationToken: CancellationToken.None);
        var composer = new BlueskyComposer(
            session,
            "fixture-frame",
            new BrowserDomNode("fixture-session", 10, 100, "DIV", false, false),
            new BrowserDomNode("fixture-session", 11, 110, "DIV", true, false),
            new BrowserDomNode("fixture-session", 13, 130, "BUTTON", false, false),
            new BrowserDomNode("fixture-session", 12, 120, "BUTTON", false, false));
        return (composer, session, transport, socket);
    }

    private static int[] ReadinessNodes(int rootNodeId, string selector, bool concentratedControls)
    {
        if (rootNodeId == 10)
        {
            return selector switch
            {
                "[data-testid='selectedPhotosView']" => concentratedControls ? [20, 30] : [20],
                "[aria-busy='true'], progress, [role='progressbar']" or "[role='alert'], [aria-invalid='true']" => [],
                _ => [],
            };
        }
        if (rootNodeId is 20 or 30)
        {
            if (selector == "[data-testid='selectedPhotoImage']") return [rootNodeId + 1];
            if (!concentratedControls) return [rootNodeId + selector.Length];
            return rootNodeId == 20 ? [rootNodeId + selector.Length, rootNodeId + selector.Length + 50] : [];
        }
        return [];
    }

    private static (BlueskyPreparationPage Page, CdpTransport Transport, CdpTestSocket Socket) ProductionPage(
        string state = "authenticated", BlueskyTiming? timing = null, Action<string>? onCommand = null,
        Func<string, bool>? stallCommand = null, Action? onStalledCommand = null, ProductionMediaFixture? media = null,
        string readbackText = "Line 1\n\nLine 3 — ✓")
    {
        var socket = new CdpTestSocket();
        socket.OnSendAsync = message =>
        {
            using JsonDocument document = JsonDocument.Parse(message);
            JsonElement command = document.RootElement;
            long id = command.GetProperty("id").GetInt64();
            string method = command.GetProperty("method").GetString()!;
            JsonElement parameters = command.TryGetProperty("params", out JsonElement value) ? value : default;
            onCommand?.Invoke(method);
            if (stallCommand?.Invoke(method) == true)
            {
                onStalledCommand?.Invoke();
                return Task.CompletedTask;
            }
            if (media?.TryRespond(socket, id, method, parameters) == true) return Task.CompletedTask;
            object result = method switch
            {
                "Target.createTarget" => new { targetId = "fixture" },
                "Target.attachToTarget" => new { sessionId = "fixture-session" },
                "Page.navigate" => new { frameId = "fixture-frame" },
                "Target.closeTarget" => new { success = true },
                "DOM.getDocument" => new { root = Node(1, "#document") },
                "DOM.querySelector" => new { nodeId = NodeFor(parameters.GetProperty("selector").GetString()!, state) },
                "DOM.describeNode" => new { node = Node(parameters.GetProperty("nodeId").GetInt32(), null) },
                "DOM.getBoxModel" => new { model = new { border = new[] { 0, 0, 100, 0, 100, 50, 0, 50 } } },
                "Accessibility.getPartialAXTree" => new { nodes = RichAxNodes(readbackText) },
                _ => new { },
            };
            socket.EnqueueJson(JsonSerializer.Serialize(new { id, result }));
            return Task.CompletedTask;
        };

        var transport = new CdpTransport(socket);
        var targets = new BrowserPreparationTargets(new CdpTargetManager(transport));
        if (timing is null)
        {
            var fakeTiming = new FakeTiming();
            timing = new BlueskyTiming(TimeSpan.FromMilliseconds(200), () => fakeTiming.UtcNow, fakeTiming.DelayAsync);
        }
        return (new BlueskyPreparationPage(targets, timing), transport, socket);
    }

    private static string[] CommandMethods(CdpTestSocket socket) => socket.Sent
        .Select(message => JsonDocument.Parse(message).RootElement.GetProperty("method").GetString()!)
        .ToArray();

    private static void AssertNoPublishActivation(CdpTestSocket socket, ProductionMediaFixture fixture)
    {
        IReadOnlyList<MouseActivation> activations = PrimaryMouseActivations(socket);
        Assert.False(ContainsPrimaryActivationPair(activations, fixture.PublishActivationCenter));
        Assert.Equal(
        [
            new MouseActivation("mousePressed", fixture.ComposeActivationCenter),
            new MouseActivation("mouseReleased", fixture.ComposeActivationCenter),
            new MouseActivation("mousePressed", fixture.AddMediaActivationCenter),
            new MouseActivation("mouseReleased", fixture.AddMediaActivationCenter),
        ],
        activations);
    }

    private static IReadOnlyList<MouseActivation> PrimaryMouseActivations(CdpTestSocket socket)
    {
        var activations = new List<MouseActivation>();
        foreach (string message in socket.Sent)
        {
            using JsonDocument command = JsonDocument.Parse(message);
            JsonElement root = command.RootElement;
            if (root.GetProperty("method").GetString() != "Input.dispatchMouseEvent" ||
                !root.TryGetProperty("params", out JsonElement parameters) ||
                !parameters.TryGetProperty("type", out JsonElement type) ||
                type.GetString() is not ("mousePressed" or "mouseReleased") ||
                !parameters.TryGetProperty("button", out JsonElement button) || button.GetString() != "left" ||
                !parameters.TryGetProperty("x", out JsonElement x) || !parameters.TryGetProperty("y", out JsonElement y))
            {
                continue;
            }

            activations.Add(new MouseActivation(type.GetString()!, new ProductionMediaFixture.FixturePoint(x.GetDouble(), y.GetDouble())));
        }

        return activations;
    }

    private static bool ContainsPrimaryActivationPair(IReadOnlyList<MouseActivation> activations, ProductionMediaFixture.FixturePoint center) =>
        activations.Zip(activations.Skip(1)).Any(pair =>
            pair.First == new MouseActivation("mousePressed", center) &&
            pair.Second == new MouseActivation("mouseReleased", center));

    private static void EnqueuePrimaryActivationPair(CdpTestSocket socket, ProductionMediaFixture.FixturePoint center)
    {
        socket.Sent.Enqueue(JsonSerializer.Serialize(new
        {
            method = "Input.dispatchMouseEvent",
            @params = new { type = "mousePressed", x = center.X, y = center.Y, button = "left", clickCount = 1 },
        }));
        socket.Sent.Enqueue(JsonSerializer.Serialize(new
        {
            method = "Input.dispatchMouseEvent",
            @params = new { type = "mouseReleased", x = center.X, y = center.Y, button = "left", clickCount = 1 },
        }));
    }

    private static long CommandId(string message)
    {
        using JsonDocument command = JsonDocument.Parse(message);
        return command.RootElement.TryGetProperty("id", out JsonElement id) ? id.GetInt64() : 0;
    }

    private static bool IsReadinessOrStabilityCommand(string message)
    {
        using JsonDocument command = JsonDocument.Parse(message);
        JsonElement root = command.RootElement;
        string method = root.GetProperty("method").GetString()!;
        if (method is "DOM.describeNode" or "DOM.getBoxModel") return true;
        if (!root.TryGetProperty("params", out JsonElement parameters) || !parameters.TryGetProperty("selector", out JsonElement selector)) return false;

        return method == "DOM.querySelectorAll" && selector.GetString() is
            "[data-testid='selectedPhotosView']" or
            "[aria-busy='true'], progress, [role='progressbar']" or
            "[role='alert'], [aria-invalid='true']";
    }

    private readonly record struct MouseActivation(string Type, ProductionMediaFixture.FixturePoint Center);

    private static void AssertNoSubmitTranscript(CdpTestSocket socket, ProductionMediaFixture fixture)
    {
        string[] methods = CommandMethods(socket);
        AssertNoPublishActivation(socket, fixture);
        Assert.DoesNotContain(socket.Sent, message =>
        {
            using JsonDocument command = JsonDocument.Parse(message);
            if (command.RootElement.GetProperty("method").GetString() != "Input.dispatchKeyEvent") return false;
            JsonElement parameters = command.RootElement.GetProperty("params");
            if (!parameters.TryGetProperty("key", out JsonElement key) ||
                key.ValueKind != JsonValueKind.String || key.GetString() is not ("Enter" or "NumpadEnter")) return false;
            if (parameters.TryGetProperty("type", out JsonElement type) && type.GetString() == "keyUp") return false;
            return !parameters.TryGetProperty("commands", out JsonElement commands) ||
                commands.ValueKind != JsonValueKind.Array ||
                commands.GetArrayLength() != 1 ||
                commands[0].GetString() != "InsertLineBreak" ||
                !parameters.TryGetProperty("modifiers", out JsonElement modifiers) ||
                modifiers.GetInt32() != 8;
        });
        Assert.DoesNotContain("Runtime.evaluate", methods);
        Assert.DoesNotContain(methods, method => method.Contains("submit", StringComparison.OrdinalIgnoreCase) ||
            method.Contains("uploadBlob", StringComparison.OrdinalIgnoreCase) || method.Contains("createRecord", StringComparison.OrdinalIgnoreCase));
    }

    public enum ProductionMediaFailure
    {
        None,
        PermanentInvalidBoxModel,
        MalformedControls,
        StabilityRegression,
        PublishDisabled,
        StallReadiness,
        PartialComposer,
        TransportFailure,
        RelinquishFailure,
    }

    private sealed class ProductionMediaFixture
    {
        private readonly FakeTiming _clock = new();
        private readonly int _mediaCount;
        private readonly int _incompleteSamples;
        private readonly ProductionMediaFailure _failure;
        private readonly CancellationTokenSource? _deadline;
        private readonly int _composerPassesBeforeComplete;
        private readonly TaskCompletionSource<long> _stalledReadinessCommand = new(TaskCreationOptions.RunContinuationsAsynchronously);
        private readonly List<TimeSpan> _delays = [];
        private int _temporaryBoxModelResponses;
        private int _composerPasses;
        private bool _interceptionEnabled;

        internal ProductionMediaFixture(int mediaCount, int incompleteSamples = 0, int temporaryBoxModelResponses = 0,
            ProductionMediaFailure failure = ProductionMediaFailure.None, CancellationTokenSource? deadline = null,
            int composerPassesBeforeComplete = 1, bool outsideDecoys = false)
        {
            _mediaCount = mediaCount;
            _incompleteSamples = incompleteSamples;
            _temporaryBoxModelResponses = temporaryBoxModelResponses;
            _failure = failure;
            _deadline = deadline;
            _composerPassesBeforeComplete = composerPassesBeforeComplete;
            OutsideDecoys = outsideDecoys;
            Timing = new BlueskyTiming(TimeSpan.FromSeconds(1), () => _clock.UtcNow, DelayAsync,
                deadline is null ? null : _ => deadline);
        }

        internal BlueskyTiming Timing { get; }
        internal IReadOnlyList<string> AssignedPaths { get; private set; } = [];
        internal int ReadinessSamples { get; private set; }
        internal int TemporaryBoxModelResponsesObserved { get; private set; }
        internal IReadOnlyList<int> LastPreviewOrder { get; private set; } = [];
        internal int RenderedPreviewCount { get; private set; }
        internal bool MediaActivated { get; private set; }
        internal bool Relinquished { get; private set; }
        internal int RelinquishAttempts { get; private set; }
        internal bool OutsideDecoys { get; }
        internal Task<long> StalledReadinessCommand => _stalledReadinessCommand.Task;
        internal bool StalledReadinessResponseSuppressed { get; private set; }
        internal IReadOnlyList<TimeSpan> Delays => _delays;
        internal FixturePoint ComposeActivationCenter => BoxFor(20).Center;
        internal FixturePoint AddMediaActivationCenter => BoxFor(130).Center;
        internal FixturePoint PublishActivationCenter => BoxFor(120).Center;

        internal bool TryRespond(CdpTestSocket socket, long id, string method, JsonElement parameters)
        {
            if (method == "Page.setInterceptFileChooserDialog")
            {
                _interceptionEnabled = parameters.GetProperty("enabled").GetBoolean();
                Reply(socket, id, new { });
                return true;
            }

            if (method == "Input.dispatchMouseEvent" && _interceptionEnabled)
            {
                if (!MediaActivated)
                {
                    MediaActivated = true;
                    socket.EnqueueJson(JsonSerializer.Serialize(new { method = "Page.fileChooserOpened", sessionId = "fixture-session", params_ = new { backendNodeId = 990L, frameId = "fixture-frame" } }).Replace("params_", "params", StringComparison.Ordinal));
                }
                Reply(socket, id, new { });
                return true;
            }

            if (method == "DOM.setFileInputFiles")
            {
                AssignedPaths = parameters.GetProperty("files").EnumerateArray().Select(path => path.GetString()!).ToArray();
                Reply(socket, id, new { });
                return true;
            }

            if (method == "DOM.querySelector")
            {
                string selector = parameters.GetProperty("selector").GetString()!;
                int root = parameters.GetProperty("nodeId").GetInt32();
                if (root == 1 && selector == "[role='dialog'][aria-modal='true']") _composerPasses++;
                if (selector is "div.tiptap.ProseMirror[contenteditable='true']" or "button[data-testid='composerPublishBtn']" or "button[data-testid='openMediaBtn']")
                {
                    int nodeId = selector switch
                    {
                        "div.tiptap.ProseMirror[contenteditable='true']" => ComposerControl(11),
                        "button[data-testid='composerPublishBtn']" => ComposerControl(12),
                        _ => ComposerControl(13),
                    };
                    Reply(socket, id, new { nodeId });
                    return true;
                }
            }

            if (method == "DOM.querySelectorAll")
            {
                int root = parameters.GetProperty("nodeId").GetInt32();
                string selector = parameters.GetProperty("selector").GetString()!;
                if (_failure == ProductionMediaFailure.StallReadiness && root == 10 && selector == "[data-testid='selectedPhotosView']")
                {
                    ReadinessSamples++;
                    StalledReadinessResponseSuppressed = true;
                    _stalledReadinessCommand.TrySetResult(id);
                    return true;
                }
                int[] nodes = QueryNodes(root, selector);
                if (nodes.Length != 0 || root == 10)
                {
                    Reply(socket, id, new { nodeIds = nodes });
                    return true;
                }
            }

            if (method == "DOM.describeNode")
            {
                if (parameters.TryGetProperty("backendNodeId", out JsonElement backend))
                {
                    Reply(socket, id, new { node = InputNode(backend.GetInt64()) });
                    return true;
                }
                int nodeId = parameters.GetProperty("nodeId").GetInt32();
                Reply(socket, id, new { node = DescribedNode(nodeId) });
                return true;
            }

            if (method == "DOM.getBoxModel")
            {
                long backend = parameters.GetProperty("backendNodeId").GetInt64();
                bool readinessImage = backend >= 200;
                if (_failure == ProductionMediaFailure.TransportFailure && readinessImage)
                {
                    socket.EnqueueFailure(new IOException("fixture transport failure"));
                    return true;
                }
                if (readinessImage && (_failure == ProductionMediaFailure.PermanentInvalidBoxModel || _temporaryBoxModelResponses > 0))
                {
                    if (_temporaryBoxModelResponses > 0) { _temporaryBoxModelResponses--; TemporaryBoxModelResponsesObserved++; }
                    socket.EnqueueJson(JsonSerializer.Serialize(new { id, error = new { code = -32000, message = "Could not compute box model." } }));
                    return true;
                }
                FixtureBox box = BoxFor(backend);
                Reply(socket, id, new { model = new { border = box.Border, width = 100, height = 50 } });
                return true;
            }

            if (method == "Target.detachFromTarget")
            {
                RelinquishAttempts++;
                if (_failure == ProductionMediaFailure.RelinquishFailure)
                {
                    socket.EnqueueJson(JsonSerializer.Serialize(new { id, error = new { code = -32000, message = "fixture relinquishment failure" } }));
                    return true;
                }
                Relinquished = true;
                Reply(socket, id, new { });
                return true;
            }

            return false;
        }

        private int ComposerControl(int nodeId)
        {
            if (_failure == ProductionMediaFailure.PartialComposer) return nodeId == 11 ? 11 : 0;
            return _composerPasses >= _composerPassesBeforeComplete ? nodeId : 0;
        }

        private int[] QueryNodes(int root, string selector)
        {
            if (OutsideDecoys && root == 1 && selector is "[data-testid='selectedPhotosView']" or "[aria-busy='true'], progress, [role='progressbar']" or "[role='alert'], [aria-invalid='true']") return [400];
            if (root == 10 && selector == "[data-testid='selectedPhotosView']")
            {
                ReadinessSamples++;
                if (AssignedPaths.Count == 0 || ReadinessSamples <= _incompleteSamples) return [];
                LastPreviewOrder = Enumerable.Range(0, _mediaCount).Select(index => 20 + index * 10).ToArray();
                RenderedPreviewCount = LastPreviewOrder.Count;
                return LastPreviewOrder.ToArray();
            }
            if (root == 10 && selector is "[aria-busy='true'], progress, [role='progressbar']" or "[role='alert'], [aria-invalid='true']") return [];
            if (root is >= 20 and <= 50)
            {
                if (selector == "[data-testid='selectedPhotoImage']") return [root + 1];
                if (_failure == ProductionMediaFailure.MalformedControls)
                    return root == 20 ? [root + selector.Length, root + selector.Length + 50] : [];
                return [root + selector.Length];
            }
            return [];
        }

        private object DescribedNode(int nodeId)
        {
            bool disabled = nodeId == 12 && (_failure == ProductionMediaFailure.PublishDisabled ||
                (_failure == ProductionMediaFailure.StabilityRegression && ReadinessSamples >= 2));
            return new
            {
                nodeId,
                backendNodeId = nodeId * 10L,
                nodeName = nodeId is 2 or 12 or 13 ? "BUTTON" : "DIV",
                attributes = disabled ? new[] { "disabled", "" } : (nodeId == 11 ? new[] { "contenteditable", "true" } : Array.Empty<string>()),
            };
        }

        private static object InputNode(long backendNodeId) => new
        {
            nodeId = 99,
            backendNodeId,
            nodeName = "INPUT",
            attributes = new[] { "type", "file", "multiple", "" },
        };

        private static void Reply(CdpTestSocket socket, long id, object result) =>
            socket.EnqueueJson(JsonSerializer.Serialize(new { id, result }));

        private Task DelayAsync(TimeSpan delay, CancellationToken cancellationToken)
        {
            _delays.Add(delay);
            return _clock.DelayAsync(delay, cancellationToken);
        }

        private static FixtureBox BoxFor(long backend) => new(backend, 0, backend + 1, 1);

        internal readonly record struct FixturePoint(double X, double Y);

        private readonly record struct FixtureBox(double Left, double Top, double Right, double Bottom)
        {
            internal FixturePoint Center => new((Left + Right) / 2, (Top + Bottom) / 2);
            internal double[] Border => [Left, Top, Right, Top, Right, Bottom, Left, Bottom];
        }
    }

    private static int NodeFor(string selector, string state) => selector switch
    {
        "button[aria-label='Compose new post']" => state == "authenticated" ? 2 : 0,
        "a[href='/login'], a[href*='login']" => state == "login" ? 3 : 0,
        "[role='alert'][aria-live='assertive']" => state == "challenge" ? 4 : 0,
        "[role='dialog'][aria-modal='true']" => 10,
        "div.tiptap.ProseMirror[contenteditable='true']" => 11,
        "button[data-testid='composerPublishBtn']" => 12,
        "button[data-testid='openMediaBtn']" => 13,
        _ => 0,
    };

    private static object Node(int nodeId, string? explicitName) => new
    {
        nodeId,
        backendNodeId = nodeId * 10L,
        nodeName = explicitName ?? (nodeId is 2 or 12 or 13 ? "BUTTON" : "DIV"),
        attributes = nodeId == 11 ? new[] { "contenteditable", "true" } : Array.Empty<string>(),
    };

    public static IEnumerable<object[]> ProductionTextCases()
    {
        yield return ["single line", 0];
        yield return ["line 1\nline 2", 1];
        yield return ["line 1\n\nline 3", 2];
        yield return ["line 1\n\n\nline 4", 3];
        yield return ["Unicode — ✓", 0];
        yield return ["emoji \ud83d\ude00", 0];
        yield return ["CRLF\r\nsource", 1];
        yield return ["NBSP\u00a0and zero-width\u200b", 0];
    }

    private static object[] RichAxNodes(string text)
    {
        var nodes = new List<object>();
        var childIds = new List<string>();
        int start = 0;
        int sequence = 0;
        for (int index = 0; index <= text.Length; index++)
        {
            if (index < text.Length && text[index] != '\n') continue;
            if (index > start)
            {
                string id = $"text-{sequence++}";
                childIds.Add(id);
                nodes.Add(new { nodeId = id, role = new { value = "StaticText" }, name = new { value = text[start..index] } });
            }
            if (index < text.Length)
            {
                string id = $"break-{sequence++}";
                childIds.Add(id);
                nodes.Add(new { nodeId = id, role = new { value = "LineBreak" } });
            }
            start = index + 1;
        }

        nodes.Insert(0, new
        {
            nodeId = "editor",
            backendDOMNodeId = 110L,
            role = new { value = "textbox" },
            childIds = childIds.ToArray(),
        });
        return nodes.ToArray();
    }

    private static BlueskySocialPreparationAdapter Adapter(FakePage page)
    {
        var timing = new FakeTiming();
        return new BlueskySocialPreparationAdapter(_ => page, new BlueskyTiming(TimeSpan.FromSeconds(1), () => timing.UtcNow, timing.DelayAsync));
    }

    private static PlatformPreparationContext Context(string title = "title", string body = "Line 1\n\nLine 3 — ✓", IReadOnlyList<string>? media = null) =>
        new("bluesky", title, body, media ?? [], BrowserTargets: null);

    private static BlueskyReadiness Ready() => new(true, true, true, true, false, false, true);

    private static async Task AssertFailureAsync(FakePage page, string expectedCode, IReadOnlyList<string>? media = null)
    {
        SocialPreparationRuntimeException error = await Assert.ThrowsAsync<SocialPreparationRuntimeException>(
            () => Adapter(page).PrepareAsync(Context(media: media), new Progress(), CancellationToken.None));
        Assert.Equal(expectedCode, error.Code);
        Assert.True(page.Abandoned);
        Assert.False(page.Relinquished);
    }

    private sealed class Progress : IPreparationProgress
    {
        internal List<SocialPreparationProgress> Values { get; } = [];
        public Task ReportAsync(SocialPreparationProgress progress, CancellationToken cancellationToken) { Values.Add(progress); return Task.CompletedTask; }
    }

    private sealed class FakePage : IBlueskyPreparationPage
    {
        internal BlueskyHomeState Home { get; set; } = BlueskyHomeState.Authenticated;
        internal bool ComposeAvailable { get; set; } = true;
        internal bool ComposerAvailable { get; set; } = true;
        internal int ComposeActivations { get; private set; }
        internal bool Relinquished { get; private set; }
        internal bool Abandoned { get; private set; }
        internal Exception? RelinquishFailure { get; set; }
        internal FakeComposer Composer { get; } = new();

        public Task<BlueskyHomeState> NavigateAndWaitForHomeAsync(CancellationToken cancellationToken) => Task.FromResult(Home);
        public Task<bool> ActivateComposeAsync(CancellationToken cancellationToken) { if (ComposeAvailable) ComposeActivations++; return Task.FromResult(ComposeAvailable); }
        public Task<IBlueskyComposer?> WaitForComposerAsync(CancellationToken cancellationToken) => Task.FromResult<IBlueskyComposer?>(ComposerAvailable ? Composer : null);
        public Task RelinquishAsync(CancellationToken cancellationToken)
        {
            if (RelinquishFailure is not null) return Task.FromException(RelinquishFailure);
            Relinquished = true;
            return Task.CompletedTask;
        }
        public Task AbandonAsync() { Abandoned = true; return Task.CompletedTask; }
        public ValueTask DisposeAsync() => ValueTask.CompletedTask;
    }

    private sealed class FakeComposer : IBlueskyComposer
    {
        internal bool ReplaceMatches { get; set; } = true;
        internal bool FinalTextMatches { get; set; } = true;
        internal bool AttachSucceeds { get; set; } = true;
        internal string? ReplacedText { get; private set; }
        internal IReadOnlyList<string> AttachedPaths { get; private set; } = [];
        internal List<BlueskyReadiness> Readiness { get; set; } = [Ready(), Ready()];
        internal int ReadinessCalls { get; private set; }
        internal List<int> IntendedCounts { get; } = [];

        public Task<bool> ReplaceAndVerifyTextAsync(string text, CancellationToken cancellationToken) { ReplacedText = text; return Task.FromResult(ReplaceMatches); }
        public Task<bool> AttachMediaAsync(IReadOnlyList<string> paths, CancellationToken cancellationToken) { AttachedPaths = paths.ToArray(); return Task.FromResult(AttachSucceeds); }
        public Task<BlueskyReadiness> ReadReadinessAsync(int intendedCount, CancellationToken cancellationToken)
        {
            IntendedCounts.Add(intendedCount);
            return Task.FromResult(Readiness[Math.Min(ReadinessCalls++, Readiness.Count - 1)]);
        }
        public Task<bool> IsValidWithoutMediaAsync(CancellationToken cancellationToken) => Task.FromResult(true);
        public Task<bool> VerifyTextAsync(string text, CancellationToken cancellationToken) => Task.FromResult(FinalTextMatches);
    }

    private sealed class ComposerPage(IBlueskyComposer composer) : IBlueskyPreparationPage
    {
        internal bool Abandoned { get; private set; }

        public Task<BlueskyHomeState> NavigateAndWaitForHomeAsync(CancellationToken cancellationToken) => Task.FromResult(BlueskyHomeState.Authenticated);
        public Task<bool> ActivateComposeAsync(CancellationToken cancellationToken) => Task.FromResult(true);
        public Task<IBlueskyComposer?> WaitForComposerAsync(CancellationToken cancellationToken) => Task.FromResult<IBlueskyComposer?>(composer);
        public Task RelinquishAsync(CancellationToken cancellationToken) => Task.CompletedTask;
        public Task AbandonAsync() { Abandoned = true; return Task.CompletedTask; }
        public ValueTask DisposeAsync() => ValueTask.CompletedTask;
    }

    private sealed class CancellingComposer(Action cancel) : IBlueskyComposer
    {
        internal int ReadinessCalls { get; private set; }

        public Task<bool> ReplaceAndVerifyTextAsync(string text, CancellationToken cancellationToken) => Task.FromResult(true);
        public Task<bool> AttachMediaAsync(IReadOnlyList<string> paths, CancellationToken cancellationToken) => Task.FromResult(true);
        public async Task<BlueskyReadiness> ReadReadinessAsync(int intendedCount, CancellationToken cancellationToken)
        {
            ReadinessCalls++;
            cancel();
            await Task.Delay(Timeout.InfiniteTimeSpan, cancellationToken);
            throw new InvalidOperationException();
        }
        public Task<bool> IsValidWithoutMediaAsync(CancellationToken cancellationToken) => Task.FromResult(true);
        public Task<bool> VerifyTextAsync(string text, CancellationToken cancellationToken) => Task.FromResult(true);
    }

    private sealed class FakeTiming
    {
        internal DateTimeOffset UtcNow { get; private set; } = DateTimeOffset.UnixEpoch;

        internal Task DelayAsync(TimeSpan delay, CancellationToken cancellationToken)
        {
            cancellationToken.ThrowIfCancellationRequested();
            UtcNow += delay;
            return Task.CompletedTask;
        }
    }
}
