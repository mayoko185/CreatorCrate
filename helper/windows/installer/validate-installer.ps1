#requires -Version 7.0

<#
.SYNOPSIS
    Validates the CreatorCrate Windows installer source and, optionally, its
    complete production payload mapping.

.DESCRIPTION
    The default mode is static: it validates installer identity, per-user
    behavior, protocol wiring, branding, and the separation between the D1
    production publish input and installer artifact output.

    With -ValidatePayload, the script requires the existing D1 production
    publish, runs the canonical production-publish validator first, and then
    proves that the recursive Inno source rule maps every publish file while
    preserving relative subdirectories. It never republishes or compiles the
    installer.
#>
[CmdletBinding()]
param(
    [switch]$ValidatePayload,

    [Parameter(DontShow)]
    [string]$PayloadDenylistFixturePath,

    [Parameter(DontShow)]
    [string]$InstallerSourcePath
)

$ErrorActionPreference = 'Stop'

$installerDir = [System.IO.Path]::GetFullPath($PSScriptRoot)
$windowsRoot = [System.IO.Path]::GetFullPath((Join-Path $installerDir '..'))
$repositoryRoot = [System.IO.Path]::GetFullPath((Join-Path $windowsRoot '..\..'))
$issPath = if ($InstallerSourcePath) {
    [System.IO.Path]::GetFullPath($InstallerSourcePath)
}
else {
    Join-Path $installerDir 'CreatorCrate.OpenLocally.iss'
}
$dispatcherPath = Join-Path $windowsRoot 'src\OpenLocally\CommandDispatcher.cs'
$registrarPath = Join-Path $windowsRoot 'src\OpenLocally\ProtocolRegistrar.cs'
$socialRegistrarPath = Join-Path $windowsRoot 'src\OpenLocally\SocialProtocolRegistrar.cs'
$csprojPath = Join-Path $windowsRoot 'src\OpenLocally\OpenLocally.csproj'
$productionValidatorPath = Join-Path $windowsRoot 'scripts\validate-production-publish.ps1'
$expectedPublishPath = [System.IO.Path]::GetFullPath(
    (Join-Path $repositoryRoot 'dist\windows-helper\production\win-x64'))
$expectedOutputPath = [System.IO.Path]::GetFullPath(
    (Join-Path $repositoryRoot 'dist\windows-helper\installer'))
$expectedIconPath = [System.IO.Path]::GetFullPath(
    (Join-Path $windowsRoot 'src\OpenLocally\CreatorCrate.ico'))
$evidencePath = [System.IO.Path]::GetFullPath(
    (Join-Path $repositoryRoot 'dist\windows-helper\evidence'))

$failures = [System.Collections.Generic.List[string]]::new()
$checks = [System.Collections.Generic.List[string]]::new()

function Assert-Condition {
    param(
        [bool]$Condition,
        [string]$Name,
        [string]$Detail
    )

    if ($Condition) {
        $script:checks.Add("PASS  $Name")
    }
    else {
        $script:failures.Add("FAIL  $Name`n      $Detail")
    }
}

