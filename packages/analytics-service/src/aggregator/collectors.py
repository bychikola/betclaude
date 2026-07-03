"""
Data collectors — fetch data from external APIs and store in database.

Each collector handles a specific data source:
- API-Football: matches, events, stats
- Sportradar: advanced stats, player data
- Pinnacle/Bet365: odds data
"""

import json
import os
from datetime import datetime, timezone

import asyncpg
import httpx
from loguru import logger


# ============================================================
# Live Match Collection
# ============================================================

async def collect_live_matches(pool: asyncpg.Pool | None):
    """Fetch live match scores from API-Football every 30 seconds."""
    if not pool:
        return

    api_key = os.getenv("API_FOOTBALL_KEY", "")
    if not api_key:
        logger.debug("No API_FOOTBALL_KEY set, skipping live matches collection")
        return

    try:
        async with httpx.AsyncClient(timeout=15) as client:
            response = await client.get(
                "https://v3.football.api-sports.io/fixtures?live=all",
                headers={
                    "x-apisports-key": api_key,
                    "Accept": "application/json",
                },
            )
            response.raise_for_status()
            data = response.json()

        fixtures = data.get("response", [])
        if not fixtures:
            return

        async with pool.acquire() as conn:
            for f in fixtures:
                fixture = f.get("fixture", {})
                teams = f.get("teams", {})
                goals = f.get("goals", {})
                league = f.get("league", {})

                await conn.execute(
                    """INSERT INTO match_events
                       (match_id, type, minute, team_id, player_name, detail)
                       VALUES ($1, 'goal', $2,
                         (SELECT id FROM teams WHERE name = $3 LIMIT 1),
                         $4, $5)""",
                    str(fixture.get("id")),
                    fixture.get("status", {}).get("elapsed", 0),
                    teams.get("home", {}).get("name"),
                    "Score update",
                    f"{goals.get('home', 0)}-{goals.get('away', 0)}",
                )

                # Upsert match status
                await conn.execute(
                    """UPDATE matches SET
                       status = CASE
                         WHEN $2 IN ('1H','2H','HT','ET','P') THEN 'live'
                         WHEN $2 = 'FT' THEN 'finished'
                         ELSE 'scheduled'
                       END,
                       home_score = $3,
                       away_score = $4,
                       minute = $5,
                       updated_at = NOW()
                       WHERE external_id = $1""",
                    str(fixture.get("id")),
                    fixture.get("status", {}).get("short", "NS"),
                    goals.get("home", 0),
                    goals.get("away", 0),
                    fixture.get("status", {}).get("elapsed", 0),
                )

        logger.info(f"Collected {len(fixtures)} live matches")
    except Exception as e:
        logger.error(f"Live match collection failed: {e}")


# ============================================================
# Match Stats Collection
# ============================================================

async def collect_match_stats(pool: asyncpg.Pool | None):
    """Fetch detailed match statistics every 5 minutes."""
    if not pool:
        return

    api_key = os.getenv("API_FOOTBALL_KEY", "")
    if not api_key:
        return

    try:
        # Get currently live matches from DB
        async with pool.acquire() as conn:
            live_matches = await conn.fetch(
                "SELECT id, external_id FROM matches WHERE status = 'live'"
            )

        async with httpx.AsyncClient(timeout=15) as client:
            for match in live_matches:
                response = await client.get(
                    f"https://v3.football.api-sports.io/fixtures/statistics?fixture={match['external_id']}",
                    headers={
                        "x-apisports-key": api_key,
                        "Accept": "application/json",
                    },
                )
                if response.status_code != 200:
                    continue

                data = response.json()
                stats_data = data.get("response", [])

                for team_stats in stats_data:
                    team = team_stats.get("team", {})
                    stats_list = team_stats.get("statistics", [])

                    stats_map = {
                        s["type"]: s["value"] for s in stats_list
                    }

                    async with pool.acquire() as conn:
                        await conn.execute(
                            """INSERT INTO match_stats
                               (match_id, team_id, possession, shots, shots_on_target,
                                corners, fouls, yellow_cards, red_cards, offsides,
                                expected_goals, pass_accuracy)
                               VALUES ($1,
                                 (SELECT id FROM teams WHERE name = $2 LIMIT 1),
                                 $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)""",
                            match["id"],
                            team.get("name"),
                            _parse_num(stats_map.get("Ball Possession")),
                            _parse_num(stats_map.get("Total Shots")),
                            _parse_num(stats_map.get("Shots on Goal")),
                            _parse_num(stats_map.get("Corner Kicks")),
                            _parse_num(stats_map.get("Fouls")),
                            _parse_num(stats_map.get("Yellow Cards")),
                            _parse_num(stats_map.get("Red Cards")),
                            _parse_num(stats_map.get("Offsides")),
                            _parse_num(stats_map.get("Expected Goals")),
                            _parse_num(stats_map.get("Passes %")),
                        )

        logger.info(f"Collected stats for {len(live_matches)} matches")
    except Exception as e:
        logger.error(f"Stats collection failed: {e}")


