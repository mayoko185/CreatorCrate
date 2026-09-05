using OpenLocally;
using OpenLocally.Tests.Manual;

namespace OpenLocally.Tests;

public class BrowserPreparationApiSurfaceTests
{
    private const System.Reflection.BindingFlags PublicDeclared = System.Reflection.BindingFlags.Instance |
        System.Reflection.BindingFlags.Static | System.Reflection.BindingFlags.Public | System.Reflection.BindingFlags.DeclaredOnly;

    private static readonly System.Reflection.Assembly ProductionAssembly = typeof(ISocialPreparationAdapter).Assembly;

    // Production contract types directly handed to adapter implementations.
    private static readonly Type[] AdapterContractRoots =
    [
        typeof(ISocialPreparationAdapter), typeof(PlatformPreparationContext),
        typeof(IPreparationProgress), typeof(PlatformPreparationResult),
    ];

    // Bounded browser facades intentionally reviewed alongside the adapter contract.
    private static readonly Type[] BoundedBrowserRoots =
    [
        typeof(BrowserPreparationSession), typeof(BrowserTextEditor),
        typeof(BrowserFileChooser), typeof(BrowserTargetSelector),
    ];

    private static readonly string[] ExpectedReachableTypeNames =
    [
        "OpenLocally.BrowserDomNode",
        "OpenLocally.BrowserFileChooser",
        "OpenLocally.BrowserNavigationResult",
        "OpenLocally.BrowserPreparationSession",
        "OpenLocally.BrowserPreparationTargets",
        "OpenLocally.BrowserTargetSelector",
        "OpenLocally.BrowserTextEditor",
        "OpenLocally.BrowserTextVerification",
        "OpenLocally.CdpBrowserVersion",
        "OpenLocally.CdpTargetInfo",
        "OpenLocally.IPreparationProgress",
        "OpenLocally.ISocialPreparationAdapter",
        "OpenLocally.PatreonCreateResolutionEvidence",
        "OpenLocally.PatreonCreateResolutionOutcome",
        "OpenLocally.PlatformPreparationContext",
        "OpenLocally.PlatformPreparationOutcome",
        "OpenLocally.PlatformPreparationResult",
        "OpenLocally.SocialPreparationDiagnostic",
        "OpenLocally.SocialPreparationProgress",
    ];

