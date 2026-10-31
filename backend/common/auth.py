"""
Caller identity for API requests.

The web app is the only client that signs users in.
On every request it proxies, it attaches a short-lived HS256 JWT naming the signed-in user
(frontend/src/lib/backend-token.ts), signed with the API_AUTH_SECRET both services share.

With API_AUTH_SECRET set, every /api route except /api/health requires a valid token, and
the token's subject is recorded as the actor in the audit log.
Without it the API trusts every caller as the local user, which only suits a single
machine or a trusted network.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import logging
import os
import time
from dataclasses import dataclass

from fastapi import HTTPException, Request

logger = logging.getLogger(__name__)

ISSUER = "energytrader-web"
AUDIENCE = "energytrader-api"
# Tolerated clock difference between the web and API hosts.
LEEWAY_S = 30
# Matches the audit_log.user column.
MAX_ACTOR_ID = 100

API_AUTH_SECRET = os.getenv("API_AUTH_SECRET", "")


@dataclass(frozen=True)
class Actor:
    id: str
    name: str


LOCAL_ACTOR = Actor(id="local", name="Local user")


class InvalidToken(ValueError):
    pass


def _b64url_decode(part: str) -> bytes:
    return base64.urlsafe_b64decode(part + "=" * (-len(part) % 4))


def _b64url_encode(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).rstrip(b"=").decode("ascii")


def _sign(signing_input: str, secret: str) -> bytes:
    return hmac.new(secret.encode(), signing_input.encode("ascii"), hashlib.sha256).digest()


def encode_token(actor: Actor, secret: str, ttl_s: int = 60, now: float | None = None) -> str:
    """Sign a token the way the web app does; used by tests and scripts."""
    issued = int(time.time() if now is None else now)
    header = {"alg": "HS256", "typ": "JWT"}
    claims = {
        "sub": actor.id,
        "name": actor.name,
        "iss": ISSUER,
        "aud": AUDIENCE,
        "iat": issued,
        "exp": issued + ttl_s,
    }
    signing_input = ".".join(
        _b64url_encode(json.dumps(part, separators=(",", ":")).encode())
        for part in (header, claims)
    )
    return f"{signing_input}.{_b64url_encode(_sign(signing_input, secret))}"


def verify_token(token: str, secret: str, now: float | None = None) -> Actor:
    """Return the actor named by a valid token, or raise InvalidToken."""
    parts = token.split(".")
    if len(parts) != 3:
        raise InvalidToken("malformed token")
    header_b64, claims_b64, signature_b64 = parts
    try:
        header = json.loads(_b64url_decode(header_b64))
        signature = _b64url_decode(signature_b64)
    except ValueError as exc:
        raise InvalidToken("malformed token") from exc
    # Pin the algorithm so a token cannot pick a weaker one, such as "none".
    if not isinstance(header, dict) or header.get("alg") != "HS256":
        raise InvalidToken("unsupported algorithm")
    if not hmac.compare_digest(signature, _sign(f"{header_b64}.{claims_b64}", secret)):
        raise InvalidToken("bad signature")

    try:
        claims = json.loads(_b64url_decode(claims_b64))
    except ValueError as exc:
        raise InvalidToken("malformed claims") from exc
    if not isinstance(claims, dict):
        raise InvalidToken("malformed claims")
    if claims.get("iss") != ISSUER or claims.get("aud") != AUDIENCE:
        raise InvalidToken("wrong issuer or audience")

    current = time.time() if now is None else now
    exp, iat = claims.get("exp"), claims.get("iat")
    if not isinstance(exp, int | float) or not isinstance(iat, int | float):
        raise InvalidToken("missing expiry")
    if current > exp + LEEWAY_S:
        raise InvalidToken("token expired")
    if iat > current + LEEWAY_S:
        raise InvalidToken("token issued in the future")

    sub, name = claims.get("sub"), claims.get("name")
    if not isinstance(sub, str) or not sub or len(sub) > MAX_ACTOR_ID:
        raise InvalidToken("invalid subject")
    return Actor(id=sub, name=name if isinstance(name, str) and name else sub)


def log_auth_mode() -> None:
    if API_AUTH_SECRET:
        logger.info("API authentication is on: requests need a token signed by the web app")
    else:
        logger.warning(
            "API_AUTH_SECRET is not set: every request is trusted as '%s'. "
            "Set it on both services before exposing the API beyond this machine.",
            LOCAL_ACTOR.id,
        )


async def current_actor(request: Request) -> Actor:
    """FastAPI dependency: the authenticated caller, or 401."""
    if not API_AUTH_SECRET:
        return LOCAL_ACTOR
    scheme, _, token = request.headers.get("authorization", "").partition(" ")
    if scheme.lower() != "bearer" or not token:
        raise HTTPException(
            401, "Sign in through the web app to use the API.", {"WWW-Authenticate": "Bearer"}
        )
    try:
        return verify_token(token, API_AUTH_SECRET)
    except InvalidToken as exc:
        logger.info("Rejected API token: %s", exc)
        raise HTTPException(
            401, "Your session token is invalid or expired.", {"WWW-Authenticate": "Bearer"}
        ) from exc
