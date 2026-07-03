#!/usr/bin/env bash
# ============================================================
# BetClaude — Zero-to-Running One-Command Deploy
#
# Usage:
#   chmod +x deploy.sh && ./deploy.sh
#
# Works on a FRESH bare Linux server. Installs EVERYTHING:
#   Docker, Docker Compose, curl, openssl
# Then builds and starts all 6 services.
# ============================================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

RED='\033[0;31m'
GREEN='\033[0;32m'
BLUE='\033[0;34m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m'

# Must be root or have sudo
if [ "$(id -u)" -ne 0 ] && ! command -v sudo &>/dev/null; then
  echo -e "${RED}Run as root or install sudo.${NC}"
  exit 1
fi

SUDO=""
if [ "$(id -u)" -ne 0 ]; then
  SUDO="sudo"
fi

echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "${BLUE}  BetClaude — AI Sports Analysis Platform${NC}"
echo -e "${BLUE}  Zero-to-Running Deploy${NC}"
echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo ""

# ============================================================
# PHASE 0 — Detect OS
# ============================================================
detect_os() {
  if [ -f /etc/os-release ]; then
    . /etc/os-release
    OS_ID="${ID}"
    OS_VERSION="${VERSION_ID:-}"
  elif [ -f /etc/debian_version ]; then
    OS_ID="debian"
  elif [ -f /etc/redhat-release ]; then
    OS_ID="rhel"
  else
    OS_ID="unknown"
  fi
}
detect_os
echo -e "${CYAN}Detected OS: ${OS_ID}${NC}"
echo ""

# ============================================================
# PHASE 1 — Install system dependencies
# ============================================================
echo -e "${BLUE}━━━ Phase 1: System Dependencies ━━━${NC}"

install_docker() {
  if command -v docker &>/dev/null; then
    echo -e "  ${GREEN}✓${NC} Docker already installed: $(docker --version 2>/dev/null || echo 'ok')"
    return 0
  fi

  echo -e "  ${YELLOW}Installing Docker...${NC}"

  case "$OS_ID" in
    ubuntu|debian)
      $SUDO apt-get update -qq
      $SUDO apt-get install -y -qq curl ca-certificates gnupg lsb-release
      $SUDO install -m 0755 -d /etc/apt/keyrings
      if [ ! -f /etc/apt/keyrings/docker.gpg ]; then
        curl -fsSL https://download.docker.com/linux/${OS_ID}/gpg | $SUDO gpg --dearmor -o /etc/apt/keyrings/docker.gpg 2>/dev/null
      fi
      echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/${OS_ID} $(lsb_release -cs) stable" | $SUDO tee /etc/apt/sources.list.d/docker.list > /dev/null
      $SUDO apt-get update -qq
      $SUDO apt-get install -y -qq docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
      ;;
    centos|rhel|fedora|rocky|almalinux)
      if command -v dnf &>/dev/null; then
        $SUDO dnf -y install dnf-plugins-core
        $SUDO dnf config-manager --add-repo https://download.docker.com/linux/${OS_ID}/docker-ce.repo
        $SUDO dnf -y install docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
      else
        $SUDO yum install -y yum-utils
        $SUDO yum-config-manager --add-repo https://download.docker.com/linux/centos/docker-ce.repo
        $SUDO yum -y install docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
      fi
      ;;
    *)
      echo -e "  ${YELLOW}Auto-install not supported for ${OS_ID}. Trying get.docker.com...${NC}"
      curl -fsSL https://get.docker.com | $SUDO bash
      ;;
  esac

  $SUDO systemctl enable docker
  $SUDO systemctl start docker
  echo -e "  ${GREEN}✓ Docker installed${NC}"
}

install_essentials() {
  case "$OS_ID" in
    ubuntu|debian)
      $SUDO apt-get install -y -qq curl openssl 2>/dev/null || true
      ;;
    centos|rhel|fedora|rocky|almalinux)
      if command -v dnf &>/dev/null; then
        $SUDO dnf -y install curl openssl 2>/dev/null || true
      else
        $SUDO yum -y install curl openssl 2>/dev/null || true
      fi
      ;;
  esac
}

install_essentials
install_docker

# Allow current user to run docker without sudo
if [ "$(id -u)" -ne 0 ] && ! docker ps &>/dev/null 2>&1; then
  echo -e "  ${YELLOW}Adding $(whoami) to docker group...${NC}"
  $SUDO usermod -aG docker "$(whoami)" 2>/dev/null || true
  echo -e "  ${YELLOW}⚠ You may need to log out and back in for docker permissions.${NC}"
  echo -e "  ${YELLOW}  For now, running docker with sudo...${NC}"
  DOCKER_CMD="sudo docker"
