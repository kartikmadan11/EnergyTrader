import math

import pytest

from forecast_service import metrics


def test_mape_ignores_blocks_below_the_price_floor():
    # The 0.5 block would add a 900% error on its own; it sits below the 1 INR/kWh floor.
    assert metrics.mape([0.5, 2.0, 4.0], [5.0, 2.2, 3.0]) == pytest.approx(17.5)


def test_mape_is_none_when_no_block_clears_the_floor():
    assert metrics.mape([0.0, 0.4], [1.0, 0.2]) is None
    assert metrics.mape([], []) is None


def test_smape_is_symmetric_and_zero_when_both_values_are_zero():
    assert metrics.smape([2.0], [3.0]) == pytest.approx(40.0)
    assert metrics.smape([3.0], [2.0]) == pytest.approx(40.0)
    assert metrics.smape([0.0, 2.0], [0.0, 2.0]) == 0.0
    assert metrics.smape([], []) == 0.0


def test_mae_and_rmse():
    actual, predicted = [1.0, 2.0, 3.0], [2.0, 2.0, 1.0]
    assert metrics.mae(actual, predicted) == pytest.approx(1.0)
    assert metrics.rmse(actual, predicted) == pytest.approx(math.sqrt(5 / 3))


@pytest.mark.parametrize("predicted", [3.0, 5.0])
def test_percentage_error_is_absolute(predicted):
    assert metrics.percentage_error(4.0, predicted) == pytest.approx(25.0)


def test_percentage_error_is_none_below_the_price_floor():
    assert metrics.percentage_error(0.5, 3.0) is None


def test_shape_mismatch_raises():
    with pytest.raises(ValueError, match="shape mismatch"):
        metrics.mae([1.0, 2.0], [1.0])
