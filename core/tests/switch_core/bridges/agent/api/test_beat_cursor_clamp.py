"""A heartbeat's cursor is clamped to the buffer head before anything adopts it.

A client can beat a number from some other history: a restored database, or
another server, where the agent's sequence had reached further than it has
here. Nothing downstream can undo adopting it: `beat()` and `confirm()` both
refuse to move a cursor backwards, and the stream's own rewind on resume is
re-poisoned by the next heartbeat.

The result is silent. The connection is claimed, heartbeats succeed and posting
works, so the session looks healthy while every event up to the stale cursor is
skipped — and `confirm()` marks those events consumed on the way past.
"""

from __future__ import annotations

from typing import Any

import pytest
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.bridges.agent.api.handlers import _record_beat
from switch_core.bridges.agent.protocol.agent_connections import (
    PROTOCOL_VERSION,
    AgentConnectionRegistry,
    ClientDeclaration,
)
from switch_core.bridges.agent.protocol.event_buffer import EventBuffer
from switch_core.bridges.agent.protocol.types import AgentEvent, MessagePayload
from switch_core.db.models import TENANT_ZERO_ID
from tests.db_buffer import db_buffer_on, seed_agent

AGENT_ID = "agent-1"
CONN_ID = "conn-1"
ROOM_ID = "room-1"


@pytest.fixture(autouse=True)
async def _agent_row(session_factory: async_sessionmaker[AsyncSession]) -> None:
    """The agent these beats are for, so its events have a row to belong to."""
    await seed_agent(session_factory, AGENT_ID)


class _Protocol:
    def __init__(self, event_buffer: EventBuffer) -> None:
        self.event_buffer = event_buffer
        self.connections = AgentConnectionRegistry()


def _message() -> AgentEvent:
    return AgentEvent(
        type="message",
        room_id=ROOM_ID,
        payload=MessagePayload(
            addressed=True,
            sender="@u:s",
            sender_name="u",
            message_id="$m",
            body="hi",
            timestamp=0,
        ),
    )


def _connect(protocol: _Protocol, cursor: int = 0) -> Any:
    conn = protocol.connections.open(
        agent_id=AGENT_ID,
        connection_id=CONN_ID,
        scope="single",
        delivery_filter="all",
        spawn_capable=False,
        cursor=cursor,
        declaration=ClientDeclaration(speaks=PROTOCOL_VERSION),
        expected_generation=None,
    )
    conn.stream_attached = True
    return conn


async def _beat(protocol: _Protocol, cursor: int) -> Any:
    # Fenced with the only incarnation these tests ever open, as the socket
    # does with the incarnation it opened.
    current = protocol.connections.require(AGENT_ID, CONN_ID).stream_generation
    return await _record_beat(protocol, AGENT_ID, CONN_ID, cursor, current)  # type: ignore[arg-type]


async def test_a_cursor_past_the_head_is_pulled_back_to_it(
    db_buffer: EventBuffer,
) -> None:
    # The agent has no events here (head 0) and the client is beating a
    # sequence it reached against some other history.
    protocol = _Protocol(db_buffer)
    conn = _connect(protocol)

    beaten = await _beat(protocol, cursor=9)

    assert await protocol.event_buffer.head(TENANT_ZERO_ID, AGENT_ID) == 0
    assert conn.cursor == 0
    assert beaten.cursor == 0


async def test_the_next_event_after_a_foreign_cursor_is_still_delivered(
    db_buffer: EventBuffer,
) -> None:
    # The symptom the clamp exists to prevent: without it the connection sits at
    # cursor 9, and sequences 1..9 — including the message that arrives next —
    # are skipped with no error anywhere.
    protocol = _Protocol(db_buffer)
    conn = _connect(protocol)
    protocol.connections.claim_room(conn, ROOM_ID, takeover=True)

    await _beat(protocol, cursor=9)
    await protocol.event_buffer.enqueue(TENANT_ZERO_ID, AGENT_ID, ROOM_ID, _message())

    delivered = await protocol.event_buffer.read_from(
        TENANT_ZERO_ID, AGENT_ID, conn.cursor, rooms={ROOM_ID}
    )
    assert [item.seq for item in delivered] == [1]


async def test_a_cursor_within_the_buffer_is_left_alone(
    db_buffer: EventBuffer,
) -> None:
    protocol = _Protocol(db_buffer)
    conn = _connect(protocol)
    for _ in range(3):
        await protocol.event_buffer.enqueue(
            TENANT_ZERO_ID, AGENT_ID, ROOM_ID, _message()
        )

    await _beat(protocol, cursor=2)

    assert conn.cursor == 2


async def test_the_clamped_value_is_what_gets_confirmed(
    db_buffer: EventBuffer,
) -> None:
    # confirm() records how far the reader has consumed. Handing it the
    # foreign cursor would record events as consumed that were never
    # delivered, so the clamp has to reach it too.
    protocol = _Protocol(db_buffer)
    _connect(protocol)
    confirmed: list[int] = []
    protocol.event_buffer.confirm = (  # type: ignore[method-assign]
        lambda agent_id, connection_id, cursor: confirmed.append(cursor)
    )

    await _beat(protocol, cursor=9)

    assert confirmed == [0]


async def test_a_heartbeat_from_the_old_boot_cannot_undo_the_gap_position(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    protocol = _Protocol(db_buffer_on(session_factory, sequence_base=2 << 32))
    sequence = await protocol.event_buffer.enqueue(
        TENANT_ZERO_ID, AGENT_ID, ROOM_ID, _message()
    )
    conn = _connect(protocol, cursor=2 << 32)
    await _beat(protocol, cursor=(1 << 32) + 2)
    assert conn.cursor == 2 << 32
    assert (
        await protocol.event_buffer.read_from(TENANT_ZERO_ID, AGENT_ID, conn.cursor)
    )[0].seq == sequence
