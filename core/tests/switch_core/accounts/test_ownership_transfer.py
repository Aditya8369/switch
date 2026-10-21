"""Handing an owned thing to another member of the workspace.

Against a real database, as the rest of `accounts/`: what a transfer must not
carry over is held in other tables, and the refusals read them.
"""

from __future__ import annotations

import uuid

import pytest
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.accounts.transfer import TransferRefused, transfer_ownership
from switch_core.authz import Principal
from switch_core.db.models import (
    TENANT_ZERO_ID,
    Agent,
    ApiKey,
    AuditEvent,
    Document,
    Package,
    Reference,
    Room,
    ServiceConnection,
    ServiceGrant,
    Template,
    User,
)
from tests.conftest import TEST_KEYRING
from tests.switch_core.accounts.test_account_deletion import _agent, _member, _user


def _reference(owner: User, *, write_visibility: str = "private") -> Reference:
    return Reference(
        owner_id=owner.id,
        read_visibility="public",
        write_visibility=write_visibility,
        type="url",
        name=f"ref-{uuid.uuid4().hex[:6]}",
        description="",
        instructions="",
        value={"url": "https://example.test"},
    )


async def _people(session: AsyncSession) -> tuple[User, User, User]:
    owner = await _user(session, "owner")
    member = await _user(session, "member")
    admin = await _user(session, "admin-member")
    await _member(session, TENANT_ZERO_ID, owner, "member")
    await _member(session, TENANT_ZERO_ID, member, "member")
    await _member(session, TENANT_ZERO_ID, admin, "admin")
    return owner, member, admin


async def _transfer(
    session: AsyncSession, kind: str, resource_id: str, to: User, by: Principal
) -> None:
    await transfer_ownership(
        session,
        tenant_id=TENANT_ZERO_ID,
        kind=kind,
        resource_id=resource_id,
        new_owner_id=to.id,
        caller=by,
        keyring=TEST_KEYRING,
    )


