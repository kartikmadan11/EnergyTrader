import pytest
from pydantic import ValidationError

from common import dsm_policy
from common.dsm_policy import DSMPolicy


def _policy(**overrides) -> DSMPolicy:
    fields = {
        "regulation_id": "test_policy",
        "name": "Test policy",
        "price_floor": 0.0,
        "price_ceiling": 12.0,
        "deviation_band": 0.10,
        "penalty_rate": 2.0,
        "severe_deviation_threshold": 0.20,
        "severe_penalty_multiplier": 1.5,
        "technical_minimum_mw": 1.0,
    }
    return DSMPolicy(**{**fields, **overrides})


# 4 INR/kWh x penalty rate 2.0 x 0.25 h x 1000 kWh/MWh: INR 2,000 per MW beyond the band.
RATE = 2000.0


@pytest.mark.parametrize(
    ("delivered_mw", "expected"),
    [
        (100.0, 0.0),
        (110.0, 0.0),  # exactly at the 10% band
        (115.0, 5 * RATE),  # 5 MW beyond the band
        (85.0, 5 * RATE),  # under-delivery is charged the same way
        (130.0, 20 * RATE + 10 * RATE * 0.5),  # 10 MW of it also beyond the 20% severe threshold
    ],
)
def test_penalty_cost_tiers(delivered_mw, expected):
    charge = _policy().penalty_cost(delivered_mw, 100.0, price=4.0, duration_hours=0.25)
    assert charge == pytest.approx(expected)


def test_penalty_cost_with_zero_schedule_treats_all_deviation_as_severe():
    charge = _policy().penalty_cost(10.0, 0.0, price=4.0, duration_hours=0.25)
    assert charge == pytest.approx(10 * RATE * 1.5)


def test_policy_model_rejects_out_of_range_parameters():
    with pytest.raises(ValidationError):
        _policy(deviation_band=1.5)
    with pytest.raises(ValidationError):
        _policy(severe_penalty_multiplier=0.5)


def test_shipped_policies_load():
    assert {p.regulation_id for p in dsm_policy.list_policies()} == {
        "cerc_dsm_2019",
        "cerc_dsm_2024_draft",
    }


@pytest.mark.parametrize("bad_id", ["../main", "a/b", "Upper", "", "x" * 65])
def test_load_policy_rejects_unsafe_ids(bad_id):
    with pytest.raises(FileNotFoundError):
        dsm_policy.load_policy(bad_id)


def test_active_policy_defaults_to_env_then_persists(policies_dir):
    assert dsm_policy.get_active_policy().regulation_id == "cerc_dsm_2024_draft"

    dsm_policy.set_active_policy("cerc_dsm_2019")

    assert (policies_dir / "active_policy.txt").read_text().strip() == "cerc_dsm_2019"
    assert dsm_policy.get_active_policy().regulation_id == "cerc_dsm_2019"


def test_stale_active_pointer_falls_back_to_default(policies_dir):
    (policies_dir / "active_policy.txt").write_text("deleted_policy\n")
    assert dsm_policy.get_active_policy().regulation_id == "cerc_dsm_2024_draft"


def test_set_active_policy_refuses_unknown_policy(policies_dir):
    with pytest.raises(FileNotFoundError):
        dsm_policy.set_active_policy("no_such_policy")
    assert not (policies_dir / "active_policy.txt").exists()


def test_update_policy_merges_fields_and_keeps_the_id():
    updated = dsm_policy.update_policy(
        "cerc_dsm_2019", {"penalty_rate": 3.0, "regulation_id": "renamed", "unknown": 1}
    )

    assert updated.regulation_id == "cerc_dsm_2019"
    reloaded = dsm_policy.load_policy("cerc_dsm_2019")
    assert reloaded.penalty_rate == 3.0
    assert reloaded.deviation_band == 0.1


def test_update_policy_rejects_invalid_values_without_writing():
    before = dsm_policy.load_policy("cerc_dsm_2019")
    with pytest.raises(ValidationError):
        dsm_policy.update_policy("cerc_dsm_2019", {"deviation_band": 2.0})
    assert dsm_policy.load_policy("cerc_dsm_2019") == before
