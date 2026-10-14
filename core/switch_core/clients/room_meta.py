from __future__ import annotations

from pydantic import BaseModel


class RoomMeta(BaseModel):
    room_id: str
    name: str
    bridge_id: str | None = None
    # Whether agents should post their self-join greeting in this room. Driven by
    # the room's collaboration bridge toggle; True for non-bridged
    # rooms and when no bridge resolves.
    agent_greetings_enabled: bool = True
    channel_type: str | None = None
    # Follow-the-conversation settings, read with the room and kept current by
    # the settings marker on the Switch app's notice when a command changes
    # them. Used only to skip work; the rules re-read the room to decide.
    follow_ups_enabled: bool = True
    main_agent_id: str | None = None