async def test_the_owner_hands_a_reference_to_a_member_and_it_is_audited(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    async with session_factory() as session:
        owner, member, _ = await _people(session)
        reference = _reference(owner)
        session.add(reference)
        await session.commit()

        await _transfer(
            session, "reference", reference.id, member, Principal(owner.id, False)
        )
        await session.commit()

        assert (
            await session.scalar(
                select(Reference.owner_id).where(Reference.id == reference.id)
            )
        ) == member.id
        event = await session.scalar(
            select(AuditEvent).where(AuditEvent.target_id == reference.id)
        )
        assert event is not None
        assert event.action == "ownership.transferred"
        assert event.actor_user_id == owner.id
        assert event.details == {
            "from": owner.id,
            "to": member.id,
            "agent_key_reissued": False,
        }


async def test_a_writer_who_is_not_the_owner_is_refused(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    async with session_factory() as session:
        owner, member, _ = await _people(session)
        reference = _reference(owner, write_visibility="public")
        session.add(reference)
        await session.commit()

        with pytest.raises(TransferRefused) as refused:
            await _transfer(
                session, "reference", reference.id, member, Principal(member.id, False)
            )
        assert refused.value.status == 403
        assert "owner or a workspace admin" in str(refused.value)


async def test_an_admin_may_hand_over_someone_elses_package(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    async with session_factory() as session:
        owner, member, admin = await _people(session)
        package = Package(
            owner_id=owner.id,
            read_visibility="public",
            write_visibility="private",
            name="kit",
            description="",
            instructions="",
        )
        session.add(package)
        await session.commit()

        await _transfer(
            session, "package", package.id, member, Principal(admin.id, True)
        )
        await session.commit()
        assert (
            await session.scalar(
                select(Package.owner_id).where(Package.id == package.id)
            )
        ) == member.id


async def test_someone_outside_the_workspace_cannot_receive_it(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    async with session_factory() as session:
        owner, _, _ = await _people(session)
        outsider = await _user(session, "outsider")
        reference = _reference(owner)
        session.add(reference)
        await session.commit()

        with pytest.raises(TransferRefused) as refused:
            await _transfer(
                session, "reference", reference.id, outsider, Principal(owner.id, False)
            )
        assert refused.value.status == 400
        assert "current member of this workspace" in str(refused.value)


async def test_an_agent_moves_with_a_new_key_its_new_owner_holds(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    async with session_factory() as session:
        owner, member, _ = await _people(session)
        agent = await _agent(session, TENANT_ZERO_ID, owner, "helper")
        await session.commit()
        key = await session.get(ApiKey, agent.api_key_id)
        assert key is not None
        old_hash = key.key_hash

        done = await transfer_ownership(
            session,
            tenant_id=TENANT_ZERO_ID,
            kind="agent",
            resource_id=agent.id,
            new_owner_id=member.id,
            caller=Principal(owner.id, False),
            keyring=TEST_KEYRING,
        )
        await session.commit()

        assert done.retired_key_hash == old_hash
        await session.refresh(key)
        await session.refresh(agent)
        assert agent.owner_id == member.id
        assert key.user_id == member.id
        assert key.key_hash != old_hash


async def test_an_agent_using_its_owners_connections_is_refused(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    async with session_factory() as session:
        owner, member, _ = await _people(session)
        agent = await _agent(session, TENANT_ZERO_ID, owner, "helper")
        session.add(
            ServiceConnection(
                user_id=owner.id,
                service="github",
                status="active",
                consent="read",
                granted_scopes=[],
                account_id="1001",
                external_identity="owner",
                encrypted_secret="x",
                secret_revision=1,
            )
        )
        await session.flush()
        session.add(
            ServiceGrant(
                agent_id=agent.id,
                owner_id=owner.id,
                service="github",
                access="read",
                tool_mode="allow",
                tools=[],
                resources={},
                account_id="1001",
                created_by=owner.id,
            )
        )
        await session.commit()

        with pytest.raises(TransferRefused) as refused:
            await _transfer(
                session, "agent", agent.id, member, Principal(owner.id, False)
            )
        assert refused.value.status == 409
        assert "github" in str(refused.value)
        owner_id, agent_id = owner.id, agent.id
        await session.rollback()
        assert (
            await session.scalar(select(Agent.owner_id).where(Agent.id == agent_id))
        ) == owner_id


async def test_an_agent_that_may_manage_agents_is_refused(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    async with session_factory() as session:
        owner, member, _ = await _people(session)
        agent = await _agent(session, TENANT_ZERO_ID, owner, "manager")
        agent.can_manage_agents = True
        await session.commit()

        with pytest.raises(TransferRefused) as refused:
            await _transfer(
                session, "agent", agent.id, member, Principal(owner.id, False)
            )
        assert "manage its owner's agents" in str(refused.value)


async def test_a_template_name_the_new_owner_already_uses_is_refused(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    async with session_factory() as session:
        owner, member, _ = await _people(session)
        mine = Template(
            owner_id=owner.id, name="same", description="", kind="room", content="x"
        )
        theirs = Template(
            owner_id=member.id, name="same", description="", kind="room", content="y"
        )
        session.add_all([mine, theirs])
        await session.commit()

        with pytest.raises(TransferRefused) as refused:
            await _transfer(
                session, "template", mine.id, member, Principal(owner.id, False)
            )
        assert refused.value.status == 409
        assert "already has a template named same" in str(refused.value)


async def test_a_room_document_and_a_chat_are_refused(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    async with session_factory() as session:
        owner, member, _ = await _people(session)
        chat = Room(
            transport_room_id=f"!{uuid.uuid4().hex}:test",
            name="Chat",
            description="",
            owner_id=owner.id,
            created_by=owner.id,
            metadata_={"chat_operation_id": "op"},
        )
        session.add(chat)
        await session.flush()
        document = Document(
            owner_id=owner.id,
            room_id=chat.id,
            read_visibility="public",
            write_visibility="private",
            name="notes",
            description="",
            instructions="",
            content="",
        )
        session.add(document)
        await session.commit()

        with pytest.raises(TransferRefused) as chat_refused:
            await _transfer(
                session, "room", chat.id, member, Principal(owner.id, False)
            )
        assert "chat can't be transferred" in str(chat_refused.value)
        with pytest.raises(TransferRefused) as document_refused:
            await _transfer(
                session, "document", document.id, member, Principal(owner.id, False)
            )
        assert "Only library documents" in str(document_refused.value)


async def test_an_unknown_kind_is_refused() -> None:
    with pytest.raises(TransferRefused) as refused:
        await transfer_ownership(
            None,  # type: ignore[arg-type]
            tenant_id=TENANT_ZERO_ID,
            kind="workspace",
            resource_id="x",
            new_owner_id="y",
            caller=Principal("z", True),
            keyring=TEST_KEYRING,
        )
    assert refused.value.status == 400


async def test_an_admin_may_not_take_someone_elses_package_for_themselves(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    async with session_factory() as session:
        owner, _member, admin = await _people(session)
        package = Package(
            owner_id=owner.id,
            read_visibility="public",
            write_visibility="private",
            name="kit",
            description="",
            instructions="",
        )
        session.add(package)
        await session.commit()

        with pytest.raises(TransferRefused) as refused:
            await _transfer(
                session, "package", package.id, admin, Principal(admin.id, True)
            )
        assert "to yourself" in str(refused.value)