    private static readonly IReadOnlyDictionary<Type, string[]> ExpectedMembers = new Dictionary<Type, string[]>
    {
        [typeof(ISocialPreparationAdapter)] =
        [
            "property System.String Platform { get; }",
            "method System.Threading.Tasks.Task<OpenLocally.PlatformPreparationResult> PrepareAsync(OpenLocally.PlatformPreparationContext, OpenLocally.IPreparationProgress, System.Threading.CancellationToken)",
        ],
        [typeof(PlatformPreparationContext)] =
        [
            ".ctor(System.String, System.String, System.String, System.Collections.Generic.IReadOnlyList<System.String>, OpenLocally.BrowserPreparationTargets)",
            "property OpenLocally.BrowserPreparationTargets BrowserTargets { get; set; }",
            "property System.Collections.Generic.IReadOnlyList<System.String> MediaPaths { get; set; }",
            "property System.String Body { get; set; }",
            "property System.String Platform { get; set; }",
            "property System.String Title { get; set; }",
        ],
        [typeof(IPreparationProgress)] =
        [
            "method System.Threading.Tasks.Task ReportAsync(OpenLocally.SocialPreparationProgress, System.Threading.CancellationToken)",
        ],
        [typeof(PlatformPreparationResult)] =
        [
            ".ctor(OpenLocally.PlatformPreparationOutcome, OpenLocally.SocialPreparationDiagnostic)",
            "method static OpenLocally.PlatformPreparationResult AuthenticationRequired()",
            "method static OpenLocally.PlatformPreparationResult Failed(OpenLocally.SocialPreparationDiagnostic)",
            "method static OpenLocally.PlatformPreparationResult Prepared()",
            "property OpenLocally.PlatformPreparationOutcome Outcome { get; set; }",
            "property OpenLocally.SocialPreparationDiagnostic Diagnostic { get; set; }",
        ],
        [typeof(SocialPreparationDiagnostic)] =
        [
            ".ctor(System.String, System.String, System.String)",
            "field System.Int32 MaximumMessageLength",
            "field System.Int32 MaximumSerializedLength",
            "method System.Void CaptureCleanup(System.Exception, System.Boolean)",
            "method System.Void CapturePrimary(System.Exception, System.Boolean)",
            "method System.Void Checkpoint(System.String, System.Nullable<System.Boolean>)",
            "method System.String FormatForDisplay()",
            "method static System.String SanitizeMessage(System.String)",
            "method System.String Serialize()",
            "method System.Void SetCorrelation(System.Nullable<System.Int32>, System.Nullable<System.Int32>)",
            "method System.Void SetPhase(System.String)",
            "method System.Void SetReportingFailure(System.String, System.Exception, System.Boolean)",
            "method System.Void SetStableCode(System.String)",
            "method System.Void TargetState(System.String, System.Nullable<System.Boolean>)",
            "property OpenLocally.PatreonCreateResolutionEvidence CreateResolution { get; }",
            "property System.Nullable<System.Int32> Attempt { get; }",
            "property System.Nullable<System.Int32> CdpCode { get; }",
            "property System.Nullable<System.Int32> ReleaseId { get; }",
            "property System.String Adapter { get; }",
            "property System.String CdpMessage { get; }",
            "property System.String CdpOperation { get; }",
            "property System.String CleanupErrorClass { get; }",
            "property System.String ErrorClass { get; }",
            "property System.String Phase { get; }",
            "property System.String Platform { get; }",
            "property System.String ReportingErrorClass { get; }",
            "property System.String ReportingFailure { get; }",
            "property System.String StableCode { get; }",
        ],
        [typeof(PatreonCreateResolutionEvidence)] =
        [
            "field System.Int32 CandidateLimit",
            "property System.Nullable<OpenLocally.PatreonCreateResolutionOutcome> Outcome { get; }",
            "property System.Nullable<System.Int32> CandidateCount { get; }",
            "property System.Nullable<System.Int32> InspectedCount { get; }",
            "property System.Nullable<System.Int32> LayoutRejectedCount { get; }",
            "property System.Nullable<System.Int32> UsableCount { get; }",
            "property System.Boolean Complete { get; }",
            "property System.Boolean LimitExceeded { get; }",
        ],
        [typeof(PatreonCreateResolutionOutcome)] =
        [
            "field OpenLocally.PatreonCreateResolutionOutcome Ambiguous",
            "field OpenLocally.PatreonCreateResolutionOutcome CandidateLimitExceeded",
            "field OpenLocally.PatreonCreateResolutionOutcome InvalidCandidateIdentity",
            "field OpenLocally.PatreonCreateResolutionOutcome MalformedDescription",
            "field OpenLocally.PatreonCreateResolutionOutcome MalformedGeometry",
            "field OpenLocally.PatreonCreateResolutionOutcome MalformedQuery",
            "field OpenLocally.PatreonCreateResolutionOutcome NoUsableCandidate",
            "field OpenLocally.PatreonCreateResolutionOutcome RootUnavailable",
            "field OpenLocally.PatreonCreateResolutionOutcome StaleDescription",
            "field OpenLocally.PatreonCreateResolutionOutcome UniqueCandidate",
            "field OpenLocally.PatreonCreateResolutionOutcome ZeroMatches",
        ],
        [typeof(BrowserPreparationTargets)] =
        [
            "method System.Threading.Tasks.Task<OpenLocally.BrowserPreparationSession> AttachAsync(System.String, System.Nullable<System.TimeSpan>, System.Threading.CancellationToken)",
            "method System.Threading.Tasks.Task<OpenLocally.BrowserPreparationSession> CreateOwnedAsync(System.Nullable<System.TimeSpan>, System.Threading.CancellationToken)",
            "method System.Threading.Tasks.Task<System.Collections.Generic.IReadOnlyList<OpenLocally.CdpTargetInfo>> GetPreparatablePagesAsync(System.Nullable<System.TimeSpan>, System.Threading.CancellationToken)",
        ],
        [typeof(BrowserPreparationSession)] =
        [
            "field System.TimeSpan DefaultReadinessTimeout",
            "method System.Threading.Tasks.Task ActivateAsync(OpenLocally.BrowserDomNode, System.Threading.CancellationToken)",
            "method System.Threading.Tasks.Task CloseOwnedTargetAsync(System.Nullable<System.TimeSpan>, System.Threading.CancellationToken)",
            "method System.Threading.Tasks.Task<OpenLocally.BrowserDomNode> FindNodeAsync(System.String, System.Threading.CancellationToken)",
            "method System.Threading.Tasks.Task<OpenLocally.BrowserDomNode> WaitForDocumentAsync(System.Nullable<System.TimeSpan>, System.Threading.CancellationToken)",
            "method System.Threading.Tasks.Task<OpenLocally.BrowserDomNode> WaitForNodeAsync(System.String, System.Nullable<System.TimeSpan>, System.Threading.CancellationToken)",
            "method System.Threading.Tasks.Task<OpenLocally.BrowserNavigationResult> NavigateAsync(System.String, System.Nullable<System.TimeSpan>, System.Threading.CancellationToken)",
            "method System.Threading.Tasks.Task<OpenLocally.BrowserTextVerification> VerifyTextAsync(OpenLocally.BrowserDomNode, System.String, System.Threading.CancellationToken)",
            "method System.Threading.Tasks.Task<OpenLocally.CdpBrowserVersion> GetBrowserVersionAsync(System.Nullable<System.TimeSpan>, System.Threading.CancellationToken)",
            "method System.Threading.Tasks.Task FocusAsync(OpenLocally.BrowserDomNode, System.Threading.CancellationToken)",
            "method System.Threading.Tasks.Task RelinquishOwnedTargetAsync(System.Nullable<System.TimeSpan>, System.Threading.CancellationToken)",
            "method System.Threading.Tasks.Task ReplaceTextAsync(OpenLocally.BrowserDomNode, System.String, System.Threading.CancellationToken)",
            "method System.Threading.Tasks.Task SetFileInputFilesAsync(OpenLocally.BrowserDomNode, System.Collections.Generic.IReadOnlyList<System.String>, System.Threading.CancellationToken)",
            "method System.Threading.Tasks.ValueTask DisposeAsync()",
            "property System.Boolean OwnsTarget { get; }",
            "property System.String TargetId { get; }",
        ],
        [typeof(BrowserTextEditor)] =
        [
            ".ctor(OpenLocally.BrowserPreparationSession)",
            "method System.Threading.Tasks.Task ReplaceAsync(OpenLocally.BrowserDomNode, System.String, System.Threading.CancellationToken)",
            "method System.Threading.Tasks.Task<OpenLocally.BrowserDomNode> FindAsync(System.String, System.Threading.CancellationToken)",
            "method System.Threading.Tasks.Task<OpenLocally.BrowserTextVerification> VerifyAsync(OpenLocally.BrowserDomNode, System.String, System.Threading.CancellationToken)",
        ],
        [typeof(BrowserFileChooser)] =
        [
            ".ctor(OpenLocally.BrowserPreparationSession)",
            "field System.TimeSpan DefaultTimeout",
            "method System.Threading.Tasks.Task AttachFilesAsync(System.Collections.Generic.IReadOnlyList<System.String>, System.Func<System.Threading.CancellationToken, System.Threading.Tasks.Task>, System.Int64, System.Nullable<System.TimeSpan>, System.Threading.CancellationToken)",
            "method System.Threading.Tasks.Task AttachTransientFilesAsync(System.Collections.Generic.IReadOnlyList<System.String>, System.String, System.Func<System.Threading.CancellationToken, System.Threading.Tasks.Task>, System.Nullable<System.TimeSpan>, System.Threading.CancellationToken)",
        ],
        [typeof(BrowserTargetSelector)] =
        [
            "method static System.Boolean IsPreparatablePage(OpenLocally.CdpTargetInfo)",
            "method static System.Collections.Generic.IReadOnlyList<OpenLocally.CdpTargetInfo> FilterPreparatablePages(System.Collections.Generic.IEnumerable<OpenLocally.CdpTargetInfo>)",
        ],
        [typeof(CdpTargetInfo)] =
        [
            ".ctor(System.String, System.String, System.String, System.String, System.Boolean)",
            "property System.Boolean Attached { get; set; }",
            "property System.String TargetId { get; set; }",
            "property System.String Title { get; set; }",
            "property System.String Type { get; set; }",
            "property System.String Url { get; set; }",
        ],
        [typeof(CdpBrowserVersion)] =
        [
            ".ctor(System.String, System.String, System.String)",
            "property System.String Product { get; set; }",
            "property System.String ProtocolVersion { get; set; }",
            "property System.String UserAgent { get; set; }",
        ],
        [typeof(BrowserDomNode)] =
        [
            "property System.Int64 BackendNodeId { get; }",
            "property System.Int32 NodeId { get; }",
            "property System.String NodeName { get; }",
        ],
        [typeof(BrowserNavigationResult)] =
        [
            ".ctor(System.String)",
            "property System.String FrameId { get; set; }",
        ],
        [typeof(BrowserTextVerification)] =
        [
            "field OpenLocally.BrowserTextVerification Match",
            "field OpenLocally.BrowserTextVerification Mismatch",
            "field OpenLocally.BrowserTextVerification NodeDisappeared",
            "field OpenLocally.BrowserTextVerification UnsupportedReadback",
        ],
        [typeof(SocialPreparationProgress)] =
        [
            "field OpenLocally.SocialPreparationProgress Preparing",
            "field OpenLocally.SocialPreparationProgress Uploading",
        ],
        [typeof(PlatformPreparationOutcome)] =
        [
            "field OpenLocally.PlatformPreparationOutcome AuthenticationRequired",
            "field OpenLocally.PlatformPreparationOutcome Failed",
            "field OpenLocally.PlatformPreparationOutcome Prepared",
        ],
    };

