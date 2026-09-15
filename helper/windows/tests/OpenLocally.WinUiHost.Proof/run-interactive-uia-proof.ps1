$ErrorActionPreference = 'Stop'
$repository = (Resolve-Path (Join-Path $PSScriptRoot '..\..\..\..')).Path
$project = Join-Path $PSScriptRoot 'OpenLocally.WinUiHost.Proof.csproj'
$output = Join-Path $repository 'test-results\winui-accessibility-proof'

dotnet publish $project -c Release -r win-x64 --self-contained true -o $output
if ($LASTEXITCODE -ne 0) { throw "Publishing the interactive proof failed with exit code $LASTEXITCODE." }

$executable = Join-Path $output 'OpenLocally.WinUiHost.Proof.exe'
& $executable --interactive-uia-proof
exit $LASTEXITCODE
