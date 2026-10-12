"""Per-agent sequenced events (CHOO-1857), kept in Postgres.

Every event an agent should see is a row in `agent_events`, numbered in that
agent's own sequence. Reading never removes, so several readers consume the
same events independently and a reader that drops off resumes from its cursor,
on any process and across restarts. Rows are deleted only when they age out of
the retention window (`expire`), and never because a reader has confirmed
them: cursors record progress, they do not decide what is kept.

Deletion is never silent. Each room's newest deleted event is recorded in
`agent_event_drops`, and the next reader resuming from before it is told it
missed events there, by name.

A new row announces itself (`db/agent_event_notify_ddl.py`), and the listener
in every process rings that agent's doorbell, so the process holding the
agent's connection wakes and reads. The doorbell is a wake-up and never the
record: a missed one costs latency, not an event.

How far behind a reader is in a room is derived rather than tallied: rows keep
their room and whether they were addressed, so "unaddressed traffic in this
room since you last caught up" is a count between two sequence numbers at the
moment somebody asks. Where each room was last caught up is still held in this
process, and is lost with it (see `mark_restarted`).
"""

from __future__ import annotations

import asyncio
import logging
import time
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from typing import TYPE_CHECKING

from sqlalchemy import delete, func, select
from sqlalchemy.dialects.postgresql import insert

from switch_core.bridges.agent.protocol.types import AgentEvent
from switch_core.db.models import AgentEventDrop, AgentEventHead, AgentEventRow
from switch_core.db.session_scope import tenant_session
from switch_core.observability.catalogue import (
    AGENT_BUFFER_SCAN_DURATION,
    AGENT_BUFFER_SCANNED,
    AGENT_EVENTS_DROPPED,
)
from switch_core.observability.metrics import metrics

if TYPE_CHECKING:
    from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

logger = logging.getLogger(__name__)

# How long an event stays readable. This is the resume window: a client that
# reconnects within it recovers every event it missed, and one that reconnects
# later is told it has a gap rather than handed a partial stream.
DEFAULT_RETENTION_SECONDS = 24 * 60 * 60

_READ = {"operation": "read"}
_UNREAD = {"operation": "unread"}

# Why an unread count is absent or incomplete. Never a bare zero: a reader that
# is told nothing went by must be able to trust it.
NO_BASELINE = "nothing recorded what you had already seen in this room"
RESTARTED = (
    "the server restarted, so what you had already seen in this room is no longer known"
)
COUNTED_FROM_A_HOLE = (
    "older events in this room were dropped before anything counted them, so "
    "this is a floor rather than a total"
)


class CursorExpiredError(Exception):
    """A reader asked to resume from a point the buffer no longer retains.

    Raised rather than fast-forwarding to head: a client that has missed events
    must be told, never handed a stream that looks complete.
    """

    def __init__(
        self, agent_id: str, requested: int, oldest: int, rooms: tuple[str, ...]
    ) -> None:
        super().__init__(
            f"cursor {requested} for agent {agent_id} is older than the retained "
            f"buffer (oldest retained: {oldest}); missed events in "
            f"{', '.join(rooms)}, re-read context"
        )
        self.agent_id = agent_id
        self.requested = requested
        self.oldest = oldest
        self.rooms = rooms


def is_notifiable(event: AgentEvent) -> bool:
    """Whether an event is addressed at the agent rather than ambient context.

    Addressed messages, task events, and room_join events the agent is
    configured to listen for. Excludes unaddressed chatter and admin command
    events. This is the `addressed` delivery filter: a supervising connection
    watching every room wants only these, while a session in a single room
    wants everything.
    """
    if event.type == "message":
        return getattr(event.payload, "addressed", False)
    if event.type == "room_join":
        return getattr(event.payload, "listening", False)
    if event.type == "command":
        return False
    # All task_* events are enqueued only for the directly-involved agent.
    return event.type.startswith("task_")


