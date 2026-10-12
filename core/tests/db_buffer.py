"""The db-buffer on the test database, and the agent rows its events point at.

Agent events are rows in Postgres now, so a test of anything that queues or
reads them runs against the real tables: offsets, tenant isolation, cascades
and retention are SQL, and a stand-in would test the stand-in.
"""

from __future__ import annotations

import uuid
from datetime import timedelta
from typing import TYPE_CHECKING

from sqlalchemy import select, update

from switch_core.bridges.agent.protocol.event_buffer import EventBuffer
from switch_core.db.models import (
    TENANT_ZERO_ID,
    Agent,
    AgentEventRow,
    ApiKey,
    Client,
    User,
)
from switch_core.db.session_scope import tenant_session

if TYPE_CHECKING:
    from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker


def db_buffer_on(
    session_factory: async_sessionmaker[AsyncSession],
    *,
    retention_seconds: float = 3600,
) -> EventBuffer:
    return EventBuffer(
        session_factory, sequence_base=0, retention_seconds=retention_seconds
    )


async def seed_agent(
    session_factory: async_sessionmaker[AsyncSession],
    agent_id: str,
    *,
    tenant_id: str = TENANT_ZERO_ID,
) -> str:
    """An agent row with this id, and the client, key and owner it needs.

    Idempotent, so a test can name the agents it uses without tracking which
    it has made.
    """
    async with tenant_session(session_factory, tenant_id) as session:
        if await session.scalar(select(Agent.id).where(Agent.id == agent_id)):
            return agent_id
        suffix = uuid.uuid4().hex[:12]
        user = User(name=f"owner-{suffix}", email=f"{suffix}@test.local", role="user")
        session.add(user)
        await session.flush()
        api_key = ApiKey(
            user_id=user.id,
            key_hash=f"hash-{suffix}",
            encrypted_key="enc",
            label=agent_id,
            type="agent",
        )
        client = Client(
            transport_user_id=f"@{suffix}:test.local",
            display_name=agent_id,
            type="agent",
        )
        session.add_all([api_key, client])
        await session.flush()
        session.add(
            Agent(
                id=agent_id,
                name=f"{agent_id}-{suffix}",
                description="",
                agent_type="always_on",
                connector_type="claude_code",
                integration_profile={"connection_model": "always_on"},
                client_id=client.id,
                api_key_id=api_key.id,
            )
        )
        await session.commit()
    return agent_id


async def age_events(
    session_factory: async_sessionmaker[AsyncSession],
    agent_id: str,
    *,
    seconds: float,
    tenant_id: str = TENANT_ZERO_ID,
) -> None:
    """Make every event queued so far for `agent_id` older by `seconds`, so a
    test can put some past the retention window without waiting for it."""
    async with tenant_session(session_factory, tenant_id) as session:
        await session.execute(
            update(AgentEventRow)
            .where(AgentEventRow.agent_id == agent_id)
            .values(created_at=AgentEventRow.created_at - timedelta(seconds=seconds))
        )
        await session.commit()
