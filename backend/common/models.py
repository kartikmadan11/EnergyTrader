from sqlalchemy import JSON, Boolean, Column, DateTime, Float, Index, Integer, String, Text
from sqlalchemy.sql import func

from .database import Base


class PriceHistory(Base):
    """Historical price data for training and backtesting."""

    __tablename__ = "price_history"
    # Scrapers keep (date, segment, block) unique; the blotter and reviews look rows up by it.
    __table_args__ = (Index("ix_price_history_date_segment_block", "date", "segment", "block"),)

    id = Column(Integer, primary_key=True, autoincrement=True)
    date = Column(String(10), nullable=False)  # YYYY-MM-DD
    block = Column(Integer, nullable=False)  # 1-96
    segment = Column(String(5), nullable=False)  # DAM, RTM, TAM
    exchange = Column(String(10), default="IEX")
    mcp = Column(Float, nullable=False)  # Market Clearing Price INR/kWh
    mcv = Column(Float)  # Market Clearing Volume MW
    demand_mw = Column(Float)
    supply_mw = Column(Float)
    renewable_gen_mw = Column(Float)
    temperature = Column(Float)


class Forecast(Base):
    """Generated price forecasts."""

    __tablename__ = "forecasts"

    id = Column(Integer, primary_key=True, autoincrement=True)
    created_at = Column(DateTime, server_default=func.now())
    target_date = Column(String(10), nullable=False)
    block = Column(Integer, nullable=False)
    segment = Column(String(5), nullable=False)
    predicted_price = Column(Float, nullable=False)
    confidence_low = Column(Float)
    confidence_high = Column(Float)
    volatility = Column(Float)
    top_features = Column(JSON)  # top 3-5 feature importances


class Bid(Base):
    """Submitted bids, one row per block, grouped by session_id."""

    __tablename__ = "bids"

    id = Column(Integer, primary_key=True, autoincrement=True)
    session_id = Column(String(36), nullable=False, index=True)  # groups one submission
    created_at = Column(DateTime, server_default=func.now())
    target_date = Column(String(10), nullable=False)
    block = Column(Integer, nullable=False)
    segment = Column(String(5), nullable=False)
    strategy = Column(String(20), default="balanced")
    price = Column(Float, nullable=False)  # INR/kWh
    volume_mw = Column(Float, nullable=False)
    is_overridden = Column(Boolean, default=False)
    override_reason = Column(Text)
    constraint_violations = Column(JSON)
    status = Column(String(20), default="submitted")


class RiskSnapshot(Base):
    """Point-in-time risk calculations."""

    __tablename__ = "risk_snapshots"

    id = Column(Integer, primary_key=True, autoincrement=True)
    session_id = Column(String(36), nullable=False)
    created_at = Column(DateTime, server_default=func.now())
    segment = Column(String(5), nullable=False)
    var_95 = Column(Float)  # Value-at-Risk 95%
    expected_dsm_penalty = Column(Float)
    worst_case_penalty = Column(Float)
    total_exposure = Column(Float)
    alert_triggered = Column(Boolean, default=False)
    alert_details = Column(JSON)


class AuditLog(Base):
    """Immutable audit trail."""

    __tablename__ = "audit_log"

    id = Column(Integer, primary_key=True, autoincrement=True)
    timestamp = Column(DateTime, server_default=func.now())
    session_id = Column(String(36))
    user = Column(String(100), default="trader")
    action = Column(String(50), nullable=False)  # e.g. pre_trade_check, submit, policy_activate
    entity_type = Column(String(50))  # bid, policy
    entity_id = Column(Integer)
    details = Column(JSON)
