"""Signals between switch-core processes, over Postgres `NOTIFY`.

A signal says that something changed and who should look: "controller C has a
new assignment", "controller C was revoked". It never carries the change
itself. Whoever holds the client the signal is about reads the database, the
same rule `messages/notify.py` follows for rooms, so a signal that is lost
costs a delay and never a wrong answer.

Every process listens on one channel. The process that makes a change acts on
it locally at once and publishes the signal for the others, which skip their
own: the holder of a controller's socket may be any process, and the database
is the one path that reaches it wherever it is.

Publishing is batched. A transaction that sends a `NOTIFY` takes a lock that
every other notifying transaction waits on as it commits, so signals raised
together go out in one statement rather than one transaction each. Payloads
are ids and small fields only: `NOTIFY` is not subject to row-level security,
and any session listening on the channel can read what is sent.

Reconnecting resyncs. Signals sent while the listening connection was down
were never queued, so every registered resync runs once the connection is back,
and each re-reads what its clients are owed.
"""

from __future__ import annotations

import asyncio
import contextlib
import json
import logging
from collections.abc import Awaitable, Callable
from typing import TYPE_CHECKING, Any

from sqlalchemy import text

if TYPE_CHECKING:
    from sqlalchemy.ext.asyncio import AsyncEngine, AsyncSession, async_sessionmaker

logger = logging.getLogger(__name__)

SIGNAL_CHANNEL = "switch_signal"

# How often the listening connection is proved alive, and how long the proof may
# take, as `MessageListener` does.
HEARTBEAT_SECONDS = 20.0
HEARTBEAT_TIMEOUT_SECONDS = 60.0
RECONNECT_BACKOFF_BASE = 1.0
RECONNECT_BACKOFF_CAP = 15.0

# Postgres refuses a payload of 8000 bytes or more. Ours are a few dozen.
MAX_PAYLOAD_BYTES = 7999

SignalHandler = Callable[[dict[str, Any]], None]
Resync = Callable[[], Awaitable[None]]
EngineFactory = Callable[[], "AsyncEngine"]

_NOTIFY_MANY = text(
    "SELECT pg_notify(:channel, payload) FROM unnest(CAST(:payloads AS text[])) AS payload"
)


