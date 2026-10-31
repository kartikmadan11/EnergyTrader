import pytest
from sqlalchemy.exc import IntegrityError

from common.models import Bid, Forecast, PriceHistory

DATE = "2026-06-01"
BLOCKS = range(1, 97)
DRAFT = "6f1c2b8e-4d3a-4f5b-9a7c-2e1d0c9b8a76"


def _forecast_rows(segment: str = "DAM") -> list[Forecast]:
    rows = []
    for b in BLOCKS:
        price = 5.0 + (b % 8) * 0.25
        rows.append(
            Forecast(
                target_date=DATE,
                block=b,
                segment=segment,
                predicted_price=price,
                confidence_low=price - 0.5,
                confidence_high=price + 0.5,
                volatility=0.4,
            )
        )
    return rows


def _actual_rows(mcp: float, segment: str = "DAM") -> list[PriceHistory]:
    return [PriceHistory(date=DATE, block=b, segment=segment, mcp=mcp) for b in BLOCKS]


def _bid_items(price: float = 5.0, blocks=BLOCKS, segment: str = "DAM") -> list[dict]:
    return [{"block": b, "segment": segment, "price": price, "volume_mw": 5.0} for b in blocks]


def _actions(client) -> list[str]:
    return [e["action"] for e in client.get("/api/audit/log").json()]


def test_health(client):
    assert client.get("/api/health").json() == {"status": "ok", "service": "energytrader-api"}


def test_recommend_trade_review_flow(client, seed):
    seed(*_forecast_rows())

    recs = client.get(
        "/api/bids/recommend",
        params={"target_date": DATE, "segment": "DAM", "strategy": "balanced", "demand_mw": 500},
    )
    assert recs.status_code == 200
    bids = [{k: r[k] for k in ("block", "segment", "price", "volume_mw")} for r in recs.json()]
    assert len(bids) == 96

    query = {"target_date": DATE, "segment": "DAM", "strategy": "balanced"}
    checks = client.post(
        "/api/bids/request-approval", params={**query, "session_id": "draft-1"}, json=bids
    )
    assert checks.status_code == 200
    assert checks.json()["can_submit"], checks.json()["summary"]

    submitted = client.post("/api/bids/submit", params=query, json=bids)
    assert submitted.status_code == 200
    session_id = submitted.json()["session_id"]
    assert submitted.json()["bid_count"] == 96

    # Clear at 5.5 INR/kWh: bids priced at or above it clear, the rest do not.
    seed(*_actual_rows(mcp=5.5))
    review = client.get("/api/audit/post-market", params={"target_date": DATE, "segment": "DAM"})
    assert review.status_code == 200
    body = review.json()
    assert body["session_id"] == session_id
    assert len(body["blocks"]) == 96
    expected_hits = sum(b["price"] >= 5.5 for b in bids) / 96 * 100
    assert body["bid_hit_rate"] == pytest.approx(expected_hits, abs=0.01)
    assert 0 < body["bid_hit_rate"] < 100
    assert body["uncleared_dsm_exposure"] > 0
    assert body["mape"] is not None

    assert _actions(client)[:2] == ["submit", "pre_trade_check"]


def test_a_checked_draft_is_submitted_once_under_its_own_id(client, seed):
    seed(*_forecast_rows())
    query = {"target_date": DATE, "segment": "DAM", "session_id": DRAFT}
    bids = _bid_items()
    assert client.post("/api/bids/request-approval", params=query, json=bids).status_code == 200

    submitted = client.post("/api/bids/submit", params=query, json=bids)
    assert submitted.status_code == 200, submitted.text
    assert submitted.json()["session_id"] == DRAFT

    again = client.post("/api/bids/submit", params=query, json=bids)
    assert again.status_code == 409
    assert again.json()["detail"] == "This bid set has already been submitted."

    detail = client.get(f"/api/blotter/{DRAFT}").json()
    assert [e["action"] for e in detail["events"]] == ["pre_trade_check", "submit"]
    assert len(detail["blocks"]) == 96


