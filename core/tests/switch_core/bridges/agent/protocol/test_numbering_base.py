"""Where a new agent's own event numbers start is read, not drawn.

Each agent's numbering is kept in `agent_event_heads` and survives restarts, so
a process start has no reason to move it. Were every start to draw from
`agent_event_boot`, which stops at 2,097,150, a pod restarting in a loop would
use it up and switch-core could no longer start.
"""

from __future__ import annotations

from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.bridges.agent.protocol.event_buffer import numbering_base


async def test_every_start_reads_the_same_base(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    engine = session_factory.kw["bind"]
    bases = []
    for _ in range(3):
        async with engine.begin() as connection:
            bases.append(await numbering_base(connection))

    assert bases[0] > 0
    assert bases[0] % (1 << 32) == 0
    assert bases == [bases[0]] * 3
