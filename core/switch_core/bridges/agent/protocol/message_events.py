"""The agent event a room row becomes, built one way wherever it is built.

A message reaches an agent by two roads: the agent's consumer, when the row is
delivered live and decided to be for the agent, and the room's log, read later
for a reader that wants the rest of the conversation too. Both build the event
here, so an agent cannot tell which road a message took.
"""

from __future__ import annotations

from typing import TYPE_CHECKING

from switch_core.bridges.agent.protocol.types import (
    AgentEvent,
    AttachmentRef,
    MessagePayload,
    RoomJoinPayload,
)
from switch_core.clients.admin_messages import PLATFORM_MARKER, platform_on_behalf_of

if TYPE_CHECKING:
    from switch_core.transport.types import InboundMedia, InboundMessage


def attachment_ref(event: InboundMedia) -> AttachmentRef:
    """The file a media event carries. With a caption, body is the caption and
    the real filename is in `filename`; without one, body is the filename."""
    return AttachmentRef(
        filename=event.filename or event.body,
        mimetype=event.mimetype or "",
        size=event.size or 0,
        mxc=event.uri,
        msgtype=event.msgtype,
    )


def message_event(
    *,
    room_id: str,
    bridge_id: str | None,
    channel_type: str | None,
    event: InboundMessage,
    addressed: bool,
    sender_name: str,
    body: str,
    thread_id: str | None,
    attachments: list[AttachmentRef] | None = None,
) -> AgentEvent:
    """A message (with its files, when it has any) as the agent receives it.

    A message a platform posted for a person is from that person as far as the
    agent is concerned: it answers whom the platform spoke for, not the client
    that carried it.
    """
    sender_kind: str | None = None
    on_behalf_of: str | None = None
    if PLATFORM_MARKER in event.content:
        sender_kind = "platform"
        person = platform_on_behalf_of(event.content)
        if person is not None:
            on_behalf_of = person.name
            sender_name = person.name
    return AgentEvent(
        type="message",
        room_id=room_id,
        bridge_id=bridge_id,
        channel_type=channel_type,
        payload=MessagePayload(
            addressed=addressed,
            sender=event.sender,
            sender_name=sender_name,
            sender_kind=sender_kind,
            on_behalf_of=on_behalf_of,
            message_id=event.event_id,
            body=body,
            timestamp=event.timestamp,
            thread_id=thread_id,
            attachments=attachments or [],
        ),
    )


def room_join_event(
    *,
    room_id: str,
    bridge_id: str | None,
    channel_type: str | None,
    member: str,
    member_name: str,
    timestamp: int,
    listening: bool,
) -> AgentEvent:
    """Someone arriving in a room. `listening` says whether this agent is set to
    react to arrivals there; the event is the same either way."""
    return AgentEvent(
        type="room_join",
        room_id=room_id,
        bridge_id=bridge_id,
        channel_type=channel_type,
        payload=RoomJoinPayload(
            member=member,
            member_name=member_name,
            timestamp=timestamp,
            listening=listening,
        ),
    )
