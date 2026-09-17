#requires -Version 7.0

[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'

$windowsRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$validatorPath = Join-Path $windowsRoot 'installer\validate-installer.ps1'
$installerSourcePath = Join-Path $windowsRoot 'installer\CreatorCrate.OpenLocally.iss'
$temporaryRoot = Join-Path ([System.IO.Path]::GetTempPath()) (
    'creatorcrate-downgrade-contract-' + [guid]::NewGuid().ToString('N'))
$passed = 0
$total = 0

function Set-SingleMutation {
    param(
        [string]$Text,
        [string]$Pattern,
        [string]$Replacement
    )

    $regex = [regex]::new($Pattern, [System.Text.RegularExpressions.RegexOptions]::Multiline)
    $matches = $regex.Matches($Text)
    if ($matches.Count -ne 1) {
        throw "Mutation pattern must match exactly once; matched $($matches.Count): $Pattern"
    }
    return $regex.Replace($Text, $Replacement, 1)
}

function Invoke-ValidationCase {
    param(
        [string]$Name,
        [string]$Source,
        [bool]$ShouldPass,
        [string]$ExpectedOutput
    )

    $script:total++
    $casePath = Join-Path $temporaryRoot ($Name + '.iss')
    [System.IO.File]::WriteAllText($casePath, $Source, [System.Text.UTF8Encoding]::new($false))

    $output = & pwsh -NoProfile -ExecutionPolicy Bypass -File $validatorPath `
        -InstallerSourcePath $casePath 2>&1 | Out-String
    $exitCode = $LASTEXITCODE
    $passedCase = if ($ShouldPass) {
        $exitCode -eq 0
    }
    else {
        $exitCode -ne 0 -and $output.Contains($ExpectedOutput)
    }

    if (-not $passedCase) {
        Write-Output "FAIL  $Name"
        Write-Output "      Exit code: $exitCode"
        if ($ExpectedOutput) {
            Write-Output "      Expected output: $ExpectedOutput"
        }
        Write-Output $output.TrimEnd()
        return
    }

    $script:passed++
    Write-Output "PASS  $Name"
}

New-Item -ItemType Directory -Path $temporaryRoot | Out-Null
try {
    $productionSource = Get-Content -LiteralPath $installerSourcePath -Raw
    Invoke-ValidationCase `
        -Name 'production-source-baseline' `
        -Source $productionSource `
        -ShouldPass $true `
        -ExpectedOutput ''

    $downgradeMessageMutation = @{
        Name = 'commented-downgrade-message'
        Pattern = "(?m)^(?<block>[ \t]+SuppressibleMsgBox\((?<newline>\r?\n)[ \t]+'A newer CreatorCrate Windows Helper is already installed\. This older setup cannot continue\.',\r?\n[ \t]+mbCriticalError,\s*MB_OK,\s*IDOK\);)\r?$"
        Replacement = '(*${newline}${block}${newline}*)'
        ExpectedOutput = 'FAIL  Newer-version rejection branch contains the approved downgrade message'
    }

    $mutations = @(
        @{
            Name = 'reversed-comparison-arguments'
            Pattern = 'ComparePackedVersion\(InstalledPackedVersion, CandidateVersion\)'
            Replacement = 'ComparePackedVersion(CandidateVersion, InstalledPackedVersion)'
            ExpectedOutput = 'FAIL  IsInstalledVersionNewer strictly compares installed version to candidate'
        },
        @{
            Name = 'missing-comparison'
            Pattern = '\(ComparePackedVersion\(InstalledPackedVersion, CandidateVersion\) > 0\)'
            Replacement = 'True'
            ExpectedOutput = 'FAIL  IsInstalledVersionNewer strictly compares installed version to candidate'
        },
        @{
            Name = 'equality-blocked'
            Pattern = 'ComparePackedVersion\(InstalledPackedVersion, CandidateVersion\) > 0'
            Replacement = 'ComparePackedVersion(InstalledPackedVersion, CandidateVersion) >= 0'
            ExpectedOutput = 'FAIL  IsInstalledVersionNewer strictly compares installed version to candidate'
        },
        @{
            Name = 'missing-downgrade-message'
            Pattern = 'A newer CreatorCrate Windows Helper is already installed\. This older setup cannot continue\.'
            Replacement = 'A later CreatorCrate Windows Helper is installed. Setup cannot continue.'
            ExpectedOutput = 'FAIL  Newer-version rejection branch contains the approved downgrade message'
        },
        @{
            Name = 'missing-result-false'
            Pattern = '(?s)(A newer CreatorCrate Windows Helper is already installed\..*?)Result := False;'
            Replacement = '$1Result := True;'
            ExpectedOutput = 'FAIL  Newer-version rejection branch sets Result := False'
        },
        @{
            Name = 'missing-exit'
            Pattern = '(?s)(A newer CreatorCrate Windows Helper is already installed\..*?Result := False;\r?\n)\s*Exit;'
            Replacement = '$1'
            ExpectedOutput = 'FAIL  Newer-version rejection branch exits immediately'
        },
        @{
            Name = 'broken-initialize-setup-wiring'
            Pattern = '^  if IsInstalledVersionNewer\('
            Replacement = '  if not IsInstalledVersionNewer('
            ExpectedOutput = 'FAIL  InitializeSetup directly branches on IsInstalledVersionNewer'
        },
        @{
            Name = 'commented-result-false'
            Pattern = '(?s)(A newer CreatorCrate Windows Helper is already installed\..*?)(    Result := False;)'
            Replacement = "`$1(*`r`n`$2`r`n*)"
            ExpectedOutput = 'FAIL  Newer-version rejection branch sets Result := False'
        },
        @{
            Name = 'commented-exit'
            Pattern = '(?s)(A newer CreatorCrate Windows Helper is already installed\..*?    Result := False;\r?\n)    Exit;'
            Replacement = '$1    { Exit; }'
            ExpectedOutput = 'FAIL  Newer-version rejection branch exits immediately'
        },
        $downgradeMessageMutation,
        @{
            Name = 'commented-comparison'
            Pattern = '    \(ComparePackedVersion\(InstalledPackedVersion, CandidateVersion\) > 0\);'
            Replacement = '    (* (ComparePackedVersion(InstalledPackedVersion, CandidateVersion) > 0) *);'
            ExpectedOutput = 'FAIL  IsInstalledVersionNewer strictly compares installed version to candidate'
        },
        @{
            Name = 'commented-initialize-setup-wiring'
            Pattern = '(?m)^  if IsInstalledVersionNewer\(InstalledVersion, CandidatePackedVersion,\r?\n    InstalledVersionValid\) then\r?$'
            Replacement = "  { if IsInstalledVersionNewer(InstalledVersion, CandidatePackedVersion,`r`n    InstalledVersionValid) then }"
            ExpectedOutput = 'FAIL  InitializeSetup directly branches on IsInstalledVersionNewer'
        },
        @{
            Name = 'commented-structural-spoof'
            Pattern = '(?m)^function IsInstalledVersionNewer\(const InstalledVersion: String;\r?$'
            Replacement = "(*`r`nfunction IsInstalledVersionNewer(const InstalledVersion: String;`r`nbegin`r`n  Result := True;`r`nend;`r`n*)`r`nfunction DisabledIsInstalledVersionNewer(const InstalledVersion: String;"
            ExpectedOutput = 'FAIL  Production IsInstalledVersionNewer routine is present'
        }
    )

    foreach ($mutation in $mutations) {
        $mutatedSource = Set-SingleMutation `
            -Text $productionSource `
            -Pattern $mutation.Pattern `
            -Replacement $mutation.Replacement
        Invoke-ValidationCase `
            -Name $mutation.Name `
            -Source $mutatedSource `
            -ShouldPass $false `
            -ExpectedOutput $mutation.ExpectedOutput
    }

    $lfSource = $productionSource -replace "`r`n?", "`n"
    $sourceRepresentations = @(
        @{ Name = 'lf'; Source = $lfSource },
        @{ Name = 'crlf'; Source = $lfSource -replace "`n", "`r`n" }
    )
    foreach ($representation in $sourceRepresentations) {
        Invoke-ValidationCase `
            -Name "$($representation.Name)-production-source-baseline" `
            -Source $representation.Source `
            -ShouldPass $true `
            -ExpectedOutput ''

        $mutatedSource = Set-SingleMutation `
            -Text $representation.Source `
            -Pattern $downgradeMessageMutation.Pattern `
            -Replacement $downgradeMessageMutation.Replacement
        Invoke-ValidationCase `
            -Name "$($representation.Name)-commented-downgrade-message" `
            -Source $mutatedSource `
            -ShouldPass $false `
            -ExpectedOutput $downgradeMessageMutation.ExpectedOutput
    }
}
finally {
    if (Test-Path -LiteralPath $temporaryRoot) {
        Remove-Item -LiteralPath $temporaryRoot -Recurse -Force
    }
}

Write-Output ''
if ($passed -ne $total) {
    Write-Output "DOWNGRADE SOURCE-CONTRACT TESTS FAILED - $passed/$total cases passed."
    exit 1
}

Write-Output "DOWNGRADE SOURCE-CONTRACT TESTS PASSED - $passed/$total cases passed."
exit 0
