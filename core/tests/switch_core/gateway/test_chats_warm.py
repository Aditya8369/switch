"""Starting an agent's session for a chat before its first message: creating a
direct chat asks the agent's controller once, and `POST /chats/{room_id}/warm`
asks again for a chat Switch Console reuses."""

from __future__ import annotations

import logging

import httpx
import pytest

from switch_core.db.models import Agent, User
from tests.switch_core.gateway.conftest import _Harness
from tests.switch_core.gateway.test_chats_routes import _code


async def _warm(
    chats: _Harness, user: User, room_id: str, agent: Agent
) -> httpx.Response:
    return await chats.client.post(
        f"/chats/{room_id}/warm",
        json={"agentId": agent.id},
        headers=chats.as_user(user),
    )


async def test_creating_a_direct_chat_starts_the_agents_session_once(
    chats: _Harness,
) -> None:
    agent = await chats.agent("helper", owner=chats.alice)
    chats.controllers.bound.add(agent.id)

    room_id = await chats.new_chat(chats.alice, agent, "c1")
    assert await chats.new_chat(chats.alice, agent, "c1") == room_id

    assert chats.controllers.warms == [(agent.id, room_id)]


async def test_creating_a_chat_with_several_agents_starts_no_session(
    chats: _Harness,
) -> None:
    helper = await chats.agent("helper", owner=chats.alice)
    other = await chats.agent("other", owner=chats.alice)
    chats.controllers.bound.update({helper.id, other.id})

    response = await chats.client.post(
        "/chats",
        json={"agentIds": [helper.id, other.id], "requestId": "c1"},
        headers=chats.as_user(chats.alice),
    )

    assert response.status_code == 200, response.text
    assert chats.controllers.warms == []


async def test_creating_a_chat_warns_when_the_controller_is_offline(
    chats: _Harness, caplog: pytest.LogCaptureFixture
) -> None:
    agent = await chats.agent("helper", owner=chats.alice)
    chats.controllers.bound.add(agent.id)
    chats.controllers.live = False

    with caplog.at_level(logging.WARNING):
        room_id = await chats.new_chat(chats.alice, agent, "c1")

    assert chats.controllers.warms == []
    assert any(
        record.levelno == logging.WARNING and room_id in record.getMessage()
        for record in caplog.records
    )


async def test_creating_a_chat_with_an_agent_no_controller_hosts_starts_nothing(
    chats: _Harness, caplog: pytest.LogCaptureFixture
) -> None:
    agent = await chats.agent("helper", owner=chats.alice)

    with caplog.at_level(logging.WARNING):
        await chats.new_chat(chats.alice, agent, "c1")

    assert chats.controllers.warms == []
    assert not [r for r in caplog.records if r.levelno >= logging.WARNING]


async def test_a_warm_reaches_the_agents_controller(chats: _Harness) -> None:
    agent = await chats.agent("helper", owner=chats.alice)
    chats.controllers.bound.add(agent.id)
    room_id = await chats.new_chat(chats.alice, agent, "c1")
    chats.controllers.warms.clear()

    response = await _warm(chats, chats.alice, room_id, agent)

    assert response.status_code == 202, response.text
    assert chats.controllers.warms == [(agent.id, room_id)]


async def test_a_warm_is_accepted_when_no_controller_takes_it(
    chats: _Harness,
) -> None:
    agent = await chats.agent("helper", owner=chats.alice)
    room_id = await chats.new_chat(chats.alice, agent, "c1")

    unbound = await _warm(chats, chats.alice, room_id, agent)
    chats.controllers.bound.add(agent.id)
    chats.controllers.live = False
    offline = await _warm(chats, chats.alice, room_id, agent)

    assert unbound.status_code == offline.status_code == 202
    assert chats.controllers.warms == []


async def test_a_warm_refuses_non_members_and_absent_agents(
    chats: _Harness,
) -> None:
    agent = await chats.agent("helper", owner=chats.alice)
    chats.controllers.bound.add(agent.id)
    room_id = await chats.new_chat(chats.alice, agent, "c1")
    chats.controllers.warms.clear()

    outsider = await _warm(chats, chats.bob, room_id, agent)
    assert outsider.status_code == 403
    assert _code(outsider) == "NOT_A_MEMBER"

    elsewhere = await chats.agent("elsewhere", owner=chats.alice)
    absent = await _warm(chats, chats.alice, room_id, elsewhere)
    assert absent.status_code == 422
    assert _code(absent) == "AGENT_NOT_IN_CHAT"

    assert chats.controllers.warms == []


async def test_a_warm_follows_the_agents_policy_not_its_owner(
    chats: _Harness,
) -> None:
    agent = await chats.agent("helper", owner=chats.alice)
    chats.controllers.bound.add(agent.id)
    room_id = await chats.new_chat(chats.alice, agent, "c1")
    assert (await chats.invite(chats.alice, room_id, chats.bob)).status_code == 200
    chats.controllers.warms.clear()

    member = await _warm(chats, chats.bob, room_id, agent)
    async with chats.factory() as session:
        row = await session.get(Agent, agent.id)
        assert row is not None
        row.addressing_policy = {"rules": [{"users": [], "agents": []}]}
        await session.commit()
    refused = await _warm(chats, chats.alice, room_id, agent)

    assert member.status_code == 202, member.text
    assert refused.status_code == 403
    assert _code(refused) == "AGENT_NOT_ALLOWED"
    assert chats.controllers.warms == [(agent.id, room_id)]
