"""
Pre-trade checks for a 96-block bid set.

Deterministic and rule-based: every check reads the bid set, the stored forecasts,
the server-side constraint and risk results, and the active DSM policy.

Hard checks (25 points each)
  coverage               every block 1-96 has exactly one bid
  constraint_compliance  no price band or technical minimum violations
  risk_exposure          cost-at-risk plus expected DSM penalty within threshold
  price_ceiling          no bid at the policy price ceiling

Soft checks (10 points each)
  forecast_confidence    stored forecasts exist and few blocks have very wide intervals
  override_ratio         manual overrides stay below MAX_OVERRIDE_RATIO
  strategy_alignment     average bid sits where the declared strategy says it should

Verdict
  two or more hard failures    REJECTED
  one hard failure             NEEDS_REVISION
  any warning or soft failure  APPROVED_WITH_FLAGS
  otherwise                    APPROVED

Only APPROVED and APPROVED_WITH_FLAGS bid sets can be submitted.
"""

from __future__ import annotations

from collections import Counter
from collections.abc import Mapping, Sequence
from dataclasses import asdict, dataclass, field
from typing import Literal, Protocol

from common.config import NUM_BLOCKS
from common.dsm_policy import DSMPolicy
from common.schemas import ConstraintViolation

MAX_OVERRIDE_RATIO = 0.40
CI_WIDTH_RATIO_WARN = 2.5  # interval width above 2.5x the predicted price counts as low confidence
CI_POOR_BLOCK_RATIO = 0.20
NEAR_CEILING_FRACTION = 0.9
CONSERVATIVE_ABOVE_PRED_MAX = 0.10
AGGRESSIVE_BELOW_PRED_MIN = -0.05
MAX_LISTED_BLOCKS = 20

Verdict = Literal["APPROVED", "APPROVED_WITH_FLAGS", "NEEDS_REVISION", "REJECTED"]


class _Bid(Protocol):
    block: int
    price: float
    is_overridden: bool


class _Forecast(Protocol):
    predicted_price: float
    confidence_low: float | None
    confidence_high: float | None


@dataclass
class Check:
    name: str
    category: Literal["hard", "soft"]
    status: Literal["pass", "warn", "fail"]
    message: str
    affected_blocks: list[int] = field(default_factory=list)


_POINTS = {
    "hard": {"pass": 25, "warn": 12, "fail": 0},
    "soft": {"pass": 10, "warn": 5, "fail": 2},
}


def _blocks(blocks: Sequence[int]) -> list[int]:
    return sorted(blocks)[:MAX_LISTED_BLOCKS]


def _count(n: int, noun: str) -> str:
    return f"{n} {noun}" if n == 1 else f"{n} {noun}s"


def _agree(n: int, singular: str, plural: str) -> str:
    return singular if n == 1 else plural


def _coverage(bids: Sequence[_Bid]) -> Check:
    counts = Counter(b.block for b in bids)
    missing = [b for b in range(1, NUM_BLOCKS + 1) if b not in counts]
    duplicated = [b for b, n in counts.items() if n > 1]
    if duplicated:
        return Check(
            "coverage",
            "hard",
            "fail",
            f"{_count(len(duplicated), 'block')} {_agree(len(duplicated), 'has', 'have')} "
            "more than one bid.",
            _blocks(duplicated),
        )
    if missing:
        return Check(
            "coverage",
            "hard",
            "fail",
            f"{len(missing)} of {NUM_BLOCKS} blocks {_agree(len(missing), 'has', 'have')} no bid.",
            _blocks(missing),
        )
    return Check("coverage", "hard", "pass", f"All {NUM_BLOCKS} blocks have a bid.")


def _constraints(violations: Mapping[int, list[ConstraintViolation]], policy: DSMPolicy) -> Check:
    violated = [block for block, items in violations.items() if items]
    if violated:
        return Check(
            "constraint_compliance",
            "hard",
            "fail",
            f"{_count(len(violated), 'block')} {_agree(len(violated), 'breaks', 'break')} the "
            f"{policy.name} price band or technical minimum.",
            _blocks(violated),
        )
    return Check(
        "constraint_compliance",
        "hard",
        "pass",
        f"All bids are within the {policy.name} price band and technical minimum.",
    )