    private static readonly Type[] ForbiddenLowLevelTypes =
    [
        typeof(CdpSession), typeof(CdpTransport), typeof(CdpTargetManager),
        typeof(IWebSocketConnection), typeof(ClientWebSocketConnection),
    ];
    private static readonly string[] PublicationTerms = ["submit", "publish", "post", "confirmpublished", "clicksubmit", "finalize"];

    [Fact]
    public void BrowserPreparationSurface_RecursivelyMatchesExpectedReachableTypes()
    {
        IReadOnlySet<Type> reachable = DiscoverReachableProjectTypes();
        string[] actualNames = reachable.Select(TypeName).OrderBy(name => name, StringComparer.Ordinal).ToArray();

        Assert.Equal(ExpectedReachableTypeNames, actualNames);
        Assert.Equal(ExpectedReachableTypeNames, ExpectedMembers.Keys.Select(TypeName).OrderBy(name => name, StringComparer.Ordinal).ToArray());
        Assert.All(
            new[] { typeof(CdpTargetInfo), typeof(CdpBrowserVersion), typeof(BrowserDomNode), typeof(BrowserNavigationResult) },
            type => Assert.Contains(type, reachable));
    }

    [Fact]
    public void BrowserPreparationSurface_SnapshotsEveryReachablePublicMemberAndConstructor()
    {
        IReadOnlySet<Type> reachable = DiscoverReachableProjectTypes();
        foreach (Type type in reachable)
        {
            string[] expected = ExpectedMembers[type].OrderBy(member => member, StringComparer.Ordinal).ToArray();
            string[] actual = PublicSurfaceMembers(type).OrderBy(member => member, StringComparer.Ordinal).ToArray();
            Assert.True(
                expected.SequenceEqual(actual),
                $"{type.FullName} has an unexpected public preparation surface.{Environment.NewLine}" +
                $"Expected:{Environment.NewLine}{string.Join(Environment.NewLine, expected)}{Environment.NewLine}" +
                $"Actual:{Environment.NewLine}{string.Join(Environment.NewLine, actual)}");
            foreach (System.Reflection.ConstructorInfo constructor in type.GetConstructors(PublicDeclared))
            {
                Assert.Contains(Describe(constructor), expected);
            }
        }
    }

