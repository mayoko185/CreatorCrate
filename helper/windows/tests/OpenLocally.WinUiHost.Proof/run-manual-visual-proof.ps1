param(
    [ValidateSet('Ready', 'Confirming', 'Unknown', 'Posted')]
    [string]$PostingState = 'Ready',
    [ValidateSet('Dark', 'Light')]
    [string]$Theme = 'Dark',
    [switch]$DragProof,
    [switch]$AutoClose
)

$ErrorActionPreference = 'Stop'
$project = Join-Path $PSScriptRoot 'OpenLocally.WinUiHost.Proof.csproj'
if ($DragProof) {
    if ($AutoClose) {
        & dotnet run --project $project --configuration Release --no-restore -- --drag-proof --auto-close
    } else {
        & dotnet run --project $project --configuration Release --no-restore -- --drag-proof
    }
} elseif ($AutoClose) {
    & dotnet run --project $project --configuration Release --no-restore -- --manual-visual-proof "--posting-state=$PostingState" "--theme=$Theme" --auto-close --no-module-provenance
} else {
    & dotnet run --project $project --configuration Release --no-restore -- --manual-visual-proof "--posting-state=$PostingState" "--theme=$Theme"
}
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
