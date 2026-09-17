#requires -Version 7.0

<#
.SYNOPSIS
    Validates the complete production OpenLocally publish payload.
#>
[CmdletBinding()]
param(
    [string]$PublishPath,

    [string]$ManifestPath,

    [string]$DependencyReportPath,

    [Parameter(DontShow)]
    [string]$DenylistFixturePath
)

$ErrorActionPreference = 'Stop'
$windowsRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$repositoryRoot = [System.IO.Path]::GetFullPath((Join-Path $windowsRoot '..\..'))
$canonicalPublishPath = [System.IO.Path]::GetFullPath(
    (Join-Path $repositoryRoot 'dist\windows-helper\production\win-x64'))
$effectivePublishPath = if ([string]::IsNullOrWhiteSpace($PublishPath)) {
    $canonicalPublishPath
}
else {
    [System.IO.Path]::GetFullPath($PublishPath)
}
$projectPath = Join-Path $windowsRoot 'src\OpenLocally\OpenLocally.csproj'
$dependencyScannerPath = Join-Path $PSScriptRoot 'scan-native-dependencies.ps1'

$denyPatterns = @(
    'OpenLocally.WinUiHost.Proof*',
    'LocalOleDropTarget*',
    'ManualVisualProofFixture*',
    'INTERACTIVE-PROOF.txt',
    'USER-OBJECT-ISOLATION.md',
    'UserObjectIsolation*',
    'testhost*',
    'xunit*',
    'Microsoft.TestPlatform*',
    'test-results',
    '*.pdb',
    '*.cs',
    '*.csx',
    '*.csproj',
    '*.fs',
    '*.fsproj',
    '*.vb',
    '*.vbproj',
    '*.xaml',
    '*.props',
    '*.targets',
    '*.pubxml',
    '*.user',
    '*.sln',
    '*.ps1',
    '*.cmd',
    '*.bat',
    '*Setup*.exe',
    '*Installer*.exe'
)

function Get-DeniedPublishFiles {
    param([string]$RootPath)

    $denied = [System.Collections.Generic.List[string]]::new()
    $candidateFiles = @(Get-ChildItem -LiteralPath $RootPath -Recurse -File | Sort-Object FullName)
    foreach ($file in $candidateFiles) {
        $relativePath = [System.IO.Path]::GetRelativePath($RootPath, $file.FullName)
        $pathSegments = @($relativePath -split '[\\/]')
        foreach ($pattern in $denyPatterns) {
            if ($file.Name -like $pattern -or
                ($pattern -eq 'test-results' -and $relativePath -match '(^|[\\/])test-results([\\/]|$)') -or
                ($pattern -eq 'UserObjectIsolation*' -and
                    @($pathSegments | Where-Object { $_ -like $pattern }).Count -gt 0)) {
                $denied.Add($relativePath)
                break
            }
        }
    }
    return $denied
}

if ($DenylistFixturePath) {
    $fixtureRoot = (Resolve-Path -LiteralPath $DenylistFixturePath).Path
    $fixtureDeniedFiles = @(Get-DeniedPublishFiles $fixtureRoot)
    if ($fixtureDeniedFiles.Count -gt 0) {
        throw "Production publish denylist fixture validation failed: $($fixtureDeniedFiles -join ', ')"
    }
    Write-Output "Effective publish path: $effectivePublishPath"
    Write-Output "Production publish denylist fixture validation passed: $fixtureRoot"
    return
}

if (-not (Test-Path -LiteralPath $effectivePublishPath -PathType Container)) {
    throw "Production publish directory not found: $effectivePublishPath"
}
$publishRoot = (Resolve-Path -LiteralPath $effectivePublishPath).Path
$files = @(Get-ChildItem -LiteralPath $publishRoot -Recurse -File | Sort-Object FullName)

$failures = New-Object System.Collections.Generic.List[string]
function Require-File {
    param([string]$RelativePath)
    if (-not (Test-Path -LiteralPath (Join-Path $publishRoot $RelativePath) -PathType Leaf)) {
        $script:failures.Add("Required publish file is missing: $RelativePath")
    }
}

$requiredFiles = @(
    'OpenLocally.exe',
    'OpenLocally.dll',
    'OpenLocally.deps.json',
    'OpenLocally.runtimeconfig.json',
    'OpenLocally.pri',
    'Microsoft.UI.pri',
    'Microsoft.WindowsAppRuntime.dll',
    'Microsoft.WindowsAppRuntime.Bootstrap.dll',
    'Microsoft.ui.xaml.dll',
    'WinUIEdit.dll',
    'hostfxr.dll',
    'hostpolicy.dll',
    'coreclr.dll',
    'clrjit.dll',
    'System.Private.CoreLib.dll'
)
foreach ($requiredFile in $requiredFiles) {
    Require-File $requiredFile
}

