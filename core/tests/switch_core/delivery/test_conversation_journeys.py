"""Every follow-the-conversation journey, end to end through the agents' clients.

The rule tests (`test_conversation.py`) call the decision directly. These send
each message the way live traffic arrives: written to the room's history, then
handed to every agent's client (`AgentConsumer`), which decides through its
real message handler and puts the result on its event stream. The assertion is
what each agent was told: whether the message is for it.

So if the rules are ever unhooked from the delivery path, or the free check in
front of them starts saying no where it should say yes, these fail. One test
per journey, mirroring the end-to-end demo.
"""

from __future__ import annotations

from collections import OrderedDict
from datetime import timedelta
from types import SimpleNamespace
from typing import Any

import pytest

from switch_core.addressing import owner_only_policy
from switch_core.bridges.agent.commands import (
    _cmd_assign_agent,
    _cmd_follow_ups,
    _cmd_unassign_agent,
)
from switch_core.bridges.agent.protocol.agent_connections import AgentConnectionRegistry
from switch_core.budgets import BudgetGuard
from switch_core.clients.actor import AgentActor
from switch_core.clients.admin_messages import (
    ADMIN_MARKER,
    AUTO_REPLY_FLAG,
    ROOM_SETTINGS_MARKER,
)
from switch_core.clients.agent_consumer import AgentConsumer
from switch_core.clients.room_meta import RoomMeta
from switch_core.db.stores.agent_session_store import AgentSessionStore
from switch_core.db.stores.agent_store import AgentStore
from switch_core.db.stores.budget_store import BudgetStore
from switch_core.db.stores.client_store import ClientStore
from switch_core.db.stores.collaboration_bridge_store import CollaborationBridgeStore
from switch_core.db.stores.external_user_store import ExternalUserStore
from switch_core.db.stores.room_role_store import RoomRoleStore
from switch_core.db.stores.room_store import RoomStore
from switch_core.delivery.conversation import ConversationRules, ConversationSettings
from switch_core.transport import InboundMessage, RoomRef
from tests.switch_core.delivery.world import T0, World, _resolver


