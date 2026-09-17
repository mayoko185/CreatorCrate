# CreatorCrate Windows helper

## Production publish

Run the production-only publish entry point from the repository root:

```powershell
pwsh -NoProfile -ExecutionPolicy Bypass -File .\helper\windows\scripts\publish-production.ps1
```

PowerShell 7 or later is required. The scripts reject Windows PowerShell 5.1
before cleaning or generating any publish output.

It restores only `src\OpenLocally\OpenLocally.csproj` with committed lock
files, cleans only `dist\windows-helper\production\win-x64`, and publishes a
Release, `win-x64`, .NET self-contained, unpackaged WinUI 3 multi-file payload.
It then validates required and denied content, scans every published EXE and
DLL with Visual Studio `dumpbin.exe`, and emits provisional SHA-256 evidence in
`dist\windows-helper\evidence`.

The publish payload and provisional evidence are generated under the ignored
repository `dist` directory. They are not final release artifacts. Installer
wiring and final release hashes are separate follow-up work.

The native dependency scan requires the Visual Studio C++ x64 build tools. It
fails explicitly when `dumpbin.exe` is unavailable, a PE cannot be scanned, or
an import cannot be classified. Redistributable imports are reported for
review without silently adding an installer prerequisite.
