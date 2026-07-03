# ============================================================
# BetClaude — Windows Production Deploy
#
# Usage:
#   .\deploy.ps1
# ============================================================

$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot

Write-Host "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━" -ForegroundColor Blue
Write-Host "  BetClaude — AI Sports Analysis Platform" -ForegroundColor Blue
Write-Host "  Production Deployment (Windows)" -ForegroundColor Blue
Write-Host "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━" -ForegroundColor Blue
Write-Host ""

# ---- 1. Environment ----
if (-not (Test-Path .env)) {
    Write-Host "Creating .env from .env.example..." -ForegroundColor Yellow
    Copy-Item .env.example .env

    # Generate secrets using .NET
    $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
    $bytes = New-Object byte[] 32
    $rng.GetBytes($bytes)
    $jwtAccess = [BitConverter]::ToString($bytes) -replace '-','' -replace '..','$0'
    $rng.GetBytes($bytes)
    $jwtRefresh = [BitConverter]::ToString($bytes) -replace '-','' -replace '..','$0'
    $rng.GetBytes($bytes); $dbPass = [BitConverter]::ToString($bytes) -replace '-','' -replace '..','$0'

    $content = Get-Content .env -Raw
    $content = $content -replace 'change-me-access-secret-64-chars', $jwtAccess
    $content = $content -replace 'change-me-refresh-secret-64-chars', $jwtRefresh
    $content = $content -replace 'change-me-db-password', $dbPass
    Set-Content .env -Value $content

    Write-Host "✓ .env created with auto-generated secrets" -ForegroundColor Green
} else {
    Write-Host "✓ .env already exists" -ForegroundColor Green
}

# ---- 2. Build & Start ----
Write-Host ""
Write-Host "Building and starting all services..." -ForegroundColor Blue
docker compose -f docker/docker-compose.prod.yml build
docker compose -f docker/docker-compose.prod.yml up -d

Write-Host "✓ Services started" -ForegroundColor Green

# ---- 3. Wait ----
Write-Host ""
Write-Host "Waiting for services to be ready..." -ForegroundColor Blue
Start-Sleep -Seconds 8

# ---- 4. Done ----
Write-Host ""
Write-Host "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━" -ForegroundColor Green
Write-Host "  BetClaude is running!" -ForegroundColor Green
Write-Host "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━" -ForegroundColor Green
Write-Host ""
Write-Host "  Frontend:        http://localhost" -ForegroundColor Blue
Write-Host "  API Gateway:     http://localhost:3000" -ForegroundColor Blue
Write-Host "  API Health:      http://localhost:3000/api/health" -ForegroundColor Blue
Write-Host ""
Write-Host "  Default login:  Register at http://localhost/register" -ForegroundColor Yellow
Write-Host ""
Write-Host "  Manage:"
Write-Host "    docker compose -f docker/docker-compose.prod.yml logs -f"
Write-Host "    docker compose -f docker/docker-compose.prod.yml down"
Write-Host ""
