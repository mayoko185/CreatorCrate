param(
    [ValidateSet('Ready', 'Confirming', 'Unknown', 'Posted')]
    [string]$PostingState = 'Ready',
    [ValidateSet('Dark', 'Light')]
    [string]$Theme = 'Dark',
    [switch]$AutoClose
)

$ErrorActionPreference = 'Stop'
$project = Join-Path $PSScriptRoot 'OpenLocally.WinUiHost.Proof.csproj'
$proofArguments = @('--manual-visual-proof', "--posting-state=$PostingState", "--theme=$Theme")
if ($AutoClose) {
    $proofArguments += '--auto-close'
    $proofArguments += '--no-module-provenance'
}
& dotnet run --project $project --configuration Release -- $proofArguments
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
