"""The frames of an agent connection (CHOO-1857).

Turns a connection plus the event buffer into a sequence of frames: catch-up
from the client's cursor, then live delivery as events are appended. The client
never asks again; it opens once and reads. `api/handlers.py` sends them over
the WebSocket, or, for a client built before it, as a Server-Sent Events
stream: both encode the same frames from the same loop, so they cannot drift.

Every event carries its place, so a client that reconnects names how far it
got and resumes exactly where it stopped. A client that holds a position is
told each event's source and number (`position`); one that holds a single
number is told that number, or, when the stream reads more than one source, a
ticket standing for the position. Gaps are reported as their own event rather
than skipped: a client that has missed events must never see a stream that
looks complete.
"""

from __future__ import annotations

import asyncio
import json
import logging
import time
from collections.abc import AsyncGenerator, AsyncIterator
from dataclasses import dataclass
from typing import TYPE_CHECKING, Any

from switch_core.bridges.agent.protocol.agent_connections import (
    APPROVAL_OUTCOME_PROTOCOL_REVISION,
    HEARTBEAT_LAPSED,
    PROTOCOL_VERSION,
    TAKEN_OVER,
    AgentConnection,
    AgentConnectionRegistry,
    Closure,
)
from switch_core.bridges.agent.protocol.event_buffer import (
    BufferedEvent,
    CursorExpiredError,
    EventBuffer,
)
from switch_core.bridges.agent.protocol.positions import SLIPS, Position, room_source
from switch_core.observability.catalogue import BRIDGE_EVENTS_OUT
from switch_core.observability.metrics import metrics
from switch_core.tenant_context import current_tenant_id
from switch_core.version import server_declaration

if TYPE_CHECKING:
    from switch_core.session_activity.outcomes import ApprovalOutcomes, Outcome

logger = logging.getLogger(__name__)

# How long the loop waits for work before yielding an idle tick, so whoever
# reads it gets a chance to do its own periodic work.
KEEPALIVE_INTERVAL_SECONDS = 15.0

# Cap on how many buffered events are written in one batch, so a large catch-up
# cannot monopolise the loop.
CATCH_UP_BATCH = 200


@dataclass(frozen=True)
class Frame:
    """One message on an agent's event stream, before it is encoded.

    The loop decides what to send; the transport decides how it is encoded.
    """

    event: str
    data: dict[str, Any]
    seq: int | None = None


# Not a message: the loop's signal that it waited a keepalive interval with
# nothing to send. The WebSocket has its own ping and drops it; the event
# stream writes a comment, which only stops proxies dropping an idle
# connection. Liveness comes from the client's beat, never from this.
KEEPALIVE = Frame("keepalive", {})


def _frame(event: str, data: dict[str, Any], *, seq: int | None = None) -> Frame:
    return Frame(event, data, seq)


def encode_ws(frame: Frame) -> dict[str, Any]:
    """A frame as a WebSocket message. `id` is the event's sequence number,
    which a reconnecting client passes back as `start_from`."""
    message: dict[str, Any] = {"event": frame.event, "data": frame.data}
    if frame.seq is not None:
        message["id"] = frame.seq
    return message


def encode_sse(frame: Frame) -> bytes:
    """A frame as a Server-Sent Event. `id` is the event's sequence number,
    which a reconnecting client sends back as `Last-Event-ID`."""
    if frame is KEEPALIVE:
        return b": keepalive\n\n"
    lines = []
    if frame.seq is not None:
        lines.append(f"id: {frame.seq}")
    lines.append(f"event: {frame.event}")
    lines.append(f"data: {json.dumps(frame.data, separators=(',', ':'))}")
    return ("\n".join(lines) + "\n\n").encode()


async def sse_stream(frames: AsyncGenerator[Frame]) -> AsyncIterator[bytes]:
    """The connection's frames as a `text/event-stream` body.

    Kept for clients built before the WebSocket (agent-protocol revision 7 and
    older), for a compatibility window: it goes once
    `switch.agents.connected{transport:sse}` stays at zero.
    """
    try:
        async for frame in frames:
            yield encode_sse(frame)
    finally:
        # Closed here, so the stream detaches from its connection when the
        # client goes rather than when the generator is garbage collected.
        await frames.aclose()


