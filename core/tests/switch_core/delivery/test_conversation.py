"""Following the conversation, against a real Postgres.

One test per branch of the decision tree, plus the edge cases that keep each
rule narrow. The rules read the room's history, so the history is real rows
written through `MessageStore`, with `sent_at` set to control the follow-up
window.
"""

from __future__ import annotations

import logging
from typing import Any

import pytest

from switch_core.addressing import owner_only_policy
from switch_core.bridges.agent.protocol.agent_connections import AgentConnectionRegistry
from switch_core.budgets import BudgetGuard
from switch_core.clients.actor import AgentActor
from switch_core.clients.admin_messages import (
    ADMIN_MARKER,
    AUTO_REPLY_FLAG,
    PLATFORM_MARKER,
    ROOM_SETTINGS_MARKER,
    SENDER_IS_APP_MARKER,
)
from switch_core.clients.agent_consumer import AgentConsumer
from switch_core.clients.room_meta import RoomMeta
from switch_core.db.stores.agent_session_store import AgentSessionStore
from switch_core.db.stores.agent_store import AgentStore
from switch_core.db.stores.budget_store import BudgetStore
from switch_core.db.stores.client_store import ClientStore
from switch_core.db.stores.external_user_store import ExternalUserStore
from switch_core.db.stores.room_role_store import RoomRoleStore
from switch_core.db.stores.room_store import RoomStore
from switch_core.delivery.conversation import (
    ConversationMessage,
    ConversationRules,
    ConversationSettings,
    is_small_talk,
    may_follow,
)
from switch_core.transport import InboundMessage, RoomRef
from tests.switch_core.delivery.world import (
    CHANNEL,
    MAIN,
    THREAD,
    World,
    _resolver,
    _settings,
)

# ── Checks that need no database read ───────────────────────────────────────


def _msg(body: str = "what next?", **content: object) -> ConversationMessage:
    return ConversationMessage(
        event_id="$x",
        sender="@alice:test",
        body=body,
        content=content,
        thread_root_id=None,
    )


class TestMayFollow:
    def test_off_unless_the_flag_is_on(self) -> None:
        off = ConversationSettings(enabled=False, window_seconds=300)
        assert not may_follow(off, room_id="r", channel_type=None, message=_msg())

    def test_a_mention_always_wins(self) -> None:
        assert not may_follow(
            _settings(), room_id="r", channel_type=None, message=_msg("@bob what next?")
        )

    def test_direct_chats_already_reach_the_agent(self) -> None:
        assert not may_follow(
            _settings(), room_id="r", channel_type="direct", message=_msg()
        )

    @pytest.mark.parametrize(
        "marker", [ADMIN_MARKER, AUTO_REPLY_FLAG, PLATFORM_MARKER, SENDER_IS_APP_MARKER]
    )
    def test_never_for_switch_agents_or_apps(self, marker: str) -> None:
        assert not may_follow(
            _settings(), room_id="r", channel_type=None, message=_msg(**{marker: True})
        )


class TestSmallTalk:
    @pytest.mark.parametrize(
        "body", ["ok", "Thanks!", "thank you.", "+1", "👍", "lgtm", "  got it  "]
    )
    def test_acknowledgements(self, body: str) -> None:
        assert is_small_talk(body)

    @pytest.mark.parametrize(
        "body", ["why?", "thanks, and what about the tests?", "ok so what next"]
    )
    def test_real_questions(self, body: str) -> None:
        assert not is_small_talk(body)


# ── Who sent it ─────────────────────────────────────────────────────────────


class TestOnlyPeople:
    async def test_a_message_from_an_agent_reaches_nobody(self, world: World) -> None:
        answer = await world.post("helper", "Here you go", at=0)
        await world.post("reviewer", "a reply", at=5, thread=answer)
        reply = await world.post("reviewer", "and another", at=6, thread=answer)

        decision = await world.decide("helper", reply)

        assert decision.route is None
        assert decision.reason == "not sent by a person"


# ── Rule 1: thread follow-ups ───────────────────────────────────────────────


