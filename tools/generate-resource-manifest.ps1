[CmdletBinding()]
param(
    [string]$ResourcesRoot,
    [switch]$Check
)

$ErrorActionPreference = 'Stop'
$repoRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
if (-not $ResourcesRoot) {
    $ResourcesRoot = Join-Path $repoRoot 'resources'
}
$ResourcesRoot = [System.IO.Path]::GetFullPath($ResourcesRoot)
$manifestPath = Join-Path $ResourcesRoot 'manifest.json'

function Resolve-ChildPath {
    param([string]$Root, [string]$RelativePath)

    if ([System.IO.Path]::IsPathRooted($RelativePath)) {
        throw "Absolute resource paths are not allowed: $RelativePath"
    }
    $fullRoot = [System.IO.Path]::GetFullPath($Root).TrimEnd('\', '/') + [System.IO.Path]::DirectorySeparatorChar
    $candidate = [System.IO.Path]::GetFullPath((Join-Path $fullRoot $RelativePath))
    if (-not $candidate.StartsWith($fullRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
        throw "Resource path escapes resources root: $RelativePath"
    }
    return $candidate
}

if (-not (Test-Path -LiteralPath $manifestPath -PathType Leaf)) {
    throw "Resource manifest not found: $manifestPath"
}

$manifest = Get-Content -LiteralPath $manifestPath -Raw -Encoding UTF8 | ConvertFrom-Json
if (-not $manifest.schemaVersion -or -not ([string]$manifest.schemaVersion).StartsWith('1.')) {
    throw "Unsupported or missing resource schemaVersion: $($manifest.schemaVersion)"
}
if ($manifest.integrityAlgorithm -ne 'SHA-256') {
    throw 'manifest.integrityAlgorithm must be SHA-256.'
}

$ids = @{}
$entries = @($manifest.runtimes) + @($manifest.models)
foreach ($entry in $entries) {
    if (-not $entry.id) { throw 'Every resource entry must have an id.' }
    $key = ([string]$entry.id).ToLowerInvariant()
    if ($ids.ContainsKey($key)) { throw "Duplicate resource id: $($entry.id)" }
    $ids[$key] = $true

    if (-not $entry.bundled) { continue }
    if (-not $entry.localPath) { throw "Bundled resource has no localPath: $($entry.id)" }
    $filePath = Resolve-ChildPath -Root $ResourcesRoot -RelativePath $entry.localPath
    if (-not (Test-Path -LiteralPath $filePath -PathType Leaf)) {
        if ($entry.required) { throw "Required bundled resource is missing: $filePath" }
        Write-Warning "Optional bundled resource is missing: $filePath"
        continue
    }

    $file = Get-Item -LiteralPath $filePath
    $hash = (Get-FileHash -LiteralPath $filePath -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($Check) {
        if ([long]$entry.size -ne [long]$file.Length) {
            throw "Size mismatch for $($entry.id): manifest=$($entry.size), actual=$($file.Length)"
        }
        if ([string]$entry.sha256 -ne $hash) {
            throw "SHA-256 mismatch for $($entry.id): manifest=$($entry.sha256), actual=$hash"
        }
    }
    else {
        $entry.size = [long]$file.Length
        $entry.sha256 = $hash
    }
}

foreach ($license in @($manifest.licenses)) {
    if (-not $license.id -or -not $license.textPath) { throw 'Each license needs id and textPath.' }
    $licensePath = Resolve-ChildPath -Root $ResourcesRoot -RelativePath $license.textPath
    if (-not (Test-Path -LiteralPath $licensePath -PathType Leaf)) {
        throw "License file is missing: $licensePath"
    }
}

if (-not $Check) {
    $manifest.generatedAt = [DateTime]::UtcNow.ToString('o', [Globalization.CultureInfo]::InvariantCulture)
    $json = $manifest | ConvertTo-Json -Depth 12
    [System.IO.File]::WriteAllText($manifestPath, $json + [Environment]::NewLine, (New-Object System.Text.UTF8Encoding($false)))
    Write-Host "Updated resource integrity metadata: $manifestPath"
}
else {
    Write-Host "Resource manifest verified: $manifestPath"
}