class Journey:
    """A room with a live client for each agent, and a way to say things in it.

    `say` writes the message to the room's history and delivers it to every
    agent's client, exactly as the transport would, and returns which agents
    were told it is for them.
    """

    def __init__(self, world: World, settings: ConversationSettings) -> None:
        self.world = world
        self.settings = settings
        self.clients: dict[str, AgentConsumer] = {}
        self.told: dict[str, dict[str, bool]] = {}
        self.refusals: list[tuple[str, str]] = []
        self.transport_room_id = ""
        self.notices: list[str] = []

    async def start(self) -> Journey:
        async with self.world.session_factory() as session:
            room = await RoomStore().get(session, self.world.room_id)
            assert room is not None
            self.transport_room_id = room.transport_room_id
        for name in self.world.agents:
            self.clients[name] = self._client(name)
        return self

    def _client(self, name: str) -> AgentConsumer:
        agent = self.world.agents[name]
        actor = object.__new__(AgentActor)
        actor.session_factory = self.world.session_factory  # type: ignore[assignment]
        actor.client_store = ClientStore()
        actor.transport_user_id = self.world.mxid(name)
        actor.client_id = agent.client_id
        actor.tenant_id = agent.tenant_id
        actor._agent = agent
        actor.room_join_times = {}  # type: ignore[attr-defined]
        client = object.__new__(AgentConsumer)
        client.actor = actor
        client._startup_ts = 0
        client._agent_store = AgentStore()
        client._room_store = RoomStore()
        client._bridge_store = CollaborationBridgeStore()
        client._room_role_store = RoomRoleStore()
        client._agent_session_store = AgentSessionStore()
        client._external_user_store = ExternalUserStore()
        client._connections = AgentConnectionRegistry()
        client._addressing = _resolver()
        client._conversation = ConversationRules(
            settings=self.settings,
            addressing=client._addressing,
            message_store=self.world.store,
            room_store=client._room_store,
        )
        client._budget_guard = BudgetGuard(BudgetStore())
        client._message_telemetry = SimpleNamespace(  # type: ignore[assignment]
            agent_addressed=lambda **_k: None
        )
        client._frontend_base_url = None
        client._room_meta = {}
        client._attachment_groups = {}
        client._attachment_group_timers = {}
        client._last_top_level_post_ms = {}
        client._thread_membership = OrderedDict()
        client._cloud_waking_notices = set()

        async def _send_message(_room: str, body: str, **_kwargs: Any) -> str:
            self.refusals.append((name, body))
            return "$auto"

        actor.send_message = _send_message  # type: ignore[assignment, method-assign]

        def _enqueue(_agent_id: str, _room_id: str, event: Any) -> None:
            payload = event.payload
            self.told.setdefault(payload.message_id, {})[name] = payload.addressed

        client._event_buffer = SimpleNamespace(enqueue=_enqueue)  # type: ignore[assignment]
        return client

    async def say(
        self,
        who: str,
        body: str,
        *,
        at: float,
        thread: str | None = None,
        **content: object,
    ) -> dict[str, bool]:
        """Post as `who` and return, for each agent, whether it was told."""
        event_id = await self.world.post(who, body, at=at, thread=thread, **content)
        await self._deliver(event_id, who, body, at, thread, content)
        return {
            agent: told
            for agent, told in self.told.get(event_id, {}).items()
            if agent != who
        }

    async def post(
        self,
        who: str,
        body: str,
        *,
        at: float,
        thread: str | None = None,
        **content: object,
    ) -> str:
        """Post as `who` (an agent answering, say) and return the event id."""
        event_id = await self.world.post(who, body, at=at, thread=thread, **content)
        await self._deliver(event_id, who, body, at, thread, content)
        return event_id

    async def _deliver(
        self,
        event_id: str,
        who: str,
        body: str,
        at: float,
        thread: str | None,
        content: dict[str, object],
    ) -> None:
        sent_at = T0 + timedelta(seconds=at)
        event = InboundMessage(
            room_id=self.transport_room_id,
            event_id=event_id,
            sender=self.world.mxid(who),
            timestamp=int(sent_at.timestamp() * 1000),
            content={"msgtype": "m.text", "body": body, **content},
            body=body,
            sender_name=who,
            thread_root_id=thread,
        )
        room = RoomRef(room_id=self.transport_room_id)
        for client in self.clients.values():
            if client._should_ignore(room, event):
                continue
            await client.on_message(room, event)

    def reached(self, told: dict[str, bool]) -> set[str]:
        return {agent for agent, addressed in told.items() if addressed}

    # ── Room commands, run by the Switch app ────────────────────────────────

    def _host(self, at: float) -> SimpleNamespace:
        world = self.world

        async def _resolve_room_meta(_transport_room_id: str) -> RoomMeta:
            return RoomMeta(room_id=world.room_id, name="room")

        async def _reply_command(_room: str, body: str, **_kw: object) -> None:
            self.notices.append(body)
            await self.post(
                "admin", body, at=at, **{ADMIN_MARKER: {"type": "command_result"}}
            )

        async def _announce_room_settings(
            _room: str,
            body: str,
            *,
            thread_root_id: str | None,
            follow_ups_enabled: bool,
            main_agent_id: str | None,
        ) -> None:
            self.notices.append(body)
            await self.post(
                "admin",
                body,
                at=at,
                **{
                    ADMIN_MARKER: {"type": "command_result"},
                    ROOM_SETTINGS_MARKER: {
                        "follow_ups": follow_ups_enabled,
                        "main_agent_id": main_agent_id,
                    },
                },
            )

        return SimpleNamespace(
            session_factory=world.session_factory,
            _resolve_room_meta=_resolve_room_meta,
            reply_command=_reply_command,
            announce_room_settings=_announce_room_settings,
            _room_store=RoomStore(),
            _agent_store=AgentStore(),
            _room_role_store=RoomRoleStore(),
            _external_user_store=ExternalUserStore(),
            client_store=ClientStore(),
            _connections=SimpleNamespace(live_connection_ids=lambda: set()),
            _follow_the_conversation_enabled=True,
        )

    async def command(self, who: str, command: str, args: str, *, at: float) -> str:
        """Run a room command as `who`; return Switch's reply."""
        handlers = {
            "assign-agent": _cmd_assign_agent,
            "unassign-agent": _cmd_unassign_agent,
            "follow-ups": _cmd_follow_ups,
        }
        event = SimpleNamespace(
            command=command, args=args, thread_id=None, user_id=self.world.mxid(who)
        )
        await handlers[command](
            self._host(at),  # type: ignore[arg-type]
            RoomRef(room_id=self.transport_room_id),
            event,  # type: ignore[arg-type]
            False,
        )
        return self.notices[-1]


ON = ConversationSettings(enabled=True, window_seconds=300)


@pytest.fixture
async def room(world: World) -> Journey:
    return await Journey(world, ON).start()


async def _owner_only(world: World, agent: str) -> None:
    """Make `agent` answer only its owner, who has claimed alice, not bob."""
    async with world.session_factory() as session:
        row = await AgentStore().get(session, world.agents[agent].id)
        assert row is not None
        row.addressing_policy = owner_only_policy([]).model_dump(mode="json")
        await session.commit()


