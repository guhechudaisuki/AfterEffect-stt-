param(
    [string]$AfterEffectsPath = $env:AFTERFX_PATH,
    [int]$TimeoutSeconds = 60
)

$ErrorActionPreference = "Stop"
$projectRoot = Split-Path -Parent $PSScriptRoot
$workFolder = Join-Path $projectRoot "artifacts\mogrt"
$flagPath = Join-Path $workFolder "project-only.flag"
$reportPath = Join-Path $workFolder "build-result.txt"
$projectPath = Join-Path $workFolder "LocalWhisper_Default_25_6.aep"
$scriptPath = Join-Path $PSScriptRoot "create-mogrt.jsx"

if ([string]::IsNullOrWhiteSpace($AfterEffectsPath)) {
    throw "Specify -AfterEffectsPath or set the AFTERFX_PATH environment variable."
}

New-Item -ItemType Directory -Force -Path $workFolder | Out-Null
Set-Content -LiteralPath $flagPath -Value "project-only" -Encoding ASCII
if (Test-Path -LiteralPath $reportPath) { Remove-Item -LiteralPath $reportPath -Force }
if (Test-Path -LiteralPath $projectPath) { Remove-Item -LiteralPath $projectPath -Force }

try {
    $process = Start-Process -FilePath $AfterEffectsPath -ArgumentList @("-m", "-r", $scriptPath) -WindowStyle Normal -PassThru
    try { Wait-Process -Id $process.Id -Timeout $TimeoutSeconds -ErrorAction Stop }
    catch {
        Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue
        throw "After Effects did not finish project generation within $TimeoutSeconds seconds."
    }
}
finally {
    Remove-Item -LiteralPath $flagPath -Force -ErrorAction SilentlyContinue
}

if (-not (Test-Path -LiteralPath $reportPath)) { throw "After Effects did not write the project generation report." }
$report = Get-Content -Raw -Encoding UTF8 -LiteralPath $reportPath
Write-Output $report
if ($report -notmatch "(?m)^status=projectOnly$") { throw "MOGRT source project generation failed." }
if (-not (Test-Path -LiteralPath $projectPath)) { throw "MOGRT source AEP was not created." }