function Get-InnoDefine {
    param(
        [string]$Text,
        [string]$Name
    )

    $match = [regex]::Match(
        $Text,
        "(?im)^\s*#define\s+$([regex]::Escape($Name))\s+`"(?<value>[^`"]+)`"\s*$")
    if ($match.Success) {
        return $match.Groups['value'].Value.Trim()
    }
    return $null
}

function Get-InnoSection {
    param(
        [string]$Text,
        [string]$Name
    )

    $match = [regex]::Match(
        $Text,
        "(?ims)^\s*\[$([regex]::Escape($Name))\]\s*(?<body>.*?)(?=^\s*\[[A-Za-z][A-Za-z0-9]*\]\s*(?:;.*)?$|\z)")
    if ($match.Success) {
        return $match.Groups['body'].Value
    }
    return ''
}

function Remove-InnoPascalComments {
    param([string]$Text)

    $sanitized = [System.Text.StringBuilder]::new($Text.Length)
    $state = 'Code'
    $index = 0

    while ($index -lt $Text.Length) {
        $character = $Text[$index]
        $nextCharacter = if ($index + 1 -lt $Text.Length) {
            $Text[$index + 1]
        }
        else {
            [char]0
        }

        switch ($state) {
            'Code' {
                if ($character -eq "'") {
                    [void]$sanitized.Append($character)
                    $state = 'String'
                }
                elseif ($character -eq '{') {
                    [void]$sanitized.Append(' ')
                    $state = 'BraceComment'
                }
                elseif ($character -eq '(' -and $nextCharacter -eq '*') {
                    [void]$sanitized.Append(' ')
                    [void]$sanitized.Append(' ')
                    $index++
                    $state = 'BlockComment'
                }
                elseif ($character -eq '/' -and $nextCharacter -eq '/') {
                    [void]$sanitized.Append(' ')
                    [void]$sanitized.Append(' ')
                    $index++
                    $state = 'LineComment'
                }
                else {
                    [void]$sanitized.Append($character)
                }
            }
            'String' {
                [void]$sanitized.Append($character)
                if ($character -eq "'") {
                    if ($nextCharacter -eq "'") {
                        [void]$sanitized.Append($nextCharacter)
                        $index++
                    }
                    else {
                        $state = 'Code'
                    }
                }
            }
            'BraceComment' {
                if ($character -eq "`r" -or $character -eq "`n") {
                    [void]$sanitized.Append($character)
                }
                else {
                    [void]$sanitized.Append(' ')
                }
                if ($character -eq '}') {
                    $state = 'Code'
                }
            }
            'BlockComment' {
                if ($character -eq '*' -and $nextCharacter -eq ')') {
                    [void]$sanitized.Append(' ')
                    [void]$sanitized.Append(' ')
                    $index++
                    $state = 'Code'
                }
                elseif ($character -eq "`r" -or $character -eq "`n") {
                    [void]$sanitized.Append($character)
                }
                else {
                    [void]$sanitized.Append(' ')
                }
            }
            'LineComment' {
                if ($character -eq "`r" -or $character -eq "`n") {
                    [void]$sanitized.Append($character)
                    $state = 'Code'
                }
                else {
                    [void]$sanitized.Append(' ')
                }
            }
        }

        $index++
    }

    return $sanitized.ToString()
}

function Get-InnoRoutine {
    param(
        [string]$Code,
        [string]$Name
    )

    $match = [regex]::Match(
        $Code,
        "(?ims)^\s*(?:function|procedure)\s+$([regex]::Escape($Name))\b(?<body>.*?)(?=^\s*(?:function|procedure)\s+[A-Za-z_]\w*\b|\z)")
    if ($match.Success) {
        return $match.Value
    }
    return ''
}

function Get-InnoBeginBranch {
    param(
        [string]$Routine,
        [string]$ConditionPattern
    )

    $match = [regex]::Match(
        $Routine,
        "(?ims)^\s*if\s+$ConditionPattern\s+then\s*\r?\n\s*begin\s*\r?\n(?<body>.*?)^\s*end\s*;")
    if ($match.Success) {
        return $match.Groups['body'].Value
    }
    return ''
}

function Get-InnoSetting {
    param(
        [string]$Section,
        [string]$Name
    )

    $match = [regex]::Match(
        $Section,
        "(?im)^\s*$([regex]::Escape($Name))\s*=\s*(?<value>[^;\r\n]+?)\s*(?:;.*)?$")
    if ($match.Success) {
        return $match.Groups['value'].Value.Trim()
    }
    return $null
}

function Get-InstallerRelativePath {
    param([string]$Path)

    if ([string]::IsNullOrWhiteSpace($Path)) {
        return $null
    }
    return [System.IO.Path]::GetFullPath((Join-Path $installerDir $Path))
}

function Test-SamePath {
    param(
        [string]$Left,
        [string]$Right
    )

    return $Left.Equals($Right, [System.StringComparison]::OrdinalIgnoreCase)
}

function Test-SameOrNestedPath {
    param(
        [string]$Candidate,
        [string]$Parent
    )

    if (Test-SamePath $Candidate $Parent) {
        return $true
    }
    $parentWithSeparator = $Parent.TrimEnd(
        [System.IO.Path]::DirectorySeparatorChar,
        [System.IO.Path]::AltDirectorySeparatorChar) + [System.IO.Path]::DirectorySeparatorChar
    return $Candidate.StartsWith(
        $parentWithSeparator,
        [System.StringComparison]::OrdinalIgnoreCase)
}

function Get-MappedProofOrTestArtifacts {
    param([string[]]$RelativePaths)

    return @(
        $RelativePaths | Where-Object {
            $_ -match '(?i)(^|[\\/])(OpenLocally\.WinUiHost\.Proof[^\\/]*|LocalOleDropTarget[^\\/]*|ManualVisualProofFixture[^\\/]*|UserObjectIsolation[^\\/]*|test-results)([\\/]|$)' -or
            [System.IO.Path]::GetFileName($_) -match '(?i)^(INTERACTIVE-PROOF\.txt|USER-OBJECT-ISOLATION\.md|testhost.*|xunit.*|Microsoft\.TestPlatform.*)$'
        }
    )
}

function Test-ExpectedDowngradeDecision {
    param(
        [bool]$ProductDetected,
        [AllowNull()]
        [string]$InstalledVersion,
        [string]$CandidateVersion
    )

    if (-not $ProductDetected -or [string]::IsNullOrWhiteSpace($InstalledVersion)) {
        return $false
    }

    $installed = $null
    $candidate = $null
    if (-not [System.Version]::TryParse($InstalledVersion, [ref]$installed)) {
        return $false
    }
    if (-not [System.Version]::TryParse($CandidateVersion, [ref]$candidate)) {
        throw "Invalid candidate version in validator: $CandidateVersion"
    }

    return $installed -gt $candidate
}

if ($PayloadDenylistFixturePath) {
    $fixtureRoot = (Resolve-Path -LiteralPath $PayloadDenylistFixturePath).Path
    $fixtureRelativePaths = @(
        Get-ChildItem -LiteralPath $fixtureRoot -Recurse -File |
            Sort-Object FullName |
            ForEach-Object { [System.IO.Path]::GetRelativePath($fixtureRoot, $_.FullName) }
    )
    $fixtureDeniedArtifacts = @(Get-MappedProofOrTestArtifacts $fixtureRelativePaths)
    if ($fixtureDeniedArtifacts.Count -gt 0) {
        Write-Output 'VALIDATION FAILED:'
        Write-Output "FAIL  Installer payload denylist fixture`n      Mapped proof/test artifacts: $($fixtureDeniedArtifacts -join ', ')"
        exit 1
    }
    Write-Output "VALIDATION PASSED - installer payload denylist fixture: $fixtureRoot"
    exit 0
}

foreach ($requiredSource in @(
        $issPath,
        $dispatcherPath,
        $registrarPath,
        $socialRegistrarPath,
        $csprojPath,
        $productionValidatorPath,
        $expectedIconPath)) {
    Assert-Condition (Test-Path -LiteralPath $requiredSource -PathType Leaf) `
        "Required source exists: $([System.IO.Path]::GetFileName($requiredSource))" `
        "Required source file not found: $requiredSource"
}

if (-not (Test-Path -LiteralPath $issPath -PathType Leaf)) {
    throw "Installer script not found: $issPath"
}

$iss = Get-Content -LiteralPath $issPath -Raw
$setup = Get-InnoSection $iss 'Setup'
$filesSection = Get-InnoSection $iss 'Files'
$runSection = Get-InnoSection $iss 'Run'
$uninstallRunSection = Get-InnoSection $iss 'UninstallRun'
$rawCodeSection = Get-InnoSection $iss 'Code'
$codeSection = Remove-InnoPascalComments $rawCodeSection
$installedVersionRoutine = Get-InnoRoutine $codeSection 'IsInstalledVersionNewer'
$initializeSetupRoutine = Get-InnoRoutine $codeSection 'InitializeSetup'
$downgradeConditionPattern =
    'IsInstalledVersionNewer\s*\(\s*InstalledVersion\s*,\s*CandidatePackedVersion\s*,\s*InstalledVersionValid\s*\)'
$downgradeBranch = Get-InnoBeginBranch $initializeSetupRoutine $downgradeConditionPattern

$pascalStringFixture = @"
Log('Text containing // markers');
Log('Text containing {braces}');
Log('Text containing (* markers *)');
Log('It''s valid Pascal text');
Log('{#MyAppVersion}');
"@
$sanitizedPascalStringFixture = Remove-InnoPascalComments $pascalStringFixture
Assert-Condition ($sanitizedPascalStringFixture.Contains("'Text containing // markers'")) `
    'Pascal comment scanner preserves // inside string literals' `
    'A line-comment marker inside a Pascal string literal must remain source text.'
Assert-Condition ($sanitizedPascalStringFixture.Contains("'Text containing {braces}'")) `
    'Pascal comment scanner preserves braces inside string literals' `
    'Brace-comment markers inside a Pascal string literal must remain source text.'
Assert-Condition ($sanitizedPascalStringFixture.Contains("'Text containing (* markers *)'")) `
    'Pascal comment scanner preserves block-comment markers inside string literals' `
    'Block-comment markers inside a Pascal string literal must remain source text.'
Assert-Condition ($sanitizedPascalStringFixture.Contains("'It''s valid Pascal text'")) `
    'Pascal comment scanner preserves doubled apostrophes inside string literals' `
    'A doubled apostrophe must not terminate a Pascal string literal.'
Assert-Condition ($sanitizedPascalStringFixture.Contains("'{#MyAppVersion}'")) `
    'Pascal comment scanner preserves quoted Inno constants' `
    'An Inno constant inside a Pascal string literal must remain source text.'
$pascalTokenSeparationFixture = "Result(* comment`r`ncontinues *):=False;"
$sanitizedTokenSeparationFixture = Remove-InnoPascalComments $pascalTokenSeparationFixture
Assert-Condition (
    $sanitizedTokenSeparationFixture.Length -eq $pascalTokenSeparationFixture.Length -and
    $sanitizedTokenSeparationFixture.Contains("`r`n") -and
    -not $sanitizedTokenSeparationFixture.Contains('Result:=False;')) `
    'Pascal comment scanner preserves token separation and comment newlines' `
    'Removed comments must be neutralized with whitespace while retaining line breaks.'

$publishDefinition = Get-InnoDefine $iss 'ProductionPublishDir'
$outputDefinition = Get-InnoDefine $iss 'InstallerOutputDir'
$publishPath = Get-InstallerRelativePath $publishDefinition
$outputPath = Get-InstallerRelativePath $outputDefinition

Assert-Condition ($null -ne $publishPath -and (Test-SamePath $publishPath $expectedPublishPath)) `
    'Installer source is the dedicated D1 production publish directory' `
    "Expected '$expectedPublishPath'; resolved '$publishPath'."
Assert-Condition ($null -ne $outputPath -and (Test-SamePath $outputPath $expectedOutputPath)) `
    'Installer output uses the dedicated artifact directory' `
    "Expected '$expectedOutputPath'; resolved '$outputPath'."

if ($null -ne $publishPath -and $null -ne $outputPath) {
    Assert-Condition (-not (Test-SameOrNestedPath $outputPath $publishPath)) `
        'Installer output is not equal to or nested inside publish input' `
        "Output '$outputPath' must not be inside publish input '$publishPath'."
    Assert-Condition (-not (Test-SameOrNestedPath $publishPath $outputPath)) `
        'Publish input is not equal to or nested inside installer output' `
        "Publish input '$publishPath' must not be inside output '$outputPath'."
    Assert-Condition (-not (Test-SameOrNestedPath $evidencePath $publishPath)) `
        'Provisional D1 evidence is outside the installer source tree' `
        "Evidence '$evidencePath' must not be inside publish input '$publishPath'."
}

$fileEntries = @([regex]::Matches(
        $filesSection,
        '(?im)^\s*Source\s*:\s*"(?<source>[^"]+)"(?<rest>[^\r\n]*)\r?$'))
Assert-Condition ($fileEntries.Count -eq 1) `
    'Installer has one authoritative payload source rule' `
    "Expected exactly one [Files] Source rule; found $($fileEntries.Count)."

if ($fileEntries.Count -eq 1) {
    $sourceSpec = $fileEntries[0].Groups['source'].Value.Trim()
    $entryRemainder = $fileEntries[0].Groups['rest'].Value
    $destinationMatch = [regex]::Match(
        $entryRemainder,
        '(?i);\s*DestDir\s*:\s*"(?<value>[^"]+)"')
    $flagsMatch = [regex]::Match(
        $entryRemainder,
        '(?i);\s*Flags\s*:\s*(?<value>[^;\r\n]+)')
    $flags = @(
        $flagsMatch.Groups['value'].Value.Trim().Split(
            [char[]]@(' ', "`t"),
            [System.StringSplitOptions]::RemoveEmptyEntries) |
            ForEach-Object { $_.ToLowerInvariant() }
    )

    Assert-Condition ($sourceSpec -ieq '{#ProductionPublishDir}\*') `
        'Payload source selects the complete production publish root' `
        "Expected '{#ProductionPublishDir}\*'; found '$sourceSpec'."
    Assert-Condition ($destinationMatch.Success -and $destinationMatch.Groups['value'].Value.Trim() -ieq '{app}') `
        'Payload destination is the application directory' `
        'The recursive payload must be installed under {app}.'
    Assert-Condition ($flags -contains 'recursesubdirs') `
        'Payload inclusion is recursive' `
        'The [Files] rule must include recursesubdirs.'
    Assert-Condition ($flags -contains 'createallsubdirs') `
        'Empty and populated publish subdirectories are preserved' `
        'The [Files] rule must include createallsubdirs.'
    Assert-Condition ($sourceSpec -notmatch '(?i)OpenLocally\.exe$') `
        'Installer has no obsolete executable-only source contract' `
        'The source rule must consume the complete publish tree, not one executable.'
}

$setupIcon = Get-InnoSetting $setup 'SetupIconFile'
$setupIconPath = Get-InstallerRelativePath $setupIcon
Assert-Condition ($null -ne $setupIconPath -and (Test-SamePath $setupIconPath $expectedIconPath)) `
    'Setup executable uses CreatorCrate.ico' `
    "Expected SetupIconFile to resolve to '$expectedIconPath'; resolved '$setupIconPath'."
Assert-Condition ((Get-InnoSetting $setup 'UninstallDisplayIcon') -ieq '{app}\{#MyAppExeName}') `
    'Installed Apps icon uses the installed OpenLocally.exe' `
    'Expected UninstallDisplayIcon={app}\{#MyAppExeName}.'

Assert-Condition ((Get-InnoDefine $iss 'MyAppVersion') -eq '1.1.0') `
    'Installer version remains 1.1.0' `
    'D2A must not bump the installer version.'
Assert-Condition ((Get-InnoDefine $iss 'MyAppId') -eq '{{8F1D5C4E-6A2B-4E9D-9C3F-7B0A2E5D1C84}') `
    'Stable installer AppId is preserved' `
    'The established AppId must not change.'

$appId = Get-InnoDefine $iss 'MyAppId'
$expandedAppId = if ($appId -like '{{*') { $appId.Substring(1) } else { $appId }
$expectedUninstallKey =
    "Software\Microsoft\Windows\CurrentVersion\Uninstall\$($expandedAppId)_is1"
Assert-Condition ($expectedUninstallKey -eq 'Software\Microsoft\Windows\CurrentVersion\Uninstall\{8F1D5C4E-6A2B-4E9D-9C3F-7B0A2E5D1C84}_is1') `
    'Downgrade lookup derives the Inno uninstall key from the stable AppId' `
    "Unexpected uninstall key derived from MyAppId: $expectedUninstallKey"
Assert-Condition ($codeSection -match "(?s)function\s+GetCreatorCrateUninstallKey\b.*ExpandConstant\('\{#MyAppId\}'\).*'_is1'") `
    'Downgrade lookup is wired to canonical MyAppId' `
    'The uninstall key must be derived from MyAppId instead of duplicating product identity.'
Assert-Condition ($codeSection -match "RegKeyExists\(HKCU,\s*UninstallKey\)") `
    'Downgrade detection uses the per-user uninstall registry root' `
    'Expected the stable AppId uninstall key to be checked under HKCU.'
Assert-Condition ($codeSection -match "RegQueryStringValue\(HKCU,\s*UninstallKey,\s*'DisplayVersion'") `
    'Installed version authority is Inno DisplayVersion metadata' `
    'Expected DisplayVersion from the per-user uninstall key.'
Assert-Condition ($codeSection -match "StrToVersion\('\{#MyAppVersion\}',\s*CandidatePackedVersion\)") `
    'Candidate version is parsed from canonical MyAppVersion' `
    'The downgrade guard must not duplicate the setup version.'
Assert-Condition (-not [string]::IsNullOrWhiteSpace($installedVersionRoutine)) `
    'Production IsInstalledVersionNewer routine is present' `
    'Expected a bounded IsInstalledVersionNewer function in the [Code] section.'
Assert-Condition ($installedVersionRoutine -match 'StrToVersion\s*\(\s*InstalledVersion\s*,\s*InstalledPackedVersion\s*\)') `
    'IsInstalledVersionNewer parses installed metadata numerically' `
    'Expected StrToVersion for installed metadata inside IsInstalledVersionNewer.'
Assert-Condition ($installedVersionRoutine -match
    '(?is)Result\s*:=\s*InstalledVersionValid\s+and\s*\(\s*ComparePackedVersion\s*\(\s*InstalledPackedVersion\s*,\s*CandidateVersion\s*\)\s*>\s*0\s*\)\s*;') `
    'IsInstalledVersionNewer strictly compares installed version to candidate' `
    'Expected ComparePackedVersion(installed, candidate) > 0 inside IsInstalledVersionNewer.'
Assert-Condition (-not [string]::IsNullOrWhiteSpace($initializeSetupRoutine)) `
    'Production InitializeSetup routine is present' `
    'Expected a bounded InitializeSetup function in the [Code] section.'
Assert-Condition (-not [string]::IsNullOrWhiteSpace($downgradeBranch)) `
    'InitializeSetup directly branches on IsInstalledVersionNewer' `
    'Expected InitializeSetup to reject from the direct IsInstalledVersionNewer result.'

$approvedDowngradeMessage =
    'A newer CreatorCrate Windows Helper is already installed. This older setup cannot continue.'
$messageMatch = [regex]::Match(
    $downgradeBranch,
    '(?is)SuppressibleMsgBox\s*\(\s*''' + [regex]::Escape($approvedDowngradeMessage) + '''\s*,')
$resultFalseMatch = [regex]::Match($downgradeBranch, '(?im)^\s*Result\s*:=\s*False\s*;')
$exitMatch = [regex]::Match($downgradeBranch, '(?im)^\s*Exit\s*;')
Assert-Condition ($messageMatch.Success) `
    'Newer-version rejection branch contains the approved downgrade message' `
    'Expected the approved message inside the bounded IsInstalledVersionNewer branch.'
Assert-Condition ($resultFalseMatch.Success) `
    'Newer-version rejection branch sets Result := False' `
    'Expected Result := False inside the bounded IsInstalledVersionNewer branch.'
Assert-Condition ($exitMatch.Success) `
    'Newer-version rejection branch exits immediately' `
    'Expected Exit inside the bounded IsInstalledVersionNewer branch.'
Assert-Condition ($messageMatch.Success -and $resultFalseMatch.Success -and $exitMatch.Success -and
    $messageMatch.Index -lt $resultFalseMatch.Index -and $resultFalseMatch.Index -lt $exitMatch.Index) `
    'Downgrade branch keeps message, rejection result, and exit in order' `
    'Expected the bounded branch to show the message before Result := False and Exit.'
Assert-Condition ($codeSection -match "no DisplayVersion; allowing repair" -and
    $codeSection -match 'DisplayVersion.*malformed; allowing repair') `
    'Missing and malformed installed versions allow repair' `
    'Corrupt installed version metadata must be logged and must not be treated as newer.'

$downgradeCases = @(
    @{ Name = 'no installed product'; Detected = $false; Installed = $null; Candidate = '1.1.0'; Block = $false },
    @{ Name = 'missing installed version'; Detected = $true; Installed = $null; Candidate = '1.1.0'; Block = $false },
    @{ Name = 'older installed version'; Detected = $true; Installed = '1.0.0'; Candidate = '1.1.0'; Block = $false },
    @{ Name = 'same-version repair'; Detected = $true; Installed = '1.1.0'; Candidate = '1.1.0'; Block = $false },
    @{ Name = 'downgrade'; Detected = $true; Installed = '1.2.0'; Candidate = '1.1.0'; Block = $true },
    @{ Name = 'numeric 1.9 to 1.10 upgrade'; Detected = $true; Installed = '1.9.0'; Candidate = '1.10.0'; Block = $false },
    @{ Name = 'numeric 1.10 to 1.9 downgrade'; Detected = $true; Installed = '1.10.0'; Candidate = '1.9.0'; Block = $true },
    @{ Name = 'malformed installed version'; Detected = $true; Installed = 'not-a-version'; Candidate = '1.1.0'; Block = $false }
)
$downgradeCasePasses = 0
foreach ($case in $downgradeCases) {
    $actual = Test-ExpectedDowngradeDecision `
        -ProductDetected $case.Detected `
        -InstalledVersion $case.Installed `
        -CandidateVersion $case.Candidate
    $passed = $actual -eq $case.Block
    Assert-Condition $passed `
        "Expected downgrade decision: $($case.Name)" `
        "Expected block=$($case.Block); actual block=$actual."
    if ($passed) {
        $downgradeCasePasses++
    }
}
Assert-Condition ($downgradeCasePasses -eq $downgradeCases.Count) `
    "Expected-decision semantic matrix passes $downgradeCasePasses/$($downgradeCases.Count) cases" `
    'One or more validator-side semantic model cases failed.'
Assert-Condition ((Get-InnoSetting $setup 'DefaultDirName') -ieq '{localappdata}\Programs\CreatorCrate\OpenLocally') `
    'Per-user install directory is preserved' `
    'Expected %LOCALAPPDATA%\Programs\CreatorCrate\OpenLocally.'
Assert-Condition ((Get-InnoSetting $setup 'PrivilegesRequired') -ieq 'lowest') `
    'PrivilegesRequired remains lowest' `
    'The installer must remain non-elevated and per-user.'
Assert-Condition ([string]::IsNullOrWhiteSpace((Get-InnoSetting $setup 'PrivilegesRequiredOverridesAllowed'))) `
    'No privilege escalation override is configured' `
    'PrivilegesRequiredOverridesAllowed would permit elevation.'
Assert-Condition ((Get-InnoSetting $setup 'CloseApplications') -ieq 'yes') `
    'Running helper is closed before payload replacement' `
    'CloseApplications must remain enabled for complete multi-file replacement.'
Assert-Condition ((Get-InnoSetting $setup 'CloseApplicationsFilter') -ieq '{#MyAppExeName}') `
    'Close-applications scope remains limited to OpenLocally.exe' `
    'The installer must not target unrelated processes.'
Assert-Condition ((Get-InnoSetting $setup 'RestartApplications') -ieq 'no') `
    'Upgrade does not replay protocol activation URIs' `
    'A social activation URI can contain a single-use intent and must not restart.'

Assert-Condition ($runSection -match '(?im)^\s*Filename\s*:\s*"\{app\}\\\{#MyAppExeName\}"[^\r\n]*Parameters\s*:\s*"--register"') `
    'creatorcrate-open post-install registration is preserved' `
    'Expected the installed helper to run with --register.'
Assert-Condition ($runSection -match '(?im)^\s*Filename\s*:\s*"\{app\}\\\{#MyAppExeName\}"[^\r\n]*Parameters\s*:\s*"--register-social"') `
    'creatorcrate-social post-install registration is preserved' `
    'Expected the installed helper to run with --register-social.'
Assert-Condition ($uninstallRunSection -match '(?im)Parameters\s*:\s*"--unregister"[^\r\n]*RunOnceId\s*:\s*"UnregisterCreatorCrateOpen"') `
    'Ownership-safe Open Locally unregistration remains wired once' `
    'Expected --unregister with its stable RunOnceId.'
Assert-Condition ($uninstallRunSection -match '(?im)Parameters\s*:\s*"--unregister-social"[^\r\n]*RunOnceId\s*:\s*"UnregisterCreatorCrateSocial"') `
    'Ownership-safe social unregistration remains wired once' `
    'Expected --unregister-social with its stable RunOnceId.'

Assert-Condition ($iss -notmatch '(?im)^\s*\[InstallDelete\]\s*$') `
    'D2B1 adds no obsolete-file cleanup rules' `
    '[InstallDelete] remains deferred pending the reviewed manifest handoff.'
Assert-Condition ($iss -notmatch '(?im)^\s*\[Registry\]\s*$|\bHKLM\b|\{common(?:appdata|pf|programs)\}') `
    'Installer defines no machine-wide registry or common-directory state' `
    'D2A must preserve the current per-user installation architecture.'

if (Test-Path -LiteralPath $csprojPath -PathType Leaf) {
    $csproj = Get-Content -LiteralPath $csprojPath -Raw
    Assert-Condition ($csproj -match '<OutputType>\s*WinExe\s*</OutputType>') `
        'Helper remains a Windows GUI executable' `
        'OpenLocally.csproj must keep OutputType=WinExe.'
    Assert-Condition ($csproj -match '<TargetFramework>\s*net10\.0-windows10\.0\.17763\.0\s*</TargetFramework>') `
        'Helper framework is net10.0-windows10.0.17763.0' `
        'The validator must enforce the D1 production framework, not net10.0-windows.'
    Assert-Condition ($csproj -match '<PublishSingleFile>\s*false\s*</PublishSingleFile>') `
        'Production project explicitly uses multi-file publish' `
        'OpenLocally.csproj must keep PublishSingleFile=false.'
    Assert-Condition ($csproj -notmatch '<PublishTrimmed>\s*true\s*</PublishTrimmed>|<PublishAot>\s*true\s*</PublishAot>|<PublishReadyToRun>\s*true\s*</PublishReadyToRun>') `
        'Trimming, NativeAOT, and ReadyToRun are not enabled in the project' `
        'The established production publish must remain untrimmed, non-AOT, and not ReadyToRun.'
}

if (Test-Path -LiteralPath $dispatcherPath -PathType Leaf) {
    $dispatcher = Get-Content -LiteralPath $dispatcherPath -Raw
    foreach ($argument in @('--register', '--unregister', '--register-social', '--unregister-social')) {
        Assert-Condition ($dispatcher.Contains('"' + $argument + '"')) `
            "Helper dispatcher supports $argument" `
            "CommandDispatcher.cs does not handle $argument."
    }
}

foreach ($registrar in @(
        @{ Path = $registrarPath; Scheme = 'creatorcrate-open' },
        @{ Path = $socialRegistrarPath; Scheme = 'creatorcrate-social' })) {
    if (Test-Path -LiteralPath $registrar.Path -PathType Leaf) {
        $source = Get-Content -LiteralPath $registrar.Path -Raw
        Assert-Condition ($source -match [regex]::Escape("Software\Classes\$($registrar.Scheme)")) `
            "$($registrar.Scheme) remains registered under HKCU\Software\Classes" `
            "$([System.IO.Path]::GetFileName($registrar.Path)) does not use the expected protocol key."
        Assert-Condition ($source -match '\$"\\"\{executablePath\}\\" \\"%1\\""') `
            "$($registrar.Scheme) command keeps executable and URI quoting" `
            'Expected the registry command shape "<executablePath>" "%1".'
        Assert-Condition ($source -match 'GetValue\(CommandKeyPath, null\)') `
            "$($registrar.Scheme) unregister keeps the ownership check" `
            'Unregister must preserve a protocol tree owned by another command.'
    }
}

if ($ValidatePayload) {
    if (-not (Test-Path -LiteralPath $expectedPublishPath -PathType Container)) {
        $failures.Add("FAIL  D1 production publish is present`n      Required directory not found: $expectedPublishPath")
    }
    elseif ($fileEntries.Count -eq 1 -and $null -ne $publishPath -and
        (Test-SamePath $publishPath $expectedPublishPath)) {
        try {
            Write-Output 'Running canonical D1 production-publish validation...'
            & $productionValidatorPath -PublishPath $expectedPublishPath
            $checks.Add('PASS  Canonical D1 production-publish validator completed')

            $payloadFiles = @(
                Get-ChildItem -LiteralPath $expectedPublishPath -Recurse -File |
                    Sort-Object FullName
            )
            $relativePaths = @(
                $payloadFiles | ForEach-Object {
                    [System.IO.Path]::GetRelativePath($expectedPublishPath, $_.FullName)
                }
            )
            $relativePathSet = [System.Collections.Generic.HashSet[string]]::new(
                [System.StringComparer]::OrdinalIgnoreCase)
            foreach ($relativePath in $relativePaths) {
                [void]$relativePathSet.Add($relativePath)
            }

            Assert-Condition ($payloadFiles.Count -gt 1) `
                "Recursive payload enumeration maps $($payloadFiles.Count) files" `
                'The production payload unexpectedly contains fewer than two files.'
            Assert-Condition (@($payloadFiles | Where-Object { $_.DirectoryName -eq $expectedPublishPath }).Count -gt 0) `
                'Payload enumeration includes root files' `
                'The installer source rule did not map files from the publish root.'
            Assert-Condition (@($relativePaths | Where-Object { $_ -match '[\\/]' }).Count -gt 0) `
                'Payload enumeration includes nested files with relative paths preserved' `
                'The installer source rule did not map nested publish content.'

            foreach ($requiredFile in @(
                    'OpenLocally.exe',
                    'OpenLocally.pri',
                    'Microsoft.UI.pri',
                    'Microsoft.WindowsAppRuntime.dll',
                    'Microsoft.ui.xaml.dll',
                    'hostfxr.dll',
                    'coreclr.dll',
                    'System.Private.CoreLib.dll',
                    'en-us\Microsoft.ui.xaml.dll.mui',
                    'Microsoft.UI.Xaml\Assets\map.html')) {
                Assert-Condition ($relativePathSet.Contains($requiredFile)) `
                    "Payload maps representative file: $requiredFile" `
                    "Expected production payload file is missing: $requiredFile"
            }

            $mappedPdbs = @($relativePaths | Where-Object { $_ -like '*.pdb' })
            $mappedSetupExecutables = @(
                $relativePaths | Where-Object {
                    [System.IO.Path]::GetFileName($_) -like '*Setup*.exe' -or
                    [System.IO.Path]::GetFileName($_) -like '*Installer*.exe'
                }
            )
            $mappedProofOrTestArtifacts = @(Get-MappedProofOrTestArtifacts $relativePaths)

            Assert-Condition ($mappedPdbs.Count -eq 0) `
                'Recursive installer payload maps zero PDBs' `
                "Mapped PDBs: $($mappedPdbs -join ', ')"
            Assert-Condition ($mappedSetupExecutables.Count -eq 0) `
                'Recursive installer payload maps no setup or installer executable' `
                "Mapped installer executables: $($mappedSetupExecutables -join ', ')"
            Assert-Condition ($mappedProofOrTestArtifacts.Count -eq 0) `
                'Recursive installer payload maps no proof or test artifact' `
                "Mapped proof/test artifacts: $($mappedProofOrTestArtifacts -join ', ')"
            Assert-Condition (-not (Test-SameOrNestedPath $evidencePath $expectedPublishPath)) `
                'Recursive installer payload excludes provisional D1 evidence' `
                'The evidence directory must remain outside the mapped publish root.'
        }
        catch {
            $failures.Add("FAIL  Canonical D1 production-publish validation`n      $($_.Exception.Message)")
        }
    }
    else {
        $failures.Add("FAIL  Payload validation source mapping`n      Static source mapping is invalid; payload validation was not run.")
    }
}
else {
    Write-Output 'SKIP  Payload enumeration was not requested. Run with -ValidatePayload to require and validate the existing D1 publish.'
}

$checks | ForEach-Object { Write-Output $_ }

if ($failures.Count -gt 0) {
    Write-Output ''
    Write-Output 'VALIDATION FAILED:'
    $failures | ForEach-Object { Write-Output $_ }
    exit 1
}

Write-Output ''
if ($ValidatePayload) {
    Write-Output 'VALIDATION PASSED - installer source and recursive D1 payload mapping are consistent.'
}
else {
    Write-Output 'VALIDATION PASSED - installer source is consistent. Payload mapping was not requested.'
}
exit 0