class TestJourneys:
    async def test_1_a_mention_works_as_today(self, room: Journey) -> None:
        told = await room.say("alice", "@helper what does just up do?", at=0)

        assert room.reached(told) == {"helper"}

    async def test_2_a_reply_in_the_agents_thread_reaches_it(
        self, room: Journey
    ) -> None:
        await room.say("alice", "@helper what does just up do?", at=0)
        answer = await room.post("helper", "It starts the stack", at=5)

        told = await room.say("alice", "why two database roles?", at=30, thread=answer)

        assert room.reached(told) == {"helper"}

    async def test_3_in_a_thread_a_mention_still_wins(self, room: Journey) -> None:
        answer = await room.post("helper", "It starts the stack", at=0)

        told = await room.say(
            "alice", "@reviewer what do you think?", at=30, thread=answer
        )

        assert room.reached(told) == {"reviewer"}

    async def test_4_two_agents_taking_part_both_get_it(self, room: Journey) -> None:
        answer = await room.post("helper", "It starts the stack", at=0)
        await room.say("alice", "@reviewer what do you think?", at=10, thread=answer)
        await room.post("reviewer", "One nit", at=20, thread=answer)

        told = await room.say("alice", "which nit?", at=30, thread=answer)

        assert room.reached(told) == {"helper", "reviewer"}

    async def test_5_thanks_wakes_nobody(self, room: Journey) -> None:
        answer = await room.post("helper", "Done", at=0)

        told = await room.say("alice", "thanks!", at=30, thread=answer)

        assert room.reached(told) == set()

    async def test_6_the_next_channel_message_reaches_the_agent(
        self, room: Journey
    ) -> None:
        await room.say("alice", "@helper what does just migrate do?", at=0)
        await room.post("helper", "It applies migrations", at=10)
        first = await room.say("alice", "and what does just down do?", at=40)
        await room.post("helper", "It stops the stack", at=50)
        second = await room.say("alice", "and just reset?", at=80)

        assert room.reached(first) == {"helper"}
        assert room.reached(second) == {"helper"}

    async def test_7_it_stops_when_someone_else_speaks(self, room: Journey) -> None:
        await room.say("alice", "@helper where is addressing decided?", at=0)
        await room.post("helper", "In delivery/addressing.py", at=10)
        bob = await room.say("bob", "lunch at 1 anyone?", at=20)
        told = await room.say("alice", "and which file has the tests?", at=30)

        assert room.reached(bob) == set()
        assert room.reached(told) == set()

    async def test_8_it_stops_after_the_window(self, room: Journey) -> None:
        await room.say("alice", "@helper what port does the gateway use?", at=0)
        await room.post("helper", "5173", at=10)

        told = await room.say("alice", "and the Mattermost port?", at=10 + 301)

        assert room.reached(told) == set()

    async def test_9_a_question_to_the_room_reaches_nobody(self, room: Journey) -> None:
        told = await room.say("bob", "anyone know why the deploy failed?", at=0)

        assert room.reached(told) == set()

    async def test_10_a_follow_up_from_someone_not_allowed_is_dropped_quietly(
        self, world: World, room: Journey
    ) -> None:
        await _owner_only(world, "helper")
        answer = await room.post("helper", "It starts the stack", at=0)

        from_bob = await room.say("bob", "hello? are you there?", at=30, thread=answer)
        from_alice = await room.say("alice", "why?", at=40, thread=answer)

        assert room.reached(from_bob) == set()
        assert room.reached(from_alice) == {"helper"}
        refusals = [body for agent, body in room.refusals if agent == "helper"]
        assert not any(
            "not permitted" in body or "only take" in body for body in refusals
        )

    async def test_11_after_assign_agent_every_message_reaches_it(
        self, room: Journey
    ) -> None:
        reply = await room.command("alice", "assign-agent", "@helper", at=0)
        question = await room.say("bob", "anyone know why the deploy failed?", at=10)
        chat = await room.say("alice", "morning all", at=20)

        assert reply.startswith("From now on, every message here goes to")
        assert room.reached(question) == {"helper"}
        assert room.reached(chat) == {"helper"}

    async def test_12_with_an_assigned_agent_a_mention_still_wins(
        self, room: Journey
    ) -> None:
        await room.command("alice", "assign-agent", "@helper", at=0)

        told = await room.say("alice", "@reviewer can you look at my PR?", at=10)

        assert room.reached(told) == {"reviewer"}

    async def test_13_follow_ups_off_then_on(self, room: Journey) -> None:
        answer = await room.post("helper", "It runs the tests", at=0)

        off = await room.command("alice", "follow-ups", "off", at=10)
        while_off = await room.say(
            "alice", "how long does it take?", at=20, thread=answer
        )
        on = await room.command("alice", "follow-ups", "on", at=30)
        while_on = await room.say(
            "alice", "which tests are slow?", at=40, thread=answer
        )

        assert "Follow-ups are **off**" in off
        assert room.reached(while_off) == set()
        assert "Follow-ups are **on**" in on
        assert room.reached(while_on) == {"helper"}

    async def test_14_unassign_and_a_refused_assign(
        self, world: World, room: Journey
    ) -> None:
        await room.command("alice", "assign-agent", "@helper", at=0)
        unassigned = await room.command("alice", "unassign-agent", "", at=10)
        question = await room.say("bob", "has anyone seen the build logs?", at=20)
        await _owner_only(world, "reviewer")
        refused = await room.command("bob", "assign-agent", "@reviewer", at=30)
        after = await room.say("bob", "can someone check the release notes?", at=40)

        assert "is no longer assigned" in unassigned
        assert room.reached(question) == set()
        assert refused.startswith("You can't assign")
        assert room.reached(after) == set()


