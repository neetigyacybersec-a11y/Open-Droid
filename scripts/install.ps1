# ISSUE-148: PowerShell-only bootstrap. Uses the pinned Node release so a
# clean Windows machine needs no Git Bash, WSL2 or preinstalled Node.
param(
  [string]$Profile = 'core',
  [string]$Capabilities = '',
  [switch]$DryRun,
  [switch]$Yes,
  [Parameter(ValueFromRemainingArguments = $true)] [string[]]$Rest = @()
)
$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $PSScriptRoot
$Pins = @{}
Get-Content (Join-Path $Root 'versions.env') | ForEach-Object {
  if ($_ -match '^\s*([A-Z][A-Z0-9_]*)=(.*)$') { $Pins[$Matches[1]] = $Matches[2].Trim() }
}
$NodeVersion = $Pins['NODE_VERSION']
if (-not $NodeVersion) { throw 'NODE_VERSION missing from versions.env' }

$NodeExe = 'node'
$cmd = Get-Command node -ErrorAction SilentlyContinue
if ($cmd -and [int]((& node --version) -replace '^v' -split '\.')[0] -ge [int]$Pins['NODE_MAJOR']) {
  $NodeExe = $cmd.Source
} else {
  $Install = Join-Path $Root '.toolchain/node'
  $NodeHome = Join-Path $Install "node-v$NodeVersion-win-x64"
  if (-not (Test-Path (Join-Path $NodeHome 'node.exe'))) {
    New-Item -ItemType Directory -Force -Path $Install | Out-Null
    $Zip = Join-Path $Install "node-v$NodeVersion-win-x64.zip"
    Invoke-WebRequest -Uri "https://nodejs.org/dist/v$NodeVersion/node-v$NodeVersion-win-x64.zip" -OutFile $Zip
    $Sha = (Invoke-WebRequest -Uri "https://nodejs.org/dist/v$NodeVersion/SHASUMS256.txt").Content |
      Select-String "node-v$NodeVersion-win-x64.zip" | ForEach-Object { ($_ -split '\s+')[0] }
    $Actual = (Get-FileHash -Algorithm SHA256 $Zip).Hash.ToLowerInvariant()
    if ($Sha -ne $Actual) { Remove-Item $Zip -Force; throw "Node checksum mismatch: $Actual" }
    Expand-Archive -LiteralPath $Zip -DestinationPath $Install -Force
    Remove-Item $Zip -Force
  }
  $NodeExe = Join-Path $NodeHome 'node.exe'
  $env:PATH = "$NodeHome;$env:PATH"
}
$NodeArgs = @((Join-Path $Root 'scripts/install.mjs'), '--profile', $Profile)
if ($Capabilities) { $NodeArgs += @('--capabilities', $Capabilities) }
if ($DryRun) { $NodeArgs += '--dry-run' }
if ($Yes) { $NodeArgs += '--yes' }
$NodeArgs += $Rest
& $NodeExe @NodeArgs
exit $LASTEXITCODE
