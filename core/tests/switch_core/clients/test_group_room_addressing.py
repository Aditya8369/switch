"""Who a message is for once a room holds more than one agent.

A direct room addresses its agent with every message, but only while it is
the room's one agent: the channel type records how a room was made and is
never rewritten, so a direct room that gained a second agent is a group, and
a message, a file or a bare command there names its agents or is a note for
nobody. Public and private rooms never auto-address.

Real Postgres and real stores behind real `AgentConsumer`s; only the actor's
posting and the event buffer are recorded rather than sent.
"""

from __future__ import annotations

from types import SimpleNamespace
from typing import Any

from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.addressing import owner_only_policy
from switch_core.bridges.agent.protocol.agent_connections import AgentConnectionRegistry
from switch_core.bridges.agent.protocol.types import AgentEvent
from switch_core.budgets import BudgetGuard
from switch_core.chats import MEMBER_CLIENT_TYPE
from switch_core.clients.actor import AgentActor
from switch_core.clients.agent_consumer import AgentConsumer
from switch_core.clients.room_meta import RoomMeta
from switch_core.db.models import Agent, Client, Room, User
from switch_core.db.stores.agent_session_store import AgentSessionStore
from switch_core.db.stores.agent_store import AgentStore
from switch_core.db.stores.budget_store import BudgetStore
from switch_core.db.stores.client_store import ClientStore
from switch_core.db.stores.external_user_store import ExternalUserStore
from switch_core.db.stores.room_role_store import RoomRoleStore
from switch_core.db.stores.room_store import RoomStore
from switch_core.delivery.addressing import (
    ADDRESSING_DENIED_MESSAGE,
    AddressingResolver,
    named_agents,
)
from switch_core.events import CommandEvent
from switch_core.transport import InboundMedia, InboundMessage, RoomRef
from tests.switch_core.gateway.agent_route_harness import add_agent

TRANSPORT_ROOM_ID = "!group:test"
SLACK_SENDER = "@switch-slack-tess:test"


class _World(SimpleNamespace):
    room_id: str
    owner: User
    member: Client
    agents: dict[str, Agent]


async def _world(
    factory: async_sessionmaker[AsyncSession], *, names: list[str], channel_type: str
) -> _World:
    async with factory() as session:
        owner = User(name="owner", email="owner@example.com", role="user")
        other = User(name="other", email="other@example.com", role="user")
        session.add_all([owner, other])
        await session.flush()
        member = Client(
            transport_user_id=f"@switch-member-{other.id}:test",
            display_name="other",
            type=MEMBER_CLIENT_TYPE,
            user_id=other.id,
        )
        session.add(member)
        agents = {
            name: await add_agent(session, name=name, owner_id=owner.id)
            for name in names
        }
        room = Room(
            transport_room_id=TRANSPORT_ROOM_ID,
            name="room",
            description="",
            channel_type=channel_type,
        )
        session.add(room)
        await session.flush()
        await RoomStore().add_agents(session, room.id, [a.id for a in agents.values()])
        await session.commit()
        return _World(room_id=room.id, owner=owner, member=member, agents=agents)


def _consumer(
    factory: async_sessionmaker[AsyncSession],
    agent: Agent,
    room_id: str,
    channel_type: str,
) -> AgentConsumer:
    actor = object.__new__(AgentActor)
    actor.session_factory = factory
    actor.client_store = ClientStore()
    actor.transport_user_id = f"@{agent.name}:test"
    actor.client_id = agent.client_id
    actor.tenant_id = agent.tenant_id
    actor._agent = agent
    client = object.__new__(AgentConsumer)
    client.actor = actor
    client._agent_store = AgentStore()
    client._room_store = RoomStore()
    client._room_role_store = RoomRoleStore()
    client._agent_session_store = AgentSessionStore()
    client._external_user_store = ExternalUserStore()
    client._connections = AgentConnectionRegistry()
    client._addressing = AddressingResolver(
        room_store=client._room_store,
        room_role_store=client._room_role_store,
        client_store=client.client_store,
        agent_store=client._agent_store,
        external_user_store=client._external_user_store,
        live_connection_ids=client._connections.live_connection_ids,
    )
    client._budget_guard = BudgetGuard(BudgetStore())
    client._frontend_base_url = None
    client._room_meta = {
        TRANSPORT_ROOM_ID: RoomMeta(
            room_id=room_id, name="room", bridge_id=None, channel_type=channel_type
        )
    }
    client._attachment_groups = {}
    client._attachment_group_timers = {}
    client._waking_notice_revisions = {}
    client.sent = []  # type: ignore[attr-defined]
    client.enqueued = []  # type: ignore[attr-defined]

    async def _send_message(transport_room_id: str, body: str, **kwargs: Any) -> str:
        client.sent.append(body)  # type: ignore[attr-defined]
        return "$sent"

    def _enqueue(_agent_id: str, _room_id: str, event: AgentEvent) -> None:
        client.enqueued.append(event)  # type: ignore[attr-defined]

    actor.send_message = _send_message  # type: ignore[assignment, method-assign]
    client._event_buffer = SimpleNamespace(enqueue=_enqueue)  # type: ignore[assignment]
    return client


