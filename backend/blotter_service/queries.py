"""
Blotter queries.

A blotter row is one bid session: the 96 (or fewer) block bids submitted together.
Each block is matched to its published clearing price, and a buy bid clears when its
price is at or above the MCP, as in the post-market review.
Everything is aggregated in SQL so filters, sorting and keyset pagination stay correct
however many sessions exist.
"""

from __future__ import annotations

import base64
import binascii
import json
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Literal

from sqlalchemy import Select, and_, case, func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from common.config import BLOCK_DURATION_MIN
from common.models import AuditLog, Bid, PriceHistory
from common.schemas import BlotterBlock, BlotterEvent, BlotterRow, BlotterStatus, BlotterTotals

HOURS_PER_BLOCK = BLOCK_DURATION_MIN / 60
KWH_PER_MWH = 1000

SortKey = Literal["submitted", "delivery", "volume", "value", "fill"]
SortOrder = Literal["asc", "desc"]


class InvalidCursor(ValueError):
    pass


@dataclass(frozen=True)
class BlotterFilters:
    segment: str | None = None
    strategy: str | None = None
    status: BlotterStatus | None = None
    delivery_from: str | None = None
    delivery_to: str | None = None
    trader: str | None = None
    session_prefix: str | None = None


def _legs(filters: BlotterFilters, session_id: str | None = None):
    """Bid rows with their block's clearing price, if published."""
    mcp = (
        select(func.max(PriceHistory.mcp))
        .where(
            PriceHistory.date == Bid.target_date,
            PriceHistory.segment == Bid.segment,
            PriceHistory.block == Bid.block,
        )
        .scalar_subquery()
    )
    q = select(
        Bid.id,
        Bid.session_id,
        Bid.created_at,
        Bid.target_date,
        Bid.segment,
        Bid.strategy,
        Bid.block,
        Bid.price,
        Bid.volume_mw,
        Bid.is_overridden,
        Bid.override_reason,
        mcp.label("mcp"),
    )
    if session_id is not None:
        q = q.where(Bid.session_id == session_id)
    if filters.segment:
        q = q.where(Bid.segment == filters.segment)
    if filters.strategy:
        q = q.where(Bid.strategy == filters.strategy)
    if filters.delivery_from:
        q = q.where(Bid.target_date >= filters.delivery_from)
    if filters.delivery_to:
        q = q.where(Bid.target_date <= filters.delivery_to)
    if filters.session_prefix:
        q = q.where(Bid.session_id.startswith(filters.session_prefix, autoescape=True))
    if filters.trader:
        q = q.where(
            Bid.session_id.in_(
                select(AuditLog.session_id).where(
                    AuditLog.action == "submit", AuditLog.user == filters.trader
                )
            )
        )
    return q.subquery("legs")


def _sessions(filters: BlotterFilters, session_id: str | None = None):
    """One aggregated row per session, with a derived clearing status."""
    legs = _legs(filters, session_id)
    priced = legs.c.mcp.is_not(None)
    cleared = and_(priced, legs.c.price >= legs.c.mcp)
    agg = (
        select(
            legs.c.session_id,
            func.min(legs.c.id).label("seq"),
            func.min(legs.c.created_at).label("submitted_at"),
            func.min(legs.c.target_date).label("target_date"),
            func.min(legs.c.segment).label("segment"),
            func.min(legs.c.strategy).label("strategy"),
            func.count().label("block_count"),
            func.sum(legs.c.volume_mw).label("sum_mw"),
            func.sum(legs.c.price * legs.c.volume_mw).label("sum_price_mw"),
            func.avg(legs.c.price).label("mean_price"),
            func.sum(case((legs.c.is_overridden, 1), else_=0)).label("overrides"),
            func.count(legs.c.mcp).label("priced_blocks"),
            func.sum(case((cleared, 1), else_=0)).label("cleared_blocks"),
            func.sum(case((priced, legs.c.volume_mw), else_=0.0)).label("priced_mw"),
            func.sum(case((cleared, legs.c.volume_mw), else_=0.0)).label("cleared_mw"),
            func.sum(case((cleared, legs.c.mcp * legs.c.volume_mw), else_=0.0)).label(
                "cleared_mcp_mw"
            ),
        )
        .group_by(legs.c.session_id)
        .subquery("agg")
    )
    # Once any price is out, the status says what has cleared so far, so a session whose
    # priced blocks all missed reads not_cleared even while later blocks await a price.
    status = case(
        (agg.c.priced_blocks == 0, "pending"),
        (agg.c.cleared_blocks == agg.c.block_count, "cleared"),
        (agg.c.cleared_blocks == 0, "not_cleared"),
        else_="partial",
    )
    fill = case(
        (and_(agg.c.priced_blocks > 0, agg.c.sum_mw > 0), agg.c.cleared_mw * 100.0 / agg.c.sum_mw),
        else_=None,
    )
    sessions = select(agg, status.label("status"), fill.label("fill_pct")).subquery("sessions")
    where = sessions.c.status == filters.status if filters.status else None
    return sessions, where


