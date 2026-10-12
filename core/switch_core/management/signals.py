"""Management's nudges, delivered to whichever process holds the controller.

A change commits in the process that handled the request; the controller it
affects may be streaming from any process. So every nudge is acted on here at
once (the local subscriptions, and on revocation the local presence) and
published on the `SignalBus` for the others, which do the same on receipt.

Nudges were already wake-ups, never the record: a controller woken pulls its
assignment or its operations. Resync keeps that true across processes. When
the signal connection comes back, every controller held here is re-nudged from
the database, so one that missed a signal while the connection was down pulls
again, and one revoked meanwhile is closed.
"""

from __future__ import annotations

import logging
from collections.abc import Callable
from datetime import datetime
from typing import TYPE_CHECKING, Any

from switch_core.db.session_scope import tenant_session

if TYPE_CHECKING:
    from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

    from switch_core.bridges.agent.protocol.controller_presence import (
        ControllerPresence,
    )
    from switch_core.db.stores.agent_controller_operation_store import (
        AgentControllerOperationStore,
    )
    from switch_core.db.stores.agent_controller_store import AgentControllerStore
    from switch_core.management.notifier import ControllerNotifier
    from switch_core.signals import SignalBus

logger = logging.getLogger(__name__)

ASSIGNMENT_CHANGED_SIGNAL = "controller.assignment_changed"
OPERATION_PENDING_SIGNAL = "controller.operation_pending"
REVOKED_SIGNAL = "controller.revoked"


class ControllerSignals:
    def __init__(
        self,
        *,
        notifier: ControllerNotifier,
        presence: ControllerPresence,
        bus: SignalBus,
        session_factory: async_sessionmaker[AsyncSession],
        controllers: AgentControllerStore,
        operations: AgentControllerOperationStore,
        clock: Callable[[], datetime],
    ) -> None:
        self.notifier = notifier
        self._presence = presence
        self._bus = bus
        self._session_factory = session_factory
        self._controllers = controllers
        self._operations = operations
        self._clock = clock
        bus.handle(ASSIGNMENT_CHANGED_SIGNAL, self._on_assignment_changed)
        bus.handle(OPERATION_PENDING_SIGNAL, self._on_operation_pending)
        bus.handle(REVOKED_SIGNAL, self._on_revoked)
        bus.on_resync(self.resync)

    # ── Announcing, from the process that made the change ─────────────────────

    def assignment_changed(self, controller_id: str, revision: int) -> None:
        self.notifier.assignment_changed(controller_id, revision)
        self._bus.publish(
            ASSIGNMENT_CHANGED_SIGNAL, controller_id=controller_id, revision=revision
        )

    def operation_pending(
        self, controller_id: str, *, operation_id: str, kind: str, agent_id: str | None
    ) -> None:
        self.notifier.operation_pending(
            controller_id, operation_id=operation_id, kind=kind, agent_id=agent_id
        )
        self._bus.publish(
            OPERATION_PENDING_SIGNAL,
            controller_id=controller_id,
            operation_id=operation_id,
            operation_kind=kind,
            agent_id=agent_id,
        )

    def revoked(self, controller_id: str) -> None:
        self._revoke_here(controller_id)
        self._bus.publish(REVOKED_SIGNAL, controller_id=controller_id)

    # ── Receiving, in every other process ─────────────────────────────────────

    def _on_assignment_changed(self, signal: dict[str, Any]) -> None:
        self.notifier.assignment_changed(signal["controller_id"], signal["revision"])

    def _on_operation_pending(self, signal: dict[str, Any]) -> None:
        self.notifier.operation_pending(
            signal["controller_id"],
            operation_id=signal["operation_id"],
            kind=signal["operation_kind"],
            agent_id=signal["agent_id"],
        )

    def _on_revoked(self, signal: dict[str, Any]) -> None:
        self._revoke_here(signal["controller_id"])

    def _revoke_here(self, controller_id: str) -> None:
        """The stream ends, the controller cannot open another here, and this
        process's token cache forgets it."""
        self.notifier.credential_revoked(controller_id)
        self._presence.revoke_controller(controller_id)

    # ── Resync ────────────────────────────────────────────────────────────────

    async def resync(self) -> None:
        """Re-nudge every controller this process holds from what the database
        says now: its assignment revision and its open operations, or its
        revocation."""
        for conn in self._presence.held_connections():
            try:
                async with tenant_session(
                    self._session_factory, conn.tenant_id
                ) as session:
                    controller = await self._controllers.get(
                        session, conn.tenant_id, conn.controller_id
                    )
                    if controller is None or controller.revoked_at is not None:
                        self._revoke_here(conn.controller_id)
                        continue
                    offered = await self._operations.list_offered(
                        session, conn.tenant_id, conn.controller_id, self._clock()
                    )
                self.notifier.assignment_changed(
                    conn.controller_id, controller.assignment_revision
                )
                for operation in offered:
                    self.notifier.operation_pending(
                        conn.controller_id,
                        operation_id=operation.id,
                        kind=operation.kind,
                        agent_id=operation.agent_id,
                    )
            except Exception:
                logger.error(
                    "Could not resync controller %s", conn.controller_id, exc_info=True
                )