class TestThreadFollowUp:
    async def test_reply_under_the_agents_answer(self, world: World) -> None:
        answer = await world.post("helper", "It starts the stack", at=0)
        reply = await world.post(
            "alice", "why two database roles?", at=30, thread=answer
        )

        assert await world.route("helper", reply) == THREAD
        assert await world.route("reviewer", reply) is None

    async def test_reply_in_a_thread_the_agent_replied_in(self, world: World) -> None:
        root = await world.post("bob", "deploy is red", at=0)
        await world.post("helper", "looking", at=10, thread=root)
        reply = await world.post("alice", "any luck?", at=60, thread=root)

        assert await world.route("helper", reply) == THREAD

    async def test_reply_under_a_question_that_mentioned_the_agent(
        self, world: World
    ) -> None:
        # The agent answered at the top of the channel, not in the thread.
        question = await world.post("alice", "@helper what does just up do?", at=0)
        await world.post("helper", "It starts the stack", at=10)
        reply = await world.post("alice", "and why?", at=60, thread=question)

        decision = await world.decide("helper", reply)
        assert decision.route == THREAD
        assert (
            decision.reason == "an earlier message in this thread addressed the agent"
        )

    async def test_a_mention_by_alias_counts(self, world: World) -> None:
        async with world.session_factory() as session:
            await RoomStore().set_alias(
                session, world.room_id, world.agents["helper"].id, "h"
            )
            await session.commit()
        question = await world.post("alice", "@h can you check?", at=0)
        reply = await world.post("alice", "the tests too", at=60, thread=question)

        assert await world.route("helper", reply) == THREAD

    async def test_an_automatic_notice_is_not_taking_part(self, world: World) -> None:
        root = await world.post("bob", "anyone around?", at=0)
        await world.post(
            "helper",
            "Starting a session…",
            at=1,
            thread=root,
            **{AUTO_REPLY_FLAG: True},
        )
        reply = await world.post("alice", "hello?", at=60, thread=root)

        decision = await world.decide("helper", reply)
        assert decision.route is None
        assert decision.reason == "the agent is not taking part in this thread"

    async def test_a_thread_between_people_reaches_nobody(self, world: World) -> None:
        root = await world.post("bob", "lunch at 1?", at=0)
        reply = await world.post(
            "alice", "sounds like a plan, see you there", at=30, thread=root
        )

        assert await world.route("helper", reply) is None
        assert await world.route("reviewer", reply) is None

    async def test_two_agents_taking_part_both_get_it(self, world: World) -> None:
        root = await world.post("alice", "@helper @reviewer thoughts?", at=0)
        await world.post("helper", "looks fine", at=10, thread=root)
        await world.post("reviewer", "one nit", at=20, thread=root)
        reply = await world.post("alice", "which nit?", at=60, thread=root)

        assert await world.route("helper", reply) == THREAD
        assert await world.route("reviewer", reply) == THREAD

    async def test_small_talk_in_a_thread_reaches_nobody(self, world: World) -> None:
        answer = await world.post("helper", "Done", at=0)
        reply = await world.post("alice", "thanks!", at=30, thread=answer)

        decision = await world.decide("helper", reply)
        assert decision.route is None
        assert decision.reason == "small talk"

    async def test_no_time_limit_in_a_thread(self, world: World) -> None:
        answer = await world.post("helper", "Done", at=0)
        reply = await world.post("alice", "one more question", at=86_400, thread=answer)

        assert await world.route("helper", reply) == THREAD


# ── Rule 2: channel follow-ups ──────────────────────────────────────────────


