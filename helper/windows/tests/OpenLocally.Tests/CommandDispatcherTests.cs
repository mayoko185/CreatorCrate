using OpenLocally;

namespace OpenLocally.Tests;

public class CommandDispatcherTests
{
    private static readonly string SocialUri =
        $"creatorcrate-social://prepare?v=1&server=https%3A%2F%2Fcreatorcrate.test&intent={new string('a', 43)}";

    [Fact]
    public void Dispatch_MissingPatreonImage2_RequiresManualDialogWithOnlyTheSafeVariableName()
    {
        const string privateVanity = "private multiword vanity";
        const string privateImage1 = @"C:\\private media\\one.png";
        var dispatcher = CreateDispatcher(
            getEnvironmentVariable: name => name switch
            {
                CommandDispatcher.PatreonLiveValidationEnvironmentVariable => "1",
                CommandDispatcher.PatreonLiveCreatorVanityEnvironmentVariable => privateVanity,
                CommandDispatcher.PatreonLiveImage1EnvironmentVariable => privateImage1,
                CommandDispatcher.PatreonLiveImage2EnvironmentVariable => null,
                _ => null,
            },
            fileExists: _ => true);

        CommandDispatchResult result = dispatcher.Dispatch([CommandDispatcher.ValidatePatreonPreparationCommand], @"C:\\Tools\\OpenLocally.exe");

        Assert.False(result.Success);
        Assert.True(result.RequiresManualFailurePresentation);
        Assert.Equal("manual_patreon_validation_image_2_required", result.Error);
        Assert.Contains("Missing input: CREATORCRATE_PATREON_LIVE_IMAGE_2", result.Detail);
        Assert.DoesNotContain(privateVanity, result.Detail);
        Assert.DoesNotContain(privateImage1, result.Detail);
    }

    [Fact]
    public void Dispatch_OpenUri_UsesOnlyOpenLocallySeam()
    {
        int openCalls = 0;
        int socialCalls = 0;
        var dispatcher = CreateDispatcher(
            runOpen: uri =>
            {
                openCalls++;
                Assert.StartsWith("creatorcrate-open://", uri);
                return OpenLocallyResult.Ok();
            },
            runSocial: _ =>
            {
                socialCalls++;
                return CommandDispatchResult.Ok();
            });

        CommandDispatchResult result = dispatcher.Dispatch(
            ["creatorcrate-open://open?v=2&path=C%3A%5Cdemo&select=0"],
            @"C:\Tools\OpenLocally.exe");

        Assert.True(result.Success);
        Assert.Equal(1, openCalls);
        Assert.Equal(0, socialCalls);
    }

    [Fact]
    public void Dispatch_SocialUri_UsesOnlySocialSeam()
    {
        int openCalls = 0;
        int socialCalls = 0;
        var dispatcher = CreateDispatcher(
            runOpen: _ =>
            {
                openCalls++;
                return OpenLocallyResult.Ok();
            },
            runSocial: request =>
            {
                socialCalls++;
                Assert.Equal("https://creatorcrate.test/", request.ServerOrigin.AbsoluteUri);
                return CommandDispatchResult.Ok();
            });

        CommandDispatchResult result = dispatcher.Dispatch([SocialUri], @"C:\Tools\OpenLocally.exe");

        Assert.True(result.Success);
        Assert.Equal(0, openCalls);
        Assert.Equal(1, socialCalls);
    }

    [Fact]
    public void Dispatch_ProductionSocialUri_StopsAtAdapterCoverageGate()
    {
        var dispatcher = new CommandDispatcher();

        CommandDispatchResult result = dispatcher.Dispatch([SocialUri], @"C:\Tools\OpenLocally.exe");

        Assert.False(result.Success);
        Assert.Equal("production_adapters_unavailable", result.Error);
    }

    [Fact]
    public void ProductionRegistry_StillLeavesXUnregistered()
    {
        Assert.False(new SocialAdapterRegistry().Supports("x"));
    }

    [Fact]
    public void ProductionRegistry_StillLeavesPatreonUnregistered()
    {
        Assert.False(new SocialAdapterRegistry().Supports("patreon"));
    }

