"""
Outbound HTTPS settings shared by the exchange and weather clients.

Certificates are always verified.
The CA bundle comes from REQUESTS_CA_BUNDLE or SSL_CERT_FILE when set, otherwise certifi.

Python 3.13 also enforces strict RFC 5280 checks on every CA in the chain.
Some TLS-inspecting corporate proxies issue CA certificates that fail those checks,
so HTTP_TLS_STRICT=false relaxes only that flag; chain and hostname verification stay on.
"""

from __future__ import annotations

import os
import ssl

import certifi
import requests
from requests.adapters import HTTPAdapter

USER_AGENT = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)"


def _strict() -> bool:
    return os.getenv("HTTP_TLS_STRICT", "true").strip().lower() not in {"0", "false", "no", "off"}


def tls_context() -> ssl.SSLContext:
    """Verifying SSL context for outbound requests."""
    cafile = os.getenv("REQUESTS_CA_BUNDLE") or os.getenv("SSL_CERT_FILE") or certifi.where()
    ctx = ssl.create_default_context(cafile=cafile)
    if not _strict():
        ctx.verify_flags &= ~ssl.VERIFY_X509_STRICT
    return ctx


class _TLSAdapter(HTTPAdapter):
    def init_poolmanager(self, *args, **kwargs):
        kwargs["ssl_context"] = tls_context()
        return super().init_poolmanager(*args, **kwargs)


def requests_session(headers: dict[str, str] | None = None) -> requests.Session:
    """A requests session that uses tls_context() for every HTTPS connection."""
    session = requests.Session()
    session.mount("https://", _TLSAdapter())
    session.headers.update({"User-Agent": USER_AGENT, **(headers or {})})
    return session