def _consumers(
    factory: async_sessionmaker[AsyncSession], world: _World, channel_type: str
) -> dict[str, AgentConsumer]:
    return {
        name: _consumer(factory, agent, world.room_id, channel_type)
        for name, agent in world.agents.items()
    }


def _message(body: str, sender: str = SLACK_SENDER) -> InboundMessage:
    return InboundMessage(
        room_id=TRANSPORT_ROOM_ID,
        event_id="$m",
        sender=sender,
        timestamp=0,
        content={"body": body, "sender_name": "tess"},
        body=body,
        sender_name="tess",
    )


def _media(caption: str) -> InboundMedia:
    return InboundMedia(
        room_id=TRANSPORT_ROOM_ID,
        event_id="$f",
        sender=SLACK_SENDER,
        timestamp=0,
        content={"body": caption, "sender_name": "tess"},
        body=caption,
        sender_name="tess",
        uri="switch-media://f",
        filename="plan.png",
        mimetype="image/png",
        size=3,
        msgtype="m.image",
    )


def _command(command: str, args: str = "") -> CommandEvent:
    return CommandEvent(
        command=command,
        args=args,
        user_id=SLACK_SENDER,
        user_name="tess",
        message_id="$c",
        thread_id="$c",
    )


def _addressed(consumer: AgentConsumer) -> list[bool]:
    return [event.payload.addressed for event in consumer.enqueued]  # type: ignore[attr-defined, union-attr]


async def _deliver(consumers: dict[str, AgentConsumer], body: str, **kw: Any) -> None:
    for consumer in consumers.values():
        await consumer.on_message(
            RoomRef(room_id=TRANSPORT_ROOM_ID), _message(body, **kw)
        )