    [Fact]
    public void Dispatch_EnvironmentGateAlone_UsesNormalDispatchWithoutManualSeam()
    {
        int openCalls = 0;
        int manualCalls = 0;
        var dispatcher = CreateDispatcher(
            runOpen: _ =>
            {
                openCalls++;
                return OpenLocallyResult.Ok();
            },
            runManual: (_, _, _) =>
            {
                manualCalls++;
                return CommandDispatchResult.Ok();
            },
            getEnvironmentVariable: name => name == CommandDispatcher.XLiveValidationEnvironmentVariable ? "1" : @"C:\fixtures\harmless.png",
            fileExists: _ => true);

        CommandDispatchResult result = dispatcher.Dispatch(["creatorcrate-open://open?v=2&path=C%3A%5Cdemo&select=0"], @"C:\Tools\OpenLocally.exe");

        Assert.True(result.Success);
        Assert.Equal(1, openCalls);
        Assert.Equal(0, manualCalls);
    }

    [Fact]
    public void Dispatch_PatreonEnvironmentGateAlone_UsesNormalDispatchWithoutManualSeam()
    {
        int openCalls = 0;
        int manualCalls = 0;
        var dispatcher = CreateDispatcher(
            runOpen: _ =>
            {
                openCalls++;
                return OpenLocallyResult.Ok();
            },
            runManualPatreon: (_, _, _, _) =>
            {
                manualCalls++;
                return CommandDispatchResult.Ok();
            },
            getEnvironmentVariable: name => name switch
            {
                CommandDispatcher.PatreonLiveValidationEnvironmentVariable => "1",
                CommandDispatcher.PatreonLiveCreatorVanityEnvironmentVariable => "creator",
                CommandDispatcher.PatreonLiveImage1EnvironmentVariable => @"C:\fixtures\harmless-1.png",
                CommandDispatcher.PatreonLiveImage2EnvironmentVariable => @"C:\fixtures\harmless-2.png",
                _ => null,
            },
            fileExists: _ => true);

        CommandDispatchResult result = dispatcher.Dispatch(["creatorcrate-open://open?v=2&path=C%3A%5Cdemo&select=0"], @"C:\Tools\OpenLocally.exe");

        Assert.True(result.Success);
        Assert.Equal(1, openCalls);
        Assert.Equal(0, manualCalls);
    }

    [Theory]
    [InlineData(null)]
    [InlineData("")]
    [InlineData("0")]
    [InlineData("true")]
    public void Dispatch_ManualXCommandWithoutExactOptIn_FailsBeforeManualSeam(string? optIn)
    {
        int manualCalls = 0;
        int imageReads = 0;
        var dispatcher = CreateDispatcher(
            runManual: (_, _, _) =>
            {
                manualCalls++;
                return CommandDispatchResult.Ok();
            },
            getEnvironmentVariable: name =>
            {
                if (name == CommandDispatcher.XLiveValidationEnvironmentVariable) return optIn;
                imageReads++;
                return @"C:\fixtures\harmless.png";
            },
            fileExists: _ => throw new InvalidOperationException("The image must not be checked before exact opt-in."));

        CommandDispatchResult result = dispatcher.Dispatch([CommandDispatcher.ValidateXPreparationCommand], @"C:\Tools\OpenLocally.exe");

        Assert.False(result.Success);
        Assert.Equal("manual_x_validation_opt_in_required", result.Error);
        AssertManualPreflightDetail(result, "x", optIn);
        Assert.Equal(0, imageReads);
        Assert.Equal(0, manualCalls);
    }

