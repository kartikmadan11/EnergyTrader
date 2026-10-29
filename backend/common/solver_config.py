"""
LP solver tuning parameters that are not derived from CERC regulations.

These values are not part of any CERC notification and do not belong in the
regulatory YAML policy files. They weight the terms of the bid optimizer objective.

  lambda1_base  - base weight for the DSM penalty cost term.
                  Scaled by (1 - risk_tolerance) at solve time.
                  Higher means the optimizer avoids deviation more aggressively.

  lambda2_base  - base weight for the forecast uncertainty (CI width) term.
                  Scaled by (1 - risk_tolerance) at solve time.
                  Higher means the optimizer prefers blocks with narrower confidence intervals.

Both can be overridden with the SOLVER_LAMBDA1_BASE and SOLVER_LAMBDA2_BASE
environment variables, and per request through /api/bids/recommend.
"""

import os


def _positive_float_env(name: str, default: float) -> float:
    raw = os.getenv(name)
    if raw is None or not raw.strip():
        return default
    value = float(raw)
    if value <= 0:
        raise ValueError(f"{name} must be a positive number, got {raw!r}")
    return value


LAMBDA1_BASE: float = _positive_float_env("SOLVER_LAMBDA1_BASE", 2.0)
LAMBDA2_BASE: float = _positive_float_env("SOLVER_LAMBDA2_BASE", 1.5)
