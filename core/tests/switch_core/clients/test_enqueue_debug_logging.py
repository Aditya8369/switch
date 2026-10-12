"""The debug line for an enqueued event costs nothing unless DEBUG is on.

It pretty-prints the whole event, and an argument to `logger.debug` is built
before the level is checked. That ran once per agent per message: on a busy
server, thousands of serialisations a second for a line nobody was logging.
"""

from __future__ import annotations

import logging
from types import SimpleNamespace

import pytest
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.bridges.agent.protocol.event_buffer import EventBuffer
from switch_core.bridges.agent.protocol.types import AgentEvent
from switch_core.clients.agent_consumer import AgentConsumer
from switch_core.db.models import TENANT_ZERO_ID
from switch_core.transport import InboundMedia, InboundMessage, RoomRef
from tests.db_buffer import seed_agent

_LOGGER = "switch_core.clients.agent_consumer"
AGENT = "agent-1"


@pytest.fixture(autouse=True)
async def _agent_row(session_factory: async_sessionmaker[AsyncSession]) -> None:
    """The agent the consumer queues for, so its events have a row to belong to."""
    await seed_agent(session_factory, AGENT)


async def _enqueued(buffer: EventBuffer) -> list[AgentEvent]:
    return [item.event for item in await buffer.read_from(TENANT_ZERO_ID, AGENT, 0)]


def _consumer(buffer: EventBuffer) -> SimpleNamespace:
    """An unaddressed delivery: no store is consulted, the event is enqueued."""

    async def _resolve_room_meta(_room_id: str) -> SimpleNamespace:
        return SimpleNamespace(
            room_id="room-1", bridge_id=None, channel_type="channel_public"
        )

    return SimpleNamespace(
        agent=SimpleNamespace(id=AGENT, name="helper"),
        tenant_id=TENANT_ZERO_ID,
        _resolve_room_meta=_resolve_room_meta,
        _addressed_without_lookup=lambda _event, _meta: False,
        _event_buffer=buffer,
    )


def _message() -> InboundMessage:
    return InboundMessage(
        room_id="!room:server",
        event_id="$evt",
        sender="@someone:switch.local",
        timestamp=1,
        content={"body": "hello"},
        body="hello",
        sender_name="someone",
    )


@pytest.fixture
def dumps(monkeypatch: pytest.MonkeyPatch) -> list[int]:
    calls: list[int] = []
    real = AgentEvent.model_dump_json

    def counting(self: AgentEvent, **kwargs: object) -> str:
        calls.append(1)
        return real(self, **kwargs)  # type: ignore[arg-type]

    monkeypatch.setattr(AgentEvent, "model_dump_json", counting)
    return calls


@pytest.mark.asyncio
async def test_an_event_is_not_serialised_for_a_debug_line_nobody_logs(
    dumps, caplog, db_buffer
):
    caplog.set_level(logging.INFO, logger=_LOGGER)

    await AgentConsumer.on_message(
        _consumer(db_buffer),  # type: ignore[arg-type]
        RoomRef(room_id="!room:server"),
        _message(),
    )

    assert len(await _enqueued(db_buffer)) == 1
    assert dumps == []
    assert not [r for r in caplog.records if "Enqueuing event" in r.getMessage()]


@pytest.mark.asyncio
async def test_the_debug_line_is_still_logged_when_debug_is_on(
    dumps, caplog, db_buffer
):
    caplog.set_level(logging.DEBUG, logger=_LOGGER)

    await AgentConsumer.on_message(
        _consumer(db_buffer),  # type: ignore[arg-type]
        RoomRef(room_id="!room:server"),
        _message(),
    )

    assert len(await _enqueued(db_buffer)) == 1
    assert dumps == [1]
    lines = [r for r in caplog.records if "Enqueuing event" in r.getMessage()]
    assert len(lines) == 1
    assert '"body": "hello"' in lines[0].getMessage()


@pytest.mark.parametrize("level", [logging.INFO, logging.DEBUG])
@pytest.mark.asyncio
async def test_a_media_event_is_serialised_only_when_debug_is_on(
    dumps, caplog, level, db_buffer
):
    caplog.set_level(level, logger=_LOGGER)
    media = InboundMedia(
        room_id="!room:server",
        event_id="$media",
        sender="@someone:switch.local",
        timestamp=1,
        content={"body": "a file"},
        body="a file",
        uri="mxc://server/file",
    )

    await AgentConsumer._emit_media(
        _consumer(db_buffer),  # type: ignore[arg-type]
        RoomRef(room_id="!room:server"),
        media,
        SimpleNamespace(  # type: ignore[arg-type]
            room_id="room-1", bridge_id=None, channel_type="channel_public"
        ),
        False,
        "someone",
        None,
        [],
        "a file",
    )

    assert len(await _enqueued(db_buffer)) == 1
    logged = [r for r in caplog.records if "Enqueuing media event" in r.getMessage()]
    if level == logging.DEBUG:
        assert dumps == [1]
        assert len(logged) == 1
    else:
        assert dumps == []
        assert logged == []
