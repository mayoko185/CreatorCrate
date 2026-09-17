# CreatorCrate Open Locally — Windows installer

Per-user [Inno Setup](https://jrsoftware.org/isinfo.php) installer for the
`OpenLocally` helper. The same executable handles the established
`creatorcrate-open://` protocol and the manual Social Preparation
`creatorcrate-social://` protocol.

## Requirements

- PowerShell 7 (`pwsh`).
- The .NET 10 SDK.
- Visual Studio C++ x64 build tools for D1 native-dependency validation.
- Inno Setup 6 (`ISCC.exe`) for the later installer-build step.

## Source and payload validation

From the repository root, create the canonical D1 production publish:

```powershell
pwsh -NoProfile -ExecutionPolicy Bypass -File .\helper\windows\scripts\publish-production.ps1
```

This produces the validated multi-file payload at:

```text
dist\windows-helper\production\win-x64
```

The Inno source consumes that entire directory recursively. It does not read
project `bin` output, proof/test output, the old installer-local `dist`
directory, D1 evidence, or the repository root. Installer artifacts are
configured separately under:

```text
dist\windows-helper\installer
```

Run static source validation without requiring a generated publish:

```powershell
pwsh -NoProfile -ExecutionPolicy Bypass -File .\helper\windows\installer\validate-installer.ps1
```

When the D1 publish exists, require canonical D1 validation and enumerate the
actual recursive installer mapping with:

```powershell
pwsh -NoProfile -ExecutionPolicy Bypass -File .\helper\windows\installer\validate-installer.ps1 -ValidatePayload
```

The integration mode runs `validate-production-publish.ps1` first, then proves
that root binaries, nested locale/resources, Windows App SDK files, and .NET
runtime files are mapped while PDB, proof/test, setup, and provisional evidence
artifacts remain excluded. It also fails if publish input and installer output
contain one another.

Compiling the final installer is intentionally a later D3 release step. This
source-validation work does not bump the version, create a release candidate,
or replace `downloads\CreatorCrate.OpenLocally-Setup.exe`.

## Previous-version manifest and downgrade policy

The retained setup binaries and their matching historical installer sources
establish this application-directory history:

| Version | Setup evidence | Historical source | Installed relative path | Current package ownership | Obsolete |
| --- | --- | --- | --- | --- | --- |
| 1.0.0 | Tracked setup at commit `f46d0f4a` (`F92A33316F44E56EBDE1BD922DCFE2342588FF43501367914F96D19B9542D416`) | `f46d0f4a` `[Files]` rule | `OpenLocally.exe` (file) | Replaced | No |
| 1.1.0 | `downloads\CreatorCrate.OpenLocally-Setup.exe` (`3AB85AE3F1B17BA84CC49B2E27BF3B8710216DBF07F0EC645D2407EAD7A98E11`) | `f361f6c4` `[Files]` rule | `OpenLocally.exe` (file) | Replaced | No |

Both binaries were listed directly as Inno Setup archives and agree with the
single-file historical `[Files]` rules. Neither version installed loose browser
automation DLLs, Chrome/CDP scripts, adapters, websocket helpers, or browser
resource directories. Browser automation code present in those generations was
embedded in `OpenLocally.exe`.

The stable AppId keeps upgrades in the same Inno product lineage. During
`InitializeSetup`, setup reads `DisplayVersion` from the matching per-user
`HKCU` uninstall key and compares it numerically with `MyAppVersion`. An older
installed version may be upgraded, and the same version may be repaired or
reinstalled. A newer installed version blocks an older setup before any files
or protocol registrations can change. If the product is absent, or its
installed version is missing or malformed, setup logs the condition and allows
installation so damaged metadata does not prevent repair.

The static validator bounds the production `IsInstalledVersionNewer` routine
and its `InitializeSetup` rejection branch, while
`tests\validate-installer-downgrade-contract.ps1` mutation-tests that source
contract using temporary copies of the current installer script. The 8-case
PowerShell expected-decision matrix is supplementary semantic documentation;
it does not execute Inno Pascal or independently prove production execution.

No manifest-backed obsolete application-directory file was found. D2B1 adds no
`[InstallDelete]` or wildcard cleanup. D2B2 should add no cleanup for the proven
1.0.0/1.1.0 lineage unless another actually shipped artifact supplies contrary
manifest evidence. Runtime upgrade validation remains deferred to D5.

## Behavior

- Installs per-user to `%LOCALAPPDATA%\Programs\CreatorCrate\OpenLocally\`.
- Ships the complete self-contained `win-x64` .NET/WinUI private-runtime
  payload; no pre-installed .NET runtime is required.
- Uses the CreatorCrate icon for the setup executable and the installed helper
  executable for Installed Apps/uninstall branding.
- Does not require administrator privileges (`PrivilegesRequired=lowest`);
  files never touch Program Files and registration never touches HKLM.
- After install and every in-place upgrade, runs `OpenLocally.exe --register`
  and `OpenLocally.exe --register-social`. These write
  `HKCU\Software\Classes\creatorcrate-open` and
  `HKCU\Software\Classes\creatorcrate-social`; both commands use the exact
  quoted shape `"<installed path>" "%1"`.
- On uninstall, the matching unregister commands remove each protocol tree
  only when its command still points to this installation. Independently
  replaced protocol registrations are preserved.
- Trusted origins and trusted local-media roots are per-user configuration,
  stored outside the install directory, and are preserved across upgrade and
  uninstall.

Obsolete-file cleanup, candidate construction, release hashes, and
clean/offline-machine validation remain outside this package.
