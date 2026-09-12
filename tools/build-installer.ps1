[CmdletBinding()]
param(
    [string]$OutputRoot,
    [switch]$SkipTests
)

$ErrorActionPreference = 'Stop'
$repoRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$installerRoot = Join-Path $repoRoot 'installer'
$extensionRoot = Join-Path $repoRoot 'extension'
$resourcesRoot = Join-Path $repoRoot 'resources'
if (-not $OutputRoot) { $OutputRoot = Join-Path $installerRoot 'artifacts' }
$OutputRoot = [System.IO.Path]::GetFullPath($OutputRoot)
$repoPrefix = $repoRoot.TrimEnd('\') + '\'
if (-not $OutputRoot.StartsWith($repoPrefix, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "OutputRoot must remain inside the repository: $OutputRoot"
}

& (Join-Path $PSScriptRoot 'generate-resource-manifest.ps1') -ResourcesRoot $resourcesRoot -Check

$cscCandidates = @(
    (Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'),
    (Join-Path $env:WINDIR 'Microsoft.NET\Framework\v4.0.30319\csc.exe')
)
$csc = $cscCandidates | Where-Object { Test-Path -LiteralPath $_ -PathType Leaf } | Select-Object -First 1
if (-not $csc) {
    throw 'No .NET Framework C# compiler was found. Install .NET Framework 4.8 developer tools or Visual Studio Build Tools.'
}

$objRoot = Join-Path $installerRoot 'obj'
New-Item -ItemType Directory -Path $objRoot -Force | Out-Null
$payloadZip = Join-Path $objRoot 'extension-payload.zip'
if (Test-Path -LiteralPath $payloadZip) { Remove-Item -LiteralPath $payloadZip -Force }
$payloadStaging = Join-Path $objRoot 'extension-payload-staging'
if (Test-Path -LiteralPath $payloadStaging) { Remove-Item -LiteralPath $payloadStaging -Recurse -Force }
New-Item -ItemType Directory -Path $payloadStaging -Force | Out-Null
$forbiddenPayloads = Get-ChildItem -LiteralPath $extensionRoot -Recurse -File | Where-Object {
    $_.Extension -in @('.bin', '.gguf', '.pt', '.zip') -or $_.Length -gt 50MB
}
if ($forbiddenPayloads) {
    throw "Model/archive-like files cannot be embedded in Setup: $($forbiddenPayloads.FullName -join ', ')"
}
Get-ChildItem -LiteralPath $extensionRoot -Recurse -File | Where-Object {
    $_.Extension -ne '.pyc' -and $_.FullName -notmatch '[\\/]__pycache__[\\/]'
} | ForEach-Object {
    $relativePath = $_.FullName.Substring($extensionRoot.Length).TrimStart('\', '/')
    $target = Join-Path $payloadStaging $relativePath
    $targetDirectory = Split-Path -Parent $target
    if (-not (Test-Path -LiteralPath $targetDirectory)) { New-Item -ItemType Directory -Path $targetDirectory -Force | Out-Null }
    Copy-Item -LiteralPath $_.FullName -Destination $target
}
Add-Type -AssemblyName System.IO.Compression.FileSystem
[System.IO.Compression.ZipFile]::CreateFromDirectory(
    $payloadStaging,
    $payloadZip,
    [System.IO.Compression.CompressionLevel]::Optimal,
    $false
)
Remove-Item -LiteralPath $payloadStaging -Recurse -Force

if (Test-Path -LiteralPath $OutputRoot) {
    if (-not $OutputRoot.StartsWith($repoPrefix, [System.StringComparison]::OrdinalIgnoreCase)) { throw 'Unsafe output deletion was blocked.' }
    Remove-Item -LiteralPath $OutputRoot -Recurse -Force
}
New-Item -ItemType Directory -Path $OutputRoot -Force | Out-Null
$setupPath = Join-Path $OutputRoot 'Setup.exe'

$sources = Get-ChildItem -LiteralPath $installerRoot -Recurse -Filter '*.cs' -File |
    Where-Object { $_.FullName -notlike "$objRoot*" -and $_.FullName -notlike "$(Join-Path $installerRoot 'artifacts')*" } |
    Sort-Object FullName |
    Select-Object -ExpandProperty FullName

$compilerArgs = @(
    '/nologo',
    '/target:winexe',
    '/platform:x64',
    '/optimize+',
    '/debug-',
    "/out:$setupPath",
    "/win32manifest:$(Join-Path $installerRoot 'app.manifest')",
    "/resource:$payloadZip,ExtensionPayload.zip",
    '/reference:System.dll',
    '/reference:System.Core.dll',
    '/reference:System.Drawing.dll',
    '/reference:System.IO.Compression.dll',
    '/reference:System.IO.Compression.FileSystem.dll',
    '/reference:System.Web.Extensions.dll',
    '/reference:System.Windows.Forms.dll'
) + $sources

& $csc @compilerArgs
if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $setupPath -PathType Leaf)) {
    throw "Installer compilation failed with exit code $LASTEXITCODE."
}

$setupAssembly = [Reflection.Assembly]::LoadFile($setupPath)
$embeddedResources = @($setupAssembly.GetManifestResourceNames())
if ($embeddedResources.Count -ne 1 -or $embeddedResources[0] -ne 'ExtensionPayload.zip') {
    throw "Setup embedded-resource boundary failed: $($embeddedResources -join ', ')"
}

$artifactResources = Join-Path $OutputRoot 'resources'
Copy-Item -LiteralPath $resourcesRoot -Destination $artifactResources -Recurse
& (Join-Path $PSScriptRoot 'generate-resource-manifest.ps1') -ResourcesRoot $artifactResources -Check
if (Get-ChildItem -LiteralPath (Join-Path $artifactResources 'models') -File -ErrorAction SilentlyContinue |
    Where-Object { $_.Extension -in @('.bin', '.gguf', '.pt') }) {
    throw 'A model file was found in the release resources directory. Models must remain opt-in and external.'
}

if (-not $SkipTests) {
    & (Join-Path $repoRoot 'tests\installer\run-installer-tests.ps1')
}

$selfTest = Start-Process -FilePath $setupPath -ArgumentList '--self-test' -Wait -PassThru -WindowStyle Hidden
if ($selfTest.ExitCode -ne 0) {
    throw "Built Setup.exe self-test failed with exit code $($selfTest.ExitCode)."
}

$setup = Get-Item -LiteralPath $setupPath
Write-Host "Built one-click installer: $($setup.FullName) ($($setup.Length) bytes)"
Write-Host "External resources: $artifactResources"
