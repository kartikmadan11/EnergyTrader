import csv
import io

import pytest

from common import auth
from common.auth import Actor, encode_token
from common.models import AuditLog, Bid, Forecast, PriceHistory

DATE = "2026-06-01"
LATER = "2026-06-02"
BLOCKS = range(1, 97)


def _sid(n: int) -> str:
    return f"{n:08x}-0000-4000-8000-000000000000"


def _session(
    n: int,
    *,
    date: str = DATE,
    segment: str = "DAM",
    strategy: str = "balanced",
    price=5.0,
    volume: float = 4.0,
    blocks=BLOCKS,
    user: str = "local",
) -> list:
    """One submitted session: its block bids and the submit audit entry."""
    rows: list = [
        Bid(
            session_id=_sid(n),
            target_date=date,
            block=b,
            segment=segment,
            strategy=strategy,
            price=price(b) if callable(price) else price,
            volume_mw=volume,
            status="submitted",
        )
        for b in blocks
    ]
    rows.append(
        AuditLog(
            session_id=_sid(n),
            user=user,
            action="submit",
            entity_type="bid",
            details={"verdict": "pass", "score": 90 + n},
        )
    )
    return rows


def _prices(mcp: float, date: str = DATE, segment: str = "DAM", blocks=BLOCKS) -> list:
    return [PriceHistory(date=date, block=b, segment=segment, mcp=mcp) for b in blocks]


def _rows(client, **params) -> list[dict]:
    response = client.get("/api/blotter", params={"limit": 500, **params})
    assert response.status_code == 200, response.text
    return response.json()["rows"]


def _ids(rows: list[dict]) -> list[str]:
    return [r["session_id"] for r in rows]


def test_empty_blotter(client):
    body = client.get("/api/blotter").json()
    assert body["rows"] == [] and body["next_cursor"] is None
    assert body["totals"]["sessions"] == 0 and body["totals"]["value_inr"] == 0


def test_session_is_aggregated_into_one_row(client, seed):
    seed(*_session(1, user="github:desk-north"))

    body = client.get("/api/blotter").json()
    (row,) = body["rows"]
    # 96 blocks of 4 MW for 15 minutes is 96 MWh; at 5 INR/kWh that is 480,000 INR.
    assert row["session_id"] == _sid(1)
    assert row["block_count"] == 96
    assert row["volume_mwh"] == 96
    assert row["avg_price"] == 5.0
    assert row["value_inr"] == 480_000
    assert row["submitted_by"] == "github:desk-north"
    assert (row["verdict"], row["score"]) == ("pass", 91)
    assert row["submitted_at"].endswith("Z") or row["submitted_at"].endswith("+00:00")
    assert (row["status"], row["fill_pct"], row["priced_blocks"]) == ("pending", None, 0)
    assert body["totals"]["volume_mwh"] == 96 and body["totals"]["value_inr"] == 480_000


def test_average_price_is_volume_weighted(client, seed):
    seed(
        *_session(1, price=4.0, blocks=[1]),
        Bid(session_id=_sid(1), target_date=DATE, block=2, segment="DAM", price=8.0, volume_mw=3),
    )
    (row,) = _rows(client)
    # (4 * 4 + 8 * 3) / 7
    assert row["avg_price"] == pytest.approx(40 / 7, abs=1e-4)


def test_status_follows_published_clearing_prices(client, seed):
    seed(
        *_session(1, price=6.0),
        *_session(2, price=5.0),
        *_session(3, price=lambda b: 6.0 if b % 2 == 0 else 5.0),
        *_session(4, date=LATER),
        *_prices(5.5),
    )
    rows = {r["session_id"]: r for r in _rows(client)}

    cleared, missed, partial, pending = (rows[_sid(n)] for n in range(1, 5))
    assert (cleared["status"], cleared["fill_pct"], cleared["cleared_blocks"]) == (
        "cleared",
        100,
        96,
    )
    # Cleared volume is paid at the clearing price, not the bid price.
    assert cleared["cleared_cost_inr"] == 5.5 * 96 * 1000
    assert (missed["status"], missed["fill_pct"], missed["cleared_mwh"]) == ("not_cleared", 0, 0)
    assert (partial["status"], partial["fill_pct"], partial["cleared_blocks"]) == (
        "partial",
        50,
        48,
    )
    assert (pending["status"], pending["fill_pct"]) == ("pending", None)

    assert _ids(_rows(client, status="partial")) == [_sid(3)]
    totals = client.get("/api/blotter", params={"status": "cleared"}).json()["totals"]
    assert (totals["sessions"], totals["cleared_mwh"]) == (1, 96)