class TestChannelFollowUp:
    async def test_the_next_message_after_an_answer(self, world: World) -> None:
        await world.post("alice", "@helper what does just up do?", at=0)
        await world.post("helper", "It starts the stack", at=20)
        follow_up = await world.post("alice", "and what does just down do?", at=60)

        decision = await world.decide("helper", follow_up)
        assert decision.route == CHANNEL
        assert decision.reason == "continues an exchange the agent has just answered"
        assert await world.route("reviewer", follow_up) is None

    async def test_a_longer_back_and_forth(self, world: World) -> None:
        await world.post("alice", "@helper first", at=0)
        await world.post("helper", "answer 1", at=20)
        await world.post("alice", "second", at=60)
        await world.post("helper", "answer 2", at=120)
        third = await world.post("alice", "third", at=200)

        assert await world.route("helper", third) == CHANNEL

    async def test_a_burst_ends_once_the_answer_is_too_old(self, world: World) -> None:
        # Each gap is short, but the agent's answer is more than the window ago.
        await world.post("alice", "@helper first", at=0)
        await world.post("helper", "answer", at=20)
        await world.post("alice", "second", at=200)
        late = await world.post("alice", "third", at=20 + 301)

        decision = await world.decide("helper", late)
        assert decision.route is None
        assert decision.reason == "too long since the agent's last answer"

    async def test_two_quick_messages_in_a_row(self, world: World) -> None:
        await world.post("alice", "@helper first", at=0)
        await world.post("helper", "answer", at=20)
        await world.post("alice", "second", at=40)
        burst = await world.post("alice", "oh and also this", at=45)

        assert await world.route("helper", burst) == CHANNEL

    async def test_ends_when_someone_else_posts(self, world: World) -> None:
        await world.post("alice", "@helper first", at=0)
        await world.post("helper", "answer", at=20)
        await world.post("bob", "unrelated chat", at=30)
        follow_up = await world.post("alice", "and then?", at=60)

        decision = await world.decide("helper", follow_up)
        assert decision.route is None
        assert decision.reason == "someone else posted after the agent's last answer"

    async def test_ends_when_another_agent_posts(self, world: World) -> None:
        await world.post("alice", "@helper first", at=0)
        await world.post("helper", "answer", at=20)
        await world.post("reviewer", "status update", at=30)
        follow_up = await world.post("alice", "and then?", at=60)

        assert (await world.decide("helper", follow_up)).reason == (
            "someone else posted after the agent's last answer"
        )

    async def test_ends_after_the_window(self, world: World) -> None:
        await world.post("alice", "@helper first", at=0)
        await world.post("helper", "answer", at=20)
        late = await world.post("alice", "and then?", at=20 + 301)

        decision = await world.decide("helper", late)
        assert decision.route is None
        assert decision.reason == "too long since the last message"

    async def test_just_inside_the_window(self, world: World) -> None:
        await world.post("alice", "@helper first", at=0)
        await world.post("helper", "answer", at=20)
        on_time = await world.post("alice", "and then?", at=20 + 300)

        assert await world.route("helper", on_time) == CHANNEL

    async def test_not_before_the_agent_has_answered(self, world: World) -> None:
        await world.post("alice", "@helper first", at=0)
        await world.post(
            "helper", "Starting a session…", at=1, **{AUTO_REPLY_FLAG: True}
        )
        early = await world.post("alice", "are you there?", at=10)

        decision = await world.decide("helper", early)
        assert decision.route is None
        assert decision.reason == "the agent has not answered yet"

    async def test_switch_notices_do_not_break_the_exchange(self, world: World) -> None:
        await world.post("alice", "@helper first", at=0)
        await world.post(
            "helper", "Starting a session…", at=1, **{AUTO_REPLY_FLAG: True}
        )
        await world.post("helper", "answer", at=30)
        await world.post(
            "admin", "Added someone to this room", at=40, **{ADMIN_MARKER: {}}
        )
        follow_up = await world.post("alice", "and then?", at=60)

        assert await world.route("helper", follow_up) == CHANNEL

    async def test_someone_else_cannot_pick_up_the_exchange(self, world: World) -> None:
        await world.post("alice", "@helper first", at=0)
        await world.post("helper", "answer", at=20)
        bobs = await world.post("bob", "what about me?", at=40)

        assert await world.route("helper", bobs) is None

    async def test_thanks_does_not_wake_the_agent(self, world: World) -> None:
        await world.post("alice", "@helper first", at=0)
        await world.post("helper", "answer", at=20)
        thanks = await world.post("alice", "thanks!", at=30)

        assert (await world.decide("helper", thanks)).reason == "small talk"

    async def test_no_exchange_at_all(self, world: World) -> None:
        await world.post("bob", "morning all", at=0)
        await world.post("alice", "morning", at=10)
        question = await world.post(
            "alice", "anyone know why the deploy failed?", at=20
        )

        decision = await world.decide("helper", question)
        assert decision.route is None
        assert decision.reason == "no recent exchange with this agent"
        assert await world.route("reviewer", question) is None

    async def test_thread_replies_do_not_count_in_the_channel(
        self, world: World
    ) -> None:
        # Bob talking in a thread does not end Alice's exchange in the channel.
        root = await world.post("bob", "lunch?", at=0)
        await world.post("alice", "@helper first", at=10)
        await world.post("helper", "answer", at=20)
        await world.post("bob", "1pm?", at=30, thread=root)
        follow_up = await world.post("alice", "and then?", at=40)

        assert await world.route("helper", follow_up) == CHANNEL


# ── Rule 3: main-agent rooms ────────────────────────────────────────────────


