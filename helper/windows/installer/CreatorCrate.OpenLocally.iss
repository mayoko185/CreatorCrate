; Inno Setup script for the CreatorCrate "Open locally" helper.
;
; Per-user installer: files land in %LOCALAPPDATA%\Programs\CreatorCrate\OpenLocally,
; protocol registration happens in HKCU\Software\Classes, and no
; administrator privileges are required anywhere.
;
; Production publish (from the repository root):
;   pwsh -NoProfile -ExecutionPolicy Bypass -File .\helper\windows\scripts\publish-production.ps1
;
; The installer consumes that complete validated publish tree. A later release
; step compiles this source; its output is kept outside the publish input.

#define MyAppName "CreatorCrate Open Locally"
#define MyAppVersion "1.2.0"
#define MyAppPublisher "CreatorCrate"
#define MyAppExeName "OpenLocally.exe"
#define MyAppId "{{8F1D5C4E-6A2B-4E9D-9C3F-7B0A2E5D1C84}"
#define ProductionPublishDir "..\..\..\dist\windows-helper\production\win-x64"
#define InstallerOutputDir "..\..\..\dist\windows-helper\installer"

[Setup]
AppId={#MyAppId}
AppName={#MyAppName}
AppVersion={#MyAppVersion}
AppPublisher={#MyAppPublisher}
VersionInfoVersion={#MyAppVersion}
DefaultDirName={localappdata}\Programs\CreatorCrate\OpenLocally
DisableProgramGroupPage=yes
; Per-user install: never elevate, never touch Program Files or the
; machine-wide registry.
PrivilegesRequired=lowest
MinVersion=10.0.14393
OutputDir={#InstallerOutputDir}
OutputBaseFilename=CreatorCrate.OpenLocally-Setup
Compression=lzma2
SolidCompression=yes
SetupIconFile=..\src\OpenLocally\CreatorCrate.ico
UninstallDisplayName={#MyAppName}
UninstallDisplayIcon={app}\{#MyAppExeName}
; Use Restart Manager to close only this helper before replacing it. Never
; restart a protocol activation after upgrade because a social URI can carry
; a single-use intent.
CloseApplications=yes
CloseApplicationsFilter={#MyAppExeName}
RestartApplications=no

[Files]
; Install the complete D1-validated multi-file publish while retaining its
; locale, architecture, native-runtime, PRI, and resource subdirectories.
Source: "{#ProductionPublishDir}\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs

; After install or upgrade, register both protocols with the same helper.
; Each command writes under HKCU\Software\Classes and replaces a stale
; executable path without requiring administrator rights.
[Run]
Filename: "{app}\{#MyAppExeName}"; Parameters: "--register"; Flags: runhidden; StatusMsg: "Registering the creatorcrate-open:// protocol..."
Filename: "{app}\{#MyAppExeName}"; Parameters: "--register-social"; Flags: runhidden; StatusMsg: "Registering the creatorcrate-social:// protocol..."

; On uninstall, remove only registrations whose command still points to this
; installed executable. Trust/origin state is user configuration and remains.
[UninstallRun]
Filename: "{app}\{#MyAppExeName}"; Parameters: "--unregister"; Flags: runhidden; RunOnceId: "UnregisterCreatorCrateOpen"
Filename: "{app}\{#MyAppExeName}"; Parameters: "--unregister-social"; Flags: runhidden; RunOnceId: "UnregisterCreatorCrateSocial"

[Code]
const
  UninstallRegistryPath = 'Software\Microsoft\Windows\CurrentVersion\Uninstall\';

function GetCreatorCrateUninstallKey: String;
begin
  { MyAppId starts with "{{" so ExpandConstant returns the literal braced AppId. }
  Result := UninstallRegistryPath + ExpandConstant('{#MyAppId}') + '_is1';
end;

function IsInstalledVersionNewer(const InstalledVersion: String;
  const CandidateVersion: Int64; var InstalledVersionValid: Boolean): Boolean;
var
  InstalledPackedVersion: Int64;
begin
  InstalledVersionValid := StrToVersion(InstalledVersion, InstalledPackedVersion);
  Result := InstalledVersionValid and
    (ComparePackedVersion(InstalledPackedVersion, CandidateVersion) > 0);
end;

function InitializeSetup: Boolean;
var
  CandidatePackedVersion: Int64;
  InstalledVersion: String;
  InstalledVersionValid: Boolean;
  UninstallKey: String;
begin
  Result := True;

  if not StrToVersion('{#MyAppVersion}', CandidatePackedVersion) then
  begin
    Log('Candidate setup version is malformed; setup cannot continue.');
    SuppressibleMsgBox(
      'This CreatorCrate Windows Helper setup has invalid version metadata and cannot continue.',
      mbCriticalError, MB_OK, IDOK);
    Result := False;
    Exit;
  end;

  UninstallKey := GetCreatorCrateUninstallKey;
  if not RegKeyExists(HKCU, UninstallKey) then
  begin
    Log('No existing CreatorCrate installation was detected; allowing setup.');
    Exit;
  end;

  if not RegQueryStringValue(HKCU, UninstallKey, 'DisplayVersion', InstalledVersion) then
  begin
    Log('Existing CreatorCrate installation has no DisplayVersion; allowing repair.');
    Exit;
  end;

  InstalledVersion := Trim(InstalledVersion);
  if InstalledVersion = '' then
  begin
    Log('Existing CreatorCrate installation has an empty DisplayVersion; allowing repair.');
    Exit;
  end;

  if IsInstalledVersionNewer(InstalledVersion, CandidatePackedVersion,
    InstalledVersionValid) then
  begin
    Log(Format('Blocking downgrade from installed version %s to setup version %s.', [InstalledVersion, '{#MyAppVersion}']));
    SuppressibleMsgBox(
      'A newer CreatorCrate Windows Helper is already installed. This older setup cannot continue.',
      mbCriticalError, MB_OK, IDOK);
    Result := False;
    Exit;
  end;

  if not InstalledVersionValid then
  begin
    Log(Format('Existing CreatorCrate DisplayVersion "%s" is malformed; allowing repair.', [InstalledVersion]));
    Exit;
  end;

  Log(Format('Installed version %s is not newer than setup version %s; allowing setup.', [InstalledVersion, '{#MyAppVersion}']));
end;
