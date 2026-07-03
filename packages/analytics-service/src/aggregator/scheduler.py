"""
Background scheduler for data aggregation tasks.

Runs periodic jobs:
- Match data collection (every 5 min for live, hourly for scheduled)
- Odds scraping (every 30 seconds for live matches)
- Stats aggregation (hourly)
- ELO rating updates (daily)
- Cleanup old data (daily)
"""

import asyncio
import os
import time
from datetime import datetime, timezone

import asyncpg
from apscheduler.schedulers.asyncio import AsyncIOScheduler
from apscheduler.triggers.interval import IntervalTrigger
from apscheduler.triggers.cron import CronTrigger
from loguru import logger

from .collectors import (
    collect_live_matches,
    collect_match_stats,
    collect_odds,
    update_elo_ratings,
    cleanup_old_data,
)


class AggregatorScheduler:
    """Manages periodic data aggregation tasks."""

    def __init__(self):
        self.scheduler = AsyncIOScheduler()
        self.db_pool: asyncpg.Pool | None = None
        self._tasks_status: dict[str, dict] = {}

    async def start(self):
        """Start the scheduler with all periodic jobs."""
        self.db_pool = await asyncpg.create_pool(
            host=os.getenv("DB_HOST", "localhost"),
            port=int(os.getenv("DB_PORT", "5432")),
            database=os.getenv("DB_NAME", "betclaude"),
            user=os.getenv("DB_USER", "betclaude"),
            password=os.getenv("DB_PASSWORD", "betclaude_dev"),
            min_size=2,
            max_size=5,
        )

        # Live data: frequent updates
        self.scheduler.add_job(
            self._wrap("collect_live_matches", collect_live_matches),
            IntervalTrigger(seconds=30),
            id="collect_live_scores",
            name="Collect live scores",
        )
        self.scheduler.add_job(
            self._wrap("collect_odds", collect_odds),
            IntervalTrigger(seconds=30),
            id="collect_odds",
            name="Collect live odds",
        )

        # Match stats: moderate frequency
        self.scheduler.add_job(
            self._wrap("collect_match_stats", collect_match_stats),
            IntervalTrigger(minutes=5),
            id="collect_match_stats",
            name="Collect match stats",
        )

        # Historical data: hourly
        self.scheduler.add_job(
            self._wrap("collect_scheduled_matches", self._collect_scheduled),
            IntervalTrigger(hours=1),
            id="collect_scheduled",
            name="Collect scheduled matches",
        )

        # ELO ratings: daily
        self.scheduler.add_job(
            self._wrap("update_elo", update_elo_ratings),
            CronTrigger(hour=3, minute=0),
            id="update_elo",
            name="Update ELO ratings",
        )

        # Cleanup: daily
        self.scheduler.add_job(
            self._wrap("cleanup", cleanup_old_data),
            CronTrigger(hour=4, minute=0),
            id="cleanup",
            name="Cleanup old data",
        )

        self.scheduler.start()
        logger.info("Aggregator scheduler started with {} jobs",
                     len(self.scheduler.get_jobs()))

    async def stop(self):
        """Stop the scheduler and close connections."""
        self.scheduler.shutdown(wait=False)
        if self.db_pool:
            await self.db_pool.close()
        logger.info("Aggregator scheduler stopped")

    async def trigger(self, task_name: str):
        """Manually trigger a task by name."""
        job = self.scheduler.get_job(task_name)
        if not job:
            # Try by ID
            for j in self.scheduler.get_jobs():
                if j.name == task_name:
                    job = j
                    break
        if not job:
            raise ValueError(f"Task not found: {task_name}")

        logger.info(f"Manually triggering: {task_name}")
        await job.func()

    def get_status(self) -> dict:
        """Get status of all scheduled jobs."""
        jobs = []
        for job in self.scheduler.get_jobs():
            jobs.append({
                "id": job.id,
                "name": job.name,
                "next_run": str(job.next_run_time) if job.next_run_time else None,
                "trigger": str(job.trigger),
            })
        return {
            "running": self.scheduler.running,
            "jobs": jobs,
            "tasks_status": self._tasks_status,
        }

    async def store_match(self, normalized: dict) -> int:
        """Store normalized match data in database."""
        if not self.db_pool:
            raise RuntimeError("Database pool not initialized")

        async with self.db_pool.acquire() as conn:
            result = await conn.execute(
                """INSERT INTO matches (id, sport_id, league_id,
                   home_team_id, away_team_id, start_time, status,
                   home_score, away_score, minute, venue, external_id, metadata)
                   VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
                   ON CONFLICT (id) DO UPDATE SET
                     status = EXCLUDED.status,
                     home_score = EXCLUDED.home_score,
                     away_score = EXCLUDED.away_score,
                     minute = EXCLUDED.minute,
                     updated_at = NOW()""",
                normalized["id"],
                normalized.get("sport_id"),
                normalized.get("league_id"),
                normalized.get("home_team_id"),
                normalized.get("away_team_id"),
                normalized.get("start_time"),
                normalized.get("status", "scheduled"),
                normalized.get("home_score"),
                normalized.get("away_score"),
                normalized.get("minute"),
                normalized.get("venue"),
                normalized.get("external_id"),
                normalized.get("metadata"),
            )
        return 1

    async def store_odds(self, normalized: dict) -> int:
        """Store normalized odds data."""
        if not self.db_pool:
            raise RuntimeError("Database pool not initialized")

        async with self.db_pool.acquire() as conn:
            await conn.execute(
                """INSERT INTO live_odds (match_id, provider, market,
                   home_odds, draw_odds, away_odds)
                   VALUES ($1, $2, $3, $4, $5, $6)""",
                normalized["match_id"],
                normalized["provider"],
                normalized["market"],
                normalized["home_odds"],
                normalized.get("draw_odds"),
                normalized["away_odds"],
            )
        return 1

    async def _collect_scheduled(self):
        """Hourly: fetch upcoming matches for next 7 days."""
        logger.info("Collecting scheduled matches")
        # In production, this calls external APIs
        pass

    def _wrap(self, task_id: str, coro_func):
        """Wrap a coroutine for the scheduler, tracking status."""
        async def wrapper():
            start = time.monotonic()
            self._tasks_status[task_id] = {
                "last_run": datetime.now(timezone.utc).isoformat(),
                "status": "running",
            }
            try:
                await coro_func(self.db_pool)
                elapsed = time.monotonic() - start
                self._tasks_status[task_id] = {
                    "last_run": datetime.now(timezone.utc).isoformat(),
                    "status": "success",
                    "duration_seconds": round(elapsed, 2),
                }
                logger.info(f"Task {task_id} completed in {elapsed:.2f}s")
            except Exception as e:
                self._tasks_status[task_id] = {
                    "last_run": datetime.now(timezone.utc).isoformat(),
                    "status": "error",
                    "error": str(e),
                }
                logger.error(f"Task {task_id} failed: {e}")

        return wrapper
