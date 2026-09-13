[CmdletBinding()]
param(
    [string]$SourceRoot,
    [string]$DestinationRoot
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'hash-utils.ps1')
$repoRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
if (-not $SourceRoot) { $SourceRoot = Join-Path $repoRoot 'installer\artifacts' }
if (-not $DestinationRoot) { $DestinationRoot = Join-Path $repoRoot 'dist\LocalWhisperSubtitles-4.0.4-win-x64' }
$source = [System.IO.Path]::GetFullPath($SourceRoot)
$destination = [System.IO.Path]::GetFullPath($DestinationRoot)
$repoPrefix = $repoRoot.TrimEnd('\') + '\'
if (-not $source.StartsWith($repoPrefix, [StringComparison]::OrdinalIgnoreCase) -or
    -not $destination.StartsWith($repoPrefix, [StringComparison]::OrdinalIgnoreCase)) {
    throw 'Publish paths must stay inside the repository.'
}
if (-not (Test-Path -LiteralPath (Join-Path $source 'Setup.exe') -PathType Leaf)) {
    throw "Built Setup.exe is missing: $source"
}

$staging = $destination + '.staging'
if (Test-Path -LiteralPath $staging) { Remove-Item -LiteralPath $staging -Recurse -Force }
New-Item -ItemType Directory -Path $staging -Force | Out-Null
Copy-Item -LiteralPath (Join-Path $source 'Setup.exe') -Destination (Join-Path $staging 'Setup.exe')
Copy-Item -LiteralPath (Join-Path $source 'resources') -Destination (Join-Path $staging 'resources') -Recurse
if (Test-Path -LiteralPath $destination) { Remove-Item -LiteralPath $destination -Recurse -Force }
Move-Item -LiteralPath $staging -Destination $destination

$selfTest = Start-Process -FilePath (Join-Path $destination 'Setup.exe') -ArgumentList '--self-test' -Wait -PassThru -WindowStyle Hidden
if ($selfTest.ExitCode -ne 0) { throw "Published Setup.exe self-test failed: $($selfTest.ExitCode)" }
$publishedSetup = Join-Path $destination 'Setup.exe'
[PSCustomObject]@{
    Algorithm = 'SHA256'
    Hash = (Get-Sha256Hex -LiteralPath $publishedSetup).ToUpperInvariant()
    Path = $publishedSetup
}