@dataclass(frozen=True)
class BufferedEvent:
    """An event with its position in the agent's stream."""

    seq: int
    room_id: str
    event: AgentEvent
    notifiable: bool


@dataclass(frozen=True)
class Reader:
    """Who is in a room, for the purpose of counting what went past it.

    A session when the caller named one, otherwise the connection or transport
    session it arrived on. Which of the two it is decides how a room changes
    hands: a connection may carry sessions working in several rooms, so
    covering a room is not being in it, while a session speaks for the one room
    it is in.
    """

    id: str
    is_session: bool


@dataclass
class _Counting:
    """What one room is behind by for one agent, and who is entitled to clear it.

    `baseline` is the sequence number the room was last caught up through, or
    None for "cannot be said". `occupant` is the session or connection in the
    room now: it decides whose `caught_up` counts, and nothing else.
    """

    occupant: Reader
    baseline: int | None


@dataclass(frozen=True)
class Unread:
    """Unaddressed messages a reader has yet to catch up on, in one room.

    `count` is None when nothing about it can be stated — better than a zero
    the reader would believe. `reason` says why a count is absent, or why one
    that is present is only a floor; it is None exactly when the count is
    complete.
    """

    count: int | None
    reason: str | None


class EventBuffer:
    def __init__(
        self,
        session_factory: async_sessionmaker[AsyncSession],
        *,
        sequence_base: int,
        retention_seconds: float = DEFAULT_RETENTION_SECONDS,
    ) -> None:
        self._session_factory = session_factory
        # An agent's first event is numbered from this boot's base, above every
        # earlier boot's, so a cursor from before the agent had any rows here
        # is recognisably older than all of them. After that its numbers come
        # from its head row and survive restarts.
        self.sequence_floor = sequence_base + 1
        self._retention_seconds = retention_seconds
        # Per process, and only the wake-up: which of this process's readers
        # to ring when a row lands. Rung by `enqueue` here and by the listener
        # for rows other processes write.
        self._notify: dict[str, asyncio.Event] = {}
        # reader id -> last sequence number that reader has confirmed. Used to
        # resume a reader and to report progress; deliberately NOT used to
        # decide what to delete.
        self._cursors: dict[str, dict[str, int]] = {}
        # agent -> room -> how far behind that room is, and who is in it.
        # Distinct from the delivery cursor, which records what the server has
        # written out: the two are allowed to diverge, and that divergence is
        # what makes a count per-room rather than per-connection.
        #
        # Keyed by room rather than by reader because at most one session of an
        # agent may be in a room, so the room names the count on its own — and
        # the reader cannot name it once an agent has a single inbound
        # connection, which every one of its sessions arrives on. What went
        # past unread in a room belongs to the room: a session taking it over
        # inherits what the agent has yet to catch up on there rather than
        # starting at a zero nothing justifies.
        self._counting: dict[str, dict[str, _Counting]] = {}
        # Agents whose baselines were lost with a previous life of this
        # process. A room counted for the first time after that starts unknown
        # rather than at a number: where it was last caught up is gone, so a
        # count from anywhere would be a guess presented as a total.
        self._restarted: set[str] = set()

    # ------------------------------------------------------------------
    # Producing
    # ------------------------------------------------------------------

    async def enqueue(
        self, tenant_id: str, agent_id: str, room_id: str, event: AgentEvent
    ) -> int:
        """Append an event for an agent and return its sequence number.

        The number comes from the agent's head row, advanced in the same
        transaction as the insert, so numbers are contiguous and never handed
        out twice, even after the rows before them have been deleted.
        """
        async with tenant_session(self._session_factory, tenant_id) as session:
            claim = (
                insert(AgentEventHead)
                .values(
                    tenant_id=tenant_id,
                    agent_id=agent_id,
                    first_seq=self.sequence_floor,
                    last_seq=self.sequence_floor,
                )
                .on_conflict_do_update(
                    index_elements=[AgentEventHead.agent_id],
                    set_={"last_seq": AgentEventHead.last_seq + 1},
                )
                .returning(AgentEventHead.last_seq)
            )
            seq = (await session.execute(claim)).scalar_one()
            session.add(
                AgentEventRow(
                    tenant_id=tenant_id,
                    agent_id=agent_id,
                    seq=seq,
                    room_id=room_id,
                    type=event.type,
                    payload=event.model_dump(mode="json"),
                    notifiable=is_notifiable(event),
                )
            )
            await session.commit()
        logger.debug(
            "[EVENT-BUF] append agent=%s room=%s type=%s seq=%s",
            agent_id,
            room_id,
            event.type,
            seq,
        )
        self.ring(agent_id)
        return seq

    # ------------------------------------------------------------------
    # Consuming
    # ------------------------------------------------------------------

    async def read_from(
        self,
        tenant_id: str,
        agent_id: str,
        after_seq: int,
        *,
        rooms: set[str] | None = None,
        notifiable_only: bool = False,
        limit: int | None = None,
    ) -> list[BufferedEvent]:
        """Return retained events after `after_seq`, oldest first.

        `rooms=None` means every room the agent has events for; otherwise only
        the given rooms. Raises `CursorExpiredError` if `after_seq` predates
        what is still retained.
        """
        started = time.perf_counter()
        await self._check_cursor(tenant_id, agent_id, after_seq)
        query = (
            select(AgentEventRow)
            .where(AgentEventRow.agent_id == agent_id, AgentEventRow.seq > after_seq)
            .order_by(AgentEventRow.seq)
        )
        if rooms is not None:
            query = query.where(AgentEventRow.room_id.in_(rooms))
        if notifiable_only:
            query = query.where(AgentEventRow.notifiable.is_(True))
        if limit is not None:
            query = query.limit(limit)
        async with tenant_session(self._session_factory, tenant_id) as session:
            rows = (await session.scalars(query)).all()
        out = [
            BufferedEvent(
                seq=row.seq,
                room_id=row.room_id,
                event=AgentEvent.model_validate(row.payload),
                notifiable=row.notifiable,
            )
            for row in rows
        ]
        self._record_scan(_READ, len(out), started)
        return out

    async def wait(self, agent_id: str, timeout: float) -> None:
        """Block until an event is appended for the agent, or the timeout passes.

        A wake-up is advisory: callers re-read from their cursor rather than
        trusting this to deliver anything. The rows are the record; this is
        only the doorbell.
        """
        notify = self._notify.setdefault(agent_id, asyncio.Event())
        notify.clear()
        try:
            await asyncio.wait_for(notify.wait(), timeout=timeout)
        except TimeoutError:
            return

    def doorbell(self, agent_id: str) -> asyncio.Event:
        """The wake-up signal for an agent, shared by every reader here.

        Set whenever an event is appended, by this process or another.
        Readers re-read from their own cursor when woken; the signal carries
        no payload, so a spurious or missed wake costs latency, never
        correctness.
        """
        return self._notify.setdefault(agent_id, asyncio.Event())

    def ring(self, agent_id: str) -> None:
        """Wake this process's readers of an agent. Called by `enqueue` and by
        the listener when another process appends."""
        notify = self._notify.get(agent_id)
        if notify is not None:
            notify.set()

    def ring_everyone(self) -> None:
        """Wake every reader here, after the listener was disconnected and may
        have missed announcements."""
        for notify in self._notify.values():
            notify.set()

    async def head(self, tenant_id: str, agent_id: str) -> int:
        """The sequence number of the most recent event (the floor less one if none)."""
        async with tenant_session(self._session_factory, tenant_id) as session:
            last = await session.scalar(
                select(AgentEventHead.last_seq).where(
                    AgentEventHead.agent_id == agent_id
                )
            )
        return self.sequence_floor - 1 if last is None else last

    async def heads(self, tenant_id: str, agent_ids: set[str]) -> dict[str, int]:
        """`head` for several agents in one read, for a reader serving many."""
        async with tenant_session(self._session_factory, tenant_id) as session:
            rows = (
                await session.execute(
                    select(AgentEventHead.agent_id, AgentEventHead.last_seq).where(
                        AgentEventHead.agent_id.in_(agent_ids)
                    )
                )
            ).all()
        found = {agent_id: last for agent_id, last in rows}
        return {
            agent_id: found.get(agent_id, self.sequence_floor - 1)
            for agent_id in agent_ids
        }

    async def first_seq(self, tenant_id: str, agent_id: str) -> int:
        """Where the agent's numbering starts: anything below it was issued
        before the agent had events here, by a server that no longer holds them."""
        async with tenant_session(self._session_factory, tenant_id) as session:
            first = await session.scalar(
                select(AgentEventHead.first_seq).where(
                    AgentEventHead.agent_id == agent_id
                )
            )
        return self.sequence_floor if first is None else first

    async def oldest_retained(self, tenant_id: str, agent_id: str) -> int:
        """Sequence number of the oldest retained event (0 if there is none)."""
        async with tenant_session(self._session_factory, tenant_id) as session:
            oldest = await session.scalar(
                select(func.min(AgentEventRow.seq)).where(
                    AgentEventRow.agent_id == agent_id
                )
            )
        return oldest or 0

    async def rooms_dropped_after(
        self, tenant_id: str, agent_id: str, after_seq: int
    ) -> tuple[str, ...]:
        """The rooms that lost events a reader at `after_seq` would have seen."""
        async with tenant_session(self._session_factory, tenant_id) as session:
            rooms = (
                await session.scalars(
                    select(AgentEventDrop.room_id).where(
                        AgentEventDrop.agent_id == agent_id,
                        AgentEventDrop.dropped_through > after_seq,
                    )
                )
            ).all()
        return tuple(sorted(rooms))

    # ------------------------------------------------------------------
    # Reader bookkeeping
    # ------------------------------------------------------------------

    def ensure_counting(
        self, agent_id: str, connection_id: str, room_id: str, from_seq: int
    ) -> None:
        """A connection is delivering this room: count it from `from_seq` if
        nothing is counting it yet.

        Covering a room is not being in it. A connection carries every session
        of an agent and delivers the union of their rooms, so a connection
        saying what it covers must not take a room from whoever is in it — and
        a delivery loop says it on every pass.

        Nothing already recorded is touched: what is there is either progress
        or a deliberate unknown, and replacing either would invent a zero.
        """
        if room_id in self._counting.setdefault(agent_id, {}):
            return
        self._begin(
            agent_id, room_id, Reader(id=connection_id, is_session=False), from_seq
        )

    def take_counting(
        self, agent_id: str, connection_id: str, room_id: str, from_seq: int
    ) -> None:
        """A connection has taken this room from whoever held it.

        For the doors where the room slot itself changes hands and the registry
        has granted the takeover — not for a connection re-stating what it
        delivers. Whoever is being told how far behind the room is has to be
        the one whose reading clears it, so the taker becomes the occupant
        whether it took the room from another connection or from a session that
        has now been displaced from it.

        What the room is behind by survives the change of hands: the messages
        went past unread whoever was there, and a successor told zero would be
        told something nobody has established.
        """
        rooms = self._counting.setdefault(agent_id, {})
        taker = Reader(id=connection_id, is_session=False)
        held = rooms.get(room_id)
        if held is None:
            self._begin(agent_id, room_id, taker, from_seq)
            return
        held.occupant = taker

    def hand_counting_to(self, agent_id: str, reader: Reader, room_id: str) -> None:
        """Record that `reader` is the one in the room now.

        Connecting to a room is taking it, so the newcomer becomes the only
        caller whose reading clears the count there — which is what stops a
        read begun by the session it displaced from clearing a count that is
        no longer that session's to clear.

        What the room is behind by survives the change of hands: the messages
        went past unread whoever was there, and a successor told zero would be
        told something nobody has established. A room nothing has counted yet
        starts from the oldest event still retained, the most that can be said
        about how far behind it is.
        """
        rooms = self._counting.setdefault(agent_id, {})
        held = rooms.get(room_id)
        if held is None:
            self._begin(agent_id, room_id, reader, 0)
            return
        held.occupant = reader

    def mark_restarted(self, agent_id: str) -> None:
        """Record that how far behind any of this agent's rooms are cannot be said.

        The buffer is in memory, so a restart takes every room's baseline with
        it — not only the rooms of whichever connection noticed. An `all`-scope
        connection names no rooms at all and the rooms its sessions work in
        arrive afterwards, so the rule has to outlive the reconnection that
        reports it: a room first counted after a restart starts unknown too.

        Sticky either way, so a room is not quietly given a fresh baseline and
        its reader told nothing went by. The next time one catches up it gets a
        real baseline again. Whoever is in a room stays in it: losing the
        buffer says nothing about who is where.
        """
        self._restarted.add(agent_id)
        for counting in self._counting.get(agent_id, {}).values():
            counting.baseline = None

    def caught_up(
        self,
        agent_id: str,
        reader: Reader,
        room_id: str,
        through_seq: int,
        arrived_on: str | None,
    ) -> None:
        """Record that the room's occupant has caught up through `through_seq`.

        Forward only, and only for the room named: catching up on one room
        says nothing about any other, which is the whole point of counting
        per room.

        Ignored from anyone but the occupant. A read is begun before its
        history arrives, so a session displaced from the room while its read
        was in flight comes back holding an answer for a room it has left; the
        session that took the room has not read a word of it, and must not be
        told otherwise.

        A session may take the count over from the connection it is speaking
        over — `arrived_on` — and from nothing else. That connection carried it
        into the room, so a count opened in the connection's name is the
        session's own to clear, which is how a session recovers one rather than
        reading forever against a baseline nothing it can say will clear. A
        count any other connection holds belongs to whoever took the room, and
        a session outranking it would put the displaced back in charge of it.
        """
        rooms = self._counting.setdefault(agent_id, {})
        held = rooms.get(room_id)
        if held is None:
            rooms[room_id] = _Counting(occupant=reader, baseline=through_seq)
            return
        if held.occupant != reader:
            if not reader.is_session:
                return
            if held.occupant.is_session or held.occupant.id != arrived_on:
                return
            held.occupant = reader
        if held.baseline is None or through_seq > held.baseline:
            held.baseline = through_seq

    async def unread(
        self, tenant_id: str, agent_id: str, room_id: str, through_seq: int
    ) -> Unread:
        """Unaddressed messages in one room the agent has not caught up on.

        Counted on demand from the retained events rather than tallied as they
        arrive, so it cannot disagree with them. Only messages: an agent is
        told how much conversation went past it, not how many admin events
        did.

        Asked by room alone, with no reader: a connection carrying every
        session of an agent could not say which of them a room's count belongs
        to, and only one of them can be in the room to be told.
        """
        held = self._counting.get(agent_id, {}).get(room_id)
        if held is None:
            return Unread(count=None, reason=NO_BASELINE)
        baseline = held.baseline
        if baseline is None:
            return Unread(count=None, reason=RESTARTED)

        started = time.perf_counter()
        async with tenant_session(self._session_factory, tenant_id) as session:
            count = await session.scalar(
                select(func.count()).where(
                    AgentEventRow.agent_id == agent_id,
                    AgentEventRow.room_id == room_id,
                    AgentEventRow.seq > baseline,
                    AgentEventRow.seq <= through_seq,
                    AgentEventRow.type == "message",
                    AgentEventRow.notifiable.is_(False),
                )
            )
            dropped = await session.scalar(
                select(AgentEventDrop.dropped_through).where(
                    AgentEventDrop.agent_id == agent_id,
                    AgentEventDrop.room_id == room_id,
                )
            )
        self._record_scan(_UNREAD, count or 0, started)
        if dropped is not None and dropped > baseline:
            return Unread(count=count or 0, reason=COUNTED_FROM_A_HOLE)
        return Unread(count=count or 0, reason=None)

    def register_reader(self, agent_id: str, reader_id: str, cursor: int) -> None:
        self._cursors.setdefault(agent_id, {})[reader_id] = cursor

    def confirm(self, agent_id: str, reader_id: str, cursor: int) -> None:
        """Record how far a reader has consumed, so its events can be trimmed.

        Cursors only move forward. A reader reporting a lower value than it has
        already confirmed is ignored rather than allowed to rewind the buffer.
        """
        readers = self._cursors.setdefault(agent_id, {})
        if cursor > readers.get(reader_id, 0):
            readers[reader_id] = cursor

    def drop_reader(self, agent_id: str, reader_id: str) -> None:
        """Forget a reader's delivery cursor. What its rooms are behind by stays.

        A reader going away does not mean the conversation it was not reading
        was read. The next session in the room is told what went past.
        """
        readers = self._cursors.get(agent_id)
        if readers:
            readers.pop(reader_id, None)

    def remove(self, agent_id: str) -> None:
        """Forget what this process holds about an agent. Its rows go with the
        agent's own row (`ON DELETE CASCADE`)."""
        self._notify.pop(agent_id, None)
        self._cursors.pop(agent_id, None)
        self._counting.pop(agent_id, None)
        self._restarted.discard(agent_id)

    def _begin(
        self, agent_id: str, room_id: str, occupant: Reader, baseline: int
    ) -> None:
        """Start counting a room, unknown when the buffer restarted under it."""
        self._counting.setdefault(agent_id, {})[room_id] = _Counting(
            occupant=occupant,
            baseline=None if agent_id in self._restarted else baseline,
        )

    async def drop_room(self, tenant_id: str, agent_id: str, room_id: str) -> None:
        """Delete everything retained for this agent in one room.

        Called when the agent is removed from it. The rows are keyed by agent
        and know nothing about who is in what, so an event queued while it was
        a member stays readable after it is not.

        Sequence numbers are untouched and no gap is recorded: a reader that
        skips these has missed nothing it was entitled to, and saying otherwise
        would send it to re-read the context of a room it is not in.
        """
        async with tenant_session(self._session_factory, tenant_id) as session:
            result = await session.execute(
                delete(AgentEventRow).where(
                    AgentEventRow.agent_id == agent_id,
                    AgentEventRow.room_id == room_id,
                )
            )
            await session.commit()
        dropped = result.rowcount or 0  # type: ignore[attr-defined]
        if dropped:
            logger.info(
                "[EVENT-BUF] dropped %s retained event(s) for agent=%s room=%s: "
                "no longer a member",
                dropped,
                agent_id,
                room_id,
            )

    # ------------------------------------------------------------------
    # Retention
    # ------------------------------------------------------------------

    async def expire(self, tenant_id: str) -> int:
        """Delete one tenant's events older than the retention window.

        Lossy, so it records, per agent and room, the newest event it deleted:
        the next reader resuming from before that is told it missed events
        there. Retention is deliberately independent of what readers have
        confirmed: an event stays readable for its window whether or not
        somebody has already consumed it, so a reader that arrives late still
        sees recent history.
        """
        cutoff = datetime.now(UTC) - timedelta(seconds=self._retention_seconds)
        async with tenant_session(self._session_factory, tenant_id) as session:
            deleted = (
                await session.execute(
                    delete(AgentEventRow)
                    .where(AgentEventRow.created_at < cutoff)
                    .returning(
                        AgentEventRow.agent_id, AgentEventRow.room_id, AgentEventRow.seq
                    )
                )
            ).all()
            through: dict[tuple[str, str], int] = {}
            for agent_id, room_id, seq in deleted:
                key = (agent_id, room_id)
                through[key] = max(seq, through.get(key, 0))
            for (agent_id, room_id), seq in through.items():
                await session.execute(
                    insert(AgentEventDrop)
                    .values(
                        tenant_id=tenant_id,
                        agent_id=agent_id,
                        room_id=room_id,
                        dropped_through=seq,
                    )
                    .on_conflict_do_update(
                        index_elements=[
                            AgentEventDrop.agent_id,
                            AgentEventDrop.room_id,
                        ],
                        set_={
                            "dropped_through": func.greatest(
                                AgentEventDrop.dropped_through, seq
                            )
                        },
                    )
                )
            await session.commit()
        if deleted:
            metrics().increment(
                AGENT_EVENTS_DROPPED, {"reason": "retention"}, len(deleted)
            )
        return len(deleted)

    # ------------------------------------------------------------------
    # Legacy long-poll compatibility
    #
    # Polling clients send no cursor and have nowhere to keep one, so the
    # server holds it for them: "everything after the last thing I gave you,
    # and record that I gave it". Behaviour is unchanged from their point of
    # view — they never see a duplicate — but reads are not destructive, so a
    # streaming reader on the same agent is unaffected.
    #
    # Delivery stays at-most-once for these callers, exactly as before: the
    # cursor advances on send, so a response lost in flight loses its events.
    # Confirming clients get at-least-once instead.
    # ------------------------------------------------------------------

    async def poll(
        self, tenant_id: str, agent_id: str, *, rooms: set[str], timeout: float = 30
    ) -> list[AgentEvent]:
        """Everything queued for this agent in the rooms it is in.

        `rooms` is how the caller applies membership, and it is required: the
        rows are keyed by agent and know nothing about who is in what, so an
        event queued while the agent was a member stays queued after it is
        removed. A default would make the leak the thing a new caller gets for
        free.
        """
        return await self._legacy_poll(
            tenant_id, agent_id, "legacy:all", timeout=timeout, rooms=rooms
        )

    async def poll_room(
        self, tenant_id: str, agent_id: str, room_id: str, timeout: float = 30
    ) -> list[AgentEvent]:
        return await self._legacy_poll(
            tenant_id,
            agent_id,
            f"legacy:room:{room_id}",
            timeout=timeout,
            rooms={room_id},
            rooms_are_membership=False,
        )

    async def poll_notifications(
        self, tenant_id: str, agent_id: str, *, rooms: set[str], timeout: float = 30
    ) -> list[AgentEvent]:
        """The notifiable half of `poll`, under the same membership rule.

        This is the stream carrying messages addressed at the agent, so it is
        the one a removal matters most on.
        """
        return await self._legacy_poll(
            tenant_id,
            agent_id,
            "legacy:notifications",
            timeout=timeout,
            rooms=rooms,
            notifiable_only=True,
        )

    async def _legacy_poll(
        self,
        tenant_id: str,
        agent_id: str,
        reader_id: str,
        *,
        timeout: float,
        rooms: set[str],
        notifiable_only: bool = False,
        rooms_are_membership: bool = True,
    ) -> list[AgentEvent]:
        args = (
            tenant_id,
            agent_id,
            reader_id,
            rooms,
            notifiable_only,
            rooms_are_membership,
        )
        events = await self._legacy_take(*args)
        if events:
            return events

        await self.wait(agent_id, timeout)

        return await self._legacy_take(*args)

    async def _legacy_take(
        self,
        tenant_id: str,
        agent_id: str,
        reader_id: str,
        rooms: set[str],
        notifiable_only: bool,
        rooms_are_membership: bool,
    ) -> list[AgentEvent]:
        """One read, moving the cursor past what this reader can never want.

        Past what it can never want, and no further. A legacy read has no
        limit, so it always reaches the end, and leaving the cursor behind an
        event the filter excluded parks it below the head indefinitely — until
        retention deletes it and the next read reports a gap that never
        happened.

        Which exclusions are permanent depends on the filter.
        `notifiable_only` tests a property of the event, which is fixed, so
        those can be skipped for good. A room set taken from membership is not
        fixed: an agent added to a room that already has events for it would
        find the cursor already past them, and they would never be delivered.
        `poll_room`'s filter is the reader's own scope rather than a
        membership snapshot, so there the exclusions are permanent too — hence
        `rooms_are_membership`.
        """
        cursor = await self._legacy_cursor(tenant_id, agent_id, reader_id)
        events = await self._legacy_read(
            tenant_id, agent_id, reader_id, cursor, rooms, notifiable_only
        )
        if rooms_are_membership:
            through = await self._last_seq_in_rooms(tenant_id, agent_id, cursor, rooms)
        else:
            through = await self.head(tenant_id, agent_id)
        self.confirm(agent_id, reader_id, through)
        return [item.event for item in events]

    async def _last_seq_in_rooms(
        self, tenant_id: str, agent_id: str, after_seq: int, rooms: set[str]
    ) -> int:
        """The newest retained event after `after_seq` in one of `rooms`.

        `after_seq` itself when there is none, so a caller confirming this
        never moves a cursor over an event held for a room the agent is not in
        yet.
        """
        async with tenant_session(self._session_factory, tenant_id) as session:
            last = await session.scalar(
                select(func.max(AgentEventRow.seq)).where(
                    AgentEventRow.agent_id == agent_id,
                    AgentEventRow.seq > after_seq,
                    AgentEventRow.room_id.in_(rooms),
                )
            )
        return after_seq if last is None else last

    async def _legacy_cursor(
        self, tenant_id: str, agent_id: str, reader_id: str
    ) -> int:
        readers = self._cursors.setdefault(agent_id, {})
        if reader_id not in readers:
            # A poller seen for the first time starts before the oldest
            # retained event, mirroring the queue it replaces: events
            # accumulated while nobody was polling and the first poll drained
            # them. Starting at head would silently swallow anything that
            # arrived before the client got around to asking.
            oldest = await self.oldest_retained(tenant_id, agent_id)
            readers[reader_id] = max(oldest - 1, 0)
        return readers[reader_id]

    async def _legacy_read(
        self,
        tenant_id: str,
        agent_id: str,
        reader_id: str,
        cursor: int,
        rooms: set[str],
        notifiable_only: bool,
    ) -> list[BufferedEvent]:
        try:
            return await self.read_from(
                tenant_id,
                agent_id,
                cursor,
                rooms=rooms,
                notifiable_only=notifiable_only,
            )
        except CursorExpiredError as exc:
            # A polling client cannot be told about a gap — it has no protocol
            # for it. Log loudly and resume from what is retained rather than
            # silently returning nothing. Migrating the client is the real fix.
            logger.error(
                "[EVENT-BUF] legacy poller %s for agent %s missed events "
                "(cursor %s, oldest retained %s); resuming from oldest retained",
                reader_id,
                agent_id,
                exc.requested,
                exc.oldest,
            )
            resumed = max(exc.oldest - 1, 0)
            self._cursors.setdefault(agent_id, {})[reader_id] = resumed
            return await self.read_from(
                tenant_id,
                agent_id,
                resumed,
                rooms=rooms,
                notifiable_only=notifiable_only,
            )

    # ------------------------------------------------------------------
    # Internals
    # ------------------------------------------------------------------

    @staticmethod
    def _record_scan(operation: dict[str, str], scanned: int, started: float) -> None:
        registry = metrics()
        registry.observe(
            AGENT_BUFFER_SCAN_DURATION,
            operation,
            (time.perf_counter() - started) * 1000.0,
        )
        registry.observe(AGENT_BUFFER_SCANNED, operation, scanned)

    async def _check_cursor(
        self, tenant_id: str, agent_id: str, after_seq: int
    ) -> None:
        rooms = await self.rooms_dropped_after(tenant_id, agent_id, after_seq)
        if not rooms:
            return
        oldest = await self.oldest_retained(tenant_id, agent_id)
        raise CursorExpiredError(agent_id, after_seq, oldest, rooms)
