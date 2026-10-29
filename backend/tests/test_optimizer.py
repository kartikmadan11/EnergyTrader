import pytest

from bid_engine_service.optimizer import generate_recommendations, validate_constraints
from common.config import NUM_BLOCKS, STRATEGY_PROFILES

DEMAND_MW = 500.0


def _forecasts(base_price: float = 5.0) -> list[dict]:
    """A 96-block forecast with an intraday shape and a 1 INR/kWh interval."""
    rows = []
    for block in range(1, NUM_BLOCKS + 1):
        price = base_price + (block % 8) * 0.25
        rows.append(
            {
                "block": block,
                "predicted_price": price,
                "confidence_low": price - 0.5,
                "confidence_high": price + 0.5,
                "volatility": 0.4,
            }
        )
    return rows


@pytest.mark.parametrize("strategy", sorted(STRATEGY_PROFILES))
def test_recommendations_respect_policy_and_volume_limits(policy, strategy):
    recs = generate_recommendations(_forecasts(), strategy, DEMAND_MW, "DAM")

    assert [r["block"] for r in recs] == list(range(1, NUM_BLOCKS + 1))
    per_block_cap = DEMAND_MW / NUM_BLOCKS * 4.0
    for r in recs:
        assert policy.price_floor < r["price"] < policy.price_ceiling
        assert policy.technical_minimum_mw <= r["volume_mw"] <= per_block_cap + 0.05
        assert r["constraint_violations"] == []
        assert r["active_policy"] == policy.regulation_id

    # Each block volume is rounded to 0.1 MW, so allow half of that per block.
    volume_cap = DEMAND_MW * STRATEGY_PROFILES[strategy]["volume_scale"]
    assert sum(r["volume_mw"] for r in recs) <= volume_cap + 0.05 * NUM_BLOCKS


def _average_bid_price(strategy: str) -> float:
    recs = generate_recommendations(_forecasts(), strategy, DEMAND_MW, "DAM")
    return sum(r["price"] for r in recs) / NUM_BLOCKS


def test_strategy_offsets_order_bid_prices(policy):
    conservative, balanced, aggressive = map(
        _average_bid_price, ("conservative", "balanced", "aggressive")
    )
    assert conservative < balanced < aggressive


def test_risk_weights_scale_with_risk_tolerance(policy):
    recs = generate_recommendations(
        _forecasts(), "balanced", DEMAND_MW, "DAM", risk_tolerance_override=1.0
    )
    assert recs[0]["effective_lambda1"] == 0.0
    assert recs[0]["effective_lambda2"] == 0.0


def test_bid_prices_are_clamped_inside_the_price_band(policy):
    recs = generate_recommendations(_forecasts(base_price=20.0), "aggressive", DEMAND_MW, "DAM")
    assert {r["price"] for r in recs} == {round(policy.price_ceiling - 0.01, 4)}


def test_missing_interval_and_volatility_fall_back_to_a_default_band(policy):
    forecasts = [
        {**fc, "confidence_low": None, "confidence_high": None, "volatility": None}
        for fc in _forecasts()
    ]
    recs = generate_recommendations(forecasts, "balanced", DEMAND_MW, "DAM")

    assert len(recs) == NUM_BLOCKS
    # The fallback band is the prediction plus or minus 10%.
    first = forecasts[0]["predicted_price"]
    assert recs[0]["uncertainty_score"] == pytest.approx(0.2 * first, abs=1e-3)


def test_validate_constraints_flags_price_band_and_technical_minimum(policy):
    assert validate_constraints(1, 5.0, 10.0, "DAM", policy) == []

    above = validate_constraints(1, policy.price_ceiling + 1, 10.0, "DAM", policy)
    assert [v.field for v in above] == ["price"]

    below_min = validate_constraints(1, 5.0, 0.5, "RTM", policy)
    assert [v.field for v in below_min] == ["volume_mw"]
    assert below_min[0].limit == policy.technical_minimum_mw


def test_technical_minimum_does_not_apply_to_tam(policy):
    assert validate_constraints(1, 5.0, 0.5, "TAM", policy) == []