def _risk(risk: Mapping) -> Check:
    exposure = risk["total_exposure"]
    threshold = risk["var_threshold"]
    if risk["alert_triggered"]:
        return Check(
            "risk_exposure",
            "hard",
            "fail",
            f"Total exposure ₹{exposure:,.0f} (VaR 95% ₹{risk['var_95']:,.0f} plus expected DSM "
            f"₹{risk['expected_dsm_penalty']:,.0f}) exceeds the ₹{threshold:,.0f} limit.",
        )
    return Check(
        "risk_exposure",
        "hard",
        "pass",
        f"Total exposure ₹{exposure:,.0f} is within the ₹{threshold:,.0f} limit.",
    )


def _ceiling(bids: Sequence[_Bid], strategy: str, policy: DSMPolicy) -> Check:
    ceiling = policy.price_ceiling
    near = NEAR_CEILING_FRACTION * ceiling
    at_ceiling = [b.block for b in bids if b.price >= ceiling]
    if at_ceiling:
        return Check(
            "price_ceiling",
            "hard",
            "fail",
            f"{_count(len(at_ceiling), 'bid')} at or above the ₹{ceiling:g}/kWh ceiling.",
            _blocks(at_ceiling),
        )
    near_ceiling = [b.block for b in bids if b.price >= near]
    if near_ceiling and strategy in ("conservative", "balanced"):
        return Check(
            "price_ceiling",
            "hard",
            "warn",
            f"{_count(len(near_ceiling), 'bid')} at ₹{near:g}/kWh or more under a {strategy} "
            "strategy.",
            _blocks(near_ceiling),
        )
    return Check("price_ceiling", "hard", "pass", f"No bids near the ₹{ceiling:g}/kWh ceiling.")


def _confidence(bids: Sequence[_Bid], forecasts: Mapping[int, _Forecast]) -> Check:
    if not forecasts:
        return Check(
            "forecast_confidence",
            "soft",
            "warn",
            "No stored forecast for this date. Risk uses a fallback volatility estimate.",
        )
    unforecast = [b.block for b in bids if b.block not in forecasts]
    wide = []
    for b in bids:
        fc = forecasts.get(b.block)
        if fc is None or fc.confidence_low is None or fc.confidence_high is None:
            continue
        width = fc.confidence_high - fc.confidence_low
        if width / max(fc.predicted_price, 0.01) > CI_WIDTH_RATIO_WARN:
            wide.append(b.block)
    if unforecast:
        return Check(
            "forecast_confidence",
            "soft",
            "warn",
            f"{_count(len(unforecast), 'bid block')} "
            f"{_agree(len(unforecast), 'has', 'have')} no stored forecast.",
            _blocks(unforecast),
        )
    ratio = len(wide) / max(len(bids), 1)
    if ratio > CI_POOR_BLOCK_RATIO:
        return Check(
            "forecast_confidence",
            "soft",
            "warn",
            f"{_count(len(wide), 'block')} ({ratio:.0%}) {_agree(len(wide), 'has', 'have')} "
            f"forecast intervals wider than {CI_WIDTH_RATIO_WARN:g}x the predicted price.",
            _blocks(wide),
        )
    message = (
        f"{_count(len(wide), 'block')} {_agree(len(wide), 'has', 'have')} a wide forecast "
        "interval, within tolerance."
        if wide
        else f"Every forecast interval is within {CI_WIDTH_RATIO_WARN:g}x the predicted price."
    )
    return Check("forecast_confidence", "soft", "pass", message)