def _connection_state(conn: AgentConnection) -> dict[str, Any]:
    """The first frame of every stream, and where the server declares itself.

    Version disclosure rides this frame rather than an endpoint of its own
    (CHOO-1865): the stream is already authenticated, and nothing about the
    server's version is reachable without authenticating. `protocol` stays as
    it was — clients read it today — and equals the server's `speaks`.

    `server.version` is null when switch-core cannot read its own version.
    Null means unknown and must be rendered as such, never as current.
    """
    return {
        "connection_id": conn.id,
        "agent_id": conn.agent_id,
        # Which incarnation of the id this stream is. The client sends it back
        # on every heartbeat, which is what lets the server tell the holder of
        # a connection from a client that has been displaced from it — the two
        # are otherwise identical on the wire.
        "generation": conn.stream_generation,
        "scope": conn.scope,
        "filter": conn.delivery_filter,
        "spawn_capable": conn.spawn_capable,
        "rooms": sorted(conn.rooms),
        "cursor": conn.cursor,
        "position": dict(conn.position),
        "protocol": PROTOCOL_VERSION,
        "heartbeat_interval_seconds": 2.0,
        "server": server_declaration("agent-protocol"),
        # Echoed back so a client can see what the server understood it to
        # have said — a declaration that silently failed to parse is worse
        # than one never sent, because both sides think it landed.
        "client": conn.declaration.as_dict(),
    }


def _eviction(closure: Closure) -> dict[str, Any]:
    """The evicted frame: a code to act on, prose to read, a room when one applies."""
    return {
        "code": closure.code,
        "reason": closure.message,
        "room_id": closure.room_id,
    }


def event_frames(
    *,
    conn: AgentConnection,
    registry: AgentConnectionRegistry,
    buffer: EventBuffer,
    approvals: ApprovalOutcomes | None,
) -> AsyncGenerator[Frame]:
    """The connection's frames, for a transport to encode."""
    return _event_stream(
        conn=conn,
        registry=registry,
        buffer=buffer,
        approvals=approvals,
        generation=conn.stream_generation,
    )


