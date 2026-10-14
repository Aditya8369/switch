"""Sign-in flows in Postgres, as two switch-core processes see them.

Through the restricted runtime role, so the tenant policies apply: the
browser's steps find a flow's tenant through `tenant_of_sign_in_flow` and
nothing else, and a superuser connection would pass whether or not that
worked.
"""

from __future__ import annotations

import asyncio
import uuid

import pytest
from sqlalchemy import select

from switch_core.connections.sign_in_flows import (
    FlowGoneError,
    FlowUsedError,
    SignInFlows,
    StoredFlow,
    digest,
)
from switch_core.db.models import SignInFlow, Tenant, User
from tests.conftest import TEST_KEYRING, RLSHarness

pytestmark = pytest.mark.no_ambient_tenant


async def _tenants_and_user(rls_harness: RLSHarness) -> tuple[str, str, str]:
    suffix = uuid.uuid4().hex[:8]
    tenant_a, tenant_b = f"a-{suffix}", f"b-{suffix}"
    async with rls_harness.owner() as session:
        for tenant_id in (tenant_a, tenant_b):
            session.add(Tenant(id=tenant_id, slug=tenant_id, name=tenant_id))
        await session.flush()
        user = User(name="Ada", email=f"ada-{suffix}@example.test", role="user")
        session.add(user)
        await session.commit()
        return tenant_a, tenant_b, user.id


async def _start(
    flows: SignInFlows, tenant_id: str, user_id: str, state: str
) -> StoredFlow:
    return await flows.start(
        kind="service",
        service="example",
        tenant_id=tenant_id,
        user_id=user_id,
        state=state,
        mode="core",
        port=43123,
        redirect_uri="https://switch.example.com/callback",
        owner_label="Ada in A",
        details={"name": "Example"},
        completion_secret="completion-secret",
    )


async def test_a_flow_started_by_one_process_is_found_by_another(
    rls_harness: RLSHarness,
) -> None:
    tenant_a, tenant_b, user_id = await _tenants_and_user(rls_harness)
    first = SignInFlows(rls_harness.restricted, TEST_KEYRING)
    second = SignInFlows(rls_harness.restricted, TEST_KEYRING)

    started = await _start(first, tenant_a, user_id, "state-1")
    # The browser's step carries only the state, and reaches the other process.
    found = await second.find("state-1")

    assert found.tenant_id == tenant_a
    assert found.verifier == started.verifier
    assert found.holds_secret("completion-secret")
    assert not found.holds_secret("something-else")
    with pytest.raises(FlowGoneError):
        await second.get("state-1", tenant_b)
    with pytest.raises(FlowGoneError):
        await second.find("no-such-state")


async def test_two_processes_racing_for_one_step_take_it_once(
    rls_harness: RLSHarness,
) -> None:
    tenant_a, _, user_id = await _tenants_and_user(rls_harness)
    first = SignInFlows(rls_harness.restricted, TEST_KEYRING)
    second = SignInFlows(rls_harness.restricted, TEST_KEYRING)
    flow = await _start(first, tenant_a, user_id, "state-2")

    taken = await asyncio.gather(
        first.advance(flow, expect=("pending",), to="authorizing", changes={}),
        second.advance(flow, expect=("pending",), to="authorizing", changes={}),
    )

    assert sorted(result is None for result in taken) == [False, True]


async def test_a_state_is_used_once_even_in_another_workspace(
    rls_harness: RLSHarness,
) -> None:
    tenant_a, tenant_b, user_id = await _tenants_and_user(rls_harness)
    flows = SignInFlows(rls_harness.restricted, TEST_KEYRING)
    await _start(flows, tenant_a, user_id, "state-3")

    with pytest.raises(FlowUsedError):
        await _start(flows, tenant_b, user_id, "state-3")


async def test_secrets_are_stored_encrypted_or_hashed(
    rls_harness: RLSHarness,
) -> None:
    tenant_a, _, user_id = await _tenants_and_user(rls_harness)
    flows = SignInFlows(rls_harness.restricted, TEST_KEYRING)
    flow = await _start(flows, tenant_a, user_id, "state-4")
    await flows.advance(
        flow,
        expect=("pending",),
        to="ready",
        changes={"encrypted_result": flows.seal({"refresh_token": "SYNTHETIC"})},
    )

    async with rls_harness.owner() as session:
        row = await session.scalar(select(SignInFlow).where(SignInFlow.id == "state-4"))
    assert row is not None
    assert flow.verifier not in row.encrypted_verifier
    assert row.completion_secret_hash == digest("completion-secret")
    assert "SYNTHETIC" not in (row.encrypted_result or "")
    assert (await flows.find("state-4")).result == {"refresh_token": "SYNTHETIC"}