class TestMainAgent:
    async def test_every_message_reaches_the_main_agent(self, world: World) -> None:
        await world.assign("helper")
        question = await world.post("bob", "anyone know why the deploy failed?", at=0)

        decision = await world.decide("helper", question)
        assert decision.route == MAIN
        assert await world.route("reviewer", question) is None

    async def test_including_small_talk(self, world: World) -> None:
        await world.assign("helper")
        thanks = await world.post("alice", "thanks", at=0)

        assert await world.route("helper", thanks) == MAIN

    async def test_a_follow_up_is_named_as_such(self, world: World) -> None:
        await world.assign("helper")
        answer = await world.post("helper", "Done", at=0)
        reply = await world.post("alice", "why?", at=30, thread=answer)

        assert await world.route("helper", reply) == THREAD

    async def test_unassigned_goes_back_to_follow_ups_only(self, world: World) -> None:
        await world.assign("helper")
        await world.assign(None)
        question = await world.post("bob", "anyone know why the deploy failed?", at=0)

        assert await world.route("helper", question) is None

    async def test_leaving_the_room_clears_it(self, world: World) -> None:
        await world.assign("helper")
        async with world.session_factory() as session:
            await RoomStore().remove_agents(
                session, world.room_id, [world.agents["helper"].id]
            )
            await session.commit()
            assert await RoomStore().main_agent_id(session, world.room_id) is None


# ── A room that turned follow-ups off ───────────────────────────────────────


class TestFollowUpsOff:
    async def _off(self, world: World) -> None:
        async with world.session_factory() as session:
            await RoomStore().set_follow_ups_enabled(session, world.room_id, False)
            await session.commit()

    async def test_no_thread_follow_up(self, world: World) -> None:
        await self._off(world)
        answer = await world.post("helper", "It starts the stack", at=0)
        reply = await world.post(
            "alice", "why two database roles?", at=30, thread=answer
        )

        decision = await world.decide("helper", reply)
        assert decision.route is None
        assert decision.reason == "follow-ups are switched off in this room"

    async def test_no_channel_follow_up(self, world: World) -> None:
        await self._off(world)
        await world.post("alice", "@helper first", at=0)
        await world.post("helper", "answer", at=20)
        follow_up = await world.post("alice", "and then?", at=40)

        assert (await world.decide("helper", follow_up)).reason == (
            "follow-ups are switched off in this room"
        )

    async def test_the_main_agent_still_gets_everything(self, world: World) -> None:
        await self._off(world)
        await world.assign("helper")
        question = await world.post("bob", "anyone know why the deploy failed?", at=0)

        assert await world.route("helper", question) == MAIN

    async def test_back_on_restores_follow_ups(self, world: World) -> None:
        await self._off(world)
        async with world.session_factory() as session:
            await RoomStore().set_follow_ups_enabled(session, world.room_id, True)
            await session.commit()
        answer = await world.post("helper", "It starts the stack", at=0)
        reply = await world.post("alice", "why?", at=30, thread=answer)

        assert await world.route("helper", reply) == THREAD


# ── Through the agent's client: permissions and the log line ────────────────


def _consumer(
    world: World, agent_name: str, settings: ConversationSettings
) -> AgentConsumer:
    agent = world.agents[agent_name]
    actor = object.__new__(AgentActor)
    actor.session_factory = world.session_factory  # type: ignore[assignment]
    actor.client_store = ClientStore()
    actor.transport_user_id = world.mxid(agent_name)
    actor.client_id = agent.client_id
    actor.tenant_id = agent.tenant_id
    actor._agent = agent
    consumer = object.__new__(AgentConsumer)
    consumer.actor = actor
    consumer._agent_store = AgentStore()
    consumer._room_store = RoomStore()
    consumer._room_role_store = RoomRoleStore()
    consumer._agent_session_store = AgentSessionStore()
    consumer._external_user_store = ExternalUserStore()
    consumer._connections = AgentConnectionRegistry()
    consumer._addressing = _resolver()
    consumer._conversation = ConversationRules(
        settings=settings,
        addressing=consumer._addressing,
        message_store=world.store,
        room_store=RoomStore(),
    )
    consumer._budget_guard = BudgetGuard(BudgetStore())
    consumer._last_top_level_post_ms = {}
    consumer._room_meta = {}
    return consumer


async def _inbound(world: World, event_id: str, timestamp: int = 0) -> InboundMessage:
    async with world.session_factory() as session:
        row = await world.store.get_by_transport_event_id(session, event_id)
    assert row is not None
    return InboundMessage(
        room_id="!transport:test",
        event_id=event_id,
        sender=row.sender_id,
        timestamp=timestamp,
        content=dict(row.content),
        body=row.body or "",
        thread_root_id=row.thread_root_event_id,
    )