def test_a_partly_published_day_is_partial(client, seed):
    seed(*_session(1, price=6.0), *_prices(5.5, blocks=range(1, 49)))
    (row,) = _rows(client)
    assert (row["status"], row["priced_blocks"], row["cleared_blocks"]) == ("partial", 48, 48)


def test_prices_for_another_segment_do_not_clear_a_session(client, seed):
    seed(*_session(1, price=6.0), *_prices(5.5, segment="RTM"))
    assert _rows(client)[0]["status"] == "pending"


def test_filters(client, seed):
    seed(
        *_session(1, segment="DAM", strategy="balanced", user="github:desk-north"),
        *_session(2, segment="RTM", strategy="aggressive", blocks=range(1, 5)),
        *_session(3, date=LATER, strategy="conservative", user="vercel:desk-south"),
    )
    assert _ids(_rows(client, segment="RTM")) == [_sid(2)]
    assert _ids(_rows(client, strategy="conservative")) == [_sid(3)]
    assert _ids(_rows(client, delivery_from=LATER)) == [_sid(3)]
    assert _ids(_rows(client, delivery_to=DATE)) == [_sid(2), _sid(1)]
    assert _ids(_rows(client, trader="github:desk-north")) == [_sid(1)]
    assert _ids(_rows(client, q="00000002")) == [_sid(2)]
    assert _ids(_rows(client, q="0000000")) == [_sid(3), _sid(2), _sid(1)]
    assert _rows(client, segment="RTM", trader="vercel:desk-south") == []


@pytest.mark.parametrize(
    "params",
    [
        {"segment": "NYMEX"},
        {"status": "filled"},
        {"delivery_from": "01-06-2026"},
        {"q": "%"},
        {"sort": "price"},
        {"order": "up"},
        {"limit": 0},
        {"limit": 501},
    ],
)
def test_invalid_parameters_are_rejected(client, params):
    assert client.get("/api/blotter", params=params).status_code == 422


# Sessions chosen so every sort key has ties, which the session sequence must break.
LADDER = [
    # (n, date, volume MW per block, bid price, blocks)
    (1, DATE, 2.0, 6.0, range(1, 5)),
    (2, LATER, 4.0, 5.0, range(1, 5)),
    (3, DATE, 2.0, 5.0, range(1, 5)),
    (4, LATER, 1.0, 6.0, range(1, 9)),
    (5, DATE, 4.0, 4.0, range(1, 3)),
    (6, LATER, 2.0, 6.0, range(1, 5)),
    (7, DATE, 3.0, 5.5, range(1, 3)),
]


@pytest.fixture
def ladder(client, seed):
    rows: list = []
    for n, date, volume, price, blocks in LADDER:
        rows += _session(n, date=date, volume=volume, price=price, blocks=blocks)
    seed(*rows, *_prices(5.5, date=DATE))
    return client


SORT_KEYS = {
    "submitted": lambda r: 0,
    "delivery": lambda r: r["target_date"],
    "volume": lambda r: r["volume_mwh"],
    "value": lambda r: r["value_inr"],
    "fill": lambda r: -1 if r["fill_pct"] is None else r["fill_pct"],
}


@pytest.mark.parametrize("order", ["desc", "asc"])
@pytest.mark.parametrize("sort", list(SORT_KEYS))
def test_keyset_pagination_walks_every_row_once_in_order(ladder, sort, order):
    seen, cursor, pages = [], None, 0
    while True:
        params = {"sort": sort, "order": order, "limit": 3}
        if cursor:
            params["cursor"] = cursor
        body = ladder.get("/api/blotter", params=params).json()
        seen += body["rows"]
        pages += 1
        assert body["totals"]["sessions"] == len(LADDER)
        cursor = body["next_cursor"]
        if cursor is None:
            break

    assert pages == 3
    seq = {_sid(n): n for n, *_ in LADDER}
    expected = sorted(
        seen, key=lambda r: (SORT_KEYS[sort](r), seq[r["session_id"]]), reverse=order == "desc"
    )
    assert _ids(seen) == _ids(expected)
    assert sorted(_ids(seen)) == sorted(seq)


