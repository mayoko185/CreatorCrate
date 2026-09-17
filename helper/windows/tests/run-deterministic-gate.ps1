$ErrorActionPreference = 'Stop'
$project = Join-Path $PSScriptRoot 'OpenLocally.Tests\OpenLocally.Tests.csproj'

dotnet test $project -c Release --no-restore --filter '(Category!=InteractiveDesktop)&(Category!=DiagnosticStress)'
exit $LASTEXITCODE