    [Theory]
    [InlineData(null)]
    [InlineData("")]
    [InlineData("relative.png")]
    [InlineData(@"C:\fixtures\missing.png")]
    public void Dispatch_ManualXCommandWithInvalidImage_FailsBeforeManualSeam(string? imagePath)
    {
        int manualCalls = 0;
        int fileChecks = 0;
        var dispatcher = CreateDispatcher(
            runManual: (_, _, _) =>
            {
                manualCalls++;
                return CommandDispatchResult.Ok();
            },
            getEnvironmentVariable: name => name == CommandDispatcher.XLiveValidationEnvironmentVariable ? "1" : imagePath,
            fileExists: _ =>
            {
                fileChecks++;
                return false;
            });

        CommandDispatchResult result = dispatcher.Dispatch([CommandDispatcher.ValidateXPreparationCommand], @"C:\Tools\OpenLocally.exe");

        Assert.False(result.Success);
        Assert.Equal(imagePath is null or "" ? "manual_x_validation_image_required" : "manual_x_validation_image_invalid", result.Error);
        AssertManualPreflightDetail(result, "x", imagePath);
        Assert.Equal(string.IsNullOrWhiteSpace(imagePath) || imagePath == "relative.png" ? 0 : 1, fileChecks);
        Assert.Equal(0, manualCalls);
    }

    [Fact]
    public void Dispatch_ManualXCommandWithExtraArgument_ReturnsSanitizedPreflightDetail()
    {
        var dispatcher = CreateDispatcher();

        CommandDispatchResult result = dispatcher.Dispatch([CommandDispatcher.ValidateXPreparationCommand, "private-extra"], @"C:\Tools\OpenLocally.exe");

        Assert.False(result.Success);
        Assert.Equal("manual_x_validation_command_invalid", result.Error);
        AssertManualPreflightDetail(result, "x", "private-extra");
    }

    [Fact]
    public void Dispatch_ManualXCommandWithExactGate_InvokesManualSeamOnceWithFrozenPayload()
    {
        const string imagePath = @"C:\fixtures\harmless.png";
        int manualCalls = 0;
        string? title = null;
        string? body = null;
        IReadOnlyList<string>? mediaPaths = null;
        var dispatcher = CreateDispatcher(
            runManual: (actualTitle, actualBody, actualMediaPaths) =>
            {
                manualCalls++;
                title = actualTitle;
                body = actualBody;
                mediaPaths = actualMediaPaths;
                return CommandDispatchResult.Ok();
            },
            getEnvironmentVariable: name => name == CommandDispatcher.XLiveValidationEnvironmentVariable ? "1" : imagePath,
            fileExists: path => path == imagePath);

        CommandDispatchResult result = dispatcher.Dispatch([CommandDispatcher.ValidateXPreparationCommand], @"C:\Tools\OpenLocally.exe");

        Assert.True(result.Success);
        Assert.Equal(1, manualCalls);
        Assert.Equal("CreatorCrate X final validation", title);
        Assert.Equal("CreatorCrate X final validation\n\nUnicode check ✓", body);
        Assert.Equal([imagePath], mediaPaths);
    }

    [Fact]
    public void Dispatch_ManualPatreonCommandWithExtraArgument_FailsBeforeOptInOrManualSeam()
    {
        int environmentReads = 0;
        int manualCalls = 0;
        var dispatcher = CreateDispatcher(
            runManualPatreon: (_, _, _, _) =>
            {
                manualCalls++;
                return CommandDispatchResult.Ok();
            },
            getEnvironmentVariable: _ =>
            {
                environmentReads++;
                return "1";
            },
            fileExists: _ => throw new InvalidOperationException("Files must not be checked before exact command shape."));

        CommandDispatchResult result = dispatcher.Dispatch(
            [CommandDispatcher.ValidatePatreonPreparationCommand, "extra"],
            @"C:\Tools\OpenLocally.exe");

        Assert.False(result.Success);
        Assert.Equal("manual_patreon_validation_command_invalid", result.Error);
        AssertManualPreflightDetail(result, "patreon", "extra");
        Assert.Equal(0, environmentReads);
        Assert.Equal(0, manualCalls);
    }