class TestWithTheFlagOff:
    async def test_nothing_changes(self, world: World) -> None:
        room = await Journey(
            world, ConversationSettings(enabled=False, window_seconds=300)
        ).start()
        await room.say("alice", "@helper what does just migrate do?", at=0)
        answer = await room.post("helper", "It applies migrations", at=10)

        in_thread = await room.say("alice", "why?", at=20, thread=answer)
        in_channel = await room.say("alice", "and just down?", at=30)

        assert room.reached(in_thread) == set()
        assert room.reached(in_channel) == set()


class TestAgentsDoNotSetEachOtherOff:
    async def test_an_agent_reply_in_a_thread_reaches_no_other_agent(
        self, room: Journey
    ) -> None:
        answer = await room.post("helper", "It starts the stack", at=0)
        await room.say("alice", "@reviewer thoughts?", at=10, thread=answer)

        told = await room.say("reviewer", "Looks right to me", at=20, thread=answer)

        assert room.reached(told) == set()

    async def test_switchs_own_notices_reach_nobody(self, room: Journey) -> None:
        answer = await room.post("helper", "It starts the stack", at=0)

        told = await room.say(
            "helper",
            "Starting a session…",
            at=10,
            thread=answer,
            **{AUTO_REPLY_FLAG: True},
        )

        assert room.reached(told) == set()


class TestReviewFixesThroughTheClients:
    async def test_no_unavailable_notice_for_a_follow_up(self, room: Journey) -> None:
        # The agents here have no session. A mention gets the usual notice;
        # a follow-up is delivered without one.
        await room.say("alice", "@helper what does just up do?", at=0)
        notices_after_mention = len(room.refusals)
        assert notices_after_mention == 1  # the mention did get a notice
        answer = await room.post("helper", "It starts the stack", at=5)

        told = await room.say("alice", "why two database roles?", at=30, thread=answer)

        assert room.reached(told) == {"helper"}
        assert len(room.refusals) == notices_after_mention

    async def test_a_follow_up_with_an_email_address_in_it(self, room: Journey) -> None:
        answer = await room.post("helper", "Who should I send it to?", at=0)

        told = await room.say(
            "alice", "send it to ops@example.com", at=30, thread=answer
        )

        assert room.reached(told) == {"helper"}

    async def test_switching_agents_ends_the_exchange(self, room: Journey) -> None:
        await room.say("alice", "@helper do X", at=0)
        await room.post("helper", "Done X", at=10)
        await room.say("alice", "@reviewer check Y", at=20)

        told = await room.say("alice", "it's in PR 12", at=30)

        assert room.reached(told) == set()


class TestCommandsWhileTheFlagIsOff:
    async def test_they_say_so_and_change_nothing(self, world: World) -> None:
        room = await Journey(world, ON).start()
        host = room._host(at=0)
        host._follow_the_conversation_enabled = False
        replies: list[str] = []

        async def _reply_command(_room: str, body: str, **_kw: object) -> None:
            replies.append(body)

        host.reply_command = _reply_command
        for command, args in (
            ("assign-agent", "@helper"),
            ("follow-ups", "off"),
            ("unassign-agent", ""),
        ):
            event = SimpleNamespace(
                command=command, args=args, thread_id=None, user_id=world.mxid("alice")
            )
            handler = {
                "assign-agent": _cmd_assign_agent,
                "follow-ups": _cmd_follow_ups,
                "unassign-agent": _cmd_unassign_agent,
            }[command]
            await handler(host, RoomRef(room_id=room.transport_room_id), event, False)  # type: ignore[arg-type]

        assert len(replies) == 3
        assert all("isn't switched on for this Switch server" in r for r in replies)
        async with world.session_factory() as session:
            assert await RoomStore().main_agent_id(session, world.room_id) is None
            assert await RoomStore().follow_ups_enabled(session, world.room_id)
