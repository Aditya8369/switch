"""An agent's events (CHOO-1857), kept in Postgres and read by position.

What an agent is sent comes from two places.

**Its own events.** A message addressed to it, an arrival it listens for, a task
it is part of, a command sent to it. Whether a room row is one of those is
decided once, by the agent's consumer, when the row is delivered to it live, and
cannot be decided again later (policies, budgets and role leases move on), so
the decision is kept: a row in `agent_events`, numbered in the agent's own
sequence. These are the db-buffer's slips.

**The rest of the conversation.** Everything else said in the agent's rooms is
already in `messages`, numbered per room, and is read from there when a reader
wants it. Nothing is copied for it, so a busy room costs one write per message,
not one per agent in it.

A reader's place is a position (`positions.py`): one number for the agent's own
events, one per room for the conversation. Reading never removes, so several
readers consume the same events independently, and a reader that drops off
resumes from its position, on any process and across restarts.

Slips are deleted when they age out of the retention window (`expire`), never
because a reader has confirmed them. Deletion is never silent: each room's
newest deleted slip is recorded in `agent_event_drops`, and the next reader
resuming from before it is told it missed events there, by name.

A new slip announces itself (`db/agent_event_notify_ddl.py`) and the listener in
every process rings that agent's doorbell, so the process holding the agent's
connection wakes and reads. The doorbell is a wake-up, never the record.

How far behind a reader is in a room is counted from `messages`: unaddressed
conversation after the point the agent last caught up, minus its own slips.
Where it caught up, and who is reading the room, are kept in `agent_room_reads`.
"""

from __future__ import annotations

import asyncio
import logging
import time
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta
from typing import TYPE_CHECKING, Any, cast

from sqlalchemy import delete, func, literal, select, text
from sqlalchemy.dialects.postgresql import insert

from switch_core.attachments import parse_attachment_group
from switch_core.bridges.agent.protocol.message_events import (
    attachment_ref,
    message_event,
    room_join_event,
)
from switch_core.bridges.agent.protocol.positions import (
    SLIPS,
    Position,
    merged,
    room_of,
    room_source,
)
from switch_core.bridges.agent.protocol.types import AgentEvent
from switch_core.clients.admin_messages import platform_replies_in_channel
from switch_core.db.models import (
    Agent,
    AgentEventDrop,
    AgentEventHead,
    AgentEventRow,
    AgentPollPosition,
    AgentPositionTicket,
    AgentRoomRead,
    Client,
    ClientRoom,
    Message,
    MessageAttachment,
    Room,
)
from switch_core.db.session_scope import tenant_session
from switch_core.observability.catalogue import (
    AGENT_BUFFER_SCAN_DURATION,
    AGENT_BUFFER_SCANNED,
    AGENT_EVENTS_DROPPED,
)
from switch_core.observability.metrics import metrics
from switch_core.transport.stored import to_inbound
from switch_core.transport.types import InboundMedia, InboundMembership, InboundMessage

if TYPE_CHECKING:
    from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

logger = logging.getLogger(__name__)

# How long a slip stays readable. This is the resume window for the agent's
# own events: a client that reconnects within it recovers every one it missed,
# and one that reconnects later is told it has a gap rather than handed a
# partial stream. The conversation is never deleted, so it has no window.
DEFAULT_RETENTION_SECONDS = 24 * 60 * 60

# How old a room row has to be before it is read as conversation. The agent's
# consumer decides, as the row is delivered to it, whether the row is for the
# agent; reading it sooner could hand the row over as conversation a moment
# before the same row arrives as the agent's own event. Seconds, because the
# consumer takes milliseconds; what can still race it is a consumer stalled
# for longer, and the cost then is the message twice, never not at all.
CONVERSATION_SETTLE_SECONDS = 2.0

# How long several files posted as one message are waited for before the parts
# that did arrive are read as conversation, flagged as incomplete. The same
# deadline the agent's consumer gives a group it is assembling.
CONVERSATION_GROUP_GRACE_SECONDS = 5.0

# The first ticket a client holding one number can be handed (the
# `agent_position_ticket` sequence starts here). Above every number an agent
# stream issued before positions, so a number at or above it is a ticket.
TICKET_FLOOR = 2**48

_READ = {"operation": "read"}
_UNREAD = {"operation": "unread"}

# Why an unread count is absent. Never a bare zero: a reader that is told
# nothing went by must be able to trust it.
NO_BASELINE = "nothing recorded what you had already seen in this room"
# Why a count is a floor: past the retention window the agent's own events are
# gone, so what was addressed to it there can no longer be told from chatter.
COUNTED_FROM_WINDOW = (
    "counted over the retention window only; you have not caught up on this "
    "room for longer than that"
)


class CursorExpiredError(Exception):
    """A reader asked to resume from a point no longer retained.

    Raised rather than fast-forwarding to head: a client that has missed events
    must be told, never handed a stream that looks complete.
    """

    def __init__(
        self, agent_id: str, requested: int, oldest: int, rooms: tuple[str, ...]
    ) -> None:
        super().__init__(
            f"cursor {requested} for agent {agent_id} is older than what is "
            f"retained (oldest retained: {oldest}); missed events in "
            f"{', '.join(rooms)}, re-read context"
        )
        self.agent_id = agent_id
        self.requested = requested
        self.oldest = oldest
        self.rooms = rooms


