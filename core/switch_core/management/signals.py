"""Management's changes, carried to every switch-core process.

A change commits in the process that handled the request; the controller it
affects may be streaming from any process, and every process keeps its own
copy of Core's bindings and controller presence. So every change is acted on
here at once and published on the `SignalBus` for the others, which do the same
on receipt.

Nudges (`assignment_changed`, `operation_pending`, `revoked`) were already
wake-ups, never the record: a controller woken pulls its assignment or its
operations. Bindings and connections are re-read from the database by each
process told of them, rather than carried in the signal, so a signal that
arrives late or out of order changes nothing the database does not say:

- `binding_changed`: an agent was placed on a controller, moved, stopped,
  started or unmanaged. Each process reads the agent's binding again and binds
  or unbinds it in its own presence, which also closes the agent's own
  connections it held once a controller runs the agent.
- `renamed`: a controller was renamed, which its agents' bindings carry.
- `connection_changed`: a controller opened a connection, a process took one
  up, or a socket attached or went. Each process reads the controller's row
  again: which process holds the live socket, so an agent run by a controller
  connected anywhere reads as live everywhere; and whether a connection this
  process holds was replaced or taken up elsewhere, in which case it is closed
  `taken_over`.

Resync keeps all of it true across processes. When the signal connection comes
back, and every `RECONCILE_SECONDS`, every process reads the bindings and the
controllers' connections again, and re-nudges every controller it holds.
"""

from __future__ import annotations

import asyncio
import logging
from collections.abc import Callable
from datetime import datetime
from typing import TYPE_CHECKING, Any

from switch_core.bridges.agent.protocol.controller_presence import DETACH_UNASSIGNED
from switch_core.db.session_scope import tenant_session
from switch_core.db.tenant_lookup import all_tenant_ids
from switch_core.management.bindings import binding_for, read_bindings
from switch_core.process_lease import ProcessLeases, read_leases
from switch_core.tenant_context import no_tenant

if TYPE_CHECKING:
    from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

    from switch_core.bridges.agent.protocol.controller_presence import (
        ControllerPresence,
    )
    from switch_core.db.models import AgentController
    from switch_core.db.stores.agent_controller_operation_store import (
        AgentControllerOperationStore,
    )
    from switch_core.db.stores.agent_controller_store import AgentControllerStore
    from switch_core.db.stores.agent_definition_store import AgentDefinitionStore
    from switch_core.db.stores.room_store import RoomStore
    from switch_core.db.stores.switch_core_process_store import (
        SwitchCoreProcessStore,
    )
    from switch_core.management.notifier import ControllerNotifier
    from switch_core.signals import SignalBus

logger = logging.getLogger(__name__)

ASSIGNMENT_CHANGED_SIGNAL = "controller.assignment_changed"
OPERATION_PENDING_SIGNAL = "controller.operation_pending"
REVOKED_SIGNAL = "controller.revoked"
BINDING_CHANGED_SIGNAL = "controller.binding_changed"
RENAMED_SIGNAL = "controller.renamed"
CONNECTION_CHANGED_SIGNAL = "controller.connection_changed"

# How often every process reads the bindings and the controllers' connections
# again in full, in case a signal was lost on its way.
RECONCILE_SECONDS = 30.0

