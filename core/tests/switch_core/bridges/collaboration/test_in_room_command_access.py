"""Who may run in-room commands on a bridge.

On a public server every member can post, so a bridge whose commands are open
to everyone lets a stranger invite agents into channels, rename them, or reset
them mid-turn. `in_room_commands` narrows that to accounts a Switch user has
claimed, or turns commands off.
"""

from __future__ import annotations

from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from types import MethodType, SimpleNamespace
from typing import Any

from switch_core.bridges.collaboration.collaboration_core import CollaborationCore
from switch_core.bridges.collaboration.discord.adapter import (
    DiscordAdapter,
    DiscordConnectionConfig,
)
from switch_core.bridges.collaboration.models import (
    InboundAgentJoin,
    InboundAppJoin,
    InboundCommand,
    InboundMessage,
    InboundUserJoin,
    InRoomCommandAccess,
)


def _cmd() -> InboundCommand:
    return InboundCommand(
        channel_id="chan-1",
        channel_type="channel_public",
        sender_id="ext-user",
        sender_name="stranger",
        command="invite-agent",
        args="@master",
        message_ref="post-1",
    )


class _Store:
    def __init__(self, *, known: bool, claimants: list[str]) -> None:
        self._known = known
        self._claimants = claimants

    async def get_by_external_id(
        self, _session: object, bridge_id: str, external_user_id: str
    ) -> SimpleNamespace | None:
        assert (bridge_id, external_user_id) == ("bridge-1", "ext-user")
        return SimpleNamespace(id="row-1") if self._known else None

    async def claimant_ids(self, _session: object, external_user_id: str) -> list[str]:
        assert external_user_id == "row-1"
        return self._claimants


def _bridge(
    access: InRoomCommandAccess,
    *,
    known: bool = False,
    claimants: list[str] | None = None,
) -> SimpleNamespace:
    notices: list[tuple[str, str, str | None]] = []
    sent: list[dict[str, Any]] = []

    async def admin_message(
        channel_id: str,
        content: str,
        thread_root_id: str | None = None,
        *,
        message_type: str | None = None,
    ) -> None:
        notices.append((channel_id, content, thread_root_id))

    async def _ensure_human_in_room(**_kw: object) -> SimpleNamespace:
        async def send_event(_room: str, _type: str, content: dict[str, Any]) -> str:
            sent.append(content)
            return "$cmd"

        return SimpleNamespace(
            transport_user_id="@human:switch.local",
            client_id="human-1",
            send_event=send_event,
        )

    async def _event_for_external_post(_post: str) -> None:
        return None

    async def _record_message_map(**_kw: str) -> None:
        return None

    @asynccontextmanager
    async def session_factory() -> AsyncIterator[object]:
        yield object()

    bridge = SimpleNamespace(
        _bridge_id="bridge-1",
        _bridge_tenant_id="tenant-1",
        _channel_to_room={"chan-1": ("room-uuid", "!room:switch.local")},
        _adapter=SimpleNamespace(
            in_room_command_access=lambda: access,
            admin_message=admin_message,
            translate_inbound=lambda raw: raw,
        ),
        _session_factory=session_factory,
        _external_user_store=_Store(known=known, claimants=claimants or []),
        _ensure_human_in_room=_ensure_human_in_room,
        _event_for_external_post=_event_for_external_post,
        _record_message_map=_record_message_map,
        _prerecord_message_map=lambda *_a: None,
        _pending_message_maps={},
        notices=notices,
        sent=sent,
    )
    bridge._command_refusal = MethodType(CollaborationCore._command_refusal, bridge)
    return bridge


class TestTheCommandIsRun:
    async def test_when_everyone_may_run_commands(self) -> None:
        bridge = _bridge("everyone")
        await CollaborationCore._handle_inbound_command(bridge, _cmd())
        assert [c["command"] for c in bridge.sent] == ["invite-agent"]
        assert bridge.notices == []

    async def test_from_a_claimed_account(self) -> None:
        bridge = _bridge("claimed", known=True, claimants=["user-1"])
        await CollaborationCore._handle_inbound_command(bridge, _cmd())
        assert [c["command"] for c in bridge.sent] == ["invite-agent"]
        assert bridge.notices == []


class TestTheCommandIsRefusedVisibly:
    async def test_when_commands_are_off(self) -> None:
        bridge = _bridge("off")
        await CollaborationCore._handle_inbound_command(bridge, _cmd())
        assert bridge.sent == []
        [(channel, text, thread)] = bridge.notices
        assert (channel, thread) == ("chan-1", "post-1")
        assert "turned off" in text

    async def test_from_an_account_nobody_has_claimed(self) -> None:
        bridge = _bridge("claimed", known=True, claimants=[])
        await CollaborationCore._handle_inbound_command(bridge, _cmd())
        assert bridge.sent == []
        [(_, text, _)] = bridge.notices
        assert "linked to a Switch user" in text

    async def test_from_an_account_the_bridge_has_never_seen(self) -> None:
        bridge = _bridge("claimed", known=False)
        await CollaborationCore._handle_inbound_command(bridge, _cmd())
        assert bridge.sent == []
        assert len(bridge.notices) == 1


class _RecordingConnection:
    def __init__(self) -> None:
        self.commands: list[Any] | None = None
        self.client = SimpleNamespace(user="bot")

    def register_message_handler(self, *_a: object) -> None: ...
    def set_dm_handler(self, *_a: object) -> None: ...
    def set_interaction_handler(self, *_a: object) -> None: ...

    async def connect(self, *, commands: list[Any]) -> None:
        self.commands = commands


async def _noop_message(_: InboundMessage) -> None: ...
async def _noop_command(_: InboundCommand) -> None: ...
async def _noop_agent(_: InboundAgentJoin) -> None: ...
async def _noop_user(_: InboundUserJoin) -> None: ...
async def _noop_app(_: InboundAppJoin) -> None: ...


async def _started(
    access: InRoomCommandAccess,
) -> tuple[DiscordAdapter, _RecordingConnection]:
    adapter = DiscordAdapter(
        config=DiscordConnectionConfig(
            bot_token="token", guild_id="900", in_room_commands=access
        )
    )
    connection = _RecordingConnection()
    adapter._connection = connection  # type: ignore[assignment]
    await adapter.start(
        _noop_message, _noop_command, _noop_agent, _noop_user, _noop_app
    )
    return adapter, connection


class TestDiscord:
    def test_commands_are_open_to_everyone_unless_narrowed(self) -> None:
        config = DiscordConnectionConfig(bot_token="token", guild_id="900")
        assert config.in_room_commands == "everyone"

    async def test_registers_slash_commands_when_they_may_be_run(self) -> None:
        adapter, connection = await _started("claimed")
        assert connection.commands
        assert adapter.in_room_command_access() == "claimed"
        assert adapter.slash_invite_hint() is not None

    async def test_registers_none_when_commands_are_off(self) -> None:
        # An empty set, not a skipped sync: the sync overwrites, so commands a
        # previous start registered are removed from the server.
        adapter, connection = await _started("off")
        assert connection.commands == []
        assert adapter.slash_invite_hint() is None
