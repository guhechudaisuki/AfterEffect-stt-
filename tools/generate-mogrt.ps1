param(
    [string]$AfterEffectsPath = $env:AFTERFX_PATH,
    [int]$TimeoutSeconds = 90
)

$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot "hash-utils.ps1")
$projectRoot = Split-Path -Parent $PSScriptRoot
$scriptPath = Join-Path $PSScriptRoot "create-mogrt.jsx"
$resultPath = Join-Path $projectRoot "artifacts\mogrt\build-result.txt"
$mogrtPath = Join-Path $projectRoot "extension\assets\LocalWhisper_Default_25_6.mogrt"

if ([string]::IsNullOrWhiteSpace($AfterEffectsPath)) {
    throw "Specify -AfterEffectsPath or set the AFTERFX_PATH environment variable."
}

if (-not (Test-Path -LiteralPath $AfterEffectsPath)) {
    throw "After Effects 2020+ command host was not found: $AfterEffectsPath"
}

if (Get-Process AfterFX -ErrorAction SilentlyContinue) {
    throw "After Effects is already running. Close it before generating the release MOGRT."
}

New-Item -ItemType Directory -Force -Path (Split-Path -Parent $resultPath) | Out-Null
if (Test-Path -LiteralPath $resultPath) { Remove-Item -LiteralPath $resultPath -Force }

$process = Start-Process -FilePath $AfterEffectsPath -ArgumentList @("-m", "-r", $scriptPath) -WindowStyle Normal -PassThru
try {
    Wait-Process -Id $process.Id -Timeout $TimeoutSeconds -ErrorAction Stop
}
catch {
    Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue
    throw "After Effects did not finish MOGRT generation within $TimeoutSeconds seconds. Complete the export from a visible Adobe 2020+ AE session."
}
if (-not (Test-Path -LiteralPath $resultPath)) {
    throw "After Effects exited without a MOGRT build report (exit code $($process.ExitCode))."
}

$report = Get-Content -Raw -Encoding UTF8 -LiteralPath $resultPath
Write-Output $report
if ($report -notmatch "(?m)^status=ok$") { throw "MOGRT generation failed." }
if (-not (Test-Path -LiteralPath $mogrtPath)) { throw "MOGRT file is missing after a successful report." }

$asset = Get-Item -LiteralPath $mogrtPath
Write-Output ("MOGRT_BYTES=" + $asset.Length)
Write-Output ("MOGRT_SHA256=" + (Get-Sha256Hex -LiteralPath $mogrtPath).ToUpperInvariant())