def _overrides(bids: Sequence[_Bid]) -> Check:
    overridden = [b.block for b in bids if b.is_overridden]
    ratio = len(overridden) / max(len(bids), 1)
    if ratio > MAX_OVERRIDE_RATIO:
        return Check(
            "override_ratio",
            "soft",
            "warn",
            f"{_count(len(overridden), 'block')} ({ratio:.0%}) "
            f"{_agree(len(overridden), 'was', 'were')} edited by hand, so the set no longer "
            "reflects the optimizer.",
            _blocks(overridden),
        )
    message = (
        f"{_count(len(overridden), 'block')} ({ratio:.0%}) edited by hand, within the "
        f"{MAX_OVERRIDE_RATIO:.0%} limit."
        if overridden
        else "No manual overrides."
    )
    return Check("override_ratio", "soft", "pass", message)


def _alignment(
    bids: Sequence[_Bid], forecasts: Mapping[int, _Forecast], strategy: str
) -> Check | None:
    pairs = [(b.price, forecasts[b.block].predicted_price) for b in bids if b.block in forecasts]
    if not pairs:
        return None
    avg_bid = sum(p for p, _ in pairs) / len(pairs)
    avg_pred = sum(f for _, f in pairs) / len(pairs)
    deviation = (avg_bid - avg_pred) / max(avg_pred, 0.01)
    if strategy == "conservative" and deviation > CONSERVATIVE_ABOVE_PRED_MAX:
        return Check(
            "strategy_alignment",
            "soft",
            "fail",
            f"Average bid is {deviation:+.1%} versus forecast, which is aggressive for a "
            "conservative strategy.",
        )
    if strategy == "aggressive" and deviation < AGGRESSIVE_BELOW_PRED_MIN:
        return Check(
            "strategy_alignment",
            "soft",
            "fail",
            f"Average bid is {deviation:+.1%} versus forecast, which is conservative for an "
            "aggressive strategy.",
        )
    return Check(
        "strategy_alignment",
        "soft",
        "pass",
        f"Average bid is {deviation:+.1%} versus forecast, consistent with a {strategy} strategy.",
    )


def _verdict(checks: list[Check]) -> tuple[Verdict, str]:
    hard_fails = [
        c.name.replace("_", " ") for c in checks if c.category == "hard" and c.status == "fail"
    ]
    flags = [
        c.name.replace("_", " ")
        for c in checks
        if c.status == "warn" or (c.category == "soft" and c.status == "fail")
    ]
    if len(hard_fails) >= 2:
        return "REJECTED", f"{len(hard_fails)} blocking issues: {', '.join(hard_fails)}."
    if hard_fails:
        return (
            "NEEDS_REVISION",
            f"1 blocking issue: {hard_fails[0]}. Revise the bids and re-run checks.",
        )
    if flags:
        return (
            "APPROVED_WITH_FLAGS",
            f"Cleared for submission with {_count(len(flags), 'flag')}: {', '.join(flags)}.",
        )
    return "APPROVED", f"All {len(checks)} checks passed. Cleared for submission."


def run_pre_trade_checks(
    bids: Sequence[_Bid],
    forecasts: Mapping[int, _Forecast],
    violations: Mapping[int, list[ConstraintViolation]],
    risk: Mapping,
    strategy: str,
    policy: DSMPolicy,
) -> dict:
    """Run every check and return the verdict, score, summary and per-check detail."""
    checks = [
        _coverage(bids),
        _constraints(violations, policy),
        _risk(risk),
        _ceiling(bids, strategy, policy),
        _confidence(bids, forecasts),
        _overrides(bids),
    ]
    alignment = _alignment(bids, forecasts, strategy)
    if alignment is not None:
        checks.append(alignment)

    max_points = sum(_POINTS[c.category]["pass"] for c in checks)
    points = sum(_POINTS[c.category][c.status] for c in checks)
    verdict, summary = _verdict(checks)

    return {
        "verdict": verdict,
        "score": round(points / max_points * 100, 1),
        "checks": [asdict(c) for c in checks],
        "summary": summary,
        "can_submit": verdict in ("APPROVED", "APPROVED_WITH_FLAGS"),
    }