@pytest.mark.parametrize("session_id", ["draft-1", DRAFT.upper(), DRAFT[:-1]])
def test_submit_accepts_only_a_canonical_session_id(client, seed, session_id):
    seed(*_forecast_rows())
    response = client.post(
        "/api/bids/submit",
        params={"target_date": DATE, "segment": "DAM", "session_id": session_id},
        json=_bid_items(),
    )
    assert response.status_code == 422
    assert "submit" not in _actions(client)


def test_a_session_holds_one_bid_per_block(client, seed):
    bid = {"session_id": DRAFT, "target_date": DATE, "block": 1, "segment": "DAM"}
    seed(Bid(**bid, price=5.0, volume_mw=5.0))
    with pytest.raises(IntegrityError):
        seed(Bid(**bid, price=6.0, volume_mw=2.0))


def test_submit_is_blocked_when_pre_trade_checks_fail(client, seed):
    seed(*_forecast_rows())
    response = client.post(
        "/api/bids/submit",
        params={"target_date": DATE, "segment": "DAM"},
        json=_bid_items(blocks=range(1, 90)),
    )

    assert response.status_code == 422
    detail = response.json()["detail"]
    assert detail["verdict"] == "NEEDS_REVISION"
    assert any(c["name"] == "coverage" and c["status"] == "fail" for c in detail["checks"])
    assert "submit" not in _actions(client)


def test_submit_rejects_bids_for_another_segment(client):
    response = client.post(
        "/api/bids/submit",
        params={"target_date": DATE, "segment": "DAM"},
        json=_bid_items(segment="RTM"),
    )
    assert response.status_code == 422
    assert "not DAM bids" in response.json()["detail"]


def test_recommend_requires_a_stored_forecast(client):
    response = client.get("/api/bids/recommend", params={"target_date": DATE, "segment": "DAM"})
    assert response.status_code == 400


def test_predict_without_a_trained_model_is_unavailable(client):
    response = client.get("/api/forecast/predict", params={"target_date": DATE, "segment": "DAM"})
    assert response.status_code == 503
    assert "No trained model" in response.json()["detail"]


def test_post_market_needs_actuals_then_a_forecast_or_bids(client, seed):
    params = {"target_date": DATE, "segment": "DAM"}
    assert client.get("/api/audit/post-market", params=params).status_code == 400

    seed(*_actual_rows(mcp=5.0))
    assert client.get("/api/audit/post-market", params=params).status_code == 404

    seed(*_forecast_rows())
    review = client.get("/api/audit/post-market", params=params).json()
    assert review["session_id"] is None
    assert review["bid_hit_rate"] == 0


def test_policy_activation_is_validated_and_audited(client, policies_dir):
    for bad in ("no_such_policy", "..%2F..%2Fmain", "Bad.Id"):
        assert client.post(f"/api/policy/activate/{bad}").status_code == 404
    assert not (policies_dir / "active_policy.txt").exists()

    assert client.post("/api/policy/activate/cerc_dsm_2019").status_code == 200
    assert client.get("/api/policy/active").json()["regulation_id"] == "cerc_dsm_2019"

    entry = client.get("/api/audit/log", params={"action": "policy_activate"}).json()[0]
    assert entry["details"] == {"from": "cerc_dsm_2024_draft", "to": "cerc_dsm_2019"}


def test_policy_update_validates_values(client):
    invalid = client.put("/api/policy/cerc_dsm_2019", json={"deviation_band": 2.0})
    assert invalid.status_code == 422

    valid = client.put("/api/policy/cerc_dsm_2019", json={"penalty_rate": 1.75})
    assert valid.status_code == 200
    assert client.get("/api/policy/list").status_code == 200
    assert "policy_update" in _actions(client)


def test_policy_compare_reports_direction(client):
    response = client.get(
        "/api/policy/compare",
        params={"policy_a": "cerc_dsm_2019", "policy_b": "cerc_dsm_2024_draft"},
    )
    assert response.status_code == 200
    diffs = {d["field"]: d["direction"] for d in response.json()["diffs"]}
    assert diffs["deviation_band"] == "stricter"
    assert diffs["penalty_rate"] == "stricter"
