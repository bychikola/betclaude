"""
Event Normalizer — unifies data formats from different providers
into a consistent internal schema.

Supported sources:
- api-football (v3 API)
- sportradar (Soccer v4 API)
- opta (JSON feed)
"""

from datetime import datetime, timezone
from typing import Any

from loguru import logger


class EventNormalizer:
    """Normalizes sports data from various external providers."""

    # Provider-specific field mappings
    MAPPINGS = {
        "api-football": {
            "match_id": ("fixture.id",),
            "home_team": ("teams.home.name",),
            "away_team": ("teams.away.name",),
            "home_score": ("goals.home",),
            "away_score": ("goals.away",),
            "status": ("fixture.status.short",),
            "elapsed": ("fixture.status.elapsed",),
            "league": ("league.name",),
            "start_time": ("fixture.date",),
            "venue": ("fixture.venue.name",),
        },
        "sportradar": {
            "match_id": ("sport_event.id",),
            "home_team": ("sport_event.competitors[0].name",),
            "away_team": ("sport_event.competitors[1].name",),
            "home_score": ("sport_event_status.home_score",),
            "away_score": ("sport_event_status.away_score",),
            "status": ("sport_event_status.status",),
            "elapsed": ("sport_event_status.clock",),
            "league": ("sport_event.tournament.name",),
            "start_time": ("sport_event.start_time",),
            "venue": ("sport_event.venue.name",),
        },
        "opta": {
            "match_id": ("matchInfo.id",),
            "home_team": ("matchInfo.contestant[0].name",),
            "away_team": ("matchInfo.contestant[1].name",),
            "home_score": ("liveData.score.home",),
            "away_score": ("liveData.score.away",),
            "status": ("matchInfo.status",),
            "elapsed": ("liveData.matchDetails.matchTime",),
            "league": ("matchInfo.tournament.name",),
            "start_time": ("matchInfo.date",),
            "venue": ("matchInfo.venue.name",),
        },
    }

    STATUS_MAP = {
        # api-football → internal
        "NS": "scheduled", "TBD": "scheduled",
        "1H": "live", "HT": "live", "2H": "live",
        "ET": "live", "P": "live", "BT": "live",
        "FT": "finished", "AET": "finished", "PEN": "finished",
        "PST": "postponed", "CANC": "cancelled", "ABD": "cancelled",
        # sportradar → internal
        "not_started": "scheduled",
        "live": "live",
        "closed": "finished",
        "postponed": "postponed",
        "cancelled": "cancelled",
    }

    EVENT_TYPE_MAP = {
        "goal": "goal",
        "card": "yellow_card",  # differentiated by detail
        "subst": "substitution",
        "var": "var",
        "penalty": "penalty",
    }

    def normalize_match(self, source: str, sport: str, payload: dict) -> dict:
        """Normalize a match payload into internal schema."""
        mapping = self.MAPPINGS.get(source)
        if not mapping:
            raise ValueError(f"Unknown source: {source}")

        raw_status = self._get_nested(payload, mapping.get("status", ()))
        start_time = self._get_nested(payload, mapping.get("start_time", ()))

        return {
            "id": self._generate_id(source, self._get_nested(payload, mapping["match_id"])),
            "external_id": str(self._get_nested(payload, mapping["match_id"])),
            "sport": sport,
            "home_team": self._get_nested(payload, mapping["home_team"]),
            "away_team": self._get_nested(payload, mapping["away_team"]),
            "home_score": self._get_nested(payload, mapping.get("home_score", ())),
            "away_score": self._get_nested(payload, mapping.get("away_score", ())),
            "status": self._normalize_status(raw_status),
            "minute": self._get_nested(payload, mapping.get("elapsed", ())),
            "league": self._get_nested(payload, mapping.get("league", ())),
            "start_time": self._parse_time(start_time),
            "venue": self._get_nested(payload, mapping.get("venue", ())),
            "source": source,
            "raw_payload": payload,
        }

    def normalize_odds(self, provider: str, match_id: str, payload: dict) -> dict:
        """Normalize odds data into internal schema."""
        if provider == "pinnacle":
            return {
                "match_id": match_id,
                "provider": provider,
                "market": payload.get("market", "1X2"),
                "home_odds": float(payload.get("home", payload.get("home_odds", 0))),
                "draw_odds": float(payload.get("draw", payload.get("draw_odds", 0))) if "draw" in payload or "draw_odds" in payload else None,
                "away_odds": float(payload.get("away", payload.get("away_odds", 0))),
            }
        elif provider == "bet365":
            return {
                "match_id": match_id,
                "provider": provider,
                "market": payload.get("market", "1X2"),
                "home_odds": float(payload.get("homeOdds", payload.get("home", 0))),
                "draw_odds": float(payload.get("drawOdds", payload.get("draw", 0))) if "drawOdds" in payload or "draw" in payload else None,
                "away_odds": float(payload.get("awayOdds", payload.get("away", 0))),
            }
        else:
            raise ValueError(f"Unknown odds provider: {provider}")

    def normalize_event(self, source: str, match_id: str, event: dict) -> dict:
        """Normalize a match event into internal schema."""
        if source == "api-football":
            return {
                "match_id": match_id,
                "type": self.EVENT_TYPE_MAP.get(event.get("type", ""), "other"),
                "minute": event.get("time", {}).get("elapsed", 0),
                "team_name": event.get("team", {}).get("name"),
                "player_name": event.get("player", {}).get("name"),
                "detail": event.get("detail") or event.get("comments"),
            }
        elif source == "sportradar":
            return {
                "match_id": match_id,
                "type": self.EVENT_TYPE_MAP.get(event.get("type", ""), "other"),
                "minute": event.get("time", 0),
                "team_name": event.get("competitor"),
                "player_name": event.get("player", {}).get("name"),
                "detail": event.get("description"),
            }
        else:
            return {
                "match_id": match_id,
                "type": "other",
                "minute": event.get("minute", 0),
                "player_name": event.get("playerName"),
                "detail": event.get("description") or json.dumps(event),
            }

    def normalize_match_stats(self, source: str, match_id: str, stats: dict) -> dict:
        """Normalize match statistics."""
        if source == "api-football":
            team_stats = stats.get("statistics", [])
            stats_map = {s["type"]: s["value"] for s in team_stats}
            return {
                "match_id": match_id,
                "team_name": stats.get("team", {}).get("name"),
                "possession": self._parse_pct(stats_map.get("Ball Possession")),
                "shots": self._parse_int(stats_map.get("Total Shots")),
                "shots_on_target": self._parse_int(stats_map.get("Shots on Goal")),
                "corners": self._parse_int(stats_map.get("Corner Kicks")),
                "fouls": self._parse_int(stats_map.get("Fouls")),
                "yellow_cards": self._parse_int(stats_map.get("Yellow Cards")),
                "red_cards": self._parse_int(stats_map.get("Red Cards")),
                "offsides": self._parse_int(stats_map.get("Offsides")),
                "expected_goals": self._parse_float(stats_map.get("Expected Goals")),
                "pass_accuracy": self._parse_pct(stats_map.get("Passes %")),
            }
        return stats

    # ============================================================
    # Helpers
    # ============================================================

    def _get_nested(self, obj: dict, path: tuple, default=None) -> Any:
        """Get a nested value from a dict using a dot-notation path."""
        if not path:
            return default

        key = path[0]
        # Handle array index notation like "competitors[0]"
        if "[" in key:
            key_parts = key.replace("]", "").split("[")
            base_key = key_parts[0]
            index = int(key_parts[1]) if len(key_parts) > 1 else 0
            value = obj.get(base_key, default)
            if isinstance(value, list) and index < len(value):
                return self._get_nested(value[index], path[1:], default)
            return default

        value = obj.get(key, default)
        if len(path) == 1:
            return value
        if isinstance(value, dict):
            return self._get_nested(value, path[1:], default)
        return default

    def _normalize_status(self, raw: Any) -> str:
        """Map external status to internal enum."""
        if raw is None:
            return "scheduled"
        return self.STATUS_MAP.get(str(raw), "scheduled")

    def _parse_time(self, value: Any) -> str | None:
        """Parse a datetime value to ISO string."""
        if value is None:
            return None
        if isinstance(value, datetime):
            return value.isoformat()
        if isinstance(value, str):
            try:
                dt = datetime.fromisoformat(value.replace("Z", "+00:00"))
                return dt.isoformat()
            except (ValueError, TypeError):
                return value
        return str(value)

    def _generate_id(self, source: str, external_id: Any) -> str:
        """Generate internal ID from source + external ID."""
        import hashlib
        raw = f"{source}:{external_id}"
        return hashlib.sha256(raw.encode()).hexdigest()[:16]

    @staticmethod
    def _parse_pct(value) -> float | None:
        if value is None:
            return None
        if isinstance(value, (int, float)):
            return float(value)
        return float(str(value).replace("%", "").strip())

    @staticmethod
    def _parse_int(value) -> int | None:
        if value is None:
            return None
        try:
            return int(value)
        except (ValueError, TypeError):
            return None

    @staticmethod
    def _parse_float(value) -> float | None:
        if value is None:
            return None
        try:
            return float(value)
        except (ValueError, TypeError):
            return None


# For JSON dump in normalize_event fallback
import json
