"""
Blotter endpoints.

  GET /blotter                 submitted bid sessions: filters, sorting, keyset pagination
  GET /blotter/export          the same rows as CSV
  GET /blotter/{session_id}    one session with its block bids and audit trail
"""

from __future__ import annotations

import csv
import io
from datetime import UTC, datetime

from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi import Path as PathParam
from fastapi.responses import Response
from sqlalchemy.ext.asyncio import AsyncSession

from common.database import get_db
from common.schemas import BlotterDetail, BlotterPage, BlotterStatus

from .queries import (
    BlotterFilters,
    InvalidCursor,
    SortKey,
    SortOrder,
    export_rows,
    get_session,
    list_sessions,
    totals,
)

router = APIRouter(prefix="/blotter", tags=["Blotter"])

DATE_PATTERN = r"^\d{4}-\d{2}-\d{2}$"
# Exports are capped so a single request stays bounded.
EXPORT_MAX_ROWS = 10_000

EXPORT_COLUMNS = [
    "session_id",
    "submitted_at_utc",
    "submitted_by",
    "delivery_date",
    "segment",
    "strategy",
    "blocks",
    "volume_mwh",
    "avg_price_inr_per_kwh",
    "value_inr",
    "overrides",
    "verdict",
    "score",
    "status",
    "cleared_blocks",
    "cleared_mwh",
    "fill_pct",
    "cleared_cost_inr",
]


def blotter_filters(
    segment: str | None = Query(None, pattern=r"^(DAM|RTM|TAM)$"),
    strategy: str | None = Query(None, pattern=r"^(conservative|balanced|aggressive)$"),
    status: BlotterStatus | None = Query(None),
    delivery_from: str | None = Query(None, pattern=DATE_PATTERN),
    delivery_to: str | None = Query(None, pattern=DATE_PATTERN),
    trader: str | None = Query(None, max_length=100, description="Exact submitting user"),
    q: str | None = Query(None, pattern=r"^[0-9a-fA-F-]{1,36}$", description="Session id prefix"),
) -> BlotterFilters:
    return BlotterFilters(
        segment=segment,
        strategy=strategy,
        status=status,
        delivery_from=delivery_from,
        delivery_to=delivery_to,
        trader=trader,
        session_prefix=q.lower() if q else None,
    )


@router.get("", response_model=BlotterPage)
async def get_blotter(
    filters: BlotterFilters = Depends(blotter_filters),
    sort: SortKey = Query("submitted"),
    order: SortOrder = Query("desc"),
    limit: int = Query(50, ge=1, le=500),
    cursor: str | None = Query(None, max_length=512),
    db: AsyncSession = Depends(get_db),
):
    """
    Submitted bid sessions, newest first by default.

    Totals cover every session matching the filters, not only the returned page.
    Pass `next_cursor` back as `cursor` with the same filters and sort for the next page.
    """
    try:
        rows, next_cursor = await list_sessions(db, filters, sort, order, limit, cursor)
    except InvalidCursor as exc:
        raise HTTPException(400, str(exc)) from exc
    return BlotterPage(rows=rows, next_cursor=next_cursor, totals=await totals(db, filters))


@router.get("/export")
async def export_blotter(
    filters: BlotterFilters = Depends(blotter_filters),
    sort: SortKey = Query("submitted"),
    order: SortOrder = Query("desc"),
    db: AsyncSession = Depends(get_db),
):
    """Every session matching the filters as CSV, up to 10,000 rows."""
    rows = await export_rows(db, filters, sort, order, EXPORT_MAX_ROWS)
    buffer = io.StringIO()
    # A byte-order mark makes Excel read the file as UTF-8.
    buffer.write("\ufeff")
    writer = csv.writer(buffer, lineterminator="\n")
    writer.writerow(EXPORT_COLUMNS)
    for r in rows:
        writer.writerow(
            [
                r.session_id,
                r.submitted_at.isoformat() if r.submitted_at else "",
                r.submitted_by or "",
                r.target_date,
                r.segment,
                r.strategy,
                r.block_count,
                r.volume_mwh,
                r.avg_price,
                r.value_inr,
                r.overrides,
                r.verdict or "",
                "" if r.score is None else r.score,
                r.status,
                r.cleared_blocks,
                r.cleared_mwh,
                "" if r.fill_pct is None else r.fill_pct,
                r.cleared_cost_inr,
            ]
        )
    stamp = datetime.now(UTC).strftime("%Y%m%d-%H%M%S")
    return Response(
        content=buffer.getvalue(),
        media_type="text/csv; charset=utf-8",
        headers={"Content-Disposition": f'attachment; filename="blotter-{stamp}.csv"'},
    )


@router.get("/{session_id}", response_model=BlotterDetail)
async def get_blotter_session(
    session_id: str = PathParam(..., pattern=r"^[0-9a-fA-F-]{36}$"),
    db: AsyncSession = Depends(get_db),
):
    """One submitted session with every block bid, its clearing result and the audit trail."""
    found = await get_session(db, session_id.lower())
    if found is None:
        raise HTTPException(404, f"No submitted session {session_id}")
    session, blocks, events = found
    return BlotterDetail(session=session, blocks=blocks, events=events)
