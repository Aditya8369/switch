"""The gateway route that limits an agent's "can manage agents" capability to
chosen saved templates.

Against real Postgres with real stores: only the owner sets it; each template
must be one the owner can read and saved by a person or shipped with Switch,
since an agent may rewrite a template it saved; null lifts the limit.
"""

from __future__ import annotations

from types import SimpleNamespace

import pytest
from fastapi import HTTPException
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.bridges.agent.protocol.agent_connections import AgentConnectionRegistry
from switch_core.db.models import Agent, Template, User
from switch_core.db.stores.agent_session_store import AgentSessionStore
from switch_core.db.stores.agent_store import AgentStore
from switch_core.db.stores.room_role_store import RoomRoleStore
from switch_core.db.stores.room_store import RoomStore
from switch_core.db.stores.user_store import UserStore
from switch_core.feature_flags import AGENT_MANAGEMENT, SWITCH_BUDDY
from switch_core.gateway.agents import update_manage_agents_templates
from switch_core.gateway.schemas import (
    AgentDetail,
    UpdateAgentManageAgentsTemplatesRequest,
)
from switch_core.official_templates import official_templates
from tests.switch_core.gateway.agent_route_harness import add_agent, add_user


async def _set(
    session: AsyncSession, agent_id: str, user: User, templates: list[str] | None
) -> AgentDetail:
    return await update_manage_agents_templates(
        agent_id,
        UpdateAgentManageAgentsTemplatesRequest(templates=templates),
        session,
        AgentStore(),
        RoomStore(),
        UserStore(),
        SimpleNamespace(  # type: ignore[arg-type]
            agent_session_store=AgentSessionStore(),
            room_role_store=RoomRoleStore(),
            connections=AgentConnectionRegistry(),
        ),
        SimpleNamespace(  # type: ignore[arg-type]
            feature_flags={AGENT_MANAGEMENT: True, SWITCH_BUDDY: False}
        ),
        user,
    )


async def _template(
    session: AsyncSession,
    owner: User,
    name: str,
    *,
    by_agent: str | None = None,
    private: bool = False,
) -> str:
    template = Template(
        owner_id=owner.id,
        name=name,
        description=name,
        kind="agent",
        content="version: 1\n",
        created_by_agent_id=by_agent,
        read_visibility="private" if private else "public",
    )
    session.add(template)
    await session.flush()
    return template.id


async def _stored(session: AsyncSession, agent_id: str) -> list | None:
    agent = await session.get(Agent, agent_id, populate_existing=True)
    assert agent is not None
    return agent.manage_agents_templates


async def test_the_owner_limits_it_and_lifts_the_limit(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    async with session_factory() as session:
        owner = await add_user(session, name="owner")
        agent = await add_agent(session, name="helper", owner_id=owner.id)
        mine = await _template(session, owner, "character")
        official = official_templates(True, False)[0].id
        assert await _stored(session, agent.id) is None

        detail = await _set(session, agent.id, owner, [mine, official, mine])
        assert detail.manage_agents_templates == [mine, official]
        assert await _stored(session, agent.id) == [mine, official]

        detail = await _set(session, agent.id, owner, None)
        assert detail.manage_agents_templates is None
        assert await _stored(session, agent.id) is None


async def test_a_template_an_agent_saved_is_refused(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    async with session_factory() as session:
        owner = await add_user(session, name="owner")
        agent = await add_agent(session, name="helper", owner_id=owner.id)
        saved_by_agent = await _template(session, owner, "its-own", by_agent=agent.id)

        with pytest.raises(HTTPException) as refused:
            await _set(session, agent.id, owner, [saved_by_agent])

        assert refused.value.status_code == 422
        assert "saved by an agent" in str(refused.value.detail)
        assert await _stored(session, agent.id) is None


async def test_a_template_the_owner_cannot_see_or_that_is_missing_is_refused(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    async with session_factory() as session:
        owner = await add_user(session, name="owner")
        other = await add_user(session, name="other")
        agent = await add_agent(session, name="helper", owner_id=owner.id)
        private = await _template(session, other, "theirs", private=True)

        for template_id in (private, "no-such-template", "official:no-such"):
            with pytest.raises(HTTPException) as refused:
                await _set(session, agent.id, owner, [template_id])
            assert refused.value.status_code == 422
        assert await _stored(session, agent.id) is None


@pytest.mark.parametrize("role", ["user", "admin"])
async def test_nobody_else_may_change_it_not_even_an_admin(
    session_factory: async_sessionmaker[AsyncSession], role: str
) -> None:
    async with session_factory() as session:
        owner = await add_user(session, name="owner")
        other = await add_user(session, name="other", role=role)
        agent = await add_agent(session, name="helper", owner_id=owner.id)

        with pytest.raises(HTTPException) as refused:
            await _set(session, agent.id, other, [])

        assert refused.value.status_code == 403
        assert await _stored(session, agent.id) is None
