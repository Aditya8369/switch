"""Management's nudges and bindings, kept current in whichever process holds
the controller.

A change commits in the process that handled the request; the controller it
affects may be streaming from any process, and every process answers that
controller's agents' requests. So every change is acted on here at once (the
local subscriptions and bindings, and on revocation the local presence) and
published on the `SignalBus` for the others, which do the same on receipt.

Nudges were already wake-ups, never the record: a controller woken pulls its
assignment or its operations. A binding is a copy of the record, which is why
a process that hears `controller.assignment_changed` or `controller.renamed`
reads the controller's placed definitions again rather than trusting the
signal (`bindings.reconcile_controller_bindings`). A move bumps the revision of
both controllers, so both are re-read.

Nothing here depends on a signal arriving. When the signal connection comes
back, every binding is read again and every controller held here is re-nudged
from the database, so one that missed a signal while the connection was down
pulls again, and one revoked meanwhile is closed. The periodic re-check does
the same reads, but nudges a held controller only with what it has not been
told yet (a newer revision, an operation it has not heard of), so a quiet
controller is not made to pull every `RECHECK_SECONDS`.
"""

from __future__ import annotations

import logging
from collections.abc import Callable
from datetime import datetime
from typing import TYPE_CHECKING, Any

from switch_core.db.session_scope import tenant_session
from switch_core.management.bindings import (
    reconcile_bindings,
    reconcile_controller_bindings,
)

if TYPE_CHECKING:
    from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

    from switch_core.bridges.agent.protocol.controller_presence import (
        ControllerPresence,
    )
    from switch_core.db.stores.agent_controller_operation_store import (
        AgentControllerOperationStore,
    )
    from switch_core.db.stores.agent_controller_store import AgentControllerStore
    from switch_core.db.stores.agent_definition_store import AgentDefinitionStore
    from switch_core.management.notifier import ControllerNotifier
    from switch_core.signals import SignalBus

logger = logging.getLogger(__name__)

ASSIGNMENT_CHANGED_SIGNAL = "controller.assignment_changed"
OPERATION_PENDING_SIGNAL = "controller.operation_pending"
REVOKED_SIGNAL = "controller.revoked"
RENAMED_SIGNAL = "controller.renamed"


