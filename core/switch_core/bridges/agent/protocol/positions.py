"""Where a reader of an agent's events has got to: one number per source.

An agent's events come from more than one place. The ones that are for it
(addressed messages, listened-for joins, tasks, commands) are its own list,
numbered for it (`agent_events.seq`). The rest of each room's conversation is
the room's own log, numbered for the room (`messages.seq`). A single number
cannot say how far a reader is in two lists, so a position holds one number
per source: `{"s": 18, "r:<room>": 43}` reads "the agent's own events up to 18,
that room up to 43".

Positions merge by taking the higher number per source, so delivering the same
event twice, delivering sources out of step, or two processes reporting
progress in either order all land in the same place.
"""

from __future__ import annotations

import json
from typing import Any

#: The source an agent's own events are numbered in.
SLIPS = "s"

_ROOM_PREFIX = "r:"

Position = dict[str, int]


def room_source(room_id: str) -> str:
    """The source a room's conversation is numbered in."""
    return f"{_ROOM_PREFIX}{room_id}"


def room_of(source: str) -> str | None:
    """The room a source numbers, or None for the agent's own events."""
    return source[len(_ROOM_PREFIX) :] if source.startswith(_ROOM_PREFIX) else None


def merged(current: Position, reported: Position) -> Position:
    """`current` moved forward by `reported`, source by source. Never back."""
    out = dict(current)
    for source, seq in reported.items():
        if seq > out.get(source, -1):
            out[source] = seq
    return out


def parse(raw: Any) -> Position:
    """A position from the wire, or ValueError.

    An object of source to non-negative integer. A source is the agent's own
    events or a room; anything else is refused rather than kept, so a typo is
    an error the client sees instead of a position that never moves.
    """
    if isinstance(raw, str):
        try:
            raw = json.loads(raw)
        except ValueError as exc:
            raise ValueError("a position is a JSON object") from exc
    if not isinstance(raw, dict):
        raise ValueError("a position is an object of source to sequence number")
    position: Position = {}
    for source, seq in raw.items():
        if not isinstance(source, str) or not (
            source == SLIPS or (source.startswith(_ROOM_PREFIX) and room_of(source))
        ):
            raise ValueError(f"unknown position source {source!r}")
        if isinstance(seq, bool) or not isinstance(seq, int) or seq < 0:
            raise ValueError(f"position {source!r} must be a non-negative integer")
        position[source] = seq
    return position
