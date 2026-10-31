[CmdletBinding()]
param([string]$NsisPath)
$ErrorActionPreference = 'Stop'
if (-not $NsisPath) { $NsisPath = $env:NSIS_MAKENSIS }
if (-not $NsisPath) {
    $installed = Get-Command makensis.exe -ErrorAction SilentlyContinue
    if ($installed) { $NsisPath = $installed.Source }
}
if ($NsisPath) {
    $compiler = (Resolve-Path -LiteralPath $NsisPath).Path
    $env:NSISDIR = Split-Path -Parent $compiler
    return $compiler
}

# A current, reproducible Unicode NSIS toolchain. No machine-wide installation.
# Digest comes from the upstream release asset's SHA-256 metadata.
$repo = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$tools = Join-Path $repo 'installer\obj\toolchains'
$destination = Join-Path $tools 'nsis-3.13'
$compiler = Join-Path $destination 'nsis-bundle\windows\makensis.exe'
if (-not (Test-Path -LiteralPath $compiler -PathType Leaf)) {
    New-Item -ItemType Directory -Path $tools -Force | Out-Null
    $archive = Join-Path $tools 'nsis-bundle-3.13.tar.gz'
    $hash = 'C18E9AD9684CF4C5BBD7B768CBF1B056D40771D7BD9AE1B513346452DECF89D2'
    if (-not (Test-Path -LiteralPath $archive -PathType Leaf)) {
        $ProgressPreference = 'SilentlyContinue'
        Invoke-WebRequest -Uri 'https://github.com/electron-userland/electron-builder-binaries/releases/download/nsis%402.0.4/nsis-bundle-3.13.tar.gz' -OutFile ($archive + '.partial') -UseBasicParsing
        if ((Get-FileHash -LiteralPath ($archive + '.partial') -Algorithm SHA256).Hash -ne $hash) { throw 'NSIS toolchain SHA-256 mismatch.' }
        Move-Item -LiteralPath ($archive + '.partial') -Destination $archive
    }
    if ((Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash -ne $hash) { throw 'NSIS toolchain SHA-256 mismatch.' }
    $entries = & tar.exe -tzf $archive
    if ($LASTEXITCODE -ne 0 -or ($entries | Where-Object { $_ -match '(^/|^[A-Za-z]:|(^|/)\.\.(/|$))' })) { throw 'Unsafe NSIS toolchain archive.' }
    New-Item -ItemType Directory -Path $destination -Force | Out-Null
    & tar.exe -xzf $archive -C $destination
    if ($LASTEXITCODE -ne 0) { throw 'Could not extract NSIS toolchain.' }
}
$env:NSISDIR = Split-Path -Parent $compiler
return $compiler
