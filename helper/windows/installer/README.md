# CreatorCrate Open Locally — Windows installer

Per-user [Inno Setup](https://jrsoftware.org/isinfo.php) installer for the
`OpenLocally` helper. The same executable handles the established
`creatorcrate-open://` protocol and the manual Social Preparation
`creatorcrate-social://` protocol.

## Requirements

- [Inno Setup 6](https://jrsoftware.org/isdl.php) (`ISCC.exe`).
- The .NET 10 SDK (to publish the `net10.0-windows` helper).

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
- Provides the native manual Social Preparation companion. It supports exact
  Unicode copy and Windows `CF_HDROP` file drag; it does not automate, control,
  or post to social websites.
- Does not require administrator privileges (`PrivilegesRequired=lowest`);
  files never touch Program Files and registration never touches HKLM.
- After install and every in-place upgrade, runs `OpenLocally.exe --register`
  and `OpenLocally.exe --register-social`. These write
  `HKCU\Software\Classes\creatorcrate-open` and
  `HKCU\Software\Classes\creatorcrate-social`; both commands use the exact
  quoted shape `"<installed path>" "%1"`.
- The stable AppId and install directory make a newer setup an in-place
  upgrade. Inno Setup's normal close-applications handling prevents replacing
  a running helper with a partial installation. Registration is refreshed
  after the files are installed, including stale executable paths.
- On uninstall, the matching unregister commands remove each protocol tree
  only when its command still points to this installation. Independently
  replaced protocol registrations are preserved.
- Trusted origins and trusted local-media roots are per-user configuration,
  stored outside the install directory, and are preserved across upgrade and
  uninstall.
- The package contains no CreatorCrate Chrome/CDP implementation, platform
  adapter, browser harness, or automated social-posting payload.

Out of scope: automatic updates, code signing, UI customization, Start menu
configuration, config editor, folder picker, project mappings.

## Validation

`validate-installer.ps1` checks the installer definition without performing a
real install/uninstall:

```powershell
.\validate-installer.ps1
```

It verifies the executable is referenced by the correct published name,
registration/unregistration commands match the helper CLI for both schemes,
the version and .NET 10 publish contract are current, install paths are
per-user, and no administrator privilege is required.
