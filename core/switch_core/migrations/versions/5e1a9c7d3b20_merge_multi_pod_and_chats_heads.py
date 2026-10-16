"""merge multi-pod and chats migrations

Revision ID: 5e1a9c7d3b20
Revises: be940bbaeaec, b3c7e1d9f2a5
Create Date: 2026-10-16 10:00:00.000000

"""

from collections.abc import Sequence

# revision identifiers, used by Alembic.
revision: str = "5e1a9c7d3b20"
down_revision: str | Sequence[str] | None = ("be940bbaeaec", "b3c7e1d9f2a5")
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    pass


def downgrade() -> None:
    pass
