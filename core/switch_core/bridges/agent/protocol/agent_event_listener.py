"""Hears new agent events and wakes this process's readers of that agent.

The other half of `db/agent_event_notify_ddl.py`. Whichever process writes an
agent's event, the one holding that agent's connection is woken here and reads
the rows after its cursor. A wake-up is not a delivery, so the notification
queue being lossy costs latency at worst; after a reconnect every reader here
is woken, since anything announced while the connection was down is gone.

Connection handling mirrors `MessageListener`: its own connection outside the
pool, a heartbeat, and a capped backoff.
"""

from __future__ import annotations

import asyncio
import contextlib
import json
import logging
from collections.abc import Callable
from typing import TYPE_CHECKING, Any

from switch_core.db.agent_event_notify_ddl import AGENT_EVENT_CHANNEL

if TYPE_CHECKING:
    from sqlalchemy.ext.asyncio import AsyncEngine

    from switch_core.bridges.agent.protocol.event_buffer import EventBuffer

logger = logging.getLogger(__name__)

HEARTBEAT_SECONDS = 20.0
HEARTBEAT_TIMEOUT_SECONDS = 60.0
RECONNECT_BACKOFF_BASE = 1.0
RECONNECT_BACKOFF_CAP = 15.0

EngineFactory = Callable[[], "AsyncEngine"]


class AgentEventListener:
    def __init__(self, engine_factory: EngineFactory, buffer: EventBuffer) -> None:
        self._engine_factory = engine_factory
        self._buffer = buffer
        self._task: asyncio.Task[None] | None = None
        self._running = False
        self.connected = asyncio.Event()

    async def start(self) -> None:
        if self._running:
            raise RuntimeError("AgentEventListener is already started")
        self._running = True
        self._task = asyncio.create_task(
            self._listen_forever(), name="agent-event-listener"
        )

    async def stop(self) -> None:
        self._running = False
        if self._task is not None:
            self._task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await self._task
            self._task = None
        self.connected.clear()

    async def _listen_forever(self) -> None:
        attempt = 0
        while self._running:
            try:
                await self._listen_once()
                attempt = 0
            except asyncio.CancelledError:
                raise
            except Exception:
                attempt += 1
                delay = min(
                    RECONNECT_BACKOFF_BASE * 2 ** (attempt - 1), RECONNECT_BACKOFF_CAP
                )
                logger.error(
                    "Agent event listener lost its connection; retrying in %.1fs",
                    delay,
                    exc_info=True,
                )
                self.connected.clear()
                await asyncio.sleep(delay)

    async def _listen_once(self) -> None:
        engine = self._engine_factory()
        try:
            async with engine.connect() as connection:
                raw = await connection.get_raw_connection()
                driver = raw.driver_connection
                if driver is None:
                    raise RuntimeError(
                        "No driver connection behind the agent event listener; "
                        "LISTEN needs asyncpg directly"
                    )
                await driver.add_listener(AGENT_EVENT_CHANNEL, self._on_notify)
                try:
                    self._buffer.ring_everyone()
                    self.connected.set()
                    while self._running:
                        await asyncio.sleep(HEARTBEAT_SECONDS)
                        await driver.execute(
                            "SELECT 1", timeout=HEARTBEAT_TIMEOUT_SECONDS
                        )
                finally:
                    self.connected.clear()
                    with contextlib.suppress(Exception):
                        await driver.remove_listener(
                            AGENT_EVENT_CHANNEL, self._on_notify
                        )
        finally:
            await engine.dispose()

    def _on_notify(
        self, _connection: Any, _pid: int, _channel: str, payload: str
    ) -> None:
        """asyncpg's callback, in the connection's read loop: ring and return."""
        try:
            agent_id = json.loads(payload)["agent_id"]
        except (ValueError, TypeError, KeyError):
            logger.warning(
                "Ignoring an unreadable agent event announcement: %r", payload[:200]
            )
            return
        self._buffer.ring(agent_id)
