"""A switch-core process's hold on work, for tests that read rooms.

A client's rooms are read only by the process that owns the client, under its
lease (`switch_core/ownership.py`), and the reading records progress through
that hold's cursors (`switch_core/transport/cursors.py`). A test standing in
for such a process claims the same rows production does: its own process
lease, then the lease for each client it reads for, and runs the cursor writer
the process would run.
"""

from __future__ import annotations

import asyncio
import uuid
from dataclasses import dataclass, field
from typing import TYPE_CHECKING

from switch_core.db.models import TENANT_ZERO_ID
from switch_core.db.stores.delivery_cursor_store import DeliveryCursorStore
from switch_core.db.stores.ownership_lease_store import OwnershipLeaseStore
from switch_core.db.stores.switch_core_process_store import SwitchCoreProcessStore
from switch_core.ownership import Fence
from switch_core.process_lease import LEASE_TTL, ProcessLease
from switch_core.transport.cursors import ConsumerCursors, CursorWriter

if TYPE_CHECKING:
    from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

    from switch_core.transport.postgres import PostgresTransport

CLIENT = "client"


@dataclass
class Holder:
    """One process: its lease, its cursor writer, and the fences it holds."""

    session_factory: async_sessionmaker[AsyncSession]
    lease: ProcessLease
    writer: CursorWriter
    task: asyncio.Task[None]
    lost: list[Fence] = field(default_factory=list)

    @property
    def process_id(self) -> str:
        return self.lease.process_id

    async def claim(self, key: str, *, kind: str = CLIENT) -> Fence:
        """Claim the lease for `key`, as the ownership would. Raises when
        another live process holds it."""
        async with self.session_factory() as session:
            claimed = await OwnershipLeaseStore().claim(
                session,
                kind=kind,
                keys=[key],
                process_id=self.process_id,
                lease_ttl=LEASE_TTL,
            )
            await session.commit()
        if key not in claimed:
            raise AssertionError(f"{kind} {key} is held by another process")
        return Fence(kind=kind, key=key, process_id=self.process_id, token=claimed[key])

    async def cursors(
        self,
        client_id: str,
        *,
        tenant_id: str = TENANT_ZERO_ID,
        kind: str = CLIENT,
        key: str | None = None,
        actor_role: str = "agent",
    ) -> ConsumerCursors:
        """Cursors for reading `client_id`'s rooms under a fresh claim."""
        fence = await self.claim(key or client_id, kind=kind)
        return ConsumerCursors(
            writer=self.writer,
            store=DeliveryCursorStore(),
            tenant_id=tenant_id,
            client_id=client_id,
            fence=fence,
            actor_role=actor_role,
            on_lost=self.lost.append,
        )

    async def receiving(self, transport: PostgresTransport) -> asyncio.Task[None]:
        """Start `transport` reading its client's rooms under this process."""
        cursors = await self.cursors(transport.client_id, tenant_id=transport.tenant_id)
        return asyncio.create_task(transport.receive_forever(cursors))

    async def stop(self) -> None:
        self.task.cancel()
        await asyncio.gather(self.task, return_exceptions=True)


async def start_holder(session_factory: async_sessionmaker[AsyncSession]) -> Holder:
    """A process whose lease is claimed and whose cursor writer runs."""
    lease = ProcessLease(
        process_id=str(uuid.uuid4()),
        session_factory=session_factory,
        processes=SwitchCoreProcessStore(),
    )
    await lease.renew()
    writer = CursorWriter(
        session_factory=session_factory,
        cursors=DeliveryCursorStore(),
        leases=OwnershipLeaseStore(),
        process_id=lease.process_id,
    )
    return Holder(
        session_factory=session_factory,
        lease=lease,
        writer=writer,
        task=asyncio.create_task(writer.run()),
    )