async def test_a_direct_room_with_two_agents_addresses_nobody_unnamed(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    world = await _world(
        session_factory, names=["alpha", "beta"], channel_type="direct"
    )
    consumers = _consumers(session_factory, world, "direct")

    await _deliver(consumers, "anyone around?")

    assert {name: _addressed(c) for name, c in consumers.items()} == {
        "alpha": [False],
        "beta": [False],
    }


async def test_a_direct_room_with_two_agents_addresses_only_the_named_one(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    world = await _world(
        session_factory, names=["alpha", "beta"], channel_type="direct"
    )
    consumers = _consumers(session_factory, world, "direct")

    await _deliver(consumers, "@beta take this one")

    assert {name: _addressed(c) for name, c in consumers.items()} == {
        "alpha": [False],
        "beta": [True],
    }


async def test_a_file_in_a_direct_room_with_two_agents_addresses_nobody_unnamed(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    world = await _world(
        session_factory, names=["alpha", "beta"], channel_type="direct"
    )
    consumers = _consumers(session_factory, world, "direct")

    for consumer in consumers.values():
        await consumer.on_media(RoomRef(room_id=TRANSPORT_ROOM_ID), _media("see this"))

    assert {name: _addressed(c) for name, c in consumers.items()} == {
        "alpha": [False],
        "beta": [False],
    }


async def test_a_bare_reset_in_a_direct_room_with_two_agents_resets_nobody(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    world = await _world(
        session_factory, names=["alpha", "beta"], channel_type="direct"
    )
    consumers = _consumers(session_factory, world, "direct")

    for consumer in consumers.values():
        await consumer.on_command(RoomRef(room_id=TRANSPORT_ROOM_ID), _command("reset"))

    for consumer in consumers.values():
        assert consumer.enqueued == []  # type: ignore[attr-defined]
        assert consumer.sent == []  # type: ignore[attr-defined]


async def test_greeting_in_a_direct_room_with_two_agents_asks_to_be_named(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    world = await _world(
        session_factory, names=["alpha", "beta"], channel_type="direct"
    )
    consumers = _consumers(session_factory, world, "direct")

    for consumer in consumers.values():
        await consumer.on_command(
            RoomRef(room_id=TRANSPORT_ROOM_ID), _command("agents-greet")
        )

    for name, consumer in consumers.items():
        [greeting] = consumer.sent  # type: ignore[attr-defined]
        assert "how can I help" not in greeting
        assert f"@{name}" in greeting


async def test_going_back_to_one_agent_restores_auto_addressing(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    world = await _world(
        session_factory, names=["alpha", "beta"], channel_type="direct"
    )
    async with session_factory() as session:
        await RoomStore().remove_agents(
            session, world.room_id, [world.agents["beta"].id]
        )
        await session.commit()
    alpha = _consumer(session_factory, world.agents["alpha"], world.room_id, "direct")

    await alpha.on_message(RoomRef(room_id=TRANSPORT_ROOM_ID), _message("hello?"))
    await alpha.on_media(RoomRef(room_id=TRANSPORT_ROOM_ID), _media(""))
    await alpha.on_command(RoomRef(room_id=TRANSPORT_ROOM_ID), _command("agents-greet"))

    assert _addressed(alpha) == [True, True]
    assert alpha.sent[-1] == "Hi! I'm alpha — how can I help?"  # type: ignore[attr-defined]


async def test_a_one_agent_public_room_is_never_auto_addressed(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    world = await _world(
        session_factory, names=["alpha"], channel_type="channel_public"
    )
    alpha = _consumer(
        session_factory, world.agents["alpha"], world.room_id, "channel_public"
    )

    await alpha.on_message(RoomRef(room_id=TRANSPORT_ROOM_ID), _message("hello?"))
    await alpha.on_message(
        RoomRef(room_id=TRANSPORT_ROOM_ID),
        _message("hello again", sender=world.member.transport_user_id),
    )
    await alpha.on_media(RoomRef(room_id=TRANSPORT_ROOM_ID), _media("a file"))

    assert _addressed(alpha) == [False, False, False]


async def test_several_mentions_in_one_message_address_each_agent_once(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    # The body Switch Console posts for mentionAgentIds [beta, alpha, beta].
    world = await _world(
        session_factory,
        names=["alpha", "beta", "gamma"],
        channel_type="channel_private",
    )
    consumers = _consumers(session_factory, world, "channel_private")

    await _deliver(
        consumers, "@alpha @beta ship it", sender=world.member.transport_user_id
    )

    assert {name: _addressed(c) for name, c in consumers.items()} == {
        "alpha": [True],
        "beta": [True],
        "gamma": [False],
    }


async def test_one_agent_refusing_the_sender_leaves_the_other_addressed(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    world = await _world(
        session_factory, names=["alpha", "beta"], channel_type="channel_private"
    )
    async with session_factory() as session:
        await AgentStore().update(
            session,
            world.agents["beta"].id,
            addressing_policy=owner_only_policy([]).model_dump(),
        )
        await session.commit()
    consumers = _consumers(session_factory, world, "channel_private")

    await _deliver(
        consumers, "@alpha @beta ship it", sender=world.member.transport_user_id
    )

    assert _addressed(consumers["alpha"]) == [True]
    assert _addressed(consumers["beta"]) == [False]
    assert consumers["beta"].sent == [ADDRESSING_DENIED_MESSAGE]  # type: ignore[attr-defined]
    assert ADDRESSING_DENIED_MESSAGE not in consumers["alpha"].sent  # type: ignore[attr-defined]


async def test_slack_and_console_bodies_with_the_same_mentions_decide_alike(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    world = await _world(
        session_factory,
        names=["alpha", "beta", "gamma"],
        channel_type="channel_private",
    )
    async with session_factory() as session:
        await RoomStore().set_alias(
            session, world.room_id, world.agents["gamma"].id, "ops"
        )
        await session.commit()
    body = "@beta and @ops, please look"
    decisions: list[dict[str, list[bool]]] = []
    for sender in (SLACK_SENDER, world.member.transport_user_id):
        consumers = _consumers(session_factory, world, "channel_private")
        await _deliver(consumers, body, sender=sender)
        decisions.append({name: _addressed(c) for name, c in consumers.items()})

    assert (
        decisions[0]
        == decisions[1]
        == {
            "alpha": [False],
            "beta": [True],
            "gamma": [True],
        }
    )


def test_named_agents_reads_names_and_aliases_only() -> None:
    names = {"a1": "alpha", "b1": "beta", "g1": "gamma"}
    aliases = {"g1": "ops", "zz": "ghost"}

    assert named_agents(names, aliases, "**@beta** and @ops, not alpha") == ["b1", "g1"]
    assert named_agents(names, aliases, "email beta@example.com") == []
    assert named_agents(names, aliases, "@ghost hello") == []
