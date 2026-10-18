"""Setting up a Slack or Discord app of your own: the Slack manifest this
server builds, and what the tokens say once pasted. The platforms are stood
in for by an httpx mock transport."""

from __future__ import annotations

import json
from typing import Any
from urllib.parse import parse_qs, urlsplit

import httpx
import pytest

from switch_core.bridges.agent.commands import COMMANDS
from switch_core.bridges.collaboration.discord.install import PERMISSIONS
from switch_core.bridges.collaboration.own_app_setup import (
    SetupCheckError,
    check_discord,
    check_slack,
    slack_create_url,
    slack_manifest,
)
from switch_core.bridges.collaboration.slack.install import BOT_SCOPES


def _client(answers: dict[str, tuple[int, Any]]) -> httpx.AsyncClient:
    def handle(request: httpx.Request) -> httpx.Response:
        status, body = answers[request.url.path]
        return httpx.Response(status, json=body)

    return httpx.AsyncClient(transport=httpx.MockTransport(handle))


class TestSlackManifest:
    def test_asks_for_what_this_server_uses(self) -> None:
        manifest = slack_manifest()

        assert manifest["oauth_config"]["scopes"]["bot"] == list(BOT_SCOPES)
        assert manifest["settings"]["socket_mode_enabled"] is True
        assert {c["command"] for c in manifest["features"]["slash_commands"]} == {
            f"/{command.name}" for command in COMMANDS
        }

    def test_stays_inside_slacks_limits(self) -> None:
        for command in slack_manifest()["features"]["slash_commands"]:
            assert len(command["description"]) <= 100, command
            assert command["command"] == command["command"].lower()
            assert len(command["command"]) <= 32

    def test_the_create_link_carries_the_manifest(self) -> None:
        manifest = slack_manifest()
        query = parse_qs(urlsplit(slack_create_url(manifest)).query)

        assert query["new_app"] == ["1"]
        assert json.loads(query["manifest_json"][0]) == manifest


class TestCheckingSlackTokens:
    async def test_reads_the_workspace_once_both_tokens_work(self) -> None:
        async with _client(
            {
                "/api/auth.test": (
                    200,
                    {
                        "ok": True,
                        "team_id": "T123",
                        "team": "Acme",
                        "user": "agent_switch",
                    },
                ),
                "/api/apps.connections.open": (200, {"ok": True, "url": "wss://x"}),
            }
        ) as http:
            checked = await check_slack(http, bot_token="xoxb-1", app_token="xapp-1")

        assert (checked.workspace_id, checked.workspace_name) == ("T123", "Acme")

    async def test_says_which_token_is_wrong(self) -> None:
        async with _client(
            {
                "/api/auth.test": (200, {"ok": True, "team_id": "T123"}),
                "/api/apps.connections.open": (
                    200,
                    {"ok": False, "error": "invalid_auth"},
                ),
            }
        ) as http:
            with pytest.raises(SetupCheckError, match="app-level token"):
                await check_slack(http, bot_token="xoxb-1", app_token="xapp-1")
            with pytest.raises(SetupCheckError, match="starts with xoxb-"):
                await check_slack(http, bot_token="xapp-1", app_token="xapp-1")


class TestCheckingADiscordToken:
    async def test_reads_the_application_its_intents_and_servers(self) -> None:
        limited_members_and_content = (1 << 15) | (1 << 19)
        async with _client(
            {
                "/api/v10/applications/@me": (
                    200,
                    {
                        "id": "42",
                        "name": "Acme Switch",
                        "flags": limited_members_and_content,
                    },
                ),
                "/api/v10/users/@me/guilds": (200, [{"id": "7", "name": "Acme"}]),
            }
        ) as http:
            checked = await check_discord(http, bot_token="token")

        assert checked.message_content and checked.server_members
        assert checked.servers == [{"id": "7", "name": "Acme"}]
        query = parse_qs(urlsplit(checked.invite_url).query)
        assert query["client_id"] == ["42"]
        assert query["permissions"] == [str(PERMISSIONS)]

    async def test_says_when_an_intent_is_off(self) -> None:
        async with _client(
            {
                "/api/v10/applications/@me": (200, {"id": "42", "flags": 1 << 19}),
                "/api/v10/users/@me/guilds": (200, []),
            }
        ) as http:
            checked = await check_discord(http, bot_token="token")

        assert checked.message_content is True
        assert checked.server_members is False
        assert checked.servers == []

    async def test_says_when_the_token_is_refused(self) -> None:
        async with _client(
            {"/api/v10/applications/@me": (401, {"message": "401: Unauthorized"})}
        ) as http:
            with pytest.raises(SetupCheckError, match="refused the bot token"):
                await check_discord(http, bot_token="bad")
