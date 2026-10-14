"""Following the conversation: when a message that mentions nobody is for an agent.

Addressing (`delivery/addressing.py`) answers "did this message ask this agent
for something?" from the message alone: a name, an alias, a role, a direct
chat. A person in a conversation does not repeat a name on every message, so
three rules extend it, each decided from the room's history:

- **Thread follow-up.** A reply in a thread reaches the agents taking part in
  it: an agent that has posted there, or that an earlier message in the
  thread addressed.
- **Channel follow-up.** A top-level message reaches the agent the sender is
  in an unbroken exchange with: the sender addressed the agent, the agent has
  answered since, nobody else has posted in between, the agent's last answer
  is within the window, and no gap between messages is longer than it.
- **Main agent.** In a room whose main agent is set (`!assign-agent`), every
  message reaches it.

A room can turn the two follow-up rules off with `!follow-ups off`; the main
agent rule is separate and unaffected. Both settings live in the room's
`metadata` (`db/stores/room_store.py`).

The rules only ever consider a person's text message that has no `@` in it
at all: a mention always wins, and a message from an agent, an app or Switch
itself never reaches anyone by these rules, so agents cannot set each other
off. Permissions are not decided here; the caller applies the agent's policy
afterwards, as it does for a mention.

Every evaluation is logged at INFO with its outcome and the reason, so each
route can be followed in the server's log.
"""

from __future__ import annotations

import logging
import re
from collections.abc import Mapping
from dataclasses import dataclass
from enum import StrEnum
from typing import TYPE_CHECKING

from switch_core.clients.admin_messages import (
    ADMIN_MARKER,
    AUTO_REPLY_FLAG,
    PLATFORM_MARKER,
    SENDER_IS_APP_MARKER,
)
from switch_core.clients.mentions import NAME_CHAR
from switch_core.db.stores.room_store import follow_ups_enabled_in, main_agent_in
from switch_core.delivery.addressing import IncomingMessage

if TYPE_CHECKING:
    from sqlalchemy.ext.asyncio import AsyncSession

    from switch_core.config import SwitchConfig
    from switch_core.db.models import Agent, Message
    from switch_core.db.stores.message_store import MessageStore
    from switch_core.db.stores.room_store import RoomStore
    from switch_core.delivery.addressing import AddressingResolver

logger = logging.getLogger(__name__)

# How many messages of a thread that mention someone are read when looking for
# one that addressed the agent, oldest first so the thread's root always counts.
THREAD_MENTION_LOOKBACK = 200

# How many of the channel's earlier top-level messages one walk reads. An
# exchange longer than this still continues: see `_channel_follow_up`.
CHANNEL_LOOKBACK = 20

# Thanks and praise: they close an exchange rather than continue it, so they
# never wake an agent through a follow-up. Answers are deliberately absent:
# "yes", "ok", "+1" or a thumbs-up may be the reply to an agent's question.
_SMALL_TALK = frozenset(
    {
        "thanks",
        "thank you",
        "thanks a lot",
        "thank you very much",
        "many thanks",
        "thx",
        "ty",
        "cheers",
        "great",
        "nice",
        "cool",
        "perfect",
        "awesome",
        "brilliant",
    }
)

_TRAILING_PUNCTUATION = re.compile(r"[\s.!?,;:]+$")

# A mention-shaped token: an `@` that starts a word, followed by name
# characters. An email address (`ops@example.com`) is not one.
_MENTION = re.compile(rf"(?<!{NAME_CHAR})@{NAME_CHAR}")


def is_small_talk(body: str) -> bool:
    """True for thanks or praise ("thanks!", "great"), which ends an exchange
    rather than continuing it."""
    return _TRAILING_PUNCTUATION.sub("", body.strip().lower()) in _SMALL_TALK


def mentions_anyone(body: str) -> bool:
    """Whether the text @-mentions anyone, by the same token rule mentions use.
    A mention always wins, so the rules stand aside."""
    return _MENTION.search(body) is not None


# The reason given when a thread reply reaches an agent that is not taking part
# in the thread. Agents' clients remember threads that answered this way, so
# later replies in them cost nothing.
NOT_TAKING_PART = "the agent is not taking part in this thread"


class ConversationRoute(StrEnum):
    THREAD_FOLLOW_UP = "thread_follow_up"
    CHANNEL_FOLLOW_UP = "channel_follow_up"
    MAIN_AGENT = "main_agent"


