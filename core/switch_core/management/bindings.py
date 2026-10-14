"""Telling Core which controller runs each managed agent.

Core keeps the bindings in memory (`ControllerPresence`), so a restart forgets
them, and they must be back before the agent bridge serves: until then a
controller-backed agent would read as directly connected, and its own API key
would be let in. They are read from every tenant, which is a question no
tenant can be scoped to, so the tenants come from the exemption
(`db/tenant_lookup.py`) and each tenant's definitions are then read under its
own policy.

Every process keeps its own copy, so a change committed by one is announced to
the others (`management/signals.py`), which read the agent's binding again
here (`binding_for`), and every process reads them all again now and then
(`read_bindings`) in case an announcement was lost.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass

from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.bridges.agent.protocol.controller_presence import (
    Binding,
    ControllerPresence,
)
from switch_core.db.models import AgentController
from switch_core.db.models import AgentDefinition as AgentDefinitionRow
from switch_core.db.session_scope import tenant_session
from switch_core.db.stores.agent_controller_store import AgentControllerStore
from switch_core.db.stores.agent_definition_store import AgentDefinitionStore
from switch_core.db.tenant_lookup import all_tenant_ids

logger = logging.getLogger(__name__)


def binding_of(
    tenant_id: str, row: AgentDefinitionRow, controller: AgentController
) -> Binding:
    """The binding Core keeps for a definition placed on `controller`."""
    assert row.controller_id == controller.id
    return Binding(
        agent_id=row.agent_id,
        controller_id=controller.id,
        tenant_id=tenant_id,
        controller_name=controller.name,
        running=row.desired_state == "running",
    )


@dataclass(frozen=True)
class RecordedBindings:
    bindings: list[Binding]
    # Controllers already revoked that agents are still placed on.
    revoked: set[str]


async def read_bindings(
    *,
    session_factory: async_sessionmaker[AsyncSession],
    definitions: AgentDefinitionStore,
    controllers: AgentControllerStore,
) -> RecordedBindings:
    """Every placed definition, in every tenant."""
    bindings: list[Binding] = []
    revoked: set[str] = set()
    for tenant_id in await all_tenant_ids(session_factory):
        async with tenant_session(session_factory, tenant_id) as session:
            placed_on: dict[str, AgentController] = {}
            # Filtered on the row's own tenant as well as by the store: see
            # `db/tenant_lookup.py`, "a fan-out ... filters what it reads back".
            for row in await definitions.list_placed(session, tenant_id):
                if row.tenant_id != tenant_id or row.controller_id is None:
                    continue
                controller = placed_on.get(row.controller_id)
                if controller is None:
                    controller = await controllers.get(
                        session, tenant_id, row.controller_id
                    )
                    if controller is None:
                        raise RuntimeError(
                            f"agent {row.agent_id} is placed on controller "
                            f"{row.controller_id}, which does not exist"
                        )
                    placed_on[controller.id] = controller
                if controller.revoked_at is not None:
                    revoked.add(controller.id)
                bindings.append(binding_of(tenant_id, row, controller))
    return RecordedBindings(bindings=bindings, revoked=revoked)


async def binding_for(
    session: AsyncSession,
    tenant_id: str,
    agent_id: str,
    *,
    definitions: AgentDefinitionStore,
    controllers: AgentControllerStore,
) -> Binding | None:
    """The agent's binding as recorded now, or None when it is not placed."""
    row = await definitions.get_for_agent(session, tenant_id, agent_id)
    if row is None or row.controller_id is None:
        return None
    controller = await controllers.get(session, tenant_id, row.controller_id)
    if controller is None:
        raise RuntimeError(
            f"agent {agent_id} is placed on controller {row.controller_id}, "
            "which does not exist"
        )
    return binding_of(tenant_id, row, controller)


async def load_bindings(
    *,
    session_factory: async_sessionmaker[AsyncSession],
    definitions: AgentDefinitionStore,
    controllers: AgentControllerStore,
    presence: ControllerPresence,
) -> int:
    """Load every placed definition into `presence`, and mark the controllers
    already revoked that agents are still placed on. Returns how many."""
    recorded = await read_bindings(
        session_factory=session_factory,
        definitions=definitions,
        controllers=controllers,
    )
    presence.load(recorded.bindings)
    for controller_id in recorded.revoked:
        presence.revoke_controller(controller_id)
    logger.info("Loaded %d controller binding(s) into Core", len(recorded.bindings))
    return len(recorded.bindings)