$nestedFiles = @($files | Where-Object { $_.DirectoryName -ne $publishRoot })
if ($nestedFiles.Count -eq 0) {
    $failures.Add('Publish contains no nested architecture/resource/locale payload.')
}
$localeResources = @(
    $nestedFiles | Where-Object { $_.Extension -eq '.mui' }
)
if ($localeResources.Count -eq 0) {
    $failures.Add('Publish contains no nested locale MUI resources.')
}

$deniedFiles = @(Get-DeniedPublishFiles $publishRoot)
if ($deniedFiles.Count -gt 0) {
    $failures.Add("Denied proof/test/dev content found: $($deniedFiles -join ', ')")
}

$propertyOutput = & dotnet msbuild $projectPath `
    -nologo `
    -p:Configuration=Release `
    -p:RuntimeIdentifier=win-x64 `
    -p:PublishProfile=Production `
    -getProperty:TargetFramework,RuntimeIdentifier,SelfContained,PublishSingleFile,WindowsPackageType,WindowsAppSDKSelfContained,UseWinUI
if ($LASTEXITCODE -ne 0) {
    throw "MSBuild property evaluation failed with exit code $LASTEXITCODE."
}
$propertyJson = $propertyOutput -join [Environment]::NewLine
$properties = $propertyJson | ConvertFrom-Json
$expectedProperties = [ordered]@{
    TargetFramework = 'net10.0-windows10.0.17763.0'
    RuntimeIdentifier = 'win-x64'
    SelfContained = 'true'
    PublishSingleFile = 'false'
    WindowsPackageType = 'None'
    WindowsAppSDKSelfContained = 'true'
    UseWinUI = 'true'
}
foreach ($entry in $expectedProperties.GetEnumerator()) {
    $actual = [string]$properties.Properties.$($entry.Key)
    if (-not $actual.Equals($entry.Value, [System.StringComparison]::OrdinalIgnoreCase)) {
        $failures.Add("Effective $($entry.Key) is '$actual'; expected '$($entry.Value)'.")
    }
}

if ($failures.Count -gt 0) {
    throw "Production publish content validation failed:`n$($failures -join "`n")"
}

& $dependencyScannerPath -PublishPath $publishRoot -ReportPath $DependencyReportPath
if ($LASTEXITCODE -ne 0) {
    throw "Native dependency validation failed with exit code $LASTEXITCODE."
}

$totalBytes = ($files | Measure-Object -Property Length -Sum).Sum
$webViewFiles = @($files | Where-Object Name -Like '*WebView2*')

if ($ManifestPath) {
    $manifestFullPath = [System.IO.Path]::GetFullPath($ManifestPath)
    if ($manifestFullPath.StartsWith(
            $publishRoot + [System.IO.Path]::DirectorySeparatorChar,
            [System.StringComparison]::OrdinalIgnoreCase)) {
        throw 'The provisional manifest must be written outside the publish payload.'
    }
    New-Item -ItemType Directory -Path (Split-Path -Parent $manifestFullPath) -Force | Out-Null
    $manifest = @(
        foreach ($file in $files) {
            [pscustomobject]@{
                path = [System.IO.Path]::GetRelativePath($publishRoot, $file.FullName).Replace('\', '/')
                bytes = $file.Length
                sha256 = (Get-FileHash -LiteralPath $file.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
            }
        }
    )
    $manifest | ConvertTo-Json -Depth 3 | Set-Content -LiteralPath $manifestFullPath -Encoding utf8
    Write-Output "Provisional manifest: $manifestFullPath"
}

Write-Output 'Effective publish properties:'
foreach ($entry in $expectedProperties.GetEnumerator()) {
    Write-Output "  $($entry.Key)=$($properties.Properties.$($entry.Key))"
}
Write-Output "Publish path: $publishRoot"
Write-Output "Publish files: $($files.Count)"
Write-Output "Publish logical bytes: $totalBytes"
Write-Output ('Publish logical MiB: {0:N2}' -f ($totalBytes / 1MB))
Write-Output 'Required files: PASS'
Write-Output 'Denylist: PASS'
Write-Output 'PDB files: 0'
Write-Output 'Proof/test artifacts: 0'
Write-Output "Nested resource files: $($nestedFiles.Count)"
Write-Output "Locale resource assemblies: $($localeResources.Count)"
Write-Output "WebView2 payload files: $($webViewFiles.Count)"
