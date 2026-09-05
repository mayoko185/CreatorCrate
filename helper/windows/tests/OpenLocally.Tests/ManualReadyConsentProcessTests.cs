using System.Diagnostics;
using System.Text.Json;
using OpenLocally;

namespace OpenLocally.Tests;

// Loaded into a spawned PowerShell 7 process by the deterministic transport tests.
// No apphost, platform input, socket, or real discovery is used by this probe.
public static class ReadyConsentProcessProbe
{
    public static void Run(string directory, string id, string localDecision)
    {
        var local = new ProbeLocal(directory, Enum.Parse<ChromeConnectionConsentDecision>(localDecision));
        var consent = new ManualReadyConsent(local, directory, id, TimeSpan.FromSeconds(2));
        var observed = new ObservedConsent(consent);
        int discoveries = 0;
        using var finished = new CancellationTokenSource();
        var connection = new ChromeConnection(() => throw new Exception("Socket must be unreachable"), TimeSpan.FromSeconds(1));
        try
        {
            var workflow = new ChromeConnectionWorkflow(() =>
            {
                discoveries++;
                return ChromeDiscoveryResult.Fail("offline_sentinel");
            }, connection, observed);
            workflow.ConnectAsync(finished.Token).GetAwaiter().GetResult();
            File.WriteAllText(Path.Combine(directory, "result.json"), JsonSerializer.Serialize(new
            {
                Discoveries = discoveries, consent.Requested, consent.Accepted,
                Decision = observed.Decision.ToString(),
                Replay = consent.ConfirmReady().ToString()
            }));
        }
        finally { connection.DisposeAsync().AsTask().GetAwaiter().GetResult(); }
    }

    public static string? Present(Process child, string directory, string id, string scenario)
        => ManualReadyConsentParent.TryPresent(child, directory, id, _ =>
        {
            File.AppendAllText(Path.Combine(directory, "presentations"), "1");
            if (scenario == "presentation_throw") throw new InvalidOperationException("private_exception_secret");
            return scenario == "Cancel" ? ChromeConnectionConsentDecision.Cancel :
                scenario == "DisplayFailed" ? ChromeConnectionConsentDecision.DisplayFailed : ChromeConnectionConsentDecision.Continue;
        });

    private sealed class ObservedConsent(IChromeConnectionConsent inner) : IChromeConnectionConsent
    {
        public ChromeConnectionConsentDecision Decision { get; private set; }
        public ChromeConnectionConsentDecision ConfirmReady() => Decision = inner.ConfirmReady();
        public ChromeConnectionConsentDecision ConfirmRetry(string code) => inner.ConfirmRetry(code);
    }

    private sealed class ProbeLocal(string directory, ChromeConnectionConsentDecision decision) : IChromeConnectionConsent
    {
        public ChromeConnectionConsentDecision ConfirmReady()
        {
            File.WriteAllText(Path.Combine(directory, "local-ended"), "yes");
            return decision;
        }
        public ChromeConnectionConsentDecision ConfirmRetry(string code) => ChromeConnectionConsentDecision.Cancel;
    }
}

