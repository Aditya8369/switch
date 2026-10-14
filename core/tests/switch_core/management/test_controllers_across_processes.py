"""Controller-backed agents, seen and served by every switch-core process.

Two processes on one database, each with its own presence, its own management
and a signal bus listening on the real `NOTIFY` channel. A controller's socket
is held by one of them; the other must read its agents as live, keep the same
bindings, let the socket attach after an open it did not handle, and close its
own copy when the controller is taken over elsewhere.
"""

from __future__ import annotations

import asyncio
import time
from collections.abc import AsyncIterator, Callable
from datetime import timedelta

import pytest
from sqlalchemy import update
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine
from sqlalchemy.pool import NullPool

from switch_core.bridges.agent.protocol.connection_rows import SharedConnections
from switch_core.bridges.agent.protocol.presence import agents_present_in
from switch_core.db.models import SwitchCoreProcess
from switch_core.db.stores.agent_connection_store import AgentConnectionStore
from switch_core.management.dependencies import get_authenticator, get_management
from switch_core.process_lease import LEASE_TTL
from tests.switch_core.management.harness import (
    Harness,
    add_member,
    add_room,
    build_harness,
    connect,
    cookies_for,
    enroll_console,
    open_connection,
    open_stream,
    place_agent,
    take,
)

SessionFactory = async_sessionmaker[AsyncSession]

WAIT_SECONDS = 10.0


async def _eventually(check: Callable[[], bool]) -> None:
    deadline = time.monotonic() + WAIT_SECONDS
    while not check():
        if time.monotonic() > deadline:
            raise AssertionError("the other process never caught up")
        await asyncio.sleep(0.02)


def _returning(value: object) -> Callable[[], object]:
    return lambda: value


@pytest.fixture
async def processes(
    postgres_url: str, session_factory: SessionFactory
) -> AsyncIterator[tuple[Harness, Harness]]:
    harnesses = [
        build_harness(
            session_factory,
            signal_engine=lambda: create_async_engine(postgres_url, poolclass=NullPool),
        )
        for _ in range(2)
    ]
    shared: list[SharedConnections] = []
    for harness in harnesses:
        # Management's dependencies are one per process; here two processes
        # share one interpreter, so each app is pointed at its own.
        for app in (harness.app, harness.gateway_app):
            app.dependency_overrides[get_management] = _returning(
                harness.management.service
            )
            app.dependency_overrides[get_authenticator] = _returning(
                harness.management.authenticator
            )
        shared.append(
            SharedConnections(
                registry=harness.protocol.connections,
                session_factory=session_factory,
                store=AgentConnectionStore(),
                bus=harness.bus,
                lease=harness.management.lease,
            )
        )
        await harness.management.lease.renew()
    for harness in harnesses:
        await harness.bus.start()
    for harness in harnesses:
        await asyncio.wait_for(harness.bus.connected.wait(), WAIT_SECONDS)
    ledgers = [
        asyncio.create_task(harness.management.run()) for harness in harnesses
    ] + [asyncio.create_task(process.run()) for process in shared]
    try:
        yield harnesses[0], harnesses[1]
    finally:
        # The buses first, so no signal starts work after the processes
        # stopped running; then the runs, which wait for the work they started.
        for harness in harnesses:
            await harness.bus.stop()
        for task in ledgers:
            task.cancel()
        await asyncio.gather(*ledgers, return_exceptions=True)


class TestBindings:
    async def test_an_agent_placed_through_one_process_is_bound_in_the_other(
        self, processes: tuple[Harness, Harness]
    ) -> None:
        here, there = processes
        owner = await add_member(here.session_factory, "ada")
        async with here.client() as client:
            controller = await enroll_console(here, client, owner)
            agent_id = await place_agent(client, controller, name="reviewer")

            await _eventually(
                lambda: there.protocol.connections.controllers.is_bound(agent_id)
            )
            binding = there.protocol.connections.controllers.binding(agent_id)
            assert binding is not None
            assert binding.controller_id == controller.controller_id

            removed = await client.delete(
                f"/gateway/management/agents/{agent_id}",
                cookies=cookies_for(owner),
            )
            assert removed.status_code == 200, removed.text

        await _eventually(
            lambda: not there.protocol.connections.controllers.is_bound(agent_id)
        )


