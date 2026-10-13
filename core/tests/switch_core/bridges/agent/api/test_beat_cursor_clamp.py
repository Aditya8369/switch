"""A heartbeat's place in the agent's own events is clamped to their head
before anything adopts it.

A client can beat a number from some other history: a restored database, or
another server, where the agent's sequence had reached further than it has
here. Nothing downstream can undo adopting it: `beat()` refuses to move a
position backwards, and the stream's own rewind on resume is re-poisoned by the
next heartbeat.

The result is silent. The connection is claimed, heartbeats succeed and posting
works, so the session looks healthy while every event up to the stale number is
skipped.

The clamp is on the agent's own events (`s`), however a client reports how far
it has read them: inside the position a client of revision 9 holds, or as the
one number an older client reading only its own events sends.
"""

from __future__ import annotations

from types import SimpleNamespace

import pytest
from fastapi import HTTPException
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.bridges.agent.api.handlers import _record_beat, connection_beat
from switch_core.bridges.agent.api.schemas import ConnectionBeatRequest
from switch_core.bridges.agent.protocol.agent_connections import (
    POSITIONS_PROTOCOL_REVISION,
    PROTOCOL_VERSION,
    AgentConnection,
    AgentConnectionRegistry,
    ClientDeclaration,
)
from switch_core.bridges.agent.protocol.event_buffer import EventBuffer
from switch_core.bridges.agent.protocol.positions import (
    OWN_EVENTS,
    Position,
    room_source,
)
from switch_core.bridges.agent.protocol.types import AgentEvent, MessagePayload
from switch_core.db.models import TENANT_ZERO_ID
from tests.db_buffer import db_buffer_on, say, seed_agent, seed_room

AGENT_ID = "agent-1"
CONN_ID = "conn-1"
ROOM_ID = "room-1"

# The two ways a client reports how far it has read its own events.
POSITION = "position"
ONE_NUMBER = "one number"


@pytest.fixture(autouse=True)
async def _agent_row(session_factory: async_sessionmaker[AsyncSession]) -> None:
    """The agent these beats are for, so its events have a row to belong to."""
    await seed_agent(session_factory, AGENT_ID)


class _Protocol:
    def __init__(self, event_buffer: EventBuffer) -> None:
        self.event_buffer = event_buffer
        self.connections = AgentConnectionRegistry()


async def _addressed(buffer: EventBuffer, index: int = 0) -> int:
    """A message addressed to the agent, kept as one of its own events."""
    return await buffer.enqueue(
        TENANT_ZERO_ID,
        AGENT_ID,
        ROOM_ID,
        AgentEvent(
            type="message",
            room_id=ROOM_ID,
            payload=MessagePayload(
                addressed=True,
                sender="@u:s",
                sender_name="u",
                message_id=f"$m-{index}",
                body="hi",
                timestamp=0,
            ),
        ),
        room_seq=index + 1,
        message_key=f"$m-{index}",
    )


def _connect(
    protocol: _Protocol, at: int = 0, reports: str = POSITION
) -> AgentConnection:
    """A client of revision 9 reads the conversation too and holds a position.
    An older one reading only its own events holds their number."""
    one_number = reports == ONE_NUMBER
    conn = protocol.connections.open(
        agent_id=AGENT_ID,
        connection_id=CONN_ID,
        scope="single",
        delivery_filter="addressed" if one_number else "all",
        spawn_capable=False,
        position={OWN_EVENTS: at},
        declaration=ClientDeclaration(
            speaks=POSITIONS_PROTOCOL_REVISION - 1 if one_number else PROTOCOL_VERSION
        ),
        expected_generation=None,
    )
    conn.stream_attached = True
    return conn


async def _beat(
    protocol: _Protocol, seq: int, reports: str = POSITION
) -> AgentConnection:
    # Fenced with the only incarnation these tests ever open, as the socket
    # does with the incarnation it opened.
    current = protocol.connections.require(AGENT_ID, CONN_ID).stream_generation
    position: Position | None = None
    cursor = seq
    if reports == POSITION:
        position, cursor = {OWN_EVENTS: seq}, 0
    return await _record_beat(
        protocol,  # type: ignore[arg-type]
        AGENT_ID,
        CONN_ID,
        cursor,
        current,
        position,
    )


