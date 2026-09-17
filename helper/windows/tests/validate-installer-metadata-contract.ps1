#requires -Version 7.0

[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'

$windowsRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$validatorPath = Join-Path $windowsRoot 'installer\validate-installer.ps1'
$installerSourcePath = Join-Path $windowsRoot 'installer\CreatorCrate.OpenLocally.iss'
$temporaryRoot = Join-Path ([System.IO.Path]::GetTempPath()) (
    'creatorcrate-installer-metadata-contract-' + [guid]::NewGuid().ToString('N'))
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

    $mutations = @(
        @{
            Name = 'missing-version-info-version'
            Pattern = '^\s*VersionInfoVersion\s*=\s*\{#MyAppVersion\}\s*\r?$'
            Replacement = ''
        },
        @{
            Name = 'stale-version-info-version-literal'
            Pattern = '^(\s*VersionInfoVersion\s*=\s*)\{#MyAppVersion\}(\s*)\r?$'
            Replacement = '${1}1.1.0.0${2}'
        },
        @{
            Name = 'broken-version-info-canonical-link'
            Pattern = '^(\s*VersionInfoVersion\s*=\s*)\{#MyAppVersion\}(\s*)\r?$'
            Replacement = '${1}{#MyAppName}${2}'
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
            -ExpectedOutput 'FAIL  Setup FileVersion derives from canonical MyAppVersion'
    }
}
finally {
    if (Test-Path -LiteralPath $temporaryRoot) {
        Remove-Item -LiteralPath $temporaryRoot -Recurse -Force
    }
}

Write-Output ''
if ($passed -ne $total) {
    Write-Output "INSTALLER METADATA SOURCE-CONTRACT TESTS FAILED - $passed/$total cases passed."
    exit 1
}

Write-Output "INSTALLER METADATA SOURCE-CONTRACT TESTS PASSED - $passed/$total cases passed."
exit 0