    [Theory]
    [InlineData(null)]
    [InlineData("")]
    [InlineData("0")]
    [InlineData("true")]
    [InlineData("not-1")]
    public void Dispatch_ManualPatreonCommandWithoutExactOptIn_FailsBeforeManualSeam(string? optIn)
    {
        int nonGateEnvironmentReads = 0;
        int manualCalls = 0;
        var dispatcher = CreateDispatcher(
            runManualPatreon: (_, _, _, _) =>
            {
                manualCalls++;
                return CommandDispatchResult.Ok();
            },
            getEnvironmentVariable: name =>
            {
                if (name == CommandDispatcher.PatreonLiveValidationEnvironmentVariable) return optIn;
                nonGateEnvironmentReads++;
                return "unexpected";
            },
            fileExists: _ => throw new InvalidOperationException("Files must not be checked before exact opt-in."));

        CommandDispatchResult result = dispatcher.Dispatch([CommandDispatcher.ValidatePatreonPreparationCommand], @"C:\Tools\OpenLocally.exe");

        Assert.False(result.Success);
        Assert.Equal("manual_patreon_validation_opt_in_required", result.Error);
        AssertManualPreflightDetail(result, "patreon", optIn);
        Assert.Equal(0, nonGateEnvironmentReads);
        Assert.Equal(0, manualCalls);
    }

    [Theory]
    [InlineData(null, "manual_patreon_validation_creator_vanity_required")]
    [InlineData(" ", "manual_patreon_validation_creator_vanity_required")]
    [InlineData("creator/name", "manual_patreon_validation_creator_vanity_invalid")]
    [InlineData("creator\u0001name", "manual_patreon_validation_creator_vanity_invalid")]
    public void Dispatch_ManualPatreonCommandWithInvalidCreatorVanity_FailsBeforeImagePreflightOrManualSeam(string? creatorVanity, string expectedError)
    {
        int imageReads = 0;
        int manualCalls = 0;
        var dispatcher = CreateDispatcher(
            runManualPatreon: (_, _, _, _) =>
            {
                manualCalls++;
                return CommandDispatchResult.Ok();
            },
            getEnvironmentVariable: name =>
            {
                if (name == CommandDispatcher.PatreonLiveValidationEnvironmentVariable) return "1";
                if (name == CommandDispatcher.PatreonLiveCreatorVanityEnvironmentVariable) return creatorVanity;
                imageReads++;
                return @"C:\fixtures\harmless.png";
            },
            fileExists: _ => throw new InvalidOperationException("Files must not be checked before creator vanity validation."));

        CommandDispatchResult result = dispatcher.Dispatch([CommandDispatcher.ValidatePatreonPreparationCommand], @"C:\Tools\OpenLocally.exe");

        Assert.False(result.Success);
        Assert.Equal(expectedError, result.Error);
        AssertManualPreflightDetail(result, "patreon", creatorVanity);
        Assert.Equal(0, imageReads);
        Assert.Equal(0, manualCalls);
    }

    [Theory]
    [InlineData(1, "missing")]
    [InlineData(2, "missing")]
    [InlineData(1, "relative")]
    [InlineData(2, "relative")]
    [InlineData(1, "unsupported")]
    [InlineData(2, "unsupported")]
    [InlineData(1, "missing-file")]
    [InlineData(2, "missing-file")]
    public void Dispatch_ManualPatreonCommandWithInvalidImage_FailsBeforeManualSeam(int position, string invalidKind)
    {
        const string validImage1 = @"C:\fixtures\harmless-1.png";
        const string validImage2 = @"C:\fixtures\harmless-2.jpg";
        string? invalidImage = invalidKind switch
        {
            "missing" => null,
            "relative" => "relative.png",
            "unsupported" => @"C:\fixtures\unsupported.mp4",
            "missing-file" => @"C:\fixtures\missing.png",
            _ => throw new InvalidOperationException("Unknown manual image fixture."),
        };
        string? image1 = position == 1 ? invalidImage : validImage1;
        string? image2 = position == 2 ? invalidImage : validImage2;
        int manualCalls = 0;
        var dispatcher = CreateDispatcher(
            runManualPatreon: (_, _, _, _) =>
            {
                manualCalls++;
                return CommandDispatchResult.Ok();
            },
            getEnvironmentVariable: name => name switch
            {
                CommandDispatcher.PatreonLiveValidationEnvironmentVariable => "1",
                CommandDispatcher.PatreonLiveCreatorVanityEnvironmentVariable => "creator",
                CommandDispatcher.PatreonLiveImage1EnvironmentVariable => image1,
                CommandDispatcher.PatreonLiveImage2EnvironmentVariable => image2,
                _ => null,
            },
            fileExists: path => path != invalidImage);

        CommandDispatchResult result = dispatcher.Dispatch([CommandDispatcher.ValidatePatreonPreparationCommand], @"C:\Tools\OpenLocally.exe");

        Assert.False(result.Success);
        Assert.Equal(
            invalidKind == "missing"
                ? $"manual_patreon_validation_image_{position}_required"
                : $"manual_patreon_validation_image_{position}_invalid",
            result.Error);
        AssertManualPreflightDetail(result, "patreon", "creator", image1, image2);
        Assert.Equal(0, manualCalls);
    }

