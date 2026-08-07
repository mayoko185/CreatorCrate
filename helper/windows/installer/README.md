# CreatorCrate Open Locally — Windows installer

Per-user [Inno Setup](https://jrsoftware.org/isinfo.php) installer for the
`OpenLocally` helper (the `creatorcrate-open://` protocol handler).

## Requirements

- [Inno Setup 6](https://jrsoftware.org/isdl.php) (`ISCC.exe`).
- The .NET 8 SDK (to publish the helper).

## Build

```powershell
# 1. Publish the helper (self-contained, win-x64, single-file, Release)
dotnet publish ..\src\OpenLocally\OpenLocally.csproj -c Release -r win-x64 --self-contained true -p:PublishSingleFile=true -o dist

# 2. Compile the installer
ISCC CreatorCrate.OpenLocally.iss
```

Output: `dist\CreatorCrate.OpenLocally-Setup.exe`.

The published helper is self-contained for `win-x64` and bundled into a single
`OpenLocally.exe`, so end users do not need a pre-installed .NET runtime.

## Behavior

- Installs per-user to `%LOCALAPPDATA%\Programs\CreatorCrate\OpenLocally\`.
- Ships a self-contained, single-file `OpenLocally.exe` (win-x64); no .NET
  runtime is required on the target machine.
- Does not require administrator privileges (`PrivilegesRequired=lowest`);
  files never touch Program Files and registration never touches HKLM.
- After install runs `OpenLocally.exe --register`, which writes
  `HKCU\Software\Classes\creatorcrate-open` with the installed executable
  as the handler.
- On uninstall runs `OpenLocally.exe --unregister` (deletes
  `HKCU\Software\Classes\creatorcrate-open`), then removes the installed
  files. The helper keeps no configuration files; the path it opens is
  supplied by CreatorCrate with every request.

Out of scope: automatic updates, code signing, UI customization, Start menu
configuration, config editor, folder picker, project mappings.

## Validation

`validate-installer.ps1` checks the installer definition without performing a
real install/uninstall:

```powershell
.\validate-installer.ps1
```

It verifies the executable is referenced by the correct published name,
registration/unregistration commands match the helper CLI
(`--register` / `--unregister`), install paths are per-user, and no
administrator privilege is required.