@dataclass(frozen=True)
class ConversationDecision:
    """Which rule, if any, delivers the message to the agent, and why."""

    route: ConversationRoute | None
    reason: str


@dataclass(frozen=True)
class ConversationSettings:
    """The deployment's settings for the rules, parsed once at startup."""

    enabled: bool
    window_seconds: int

    @classmethod
    def from_config(cls, config: SwitchConfig) -> ConversationSettings:
        return cls(
            enabled=config.follow_the_conversation_enabled,
            window_seconds=config.follow_the_conversation_window_seconds,
        )


@dataclass(frozen=True)
class ConversationMessage:
    """The message being decided: what addressing knows, plus where it sits."""

    event_id: str
    sender: str
    body: str
    content: Mapping[str, object]
    thread_root_id: str | None


def may_follow(
    settings: ConversationSettings,
    *,
    channel_type: str | None,
    message: ConversationMessage,
) -> bool:
    """The checks that need no database read. False means no rule can apply.

    Most room chatter is settled here, before a pool slot is taken.
    """
    if not settings.enabled:
        return False
    if channel_type == "direct":
        return False
    if mentions_anyone(message.body):
        return False
    content = message.content
    return not any(
        marker in content
        for marker in (
            ADMIN_MARKER,
            AUTO_REPLY_FLAG,
            PLATFORM_MARKER,
            SENDER_IS_APP_MARKER,
        )
    )


def _as_incoming(row: Message) -> IncomingMessage:
    return IncomingMessage(
        sender=row.sender_id,
        body=row.body or "",
        formatted_body=row.formatted_body,
        content=dict(row.content or {}),
    )


def _is_automatic(row: Message) -> bool:
    """Switch's own notices and the automatic replies an agent's client posts
    ("Starting a session…"): neither is anyone taking part."""
    content = row.content or {}
    return AUTO_REPLY_FLAG in content or ADMIN_MARKER in content


