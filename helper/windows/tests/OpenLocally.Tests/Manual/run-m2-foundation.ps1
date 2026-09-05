[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [ValidateNotNullOrEmpty()]
    [string]$RepositoryRoot,

    [string]$RecoverFrom,

    [switch]$VerifyEventStreamReader,

    [switch]$VerifyTokenDiagnostics,

    [switch]$VerifyNativeAppHostPreflight,

    [switch]$VerifyProcessStartInfoArguments,

    [switch]$VerifyDiagnosticSocialUri,

    [switch]$VerifyOperatorResponseChannel,

    [switch]$VerifyOperatorInputDeadline,

    [switch]$VerifyBoundedWorkflowWrapper,

    [switch]$RunPatreonManualValidation,

    [string]$CapturePath,

    [switch]$VerifyHelperOutputCapture,

    [switch]$VerifyManualFailureRouting,
    [string]$VerifyDurableHarnessFailure,
    [ValidateSet('combined', 'helper_only', 'harness_only', 'missing', 'presenter_failed')]
    [string]$VerifyFullDetailFailure,
    [string]$OfflineReportDirectory,
    [ValidateSet(0, 23)][int]$VerifyPublicationExit = 0,
    [switch]$VerifyPublicationContract,
    [ValidateSet('capture_confirmed', 'capture_failed', 'timeout_confirmed', 'timeout_failed', 'timeout_killed', 'late_failed', 'late_confirmed', 'late_missing', 'late_malformed', 'late_capture_failed')]
    [string]$VerifyManualCoordinationDefects,

    [switch]$VerifyManualFailureDialog,

    [switch]$VerifyPublishedManualPresentation,
    [switch]$VerifyPublishedManualDesktop,
    [switch]$VerifyReadyConsent,

    # Offline process-exit regression only; never publishes or launches the production helper.
    [switch]$VerifyManualFailureFullFlow,
    [ValidateSet(0, 17)][int]$OfflineHelperExitCode = 17,
    [switch]$OfflinePresentationFails,
    [switch]$OfflineCleanupFails,
    [ValidateSet('comparison', 'no_result')][string]$OfflinePostHelperFailure
)

$ErrorActionPreference = 'Stop'
$ManualWorkspacePrefix = 'CreatorCrate-m2-manual-'
$ManualCleanupRetryWindowSeconds = 8
$ManualCleanupRetryDelayMilliseconds = 200
$ManualWorkflowChildCleanupTimeoutMilliseconds = 5000
$ManualWorkflowTerminatorTimeoutMilliseconds = 3000
$ManualWorkflowControlledFailureExitGraceTimeoutMilliseconds = 15000
# The helper may wait five minutes for an operator to approve the Chrome Remote Debugging prompt.
# Keep the outer preflight alive long enough to collect the helper's terminal result.
$ParentProductionGateApprovalTimeoutMilliseconds = 330000
$script:ManualFailureDialogAttempted = $false
$script:ManualAuthoritativeExitCode = $null
$script:ManualFailureBoundaryActive = $false
$script:ManualFailurePlatform = 'social_preparation'
$script:OfflineNativePresent = $null
$script:ManualParentPresentation = $null
$script:ManualChildPresentation = $null
$script:ManualChildExitUnconfirmed = $false
$script:ManualDurableFailure = $null