class TestPresence:
    async def test_a_managed_agent_connected_to_one_process_reads_live_from_the_other(
        self, processes: tuple[Harness, Harness]
    ) -> None:
        here, there = processes
        owner = await add_member(here.session_factory, "ada")
        async with here.client() as client:
            controller = await enroll_console(here, client, owner)
            agent_id = await place_agent(client, controller, name="reviewer")
            room_id = await add_room(here.session_factory, agent_id)
            await connect(client, controller)

        presence = there.protocol.connections.controllers
        await _eventually(lambda: presence.is_live(agent_id))
        await _eventually(lambda: presence.live_in_room(agent_id, room_id))
        assert agents_present_in([agent_id], room_id, there.protocol.connections) == {
            agent_id
        }
        assert agent_id in there.protocol.connections.live_agent_ids()
        # The process holding the socket is the one that reports it.
        assert presence.live_connection_count() == 0
        assert there.protocol.connections.live_agents_by_transport() == {}

    async def test_an_agent_bound_to_a_controller_held_elsewhere_is_in_its_rooms(
        self, processes: tuple[Harness, Harness]
    ) -> None:
        """The binding reaches the other process after the controller's
        socket did, and the agent is present in its rooms there at once."""
        here, there = processes
        owner = await add_member(here.session_factory, "ada")
        presence = there.protocol.connections.controllers
        async with here.client() as client:
            controller = await enroll_console(here, client, owner)
            agent_id = await place_agent(client, controller, name="reviewer")
            await _eventually(lambda: presence.is_live(agent_id))
            room_id = await add_room(here.session_factory, agent_id)
            for state in ("stopped", "running"):
                changed = await client.patch(
                    f"/gateway/management/agents/{agent_id}",
                    json={"desired_state": state},
                    cookies=cookies_for(owner),
                )
                assert changed.status_code == 200, changed.text
                await _eventually(
                    lambda state=state: (
                        presence.is_live(agent_id) == (state == "running")
                    )
                )

        await _eventually(lambda: presence.live_in_room(agent_id, room_id))

    async def test_the_socket_going_is_seen_by_the_other(
        self, processes: tuple[Harness, Harness]
    ) -> None:
        here, there = processes
        owner = await add_member(here.session_factory, "ada")
        async with here.client() as client:
            controller = await enroll_console(here, client, owner)
            agent_id = await place_agent(client, controller, name="reviewer")
            await connect(client, controller)
        presence = there.protocol.connections.controllers
        await _eventually(lambda: presence.is_live(agent_id))

        held = here.protocol.connections.controllers
        conn = held.current_connection(controller.controller_id)
        assert conn is not None
        held.detach_stream(conn, conn.stream_token)

        await _eventually(lambda: not presence.is_live(agent_id))

    async def test_a_dead_holder_stops_counting_on_the_next_pass(
        self, processes: tuple[Harness, Harness], session_factory: SessionFactory
    ) -> None:
        here, there = processes
        owner = await add_member(here.session_factory, "ada")
        async with here.client() as client:
            controller = await enroll_console(here, client, owner)
            agent_id = await place_agent(client, controller, name="reviewer")
            await connect(client, controller)
        presence = there.protocol.connections.controllers
        await _eventually(lambda: presence.is_live(agent_id))
        async with session_factory() as session:
            await session.execute(
                update(SwitchCoreProcess)
                .where(SwitchCoreProcess.id == here.management.lease.process_id)
                .values(
                    beat_at=SwitchCoreProcess.beat_at - LEASE_TTL - timedelta(seconds=1)
                )
            )
            await session.commit()

        await there.management.service.signals.read_connections()

        assert not presence.is_live(agent_id)

    async def test_a_session_command_reaches_the_controller_on_the_other_process(
        self, processes: tuple[Harness, Harness]
    ) -> None:
        here, there = processes
        owner = await add_member(here.session_factory, "ada")
        async with here.client() as client:
            controller = await enroll_console(here, client, owner)
            agent_id = await place_agent(client, controller, name="reviewer")
            await connect(client, controller)
        await _eventually(
            lambda: there.protocol.connections.controllers.is_live(agent_id)
        )
        frame = {"command": "interrupt", "origin": {"roomId": "room"}}

        assert there.protocol.connections.relay_session_command(agent_id, frame)

        conn = here.protocol.connections.controllers.current_connection(
            controller.controller_id
        )
        assert conn is not None
        await _eventually(lambda: conn.session_commands == [(agent_id, frame)])


