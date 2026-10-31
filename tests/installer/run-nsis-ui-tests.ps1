[CmdletBinding()]
param([string]$SetupPath)
$ErrorActionPreference = 'Stop'
$repo = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
if (-not $SetupPath) { $SetupPath = Join-Path $repo 'installer\artifacts\Setup.exe' }
$output = Join-Path $repo 'artifacts\nsis-ui'
New-Item -ItemType Directory -Path $output -Force | Out-Null
$csc = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
$testExe = Join-Path $output 'NsisUiSmoke.exe'
& $csc /nologo /target:exe /platform:x64 "/out:$testExe" /reference:System.dll /reference:System.Core.dll /reference:System.Drawing.dll (Join-Path $PSScriptRoot 'NsisUiSmoke.cs')
if ($LASTEXITCODE -ne 0) { throw 'Native installer UI test compilation failed.' }
& $testExe $SetupPath $output
if ($LASTEXITCODE -ne 0) { throw 'Native installer UI tests failed.' }
