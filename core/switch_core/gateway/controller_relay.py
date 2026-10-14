"""Console ⇄ agents controller relay: one request answered by the agent's
controller, and live views of its sessions.

For an agent whose definition places it on a controller. The request goes out
on that controller's stream as `agent.control` and the controller answers it
over the management routes (`ControlRelays`). A session is never started from
here with a caller's config: `warm` only asks the agent's own watcher to start
the session a message to one of its rooms would start. A machine that is
offline or asleep is reported, not woken.

Owner only: an agent that is not the caller's reads as not found, so its
existence does not leak. Nothing relayed is written to the database or the
log.
"""

from __future__ import annotations

import asyncio
import json
import logging
import time
from collections.abc import AsyncIterator
from typing import Annotated, Any
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from fastapi.responses import JSONResponse, StreamingResponse
from pydantic import BaseModel, ConfigDict, Field, ValidationError
from sqlalchemy.ext.asyncio import AsyncSession

from switch_core.bridges.agent.protocol.agent_core import AgentCore
from switch_core.bridges.agent.protocol.control_relay import (
    HEALTH_SUBSCRIPTION,
    RELAY_REQUEST_LIMIT_BYTES,
    RELAY_TIMEOUT_LIMIT_MS,
    ConsoleView,
    ControllerRelay,
    ControlRelays,
    RelayError,
    classify_message,
    subscribe_message,
    warm_room_id,
)
from switch_core.bridges.agent.protocol.controller_presence import ControllerPresence
from switch_core.bridges.agent.protocol.stream import KEEPALIVE_INTERVAL_SECONDS
from switch_core.db.models import AgentDefinition, User, require_tenant_id
from switch_core.db.stores.agent_definition_store import AgentDefinitionStore
from switch_core.db.stores.room_store import RoomStore
from switch_core.gateway.auth import get_current_user, get_current_user_in_transaction
from switch_core.gateway.dependencies import get_protocol, get_session

logger = logging.getLogger(__name__)

#: A subscription the stream asks the controller for itself waits this long.
SUBSCRIPTION_RELAY_TIMEOUT_MS = 30_000
MAX_STREAM_SUBSCRIPTIONS = 32


class RelayRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    message: dict[str, Any]
    timeout_ms: int = Field(gt=0, le=RELAY_TIMEOUT_LIMIT_MS)


def relay_error(error: RelayError, worker: dict[str, Any] | None) -> JSONResponse:
    body: dict[str, Any] = {
        "ok": False,
        "error": {"code": error.code, "message": str(error)},
        "worker": worker,
    }
    return JSONResponse(status_code=error.status, content=body)


async def request_body(request: Request) -> bytes:
    """The body, read ahead of the caller's user.

    The relay takes the user with its transaction left open, so the body has
    to be in hand before that transaction starts: from the user read to the
    rollback nothing waits on the client.
    """
    return await request.body()


def stream_frame(event: str, data: dict[str, Any]) -> bytes:
    return (
        f"event: {event}\ndata: {json.dumps(data, separators=(',', ':'))}\n\n".encode()
    )


def controller_info(generation: int | None) -> dict[str, Any]:
    """The relay's far end in the hosted relay's `worker` shape: the
    controller's current stream, which the Console resets its live views on."""
    return {"launch_revision": None, "boot_id": None, "generation": generation}


def live_controller(
    presence: ControllerPresence, relays: ControlRelays, agent_id: str
) -> tuple[str | None, int | None]:
    """The agent's controller, and its current stream while it is live."""
    binding = presence.binding(agent_id)
    if binding is None:
        return None, None
    if not presence.is_live(agent_id):
        return binding.controller_id, None
    return binding.controller_id, relays.generation(binding.controller_id)


async def owned_definition(
    session: AsyncSession, tenant_id: str, agent_id: str, user: User
) -> AgentDefinition:
    row = await AgentDefinitionStore().get_for_agent(session, tenant_id, agent_id)
    if row is None or row.owner_id != user.id:
        raise HTTPException(404, "Managed agent not found.")
    return row


def control_target(
    presence: ControllerPresence,
    relays: ControlRelays,
    row: AgentDefinition,
) -> str:
    """The controller to send the agent's control request to, or why there is none."""
    if row.controller_id is None:
        raise RelayError(
            "agent_unplaced", "The agent is not placed on any machine.", 409
        )
    binding = presence.binding(row.agent_id)
    if binding is None or binding.controller_id != row.controller_id:
        raise RelayError(
            "controller_changing",
            "The agent is moving to another machine. Retry shortly.",
            409,
        )
    if presence.is_revoked(binding.controller_id):
        raise RelayError(
            "controller_revoked", "The machine running this agent was removed.", 409
        )
    if not binding.running:
        raise RelayError("agent_stopped", "The agent is stopped.", 409)
    if (
        presence.is_live(row.agent_id)
        and relays.generation(binding.controller_id) is not None
    ):
        return binding.controller_id
    raise RelayError(
        "controller_offline",
        f"The machine running this agent ({binding.controller_name}) is offline.",
        503,
    )