function ConvertTo-WindowsCommandLineArgument {
    param([Parameter(Mandatory = $true)][AllowEmptyString()][string]$Argument)

    if ($Argument.Length -eq 0) { return '""' }
    if ($Argument -notmatch '[\s"]') { return $Argument }

    $builder = [Text.StringBuilder]::new()
    [void]$builder.Append('"')
    $backslashCount = 0

    foreach ($character in $Argument.ToCharArray()) {
        if ($character -eq '\') {
            $backslashCount += 1
            continue
        }

        if ($character -eq '"') {
            [void]$builder.Append(('\' * (($backslashCount * 2) + 1) -join ''))
            [void]$builder.Append('"')
            $backslashCount = 0
            continue
        }

        if ($backslashCount -gt 0) {
            [void]$builder.Append(('\' * $backslashCount -join ''))
            $backslashCount = 0
        }
        [void]$builder.Append($character)
    }

    if ($backslashCount -gt 0) {
        [void]$builder.Append(('\' * ($backslashCount * 2) -join ''))
    }
    [void]$builder.Append('"')
    return $builder.ToString()
}

function Join-WindowsCommandLineArguments {
    param([Parameter(Mandatory = $true)][AllowEmptyString()][string[]]$LogicalArguments)

    return (@($LogicalArguments | ForEach-Object {
        ConvertTo-WindowsCommandLineArgument -Argument $_
    }) -join ' ')
}

function Set-ManualProcessStartInfoArguments {
    param(
        [Parameter(Mandatory = $true)][System.Diagnostics.ProcessStartInfo]$StartInfo,
        [Parameter(Mandatory = $true)][AllowEmptyString()][string[]]$LogicalArguments
    )

    $StartInfo.Arguments = Join-WindowsCommandLineArguments -LogicalArguments $LogicalArguments
}

function Get-RegistrySnapshot {
    param([Parameter(Mandatory = $true)][string]$Path)

    if (-not (Test-Path -LiteralPath $Path)) {
        return [pscustomobject]@{ Captured = $true; Exists = $false; Values = @(); Children = @(); Name = $null }
    }

    $key = Get-Item -LiteralPath $Path
    $values = foreach ($name in $key.GetValueNames()) {
        [pscustomobject]@{
            Name = $name
            Value = $key.GetValue($name, $null, 'DoNotExpandEnvironmentNames')
            Kind = $key.GetValueKind($name).ToString()
        }
    }
    $children = foreach ($child in Get-ChildItem -LiteralPath $Path) {
        $snapshot = Get-RegistrySnapshot -Path $child.PSPath
        $snapshot.Name = $child.PSChildName
        $snapshot
    }

    [pscustomobject]@{
        Captured = $true
        Exists = $true
        Values = @($values)
        Children = @($children)
        Name = $key.PSChildName
    }
}

function Test-RegistrySnapshotIsValid {
    param([AllowNull()]$Snapshot)

    if ($null -eq $Snapshot) { return $false }

    $captured = $Snapshot.PSObject.Properties['Captured']
    $exists = $Snapshot.PSObject.Properties['Exists']
    $values = $Snapshot.PSObject.Properties['Values']
    $children = $Snapshot.PSObject.Properties['Children']
    if ($null -eq $captured -or $captured.Value -ne $true -or
        $null -eq $exists -or $null -eq $values -or $null -eq $children) {
        return $false
    }

    foreach ($child in @($children.Value)) {
        if (-not (Test-RegistrySnapshotIsValid -Snapshot $child)) { return $false }
    }

    return $true
}

function Restore-RegistrySnapshot {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [AllowNull()]$Snapshot
    )

    if (-not (Test-RegistrySnapshotIsValid -Snapshot $Snapshot)) {
        throw "Registry snapshot for '$Path' was not captured completely; the live key was left untouched."
    }

    if (Test-Path -LiteralPath $Path) { Remove-Item -LiteralPath $Path -Recurse -Force }
    if (-not $Snapshot.Exists) { return }

    New-Item -Path $Path -Force | Out-Null
    $key = Get-Item -LiteralPath $Path
    foreach ($value in @($Snapshot.Values)) {
        $key.SetValue($value.Name, $value.Value, [Microsoft.Win32.RegistryValueKind]::$($value.Kind))
    }
    foreach ($child in @($Snapshot.Children)) {
        Restore-RegistrySnapshot -Path (Join-Path $Path $child.Name) -Snapshot $child
    }
}

function Test-RegistrySnapshotMatches {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [AllowNull()]$Expected
    )

    if (-not (Test-RegistrySnapshotIsValid -Snapshot $Expected)) { return $false }

    try {
        $actual = Get-RegistrySnapshot -Path $Path
    }
    catch {
        return $false
    }

    if ($actual.Exists -ne $Expected.Exists) { return $false }
    if (-not $Expected.Exists) { return $true }

    $expectedValues = @($Expected.Values)
    $actualValues = @($actual.Values)
    if ($expectedValues.Count -ne $actualValues.Count) { return $false }
    foreach ($expectedValue in $expectedValues) {
        $matches = @($actualValues | Where-Object { $_.Name -ceq $expectedValue.Name })
        if ($matches.Count -ne 1) { return $false }
        $actualValue = $matches[0]
        if ($actualValue.Kind -cne $expectedValue.Kind) { return $false }
        if ((ConvertTo-Json -InputObject $actualValue.Value -Depth 20 -Compress) -cne
            (ConvertTo-Json -InputObject $expectedValue.Value -Depth 20 -Compress)) {
            return $false
        }
    }

    $expectedChildren = @($Expected.Children)
    $actualChildren = @($actual.Children)
    if ($expectedChildren.Count -ne $actualChildren.Count) { return $false }
    foreach ($expectedChild in $expectedChildren) {
        $matches = @($actualChildren | Where-Object { $_.Name -ieq $expectedChild.Name })
        if ($matches.Count -ne 1 -or -not (Test-RegistrySnapshotMatches -Path (Join-Path $Path $matches[0].Name) -Expected $expectedChild)) {
            return $false
        }
    }

    return $true
}

function Get-EnvironmentSnapshot {
    param([Parameter(Mandatory = $true)][string]$Name)

    if (Test-Path -LiteralPath "Env:$Name") {
        return [pscustomobject]@{ Exists = $true; Value = (Get-Item -LiteralPath "Env:$Name").Value }
    }

    return [pscustomobject]@{ Exists = $false; Value = $null }
}

function Restore-EnvironmentSnapshot {
    param(
        [Parameter(Mandatory = $true)][string]$Name,
        [Parameter(Mandatory = $true)]$Snapshot
    )

    if ($Snapshot.Exists) {
        Set-Item -LiteralPath "Env:$Name" -Value $Snapshot.Value
    }
    elseif (Test-Path -LiteralPath "Env:$Name") {
        Remove-Item -LiteralPath "Env:$Name" -ErrorAction Stop
    }
}

function New-RecoveryFailure {
    param(
        [Parameter(Mandatory = $true)][string]$Phase,
        [Parameter(Mandatory = $true)][string]$Target,
        [AllowNull()]$Snapshot,
        [Parameter(Mandatory = $true)][string]$Detail
    )

    [pscustomobject]@{
        Phase = $Phase
        Target = $Target
        OriginallyExisted = if (Test-RegistrySnapshotIsValid -Snapshot $Snapshot) { [bool]$Snapshot.Exists } else { $null }
        Detail = $Detail
    }
}

function Invoke-RegistryRestoration {
    param(
        [Parameter(Mandatory = $true)][string[]]$Paths,
        [Parameter(Mandatory = $true)][hashtable]$Snapshots,
        [Parameter(Mandatory = $true)][string]$OpenLocallyPath
    )

    $failures = [System.Collections.Generic.List[object]]::new()
    foreach ($path in $Paths) {
        $snapshot = if ($Snapshots.ContainsKey($path)) { $Snapshots[$path] } else { $null }
        if (-not (Test-RegistrySnapshotIsValid -Snapshot $snapshot)) {
            $failures.Add((New-RecoveryFailure -Phase 'registry' -Target $path -Snapshot $snapshot -Detail 'No complete pre-run snapshot is available; the live key was left untouched.')) | Out-Null
            continue
        }

        try {
            Restore-RegistrySnapshot -Path $path -Snapshot $snapshot
            if ($path -ieq $OpenLocallyPath -and -not (Test-RegistrySnapshotMatches -Path $path -Expected $snapshot)) {
                throw 'The restored Open Locally command/value tree does not match its captured pre-run state.'
            }
        }
        catch {
            $failures.Add((New-RecoveryFailure -Phase 'registry' -Target $path -Snapshot $snapshot -Detail $_.Exception.Message)) | Out-Null
        }
    }

    return @($failures)
}

function Format-RecoveryCommand {
    param(
        [Parameter(Mandatory = $true)][string]$RepositoryRoot,
        [Parameter(Mandatory = $true)][string]$RecoveryPath
    )

    $scriptPath = $PSCommandPath.Replace("'", "''")
    $escapedRoot = $RepositoryRoot.Replace("'", "''")
    $escapedRecovery = $RecoveryPath.Replace("'", "''")
    return "& '$scriptPath' -RepositoryRoot '$escapedRoot' -RecoverFrom '$escapedRecovery'"
}

function Assert-ManualWorkspace {
    param([Parameter(Mandatory = $true)][string]$Workspace)

    $workspace = [IO.Path]::GetFullPath($Workspace)
    $tempRoot = [IO.Path]::GetFullPath($env:TEMP).TrimEnd([IO.Path]::DirectorySeparatorChar, [IO.Path]::AltDirectorySeparatorChar)
    $tempPrefix = $tempRoot + [IO.Path]::DirectorySeparatorChar
    if (-not $workspace.StartsWith($tempPrefix, [System.StringComparison]::OrdinalIgnoreCase) -or
        -not [IO.Path]::GetFileName($workspace).StartsWith($ManualWorkspacePrefix, [System.StringComparison]::OrdinalIgnoreCase)) {
        throw "Recovery data must belong to a unique temporary $ManualWorkspacePrefix workspace."
    }

    return $workspace
}

function Get-ManualWorkspaceFromRecoveryPath {
    param([Parameter(Mandatory = $true)][string]$RecoveryPath)

    $resolvedRecovery = (Resolve-Path -LiteralPath $RecoveryPath).Path
    if ([IO.Path]::GetFileName($resolvedRecovery) -cne 'registry-recovery.clixml') {
        throw "Recovery data must be the wrapper's registry-recovery.clixml file."
    }

    return Assert-ManualWorkspace -Workspace (Split-Path -LiteralPath $resolvedRecovery -Parent)
}

function Test-TransientWorkspaceLock {
    param([Parameter(Mandatory = $true)]$Error)

    $current = $Error
    while ($null -ne $current) {
        if ($current -is [IO.IOException] -or $current -is [UnauthorizedAccessException]) { return $true }
        $current = $current.InnerException
    }

    return $false
}

function Remove-ManualWorkspaceWithRetry {
    param([Parameter(Mandatory = $true)][string]$Workspace)

    $verifiedWorkspace = Assert-ManualWorkspace -Workspace $Workspace
    $deadline = [datetime]::UtcNow.AddSeconds($ManualCleanupRetryWindowSeconds)
    $attempts = 0

    while ($true) {
        if (-not (Test-Path -LiteralPath $verifiedWorkspace)) {
            return [pscustomobject]@{ Succeeded = $true; Attempts = $attempts; Detail = $null }
        }

        $attempts += 1
        try {
            Remove-Item -LiteralPath $verifiedWorkspace -Recurse -Force -ErrorAction Stop
            return [pscustomobject]@{ Succeeded = $true; Attempts = $attempts; Detail = $null }
        }
        catch {
            if (-not (Test-TransientWorkspaceLock -Error $_.Exception) -or [datetime]::UtcNow -ge $deadline) {
                return [pscustomobject]@{ Succeeded = $false; Attempts = $attempts; Detail = $_.Exception.Message }
            }

            Start-Sleep -Milliseconds $ManualCleanupRetryDelayMilliseconds
        }
    }
}

function New-ManualWorkflowEventReader {
    [pscustomobject]@{
        ReadByteOffset = [long]0
        FramedByteOffset = [long]0
        ParsedCount = [long]0
        PendingBytes = [byte[]]::new(0)
        PendingEvents = [System.Collections.Generic.List[object]]::new()
        SnapshotLengthCapturedHook = $null
    }
}

function Get-ManualWorkflowEventReaderProgress {
    param([Parameter(Mandatory = $true)]$State)

    [byte[]]$pendingBytes = [byte[]]$State.PendingBytes.Clone()
    return [pscustomobject]@{
        ReadByteOffset = [long]$State.ReadByteOffset
        FramedByteOffset = [long]$State.FramedByteOffset
        ParsedCount = [long]$State.ParsedCount
        PendingBytes = $pendingBytes
    }
}

function Assert-ManualWorkflowEventReaderProgress {
    param(
        [Parameter(Mandatory = $true)]$State,
        [Parameter(Mandatory = $true)]$Expected,
        [Parameter(Mandatory = $true)][string]$Scenario
    )

    if ($State.ReadByteOffset -ne $Expected.ReadByteOffset -or
        $State.FramedByteOffset -ne $Expected.FramedByteOffset -or
        $State.ParsedCount -ne $Expected.ParsedCount -or
        $State.PendingBytes.Length -ne $Expected.PendingBytes.Length) {
        throw "$Scenario changed committed reader progress."
    }

    for ([int]$index = 0; $index -lt $Expected.PendingBytes.Length; $index++) {
        if ($State.PendingBytes[$index] -ne $Expected.PendingBytes[$index]) {
            throw "$Scenario changed committed reader pending bytes."
        }
    }

    if ($State.ReadByteOffset -ne ($State.FramedByteOffset + $State.PendingBytes.Length)) {
        throw "$Scenario violated the reader byte-progress invariant."
    }
}

function Read-ManualWorkflowEventSnapshot {
    param(
        [Parameter(Mandatory = $true)][string]$Events,
        [Parameter(Mandatory = $true)][long]$ReadByteOffset,
        [scriptblock]$AfterSnapshotLengthCaptured
    )

    # The Manual event stream is live and append-only. Keep the handle only for
    # one fixed byte snapshot so concurrent writers can continue publishing.
    $stream = [IO.FileStream]::new($Events, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::ReadWrite)
    try {
        $snapshotLength = [long]$stream.Length
        if ($snapshotLength -lt $ReadByteOffset) {
            throw "Workflow event stream was truncated before byte offset $ReadByteOffset."
        }

        if ($null -ne $AfterSnapshotLengthCaptured) {
            & $AfterSnapshotLengthCaptured $snapshotLength $ReadByteOffset
        }

        [long]$remaining = $snapshotLength - $ReadByteOffset
        if ($remaining -eq 0) {
            return ,([byte[]]::new(0))
        }

        [void]$stream.Seek($ReadByteOffset, [IO.SeekOrigin]::Begin)
        $capturedBytes = [System.Collections.Generic.List[byte]]::new()
        $buffer = [byte[]]::new([int][Math]::Min(8192, $remaining))
        while ($remaining -gt 0) {
            $requested = [int][Math]::Min([long]$buffer.Length, $remaining)
            $read = $stream.Read($buffer, 0, $requested)
            if ($read -le 0) {
                throw "Workflow event stream ended before captured snapshot byte offset $snapshotLength."
            }

            $chunk = [byte[]]::new($read)
            [Buffer]::BlockCopy($buffer, 0, $chunk, 0, $read)
            $capturedBytes.AddRange($chunk)
            $remaining -= [long]$read
        }

        return ,([byte[]]$capturedBytes.ToArray())
    }
    finally {
        $stream.Dispose()
    }
}

function Read-ManualWorkflowEvents {
    param(
        [Parameter(Mandatory = $true)][string]$Events,
        [Parameter(Mandatory = $true)]$State,
        [switch]$EndOfStream
    )

    # Reader progress is a whole-poll transaction. The verifier-only snapshot
    # hook is intentionally one-shot and is not reader progress state.
    [long]$temporaryReadByteOffset = $State.ReadByteOffset
    [long]$temporaryFramedByteOffset = $State.FramedByteOffset
    [long]$temporaryParsedCount = $State.ParsedCount
    [byte[]]$temporaryPendingBytes = [byte[]]$State.PendingBytes
    $temporaryEvents = [System.Collections.Generic.List[object]]::new()

    if (Test-Path -LiteralPath $Events) {
        $snapshotHook = $State.SnapshotLengthCapturedHook
        $State.SnapshotLengthCapturedHook = $null
        [byte[]]$snapshotBytes = Read-ManualWorkflowEventSnapshot -Events $Events -ReadByteOffset $temporaryReadByteOffset -AfterSnapshotLengthCaptured $snapshotHook
        $temporaryReadByteOffset += [long]$snapshotBytes.Length

        $framingBytes = [System.Collections.Generic.List[byte]]::new()
        if ($temporaryPendingBytes.Length -gt 0) {
            $framingBytes.AddRange($temporaryPendingBytes)
        }
        if ($snapshotBytes.Length -gt 0) {
            $framingBytes.AddRange($snapshotBytes)
        }

        $strictUtf8 = [Text.UTF8Encoding]::new($false, $true)
        [int]$recordStart = 0
        for ([int]$index = 0; $index -lt $framingBytes.Count; $index++) {
            if ($framingBytes[$index] -ne [byte]0x0A) { continue }

            [int]$framedLength = ($index - $recordStart) + 1
            [int]$recordByteLength = $index - $recordStart
            if ($recordByteLength -gt 0 -and $framingBytes[$index - 1] -eq [byte]0x0D) {
                $recordByteLength -= 1
            }

            [byte[]]$recordBytes = [byte[]]::new($recordByteLength)
            if ($recordByteLength -gt 0) {
                $framingBytes.CopyTo($recordStart, $recordBytes, 0, $recordByteLength)
            }

            [long]$recordByteOffset = $temporaryFramedByteOffset
            $recordStart = $index + 1
            if ($recordBytes.Length -eq 0) {
                $temporaryFramedByteOffset += [long]$framedLength
                continue
            }

            try {
                $record = $strictUtf8.GetString($recordBytes)
            }
            catch {
                throw "Invalid UTF-8 complete workflow event record #$($temporaryParsedCount + 1) at byte offset $recordByteOffset; sanitized record context: <redacted length=$($recordBytes.Length)>."
            }

            if ([string]::IsNullOrWhiteSpace($record)) {
                $temporaryFramedByteOffset += [long]$framedLength
                continue
            }

            try {
                $event = $record | ConvertFrom-Json -ErrorAction Stop
            }
            catch {
                throw "Malformed complete workflow event record #$($temporaryParsedCount + 1) at byte offset $recordByteOffset; sanitized record context: <redacted length=$($recordBytes.Length)>."
            }

            $temporaryEvents.Add($event) | Out-Null
            $temporaryParsedCount += 1
            $temporaryFramedByteOffset += [long]$framedLength
        }

        [int]$pendingLength = $framingBytes.Count - $recordStart
        [byte[]]$temporaryPendingBytes = [byte[]]::new($pendingLength)
        if ($pendingLength -gt 0) {
            $framingBytes.CopyTo($recordStart, $temporaryPendingBytes, 0, $pendingLength)
        }
    }

    if ($EndOfStream -and $temporaryPendingBytes.Length -gt 0) {
        $isWhitespace = $false
        try {
            $isWhitespace = [string]::IsNullOrWhiteSpace(([Text.UTF8Encoding]::new($false, $true)).GetString($temporaryPendingBytes))
        }
        catch {
            $isWhitespace = $false
        }

        if (-not $isWhitespace) {
            throw "Incomplete workflow event stream at byte offset $temporaryFramedByteOffset; sanitized trailing context: <redacted length=$($temporaryPendingBytes.Length)>."
        }
    }

    # Commit only after every complete record and the optional final drain pass.
    $State.ReadByteOffset = $temporaryReadByteOffset
    $State.FramedByteOffset = $temporaryFramedByteOffset
    $State.ParsedCount = $temporaryParsedCount
    $State.PendingBytes = $temporaryPendingBytes
    foreach ($event in $temporaryEvents) {
        $State.PendingEvents.Add($event) | Out-Null
    }
}

function Assert-ManualWorkflowEventReader {
    $root = Join-Path $env:TEMP ('CreatorCrate-m2-event-reader-' + [guid]::NewGuid().ToString('N'))
    $events = Join-Path $root 'workflow-events.jsonl'
    $utf8 = [Text.UTF8Encoding]::new($false)
    New-Item -ItemType Directory -Path $root | Out-Null

    try {
        [IO.File]::WriteAllBytes($events, [byte[]]::new(0))
        $reader = New-ManualWorkflowEventReader
        if ($null -ne $reader.SnapshotLengthCapturedHook) {
            throw 'A new event reader did not initialize its verifier-only snapshot hook to null.'
        }
        Read-ManualWorkflowEvents -Events $events -State $reader
        if ($reader.PendingEvents.Count -ne 0 -or $reader.ReadByteOffset -ne 0 -or $reader.PendingBytes.Length -ne 0) {
            throw 'Empty event stream did not remain an empty byte snapshot.'
        }
        Assert-ManualWorkflowEventReaderProgress -State $reader -Expected (Get-ManualWorkflowEventReaderProgress -State $reader) -Scenario 'Empty event stream'

        $singleRecord = '{"Kind":"checkpoint","Stage":"single","Message":"single"}' + [Environment]::NewLine
        [IO.File]::WriteAllText($events, $singleRecord, $utf8)
        $reader = New-ManualWorkflowEventReader
        Read-ManualWorkflowEvents -Events $events -State $reader
        if ($reader.PendingEvents.Count -ne 1 -or $reader.PendingEvents[0].Stage -cne 'single') {
            throw 'One complete ASCII event record did not parse exactly once.'
        }
        Assert-ManualWorkflowEventReaderProgress -State $reader -Expected (Get-ManualWorkflowEventReaderProgress -State $reader) -Scenario 'Single complete event'

        $multipleRecords = '{"Kind":"checkpoint","Stage":"one","Message":"one"}' + [Environment]::NewLine + '{"Kind":"checkpoint","Stage":"two","Message":"two"}' + [Environment]::NewLine
        [IO.File]::WriteAllText($events, $multipleRecords, $utf8)
        $reader = New-ManualWorkflowEventReader
        Read-ManualWorkflowEvents -Events $events -State $reader
        if ($reader.PendingEvents.Count -ne 2) { throw 'Multiple complete event records in one read did not parse exactly twice.' }
        $reader.PendingEvents.Clear()
        Read-ManualWorkflowEvents -Events $events -State $reader
        if ($reader.PendingEvents.Count -ne 0) { throw 'A repeated event-reader poll emitted duplicate complete records.' }

        $reader = New-ManualWorkflowEventReader
        [IO.File]::WriteAllText($events, '{"Kind":"stage-start","Stage":"Produ', $utf8)
        Read-ManualWorkflowEvents -Events $events -State $reader
        if ($reader.PendingEvents.Count -ne 0 -or $reader.PendingBytes.Length -eq 0) {
            throw 'Split ASCII event record was parsed or discarded before its newline terminator.'
        }

        [IO.File]::AppendAllText($events, ('ction gate","Message":"started"}' + [Environment]::NewLine + '{"Kind":"checkpoint","Stage":"after-split","Message":"after-split"}' + [Environment]::NewLine), $utf8)
        Read-ManualWorkflowEvents -Events $events -State $reader
        if ($reader.PendingEvents.Count -ne 2 -or $reader.PendingEvents[0].Stage -cne 'Production gate' -or $reader.PendingEvents[1].Stage -cne 'after-split') {
            throw 'Split ASCII record or its immediately following event did not parse exactly once after completion.'
        }

        $crlfRecord = '{"Kind":"checkpoint","Stage":"crlf","Message":"crlf"}' + [char]13 + [char]10
        [IO.File]::WriteAllText($events, $crlfRecord, $utf8)
        $reader = New-ManualWorkflowEventReader
        Read-ManualWorkflowEvents -Events $events -State $reader
        if ($reader.PendingEvents.Count -ne 1 -or $reader.PendingEvents[0].Stage -cne 'crlf') {
            throw 'CRLF event framing retained a carriage return or failed to parse the record.'
        }

        $splitCases = @(
            [pscustomobject]@{
                Name = '2BYTE'
                ExpectedMessage = ('caf' + [char]0x00E9)
                TargetBytes = [byte[]]@(0xC3, 0xA9)
                SplitLength = 1
            },
            [pscustomobject]@{
                Name = '3BYTE'
                ExpectedMessage = ([string][char]0x20AC)
                TargetBytes = [byte[]]@(0xE2, 0x82, 0xAC)
                SplitLength = 1
            },
            [pscustomobject]@{
                Name = '4BYTE'
                ExpectedMessage = ([char]0xD83D + [char]0xDE00)
                TargetBytes = [byte[]]@(0xF0, 0x9F, 0x98, 0x80)
                SplitLength = 1
            }
        )

        foreach ($splitCase in $splitCases) {
            $record = ([pscustomobject]@{ Kind = 'checkpoint'; Stage = ('utf8-' + $splitCase.Name.ToLowerInvariant()); Message = $splitCase.ExpectedMessage } | ConvertTo-Json -Compress) + [Environment]::NewLine
            [byte[]]$recordBytes = $utf8.GetBytes($record)
            [int]$targetIndex = -1
            [int]$targetOccurrences = 0
            for ([int]$candidate = 0; $candidate -le $recordBytes.Length - $splitCase.TargetBytes.Length; $candidate++) {
                $matchesTarget = $true
                for ([int]$targetOffset = 0; $targetOffset -lt $splitCase.TargetBytes.Length; $targetOffset++) {
                    if ($recordBytes[$candidate + $targetOffset] -ne $splitCase.TargetBytes[$targetOffset]) {
                        $matchesTarget = $false
                        break
                    }
                }

                if ($matchesTarget) {
                    if ($targetIndex -lt 0) { $targetIndex = $candidate }
                    $targetOccurrences += 1
                }
            }

            if ($targetIndex -lt 0 -or $targetOccurrences -ne 1 -or
                $targetIndex + $splitCase.SplitLength -ge $recordBytes.Length -or
                $recordBytes[$targetIndex] -ne $splitCase.TargetBytes[0]) {
                throw "$($splitCase.Name) fixture did not contain exactly one target UTF-8 sequence at a safe internal split point."
            }

            $reader = New-ManualWorkflowEventReader
            $writer = [IO.FileStream]::new($events, [IO.FileMode]::Create, [IO.FileAccess]::Write, [IO.FileShare]::Read)
            try {
                [int]$firstWriteLength = $targetIndex + $splitCase.SplitLength
                $writer.Write($recordBytes, 0, $firstWriteLength)
                $writer.Flush($true)
                Read-ManualWorkflowEvents -Events $events -State $reader
                if ($reader.PendingEvents.Count -ne 0 -or
                    $reader.PendingBytes.Length -ne $firstWriteLength -or
                    $reader.ReadByteOffset -ne $firstWriteLength -or
                    $reader.FramedByteOffset -ne 0 -or
                    $reader.PendingBytes[$reader.PendingBytes.Length - 1] -ne $splitCase.TargetBytes[$splitCase.SplitLength - 1]) {
                    throw "$($splitCase.Name) split event was decoded, skipped, or not retained as raw pending bytes."
                }

                $writer.Write($recordBytes, $firstWriteLength, $recordBytes.Length - $firstWriteLength)
                $writer.Flush($true)
                Read-ManualWorkflowEvents -Events $events -State $reader
            }
            finally {
                $writer.Dispose()
            }

            [int]$replacementCount = 0
            if ($reader.PendingEvents.Count -ne 1 -or $reader.PendingEvents[0].Message -cne $splitCase.ExpectedMessage) {
                throw "$($splitCase.Name) split event did not preserve its target character exactly."
            }
            foreach ($character in $reader.PendingEvents[0].Message.ToCharArray()) {
                if ($character -eq [char]0xFFFD) { $replacementCount += 1 }
            }
            if ($replacementCount -ne 0) {
                throw "$($splitCase.Name) split event inserted replacement characters."
            }
            Assert-ManualWorkflowEventReaderProgress -State $reader -Expected (Get-ManualWorkflowEventReaderProgress -State $reader) -Scenario "$($splitCase.Name) completed split event"
            Write-Host ('{0}_PRE_EVENTS=0; {0}_ACTUAL={1}; {0}_BYTES={2}; {0}_SPLIT={3}/{4}; {0}_BYTE_INDEX={5}; REPLACEMENT_COUNT={6}' -f $splitCase.Name, $splitCase.ExpectedMessage, ([BitConverter]::ToString($splitCase.TargetBytes)), $splitCase.SplitLength, ($splitCase.TargetBytes.Length - $splitCase.SplitLength), $targetIndex, $replacementCount)

            $reader.PendingEvents.Clear()
            Read-ManualWorkflowEvents -Events $events -State $reader
            if ($reader.PendingEvents.Count -ne 0) { throw "$($splitCase.Name) completed split event was emitted more than once." }
        }

        $recordA = '{"Kind":"checkpoint","Stage":"snapshot-a","Message":"A"}' + [Environment]::NewLine
        $recordB = '{"Kind":"checkpoint","Stage":"snapshot-b","Message":"B"}' + [Environment]::NewLine
        [IO.File]::WriteAllText($events, $recordA, $utf8)
        $reader = New-ManualWorkflowEventReader
        $reader.SnapshotLengthCapturedHook = {
            param($snapshotLength, $readByteOffset)
            [IO.File]::AppendAllText($events, $recordB, $utf8)
        }.GetNewClosure()
        Read-ManualWorkflowEvents -Events $events -State $reader
        if ($reader.PendingEvents.Count -ne 1 -or $reader.PendingEvents[0].Stage -cne 'snapshot-a' -or $null -ne $reader.SnapshotLengthCapturedHook) {
            throw 'The fixed snapshot boundary did not consume its one-shot hook or deferred post-capture bytes.'
        }
        $reader.PendingEvents.Clear()
        Read-ManualWorkflowEvents -Events $events -State $reader
        if ($reader.PendingEvents.Count -ne 1 -or $reader.PendingEvents[0].Stage -cne 'snapshot-b') {
            throw 'The next byte snapshot did not consume the record deferred past the captured boundary.'
        }

        [IO.File]::WriteAllText($events, $recordA, $utf8)
        $reader = New-ManualWorkflowEventReader
        $beforeHookFailure = Get-ManualWorkflowEventReaderProgress -State $reader
        $reader.SnapshotLengthCapturedHook = {
            throw 'Deliberate snapshot hook failure.'
        }
        $hookFailure = $null
        try { Read-ManualWorkflowEvents -Events $events -State $reader }
        catch { $hookFailure = $_.Exception }
        if ($null -eq $hookFailure -or $hookFailure.Message -notlike '*Deliberate snapshot hook failure*' -or $null -ne $reader.SnapshotLengthCapturedHook) {
            throw 'A failing one-shot snapshot hook was not consumed before invocation.'
        }
        Assert-ManualWorkflowEventReaderProgress -State $reader -Expected $beforeHookFailure -Scenario 'Failing one-shot snapshot hook'
        Read-ManualWorkflowEvents -Events $events -State $reader
        if ($reader.PendingEvents.Count -ne 1 -or $reader.PendingEvents[0].Stage -cne 'snapshot-a') {
            throw 'A failing snapshot hook changed reader offsets instead of allowing a normal replay.'
        }

        $reader = New-ManualWorkflowEventReader
        [IO.File]::WriteAllText($events, '{"Kind":"checkpoint"', $utf8)
        $beforeIncomplete = Get-ManualWorkflowEventReaderProgress -State $reader
        $incomplete = $null
        try { Read-ManualWorkflowEvents -Events $events -State $reader -EndOfStream }
        catch { $incomplete = $_.Exception }
        if ($null -eq $incomplete -or $incomplete.Message -notlike '*Incomplete workflow event stream*') {
            throw 'Final partial event record did not produce the bounded incomplete-stream diagnostic.'
        }
        Assert-ManualWorkflowEventReaderProgress -State $reader -Expected $beforeIncomplete -Scenario 'Incomplete final record'

        $partialUtf8 = [System.Collections.Generic.List[byte]]::new()
        $partialUtf8.AddRange($utf8.GetBytes('{"Kind":"checkpoint","Message":"caf'))
        $partialUtf8.Add([byte]0xC3)
        [IO.File]::WriteAllBytes($events, $partialUtf8.ToArray())
        $reader = New-ManualWorkflowEventReader
        $beforeIncompleteUtf8 = Get-ManualWorkflowEventReaderProgress -State $reader
        $incompleteUtf8 = $null
        try { Read-ManualWorkflowEvents -Events $events -State $reader -EndOfStream }
        catch { $incompleteUtf8 = $_.Exception }
        if ($null -eq $incompleteUtf8 -or $incompleteUtf8.Message -notlike '*Incomplete workflow event stream*') {
            throw 'A partial UTF-8 trailing record was normalized instead of producing the incomplete-stream diagnostic.'
        }
        Assert-ManualWorkflowEventReaderProgress -State $reader -Expected $beforeIncompleteUtf8 -Scenario 'Incomplete final UTF-8 record'

        $validSuffix = '{"Kind":"checkpoint","Stage":"valid-suffix","Message":"suffix"}' + [Environment]::NewLine
        [IO.File]::WriteAllText($events, ('{"Kind":"checkpoint"' + [Environment]::NewLine + $validSuffix), $utf8)
        $reader = New-ManualWorkflowEventReader
        $beforeMalformed = Get-ManualWorkflowEventReaderProgress -State $reader
        $malformed = $null
        try { Read-ManualWorkflowEvents -Events $events -State $reader }
        catch { $malformed = $_.Exception }
        if ($null -eq $malformed -or $malformed.Message -notlike '*Malformed complete workflow event record*' -or $reader.PendingEvents.Count -ne 0) {
            throw 'Malformed complete event with a valid suffix did not fail without exposing events.'
        }
        Assert-ManualWorkflowEventReaderProgress -State $reader -Expected $beforeMalformed -Scenario 'Malformed record with valid suffix'
        Write-Host ('ROLLBACK_MALFORMED_BEFORE=ReadByteOffset:{0},FramedByteOffset:{1},PendingBytes:{2}; AFTER_FAILURE=ReadByteOffset:{3},FramedByteOffset:{4},PendingBytes:{5}' -f $beforeMalformed.ReadByteOffset, $beforeMalformed.FramedByteOffset, $beforeMalformed.PendingBytes.Length, $reader.ReadByteOffset, $reader.FramedByteOffset, $reader.PendingBytes.Length)
        $repeatedMalformed = $null
        try { Read-ManualWorkflowEvents -Events $events -State $reader }
        catch { $repeatedMalformed = $_.Exception }
        if ($null -eq $repeatedMalformed -or $repeatedMalformed.Message -notlike '*Malformed complete workflow event record*' -or $reader.PendingEvents.Count -ne 0) {
            throw 'Malformed record with a valid suffix did not fail again from the original committed byte offset.'
        }
        Assert-ManualWorkflowEventReaderProgress -State $reader -Expected $beforeMalformed -Scenario 'Repeated malformed record with valid suffix'

        $invalidUtf8 = [System.Collections.Generic.List[byte]]::new()
        $invalidUtf8.AddRange($utf8.GetBytes('{"Kind":"checkpoint","Message":"'))
        $invalidUtf8.Add([byte]0xC3)
        $invalidUtf8.AddRange($utf8.GetBytes('"}' + [Environment]::NewLine + $validSuffix))
        [IO.File]::WriteAllBytes($events, $invalidUtf8.ToArray())
        $reader = New-ManualWorkflowEventReader
        $beforeInvalidUtf8 = Get-ManualWorkflowEventReaderProgress -State $reader
        $invalidEncoding = $null
        try { Read-ManualWorkflowEvents -Events $events -State $reader }
        catch { $invalidEncoding = $_.Exception }
        if ($null -eq $invalidEncoding -or $invalidEncoding.Message -notlike '*Invalid UTF-8 complete workflow event record*' -or $reader.PendingEvents.Count -ne 0) {
            throw 'Invalid UTF-8 complete event with a valid suffix did not fail through the strict encoding path.'
        }
        Assert-ManualWorkflowEventReaderProgress -State $reader -Expected $beforeInvalidUtf8 -Scenario 'Invalid UTF-8 record with valid suffix'
        $repeatedInvalidEncoding = $null
        try { Read-ManualWorkflowEvents -Events $events -State $reader }
        catch { $repeatedInvalidEncoding = $_.Exception }
        if ($null -eq $repeatedInvalidEncoding -or $repeatedInvalidEncoding.Message -notlike '*Invalid UTF-8 complete workflow event record*' -or $reader.PendingEvents.Count -ne 0) {
            throw 'Invalid UTF-8 record with a valid suffix did not fail again from the original committed byte offset.'
        }
        Assert-ManualWorkflowEventReaderProgress -State $reader -Expected $beforeInvalidUtf8 -Scenario 'Repeated invalid UTF-8 record with valid suffix'

        $pendingPrefix = '{"Kind":"checkpoint","Stage":"pending","Message":"'
        [IO.File]::WriteAllText($events, $pendingPrefix, $utf8)
        $reader = New-ManualWorkflowEventReader
        Read-ManualWorkflowEvents -Events $events -State $reader
        $beforePendingFailure = Get-ManualWorkflowEventReaderProgress -State $reader
        if ($reader.PendingEvents.Count -ne 0 -or $beforePendingFailure.PendingBytes.Length -ne $utf8.GetByteCount($pendingPrefix)) {
            throw 'The pre-existing PendingBytes regression did not commit its first partial poll.'
        }
        [IO.File]::AppendAllText($events, ('pending" BROKEN' + [Environment]::NewLine + $validSuffix), $utf8)
        $pendingMalformed = $null
        try { Read-ManualWorkflowEvents -Events $events -State $reader }
        catch { $pendingMalformed = $_.Exception }
        if ($null -eq $pendingMalformed -or $pendingMalformed.Message -notlike '*Malformed complete workflow event record*' -or $reader.PendingEvents.Count -ne 0) {
            throw 'A malformed completion of pre-existing PendingBytes did not fail transactionally.'
        }
        Assert-ManualWorkflowEventReaderProgress -State $reader -Expected $beforePendingFailure -Scenario 'Malformed completion of pre-existing PendingBytes'

        $validA = '{"Kind":"checkpoint","Stage":"valid-a","Message":"A"}' + [Environment]::NewLine
        $malformedB = '{"Kind":"checkpoint","Stage":"malformed-b"' + [Environment]::NewLine
        [IO.File]::WriteAllText($events, ($validA + $malformedB), $utf8)
        $reader = New-ManualWorkflowEventReader
        $beforeValidThenMalformed = Get-ManualWorkflowEventReaderProgress -State $reader
        $validThenMalformed = $null
        try { Read-ManualWorkflowEvents -Events $events -State $reader }
        catch { $validThenMalformed = $_.Exception }
        if ($null -eq $validThenMalformed -or $validThenMalformed.Message -notlike '*record #2*' -or $reader.PendingEvents.Count -ne 0) {
            throw 'A valid event before malformed JSON was committed or did not fail as the second record.'
        }
        Assert-ManualWorkflowEventReaderProgress -State $reader -Expected $beforeValidThenMalformed -Scenario 'Valid event before malformed event'
        $repeatedValidThenMalformed = $null
        try { Read-ManualWorkflowEvents -Events $events -State $reader }
        catch { $repeatedValidThenMalformed = $_.Exception }
        if ($null -eq $repeatedValidThenMalformed -or $repeatedValidThenMalformed.Message -notlike '*record #2*' -or $reader.PendingEvents.Count -ne 0) {
            throw 'A valid event before malformed JSON was skipped on the replay poll.'
        }
        Assert-ManualWorkflowEventReaderProgress -State $reader -Expected $beforeValidThenMalformed -Scenario 'Repeated valid event before malformed event'

        $successA = '{"Kind":"checkpoint","Stage":"success-a","Message":"A"}' + [Environment]::NewLine
        $successB = '{"Kind":"checkpoint","Stage":"success-b","Message":"B"}' + [Environment]::NewLine
        $partialC = '{"Kind":"checkpoint","Stage":"success-c","Message":"partial'
        [IO.File]::WriteAllText($events, ($successA + $successB + $partialC), $utf8)
        $reader = New-ManualWorkflowEventReader
        Read-ManualWorkflowEvents -Events $events -State $reader
        [long]$expectedSuccessReadOffset = $utf8.GetByteCount($successA + $successB + $partialC)
        [long]$expectedSuccessFramedOffset = $utf8.GetByteCount($successA + $successB)
        if ($reader.PendingEvents.Count -ne 2 -or
            $reader.PendingEvents[0].Stage -cne 'success-a' -or
            $reader.PendingEvents[1].Stage -cne 'success-b' -or
            $reader.ReadByteOffset -ne $expectedSuccessReadOffset -or
            $reader.FramedByteOffset -ne $expectedSuccessFramedOffset -or
            $reader.PendingBytes.Length -ne $utf8.GetByteCount($partialC)) {
            throw 'A successful valid-A/valid-B/partial-C poll did not commit the expected whole-poll state.'
        }
        Assert-ManualWorkflowEventReaderProgress -State $reader -Expected (Get-ManualWorkflowEventReaderProgress -State $reader) -Scenario 'Successful valid-A valid-B partial-C poll'
        $reader.PendingEvents.Clear()
        [IO.File]::AppendAllText($events, ('"}' + [Environment]::NewLine), $utf8)
        Read-ManualWorkflowEvents -Events $events -State $reader
        if ($reader.PendingEvents.Count -ne 1 -or $reader.PendingEvents[0].Stage -cne 'success-c') {
            throw 'The next successful poll did not complete only the retained partial-C event.'
        }
    }
    finally {
        if (Test-Path -LiteralPath $root) { Remove-Item -LiteralPath $root -Recurse -Force }
    }

    Write-Host 'Event stream framing self-test passed.'
}

function Get-ManualProcessDescription {
    try {
        $current = Get-CimInstance -ClassName Win32_Process -Filter "ProcessId = $PID"
        if ($null -eq $current -or $current.ParentProcessId -le 0) { return '<unavailable>' }

        $parent = Get-CimInstance -ClassName Win32_Process -Filter ("ProcessId = {0}" -f $current.ParentProcessId)
        if ($null -eq $parent) { return ("exited ({0})" -f $current.ParentProcessId) }

        return ("{0} ({1})" -f $parent.Name, $parent.ProcessId)
    }
    catch {
        return '<unavailable>'
    }
}

function Get-ManualDotnetEnvironmentNames {
    return @(
        Get-ChildItem Env: |
            Where-Object { $_.Name.StartsWith('DOTNET_', [System.StringComparison]::OrdinalIgnoreCase) } |
            Select-Object -ExpandProperty Name |
            Sort-Object
    )
}

function Get-ManualTokenDiagnostics {
    $source = Join-Path $PSScriptRoot 'ManualTokenDiagnostics.cs'
    if (-not (Test-Path -LiteralPath $source -PathType Leaf)) {
        throw "Manual token diagnostics source '$source' was not found."
    }

    if ($null -eq ('OpenLocally.Tests.Manual.ManualTokenDiagnostics' -as [type])) {
        Add-Type -Path $source -ErrorAction Stop
    }

    return [OpenLocally.Tests.Manual.ManualTokenDiagnostics]::InspectCurrentProcess()
}

function Get-ManualFinalPath {
    param([Parameter(Mandatory = $true)][IO.FileStream]$Stream)

    if ($null -eq ('CreatorCrate.ManualFinalPath' -as [type])) {
        Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Text;
using Microsoft.Win32.SafeHandles;

namespace CreatorCrate
{
    public static class ManualFinalPath
    {
        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        private static extern uint GetFinalPathNameByHandle(SafeFileHandle handle, StringBuilder path, uint pathLength, uint flags);

        public static string Resolve(SafeFileHandle handle)
        {
            var path = new StringBuilder(32768);
            uint length = GetFinalPathNameByHandle(handle, path, (uint)path.Capacity, 0);
            if (length == 0 || length >= path.Capacity)
                throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error(), "Windows could not resolve the final executable path.");

            return path.ToString();
        }
    }
}
'@
    }

    return [CreatorCrate.ManualFinalPath]::Resolve($Stream.SafeFileHandle)
}

function Test-NativeAppHostPreflight {
    param(
        [Parameter(Mandatory = $true)][string]$Executable,
        [Parameter(Mandatory = $true)][string]$WorkingDirectory
    )

    if (-not (Test-Path -LiteralPath $Executable -PathType Leaf)) {
        throw "Native apphost preflight [file-exists] failed: '$Executable' does not exist."
    }

    try {
        $fullExecutable = [IO.Path]::GetFullPath($Executable)
    }
    catch {
        throw "Native apphost preflight [full-path] failed: $($_.Exception.Message)"
    }

    $parent = [IO.Path]::GetDirectoryName($fullExecutable)
    if ([string]::IsNullOrWhiteSpace($parent) -or -not (Test-Path -LiteralPath $parent -PathType Container)) {
        throw "Native apphost preflight [executable-parent] failed: '$parent' does not exist."
    }

    if (-not (Test-Path -LiteralPath $WorkingDirectory -PathType Container)) {
        throw "Native apphost preflight [working-directory] failed: '$WorkingDirectory' does not exist."
    }

    try {
        $executableAttributes = [IO.File]::GetAttributes($fullExecutable)
        $parentAttributes = [IO.File]::GetAttributes($parent)
        $stream = [IO.File]::Open($fullExecutable, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::ReadWrite)
        try {
            $finalPath = Get-ManualFinalPath -Stream $stream
        }
        finally {
            $stream.Dispose()
        }
    }
    catch {
        throw "Native apphost preflight [read-attributes-final-path] failed: $($_.Exception.Message)"
    }

    [pscustomobject]@{
        ExecutablePath = $fullExecutable
        PublishDirectory = $parent
        WorkingDirectory = [IO.Path]::GetFullPath($WorkingDirectory)
        WorkingDirectoryExists = $true
        ExecutableExists = $true
        ExecutableAttributes = $executableAttributes.ToString()
        ExecutableParentAttributes = $parentAttributes.ToString()
        ReadAccessConfirmed = $true
        ExecutableFinalPath = $finalPath
    }
}

function New-WrapperLaunchContext {
    param(
        [Parameter(Mandatory = $true)]$Preflight,
        [Parameter(Mandatory = $true)][System.Diagnostics.ProcessStartInfo]$StartInfo,
        [Parameter(Mandatory = $true)][AllowEmptyString()][string[]]$LogicalArguments
    )

    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    try {
        $tokenDiagnostics = Get-ManualTokenDiagnostics

        [pscustomobject]@{
            Launcher = 'Parent PowerShell wrapper'
            ParentProcess = Get-ManualProcessDescription
            ProcessId = $PID
            Identity = $identity.Name
            IsElevated = $tokenDiagnostics.IsElevated
            ElevationType = $tokenDiagnostics.ElevationType
            IntegrityLevel = $tokenDiagnostics.IntegrityLevel
            IsAppContainer = $tokenDiagnostics.IsAppContainer
            TokenInspectionStatus = $tokenDiagnostics.InspectionStatus
            TokenProcessId = $tokenDiagnostics.ProcessId
            Architecture = if ([Environment]::Is64BitProcess) { 'x64' } else { 'x86' }
            ExecutablePath = $Preflight.ExecutablePath
            PublishDirectory = $Preflight.PublishDirectory
            WorkingDirectory = $Preflight.WorkingDirectory
            WorkingDirectoryExists = $Preflight.WorkingDirectoryExists
            ExecutableExists = $Preflight.ExecutableExists
            ExecutableAttributes = $Preflight.ExecutableAttributes
            ExecutableParentAttributes = $Preflight.ExecutableParentAttributes
            ReadAccessConfirmed = $Preflight.ReadAccessConfirmed
            ExecutableFinalPath = $Preflight.ExecutableFinalPath
            DotnetEnvironmentVariables = @(Get-ManualDotnetEnvironmentNames)
            UseShellExecute = $StartInfo.UseShellExecute
            RedirectStandardOutput = $StartInfo.RedirectStandardOutput
            RedirectStandardError = $StartInfo.RedirectStandardError
            ArgumentCount = @($LogicalArguments).Count
            PublishDescriptor = $env:CREATORCRATE_M2_PUBLISH_DESCRIPTOR
        }
    }
    finally {
        $identity.Dispose()
    }
}

function Get-ManualDiagnosticSocialUri {
    param([Parameter(Mandatory = $true)][string]$RepositoryRoot)

    $definitionPath = Join-Path $RepositoryRoot 'helper\windows\tests\OpenLocally.Tests\diagnostic-social-request.json'
    if (-not (Test-Path -LiteralPath $definitionPath -PathType Leaf)) {
        throw "Shared diagnostic social request definition '$definitionPath' does not exist."
    }

    try {
        $definition = Get-Content -LiteralPath $definitionPath -Raw | ConvertFrom-Json -ErrorAction Stop
    }
    catch {
        throw "Shared diagnostic social request definition could not be read: $($_.Exception.Message)"
    }

    if ($null -eq $definition -or $definition.Scheme -cne 'creatorcrate-social' -or $definition.Action -cne 'prepare' -or $definition.Version -cne '1') {
        throw 'Shared diagnostic social request definition has an unsupported social URI envelope.'
    }
    if ([string]::IsNullOrWhiteSpace([string]$definition.Intent) -or [string]$definition.Intent -notmatch '^[A-Za-z0-9_-]{43}$') {
        throw 'Shared diagnostic social request definition has an invalid diagnostic intent.'
    }

    try {
        $origin = [uri][string]$definition.Origin
    }
    catch {
        throw 'Shared diagnostic social request definition has an invalid origin.'
    }
    if (-not $origin.IsAbsoluteUri -or ($origin.Scheme -cne 'http' -and $origin.Scheme -cne 'https') -or $origin.UserInfo.Length -ne 0 -or $origin.AbsolutePath -cne '/' -or $origin.Query.Length -ne 0 -or $origin.Fragment.Length -ne 0) {
        throw 'Shared diagnostic social request definition has an invalid origin.'
    }

    return ('{0}://{1}?v={2}&server={3}&intent={4}' -f $definition.Scheme, $definition.Action, $definition.Version, [uri]::EscapeDataString($origin.AbsoluteUri), $definition.Intent)
}

function Get-ManualTextSha256 {
    param([Parameter(Mandatory = $true)][string]$Text)

    $hasher = [Security.Cryptography.SHA256]::Create()
    try {
        return ([BitConverter]::ToString($hasher.ComputeHash([Text.Encoding]::UTF8.GetBytes($Text))).Replace('-', '').ToLowerInvariant())
    }
    finally {
        $hasher.Dispose()
    }
}

function Format-ManualHelperOutput {
    param([AllowEmptyString()][string]$Output)

    return $Output -replace '(?i)(intent=)[^&\s]+', '$1<redacted>'
}

function Get-ManualTerminationDiagnostics {
    param(
        [Parameter(Mandatory = $true)]$Result
    )

    $diagnostics = [System.Collections.Generic.List[string]]::new()
    if ($Result.TerminatorTimedOut) {
        $diagnostics.Add('terminator_timeout')
    }
    elseif ($null -ne $Result.TerminatorExitCode -and $Result.TerminatorExitCode -ne 0) {
        $diagnostics.Add(('terminator_nonzero:{0}' -f $Result.TerminatorExitCode))
    }
    elseif ($Result.TerminatorStartFailed) {
        $diagnostics.Add('terminator_start_failed')
    }

    if ($Result.ChildExitTimedOut) {
        $diagnostics.Add('child_exit_timeout')
    }

    if ($diagnostics.Count -eq 0) {
        return 'termination_completed'
    }

    return ($diagnostics -join ', ')
}

function New-ManualHelperOutputCapture {
    param(
        [Parameter(Mandatory = $true)][ValidateNotNullOrEmpty()][string]$CapturePath,
        [Parameter(Mandatory = $true)][ValidateNotNullOrEmpty()][string]$Command
    )

    if ($CapturePath -notmatch '^(?:[a-zA-Z]:[\\/]|\\\\)') {
        throw 'CapturePath must be an absolute path.'
    }

    $fullCapturePath = [IO.Path]::GetFullPath($CapturePath)
    $captureDirectory = [IO.Path]::GetDirectoryName($fullCapturePath)
    if ([string]::IsNullOrWhiteSpace($captureDirectory) -or -not (Test-Path -LiteralPath $captureDirectory -PathType Container)) {
        throw "Capture setup failed before helper launch: destination directory does not exist: $captureDirectory"
    }

    $stream = $null
    $writer = $null
    try {
        $stream = [IO.File]::Open($fullCapturePath, [IO.FileMode]::Create, [IO.FileAccess]::ReadWrite, [IO.FileShare]::Read)
        $writer = [IO.StreamWriter]::new($stream, [Text.UTF8Encoding]::new($false))
        $startedUtc = [datetime]::UtcNow
        $writer.WriteLine('=== RUN ===')
        $writer.WriteLine(('started_utc={0}' -f $startedUtc.ToString('o')))
        $writer.WriteLine(('command={0}' -f $Command))
        $writer.Flush()
        $stream.Flush($true)
        return [pscustomobject]@{ Path = $fullCapturePath; Writer = $writer; StartedUtc = $startedUtc; Completed = $false; Closed = $false }
    }
    catch {
        if ($null -ne $writer) { $writer.Dispose() }
        elseif ($null -ne $stream) { $stream.Dispose() }
        throw "Capture setup failed before helper launch for '$fullCapturePath': $($_.Exception.Message)"
    }
}

function Complete-ManualHelperOutputCapture {
    param(
        [Parameter(Mandatory = $true)]$Capture,
        [Parameter(Mandatory = $true)][AllowEmptyString()][string]$StandardOutput,
        [Parameter(Mandatory = $true)][AllowEmptyString()][string]$StandardError,
        [AllowNull()][object]$HelperExitCode,
        [Parameter(Mandatory = $true)][int]$HarnessExitCode,
        [Parameter(Mandatory = $true)][ValidateNotNullOrEmpty()][string]$Outcome
    )

    try {
        $helperExitValue = if ($null -eq $HelperExitCode) { 'unavailable' } else { $HelperExitCode }
        $Capture.Writer.WriteLine('=== HELPER STDOUT ===')
        $Capture.Writer.Write($StandardOutput)
        if ($StandardOutput.Length -gt 0 -and -not ($StandardOutput.EndsWith("`n") -or $StandardOutput.EndsWith("`r"))) { $Capture.Writer.WriteLine() }
        $Capture.Writer.WriteLine('=== HELPER STDERR ===')
        $Capture.Writer.Write($StandardError)
        if ($StandardError.Length -gt 0 -and -not ($StandardError.EndsWith("`n") -or $StandardError.EndsWith("`r"))) { $Capture.Writer.WriteLine() }
        $Capture.Writer.WriteLine('=== EXIT ===')
        $Capture.Writer.WriteLine(('helper_exit_code={0}' -f $helperExitValue))
        $Capture.Writer.WriteLine(('harness_exit_code={0}' -f $HarnessExitCode))
        $Capture.Writer.WriteLine(('outcome={0}' -f $Outcome))
        $Capture.Writer.WriteLine(('ended_utc={0}' -f [datetime]::UtcNow.ToString('o')))
        $Capture.Writer.Flush()
        $Capture.Completed = $true
    }
    finally {
        $Capture.Writer.Dispose()
        $Capture.Closed = $true
    }
}

function Show-ManualHelperFailureReport {
    param(
        [Parameter(Mandatory = $true)][int]$HelperExitCode,
        [Parameter(Mandatory = $true)][AllowEmptyString()][string]$StandardError,
        [string]$CapturePath
    )

    # Presentation is secondary to the helper's exit status and durable capture.
    # Do not parse or reformat stderr: FailureReporter already emitted the bounded,
    # sanitized production diagnostic and the operator must see that exact report.
    try {
        Write-Host ("HELPER_EXIT_CODE={0}" -f $HelperExitCode)
        if (-not [string]::IsNullOrWhiteSpace($CapturePath)) {
            Write-Host ("CAPTURE_ARTIFACT={0}" -f [IO.Path]::GetFullPath($CapturePath))
        }
        Write-Host 'HELPER_FAILURE_REPORT_BEGIN'
        Write-Host $StandardError
        Write-Host 'HELPER_FAILURE_REPORT_END'
    }
    catch {
        # Never let a console/presentation failure mask the authoritative helper failure.
    }
}

function New-ManualFailureDialogReport {
    param(
        [Parameter(Mandatory = $true)][ValidatePattern('^[a-z_]+$')][string]$Platform,
        [Parameter(Mandatory = $true)][ValidatePattern('^[a-z0-9_]+$')][string]$Phase,
        [Parameter(Mandatory = $true)][ValidatePattern('^[a-z0-9_]+$')][string]$StableError,
        [Parameter(Mandatory = $true)][ValidatePattern('^[a-z0-9_]+$')][string]$ErrorClass,
        [string[]]$AdditionalLines = @()
    )

    $lines = @(
        "Platform: $Platform",
        "Phase: $Phase",
        "Stable error: $StableError",
        'Outcome: failed',
        "Error class: $ErrorClass"
    )
    foreach ($line in $AdditionalLines) {
        if (-not [string]::IsNullOrWhiteSpace($line)) { $lines += $line }
    }
    return ($lines -join [Environment]::NewLine)
}

function Get-ManualFailureClassification {
    param([Parameter(Mandatory = $true)][System.Management.Automation.ErrorRecord]$ErrorRecord, [string]$HarnessPhase)

    # Post-capture classification is operation-owned, never inferred from private text.
    if ($HarnessPhase) {
        $classification = switch ($HarnessPhase) {
            { $_ -in @('native_apphost_preflight', 'process_start_info', 'ready_setup', 'launch_context', 'process_setup') } { @('native_host_context_failed', 'host_context', 'native_host_context'); break }
            'process_start' { @('helper_launch_failed', 'process_start', 'helper_launch'); break }
            'capture_finalization' { @('manual_capture_finalize_failed', 'io', 'capture_finalization'); break }
            'cleanup' { @('manual_cleanup_recovery_failed', 'cleanup', 'cleanup_recovery'); break }
            { $_ -in @('capture_initialized', 'stream_setup', 'ready_coordination', 'child_wait', 'output_collection', 'result_coordination') } { @('manual_validation_failed', 'harness', 'manual_validation'); break }
            default { throw 'Unknown fixed harness phase.' }
        }
        return [pscustomobject]@{ Phase = $HarnessPhase; StableError = $classification[0]; ErrorClass = $classification[1]; DetailPhase = $classification[2] }
    }

    $message = [string]$ErrorRecord.Exception.Message
    if ($message -match '(?i)manual workflow is disabled') { return [pscustomobject]@{ Phase = 'harness_enablement'; StableError = 'manual_validation_disabled'; ErrorClass = 'validation' } }
    if ($message -match '(?i)capture') { return [pscustomobject]@{ Phase = 'capture_preflight'; StableError = 'manual_capture_setup_failed'; ErrorClass = 'io' } }
    if ($message -match '(?i)timed out') { return [pscustomobject]@{ Phase = 'preflight_timeout'; StableError = 'manual_preflight_timed_out'; ErrorClass = 'timeout' } }
    if ($message -match '(?i)native apphost preflight|launch context|processstartinfo') { return [pscustomobject]@{ Phase = 'native_host_context'; StableError = 'native_host_context_failed'; ErrorClass = 'host_context' } }
    if ($message -match '(?i)could not start|process start|published helper') { return [pscustomobject]@{ Phase = 'helper_launch'; StableError = 'helper_launch_failed'; ErrorClass = 'process_start' } }
    if ($message -match '(?i)publish') { return [pscustomobject]@{ Phase = 'helper_publication'; StableError = 'helper_publication_failed'; ErrorClass = 'process_setup' } }
    if ($message -match '(?i)recovery|cleanup|restor') { return [pscustomobject]@{ Phase = 'cleanup_recovery'; StableError = 'manual_cleanup_recovery_failed'; ErrorClass = 'cleanup' } }
    return [pscustomobject]@{ Phase = 'manual_validation'; StableError = 'manual_validation_failed'; ErrorClass = 'harness' }
}

function Get-ManualFailureSafeDetail {
    param([Parameter(Mandatory = $true)][string]$Phase)

    switch ($Phase) {
        'harness_enablement' { return 'Detail: Manual validation enablement is required.' }
        'capture_preflight' { return 'Detail: Capture destination could not be created.' }
        'preflight_timeout' { return 'Detail: Parent production-gate preflight timed out.' }
        'native_host_context' { return 'Detail: Expected native host or launch context could not be prepared.' }
        'helper_launch' { return 'Detail: Helper process could not be started.' }
        'helper_publication' { return 'Detail: Helper publication or setup step failed.' }
        'cleanup_recovery' { return 'Detail: Cleanup or recovery step failed.' }
        'capture_finalization' { return 'Detail: Capture finalization could not be completed.' }
        default { return 'Detail: Manual validation harness operation failed.' }
    }
}

function Reserve-ManualFailureDialog {
    if ($script:ManualChildExitUnconfirmed) { return $false }
    if ($script:ManualFailureDialogAttempted) { return $false }
    $script:ManualFailureDialogAttempted = $true
    return $true
}

function Show-ManualFailureDialog {
    param(
        [Parameter(Mandatory = $true)][string]$RepositoryRoot,
        [Parameter(Mandatory = $true)][string]$Platform,
        [Parameter(Mandatory = $true)][string]$Phase,
        [Parameter(Mandatory = $true)][string]$Report
    )

    if (-not (Reserve-ManualFailureDialog)) { return }
    try {
        if ($null -ne $script:OfflineNativePresent) {
            & $script:OfflineNativePresent $Phase $Report
            $script:ManualParentPresentation = 'presented_offline_stub'
            return
        }
        if ($null -eq ('OpenLocally.NativeFailureDialog' -as [type])) {
            Add-Type -Path @((Join-Path $RepositoryRoot 'helper\windows\src\OpenLocally\NativeFailureDialog.cs'), (Join-Path $RepositoryRoot 'helper\windows\src\OpenLocally\NativeOperatorUiHost.cs')) -ErrorAction Stop
        }
        $summary = if ($Platform -eq 'social_preparation') { 'CreatorCrate Social Preparation failed during manual validation.' } else { ('{0} preparation failed during {1}.' -f ($Platform.Substring(0, 1).ToUpperInvariant() + $Platform.Substring(1)), $Phase.Replace('_', ' ')) }
        $outcome = [OpenLocally.NativeFailureDialog]::Show($summary, $Report)
        $script:ManualParentPresentation = $outcome.ToMarker()
    }
    catch {
        $script:ManualParentPresentation = 'failed;stage=unexpected;win32_code=0'
        # Presentation is intentionally best effort: do not replace the
        # authoritative harness failure, capture, or cleanup outcome.
        Write-Warning 'CreatorCrate manual failure dialog could not be displayed.'
    }
}

function Invoke-ManualFailureDialogBoundary {
    param(
        [Parameter(Mandatory = $true)][System.Management.Automation.ErrorRecord]$ErrorRecord,
        [Parameter(Mandatory = $true)][string]$RepositoryRoot,
        [Parameter(Mandatory = $true)][string]$Platform,
        [scriptblock]$Present
    )

    if ($null -ne $script:ManualDurableFailure) {
        Save-ManualHarnessFailure -State $script:ManualDurableFailure -ErrorRecord $ErrorRecord
    }
    if ($script:ManualChildExitUnconfirmed -or $script:ManualFailureDialogAttempted) { return }
    $classification = Get-ManualFailureClassification -ErrorRecord $ErrorRecord
    $report = New-ManualFailureDialogReport -Platform $Platform -Phase $classification.Phase -StableError $classification.StableError -ErrorClass $classification.ErrorClass -AdditionalLines @(Get-ManualFailureSafeDetail -Phase $classification.Phase)
    if ($null -ne $script:ManualDurableFailure -and $null -ne $script:ManualDurableFailure.Primary) {
        $report = New-ManualCompleteFailureReport -State $script:ManualDurableFailure
        $classification.Phase = $script:ManualDurableFailure.Primary.Phase
    }
    if ($null -ne $Present) {
        $script:ManualFailureDialogAttempted = $true
        & $Present $classification.Phase $report
        return
    }
    Show-ManualFailureDialog -RepositoryRoot $RepositoryRoot -Platform $Platform -Phase $classification.Phase -Report $report
}

function Set-ManualAuthoritativeHelperFailure {
    param(
        [Parameter(Mandatory = $true)][int]$HelperExitCode,
        [AllowEmptyString()][string]$StandardOutput = '',
        [AllowEmptyString()][string]$StandardError = '',
        [string]$RepositoryRoot = $script:RepositoryRoot,
        [string]$CapturePath
    )

    if ($HelperExitCode -eq 0) { return }

    $script:ManualAuthoritativeExitCode = $HelperExitCode
    if ($script:ManualChildExitUnconfirmed) { return }
    # Call only after the launched child has exited. A failed attempt is not
    # confirmation; cleanup must not retry after this one fallback attempt.
    $child = Read-ManualPresentationResult -Output $StandardOutput
    $script:ManualChildPresentation = $child.Evidence
    if ($child.Confirmed) {
        $script:ManualFailureDialogAttempted = $true
        return
    }
    if ($script:ManualFailureDialogAttempted) { return }
    $report = New-ManualCompleteFailureReport -State $script:ManualDurableFailure -StandardError $StandardError -Child $child
    if ($null -ne $script:ManualDurableFailure) {
        [void](Write-ManualHarnessEvidence -State $script:ManualDurableFailure -Text ('=== OPERATOR REPORT ===' + [Environment]::NewLine + $report))
    }
    Show-ManualFailureDialog -RepositoryRoot $RepositoryRoot -Platform 'social_preparation' -Phase 'manual_preparation' -Report $report
    if (-not [string]::IsNullOrWhiteSpace($CapturePath)) {
        try { [IO.File]::AppendAllText($CapturePath, ([Environment]::NewLine + 'Child presentation: ' + $child.Evidence + [Environment]::NewLine + 'Parent presentation: ' + $script:ManualParentPresentation + [Environment]::NewLine), [Text.UTF8Encoding]::new($false)) }
        catch { Write-Warning 'Supplemental presentation capture unavailable.' }
    }
}

function Read-ManualSocialFailureReport {
    param([AllowEmptyString()][string]$StandardError)
    # FailureReporter.BuildReport emits one fixed-word headline, then one display
    # report and WriteLine's terminal newline. No other surrounding logs are part
    # of this contract. Validate temporary text in full before promoting anything.
    $text = $StandardError.Replace("`r`n", "`n")
    if ($text.EndsWith("`n")) { $text = $text.Substring(0, $text.Length - 1) }
    if ($text -cmatch '\A[a-z0-9_]{1,64}\n') { $text = $text.Substring($Matches[0].Length) }
    $lines = $text -split "`n"
    if ($lines.Count -gt 128 -or @($lines | Where-Object { $_.Length -gt 320 }).Count) { return '' }
    $word = '[a-z0-9_]{1,64}'
    $flag = '(?:yes|no|unknown)'
    $errorClass = '(?:unexpected|cdp_command|cdp_transport|target_closed|browser_preparation|timeout|authentication_manual_attention|validation)'
    $boundary = '(?:not_started|entered|completed|failed|unknown)'
    $exception = '(?:invalid_operation|io|unauthorized_access|argument|operation_canceled|object_disposed|timeout|websocket_connection|social_preparation_runtime|browser_preparation|cdp_command|cdp_transport|unexpected|unknown)'
    $manual = 'Manual preparation:\n'
    foreach ($name in @('composition', 'consent', 'discovery', 'connection_setup', 'connection', 'browser_setup', 'adapter_invocation', 'runtime_disposal', 'failure')) {
        $manual += '  ' + $name + ':\n'
        if ($name -ne 'failure') { $manual += '    state: ' + $boundary + '\n' }
        switch ($name) {
            'consent' { $manual += '    parent_requested: ' + $flag + '\n    parent_response_accepted: ' + $flag + '\n    decision: (?:continue|cancel|display_failed|unknown)\n    local_presentation: (?:presented_and_dismissed|failed|unknown)\n' }
            'discovery' { $manual += '    result: (?:chrome_not_running|chrome_discovery_missing|chrome_discovery_malformed|unknown)\n' }
            'connection' { $manual += '    result: (?:chrome_connection_cancelled|chrome_approval_timeout|chrome_connection_refused|chrome_approval_denied|chrome_handshake_failed|unknown)\n' }
            'failure' { $manual += '    kind: (?:caught_exception|failure_outcome|disposal_failure|unknown)\n    exception_class: ' + $exception + '\n    disposal_exception_class: ' + $exception + '\n' }
        }
    }
    $count = '(?:[0-9]|1[0-6])'
    $create = 'Create resolution:\n  stage: create_resolution\n  candidate_limit: 16\n  limit_exceeded: (?:yes|no)\n  complete: (?<complete>yes|no)\n'
    $create += '(?:  outcome: (?:root_unavailable|zero_matches|no_usable_candidate|ambiguous|candidate_limit_exceeded|malformed_query|invalid_candidate_identity|malformed_description|stale_description|malformed_geometry|unique_candidate)\n)?'
    foreach ($name in @('candidate_count', 'inspected_count', 'usable_count', 'layout_rejected_count')) { $create += '(?:  ' + $name + ': ' + $count + '\n)?' }
    $create += '(?:  outcome: unknown\n)?(?:  candidate_count: unknown\n)?(?<partial>  Counts are partial; candidate-set inspection is incomplete\.\n)?'
    $grammar = '\ASocial Preparation failed\nPlatform: (?<platform>patreon|x|bluesky|unknown)\nAdapter: \k<platform>_social_preparation\nPhase: ' + $word + '\nStable error: ' + $word + '\nOutcome: failed\nError class: ' + $errorClass + '\n'
    $grammar += '(?:CDP operation: (?:get_document|query_selector|query_selector_all|describe_node|get_box_model|scroll_into_view|set_file_input_files|focus|navigate|dispatch_mouse_event|insert_text|unknown)\nCDP code: (?<code>-?[0-9]{1,10})\nCDP message: (?<message>[^\n]{1,256})\n)?'
    $grammar += '(?:Release ID: (?<release>[0-9]{1,10})\n)?(?:Attempt: (?<attempt>[0-9]{1,10})\n)?'
    $grammar += '(?:' + $create + ')?(?:' + $manual + ')?Checkpoints:\n(?:  ' + $word + ': ' + $flag + '\n){0,16}Target/lifecycle:\n(?:  ' + $word + ': ' + $flag + '\n){0,8}'
    $grammar += '(?:Cleanup:\n  Error class: ' + $errorClass + '\n)?(?:Reporting/persistence:\n  Stable error: ' + $word + '\n(?:  Error class: ' + $errorClass + '\n)?)?'
    # Exact input-name constants used by CommandDispatcher.ManualPreflightFailure.
    # Names are safe; values and arbitrary CREATORCRATE_* identifiers are not.
    $preflightInput = '(?:CREATORCRATE_RUN_X_LIVE_VALIDATION|CREATORCRATE_X_LIVE_IMAGE|CREATORCRATE_RUN_PATREON_LIVE_VALIDATION|CREATORCRATE_PATREON_LIVE_CREATOR_VANITY|CREATORCRATE_PATREON_LIVE_IMAGE_1|CREATORCRATE_PATREON_LIVE_IMAGE_2)'
    $grammar += '(?:(?:Missing input|Invalid input): ' + $preflightInput + '\n)?\z'
    $match = [regex]::Match($text + "`n", $grammar, [Text.RegularExpressions.RegexOptions]::CultureInvariant)
    if (-not $match.Success) { return '' }
    foreach ($name in @('code', 'release', 'attempt')) {
        $group = $match.Groups[$name]; $number = 0
        if ($group.Success -and (-not [int]::TryParse($group.Value, [ref]$number) -or ($name -eq 'release' -and $number -le 0))) { return '' }
    }
    # Singular fields cannot recur within a section (including optional counts).
    $section = ''; $seen = @{}
    foreach ($line in $lines) {
        if ($line -cmatch '^\S.*:$') { $section = $line }
        if ($section -ne 'Manual preparation:' -and $line -cmatch '^  ([^:]+): ') {
            $key = $section + $Matches[1]
            if ($seen.ContainsKey($key)) { return '' }
            $seen[$key] = $true
        }
    }
    if ($match.Groups['complete'].Success) {
        if (-not $seen.ContainsKey('Create resolution:outcome') -or -not $seen.ContainsKey('Create resolution:candidate_count')) { return '' }
        if (($match.Groups['complete'].Value -eq 'no') -ne $match.Groups['partial'].Success) { return '' }
    }
    if ($match.Groups['message'].Success) {
        $message = $match.Groups['message'].Value
        # Mirror SanitizeMessage's Url/Path/Html/Secret/NamedId exclusions and
        # normalization, not a second sanitizer. Loading the net8 production
        # assembly into Windows PowerShell's .NET Framework is not supported.
        $private = '\b[a-z][a-z0-9+.-]*://[^\s;,|]+|(?<!\w)(?:[a-z]:\\|\\\\|/(?!/))[^;,|]+|<|\b(?:[\w-]*(?:token|cookie|secret|csrf)[\w-]*|authorization|auth(?:orization)?|bearer|capability|intent|session(?:[-_ ]?id)?|target(?:[-_ ]?id)?|backend[-_ ]?node[-_ ]?id|node[-_ ]?id|creator(?:[-_ ]?vanity)?|vanity|title|body|description|notes)\b\s*(?::|=)\s*[^;,|]+|\b(?:target|session|backend\s*node|node|frame|object)\s+id\s+[^\s;,|]+'
        $options = [Text.RegularExpressions.RegexOptions]::IgnoreCase -bor [Text.RegularExpressions.RegexOptions]::CultureInvariant
        if ([regex]::IsMatch($message, $private, $options) -or @($message.ToCharArray() | Where-Object { [char]::IsControl($_) }).Count -or $message -match '[;|=]|  ' -or $message -cne $message.Trim()) { return '' }
        # Explicit parent trust-boundary requirement: bare bearer credentials are
        # rejected too; production only redacts the keyed bearer form.
        if ([regex]::IsMatch($message, '\bbearer\s+\S+', $options)) { return '' }
    }
    return ($lines | Where-Object { $_ -cnotmatch '^(Release ID|Attempt): ' }) -join [Environment]::NewLine
}

function New-ManualCompleteFailureReport {
    param($State, [AllowEmptyString()][string]$StandardError = '', $Child)
    if ($null -ne $State) {
        # Result stderr may include parent coordination/capture annotations. Only
        # the drained child stream is a helper candidate; never strip surrounding text.
        if ($State.ChildExitConfirmed -or -not $StandardError) { $StandardError = $State.FinalStandardError }
        if ($null -eq $Child) { $Child = $State.FinalChildPresentation }
    }
    $lines = [System.Collections.Generic.List[string]]::new()
    $helper = Read-ManualSocialFailureReport -StandardError $StandardError
    if ($helper) { $lines.Add($helper) }
    else { $lines.Add('CreatorCrate Social Preparation Failed'); $lines.Add('Helper diagnostic: unavailable') }
    if ($null -ne $State -and $null -ne $State.Primary) {
        $lines.Add('Harness:')
        # Primary remains immutable; the platform belongs to the helper, not a
        # guessed parent diagnostic. Final lifecycle is added separately below.
        $lines.Add(($State.Primary.Report -split '\r?\n' | Where-Object { -not $_.StartsWith('Platform:') }) -join [Environment]::NewLine)
    }
    elseif (-not $helper) { $lines.Add('Stable error: manual_helper_failed'); $lines.Add('Outcome: failed') }
    if ($null -ne $State) {
        $lines.Add('Child started: ' + $(if ($State.ChildStarted) { 'yes' } else { 'no' }))
        $lines.Add('Child exit confirmed: ' + $(if ($State.ChildExitConfirmed) { 'yes' } else { 'no' }))
        $lines.Add('Helper exit code: ' + $(if ($null -eq $State.HelperExitCode) { 'unavailable' } else { $State.HelperExitCode }))
        foreach ($evidence in $State.ReportEvidence.Values) { $lines.Add($evidence) }
    }
    if ($null -ne $Child) {
        $lines.Add('Child presentation: ' + ($Child.Evidence -replace ';session_id=[0-9]+', ''))
    }
    return $lines -join [Environment]::NewLine
}

function Read-ManualPresentationResult {
    param([AllowEmptyString()][string]$Output)
    $unconfirmed = [pscustomobject]@{ Confirmed = $false; Evidence = 'unconfirmed;stage=unexpected;win32_code=0' }
    $records = @($Output -split "\r?\n" | Where-Object { $_.Contains('CREATORCRATE_MANUAL_PRESENTATION') })
    if ($records.Count -ne 1) { return $unconfirmed }
    $stages = 'start|open_input_desktop|set_thread_desktop|register_window_class|create_main_window|create_report_control|create_copy_button|create_close_button|show_window|visibility_check|message_loop|completed|unexpected'
    $pattern = '\ACREATORCRATE_MANUAL_PRESENTATION;state=(presented|failed);stage=(' + $stages + ');win32_code=(0|[1-9][0-9]{0,9});session_id=(0|[1-9][0-9]{0,9});input_desktop=(yes|no);thread_desktop=(yes|no);window_created=(yes|no);window_visible=(yes|no);normal_dismissal=(yes|no)\z'
    $match = [regex]::Match($records[0], $pattern)
    if (-not $match.Success) { return $unconfirmed }
    $code = 0; $session = 0
    if (-not [int]::TryParse($match.Groups[3].Value, [ref]$code) -or -not [int]::TryParse($match.Groups[4].Value, [ref]$session)) { return $unconfirmed }
    $presented = $match.Groups[1].Value -ceq 'presented'
    if ($presented) {
        if ($match.Groups[2].Value -cne 'completed' -or $code -ne 0) { return $unconfirmed }
        foreach ($index in 5..9) { if ($match.Groups[$index].Value -cne 'yes') { return $unconfirmed } }
    }
    elseif ($match.Groups[2].Value -ceq 'completed') { return $unconfirmed }
    return [pscustomobject]@{ Confirmed = $presented; Evidence = $records[0].Substring('CREATORCRATE_MANUAL_PRESENTATION;'.Length) }
}

function Assert-ManualPresentationCoordination {
    $primary = "Social Preparation failed`r`nPlatform: patreon`r`nAdapter: patreon_social_preparation`r`nPhase: manual_preparation`r`nStable error: offline_failure`r`nOutcome: failed`r`nError class: unexpected`r`nCheckpoints:`r`nTarget/lifecycle:"
    $presented = 'CREATORCRATE_MANUAL_PRESENTATION;state=presented;stage=completed;win32_code=0;session_id=1;input_desktop=yes;thread_desktop=yes;window_created=yes;window_visible=yes;normal_dismissal=yes'
    $failed = 'CREATORCRATE_MANUAL_PRESENTATION;state=failed;stage=open_input_desktop;win32_code=5;session_id=1;input_desktop=no;thread_desktop=no;window_created=no;window_visible=no;normal_dismissal=no'
    $savedPresent = $script:OfflineNativePresent
    $savedAttempted = $script:ManualFailureDialogAttempted
    $savedExit = $script:ManualAuthoritativeExitCode
    try {
        foreach ($case in @(
            [pscustomobject]@{ Output = $presented; Count = 0 },
            [pscustomobject]@{ Output = $failed; Count = 1 },
            [pscustomobject]@{ Output = ''; Count = 1 },
            [pscustomobject]@{ Output = 'CREATORCRATE_MANUAL_PRESENTATION;state=presented'; Count = 1 },
            [pscustomobject]@{ Output = "$presented`n$failed"; Count = 1 },
            [pscustomobject]@{ Output = "$presented`n$presented"; Count = 1 },
            [pscustomobject]@{ Output = $presented.Replace('win32_code=0', 'win32_code=9999999999'); Count = 1 },
            [pscustomobject]@{ Output = $presented.Replace('normal_dismissal=yes', 'normal_dismissal=no'); Count = 1 },
            [pscustomobject]@{ Output = $presented.Replace('stage=completed', 'stage=PRIVATE'); Count = 1 },
            [pscustomobject]@{ Output = " $presented"; Count = 1 }
        )) {
            $script:ManualFailureDialogAttempted = $false
            $script:ParserFallbackCount = 0
            $script:ParserFallbackReport = ''
            $script:OfflineNativePresent = { param($Phase, $Report) $script:ParserFallbackCount++; $script:ParserFallbackReport = $Report }
            Set-ManualAuthoritativeHelperFailure -HelperExitCode 17 -StandardOutput $case.Output -StandardError $primary -RepositoryRoot $RepositoryRoot
            if ($case.Count -eq 1 -and -not $script:ParserFallbackReport.Contains($primary)) { throw 'Primary report missing.' }
            if ($script:ParserFallbackCount -ne $case.Count -or $script:ManualAuthoritativeExitCode -ne 17) { throw 'Marker parser coordination failed.' }
            if ($script:ManualChildPresentation.Contains('PRIVATE')) { throw 'Unvalidated marker evidence leaked.' }
        }
    }
    finally {
        $script:OfflineNativePresent = $savedPresent
        $script:ManualFailureDialogAttempted = $savedAttempted
        $script:ManualAuthoritativeExitCode = $savedExit
    }
}

function Complete-ManualCleanupOutcome {
    param(
        [Parameter(Mandatory = $true)][System.Collections.IList]$RecoveryFailures,
        [Parameter(Mandatory = $true)][string]$Workspace,
        [Parameter(Mandatory = $true)][string]$RecoveryCommand
    )

    if ($RecoveryFailures.Count -eq 0) { return }

    if ($null -ne $script:ManualDurableFailure) {
        $script:ManualDurableFailure.Phase = 'cleanup'
        $safeError = [Management.Automation.ErrorRecord]::new([InvalidOperationException]::new('Cleanup failed.'), 'cleanup', [Management.Automation.ErrorCategory]::NotSpecified, $null)
        Save-ManualHarnessFailure -State $script:ManualDurableFailure -ErrorRecord $safeError
        try { Show-ManualFailureDialog -RepositoryRoot $RepositoryRoot -Platform 'patreon' -Phase $script:ManualDurableFailure.Primary.Phase -Report (New-ManualCompleteFailureReport -State $script:ManualDurableFailure) }
        catch { $script:ManualParentPresentation = 'failed;stage=unexpected;win32_code=0' }
        Write-ManualHarnessPresentation -State $script:ManualDurableFailure
    }

    if ($null -ne $script:ManualAuthoritativeExitCode -and $script:ManualAuthoritativeExitCode -ne 0) {
        # Do not emit raw recovery details or replace the helper diagnostic.
        # Cleanup remains recorded by the retained workspace/recovery export.
        Write-Warning 'Manual cleanup or recovery failure was retained as secondary evidence after an authoritative helper failure.'
        return
    }

    # Recovery details can include private paths or values. The outer boundary
    # presents only its classified, bounded report for a standalone failure.
    Write-Warning 'Manual cleanup or recovery failure was retained for recovery.'
    throw "Manual recovery reported $($RecoveryFailures.Count) failure(s) after completing every registry, environment, and cleanup attempt."
}

function Assert-ManualFailureRouting {
    Assert-ManualPresentationCoordination
    $privateFragments = @('C:\Users\Test Person\Private Folder\secret-image-name.png', 'https://private.example/path', 'token=SECRET_VALUE_987', 'Creator Vanity With Spaces')
    $cases = @(
        [pscustomobject]@{ Phase = 'helper_publication'; StableError = 'helper_publication_failed'; ErrorClass = 'process_setup' },
        [pscustomobject]@{ Phase = 'capture_preflight'; StableError = 'manual_capture_setup_failed'; ErrorClass = 'io' },
        [pscustomobject]@{ Phase = 'helper_launch'; StableError = 'helper_launch_failed'; ErrorClass = 'process_start' },
        [pscustomobject]@{ Phase = 'preflight_timeout'; StableError = 'manual_preflight_timed_out'; ErrorClass = 'timeout' },
        [pscustomobject]@{ Phase = 'cleanup_recovery'; StableError = 'manual_cleanup_recovery_failed'; ErrorClass = 'cleanup' }
    )
    foreach ($case in $cases) {
        $report = New-ManualFailureDialogReport -Platform 'patreon' -Phase $case.Phase -StableError $case.StableError -ErrorClass $case.ErrorClass -AdditionalLines @(Get-ManualFailureSafeDetail -Phase $case.Phase)
        if ($report -notmatch [regex]::Escape($case.StableError) -or $report -notmatch '(?m)^Detail: .+$') { throw "Safe failure detail was not retained for $($case.Phase)." }
        foreach ($privateFragment in $privateFragments) { if ($report.Contains($privateFragment)) { throw "Private failure fixture leaked for $($case.Phase)." } }
    }
    foreach ($classificationCase in @(
        [pscustomobject]@{ Message = 'Native apphost preflight [file-exists] failed: C:\\Users\\Test Person\\Private Folder\\secret-image-name.png'; Phase = 'native_host_context' },
        [pscustomobject]@{ Message = 'Parent wrapper published-helper preflight timed out after token=SECRET_VALUE_987'; Phase = 'preflight_timeout' },
        [pscustomobject]@{ Message = 'Workspace cleanup failed after Creator Vanity With Spaces'; Phase = 'cleanup_recovery' }
    )) {
        $errorRecord = [System.Management.Automation.ErrorRecord]::new([InvalidOperationException]::new($classificationCase.Message), 'manual_failure_fixture', [System.Management.Automation.ErrorCategory]::InvalidOperation, $null)
        if ((Get-ManualFailureClassification -ErrorRecord $errorRecord).Phase -ne $classificationCase.Phase) { throw "Manual failure classification did not route $($classificationCase.Phase)." }
    }

    $savedAttempted = $script:ManualFailureDialogAttempted
    $savedAuthoritativeExitCode = $script:ManualAuthoritativeExitCode
    try {
        foreach ($boundaryCase in @(
            [pscustomobject]@{ Message = 'Manual workflow is disabled. Set CREATORCRATE_M2_MANUAL=1 explicitly to run it.'; StableError = 'manual_validation_disabled'; Detail = 'Manual validation enablement is required.' },
            [pscustomobject]@{ Message = 'Native apphost preflight [file-exists] failed: C:\\Users\\Test Person\\Private Folder\\secret-image-name.png'; StableError = 'native_host_context_failed'; Detail = 'Expected native host or launch context could not be prepared.' },
            [pscustomobject]@{ Message = 'Parent wrapper published-helper preflight timed out after token=SECRET_VALUE_987'; StableError = 'manual_preflight_timed_out'; Detail = 'Parent production-gate preflight timed out.' },
            [pscustomobject]@{ Message = 'Workspace cleanup failed after Creator Vanity With Spaces'; StableError = 'manual_cleanup_recovery_failed'; Detail = 'Cleanup or recovery step failed.' }
        )) {
            $script:ManualFailureDialogAttempted = $false
            $script:ManualFailureRoutingPresentationCalls = 0
            $script:ManualFailureRoutingReport = $null
            $authoritativeExitCode = 1
            $errorRecord = [System.Management.Automation.ErrorRecord]::new([InvalidOperationException]::new($boundaryCase.Message), 'manual_failure_fixture', [System.Management.Automation.ErrorCategory]::InvalidOperation, $null)
            Invoke-ManualFailureDialogBoundary -ErrorRecord $errorRecord -RepositoryRoot $RepositoryRoot -Platform 'patreon' -Present { param($phase, $report) $script:ManualFailureRoutingPresentationCalls++; $script:ManualFailureRoutingReport = $report }
            Invoke-ManualFailureDialogBoundary -ErrorRecord $errorRecord -RepositoryRoot $RepositoryRoot -Platform 'patreon' -Present { param($phase, $report) $script:ManualFailureRoutingPresentationCalls++ }
            if ($authoritativeExitCode -ne 1 -or $script:ManualFailureRoutingPresentationCalls -ne 1 -or $script:ManualFailureRoutingReport -notmatch [regex]::Escape($boundaryCase.StableError) -or $script:ManualFailureRoutingReport -notmatch [regex]::Escape($boundaryCase.Detail)) { throw "Manual failure boundary did not preserve failure, detail, or one dialog for $($boundaryCase.StableError)." }
            foreach ($privateFragment in $privateFragments) { if ($script:ManualFailureRoutingReport.Contains($privateFragment)) { throw "Manual failure boundary leaked private fixture for $($boundaryCase.StableError)." } }
        }

        $privateCleanupDetail = 'Workspace cleanup failed after Creator Vanity With Spaces; token=SECRET_VALUE_987; C:\\Users\\Test Person\\Private Folder\\secret-image-name.png'
        $cleanupFailures = [System.Collections.Generic.List[object]]::new()
        $cleanupFailures.Add((New-RecoveryFailure -Phase 'cleanup' -Target 'private-workspace' -Snapshot $null -Detail $privateCleanupDetail)) | Out-Null

        $confirmedMarker = 'CREATORCRATE_MANUAL_PRESENTATION;state=presented;stage=completed;win32_code=0;session_id=0;input_desktop=yes;thread_desktop=yes;window_created=yes;window_visible=yes;normal_dismissal=yes'
        # Helper failed and confirmed presentation: cleanup is secondary.
        $script:ManualFailureDialogAttempted = $false
        $script:ManualAuthoritativeExitCode = $null
        $helperPresentationAttempts = 1
        $outerPresentationAttempts = 0
        $script:ManualFailureRoutingPresentationCalls = 0
        Set-ManualAuthoritativeHelperFailure -HelperExitCode 17 -StandardOutput $confirmedMarker
        Invoke-ManualFailureDialogBoundary -ErrorRecord ([System.Management.Automation.ErrorRecord]::new([InvalidOperationException]::new($privateCleanupDetail), 'manual_cleanup_fixture', [System.Management.Automation.ErrorCategory]::InvalidOperation, $null)) -RepositoryRoot $RepositoryRoot -Platform 'patreon' -Present { param($phase, $report) $script:ManualFailureRoutingPresentationCalls++; $script:ManualFailureRoutingReport = $report }
        $outerPresentationAttempts = $script:ManualFailureRoutingPresentationCalls
        $secondaryCleanupOutput = @(& { Complete-ManualCleanupOutcome -RecoveryFailures $cleanupFailures -Workspace 'private-workspace' -RecoveryCommand 'private recovery command' } 3>&1 | ForEach-Object { $_.ToString() }) -join [Environment]::NewLine
        if (-not $script:ManualFailureDialogAttempted -or $script:ManualAuthoritativeExitCode -ne 17 -or $outerPresentationAttempts -ne 0 -or ($helperPresentationAttempts + $outerPresentationAttempts) -ne 1) { throw 'Combined helper failure and cleanup failure did not preserve exactly one presentation attempt.' }
        if ($secondaryCleanupOutput -notmatch [regex]::Escape('secondary evidence') -or $secondaryCleanupOutput.Contains($privateCleanupDetail) -or $secondaryCleanupOutput.Contains('Creator Vanity With Spaces') -or $secondaryCleanupOutput.Contains('SECRET_VALUE_987')) { throw 'Combined helper cleanup evidence was not safely retained as secondary evidence.' }
        # These are unit-level state checks only. Real exit semantics are covered
        # by the C# spawned-script VerifyManualFailureFullFlow regression.

        # Helper failed and cleanup succeeded: helper exit remains authoritative.
        $script:ManualFailureDialogAttempted = $false
        $script:ManualAuthoritativeExitCode = $null
        Set-ManualAuthoritativeHelperFailure -HelperExitCode 17 -StandardOutput $confirmedMarker
        Complete-ManualCleanupOutcome -RecoveryFailures ([System.Collections.Generic.List[object]]::new()) -Workspace 'unused' -RecoveryCommand 'unused'
        if (-not $script:ManualFailureDialogAttempted -or $script:ManualAuthoritativeExitCode -ne 17) { throw 'Helper failure with successful cleanup did not preserve the helper exit.' }

        # A failed child attempt requires exactly one parent fallback.
        $script:ManualFailureDialogAttempted = $false
        $script:ManualAuthoritativeExitCode = $null
        $savedPresent = $script:OfflineNativePresent
        try {
            $script:OfflineNativePresent = { param($Phase, $Report) }
            Set-ManualAuthoritativeHelperFailure -HelperExitCode 17
        }
        finally { $script:OfflineNativePresent = $savedPresent }
        Complete-ManualCleanupOutcome -RecoveryFailures $cleanupFailures -Workspace 'private-workspace' -RecoveryCommand 'private recovery command' 3>$null
        if (-not $script:ManualFailureDialogAttempted -or $script:ManualAuthoritativeExitCode -ne 17) { throw 'A failed helper presentation attempt allowed cleanup to replace the authoritative helper failure.' }

        # Without a helper failure, cleanup stays authoritative and reaches the outer boundary.
        $script:ManualFailureDialogAttempted = $false
        $script:ManualAuthoritativeExitCode = $null
        $script:ManualFailureRoutingPresentationCalls = 0
        $script:ManualFailureRoutingStandaloneCleanupError = $null
        $standaloneCleanupOutput = @(& {
            try { Complete-ManualCleanupOutcome -RecoveryFailures $cleanupFailures -Workspace 'private-workspace' -RecoveryCommand 'private recovery command' }
            catch { $script:ManualFailureRoutingStandaloneCleanupError = $_ }
        } 3>&1 | ForEach-Object { $_.ToString() }) -join [Environment]::NewLine
        $standaloneCleanupError = $script:ManualFailureRoutingStandaloneCleanupError
        if ($null -eq $standaloneCleanupError) { throw 'Standalone cleanup failure was incorrectly suppressed.' }
        if ($standaloneCleanupOutput -notmatch [regex]::Escape('retained for recovery') -or $standaloneCleanupOutput.Contains($privateCleanupDetail) -or $standaloneCleanupOutput.Contains('Creator Vanity With Spaces') -or $standaloneCleanupOutput.Contains('SECRET_VALUE_987')) { throw 'Standalone cleanup evidence leaked private detail.' }
        Invoke-ManualFailureDialogBoundary -ErrorRecord $standaloneCleanupError -RepositoryRoot $RepositoryRoot -Platform 'patreon' -Present { param($phase, $report) $script:ManualFailureRoutingPresentationCalls++; $script:ManualFailureRoutingReport = $report }
        if ($script:ManualFailureRoutingPresentationCalls -ne 1 -or $script:ManualFailureRoutingReport -notmatch 'manual_cleanup_recovery_failed' -or $script:ManualFailureRoutingReport.Contains($privateCleanupDetail)) { throw 'Standalone cleanup failure did not retain its safe authoritative dialog routing.' }
    }
    finally {
        $script:ManualFailureDialogAttempted = $savedAttempted
        $script:ManualAuthoritativeExitCode = $savedAuthoritativeExitCode
        $script:ManualFailureRoutingStandaloneCleanupError = $null
    }
}

function Write-ManualHarnessEvidence {
    param($State, [string]$Text)
    # Only these script-owned bounded diagnostic records are report material.
    # The durable writer also accepts raw capture records; never merge those.
    if ($null -ne $State.ReportEvidence -and $Text -match '^(Harness supplemental:|Child coordination:|Child output:)') {
        $State.ReportEvidence[$Text] = $Text
    }
    if ($null -eq $State.Capture) { return $false }
    try {
        if (-not $State.Capture.Closed) {
            $State.Capture.Writer.WriteLine($Text)
            $State.Capture.Writer.Flush()
            $State.Capture.Writer.BaseStream.Flush($true)
        }
        else {
            $stream = [IO.File]::Open($State.Capture.Path, [IO.FileMode]::Append, [IO.FileAccess]::Write, [IO.FileShare]::Read)
            try {
                $bytes = [Text.UTF8Encoding]::new($false).GetBytes($Text + [Environment]::NewLine)
                $stream.Write($bytes, 0, $bytes.Length)
                $stream.Flush($true)
            }
            finally { $stream.Dispose() }
        }
        return $true
    }
    catch { return $false } # Physical I/O failure must not become a claim of durability.
}

function Write-ManualHarnessPresentation {
    param($State)
    $presentation = if ($script:ManualParentPresentation -eq 'presented_offline_stub' -or $script:ManualParentPresentation -match '^CREATORCRATE_MANUAL_PRESENTATION;state=presented;') { 'presented' } elseif ($script:ManualParentPresentation) { 'failed' } else { 'not_attempted' }
    [void](Write-ManualHarnessEvidence -State $State -Text ('Parent presentation: state=' + $presentation))
}

function Save-ManualHarnessFailure {
    param($State, [Management.Automation.ErrorRecord]$ErrorRecord)
    $newPrimary = $null -eq $State.Primary
    $classification = Get-ManualFailureClassification -ErrorRecord $ErrorRecord -HarnessPhase $State.Phase
    if ($null -eq $State.Primary) {
        $detail = Get-ManualFailureSafeDetail -Phase $classification.DetailPhase
        $State.Primary = [pscustomobject]@{
            Phase = $State.Phase; StableError = $classification.StableError; ErrorClass = $classification.ErrorClass
            Report = New-ManualFailureDialogReport -Platform 'patreon' -Phase $State.Phase -StableError $classification.StableError -ErrorClass $classification.ErrorClass -AdditionalLines @($detail)
            Record = (@('=== HARNESS FAILURE ===', ('phase=' + $State.Phase), ('stable_error=' + $classification.StableError), 'outcome=failed', ('error_class=' + $classification.ErrorClass), ('detail=' + $detail.Substring(8)), ('child_started=' + $State.ChildStarted.ToString().ToLowerInvariant()), ('child_exit_confirmed=' + $State.ChildExitConfirmed.ToString().ToLowerInvariant())) -join [Environment]::NewLine)
        }
        if ($null -eq $script:ManualAuthoritativeExitCode -or $script:ManualAuthoritativeExitCode -eq 0) { $script:ManualAuthoritativeExitCode = 1 }
    }
    if (-not $State.Persisted) { $State.Persisted = Write-ManualHarnessEvidence -State $State -Text $State.Primary.Record }
    if ($newPrimary -and $State.Persisted -and $State.Capture.Completed) {
        # Failures in caller/outer cleanup occur after stream finalization. Append
        # an authoritative exit update, never rewrite the already-flushed artifact.
        $helperExit = if ($null -eq $State.HelperExitCode) { 'unavailable' } else { $State.HelperExitCode }
        $outcome = if ($State.ChildExitConfirmed -and $null -ne $State.HelperExitCode) { 'helper_completed' } else { 'harness_incomplete' }
        [void](Write-ManualHarnessEvidence -State $State -Text ((@('=== EXIT ===', ('helper_exit_code=' + $helperExit), ('harness_exit_code=' + $script:ManualAuthoritativeExitCode), ('outcome=' + $outcome))) -join [Environment]::NewLine))
    }
    if ($State.Phase -ne $State.Primary.Phase -and -not $State.Secondary.ContainsKey($State.Phase)) {
        $State.Secondary[$State.Phase] = $true
        [void](Write-ManualHarnessEvidence -State $State -Text ('Harness supplemental: phase=' + $State.Phase + '; stable_error=' + $classification.StableError + '; error_class=' + $classification.ErrorClass))
    }
}

function Invoke-ManualHelperPublication {
    param([string]$Project, [string]$Work, [string]$RepositoryRoot, [switch]$ManualValidation)
    $publish = Join-Path $Work 'publish'
    try {
        & dotnet publish $Project -c Release -r win-x64 --self-contained true -p:PublishSingleFile=true --artifacts-path (Join-Path $Work 'artifacts') -o $publish
        $publishExitCode = $LASTEXITCODE
        if ($publishExitCode -ne 0) { throw 'Temporary helper publication failed.' }
        $helper = Join-Path $publish 'OpenLocally.exe'
        if (-not (Test-Path -LiteralPath $helper)) { throw 'Temporary helper publish did not produce OpenLocally.exe.' }
    }
    catch {
        if ($ManualValidation) {
            $report = New-ManualFailureDialogReport -Platform 'patreon' -Phase 'helper_publication' -StableError 'helper_publication_failed' -ErrorClass 'process_setup' -AdditionalLines @(Get-ManualFailureSafeDetail -Phase 'helper_publication')
            Show-ManualFailureDialog -RepositoryRoot $RepositoryRoot -Platform 'patreon' -Phase 'helper_publication' -Report $report
        }
        throw
    }
}

function Invoke-ParentProductionGatePreflight {
    param(
        [Parameter(Mandatory = $true)][string]$Helper,
        [Parameter(Mandatory = $true)][string]$WorkingDirectory,
        [Parameter(Mandatory = $true)][string]$ContextPath,
        [Parameter(Mandatory = $true)][string]$DiagnosticUri,
        [string[]]$LogicalArguments,
        [int]$TimeoutMilliseconds = $ParentProductionGateApprovalTimeoutMilliseconds,
        [int]$TerminatorTimeoutMilliseconds = $ManualWorkflowTerminatorTimeoutMilliseconds,
        [int]$ChildCleanupTimeoutMilliseconds = $ManualWorkflowChildCleanupTimeoutMilliseconds,
        [scriptblock]$StartTerminator,
        [System.Collections.IList]$OwnedProcesses,
        [scriptblock]$RetainTerminator,
        [switch]$CaptureResult,
        [scriptblock]$FinalizeCapture,
        [scriptblock]$BeforeExtendedChildWait,
        [scriptblock]$BeforeHarnessOperation,
        [scriptblock]$StartProcess,
        [string]$CapturePath,
        [string]$CaptureCommand = '<not-recorded>',
        [int]$HarnessExitCode = 1,
        [string]$ManualPlatform,
        [string]$ReadyConsentAssembly,
        [scriptblock]$PresentReady,
        [string]$RepositoryRoot
    )

    $capture = $null
    $process = $null
    $script:ManualDurableFailure = $null
    $processStarted = $false
    $ownedProcessRegistered = $false
    $stdoutRead = $null; $stderrRead = $null
    $stdout = ''; $stderr = ''; $helperExitCode = $null; $result = $null; $childPresentation = $null
    $readyDirectory = $null
    $state = [pscustomobject]@{ Capture = $null; Phase = 'capture_initialized'; Primary = $null; Persisted = $false; Secondary = @{}; ReportEvidence = [ordered]@{}; ChildStarted = $false; ChildExitConfirmed = $false; HelperExitCode = $null; FinalStandardError = ''; FinalChildPresentation = $null }
    try {
    if (-not [string]::IsNullOrWhiteSpace($CapturePath)) {
        try {
            $capture = New-ManualHelperOutputCapture -CapturePath $CapturePath -Command $CaptureCommand
            $state.Capture = $capture
            $script:ManualDurableFailure = $state
        }
        catch {
            if (-not [string]::IsNullOrWhiteSpace($ManualPlatform)) {
                $report = New-ManualFailureDialogReport -Platform $ManualPlatform -Phase 'capture_preflight' -StableError 'manual_capture_setup_failed' -ErrorClass 'io' -AdditionalLines @(Get-ManualFailureSafeDetail -Phase 'capture_preflight')
                Show-ManualFailureDialog -RepositoryRoot $RepositoryRoot -Platform $ManualPlatform -Phase 'capture_preflight' -Report $report
            }
            throw
        }
    }

    $state.Phase = 'native_apphost_preflight'
    if ($BeforeHarnessOperation) { & $BeforeHarnessOperation $state.Phase }
    $preflight = Test-NativeAppHostPreflight -Executable $Helper -WorkingDirectory $WorkingDirectory
    $state.Phase = 'process_start_info'
    if ($BeforeHarnessOperation) { & $BeforeHarnessOperation $state.Phase }
    $startInfo = [System.Diagnostics.ProcessStartInfo]::new()
    $startInfo.FileName = $preflight.ExecutablePath
    $startInfo.WorkingDirectory = $preflight.WorkingDirectory
    $startInfo.UseShellExecute = $false
    $startInfo.CreateNoWindow = $true
    $startInfo.RedirectStandardOutput = $true
    $startInfo.RedirectStandardError = $true
    if ($null -ne $capture) {
        $startInfo.StandardOutputEncoding = [Text.UTF8Encoding]::new($false, $true)
        $startInfo.StandardErrorEncoding = [Text.UTF8Encoding]::new($false, $true)
    }
    $childArgs = if ($null -eq $LogicalArguments) { @($DiagnosticUri) } else { @($LogicalArguments) }
    Set-ManualProcessStartInfoArguments -StartInfo $startInfo -LogicalArguments $childArgs

    $state.Phase = 'ready_setup'
    if ($BeforeHarnessOperation) { & $BeforeHarnessOperation $state.Phase }
    if ($ReadyConsentAssembly) {
        if ($env:CREATORCRATE_M2_MANUAL -cne '1') { throw 'Manual Ready bridge requires explicit manual opt-in.' }
        if ($null -eq ('OpenLocally.ManualReadyConsentParent' -as [type])) {
            # Load this build without locking its temporary publication artifacts during cleanup.
            [void][Reflection.Assembly]::Load([IO.File]::ReadAllBytes($ReadyConsentAssembly))
        }
        $readyId = [guid]::NewGuid().ToString('N')
        $readyDirectory = Join-Path (Split-Path -Parent $ContextPath) ('ready-' + $readyId)
        [void][IO.Directory]::CreateDirectory($readyDirectory)
        $startInfo.EnvironmentVariables['CREATORCRATE_M2_READY_DIRECTORY'] = $readyDirectory
        $startInfo.EnvironmentVariables['CREATORCRATE_M2_READY_ID'] = $readyId
    }

    $state.Phase = 'launch_context'
    if ($BeforeHarnessOperation) { & $BeforeHarnessOperation $state.Phase }
    $context = New-WrapperLaunchContext -Preflight $preflight -StartInfo $startInfo -LogicalArguments $childArgs
    [IO.File]::WriteAllText($ContextPath, ($context | ConvertTo-Json -Compress))

    $state.Phase = 'process_setup'
    if ($BeforeHarnessOperation) { & $BeforeHarnessOperation $state.Phase }
    $process = [System.Diagnostics.Process]::new()
    $process.StartInfo = $startInfo
        $state.Phase = 'process_start'
        if ($BeforeHarnessOperation) { & $BeforeHarnessOperation $state.Phase }
        $started = if ($StartProcess) { & $StartProcess $process } else { $process.Start() }
        if (-not $started) { throw 'Parent wrapper could not start the published helper.' }
        $processStarted = $true
        $state.ChildStarted = $true
        $script:ManualChildExitUnconfirmed = $true
        # Drain both redirected pipes while the child is alive. A full detailed
        # report must not block stderr before the child reaches native UI.
        $state.Phase = 'stream_setup'
        if ($BeforeHarnessOperation) { & $BeforeHarnessOperation $state.Phase }
        $stdoutRead = $process.StandardOutput.ReadToEndAsync()
        if ($BeforeHarnessOperation) { & $BeforeHarnessOperation 'stderr_reader' }
        $stderrRead = $process.StandardError.ReadToEndAsync()
        if ($null -ne $OwnedProcesses) {
            Add-ManualWrapperVerifierOwnedProcess -OwnedProcesses $OwnedProcesses -Role 'parent-preflight-child' -Process $process -WorkingDirectory $WorkingDirectory
            $ownedProcessRegistered = $true
        }
        $timeoutEvidence = ''
        $readyResponded = $false
        $readyCoordinationEvidence = ''
        $waitClock = [Diagnostics.Stopwatch]::StartNew()
        $state.Phase = 'ready_coordination'
        if ($BeforeHarnessOperation) { & $BeforeHarnessOperation $state.Phase }
        while ($readyDirectory -and -not $process.HasExited -and $waitClock.ElapsedMilliseconds -lt $TimeoutMilliseconds) {
            if (-not $readyResponded) {
                $answer = $null
                $readyOperation = 'request_detection'
                try {
                    if ([IO.File]::Exists((Join-Path $readyDirectory 'request.json'))) {
                        # Own this request before any fallible presentation/member access.
                        $readyResponded = $true
                        $readyOperation = 'presentation'
                        $answer = if ($PresentReady) { & $PresentReady $process $readyDirectory $readyId } else { [OpenLocally.ManualReadyConsentParent]::TryPresent($process, $readyDirectory, $readyId) }
                        $readyOperation = 'presentation_result'
                        if ($BeforeHarnessOperation) { & $BeforeHarnessOperation 'ready_presentation_result' }
                        Write-Host ('READY_PARENT_PRESENTATION=' + [OpenLocally.ManualReadyConsentParent]::LastPresentation)
                    }
                }
                catch {
                    $readyResponded = $true
                    $answer = 'DisplayFailed'
                    $readyCoordinationEvidence = 'Ready coordination: state=failed; reason=' + $readyOperation
                }
                if ($null -ne $answer) {
                    try {
                        if (-not $process.HasExited) {
                            if ($BeforeHarnessOperation) { & $BeforeHarnessOperation 'ready_response_publication' }
                            Write-ManualOperatorResponse -RequestId $readyId -Answer $answer -ResponseDirectory $readyDirectory
                        }
                    }
                    catch {
                        # Never retry a possibly published response or re-present UI.
                        # The child's existing bounded missing-response path fails closed.
                        if ($readyCoordinationEvidence) { $readyCoordinationEvidence += '; response_publication=failed' }
                        else { $readyCoordinationEvidence = 'Ready coordination: state=failed; reason=response_publication' }
                    }
                }
            }
            [void]$process.WaitForExit(50)
        }
        $state.Phase = 'child_wait'
        if ($BeforeHarnessOperation) { & $BeforeHarnessOperation $state.Phase }
        $remainingWait = if ($readyDirectory) { [Math]::Max(0, $TimeoutMilliseconds - [int]$waitClock.ElapsedMilliseconds) } else { $TimeoutMilliseconds }
        if (-not $process.WaitForExit($remainingWait)) {
            $termination = Stop-ManualWorkflowProcess -Process $process -TerminatorTimeoutMilliseconds $TerminatorTimeoutMilliseconds -ChildCleanupTimeoutMilliseconds $ChildCleanupTimeoutMilliseconds -StartTerminator $StartTerminator -RetainTerminator $RetainTerminator
            $timeoutEvidence = 'Harness: state=timed_out; ' + (Get-ManualTerminationDiagnostics -Result $termination)
            # Grace expiry records termination evidence, not the end of ownership.
            # Keep both asynchronous drains, the process, and the presentation
            # interlock alive until actual exit; only then classify complete output.
            if (-not $process.HasExited) {
                # Offline verifier seam; production has no callback or further deadline.
                do {
                    if ($null -ne $BeforeExtendedChildWait) { & $BeforeExtendedChildWait $process $termination }
                    # Each observation is bounded; ownership has no abandonment deadline.
                } while (-not $process.WaitForExit(1000))
            }
        }

        $state.ChildExitConfirmed = $true
        $state.Phase = 'output_collection'
        if ($BeforeHarnessOperation) { & $BeforeHarnessOperation $state.Phase }
        $stdout = $stdoutRead.GetAwaiter().GetResult()
        $stderr = $stderrRead.GetAwaiter().GetResult()
        $helperExitCode = $process.ExitCode
        $state.HelperExitCode = $helperExitCode
        if ($null -ne $capture -and $helperExitCode -ne 0) { $script:ManualAuthoritativeExitCode = $helperExitCode }
        $state.Phase = 'result_coordination'
        if ($BeforeHarnessOperation) { & $BeforeHarnessOperation $state.Phase }
        $childPresentation = Read-ManualPresentationResult -Output $stdout
        $state.FinalStandardError = $stderr; $state.FinalChildPresentation = $childPresentation
        $script:ManualChildExitUnconfirmed = $false
        [void](Write-ManualHarnessEvidence -State $state -Text 'Child coordination: child_exit_confirmed=true; output_collection=completed')
        foreach ($pipe in @('stdout', 'stderr')) { [void](Write-ManualHarnessEvidence -State $state -Text ('Child output: stream=' + $pipe + '; state=collected')) }
        # A manual validation's process result is authoritative: presentation and
        # capture must not convert the helper's nonzero result into success.
        $authoritativeHarnessExitCode = $helperExitCode
        if ($timeoutEvidence -and $helperExitCode -eq 0) { $authoritativeHarnessExitCode = 1 }
        $result = [pscustomobject]@{
            LaunchContext = $context
            ExitCode = $helperExitCode
            HarnessExitCode = $authoritativeHarnessExitCode
            StandardOutput = $stdout
            StandardError = $stderr
            ChildExitConfirmed = $true
            ChildPresentation = $childPresentation
            CaptureEvidence = ''
        }
        if ($timeoutEvidence) { $result.StandardError += [Environment]::NewLine + $timeoutEvidence }
        if ($readyCoordinationEvidence) { $result.StandardError += [Environment]::NewLine + $readyCoordinationEvidence }
        if ($timeoutEvidence) { $state.ReportEvidence['timeout'] = $timeoutEvidence }
        if ($readyCoordinationEvidence) { $state.ReportEvidence['ready'] = $readyCoordinationEvidence }
        if ($CaptureResult) {
            return $result
        }
        if ($timeoutEvidence) {
            if (-not [string]::IsNullOrWhiteSpace($ManualPlatform)) {
                Set-ManualAuthoritativeHelperFailure -HelperExitCode $result.HarnessExitCode -StandardOutput $result.StandardOutput -StandardError $result.StandardError -RepositoryRoot $RepositoryRoot
            }
            throw ('Parent wrapper published-helper preflight timed out after {0} milliseconds; child_exit_confirmed. {1}' -f $TimeoutMilliseconds, $timeoutEvidence)
        }
        if ($process.ExitCode -eq 0 -or $stdout.Length -ne 0 -or $stderr.Trim() -cne 'production_adapters_unavailable') {
            throw ("Parent wrapper published-helper preflight did not reach the production adapter gate. Exit code: {0}; stdout: {1}; stderr: {2}" -f $process.ExitCode, (Format-ManualHelperOutput $stdout), (Format-ManualHelperOutput $stderr))
        }

        Write-Host 'Parent wrapper: production_adapters_unavailable'
    }
    catch {
        if ($null -eq $capture) { throw }
        # Snapshot only safe script-owned strings BEFORE any unwind, wait or UI gate.
        Save-ManualHarnessFailure -State $state -ErrorRecord $_
        if ($processStarted) {
            # Establish missing drains before waiting. Never dispose an unconfirmed child.
            $exitConfirmed = $false
            $discardOutput = @{}
            $terminationRequested = $false
            do {
                foreach ($pipe in @('stdout', 'stderr')) {
                    try {
                        $read = if ($pipe -eq 'stdout') { $stdoutRead } else { $stderrRead }
                        $reader = if ($pipe -eq 'stdout') { $process.StandardOutput } else { $process.StandardError }
                        if ($null -eq $read) { $read = $reader.ReadToEndAsync() }
                        if ($read.IsFaulted -or $read.IsCanceled) {
                            $state.Phase = 'stream_setup'
                            $safeError = [Management.Automation.ErrorRecord]::new([IO.IOException]::new('Reader failed.'), 'reader', [Management.Automation.ErrorCategory]::ReadError, $null)
                            Save-ManualHarnessFailure -State $state -ErrorRecord $safeError
                            $discardOutput[$pipe] = $true
                            $read = $reader.BaseStream.CopyToAsync([IO.Stream]::Null)
                        }
                        if ($pipe -eq 'stdout') { $stdoutRead = $read } else { $stderrRead = $read }
                    }
                    catch {
                        $state.Phase = 'stream_setup'; Save-ManualHarnessFailure -State $state -ErrorRecord $_
                        # If a pipe cannot be drained at all, request bounded termination;
                        # grace expiry still cannot release process ownership.
                        if (-not $terminationRequested) {
                            $terminationRequested = $true
                            try { $null = Stop-ManualWorkflowProcess -Process $process -TerminatorTimeoutMilliseconds $TerminatorTimeoutMilliseconds -ChildCleanupTimeoutMilliseconds $ChildCleanupTimeoutMilliseconds -StartTerminator $StartTerminator -RetainTerminator $RetainTerminator }
                            catch { $state.Phase = 'child_wait'; Save-ManualHarnessFailure -State $state -ErrorRecord $_ }
                        }
                    }
                }
                $state.Phase = 'child_wait'
                try { $exitConfirmed = $process.WaitForExit(1000) }
                catch { Save-ManualHarnessFailure -State $state -ErrorRecord $_; Start-Sleep -Milliseconds 100 }
            } while (-not $exitConfirmed)
            $state.ChildExitConfirmed = $true
            $state.Phase = 'output_collection'
            try { $collected = $stdoutRead.GetAwaiter().GetResult(); if (-not $discardOutput.ContainsKey('stdout')) { $stdout = [string]$collected } }
            catch { $discardOutput['stdout'] = $true; Save-ManualHarnessFailure -State $state -ErrorRecord $_ }
            try { $collected = $stderrRead.GetAwaiter().GetResult(); if (-not $discardOutput.ContainsKey('stderr')) { $stderr = [string]$collected } }
            catch { $discardOutput['stderr'] = $true; Save-ManualHarnessFailure -State $state -ErrorRecord $_ }
            $state.Phase = 'result_coordination'
            try { $helperExitCode = $process.ExitCode; $state.HelperExitCode = $helperExitCode }
            catch { Save-ManualHarnessFailure -State $state -ErrorRecord $_ }
            try {
                $childPresentation = Read-ManualPresentationResult -Output $stdout
                if ($childPresentation.Confirmed) { $script:ManualFailureDialogAttempted = $true }
                [void](Write-ManualHarnessEvidence -State $state -Text ('Child presentation: ' + $childPresentation.Evidence))
            }
            catch { Save-ManualHarnessFailure -State $state -ErrorRecord $_ }
            $script:ManualChildExitUnconfirmed = $false
            [void](Write-ManualHarnessEvidence -State $state -Text 'Child coordination: child_exit_confirmed=true; output_collection=completed')
            foreach ($pipe in @('stdout', 'stderr')) {
                $availability = if ($discardOutput.ContainsKey($pipe)) { 'unavailable' } else { 'collected' }
                [void](Write-ManualHarnessEvidence -State $state -Text ('Child output: stream=' + $pipe + '; state=' + $availability))
            }
            $state.FinalStandardError = $stderr; $state.FinalChildPresentation = $childPresentation
        }
        if ($null -ne $helperExitCode -and $helperExitCode -ne 0) { $script:ManualAuthoritativeExitCode = $helperExitCode }
        # Durable primary evidence already exists even if either interlock denies UI.
        try {
            $report = New-ManualCompleteFailureReport -State $state -StandardError $stderr -Child $childPresentation
            [void](Write-ManualHarnessEvidence -State $state -Text ('=== OPERATOR REPORT ===' + [Environment]::NewLine + $report))
            if ($ManualPlatform) { Show-ManualFailureDialog -RepositoryRoot $RepositoryRoot -Platform $ManualPlatform -Phase $state.Primary.Phase -Report $report }
        }
        catch { $script:ManualParentPresentation = 'failed;stage=unexpected;win32_code=0' }
        Write-ManualHarnessPresentation -State $state
        if ($CaptureResult) {
            $result = [pscustomobject]@{
                LaunchContext = $null; ExitCode = $helperExitCode; HarnessExitCode = $script:ManualAuthoritativeExitCode
                StandardOutput = $stdout; StandardError = $state.Primary.Report + [Environment]::NewLine + $stderr
                ChildExitConfirmed = $state.ChildExitConfirmed; ChildPresentation = $childPresentation
                CaptureEvidence = ''; HarnessFailure = $true
            }
            return $result
        }
        throw 'Manual validation harness operation failed.'
    }
    finally {
        if ($null -ne $capture -and -not $capture.Completed) {
            $state.Phase = 'capture_finalization'
            try {
                if ($BeforeHarnessOperation) { & $BeforeHarnessOperation $state.Phase }
                if ($null -ne $FinalizeCapture) { & $FinalizeCapture $capture }
                else {
                    $exitCode = if ($null -ne $state.Primary) { $script:ManualAuthoritativeExitCode } elseif ($null -ne $result) { $result.HarnessExitCode } else { $HarnessExitCode }
                    $outcome = if ($state.ChildExitConfirmed -and $null -ne $helperExitCode) { 'helper_completed' } else { 'harness_incomplete' }
                    $capturedError = if ($null -ne $result -and $null -eq $state.Primary) { $result.StandardError } else { $stderr }
                    Complete-ManualHelperOutputCapture -Capture $capture -StandardOutput $stdout -StandardError $capturedError -HelperExitCode $helperExitCode -HarnessExitCode $exitCode -Outcome $outcome
                }
            }
            catch {
                Save-ManualHarnessFailure -State $state -ErrorRecord $_
                try { $capture.Writer.Dispose() } catch { }
                $capture.Closed = $true
                Save-ManualHarnessFailure -State $state -ErrorRecord $_
                if ($null -ne $result) {
                    $result.CaptureEvidence = 'Capture: state=failed; error_class=io'
                    $result.StandardError += [Environment]::NewLine + $result.CaptureEvidence
                    if ($result.HarnessExitCode -eq 0) { $result.HarnessExitCode = 1 }
                }
            }
        }
        $state.Phase = 'cleanup'
        try {
            if ($BeforeHarnessOperation) { & $BeforeHarnessOperation $state.Phase }
        }
        catch { Save-ManualHarnessFailure -State $state -ErrorRecord $_ }
        finally {
            if ($null -ne $process -and (-not $processStarted -or ($state.ChildExitConfirmed -and -not $ownedProcessRegistered))) {
                try { $process.Dispose() }
                catch { Save-ManualHarnessFailure -State $state -ErrorRecord $_ }
            }
        }
        if ($null -ne $state.Primary -and $null -ne $result -and $result.HarnessExitCode -eq 0) { $result.HarnessExitCode = 1 }
        if ($null -ne $state.Primary -and $null -ne $result -and $null -ne $result.ChildPresentation -and $result.ChildPresentation.Confirmed) { $script:ManualFailureDialogAttempted = $true }
        if ($null -ne $state.Primary -and $ManualPlatform -and -not $script:ManualFailureDialogAttempted -and -not $script:ManualChildExitUnconfirmed) {
            try {
                $report = New-ManualCompleteFailureReport -State $state -StandardError $stderr -Child $childPresentation
                [void](Write-ManualHarnessEvidence -State $state -Text ('=== OPERATOR REPORT ===' + [Environment]::NewLine + $report))
                Show-ManualFailureDialog -RepositoryRoot $RepositoryRoot -Platform $ManualPlatform -Phase $state.Primary.Phase -Report $report
            }
            catch { $script:ManualParentPresentation = 'failed;stage=unexpected;win32_code=0' }
            Write-ManualHarnessPresentation -State $state
        }
        $state.Phase = 'result_coordination'
    }

    return $context
}

function Assert-ManualCoordinationDefects {
    param([string]$Scenario)
    $root = Join-Path ([IO.Path]::GetTempPath()) ('CreatorCrate-coordination-' + [guid]::NewGuid().ToString('N'))
    [void][IO.Directory]::CreateDirectory($root)
    $owned = [System.Collections.Generic.List[object]]::new()
    $release = Join-Path $root 'release'
    $ready = Join-Path $root 'ready'
    $late = $Scenario.StartsWith('late_')
    $captureFails = $Scenario.StartsWith('capture_') -or $Scenario -eq 'late_capture_failed'
    $confirmed = $Scenario.EndsWith('_confirmed')
    $marker = if ($confirmed) { 'CREATORCRATE_MANUAL_PRESENTATION;state=presented;stage=completed;win32_code=0;session_id=1;input_desktop=yes;thread_desktop=yes;window_created=yes;window_visible=yes;normal_dismissal=yes' } else { 'CREATORCRATE_MANUAL_PRESENTATION;state=failed;stage=open_input_desktop;win32_code=5;session_id=1;input_desktop=no;thread_desktop=no;window_created=no;window_visible=no;normal_dismissal=no' }
    $primary = "Social Preparation failed`r`nPlatform: patreon`r`nPhase: manual_preparation`r`nStable error: offline_failure`r`nOutcome: failed`r`nError class: unexpected`r`nCheckpoints:`r`n  output_drained: yes`r`nTarget/lifecycle:`r`n  child_owned: yes`r`n"
    if ($Scenario -eq 'late_missing') { $marker = '' }
    if ($Scenario -eq 'late_malformed') { $marker += ';state=presented' }
    $burst = ('extended-output-' * 8192)
    $script:CoordinationExtendedWaitObserved = $false
    $script:CoordinationFallbackCount = 0
    $script:CoordinationFallbackReport = ''
    $script:OfflineNativePresent = {
        param($phase, $report)
        foreach ($entry in $owned) { if (-not $entry.Process.HasExited) { throw 'Parent presentation raced a live child.' } }
        $script:CoordinationFallbackCount++
        $script:CoordinationFallbackReport = $report
    }
    try {
        $child = Join-Path $root 'child.ps1'
        [IO.File]::WriteAllText((Join-Path $root 'report'), $primary)
        [IO.File]::WriteAllText($child, @'
param($Root, $Marker, $Late)
[Console]::Error.Write([IO.File]::ReadAllText((Join-Path $Root 'report')))
[IO.File]::WriteAllText((Join-Path $Root 'ready'), 'ready')
if ($Late -eq 'yes') {
    while (-not [IO.File]::Exists((Join-Path $Root 'extended'))) { Start-Sleep -Milliseconds 10 }
    $burst = ('extended-output-' * 8192)
    [Console]::Out.WriteLine($burst)
    [Console]::Error.Write($burst)
    [IO.File]::WriteAllText((Join-Path $Root 'drained'), 'drained')
}
$deadline = [DateTime]::UtcNow.AddSeconds(20)
while (-not [IO.File]::Exists((Join-Path $Root 'release')) -and [DateTime]::UtcNow -lt $deadline) { Start-Sleep -Milliseconds 10 }
[Console]::Out.WriteLine($Marker)
[Console]::Error.Write('final-stderr')
exit 17
'@)
        $args = @{
            Helper = (Join-Path $PSHOME 'powershell.exe'); WorkingDirectory = $root
            ContextPath = (Join-Path $root 'context.json'); DiagnosticUri = 'unused'
            LogicalArguments = @('-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', $child, $root, $marker, $(if ($late) { 'yes' } else { 'no' }))
            CaptureResult = $true; CapturePath = (Join-Path $root 'capture.txt'); OwnedProcesses = $owned
            RepositoryRoot = $RepositoryRoot
            TimeoutMilliseconds = 1500; ChildCleanupTimeoutMilliseconds = 3000
        }
        if ($captureFails) {
            $args.FinalizeCapture = {
                param($capture)
                if (-not $owned[0].Process.HasExited) { throw 'Capture injection preceded exit.' }
                # Fail the real writer only after process completion and collection.
                $capture.Writer.Dispose()
                Complete-ManualHelperOutputCapture -Capture $capture -StandardOutput 'unused' -StandardError 'unused' -HelperExitCode 17 -HarnessExitCode 17 -Outcome 'helper_completed'
            }
        }
        if ($Scenario.StartsWith('capture_')) {
            [IO.File]::WriteAllText($release, 'release')
            $args.TimeoutMilliseconds = 10000
        }
        else {
            $args.StartTerminator = {
                param($process)
                $deadline = [datetime]::UtcNow.AddSeconds(5)
                while (-not [IO.File]::Exists($ready) -and [datetime]::UtcNow -lt $deadline) { Start-Sleep -Milliseconds 10 }
                if (-not [IO.File]::Exists($ready) -or $process.HasExited) { throw 'Delayed child fixture was not alive and ready.' }
                $errorRecord = [System.Management.Automation.ErrorRecord]::new([InvalidOperationException]::new('offline timeout'), 'offline', [System.Management.Automation.ErrorCategory]::OperationTimeout, $null)
                Invoke-ManualFailureDialogBoundary -ErrorRecord $errorRecord -RepositoryRoot $RepositoryRoot -Platform 'patreon' -Present { throw 'Outer presentation boundary entered while child alive.' }
                if ((Reserve-ManualFailureDialog) -or $script:ManualFailureDialogAttempted -or $script:CoordinationFallbackCount -ne 0) { throw 'Live child lost presentation ownership.' }
                Write-Host 'COORDINATION_WHILE_ALIVE_FALLBACKS=0'
                if ($Scenario -eq 'timeout_killed') { $process.Kill() }
                elseif (-not $late) { [IO.File]::WriteAllText($release, 'release') }
                if ($Scenario -ne 'timeout_killed') { throw 'Injected termination failure with private path and token.' }
            }
            if ($late) {
                $args.ChildCleanupTimeoutMilliseconds = 50
                $args.BeforeExtendedChildWait = {
                    param($process, $termination)
                    if (-not $termination.ChildExitTimedOut -or -not $termination.TerminatorStartFailed -or $process.HasExited -or $null -ne $result -or -not $script:ManualChildExitUnconfirmed) { throw 'Coordinator did not retain unresolved child ownership after grace.' }
                    $errorRecord = [System.Management.Automation.ErrorRecord]::new([InvalidOperationException]::new('offline grace expiry'), 'offline', [System.Management.Automation.ErrorCategory]::OperationTimeout, $null)
                    Invoke-ManualFailureDialogBoundary -ErrorRecord $errorRecord -RepositoryRoot $RepositoryRoot -Platform 'patreon' -Present { throw 'Fallback raced late child.' }
                    if ((Reserve-ManualFailureDialog) -or $script:ManualFailureDialogAttempted -or $script:CoordinationFallbackCount -ne 0) { throw 'Late child lost presentation ownership.' }
                    if ($script:CoordinationExtendedWaitObserved) {
                        # A full extended observation elapsed in the real coordinator.
                        Write-Host 'COORDINATION_EXTENDED_WAIT_REENTERED=1;returned:false;fallbacks:0'
                        [IO.File]::WriteAllText($release, 'release')
                        return
                    }
                    # Release pipe traffic only AFTER grace. Both writes exceed pipe
                    # capacity, so the child acknowledgment proves live async drains.
                    [IO.File]::WriteAllText((Join-Path $root 'extended'), 'extended')
                    $deadline = [datetime]::UtcNow.AddSeconds(10)
                    while (-not [IO.File]::Exists((Join-Path $root 'drained')) -and [datetime]::UtcNow -lt $deadline) { Start-Sleep -Milliseconds 10 }
                    if (-not [IO.File]::Exists((Join-Path $root 'drained')) -or $process.HasExited -or $null -ne $result) { throw 'Extended wait stopped stream draining or finalized early.' }
                    $script:CoordinationExtendedWaitObserved = $true
                    Write-Host 'COORDINATION_AFTER_GRACE=alive:true;active:true;returned:false;fallbacks:0;drains:live'
                }
            }
        }
        $result = $null
        $failure = $null
        try { $result = Invoke-ParentProductionGatePreflight @args }
        catch { $failure = $_ }
        if ($null -ne $failure) { throw $failure }
        if (-not $result.ChildExitConfirmed -or -not $owned[0].Process.HasExited -or -not $result.StandardError.StartsWith($primary)) { throw 'Completed result lost exit or full primary report.' }
        $expectedOutput = $(if ($late) { $burst + [Environment]::NewLine } else { '' }) + $marker + [Environment]::NewLine
        if ($Scenario -ne 'timeout_killed' -and ($result.ExitCode -ne 17 -or $result.HarnessExitCode -ne 17 -or $result.StandardOutput -cne $expectedOutput -or $result.ChildPresentation.Confirmed -ne $confirmed)) { throw 'Completed result lost authoritative exit or marker.' }
        if ($captureFails -and ($result.CaptureEvidence -cne 'Capture: state=failed; error_class=io' -or -not $result.StandardError.Contains($result.CaptureEvidence))) { throw 'Capture failure was not supplemental.' }
        if (($late -or $Scenario.StartsWith('timeout_')) -and -not $result.StandardError.Contains('Harness: state=timed_out;')) { throw 'Timeout evidence was lost.' }
        if ($late) {
            $expectedError = $primary + $burst + 'final-stderr' + [Environment]::NewLine + 'Harness: state=timed_out; terminator_start_failed, child_exit_timeout'
            if ($captureFails) { $expectedError += [Environment]::NewLine + 'Capture: state=failed; error_class=io' }
            if (-not $script:CoordinationExtendedWaitObserved -or $script:ManualChildExitUnconfirmed -or $result.StandardError -cne $expectedError) { throw 'Late result lost complete output or grace evidence.' }
            Write-Host "COORDINATION_COMPLETE_OUTPUT=stdout:$($expectedOutput.Length);stderr_primary:$($primary.Length);burst_per_stream:$($burst.Length)"
        }
        Set-ManualAuthoritativeHelperFailure -HelperExitCode $result.HarnessExitCode -StandardOutput $result.StandardOutput -StandardError $result.StandardError -RepositoryRoot $RepositoryRoot
        $expected = if ($confirmed) { 0 } else { 1 }
        if ($script:CoordinationFallbackCount -ne $expected -or ($expected -eq 1 -and -not $script:CoordinationFallbackReport.Contains('Helper diagnostic: unavailable'))) { throw 'Post-exit fallback trusted malformed stderr or duplicated presentation.' }
        if ($expected -eq 1 -and (-not $script:CoordinationFallbackReport.Contains(($result.ChildPresentation.Evidence -replace ';session_id=[0-9]+', '')) -or $script:CoordinationFallbackReport.Contains('extended-output-') -or $script:CoordinationFallbackReport.Contains('final-stderr'))) { throw 'Fallback lost safe evidence or included raw stream data.' }
        $cleanupError = [System.Management.Automation.ErrorRecord]::new([IO.IOException]::new('private capture path token'), 'offline', [System.Management.Automation.ErrorCategory]::WriteError, $null)
        Invoke-ManualFailureDialogBoundary -ErrorRecord $cleanupError -RepositoryRoot $RepositoryRoot -Platform 'patreon' -Present { throw 'Cleanup duplicated presentation.' }
        Complete-ManualCleanupOutcome -RecoveryFailures @([pscustomobject]@{ Phase = 'cleanup'; Detail = 'private capture path token' }) -Workspace 'private' -RecoveryCommand 'private'
        if ($script:ManualAuthoritativeExitCode -ne $result.HarnessExitCode -or $script:CoordinationFallbackCount -ne $expected -or $result.StandardError.Contains('private')) { throw 'Secondary failure replaced exit or leaked private data.' }
        Write-Host "COORDINATION_PASS=$Scenario;fallbacks=$expected;helper_exit=$($result.ExitCode)"
        return $result.HarnessExitCode
    }
    finally {
        if ($readyDirectory -and $processStarted -and $process.HasExited) {
            # This unique directory belongs exclusively to this child; never reuse a response.
            Remove-Item -LiteralPath $readyDirectory -Recurse -Force
        }
        # Test ownership only: always release/kill the offline child before deleting fixtures.
        [IO.File]::WriteAllText($release, 'release')
        foreach ($entry in $owned) {
            if (-not $entry.Process.WaitForExit(5000)) { $entry.Process.Kill(); [void]$entry.Process.WaitForExit(5000) }
            $entry.Process.Dispose()
        }
        foreach ($file in [IO.Directory]::GetFiles($root)) { [IO.File]::Delete($file) }
        [IO.Directory]::Delete($root)
    }
}

function Assert-ManualHelperOutputCapture {
    if ($PSVersionTable.PSVersion.Major -ne 5 -or $PSVersionTable.PSVersion.Minor -ne 1) {
        throw "Manual helper output capture verification must run in Windows PowerShell 5.1; found $($PSVersionTable.PSVersion)."
    }

    $root = Join-Path ([IO.Path]::GetTempPath()) ($ManualWorkspacePrefix + 'helper-capture-' + [guid]::NewGuid().ToString('N'))
    $helperScript = Join-Path $root 'fake-helper.ps1'
    $startedPath = Join-Path $root 'helper-started'
    $capturePath = Join-Path $root 'helper-capture.txt'
    $privateName = 'CREATORCRATE_CAPTURE_PRIVATE_TEST'
    $privateSnapshot = Get-EnvironmentSnapshot -Name $privateName
    $expectedStdout = ('stdout; Unicode=Ω; semicolon=one;two' + [Environment]::NewLine + 'stdout second line')
    $expectedStderr = ('diagnostic; operation=DOM.click; code=-32000; message=é漢' + [Environment]::NewLine + 'detail=multiline; retained=true')

    New-Item -ItemType Directory -Path $root | Out-Null
    try {
        @'
param([Parameter(Mandatory = $true)][string]$StartedPath)
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
[Console]::Error.Write('diagnostic; operation=DOM.click; code=-32000; message=é漢' + [Environment]::NewLine + 'detail=multiline; retained=true')
[Console]::Out.Write('stdout; Unicode=Ω; semicolon=one;two' + [Environment]::NewLine + 'stdout second line')
[IO.File]::WriteAllText($StartedPath, 'started', [Text.UTF8Encoding]::new($false))
exit 17
'@ | Set-Content -LiteralPath $helperScript -Encoding UTF8

        $withoutCapture = Invoke-ParentProductionGatePreflight -Helper (Join-Path $PSHOME 'powershell.exe') -WorkingDirectory $root -ContextPath (Join-Path $root 'without-capture-context.json') -DiagnosticUri 'unused' -LogicalArguments @('-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', $helperScript, '-StartedPath', $startedPath) -CaptureResult
        if ($withoutCapture.ExitCode -ne 17 -or $withoutCapture.StandardOutput -cne $expectedStdout -or $withoutCapture.StandardError -cne $expectedStderr -or (Test-Path -LiteralPath $capturePath)) {
            throw 'The non-capture helper launch behavior changed.'
        }

        Set-Item -LiteralPath ("Env:{0}" -f $privateName) -Value 'private-token; must-not-be-captured'
        $captured = Invoke-ParentProductionGatePreflight -Helper (Join-Path $PSHOME 'powershell.exe') -WorkingDirectory $root -ContextPath (Join-Path $root 'capture-context.json') -DiagnosticUri 'unused' -LogicalArguments @('-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', $helperScript, '-StartedPath', $startedPath) -CaptureResult -CapturePath $capturePath -CaptureCommand '--validate-capture-fixture' -HarnessExitCode 0
        if ($captured.ExitCode -ne 17 -or $captured.StandardOutput -cne $expectedStdout -or $captured.StandardError -cne $expectedStderr -or -not (Test-Path -LiteralPath $capturePath -PathType Leaf)) {
            throw 'The captured helper result was not retained exactly.'
        }

        $captureText = [IO.File]::ReadAllText($capturePath, [Text.UTF8Encoding]::new($false))
        $expectedStreamSections = ('=== HELPER STDOUT ===' + [Environment]::NewLine + $expectedStdout + [Environment]::NewLine + '=== HELPER STDERR ===' + [Environment]::NewLine + $expectedStderr + [Environment]::NewLine + '=== EXIT ===')
        if (-not $captureText.Contains($expectedStreamSections)) {
            throw 'Capture artifact did not preserve the exact ordered stdout and stderr sections.'
        }
        if ($captureText.Contains('=== HARNESS FAILURE ===')) { throw 'Successful harness capture fabricated a harness failure.' }
        if ($captured.HarnessExitCode -ne 17) { throw 'The helper nonzero exit code was not preserved as the harness result.' }
        foreach ($required in @('=== RUN ===', 'command=--validate-capture-fixture', '=== HELPER STDOUT ===', $expectedStdout, '=== HELPER STDERR ===', $expectedStderr, '=== EXIT ===', 'helper_exit_code=17', 'harness_exit_code=17', 'outcome=helper_completed', 'started_utc=', 'ended_utc=')) {
            if (-not $captureText.Contains($required)) { throw "Capture artifact omitted required exact content: $required" }
        }
        if ($captureText.Contains((Get-Item -LiteralPath ("Env:{0}" -f $privateName)).Value)) {
            throw 'Capture artifact echoed a process-local private input.'
        }

        $presented = @(& {
            Show-ManualHelperFailureReport -HelperExitCode $captured.ExitCode -StandardError $captured.StandardError -CapturePath $capturePath
        } 6>&1 | ForEach-Object { $_.ToString() }) -join [Environment]::NewLine
        foreach ($required in @('HELPER_EXIT_CODE=17', ("CAPTURE_ARTIFACT={0}" -f [IO.Path]::GetFullPath($capturePath)), 'HELPER_FAILURE_REPORT_BEGIN', $expectedStderr, 'HELPER_FAILURE_REPORT_END')) {
            if (-not $presented.Contains($required)) { throw "Manual failure presentation omitted required content: $required" }
        }
        if ($presented.Contains((Get-Item -LiteralPath ("Env:{0}" -f $privateName)).Value)) {
            throw 'Manual failure presentation echoed a process-local private input.'
        }

        Remove-Item -LiteralPath $startedPath -Force
        $captureSetupFailure = $null
        try {
            Invoke-ParentProductionGatePreflight -Helper (Join-Path $PSHOME 'powershell.exe') -WorkingDirectory $root -ContextPath (Join-Path $root 'failed-capture-context.json') -DiagnosticUri 'unused' -LogicalArguments @('-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', $helperScript, '-StartedPath', $startedPath) -CaptureResult -CapturePath (Join-Path $root 'missing\capture.txt') -CaptureCommand '--validate-capture-fixture' -HarnessExitCode 0
        }
        catch {
            $captureSetupFailure = $_.Exception
        }
        if ($null -eq $captureSetupFailure -or $captureSetupFailure.Message -notlike '*Capture setup failed before helper launch*' -or (Test-Path -LiteralPath $startedPath)) {
            throw 'Capture setup failure did not stop before fake helper execution.'
        }

        Write-Host 'Manual helper output capture self-test passed.'
    }
    finally {
        Restore-EnvironmentSnapshot -Name $privateName -Snapshot $privateSnapshot
        if (Test-Path -LiteralPath $root) {
            $cleanup = Remove-ManualWorkspaceWithRetry -Workspace $root
            if (-not $cleanup.Succeeded) {
                throw "Manual helper output capture self-test cleanup failed after $($cleanup.Attempts) attempt(s): $($cleanup.Detail)"
            }
        }
    }
}

function Show-ManualLaunchContextComparison {
    param(
        [Parameter(Mandatory = $true)]$ParentContext,
        [Parameter(Mandatory = $true)][string]$TestHostContextPath
    )

    if (-not (Test-Path -LiteralPath $TestHostContextPath -PathType Leaf)) {
        Write-Host 'MANUAL DIAGNOSTIC - VSTest testhost launch context was not recorded before its helper launch.'
        return
    }

    $testHost = Get-Content -LiteralPath $TestHostContextPath -Raw | ConvertFrom-Json -ErrorAction Stop
    $differences = 0
    foreach ($property in @(
        'ParentProcess', 'Identity', 'IsElevated', 'ElevationType', 'IntegrityLevel',
        'IsAppContainer', 'TokenInspectionStatus', 'TokenProcessId', 'Architecture',
        'ExecutablePath', 'PublishDirectory', 'WorkingDirectory', 'WorkingDirectoryExists',
        'ExecutableExists', 'ExecutableAttributes', 'ExecutableParentAttributes',
        'ReadAccessConfirmed', 'ExecutableFinalPath', 'DotnetEnvironmentVariables',
        'UseShellExecute', 'RedirectStandardOutput', 'RedirectStandardError', 'ArgumentCount',
        'PublishDescriptor'
    )) {
        $parentValue = $ParentContext.$property
        $testHostValue = $testHost.$property
        if ((ConvertTo-Json -InputObject $parentValue -Compress) -cne (ConvertTo-Json -InputObject $testHostValue -Compress)) {
            $differences += 1
            Write-Host ("MANUAL DIAGNOSTIC - {0} differs. Parent wrapper: {1}; VSTest testhost: {2}" -f $property, ($parentValue | ConvertTo-Json -Compress), ($testHostValue | ConvertTo-Json -Compress))
        }
    }

    if ($differences -eq 0) {
        Write-Host 'MANUAL DIAGNOSTIC - Parent wrapper and VSTest testhost launch contexts match for the selected safe fields.'
    }
}

function Write-ManualOperatorResponse {
    param(
        [Parameter(Mandatory = $true)][string]$RequestId,
        [Parameter(Mandatory = $true)][ValidateSet('yes', 'no', 'Continue', 'Cancel', 'DisplayFailed')][string]$Answer,
        [Parameter(Mandatory = $true)][string]$ResponseDirectory
    )

    if ($RequestId -notmatch '^[0-9A-Fa-f]{32}$') {
        throw "Manual operator confirmation request ID is invalid."
    }

    $target = Join-Path $ResponseDirectory ($RequestId + '.json')
    $temporary = Join-Path $ResponseDirectory ('.' + $RequestId + '.' + [guid]::NewGuid().ToString('N') + '.tmp')
    $payload = [pscustomobject]@{ RequestId = $RequestId; Answer = $Answer } | ConvertTo-Json -Compress

    try {
        [IO.File]::WriteAllText($temporary, $payload, [Text.UTF8Encoding]::new($false))
        [IO.File]::Move($temporary, $target)
    }
    finally {
        if (Test-Path -LiteralPath $temporary) {
            Remove-Item -LiteralPath $temporary -Force
        }
    }
}

function Stop-ManualWorkflowProcess {
    param(
        [Parameter(Mandatory = $true)]$Process,
        [int]$TerminatorTimeoutMilliseconds = $ManualWorkflowTerminatorTimeoutMilliseconds,
        [int]$ChildCleanupTimeoutMilliseconds = $ManualWorkflowChildCleanupTimeoutMilliseconds,
        [scriptblock]$StartTerminator,
        [scriptblock]$RetainTerminator
    )

    $result = [pscustomobject]@{
        TerminatorAttempted = $false
        TerminatorTimedOut = $false
        TerminatorExitCode = $null
        TerminatorStartFailed = $false
        TerminatorElapsedMilliseconds = $null
        ChildAlreadyExited = $false
        ChildExitTimedOut = $false
    }

    try {
        $Process.Refresh()
    }
    catch {
        # The owned Process object remains the authority; Refresh can race with its exit.
    }

    if ($Process.HasExited) {
        $result.ChildAlreadyExited = $true
        [void]$Process.WaitForExit($ChildCleanupTimeoutMilliseconds)
        return $result
    }

    $terminator = $null
    $terminatorRetained = $false
    try {
        if ($null -ne $StartTerminator) {
            $terminator = & $StartTerminator $Process
        }
        else {
            $taskKill = Join-Path -Path $env:SystemRoot -ChildPath 'System32/taskkill.exe'
            if (Test-Path -LiteralPath $taskKill) {
                $startInfo = [System.Diagnostics.ProcessStartInfo]::new()
                $startInfo.FileName = $taskKill
                $startInfo.UseShellExecute = $false
                $startInfo.CreateNoWindow = $true
                Set-ManualProcessStartInfoArguments -StartInfo $startInfo -LogicalArguments @('/PID', [string]$Process.Id, '/T', '/F')

                $terminator = [System.Diagnostics.Process]::new()
                $terminator.StartInfo = $startInfo
            }
            else {
                $result.TerminatorAttempted = $true
                try {
                    $Process.Kill()
                }
                catch {
                    $result.TerminatorStartFailed = $true
                }
            }
        }

        if ($null -ne $terminator) {
            $result.TerminatorAttempted = $true
            if (-not $terminator.Start()) {
                $result.TerminatorStartFailed = $true
            }
            else {
                $terminatorStartedAt = [datetime]::UtcNow
                $terminatorDeadline = $terminatorStartedAt.AddMilliseconds($TerminatorTimeoutMilliseconds)
                $remainingMilliseconds = [Math]::Max(0, [int][Math]::Ceiling(($terminatorDeadline - [datetime]::UtcNow).TotalMilliseconds))
                if ($remainingMilliseconds -le 0 -or -not $terminator.WaitForExit($remainingMilliseconds)) {
                    $result.TerminatorTimedOut = $true
                    try {
                        if (-not $terminator.HasExited) {
                            $terminator.Kill()
                        }
                    }
                    catch {
                        # Cleanup must continue to the owned child even when the helper cannot be stopped.
                    }
                }
                else {
                    $result.TerminatorExitCode = $terminator.ExitCode
                }
                $result.TerminatorElapsedMilliseconds = [Math]::Max(0, [int][Math]::Ceiling(([datetime]::UtcNow - $terminatorStartedAt).TotalMilliseconds))
            }
        }
    }
    catch {
        $result.TerminatorStartFailed = $true
    }
    finally {
        if ($null -ne $terminator) {
            if ($null -ne $RetainTerminator) {
                $terminatorRetained = [bool](& $RetainTerminator $terminator)
            }
            if (-not $terminatorRetained) {
                $terminator.Dispose()
            }
        }
    }

    try {
        $Process.Refresh()
    }
    catch {
        # The Process object can exit between termination and observation.
    }
    if (-not $Process.HasExited -and -not $Process.WaitForExit($ChildCleanupTimeoutMilliseconds)) {
        $result.ChildExitTimedOut = $true
    }

    return $result
}

function Read-ManualOperatorAnswer {
    param(
        [Parameter(Mandatory = $true)][string]$Stage,
        [Parameter(Mandatory = $true)][string]$QuestionCode,
        [Parameter(Mandatory = $true)][datetime]$Deadline,
        [Parameter(Mandatory = $true)]$Process,
        [scriptblock]$ReadInput,
        [object]$PendingInput
    )

    $attempt = 0
    while ([datetime]::UtcNow -le $Deadline) {
        if ($Process.HasExited) {
            return 'child-exited'
        }

        if ($null -ne $ReadInput) {
            try {
                $raw = & $ReadInput
            }
            catch {
                throw "Manual confirmation input failed for '$Stage' and '$QuestionCode': $($_.Exception.Message)"
            }
        }
        else {
            try {
                if ([Console]::IsInputRedirected) {
                    throw 'Console input is redirected.'
                }
                if (-not [Console]::KeyAvailable) {
                    Start-Sleep -Milliseconds 25
                    continue
                }

                $key = [Console]::ReadKey($true)
                $raw = $key.KeyChar.ToString()
                Write-Host $raw
            }
            catch [System.InvalidOperationException] {
                throw "Manual confirmation for '$Stage' and '$QuestionCode' requires an interactive console."
            }
        }

        if ($null -ne $PendingInput -and [object]::ReferenceEquals($raw, $PendingInput)) {
            Start-Sleep -Milliseconds 25
            continue
        }

        if ($null -eq $raw) {
            throw "Manual confirmation input ended before '$Stage' and '$QuestionCode' could continue."
        }

        switch ($raw.ToString().Trim().ToLowerInvariant()) {
            'y' { return 'yes' }
            'yes' { return 'yes' }
            'n' { return 'no' }
            'no' { return 'no' }
            default {
                $attempt += 1
                if ($attempt -eq 3) {
                    throw "Manual confirmation for '$Stage' and '$QuestionCode' requires an explicit Y or N answer."
                }
                Write-Warning "Please enter Y or N. Attempt $attempt of 3 was invalid."
            }
        }
    }

    throw "Manual workflow stalled at '$Stage' while awaiting operator confirmation '$QuestionCode' after the announced bounded timeout."
}

function Assert-ManualOperatorResponseChannel {
    $activeProcess = [pscustomobject]@{ HasExited = $false }
    $root = Join-Path $env:TEMP ('CreatorCrate-m2-operator-response-' + [guid]::NewGuid().ToString('N'))
    New-Item -ItemType Directory -Path $root | Out-Null
    try {
        $requestId = [guid]::NewGuid().ToString('N')
        Write-ManualOperatorResponse -RequestId $requestId -Answer 'yes' -ResponseDirectory $root
        $responsePath = Join-Path $root ($requestId + '.json')
        $response = Get-Content -LiteralPath $responsePath -Raw | ConvertFrom-Json -ErrorAction Stop
        if ($response.RequestId -cne $requestId -or $response.Answer -cne 'yes') {
            throw 'Operator response channel did not preserve the correlated affirmative response.'
        }
        if (Get-ChildItem -LiteralPath $root -Filter '*.tmp' -ErrorAction SilentlyContinue) {
            throw 'Operator response channel left a temporary partial response file.'
        }

        $invalidInput = $null
        try {
            Read-ManualOperatorAnswer -Stage 'Open Locally' -QuestionCode 'operator-response-channel' -Deadline ([datetime]::UtcNow.AddSeconds(1)) -Process $activeProcess -ReadInput { 'not an answer' } | Out-Null
        }
        catch {
            $invalidInput = $_.Exception
        }
        if ($null -eq $invalidInput -or $invalidInput.Message -notlike '*explicit Y or N*') {
            throw 'Operator response channel did not reject invalid input after its bounded attempts.'
        }

        $eofInput = $null
        try {
            Read-ManualOperatorAnswer -Stage 'Open Locally' -QuestionCode 'operator-response-channel' -Deadline ([datetime]::UtcNow.AddSeconds(1)) -Process $activeProcess -ReadInput { $null } | Out-Null
        }
        catch {
            $eofInput = $_.Exception
        }
        if ($null -eq $eofInput -or $eofInput.Message -notlike '*input ended*') {
            throw 'Operator response channel did not reject EOF/noninteractive input.'
        }
    }
    finally {
        if (Test-Path -LiteralPath $root) { Remove-Item -LiteralPath $root -Recurse -Force }
    }

    Write-Host 'Operator response channel self-test passed.'
}

function Invoke-ManualWorkflowEvent {
    param(
        [Parameter(Mandatory = $true)]$Event,
        [Parameter(Mandatory = $true)]$State,
        [Parameter(Mandatory = $true)][string]$ConfirmationDirectory,
        [Parameter(Mandatory = $true)]$Process,
        [scriptblock]$ReadInput,
        [object]$PendingInput
    )

    if ($State.PSObject.Properties.Match('ObservedEventKinds').Count -ne 0) {
        $State.ObservedEventKinds.Add([string]$Event.Kind)
    }
    if ($State.PSObject.Properties.Match('ObservedEventMessages').Count -ne 0) {
        $State.ObservedEventMessages.Add([string]$Event.Message)
    }

    switch ($Event.Kind) {
        'stage-start' {
            $State.CurrentStage = $Event.Stage
            $State.StageTimeoutSeconds = [int]$Event.TimeoutSeconds
            $State.Deadline = [datetime]::UtcNow.AddSeconds($State.StageTimeoutSeconds)
            Write-Host $Event.Message
        }
        'checkpoint' {
            Write-Host $Event.Message
        }
        'operator_confirmation_required' {
            if ([string]::IsNullOrWhiteSpace([string]$Event.RequestId) -or [string]::IsNullOrWhiteSpace([string]$Event.QuestionCode)) {
                throw "Operator confirmation event for '$($State.CurrentStage)' is missing request correlation data."
            }

            Write-Host $Event.Message
            $answer = Read-ManualOperatorAnswer -Stage $State.CurrentStage -QuestionCode ([string]$Event.QuestionCode) -Deadline $State.Deadline -Process $Process -ReadInput $ReadInput -PendingInput $PendingInput
            if ($answer -eq 'child-exited') {
                if ($State.PSObject.Properties.Match('ChildExitedWhileAwaitingConfirmation').Count -ne 0) {
                    $State.ChildExitedWhileAwaitingConfirmation = $true
                }
                return
            }

            Write-ManualOperatorResponse -RequestId ([string]$Event.RequestId) -Answer $answer -ResponseDirectory $ConfirmationDirectory
        }
        'stage-complete' {
            Write-Host $Event.Message
        }
        'stage-failed' {
            $State.Failure = [string]$Event.Message
            if ($State.PSObject.Properties.Match('ControlledFailure').Count -ne 0) {
                $State.ControlledFailure = $true
                $State.ControlledFailureDeadline = [datetime]::UtcNow.AddMilliseconds($State.ControlledFailureExitGraceTimeoutMilliseconds)
            }
            Write-Host ("Manual workflow stage failed: {0}" -f $State.Failure)
        }
        'cleanup-complete' {
            Write-Host $Event.Message
        }
        'cleanup-failed' {
            $State.Failure = [string]$Event.Message
            Write-Host ("Manual workflow cleanup failed: {0}" -f $State.Failure)
        }
        default {
            throw "Workflow event record #$($State.Reader.ParsedCount) has unsupported kind '$($Event.Kind)'."
        }
    }
}

function Assert-ManualOperatorInputDeadline {
    $running = [pscustomobject]@{ HasExited = $false }
    $questionCode = 'explorer_revealed_fixture'
    $pending = [pscustomobject]@{ Kind = 'pending' }

    $timeoutFailure = $null
    try {
        Read-ManualOperatorAnswer -Stage 'Open Locally' -QuestionCode $questionCode -Deadline ([datetime]::UtcNow.AddMilliseconds(150)) -Process $running -ReadInput { $pending } -PendingInput $pending | Out-Null
    } catch {
        $timeoutFailure = $_.Exception
    }
    if ($null -eq $timeoutFailure -or $timeoutFailure.Message -notlike "*$questionCode*") {
        throw 'The unanswered operator confirmation did not fail by its bounded deadline with the question code.'
    }

    $eofFailure = $null
    try {
        Read-ManualOperatorAnswer -Stage 'Open Locally' -QuestionCode $questionCode -Deadline ([datetime]::UtcNow.AddSeconds(1)) -Process $running -ReadInput { $null } | Out-Null
    } catch {
        $eofFailure = $_.Exception
    }
    if ($null -eq $eofFailure -or $eofFailure.Message -notlike '*input ended*') {
        throw 'The operator EOF regression contract did not fail explicitly.'
    }

    $answers = [System.Collections.Generic.Queue[string]]::new()
    @('invalid', 'still invalid', 'wrong') | ForEach-Object { $answers.Enqueue($_) }
    $invalidFailure = $null
    try {
        Read-ManualOperatorAnswer -Stage 'Open Locally' -QuestionCode $questionCode -Deadline ([datetime]::UtcNow.AddSeconds(1)) -Process $running -ReadInput { $answers.Dequeue() } | Out-Null
    } catch {
        $invalidFailure = $_.Exception
    }
    if ($null -eq $invalidFailure -or $invalidFailure.Message -notlike '*explicit Y or N*') {
        throw 'The invalid operator response regression contract did not retain explicit Y/N semantics.'
    }

    if ((Read-ManualOperatorAnswer -Stage 'Open Locally' -QuestionCode $questionCode -Deadline ([datetime]::UtcNow.AddSeconds(1)) -Process $running -ReadInput { 'Y' }) -ne 'yes') {
        throw 'The affirmative operator response regression contract failed.'
    }
    if ((Read-ManualOperatorAnswer -Stage 'Open Locally' -QuestionCode $questionCode -Deadline ([datetime]::UtcNow.AddSeconds(1)) -Process $running -ReadInput { 'n' }) -ne 'no') {
        throw 'The negative operator response regression contract failed.'
    }

    $exitedResult = Read-ManualOperatorAnswer -Stage 'Open Locally' -QuestionCode $questionCode -Deadline ([datetime]::UtcNow.AddSeconds(1)) -Process ([pscustomobject]@{ HasExited = $true }) -ReadInput { $pending } -PendingInput $pending
    if ($exitedResult -ne 'child-exited') {
        throw 'The child-exit-while-prompting regression contract did not return control to the event drain.'
    }

    $stageFailure = $null
    $stageFailureState = New-ManualWorkflowWrapperState
    try {
        Invoke-ManualWorkflowEvent -Event ([pscustomobject]@{ Kind = 'stage-failed'; Stage = 'Open Locally'; Message = 'Operator declined the deterministic fixture.' }) -State $stageFailureState -ConfirmationDirectory ([IO.Path]::GetTempPath()) -Process $running
    } catch {
        $stageFailure = $_.Exception
    }
    if ($null -ne $stageFailure -or -not $stageFailureState.ControlledFailure -or $stageFailureState.Failure -notlike '*declined*') {
        throw 'A controlled stage-failed event became a wrapper-level terminating error under ErrorActionPreference Stop.'
    }

    $responsePath = [IO.Path]::GetTempFileName()
    try {
        $responseFailure = $null
        try {
            Invoke-ManualWorkflowEvent -Event ([pscustomobject]@{ Kind = 'operator_confirmation_required'; RequestId = '0123456789abcdef0123456789abcdef'; QuestionCode = $questionCode; Message = 'Confirm the deterministic fixture state.' }) -State ([pscustomobject]@{ CurrentStage = 'Open Locally'; StageTimeoutSeconds = 1; Deadline = [datetime]::UtcNow.AddSeconds(1); Failure = $null }) -ConfirmationDirectory $responsePath -Process $running -ReadInput { 'Y' }
        } catch {
            $responseFailure = $_.Exception
        }
        if ($null -eq $responseFailure) {
            throw 'The response-write failure regression contract unexpectedly succeeded.'
        }
    } finally {
        if (Test-Path -LiteralPath $responsePath) {
            Remove-Item -LiteralPath $responsePath -Force
        }
    }

    $cleanupInfo = [System.Diagnostics.ProcessStartInfo]::new()
    $cleanupInfo.FileName = Join-Path -Path $env:SystemRoot -ChildPath 'System32/ping.exe'
    $cleanupInfo.UseShellExecute = $false
    $cleanupInfo.CreateNoWindow = $true
    Set-ManualProcessStartInfoArguments -StartInfo $cleanupInfo -LogicalArguments @('-n', '30', '127.0.0.1')
    $cleanupProbe = [System.Diagnostics.Process]::new()
    $cleanupProbe.StartInfo = $cleanupInfo
    try {
        if (-not $cleanupProbe.Start()) {
            throw 'The deterministic cleanup probe could not start.'
        }
        $cleanupResult = Stop-ManualWorkflowProcess -Process $cleanupProbe
        if (-not $cleanupProbe.HasExited -or $cleanupResult.ChildExitTimedOut) {
            throw 'The wrapper-side cleanup regression contract did not wait for the child process tree.'
        }
    } finally {
        $cleanupProbe.Dispose()
    }
}

function New-ManualWorkflowWrapperState {
    param(
        [int]$ControlledFailureExitGraceTimeoutMilliseconds = $ManualWorkflowControlledFailureExitGraceTimeoutMilliseconds
    )

    return [pscustomobject]@{
        Reader = New-ManualWorkflowEventReader
        CurrentStage = 'test startup'
        StageTimeoutSeconds = 120
        Deadline = [datetime]::UtcNow.AddSeconds(120)
        Failure = $null
        ControlledFailure = $false
        ControlledFailureExitGraceTimeoutMilliseconds = $ControlledFailureExitGraceTimeoutMilliseconds
        ControlledFailureDeadline = $null
        ChildExitedWhileAwaitingConfirmation = $false
        ObservedEventKinds = [System.Collections.Generic.List[string]]::new()
        ObservedEventMessages = [System.Collections.Generic.List[string]]::new()
        TerminationResult = $null
    }
}

function Invoke-ManualWorkflowEventLoop {
    param(
        [Parameter(Mandatory = $true)]$Process,
        [Parameter(Mandatory = $true)][string]$Events,
        [Parameter(Mandatory = $true)][string]$ConfirmationDirectory,
        [Parameter(Mandatory = $true)]$State,
        [scriptblock]$ReadInput,
        [object]$PendingInput,
        [scriptblock]$StartTerminator
    )

    try {
        while (-not $Process.HasExited) {
            Read-ManualWorkflowEvents -Events $Events -State $State.Reader
            while ($State.Reader.PendingEvents.Count -gt 0) {
                $event = $State.Reader.PendingEvents[0]
                $State.Reader.PendingEvents.RemoveAt(0)
                Invoke-ManualWorkflowEvent -Event $event -State $State -ConfirmationDirectory $ConfirmationDirectory -Process $Process -ReadInput $ReadInput -PendingInput $PendingInput
            }

            if ($State.ControlledFailure) {
                if ([datetime]::UtcNow -gt $State.ControlledFailureDeadline) {
                    throw "Manual controlled stage failure cleanup did not exit within $($State.ControlledFailureExitGraceTimeoutMilliseconds) milliseconds."
                }
            }
            elseif ([datetime]::UtcNow -gt $State.Deadline) {
                throw "Manual workflow stalled at '$($State.CurrentStage)' after the announced bounded timeout."
            }

            Start-Sleep -Milliseconds 200
        }

        if (-not $Process.WaitForExit($ManualWorkflowChildCleanupTimeoutMilliseconds)) {
            throw "Manual workflow child-exit observation did not complete within $ManualWorkflowChildCleanupTimeoutMilliseconds milliseconds."
        }

        Read-ManualWorkflowEvents -Events $Events -State $State.Reader -EndOfStream
        while ($State.Reader.PendingEvents.Count -gt 0) {
            $event = $State.Reader.PendingEvents[0]
            $State.Reader.PendingEvents.RemoveAt(0)
            Invoke-ManualWorkflowEvent -Event $event -State $State -ConfirmationDirectory $ConfirmationDirectory -Process $Process -ReadInput $ReadInput -PendingInput $PendingInput
        }

        if ($Process.ExitCode -ne 0 -or $null -ne $State.Failure) {
            $failure = if ($null -ne $State.Failure) {
                $State.Failure
            }
            else {
                "The deterministic Manual workflow failed at '$($State.CurrentStage)' with exit code $($Process.ExitCode)."
            }
            return [pscustomobject]@{ Succeeded = $false; Failure = $failure; ExitCode = $Process.ExitCode }
        }

        return [pscustomobject]@{ Succeeded = $true; Failure = $null; ExitCode = $Process.ExitCode }
    }
    catch {
        $workflowFailure = $_
        $State.TerminationResult = Stop-ManualWorkflowProcess -Process $Process -StartTerminator $StartTerminator
        $diagnostics = Get-ManualTerminationDiagnostics -Result $State.TerminationResult
        if ($diagnostics -ne 'termination_completed') {
            throw ("Manual workflow infrastructure failure cleanup reported {0}. Original failure: {1}" -f $diagnostics, $workflowFailure.Exception.Message)
        }
        throw $workflowFailure
    }
}

function Invoke-ManualWorkflow {
    param(
        [Parameter(Mandatory = $true)][string]$RepositoryRoot,
        [Parameter(Mandatory = $true)][string]$Tests,
        [Parameter(Mandatory = $true)][string]$Artifacts,
        [Parameter(Mandatory = $true)][string]$Events,
        [Parameter(Mandatory = $true)][string]$ConfirmationDirectory
    )

    $startInfo = [System.Diagnostics.ProcessStartInfo]::new()
    $startInfo.FileName = 'dotnet'
    $childArgs = @(
        'test', $Tests, '-c', 'Release', '--artifacts-path', $Artifacts,
        '--filter', 'FullyQualifiedName~ManualFoundationHarnessTests.RunDeterministicFoundationWorkflow',
        '--logger', 'console;verbosity=detailed'
    )
    Set-ManualProcessStartInfoArguments -StartInfo $startInfo -LogicalArguments $childArgs
    $startInfo.WorkingDirectory = $RepositoryRoot
    $startInfo.UseShellExecute = $false

    $process = [System.Diagnostics.Process]::new()
    $process.StartInfo = $startInfo
    if (-not $process.Start()) { throw 'The deterministic Manual workflow test process could not start.' }

    $state = New-ManualWorkflowWrapperState
    try {
        $result = Invoke-ManualWorkflowEventLoop -Process $process -Events $Events -ConfirmationDirectory $ConfirmationDirectory -State $state
        if (-not $result.Succeeded) {
            throw $result.Failure
        }
    }
    finally {
        $process.Dispose()
    }
}

function Assert-ManualProcessStartInfoArgumentRoundTrips {
    if ($PSVersionTable.PSVersion.Major -ne 5 -or $PSVersionTable.PSVersion.Minor -ne 1) {
        throw "This verifier requires Windows PowerShell 5.1; found $($PSVersionTable.PSVersion)."
    }

    $root = Join-Path ([IO.Path]::GetTempPath()) ('creatorcrate-ps51-argv-' + [guid]::NewGuid().ToString('N'))
    $echoScript = Join-Path $root 'echo-argv.ps1'
    New-Item -ItemType Directory -Path $root | Out-Null
    try {
        [IO.File]::WriteAllText($echoScript, @'
param([Parameter(ValueFromRemainingArguments = $true)][AllowEmptyString()][string[]]$ChildArguments)
[Console]::Out.Write((ConvertTo-Json -InputObject @($ChildArguments) -Compress))
'@, [Text.UTF8Encoding]::new($false))

        $diagnosticUri = Get-ManualDiagnosticSocialUri -RepositoryRoot $RepositoryRoot
        $cases = @(
            [pscustomobject]@{ Name = 'social-uri'; Arguments = @($diagnosticUri) },
            [pscustomobject]@{ Name = 'spaces'; Arguments = @('value with spaces') },
            [pscustomobject]@{ Name = 'quotes-and-backslashes'; Arguments = @('embedded"quote', 'C:\path with spaces\trailing\', 'slashes\\"quoted') },
            [pscustomobject]@{ Name = 'empty'; Arguments = @('') },
            [pscustomobject]@{ Name = 'switches'; Arguments = @('--register-social', '--unregister-social') }
        )

        foreach ($case in $cases) {
            $startInfo = [System.Diagnostics.ProcessStartInfo]::new()
            $startInfo.FileName = Join-Path $PSHOME 'powershell.exe'
            $startInfo.WorkingDirectory = $root
            $startInfo.UseShellExecute = $false
            $startInfo.CreateNoWindow = $true
            $startInfo.RedirectStandardOutput = $true
            $startInfo.RedirectStandardError = $true
            $childArgs = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $echoScript) + @($case.Arguments)
            Set-ManualProcessStartInfoArguments -StartInfo $startInfo -LogicalArguments $childArgs

            $process = [System.Diagnostics.Process]::new()
            $process.StartInfo = $startInfo
            try {
                if (-not $process.Start()) { throw "Argument round-trip case '$($case.Name)' could not start the harmless child process." }
                if (-not $process.WaitForExit(30000)) {
                    $termination = Stop-ManualWorkflowProcess -Process $process
                    throw ("Argument round-trip case '{0}' timed out. {1}" -f $case.Name, (Get-ManualTerminationDiagnostics -Result $termination))
                }

                $stdout = $process.StandardOutput.ReadToEnd()
                $stderr = $process.StandardError.ReadToEnd()
                if ($process.ExitCode -ne 0) {
                    throw "Argument round-trip case '$($case.Name)' failed with exit code $($process.ExitCode): $stderr"
                }

                $actual = @((ConvertFrom-Json -InputObject $stdout -ErrorAction Stop))
                if ($actual.Count -ne $case.Arguments.Count) {
                    throw "Argument round-trip case '$($case.Name)' produced $($actual.Count) arguments instead of $($case.Arguments.Count)."
                }

                for ($index = 0; $index -lt $case.Arguments.Count; $index += 1) {
                    if ([string]$actual[$index] -cne [string]$case.Arguments[$index]) {
                        throw "Argument round-trip case '$($case.Name)' changed argument index $index."
                    }
                }
            }
            finally {
                $process.Dispose()
            }
        }

        [pscustomobject]@{
            Invocation = 'powershell-5.1-process-start-info-arguments'
            PowerShellVersion = $PSVersionTable.PSVersion.ToString()
            Cases = @($cases | ForEach-Object {
                [pscustomobject]@{ Name = $_.Name; ArgumentCount = $_.Arguments.Count }
            })
        } | ConvertTo-Json -Compress
    }
    finally {
        if (Test-Path -LiteralPath $root) {
            Remove-Item -LiteralPath $root -Recurse -Force
        }
    }
}

function Start-ManualWrapperVerifierProcess {
    param(
        [Parameter(Mandatory = $true)][string]$Executable,
        [Parameter(Mandatory = $true)][string]$WorkingDirectory,
        [Parameter(Mandatory = $true)][string[]]$LogicalArguments,
        [System.Collections.IList]$OwnedProcesses,
        [string]$Role = 'controlled child'
    )

    $startInfo = [System.Diagnostics.ProcessStartInfo]::new()
    $startInfo.FileName = $Executable
    $startInfo.WorkingDirectory = $WorkingDirectory
    $startInfo.UseShellExecute = $false
    $startInfo.CreateNoWindow = $true
    $startInfo.RedirectStandardOutput = $true
    $startInfo.RedirectStandardError = $true
    Set-ManualProcessStartInfoArguments -StartInfo $startInfo -LogicalArguments $LogicalArguments

    $process = [System.Diagnostics.Process]::new()
    $process.StartInfo = $startInfo
    if (-not $process.Start()) {
        $process.Dispose()
        throw 'The bounded-wrapper verifier could not start its controlled child process.'
    }

    if ($null -ne $OwnedProcesses) {
        [void]$OwnedProcesses.Add([pscustomobject]@{
            Role = $Role
            ProcessId = $process.Id
            WorkingDirectory = $WorkingDirectory
            Process = $process
        })
    }

    return $process
}

function Add-ManualWrapperVerifierOwnedProcess {
    param(
        [Parameter(Mandatory = $true)][System.Collections.IList]$OwnedProcesses,
        [Parameter(Mandatory = $true)][string]$Role,
        [Parameter(Mandatory = $true)]$Process,
        [Parameter(Mandatory = $true)][string]$WorkingDirectory
    )

    [void]$OwnedProcesses.Add([pscustomobject]@{
        Role = $Role
        ProcessId = $Process.Id
        WorkingDirectory = $WorkingDirectory
        Process = $Process
    })
}

function Stop-ManualWrapperVerifierProcess {
    param(
        [Parameter(Mandatory = $true)]$Process
    )

    try {
        if (-not $Process.HasExited) {
            $Process.Kill()
        }
    }
    catch {
        # The verifier only owns its child and still attempts the finite observation below.
    }

    if (-not $Process.HasExited -and -not $Process.WaitForExit(5000)) {
        throw 'The bounded-wrapper verifier could not stop its controlled child process.'
    }
}

function Complete-ManualWrapperVerifierProcessTeardown {
    param(
        [Parameter(Mandatory = $true)][System.Collections.IList]$OwnedProcesses,
        [int]$TimeoutMilliseconds = 5000
    )

    $deadline = [datetime]::UtcNow.AddMilliseconds($TimeoutMilliseconds)
    foreach ($owned in @($OwnedProcesses)) {
        try {
            if (-not $owned.Process.HasExited) {
                $owned.Process.Kill()
            }
        }
        catch {
            # The final exact-owned-process observation below reports any process that survives this best effort.
        }
    }

    $remaining = @()
    foreach ($owned in @($OwnedProcesses)) {
        $exited = $false
        try {
            $remainingMilliseconds = [Math]::Max(0, [int][Math]::Ceiling(($deadline - [datetime]::UtcNow).TotalMilliseconds))
            $exited = $owned.Process.HasExited -or ($remainingMilliseconds -gt 0 -and $owned.Process.WaitForExit($remainingMilliseconds))
        }
        catch {
            $exited = $false
        }
        if (-not $exited) {
            try { $owned.Process.Kill() } catch { }
            $remaining += $owned
        }
    }

    foreach ($owned in @($OwnedProcesses)) {
        try { $owned.Process.Dispose() } catch { }
    }

    return [pscustomobject]@{
        Succeeded = ($remaining.Count -eq 0)
        Remaining = @($remaining | ForEach-Object { '{0} ({1})' -f $_.Role, $_.ProcessId })
    }
}

function Invoke-ManualWorkflowFixture {
    param(
        [Parameter(Mandatory = $true)][string]$Root,
        [Parameter(Mandatory = $true)][string]$FixtureScript,
        [Parameter(Mandatory = $true)][ValidateSet('yes', 'no', 'child-exits', 'zero', 'utf8-2', 'utf8-3', 'utf8-4')][string]$Mode,
        [Parameter(Mandatory = $true)][System.Collections.IList]$OwnedProcesses
    )

    $events = Join-Path $Root ($Mode + '-events.jsonl')
    $confirmations = Join-Path $Root ($Mode + '-confirmations')
    New-Item -ItemType File -Path $events | Out-Null
    New-Item -ItemType Directory -Path $confirmations | Out-Null

    $process = Start-ManualWrapperVerifierProcess -Executable (Join-Path $PSHOME 'powershell.exe') -WorkingDirectory $Root -LogicalArguments @(
        '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', $FixtureScript,
        '-Events', $events, '-ConfirmationDirectory', $confirmations, '-SynchronizationDirectory', $Root, '-Mode', $Mode
    ) -OwnedProcesses $OwnedProcesses -Role ('fixture-' + $Mode)
    $state = New-ManualWorkflowWrapperState -ControlledFailureExitGraceTimeoutMilliseconds 2000
    try {
        $answer = if ($Mode -eq 'yes') { 'Y' } else { 'N' }
        if ($Mode -eq 'child-exits') {
            if (-not $process.WaitForExit(5000)) {
                throw 'The child-exit fixture did not exit before the final event-drain regression.'
            }
        }
        elseif ($Mode -like 'utf8-*') {
            $fragmentReady = Join-Path $Root ($Mode + '-fragment-ready')
            $snapshotObserved = Join-Path $Root ($Mode + '-snapshot-observed')
            $deadline = [datetime]::UtcNow.AddSeconds(5)
            while (-not (Test-Path -LiteralPath $fragmentReady)) {
                if ($process.HasExited -or [datetime]::UtcNow -gt $deadline) {
                    throw "The live $Mode fixture did not publish its split record before wrapper polling."
                }
                Start-Sleep -Milliseconds 25
            }

            $state.Reader.SnapshotLengthCapturedHook = {
                param($snapshotLength, $readByteOffset)
                [IO.File]::WriteAllText($snapshotObserved, 'observed', [Text.UTF8Encoding]::new($false))
            }.GetNewClosure()
        }

        $result = Invoke-ManualWorkflowEventLoop -Process $process -Events $events -ConfirmationDirectory $confirmations -State $state -ReadInput { $answer }
        $responsePath = Join-Path $confirmations '0123456789abcdef0123456789abcdef.json'
        $response = if (Test-Path -LiteralPath $responsePath) {
            Get-Content -LiteralPath $responsePath -Raw | ConvertFrom-Json -ErrorAction Stop
        }
        else {
            $null
        }

        return [pscustomobject]@{ Result = $result; State = $state; Response = $response; EventContents = [IO.File]::ReadAllText($events); StandardError = $process.StandardError.ReadToEnd() }
    }
    finally {
        Stop-ManualWrapperVerifierProcess -Process $process
    }
}

function Assert-ManualBoundedWorkflowWrapper {
    if ($PSVersionTable.PSVersion.Major -ne 5 -or $PSVersionTable.PSVersion.Minor -ne 1) {
        throw "This verifier requires Windows PowerShell 5.1; found $($PSVersionTable.PSVersion)."
    }

    $root = Join-Path ([IO.Path]::GetTempPath()) ('CreatorCrate-m2-manual-bounded-wrapper-' + [guid]::NewGuid().ToString('N'))
    $fixtureScript = Join-Path $root 'workflow-fixture.ps1'
    $workerScript = Join-Path $root 'worker.ps1'
    $ownedProcesses = [System.Collections.Generic.List[object]]::new()
    New-Item -ItemType Directory -Path $root | Out-Null
    try {
        [IO.File]::WriteAllText($fixtureScript, @'
param(
    [Parameter(Mandatory = $true)][string]$Events,
    [Parameter(Mandatory = $true)][string]$ConfirmationDirectory,
    [Parameter(Mandatory = $true)][string]$SynchronizationDirectory,
    [Parameter(Mandatory = $true)][string]$Mode
)

$ErrorActionPreference = 'Stop'
function Write-FixtureEvent {
    param(
        [Parameter(Mandatory = $true)][string]$Kind,
        [string]$Stage,
        [string]$Message,
        [string]$RequestId,
        [string]$QuestionCode,
        [int]$TimeoutSeconds
    )

    $record = [pscustomobject]@{
        Kind = $Kind
        Stage = $Stage
        Message = $Message
        RequestId = $RequestId
        QuestionCode = $QuestionCode
        TimeoutSeconds = $TimeoutSeconds
    } | ConvertTo-Json -Compress
    [IO.File]::AppendAllText($Events, ($record + [Environment]::NewLine), [Text.UTF8Encoding]::new($false))
}

if ($Mode -like 'utf8-*') {
    # Verifier-only markers make each real UTF-8 internal split independent of scheduling.
    switch ($Mode) {
        'utf8-2' {
            $expectedMessage = ('caf' + [char]0x00E9)
            [byte[]]$targetBytes = @(0xC3, 0xA9)
        }
        'utf8-3' {
            $expectedMessage = ([string][char]0x20AC)
            [byte[]]$targetBytes = @(0xE2, 0x82, 0xAC)
        }
        'utf8-4' {
            $expectedMessage = ([char]0xD83D + [char]0xDE00)
            [byte[]]$targetBytes = @(0xF0, 0x9F, 0x98, 0x80)
        }
        default {
            throw "Unsupported UTF-8 live-writer mode '$Mode'."
        }
    }

    $record = ([pscustomobject]@{ Kind = 'checkpoint'; Stage = ($Mode + '-live-writer'); Message = $expectedMessage } | ConvertTo-Json -Compress) + [Environment]::NewLine
    $utf8 = [Text.UTF8Encoding]::new($false)
    [byte[]]$recordBytes = $utf8.GetBytes($record)
    [int]$targetIndex = -1
    [int]$targetOccurrences = 0
    for ([int]$candidate = 0; $candidate -le $recordBytes.Length - $targetBytes.Length; $candidate++) {
        $matchesTarget = $true
        for ([int]$targetOffset = 0; $targetOffset -lt $targetBytes.Length; $targetOffset++) {
            if ($recordBytes[$candidate + $targetOffset] -ne $targetBytes[$targetOffset]) {
                $matchesTarget = $false
                break
            }
        }

        if ($matchesTarget) {
            if ($targetIndex -lt 0) { $targetIndex = $candidate }
            $targetOccurrences += 1
        }
    }

    if ($targetIndex -lt 0 -or $targetOccurrences -ne 1 -or
        $targetIndex + 1 -ge $recordBytes.Length -or
        $recordBytes[$targetIndex] -ne $targetBytes[0]) {
        throw "The live $Mode fixture did not contain exactly one target sequence at the required internal split point."
    }

    $writer = [IO.FileStream]::new($Events, [IO.FileMode]::Open, [IO.FileAccess]::Write, [IO.FileShare]::Read)
    try {
        [int]$firstWriteLength = $targetIndex + 1
        $writer.Write($recordBytes, 0, $firstWriteLength)
        $writer.Flush($true)
        [IO.File]::WriteAllText((Join-Path $SynchronizationDirectory ($Mode + '-fragment-ready')), 'ready', $utf8)

        $deadline = [datetime]::UtcNow.AddSeconds(5)
        while (-not (Test-Path -LiteralPath (Join-Path $SynchronizationDirectory ($Mode + '-snapshot-observed')))) {
            if ([datetime]::UtcNow -gt $deadline) {
                throw "The live $Mode fixture did not observe the wrapper snapshot of its split record."
            }
            Start-Sleep -Milliseconds 25
        }

        $writer.Write($recordBytes, $firstWriteLength, $recordBytes.Length - $firstWriteLength)
        $writer.Flush($true)
    }
    finally {
        $writer.Dispose()
    }
    exit 0
}

if ($Mode -eq 'zero') {
    Start-Sleep -Milliseconds 300
    exit 0
}

$requestId = '0123456789abcdef0123456789abcdef'
Write-FixtureEvent -Kind 'stage-start' -Stage 'Open Locally' -Message 'fixture stage started' -TimeoutSeconds 5
Write-FixtureEvent -Kind 'operator_confirmation_required' -Stage 'Open Locally' -Message 'fixture confirmation required' -RequestId $requestId -QuestionCode 'fixture_confirmation'

if ($Mode -eq 'child-exits') {
    Write-FixtureEvent -Kind 'stage-failed' -Stage 'Open Locally' -Message 'fixture child exited before confirmation'
    Write-FixtureEvent -Kind 'cleanup-complete' -Stage 'cleanup' -Message 'fixture cleanup completed'
    exit 1
}

$responsePath = Join-Path $ConfirmationDirectory ($requestId + '.json')
$deadline = [datetime]::UtcNow.AddSeconds(5)
while (-not (Test-Path -LiteralPath $responsePath)) {
    if ([datetime]::UtcNow -gt $deadline) {
        Write-FixtureEvent -Kind 'stage-failed' -Stage 'Open Locally' -Message 'fixture response timeout'
        Write-FixtureEvent -Kind 'cleanup-complete' -Stage 'cleanup' -Message 'fixture cleanup completed'
        exit 1
    }
    Start-Sleep -Milliseconds 25
}

$response = Get-Content -LiteralPath $responsePath -Raw | ConvertFrom-Json -ErrorAction Stop
if ($response.Answer -eq 'no') {
    Write-FixtureEvent -Kind 'stage-failed' -Stage 'Open Locally' -Message 'fixture operator declined'
    Write-FixtureEvent -Kind 'cleanup-complete' -Stage 'cleanup' -Message 'fixture cleanup completed'
    exit 1
}

Write-FixtureEvent -Kind 'stage-complete' -Stage 'Open Locally' -Message 'fixture stage completed'
Write-FixtureEvent -Kind 'cleanup-complete' -Stage 'cleanup' -Message 'fixture cleanup completed'
exit 0
'@, [Text.UTF8Encoding]::new($false))

        [IO.File]::WriteAllText($workerScript, @'
param(
    [Parameter(Mandatory = $true)][int]$Milliseconds,
    [Parameter(Mandatory = $true)][int]$ExitCode
)

Start-Sleep -Milliseconds $Milliseconds
exit $ExitCode
'@, [Text.UTF8Encoding]::new($false))

        $negative = Invoke-ManualWorkflowFixture -Root $root -FixtureScript $fixtureScript -Mode 'no' -OwnedProcesses $ownedProcesses
        if ($negative.Result.Succeeded -or $negative.Result.ExitCode -eq 0 -or $negative.Response.Answer -cne 'no' -or $null -ne $negative.State.TerminationResult) {
            throw 'The controlled negative response regression incorrectly terminated or reported success.'
        }
        $negativeFailedIndex = $negative.State.ObservedEventKinds.IndexOf('stage-failed')
        $negativeCleanupIndex = $negative.State.ObservedEventKinds.IndexOf('cleanup-complete')
        if ($negativeFailedIndex -lt 0 -or $negativeCleanupIndex -le $negativeFailedIndex) {
            throw 'The controlled negative response regression did not drain stage-failed and cleanup-complete in order.'
        }

        $affirmative = Invoke-ManualWorkflowFixture -Root $root -FixtureScript $fixtureScript -Mode 'yes' -OwnedProcesses $ownedProcesses
        if (-not $affirmative.Result.Succeeded -or $affirmative.Response.Answer -cne 'yes' -or $null -ne $affirmative.State.TerminationResult -or $affirmative.State.ObservedEventKinds.IndexOf('cleanup-complete') -lt 0) {
            throw ('The affirmative workflow regression did not complete normally without termination. Succeeded: {0}; answer: {1}; termination: {2}; events: {3}' -f $affirmative.Result.Succeeded, $affirmative.Response.Answer, ($null -ne $affirmative.State.TerminationResult), ($affirmative.State.ObservedEventKinds -join ','))
        }

        $childExited = Invoke-ManualWorkflowFixture -Root $root -FixtureScript $fixtureScript -Mode 'child-exits' -OwnedProcesses $ownedProcesses
        if ($childExited.Result.Succeeded -or -not $childExited.State.ChildExitedWhileAwaitingConfirmation -or $null -ne $childExited.State.TerminationResult) {
            throw ('The child-exit-while-prompting regression did not return control to the final event drain. Succeeded: {0}; child exited while awaiting confirmation: {1}; termination: {2}; events: {3}; stream length: {4}; stderr: {5}' -f $childExited.Result.Succeeded, $childExited.State.ChildExitedWhileAwaitingConfirmation, ($null -ne $childExited.State.TerminationResult), ($childExited.State.ObservedEventKinds -join ','), $childExited.EventContents.Length, $childExited.StandardError.Trim())
        }
        $zeroEvents = Invoke-ManualWorkflowFixture -Root $root -FixtureScript $fixtureScript -Mode 'zero' -OwnedProcesses $ownedProcesses
        if (-not $zeroEvents.Result.Succeeded -or $zeroEvents.Result.ExitCode -ne 0 -or $zeroEvents.State.Reader.ParsedCount -ne 0 -or $zeroEvents.EventContents.Length -ne 0 -or $null -ne $zeroEvents.State.TerminationResult) {
            throw ('The zero-event workflow regression did not deterministically drain an empty valid stream. Succeeded: {0}; exit: {1}; parsed: {2}; stream length: {3}; termination: {4}' -f $zeroEvents.Result.Succeeded, $zeroEvents.Result.ExitCode, $zeroEvents.State.Reader.ParsedCount, $zeroEvents.EventContents.Length, ($null -ne $zeroEvents.State.TerminationResult))
        }

        $utf8LiveCases = @(
            [pscustomobject]@{ Name = '2BYTE'; Mode = 'utf8-2'; ExpectedMessage = ('caf' + [char]0x00E9); TargetBytes = [byte[]]@(0xC3, 0xA9) },
            [pscustomobject]@{ Name = '3BYTE'; Mode = 'utf8-3'; ExpectedMessage = ([string][char]0x20AC); TargetBytes = [byte[]]@(0xE2, 0x82, 0xAC) },
            [pscustomobject]@{ Name = '4BYTE'; Mode = 'utf8-4'; ExpectedMessage = ([char]0xD83D + [char]0xDE00); TargetBytes = [byte[]]@(0xF0, 0x9F, 0x98, 0x80) }
        )
        foreach ($utf8LiveCase in $utf8LiveCases) {
            $utf8Live = Invoke-ManualWorkflowFixture -Root $root -FixtureScript $fixtureScript -Mode $utf8LiveCase.Mode -OwnedProcesses $ownedProcesses
            if (-not $utf8Live.Result.Succeeded -or $utf8Live.Result.ExitCode -ne 0 -or $utf8Live.State.Reader.ParsedCount -ne 1 -or $utf8Live.State.ObservedEventMessages.IndexOf($utf8LiveCase.ExpectedMessage) -lt 0 -or $utf8Live.EventContents.Contains([char]0xFFFD) -or $null -ne $utf8Live.State.TerminationResult) {
                throw ('The live {0} writer regression did not preserve the exact event through wrapper polling. Succeeded: {1}; exit: {2}; parsed: {3}; messages: {4}; replacement: {5}; termination: {6}; stderr: {7}' -f $utf8LiveCase.Name, $utf8Live.Result.Succeeded, $utf8Live.Result.ExitCode, $utf8Live.State.Reader.ParsedCount, ($utf8Live.State.ObservedEventMessages -join ','), $utf8Live.EventContents.Contains([char]0xFFFD), ($null -ne $utf8Live.State.TerminationResult), $utf8Live.StandardError.Trim())
            }

            Write-Host ('INTEGRATED_{0}_ACTUAL={1}; INTEGRATED_{0}_BYTES={2}; INTEGRATED_{0}_SPLIT=1/{3}; REPLACEMENT_COUNT=0' -f $utf8LiveCase.Name, $utf8LiveCase.ExpectedMessage, ([BitConverter]::ToString($utf8LiveCase.TargetBytes)), ($utf8LiveCase.TargetBytes.Length - 1))
        }

        $childExitedFailedIndex = $childExited.State.ObservedEventKinds.IndexOf('stage-failed')
        $childExitedCleanupIndex = $childExited.State.ObservedEventKinds.IndexOf('cleanup-complete')
        if ($childExitedFailedIndex -lt 0 -or $childExitedCleanupIndex -le $childExitedFailedIndex) {
            throw 'The child-exit-while-prompting regression discarded final workflow events.'
        }

        $startWorker = {
            param($milliseconds, $exitCode, $role)
            Start-ManualWrapperVerifierProcess -Executable (Join-Path $PSHOME 'powershell.exe') -WorkingDirectory $root -LogicalArguments @(
                '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', $workerScript,
                '-Milliseconds', [string]$milliseconds, '-ExitCode', [string]$exitCode
            ) -OwnedProcesses $ownedProcesses -Role $role
        }
        $retainTerminator = { param($terminator) return $true }

        $timeoutChild = & $startWorker 30000 0 'terminator-timeout child'
        try {
            $terminatorTimeout = Stop-ManualWorkflowProcess -Process $timeoutChild -TerminatorTimeoutMilliseconds 150 -ChildCleanupTimeoutMilliseconds 100 -StartTerminator {
                param($owned)
                & $startWorker 1000 0 'terminator-timeout helper'
            } -RetainTerminator $retainTerminator
            if (-not $terminatorTimeout.TerminatorTimedOut -or -not $terminatorTimeout.ChildExitTimedOut -or $terminatorTimeout.TerminatorElapsedMilliseconds -gt 225 -or (Get-ManualTerminationDiagnostics -Result $terminatorTimeout) -notlike '*terminator_timeout*child_exit_timeout*') {
                throw 'The terminator-timeout regression did not preserve one total helper deadline before owned-child observation.'
            }
        }
        finally {
            Stop-ManualWrapperVerifierProcess -Process $timeoutChild
        }

        $nearDeadlineChild = & $startWorker 30000 0 'near-deadline child'
        try {
            $nearDeadline = Stop-ManualWorkflowProcess -Process $nearDeadlineChild -TerminatorTimeoutMilliseconds 3000 -ChildCleanupTimeoutMilliseconds 100 -StartTerminator {
                param($owned)
                & $startWorker 2200 0 'near-deadline helper'
            } -RetainTerminator $retainTerminator
            if ($nearDeadline.TerminatorTimedOut -or $nearDeadline.TerminatorExitCode -ne 0 -or $nearDeadline.TerminatorElapsedMilliseconds -gt 3000) {
                throw 'The near-deadline terminator regression incorrectly classified a normal helper exit.'
            }
        }
        finally {
            Stop-ManualWrapperVerifierProcess -Process $nearDeadlineChild
        }

        $nonzeroChild = & $startWorker 30000 0 'terminator-nonzero child'
        try {
            $terminatorNonzero = Stop-ManualWorkflowProcess -Process $nonzeroChild -TerminatorTimeoutMilliseconds 1000 -ChildCleanupTimeoutMilliseconds 100 -StartTerminator {
                param($owned)
                & $startWorker 1 7 'terminator-nonzero helper'
            } -RetainTerminator $retainTerminator
            if ($terminatorNonzero.TerminatorExitCode -ne 7 -or -not $terminatorNonzero.ChildExitTimedOut -or (Get-ManualTerminationDiagnostics -Result $terminatorNonzero) -notlike '*terminator_nonzero:7*child_exit_timeout*') {
                throw 'The terminator-nonzero regression did not preserve separate helper and child diagnostics.'
            }
        }
        finally {
            Stop-ManualWrapperVerifierProcess -Process $nonzeroChild
        }

        $refusingChild = & $startWorker 30000 0 'child-exit-timeout child'
        try {
            $childStillAlive = Stop-ManualWorkflowProcess -Process $refusingChild -TerminatorTimeoutMilliseconds 1000 -ChildCleanupTimeoutMilliseconds 100 -StartTerminator {
                param($owned)
                & $startWorker 1 0 'child-exit-timeout helper'
            } -RetainTerminator $retainTerminator
            if (-not $childStillAlive.TerminatorAttempted -or -not $childStillAlive.ChildExitTimedOut -or (Get-ManualTerminationDiagnostics -Result $childStillAlive) -ne 'child_exit_timeout') {
                throw 'The child-still-alive regression did not report the owned-child timeout.'
            }
        }
        finally {
            Stop-ManualWrapperVerifierProcess -Process $refusingChild
        }

        $preflightFailure = $null
        $retainParentPreflightTerminator = {
            param($terminator)
            return $true
        }
        try {
            Invoke-ParentProductionGatePreflight -Helper (Join-Path $PSHOME 'powershell.exe') -WorkingDirectory $root -ContextPath (Join-Path $root 'parent-context.json') -DiagnosticUri 'unused' -LogicalArguments @(
                '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', $workerScript,
                '-Milliseconds', '30000', '-ExitCode', '0'
            ) -TimeoutMilliseconds 100 -TerminatorTimeoutMilliseconds 3000 -ChildCleanupTimeoutMilliseconds 5000 -StartTerminator {
                param($owned)
                $owned.Kill()
                & $startWorker 1 0 'parent-preflight terminator'
            } -OwnedProcesses $ownedProcesses -RetainTerminator $retainParentPreflightTerminator
        }
        catch {
            $preflightFailure = $_.Exception
        }
        if ($null -eq $preflightFailure -or $preflightFailure.Message -notlike '*timed out*termination_completed*') {
            throw ('The parent preflight timeout regression did not use the bounded owned-process termination path. Detail: {0}' -f $(if ($null -eq $preflightFailure) { '<none>' } else { $preflightFailure.Message }))
        }

        Write-Host 'Bounded workflow wrapper self-test passed.'
    }
    finally {
        $teardown = Complete-ManualWrapperVerifierProcessTeardown -OwnedProcesses $ownedProcesses -TimeoutMilliseconds 5000
        if (-not $teardown.Succeeded) {
            throw ('Bounded workflow wrapper self-test verifier teardown timed out after 5000 milliseconds. Remaining owned processes: {0}' -f ($teardown.Remaining -join ', '))
        }
        if (Test-Path -LiteralPath $root) {
            $cleanup = Remove-ManualWorkspaceWithRetry -Workspace $root
            if (-not $cleanup.Succeeded) {
                throw "Bounded workflow wrapper self-test cleanup failed after $($cleanup.Attempts) attempt(s): $($cleanup.Detail)"
            }
            if (Test-Path -LiteralPath $root) {
                throw "Bounded workflow wrapper self-test cleanup reported success but verifier root still exists: $root"
            }
        }
    }
}

$RepositoryRoot = (Resolve-Path -LiteralPath $RepositoryRoot).Path
if ($VerifyPublicationContract) {
    $root = Join-Path ([IO.Path]::GetTempPath()) ('CreatorCrate-publication-' + [guid]::NewGuid().ToString('N'))
    [void][IO.Directory]::CreateDirectory($root)
    $oldPath = $env:PATH
    $script:PublicationPresented = $false
    $script:OfflineNativePresent = {
        param($phase, $report)
        if ($phase -ne 'helper_publication' -or -not $report.Contains('Stable error: helper_publication_failed') -or -not $report.Contains('Error class: process_setup')) { throw 'Wrong publication report.' }
        $script:PublicationPresented = $true
    }
    try {
        $publish = Join-Path $root 'publish'
        [void][IO.Directory]::CreateDirectory($publish)
        # A real native command creates the expected executable THEN returns the injected status.
        [IO.File]::WriteAllText((Join-Path $root 'dotnet.cmd'), ('@echo off' + "`r`n" + 'copy /y "' + (Join-Path $PSHOME 'powershell.exe') + '" "' + (Join-Path $publish 'OpenLocally.exe') + '" >nul' + "`r`nexit /b $VerifyPublicationExit`r`n"))
        $env:PATH = $root + ';' + $oldPath
        $continued = $false; $failed = $false
        try {
            Invoke-ManualHelperPublication -Project 'offline' -Work $root -RepositoryRoot $RepositoryRoot -ManualValidation | Out-Host
            $continued = $true # Stop at the contract: never launch the published executable.
        }
        catch { $failed = $true }
        if (-not [IO.File]::Exists((Join-Path $publish 'OpenLocally.exe'))) { throw 'Native fixture did not create the executable.' }
        if ($failed -ne ($VerifyPublicationExit -ne 0) -or $continued -ne ($VerifyPublicationExit -eq 0) -or $script:PublicationPresented -ne $failed) { throw 'Publication exit contract failed.' }
        Write-Host "PUBLICATION_PASS=$VerifyPublicationExit;existing_exe=true;helper_launched=false;ready=false;browser=false;continued=$continued"
        if ($failed) { exit 1 }
        exit 0
    }
    finally {
        $env:PATH = $oldPath
        [IO.File]::Delete((Join-Path $publish 'OpenLocally.exe'))
        [IO.File]::Delete((Join-Path $root 'dotnet.cmd'))
        [IO.Directory]::Delete($publish); [IO.Directory]::Delete($root)
    }
}

if ($VerifyFullDetailFailure) {
    foreach ($name in $PSBoundParameters.Keys) {
        if ($name -notin @('RepositoryRoot', 'VerifyFullDetailFailure', 'OfflineReportDirectory')) { throw 'Full-detail offline verification cannot be combined with other modes.' }
    }
    $root = [IO.Path]::GetFullPath($OfflineReportDirectory)
    $captureFile = Join-Path $root 'capture.txt'
    $child = Join-Path $root 'child.ps1'
    $owned = [System.Collections.Generic.List[object]]::new()
    $script:FullDetailCount = 0; $script:FullDetailExited = $false
    $script:OfflineNativePresent = {
        param($phase, $report)
        $script:FullDetailCount++
        $script:FullDetailExited = $VerifyFullDetailFailure -eq 'harness_only' -or ($owned.Count -eq 1 -and $owned[0].Process.HasExited -and [IO.File]::Exists((Join-Path $root 'finished')))
        [IO.File]::WriteAllText((Join-Path $root 'presented.txt'), $report)
        if ($VerifyFullDetailFailure -eq 'presenter_failed') { throw 'private_presenter_exception' }
    }
    [IO.File]::WriteAllText($child, @'
param($Root, $Scenario)
$capture = Join-Path $Root 'capture.txt'
if ($Scenario -ne 'helper_only') {
    $deadline = [DateTime]::UtcNow.AddSeconds(10)
    do {
        $reader = [IO.StreamReader]::new([IO.File]::Open($capture, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::ReadWrite))
        try { $text = $reader.ReadToEnd() } finally { $reader.Dispose() }
        if ($text.Contains('=== HARNESS FAILURE ===')) { break }
        Start-Sleep -Milliseconds 10
    } while ([DateTime]::UtcNow -lt $deadline)
    if (-not $text.Contains('child_exit_confirmed=false')) { exit 88 }
    [IO.File]::WriteAllText((Join-Path $Root 'primary-before-exit'), $text)
}
Start-Sleep -Milliseconds 250
if ([IO.File]::Exists((Join-Path $Root 'presented.txt'))) { exit 89 }
[IO.File]::WriteAllText((Join-Path $Root 'before-exit-count'), '0')
if ([IO.File]::Exists((Join-Path $Root 'child-stderr.txt'))) {
    [Console]::Error.Write([IO.File]::ReadAllText((Join-Path $Root 'child-stderr.txt')))
} else {
    [Console]::Error.WriteLine('chrome_connection_prompt_failed')
    if ($Scenario -ne 'missing') { [Console]::Error.WriteLine([IO.File]::ReadAllText((Join-Path $Root 'helper-report.txt'))) }
}
[Console]::Out.WriteLine('CREATORCRATE_MANUAL_PRESENTATION;state=failed;stage=set_thread_desktop;win32_code=170;session_id=987654321;input_desktop=yes;thread_desktop=no;window_created=no;window_visible=no;normal_dismissal=no')
[IO.File]::WriteAllText((Join-Path $Root 'finished'), 'yes')
exit 17
'@)
    try {
        $parameters = @{
            Helper = (Join-Path $PSHOME 'powershell.exe'); WorkingDirectory = $root
            ContextPath = (Join-Path $root 'context.json'); DiagnosticUri = 'unused'
            LogicalArguments = @('-NoProfile', '-NonInteractive', '-File', $child, $root, $VerifyFullDetailFailure)
            CapturePath = $captureFile; CaptureResult = $true; ManualPlatform = 'social_preparation'; RepositoryRoot = $RepositoryRoot
            OwnedProcesses = $owned
            BeforeHarnessOperation = {
                param($phase)
                if (($VerifyFullDetailFailure -eq 'harness_only' -and $phase -eq 'process_start') -or ($VerifyFullDetailFailure -notin @('harness_only', 'helper_only') -and $phase -eq 'ready_coordination')) {
                    if ($script:FullDetailCount -ne 0) { throw 'Premature presentation.' }
                    throw 'raw_exception_secret C:\private\private-image.png https://private.invalid token=private_token'
                }
            }
        }
        $result = Invoke-ParentProductionGatePreflight @parameters
        if ([IO.File]::Exists((Join-Path $root 'child-stderr.txt'))) {
            # Replay the exact live result composition, without invoking Ready or UI.
            $ready = 'Ready coordination: state=failed; reason=presentation'
            $result.StandardError += [Environment]::NewLine + $ready
            $script:ManualDurableFailure.ReportEvidence['ready'] = $ready
            [IO.File]::WriteAllText((Join-Path $root 'raw-stderr.txt'), $script:ManualDurableFailure.FinalStandardError)
            [IO.File]::WriteAllText((Join-Path $root 'parsed-helper.txt'), (Read-ManualSocialFailureReport -StandardError $script:ManualDurableFailure.FinalStandardError))
            if (Read-ManualSocialFailureReport -StandardError $result.StandardError) { throw 'Mixed stderr must not validate as a helper report.' }
        }
        Set-ManualAuthoritativeHelperFailure -HelperExitCode $result.HarnessExitCode -StandardOutput $result.StandardOutput -StandardError $result.StandardError -RepositoryRoot $RepositoryRoot -CapturePath $captureFile
        if ($script:FullDetailCount -ne 1 -or -not $script:FullDetailExited -or $script:ManualChildExitUnconfirmed) { throw 'Full-detail presentation was premature, missing, or duplicated.' }
        Write-Host ('FULL_DETAIL_PASS=' + $VerifyFullDetailFailure + ';count=1;exit_confirmed=true')
        exit 0
    }
    finally {
        foreach ($entry in $owned) {
            if (-not $entry.Process.HasExited) { $entry.Process.Kill(); while (-not $entry.Process.WaitForExit(1000)) { } }
            $entry.Process.Dispose()
        }
    }
}

if ($VerifyDurableHarnessFailure) {
    $root = Join-Path ([IO.Path]::GetTempPath()) ('CreatorCrate-durable-' + [guid]::NewGuid().ToString('N'))
    [void][IO.Directory]::CreateDirectory($root)
    $captureFile = Join-Path $root 'capture.txt'
    $child = Join-Path $root 'child.ps1'
    $childFinished = Join-Path $root 'finished'
    $privateText = 'C:\Users\Private\secret-image.png https://private.example token=SECRET Creator Vanity raw_exception_secret'
    $phase = $VerifyDurableHarnessFailure
    if ($phase -in @('start_false', 'start_throw', 'presenter_throw', 'presenter_bootstrap', 'presenter_failed', 'cleanup_secondary', 'finalization_secondary', 'presentation_interlock')) { $phase = 'process_start' }
    if ($phase -in @('ready_member', 'ready_presented', 'ready_failed', 'ready_malformed')) { $phase = 'ready_coordination' }
    if ($phase -eq 'stderr_reader') { $phase = 'stream_setup' }
    $script:DurablePresentCount = 0; $script:DurableReport = ''; $script:DurablePersistedBeforeUi = $false
    $script:OfflineNativePresent = {
        param($presentPhase, $report)
        $script:DurablePresentCount++
        $script:DurableReport = $report
        $reader = [IO.StreamReader]::new([IO.File]::Open($captureFile, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::ReadWrite))
        try { $text = $reader.ReadToEnd() } finally { $reader.Dispose() }
        $script:DurablePersistedBeforeUi = $text.Contains('=== HARNESS FAILURE ===') -and $text.Contains('phase=' + $phase)
        if ($script:ManualChildExitUnconfirmed) { throw 'Presentation raced child ownership.' }
        if ($VerifyDurableHarnessFailure -eq 'presenter_throw') { throw $privateText }
    }
    try {
        [IO.File]::WriteAllText($child, @'
param($Finished, $Capture, $ObserveFailure, $Marker)
if ($ObserveFailure -eq 'yes') {
    $deadline = [DateTime]::UtcNow.AddSeconds(10)
    do {
        $reader = [IO.StreamReader]::new([IO.File]::Open($Capture, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::ReadWrite))
        try { $report = $reader.ReadToEnd() } finally { $reader.Dispose() }
        if ($report.Contains('=== HARNESS FAILURE ===')) { break }
        Start-Sleep -Milliseconds 10
    } while ([DateTime]::UtcNow -lt $deadline)
    if (-not $report.Contains('=== HARNESS FAILURE ===')) { exit 88 }
}
[Console]::Out.Write(('stdout;' * 20000))
[Console]::Error.Write(('stderr;' * 20000))
if ($Marker -ne 'none') { [Console]::Out.WriteLine(); [Console]::Out.WriteLine($Marker) }
Start-Sleep -Milliseconds 200
[IO.File]::WriteAllText($Finished, 'finished')
exit 17
'@)
        $marker = switch ($VerifyDurableHarnessFailure) {
            'ready_presented' { 'CREATORCRATE_MANUAL_PRESENTATION;state=presented;stage=completed;win32_code=0;session_id=1;input_desktop=yes;thread_desktop=yes;window_created=yes;window_visible=yes;normal_dismissal=yes' }
            'ready_failed' { 'CREATORCRATE_MANUAL_PRESENTATION;state=failed;stage=open_input_desktop;win32_code=5;session_id=1;input_desktop=no;thread_desktop=no;window_created=no;window_visible=no;normal_dismissal=no' }
            'ready_malformed' { 'CREATORCRATE_MANUAL_PRESENTATION;state=presented' }
            default { 'none' }
        }
        $observeFailure = if ($phase -in @('stream_setup', 'ready_coordination', 'child_wait')) { 'yes' } else { 'no' }
        $parameters = @{
            Helper = (Join-Path $PSHOME 'powershell.exe'); WorkingDirectory = $root
            ContextPath = (Join-Path $root 'context.json'); DiagnosticUri = 'unused'
            LogicalArguments = @('-NoProfile', '-NonInteractive', '-File', $child, $childFinished, $captureFile, $observeFailure, $marker)
            CapturePath = $captureFile; CaptureResult = $true; ManualPlatform = 'patreon'; RepositoryRoot = $RepositoryRoot
            BeforeHarnessOperation = {
                param($current)
                if (($current -eq $phase -and $VerifyDurableHarnessFailure -notin @('start_false', 'start_throw', 'stderr_reader')) -or ($current -eq 'stderr_reader' -and $VerifyDurableHarnessFailure -eq 'stderr_reader')) {
                    if ($VerifyDurableHarnessFailure -eq 'presentation_interlock') { $script:ManualFailureDialogAttempted = $true }
                    if ($VerifyDurableHarnessFailure -eq 'ready_member') { [CreatorCrateOfflineMissingReadyType]::LastPresentation }
                    throw $privateText
                }
                if ($current -eq 'cleanup' -and $VerifyDurableHarnessFailure -eq 'cleanup_secondary') { throw $privateText }
                if ($current -eq 'capture_finalization' -and $VerifyDurableHarnessFailure -eq 'finalization_secondary') { throw $privateText }
            }
        }
        if ($VerifyDurableHarnessFailure -eq 'start_false') { $parameters.StartProcess = { param($process) return $false } }
        if ($VerifyDurableHarnessFailure -eq 'start_throw') { $parameters.StartProcess = { param($process) $process.StartInfo.FileName = Join-Path $root 'missing-private.exe'; $process.Start() } }
        if ($VerifyDurableHarnessFailure -eq 'presenter_bootstrap') {
            $script:OfflineNativePresent = $null
            $parameters.RepositoryRoot = Join-Path $root 'missing-sources'
        }
        if ($VerifyDurableHarnessFailure -eq 'presenter_failed') {
            # Exercise the real native-outcome branch with a harmless API-compatible stub.
            Add-Type -TypeDefinition @'
namespace OpenLocally {
 public sealed class OfflineFailureOutcome { public string ToMarker() { return "CREATORCRATE_MANUAL_PRESENTATION;state=failed;stage=create_main_window;win32_code=5"; } }
 public static class NativeFailureDialog { public static OfflineFailureOutcome Show(string summary, string report) { return new OfflineFailureOutcome(); } }
}
'@
            $script:OfflineNativePresent = $null
        }
        $failed = $false
        try { $observed = Invoke-ParentProductionGatePreflight @parameters; $failed = $observed.HarnessFailure -eq $true -or $null -ne $script:ManualDurableFailure.Primary }
        catch { $failed = $true }
        $text = [IO.File]::ReadAllText($captureFile)
        if (-not $failed -or $script:ManualAuthoritativeExitCode -eq 0) { throw 'Harness failure became success.' }
        foreach ($required in @('=== HARNESS FAILURE ===', ('phase=' + $phase), 'stable_error=', 'outcome=failed', 'error_class=', 'detail=')) {
            if (-not $text.Contains($required)) { throw 'Missing durable safe report field.' }
        }
        $expectedStable = if ($phase -eq 'process_start') { 'helper_launch_failed' } elseif ($phase -eq 'capture_finalization') { 'manual_capture_finalize_failed' } elseif ($phase -eq 'cleanup') { 'manual_cleanup_recovery_failed' } elseif ($phase -in @('native_apphost_preflight', 'process_start_info', 'ready_setup', 'launch_context', 'process_setup')) { 'native_host_context_failed' } else { 'manual_validation_failed' }
        if (-not $text.Contains('stable_error=' + $expectedStable) -or ([regex]::Matches($text, '=== HARNESS FAILURE ===')).Count -ne 1) { throw 'Primary classification was replaced or duplicated.' }
        if ($text.Contains('=== EXIT ===') -and $text.IndexOf('=== HARNESS FAILURE ===') -gt $text.LastIndexOf('=== EXIT ===')) { throw 'Final failure footer preceded the primary report.' }
        foreach ($private in @('C:\Users\Private\secret-image.png', 'https://private.example', 'token=SECRET', 'Creator Vanity', 'raw_exception_secret')) {
            if ($text.Contains($private) -or $script:DurableReport.Contains($private)) { throw 'Private failure data leaked.' }
        }
        $postStart = $phase -in @('stream_setup', 'ready_coordination', 'child_wait', 'output_collection', 'result_coordination', 'cleanup', 'capture_finalization')
        if ($postStart) {
            if (-not [IO.File]::Exists($childFinished) -or $script:ManualChildExitUnconfirmed) { throw 'Child ownership lost.' }
            if ($phase -ne 'capture_finalization' -and (-not $text.Contains('helper_exit_code=17') -or -not $text.Contains(('stdout;' * 20000)) -or -not $text.Contains(('stderr;' * 20000)))) { throw 'Child exit or exact output lost.' }
        }
        elseif (-not $text.Contains('helper_exit_code=unavailable') -and $VerifyDurableHarnessFailure -ne 'finalization_secondary') { throw 'Prelaunch failure fabricated child exit.' }
        if ($VerifyDurableHarnessFailure -notin @('presenter_failed', 'presenter_bootstrap', 'presentation_interlock', 'ready_presented') -and ($script:DurablePresentCount -ne 1 -or -not $script:DurablePersistedBeforeUi)) { throw 'Report was not flushed before exactly one presentation.' }
        if ($VerifyDurableHarnessFailure -in @('presentation_interlock', 'ready_presented') -and $script:DurablePresentCount -ne 0) { throw 'Presentation ownership was ignored.' }
        if ($VerifyDurableHarnessFailure -in @('presenter_failed', 'presenter_throw', 'presenter_bootstrap') -and -not $text.Contains('Parent presentation: state=failed')) { throw 'Presentation failure evidence missing.' }
        if ($VerifyDurableHarnessFailure -eq 'cleanup_secondary' -and -not $text.Contains('Harness supplemental: phase=cleanup')) { throw 'Cleanup evidence missing.' }
        if ($VerifyDurableHarnessFailure -eq 'finalization_secondary' -and -not $text.Contains('Harness supplemental: phase=capture_finalization')) { throw 'Finalization evidence missing.' }
        Write-Host "DURABLE_PASS=$VerifyDurableHarnessFailure;primary=$phase;child_coordinated=$postStart;privacy=pass;exit=$script:ManualAuthoritativeExitCode"
        exit $script:ManualAuthoritativeExitCode
    }
    finally {
        foreach ($file in [IO.Directory]::GetFiles($root)) { [IO.File]::Delete($file) }
        [IO.Directory]::Delete($root)
    }
}

if ($VerifyManualCoordinationDefects) {
    foreach ($name in $PSBoundParameters.Keys) {
        if ($name -notin @('RepositoryRoot', 'VerifyManualCoordinationDefects')) { throw 'Offline coordination verification cannot be combined with other modes.' }
    }
}
if ($VerifyReadyConsent) {
    foreach ($name in $PSBoundParameters.Keys) {
        if ($name -notin @('RepositoryRoot', 'VerifyReadyConsent')) { throw 'Ready verification cannot be combined with other modes.' }
    }
    if ($env:CREATORCRATE_M2_MANUAL -cne '1') { throw 'Ready verification requires CREATORCRATE_M2_MANUAL=1.' }
    $offlineRoot = Join-Path ([IO.Path]::GetTempPath()) ('CreatorCrate-m2-manual-ready-' + [guid]::NewGuid().ToString('N'))
    [void][IO.Directory]::CreateDirectory($offlineRoot)
    try {
        $publish = Join-Path $offlineRoot 'publish'
        & dotnet publish (Join-Path $RepositoryRoot 'helper/windows/src/OpenLocally/OpenLocally.csproj') -c Release -r win-x64 --self-contained true '-p:PublishSingleFile=true' --artifacts-path (Join-Path $offlineRoot 'artifacts') -o $publish
        if ($LASTEXITCODE -ne 0) { throw 'Offline helper publication failed.' }
        $assembly = Join-Path $offlineRoot 'artifacts/bin/OpenLocally/release_win-x64/OpenLocally.dll'
        $result = Invoke-ParentProductionGatePreflight -Helper (Join-Path $publish 'OpenLocally.exe') -WorkingDirectory $publish -ContextPath (Join-Path $offlineRoot 'launch.json') -DiagnosticUri 'unused' -LogicalArguments @('--verify-ready-consent') -CaptureResult -ReadyConsentAssembly $assembly -RepositoryRoot $RepositoryRoot
        Write-Host $result.StandardOutput
        Write-Host ('READY_VERIFICATION_EXIT=' + $result.ExitCode)
        if ($result.ExitCode -ne 0) { throw 'Offline Ready consent presentation failed.' }
    }
    finally {
        $cleanup = Remove-ManualWorkspaceWithRetry -Workspace $offlineRoot
        if (-not $cleanup.Succeeded) { throw 'Offline Ready workspace cleanup failed.' }
    }
    return
}

if ($VerifyPublishedManualPresentation -or $VerifyPublishedManualDesktop) {
    foreach ($name in $PSBoundParameters.Keys) {
        if ($name -notin @('RepositoryRoot', 'VerifyPublishedManualPresentation', 'VerifyPublishedManualDesktop')) { throw 'Published offline verification cannot be combined with other modes.' }
    }
    if ($VerifyPublishedManualPresentation -and $VerifyPublishedManualDesktop) { throw 'Select one published offline verification mode.' }
    if ($VerifyPublishedManualPresentation) { Assert-ManualPresentationCoordination }
    $offlineRoot = Join-Path ([IO.Path]::GetTempPath()) ('CreatorCrate-m2-manual-presentation-' + [guid]::NewGuid().ToString('N'))
    New-Item -ItemType Directory -Path $offlineRoot | Out-Null
    try {
        $publish = Join-Path $offlineRoot 'publish'
        & dotnet publish (Join-Path $RepositoryRoot 'helper/windows/src/OpenLocally/OpenLocally.csproj') -c Release -r win-x64 --self-contained true '-p:PublishSingleFile=true' --artifacts-path (Join-Path $offlineRoot 'artifacts') -o $publish
        if ($LASTEXITCODE -ne 0) { throw 'Offline helper publication failed.' }
        $helper = Join-Path $publish 'OpenLocally.exe'
        $scenarios = if ($VerifyPublishedManualDesktop) { @('desktop') } else { @('presented', 'failed', 'missing', 'malformed', 'both_failed') }
        foreach ($scenario in $scenarios) {
            $script:ManualFailureDialogAttempted = $false
            $script:ManualAuthoritativeExitCode = $null
            $script:ManualParentPresentation = $null
            $script:OfflineFallbackCount = 0
            $script:OfflineFallbackReport = ''
            if (-not $VerifyPublishedManualDesktop) {
                $script:OfflineNativePresent = {
                    param($Phase, $Report)
                    $script:OfflineFallbackCount++
                    $script:OfflineFallbackReport = $Report
                    if ($scenario -eq 'both_failed') { throw 'Offline fallback failed.' }
                }
            }
            $childScenario = if ($scenario -eq 'both_failed') { 'failed' } else { $scenario }
            $capture = Join-Path $offlineRoot ($scenario + '.txt')
            # All three arguments enter the existing command-invalid preflight,
            # before any environment, Chrome, CDP, or platform dependency.
            $result = Invoke-ParentProductionGatePreflight -Helper $helper -WorkingDirectory $publish -ContextPath (Join-Path $offlineRoot 'launch.json') -DiagnosticUri 'unused' -LogicalArguments @('--validate-patreon-preparation', '--offline-presentation-verification', $childScenario) -CaptureResult -CapturePath $capture -CaptureCommand 'offline_manual_presentation' -ManualPlatform 'patreon' -RepositoryRoot $RepositoryRoot
            if ($result.ExitCode -ne 1 -or $result.StandardError -notmatch 'manual_patreon_validation_command_invalid') { throw 'Real child did not traverse the expected manual preflight/reporter.' }
            Set-ManualAuthoritativeHelperFailure -HelperExitCode $result.ExitCode -StandardOutput $result.StandardOutput -StandardError $result.StandardError -RepositoryRoot $RepositoryRoot -CapturePath $capture
            if (-not $VerifyPublishedManualDesktop) {
                $expected = if ($scenario -eq 'presented') { 0 } else { 1 }
                if ($script:OfflineFallbackCount -ne $expected -or $script:ManualAuthoritativeExitCode -ne 1) { throw 'Real-child presentation coordination failed.' }
                $expectedReport = Read-ManualSocialFailureReport -StandardError $result.StandardError
                if (-not $expectedReport.Contains('Stable error: manual_patreon_validation_command_invalid')) { throw 'Published child did not emit a valid detailed report.' }
                if ($expected -eq 1 -and -not $script:OfflineFallbackReport.Contains($expectedReport)) { throw 'Fallback lost the full primary report.' }
                if ($scenario -eq 'both_failed' -and ($script:ManualParentPresentation -notmatch '^failed;' -or $script:ManualChildPresentation -notmatch 'state=failed;stage=open_input_desktop;win32_code=5')) { throw 'Both-failure evidence was lost.' }
                # Re-enter the same boundary: no recursive retry or cleanup duplicate.
                $errorRecord = [System.Management.Automation.ErrorRecord]::new([InvalidOperationException]::new('Workspace cleanup failed'), 'offline_cleanup', [System.Management.Automation.ErrorCategory]::InvalidOperation, $null)
                Invoke-ManualFailureDialogBoundary -ErrorRecord $errorRecord -RepositoryRoot $RepositoryRoot -Platform 'patreon'
                if ($script:OfflineFallbackCount -ne $expected) { throw 'Cleanup duplicated fallback.' }
                Write-Host ('PUBLISHED_OFFLINE_PASS={0};fallbacks={1};helper_exit=1' -f $scenario, $expected)
            }
            Write-Host ('CHILD_PRESENTATION={0}' -f $script:ManualChildPresentation)
            Write-Host ('PARENT_PRESENTATION={0}' -f $script:ManualParentPresentation)
        }
    }
    finally {
        $script:OfflineNativePresent = $null
        $cleanup = Remove-ManualWorkspaceWithRetry -Workspace $offlineRoot
        if (-not $cleanup.Succeeded) { Write-Warning 'Offline verification workspace cleanup failed.' }
    }
    return
}

if ($VerifyManualFailureFullFlow) {
    # Reject mixed modes before any verifier can return early or show real UI.
    foreach ($name in $PSBoundParameters.Keys) {
        if ($name -notin @('RepositoryRoot', 'VerifyManualFailureFullFlow', 'OfflineHelperExitCode', 'OfflinePresentationFails', 'OfflineCleanupFails', 'OfflinePostHelperFailure', 'CapturePath')) {
            throw 'Offline full-flow verification cannot be combined with other modes.'
        }
    }
    if ($OfflinePostHelperFailure -and [string]::IsNullOrWhiteSpace($CapturePath)) { throw 'Offline durable verification requires a capture destination.' }
    if ($CapturePath -and -not $OfflinePostHelperFailure) { throw 'Offline capture requires post-helper verification.' }
    $RunPatreonManualValidation = $true
    $script:OfflineNativePresent = {
        param($Phase, $Report)
        Write-Host ('OFFLINE_NATIVE_PRESENTATION_ATTEMPT={0}' -f $Phase)
        if ($OfflinePresentationFails) { throw 'Offline native presentation failure.' }
    }
}
elseif ($PSBoundParameters.Keys | Where-Object { $_ -like 'Offline*' }) {
    throw 'Offline injection requires VerifyManualFailureFullFlow.'
}
$project = Join-Path $RepositoryRoot 'helper\windows\src\OpenLocally\OpenLocally.csproj'
$tests = Join-Path $RepositoryRoot 'helper\windows\tests\OpenLocally.Tests\OpenLocally.Tests.csproj'
if (-not (Test-Path -LiteralPath $project) -or -not (Test-Path -LiteralPath $tests)) {
    throw 'RepositoryRoot must contain the CreatorCrate Windows helper project and test project.'
}

if ($VerifyEventStreamReader) {
    Assert-ManualWorkflowEventReader
    return
}

if ($VerifyProcessStartInfoArguments) {
    Assert-ManualProcessStartInfoArgumentRoundTrips
    return
}

if ($VerifyHelperOutputCapture) {
    Assert-ManualHelperOutputCapture
    return
}

if ($VerifyManualCoordinationDefects) {
    $verifiedExit = Assert-ManualCoordinationDefects -Scenario $VerifyManualCoordinationDefects
    exit $verifiedExit
}

if ($VerifyManualFailureRouting) {
    Assert-ManualFailureRouting
    return
}

if ($VerifyManualFailureDialog) {
    $offlineReport = New-ManualFailureDialogReport -Platform 'patreon' -Phase 'create_activation' -StableError 'platform_preparation_failed' -ErrorClass 'cdp_command' -AdditionalLines @(
        'Adapter: patreon_social_preparation',
        'CDP operation: scroll_into_view',
        'CDP code: -32000',
        'CDP message: Node does not have a layout object',
        'Checkpoints:',
        '  creator_page_ready: yes',
        '  owned_target_created: yes',
        'Cleanup:',
        '  cleanup_attempted: yes',
        '  cleanup_succeeded: yes',
        ('  horizontal_scroll_probe: ' + ('x' * 1024))
    )
    Show-ManualFailureDialog -RepositoryRoot $RepositoryRoot -Platform 'patreon' -Phase 'create_activation' -Report $offlineReport
    return
}

if ($VerifyOperatorResponseChannel) {
    Assert-ManualOperatorResponseChannel
    return
}

if ($VerifyOperatorInputDeadline) {
    Assert-ManualOperatorInputDeadline
    return
}

if ($VerifyBoundedWorkflowWrapper) {
    Assert-ManualBoundedWorkflowWrapper
    return
}

if ($VerifyDiagnosticSocialUri) {
    $diagnosticUri = Get-ManualDiagnosticSocialUri -RepositoryRoot $RepositoryRoot
    [pscustomobject]@{
        Invocation = 'parent-wrapper-diagnostic-social-uri'
        ArgumentCount = 1
        UriSha256 = Get-ManualTextSha256 -Text $diagnosticUri
    } | ConvertTo-Json -Compress
    return
}

if ($VerifyTokenDiagnostics) {
    $tokenDiagnostics = Get-ManualTokenDiagnostics
    [pscustomobject]@{
        ProcessId = $tokenDiagnostics.ProcessId
        IsElevated = $tokenDiagnostics.IsElevated
        ElevationType = $tokenDiagnostics.ElevationType
        IntegrityLevel = $tokenDiagnostics.IntegrityLevel
        IsAppContainer = $tokenDiagnostics.IsAppContainer
        InspectionStatus = $tokenDiagnostics.InspectionStatus
    } | ConvertTo-Json -Compress
    return
}

if ($VerifyNativeAppHostPreflight) {
    $currentProcess = [Diagnostics.Process]::GetCurrentProcess()
    try {
        $executable = $currentProcess.MainModule.FileName
        if ([string]::IsNullOrWhiteSpace($executable)) {
            throw 'Current PowerShell executable path is unavailable for native apphost preflight verification.'
        }
        $command = Get-Command Test-NativeAppHostPreflight
        $preflight = Test-NativeAppHostPreflight -Executable $executable -WorkingDirectory ([IO.Path]::GetTempPath())
        [pscustomobject]@{
            Invocation = 'parent-wrapper'
            ParameterSets = @($command.ParameterSets | ForEach-Object Name)
            ExecutablePath = $preflight.ExecutablePath
            WorkingDirectory = $preflight.WorkingDirectory
            ReadAccessConfirmed = $preflight.ReadAccessConfirmed
        } | ConvertTo-Json -Compress
    }
    finally {
        $currentProcess.Dispose()
    }
    return
}

$registryPaths = @(
    'HKCU:\Software\Classes\creatorcrate-open',
    'HKCU:\Software\Classes\creatorcrate-social',
    'HKCU:\Software\CreatorCrate\SocialPreparation\TrustedOrigins',
    'HKCU:\Software\CreatorCrate\SocialPreparation\TrustedMediaRoots'
)
$openLocallyPath = 'HKCU:\Software\Classes\creatorcrate-open'
$script:ManualFailureBoundaryActive = $true
$script:ManualFailurePlatform = if ($RunPatreonManualValidation) { 'patreon' } else { 'social_preparation' }
trap {
    if ($script:ManualFailureBoundaryActive -and ($null -eq $script:ManualDurableFailure -or $null -eq $script:ManualDurableFailure.Primary)) {
        Invoke-ManualFailureDialogBoundary -ErrorRecord $_ -RepositoryRoot $RepositoryRoot -Platform $script:ManualFailurePlatform
    }
    # Resume after the failed outer statement (including its finally), then use
    # the single authoritative exit below. Without a retained failure, fail closed.
    if ($null -ne $script:ManualAuthoritativeExitCode -and $script:ManualAuthoritativeExitCode -ne 0) { continue }
    throw $_
}

if (-not [string]::IsNullOrWhiteSpace($RecoverFrom)) {
    $recoveryPath = (Resolve-Path -LiteralPath $RecoverFrom).Path
    $workspace = Get-ManualWorkspaceFromRecoveryPath -RecoveryPath $recoveryPath
    $recoverySnapshots = Import-Clixml -LiteralPath $recoveryPath
    if ($recoverySnapshots -isnot [hashtable]) {
        throw "Recovery data '$recoveryPath' does not contain this wrapper's registry snapshot collection."
    }

    $recoveryFailures = @(Invoke-RegistryRestoration -Paths $registryPaths -Snapshots $recoverySnapshots -OpenLocallyPath $openLocallyPath)
    if ($recoveryFailures.Count -gt 0) {
        foreach ($failure in $recoveryFailures) {
            Write-Warning ("Recovery failure [{0}] {1}; originally existed: {2}; snapshot: {3}; detail: {4}" -f $failure.Phase, $failure.Target, $failure.OriginallyExisted, $recoveryPath, $failure.Detail)
        }
        throw "Registry recovery failed after attempting every captured root. Recovery data was retained at '$recoveryPath'."
    }

    $workspaceCleanup = Remove-ManualWorkspaceWithRetry -Workspace $workspace
    if (-not $workspaceCleanup.Succeeded) {
        throw "Registry recovery completed, but workspace cleanup failed after $($workspaceCleanup.Attempts) attempt(s) over $ManualCleanupRetryWindowSeconds second(s): $($workspaceCleanup.Detail). Recovery data was retained at '$recoveryPath'."
    }

    Write-Host "Registry recovery and workspace cleanup completed from '$recoveryPath' after $($workspaceCleanup.Attempts) attempt(s)."
    return
}

if (-not $VerifyManualFailureFullFlow -and $env:CREATORCRATE_M2_MANUAL -cne '1') {
    throw 'Manual workflow is disabled. Set CREATORCRATE_M2_MANUAL=1 explicitly to run it.'
}

$work = Join-Path $env:TEMP ('CreatorCrate-m2-manual-' + [guid]::NewGuid().ToString('N'))
$recovery = Join-Path $work 'registry-recovery.clixml'
$environmentNames = @(
    'CREATORCRATE_M2_MANUAL',
    'CREATORCRATE_M2_HELPER_EXE',
    'CREATORCRATE_M2_MANUAL_STAGING_ROOT',
    'CREATORCRATE_M2_WORKFLOW_EVENTS',
    'CREATORCRATE_M2_OPERATOR_RESPONSE_DIR',
    'CREATORCRATE_M2_TESTHOST_LAUNCH_CONTEXT',
    'CREATORCRATE_M2_PUBLISH_DESCRIPTOR',
    'CREATORCRATE_M2_DIAGNOSTIC_SOCIAL_URI'
)
$snapshots = @{}
$environmentSnapshots = @{}
$snapshotPreflightCompleted = $false
$manualMutationMayHaveBegun = $false
$registryRootsMayHaveBeenMutated = @()
$helper = $null

foreach ($name in $environmentNames) {
    $environmentSnapshots[$name] = Get-EnvironmentSnapshot -Name $name
}

New-Item -ItemType Directory -Path $work | Out-Null
try {
    if (-not $VerifyManualFailureFullFlow) {
        foreach ($path in $registryPaths) {
            $snapshots[$path] = Get-RegistrySnapshot -Path $path
        }
        $snapshots | Export-Clixml -LiteralPath $recovery
        $snapshotPreflightCompleted = $true

        $publish = Join-Path $work 'publish'
        Invoke-ManualHelperPublication -Project $project -Work $work -RepositoryRoot $RepositoryRoot -ManualValidation:$RunPatreonManualValidation | Out-Host
        $helper = Join-Path $publish 'OpenLocally.exe'
        if ($RunPatreonManualValidation -and [string]::IsNullOrWhiteSpace($CapturePath)) {
            $report = New-ManualFailureDialogReport -Platform 'patreon' -Phase 'harness_preflight' -StableError 'required_manual_input_missing' -ErrorClass 'validation' -AdditionalLines @('Missing input: CapturePath')
            Show-ManualFailureDialog -RepositoryRoot $RepositoryRoot -Platform 'patreon' -Phase 'harness_preflight' -Report $report
            throw 'CapturePath is required for manual Patreon validation so failure output is durably retained before helper launch.'
        }
        $diagnosticUri = if ($RunPatreonManualValidation) { 'unused' } else { Get-ManualDiagnosticSocialUri -RepositoryRoot $RepositoryRoot }

        $events = Join-Path $work 'workflow-events.jsonl'
        $confirmationDirectory = Join-Path $work 'confirmations'
        $parentWorkingDirectory = Join-Path $work 'parent-published-helper'
        $parentLaunchContextPath = Join-Path $work 'parent-launch-context.json'
        $testHostLaunchContextPath = Join-Path $work 'testhost-launch-context.json'
        New-Item -ItemType Directory -Path $confirmationDirectory | Out-Null
        New-Item -ItemType Directory -Path $parentWorkingDirectory | Out-Null
        New-Item -ItemType File -Path $events | Out-Null

        $env:CREATORCRATE_M2_HELPER_EXE = $helper
        $env:CREATORCRATE_M2_MANUAL_STAGING_ROOT = Join-Path $work 'staging'
        $env:CREATORCRATE_M2_WORKFLOW_EVENTS = $events
        $env:CREATORCRATE_M2_OPERATOR_RESPONSE_DIR = $confirmationDirectory
        $env:CREATORCRATE_M2_TESTHOST_LAUNCH_CONTEXT = $testHostLaunchContextPath
        $env:CREATORCRATE_M2_PUBLISH_DESCRIPTOR = 'win-x64;self-contained=true;single-file=true'
        $env:CREATORCRATE_M2_DIAGNOSTIC_SOCIAL_URI = $diagnosticUri
        $registryRootsMayHaveBeenMutated = @($registryPaths)
        $manualMutationMayHaveBegun = $true
    }

    $parentLaunchContext = $null
    try {
        if ($RunPatreonManualValidation) {
            Write-Host 'MANUAL CHECK - Patreon manual validation through the published helper.'
            if ($VerifyManualFailureFullFlow -and $OfflinePostHelperFailure) {
                $child = Join-Path $work 'offline-child.ps1'
                [IO.File]::WriteAllText($child, "[Console]::Out.Write('offline-stdout'); [Console]::Error.Write('offline-stderr'); exit 17")
                $testHostLaunchContextPath = Join-Path $work 'offline-context.json'
                [IO.File]::WriteAllText($testHostLaunchContextPath, '{ private_context token=SECRET https://private.example C:\private\secret.png')
                $parameters = @{
                    Helper = (Join-Path $PSHOME 'powershell.exe'); WorkingDirectory = $work
                    ContextPath = (Join-Path $work 'offline-parent.json'); DiagnosticUri = 'unused'
                    LogicalArguments = @('-NoProfile', '-NonInteractive', '-File', $child)
                    CaptureResult = $true; CapturePath = $CapturePath; ManualPlatform = 'patreon'; RepositoryRoot = $RepositoryRoot
                }
                if ($OfflinePostHelperFailure -eq 'no_result') {
                    $parameters.BeforeHarnessOperation = { param($phase) if ($phase -eq 'process_start') { throw 'private_context token=SECRET' } }
                }
                $patreonResult = Invoke-ParentProductionGatePreflight @parameters
            }
            elseif ($VerifyManualFailureFullFlow) {
                # Simulate the helper-owned best-effort attempt, not parent state.
                # Only the shared result handling below may record parent ownership.
                if ($OfflineHelperExitCode -ne 0) {
                    try { & $script:OfflineNativePresent 'helper' 'Offline helper failure.' }
                    catch { Write-Host 'OFFLINE_HELPER_PRESENTATION_FAILED=1' }
                }
                $patreonResult = [pscustomobject]@{
                    ExitCode = $OfflineHelperExitCode
                    HarnessExitCode = $OfflineHelperExitCode
                    StandardError = 'Offline helper failure.'
                    StandardOutput = if ($OfflinePresentationFails) { '' } else { 'CREATORCRATE_MANUAL_PRESENTATION;state=presented;stage=completed;win32_code=0;session_id=0;input_desktop=yes;thread_desktop=yes;window_created=yes;window_visible=yes;normal_dismissal=yes' }
                    LaunchContext = $null
                }
            }
            else {
                $patreonResult = Invoke-ParentProductionGatePreflight -Helper $helper -WorkingDirectory $parentWorkingDirectory -ContextPath $parentLaunchContextPath -DiagnosticUri $diagnosticUri -LogicalArguments @('--validate-patreon-preparation') -CaptureResult -CapturePath $CapturePath -CaptureCommand '--validate-patreon-preparation' -ManualPlatform 'patreon' -RepositoryRoot $RepositoryRoot -ReadyConsentAssembly (Join-Path $work 'artifacts/bin/OpenLocally/release_win-x64/OpenLocally.dll')
            }
            $parentLaunchContext = $patreonResult.LaunchContext
            if (-not [string]::IsNullOrWhiteSpace($CapturePath)) {
                Write-Host ("CAPTURE_ARTIFACT={0}" -f [IO.Path]::GetFullPath($CapturePath))
            }
            Write-Host ("PATREON_MANUAL_EXIT_CODE={0}" -f $patreonResult.ExitCode)
            if ($patreonResult.HarnessExitCode -ne 0) {
                Set-ManualAuthoritativeHelperFailure -HelperExitCode $patreonResult.HarnessExitCode -StandardOutput $patreonResult.StandardOutput -StandardError $patreonResult.StandardError -RepositoryRoot $RepositoryRoot -CapturePath $CapturePath
                Show-ManualHelperFailureReport -HelperExitCode $patreonResult.ExitCode -StandardError $patreonResult.StandardError -CapturePath $CapturePath
            }
        }

        else {
            Write-Host 'MANUAL CHECK - Parent wrapper production-gate preflight'
            Write-Host 'Verify the temporary published helper reaches the production adapter gate before any fixture request.'
            $parentLaunchContext = Invoke-ParentProductionGatePreflight -Helper $helper -WorkingDirectory $parentWorkingDirectory -ContextPath $parentLaunchContextPath -DiagnosticUri $diagnosticUri

            Write-Host 'Manual harness preparation completed. Starting the deterministic Manual workflow.'
            Invoke-ManualWorkflow -RepositoryRoot $RepositoryRoot -Tests $tests -Artifacts (Join-Path $work 'test-artifacts') -Events $events -ConfirmationDirectory $confirmationDirectory
            Write-Host 'MANUAL CHECK: overall PASS.'
        }
    }
    finally {
        if ($null -ne $parentLaunchContext) {
            Show-ManualLaunchContextComparison -ParentContext $parentLaunchContext -TestHostContextPath $testHostLaunchContextPath
        }
        else {
            Write-Host 'MANUAL DIAGNOSTIC - Parent wrapper launch failed before VSTest testhost launch began.'
        }
    }
}
catch {
    # Capture-owned reporting boundary: persist the original operation before
    # outer cleanup can change the retained phase or add supplemental evidence.
    if ($null -ne $script:ManualDurableFailure) {
        Invoke-ManualFailureDialogBoundary -ErrorRecord $_ -RepositoryRoot $RepositoryRoot -Platform $script:ManualFailurePlatform
    }
    throw
}
finally {
    if ($VerifyManualFailureFullFlow -and $OfflinePostHelperFailure) {
        # Snapshot the actual durable artifact at cleanup entry, not retained state.
        [IO.File]::Copy($CapturePath, ($CapturePath + '.cleanup-entry'), $true)
    }
    $recoveryFailures = [System.Collections.Generic.List[object]]::new()

    if ($manualMutationMayHaveBegun -and $snapshotPreflightCompleted) {
        foreach ($failure in @(Invoke-RegistryRestoration -Paths $registryRootsMayHaveBeenMutated -Snapshots $snapshots -OpenLocallyPath $openLocallyPath)) {
            $recoveryFailures.Add($failure) | Out-Null
        }
    }

    foreach ($name in $environmentNames) {
        try {
            Restore-EnvironmentSnapshot -Name $name -Snapshot $environmentSnapshots[$name]
        }
        catch {
            $recoveryFailures.Add((New-RecoveryFailure -Phase 'environment' -Target $name -Snapshot $null -Detail $_.Exception.Message)) | Out-Null
        }
    }

    if ($recoveryFailures.Count -eq 0) {
        $workspaceCleanup = Remove-ManualWorkspaceWithRetry -Workspace $work
        if ($VerifyManualFailureFullFlow) {
            # Remove the real temporary workspace first; inject only its outcome.
            if (-not $workspaceCleanup.Succeeded) { throw 'Offline workspace removal failed.' }
            Write-Host 'OFFLINE_OUTER_CLEANUP_REACHED=1'
            if ($OfflineCleanupFails) {
                $workspaceCleanup = [pscustomobject]@{ Succeeded = $false; Attempts = 1; Detail = 'Offline cleanup failure.' }
            }
        }
        if (-not $workspaceCleanup.Succeeded) {
            $detail = "Workspace cleanup failed after $($workspaceCleanup.Attempts) attempt(s) over $ManualCleanupRetryWindowSeconds second(s): $($workspaceCleanup.Detail)"
            $recoveryFailures.Add((New-RecoveryFailure -Phase 'cleanup' -Target $work -Snapshot $null -Detail $detail)) | Out-Null
        }
    }

    if ($recoveryFailures.Count -gt 0) {
        $recoveryCommand = if (Test-Path -LiteralPath $recovery) {
            Format-RecoveryCommand -RepositoryRoot $RepositoryRoot -RecoveryPath $recovery
        }
        else {
            'No recovery export is available because preflight did not complete before any Manual registry mutation.'
        }

        Complete-ManualCleanupOutcome -RecoveryFailures $recoveryFailures -Workspace $work -RecoveryCommand $recoveryCommand
    }
}

if ($null -ne $script:ManualAuthoritativeExitCode -and $script:ManualAuthoritativeExitCode -ne 0) {
    exit $script:ManualAuthoritativeExitCode
}
