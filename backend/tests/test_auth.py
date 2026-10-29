import base64
import json

import pytest

from common import auth
from common.auth import Actor, InvalidToken, encode_token, verify_token

SECRET = "test-secret-with-enough-entropy-0123456789"
DESK = Actor(id="github:desk-north", name="Desk North")
NOW = 1_800_000_000


def _b64(obj) -> str:
    return base64.urlsafe_b64encode(json.dumps(obj).encode()).rstrip(b"=").decode()


def test_token_round_trip():
    token = encode_token(DESK, SECRET, now=NOW)
    assert verify_token(token, SECRET, now=NOW + 10) == DESK


# The web app signs tokens in TypeScript (frontend/src/lib/backend-token.ts); its test pins the
# same vector, so a change to either side's encoding fails one of the two suites.
CONTRACT_SECRET = "contract-test-secret"
CONTRACT_NOW = 1_767_225_600
CONTRACT_TOKEN = (
    "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9."
    "eyJzdWIiOiJnaXRodWI6ZGVzay1ub3J0aCIsIm5hbWUiOiJEZXNrIE5vcnRoIiwiaXNzIjoiZW5lcmd5dHJhZGVy"
    "LXdlYiIsImF1ZCI6ImVuZXJneXRyYWRlci1hcGkiLCJpYXQiOjE3NjcyMjU2MDAsImV4cCI6MTc2NzIyNTY2MH0."
    "VpzUbMnF3eCJuzlcqlHZDy8lWa9Swd_pzWPd5jsBHbY"
)


def test_tokens_match_the_web_app_encoding():
    assert encode_token(DESK, CONTRACT_SECRET, now=CONTRACT_NOW) == CONTRACT_TOKEN
    assert verify_token(CONTRACT_TOKEN, CONTRACT_SECRET, now=CONTRACT_NOW + 1) == DESK


@pytest.mark.parametrize(
    ("token", "now", "reason"),
    [
        (encode_token(DESK, SECRET, ttl_s=60, now=NOW), NOW + 60 + auth.LEEWAY_S + 1, "expired"),
        (encode_token(DESK, SECRET, now=NOW + 3600), NOW, "future"),
        (encode_token(DESK, "another-secret", now=NOW), NOW, "signature"),
        ("not-a-token", NOW, "malformed"),
        ("a.b.c", NOW, "malformed"),
    ],
)
def test_invalid_tokens_are_rejected(token, now, reason):
    with pytest.raises(InvalidToken, match=reason):
        verify_token(token, SECRET, now=now)


def test_tampered_claims_are_rejected():
    header, _, signature = encode_token(DESK, SECRET, now=NOW).split(".")
    forged = _b64({"sub": "github:someone-else", "iss": auth.ISSUER, "aud": auth.AUDIENCE})
    with pytest.raises(InvalidToken, match="signature"):
        verify_token(f"{header}.{forged}.{signature}", SECRET, now=NOW)


def test_unsigned_algorithm_is_rejected():
    claims = {"sub": "x", "iss": auth.ISSUER, "aud": auth.AUDIENCE, "iat": NOW, "exp": NOW + 60}
    token = f"{_b64({'alg': 'none', 'typ': 'JWT'})}.{_b64(claims)}."
    with pytest.raises(InvalidToken, match="algorithm"):
        verify_token(token, SECRET, now=NOW)


def test_wrong_audience_is_rejected(monkeypatch):
    monkeypatch.setattr(auth, "AUDIENCE", "some-other-api")
    token = encode_token(DESK, SECRET, now=NOW)
    monkeypatch.undo()
    with pytest.raises(InvalidToken, match="audience"):
        verify_token(token, SECRET, now=NOW)


def test_oversized_subject_is_rejected():
    token = encode_token(Actor(id="x" * 101, name="x"), SECRET, now=NOW)
    with pytest.raises(InvalidToken, match="subject"):
        verify_token(token, SECRET, now=NOW)


@pytest.fixture
def secured(monkeypatch):
    monkeypatch.setattr(auth, "API_AUTH_SECRET", SECRET)


def _bearer(actor: Actor = DESK) -> dict:
    return {"Authorization": f"Bearer {encode_token(actor, SECRET)}"}


def test_api_requires_a_token_when_a_secret_is_set(client, secured):
    missing = client.get("/api/audit/log")
    assert missing.status_code == 401
    assert missing.headers["www-authenticate"] == "Bearer"

    bad = client.get("/api/audit/log", headers={"Authorization": "Bearer nope.nope.nope"})
    assert bad.status_code == 401
    assert "invalid or expired" in bad.json()["detail"]

    assert client.get("/api/audit/log", headers=_bearer()).status_code == 200
    assert client.get("/api/blotter", headers=_bearer()).status_code == 200


def test_health_stays_public(client, secured):
    assert client.get("/api/health").status_code == 200


def test_audit_entries_record_the_signed_in_user(client, secured):
    response = client.post("/api/policy/activate/cerc_dsm_2019", headers=_bearer())
    assert response.status_code == 200
    entry = client.get("/api/audit/log", headers=_bearer()).json()[0]
    assert (entry["action"], entry["user"]) == ("policy_activate", DESK.id)


def test_without_a_secret_every_caller_is_the_local_user(client):
    assert client.post("/api/policy/activate/cerc_dsm_2019").status_code == 200
    assert client.get("/api/audit/log").json()[0]["user"] == auth.LOCAL_ACTOR.id
