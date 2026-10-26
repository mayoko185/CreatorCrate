param(
    [ValidateSet('Ready', 'Confirming', 'Unknown', 'Posted')]
    [string]$PostingState = 'Ready',
    [ValidateSet('Dark', 'Light')]
    [string]$Theme = 'Dark',
    # Scripted Release link scenario; production always shows the card, so 'ready' is the default.
    [ValidateSet('ready', 'none', 'loading', 'draft', 'saved', 'invalid', 'conflict', 'uncertain', 'failed', 'expired', 'unsupported')]
    [string]$ReleaseLink = 'ready',
    # Legacy layout without a Release link controller, for focused comparison only.
    [switch]$NoReleaseLink,
    [ValidateRange(100, 225)]
    [int]$TextScale,
    [switch]$DragProof,
    [switch]$AutoClose
)

$ErrorActionPreference = 'Stop'
$project = Join-Path $PSScriptRoot 'OpenLocally.WinUiHost.Proof.csproj'
if ($NoReleaseLink -and $PSBoundParameters.ContainsKey('ReleaseLink')) {
    throw '-NoReleaseLink cannot be combined with -ReleaseLink.'
}
if ($DragProof) {
    foreach ($name in 'ReleaseLink', 'NoReleaseLink', 'TextScale') {
        if ($PSBoundParameters.ContainsKey($name)) { throw "-$name does not apply to -DragProof." }
    }
    if ($AutoClose) {
        & dotnet run --project $project --configuration Release --no-restore -- --drag-proof --auto-close
    } else {
        & dotnet run --project $project --configuration Release --no-restore -- --drag-proof
    }
} else {
    $proofArguments = @('--manual-visual-proof', "--posting-state=$PostingState", "--theme=$Theme")
    if ($NoReleaseLink) {
        $proofArguments += '--no-release-link'
    } else {
        $proofArguments += "--release-link=$($ReleaseLink.ToLowerInvariant())"
    }
    if ($PSBoundParameters.ContainsKey('TextScale')) { $proofArguments += "--text-scale=$TextScale" }
    if ($AutoClose) { $proofArguments += @('--auto-close', '--no-module-provenance') }
    & dotnet run --project $project --configuration Release --no-restore -- @proofArguments
}
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
