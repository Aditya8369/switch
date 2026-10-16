"""`POST /chats/{room_id}/greeting`: the owner of a direct chat has their own
agent open it with a first message, posted as the agent (switch-buddy's
welcome)."""

from __future__ import annotations

import httpx

from switch_core.db.models import Agent, User
from tests.switch_core.gateway.conftest import _Harness
from tests.switch_core.gateway.test_chats_routes import _code


async def _greet(
    chats: _Harness, user: User, room_id: str, agent: Agent, body: str = "Hi, I'm here."
) -> httpx.Response:
    return await chats.client.post(
        f"/chats/{room_id}/greeting",
        json={"agentId": agent.id, "body": body},
        headers=chats.as_user(user),
    )


async def test_the_owner_has_their_agent_open_an_empty_chat(chats: _Harness) -> None:
    agent = await chats.agent("helper", owner=chats.alice)
    room_id = await chats.new_chat(chats.alice, agent, "c1")

    response = await _greet(chats, chats.alice, room_id, agent)

    assert response.status_code == 204, response.text
    assert chats.greetings.posted == [(agent.id, room_id, "Hi, I'm here.")]


async def test_a_chat_with_messages_is_not_greeted(chats: _Harness) -> None:
    agent = await chats.agent("helper", owner=chats.alice)
    room_id = await chats.new_chat(chats.alice, agent, "c1")
    sent = await chats.send(chats.alice, room_id, "s1", "hello")
    assert sent.status_code == 200, sent.text

    response = await _greet(chats, chats.alice, room_id, agent)

    assert response.status_code == 409
    assert _code(response) == "CHAT_NOT_EMPTY"
    assert chats.greetings.posted == []


async def test_only_the_agents_owner_can_have_it_greet(chats: _Harness) -> None:
    agent = await chats.agent("helper", owner=chats.bob)
    room_id = await chats.new_chat(chats.alice, agent, "c1")

    response = await _greet(chats, chats.alice, room_id, agent)

    assert response.status_code == 403
    assert _code(response) == "NOT_AGENT_OWNER"


async def test_an_agent_still_starting_says_so(chats: _Harness) -> None:
    agent = await chats.agent("helper", owner=chats.alice)
    room_id = await chats.new_chat(chats.alice, agent, "c1")
    chats.greetings.fail_with = ValueError("Agent client not running")

    response = await _greet(chats, chats.alice, room_id, agent)

    assert response.status_code == 409
    assert _code(response) == "AGENT_NOT_READY"


async def test_an_empty_greeting_is_refused(chats: _Harness) -> None:
    agent = await chats.agent("helper", owner=chats.alice)
    room_id = await chats.new_chat(chats.alice, agent, "c1")

    response = await _greet(chats, chats.alice, room_id, agent, body="  ")

    assert response.status_code == 422
    assert _code(response) == "EMPTY_MESSAGE"