class TestTheConnectionOnAnyProcess:
    async def test_the_socket_attaches_through_the_process_that_did_not_open_it(
        self, processes: tuple[Harness, Harness]
    ) -> None:
        here, there = processes
        owner = await add_member(here.session_factory, "ada")
        async with here.client() as client:
            controller = await enroll_console(here, client, owner)
            opened = await open_connection(client, controller)

        stream = await open_stream(there, controller, opened)
        ((name, state),) = await take(stream, 1)
        await stream.aclose()  # type: ignore[attr-defined]

        assert name == "connection_state"
        assert state["connection_id"] == opened["connection_id"]
        assert state["generation"] == opened["generation"]
        adopted = there.protocol.connections.controllers.current_connection(
            controller.controller_id
        )
        assert adopted is not None
        assert adopted.id == opened["connection_id"]
        # The process that opened it lets its copy go once told.
        await _eventually(
            lambda: (
                here.protocol.connections.controllers.current_connection(
                    controller.controller_id
                )
                is None
            )
        )

    async def test_a_socket_reattaching_through_the_other_process_resumes_there(
        self, processes: tuple[Harness, Harness]
    ) -> None:
        """The socket dropped and came back through the other process: the
        connection is taken up there, each agent resuming where the beats had
        confirmed it, which were written when the socket went."""
        here, there = processes
        owner = await add_member(here.session_factory, "ada")
        async with here.client() as client:
            controller = await enroll_console(here, client, owner)
            agent_id = await place_agent(client, controller, name="reviewer")
        held = here.protocol.connections.controllers
        conn = held.current_connection(controller.controller_id)
        assert conn is not None
        held.resume_from(conn, agent_id, 42)
        held.detach_stream(conn, conn.stream_token)
        await here.management.ledger.flush_all()

        stream = await open_stream(
            there,
            controller,
            {"connection_id": conn.id, "generation": conn.generation},
        )
        await take(stream, 1)
        await stream.aclose()  # type: ignore[attr-defined]

        adopted = there.protocol.connections.controllers.current_connection(
            controller.controller_id
        )
        assert adopted is not None
        assert adopted.id == conn.id
        assert adopted.resume_cursors[agent_id] == 42

    async def test_an_attach_naming_another_generation_is_still_refused(
        self, processes: tuple[Harness, Harness]
    ) -> None:
        here, there = processes
        owner = await add_member(here.session_factory, "ada")
        async with here.client() as client:
            controller = await enroll_console(here, client, owner)
            opened = await open_connection(client, controller)

        with pytest.raises(Exception) as refused:
            await open_stream(
                there,
                controller,
                {
                    "connection_id": opened["connection_id"],
                    "generation": opened["generation"] + 1,
                },
            )

        assert getattr(refused.value, "status_code", None) == 404
        assert (
            there.protocol.connections.controllers.current_connection(
                controller.controller_id
            )
            is None
        )

    async def test_opening_through_the_other_process_takes_the_connection_over(
        self, processes: tuple[Harness, Harness]
    ) -> None:
        here, there = processes
        owner = await add_member(here.session_factory, "ada")
        async with here.client() as client:
            controller = await enroll_console(here, client, owner)
            await connect(client, controller)
        loser = here.protocol.connections.controllers.current_connection(
            controller.controller_id
        )
        assert loser is not None

        async with there.client() as elsewhere:
            await open_connection(elsewhere, controller)

        await _eventually(lambda: loser.closure is not None)
        assert loser.closure is not None
        assert loser.closure.code == "taken_over"
        assert (
            here.protocol.connections.controllers.current_connection(
                controller.controller_id
            )
            is None
        )
