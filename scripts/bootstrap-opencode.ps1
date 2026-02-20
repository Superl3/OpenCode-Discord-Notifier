param(
  [switch]$RunSetup,
  [switch]$SkipNpmInstall,
  [switch]$SkipOpenCodeCheck
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

function Write-Step {
  param([string]$Message)
  Write-Host "`n[bootstrap] $Message"
}

function Test-CommandExists {
  param([string]$Name)
  return $null -ne (Get-Command -Name $Name -ErrorAction SilentlyContinue)
}

function Refresh-ProcessPath {
  $machinePath = [System.Environment]::GetEnvironmentVariable("Path", "Machine")
  $userPath = [System.Environment]::GetEnvironmentVariable("Path", "User")
  $env:Path = "$machinePath;$userPath"
}

function Ensure-NodeAndNpm {
  $hasNode = Test-CommandExists -Name "node"
  $hasNpm = Test-CommandExists -Name "npm"
  if ($hasNode -and $hasNpm) {
    Write-Host "[bootstrap] node/npm already installed"
    return
  }

  Write-Step "node/npm missing; attempting auto-install"

  if (Test-CommandExists -Name "winget") {
    winget install --id OpenJS.NodeJS.LTS --accept-package-agreements --accept-source-agreements --silent
  }
  elseif (Test-CommandExists -Name "choco") {
    choco install nodejs-lts -y
  }
  elseif (Test-CommandExists -Name "scoop") {
    scoop install nodejs-lts
  }
  else {
    throw "No installer found for node/npm. Install winget/choco/scoop and retry."
  }

  Refresh-ProcessPath

  $hasNode = Test-CommandExists -Name "node"
  $hasNpm = Test-CommandExists -Name "npm"
  if ((-not $hasNode) -or (-not $hasNpm)) {
    throw "node/npm still unavailable after install. Restart terminal and retry."
  }
}

$scriptDir = Split-Path -Parent $PSCommandPath
$repoRoot = Resolve-Path (Join-Path $scriptDir "..")
$bootstrapScript = Join-Path $scriptDir "bootstrap-opencode.js"

Ensure-NodeAndNpm

$forwardArgs = @()
if ($RunSetup) {
  $forwardArgs += "--run-setup"
}
if ($SkipNpmInstall) {
  $forwardArgs += "--skip-npm-install"
}
if ($SkipOpenCodeCheck) {
  $forwardArgs += "--skip-opencode-check"
}

Write-Step "running OpenCode bootstrap"

Push-Location $repoRoot
try {
  & node $bootstrapScript @forwardArgs
  if ($LASTEXITCODE -ne 0) {
    throw "bootstrap-opencode.js failed"
  }
}
finally {
  Pop-Location
}
