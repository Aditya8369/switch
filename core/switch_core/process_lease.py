"""This switch-core process's lease, and reading every process's.

Every switch-core process holds a lease in `switch_core_processes`, whatever
features it runs: it claims it at startup, renews it every `RENEW_INTERVAL`,
and marks it stopped as it shuts down. Two things lean on it. A controller's
socket lives in the memory of the one process holding it, and that process
writes the connection's transitions to the controller's row
(`management/connection_ledger.py`); a process that dies writes no closing,
so a connection reads as online only while its holding process's lease is
held: renewed within `LEASE_TTL` and not stopped. And the work that must run
once (a client's consumer, a bridge's platform connection) is owned through
`ownership.py`, whose leases are valid only while their holder's process lease
is held. One write per process per renewal, however much it holds.

Leases are written and compared on the database's clock, never a host's.
Leases not renewed for `PRUNE_AFTER` are deleted by whichever process renews
next; a connection naming a process with no lease reads as lost.
"""

from __future__ import annotations

import asyncio
import logging
import time
from dataclasses import dataclass
from datetime import datetime, timedelta

from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.db.stores.switch_core_process_store import (
    ProcessLeaseRow,
    SwitchCoreProcessStore,
)

logger = logging.getLogger(__name__)

RENEW_INTERVAL_SECONDS = 5.0

# Three renewals: one missed write, or a slow one, does not put every machine
# the process holds offline.
LEASE_TTL = timedelta(seconds=3 * RENEW_INTERVAL_SECONDS)

PRUNE_AFTER = timedelta(hours=1)

# Why a connection the row still shows open is not, when its process is the
# reason: the process shut down without writing it, or stopped renewing.
SERVER_SHUTDOWN = "server_shutdown"
SERVER_LOST = "server_lost"


@dataclass(frozen=True)
class ProcessLeases:
    """Every process's lease as the database held it at `read_at`, its own
    clock."""

    read_at: datetime
    leases: dict[str, ProcessLeaseRow]

    def holds(self, process_id: str | None) -> bool:
        """Whether the process is alive and holding its sockets."""
        lease = self.leases.get(process_id) if process_id is not None else None
        return (
            lease is not None
            and lease.stopped_at is None
            and self.read_at - lease.beat_at < LEASE_TTL
        )

    def ended(self, process_id: str | None) -> tuple[datetime | None, str]:
        """When and why a process not holding stopped: shut down at
        `stopped_at`, or lost after its last renewal (when not known once its
        lease is pruned)."""
        lease = self.leases.get(process_id) if process_id is not None else None
        if lease is None:
            return None, SERVER_LOST
        if lease.stopped_at is not None:
            return lease.stopped_at, SERVER_SHUTDOWN
        return lease.beat_at, SERVER_LOST


async def read_leases(
    session: AsyncSession, processes: SwitchCoreProcessStore
) -> ProcessLeases:
    """Every lease, in the caller's session; the table has no tenant policy,
    so any session reads it."""
    read_at, leases = await processes.read(session)
    return ProcessLeases(read_at=read_at, leases=leases)


class ProcessLease:
    """This process's lease. The sessions are opened with no tenant bound:
    the table carries none."""

    def __init__(
        self,
        *,
        process_id: str,
        session_factory: async_sessionmaker[AsyncSession],
        processes: SwitchCoreProcessStore,
    ) -> None:
        self.process_id = process_id
        self._session_factory = session_factory
        self._processes = processes
        # This process's monotonic clock when the last renewal that succeeded
        # was sent, or None before the first and after `stop`. Sent, not
        # answered: the database stamped the lease at some moment after this,
        # so a deadline counted from here can only be early.
        self._renewed_at: float | None = None

    def surely_held(self) -> bool:
        """Whether no other process can yet read this lease as lapsed.

        Another process takes over this one's work once the lease is
        `LEASE_TTL` old by the database's clock. This answers from half that,
        on this process's own clock and from when the last good renewal was
        sent, so the work stops here well before anyone else may start it,
        however far the two clocks have drifted.
        """
        held_until = self.held_until()
        return held_until is not None and time.monotonic() < held_until

    def held_until(self) -> float | None:
        """On this process's monotonic clock, when `surely_held` turns false
        unless the lease is renewed first. None before the first renewal and
        after `stop`."""
        if self._renewed_at is None:
            return None
        return self._renewed_at + LEASE_TTL.total_seconds() / 2

    async def renew(self) -> None:
        """Claim or renew the lease, and prune leases long dead."""
        sent_at = time.monotonic()
        async with self._session_factory() as session:
            await self._processes.renew(session, self.process_id)
            pruned = await self._processes.prune(session, PRUNE_AFTER)
            await session.commit()
        self._renewed_at = sent_at
        if pruned:
            logger.info("Pruned %d switch-core process lease(s) long stale", pruned)

    async def stop(self) -> None:
        """Mark the lease stopped: every connection this process still shows
        open reads as offline from now, and the work it owned may be taken
        over at once."""
        self._renewed_at = None
        async with self._session_factory() as session:
            await self._processes.stop(session, self.process_id)
            await session.commit()
        logger.info("Released switch-core process lease %s", self.process_id)

    async def run(self) -> None:
        """Renew every `RENEW_INTERVAL_SECONDS` until cancelled. A failed
        renewal is logged and retried at the next; three in a row and this
        process's machines read offline elsewhere, and its owned work passes
        to the other processes."""
        while True:
            await asyncio.sleep(RENEW_INTERVAL_SECONDS)
            try:
                await self.renew()
            except Exception:
                logger.exception(
                    "Renewing switch-core process lease %s failed; the machines "
                    "it holds read offline once it is %s old",
                    self.process_id,
                    LEASE_TTL,
                )
