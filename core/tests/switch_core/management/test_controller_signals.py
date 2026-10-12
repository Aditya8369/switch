"""Management's nudges reach the controller wherever it streams from."""

from __future__ import annotations

import asyncio
import uuid
from datetime import UTC, datetime
from typing import TYPE_CHECKING

import pytest
from sqlalchemy.ext.asyncio import create_async_engine
from sqlalchemy.pool import NullPool

from switch_core.bridges.agent.protocol.agent_connections import AgentConnectionRegistry
from switch_core.db.models import TENANT_ZERO_ID
from switch_core.db.session_scope import tenant_session
from switch_core.db.stores.agent_controller_operation_store import (
    AgentControllerOperationStore,
)
from switch_core.db.stores.agent_controller_store import AgentControllerStore
from switch_core.management.notifier import (
    ASSIGNMENT_CHANGED,
    CREDENTIAL_REVOKED,
    OPERATION_PENDING,
    ControllerNotifier,
)
from switch_core.management.signals import ControllerSignals
from switch_core.signals import SignalBus
from tests.switch_core.management.harness import (
    Harness,
    add_member,
    build_harness,
    enroll_console,
    open_connection,
    open_stream,
    take,
)

if TYPE_CHECKING:
    from collections.abc import AsyncIterator

    from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

DELIVERY_TIMEOUT = 10.0


def _process(
    postgres_url: str, session_factory: async_sessionmaker[AsyncSession]
) -> tuple[ControllerSignals, AgentConnectionRegistry, SignalBus]:
    """One switch-core process's share of it: its own presence, notifier and bus."""
    registry = AgentConnectionRegistry()
    bus = SignalBus(
        session_factory,
        lambda: create_async_engine(postgres_url, poolclass=NullPool),
        process_id=str(uuid.uuid4()),
    )
    signals = ControllerSignals(
        notifier=ControllerNotifier(),
        presence=registry.controllers,
        bus=bus,
        session_factory=session_factory,
        controllers=AgentControllerStore(),
        operations=AgentControllerOperationStore(),
        clock=lambda: datetime.now(UTC),
    )
    return signals, registry, bus


@pytest.fixture
async def two_processes(
    postgres_url: str, session_factory: async_sessionmaker[AsyncSession]
) -> AsyncIterator[tuple[ControllerSignals, ControllerSignals]]:
    first, _, first_bus = _process(postgres_url, session_factory)
    second, _, second_bus = _process(postgres_url, session_factory)
    for bus in (first_bus, second_bus):
        await bus.start()
    for bus in (first_bus, second_bus):
        await asyncio.wait_for(bus.connected.wait(), DELIVERY_TIMEOUT)
    yield first, second
    await first_bus.stop()
    await second_bus.stop()


async def _woken(subscription: object) -> None:
    await asyncio.wait_for(subscription.wake.wait(), DELIVERY_TIMEOUT)  # type: ignore[attr-defined]


class TestAcrossProcesses:
    async def test_a_change_in_one_process_nudges_a_stream_in_another(
        self, two_processes: tuple[ControllerSignals, ControllerSignals]
    ) -> None:
        handled_here, streaming_there = two_processes
        subscription = streaming_there.notifier.subscribe("c1")

        handled_here.assignment_changed("c1", 7)
        handled_here.operation_pending(
            "c1", operation_id="o1", kind="provider.recheck", agent_id=None
        )
        await _woken(subscription)
        async with asyncio.timeout(DELIVERY_TIMEOUT):
            frames = subscription.drain()
            while len(frames) < 2:
                await _woken(subscription)
                frames += subscription.drain()

        assert frames == [
            (ASSIGNMENT_CHANGED, {"revision": 7}),
            (
                OPERATION_PENDING,
                {"operation_id": "o1", "kind": "provider.recheck", "agent_id": None},
            ),
        ]

    async def test_the_process_that_made_the_change_nudges_at_once(
        self, two_processes: tuple[ControllerSignals, ControllerSignals]
    ) -> None:
        handled_here, _ = two_processes
        subscription = handled_here.notifier.subscribe("c1")

        handled_here.assignment_changed("c1", 2)

        assert subscription.drain() == [(ASSIGNMENT_CHANGED, {"revision": 2})]

    async def test_a_revocation_reaches_the_other_process(
        self, two_processes: tuple[ControllerSignals, ControllerSignals]
    ) -> None:
        handled_here, streaming_there = two_processes
        subscription = streaming_there.notifier.subscribe("c1")

        handled_here.revoked("c1")
        await _woken(subscription)

        assert subscription.drain() == [(CREDENTIAL_REVOKED, {})]
        assert streaming_there._presence.is_revoked("c1")


@pytest.fixture
def harness(session_factory: async_sessionmaker[AsyncSession]) -> Harness:
    return build_harness(session_factory)


class TestResync:
    async def test_a_held_controller_is_renudged_from_the_database(
        self, harness: Harness
    ) -> None:
        owner = await add_member(harness.session_factory, "ada")
        async with harness.client() as client:
            controller = await enroll_console(harness, client, owner)
            opened = await open_connection(client, controller)
            stream = await open_stream(harness, controller, opened)
            (opening,) = await take(stream, 1)

            await harness.management.service.signals.resync()
            nudged = await take(stream, 1)
            await stream.aclose()

        assert nudged == [
            (ASSIGNMENT_CHANGED, {"revision": opening[1]["assignment_revision"]})
        ]

    async def test_a_controller_revoked_meanwhile_is_closed(
        self, harness: Harness
    ) -> None:
        owner = await add_member(harness.session_factory, "ada")
        async with harness.client() as client:
            controller = await enroll_console(harness, client, owner)
            opened = await open_connection(client, controller)
            stream = await open_stream(harness, controller, opened)
            await take(stream, 1)
            async with tenant_session(
                harness.session_factory, TENANT_ZERO_ID
            ) as session:
                await AgentControllerStore().mark_revoked(
                    session, TENANT_ZERO_ID, controller.controller_id, datetime.now(UTC)
                )
                await session.commit()

            await harness.management.service.signals.resync()
            final = await take(stream, 1)
            with pytest.raises(StopAsyncIteration):
                await anext(stream)

        assert final == [(CREDENTIAL_REVOKED, {})]
