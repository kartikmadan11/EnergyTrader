"""Forecast endpoints: training, single and multi-day forecasts, and backtests."""

from datetime import date, timedelta

import pandas as pd
import pytest

from common.models import PriceHistory
from data import scrape_weather
from forecast_service import model as forecast_model
from forecast_service import router as forecast_router

FIRST_DAY = date(2026, 5, 1)
HISTORY_DAYS = 21


def _day(offset: int) -> str:
    return (FIRST_DAY + timedelta(days=offset)).isoformat()


def _history() -> list[dict]:
    """Three weeks of DAM prices with a daily shape and a weekly cycle."""
    return [
        {
            "date": _day(d),
            "block": b,
            "segment": "DAM",
            "mcp": 4.0 + (b % 12) * 0.2 + (d % 7) * 0.1,
            "demand_mw": 40000 + b * 50,
            "supply_mw": 42000,
            "renewable_gen_mw": 5000,
            "temperature": 30.0,
        }
        for d in range(HISTORY_DAYS)
        for b in range(1, 97)
    ]


def _history_rows() -> list[PriceHistory]:
    return [PriceHistory(**row) for row in _history()]


@pytest.fixture(scope="module")
def model(tmp_path_factory: pytest.TempPathFactory) -> forecast_model.PriceForecastModel:
    """A small DAM model trained once for the module on the synthetic history."""
    with pytest.MonkeyPatch.context() as mp:
        mp.setattr(forecast_model, "MODEL_DIR", tmp_path_factory.mktemp("models"))
        trained = forecast_model.PriceForecastModel(segment="DAM")
        trained.train(pd.DataFrame(_history()), hyperparams={"max_iter": 50})
    return trained


@pytest.fixture
def weather_requests(monkeypatch: pytest.MonkeyPatch) -> list[tuple[str, str]]:
    """Stand in for Open-Meteo: record each request and return flat hourly weather."""
    requests: list[tuple[str, str]] = []

    def fetch(start_date: str, end_date: str, *args, **kwargs) -> dict[str, dict[int, dict]]:
        requests.append((start_date, end_date))
        days = (date.fromisoformat(end_date) - date.fromisoformat(start_date)).days + 1
        hour = {
            "temperature_2m": 31.0,
            "wind_speed_ms": 3.0,
            "solar_radiation_wm2": 0.0,
            "cloud_cover_pct": 10.0,
        }
        return {
            (date.fromisoformat(start_date) + timedelta(days=i)).isoformat(): {
                h: dict(hour) for h in range(24)
            }
            for i in range(days)
        }

    monkeypatch.setattr(forecast_router, "fetch_weather_hourly", fetch)
    monkeypatch.setattr(scrape_weather, "fetch_weather_hourly", fetch)
    return requests


@pytest.fixture
def trained(client, seed, model, weather_requests) -> forecast_model.PriceForecastModel:
    """The synthetic history in the database and the module's model loaded for DAM."""
    seed(*_history_rows())
    forecast_router._models["DAM"] = model
    return model


def test_train_endpoint_trains_and_serves_the_model(client, seed, weather_requests):
    seed(*_history_rows())
    response = client.post(
        "/api/forecast/train", json={"segment": "DAM", "hyperparams": {"max_iter": 50}}
    )
    assert response.status_code == 200, response.text
    assert response.json()["status"] == "trained"
    assert forecast_router._models["DAM"].uses_weather

    forecast = client.get(
        "/api/forecast/predict", params={"target_date": _day(HISTORY_DAYS), "segment": "DAM"}
    )
    assert forecast.status_code == 200, forecast.text
    assert len(forecast.json()["blocks"]) == 96
    assert weather_requests == [(_day(HISTORY_DAYS), _day(HISTORY_DAYS))]


def test_backtest_fetches_weather_once_for_the_whole_range(client, trained, weather_requests):
    params = {"start_date": _day(14), "end_date": _day(20), "segment": "DAM"}
    response = client.get("/api/forecast/evaluate", params=params)

    assert response.status_code == 200, response.text
    assert response.json()["days_evaluated"] == 7
    assert weather_requests == [(_day(14), _day(20))]


def test_backtest_runs_without_weather_when_the_fetch_fails(client, trained, monkeypatch):
    def unavailable(*args, **kwargs):
        raise ConnectionError("weather service unavailable")

    monkeypatch.setattr(forecast_router, "fetch_weather_hourly", unavailable)
    params = {"start_date": _day(14), "end_date": _day(20), "segment": "DAM"}
    response = client.get("/api/forecast/evaluate", params=params)

    assert response.status_code == 200, response.text
    assert response.json()["days_evaluated"] == 7


def test_range_forecast_matches_single_day_forecasts(client, trained, weather_requests):
    target_days = [_day(HISTORY_DAYS - 1), _day(HISTORY_DAYS)]
    ranged = client.get(
        "/api/forecast/predict-range",
        params={"date_from": target_days[0], "date_to": target_days[1], "segment": "DAM"},
    )
    assert ranged.status_code == 200, ranged.text
    assert weather_requests == [tuple(target_days)]

    for day in ranged.json()["days"]:
        single = client.get(
            "/api/forecast/predict", params={"target_date": day["date"], "segment": "DAM"}
        )
        assert single.status_code == 200, single.text
        expected = {b["block"]: b["predicted_price"] for b in single.json()["blocks"]}
        assert {b["block"]: b["predicted_price"] for b in day["blocks"]} == expected


def test_predict_scores_every_block_in_one_model_call(client, trained, monkeypatch):
    estimator = trained.model
    calls: list[int] = []
    predict = estimator.predict

    def counting_predict(X):
        calls.append(len(X))
        return predict(X)

    monkeypatch.setattr(estimator, "predict", counting_predict)
    response = client.get(
        "/api/forecast/predict", params={"target_date": _day(HISTORY_DAYS), "segment": "DAM"}
    )

    assert response.status_code == 200, response.text
    assert len(response.json()["blocks"]) == 96
    assert calls == [96]
