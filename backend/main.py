import logging
import os
from contextlib import asynccontextmanager

from fastapi import Depends, FastAPI
from fastapi.middleware.cors import CORSMiddleware

from approval_service.router import router as approval_router
from audit_service.router import router as audit_router
from bid_engine_service.router import router as bid_router
from blotter_service.router import router as blotter_router
from common.auth import current_actor, log_auth_mode
from common.database import init_db
from forecast_service.router import router as forecast_router
from jobs.scheduler import start_scheduler, stop_scheduler
from policy_service.router import router as policy_router
from risk_service.router import router as risk_router
from scraper_service.router import router as scraper_router

# Uvicorn configures only its own loggers; this makes application loggers visible too.
logging.basicConfig(
    level=os.getenv("LOG_LEVEL", "INFO").upper(), format="%(levelname)s:%(name)s:%(message)s"
)


@asynccontextmanager
async def lifespan(app: FastAPI):
    log_auth_mode()
    await init_db()
    start_scheduler()
    yield
    stop_scheduler()


app = FastAPI(
    title="EnergyTrader API",
    description="Price forecasting, bid optimization and pre-trade risk for Indian power exchanges.",
    version="0.1.0",
    lifespan=lifespan,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        o.strip()
        for o in os.getenv("CORS_ORIGINS", "http://localhost:3000").split(",")
        if o.strip()
    ],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

for router in (
    forecast_router,
    bid_router,
    approval_router,
    risk_router,
    audit_router,
    blotter_router,
    policy_router,
    scraper_router,
):
    app.include_router(router, prefix="/api", dependencies=[Depends(current_actor)])


# Public, so uptime checks need no token.
@app.get("/api/health")
async def health():
    return {"status": "ok", "service": "energytrader-api"}