    [Fact]
    public void BrowserPreparationSurface_TraversesProjectTypesThroughFrameworkWrappers()
    {
        var discovered = new HashSet<Type>();
        AddProjectTypesInShape(typeof(Task<IReadOnlyList<CdpTargetInfo>>), discovered, new Queue<Type>());

        Assert.Contains(typeof(CdpTargetInfo), discovered);
    }

    [Fact]
    public void BrowserPreparationSurface_DoesNotReachLowLevelCapabilities() =>
        Assert.DoesNotContain(ForbiddenLowLevelTypes, DiscoverReachableProjectTypes().Contains);

    [Fact]
    public void BrowserPreparationSurface_RemainsPreparationOnly()
    {
        Assert.DoesNotContain(
            DiscoverReachableProjectTypes().SelectMany(PublicSurfaceMemberNames),
            name => PublicationTerms.Any(term => name.Contains(term, StringComparison.OrdinalIgnoreCase)));
        Assert.Equal(
            new[] { typeof(ISocialPreparationAdapter), typeof(IAsyncDisposable) }.OrderBy(type => type.FullName),
            typeof(FixturePreparationAdapter).GetInterfaces().OrderBy(type => type.FullName));
        Assert.DoesNotContain(
            PublicSurfaceMemberNames(typeof(FixturePreparationAdapter)),
            name => PublicationTerms.Any(term => name.Contains(term, StringComparison.OrdinalIgnoreCase)));
    }

