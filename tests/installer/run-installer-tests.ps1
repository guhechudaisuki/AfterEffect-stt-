[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$repoRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
$artifactRoot = Join-Path $PSScriptRoot '.artifacts'
$testExe = Join-Path $artifactRoot 'InstallerTests.exe'
$cscCandidates = @(
    (Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'),
    (Join-Path $env:WINDIR 'Microsoft.NET\Framework\v4.0.30319\csc.exe')
)
$csc = $cscCandidates | Where-Object { Test-Path -LiteralPath $_ -PathType Leaf } | Select-Object -First 1
if (-not $csc) { throw 'No .NET Framework C# compiler was found.' }

if (Test-Path -LiteralPath $artifactRoot) {
    $resolved = [System.IO.Path]::GetFullPath($artifactRoot)
    $allowed = [System.IO.Path]::GetFullPath($PSScriptRoot).TrimEnd('\') + '\'
    if (-not $resolved.StartsWith($allowed, [System.StringComparison]::OrdinalIgnoreCase)) { throw 'Unsafe test cleanup was blocked.' }
    Remove-Item -LiteralPath $artifactRoot -Recurse -Force
}
New-Item -ItemType Directory -Path $artifactRoot -Force | Out-Null

$sources = @(
    (Join-Path $repoRoot 'installer\Domain.cs'),
    (Join-Path $repoRoot 'installer\ResourceCatalog.cs'),
    (Join-Path $repoRoot 'installer\HostDetector.cs'),
    (Join-Path $repoRoot 'installer\GpuRuntimeDetector.cs'),
    (Join-Path $repoRoot 'installer\ModelDetector.cs'),
    (Join-Path $repoRoot 'installer\InstallTransaction.cs'),
    (Join-Path $PSScriptRoot 'InstallerTests.cs')
)
$compilerArgs = @(
    '/nologo',
    '/target:exe',
    '/platform:x64',
    "/out:$testExe",
    '/reference:System.dll',
    '/reference:System.Core.dll',
    '/reference:System.IO.Compression.dll',
    '/reference:System.IO.Compression.FileSystem.dll',
    '/reference:System.Web.Extensions.dll'
) + $sources

& $csc @compilerArgs
if ($LASTEXITCODE -ne 0) { throw "Installer test compilation failed with exit code $LASTEXITCODE." }
& $testExe (Join-Path $repoRoot 'resources')
if ($LASTEXITCODE -ne 0) { throw "Installer tests failed with exit code $LASTEXITCODE." }
Remove-Item -LiteralPath $artifactRoot -Recurse -Force