@pytest.mark.parametrize("reports", [POSITION, ONE_NUMBER])
async def test_a_number_past_the_head_is_pulled_back_to_it(
    db_buffer: EventBuffer, reports: str
) -> None:
    # The agent has no events here (head 0) and the client is beating a
    # sequence it reached against some other history.
    protocol = _Protocol(db_buffer)
    conn = _connect(protocol, reports=reports)

    beaten = await _beat(protocol, 9, reports)

    assert await protocol.event_buffer.head(TENANT_ZERO_ID, AGENT_ID) == 0
    assert conn.position[OWN_EVENTS] == 0
    assert beaten.position[OWN_EVENTS] == 0


async def test_the_next_event_after_a_foreign_number_is_still_delivered(
    db_buffer: EventBuffer,
) -> None:
    # The symptom the clamp exists to prevent: without it the connection sits at
    # 9 in the agent's own events, and 1 to 9, the message that arrives next
    # among them, are skipped with no error anywhere.
    protocol = _Protocol(db_buffer)
    conn = _connect(protocol)
    protocol.connections.claim_room(conn, ROOM_ID, takeover=True)

    await _beat(protocol, 9)
    await _addressed(protocol.event_buffer)

    delivered = await protocol.event_buffer.read_from(
        TENANT_ZERO_ID, AGENT_ID, conn.position[OWN_EVENTS], rooms={ROOM_ID}
    )
    assert [item.seq for item in delivered] == [1]


@pytest.mark.parametrize("reports", [POSITION, ONE_NUMBER])
async def test_a_number_within_the_buffer_is_left_alone(
    db_buffer: EventBuffer, reports: str
) -> None:
    protocol = _Protocol(db_buffer)
    conn = _connect(protocol, reports=reports)
    for index in range(3):
        await _addressed(protocol.event_buffer, index)

    await _beat(protocol, 2, reports)

    assert conn.position[OWN_EVENTS] == 2


async def test_a_heartbeat_from_the_old_boot_cannot_undo_the_gap_position(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    protocol = _Protocol(db_buffer_on(session_factory, sequence_base=2 << 32))
    sequence = await _addressed(protocol.event_buffer)
    conn = _connect(protocol, at=2 << 32)
    await _beat(protocol, (1 << 32) + 2)
    assert conn.position[OWN_EVENTS] == 2 << 32
    assert (
        await protocol.event_buffer.read_from(
            TENANT_ZERO_ID, AGENT_ID, conn.position[OWN_EVENTS]
        )
    )[0].seq == sequence


async def test_a_place_past_a_rooms_end_is_pulled_back_to_it(
    db_buffer: EventBuffer, session_factory: async_sessionmaker[AsyncSession]
) -> None:
    """The same clamp, for a client reading a room's conversation: a place the
    room's log does not reach would pass over that many of its next messages."""
    protocol = _Protocol(db_buffer)
    await seed_room(session_factory, ROOM_ID)
    await say(session_factory, ROOM_ID, "one")
    await say(session_factory, ROOM_ID, "two")
    conn = _connect(protocol)
    current = conn.stream_generation

    await _record_beat(
        protocol,  # type: ignore[arg-type]
        AGENT_ID,
        CONN_ID,
        0,
        current,
        {OWN_EVENTS: 0, room_source(ROOM_ID): 9},
    )

    assert conn.position[room_source(ROOM_ID)] == 2


async def test_a_heartbeat_with_something_that_is_not_a_position_is_refused(
    db_buffer: EventBuffer,
) -> None:
    """Refused rather than kept: a source the server does not know would sit
    in the position and never move, and the client would not know why."""
    protocol = _Protocol(db_buffer)
    conn = _connect(protocol)

    with pytest.raises(HTTPException) as refused:
        await connection_beat(
            AGENT_ID,
            ConnectionBeatRequest(
                connection_id=CONN_ID,
                cursor=0,
                generation=conn.stream_generation,
                position={"elsewhere": 3},
            ),
            agent=SimpleNamespace(id=AGENT_ID, tenant_id=TENANT_ZERO_ID),  # type: ignore[arg-type]
            protocol=protocol,  # type: ignore[arg-type]
        )

    assert refused.value.status_code == 422