    private static IReadOnlySet<Type> DiscoverReachableProjectTypes()
    {
        var reachable = new HashSet<Type>();
        var queue = new Queue<Type>();
        foreach (Type root in AdapterContractRoots.Concat(BoundedBrowserRoots))
        {
            AddProjectTypesInShape(root, reachable, queue);
        }
        while (queue.Count > 0)
        {
            foreach (Type surfaceType in PublicSurfaceTypes(queue.Dequeue()))
            {
                AddProjectTypesInShape(surfaceType, reachable, queue);
            }
        }
        return reachable;
    }

    private static IEnumerable<Type> PublicSurfaceTypes(Type type) =>
        type.GetConstructors(PublicDeclared)
            .SelectMany(constructor => constructor.GetParameters().Select(parameter => parameter.ParameterType))
            .Concat(type.GetMethods(PublicDeclared).Where(method => !IsRuntimeMethod(method))
                .SelectMany(method => method.GetParameters().Select(parameter => parameter.ParameterType).Append(method.ReturnType)))
            .Concat(type.GetProperties(PublicDeclared).Select(property => property.PropertyType))
            .Concat(type.GetFields(PublicDeclared).Where(IsSurfaceField).Select(field => field.FieldType))
            .Concat(type.GetEvents(PublicDeclared).Select(@event => @event.EventHandlerType!))
            .Concat(type.BaseType is Type baseType ? new[] { baseType } : Array.Empty<Type>())
            .Concat(type.GetInterfaces());