async def _event_stream(
    *,
    conn: AgentConnection,
    registry: AgentConnectionRegistry,
    buffer: EventBuffer,
    approvals: ApprovalOutcomes | None,
    generation: int,
) -> AsyncGenerator[Frame]:
    """Yield frames for a connection until its stream is superseded or it dies."""
    if conn.stream_generation != generation:
        return
    agent_id = conn.agent_id
    bell = buffer.doorbell(agent_id)
    # Captured before the first yield: the generator suspends there, and any
    # subscription change that lands while it is suspended must still be
    # reported when it resumes.
    last_rooms = set(conn.rooms)

    tenant_id = current_tenant_id()
    if tenant_id is None:
        raise RuntimeError("An agent stream runs inside its agent's tenant")
    tenant: str = tenant_id

    # Approval answers and expiries, for the agent's own stream only: the
    # watcher that routes work to its sessions. Owed ones are read on opening
    # and on every resync; live ones arrive pushed. Keyed so a resync that
    # overlaps a live push sends each outcome once per pass.
    outcomes: dict[tuple[str, str], Outcome] = {}
    resync = [False]
    unsubscribe_outcomes = None
    speaks = conn.declaration.speaks
    if (
        approvals is not None
        and conn.scope == "all"
        and speaks is not None
        and speaks >= APPROVAL_OUTCOME_PROTOCOL_REVISION
    ):

        def owe(outcome: Outcome) -> None:
            outcomes[(outcome["session_id"], outcome["request_id"])] = outcome
            conn.wake.set()

        def recheck() -> None:
            resync[0] = True
            conn.wake.set()

        unsubscribe_outcomes = approvals.subscribe(tenant, agent_id, owe, recheck)
        resync[0] = True
    # Rooms this stream has made sure are being counted, so a pass of the loop
    # asks the database only about rooms it has not seen yet.
    counted: set[str] = set()
    last_keepalive = time.monotonic()
    try:
        yield _frame("connection_state", _connection_state(conn))

        for gap in await _opening_gaps(conn, buffer, tenant):
            yield _frame("gap", gap)

        while True:
            if conn.stream_generation != generation:
                # Another stream took this connection over.
                yield _frame("evicted", _eviction(TAKEN_OVER))
                return
            if conn.closure is not None:
                yield _frame("evicted", _eviction(conn.closure))
                return
            if not conn.is_alive(time.monotonic()):
                # Delivering to a connection whose heartbeat has lapsed is the
                # worst of both worlds: every presence reader treats it as dead
                # (they filter on liveness), so the agent is reported offline
                # while its socket keeps handing it events. That combination is
                # invisible from either side — the client sees traffic and
                # believes it is fine, the room is told nobody is home.
                logger.warning(
                    "[STREAM] agent=%s connection=%s heartbeat lapsed — closing "
                    "the stream rather than delivering to a connection nothing "
                    "else considers alive",
                    agent_id,
                    conn.id,
                )
                registry.close(conn.id, HEARTBEAT_LAPSED)
                yield _frame("evicted", _eviction(HEARTBEAT_LAPSED))
                return

            if conn.session_commands:
                relayed = list(conn.session_commands)
                conn.session_commands.clear()
                for frame in relayed:
                    yield _frame("session_command", frame)

            if conn.released_rooms:
                released = dict(conn.released_rooms)
                conn.released_rooms.clear()
                for room_id, session_id in released.items():
                    yield _frame(
                        "room_released", {"room_id": room_id, "session_id": session_id}
                    )

            if resync[0] and approvals is not None:
                resync[0] = False
                for outcome in await approvals.undelivered(agent_id):
                    outcomes[(outcome["session_id"], outcome["request_id"])] = outcome
            if outcomes:
                owed = list(outcomes.values())
                outcomes.clear()
                for outcome in owed:
                    yield _frame("approval_outcome", outcome)

            if conn.rooms != last_rooms:
                last_rooms = set(conn.rooms)
                yield _frame(
                    "subscription_changed",
                    {"rooms": sorted(last_rooms), "reason": "subscription updated"},
                )

            if conn.scope == "single" and not conn.rooms:
                # A session connection that has not claimed a room yet must not
                # read. It would find every event uncovered — it covers nothing
                # — and the skip path advances the position, so it would consume
                # its way to the end of the agent's events while waiting for its
                # room.
                #
                # That window is not an edge case: a session spawned to answer a
                # message opens its connection *before* the session boots and
                # calls connect_to_room. Reading during it burns past the very
                # message the session was started for, which then never arrives.
                #
                # Park until a room is claimed. `claim_room` sets `wake`, so the
                # loop resumes the moment there is something to cover, with the
                # position still where it started.
                conn.wake.clear()
                if not conn.rooms and not await _wait_for_wake(conn):
                    yield KEEPALIVE
                continue

            # Where counting starts for a room nothing is counting yet: now. A
            # room covered later starts from then too. Covering is not taking:
            # the room slot changes hands at the doors, not on every pass.
            for room_id in conn.rooms - counted:
                await buffer.ensure_counting(tenant, agent_id, conn.id, room_id)
                counted.add(room_id)

            conversation_rooms: set[str] = set()
            if conn.reads_conversation:
                conversation_rooms = await _conversation_rooms(
                    conn, registry, buffer, tenant
                )
                # A room this connection has never read starts where the room
                # is now: what was said before it covered the room is history,
                # read with `read_context`, not a backlog to deliver.
                fresh = {
                    room_id
                    for room_id in conversation_rooms
                    if room_source(room_id) not in conn.position
                }
                for room_id, head in (await buffer.room_heads(tenant, fresh)).items():
                    conn.position[room_source(room_id)] = head

            try:
                pending, looked = await buffer.read(
                    tenant,
                    agent_id,
                    conn.position,
                    conversation_rooms=conversation_rooms,
                    notifiable_only=not conn.reads_conversation,
                    limit=CATCH_UP_BATCH,
                )
            except CursorExpiredError as exc:
                resumed_at = max(exc.oldest - 1, 0)
                conn.position[SLIPS] = resumed_at
                yield _frame(
                    "gap",
                    _gap(
                        conn,
                        from_sequence=exc.requested,
                        resumed_at=resumed_at,
                        rooms=list(exc.rooms),
                        all_rooms=False,
                        reason=str(exc),
                    ),
                )
                continue

            # Room coverage is evaluated per event rather than up front: a
            # sibling claiming a room must take effect immediately, without
            # tearing the stream down. An uncovered event of the agent's own is
            # passed over, and the position moves past it all the same.
            deliver: list[BufferedEvent] = []
            for item in pending:
                if item.source == SLIPS and not registry.covers(conn, item.room_id):
                    conn.position[SLIPS] = item.seq
                    continue
                deliver.append(item)

            tickets = await _tickets_for(conn, buffer, tenant, deliver)
            delivered = False
            for index, item in enumerate(deliver):
                payload = item.event.model_dump(mode="json")
                frame_seq = _number_for(conn, item, tickets, index)
                payload["sequence"] = frame_seq if frame_seq is not None else item.seq
                if conn.speaks_positions:
                    payload["position"] = {item.source: item.seq}
                if item.notifiable:
                    # Told on the way past, on the one event the agent is being
                    # woken for anyway. A count of its own would be a wake
                    # spent on "you may have missed something you may not care
                    # about".
                    unread = await buffer.unread(
                        tenant, agent_id, item.room_id, item.room_seq
                    )
                    payload["missed"] = {
                        "count": unread.count,
                        "reason": unread.reason,
                    }
                # Advance before yielding: the position tracks what the server
                # has written out. What the client has actually processed comes
                # back on its heartbeat, which is what governs resume.
                if item.seq > conn.position.get(item.source, -1):
                    conn.position[item.source] = item.seq
                if tickets:
                    conn.ticket = tickets[index]
                delivered = True
                metrics().increment(
                    BRIDGE_EVENTS_OUT,
                    {"bridge": "agent", "platform": "switch", "kind": item.event.type},
                )
                yield _frame(item.event.type, payload, seq=frame_seq)

            # Past what was looked at and not delivered: events the filter left
            # out, rows that are not conversation. Nothing is lost by moving
            # past them: the position records what has been written out, not
            # what the agent has caught up on, so they stay countable. Not
            # moving past them would leave "anything new?" below permanently
            # true, and the loop would spin instead of waiting.
            for source, seq in looked.items():
                if seq > conn.position.get(source, -1):
                    conn.position[source] = seq

            if delivered:
                continue

            bell.clear()
            conn.wake.clear()
            # Re-check after clearing: an event appended between the read above
            # and the clear would otherwise wait for the keepalive timeout.
            if (
                conn.session_commands
                or conn.released_rooms
                or outcomes
                or resync[0]
                or await buffer.head(tenant, agent_id) > conn.position.get(SLIPS, 0)
                or conn.rooms != last_rooms
            ):
                continue

            # The conversation rings no bell: it is read once it has settled,
            # so a stream that reads it looks again when it may have.
            timeout = (
                buffer.settle_seconds
                if conn.reads_conversation
                else KEEPALIVE_INTERVAL_SECONDS
            )
            if await _wait_for_work(bell, conn, timeout):
                continue
            if time.monotonic() - last_keepalive >= KEEPALIVE_INTERVAL_SECONDS:
                last_keepalive = time.monotonic()
                yield KEEPALIVE
    finally:
        if unsubscribe_outcomes is not None:
            unsubscribe_outcomes()
        registry.detach_stream(conn, generation)