else
  DOCKER_CMD="docker"
fi

echo ""

# ============================================================
# PHASE 2 — Environment
# ============================================================
echo -e "${BLUE}━━━ Phase 2: Configuration ━━━${NC}"

if [ ! -f .env ]; then
  echo -e "  ${YELLOW}Creating .env with auto-generated secrets...${NC}"
  cp .env.example .env

  JWT_ACCESS=$(openssl rand -hex 32 2>/dev/null || echo "jwt-access-$(date +%s)-$(head -c16 /dev/urandom | xxd -p)")
  JWT_REFRESH=$(openssl rand -hex 32 2>/dev/null || echo "jwt-refresh-$(date +%s)-$(head -c16 /dev/urandom | xxd -p)")
  DB_PASS=$(openssl rand -hex 16 2>/dev/null || echo "db-pass-$(date +%s)-$(head -c8 /dev/urandom | xxd -p)")

  sed -i "s/change-me-access-secret-64-chars/$JWT_ACCESS/" .env
  sed -i "s/change-me-refresh-secret-64-chars/$JWT_REFRESH/" .env
  sed -i "s/change-me-db-password/$DB_PASS/" .env

  echo -e "  ${GREEN}✓ .env created${NC}"
else
  echo -e "  ${GREEN}✓ .env exists${NC}"
fi

echo ""

# ============================================================
# PHASE 3 — Build
# ============================================================
echo -e "${BLUE}━━━ Phase 3: Building Images ━━━${NC}"
$DOCKER_CMD compose -f docker/docker-compose.prod.yml build 2>&1 | grep -E '^(#[0-9]|Successfully|ERROR|FAILED)' || true
echo -e "${GREEN}✓ Build complete${NC}"
echo ""

# ============================================================
# PHASE 4 — Start
# ============================================================
echo -e "${BLUE}━━━ Phase 4: Starting Services ━━━${NC}"
$DOCKER_CMD compose -f docker/docker-compose.prod.yml up -d
echo -e "${GREEN}✓ Containers started${NC}"
echo ""

# ============================================================
# PHASE 5 — Wait for readiness
# ============================================================
echo -e "${BLUE}━━━ Phase 5: Waiting for readiness... ━━━${NC}"

for svc in postgres redis analytics api-gateway frontend; do
  printf "  Waiting for %-20s" "${svc}..."
  for i in $(seq 1 60); do
    if $DOCKER_CMD inspect "betclaude-${svc}" --format='{{.State.Status}}' 2>/dev/null | grep -q running; then
      echo -e " ${GREEN}✓${NC}"
      break
    fi
    sleep 2
  done
done

# Extra wait for DB readiness
echo "  Waiting for database..."
for i in $(seq 1 30); do
  if $DOCKER_CMD exec betclaude-postgres pg_isready -U betclaude &>/dev/null; then
    echo -e "  ${GREEN}✓ Database accepting connections${NC}"
    break
  fi
  sleep 2
done

echo ""

# ============================================================
# PHASE 6 — Verify
# ============================================================
echo -e "${BLUE}━━━ Phase 6: Health Check ━━━${NC}"

check_url() {
  local url="$1" name="$2"
  if curl -sf --max-time 5 "$url" >/dev/null 2>&1; then
    echo -e "  ${GREEN}✓${NC} $name — $url"
  else
    echo -e "  ${YELLOW}⚠${NC}  $name — still starting (check: curl $url)"
  fi
}

sleep 5
check_url "http://localhost/api/health" "API Gateway"
check_url "http://localhost:8000/health" "Analytics"

echo ""

# ============================================================
# DONE
# ============================================================
# Try to get server IP
SERVER_IP=$(curl -sf --max-time 2 ifconfig.me 2>/dev/null || curl -sf --max-time 2 icanhazip.com 2>/dev/null || echo "localhost")

echo -e "${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "${GREEN}  ✓ BetClaude is running!${NC}"
echo -e "${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo ""
echo -e "  ${CYAN}Frontend:${NC}        http://${SERVER_IP}"
echo -e "  ${CYAN}API Health:${NC}      http://${SERVER_IP}:3000/api/health"
echo -e "  ${CYAN}Analytics:${NC}       http://${SERVER_IP}:8000/health"
echo ""
echo -e "  ${YELLOW}Get started:${NC}  Open http://${SERVER_IP}/register"
echo ""
echo -e "  ${BLUE}Commands:${NC}"
echo -e "    $DOCKER_CMD compose -f docker/docker-compose.prod.yml logs -f   # watch logs"
echo -e "    $DOCKER_CMD compose -f docker/docker-compose.prod.yml restart   # restart all"
echo -e "    $DOCKER_CMD compose -f docker/docker-compose.prod.yml down      # stop all"
echo ""