    private static void AddProjectTypesInShape(Type? type, ISet<Type> discovered, Queue<Type> queue)
    {
        if (type is null || type.IsGenericParameter) return;
        if (type.IsByRef || type.IsPointer || type.IsArray)
        {
            AddProjectTypesInShape(type.GetElementType(), discovered, queue);
            return;
        }
        if (IsProjectOwnedPublic(type) && discovered.Add(type))
        {
            queue.Enqueue(type);
        }
        if (type.IsGenericType)
        {
            foreach (Type argument in type.GetGenericArguments())
            {
                AddProjectTypesInShape(argument, discovered, queue);
            }
        }
    }

    private static bool IsProjectOwnedPublic(Type type) =>
        type.Assembly == ProductionAssembly && (type.IsPublic || type.IsNestedPublic);

    private static bool IsSurfaceField(System.Reflection.FieldInfo field) => !field.IsSpecialName;

    private static IEnumerable<string> PublicSurfaceMembers(Type type) =>
        type.GetConstructors(PublicDeclared).Select(Describe)
            .Concat(type.GetMethods(PublicDeclared).Where(method => !IsRuntimeMethod(method) && !method.IsSpecialName).Select(Describe))
            .Concat(type.GetProperties(PublicDeclared).Select(Describe))
            .Concat(type.GetFields(PublicDeclared).Where(IsSurfaceField).Select(Describe))
            .Concat(type.GetEvents(PublicDeclared).Select(Describe));

    private static IEnumerable<string> PublicSurfaceMemberNames(Type type) =>
        type.GetConstructors(PublicDeclared).Select(_ => ".ctor")
            .Concat(type.GetMethods(PublicDeclared).Where(method => !IsRuntimeMethod(method) && !method.IsSpecialName).Select(method => method.Name))
            .Concat(type.GetProperties(PublicDeclared).Select(property => property.Name))
            .Concat(type.GetFields(PublicDeclared).Where(IsSurfaceField).Select(field => field.Name))
            .Concat(type.GetEvents(PublicDeclared).Select(@event => @event.Name));

    private static bool IsRuntimeMethod(System.Reflection.MethodInfo method) =>
        method.Name is "ToString" or "GetHashCode" or "Deconstruct" or "<Clone>$" ||
        (method.Name == "Equals" && method.GetParameters().Length == 1) ||
        method.Name is "op_Equality" or "op_Inequality";

    private static string Describe(System.Reflection.ConstructorInfo constructor) =>
        $".ctor({string.Join(", ", constructor.GetParameters().Select(parameter => TypeName(parameter.ParameterType)))})";

    private static string Describe(System.Reflection.MethodInfo method) =>
        $"method {(method.IsStatic ? "static " : string.Empty)}{TypeName(method.ReturnType)} {method.Name}({string.Join(", ", method.GetParameters().Select(parameter => TypeName(parameter.ParameterType)))})";

    private static string Describe(System.Reflection.PropertyInfo property)
    {
        string accessors = string.Join(" ", new[]
        {
            property.GetMethod?.IsPublic == true ? "get;" : null,
            property.SetMethod?.IsPublic == true ? "set;" : null,
        }.Where(accessor => accessor is not null));
        return $"property {TypeName(property.PropertyType)} {property.Name} {{ {accessors} }}";
    }

    private static string Describe(System.Reflection.FieldInfo field) => $"field {TypeName(field.FieldType)} {field.Name}";
    private static string Describe(System.Reflection.EventInfo @event) => $"event {TypeName(@event.EventHandlerType!)} {@event.Name}";

    private static string TypeName(Type type)
    {
        if (type.IsByRef) return $"{TypeName(type.GetElementType()!)}&";
        if (type.IsPointer) return $"{TypeName(type.GetElementType()!)}*";
        if (type.IsArray) return $"{TypeName(type.GetElementType()!)}[]";
        if (!type.IsGenericType) return type.FullName ?? type.Name;
        string name = type.GetGenericTypeDefinition().FullName!;
        return $"{name[..name.IndexOf('`')]}<{string.Join(", ", type.GetGenericArguments().Select(TypeName))}>";
    }
}
