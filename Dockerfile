# ============================================================
# BetClaude — Multi-stage Dockerfile
#
# Builds all Node.js services from the monorepo root.
# Each service is a separate stage, selected via --target.
#
#   docker build --target api-gateway -t betclaude-api .
#   docker build --target orchestrator -t betclaude-orch .
#   docker build --target frontend -t betclaude-frontend .
# ============================================================

# ============================================================
# Stage 0: Shared build — compile all TypeScript
# ============================================================
FROM node:20-alpine AS builder
WORKDIR /app

# Copy workspace config
COPY package.json package-lock.json tsconfig.json tsconfig.base.json ./

# Copy all packages
COPY packages/shared/package.json        packages/shared/
COPY packages/api-gateway/package.json   packages/api-gateway/
COPY packages/session-orchestrator/package.json packages/session-orchestrator/
COPY packages/frontend/package.json      packages/frontend/

# Copy MCP server package.json files
COPY packages/mcp-servers/session-memory/package.json packages/mcp-servers/session-memory/
COPY packages/mcp-servers/live-scores/package.json   packages/mcp-servers/live-scores/
COPY packages/mcp-servers/odds-provider/package.json  packages/mcp-servers/odds-provider/
COPY packages/mcp-servers/stats-provider/package.json  packages/mcp-servers/stats-provider/
COPY packages/mcp-servers/historical-db/package.json   packages/mcp-servers/historical-db/
COPY packages/mcp-servers/news-provider/package.json   packages/mcp-servers/news-provider/
COPY packages/mcp-servers/predictor/package.json       packages/mcp-servers/predictor/
COPY packages/mcp-servers/pattern-finder/package.json  packages/mcp-servers/pattern-finder/
COPY packages/mcp-servers/chart-builder/package.json   packages/mcp-servers/chart-builder/
COPY packages/mcp-servers/weather/package.json         packages/mcp-servers/weather/

# Install all dependencies
RUN npm install --ignore-scripts

# Copy all source code
COPY packages/shared/src          packages/shared/src/
COPY packages/api-gateway/src     packages/api-gateway/src/
COPY packages/session-orchestrator/src packages/session-orchestrator/src/
COPY packages/mcp-servers/session-memory/src packages/mcp-servers/session-memory/src/
COPY packages/mcp-servers/live-scores/src   packages/mcp-servers/live-scores/src/
COPY packages/mcp-servers/odds-provider/src  packages/mcp-servers/odds-provider/src/
COPY packages/mcp-servers/stats-provider/src  packages/mcp-servers/stats-provider/src/
COPY packages/mcp-servers/historical-db/src   packages/mcp-servers/historical-db/src/
COPY packages/mcp-servers/news-provider/src   packages/mcp-servers/news-provider/src/
COPY packages/mcp-servers/predictor/src       packages/mcp-servers/predictor/src/
COPY packages/mcp-servers/pattern-finder/src  packages/mcp-servers/pattern-finder/src/
COPY packages/mcp-servers/chart-builder/src   packages/mcp-servers/chart-builder/src/
COPY packages/mcp-servers/weather/src         packages/mcp-servers/weather/src/

# Also need tsconfig files in each package for project references
COPY packages/shared/tsconfig.json                    packages/shared/
COPY packages/api-gateway/tsconfig.json                packages/api-gateway/
COPY packages/session-orchestrator/tsconfig.json       packages/session-orchestrator/
COPY packages/mcp-servers/session-memory/tsconfig.json packages/mcp-servers/session-memory/
COPY packages/mcp-servers/live-scores/tsconfig.json    packages/mcp-servers/live-scores/
COPY packages/mcp-servers/odds-provider/tsconfig.json  packages/mcp-servers/odds-provider/
COPY packages/mcp-servers/stats-provider/tsconfig.json packages/mcp-servers/stats-provider/
COPY packages/mcp-servers/historical-db/tsconfig.json  packages/mcp-servers/historical-db/
COPY packages/mcp-servers/news-provider/tsconfig.json  packages/mcp-servers/news-provider/

# Build TypeScript
RUN npx tsc -b

# ============================================================
# Stage 1: API Gateway
# ============================================================
FROM node:20-alpine AS api-gateway
WORKDIR /app

COPY --from=builder /app/node_modules                          ./node_modules
COPY --from=builder /app/packages/shared/package.json          ./packages/shared/
COPY --from=builder /app/packages/shared/dist                  ./packages/shared/dist
COPY --from=builder /app/packages/api-gateway/package.json     ./packages/api-gateway/
COPY --from=builder /app/packages/api-gateway/dist             ./packages/api-gateway/dist