public class ManualReadyConsentProcessTests
{
    [Theory]
    [InlineData("Continue", true, "Continue", 1, "")]
    [InlineData("Cancel", true, "Cancel", 0, "")]
    [InlineData("DisplayFailed", true, "DisplayFailed", 0, "")]
    [InlineData("presentation_throw", true, "DisplayFailed", 0, "")]
    [InlineData("ready_member", true, "DisplayFailed", 0, "presentation_result")]
    [InlineData("type_resolution", true, "DisplayFailed", 0, "presentation")]
    [InlineData("publication_failure", false, "DisplayFailed", 0, "response_publication")]
    public async Task RealHarnessCoordinatesChildAndContainsReadyFailures(string scenario, bool accepted, string decision, int discoveries, string reason)
    {
        string root = PublishedProductionGateProcessTests.FindRepositoryRoot();
        string directory = Path.Combine(Path.GetTempPath(), "CreatorCrate-ready-harness-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(directory);
        try
        {
            string script = Path.Combine(directory, "parent.ps1");
            File.WriteAllText(script, """
                param($Repository,$Production,$Tests,$Root,$Scenario)
                $ErrorActionPreference = 'Stop'
                if ($Scenario -ne 'type_resolution') {
                    Add-Type -Path $Production
                    Add-Type -Path $Tests
                }
                $tokens=$null; $errors=$null
                $harness=Join-Path $Repository 'helper/windows/tests/OpenLocally.Tests/Manual/run-m2-foundation.ps1'
                $ast=[Management.Automation.Language.Parser]::ParseFile($harness,[ref]$tokens,[ref]$errors)
                if ($errors.Count) { throw 'Harness parse failure' }
                # Load actual harness functions without executing any manual/live mode.
                foreach ($fn in $ast.FindAll({param($n) $n -is [Management.Automation.Language.FunctionDefinitionAst]},$false)) {
                    Set-Item -Path ('function:' + $fn.Name) -Value $fn.Body.GetScriptBlock()
                }
                $env:CREATORCRATE_M2_MANUAL='1'
                $script:ManualChildExitUnconfirmed=$false
                $script:ManualFailureDialogAttempted=$false
                $script:ManualAuthoritativeExitCode=$null
                $script:OfflineNativePresent={ throw 'No native failure dialog expected' }
                $child=Join-Path $Root 'child.ps1'
                [IO.File]::WriteAllText($child, @'
                param($Production,$Tests)
                $ErrorActionPreference='Stop'
                Add-Type -Path $Production
                Add-Type -Path $Tests
                [OpenLocally.Tests.ReadyConsentProcessProbe]::Run($env:CREATORCRATE_M2_READY_DIRECTORY,$env:CREATORCRATE_M2_READY_ID,'DisplayFailed')
                '@)
                $script:publicationAttempts=0
                $presentReady = if ($Scenario -eq 'type_resolution') { $null } else { {
                    param($childProcess,$readyDirectory,$id)
                    $script:readyDirectory=$readyDirectory
                    $script:readyId=$id
                    [OpenLocally.Tests.ReadyConsentProcessProbe]::Present($childProcess,$readyDirectory,$id,$Scenario)
                } }
                $childHost = if ($env:CREATORCRATE_TEST_PWSH) { $env:CREATORCRATE_TEST_PWSH } else { (Get-Command pwsh.exe).Source }
                $result=Invoke-ParentProductionGatePreflight -Helper $childHost -WorkingDirectory $Root -ContextPath (Join-Path $Root 'context.json') -DiagnosticUri unused -LogicalArguments @('-NoProfile','-File',$child,$Production,$Tests) -TimeoutMilliseconds 15000 -TerminatorTimeoutMilliseconds 1000 -ChildCleanupTimeoutMilliseconds 1000 -CaptureResult -CapturePath (Join-Path $Root 'capture.txt') -ReadyConsentAssembly $Production -RepositoryRoot $Repository -PresentReady $presentReady -BeforeHarnessOperation {
                    param($operation)
                    if ($operation -eq 'ready_presentation_result' -and $Scenario -eq 'ready_member') {
                        # Exact formerly unguarded operation: parent type/member resolution.
                        [CreatorCrateOfflineMissingReadyType]::LastPresentation
                    }
                    if ($operation -eq 'ready_response_publication') {
                        $script:publicationAttempts++
                        if ($Scenario -eq 'type_resolution') {
                            $script:readyDirectory=(Get-ChildItem -LiteralPath $Root -Directory -Filter 'ready-*').FullName
                            $script:readyId=(Split-Path -Leaf $script:readyDirectory).Substring(6)
                        }
                        if ($Scenario -eq 'publication_failure') {
                            # Fail the real atomic move after its temporary write.
                            [void][IO.Directory]::CreateDirectory((Join-Path $script:readyDirectory ($script:readyId + '.json')))
                        }
                    }
                    if ($operation -eq 'cleanup' -and $script:ManualChildExitUnconfirmed) { throw 'Child ownership released early' }
                }
                if ($result.HarnessFailure -or -not $result.ChildExitConfirmed -or $script:ManualChildExitUnconfirmed) { throw ('Uncontrolled harness failure or unconfirmed child exit: ' + ($Error | Out-String) + ($result | ConvertTo-Json -Depth 8)) }
                if ($script:publicationAttempts -ne 1) { throw 'Duplicate response attempt' }
                if ($Scenario -ne 'type_resolution' -and [OpenLocally.Tests.ReadyConsentProcessProbe]::Present([Diagnostics.Process]::GetCurrentProcess(),$script:readyDirectory,$script:readyId,$Scenario)) { throw 'Request replay' }
                [IO.File]::WriteAllText((Join-Path $Root 'harness-result.json'),($result | ConvertTo-Json -Depth 8))
                """);
            var start = new ProcessStartInfo(scenario == "type_resolution" ? "powershell.exe" :
                Environment.GetEnvironmentVariable("CREATORCRATE_TEST_PWSH") ?? "pwsh.exe")
            { UseShellExecute = false, CreateNoWindow = true, RedirectStandardOutput = true, RedirectStandardError = true, WorkingDirectory = root };
            foreach (string argument in new[] { "-NoProfile", "-File", script, root, typeof(CommandDispatcher).Assembly.Location,
                typeof(ReadyConsentProcessProbe).Assembly.Location, directory, scenario }) start.ArgumentList.Add(argument);
            using Process parent = Process.Start(start)!;
            Task<string> stdout = parent.StandardOutput.ReadToEndAsync(), stderr = parent.StandardError.ReadToEndAsync();
            using var deadline = new CancellationTokenSource(TimeSpan.FromSeconds(40));
            try { await parent.WaitForExitAsync(deadline.Token); }
            finally { if (!parent.HasExited) { parent.Kill(entireProcessTree: true); await parent.WaitForExitAsync(); } }
            Assert.True(parent.ExitCode == 0, await stdout + await stderr);
            string ready = Assert.Single(Directory.GetDirectories(directory, "ready-*"));
            using var result = JsonDocument.Parse(File.ReadAllText(Path.Combine(ready, "result.json")));
            Assert.True(result.RootElement.GetProperty("Requested").GetBoolean());
            Assert.Equal(accepted, result.RootElement.GetProperty("Accepted").GetBoolean());
            Assert.Equal(decision, result.RootElement.GetProperty("Decision").GetString());
            Assert.Equal(discoveries, result.RootElement.GetProperty("Discoveries").GetInt32());
            Assert.Equal("DisplayFailed", result.RootElement.GetProperty("Replay").GetString());
            if (scenario == "type_resolution") Assert.False(File.Exists(Path.Combine(ready, "presentations")));
            else Assert.Equal("1", File.ReadAllText(Path.Combine(ready, "presentations")));
            Assert.Empty(Directory.GetFiles(ready, "*.tmp"));
            Assert.Equal(accepted ? 1 : 0, Directory.GetFiles(Path.Combine(ready, "consumed")).Length);
            string capture = File.ReadAllText(Path.Combine(directory, "capture.txt"));
            Assert.Contains("outcome=helper_completed", capture);
            Assert.DoesNotContain("Harness: state=timed_out", capture);
            Assert.DoesNotContain("=== HARNESS FAILURE ===", capture);
            Assert.DoesNotContain("private_exception_secret", capture);
            if (reason.Length > 0) Assert.Contains("Ready coordination: state=failed; reason=" + reason, capture);
        }
        finally { Directory.Delete(directory, recursive: true); }
    }

    [Theory]
    [InlineData("Continue", 1)]
    [InlineData("Cancel", 0)]
    [InlineData("DisplayFailed", 0)]
    [InlineData("missing", 0)]
    [InlineData("malformed", 0)]
    [InlineData("mismatch", 0)]
    [InlineData("unknown", 0)]
    [InlineData("stale", 0)]
    [InlineData("replayed", 0)]
    public async Task SpawnedChildWaitsForOneExactResponseBeforeDiscoverySentinel(string answer, int expected)
    {
        using var run = new ProbeRun();
        if (answer == "stale") File.WriteAllText(run.Response, "{}");
        if (answer == "replayed")
        {
            Directory.CreateDirectory(Path.Combine(run.Directory, "consumed"));
            File.WriteAllText(Path.Combine(run.Directory, "consumed", run.Id + ".json"), "{}");
        }
        run.Start("DisplayFailed");
        if (answer is not ("stale" or "replayed"))
        {
            await run.WaitForRequest();
            Assert.True(File.Exists(Path.Combine(run.Directory, "local-ended")));
            Assert.False(File.Exists(Path.Combine(run.Directory, "result.json")));
            Assert.False(run.Child!.HasExited);
            if (answer != "missing")
            {
                string body = answer == "malformed" ? "{" : JsonSerializer.Serialize(new
                {
                    RequestId = answer == "mismatch" ? Guid.NewGuid().ToString("N") : run.Id,
                    Answer = answer == "unknown" ? "yes" : answer
                });
                string temp = run.Response + ".tmp";
                File.WriteAllText(temp, body);
                File.Move(temp, run.Response);
            }
        }
        await run.WaitForExit();
        using var result = JsonDocument.Parse(File.ReadAllText(Path.Combine(run.Directory, "result.json")));
        Assert.Equal(expected, result.RootElement.GetProperty("Discoveries").GetInt32());
        Assert.Equal("DisplayFailed", result.RootElement.GetProperty("Replay").GetString());
        Assert.Equal(answer is "Continue" or "Cancel" or "DisplayFailed", result.RootElement.GetProperty("Accepted").GetBoolean());
    }

    [Theory]
    [InlineData("Continue", 1)]
    [InlineData("Cancel", 0)]
    public async Task LocalSuccessNeverRequestsParent(string decision, int expected)
    {
        using var run = new ProbeRun();
        run.Start(decision);
        await run.WaitForExit();
        Assert.False(File.Exists(Path.Combine(run.Directory, "request.json")));
        using var result = JsonDocument.Parse(File.ReadAllText(Path.Combine(run.Directory, "result.json")));
        Assert.False(result.RootElement.GetProperty("Requested").GetBoolean());
        Assert.Equal(expected, result.RootElement.GetProperty("Discoveries").GetInt32());
    }

    [Fact]
    public async Task ChildExitCancelsPendingParentAndCannotLeaveResponseOrReplay()
    {
        using var run = new ProbeRun();
        run.Start("DisplayFailed");
        await run.WaitForRequest();
        int presentations = 0;
        string? response = ManualReadyConsentParent.TryPresent(run.Child!, run.Directory, run.Id, cancellation =>
        {
            presentations++;
            run.Child!.Kill();
            Assert.True(cancellation.WaitHandle.WaitOne(TimeSpan.FromSeconds(5)));
            return ChromeConnectionConsentDecision.Continue;
        });
        Assert.Null(response);
        Assert.Null(ManualReadyConsentParent.TryPresent(run.Child!, run.Directory, run.Id, _ => throw new Exception("No replay")));
        Assert.Equal(1, presentations);
        Assert.False(File.Exists(run.Response));
    }

    [Theory]
    [InlineData(ChromeConnectionConsentDecision.Continue)]
    [InlineData(ChromeConnectionConsentDecision.Cancel)]
    [InlineData(ChromeConnectionConsentDecision.DisplayFailed)]
    public async Task ParentPresentsAtMostOnceAfterLocalAttemptEnded(ChromeConnectionConsentDecision decision)
    {
        using var run = new ProbeRun();
        run.Start("DisplayFailed");
        await run.WaitForRequest();
        int calls = 0;
        var response = ManualReadyConsentParent.TryPresent(run.Child!, run.Directory, run.Id, _ =>
        {
            Assert.True(File.Exists(Path.Combine(run.Directory, "local-ended")));
            calls++;
            return decision;
        });
        Assert.Equal(decision.ToString(), response);
        Assert.Null(ManualReadyConsentParent.TryPresent(run.Child!, run.Directory, run.Id, _ => throw new Exception("Duplicate UI")));
        File.WriteAllText(run.Response + ".tmp", JsonSerializer.Serialize(new { RequestId = run.Id, Answer = response }));
        File.Move(run.Response + ".tmp", run.Response);
        await run.WaitForExit();
        Assert.Equal(1, calls);
        using var result = JsonDocument.Parse(File.ReadAllText(Path.Combine(run.Directory, "result.json")));
        Assert.Equal(decision == ChromeConnectionConsentDecision.Continue ? 1 : 0, result.RootElement.GetProperty("Discoveries").GetInt32());
    }

    private sealed class ProbeRun : IDisposable
    {
        public string Directory { get; } = Path.Combine(Path.GetTempPath(), "CreatorCrate-ready-test-" + Guid.NewGuid().ToString("N"));
        public string Id { get; } = Guid.NewGuid().ToString("N");
        public Process? Child { get; private set; }
        public string Response => Path.Combine(Directory, Id + ".json");
        private Task<string>? stderr;
        private Task<string>? stdout;
        public ProbeRun() { System.IO.Directory.CreateDirectory(Directory); }
        public void Start(string decision)
        {
            string script = Path.Combine(Directory, "probe.ps1");
            File.WriteAllText(script, "param($Production,$Tests,$Directory,$Id,$Decision)\n$ErrorActionPreference='Stop'\nAdd-Type -Path $Production\nAdd-Type -Path $Tests\n[OpenLocally.Tests.ReadyConsentProcessProbe]::Run($Directory,$Id,$Decision)\n");
            var info = new ProcessStartInfo(Environment.GetEnvironmentVariable("CREATORCRATE_TEST_PWSH") ?? "pwsh.exe")
            { UseShellExecute = false, CreateNoWindow = true, RedirectStandardError = true, RedirectStandardOutput = true, WorkingDirectory = Directory };
            foreach (var argument in new[] { "-NoProfile", "-File", script, typeof(CommandDispatcher).Assembly.Location,
                typeof(ReadyConsentProcessProbe).Assembly.Location, Directory, Id, decision }) info.ArgumentList.Add(argument);
            Child = Process.Start(info)!;
            stdout = Child.StandardOutput.ReadToEndAsync();
            stderr = Child.StandardError.ReadToEndAsync();
        }
        public async Task WaitForRequest()
        {
            using var deadline = new CancellationTokenSource(TimeSpan.FromSeconds(15));
            while (!File.Exists(Path.Combine(Directory, "request.json")))
            {
                if (Child!.HasExited) Assert.Fail(await stderr!);
                await Task.Delay(20, deadline.Token);
            }
        }
        public async Task WaitForExit()
        {
            using var deadline = new CancellationTokenSource(TimeSpan.FromSeconds(15));
            await Child!.WaitForExitAsync(deadline.Token);
            Assert.True(Child.ExitCode == 0, await stderr!);
            await stdout!;
        }
        public void Dispose()
        {
            if (Child is not null) { if (!Child.HasExited) { Child.Kill(); Child.WaitForExit(); } Child.Dispose(); }
            System.IO.Directory.Delete(Directory, true);
        }
    }
}