def test_cursor_from_another_sort_is_rejected(ladder):
    cursor = ladder.get("/api/blotter", params={"sort": "volume", "limit": 2}).json()["next_cursor"]
    response = ladder.get("/api/blotter", params={"sort": "delivery", "cursor": cursor})
    assert response.status_code == 400
    assert "different sort" in response.json()["detail"]


@pytest.mark.parametrize("cursor", ["!!!", "W10", "WyJzdWJtaXR0ZWQiLCJkZXNjIiwxLCJ4Il0"])
def test_malformed_cursor_is_rejected(client, cursor):
    response = client.get("/api/blotter", params={"cursor": cursor})
    assert response.status_code == 400
    assert response.json()["detail"] == "Malformed cursor"


def test_csv_export(ladder):
    response = ladder.get("/api/blotter/export", params={"delivery_from": LATER, "sort": "volume"})
    assert response.status_code == 200
    assert response.headers["content-type"] == "text/csv; charset=utf-8"
    assert response.headers["content-disposition"].startswith('attachment; filename="blotter-')

    assert response.content.startswith(b"\xef\xbb\xbf")
    text = response.content.decode("utf-8-sig")
    records = list(csv.DictReader(io.StringIO(text)))
    # Equal volumes fall back to the newest session first.
    assert [r["session_id"] for r in records] == [_sid(2), _sid(6), _sid(4)]
    assert records[0]["volume_mwh"] == "4.0"
    assert records[0]["status"] == "pending" and records[0]["fill_pct"] == ""


def test_session_detail(client, seed):
    sid = _sid(0xABCDEF)
    seed(*_session(0xABCDEF, price=lambda b: 6.0 if b <= 2 else 5.0, blocks=range(1, 5)))
    seed(*_prices(5.5, blocks=range(1, 4)))

    # Session ids are matched case-insensitively.
    response = client.get(f"/api/blotter/{sid.upper()}")
    assert response.status_code == 200
    body = response.json()
    assert body["session"]["status"] == "partial"
    assert [(b["block"], b["mcp"], b["cleared"]) for b in body["blocks"]] == [
        (1, 5.5, True),
        (2, 5.5, True),
        (3, 5.5, False),
        (4, None, None),
    ]
    assert [e["action"] for e in body["events"]] == ["submit"]


def test_unknown_or_malformed_session(client):
    assert client.get(f"/api/blotter/{_sid(99)}").status_code == 404
    assert client.get("/api/blotter/not-a-session").status_code == 422


def test_submitted_sessions_appear_under_the_signed_in_user(client, seed, monkeypatch):
    secret = "blotter-test-secret"
    monkeypatch.setattr(auth, "API_AUTH_SECRET", secret)
    headers = {
        "Authorization": f"Bearer {encode_token(Actor('vercel:desk-east', 'Desk East'), secret)}"
    }
    seed(
        *[
            Forecast(
                target_date=DATE,
                block=b,
                segment="DAM",
                predicted_price=5.0,
                confidence_low=4.5,
                confidence_high=5.5,
                volatility=0.4,
            )
            for b in BLOCKS
        ]
    )
    bids = [{"block": b, "segment": "DAM", "price": 5.0, "volume_mw": 5.0} for b in BLOCKS]
    submitted = client.post(
        "/api/bids/submit",
        params={"target_date": DATE, "segment": "DAM", "strategy": "balanced"},
        json=bids,
        headers=headers,
    )
    assert submitted.status_code == 200, submitted.text

    rows = client.get(
        "/api/blotter", params={"trader": "vercel:desk-east"}, headers=headers
    ).json()["rows"]
    assert _ids(rows) == [submitted.json()["session_id"]]
    assert rows[0]["submitted_by"] == "vercel:desk-east"
    assert rows[0]["volume_mwh"] == 120
