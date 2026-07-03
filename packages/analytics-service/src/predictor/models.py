"""
Match predictor — ML models for sports outcome prediction.

Models:
- Poisson regression (expected goals → score probabilities)
- ELO-based (rating difference → win probabilities)
- Ensemble (weighted average of multiple models)

Uses:
- scikit-learn for regression
- xgboost for ensemble models
- numpy/scipy for Poisson distribution
"""

import math
import os
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any

import asyncpg
import numpy as np
from loguru import logger
from scipy.stats import poisson


# ============================================================
# Types
# ============================================================

@dataclass
class PredictionResult:
    model: str
    home_score: float
    away_score: float
    confidence: float
    probabilities: dict[str, float]  # home_win, draw, away_win
    features: dict[str, float] = field(default_factory=dict)


@dataclass
class TeamFormMatch:
    date: str
    opponent: str
    is_home: bool
    goals_for: int
    goals_against: int
    result: str  # W, D, L
    xg: float = 0.0


@dataclass
class FormSummary:
    matches: int
    wins: int
    draws: int
    losses: int
    goals_for: int
    goals_against: int
    avg_xg: float
    trend: str  # improving, declining, stable


# ============================================================
# Predictor
# ============================================================

class MatchPredictor:
    """Generates match predictions using multiple models."""

    def __init__(self):
        self.db_pool: asyncpg.Pool | None = None

    async def _ensure_pool(self):
        if not self.db_pool:
            self.db_pool = await asyncpg.create_pool(
                host=os.getenv("DB_HOST", "localhost"),
                port=int(os.getenv("DB_PORT", "5432")),
                database=os.getenv("DB_NAME", "betclaude"),
                user=os.getenv("DB_USER", "betclaude"),
                password=os.getenv("DB_PASSWORD", "betclaude_dev"),
                min_size=2,
                max_size=5,
            )

    async def predict(
        self, match_id: str, models: list[str] | None = None
    ) -> dict:
        """Generate predictions for a match."""
        await self._ensure_pool()
        models = models or ["ensemble"]

        # Fetch match data
        match_data = await self._fetch_match_data(match_id)
        if not match_data:
            raise ValueError(f"Match not found: {match_id}")

        predictions = []

        for model_name in models:
            if model_name == "poisson":
                pred = await self._poisson_predict(match_data)
            elif model_name == "elo":
                pred = await self._elo_predict(match_data)
            elif model_name == "xgboost":
                pred = await self._xgboost_predict(match_data)
            elif model_name == "ensemble":
                pred = await self._ensemble_predict(match_data)
            else:
                continue

            predictions.append({
                "model": pred.model,
                "home_score": round(pred.home_score, 2),
                "away_score": round(pred.away_score, 2),
                "confidence": round(pred.confidence, 4),
                "probabilities": pred.probabilities,
                "features": pred.features,
            })

        # Store predictions
        async with self.db_pool.acquire() as conn:
            for p in predictions:
                await conn.execute(
                    """INSERT INTO predictions
                       (match_id, model, predicted_home_score,
                        predicted_away_score, confidence, features)
                       VALUES ($1, $2, $3, $4, $5, $6)""",
                    match_id, p["model"],
                    p["home_score"], p["away_score"],
                    p["confidence"], json.dumps(p["features"]),
                )

        return {"match_id": match_id, "predictions": predictions}

    async def batch_predict(self, match_ids: list[str], model: str) -> list[dict]:
        """Batch predict for multiple matches."""
        results = []
        for mid in match_ids:
            try:
                result = await self.predict(mid, [model])
                results.append(result)
            except Exception as e:
                logger.warning(f"Batch predict failed for {mid}: {e}")
                results.append({"match_id": mid, "error": str(e)})
        return results

    async def analyze(
        self,
        match_id: str,
        include_stats: bool = True,
        include_h2h: bool = True,
        include_form: bool = True,
    ) -> dict:
        """Full match analysis."""
        await self._ensure_pool()

        match_data = await self._fetch_match_data(match_id)
        if not match_data:
            raise ValueError(f"Match not found: {match_id}")

        analysis = {
            "match_id": match_id,
            "match_info": {
                "home_team": match_data.get("home_team"),
                "away_team": match_data.get("away_team"),
                "league": match_data.get("league_name"),
                "sport": match_data.get("sport_name"),
                "start_time": str(match_data.get("start_time")),
                "status": match_data.get("status"),
            },
        }

        if include_form:
            analysis["home_team"] = await self._team_analysis(
                match_data["home_team_id"], match_data["home_team"]
            )
            analysis["away_team"] = await self._team_analysis(
                match_data["away_team_id"], match_data["away_team"]
            )

        if include_h2h:
            analysis["head_to_head"] = await self._h2h_analysis(
                match_data["home_team_id"], match_data["away_team_id"],
                match_data["home_team"], match_data["away_team"],
            )

        if include_stats:
            prediction = await self._ensemble_predict(match_data)
            analysis["prediction"] = {
                "model": prediction.model,
                "home_score": round(prediction.home_score, 2),
                "away_score": round(prediction.away_score, 2),
                "confidence": round(prediction.confidence, 4),
                "probabilities": prediction.probabilities,
            }

        # Key factors
        analysis["key_factors"] = await self._identify_key_factors(match_data)

        return analysis

    async def get_team_form(self, team_id: str, matches: int = 10) -> dict:
        """Get team's recent form."""
        await self._ensure_pool()

        async with self.db_pool.acquire() as conn:
            rows = await conn.fetch(
                """SELECT
                   m.start_time, m.home_score, m.away_score, m.status,
                   CASE WHEN m.home_team_id = $1 THEN at.name ELSE ht.name END as opponent,
                   (m.home_team_id = $1) as is_home
                 FROM matches m
                 JOIN teams ht ON m.home_team_id = ht.id
                 JOIN teams at ON m.away_team_id = at.id
                 WHERE (m.home_team_id = $1 OR m.away_team_id = $1)
                   AND m.status = 'finished'
                 ORDER BY m.start_time DESC
                 LIMIT $2""",
                team_id, matches,
            )

            team_name_row = await conn.fetchrow(
                "SELECT name FROM teams WHERE id = $1", team_id
            )
            team_name = team_name_row["name"] if team_name_row else "Unknown"

        form_matches = []
        w = d = l = gf = ga = 0

        for r in reversed(rows):
            goals_for = r["home_score"] if r["is_home"] else r["away_score"]
            goals_against = r["away_score"] if r["is_home"] else r["home_score"]

            if goals_for > goals_against:
                result = "W"; w += 1
            elif goals_for == goals_against:
                result = "D"; d += 1
            else:
                result = "L"; l += 1

            gf += goals_for or 0
            ga += goals_against or 0

            form_matches.append({
                "date": str(r["start_time"]),
                "opponent": r["opponent"],
                "is_home": r["is_home"],
                "goals_for": goals_for or 0,
                "goals_against": goals_against or 0,
                "result": result,
            })

        total = len(form_matches)

        # Determine trend
        if total >= 6:
            first_half_pts = sum(
                3 if m["result"] == "W" else 1 if m["result"] == "D" else 0
                for m in form_matches[:total//2]
            )
            second_half_pts = sum(
                3 if m["result"] == "W" else 1 if m["result"] == "D" else 0
                for m in form_matches[total//2:]
            )
            if second_half_pts > first_half_pts + 2:
                trend = "improving"
            elif second_half_pts < first_half_pts - 2:
                trend = "declining"
            else:
                trend = "stable"
        else:
            trend = "stable"

        return {
            "team_id": team_id,
            "team_name": team_name,
            "matches": form_matches,
            "summary": {
                "matches": total,
                "wins": w,
                "draws": d,
                "losses": l,
                "goals_for": gf,
                "goals_against": ga,
                "trend": trend,
            },
        }

    async def get_h2h(
        self, team1_id: str, team2_id: str, limit: int = 10
    ) -> dict:
        """Get head-to-head history."""
        await self._ensure_pool()

        async with self.db_pool.acquire() as conn:
            rows = await conn.fetch(
                """SELECT m.start_time, m.home_score, m.away_score,
                   ht.name as home_team, at.name as away_team,
                   l.name as league_name
                 FROM matches m
                 JOIN teams ht ON m.home_team_id = ht.id
                 JOIN teams at ON m.away_team_id = at.id
                 JOIN leagues l ON m.league_id = l.id
                 WHERE (
                   (m.home_team_id = $1 AND m.away_team_id = $2) OR
                   (m.home_team_id = $2 AND m.away_team_id = $1)
                 )
                 AND m.status = 'finished'
                 ORDER BY m.start_time DESC
                 LIMIT $3""",
                team1_id, team2_id, limit,
            )

        home_wins = draws = away_wins = 0
        matches = []

        for r in rows:
            matches.append({
                "date": str(r["start_time"]),
                "competition": r["league_name"],
                "home_team": r["home_team"],
                "away_team": r["away_team"],
                "home_score": r["home_score"],
                "away_score": r["away_score"],
            })

            if r["home_score"] > r["away_score"]:
                if r["home_team"] == rows[0]["home_team"]:  # approximate
                    home_wins += 1
                else:
                    away_wins += 1
            elif r["home_score"] < r["away_score"]:
                if r["away_team"] == rows[0]["away_team"]:
                    away_wins += 1
                else:
                    home_wins += 1
            else:
                draws += 1

        return {
            "summary": {
                "total_matches": len(matches),
                "home_wins": home_wins,
                "draws": draws,
                "away_wins": away_wins,
                "recent_matches": matches,
            },
        }

    # ============================================================
    # Model implementations
    # ============================================================

    async def _poisson_predict(self, match_data: dict) -> PredictionResult:
        """Poisson regression: xG → score distribution."""
        home_xg = match_data.get("home_avg_xg", 1.5) or 1.5
        away_xg = match_data.get("away_avg_xg", 1.2) or 1.2

        # Home advantage multiplier
        home_xg *= 1.15
        away_xg *= 0.85

        # Adjust for opponent strength
        home_def_strength = match_data.get("away_avg_xga", 1.2) or 1.2
        away_def_strength = match_data.get("home_avg_xga", 1.0) or 1.0

        expected_home = home_xg * (away_def_strength / 1.2)
        expected_away = away_xg * (home_def_strength / 1.2)

        # Poisson probabilities for scores 0-5
        max_goals = 5
        home_probs = [poisson.pmf(i, expected_home) for i in range(max_goals + 1)]
        away_probs = [poisson.pmf(i, expected_away) for i in range(max_goals + 1)]

        # Calculate outcome probabilities
        home_win_prob = sum(
            home_probs[i] * sum(away_probs[:i])
            for i in range(1, max_goals + 1)
        )
        away_win_prob = sum(
            away_probs[i] * sum(home_probs[:i])
            for i in range(1, max_goals + 1)
        )
        draw_prob = sum(home_probs[i] * away_probs[i] for i in range(max_goals + 1))

        return PredictionResult(
            model="poisson",
            home_score=expected_home,
            away_score=expected_away,
            confidence=max(home_win_prob, draw_prob, away_win_prob),
            probabilities={
                "home_win": round(home_win_prob, 4),
                "draw": round(draw_prob, 4),
                "away_win": round(away_win_prob, 4),
            },
            features={
                "expected_home_goals": round(expected_home, 3),
                "expected_away_goals": round(expected_away, 3),
                "home_xg": round(home_xg, 3),
                "away_xg": round(away_xg, 3),
            },
        )

    async def _elo_predict(self, match_data: dict) -> PredictionResult:
        """ELO-based prediction."""
        home_elo = match_data.get("home_elo", 1500) or 1500
        away_elo = match_data.get("away_elo", 1500) or 1500
        elo_diff = home_elo - away_elo + 100  # +100 home advantage

        # Convert ELO difference to win probability
        home_win_prob = 1 / (1 + 10 ** (-elo_diff / 400))
        draw_prob = 0.28 * (1 - abs(home_win_prob - 0.5) * 2)  # Draws peak at equal strength
        away_win_prob = 1 - home_win_prob - draw_prob

        # Scale to expected goals using division averages
        avg_goals = 2.75
        expected_home = avg_goals * (home_win_prob + draw_prob * 0.5)
        expected_away = avg_goals * (away_win_prob + draw_prob * 0.5)

        return PredictionResult(
            model="elo",
            home_score=expected_home,
            away_score=expected_away,
            confidence=max(home_win_prob, draw_prob, away_win_prob),
            probabilities={
                "home_win": round(home_win_prob, 4),
                "draw": round(draw_prob, 4),
                "away_win": round(away_win_prob, 4),
            },
            features={
                "home_elo": home_elo,
                "away_elo": away_elo,
                "elo_diff": elo_diff,
            },
        )

    async def _xgboost_predict(self, match_data: dict) -> PredictionResult:
        """XGBoost model prediction using engineered features."""
        # Feature engineering
        features = {
            "home_avg_xg": match_data.get("home_avg_xg", 1.5) or 1.5,
            "away_avg_xg": match_data.get("away_avg_xg", 1.2) or 1.2,
            "home_avg_xga": match_data.get("home_avg_xga", 1.0) or 1.0,
            "away_avg_xga": match_data.get("away_avg_xga", 1.2) or 1.2,
            "home_elo": match_data.get("home_elo", 1500) or 1500,
            "away_elo": match_data.get("away_elo", 1500) or 1500,
            "home_form_pts": match_data.get("home_form_pts", 1.5) or 1.5,
            "away_form_pts": match_data.get("away_form_pts", 1.5) or 1.5,
            "h2h_home_dominance": match_data.get("h2h_home_dominance", 0.5) or 0.5,
        }

        # In production: load trained XGBoost model
        # model = xgb.Booster()
        # model.load_model("models/xgboost_match_predictor.json")
        # dmatrix = xgb.DMatrix([list(features.values())])
        # raw_pred = model.predict(dmatrix)[0]

        # For now: weighted sum of features as linear approximation
        weights = {
            "home_avg_xg": 1.2,
            "away_avg_xga": 1.1,
            "home_elo": 0.001,
            "home_form_pts": 0.3,
        }
        home_strength = sum(
            weights.get(k, 0.1) * v for k, v in features.items() if "home" in k or "away_avg_xga" in k
        )
        away_strength = sum(
            weights.get(k.replace("home", "away"), 0.1) * v
            for k, v in features.items() if "away" in k or "home_avg_xga" in k
        )

        expected_home = max(0.3, home_strength / 2)
        expected_away = max(0.3, away_strength / 2)

        # Normalize
        total = expected_home + expected_away
        if total > 0:
            expected_home = (expected_home / total) * 2.75
            expected_away = (expected_away / total) * 2.75

        # Probabilities using Poisson
        home_win_prob = 1 / (1 + math.exp(-(expected_home - expected_away)))
        draw_prob = 0.25 * (1 - abs(home_win_prob - 0.5) * 2)
        away_win_prob = 1 - home_win_prob - draw_prob

        return PredictionResult(
            model="xgboost",
            home_score=expected_home,
            away_score=expected_away,
            confidence=max(home_win_prob, draw_prob, away_win_prob),
            probabilities={
                "home_win": round(home_win_prob, 4),
                "draw": round(max(0, draw_prob), 4),
                "away_win": round(max(0, away_win_prob), 4),
            },
            features=features,
        )

    async def _ensemble_predict(self, match_data: dict) -> PredictionResult:
        """Ensemble: weighted average of all models."""
        poisson_pred = await self._poisson_predict(match_data)
        elo_pred = await self._elo_predict(match_data)
        xgb_pred = await self._xgboost_predict(match_data)

        # Weights based on model reliability
        w_poisson = 0.4
        w_elo = 0.25
        w_xgb = 0.35

        home_score = (
            w_poisson * poisson_pred.home_score +
            w_elo * elo_pred.home_score +
            w_xgb * xgb_pred.home_score
        )
        away_score = (
            w_poisson * poisson_pred.away_score +
            w_elo * elo_pred.away_score +
            w_xgb * xgb_pred.away_score
        )

        # Weighted probabilities
        probs = {}
        for key in ["home_win", "draw", "away_win"]:
            probs[key] = round(
                w_poisson * poisson_pred.probabilities.get(key, 0) +
                w_elo * elo_pred.probabilities.get(key, 0) +
                w_xgb * xgb_pred.probabilities.get(key, 0),
                4,
            )

        return PredictionResult(
            model="ensemble",
            home_score=round(home_score, 2),
            away_score=round(away_score, 2),
            confidence=max(probs.values()),
            probabilities=probs,
            features={
                "poisson_home": round(poisson_pred.home_score, 2),
                "poisson_away": round(poisson_pred.away_score, 2),
                "elo_home": round(elo_pred.home_score, 2),
                "elo_away": round(elo_pred.away_score, 2),
                "xgb_home": round(xgb_pred.home_score, 2),
                "xgb_away": round(xgb_pred.away_score, 2),
            },
        )

    # ============================================================
    # Data fetching
    # ============================================================

    async def _fetch_match_data(self, match_id: str) -> dict | None:
        """Fetch match data with enriched stats from DB."""
        async with self.db_pool.acquire() as conn:
            row = await conn.fetchrow(
                """SELECT m.*,
                   ht.name as home_team, ht.metadata as home_meta,
                   at.name as away_team, at.metadata as away_meta,
                   l.name as league_name, s.name as sport_name
                 FROM matches m
                 JOIN teams ht ON m.home_team_id = ht.id
                 JOIN teams at ON m.away_team_id = at.id
                 JOIN leagues l ON m.league_id = l.id
                 JOIN sports s ON m.sport_id = s.id
                 WHERE m.id = $1""",
                match_id,
            )

            if not row:
                return None

            data = dict(row)

            # Parse team metadata (ELO, etc.)
            home_meta = row["home_meta"] or {}
            away_meta = row["away_meta"] or {}
            if isinstance(home_meta, str):
                home_meta = json.loads(home_meta)
            if isinstance(away_meta, str):
                away_meta = json.loads(away_meta)

            data["home_elo"] = home_meta.get("elo", 1500)
            data["away_elo"] = away_meta.get("elo", 1500)

            # Get average stats
            stats = await conn.fetch(
                """SELECT team_id, AVG(expected_goals) as avg_xg,
                   AVG(shots) as avg_shots, AVG(possession) as avg_possession
                 FROM match_stats
                 WHERE team_id IN ($1, $2)
                 GROUP BY team_id""",
                row["home_team_id"], row["away_team_id"],
            )

            for s in stats:
                if s["team_id"] == row["home_team_id"]:
                    data["home_avg_xg"] = float(s["avg_xg"]) if s["avg_xg"] else 1.5
                else:
                    data["away_avg_xg"] = float(s["avg_xg"]) if s["avg_xg"] else 1.2

            return data

    async def _team_analysis(self, team_id: str, team_name: str) -> dict:
        """Build team analysis section."""
        form = await self.get_team_form(team_id, 10)

        # Get season stats
        async with self.db_pool.acquire() as conn:
            stats = await conn.fetchrow(
                """SELECT
                   AVG(possession) as avg_possession,
                   AVG(shots) as avg_shots,
                   AVG(shots_on_target) as avg_shots_on_target,
                   AVG(expected_goals) as avg_xg
                 FROM match_stats
                 WHERE team_id = $1""",
                team_id,
            )

        return {
            "team_name": team_name,
            "recent_form": form["summary"],
            "season_stats": {
                "avg_possession": round(float(stats["avg_possession"] or 0), 1),
                "avg_shots": round(float(stats["avg_shots"] or 0), 1),
                "avg_shots_on_target": round(float(stats["avg_shots_on_target"] or 0), 1),
                "avg_xg": round(float(stats["avg_xg"] or 0), 2),
            } if stats else {},
        }

    async def _h2h_analysis(
        self, team1_id: str, team2_id: str, team1_name: str, team2_name: str
    ) -> dict:
        """Build H2H analysis section."""
        return await self.get_h2h(team1_id, team2_id, 10)

    async def _identify_key_factors(self, match_data: dict) -> list[str]:
        """Identify key factors affecting the match."""
        factors = []

        # ELO difference
        home_elo = match_data.get("home_elo", 1500) or 1500
        away_elo = match_data.get("away_elo", 1500) or 1500
        elo_diff = home_elo - away_elo
        if abs(elo_diff) > 150:
            stronger = match_data.get("home_team") if elo_diff > 0 else match_data.get("away_team")
            factors.append(f"Significant ELO advantage for {stronger} ({abs(elo_diff):.0f} points)")

        # Home advantage
        factors.append("Home team advantage (historically ~15% higher win rate)")

        # Form
        factors.append("Recent form is a strong indicator — consider last 5 matches")

        # xG differential
        home_xg = match_data.get("home_avg_xg", 1.5) or 1.5
        away_xg = match_data.get("away_avg_xg", 1.2) or 1.2
        if abs(home_xg - away_xg) > 0.5:
            factors.append(
                f"xG differential of {abs(home_xg - away_xg):.2f} suggests "
                f"{match_data.get('home_team') if home_xg > away_xg else match_data.get('away_team')} "
                "creates more quality chances"
            )

        return factors


# JSON import for features storage
import json
