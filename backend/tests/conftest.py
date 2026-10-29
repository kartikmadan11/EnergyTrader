"""
Shared fixtures.

The database engine binds to DATABASE_URL at import time, so the environment is set here,
before any application module is imported.
Policies and trained models are redirected to per-test directories so tests never read or
write the local runtime state under backend/data.
"""

from __future__ import annotations

import os
import shutil
import sqlite3
import tempfile
from collections.abc import Iterator
from contextlib import closing
from pathlib import Path

import pytest

_TMP_ROOT = Path(tempfile.mkdtemp(prefix="energytrader-tests-"))
os.environ["DATABASE_URL"] = f"sqlite+aiosqlite:///{_TMP_ROOT / 'test.db'}"
os.environ["SCHEDULER_ENABLED"] = "false"
os.environ["DSM_POLICY"] = "cerc_dsm_2024_draft"
os.environ["RISK_VAR_THRESHOLD_INR"] = "500000"

from fastapi.testclient import TestClient  # noqa: E402

from common import dsm_policy  # noqa: E402
from common.config import DB_PATH  # noqa: E402
from common.database import async_session  # noqa: E402
from forecast_service import model as forecast_model  # noqa: E402
from forecast_service import router as forecast_router  # noqa: E402
from main import app  # noqa: E402

SHIPPED_POLICIES = Path(dsm_policy.__file__).resolve().parent.parent / "data" / "policies"


@pytest.fixture(autouse=True)
def policies_dir(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    """A private copy of the shipped policy YAML files with no active-policy pointer."""
    target = tmp_path / "policies"
    target.mkdir()
    for yaml_file in SHIPPED_POLICIES.glob("*.yaml"):
        shutil.copy(yaml_file, target / yaml_file.name)
    monkeypatch.setattr(dsm_policy, "POLICIES_DIR", target)
    monkeypatch.setattr(dsm_policy, "_ACTIVE_POLICY_FILE", target / "active_policy.txt")
    return target


@pytest.fixture
def policy(policies_dir: Path) -> dsm_policy.DSMPolicy:
    """The default policy: CERC DSM 2024 draft, 7% band, 2.0x rate, 1.5x beyond 15%."""
    return dsm_policy.load_policy("cerc_dsm_2024_draft")


@pytest.fixture(autouse=True)
def models_dir(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    """An empty model directory and a cleared model cache."""
    target = tmp_path / "models"
    target.mkdir()
    monkeypatch.setattr(forecast_model, "MODEL_DIR", target)
    monkeypatch.setattr(forecast_router, "_models", {})
    return target


@pytest.fixture(scope="session")
def _app_client() -> Iterator[TestClient]:
    with TestClient(app) as client:
        yield client


@pytest.fixture
def client(_app_client: TestClient) -> TestClient:
    """The API client, with every table emptied before the test."""
    with closing(sqlite3.connect(DB_PATH)) as conn:
        tables = [
            row[0]
            for row in conn.execute(
                "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'"
            )
        ]
        for table in tables:
            conn.execute(f'DELETE FROM "{table}"')
        conn.commit()
    return _app_client


@pytest.fixture
def seed(client: TestClient):
    """Insert ORM rows through the app's own engine and event loop."""

    async def _add(rows: list) -> None:
        async with async_session() as session:
            session.add_all(rows)
            await session.commit()

    def _seed(*rows) -> None:
        client.portal.call(_add, list(rows))

    return _seed


def pytest_sessionfinish(session, exitstatus) -> None:
    shutil.rmtree(_TMP_ROOT, ignore_errors=True)
