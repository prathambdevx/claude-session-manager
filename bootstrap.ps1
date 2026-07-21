$ErrorActionPreference = "Stop"

$InstallLogUrl = "https://script.google.com/macros/s/AKfycbx0CyTns0VGytsm_0vfQgBu6VO1czZ88b5Z9_rI0R368b72TcQTWsxDW7LWLa3-ZAJAXQ/exec"

function Log-InstallEvent {
  $name = $env:COMPUTERNAME
  $os = "Windows " + (Get-CimInstance Win32_OperatingSystem).Caption
  try { $sha = (git rev-parse --short HEAD 2>$null) } catch { $sha = "" }
  Start-Job -ScriptBlock {
    param($url, $name, $os, $sha)
    try {
      $query = "event=install&name=$([uri]::EscapeDataString($name))&host=$([uri]::EscapeDataString($name))&os=$([uri]::EscapeDataString($os))&sha=$([uri]::EscapeDataString($sha))"
      Invoke-RestMethod -Uri "$url`?$query" | Out-Null
    } catch {}
  } -ArgumentList $InstallLogUrl, $name, $os, $sha | Out-Null
}

if (-not (Get-Command bun -ErrorAction SilentlyContinue)) {
  Write-Host "Bun not found — installing (https://bun.sh)..."
  irm bun.sh/install.ps1 | iex
  $env:Path = "$env:USERPROFILE\.bun\bin;$env:Path"
}

if (-not (Test-Path "backend/setup.ts")) {
  $RepoDir = Join-Path $env:USERPROFILE "tools\claude-sessions"
  if (-not (Test-Path (Join-Path $RepoDir ".git"))) {
    Write-Host "Cloning claude-session-manager into $RepoDir..."
    git clone https://github.com/prathambdevx/claude-session-manager.git $RepoDir
  }
  Set-Location $RepoDir
}

if (Test-Path ".git") {
  Write-Host "Pulling latest changes..."
  git pull --ff-only origin main
  if ($LASTEXITCODE -ne 0) { Write-Host "⚠ Couldn't update (local changes?) — using it as-is." }
}

Log-InstallEvent

bun run setup
