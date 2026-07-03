"""
BetClaude Analytics Service — FastAPI entry point.

Provides:
- REST API for data ingestion, match analysis, predictions, reports
- gRPC server for high-performance inter-service communication
- Background scheduler for data aggregation
"""

import os
import time
from contextlib import asynccontextmanager

import uvicorn
from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException, Query
from loguru import logger
from pydantic import BaseModel

from .aggregator.scheduler import AggregatorScheduler
from .normalizer.event_normalizer import EventNormalizer
from .predictor.models import MatchPredictor
from .reports.generator import ReportGenerator

load_dotenv(os.path.join(os.path.dirname(__file__), "..", "..", "..", ".env"))

# ============================================================
# App lifecycle
# ============================================================

scheduler = AggregatorScheduler()
normalizer = EventNormalizer()
predictor = MatchPredictor()
report_gen = ReportGenerator()

@asynccontextmanager
async def lifespan(app: FastAPI):
    """Start background services on app startup."""
    logger.info("Starting Analytics Service...")
    await scheduler.start()
    logger.info("Analytics Service ready")
    yield
    logger.info("Shutting down Analytics Service...")
    await scheduler.stop()
    logger.info("Analytics Service stopped")


app = FastAPI(
    title="BetClaude Analytics Service",
    version="0.2.0",
    lifespan=lifespan,
)

# ============================================================
# Models
# ============================================================

class IngestRequest(BaseModel):
    source: str = "api-football"
    sport: str = "football"
    data_type: str = "match"
    payload: dict

class IngestOddsRequest(BaseModel):
    provider: str = "pinnacle"
    match_id: str
    payload: dict

class PredictRequest(BaseModel):
    match_id: str
    models: list[str] = ["ensemble"]

class AnalyzeRequest(BaseModel):
    match_id: str
    include_stats: bool = True
    include_h2h: bool = True
    include_form: bool = True

class ReportRequest(BaseModel):
    match_id: str
    format: str = "markdown"
    sections: list[str] = ["summary", "stats", "h2h", "prediction"]

class TeamFormRequest(BaseModel):
    team_id: str
    matches: int = 10

class H2HRequest(BaseModel):
    team1_id: str
    team2_id: str
    limit: int = 10

# ============================================================
# Routes
# ============================================================

@app.get("/health")
async def health():
    return {
        "status": "healthy",
        "version": "0.2.0",
        "uptime_seconds": time.time() - START_TIME,
    }


@app.post("/ingest/match")
async def ingest_match(req: IngestRequest):
    """Ingest match data from external provider."""
    try:
        normalized = normalizer.normalize_match(req.source, req.sport, req.payload)
        count = await scheduler.store_match(normalized)
        return {"success": True, "records_processed": count}
    except Exception as e:
        logger.error(f"Ingest failed: {e}")
        raise HTTPException(500, str(e))


@app.post("/ingest/odds")
async def ingest_odds(req: IngestOddsRequest):
    """Ingest odds data from betting provider."""
    try:
        normalized = normalizer.normalize_odds(req.provider, req.match_id, req.payload)
        count = await scheduler.store_odds(normalized)
        return {"success": True, "records_processed": count}
    except Exception as e:
        logger.error(f"Odds ingest failed: {e}")
        raise HTTPException(500, str(e))


@app.post("/predict")
async def predict_match(req: PredictRequest):
    """Generate predictions for a match."""
    try:
        result = await predictor.predict(req.match_id, req.models)
        return result
    except Exception as e:
        logger.error(f"Prediction failed: {e}")
        raise HTTPException(500, str(e))


@app.post("/predict/batch")
async def batch_predict(match_ids: list[str], model: str = "ensemble"):
    """Batch prediction for multiple matches."""
    try:
        results = await predictor.batch_predict(match_ids, model)
        return {"results": results}
    except Exception as e:
        logger.error(f"Batch prediction failed: {e}")
        raise HTTPException(500, str(e))


@app.post("/analyze")
async def analyze_match(req: AnalyzeRequest):
    """Full match analysis."""
    try:
        analysis = await predictor.analyze(
            req.match_id,
            include_stats=req.include_stats,
            include_h2h=req.include_h2h,
            include_form=req.include_form,
        )
        return analysis
    except Exception as e:
        logger.error(f"Analysis failed: {e}")
        raise HTTPException(500, str(e))


@app.post("/reports/generate")
async def generate_report(req: ReportRequest):
    """Generate a match report."""
    try:
        report = await report_gen.generate(
            req.match_id,
            format=req.format,
            sections=req.sections,
        )
        return report
    except Exception as e:
        logger.error(f"Report generation failed: {e}")
        raise HTTPException(500, str(e))


@app.get("/teams/{team_id}/form")
async def get_team_form(team_id: str, matches: int = Query(10, ge=5, le=50)):
    """Get team form."""
    try:
        form = await predictor.get_team_form(team_id, matches)
        return form
    except Exception as e:
        logger.error(f"Form fetch failed: {e}")
        raise HTTPException(500, str(e))


@app.get("/h2h/{team1_id}/{team2_id}")
async def get_h2h(team1_id: str, team2_id: str, limit: int = Query(10, ge=1, le=50)):
    """Get head-to-head history."""
    try:
        h2h = await predictor.get_h2h(team1_id, team2_id, limit)
        return h2h
    except Exception as e:
        logger.error(f"H2H fetch failed: {e}")
        raise HTTPException(500, str(e))


@app.get("/scheduler/status")
async def scheduler_status():
    """Get aggregator scheduler status."""
    return scheduler.get_status()


@app.post("/scheduler/trigger/{task_name}")
async def trigger_task(task_name: str):
    """Manually trigger an aggregation task."""
    try:
        await scheduler.trigger(task_name)
        return {"success": True, "task": task_name}
    except Exception as e:
        raise HTTPException(400, str(e))


# ============================================================
# Entry point
# ============================================================

START_TIME = time.time()

if __name__ == "__main__":
    uvicorn.run(
        "src.main:app",
        host=os.getenv("ANALYTICS_HOST", "0.0.0.0"),
        port=int(os.getenv("ANALYTICS_PORT", "8000")),
        reload=os.getenv("NODE_ENV", "development") != "production",
        log_level="info",
    )
