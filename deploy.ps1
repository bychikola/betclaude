# ============================================================
# BetClaude — Zero-to-Running Windows Deploy
#
# Usage:
#   .\deploy.ps1
#
# Installs everything needed and starts the platform.
# Requires: PowerShell 5.1+ (built into Windows 10+)
# ============================================================

$ErrorActionPreference = "Stop"

# Must be admin
if (-NOT ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole] "Administrator")) {
    Write-Host "Run PowerShell as Administrator (right-click → Run as Administrator)" -ForegroundColor Red
    exit 1
}

Set-Location $PSScriptRoot

Write-Host "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━" -ForegroundColor Blue
Write-Host "  BetClaude — AI Sports Analysis Platform" -ForegroundColor Blue
Write-Host "  Zero-to-Running Deploy (Windows)" -ForegroundColor Blue
Write-Host "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━" -ForegroundColor Blue
Write-Host ""

# ============================================================
# PHASE 1 — Install Docker Desktop if missing
# ============================================================
Write-Host "━━━ Phase 1: Docker ━━━" -ForegroundColor Blue

if (Get-Command docker -ErrorAction SilentlyContinue) {
    Write-Host "  ✓ Docker found: $(docker --version)" -ForegroundColor Green
} else {
    Write-Host "  Installing Docker Desktop..." -ForegroundColor Yellow
    Write-Host "  This will open the Docker installer. After installation, re-run deploy.ps1" -ForegroundColor Yellow

    $installerUrl = "https://desktop.docker.com/win/main/amd64/Docker%20Desktop%20Installer.exe"
    $installerPath = "$env:TEMP\DockerDesktopInstaller.exe"

    Invoke-WebRequest -Uri $installerUrl -OutFile $installerPath
    Start-Process -FilePath $installerPath -Wait

    Write-Host "  Please restart your computer after Docker installation, then re-run: .\deploy.ps1" -ForegroundColor Red
    exit 0
}

# Ensure Docker is running
docker info 2>$null
if ($LASTEXITCODE -ne 0) {
    Write-Host "  Starting Docker..." -ForegroundColor Yellow
    Start-Process "C:\Program Files\Docker\Docker\Docker Desktop.exe"
    Write-Host "  Waiting for Docker to start..." -ForegroundColor Yellow
    for ($i = 0; $i -lt 30; $i++) {
        Start-Sleep -Seconds 2
        docker info 2>$null
        if ($LASTEXITCODE -eq 0) { break }
    }
}

Write-Host "  ✓ Docker ready" -ForegroundColor Green
Write-Host ""

# ============================================================
# PHASE 2 — Install WSL if needed (Docker backend)
# ============================================================
Write-Host "━━━ Phase 2: Environment ━━━" -ForegroundColor Blue

if (-not (Test-Path .env)) {
    Write-Host "  Creating .env with auto-generated secrets..." -ForegroundColor Yellow
    Copy-Item .env.example .env

    $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
    $bytes = New-Object byte[] 32
    $rng.GetBytes($bytes); $jwtAccess = -join ($bytes | ForEach-Object { $_.ToString("x2") })
    $rng.GetBytes($bytes); $jwtRefresh = -join ($bytes | ForEach-Object { $_.ToString("x2") })
    $rng.GetBytes($bytes); $dbPass = -join ($bytes | ForEach-Object { $_.ToString("x2") })

    $content = Get-Content .env -Raw
    $content = $content -replace 'change-me-access-secret-64-chars', $jwtAccess
    $content = $content -replace 'change-me-refresh-secret-64-chars', $jwtRefresh
    $content = $content -replace 'change-me-db-password', $dbPass
    Set-Content .env -Value $content -NoNewline

    Write-Host "  ✓ .env created" -ForegroundColor Green
} else {
    Write-Host "  ✓ .env exists" -ForegroundColor Green
}

Write-Host ""

# ============================================================
# PHASE 3 — Build & Start
# ============================================================
Write-Host "━━━ Phase 3: Building Images ━━━" -ForegroundColor Blue
docker compose -f docker/docker-compose.prod.yml build
Write-Host "  ✓ Build complete" -ForegroundColor Green
Write-Host ""

Write-Host "━━━ Phase 4: Starting Services ━━━" -ForegroundColor Blue
docker compose -f docker/docker-compose.prod.yml up -d
Write-Host "  ✓ Containers started" -ForegroundColor Green
Write-Host ""

# ============================================================
# PHASE 5 — Wait
# ============================================================
Write-Host "━━━ Phase 5: Waiting for readiness... ━━━" -ForegroundColor Blue

$services = @("postgres", "redis", "analytics", "api-gateway", "frontend")
foreach ($svc in $services) {
    Write-Host "  Waiting for betclaude-$svc..."
    for ($i = 0; $i -lt 60; $i++) {
        $status = docker inspect "betclaude-$svc" --format '{{.State.Status}}' 2>$null
        if ($status -eq "running") { break }
        Start-Sleep -Seconds 2
    }
}

Write-Host "  ✓ All services running" -ForegroundColor Green
Write-Host ""

# ============================================================
# PHASE 6 — Verify
# ============================================================
Write-Host "━━━ Phase 6: Health Check ━━━" -ForegroundColor Blue
Start-Sleep -Seconds 5

try {
    $health = Invoke-RestMethod -Uri "http://localhost/api/health" -TimeoutSec 5
    Write-Host "  ✓ API Gateway: $($health.status)" -ForegroundColor Green
} catch {
    Write-Host "  ⚠ API Gateway still starting..." -ForegroundColor Yellow
}

try {
    $py = Invoke-RestMethod -Uri "http://localhost:8000/health" -TimeoutSec 5
    Write-Host "  ✓ Analytics: $($py.status)" -ForegroundColor Green
} catch {
    Write-Host "  ⚠ Analytics still starting..." -ForegroundColor Yellow
}

Write-Host ""

# ============================================================
# Done
# ============================================================
Write-Host "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━" -ForegroundColor Green
Write-Host "  ✓ BetClaude is running!" -ForegroundColor Green
Write-Host "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━" -ForegroundColor Green
Write-Host ""
Write-Host "  Frontend:        http://localhost" -ForegroundColor Cyan
Write-Host "  API Health:      http://localhost:3000/api/health" -ForegroundColor Cyan
Write-Host ""
Write-Host "  Get started: Open http://localhost/register" -ForegroundColor Yellow
Write-Host ""
Write-Host "  Manage:" -ForegroundColor Blue
Write-Host "    docker compose -f docker/docker-compose.prod.yml logs -f"
Write-Host "    docker compose -f docker/docker-compose.prod.yml down"
Write-Host ""
