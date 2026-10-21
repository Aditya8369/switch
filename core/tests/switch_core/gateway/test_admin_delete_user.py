"""The deployment operator deleting someone's account (DELETE /users/{id}).

Against a real database: the route runs the same `AccountDeletion` as
`DELETE /auth/me`, whose difficulty is the schema. The services with side
effects outside the database are the fakes `test_account_deletion.py` uses.
"""

from __future__ import annotations

from types import SimpleNamespace

import httpx
from fastapi import FastAPI
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.connections.broker import get_service_broker
from switch_core.db.models import TENANT_ZERO_ID, ServerAuditEvent, User
from switch_core.db.stores.agent_store import AgentStore
from switch_core.db.stores.api_key_store import ApiKeyStore
from switch_core.db.stores.template_store import TemplateStore
from switch_core.db.stores.user_store import UserStore
from switch_core.gateway import dependencies as gw_deps
from switch_core.gateway.auth import create_jwt
from switch_core.gateway.auth_routes import router
from tests.conftest import TEST_KEYRING
from tests.switch_core.accounts.test_account_deletion import (
    ADMIN_EMAIL,
    _deletion,
    _SignInFlows,
)
from tests.switch_core.gateway.test_tenant_api_routes import _make_member


def _app(session_factory: async_sessionmaker[AsyncSession]) -> FastAPI:
    deletion, _, _ = _deletion(session_factory)

    async def _session_dep():
        async with session_factory() as session:
            yield session

    app = FastAPI()
    app.include_router(router)
    app.state.sign_in_flows = _SignInFlows()
    overrides = app.dependency_overrides
    overrides[gw_deps.get_session] = _session_dep
    overrides[gw_deps.get_system_session] = _session_dep
    overrides[gw_deps.get_session_factory] = lambda: session_factory
    overrides[gw_deps.get_user_store] = lambda: UserStore()
    overrides[gw_deps.get_agent_store] = lambda: AgentStore()
    overrides[gw_deps.get_api_key_store] = lambda: ApiKeyStore()
    overrides[gw_deps.get_template_store] = lambda: TemplateStore()
    overrides[gw_deps.get_protocol] = lambda: deletion.protocol
    overrides[gw_deps.get_resource_service] = lambda: deletion.resources
    overrides[gw_deps.get_room_service] = lambda: deletion.rooms
    overrides[get_service_broker] = lambda: deletion.broker
    overrides[gw_deps.get_config] = lambda: SimpleNamespace(
        keyring=TEST_KEYRING,
        gateway_cookie_secure=False,
        gateway_admin_email=ADMIN_EMAIL,
        gateway_tenant_choice_enabled=False,
    )
    return app


def _client(app: FastAPI, user_id: str, email: str) -> httpx.AsyncClient:
    token = create_jwt(user_id, email, "user", TEST_KEYRING, TENANT_ZERO_ID)
    return httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app),
        base_url="http://test",
        cookies={"switch_auth": token},
    )


async def _people(
    session_factory: async_sessionmaker[AsyncSession],
) -> tuple[str, str]:
    operator = await _make_member(
        session_factory,
        name="operator",
        tenant_id=TENANT_ZERO_ID,
        role="owner",
        email=ADMIN_EMAIL,
        user_role="admin",
    )
    member = await _make_member(
        session_factory, name="leaving", tenant_id=TENANT_ZERO_ID, role="member"
    )
    return operator, member


async def _server_events(
    session_factory: async_sessionmaker[AsyncSession],
) -> list[ServerAuditEvent]:
    async with session_factory() as session:
        return list(
            (
                await session.scalars(
                    select(ServerAuditEvent).order_by(ServerAuditEvent.occurred_at)
                )
            ).all()
        )


async def test_the_operator_deletes_a_members_account_and_it_is_logged(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    operator, member = await _people(session_factory)
    async with _client(_app(session_factory), operator, ADMIN_EMAIL) as client:
        response = await client.delete(f"/users/{member}")
    assert response.status_code == 200, response.text
    async with session_factory() as session:
        assert await session.get(User, member) is None
    [event] = await _server_events(session_factory)
    assert event.action == "user.deleted"
    assert event.actor_user_id == operator
    assert event.target_id == member
    assert event.details is not None and event.details["outcome"] == "deleted"


async def test_a_workspace_admin_who_is_not_the_operator_is_refused(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    _, member = await _people(session_factory)
    workspace_admin = await _make_member(
        session_factory, name="ws-admin", tenant_id=TENANT_ZERO_ID, role="owner"
    )
    async with _client(
        _app(session_factory), workspace_admin, "ws-admin@example.invalid"
    ) as client:
        response = await client.delete(f"/users/{member}")
    assert response.status_code == 403, response.text
    async with session_factory() as session:
        assert await session.get(User, member) is not None
    assert await _server_events(session_factory) == []


async def test_the_operators_own_account_is_refused(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    operator, _ = await _people(session_factory)
    async with _client(_app(session_factory), operator, ADMIN_EMAIL) as client:
        response = await client.delete(f"/users/{operator}")
    assert response.status_code == 409, response.text
    assert "your own account" in response.json()["detail"]
    async with session_factory() as session:
        assert await session.get(User, operator) is not None


async def test_another_administrator_account_is_refused_and_logged(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    operator, _ = await _people(session_factory)
    other_admin = await _make_member(
        session_factory,
        name="second-admin",
        tenant_id=TENANT_ZERO_ID,
        role="member",
        user_role="admin",
    )
    async with _client(_app(session_factory), operator, ADMIN_EMAIL) as client:
        response = await client.delete(f"/users/{other_admin}")
    assert response.status_code == 409, response.text
    assert "administrator account" in response.json()["detail"]
    async with session_factory() as session:
        assert await session.get(User, other_admin) is not None
    [event] = await _server_events(session_factory)
    assert event.action == "user.deletion_refused"
    assert event.details is not None and event.details["outcome"] == "refused"


async def test_an_unknown_user_is_not_found(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    operator, _ = await _people(session_factory)
    async with _client(_app(session_factory), operator, ADMIN_EMAIL) as client:
        response = await client.delete("/users/nobody")
    assert response.status_code == 404, response.text
