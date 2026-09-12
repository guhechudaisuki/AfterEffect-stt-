[CmdletBinding()]
param(
    [switch]$Download,
    [switch]$AcceptThirdPartyLicense
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'hash-utils.ps1')
$repoRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$resourcesRoot = Join-Path $repoRoot 'resources'
$manifestPath = Join-Path $resourcesRoot 'manifest.json'
$manifest = Get-Content -LiteralPath $manifestPath -Raw -Encoding UTF8 | ConvertFrom-Json
$runtime = @($manifest.runtimes | Where-Object { $_.backend -eq 'cpu' -and $_.architecture -eq 'x64' })[0]
if (-not $runtime) { throw 'No Windows x64 CPU runtime is declared.' }
if (-not ([Uri]$runtime.downloadUrl).IsAbsoluteUri -or ([Uri]$runtime.downloadUrl).Scheme -ne 'https') {
    throw 'Runtime downloadUrl must be an absolute HTTPS URL.'
}
if (-not $runtime.sha256 -or ([string]$runtime.sha256).Length -ne 64 -or [long]$runtime.size -le 0) {
    throw 'Runtime size and SHA-256 must be pinned in manifest.json before download.'
}

$target = [System.IO.Path]::GetFullPath((Join-Path $resourcesRoot $runtime.localPath))
$rootPrefix = [System.IO.Path]::GetFullPath($resourcesRoot).TrimEnd('\') + '\'
if (-not $target.StartsWith($rootPrefix, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw 'Runtime path escapes resources root.'
}

if (-not (Test-Path -LiteralPath $target -PathType Leaf)) {
    if (-not $Download) {
        throw "Runtime archive is absent. Re-run with -Download -AcceptThirdPartyLicense after reviewing resources/licenses/whisper.cpp-MIT.txt. No download was attempted."
    }
    if (-not $AcceptThirdPartyLicense) {
        throw 'Explicit -AcceptThirdPartyLicense is required. No download was attempted.'
    }
    New-Item -ItemType Directory -Path (Split-Path -Parent $target) -Force | Out-Null
    $partial = $target + '.part'
    try {
        Write-Host "Downloading explicitly requested runtime from $($runtime.downloadUrl)"
        $curl = Get-Command curl.exe -ErrorAction SilentlyContinue
        if ($curl) {
            & $curl.Source --ssl-revoke-best-effort -L --fail --retry 3 --retry-delay 2 -A LocalWhisperSubtitles-ResourceBuild -o $partial $runtime.downloadUrl
            if ($LASTEXITCODE -ne 0) { throw "curl failed with exit code $LASTEXITCODE" }
        }
        else {
            Invoke-WebRequest -UseBasicParsing -Headers @{ 'User-Agent' = 'LocalWhisperSubtitles-ResourceBuild' } -Uri $runtime.downloadUrl -OutFile $partial
        }
        $downloaded = Get-Item -LiteralPath $partial
        $downloadedHash = Get-Sha256Hex -LiteralPath $partial
        if ([long]$downloaded.Length -ne [long]$runtime.size -or $downloadedHash -ne [string]$runtime.sha256) {
            throw "Downloaded runtime failed pinned size/SHA-256 verification. No resource was installed."
        }
        Move-Item -LiteralPath $partial -Destination $target -Force
    }
    finally {
        if (Test-Path -LiteralPath $partial) { Remove-Item -LiteralPath $partial -Force }
    }
}

& (Join-Path $PSScriptRoot 'generate-resource-manifest.ps1') -Check
Write-Host "External runtime ready: $target"