def _meta(
    world: World, *, follow_ups_enabled: bool = True, main_agent_id: str | None = None
) -> RoomMeta:
    return RoomMeta(
        room_id=world.room_id,
        name="room",
        channel_type="channel_public",
        follow_ups_enabled=follow_ups_enabled,
        main_agent_id=main_agent_id,
    )


class TestThroughTheClient:
    async def test_delivered_and_logged(
        self, world: World, caplog: pytest.LogCaptureFixture
    ) -> None:
        answer = await world.post("helper", "It starts the stack", at=0)
        reply = await world.post("alice", "why?", at=30, thread=answer)
        consumer = _consumer(world, "helper", _settings())

        with caplog.at_level(logging.INFO, logger="switch_core.clients.agent_consumer"):
            delivered = await consumer._follow_the_conversation(
                await _inbound(world, reply), _meta(world)
            )

        assert delivered
        assert (
            f"message={reply} agent=helper route=thread_follow_up outcome=delivered"
            in caplog.text
        )

    async def test_nobody_is_logged_with_the_reason(
        self, world: World, caplog: pytest.LogCaptureFixture
    ) -> None:
        question = await world.post("alice", "anyone know why the deploy failed?", at=0)
        consumer = _consumer(world, "helper", _settings())
        # The agent posted here a moment ago, so the history is worth reading.
        consumer._last_top_level_post_ms["!transport:test"] = 0

        with caplog.at_level(logging.INFO, logger="switch_core.clients.agent_consumer"):
            delivered = await consumer._follow_the_conversation(
                await _inbound(world, question), _meta(world)
            )

        assert not delivered
        assert "route=none outcome=nobody reason=no recent exchange" in caplog.text

    async def test_dropped_quietly_when_the_sender_may_not_instruct_the_agent(
        self, world: World, caplog: pytest.LogCaptureFixture
    ) -> None:
        # helper answers only its owner, who has claimed alice's account, not bob's.
        async with world.session_factory() as session:
            agent = await AgentStore().get(session, world.agents["helper"].id)
            assert agent is not None
            agent.addressing_policy = owner_only_policy([]).model_dump(mode="json")
            await session.commit()
        answer = await world.post("helper", "It starts the stack", at=0)
        from_bob = await world.post("bob", "why?", at=30, thread=answer)
        from_alice = await world.post("alice", "why?", at=40, thread=answer)
        consumer = _consumer(world, "helper", _settings())

        with caplog.at_level(logging.INFO, logger="switch_core.clients.agent_consumer"):
            bob_delivered = await consumer._follow_the_conversation(
                await _inbound(world, from_bob), _meta(world)
            )
            alice_delivered = await consumer._follow_the_conversation(
                await _inbound(world, from_alice), _meta(world)
            )

        assert not bob_delivered
        assert alice_delivered
        assert (
            f"message={from_bob} agent=helper route=thread_follow_up "
            "outcome=dropped_not_permitted" in caplog.text
        )

    async def test_no_rule_runs_while_the_flag_is_off(self, world: World) -> None:
        answer = await world.post("helper", "It starts the stack", at=0)
        reply = await world.post("alice", "why?", at=30, thread=answer)
        opened: list[object] = []

        def counting() -> Any:
            opened.append(object())
            return world.session_factory()

        consumer = _consumer(
            world,
            "helper",
            ConversationSettings(enabled=False, window_seconds=300),
        )
        consumer.actor.session_factory = counting  # type: ignore[assignment]

        delivered = await consumer._follow_the_conversation(
            await _inbound(world, reply), _meta(world)
        )

        assert not delivered
        assert opened == []


# ── The free check that runs before any history is read ─────────────────────


