"""Building the management module and attaching it to the two apps.

`create_management` returns None when the `agent_management` feature flag is off, and
with None nothing is mounted and the bearer middleware has no controller
branch. When it is on, the authenticator goes to the middleware as the agent
bridge app is built, `install` adds the routes once both apps exist, and
`load_bindings` tells Core which controller runs each agent before the bridge
serves. `install` also hands Core the agent-facing side
(`ManagementAgentOperations`), which is what makes the agent operations on
machines and managed agents exist.

Each process writes its controllers' connection transitions
(`connection_ledger.py`) under the lease the process holds whatever features
it runs (`switch_core.process_lease`, claimed and renewed by the core
wiring). `start` reads which controllers the other processes hold before the
bridge serves, `run` writes transitions and reads the bindings and the other
processes' controllers again now and then until cancelled, and `stop` writes
what is left, before the core wiring marks the lease stopped.
"""

from __future__ import annotations

import asyncio
from collections.abc import Callable
from dataclasses import dataclass
from datetime import UTC, datetime

from fastapi import FastAPI
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.bridges.agent.controller_auth_cache import ControllerAuthCache
from switch_core.bridges.agent.operations.agent_management import (
    enable_agent_management,
)
from switch_core.bridges.agent.protocol.agent_core import AgentCore
from switch_core.bridges.agent.protocol.controller_presence import ControllerPresence
from switch_core.config import SwitchConfig
from switch_core.db.session_scope import tenant_session
from switch_core.db.stores.agent_controller_operation_store import (
    AgentControllerOperationStore,
)
from switch_core.db.stores.agent_controller_store import AgentControllerStore
from switch_core.db.stores.agent_definition_store import AgentDefinitionStore
from switch_core.db.stores.agent_store import AgentStore
from switch_core.db.stores.api_key_store import ApiKeyStore
from switch_core.db.stores.room_store import RoomStore
from switch_core.db.stores.switch_core_process_store import SwitchCoreProcessStore
from switch_core.gateway.cloud_controllers import set_cloud_enrollment
from switch_core.management.agent_operations import ManagementAgentOperations
from switch_core.management.auth import ManagementAuthenticator
from switch_core.management.bindings import load_bindings
from switch_core.management.connection_ledger import ControllerConnectionLedger
from switch_core.management.controller_routes import router as controller_router
from switch_core.management.dependencies import init_management_dependencies
from switch_core.management.gateway_routes import router as gateway_router
from switch_core.management.notifier import ControllerNotifier
from switch_core.management.service import ManagementService, ManagementSettings
from switch_core.management.signals import ControllerSignals
from switch_core.signals import SignalBus

GATEWAY_PREFIX = "/management"


def utc_now() -> datetime:
    return datetime.now(UTC)


@dataclass(frozen=True)
class Management:
    service: ManagementService
    authenticator: ManagementAuthenticator
    agent_operations: ManagementAgentOperations
    session_factory: async_sessionmaker[AsyncSession]
    ledger: ControllerConnectionLedger

    def install(
        self,
        *,
        agent_bridge_app: FastAPI,
        gateway_app: FastAPI,
        protocol: AgentCore,
    ) -> None:
        init_management_dependencies(
            service=self.service,
            authenticator=self.authenticator,
            session_factory=self.session_factory,
        )
        agent_bridge_app.include_router(controller_router)
        gateway_app.include_router(gateway_router, prefix=GATEWAY_PREFIX)
        protocol.set_agent_removal_listener(self.agent_removed)
        enable_agent_management(self.agent_operations)

    async def agent_removed(self, tenant_id: str, agent_id: str) -> None:
        async with tenant_session(self.session_factory, tenant_id) as session:
            await self.service.forget_deleted_agent(session, tenant_id, agent_id)

    async def start(self) -> None:
        """Read which controllers the other processes hold, before the bridge
        serves: until then every agent they run reads offline here."""
        await self.service.signals.reconcile()

    async def run(self) -> None:
        """Write connection transitions, and read the bindings and the other
        processes' controllers again now and then, until cancelled."""
        # A task group rather than `gather`: cancelled, it waits for both to
        # unwind, so neither is left holding a database connection.
        async with asyncio.TaskGroup() as group:
            group.create_task(self.ledger.run())
            group.create_task(self.service.signals.reconcile_forever())

    async def stop(self) -> None:
        """Write the transitions still queued. The core wiring marks the
        process's lease stopped after this, whether it succeeds or not."""
        await self.ledger.flush_all()

    async def load_bindings(self) -> int:
        return await load_bindings(
            session_factory=self.session_factory,
            definitions=self.service.definitions,
            controllers=self.service.controllers,
            presence=self.service.presence,
        )


