#requires -Version 7.0

<#
.SYNOPSIS
    Scans the direct and delay-load imports of every EXE and DLL in a publish.

.DESCRIPTION
    Uses the Microsoft PE/COFF tool DUMPBIN. Dependencies are classified as
    Windows/API-set, app-local, redistributable, or unresolved. The script
    fails when DUMPBIN is unavailable, a PE cannot be scanned, or an import is
    unresolved. Redistributable imports are reported without installing or
    modifying prerequisites.
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory)]
    [string]$PublishPath,

    [string]$ReportPath
)

$ErrorActionPreference = 'Stop'
$publishRoot = (Resolve-Path -LiteralPath $PublishPath).Path

function Find-DumpBin {
    $command = Get-Command dumpbin.exe -ErrorAction SilentlyContinue
    if ($command) {
        return $command.Source
    }

    $vswherePath = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio\Installer\vswhere.exe'
    if (Test-Path -LiteralPath $vswherePath) {
        $candidate = & $vswherePath `
            -latest `
            -products '*' `
            -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 `
            -find 'VC\Tools\MSVC\**\bin\Hostx64\x64\dumpbin.exe' |
            Select-Object -First 1
        if ($candidate -and (Test-Path -LiteralPath $candidate)) {
            return $candidate
        }
    }

    throw 'DUMPBIN was not found. Install the Visual Studio C++ x64 build tools or put dumpbin.exe on PATH; the native dependency scan cannot be skipped.'
}

function Get-DependencyClassification {
    param(
        [Parameter(Mandatory)]
        [string]$Dependency,

        [Parameter(Mandatory)]
        [hashtable]$AppLocalFiles
    )

    $name = $Dependency.ToUpperInvariant()
    if ($name -match '^(VCRUNTIME|MSVCP|CONCRT).*\.DLL$') {
        return 'redistributable'
    }
    if ($name -match '^(API-MS-|EXT-MS-)') {
        return 'windows-api-set'
    }
    if ($AppLocalFiles.ContainsKey($name)) {
        return 'app-local'
    }

    $systemCandidates = @(
        (Join-Path $env:WINDIR "System32\$Dependency"),
        (Join-Path $env:WINDIR "SysWOW64\$Dependency")
    )
    if ($systemCandidates | Where-Object { Test-Path -LiteralPath $_ }) {
        return 'windows-system'
    }

    return 'unresolved'
}

$dumpbinPath = Find-DumpBin
$peFiles = @(
    Get-ChildItem -LiteralPath $publishRoot -Recurse -File |
        Where-Object { $_.Extension -in @('.exe', '.dll') } |
        Sort-Object FullName
)
if ($peFiles.Count -eq 0) {
    throw "No EXE or DLL files found beneath $publishRoot."
}

$appLocalFiles = @{}
foreach ($file in $peFiles) {
    $appLocalFiles[$file.Name.ToUpperInvariant()] = $true
}

$findings = New-Object System.Collections.Generic.List[object]
$scanFailures = New-Object System.Collections.Generic.List[string]
foreach ($file in $peFiles) {
    $output = @(& $dumpbinPath /nologo /dependents $file.FullName 2>&1)
    if ($LASTEXITCODE -ne 0) {
        $scanFailures.Add("$($file.FullName): DUMPBIN exit code $LASTEXITCODE")
        continue
    }

    $dependencies = @(
        $output |
            ForEach-Object { if ($_ -match '^\s+([^\s:]+\.dll)\s*$') { $Matches[1] } } |
            Where-Object { $_ } |
            Sort-Object -Unique
    )

    foreach ($dependency in $dependencies) {
        $relativePath = [System.IO.Path]::GetRelativePath($publishRoot, $file.FullName)
        $classification = Get-DependencyClassification `
            -Dependency $dependency `
            -AppLocalFiles $appLocalFiles
        $findings.Add([pscustomobject]@{
            file = $relativePath.Replace('\', '/')
            dependency = $dependency
            classification = $classification
            windowsAppRuntime = $dependency -match '^(Microsoft\.(WindowsAppRuntime|UI\.)|WinUI)'
            vcRuntime = $dependency -match '^(VCRUNTIME|MSVCP|CONCRT)'
        })
    }
}

if ($scanFailures.Count -gt 0) {
    throw "Native dependency scan failed:`n$($scanFailures -join "`n")"
}

$unresolved = @($findings | Where-Object classification -eq 'unresolved')
$vcRuntime = @($findings | Where-Object vcRuntime)
$windowsAppRuntime = @($findings | Where-Object windowsAppRuntime)
$summary = [pscustomobject]@{
    scanner = $dumpbinPath
    publishPath = $publishRoot
    scannedPeFileCount = $peFiles.Count
    importCount = $findings.Count
    windowsAppRuntimeImportCount = $windowsAppRuntime.Count
    vcRuntimeImportCount = $vcRuntime.Count
    unresolvedImportCount = $unresolved.Count
    findings = $findings.ToArray()
}

if ($ReportPath) {
    $reportFullPath = [System.IO.Path]::GetFullPath($ReportPath)
    New-Item -ItemType Directory -Path (Split-Path -Parent $reportFullPath) -Force | Out-Null
    $summary | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $reportFullPath -Encoding utf8
}

Write-Output "Native dependency scanner: $dumpbinPath"
Write-Output "Native PE files scanned: $($peFiles.Count)"
Write-Output "Native imports classified: $($findings.Count)"
Write-Output "Windows App Runtime/WinUI imports: $($windowsAppRuntime.Count)"
Write-Output "VCRUNTIME/MSVCP/CONCRT imports: $($vcRuntime.Count)"
Write-Output "Unresolved imports: $($unresolved.Count)"

if ($vcRuntime.Count -gt 0) {
    $vcRuntime |
        Sort-Object file, dependency -Unique |
        ForEach-Object { Write-Warning "$($_.file) imports $($_.dependency)" }
}
if ($unresolved.Count -gt 0) {
    $unresolved |
        Sort-Object file, dependency -Unique |
        ForEach-Object { Write-Error "$($_.file) has unresolved import $($_.dependency)" -ErrorAction Continue }
    exit 1
}
