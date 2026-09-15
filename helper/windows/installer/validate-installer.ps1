<#
.SYNOPSIS
    Static validation for CreatorCrate.OpenLocally.iss - no real machine
    install or uninstall is performed.

.DESCRIPTION
    Verifies, against the installer definition and the helper sources:
      - the installer references the correct published executable name;
      - install and uninstall wire both custom protocols through the helper;
      - the helper's registry constants and quoted commands match;
      - the stable installer identity and current version are present;
      - the .NET 10 self-contained single-file publish contract is preserved;
      - the install path is per-user (%LOCALAPPDATA%);
      - no administrator privileges are required (PrivilegesRequired=lowest,
        no HKLM / common-dirs / [Registry] usage).
#>
[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'

$installerDir = $PSScriptRoot
$issPath = Join-Path $installerDir 'CreatorCrate.OpenLocally.iss'
$dispatcherPath = Join-Path $installerDir '..\src\OpenLocally\CommandDispatcher.cs'
$registrarPath = Join-Path $installerDir '..\src\OpenLocally\ProtocolRegistrar.cs'
$socialRegistrarPath = Join-Path $installerDir '..\src\OpenLocally\SocialProtocolRegistrar.cs'
$csprojPath = Join-Path $installerDir '..\src\OpenLocally\OpenLocally.csproj'

$failures = New-Object System.Collections.Generic.List[string]
$checks = New-Object System.Collections.Generic.List[string]

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

if (-not (Test-Path -LiteralPath $issPath)) {
    Write-Error "Installer script not found: $issPath"
    exit 1
}

$iss = Get-Content -LiteralPath $issPath -Raw

# --- 1. Executable reference ------------------------------------------------
$exeSourceLine = [regex]::Match(
    $iss,
    'Source:\s*"dist\\([^"]*\.exe)"\s*;\s*DestDir:\s*"\{app\}"',
    [System.Text.RegularExpressions.RegexOptions]::IgnoreCase)
Assert-Condition $exeSourceLine.Success `
    'Executable is installed from dist\ to {app}' `
    'Expected a Source line for dist\*.exe with DestDir {app}.'

$exeName = $exeSourceLine.Groups[1].Value
Assert-Condition ($exeName -eq 'OpenLocally.exe') `
    'Installed executable is OpenLocally.exe' `
    "Installer references '$exeName' but the helper builds OpenLocally.exe."

# --- 2. Registration / unregistration commands ------------------------------
$runLine = [regex]::Match(
    $iss,
    'Filename:\s*"\{app\}\\[^"]*";\s*Parameters:\s*"--register"',
    [System.Text.RegularExpressions.RegexOptions]::IgnoreCase)
Assert-Condition $runLine.Success `
    '[Run] runs the helper with --register' `
    'Expected a [Run] entry: Filename "{app}\OpenLocally.exe"; Parameters: "--register".'

$unrunLine = [regex]::Match(
    $iss,
    'Filename:\s*"\{app\}\\[^"]*";\s*Parameters:\s*"--unregister"',
    [System.Text.RegularExpressions.RegexOptions]::IgnoreCase)
Assert-Condition $unrunLine.Success `
    '[UninstallRun] runs the helper with --unregister' `
    'Expected an [UninstallRun] entry: Filename "{app}\OpenLocally.exe"; Parameters: "--unregister".'

$socialRunLine = [regex]::Match(
    $iss,
    'Filename:\s*"\{app\}\\[^\"]*";\s*Parameters:\s*"--register-social"',
    [System.Text.RegularExpressions.RegexOptions]::IgnoreCase)
Assert-Condition $socialRunLine.Success `
    '[Run] runs the helper with --register-social' `
    'Expected a [Run] entry for --register-social.'

$socialUnrunLine = [regex]::Match(
    $iss,
    'Filename:\s*"\{app\}\\[^\"]*";\s*Parameters:\s*"--unregister-social"',
    [System.Text.RegularExpressions.RegexOptions]::IgnoreCase)
Assert-Condition $socialUnrunLine.Success `
    '[UninstallRun] runs the helper with --unregister-social' `
    'Expected an [UninstallRun] entry for --unregister-social.'
Assert-Condition ($iss -match 'Parameters:\s*"--unregister"[^\r\n]*RunOnceId:\s*"UnregisterCreatorCrateOpen"') `
    'Open Locally unregistration is recorded once across upgrades' `
    'The --unregister entry needs a stable RunOnceId.'
Assert-Condition ($iss -match 'Parameters:\s*"--unregister-social"[^\r\n]*RunOnceId:\s*"UnregisterCreatorCrateSocial"') `
    'Social unregistration is recorded once across upgrades' `
    'The --unregister-social entry needs a stable RunOnceId.'

# Cross-check the CLI flags against the helper entry point.
if (Test-Path -LiteralPath $dispatcherPath) {
    $dispatcher = Get-Content -LiteralPath $dispatcherPath -Raw
    Assert-Condition ($dispatcher -match '"--register"') `
        'Helper dispatcher supports --register' `
        'CommandDispatcher.cs does not handle --register.'
    Assert-Condition ($dispatcher -match '"--unregister"') `
        'Helper dispatcher supports --unregister' `
        'CommandDispatcher.cs does not handle --unregister.'
    Assert-Condition ($dispatcher -match '"--register-social"') `
        'Helper dispatcher supports --register-social' `
        'CommandDispatcher.cs does not handle --register-social.'
    Assert-Condition ($dispatcher -match '"--unregister-social"') `
        'Helper dispatcher supports --unregister-social' `
        'CommandDispatcher.cs does not handle --unregister-social.'
}

if (Test-Path -LiteralPath $socialRegistrarPath) {
    $socialRegistrar = Get-Content -LiteralPath $socialRegistrarPath -Raw
    Assert-Condition ($socialRegistrar -match 'Software\\Classes\\creatorcrate-social') `
        'Social helper target is HKCU\Software\Classes\creatorcrate-social' `
        'SocialProtocolRegistrar.cs does not use the expected root key path.'
}

# Both registrars must quote the executable and the single URI argument. The
# command is consumed directly by Windows shell activation, never by cmd.exe.
foreach ($path in @($registrarPath, $socialRegistrarPath)) {
    if (Test-Path -LiteralPath $path) {
        $source = Get-Content -LiteralPath $path -Raw
        Assert-Condition ($source -match '\$"\\"\{executablePath\}\\" \\"%1\\""') `
            "$(Split-Path -Leaf $path) quotes executable and URI argument" `
            'Expected the registry command shape "<executablePath>" "%1".'
        Assert-Condition ($source -match 'GetValue\(CommandKeyPath, null\)') `
            "$(Split-Path -Leaf $path) checks command ownership before removal" `
            'Unregister must preserve a protocol tree owned by another command.'
    }
}

# Cross-check the registry root path against the helper constants.
if (Test-Path -LiteralPath $registrarPath) {
    $registrar = Get-Content -LiteralPath $registrarPath -Raw
    Assert-Condition ($registrar -match 'Software\\Classes\\creatorcrate-open') `
        'Helper unregister target is HKCU\Software\Classes\creatorcrate-open' `
        'ProtocolRegistrar.cs does not use the expected root key path.'
}

# --- 2b. Windows GUI subsystem (no console flash on protocol activation) ----
if (Test-Path -LiteralPath $csprojPath) {
    $csproj = Get-Content -LiteralPath $csprojPath -Raw
    Assert-Condition ($csproj -match '<OutputType>WinExe</OutputType>') `
        'Helper builds as a Windows GUI executable (OutputType=WinExe)' `
        'OpenLocally.csproj must use <OutputType>WinExe</OutputType> so protocol activation does not flash a console window.'
    Assert-Condition ($csproj -notmatch '<OutputType>\s*Exe\s*</OutputType>') `
        'Helper does not use the console OutputType=Exe' `
        'OpenLocally.csproj must not use <OutputType>Exe</OutputType>.'
    Assert-Condition ($csproj -match '<TargetFramework>net10\.0-windows</TargetFramework>') `
        'Helper targets net10.0-windows' `
        'OpenLocally.csproj must target net10.0-windows.'
    Assert-Condition ($csproj -notmatch '<PublishTrimmed>\s*true\s*</PublishTrimmed>|<PublishAot>\s*true\s*</PublishAot>|<PublishReadyToRun>\s*true\s*</PublishReadyToRun>') `
        'Trimming, NativeAOT, and ReadyToRun are not enabled' `
        'The established production publish must not enable these options.'
}

# --- 2c. Stable identity, compatible feature version, running-app safety ----
Assert-Condition ($iss -match '#define\s+MyAppVersion\s+"1\.1\.0"') `
    'Installer version is 1.1.0' `
    'Expected the backward-compatible feature upgrade from 1.0.0 to 1.1.0.'
Assert-Condition ($iss -match '#define\s+MyAppId\s+"\{\{8F1D5C4E-6A2B-4E9D-9C3F-7B0A2E5D1C84\}"') `
    'Installer AppId preserves the 1.0.0 upgrade lineage' `
    'The established AppId must not change.'
Assert-Condition ($iss -match 'CloseApplications=yes') `
    'Installer detects and closes a running helper before replacement' `
    'CloseApplications must remain enabled for complete replacement.'
Assert-Condition ($iss -match 'CloseApplicationsFilter=\{#MyAppExeName\}') `
    'Close-applications scope is limited to OpenLocally.exe' `
    'The installer must not target unrelated processes.'
Assert-Condition ($iss -match 'RestartApplications=no') `
    'Upgrade does not replay protocol activation URIs' `
    'A social activation URI can contain a single-use intent and must not be restarted.'

$failureReporterPath = Join-Path $installerDir '..\src\OpenLocally\FailureReporter.cs'
if (Test-Path -LiteralPath $failureReporterPath) {
    $reporter = Get-Content -LiteralPath $failureReporterPath -Raw
    Assert-Condition ($reporter -match 'MessageBoxW') `
        'GUI-subsystem failures are surfaced with a Windows message box' `
        'FailureReporter.cs must fall back to MessageBoxW when no console exists.'
    Assert-Condition ($reporter -notmatch 'GetCommandLineArgs|Environment\.StackTrace') `
        'Failure reporting never exposes stack traces' `
        'FailureReporter.cs must not print stack traces.'
}

# --- 3. Per-user install path ------------------------------------------------
Assert-Condition ($iss -match 'DefaultDirName=\{localappdata\}\\[^\r\n]+') `
    'DefaultDirName is under {localappdata}' `
    'DefaultDirName must point under %LOCALAPPDATA%.'

Assert-Condition ($iss -match 'PrivilegesRequired=lowest') `
    'PrivilegesRequired=lowest (no admin)' `
    'PrivilegesRequired must be set to lowest.'

Assert-Condition ($iss -notmatch 'PrivilegesRequiredOverridesAllowed') `
    'No privilege escalation override' `
    'PrivilegesRequiredOverridesAllowed would allow an admin prompt.'

$forbidden = @(
    'HKLM',
    '{commonappdata}',
    '{commonpf}',
    '{commonprograms}',
    '\[Registry\]'
)
foreach ($token in $forbidden) {
    Assert-Condition ($iss -notmatch [regex]::Escape($token)) `
        "No forbidden token: $token" `
        "'$token' would require admin or machine-wide state."
}

# --- 4. Published output exists ----------------------------------------------
$distExe = Join-Path $installerDir 'dist\OpenLocally.exe'
if (Test-Path -LiteralPath $distExe) {
    $checks.Add("PASS  dist\OpenLocally.exe found - publish output present.")
}
else {
    $failures.Add("FAIL  dist\OpenLocally.exe missing`n      Run the documented production publish before validation.")
}

# --- Report ----------------------------------------------------------------
$checks | ForEach-Object { Write-Output $_ }

if ($failures.Count -gt 0) {
    Write-Output ''
    Write-Output 'VALIDATION FAILED:'
    $failures | ForEach-Object { Write-Output $_ }
    exit 1
}

Write-Output ''
Write-Output 'VALIDATION PASSED - installer definition is consistent with the helper.'
exit 0