def build_management(
    *,
    token_secret: str,
    status_interval_seconds: int,
    server_url: str | None,
    session_factory: async_sessionmaker[AsyncSession],
    presence: ControllerPresence,
    auth_cache: ControllerAuthCache,
    clock: Callable[[], datetime],
    signal_bus: SignalBus,
) -> Management:
    process_id = signal_bus.process_id
    controllers = AgentControllerStore()
    operations = AgentControllerOperationStore()
    definitions = AgentDefinitionStore()
    processes = SwitchCoreProcessStore()
    presence.use_auth_cache(auth_cache)
    signals = ControllerSignals(
        notifier=ControllerNotifier(),
        presence=presence,
        bus=signal_bus,
        session_factory=session_factory,
        controllers=controllers,
        operations=operations,
        definitions=definitions,
        rooms=RoomStore(),
        processes=processes,
        clock=clock,
    )
    ledger = ControllerConnectionLedger(
        process_id=process_id,
        session_factory=session_factory,
        controllers=controllers,
        clock=clock,
        announce=signals.connection_changed,
    )
    presence.use_ledger(ledger)
    service = ManagementService(
        settings=ManagementSettings(
            token_secret=token_secret,
            status_interval_seconds=status_interval_seconds,
            server_url=server_url,
        ),
        signals=signals,
        controllers=controllers,
        definitions=definitions,
        operations=operations,
        api_keys=ApiKeyStore(),
        agents=AgentStore(),
        processes=processes,
        presence=presence,
        clock=clock,
    )
    # Switch cloud machines that run the controller enroll with codes it mints.
    set_cloud_enrollment(service)
    authenticator = ManagementAuthenticator(
        session_factory=session_factory,
        controllers=controllers,
        token_secret=token_secret,
        presence=presence,
        auth_cache=auth_cache,
    )
    return Management(
        service=service,
        authenticator=authenticator,
        agent_operations=ManagementAgentOperations(
            service=service, session_factory=session_factory
        ),
        session_factory=session_factory,
        ledger=ledger,
    )


def create_management(
    config: SwitchConfig,
    session_factory: async_sessionmaker[AsyncSession],
    presence: ControllerPresence,
    signal_bus: SignalBus,
) -> Management | None:
    if not config.agent_management_enabled:
        return None
    if config.controller_token_secret is None:
        raise RuntimeError(
            "The agent_management feature flag is on without CONTROLLER_TOKEN_SECRET; the "
            "config validator should have refused this"
        )
    return build_management(
        token_secret=config.controller_token_secret,
        status_interval_seconds=config.controller_status_interval_seconds,
        server_url=config.gateway_public_url,
        session_factory=session_factory,
        presence=presence,
        # The agent API-key cache's bound: the longest a controller revoked
        # by any path that does not go through `ControllerPresence` could go
        # on authenticating.
        auth_cache=ControllerAuthCache(
            ttl_seconds=config.agent_auth_cache_ttl_seconds,
            max_entries=config.agent_auth_cache_max_entries,
        ),
        clock=utc_now,
        signal_bus=signal_bus,
    )
