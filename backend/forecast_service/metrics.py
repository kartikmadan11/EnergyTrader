"""
Forecast error metrics shared by training, evaluation, backtesting and post-market analysis.

IEX clearing prices regularly touch zero during solar hours, especially in RTM.
Percentage error is undefined there, so MAPE only counts blocks whose actual price is at
least MAPE_PRICE_FLOOR. sMAPE, MAE and RMSE use every block.
"""

from __future__ import annotations

import numpy as np

MAPE_PRICE_FLOOR = 1.0  # INR/kWh


def _arrays(actual, predicted) -> tuple[np.ndarray, np.ndarray]:
    a = np.asarray(actual, dtype=float)
    p = np.asarray(predicted, dtype=float)
    if a.shape != p.shape:
        raise ValueError(f"shape mismatch: {a.shape} vs {p.shape}")
    return a, p


def mape(actual, predicted, floor: float = MAPE_PRICE_FLOOR) -> float | None:
    """Mean absolute percentage error (%) over blocks with actual >= floor, or None if there are none."""
    a, p = _arrays(actual, predicted)
    mask = np.abs(a) >= floor
    if not mask.any():
        return None
    return float(np.mean(np.abs(a[mask] - p[mask]) / np.abs(a[mask])) * 100)


def smape(actual, predicted) -> float:
    """Symmetric MAPE (%), defined as 0 for blocks where both values are 0."""
    a, p = _arrays(actual, predicted)
    denom = np.abs(a) + np.abs(p)
    ratio = np.divide(2 * np.abs(a - p), denom, out=np.zeros_like(denom), where=denom > 0)
    return float(np.mean(ratio) * 100) if ratio.size else 0.0


def mae(actual, predicted) -> float:
    a, p = _arrays(actual, predicted)
    return float(np.mean(np.abs(a - p))) if a.size else 0.0


def rmse(actual, predicted) -> float:
    a, p = _arrays(actual, predicted)
    return float(np.sqrt(np.mean((a - p) ** 2))) if a.size else 0.0


def percentage_error(
    actual: float, predicted: float, floor: float = MAPE_PRICE_FLOOR
) -> float | None:
    """Absolute percentage error (%) for one block, or None below the price floor."""
    if abs(actual) < floor:
        return None
    return abs(predicted - actual) / abs(actual) * 100