def _gap(
    conn: AgentConnection,
    *,
    from_sequence: int,
    resumed_at: int,
    rooms: list[str],
    all_rooms: bool,
    reason: str,
) -> dict[str, Any]:
    """A gap frame: the integers an older client acts on, and the position."""
    return {
        "from_sequence": from_sequence,
        "resumed_at": resumed_at,
        "resumed_position": dict(conn.position),
        "rooms": rooms,
        "all_rooms": all_rooms,
        "reason": reason,
    }


async def _opening_gaps(
    conn: AgentConnection, buffer: EventBuffer, tenant: str
) -> list[dict[str, Any]]:
    """What the client's resume point says it missed, told before anything else.

    A ticket the server no longer holds, a number from before this agent's
    events were kept here, one ahead of everything held, or one older than
    what is still retained. Each is reported, never smoothed over: a client
    left believing it is caught up when its numbering no longer means anything
    never re-reads what it lost.
    """
    agent_id = conn.agent_id
    gaps: list[dict[str, Any]] = []
    if conn.resume_lost:
        conn.resume_lost = False
        gaps.append(
            _gap(
                conn,
                from_sequence=conn.resume_requested,
                resumed_at=conn.cursor,
                rooms=sorted(conn.rooms),
                all_rooms=True,
                reason="where you left off is no longer known to the server; "
                "re-read room context",
            )
        )
        return gaps

    at = conn.position.get(SLIPS, 0)
    head = await buffer.head(tenant, agent_id)
    floor = await buffer.first_seq(tenant, agent_id)
    if 0 < at < floor - 1:
        # Numbering only ever starts above every earlier one, so the client
        # keeps its sequence-based dedupe (nothing is reused); what it has lost
        # is every event from before.
        logger.warning(
            "[STREAM] agent=%s connection=%s resumed from cursor %s of an "
            "earlier server boot (this agent's events start at %s)",
            agent_id,
            conn.id,
            at,
            floor,
        )
        conn.position[SLIPS] = floor - 1
        gaps.append(
            _gap(
                conn,
                from_sequence=at,
                resumed_at=floor - 1,
                rooms=sorted(conn.rooms),
                all_rooms=True,
                reason="the server restarted since your last connection; "
                "events from before the restart are gone in every room, "
                "including any this connection has yet to claim — re-read "
                "room context",
            )
        )
        at = floor - 1
    elif at > head:
        logger.warning(
            "[STREAM] agent=%s connection=%s resumed from cursor %s but the "
            "agent's events only reach %s — treating as a restart",
            agent_id,
            conn.id,
            at,
            head,
        )
        conn.position[SLIPS] = head
        gaps.append(
            _gap(
                conn,
                from_sequence=head,
                resumed_at=head,
                rooms=sorted(conn.rooms),
                all_rooms=True,
                reason="the server restarted since your last connection; "
                "sequence numbers have been reset and events from before "
                "the restart are gone in every room, including any this "
                "connection has yet to claim — re-read room context",
            )
        )
        at = head

    # A point the agent's events can no longer serve is reported, not silently
    # moved to head. The client re-reads room context to recover.
    lost = await buffer.rooms_dropped_after(tenant, agent_id, at)
    if lost:
        oldest = await buffer.oldest_retained(tenant, agent_id)
        logger.warning(
            "[STREAM] agent=%s connection=%s resumed from expired cursor %s "
            "(oldest retained %s, rooms %s)",
            agent_id,
            conn.id,
            at,
            oldest,
            ", ".join(lost),
        )
        resumed_at = max(oldest - 1, 0)
        conn.position[SLIPS] = resumed_at
        gaps.append(
            _gap(
                conn,
                from_sequence=at,
                resumed_at=resumed_at,
                rooms=list(lost),
                all_rooms=False,
                reason="events older than the retention window were "
                "dropped; re-read room context",
            )
        )
    return gaps