    [Fact]
    public void Dispatch_ManualPatreonCommandWithExactGate_InvokesManualSeamOnceWithFrozenPayload()
    {
        const string creatorVanity = "creator-name";
        const string image1Path = @"C:\fixtures\harmless-1.png";
        const string image2Path = @"C:\fixtures\harmless-2.webp";
        int manualCalls = 0;
        string? actualCreatorVanity = null;
        string? title = null;
        string? body = null;
        IReadOnlyList<string>? mediaPaths = null;
        var dispatcher = CreateDispatcher(
            runManualPatreon: (actualVanity, actualTitle, actualBody, actualMediaPaths) =>
            {
                manualCalls++;
                actualCreatorVanity = actualVanity;
                title = actualTitle;
                body = actualBody;
                mediaPaths = actualMediaPaths;
                return CommandDispatchResult.Ok();
            },
            getEnvironmentVariable: name => name switch
            {
                CommandDispatcher.PatreonLiveValidationEnvironmentVariable => "1",
                CommandDispatcher.PatreonLiveCreatorVanityEnvironmentVariable => creatorVanity,
                CommandDispatcher.PatreonLiveImage1EnvironmentVariable => image1Path,
                CommandDispatcher.PatreonLiveImage2EnvironmentVariable => image2Path,
                _ => null,
            },
            fileExists: path => path == image1Path || path == image2Path);

        CommandDispatchResult result = dispatcher.Dispatch([CommandDispatcher.ValidatePatreonPreparationCommand], @"C:\Tools\OpenLocally.exe");

        Assert.True(result.Success);
        Assert.Equal(1, manualCalls);
        Assert.Equal(creatorVanity, actualCreatorVanity);
        Assert.Equal("CreatorCrate Patreon final validation", title);
        Assert.Equal("CreatorCrate Patreon body validation\n\nUnicode check ✓", body);
        Assert.Equal([image1Path, image2Path], mediaPaths);
    }

    [Fact]
    public void Dispatch_ManualXCommand_PreservesStableFailureCodeAndSupplementalDiagnostic()
    {
        const string imagePath = @"C:\fixtures\harmless.png";
        const string diagnostic = "BrowserTextMismatchDiagnostic { ExpectedUtf16Length = 5, ActualUtf16Length = 6, FirstDifferenceIndex = 2 }";
        var dispatcher = CreateDispatcher(
            runManual: (_, _, _) => CommandDispatchResult.Fail("x_text_mismatch", diagnostic),
            getEnvironmentVariable: name => name == CommandDispatcher.XLiveValidationEnvironmentVariable ? "1" : imagePath,
            fileExists: path => path == imagePath);

        CommandDispatchResult manual = dispatcher.Dispatch([CommandDispatcher.ValidateXPreparationCommand], @"C:\Tools\OpenLocally.exe");
        CommandDispatchResult ordinary = dispatcher.Dispatch([SocialUri], @"C:\Tools\OpenLocally.exe");

        Assert.False(manual.Success);
        Assert.Equal("x_text_mismatch", manual.Error);
        Assert.Equal(diagnostic, manual.Detail);
        Assert.True(ordinary.Success);
        Assert.Null(ordinary.Detail);
    }