class ControllerSignals:
    def __init__(
        self,
        *,
        notifier: ControllerNotifier,
        presence: ControllerPresence,
        bus: SignalBus,
        session_factory: async_sessionmaker[AsyncSession],
        controllers: AgentControllerStore,
        definitions: AgentDefinitionStore,
        operations: AgentControllerOperationStore,
        clock: Callable[[], datetime],
    ) -> None:
        self.notifier = notifier
        self._presence = presence
        self._bus = bus
        self._session_factory = session_factory
        self._controllers = controllers
        self._definitions = definitions
        self._operations = operations
        self._clock = clock
        # What each controller has been nudged with from this process, so the
        # periodic re-check tells a held controller only what is new to it.
        self._nudged_revision: dict[str, int] = {}
        self._nudged_operations: dict[str, set[str]] = {}
        # Controllers, by (tenant id, controller id), whose bindings another
        # process changed and this one has still to read.
        self._bindings_owed = bus.pending_work(
            "controller bindings", self._reconcile_controller
        )
        bus.handle(ASSIGNMENT_CHANGED_SIGNAL, self._on_assignment_changed)
        bus.handle(OPERATION_PENDING_SIGNAL, self._on_operation_pending)
        bus.handle(REVOKED_SIGNAL, self._on_revoked)
        bus.handle(RENAMED_SIGNAL, self._on_renamed)
        bus.on_resync(self.resync)
        bus.on_recheck(self.recheck)

    # ── Announcing, from the process that made the change ─────────────────────

    def assignment_changed(
        self, tenant_id: str, controller_id: str, revision: int
    ) -> None:
        """The process that committed the change has already bound its agents."""
        self._nudge_assignment(controller_id, revision)
        self._bus.publish(
            ASSIGNMENT_CHANGED_SIGNAL,
            tenant_id=tenant_id,
            controller_id=controller_id,
            revision=revision,
        )

    def operation_pending(
        self, controller_id: str, *, operation_id: str, kind: str, agent_id: str | None
    ) -> None:
        self._nudge_operation(
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

    def renamed(self, tenant_id: str, controller_id: str) -> None:
        """The controller's owner renamed it. A rename bumps no assignment
        revision, so it needs a signal of its own for the other processes to
        re-read the name their bindings carry."""
        self._bus.publish(
            RENAMED_SIGNAL, tenant_id=tenant_id, controller_id=controller_id
        )

    # ── Receiving, in every other process ─────────────────────────────────────

    def _on_assignment_changed(self, signal: dict[str, Any]) -> None:
        # Nudged at once, as before bindings were re-read here: the
        # controller's pull may land on any process, so waiting for this
        # one's read would only delay it.
        self._nudge_assignment(signal["controller_id"], signal["revision"])
        self._bindings_owed.add((signal["tenant_id"], signal["controller_id"]))

    def _on_operation_pending(self, signal: dict[str, Any]) -> None:
        self._nudge_operation(
            signal["controller_id"],
            operation_id=signal["operation_id"],
            kind=signal["operation_kind"],
            agent_id=signal["agent_id"],
        )

    def _on_revoked(self, signal: dict[str, Any]) -> None:
        self._revoke_here(signal["controller_id"])

    def _on_renamed(self, signal: dict[str, Any]) -> None:
        self._bindings_owed.add((signal["tenant_id"], signal["controller_id"]))

    async def _reconcile_controller(self, key: tuple[str, str]) -> None:
        tenant_id, controller_id = key
        await reconcile_controller_bindings(
            session_factory=self._session_factory,
            definitions=self._definitions,
            controllers=self._controllers,
            presence=self._presence,
            tenant_id=tenant_id,
            controller_id=controller_id,
        )

    # ── Acting here ───────────────────────────────────────────────────────────

    def _nudge_assignment(self, controller_id: str, revision: int) -> None:
        if revision > self._nudged_revision.get(controller_id, -1):
            self._nudged_revision[controller_id] = revision
        self.notifier.assignment_changed(controller_id, revision)

    def _nudge_operation(
        self, controller_id: str, *, operation_id: str, kind: str, agent_id: str | None
    ) -> None:
        self._nudged_operations.setdefault(controller_id, set()).add(operation_id)
        self.notifier.operation_pending(
            controller_id, operation_id=operation_id, kind=kind, agent_id=agent_id
        )

    def _revoke_here(self, controller_id: str) -> None:
        """The stream ends, the controller cannot open another here, and this
        process's token cache forgets it."""
        self.notifier.credential_revoked(controller_id)
        self._presence.revoke_controller(controller_id)

    # ── Resync and re-check ───────────────────────────────────────────────────

    async def resync(self) -> None:
        """Re-read every binding, then re-nudge every controller this process
        holds from what the database says now: its assignment revision and
        its open operations, or its revocation."""
        await self._reconcile_all_bindings()
        await self._renudge_held(only_new=False)

    async def recheck(self) -> None:
        """What `resync` does, but a held controller is nudged only with what
        this process has not told it yet."""
        await self._reconcile_all_bindings()
        await self._renudge_held(only_new=True)

    async def _reconcile_all_bindings(self) -> None:
        try:
            await reconcile_bindings(
                session_factory=self._session_factory,
                definitions=self._definitions,
                controllers=self._controllers,
                presence=self._presence,
            )
        except Exception:
            logger.error("Could not re-read controller bindings", exc_info=True)

    async def _renudge_held(self, *, only_new: bool) -> None:
        held = self._presence.held_connections()
        # What a controller held elsewhere was told is no use here: if it
        # connects to this process later, its opening frame carries the state.
        held_ids = {conn.controller_id for conn in held}
        for remembered in (self._nudged_revision, self._nudged_operations):
            for controller_id in set(remembered) - held_ids:
                del remembered[controller_id]
        for conn in held:
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
                revision = controller.assignment_revision
                if not only_new or revision > self._nudged_revision.get(
                    conn.controller_id, -1
                ):
                    self._nudge_assignment(conn.controller_id, revision)
                told = self._nudged_operations.get(conn.controller_id, set())
                for operation in offered:
                    if only_new and operation.id in told:
                        continue
                    self._nudge_operation(
                        conn.controller_id,
                        operation_id=operation.id,
                        kind=operation.kind,
                        agent_id=operation.agent_id,
                    )
                # Only the operations still offered need remembering.
                self._nudged_operations[conn.controller_id] = {
                    operation.id for operation in offered
                }
            except Exception:
                logger.error(
                    "Could not resync controller %s", conn.controller_id, exc_info=True
                )
