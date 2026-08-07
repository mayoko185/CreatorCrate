; Inno Setup script for the CreatorCrate "Open locally" helper.
;
; Per-user installer: files land in %LOCALAPPDATA%\Programs\CreatorCrate\OpenLocally,
; protocol registration happens in HKCU\Software\Classes, and no
; administrator privileges are required anywhere.
;
; Build (from this directory):
;   1. dotnet publish ..\src\OpenLocally\OpenLocally.csproj -c Release -r win-x64 --self-contained true -p:PublishSingleFile=true -o dist
;   2. ISCC CreatorCrate.OpenLocally.iss
;
; The setup executable is written to the dist\ directory.

#define MyAppName "CreatorCrate Open Locally"
#define MyAppVersion "1.0.0"
#define MyAppPublisher "CreatorCrate"
#define MyAppExeName "OpenLocally.exe"
#define MyAppId "{{8F1D5C4E-6A2B-4E9D-9C3F-7B0A2E5D1C84}"

[Setup]
AppId={#MyAppId}
AppName={#MyAppName}
AppVersion={#MyAppVersion}
AppPublisher={#MyAppPublisher}
DefaultDirName={localappdata}\Programs\CreatorCrate\OpenLocally
DisableProgramGroupPage=yes
; Per-user install: never elevate, never touch Program Files or the
; machine-wide registry.
PrivilegesRequired=lowest
MinVersion=10.0.14393
OutputDir=dist
OutputBaseFilename=CreatorCrate.OpenLocally-Setup
Compression=lzma2
SolidCompression=yes
UninstallDisplayName={#MyAppName}

[Files]
; Self-contained single-file publish output (win-x64); the helper needs no
; other binaries and no pre-installed .NET runtime.
Source: "dist\OpenLocally.exe"; DestDir: "{app}"; Flags: ignoreversion

; After install, register the creatorcrate-open:// protocol. The helper
; writes HKCU\Software\Classes\creatorcrate-open pointing at its own
; installed path (Environment.ProcessPath), so no admin rights are needed.
[Run]
Filename: "{app}\{#MyAppExeName}"; Parameters: "--register"; Flags: runhidden; StatusMsg: "Registering the creatorcrate-open:// protocol..."

; On uninstall, remove the protocol registration first; the helper deletes
; the whole HKCU\Software\Classes\creatorcrate-open tree. Runs before the
; application files are removed. The helper keeps no configuration files, so
; nothing beyond the installed executable is removed or left behind.
[UninstallRun]
Filename: "{app}\{#MyAppExeName}"; Parameters: "--unregister"; Flags: runhidden