# ============================================================
# Odds Collection
# ============================================================

async def collect_odds(pool: asyncpg.Pool | None):
    """Fetch current odds from Pinnacle every 30 seconds for live matches."""
    if not pool:
        return

    # For dev/demo, generate mock odds
    # In production: call Pinnacle/Bet365 APIs
    try:
        async with pool.acquire() as conn:
            live_matches = await conn.fetch(
                "SELECT id FROM matches WHERE status IN ('live', 'scheduled')"
            )

            for match in live_matches:
                # Generate realistic mock odds
                import random
                home = round(random.uniform(1.5, 4.5), 2)
                draw = round(random.uniform(2.5, 5.0), 2)
                away = round(random.uniform(1.8, 6.0), 2)

                await conn.execute(
                    """INSERT INTO live_odds (match_id, provider, market,
                       home_odds, draw_odds, away_odds)
                       VALUES ($1, 'mock', '1X2', $2, $3, $4)""",
                    match["id"], home, draw, away,
                )

        logger.debug(f"Updated odds for {len(live_matches)} matches")
    except Exception as e:
        logger.error(f"Odds collection failed: {e}")


# ============================================================
# ELO Rating Updates (daily)
# ============================================================

async def update_elo_ratings(pool: asyncpg.Pool | None):
    """Update ELO ratings for all teams based on recent results."""
    if not pool:
        return

    K_FACTOR = 32  # Standard ELO K-factor

    try:
        async with pool.acquire() as conn:
            # Get finished matches since last ELO update
            matches = await conn.fetch(
                """SELECT m.home_team_id, m.away_team_id, m.home_score, m.away_score,
                   ht.name as home_name, at.name as away_name
                   FROM matches m
                   JOIN teams ht ON m.home_team_id = ht.id
                   JOIN teams at ON m.away_team_id = at.id
                   WHERE m.status = 'finished'
                   AND m.updated_at > NOW() - INTERVAL '24 hours'"""
            )

            elo_changes: dict[str, float] = {}

            for m in matches:
                if m["home_score"] is None or m["away_score"] is None:
                    continue

                # Simple ELO: winner gains, loser loses
                if m["home_score"] > m["away_score"]:
                    elo_changes[m["home_team_id"]] = elo_changes.get(m["home_team_id"], 0) + K_FACTOR
                    elo_changes[m["away_team_id"]] = elo_changes.get(m["away_team_id"], 0) - K_FACTOR
                elif m["home_score"] < m["away_score"]:
                    elo_changes[m["home_team_id"]] = elo_changes.get(m["home_team_id"], 0) - K_FACTOR
                    elo_changes[m["away_team_id"]] = elo_changes.get(m["away_team_id"], 0) + K_FACTOR
                else:
                    # Draw: slight adjustment toward the away team
                    elo_changes[m["home_team_id"]] = elo_changes.get(m["home_team_id"], 0) - K_FACTOR * 0.3
                    elo_changes[m["away_team_id"]] = elo_changes.get(m["away_team_id"], 0) + K_FACTOR * 0.3

            # Update team metadata with new ELO
            for team_id, delta in elo_changes.items():
                await conn.execute(
                    """UPDATE teams SET
                       metadata = COALESCE(metadata, '{}'::jsonb) ||
                         jsonb_build_object('elo', COALESCE((metadata->>'elo')::int, 1500) + $2)
                       WHERE id = $1""",
                    team_id, int(delta),
                )

        logger.info(f"Updated ELO for {len(elo_changes)} teams")
    except Exception as e:
        logger.error(f"ELO update failed: {e}")


# ============================================================
# Cleanup (daily)
# ============================================================

async def cleanup_old_data(pool: asyncpg.Pool | None):
    """Remove old data to manage database size."""
    if not pool:
        return

    try:
        async with pool.acquire() as conn:
            # Keep last 30 days of odds data
            await conn.execute(
                "SELECT drop_chunks('live_odds', INTERVAL '30 days')"
            )
            # Keep last 90 days of match events
            await conn.execute(
                "SELECT drop_chunks('match_events', INTERVAL '90 days')"
            )
        logger.info("Data cleanup completed")
    except Exception as e:
        logger.error(f"Cleanup failed: {e}")


# ============================================================
# Helpers
# ============================================================

def _parse_num(value) -> float | None:
    """Parse numeric value from API response (may be string with '%')."""
    if value is None:
        return None
    if isinstance(value, (int, float)):
        return float(value)
    if isinstance(value, str):
        cleaned = value.replace("%", "").strip()
        try:
            return float(cleaned)
        except ValueError:
            return None
    return None
