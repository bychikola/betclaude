# BetClaude — AI-Powered Sports Analysis Platform

Платформа для анализа спортивных событий на базе Claude Code CLI с 10 MCP-расширениями.

```
Frontend (React) → WebSocket → API Gateway (Fastify)
                                    ↓
                           Session Orchestrator
                          (Process Pool Manager)
                                    ↓
                    Claude Code CLI × 10 MCP Servers
                         ↓              ↓
                   PostgreSQL      Redis
                   TimescaleDB
```

---

## 🚀 One-Command Deploy (Production)

```bash
git clone <repo-url> && cd betclaude && ./deploy.sh
```

**Всё.** Через 2-3 минуты приложение доступно на `http://localhost`.

### Что делает deploy.sh:
1. Создаёт `.env` с автогенерированными секретами
2. Собирает Docker-образы
3. Запускает все 6 сервисов
4. Инициализирует БД с демо-данными
5. Проверяет здоровье сервисов

### Windows:
```powershell
git clone <repo-url> ; cd betclaude ; .\deploy.ps1
```

### Ручной запуск:
```bash
cp .env.example .env        # отредактируйте .env
docker compose -f docker/docker-compose.prod.yml up -d
```

---

## 🛠 Development

```bash
npm install
docker compose -f docker/docker-compose.yml up -d postgres redis

# Три терминала:
npm run dev:gateway          # → http://localhost:3000
npm run dev:orchestrator     # Process Pool Manager
npm run dev:frontend         # → http://localhost:5173

# Или одной командой:
npm run dev
```

---

## 📦 Архитектура

| Сервис | Технология | Порт |
|---|---|---|
| **Frontend** | React 18 + Tailwind CSS + Vite | 80 / 5173 |
| **API Gateway** | Fastify (Node.js) + WebSocket + JWT | 3000 |
| **Session Orchestrator** | Node.js — Process Pool Manager | — |
| **Analytics Service** | Python FastAPI + gRPC + ML | 8000 |
| **PostgreSQL** | TimescaleDB (time-series) | 5432 |
| **Redis** | Cache + Pub/Sub | 6379 |

### 10 MCP Servers

| Категория | Сервер | Инструменты |
|---|---|---|
| Core | Session Memory | Сохранение/загрузка диалогов, профиль, sandbox FS |
| Core | User Profile | Данные пользователя, предпочтения |
| Data | Live Scores | Live счёт, события, таймлайн (API-Football) |
| Data | Odds Provider | Коэффициенты, лучшие odds, движение линии |
| Data | Stats Provider | xG, владение, удары, сравнение команд |
| Data | News Provider | Новости команд, injury reports, пресс-конференции |
| Data | Weather Provider | Погода на стадионе, анализ влияния |
| Query | Historical DB | H2H, история команд, турнирные таблицы, тренды |
| Analysis | Predictor | ML-прогнозы (Poisson + ELO + XGBoost + Ensemble) |
| Analysis | Pattern Finder | Поиск паттернов, аномалии, streaks |
| Viz | Chart Builder | ASCII-графики, данные для Chart.js/Recharts |

---

## 🔑 API Endpoints

### Auth
```
POST /api/auth/register    POST /api/auth/login
POST /api/auth/refresh     GET  /api/auth/me
POST /api/auth/logout
```

### Sports
```
GET /api/sports            GET /api/sports/:id/leagues
GET /api/leagues/:id/teams  GET /api/matches?status=live
GET /api/matches/:id       GET /api/matches/:id/odds
GET /api/matches/:id/stats GET /api/matches/:id/h2h
```

### Chat (WebSocket)
```
WS /ws/chat?token={jwt}
→ { type: "message", content: "Анализ матча..." }
← { type: "chunk", content: "..." }  // стриминг
← { type: "done" }                   // завершён
```

---

## 🔧 Переменные окружения

Скопируйте `.env.example` → `.env`. Без API-ключей система работает с mock-данными для разработки.

| Переменная | Назначение |
|---|---|
| `JWT_ACCESS_SECRET` | Секрет для access-токенов |
| `JWT_REFRESH_SECRET` | Секрет для refresh-токенов |
| `DB_PASSWORD` | Пароль PostgreSQL |
| `API_FOOTBALL_KEY` | (Опц.) API-Football для live scores |
| `SPORTRADAR_KEY` | (Опц.) Sportradar для продвинутой статистики |
| `PINNACLE_API_KEY` | (Опц.) Pinnacle для реальных коэффициентов |
| `NEWSAPI_KEY` | (Опц.) NewsAPI для новостей |
| `OPENWEATHER_API_KEY` | (Опц.) OpenWeatherMap для погоды |

---

## 📊 Мониторинг

```bash
# Prometheus + Grafana (development)
docker compose -f docker/docker-compose.yml --profile monitoring up -d
# Grafana: http://localhost:3001 (admin/admin)
# Prometheus: http://localhost:9090
# API метрики: http://localhost:3000/api/metrics
```
