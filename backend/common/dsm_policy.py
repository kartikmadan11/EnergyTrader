"""
DSM policy engine: CERC Deviation Settlement Mechanism parameters as data.

Each regulation version is a YAML file under backend/data/policies/.
The active version is recorded in active_policy.txt in the same directory,
which is local runtime state and not committed.
When the pointer file is absent, the DSM_POLICY environment variable
(default cerc_dsm_2024_draft) selects the policy.

Usage:
    from common.dsm_policy import get_active_policy

    policy = get_active_policy()
    policy.deviation_band   # e.g. 0.07
"""

from __future__ import annotations

import logging
import os
import re
from pathlib import Path

import yaml
from pydantic import BaseModel, Field

logger = logging.getLogger(__name__)

POLICIES_DIR = Path(__file__).resolve().parent.parent / "data" / "policies"
_ACTIVE_POLICY_FILE = POLICIES_DIR / "active_policy.txt"
_REGULATION_ID = re.compile(r"^[a-z0-9_]{1,64}$")

DEFAULT_POLICY_ID = os.getenv("DSM_POLICY", "cerc_dsm_2024_draft")


class DSMPolicy(BaseModel):
    """Declarative model of a CERC DSM regulation version."""

    regulation_id: str
    name: str
    description: str = ""
    effective_date: str = ""
    status: str = "active"

    # Price limits (INR/kWh)
    price_floor: float = Field(ge=0.0)
    price_ceiling: float = Field(gt=0.0)

    # Permissible deviation band (fraction of schedule, e.g. 0.10 = 10%)
    deviation_band: float = Field(gt=0.0, lt=1.0)

    # Penalty structure
    penalty_rate: float = Field(gt=0.0)
    severe_deviation_threshold: float = Field(gt=0.0, lt=1.0)
    severe_penalty_multiplier: float = Field(ge=1.0)

    # Market minimums
    technical_minimum_mw: float = Field(gt=0.0)

    def penalty_cost(
        self,
        volume_mw: float,
        scheduled_mw: float,
        price: float,
        duration_hours: float,
    ) -> float:
        """
        DSM charge (INR) for one block where *volume_mw* is delivered against *scheduled_mw*.

        Tiered structure, measured in MW:
          - deviation up to deviation_band x schedule is free
          - deviation beyond the band pays penalty_rate x price
          - deviation beyond severe_deviation_threshold x schedule additionally pays
            (severe_penalty_multiplier - 1) x penalty_rate x price

        With a zero schedule every MW of deviation falls in the severe tier.
        """
        deviation_mw = abs(volume_mw - scheduled_mw)
        schedule = max(scheduled_mw, 0.0)
        excess_mw = max(0.0, deviation_mw - self.deviation_band * schedule)
        severe_mw = max(0.0, deviation_mw - self.severe_deviation_threshold * schedule)

        rate = price * self.penalty_rate * duration_hours * 1000
        charge = excess_mw * rate + severe_mw * rate * (self.severe_penalty_multiplier - 1.0)
        return round(charge, 2)


def _policy_path(regulation_id: str) -> Path:
    if not _REGULATION_ID.match(regulation_id):
        raise FileNotFoundError(f"Invalid policy id {regulation_id!r}.")
    return POLICIES_DIR / f"{regulation_id}.yaml"


def load_policy(regulation_id: str) -> DSMPolicy:
    """Load and validate a policy by its regulation_id."""
    path = _policy_path(regulation_id)
    if not path.exists():
        available = sorted(p.stem for p in POLICIES_DIR.glob("*.yaml"))
        raise FileNotFoundError(f"Policy {regulation_id!r} not found. Available: {available}")
    return DSMPolicy(**yaml.safe_load(path.read_text()))


def list_policies() -> list[DSMPolicy]:
    """Return all available policies, newest effective_date first."""
    policies = []
    for yaml_path in sorted(POLICIES_DIR.glob("*.yaml")):
        try:
            policies.append(DSMPolicy(**yaml.safe_load(yaml_path.read_text())))
        except Exception as exc:
            logger.warning("Skipping malformed policy file %s: %s", yaml_path.name, exc)
    return sorted(policies, key=lambda p: p.effective_date, reverse=True)


def get_active_policy() -> DSMPolicy:
    """Return the active DSM policy, falling back to DEFAULT_POLICY_ID."""
    if _ACTIVE_POLICY_FILE.exists():
        regulation_id = _ACTIVE_POLICY_FILE.read_text().strip()
        try:
            return load_policy(regulation_id)
        except (FileNotFoundError, ValueError) as exc:
            logger.warning("Ignoring active policy pointer %r: %s", regulation_id, exc)
    return load_policy(DEFAULT_POLICY_ID)


def set_active_policy(regulation_id: str) -> DSMPolicy:
    """
    Persist a new active policy and return it.

    The policy is loaded first, so the pointer never names a missing or invalid file.
    """
    policy = load_policy(regulation_id)
    _ACTIVE_POLICY_FILE.write_text(regulation_id + "\n")
    logger.info("Active DSM policy switched to %s", regulation_id)
    return policy


def update_policy(regulation_id: str, updates: dict) -> DSMPolicy:
    """
    Persist edits to an existing policy YAML and return the updated policy.

    Only the fields present in *updates* change.
    The regulation_id is the file identifier and cannot be changed.

    Raises FileNotFoundError if the policy does not exist and
    pydantic.ValidationError if the merged values are invalid.
    """
    path = _policy_path(regulation_id)
    if not path.exists():
        raise FileNotFoundError(f"Policy {regulation_id!r} not found.")

    existing = yaml.safe_load(path.read_text())
    changes = {k: v for k, v in updates.items() if k != "regulation_id"}
    merged = DSMPolicy(**{**existing, **changes})

    # Write the validated model rather than the raw request body so unknown keys are dropped.
    path.write_text(
        yaml.safe_dump(merged.model_dump(), sort_keys=False, allow_unicode=True, width=100)
    )
    logger.info("Policy %s updated: %s", regulation_id, sorted(changes))
    return merged