class SignalBus:
    """Publishes signals to every process and hands each process its own."""

    def __init__(
        self,
        session_factory: async_sessionmaker[AsyncSession],
        engine_factory: EngineFactory,
        process_id: str,
    ) -> None:
        self._session_factory = session_factory
        # Signals carry the sender's process id, and a process skips its own:
        # whoever publishes has already acted on the change locally.
        self.process_id = process_id
        # A factory, as for `MessageListener`: a reconnect builds a fresh engine.
        self._engine_factory = engine_factory
        self._handlers: dict[str, SignalHandler] = {}
        self._resyncs: list[Resync] = []
        self._outbox: list[str] = []
        self._has_outbox = asyncio.Event()
        self._inbox: asyncio.Queue[dict[str, Any]] = asyncio.Queue()
        self._tasks: list[asyncio.Task[None]] = []
        self._running = False
        self.connected = asyncio.Event()

    # ── Registration ──────────────────────────────────────────────────────────

    def handle(self, kind: str, handler: SignalHandler) -> None:
        """Run `handler` for every signal of `kind` another process sends.

        Handlers run in the dispatch loop and must not block: they hand the
        signal to whatever holds the client, which does its own I/O."""
        if kind in self._handlers:
            raise ValueError(f"A handler for signal {kind!r} is already registered")
        self._handlers[kind] = handler

    def on_resync(self, resync: Resync) -> None:
        """Run `resync` each time the listening connection is (re)established."""
        self._resyncs.append(resync)

    # ── Publishing ────────────────────────────────────────────────────────────

    def publish(self, kind: str, **fields: Any) -> None:
        """Send a signal to every process, after the change it announces has
        committed. Never blocks the caller: the send is batched and retried by
        the bus, and a send that fails is logged rather than raised, since the
        change itself is already durable and resync covers the gap."""
        payload = json.dumps(
            {"kind": kind, "from": self.process_id, **fields}, separators=(",", ":")
        )
        if len(payload.encode()) > MAX_PAYLOAD_BYTES:
            raise ValueError(
                f"Signal {kind!r} is too large to send ({len(payload)} bytes)"
            )
        self._outbox.append(payload)
        self._has_outbox.set()

    async def _send_forever(self) -> None:
        while self._running:
            await self._has_outbox.wait()
            self._has_outbox.clear()
            batch, self._outbox = self._outbox, []
            if not batch:
                continue
            try:
                async with self._session_factory() as session:
                    await session.execute(
                        _NOTIFY_MANY, {"channel": SIGNAL_CHANNEL, "payloads": batch}
                    )
                    await session.commit()
            except asyncio.CancelledError:
                raise
            except Exception:
                logger.error(
                    "Could not send %d signal(s); listeners resync on reconnect",
                    len(batch),
                    exc_info=True,
                )

    # ── Lifecycle ─────────────────────────────────────────────────────────────

    async def start(self) -> None:
        if self._running:
            raise RuntimeError("SignalBus is already started")
        self._running = True
        self._tasks = [
            asyncio.create_task(self._listen_forever(), name="signal-listener"),
            asyncio.create_task(self._dispatch_forever(), name="signal-dispatch"),
            asyncio.create_task(self._send_forever(), name="signal-sender"),
        ]

    async def stop(self) -> None:
        self._running = False
        for task in self._tasks:
            task.cancel()
        for task in self._tasks:
            with contextlib.suppress(asyncio.CancelledError):
                await task
        self._tasks = []
        self.connected.clear()

    # ── The listening connection ──────────────────────────────────────────────

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
                    "Signal listener lost its connection; retrying in %.1fs",
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
                        "No driver connection behind the signal listener; "
                        "LISTEN needs asyncpg directly"
                    )
                await driver.add_listener(SIGNAL_CHANNEL, self._on_notify)
                try:
                    self.connected.set()
                    await self._resync_all()
                    await self._hold_open(driver)
                finally:
                    self.connected.clear()
                    with contextlib.suppress(Exception):
                        await driver.remove_listener(SIGNAL_CHANNEL, self._on_notify)
        finally:
            await engine.dispose()

    async def _hold_open(self, driver: Any) -> None:
        while self._running:
            await asyncio.sleep(HEARTBEAT_SECONDS)
            await driver.execute("SELECT 1", timeout=HEARTBEAT_TIMEOUT_SECONDS)

    def _on_notify(
        self, _connection: Any, _pid: int, _channel: str, payload: str
    ) -> None:
        """asyncpg's callback, in the connection's read loop: queue and return."""
        try:
            signal = json.loads(payload)
            if not isinstance(signal, dict) or not isinstance(signal.get("kind"), str):
                raise ValueError("no kind")
        except ValueError:
            logger.warning("Ignoring an unreadable signal: %r", payload[:200])
            return
        self._inbox.put_nowait(signal)

    async def _resync_all(self) -> None:
        for resync in self._resyncs:
            try:
                await resync()
            except asyncio.CancelledError:
                raise
            except Exception:
                logger.error("A signal resync failed", exc_info=True)

    # ── Dispatch ──────────────────────────────────────────────────────────────

    async def _dispatch_forever(self) -> None:
        while self._running:
            signal = await self._inbox.get()
            if signal.get("from") == self.process_id:
                continue
            handler = self._handlers.get(signal["kind"])
            if handler is None:
                # A newer process may send kinds an older one does not know,
                # during a rolling deploy.
                logger.debug("No handler for signal %r", signal["kind"])
                continue
            try:
                handler(signal)
            except Exception:
                logger.error("Handling signal %r failed", signal["kind"], exc_info=True)