class TestTheFreeCheck:
    """`_might_follow` keeps busy rooms free: no session unless a rule could
    apply. It may only say no where the rules would also say no."""

    def _counting(self, world: World, consumer: AgentConsumer) -> list[object]:
        opened: list[object] = []

        def counting() -> Any:
            opened.append(object())
            return world.session_factory()

        consumer.actor.session_factory = counting  # type: ignore[assignment]
        return opened

    async def test_chatter_with_no_recent_post_costs_nothing(
        self, world: World
    ) -> None:
        question = await world.post("bob", "lunch at 1?", at=0)
        consumer = _consumer(world, "helper", _settings())
        opened = self._counting(world, consumer)

        delivered = await consumer._follow_the_conversation(
            await _inbound(world, question, timestamp=1_000_000), _meta(world)
        )

        assert not delivered
        assert opened == []

    async def test_a_recent_post_lets_a_channel_follow_up_through(
        self, world: World
    ) -> None:
        await world.post("alice", "@helper first", at=0)
        await world.post("helper", "answer", at=20)
        follow_up = await world.post("alice", "and then?", at=40)
        consumer = _consumer(world, "helper", _settings())
        consumer._last_top_level_post_ms["!transport:test"] = 1_000_000

        delivered = await consumer._follow_the_conversation(
            await _inbound(world, follow_up, timestamp=1_020_000), _meta(world)
        )

        assert delivered

    async def test_an_old_post_does_not(self, world: World) -> None:
        question = await world.post("alice", "and then?", at=0)
        consumer = _consumer(world, "helper", _settings())
        consumer._last_top_level_post_ms["!transport:test"] = 1_000_000
        opened = self._counting(world, consumer)

        await consumer._follow_the_conversation(
            await _inbound(world, question, timestamp=1_000_000 + 301_000),
            _meta(world),
        )

        assert opened == []

    async def test_a_room_with_follow_ups_off_costs_nothing(self, world: World) -> None:
        answer = await world.post("helper", "Done", at=0)
        reply = await world.post("alice", "why?", at=30, thread=answer)
        consumer = _consumer(world, "helper", _settings())
        opened = self._counting(world, consumer)

        delivered = await consumer._follow_the_conversation(
            await _inbound(world, reply), _meta(world, follow_ups_enabled=False)
        )

        assert not delivered
        assert opened == []

    async def test_the_main_agent_always_checks(self, world: World) -> None:
        await world.assign("helper")
        question = await world.post("bob", "anyone know why the deploy failed?", at=0)
        consumer = _consumer(world, "helper", _settings())

        delivered = await consumer._follow_the_conversation(
            await _inbound(world, question),
            _meta(world, main_agent_id=world.agents["helper"].id),
        )

        assert delivered

    def test_its_own_top_level_posts_are_remembered(self, world: World) -> None:
        consumer = _consumer(world, "helper", _settings())
        consumer.actor.room_join_times = {}  # type: ignore[attr-defined]
        consumer._startup_ts = 0
        room = RoomRef(room_id="!transport:test")

        def own(timestamp: int, **kwargs: Any) -> InboundMessage:
            return InboundMessage(
                room_id="!transport:test",
                event_id=f"$own{timestamp}",
                sender=world.mxid("helper"),
                timestamp=timestamp,
                body="hi",
                **kwargs,
            )

        consumer._should_ignore(room, own(5))
        consumer._should_ignore(room, own(6, thread_root_id="$root"))
        consumer._should_ignore(room, own(7, content={AUTO_REPLY_FLAG: True}))

        assert consumer._last_top_level_post_ms == {"!transport:test": 5}

    def test_a_settings_notice_updates_the_cached_room(self, world: World) -> None:
        consumer = _consumer(world, "helper", _settings())
        room = RoomRef(room_id="!transport:test")
        meta = _meta(world)
        notice = InboundMessage(
            room_id="!transport:test",
            event_id="$notice",
            sender="@switch-admin:test",
            timestamp=1,
            body="From now on…",
            content={
                ADMIN_MARKER: {"type": "command_result"},
                ROOM_SETTINGS_MARKER: {"follow_ups": False, "main_agent_id": "a-1"},
            },
        )

        consumer._apply_room_settings_notice(room, meta, notice)

        cached = consumer._room_meta["!transport:test"]
        assert cached is not None
        assert not cached.follow_ups_enabled
        assert cached.main_agent_id == "a-1"

    def test_a_settings_marker_without_the_admin_marker_is_ignored(
        self, world: World
    ) -> None:
        consumer = _consumer(world, "helper", _settings())
        forged = InboundMessage(
            room_id="!transport:test",
            event_id="$forged",
            sender="@someone:test",
            timestamp=1,
            body="hi",
            content={ROOM_SETTINGS_MARKER: {"follow_ups": False, "main_agent_id": "x"}},
        )

        consumer._apply_room_settings_notice(
            RoomRef(room_id="!transport:test"), _meta(world), forged
        )

        assert consumer._room_meta == {}
