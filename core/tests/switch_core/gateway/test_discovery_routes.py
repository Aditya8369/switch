"""`GET /gateway/discovery`: a server's public origins, for a client that has one.

Switch Console calls this with whichever address a person typed, before any
session exists, to learn the other. What it may say is deliberately narrow: the
two configured origins, normalised, or null; never a guess, never a version.
"""

from __future__ import annotations

from typing import Any
from unittest.mock import MagicMock

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from switch_core.bridges.agent.auth import BearerAuthMiddleware
from switch_core.gateway.discovery_routes import public_origin
from tests.switch_core.gateway.test_app_route_mounting import _app

# ── public_origin ────────────────────────────────────────────────────────────


@pytest.mark.parametrize(
    ("configured", "origin"),
    [
        ("https://switch.example.com", "https://switch.example.com"),
        ("https://switch.example.com/", "https://switch.example.com"),
        ("https://switch.example.com/some/path?q=1#f", "https://switch.example.com"),
        ("https://switch.example.com:443", "https://switch.example.com"),
        ("http://switch.example.com:80/", "http://switch.example.com"),
        ("https://switch.example.com:8443", "https://switch.example.com:8443"),
        ("http://localhost:8000", "http://localhost:8000"),
        ("HTTPS://Switch.Example.COM", "https://switch.example.com"),
        ("http://[::1]:8000/", "http://[::1]:8000"),
        ("  https://switch.example.com  ", "https://switch.example.com"),
    ],
)
def test_a_configured_value_is_reduced_to_its_origin(
    configured: str, origin: str
) -> None:
    assert public_origin(configured) == origin


@pytest.mark.parametrize(
    "configured",
    [None, "", "   ", "switch.example.com", "ftp://switch.example.com", "https://"],
)
def test_a_value_that_is_not_an_origin_is_reported_as_unset(
    configured: str | None,
) -> None:
    assert public_origin(configured) is None


# ── the route ────────────────────────────────────────────────────────────────


def _client(**overrides: object) -> TestClient:
    # Both origins explicit, so a developer's own `.env` (which the config
    # reads) cannot answer for a case that means "not configured".
    settings: dict[str, object] = {
        "frontend_base_url": None,
        "gateway_public_url": None,
    }
    return TestClient(_app(**{**settings, **overrides}))  # type: ignore[arg-type]


def test_both_origins_configured() -> None:
    response = _client(
        frontend_base_url="https://switch.example.com/",
        gateway_public_url="https://switch-api.example.com",
    ).get("/discovery")

    assert response.status_code == 200
    assert response.json() == {
        "gateway_url": "https://switch.example.com",
        "api_url": "https://switch-api.example.com",
    }


def test_only_the_dashboard_configured() -> None:
    response = _client(frontend_base_url="https://switch.example.com").get("/discovery")

    assert response.status_code == 200
    assert response.json() == {
        "gateway_url": "https://switch.example.com",
        "api_url": None,
    }


def test_only_the_agent_bridge_configured() -> None:
    response = _client(gateway_public_url="https://switch-api.example.com").get(
        "/discovery"
    )

    assert response.status_code == 200
    assert response.json() == {
        "gateway_url": None,
        "api_url": "https://switch-api.example.com",
    }


def test_neither_configured_is_two_nulls_not_an_error() -> None:
    response = _client().get("/discovery")

    assert response.status_code == 200
    assert response.json() == {"gateway_url": None, "api_url": None}


def test_the_request_host_is_never_used_as_a_guess() -> None:
    """The request may well have arrived at the agent bridge; with nothing
    configured the answer is still null, because a guessed address would be
    written into every agent."""
    response = _client().get("/discovery", headers={"host": "switch-api.example.com"})

    assert response.json()["api_url"] is None


# ── unauthenticated and disclosure-limited ──────────────────────────────────


@pytest.mark.parametrize(
    "headers",
    [
        {},
        {"cookie": "switch_auth=not-a-real-token"},
        {"cookie": "switch_auth="},
        {"authorization": "Bearer nonsense"},
    ],
    ids=["nothing", "malformed-cookie", "empty-cookie", "bad-bearer"],
)
def test_it_answers_without_a_valid_session(headers: dict[str, str]) -> None:
    response = _client(frontend_base_url="https://switch.example.com").get(
        "/discovery", headers=headers
    )

    assert response.status_code == 200
    assert response.json()["gateway_url"] == "https://switch.example.com"


def test_the_body_carries_only_the_two_origins() -> None:
    body = (
        _client(
            frontend_base_url="https://switch.example.com",
            gateway_public_url="https://switch-api.example.com",
        )
        .get("/discovery")
        .json()
    )

    assert set(body) == {"gateway_url", "api_url"}


def test_no_header_discloses_a_version() -> None:
    response = _client().get("/discovery")

    for name, value in response.headers.items():
        assert "version" not in name.lower()
        assert "switch" not in name.lower(), f"{name}: {value}"


# ── mounted on the agent bridge ──────────────────────────────────────────────


def _bridge_with_gateway(**overrides: object) -> TestClient:
    """The agent bridge's shape: the gateway mounted at `/gateway`, inside the
    bearer middleware that guards every agent path."""
    bridge = FastAPI()

    @bridge.get("/agents/{agent_id}/ping")
    async def ping(agent_id: str) -> dict[str, Any]:  # pragma: no cover
        return {"ok": True}

    settings: dict[str, object] = {
        "frontend_base_url": None,
        "gateway_public_url": None,
    }
    bridge.mount("/gateway", _app(**{**settings, **overrides}))  # type: ignore[arg-type]
    bridge.add_middleware(
        BearerAuthMiddleware,
        agent_store=MagicMock(),
        api_key_store=MagicMock(),
        api_key_cache=MagicMock(),
        session_factory=MagicMock(),
        controller_auth=None,
    )
    return TestClient(bridge)


def test_the_bridge_answers_it_under_gateway_without_a_token() -> None:
    client = _bridge_with_gateway(gateway_public_url="https://switch-api.example.com")

    response = client.get("/gateway/discovery")

    assert response.status_code == 200
    assert response.json()["api_url"] == "https://switch-api.example.com"


def test_the_bearer_middleware_still_guards_agent_paths() -> None:
    """The control: the same app refuses an agent path without a token, so the
    discovery answer above is the public-path rule, not a disabled guard."""
    response = _bridge_with_gateway().get("/agents/a1/ping")

    assert response.status_code == 401
