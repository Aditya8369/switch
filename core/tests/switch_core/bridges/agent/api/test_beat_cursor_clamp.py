"""A heartbeat's place is lowered to what the server has sent on the
connection before anything adopts it.

A client can beat a number from some other history: a restored database, or
another server, where the agent's sequence had reached further than it has
here. Nothing downstream can undo adopting it: `beat()` refuses to move a
position backwards, and the stream's own rewind on resume is re-poisoned by the
next heartbeat.

The result is silent. The connection is claimed, heartbeats succeed and posting
works, so the session looks healthy while every event up to the stale number is
skipped.

The bound is what this server has sent on the connection, which it keeps in
memory, so a beat costs no database query. It applies however a client reports
how far it has read: inside the position a client of revision 9 holds, as the
one number an older client reading only its own events sends, or as a ticket.
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
from switch_core.bridges.agent.protocol.event_buffer import TICKET_FLOOR, EventBuffer
from switch_core.bridges.agent.protocol.positions import (
    OWN_EVENTS,
    Position,
    room_source,
)
from switch_core.bridges.agent.protocol.types import AgentEvent, MessagePayload
from switch_core.db.models import TENANT_ZERO_ID
from tests.db_buffer import db_buffer_on, seed_agent

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
    return _record_beat(
        protocol,  # type: ignore[arg-type]
        AGENT_ID,
        CONN_ID,
        cursor,
        current,
        position,
    )


@pytest.mark.parametrize("reports", [POSITION, ONE_NUMBER])
async def test_a_number_past_what_was_sent_is_pulled_back_to_it(
    db_buffer: EventBuffer, reports: str
) -> None:
    # Nothing has been sent on this connection and the client is beating a
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
async def test_a_number_within_what_was_sent_never_moves_the_place_back(
    db_buffer: EventBuffer, reports: str
) -> None:
    """A beat reports what the client has handled, which lags what the stream
    has written out. The connection keeps the further of the two."""
    protocol = _Protocol(db_buffer)
    conn = _connect(protocol, reports=reports)
    for index in range(3):
        await _addressed(protocol.event_buffer, index)
    conn.position[OWN_EVENTS] = 3  # as the stream records once it has sent all three

    await _beat(protocol, 2, reports)

    assert conn.position[OWN_EVENTS] == 3


async def test_a_beat_reads_nothing_from_the_database() -> None:
    """Beats arrive every few seconds from every client, and a burst of them
    follows any restart. They are answered from memory."""
    protocol = _Protocol(event_buffer=None)  # type: ignore[arg-type]
    conn = _connect(protocol)
    conn.position = {OWN_EVENTS: 4, room_source(ROOM_ID): 7}

    beaten = await _beat(protocol, 9)

    assert beaten.position == {OWN_EVENTS: 4, room_source(ROOM_ID): 7}


async def test_a_ticket_is_read_from_what_was_sent_on_the_connection() -> None:
    """A client that holds one number but reads the conversation beats with the
    last ticket it was sent. The ticket is read from the connection, not from
    `agent_position_tickets`, and one the connection never sent is ignored."""
    protocol = _Protocol(event_buffer=None)  # type: ignore[arg-type]
    conn = protocol.connections.open(
        agent_id=AGENT_ID,
        connection_id=CONN_ID,
        scope="single",
        delivery_filter="all",
        spawn_capable=False,
        position={OWN_EVENTS: 4, room_source(ROOM_ID): 7},
        declaration=ClientDeclaration(speaks=POSITIONS_PROTOCOL_REVISION - 1),
        expected_generation=None,
    )
    conn.stream_attached = True
    conn.issued(TICKET_FLOOR + 1, {OWN_EVENTS: 4, room_source(ROOM_ID): 7})

    for ticket in (TICKET_FLOOR + 1, TICKET_FLOOR + 99):
        _record_beat(
            protocol,  # type: ignore[arg-type]
            AGENT_ID,
            CONN_ID,
            ticket,
            conn.stream_generation,
        )

    assert conn.position == {OWN_EVENTS: 4, room_source(ROOM_ID): 7}


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


async def test_a_room_place_past_what_was_sent_is_pulled_back_to_it(
    db_buffer: EventBuffer,
) -> None:
    """The same bound, for a client reading a room's conversation: a place
    beyond what the connection was sent in that room would pass over that many
    of the room's next messages, and a room the connection has no place in is
    not added by a beat."""
    protocol = _Protocol(db_buffer)
    conn = _connect(protocol)
    conn.position[room_source(ROOM_ID)] = 2

    _record_beat(
        protocol,  # type: ignore[arg-type]
        AGENT_ID,
        CONN_ID,
        0,
        conn.stream_generation,
        {OWN_EVENTS: 0, room_source(ROOM_ID): 9, room_source("elsewhere"): 5},
    )

    assert conn.position == {OWN_EVENTS: 0, room_source(ROOM_ID): 2}


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