    [Fact]
    public void Dispatch_ManualPatreonCommand_PreservesOnlyTheBoundedTraceDetail()
    {
        const string creatorVanity = "test-creator";
        const string image1Path = @"C:\fixtures\distinctive-image-1.png";
        const string image2Path = @"C:\fixtures\distinctive-image-2.webp";
        const string trace = "patreon_manual_trace;creator_page_ready=1;create_found=1;create_activated=1;post_found=0;post_activated=0;composer_route_observed=0;original_target_present=1;replacement_target_appeared=0;error=patreon_post_control_missing";
        var dispatcher = CreateDispatcher(
            runManualPatreon: (_, _, _, _) => CommandDispatchResult.Fail("patreon_post_control_missing", trace),
            getEnvironmentVariable: name => name switch
            {
                CommandDispatcher.PatreonLiveValidationEnvironmentVariable => "1",
                CommandDispatcher.PatreonLiveCreatorVanityEnvironmentVariable => creatorVanity,
                CommandDispatcher.PatreonLiveImage1EnvironmentVariable => image1Path,
                CommandDispatcher.PatreonLiveImage2EnvironmentVariable => image2Path,
                _ => null,
            },
            fileExists: path => path == image1Path || path == image2Path);

        CommandDispatchResult result = dispatcher.Dispatch([CommandDispatcher.ValidatePatreonPreparationCommand], @"C:\Tools\OpenLocally.exe");

        Assert.False(result.Success);
        Assert.Equal("patreon_post_control_missing", result.Error);
        Assert.Equal(trace, result.Detail);
        Assert.DoesNotContain(creatorVanity, result.Detail);
        Assert.DoesNotContain("CreatorCrate Patreon final validation", result.Detail);
        Assert.DoesNotContain("CreatorCrate Patreon body validation", result.Detail);
        Assert.DoesNotContain(image1Path, result.Detail);
        Assert.DoesNotContain(image2Path, result.Detail);
        Assert.DoesNotContain("target-999", result.Detail);
        Assert.DoesNotContain("https://www.patreon.com/test-creator/posts/draft/edit", result.Detail);
        Assert.DoesNotContain("raw exception text", result.Detail);
    }

    [Fact]
    public void Dispatch_SocialUri_DoesNotResolveExecutablePath()
    {
        var dispatcher = CreateDispatcher();

        CommandDispatchResult result = dispatcher.Dispatch(
            [SocialUri],
            () => throw new InvalidOperationException("Executable path resolution must be registration-only."));

        Assert.True(result.Success);
    }

    [Fact]
    public void Dispatch_SocialUriWithExtraArgument_ReturnsFailureWithoutSeam()
    {
        int socialCalls = 0;
        var dispatcher = CreateDispatcher(runSocial: _ =>
        {
            socialCalls++;
            return CommandDispatchResult.Ok();
        });

        CommandDispatchResult result = dispatcher.Dispatch([SocialUri, "extra"], @"C:\Tools\OpenLocally.exe");

        Assert.False(result.Success);
        Assert.Equal(0, socialCalls);
    }

    [Theory]
    [InlineData("--register", "open-register")]
    [InlineData("--unregister", "open-unregister")]
    [InlineData("--register-social", "social-register")]
    [InlineData("--unregister-social", "social-unregister")]
    public void Dispatch_RegistrationCommands_SelectTheirOwnRegistrar(string command, string expected)
    {
        var calls = new List<string>();
        var dispatcher = new CommandDispatcher(
            _ => OpenLocallyResult.Ok(),
            _ => CommandDispatchResult.Ok(),
            _ =>
            {
                calls.Add("open-register");
                return ProtocolRegistrationResult.Ok();
            },
            () =>
            {
                calls.Add("open-unregister");
                return ProtocolRegistrationResult.Ok();
            },
            _ =>
            {
                calls.Add("social-register");
                return ProtocolRegistrationResult.Ok();
            },
            () =>
            {
                calls.Add("social-unregister");
                return ProtocolRegistrationResult.Ok();
            });

        CommandDispatchResult result = dispatcher.Dispatch([command], @"C:\Tools\OpenLocally.exe");

        Assert.True(result.Success);
        Assert.Equal([expected], calls);
    }

    [Fact]
    public void Dispatch_UnsupportedSocialVersion_ReturnsUpdateRequiredWithoutSocialSeam()
    {
        int socialCalls = 0;
        var dispatcher = CreateDispatcher(runSocial: _ =>
        {
            socialCalls++;
            return CommandDispatchResult.Ok();
        });

        CommandDispatchResult result = dispatcher.Dispatch(
            [$"creatorcrate-social://prepare?v=2&server=https%3A%2F%2Fcreatorcrate.test&intent={new string('a', 43)}"],
            @"C:\Tools\OpenLocally.exe");

        Assert.False(result.Success);
        Assert.Equal("helper_update_required", result.Error);
        Assert.Equal(0, socialCalls);
    }