# How many times a read is made again when the presence changed here while it
# was being made, before it is left to the next full pass.
_READ_ATTEMPTS = 3


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
        definitions: AgentDefinitionStore,
        rooms: RoomStore,
        processes: SwitchCoreProcessStore,
        clock: Callable[[], datetime],
    ) -> None:
        self.notifier = notifier
        # The process this is, as signals and the rows naming a holder call it.
        self.process_id = bus.process_id
        self._presence = presence
        self._bus = bus
        self._session_factory = session_factory
        self._controllers = controllers
        self._operations = operations
        self._definitions = definitions
        self._rooms = rooms
        self._processes = processes
        self._clock = clock
        self._tasks: set[asyncio.Task[None]] = set()
        # Set once `reconcile_forever` ends: a signal arriving after that
        # starts no read.
        self._stopped = False
        bus.handle(ASSIGNMENT_CHANGED_SIGNAL, self._on_assignment_changed)
        bus.handle(OPERATION_PENDING_SIGNAL, self._on_operation_pending)
        bus.handle(REVOKED_SIGNAL, self._on_revoked)
        bus.handle(BINDING_CHANGED_SIGNAL, self._on_binding_changed)
        bus.handle(RENAMED_SIGNAL, self._on_renamed)
        bus.handle(CONNECTION_CHANGED_SIGNAL, self._on_connection_changed)
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

    def binding_changed(self, tenant_id: str, agent_id: str, reason: str) -> None:
        """The agent's binding changed and this process's presence has it
        already. `reason` is why an unbound agent left its controller, for the
        process holding that controller's stream to say."""
        self._bus.publish(
            BINDING_CHANGED_SIGNAL,
            tenant_id=tenant_id,
            agent_id=agent_id,
            reason=reason,
        )

    def renamed(self, tenant_id: str, controller_id: str) -> None:
        self._bus.publish(
            RENAMED_SIGNAL, tenant_id=tenant_id, controller_id=controller_id
        )

    def connection_changed(self, tenant_id: str, controller_id: str) -> None:
        """The controller's connection row changed, and this process already
        acts on it."""
        self._bus.publish(
            CONNECTION_CHANGED_SIGNAL, tenant_id=tenant_id, controller_id=controller_id
        )

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

    def _spawn(self, work: Any) -> None:
        if self._stopped:
            work.close()
            return
        task = asyncio.create_task(work)
        self._tasks.add(task)
        task.add_done_callback(self._tasks.discard)

    def _on_binding_changed(self, signal: dict[str, Any]) -> None:
        self._spawn(
            self._logged(
                self._read_binding(
                    signal["tenant_id"], signal["agent_id"], signal["reason"]
                ),
                f"agent {signal['agent_id']}'s binding",
            )
        )

    def _on_renamed(self, signal: dict[str, Any]) -> None:
        self._spawn(
            self._logged(
                self._read_name(signal["tenant_id"], signal["controller_id"]),
                f"controller {signal['controller_id']}'s name",
            )
        )

    def _on_connection_changed(self, signal: dict[str, Any]) -> None:
        self._spawn(
            self._logged(
                self._read_connection(signal["tenant_id"], signal["controller_id"]),
                f"controller {signal['controller_id']}'s connection",
            )
        )

    async def _logged(self, work: Any, what: str) -> None:
        try:
            await work
        except asyncio.CancelledError:
            raise
        except Exception:
            logger.error(
                "Could not read %s again after another process changed it; the "
                "next full pass will",
                what,
                exc_info=True,
            )

    async def _read_binding(self, tenant_id: str, agent_id: str, reason: str) -> None:
        for _ in range(_READ_ATTEMPTS):
            version = self._presence.version(agent_id)
            async with tenant_session(self._session_factory, tenant_id) as session:
                binding = await binding_for(
                    session,
                    tenant_id,
                    agent_id,
                    definitions=self._definitions,
                    controllers=self._controllers,
                )
            if self._presence.version(agent_id) != version:
                # Changed here while it was read: what was read may be older.
                continue
            if binding is None:
                if self._presence.is_bound(agent_id):
                    self._presence.unbind(agent_id, reason)
            elif self._presence.binding(agent_id) != binding:
                self._presence.bind(binding)
                await self._read_rooms_if_held_elsewhere(tenant_id, agent_id)
            return

    async def _read_rooms_if_held_elsewhere(
        self, tenant_id: str, agent_id: str
    ) -> None:
        """An agent just bound to a controller another process holds: its
        rooms are read here, as they are for the controller's other agents
        (`_rooms_if_held_elsewhere`), so it is present in them at once."""
        if self._presence.process_holding(agent_id) is None:
            return
        async with tenant_session(self._session_factory, tenant_id) as session:
            rooms = await self._rooms.get_rooms_for_agent(
                session, agent_id, include_archived=True
            )
        self._presence.set_rooms(agent_id, {room.id for room in rooms})

    async def _read_name(self, tenant_id: str, controller_id: str) -> None:
        async with tenant_session(self._session_factory, tenant_id) as session:
            controller = await self._controllers.get(session, tenant_id, controller_id)
        if controller is not None:
            self._presence.rename_controller(controller_id, controller.name)

    async def _read_connection(self, tenant_id: str, controller_id: str) -> None:
        for _ in range(_READ_ATTEMPTS):
            version = self._presence.version(controller_id)
            async with tenant_session(self._session_factory, tenant_id) as session:
                controller = await self._controllers.get(
                    session, tenant_id, controller_id
                )
                if controller is None:
                    return
                leases = await read_leases(session, self._processes)
                rooms = await self._rooms_if_held_elsewhere(session, controller, leases)
            if self._presence.version(controller_id) != version:
                # Changed here while it was read: what was read may be older.
                continue
            self._apply_connection(controller, leases, rooms)
            return

    async def _rooms_if_held_elsewhere(
        self,
        session: AsyncSession,
        controller: AgentController,
        leases: ProcessLeases,
    ) -> dict[str, set[str]]:
        """The rooms of each agent the controller runs, when another process
        holds its socket: they are what makes those agents present in a room
        here, and the stream that loads them runs over there."""
        if self._held_elsewhere(controller, leases) is None:
            return {}
        return {
            agent_id: {
                room.id
                for room in await self._rooms.get_rooms_for_agent(
                    session, agent_id, include_archived=True
                )
            }
            for agent_id in sorted(self._presence.agents_of(controller.id))
        }

    def _held_elsewhere(
        self, controller: AgentController, leases: ProcessLeases
    ) -> str | None:
        """The other process holding the controller's live socket, if any."""
        process_id = controller.connection_process_id
        if (
            controller.connection_id is None
            or controller.disconnected_at is not None
            or process_id is None
            or process_id == self.process_id
            or not leases.holds(process_id)
        ):
            return None
        return process_id

    def _apply_connection(
        self,
        controller: AgentController,
        leases: ProcessLeases,
        rooms: dict[str, set[str]],
    ) -> None:
        local = self._presence.current_connection(controller.id)
        if local is not None and controller.open_connection_id is not None:
            # The row names the connection the controller opened last and the
            # process holding it. A connection held here that is not that one,
            # or is that one but taken up by another process, is over here.
            if (
                controller.open_connection_id != local.id
                or controller.open_process_id != self.process_id
            ):
                self._presence.supersede(controller.id)
        self._presence.held_elsewhere(
            controller.id, self._held_elsewhere(controller, leases)
        )
        for agent_id, agent_rooms in rooms.items():
            self._presence.set_rooms(agent_id, agent_rooms)

    # ── Resync ────────────────────────────────────────────────────────────────

    async def resync(self) -> None:
        """Re-nudge every controller this process holds from what the database
        says now (its assignment revision and its open operations, or its
        revocation), then read the bindings and every controller's connection
        again."""
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
        await self.reconcile()

    async def reconcile(self) -> None:
        """Read every binding and every controller's connection again, and
        make this process's presence agree. Logs rather than raises: the next
        pass tries again."""
        try:
            await self._reconcile_bindings()
            await self._reconcile_connections()
        except asyncio.CancelledError:
            raise
        except Exception:
            logger.error(
                "Could not read the controller bindings and connections again",
                exc_info=True,
            )

    async def _reconcile_bindings(self) -> None:
        bound_before = self._presence.bound_agent_ids()
        versions = {
            agent_id: self._presence.version(agent_id) for agent_id in bound_before
        }
        with no_tenant():
            recorded = await read_bindings(
                session_factory=self._session_factory,
                definitions=self._definitions,
                controllers=self._controllers,
            )
        placed = {binding.agent_id: binding for binding in recorded.bindings}

        def unchanged(agent_id: str) -> bool:
            # Bound or unbound here since the read began: newer than the read.
            return self._presence.version(agent_id) == versions.get(agent_id, 0)

        for agent_id in bound_before - set(placed):
            if unchanged(agent_id):
                self._presence.unbind(agent_id, DETACH_UNASSIGNED)
        for binding in recorded.bindings:
            if (
                unchanged(binding.agent_id)
                and self._presence.binding(binding.agent_id) != binding
            ):
                self._presence.bind(binding)
        for controller_id in recorded.revoked:
            if not self._presence.is_revoked(controller_id):
                self._presence.revoke_controller(controller_id)

    async def _reconcile_connections(self) -> None:
        seen: set[str] = set()
        elsewhere = self._presence.controllers_elsewhere()
        with no_tenant():
            tenant_ids = await all_tenant_ids(self._session_factory)
        for tenant_id in tenant_ids:
            versions = self._presence.versions()
            async with tenant_session(self._session_factory, tenant_id) as session:
                leases = await read_leases(session, self._processes)
                found = [
                    controller
                    for controller in await self._controllers.list_with_connections(
                        session, tenant_id
                    )
                    if controller.tenant_id == tenant_id
                ]
                rooms = {
                    controller.id: await self._rooms_if_held_elsewhere(
                        session, controller, leases
                    )
                    for controller in found
                }
            for controller in found:
                seen.add(controller.id)
                if self._presence.version(controller.id) != versions.get(
                    controller.id, 0
                ):
                    # Changed here while it was read; read it again on its own.
                    await self._read_connection(tenant_id, controller.id)
                    continue
                self._apply_connection(controller, leases, rooms[controller.id])
        for controller_id in elsewhere - seen:
            self._presence.held_elsewhere(controller_id, None)

    async def reconcile_forever(self) -> None:
        """Reconcile every `RECONCILE_SECONDS`, until cancelled."""
        try:
            while True:
                await asyncio.sleep(RECONCILE_SECONDS)
                await self.reconcile()
        finally:
            self._stopped = True
            # Waited for, so none is left holding a database connection
            # mid-transaction once the process has moved on.
            pending = list(self._tasks)
            for task in pending:
                task.cancel()
            await asyncio.gather(*pending, return_exceptions=True)
