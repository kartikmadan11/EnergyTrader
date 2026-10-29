from types import SimpleNamespace

import pytest

from risk_service import engine


def _bid(block: int = 1, price: float = 5.0, volume_mw: float = 10.0) -> SimpleNamespace:
    return SimpleNamespace(block=block, price=price, volume_mw=volume_mw)


def _forecast(price: float = 5.0, half_width: float = 1.0) -> SimpleNamespace:
    return SimpleNamespace(
        predicted_price=price, confidence_low=price - half_width, confidence_high=price + half_width
    )


def _row(volume_mw: float = 100.0, price: float = 5.0, sigma: float = 1.0) -> engine.BlockRisk:
    return engine.BlockRisk(
        block=1,
        bid_price=price,
        volume_mw=volume_mw,
        predicted_price=price,
        sigma=sigma,
        has_forecast=True,
    )


def test_sigma_is_recovered_from_the_95_percent_interval():
    (row,) = engine.block_risks([_bid()], {1: _forecast(half_width=1.96)})
    assert row.sigma == pytest.approx(1.0)
    assert row.has_forecast


def test_block_without_forecast_falls_back_to_bid_price():
    (row,) = engine.block_risks([_bid(price=5.0)], {})
    assert row.predicted_price == 5.0
    assert row.sigma == pytest.approx(5.0 * engine.FALLBACK_SIGMA_FRACTION)
    assert not row.has_forecast


def test_cost_at_risk_sums_block_sigmas():
    # 100 MW for 15 minutes is 25,000 kWh, so sigma 1 INR/kWh is INR 25,000 per unit of z.
    assert engine.cost_at_risk([_row()]) == pytest.approx(engine.Z_95 * 25_000, abs=0.01)
    assert engine.cost_at_risk([_row(), _row()]) == pytest.approx(
        2 * engine.Z_95 * 25_000, abs=0.01
    )


def test_volume_uncertainty_is_clamped():
    lo, hi = engine.VOLUME_UNCERTAINTY_RANGE
    assert engine.volume_uncertainty([_row(sigma=0.001)]) == lo
    assert engine.volume_uncertainty([_row(sigma=5.0)]) == hi
    assert engine.volume_uncertainty([]) == lo


def test_dsm_exposure_is_zero_inside_the_band_but_not_under_stress(policy):
    # A 2% relative half-width stays inside the 7% band; the 30% stress case does not.
    dsm = engine.dsm_exposure([_row(sigma=0.05)], policy)
    assert dsm["expected"] == 0.0
    assert dsm["penalized_blocks"] == 0
    assert dsm["worst_case"] > 0


def test_assess_risk_raises_an_alert_above_the_threshold(policy):
    bids = [_bid(block=b, volume_mw=50.0) for b in range(1, 97)]
    forecasts = {b: _forecast() for b in range(1, 97)}

    alerted = engine.assess_risk(bids, forecasts, policy, var_threshold=1.0)
    quiet = engine.assess_risk(bids, forecasts, policy, var_threshold=1e12)

    assert alerted["alert_triggered"]
    assert alerted["alert_details"]["breakdown"] == {
        "var_95": alerted["var_95"],
        "expected_penalty": alerted["expected_dsm_penalty"],
    }
    assert alerted["total_exposure"] == pytest.approx(
        alerted["var_95"] + alerted["expected_dsm_penalty"], abs=0.01
    )
    assert alerted["expected_dsm_penalty"] > 0
    assert alerted["forecast_coverage"] == 96
    assert alerted["policy_id"] == policy.regulation_id

    assert not quiet["alert_triggered"]
    assert quiet["alert_details"] is None