    [Fact]
    public void Dispatch_ManualPatreonAttachedResolutionSurvivesRuntimeFailureIntoFullDetail()
    {
        var diagnostic = new SocialPreparationDiagnostic("patreon", "create_activation", "patreon_create_control_missing");
        diagnostic.SetCreateResolution(new(PatreonCreateResolutionOutcome.NoUsableCandidate, 2, 2, 0, 2, complete: true));
        diagnostic.CapturePrimary(new PatreonPreparationException("patreon_create_control_missing"));
        var error = new SocialPreparationRuntimeException("patreon_create_control_missing", null, diagnostic);
        // Exercise the real production wrapper/catch without a live browser runtime.
        var dispatcher = CreateDispatcher(
            runManualPatreon: (vanity, title, body, paths) => CommandDispatcher.RunProductionPatreonPreparation(
                vanity, title, body, paths, _ => throw error, _ => throw new InvalidOperationException("Unreachable adapter")),
            getEnvironmentVariable: name => name switch
            {
                CommandDispatcher.PatreonLiveValidationEnvironmentVariable => "1",
                CommandDispatcher.PatreonLiveCreatorVanityEnvironmentVariable => "private-creator",
                CommandDispatcher.PatreonLiveImage1EnvironmentVariable => @"C:\private\one.png",
                CommandDispatcher.PatreonLiveImage2EnvironmentVariable => @"C:\private\two.png",
                _ => null,
            }, fileExists: _ => true);
        CommandDispatchResult result = dispatcher.Dispatch([CommandDispatcher.ValidatePatreonPreparationCommand], @"C:\Tools\OpenLocally.exe");
        Assert.False(result.Success);
        Assert.Equal("patreon_create_control_missing", result.Error);
        Assert.Equal(diagnostic.FormatForDisplay(), result.Detail);
        Assert.Contains("outcome: no_usable_candidate", result.Detail);
        Assert.Contains("layout_rejected_count: 2", result.Detail);
        Assert.Contains("complete: yes", result.Detail);
        Assert.DoesNotContain("private", result.Detail);
    }

    private static CommandDispatcher CreateDispatcher(
        Func<string?, OpenLocallyResult>? runOpen = null,
        Func<SocialUriRequest, CommandDispatchResult>? runSocial = null,
        Func<string, string, IReadOnlyList<string>, CommandDispatchResult>? runManual = null,
        Func<string, string?>? getEnvironmentVariable = null,
        Func<string, bool>? fileExists = null,
        Func<string, string, string, IReadOnlyList<string>, CommandDispatchResult>? runManualPatreon = null) =>
        new(
            runOpen ?? (_ => OpenLocallyResult.Ok()),
            runSocial ?? (_ => CommandDispatchResult.Ok()),
            _ => ProtocolRegistrationResult.Ok(),
            () => ProtocolRegistrationResult.Ok(),
            _ => ProtocolRegistrationResult.Ok(),
            () => ProtocolRegistrationResult.Ok(),
            runManual,
            getEnvironmentVariable,
            fileExists,
            runManualPatreon);

    private static void AssertManualPreflightDetail(CommandDispatchResult result, string platform, params string?[] privateValues)
    {
        Assert.NotNull(result.Detail);
        Assert.Contains("Social Preparation failed", result.Detail);
        Assert.Contains($"Platform: {platform}", result.Detail);
        Assert.Contains($"Adapter: {platform}_social_preparation", result.Detail);
        Assert.Contains("Phase: manual_preflight", result.Detail);
        Assert.Contains($"Stable error: {result.Error}", result.Detail);
        Assert.Contains("Outcome: failed", result.Detail);
        Assert.Contains("Error class: validation", result.Detail);
        foreach (string? privateValue in privateValues.Where(value => !string.IsNullOrWhiteSpace(value)))
            Assert.DoesNotContain(privateValue!, result.Detail);
    }
}