ENV NODE_ENV=production
EXPOSE 3000
CMD ["node", "packages/api-gateway/dist/index.js"]

# ============================================================
# Stage 2: Session Orchestrator
# ============================================================
FROM node:20-alpine AS orchestrator
WORKDIR /app

COPY --from=builder /app/node_modules                                ./node_modules
COPY --from=builder /app/packages/shared/package.json                ./packages/shared/
COPY --from=builder /app/packages/shared/dist                        ./packages/shared/dist
COPY --from=builder /app/packages/session-orchestrator/package.json  ./packages/session-orchestrator/
COPY --from=builder /app/packages/session-orchestrator/dist          ./packages/session-orchestrator/dist

# Copy MCP servers used at runtime (launched as child processes)
COPY --from=builder /app/packages/mcp-servers/session-memory/package.json ./packages/mcp-servers/session-memory/
COPY --from=builder /app/packages/mcp-servers/session-memory/dist         ./packages/mcp-servers/session-memory/dist
COPY --from=builder /app/packages/mcp-servers/live-scores/package.json   ./packages/mcp-servers/live-scores/
COPY --from=builder /app/packages/mcp-servers/live-scores/dist           ./packages/mcp-servers/live-scores/dist
COPY --from=builder /app/packages/mcp-servers/odds-provider/package.json  ./packages/mcp-servers/odds-provider/
COPY --from=builder /app/packages/mcp-servers/odds-provider/dist          ./packages/mcp-servers/odds-provider/dist
COPY --from=builder /app/packages/mcp-servers/stats-provider/package.json ./packages/mcp-servers/stats-provider/
COPY --from=builder /app/packages/mcp-servers/stats-provider/dist         ./packages/mcp-servers/stats-provider/dist
COPY --from=builder /app/packages/mcp-servers/historical-db/package.json  ./packages/mcp-servers/historical-db/
COPY --from=builder /app/packages/mcp-servers/historical-db/dist          ./packages/mcp-servers/historical-db/dist
COPY --from=builder /app/packages/mcp-servers/news-provider/package.json  ./packages/mcp-servers/news-provider/
COPY --from=builder /app/packages/mcp-servers/news-provider/dist          ./packages/mcp-servers/news-provider/dist
COPY --from=builder /app/packages/mcp-servers/predictor/package.json      ./packages/mcp-servers/predictor/
COPY --from=builder /app/packages/mcp-servers/predictor/dist              ./packages/mcp-servers/predictor/dist
COPY --from=builder /app/packages/mcp-servers/pattern-finder/package.json ./packages/mcp-servers/pattern-finder/
COPY --from=builder /app/packages/mcp-servers/pattern-finder/dist         ./packages/mcp-servers/pattern-finder/dist
COPY --from=builder /app/packages/mcp-servers/chart-builder/package.json  ./packages/mcp-servers/chart-builder/
COPY --from=builder /app/packages/mcp-servers/chart-builder/dist          ./packages/mcp-servers/chart-builder/dist
COPY --from=builder /app/packages/mcp-servers/weather/package.json        ./packages/mcp-servers/weather/
COPY --from=builder /app/packages/mcp-servers/weather/dist                ./packages/mcp-servers/weather/dist

ENV NODE_ENV=production
CMD ["node", "packages/session-orchestrator/dist/index.js"]

# ============================================================
# Stage 3: Frontend (build)
# ============================================================
FROM node:20-alpine AS frontend-build
WORKDIR /app

# Copy entire node_modules from builder (has vite, react, tailwind, etc.)
COPY --from=builder /app/node_modules ./node_modules

# Copy frontend source and config files
COPY packages/frontend/index.html           packages/frontend/
COPY packages/frontend/package.json         packages/frontend/
COPY packages/frontend/vite.config.ts       packages/frontend/
COPY packages/frontend/tsconfig.json        packages/frontend/
COPY packages/frontend/tailwind.config.js   packages/frontend/
COPY packages/frontend/postcss.config.js    packages/frontend/
COPY packages/frontend/public/              packages/frontend/public/
COPY packages/frontend/src/                 packages/frontend/src/

# Build the React app
WORKDIR /app/packages/frontend
RUN npx vite build --outDir dist

# ============================================================
# Stage 4: Frontend (serve)
# ============================================================
FROM nginx:alpine AS frontend
COPY --from=frontend-build /app/packages/frontend/dist /usr/share/nginx/html
COPY packages/frontend/nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 80
CMD ["nginx", "-g", "daemon off;"]
