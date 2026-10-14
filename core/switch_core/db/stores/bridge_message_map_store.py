from sqlalchemy import delete, select, update
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.ext.asyncio import AsyncSession

from switch_core.db.models import BridgeMessageMap


class BridgeMessageMapStore:
    async def claim(
        self,
        session: AsyncSession,
        *,
        bridge_id: str,
        external_channel_id: str,
        transport_event_id: str,
    ) -> bool:
        """Claim a room message for posting to the platform: a row with no
        external post yet. False when the message has a row already, posted
        or claimed by whoever posted it before."""
        result = await session.execute(
            insert(BridgeMessageMap)
            .values(
                bridge_id=bridge_id,
                external_channel_id=external_channel_id,
                transport_event_id=transport_event_id,
                external_post_id=None,
            )
            .on_conflict_do_nothing(
                index_elements=[
                    BridgeMessageMap.bridge_id,
                    BridgeMessageMap.transport_event_id,
                ]
            )
            .returning(BridgeMessageMap.id)
        )
        return result.scalar_one_or_none() is not None

    async def fill(
        self,
        session: AsyncSession,
        *,
        bridge_id: str,
        transport_event_id: str,
        external_post_id: str,
    ) -> None:
        """Record the post a claimed message became on the platform."""
        await session.execute(
            update(BridgeMessageMap)
            .where(
                BridgeMessageMap.bridge_id == bridge_id,
                BridgeMessageMap.transport_event_id == transport_event_id,
                BridgeMessageMap.external_post_id.is_(None),
            )
            .values(external_post_id=external_post_id)
        )

    async def release_claim(
        self, session: AsyncSession, *, bridge_id: str, transport_event_id: str
    ) -> None:
        """Drop a claim the platform never turned into a post."""
        await session.execute(
            delete(BridgeMessageMap).where(
                BridgeMessageMap.bridge_id == bridge_id,
                BridgeMessageMap.transport_event_id == transport_event_id,
                BridgeMessageMap.external_post_id.is_(None),
            )
        )

    async def create(
        self, session: AsyncSession, mapping: BridgeMessageMap
    ) -> BridgeMessageMap:
        session.add(mapping)
        await session.flush()
        return mapping

    async def get_by_transport_event_id(
        self, session: AsyncSession, bridge_id: str, transport_event_id: str
    ) -> BridgeMessageMap | None:
        result = await session.execute(
            select(BridgeMessageMap).where(
                BridgeMessageMap.bridge_id == bridge_id,
                BridgeMessageMap.transport_event_id == transport_event_id,
            )
        )
        return result.scalar_one_or_none()

    async def get_by_external_post_id(
        self, session: AsyncSession, bridge_id: str, external_post_id: str
    ) -> BridgeMessageMap | None:
        result = await session.execute(
            select(BridgeMessageMap).where(
                BridgeMessageMap.bridge_id == bridge_id,
                BridgeMessageMap.external_post_id == external_post_id,
            )
        )
        return result.scalar_one_or_none()

    async def delete_by_transport_event_id(
        self, session: AsyncSession, bridge_id: str, transport_event_id: str
    ) -> None:
        await session.execute(
            delete(BridgeMessageMap).where(
                BridgeMessageMap.bridge_id == bridge_id,
                BridgeMessageMap.transport_event_id == transport_event_id,
            )
        )
        await session.flush()
