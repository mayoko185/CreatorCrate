<#
.SYNOPSIS
    Static validation for CreatorCrate.OpenLocally.iss - no real machine
    install or uninstall is performed.

.DESCRIPTION
    Verifies, against the installer definition and the helper sources:
      - the installer references the correct published executable name;
      - the [Run] section registers the protocol with --register and the
        [UninstallRun] section unregisters it with --unregister;
      - the helper's registry constants (scheme, root key path) match;
      - the install path is per-user (%LOCALAPPDATA%);
      - no administrator privileges are required (PrivilegesRequired=lowest,
        no HKLM / common-dirs / [Registry] usage).
#>
[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'

$installerDir = $PSScriptRoot
$issPath = Join-Path $installerDir 'CreatorCrate.OpenLocally.iss'
$programPath = Join-Path $installerDir '..\src\OpenLocally\Program.cs'
$registrarPath = Join-Path $installerDir '..\src\OpenLocally\ProtocolRegistrar.cs'

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

# Cross-check the CLI flags against the helper entry point.
if (Test-Path -LiteralPath $programPath) {
    $program = Get-Content -LiteralPath $programPath -Raw
    Assert-Condition ($program -match '"--register"') `
        'Helper Program.cs supports --register' `
        'Program.cs does not handle --register.'
    Assert-Condition ($program -match '"--unregister"') `
        'Helper Program.cs supports --unregister' `
        'Program.cs does not handle --unregister.'
}

# Cross-check the registry root path against the helper constants.
if (Test-Path -LiteralPath $registrarPath) {
    $registrar = Get-Content -LiteralPath $registrarPath -Raw
    Assert-Condition ($registrar -match 'Software\\Classes\\creatorcrate-open') `
        'Helper unregister target is HKCU\Software\Classes\creatorcrate-open' `
        'ProtocolRegistrar.cs does not use the expected root key path.'
}

# --- 2b. Windows GUI subsystem (no console flash on protocol activation) ----
$csprojPath = Join-Path $installerDir '..\src\OpenLocally\OpenLocally.csproj'
if (Test-Path -LiteralPath $csprojPath) {
    $csproj = Get-Content -LiteralPath $csprojPath -Raw
    Assert-Condition ($csproj -match '<OutputType>WinExe</OutputType>') `
        'Helper builds as a Windows GUI executable (OutputType=WinExe)' `
        'OpenLocally.csproj must use <OutputType>WinExe</OutputType> so protocol activation does not flash a console window.'
    Assert-Condition ($csproj -notmatch '<OutputType>\s*Exe\s*</OutputType>') `
        'Helper does not use the console OutputType=Exe' `
        'OpenLocally.csproj must not use <OutputType>Exe</OutputType>.'
}

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

# --- 4. Published output exists (informational) ------------------------------
$distExe = Join-Path $installerDir 'dist\OpenLocally.exe'
if (Test-Path -LiteralPath $distExe) {
    $checks.Add("INFO  dist\OpenLocally.exe found - publish output present.")
}
else {
    $checks.Add("INFO  dist\OpenLocally.exe not found - run 'dotnet publish ..\src\OpenLocally\OpenLocally.csproj -c Release -r win-x64 --self-contained true -p:PublishSingleFile=true -o dist' first.")
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