class ConversationRules:
    """Decides, for one agent, whether a message reaches it by following the
    conversation."""

    def __init__(
        self,
        *,
        settings: ConversationSettings,
        addressing: AddressingResolver,
        message_store: MessageStore,
        room_store: RoomStore,
    ) -> None:
        self._settings = settings
        self._addressing = addressing
        self._message_store = message_store
        self._room_store = room_store

    @property
    def settings(self) -> ConversationSettings:
        return self._settings

    async def decide(
        self,
        session: AsyncSession,
        *,
        agent: Agent,
        agent_user_id: str,
        room_id: str,
        channel_type: str | None,
        message: ConversationMessage,
    ) -> ConversationDecision:
        """Which rule delivers `message` to `agent`, if any.

        The caller has already checked `may_follow`.
        """
        principal = await self._addressing.resolve_sender(
            session, message.sender, message.content
        )
        if principal is None or principal.kind != "user":
            return ConversationDecision(None, "not sent by a person")

        current = await self._message_store.get_by_transport_event_id(
            session, message.event_id
        )
        if current is None:
            logger.warning(
                "Follow the conversation: message %s in room %s is not in the "
                "room's history yet, so no rule can be checked",
                message.event_id,
                room_id,
            )
            return ConversationDecision(None, "message not in history")

        room = await self._room_store.get(session, room_id)
        metadata = room.metadata_ if room is not None else None
        follow_up: ConversationDecision | None = None
        if not follow_ups_enabled_in(metadata):
            follow_up = ConversationDecision(
                None, "follow-ups are switched off in this room"
            )
        elif is_small_talk(message.body):
            follow_up = ConversationDecision(None, "small talk")
        elif message.thread_root_id is not None:
            follow_up = await self._thread_follow_up(
                session,
                agent=agent,
                agent_user_id=agent_user_id,
                room_id=room_id,
                channel_type=channel_type,
                thread_root_id=message.thread_root_id,
                before_seq=current.seq,
            )
        else:
            follow_up = await self._channel_follow_up(
                session,
                agent=agent,
                agent_user_id=agent_user_id,
                room_id=room_id,
                channel_type=channel_type,
                current=current,
            )
        if follow_up.route is not None:
            return follow_up
        if main_agent_in(metadata) == agent.id:
            return ConversationDecision(
                ConversationRoute.MAIN_AGENT, "the room's main agent"
            )
        return follow_up

    async def _addressed_agent(
        self,
        session: AsyncSession,
        *,
        agent: Agent,
        agent_user_id: str,
        room_id: str,
        channel_type: str | None,
        row: Message,
    ) -> bool:
        return await self._addressing.addresses(
            session,
            agent=agent,
            agent_user_id=agent_user_id,
            room_id=room_id,
            channel_type=channel_type,
            message=_as_incoming(row),
        )

    async def _thread_follow_up(
        self,
        session: AsyncSession,
        *,
        agent: Agent,
        agent_user_id: str,
        room_id: str,
        channel_type: str | None,
        thread_root_id: str,
        before_seq: int,
    ) -> ConversationDecision:
        if await self._message_store.posted_in_thread(
            session,
            room_id,
            thread_root_event_id=thread_root_id,
            sender_id=agent_user_id,
            before_seq=before_seq,
            excluding=(AUTO_REPLY_FLAG, ADMIN_MARKER),
        ):
            return ConversationDecision(
                ConversationRoute.THREAD_FOLLOW_UP, "the agent posted in this thread"
            )
        rows = await self._message_store.list_thread_mentions_before(
            session,
            room_id,
            thread_root_event_id=thread_root_id,
            before_seq=before_seq,
            limit=THREAD_MENTION_LOOKBACK,
        )
        for row in rows:
            if _is_automatic(row):
                continue
            if await self._addressed_agent(
                session,
                agent=agent,
                agent_user_id=agent_user_id,
                room_id=room_id,
                channel_type=channel_type,
                row=row,
            ):
                return ConversationDecision(
                    ConversationRoute.THREAD_FOLLOW_UP,
                    "an earlier message in this thread addressed the agent",
                )
        return ConversationDecision(None, NOT_TAKING_PART)

    async def _channel_follow_up(
        self,
        session: AsyncSession,
        *,
        agent: Agent,
        agent_user_id: str,
        room_id: str,
        channel_type: str | None,
        current: Message,
    ) -> ConversationDecision:
        """Walk back through the channel's top-level messages for an unbroken
        exchange between the sender and this agent.

        It must have started with the sender addressing the agent, unless it
        runs past the lookback: a run that long with only the two of them in
        it, each gap inside the window, can only be an exchange already under
        way. Anyone else posting ends it, and so does the sender turning to
        someone else with a mention.
        """
        rows = await self._message_store.list_top_level_before(
            session, room_id, before_seq=current.seq, limit=CHANNEL_LOOKBACK
        )
        later_sent_at = current.sent_at
        agent_answered = False
        for index, row in enumerate(rows):
            if _is_automatic(row):
                continue
            gap = (later_sent_at - row.sent_at).total_seconds()  # type: ignore[operator]
            if gap > self._settings.window_seconds:
                return ConversationDecision(None, "too long since the last message")
            later_sent_at = row.sent_at
            if row.sender_id == agent_user_id:
                if not agent_answered:
                    since_answer = (current.sent_at - row.sent_at).total_seconds()  # type: ignore[operator]
                    if since_answer > self._settings.window_seconds:
                        return ConversationDecision(
                            None, "too long since the agent's last answer"
                        )
                agent_answered = True
                continue
            if row.sender_id != current.sender_id:
                if agent_answered or any(
                    earlier.sender_id == agent_user_id and not _is_automatic(earlier)
                    for earlier in rows[index + 1 :]
                ):
                    return ConversationDecision(
                        None, "someone else posted after the agent's last answer"
                    )
                return ConversationDecision(None, "no recent exchange with this agent")
            if await self._addressed_agent(
                session,
                agent=agent,
                agent_user_id=agent_user_id,
                room_id=room_id,
                channel_type=channel_type,
                row=row,
            ):
                if agent_answered:
                    return ConversationDecision(
                        ConversationRoute.CHANNEL_FOLLOW_UP,
                        "continues an exchange the agent has just answered",
                    )
                return ConversationDecision(None, "the agent has not answered yet")
            if mentions_anyone(row.body or ""):
                return ConversationDecision(
                    None, "the sender turned to someone else since"
                )
        if agent_answered and len(rows) == CHANNEL_LOOKBACK:
            return ConversationDecision(
                ConversationRoute.CHANNEL_FOLLOW_UP,
                "continues a long exchange the agent is answering",
            )
        return ConversationDecision(None, "no recent exchange with this agent")