def _sort_column(sessions, sort: SortKey):
    # Float keys are rounded so a cursor value compares equal to the row it came from.
    return {
        "submitted": sessions.c.seq,
        "delivery": sessions.c.target_date,
        "volume": func.round(sessions.c.sum_mw, 6),
        "value": func.round(sessions.c.sum_price_mw, 6),
        "fill": func.round(func.coalesce(sessions.c.fill_pct, -1.0), 6),
    }[sort]


def encode_cursor(sort: SortKey, order: SortOrder, value, seq: int) -> str:
    raw = json.dumps([sort, order, value, seq], separators=(",", ":")).encode()
    return base64.urlsafe_b64encode(raw).rstrip(b"=").decode("ascii")


def decode_cursor(cursor: str, sort: SortKey, order: SortOrder) -> tuple[object, int]:
    try:
        raw = base64.urlsafe_b64decode(cursor + "=" * (-len(cursor) % 4))
        c_sort, c_order, value, seq = json.loads(raw)
    except (binascii.Error, ValueError, TypeError) as exc:
        raise InvalidCursor("Malformed cursor") from exc
    if c_sort != sort or c_order != order:
        raise InvalidCursor("Cursor belongs to a different sort; start from the first page")
    if not isinstance(seq, int) or not isinstance(value, int | float | str):
        raise InvalidCursor("Malformed cursor")
    return value, seq


def _ordered(
    filters: BlotterFilters, sort: SortKey, order: SortOrder, cursor: str | None
) -> tuple[Select, object]:
    sessions, where = _sessions(filters)
    key = _sort_column(sessions, sort)
    q = select(sessions, key.label("sort_value"))
    if where is not None:
        q = q.where(where)
    if cursor:
        value, seq = decode_cursor(cursor, sort, order)
        if order == "desc":
            q = q.where(or_(key < value, and_(key == value, sessions.c.seq < seq)))
        else:
            q = q.where(or_(key > value, and_(key == value, sessions.c.seq > seq)))
    if order == "desc":
        q = q.order_by(key.desc(), sessions.c.seq.desc())
    else:
        q = q.order_by(key.asc(), sessions.c.seq.asc())
    return q, sessions


def _utc(ts: datetime | None) -> datetime | None:
    # SQLite CURRENT_TIMESTAMP is UTC but naive.
    return ts.replace(tzinfo=UTC) if ts is not None and ts.tzinfo is None else ts


async def _submissions(db: AsyncSession, session_ids: list[str]) -> dict[str, AuditLog]:
    if not session_ids:
        return {}
    entries = (
        (
            await db.execute(
                select(AuditLog)
                .where(AuditLog.action == "submit", AuditLog.session_id.in_(session_ids))
                .order_by(AuditLog.id)
            )
        )
        .scalars()
        .all()
    )
    return {e.session_id: e for e in entries}


def _row(r, submission: AuditLog | None) -> BlotterRow:
    details = (submission.details or {}) if submission else {}
    sum_mw = r.sum_mw or 0.0
    return BlotterRow(
        session_id=r.session_id,
        submitted_at=_utc(r.submitted_at),
        submitted_by=submission.user if submission else None,
        target_date=r.target_date,
        segment=r.segment,
        strategy=r.strategy,
        block_count=r.block_count,
        volume_mwh=round(sum_mw * HOURS_PER_BLOCK, 4),
        avg_price=round(r.sum_price_mw / sum_mw if sum_mw else r.mean_price, 4),
        value_inr=round((r.sum_price_mw or 0.0) * HOURS_PER_BLOCK * KWH_PER_MWH, 2),
        overrides=r.overrides or 0,
        verdict=details.get("verdict"),
        score=details.get("score"),
        status=r.status,
        priced_blocks=r.priced_blocks,
        cleared_blocks=r.cleared_blocks or 0,
        cleared_mwh=round((r.cleared_mw or 0.0) * HOURS_PER_BLOCK, 4),
        cleared_cost_inr=round((r.cleared_mcp_mw or 0.0) * HOURS_PER_BLOCK * KWH_PER_MWH, 2),
        fill_pct=round(r.fill_pct, 2) if r.fill_pct is not None else None,
    )