async def _conversation_rooms(
    conn: AgentConnection,
    registry: AgentConnectionRegistry,
    buffer: EventBuffer,
    tenant: str,
) -> set[str]:
    """The rooms whose conversation this connection is sent: the room it holds,
    for a session; for a connection over every room, each room the agent is in
    that no live sibling holds."""
    if conn.scope == "single":
        return set(conn.rooms)
    member = await buffer.member_rooms(tenant, conn.agent_id)
    return {room_id for room_id in member if registry.covers(conn, room_id)}


async def _tickets_for(
    conn: AgentConnection,
    buffer: EventBuffer,
    tenant: str,
    deliver: list[BufferedEvent],
) -> list[int]:
    """Tickets for the events about to be sent, when the client holds one number
    and the stream reads more than one source: each stands for the position
    after its event, so the number the client sends back resumes it there."""
    if conn.speaks_positions or not conn.reads_conversation or not deliver:
        return []
    positions: list[Position] = []
    position = dict(conn.position)
    for item in deliver:
        if item.seq > position.get(item.source, -1):
            position[item.source] = item.seq
        positions.append(dict(position))
    return await buffer.mint_tickets(tenant, conn.agent_id, positions)


def _number_for(
    conn: AgentConnection, item: BufferedEvent, tickets: list[int], index: int
) -> int | None:
    """The number a delivered event is sent with: its ticket, for a client that
    holds one number over more than one source; otherwise its number in the
    agent's own events, or none for the conversation, whose place is in
    `position`."""
    if tickets:
        return tickets[index]
    if item.source == SLIPS:
        return item.seq
    return None


async def _wait_for_wake(conn: AgentConnection) -> bool:
    """Wait for the connection itself to change — a room claim, or a close.

    Deliberately not waiting on the event bell: a parked connection covers
    nothing, so new events are not news to it, and waking for each one would
    spin through a busy room for no reason.
    """
    try:
        await asyncio.wait_for(conn.wake.wait(), timeout=KEEPALIVE_INTERVAL_SECONDS)
        return True
    except TimeoutError:
        return False


async def _wait_for_work(
    bell: asyncio.Event,
    conn: AgentConnection,
    timeout: float = KEEPALIVE_INTERVAL_SECONDS,
) -> bool:
    """Wait for a new event or a change to the connection itself.

    Returns False when neither happened within `timeout`, so the caller can
    look again or write a comment to keep the socket warm.
    """
    waiters = [
        asyncio.ensure_future(bell.wait()),
        asyncio.ensure_future(conn.wake.wait()),
    ]
    try:
        done, _ = await asyncio.wait(
            waiters,
            timeout=timeout,
            return_when=asyncio.FIRST_COMPLETED,
        )
        return bool(done)
    finally:
        for waiter in waiters:
            waiter.cancel()