def ask_controller(
    relays: ControlRelays,
    tenant_id: str,
    controller_id: str,
    agent_id: str,
    subscription: str,
    on: bool,
) -> None:
    """Subscribe or unsubscribe the controller for Console views; the answer is
    not awaited.

    A subscribe the controller's queue cannot take is shown on every view of
    it and asked again on the next pass. An unsubscribe that cannot be sent is
    not lost either: the controller's next push for it is answered
    `subscribed: false`.
    """
    try:
        relays.dispatch(
            tenant_id=tenant_id,
            controller_id=controller_id,
            agent_id=agent_id,
            message=subscribe_message(subscription, on),
            timeout_ms=SUBSCRIPTION_RELAY_TIMEOUT_MS,
        )
    except RelayError as error:
        if on:
            relays.views.subscribe_failed(agent_id, subscription, error)
            return
        logger.warning(
            "Could not close controller subscription for agent %s: %s; the "
            "controller's next push is refused instead",
            agent_id,
            error.code,
        )


async def control_events(
    presence: ControllerPresence,
    relays: ControlRelays,
    tenant_id: str,
    agent_id: str,
    view: ConsoleView,
    keepalive_seconds: float,
) -> AsyncIterator[bytes]:
    views = relays.views
    views.open(agent_id, view)
    sent: dict[str, Any] | None = None
    last_write = time.monotonic()
    try:
        while True:
            controller_id, generation = live_controller(presence, relays, agent_id)
            info = controller_info(generation)
            if info != sent:
                sent = info
                last_write = time.monotonic()
                yield stream_frame("worker", info)
            if controller_id is not None and generation is not None:
                for name in views.unsubscribed(agent_id, generation):
                    ask_controller(
                        relays, tenant_id, controller_id, agent_id, name, True
                    )
            view.wake.clear()
            for event, data in view.drain():
                last_write = time.monotonic()
                yield stream_frame(event, data)
            try:
                await asyncio.wait_for(view.wake.wait(), timeout=1.0)
            except TimeoutError:
                pass
            if time.monotonic() - last_write >= keepalive_seconds:
                last_write = time.monotonic()
                yield b": keepalive\n\n"
    finally:
        controller_id, generation = live_controller(presence, relays, agent_id)
        for name, asked in views.close(agent_id, view):
            if controller_id is not None and generation is not None:
                if asked == generation:
                    ask_controller(
                        relays, tenant_id, controller_id, agent_id, name, False
                    )


def relay_answer(relay: ControllerRelay, answer: dict[str, Any]) -> JSONResponse:
    return JSONResponse(
        content={
            **answer,
            "worker": controller_info(relay.generation),
        }
    )


def controller_relay_router(relays: ControlRelays) -> APIRouter:
    router = APIRouter(tags=["agent management"])

    @router.post("/agents/{agent_id}/control", response_model=None)
    async def control(
        agent_id: str,
        raw: Annotated[bytes, Depends(request_body)],
        user: Annotated[User, Depends(get_current_user_in_transaction)],
        session: Annotated[AsyncSession, Depends(get_session)],
        protocol: Annotated[AgentCore, Depends(get_protocol)],
    ) -> JSONResponse:
        """One control message for the agent, answered by its controller.

        Waits for the answer up to `timeout_ms`; past it the outcome is
        unknown (`relay_timeout`) and the controller is told to drop it.
        """
        if len(raw) > RELAY_REQUEST_LIMIT_BYTES:
            return relay_error(
                RelayError("too_large", "A relay request is at most 2 MiB.", 413),
                None,
            )
        try:
            body = RelayRequest.model_validate_json(raw)
        except ValidationError as exc:
            raise HTTPException(422, exc.errors(include_input=False)) from exc
        tenant_id = require_tenant_id()
        row = await owned_definition(session, tenant_id, agent_id, user)
        presence = protocol.connections.controllers
        try:
            classify_message(body.message)
            room_id = warm_room_id(body.message)
            if room_id is not None:
                found = await RoomStore().get_with_membership(
                    session, room_id, agent_id
                )
                if found is None or not found[1]:
                    raise RelayError(
                        "not_a_member", "The agent is not a member of that room.", 403
                    )
            controller_id = control_target(presence, relays, row)
            await session.rollback()
            relay = relays.dispatch(
                tenant_id=tenant_id,
                controller_id=controller_id,
                agent_id=agent_id,
                message=body.message,
                timeout_ms=body.timeout_ms,
            )
            answer = await asyncio.shield(relay.future)
        except RelayError as error:
            return relay_error(
                error, controller_info(live_controller(presence, relays, agent_id)[1])
            )
        return relay_answer(relay, answer)

    @router.get("/agents/{agent_id}/control/stream", response_model=None)
    async def control_stream(
        agent_id: str,
        user: Annotated[User, Depends(get_current_user)],
        session: Annotated[AsyncSession, Depends(get_session)],
        protocol: Annotated[AgentCore, Depends(get_protocol)],
        subscribe: Annotated[list[UUID] | None, Query()] = None,
        watch_health: Annotated[bool, Query(alias="watchHealth")] = False,
    ) -> StreamingResponse:
        """Live events of the subscribed sessions (and health) as SSE, in the
        hosted relay stream's frames."""
        tenant_id = require_tenant_id()
        await owned_definition(session, tenant_id, agent_id, user)
        names = {str(session_id) for session_id in subscribe or []}
        if len(names) > MAX_STREAM_SUBSCRIPTIONS:
            raise HTTPException(422, "Too many subscriptions on one relay stream.")
        if watch_health:
            names.add(HEALTH_SUBSCRIPTION)
        await session.rollback()
        return StreamingResponse(
            control_events(
                protocol.connections.controllers,
                relays,
                tenant_id,
                agent_id,
                ConsoleView(frozenset(names)),
                KEEPALIVE_INTERVAL_SECONDS,
            ),
            media_type="text/event-stream",
            headers={"Cache-Control": "no-store", "X-Accel-Buffering": "no"},
        )

    return router
