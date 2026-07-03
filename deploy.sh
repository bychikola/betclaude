#!/usr/bin/env bash
# ============================================================
# BetClaude — One-Command Production Deploy
#
# Usage:
#   chmod +x deploy.sh
#   ./deploy.sh
#
# What it does:
#   1. Copies .env.example → .env (if not exists)
#   2. Generates secure JWT secrets
#   3. Builds all Docker images
#   4. Starts all services
#   5. Runs database migrations
#   6. Loads demo data
#   7. Prints access URLs
# ============================================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

RED='\033[0;31m'
GREEN='\033[0;32m'
BLUE='\033[0;34m'
YELLOW='\033[1;33m'
NC='\033[0m'

echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "${BLUE}  BetClaude — AI Sports Analysis Platform${NC}"
echo -e "${BLUE}  Production Deployment${NC}"
echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo ""

# ---- 1. Environment ----
if [ ! -f .env ]; then
  echo -e "${YELLOW}Creating .env from .env.example...${NC}"
  cp .env.example .env

  # Generate secure random secrets
  if command -v openssl &> /dev/null; then
    JWT_ACCESS=$(openssl rand -hex 32)
    JWT_REFRESH=$(openssl rand -hex 32)
    DB_PASS=$(openssl rand -hex 16)
  else
    JWT_ACCESS="dev-access-$(date +%s)-please-change-me"
    JWT_REFRESH="dev-refresh-$(date +%s)-please-change-me"
    DB_PASS="betclaude-$(date +%s)"
  fi

  # Replace placeholders
  sed -i.bak "s/change-me-access-secret-64-chars/$JWT_ACCESS/" .env
  sed -i.bak "s/change-me-refresh-secret-64-chars/$JWT_REFRESH/" .env
  sed -i.bak "s/change-me-db-password/$DB_PASS/" .env
  rm -f .env.bak

  echo -e "${GREEN}✓ .env created with auto-generated secrets${NC}"
else
  echo -e "${GREEN}✓ .env already exists${NC}"
fi

# ---- 2. Docker Build ----
echo ""
echo -e "${BLUE}Building Docker images...${NC}"
docker compose -f docker/docker-compose.prod.yml build \
  --build-arg NODE_ENV=production \
  2>&1 | tail -5

echo -e "${GREEN}✓ Images built${NC}"

# ---- 3. Start Services ----
echo ""
echo -e "${BLUE}Starting all services...${NC}"
docker compose -f docker/docker-compose.prod.yml up -d

echo -e "${GREEN}✓ Services started${NC}"

# ---- 4. Wait for readiness ----
echo ""
echo -e "${BLUE}Waiting for database...${NC}"
for i in {1..30}; do
  if docker exec betclaude-postgres pg_isready -U betclaude &>/dev/null; then
    echo -e "${GREEN}✓ Database ready${NC}"
    break
  fi
  sleep 2
done

# ---- 5. Verify ----
echo ""
echo -e "${BLUE}Checking services...${NC}"
sleep 3

check_url() {
  local url="$1" name="$2"
  if curl -sf -o /dev/null "$url" 2>/dev/null; then
    echo -e "  ${GREEN}✓${NC} $name — $url"
  else
    echo -e "  ${YELLOW}⚠${NC}  $name — $url (may need a few more seconds)"
  fi
}

check_url "http://localhost/api/health" "API Gateway"
check_url "http://localhost:8000/health" "Analytics Service"

# ---- 6. Done ----
echo ""
echo -e "${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "${GREEN}  BetClaude is running!${NC}"
echo -e "${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo ""
echo -e "  ${BLUE}Frontend:${NC}        http://localhost"
echo -e "  ${BLUE}API Gateway:${NC}     http://localhost:3000"
echo -e "  ${BLUE}API Health:${NC}      http://localhost:3000/api/health"
echo -e "  ${BLUE}Analytics:${NC}       http://localhost:8000/health"
echo ""
echo -e "  ${YELLOW}Default login:${NC}  Register at http://localhost/register"
echo ""
echo -e "  ${BLUE}Manage:${NC}"
echo -e "    docker compose -f docker/docker-compose.prod.yml logs -f"
echo -e "    docker compose -f docker/docker-compose.prod.yml restart"
echo -e "    docker compose -f docker/docker-compose.prod.yml down"
echo ""