async def list_sessions(
    db: AsyncSession,
    filters: BlotterFilters,
    sort: SortKey = "submitted",
    order: SortOrder = "desc",
    limit: int = 50,
    cursor: str | None = None,
) -> tuple[list[BlotterRow], str | None]:
    """A page of sessions and the cursor for the next one, if any."""
    q, _ = _ordered(filters, sort, order, cursor)
    rows = (await db.execute(q.limit(limit + 1))).all()
    page, more = rows[:limit], len(rows) > limit
    submissions = await _submissions(db, [r.session_id for r in page])
    next_cursor = (
        encode_cursor(sort, order, page[-1].sort_value, page[-1].seq) if more and page else None
    )
    return [_row(r, submissions.get(r.session_id)) for r in page], next_cursor


async def totals(db: AsyncSession, filters: BlotterFilters) -> BlotterTotals:
    sessions, where = _sessions(filters)
    q = select(
        func.count(),
        func.coalesce(func.sum(sessions.c.sum_mw), 0.0),
        func.coalesce(func.sum(sessions.c.sum_price_mw), 0.0),
        func.coalesce(func.sum(sessions.c.priced_mw), 0.0),
        func.coalesce(func.sum(sessions.c.cleared_mw), 0.0),
        func.coalesce(func.sum(sessions.c.cleared_mcp_mw), 0.0),
    ).select_from(sessions)
    if where is not None:
        q = q.where(where)
    count, sum_mw, sum_price_mw, priced_mw, cleared_mw, cleared_mcp_mw = (await db.execute(q)).one()
    to_inr = HOURS_PER_BLOCK * KWH_PER_MWH
    return BlotterTotals(
        sessions=count,
        volume_mwh=round(sum_mw * HOURS_PER_BLOCK, 4),
        value_inr=round(sum_price_mw * to_inr, 2),
        priced_volume_mwh=round(priced_mw * HOURS_PER_BLOCK, 4),
        cleared_mwh=round(cleared_mw * HOURS_PER_BLOCK, 4),
        cleared_cost_inr=round(cleared_mcp_mw * to_inr, 2),
    )


async def get_session(
    db: AsyncSession, session_id: str
) -> tuple[BlotterRow, list[BlotterBlock], list[BlotterEvent]] | None:
    """One session with its block bids and audit trail, or None if it does not exist."""
    sessions, _ = _sessions(BlotterFilters(), session_id)
    summary = (await db.execute(select(sessions))).one_or_none()
    if summary is None:
        return None
    submissions = await _submissions(db, [session_id])

    legs = _legs(BlotterFilters(), session_id)
    blocks = [
        BlotterBlock(
            block=leg.block,
            price=leg.price,
            volume_mw=leg.volume_mw,
            mcp=leg.mcp,
            cleared=None if leg.mcp is None else leg.price >= leg.mcp,
            is_overridden=bool(leg.is_overridden),
            override_reason=leg.override_reason,
        )
        for leg in (await db.execute(select(legs).order_by(legs.c.block))).all()
    ]
    entries = (
        (
            await db.execute(
                select(AuditLog).where(AuditLog.session_id == session_id).order_by(AuditLog.id)
            )
        )
        .scalars()
        .all()
    )
    events = [
        BlotterEvent(timestamp=_utc(e.timestamp), user=e.user, action=e.action, details=e.details)
        for e in entries
    ]
    return _row(summary, submissions.get(session_id)), blocks, events


async def export_rows(
    db: AsyncSession, filters: BlotterFilters, sort: SortKey, order: SortOrder, max_rows: int
) -> list[BlotterRow]:
    q, _ = _ordered(filters, sort, order, None)
    rows = (await db.execute(q.limit(max_rows))).all()
    submissions = await _submissions(db, [r.session_id for r in rows])
    return [_row(r, submissions.get(r.session_id)) for r in rows]
