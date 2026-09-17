#requires -Version 7.0

<#
.SYNOPSIS
    Creates and validates the production OpenLocally publish payload.

.DESCRIPTION
    Restores the production project in locked mode, removes only the dedicated
    production publish directory, publishes the production project with the
    Production profile, validates its contents, scans every PE dependency, and
    writes a provisional hash manifest outside the publish payload.
#>
[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'

$windowsRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$repositoryRoot = [System.IO.Path]::GetFullPath((Join-Path $windowsRoot '..\..'))
$projectPath = Join-Path $windowsRoot 'src\OpenLocally\OpenLocally.csproj'
$publishPath = Join-Path $repositoryRoot 'dist\windows-helper\production\win-x64'
$evidencePath = Join-Path $repositoryRoot 'dist\windows-helper\evidence'
$manifestPath = Join-Path $evidencePath 'production-publish-manifest.json'
$dependencyReportPath = Join-Path $evidencePath 'native-dependencies.json'
$validatorPath = Join-Path $PSScriptRoot 'validate-production-publish.ps1'

$expectedPublishPath = [System.IO.Path]::GetFullPath(
    (Join-Path $repositoryRoot 'dist\windows-helper\production\win-x64'))
$resolvedPublishPath = [System.IO.Path]::GetFullPath($publishPath)

if (-not $resolvedPublishPath.Equals(
        $expectedPublishPath,
        [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "Refusing to clean unexpected publish path: $resolvedPublishPath"
}

if (Test-Path -LiteralPath $resolvedPublishPath) {
    $publishItem = Get-Item -LiteralPath $resolvedPublishPath -Force
    if (($publishItem.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
        throw "Refusing to clean reparse-point publish path: $resolvedPublishPath"
    }
    Remove-Item -LiteralPath $resolvedPublishPath -Recurse -Force
}

New-Item -ItemType Directory -Path $resolvedPublishPath -Force | Out-Null
New-Item -ItemType Directory -Path $evidencePath -Force | Out-Null

Write-Output 'Restoring the production project with committed lock files...'
& dotnet restore $projectPath `
    --locked-mode `
    -r win-x64 `
    -p:Configuration=Release `
    -p:PublishProfile=Production
if ($LASTEXITCODE -ne 0) {
    throw "Locked restore failed with exit code $LASTEXITCODE."
}

Write-Output "Publishing production helper to $resolvedPublishPath ..."
& dotnet publish $projectPath `
    --configuration Release `
    --runtime win-x64 `
    --no-restore `
    -p:PublishProfile=Production `
    --output $resolvedPublishPath
if ($LASTEXITCODE -ne 0) {
    throw "Production publish failed with exit code $LASTEXITCODE."
}

& $validatorPath `
    -PublishPath $resolvedPublishPath `
    -ManifestPath $manifestPath `
    -DependencyReportPath $dependencyReportPath
if ($LASTEXITCODE -ne 0) {
    throw "Production publish validation failed with exit code $LASTEXITCODE."
}