def is_notifiable(event: AgentEvent) -> bool:
    """Whether an event is addressed at the agent rather than ambient context.

    Addressed messages, task events, and room_join events the agent is
    configured to listen for. Excludes conversation and admin command events.
    This is the `addressed` delivery filter: a supervising connection watching
    every room wants only these, while a session in a single room wants
    everything.
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
    """An event with its place in the source it was read from.

    `source` is the agent's own events (`positions.SLIPS`) or a room's
    conversation; `seq` is the event's number there, which is what a reader's
    position moves to once the event is delivered. `room_seq` is the room row
    the event came from, and `at` when it happened, which orders events read
    from different sources against each other.
    """

    seq: int
    room_id: str
    event: AgentEvent
    notifiable: bool
    source: str = SLIPS
    room_seq: int = 0
    at: float = 0.0


@dataclass(frozen=True)
class Conversation:
    """What reading the rooms' conversation found.

    `through` is, per room, how far the read looked, delivered or not: rows
    that are not conversation (the agent's own, other kinds of event, ones
    already among its own events) are looked past all the same, so a reader's
    position can move over them.
    """

    events: list[BufferedEvent] = field(default_factory=list)
    through: dict[str, int] = field(default_factory=dict)


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


@dataclass(frozen=True)
class Unread:
    """Unaddressed messages a reader has yet to catch up on, in one room.

    `count` is None when nothing about it can be stated — better than a zero
    the reader would believe. `reason` says why a count is absent; it is None
    exactly when the count is complete.
    """

    count: int | None
    reason: str | None


def _epoch(when: datetime | None) -> float:
    return when.timestamp() if when is not None else 0.0


def message_key(row: Message) -> str:
    """The id a row's message is known by: its attachment group, when it is one
    of several files posted as one message, otherwise its own event id."""
    group = parse_attachment_group(row.content or {})
    return group[0] if group is not None else row.transport_event_id


# The same, in SQL, for counting over `messages` without reading every row.
_MESSAGE_KEY_SQL = (
    "COALESCE(m.content->'com.switch.attachment_group'->>'id', m.transport_event_id)"
)

_UNREAD_SQL = text(
    f"""
    SELECT count(DISTINCT {_MESSAGE_KEY_SQL})
    FROM messages m
    WHERE m.room_id = :room_id
      AND m.seq > :baseline
      AND m.seq <= :through
      AND m.seq > 0
      AND m.event_type = 'm.room.message'
      AND m.sender_id <> :me
      AND NOT EXISTS (
        SELECT 1 FROM agent_events e
        WHERE e.agent_id = :agent_id
          AND e.room_id = :room_id
          AND e.type = 'message'
          AND e.message_key = {_MESSAGE_KEY_SQL}
          AND e.room_seq >= m.seq
      )
    """
)


class EventBuffer:
    def __init__(
        self,
        session_factory: async_sessionmaker[AsyncSession],
        *,
        sequence_base: int,
        retention_seconds: float = DEFAULT_RETENTION_SECONDS,
        settle_seconds: float = CONVERSATION_SETTLE_SECONDS,
    ) -> None:
        self._session_factory = session_factory
        # An agent's first event is numbered from this boot's base, above every
        # earlier boot's, so a cursor from before the agent had any rows here
        # is recognisably older than all of them. After that its numbers come
        # from its head row and survive restarts.
        self.sequence_floor = sequence_base + 1
        self._retention_seconds = retention_seconds
        self._settle_seconds = settle_seconds
        # Per process, and only the wake-up: which of this process's readers
        # to ring when a slip lands. Rung by `enqueue` here and by the listener
        # for slips other processes write.
        self._notify: dict[str, asyncio.Event] = {}

    @property
    def settle_seconds(self) -> float:
        return self._settle_seconds

    # ------------------------------------------------------------------
    # Producing
    # ------------------------------------------------------------------

    async def enqueue(
        self,
        tenant_id: str,
        agent_id: str,
        room_id: str,
        event: AgentEvent,
        *,
        room_seq: int,
        message_key: str | None,
    ) -> int:
        """Keep an event that is for the agent and return its sequence number.

        The number comes from the agent's head row, advanced in the same
        transaction as the insert, so numbers are contiguous and never handed
        out twice, even after the rows before them have been deleted.
        `room_seq` and `message_key` name the room row the event came from.
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
                    room_seq=room_seq,
                    message_key=message_key,
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
    # The agent's own events
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
        through_seq: int | None = None,
    ) -> list[BufferedEvent]:
        """The agent's own events after `after_seq`, oldest first.

        `rooms=None` means every room the agent has events in; otherwise only
        the given rooms. `through_seq` stops the read at a bound the caller
        took beforehand, so it can move a position to exactly what it was
        handed. Raises `CursorExpiredError` if `after_seq` predates what is
        still retained.
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
        if through_seq is not None:
            query = query.where(AgentEventRow.seq <= through_seq)
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
                source=SLIPS,
                room_seq=row.room_seq,
                at=_epoch(row.created_at),
            )
            for row in rows
        ]
        self._record_scan(_READ, len(out), started)
        return out

    async def wait(self, agent_id: str, timeout: float) -> None:
        """Block until an event is appended for the agent, or the timeout passes.

        A wake-up is advisory: callers re-read from their position rather than
        trusting this to deliver anything.
        """
        notify = self._notify.setdefault(agent_id, asyncio.Event())
        notify.clear()
        try:
            await asyncio.wait_for(notify.wait(), timeout=timeout)
        except TimeoutError:
            return

    def doorbell(self, agent_id: str) -> asyncio.Event:
        """The wake-up signal for an agent, shared by every reader here.

        Set whenever one of its events is appended, by this process or another.
        Readers re-read from their own position when woken; the signal carries
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
        """The number of the agent's newest event (the floor less one if none)."""
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
        """Number of the agent's oldest retained event (0 if there is none)."""
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
    # The rooms' conversation
    # ------------------------------------------------------------------

    async def member_rooms(self, tenant_id: str, agent_id: str) -> set[str]:
        """The rooms the agent is in now."""
        async with tenant_session(self._session_factory, tenant_id) as session:
            rooms = (
                await session.scalars(
                    select(ClientRoom.room_id)
                    .join(Agent, Agent.client_id == ClientRoom.client_id)
                    .where(Agent.id == agent_id)
                )
            ).all()
        return set(rooms)

    async def room_heads(self, tenant_id: str, room_ids: set[str]) -> dict[str, int]:
        """Each room's newest position (0 for a room with nothing in it yet)."""
        if not room_ids:
            return {}
        async with tenant_session(self._session_factory, tenant_id) as session:
            rows = (
                await session.execute(
                    select(Message.room_id, func.max(Message.seq))
                    .where(Message.room_id.in_(room_ids))
                    .group_by(Message.room_id)
                )
            ).all()
        found = {room_id: head for room_id, head in rows}
        return {room_id: max(found.get(room_id) or 0, 0) for room_id in room_ids}

    async def within_rooms(
        self, tenant_id: str, position: Position
    ) -> tuple[Position, list[str]]:
        """`position` with each room's place no further than the room's newest
        row, and the rooms whose place was further.

        A place past the end of a room comes from some other history (a
        restored database). Kept, it would pass over that many of the room's
        next messages without a word, since a position never moves back.
        """
        rooms = {
            room_id for source in position if (room_id := room_of(source)) is not None
        }
        clamped = dict(position)
        past: list[str] = []
        for room_id, head in (await self.room_heads(tenant_id, rooms)).items():
            source = room_source(room_id)
            if clamped[source] > head:
                clamped[source] = head
                past.append(room_id)
        return clamped, sorted(past)

    async def room_window_starts(
        self, tenant_id: str, room_ids: set[str]
    ) -> dict[str, int]:
        """Per room, the position just before the retention window: what a
        reader that has never read a room counts and reads from, the same
        stretch of conversation the agent's own events are kept for."""
        if not room_ids:
            return {}
        cutoff = datetime.now(UTC) - timedelta(seconds=self._retention_seconds)
        async with tenant_session(self._session_factory, tenant_id) as session:
            return {
                room_id: max(
                    await session.scalar(_window_start(room_id, cutoff)) or 0, 0
                )
                for room_id in room_ids
            }

    async def read_conversation(
        self,
        tenant_id: str,
        agent_id: str,
        after: dict[str, int],
        *,
        limit: int,
    ) -> Conversation:
        """The conversation in each of the rooms in `after`, past its position.

        What is read: messages and arrivals by others, since the agent joined,
        that are not already among its own events, and that the agent's
        consumer has decided are not. A room is read in order up to the first
        row it may not have decided yet. It takes a room's rows one at a time,
        in order, so every row up to its newest own event in the room is
        decided; a row past that is decided once it is old enough
        (`CONVERSATION_SETTLE_SECONDS`). Several files posted as one message
        are read as one, once all of them are in or the grace for the rest has
        passed.
        """
        if not after:
            return Conversation()
        started = time.perf_counter()
        events: list[BufferedEvent] = []
        through: dict[str, int] = {}
        async with tenant_session(self._session_factory, tenant_id) as session:
            me = await session.execute(
                select(Client.transport_user_id, Client.id)
                .join(Agent, Agent.client_id == Client.id)
                .where(Agent.id == agent_id)
            )
            identity = me.first()
            if identity is None:
                return Conversation()
            my_sender, my_client = identity
            joined: dict[str, Any] = {
                room_id: joined_at
                for room_id, joined_at in (
                    await session.execute(
                        select(ClientRoom.room_id, ClientRoom.joined_at).where(
                            ClientRoom.client_id == my_client,
                            ClientRoom.room_id.in_(after),
                        )
                    )
                ).all()
            }
            rooms = {
                room.id: room
                for room in (
                    await session.scalars(select(Room).where(Room.id.in_(after)))
                ).all()
            }
            # The database's clock, the one `sent_at` was stamped with.
            settled_before: datetime = cast(
                datetime,
                await session.scalar(
                    select(func.now() - timedelta(seconds=self._settle_seconds))
                ),
            )
            group_deadline = settled_before - timedelta(
                seconds=CONVERSATION_GROUP_GRACE_SECONDS
            )
            # The agent's newest own event per room, from its consumer (a
            # message or an arrival; commands are kept by another).
            decided: dict[str, int] = {
                room_id: seq
                for room_id, seq in (
                    await session.execute(
                        select(AgentEventRow.room_id, func.max(AgentEventRow.room_seq))
                        .where(
                            AgentEventRow.agent_id == agent_id,
                            AgentEventRow.room_id.in_(after),
                            AgentEventRow.type.in_(("message", "room_join")),
                        )
                        .group_by(AgentEventRow.room_id)
                    )
                ).all()
            }
            for room_id, after_seq in sorted(after.items()):
                room = rooms.get(room_id)
                if room is None or room_id not in joined:
                    continue
                rows: list[Message] = []
                for row in (
                    await session.scalars(
                        select(Message)
                        .where(
                            Message.room_id == room_id,
                            Message.seq > max(after_seq, 0),
                        )
                        .order_by(Message.seq)
                        .limit(limit)
                    )
                ).all():
                    if (
                        row.seq > decided.get(room_id, 0)
                        and cast(datetime, row.sent_at) >= settled_before
                    ):
                        break
                    rows.append(row)
                if not rows:
                    continue
                room_events, room_through = await self._conversation_in(
                    session,
                    room,
                    rows,
                    my_sender=my_sender,
                    joined_at=joined[room_id],
                    agent_id=agent_id,
                    group_deadline=group_deadline,
                )
                events.extend(room_events)
                if room_through > after_seq:
                    through[room_id] = room_through
        self._record_scan(_READ, len(events), started)
        return Conversation(events=events, through=through)

    async def _conversation_in(
        self,
        session: AsyncSession,
        room: Room,
        rows: list[Message],
        *,
        my_sender: str,
        joined_at: Any,
        agent_id: str,
        group_deadline: datetime,
    ) -> tuple[list[BufferedEvent], int]:
        """One room's rows as conversation, and how far they were looked at."""
        # The rows already among the agent's own events: each event covers its
        # message up to the room row it was delivered through. A file posted
        # with others that arrives after its group was delivered is past that
        # row, and is conversation like any other.
        keys = {message_key(row) for row in rows}
        delivered_through: dict[str, int] = {
            key: seq
            for key, seq in (
                await session.execute(
                    select(AgentEventRow.message_key, func.max(AgentEventRow.room_seq))
                    .where(
                        AgentEventRow.agent_id == agent_id,
                        AgentEventRow.message_key.in_(keys),
                    )
                    .group_by(AgentEventRow.message_key)
                )
            ).all()
        }

        def already_mine(row: Message) -> bool:
            return row.seq <= delivered_through.get(message_key(row), -1)

        attachments: dict[str, list[MessageAttachment]] = {}
        message_ids = [row.id for row in rows if row.event_type == "m.room.message"]
        if message_ids:
            for attachment in (
                await session.scalars(
                    select(MessageAttachment)
                    .where(MessageAttachment.message_id.in_(message_ids))
                    .order_by(MessageAttachment.message_id, MessageAttachment.position)
                )
            ).all():
                attachments.setdefault(attachment.message_id, []).append(attachment)

        # Several files posted as one message: the parts present here, by group.
        groups: dict[str, list[tuple[int, int, Message]]] = {}
        for row in rows:
            if already_mine(row):
                continue
            group = parse_attachment_group(row.content or {})
            if group is not None:
                groups.setdefault(group[0], []).append((group[1], group[2], row))

        held_from: int | None = None
        for parts in groups.values():
            total = parts[0][1]
            lead = min(parts, key=lambda part: part[0])[2]
            complete = len({index for index, _, _ in parts}) >= total
            if not complete and cast(datetime, lead.sent_at) >= group_deadline:
                first = min(row.seq for _, _, row in parts)
                held_from = first if held_from is None else min(held_from, first)

        member_names = await self._member_names(
            session,
            {
                row.sender_id
                for row in rows
                if row.event_type == "m.room.member" and row.sender_id != my_sender
            },
        )

        events: list[BufferedEvent] = []
        through = 0
        rendered_groups: set[str] = set()
        for row in rows:
            if held_from is not None and row.seq >= held_from:
                break
            through = row.seq
            if row.sender_id == my_sender or row.sent_at < joined_at:
                continue
            if already_mine(row):
                continue
            key = message_key(row)
            inbound = to_inbound(
                row, attachments.get(row.id, []), transport_room_id=room.id
            )
            event: AgentEvent | None = None
            seq = row.seq
            if isinstance(inbound, InboundMembership):
                if inbound.membership != "join" or inbound.prev_membership == "join":
                    continue
                event = room_join_event(
                    room_id=room.id,
                    bridge_id=room.bridge_id,
                    channel_type=room.channel_type,
                    member=inbound.state_key,
                    member_name=member_names.get(inbound.state_key)
                    or inbound.display_name
                    or inbound.state_key.split(":")[0].lstrip("@"),
                    timestamp=inbound.timestamp,
                    listening=False,
                )
            elif isinstance(inbound, InboundMedia) and key in groups:
                if key in rendered_groups:
                    continue
                rendered_groups.add(key)
                event, seq = self._grouped_media(
                    room, inbound, groups[key], attachments
                )
            elif isinstance(inbound, InboundMedia):
                event = message_event(
                    room_id=room.id,
                    bridge_id=room.bridge_id,
                    channel_type=room.channel_type,
                    event=inbound,
                    addressed=False,
                    sender_name=inbound.sender_name or inbound.sender,
                    body=inbound.body,
                    thread_id=inbound.thread_root_id,
                    attachments=[attachment_ref(inbound)],
                )
            elif isinstance(inbound, InboundMessage):
                event = message_event(
                    room_id=room.id,
                    bridge_id=room.bridge_id,
                    channel_type=room.channel_type,
                    event=inbound,
                    addressed=False,
                    sender_name=inbound.sender_name or inbound.sender,
                    body=inbound.body,
                    thread_id=None
                    if platform_replies_in_channel(inbound.content)
                    else inbound.thread_root_id,
                )
            if event is None:
                continue
            events.append(
                BufferedEvent(
                    seq=seq,
                    room_id=room.id,
                    event=event,
                    notifiable=False,
                    source=room_source(room.id),
                    room_seq=seq,
                    at=_epoch(cast(datetime, row.sent_at)),
                )
            )
        return events, through

    def _grouped_media(
        self,
        room: Room,
        lead_inbound: InboundMedia,
        parts: list[tuple[int, int, Message]],
        attachments: dict[str, list[MessageAttachment]],
    ) -> tuple[AgentEvent, int]:
        """Several files posted as one message, as the one message. Led by the
        lowest part present, which carries the caption and the id the sender
        was handed; flagged when parts are missing, as a live delivery would."""
        ordered = sorted(parts, key=lambda part: part[0])
        total = ordered[0][1]
        lead = ordered[0][2]
        refs = []
        for _, _, row in ordered:
            inbound = to_inbound(
                row, attachments.get(row.id, []), transport_room_id=room.id
            )
            if isinstance(inbound, InboundMedia):
                refs.append(attachment_ref(inbound))
        anchor = to_inbound(
            lead, attachments.get(lead.id, []), transport_room_id=room.id
        )
        if not isinstance(anchor, InboundMedia):
            anchor = lead_inbound
        body = anchor.body
        present = len({index for index, _, _ in ordered})
        if present < total:
            notice = (
                f"[incomplete attachment group: {present} of {total} files arrived]"
            )
            body = f"{body}\n{notice}" if body else notice
        event = message_event(
            room_id=room.id,
            bridge_id=room.bridge_id,
            channel_type=room.channel_type,
            event=anchor,
            addressed=False,
            sender_name=anchor.sender_name or anchor.sender,
            body=body,
            thread_id=anchor.thread_root_id,
            attachments=refs,
        )
        return event, max(row.seq for _, _, row in ordered)

    async def _member_names(
        self, session: AsyncSession, transport_ids: set[str]
    ) -> dict[str, str]:
        if not transport_ids:
            return {}
        rows = (
            await session.execute(
                select(Client.transport_user_id, Client.display_name).where(
                    Client.transport_user_id.in_(transport_ids)
                )
            )
        ).all()
        return {transport_id: name for transport_id, name in rows}

    # ------------------------------------------------------------------
    # Reading a position
    # ------------------------------------------------------------------

    async def read(
        self,
        tenant_id: str,
        agent_id: str,
        position: Position,
        *,
        conversation_rooms: set[str],
        notifiable_only: bool = False,
        slip_rooms: set[str] | None = None,
        limit: int,
    ) -> tuple[list[BufferedEvent], Position]:
        """The agent's own events and its rooms' conversation past `position`,
        in the order they happened, and how far each source was looked at.

        The agent's own events are read up to a head taken before the read, so
        the returned position never moves past one appended while reading.
        Events from one source stay in that source's order; sources are
        interleaved by time. Each of `conversation_rooms` is read from its
        place in `position`; one without a place is not read.
        """
        after = position.get(SLIPS, self.sequence_floor - 1)
        bound = await self.head(tenant_id, agent_id)
        slips = await self.read_from(
            tenant_id,
            agent_id,
            after,
            rooms=slip_rooms,
            notifiable_only=notifiable_only,
            limit=limit,
            through_seq=bound,
        )
        looked: Position = {}
        if len(slips) < limit and bound > after:
            looked[SLIPS] = bound
        conversation = await self.read_conversation(
            tenant_id,
            agent_id,
            {
                room_id: position[room_source(room_id)]
                for room_id in conversation_rooms
                if room_source(room_id) in position
            },
            limit=limit,
        )
        for room_id, seq in conversation.through.items():
            looked[room_source(room_id)] = seq
        return _interleaved([slips, *_by_source(conversation.events)]), looked

    # ------------------------------------------------------------------
    # Tickets, for clients that hold one number
    # ------------------------------------------------------------------

    async def mint_tickets(
        self, tenant_id: str, agent_id: str, positions: list[Position]
    ) -> list[int]:
        """One ticket per position, in order, for a client that can only hold
        one number: it sends the number back and gets the position."""
        if not positions:
            return []
        ids: list[int] = []
        async with tenant_session(self._session_factory, tenant_id) as session:
            for position in positions:
                ticket = await session.scalar(
                    insert(AgentPositionTicket)
                    .values(tenant_id=tenant_id, agent_id=agent_id, position=position)
                    .returning(AgentPositionTicket.id)
                )
                assert ticket is not None
                ids.append(ticket)
            await session.commit()
        return ids

    async def ticket(
        self, tenant_id: str, agent_id: str, ticket_id: int
    ) -> Position | None:
        """The position a ticket holds, or None when it is unknown or expired,
        or was handed to another agent."""
        async with tenant_session(self._session_factory, tenant_id) as session:
            position = await session.scalar(
                select(AgentPositionTicket.position).where(
                    AgentPositionTicket.id == ticket_id,
                    AgentPositionTicket.agent_id == agent_id,
                )
            )
        return dict(position) if position is not None else None

    # ------------------------------------------------------------------
    # Unread counts
    # ------------------------------------------------------------------

    async def ensure_counting(
        self, tenant_id: str, agent_id: str, reader_id: str, room_id: str
    ) -> None:
        """A connection is delivering this room: count it from now if nothing
        is counting it yet.

        Covering a room is not being in it. A connection carries every session
        of an agent and delivers the union of their rooms, so a connection
        saying what it covers must not take a room from whoever is in it.
        Nothing already recorded is touched.
        """
        async with tenant_session(self._session_factory, tenant_id) as session:
            await session.execute(
                _counting(
                    agent_id,
                    room_id,
                    baseline=_room_head(room_id),
                    occupant=Reader(id=reader_id, is_session=False),
                ).on_conflict_do_nothing(
                    index_elements=[AgentRoomRead.agent_id, AgentRoomRead.room_id]
                )
            )
            await session.commit()

    async def take_counting(
        self, tenant_id: str, agent_id: str, reader_id: str, room_id: str
    ) -> None:
        """A connection has taken this room from whoever held it.

        For the doors where the room slot itself changes hands and the registry
        has granted the takeover. The taker becomes the one whose reading clears
        the count; what the room is behind by survives the change of hands.
        """
        async with tenant_session(self._session_factory, tenant_id) as session:
            await session.execute(
                _counting(
                    agent_id,
                    room_id,
                    baseline=_room_head(room_id),
                    occupant=Reader(id=reader_id, is_session=False),
                ).on_conflict_do_update(
                    index_elements=[AgentRoomRead.agent_id, AgentRoomRead.room_id],
                    set_={"occupant_id": reader_id, "occupant_is_session": False},
                )
            )
            await session.commit()

    async def hand_counting_to(
        self, tenant_id: str, agent_id: str, reader: Reader, room_id: str
    ) -> None:
        """Record that `reader` is the one in the room now.

        Connecting to a room is taking it, so the newcomer becomes the only
        caller whose reading clears the count there. What the room is behind by
        survives the change of hands. A room nothing has counted yet counts
        the retention window, the most that can be said about how far behind
        it is.
        """
        start = (await self.room_window_starts(tenant_id, {room_id}))[room_id]
        async with tenant_session(self._session_factory, tenant_id) as session:
            await session.execute(
                _counting(
                    agent_id, room_id, baseline=literal(start), occupant=reader
                ).on_conflict_do_update(
                    index_elements=[AgentRoomRead.agent_id, AgentRoomRead.room_id],
                    set_={
                        "occupant_id": reader.id,
                        "occupant_is_session": reader.is_session,
                    },
                )
            )
            await session.commit()

    async def caught_up(
        self,
        tenant_id: str,
        agent_id: str,
        reader: Reader,
        room_id: str,
        through_seq: int,
        arrived_on: str | None,
    ) -> None:
        """Record that the room's occupant has caught up through `through_seq`,
        a position in the room.

        Forward only, and only for the room named. Ignored from anyone but the
        occupant: a read is begun before its history arrives, so a session
        displaced while its read was in flight comes back holding an answer for
        a room it has left. A session may take the count over from the
        connection it is speaking over (`arrived_on`), and from nothing else.
        """
        async with tenant_session(self._session_factory, tenant_id) as session:
            held = await session.scalar(
                select(AgentRoomRead)
                .where(
                    AgentRoomRead.agent_id == agent_id,
                    AgentRoomRead.room_id == room_id,
                )
                .with_for_update()
            )
            if held is None:
                session.add(
                    AgentRoomRead(
                        tenant_id=tenant_id,
                        agent_id=agent_id,
                        room_id=room_id,
                        caught_up_seq=through_seq,
                        occupant_id=reader.id,
                        occupant_is_session=reader.is_session,
                    )
                )
                await session.commit()
                return
            occupant = Reader(id=held.occupant_id, is_session=held.occupant_is_session)
            if occupant != reader:
                if not reader.is_session:
                    return
                if occupant.is_session or occupant.id != arrived_on:
                    return
                held.occupant_id = reader.id
                held.occupant_is_session = True
            if through_seq > held.caught_up_seq:
                held.caught_up_seq = through_seq
            await session.commit()

    async def unread(
        self, tenant_id: str, agent_id: str, room_id: str, through_seq: int
    ) -> Unread:
        """Unaddressed messages in one room the agent has not caught up on, up
        to `through_seq`, a position in the room.

        Counted from the room's own log on demand, so it cannot disagree with
        it. Only messages, and not the agent's own: an agent is told how much
        conversation went past it. Several files posted as one message count
        once. Never further back than the retention window, where what was
        addressed to the agent can still be told apart; a count cut there says
        so.
        """
        async with tenant_session(self._session_factory, tenant_id) as session:
            baseline = await session.scalar(
                select(AgentRoomRead.caught_up_seq).where(
                    AgentRoomRead.agent_id == agent_id,
                    AgentRoomRead.room_id == room_id,
                )
            )
            if baseline is None:
                return Unread(count=None, reason=NO_BASELINE)
            cutoff = datetime.now(UTC) - timedelta(seconds=self._retention_seconds)
            window_start = await session.scalar(_window_start(room_id, cutoff)) or 0
            reason = None
            if baseline < window_start:
                baseline, reason = window_start, COUNTED_FROM_WINDOW
            me = await session.scalar(
                select(Client.transport_user_id)
                .join(Agent, Agent.client_id == Client.id)
                .where(Agent.id == agent_id)
            )
            started = time.perf_counter()
            count = await session.scalar(
                _UNREAD_SQL,
                {
                    "room_id": room_id,
                    "baseline": baseline,
                    "through": through_seq,
                    "me": me or "",
                    "agent_id": agent_id,
                },
            )
        self._record_scan(_UNREAD, count or 0, started)
        return Unread(count=count or 0, reason=reason)

    # ------------------------------------------------------------------
    # Leaving
    # ------------------------------------------------------------------

    def remove(self, agent_id: str) -> None:
        """Forget this process's wake-up for an agent. Everything kept about it
        goes with the agent's own row (`ON DELETE CASCADE`)."""
        self._notify.pop(agent_id, None)

    async def drop_room(self, tenant_id: str, agent_id: str, room_id: str) -> None:
        """Delete the agent's own events in one room.

        Called when the agent is removed from it. Sequence numbers are untouched
        and no gap is recorded: a reader that skips these has missed nothing it
        was entitled to, and saying otherwise would send it to re-read the
        context of a room it is not in.
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
        """Delete one tenant's events and tickets older than the retention window.

        Lossy, so it records, per agent and room, the newest event it deleted:
        the next reader resuming from before that is told it missed events
        there. Retention is independent of what readers have confirmed: an
        event stays readable for its window whether or not somebody has already
        consumed it, so a reader that arrives late still sees recent history.
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
            await session.execute(
                delete(AgentPositionTicket).where(
                    AgentPositionTicket.created_at < cutoff
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
    # Polling clients send no position and have nowhere to keep one, so the
    # server keeps it for them, per reader (`agent_poll_positions`): "everything
    # after the last thing I gave you, and record that I gave it". Behaviour is
    # unchanged from their point of view — they never see a duplicate — but
    # reads are not destructive, so a streaming reader on the same agent is
    # unaffected.
    #
    # Delivery stays at-most-once for these callers, exactly as before: the
    # position advances on send, so a response lost in flight loses its events.
    # ------------------------------------------------------------------

    async def poll(
        self, tenant_id: str, agent_id: str, *, rooms: set[str], timeout: float = 30
    ) -> list[AgentEvent]:
        """Everything for this agent in the rooms it is in: its own events and
        the conversation.

        `rooms` is how the caller applies membership, and it is required: the
        agent's events are keyed by agent and know nothing about who is in
        what, so one queued while the agent was a member stays queued after it
        is removed. A default would make the leak the thing a new caller gets
        for free.
        """
        return await self._legacy_poll(
            tenant_id,
            agent_id,
            "legacy:all",
            timeout=timeout,
            rooms=rooms,
            conversation=True,
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
            conversation=True,
            rooms_are_membership=False,
        )

    async def poll_notifications(
        self, tenant_id: str, agent_id: str, *, rooms: set[str], timeout: float = 30
    ) -> list[AgentEvent]:
        """The agent's own addressed events, under the same membership rule.

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
        conversation: bool = False,
        notifiable_only: bool = False,
        rooms_are_membership: bool = True,
    ) -> list[AgentEvent]:
        args = (
            tenant_id,
            agent_id,
            reader_id,
            rooms,
            conversation,
            notifiable_only,
            rooms_are_membership,
        )
        events = await self._legacy_take(*args)
        if events:
            return events

        if conversation:
            # The conversation announces nothing to this doorbell and is read
            # once it has settled, so a poll waiting for it looks again then.
            await self.wait(agent_id, min(timeout, self._settle_seconds * 2))
        else:
            await self.wait(agent_id, timeout)

        return await self._legacy_take(*args)

    async def _legacy_take(
        self,
        tenant_id: str,
        agent_id: str,
        reader_id: str,
        rooms: set[str],
        conversation: bool,
        notifiable_only: bool,
        rooms_are_membership: bool,
    ) -> list[AgentEvent]:
        """One read, moving the position past what this reader can never want.

        Past what it can never want, and no further. The bound on the agent's
        own events is taken before the read and the read stops at it, so the
        position moves through exactly what was handed over. A room set taken
        from membership is not fixed: an agent added to a room that already
        has events for it would find the position already past them, so with
        membership the bound is the newest event in those rooms, not the head.
        """
        position = await self._poll_position(
            tenant_id, agent_id, reader_id, rooms if conversation else set()
        )
        after = position[SLIPS]
        if rooms_are_membership:
            through = await self._last_seq_in_rooms(tenant_id, agent_id, after, rooms)
        else:
            through = await self.head(tenant_id, agent_id)
        try:
            slips = await self.read_from(
                tenant_id,
                agent_id,
                after,
                rooms=rooms,
                notifiable_only=notifiable_only,
                through_seq=through,
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
            after = max(exc.oldest - 1, 0)
            slips = await self.read_from(
                tenant_id,
                agent_id,
                after,
                rooms=rooms,
                notifiable_only=notifiable_only,
                through_seq=through,
            )
        moved = merged(position, {SLIPS: max(through, after)})
        found: list[list[BufferedEvent]] = [slips]
        if conversation:
            said = await self.read_conversation(
                tenant_id,
                agent_id,
                {room_id: moved[room_source(room_id)] for room_id in rooms},
                limit=10_000,
            )
            found.extend(_by_source(said.events))
            moved = merged(
                moved,
                {room_source(room_id): seq for room_id, seq in said.through.items()},
            )
        await self._save_poll_position(tenant_id, agent_id, reader_id, moved)
        return [item.event for item in _interleaved(found)]

    async def _poll_position(
        self, tenant_id: str, agent_id: str, reader_id: str, rooms: set[str]
    ) -> Position:
        """A poller's position, with a place in each of `rooms`.

        A poller seen for the first time starts before the oldest event still
        kept, mirroring the queue it replaces: events accumulated while nobody
        was polling and the first poll drained them. Starting at head would
        silently swallow anything that arrived before the client got around to
        asking. A room it has not read yet starts at the retention window, for
        the same reason.
        """
        async with tenant_session(self._session_factory, tenant_id) as session:
            stored = await session.scalar(
                select(AgentPollPosition.position).where(
                    AgentPollPosition.agent_id == agent_id,
                    AgentPollPosition.reader_id == reader_id,
                )
            )
        position: Position = dict(stored) if stored is not None else {}
        if SLIPS not in position:
            oldest = await self.oldest_retained(tenant_id, agent_id)
            position[SLIPS] = max(oldest - 1, 0)
        missing = {room_id for room_id in rooms if room_source(room_id) not in position}
        if missing:
            starts = await self.room_window_starts(tenant_id, missing)
            for room_id, start in starts.items():
                position[room_source(room_id)] = start
        return position

    async def _save_poll_position(
        self, tenant_id: str, agent_id: str, reader_id: str, position: Position
    ) -> None:
        # Selected through the agent, so a poll still in flight when its agent
        # is deleted saves nothing rather than failing.
        async with tenant_session(self._session_factory, tenant_id) as session:
            await session.execute(
                insert(AgentPollPosition)
                .from_select(
                    [
                        AgentPollPosition.tenant_id,
                        AgentPollPosition.agent_id,
                        AgentPollPosition.reader_id,
                        AgentPollPosition.position,
                    ],
                    select(
                        Agent.tenant_id,
                        Agent.id,
                        literal(reader_id),
                        literal(position, AgentPollPosition.position.type),
                    ).where(Agent.id == agent_id),
                )
                .on_conflict_do_update(
                    index_elements=[
                        AgentPollPosition.agent_id,
                        AgentPollPosition.reader_id,
                    ],
                    set_={"position": position},
                )
            )
            await session.commit()

    async def _last_seq_in_rooms(
        self, tenant_id: str, agent_id: str, after_seq: int, rooms: set[str]
    ) -> int:
        """The newest retained event after `after_seq` in one of `rooms`.

        `after_seq` itself when there is none, so a caller confirming this
        never moves a position over an event held for a room the agent is not
        in yet.
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


def _counting(agent_id: str, room_id: str, *, baseline: Any, occupant: Reader) -> Any:
    """An `agent_room_reads` row for a room that exists, and none for one that
    does not: a room deleted while a reader covered it has nothing left to
    count, and must not fail the reader's stream."""
    return insert(AgentRoomRead).from_select(
        [
            AgentRoomRead.tenant_id,
            AgentRoomRead.agent_id,
            AgentRoomRead.room_id,
            AgentRoomRead.caught_up_seq,
            AgentRoomRead.occupant_id,
            AgentRoomRead.occupant_is_session,
        ],
        select(
            Room.tenant_id,
            literal(agent_id),
            Room.id,
            baseline,
            literal(occupant.id),
            literal(occupant.is_session),
        ).where(Room.id == room_id),
    )


def _window_start(room_id: str, cutoff: datetime) -> Any:
    """The room's newest row from before `cutoff`: one probe of the room's
    `sent_at` index, rather than a scan of everything said since."""
    return (
        select(Message.seq)
        .where(Message.room_id == room_id, Message.sent_at < cutoff)
        .order_by(Message.sent_at.desc())
        .limit(1)
    )


def _room_head(room_id: str) -> Any:
    """A room's newest position, as an expression for an insert."""
    return (
        select(func.coalesce(func.max(Message.seq), 0))
        .where(Message.room_id == room_id)
        .scalar_subquery()
    )


def _by_source(events: list[BufferedEvent]) -> list[list[BufferedEvent]]:
    """Events split by the source they came from, each in its own order."""
    sources: dict[str, list[BufferedEvent]] = {}
    for item in events:
        sources.setdefault(item.source, []).append(item)
    return list(sources.values())


def _interleaved(sources: list[list[BufferedEvent]]) -> list[BufferedEvent]:
    """Several sources' events as one sequence, earliest first.

    Only each source's next event is ever compared, so every source keeps its
    own order — which is what makes a position safe to move per event — while
    sources are woven together by when their events happened.
    """
    heads = [0] * len(sources)
    out: list[BufferedEvent] = []
    while True:
        best: int | None = None
        for index, items in enumerate(sources):
            if heads[index] >= len(items):
                continue
            if best is None or items[heads[index]].at < sources[best][heads[best]].at:
                best = index
        if best is None:
            return out
        out.append(sources[best][heads[best]])
        heads[best] += 1
