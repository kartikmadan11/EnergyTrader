from types import SimpleNamespace

import pytest

from approval_service.checks import run_pre_trade_checks
from common.schemas import ConstraintViolation

ALL_BLOCKS = range(1, 97)
SAFE_RISK = {
    "total_exposure": 1_000.0,
    "var_threshold": 500_000.0,
    "alert_triggered": False,
    "var_95": 900.0,
    "expected_dsm_penalty": 100.0,
}
BREACHED_RISK = {**SAFE_RISK, "total_exposure": 600_000.0, "alert_triggered": True}


def _bids(price: float = 5.0, blocks=ALL_BLOCKS, overridden: int = 0) -> list[SimpleNamespace]:
    return [SimpleNamespace(block=b, price=price, is_overridden=b <= overridden) for b in blocks]


def _forecasts(price: float = 5.0, half_width: float = 1.0) -> dict[int, SimpleNamespace]:
    return {
        b: SimpleNamespace(
            predicted_price=price,
            confidence_low=price - half_width,
            confidence_high=price + half_width,
        )
        for b in ALL_BLOCKS
    }


@pytest.fixture
def run(policy):
    def _run(bids=None, forecasts=None, violations=None, risk=SAFE_RISK, strategy="balanced"):
        return run_pre_trade_checks(
            _bids() if bids is None else bids,
            _forecasts() if forecasts is None else forecasts,
            violations or {},
            risk,
            strategy,
            policy,
        )

    return _run


def _check(result: dict, name: str) -> dict:
    return next(c for c in result["checks"] if c["name"] == name)


def _status(result: dict, name: str) -> str:
    return _check(result, name)["status"]


def test_clean_bid_set_is_approved(run):
    result = run()
    assert result["verdict"] == "APPROVED"
    assert result["score"] == 100.0
    assert result["can_submit"]
    assert len(result["checks"]) == 7
    assert _check(result, "override_ratio")["message"] == "No manual overrides."


def test_missing_block_needs_revision(run):
    result = run(bids=_bids(blocks=range(1, 96)))
    assert _status(result, "coverage") == "fail"
    assert result["verdict"] == "NEEDS_REVISION"
    assert not result["can_submit"]
    coverage = _check(result, "coverage")
    assert coverage["affected_blocks"] == [96]
    assert coverage["message"] == "1 of 96 blocks has no bid."


def test_duplicate_block_fails_coverage(run):
    assert _status(run(bids=_bids() + _bids(blocks=[7])), "coverage") == "fail"


def test_two_hard_failures_reject(run):
    result = run(bids=_bids(blocks=range(1, 96)), risk=BREACHED_RISK)
    assert result["verdict"] == "REJECTED"
    assert not result["can_submit"]


def test_constraint_violation_fails(run):
    violation = ConstraintViolation(block=3, field="price", value=13, limit=12, message="ceiling")
    result = run(violations={3: [violation], 4: []})
    check = _check(result, "constraint_compliance")
    assert check["status"] == "fail"
    assert check["affected_blocks"] == [3]
    assert check["message"].startswith("1 block breaks the ")


def test_bid_at_the_ceiling_fails(run, policy):
    assert _status(run(bids=_bids(price=policy.price_ceiling)), "price_ceiling") == "fail"


@pytest.mark.parametrize(("strategy", "status"), [("balanced", "warn"), ("aggressive", "pass")])
def test_near_ceiling_bids_warn_outside_the_aggressive_strategy(run, policy, strategy, status):
    near = policy.price_ceiling * 0.95
    result = run(bids=_bids(price=near), forecasts=_forecasts(price=near), strategy=strategy)
    assert _status(result, "price_ceiling") == status


def test_heavy_manual_editing_is_flagged_but_submittable(run):
    result = run(bids=_bids(overridden=50))
    assert _status(result, "override_ratio") == "warn"
    assert result["verdict"] == "APPROVED_WITH_FLAGS"
    assert result["summary"] == "Cleared for submission with 1 flag: override ratio."
    assert result["can_submit"]


@pytest.mark.parametrize(("strategy", "bid_price"), [("conservative", 6.0), ("aggressive", 4.5)])
def test_bids_inconsistent_with_the_strategy_are_flagged(run, strategy, bid_price):
    result = run(bids=_bids(price=bid_price), strategy=strategy)
    assert _status(result, "strategy_alignment") == "fail"
    assert result["verdict"] == "APPROVED_WITH_FLAGS"


def test_missing_forecasts_warn_and_skip_strategy_alignment(run):
    result = run(forecasts={})
    assert _status(result, "forecast_confidence") == "warn"
    assert "strategy_alignment" not in {c["name"] for c in result["checks"]}


def test_wide_forecast_intervals_warn(run):
    # Width 14 on a price of 5 is 2.8x, above the 2.5x limit, on every block.
    assert _status(run(forecasts=_forecasts(half_width=7.0)), "forecast_confidence") == "warn"
