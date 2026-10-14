"""agent_event_boot: one last draw, for a numbering floor that stays put

Before the agent event outbox, each switch-core process kept an agent's own
events in memory and numbered them from a fresh base on every start: the next
value of `agent_event_boot`, shifted left 32 bits, so numbers after a restart
were above every number handed out before it. The sequence stops at 2,097,150
and does not cycle, so every start used up one value.

Since the outbox, an agent's numbering is kept in `agent_event_heads` and
survives restarts. The base only decides where a brand-new agent's numbering
starts, and it must be above every number an in-memory process handed out.
This draws one last value, above all of those, and processes read it from now
on instead of drawing (`EventBuffer.numbering_base`). Restarts no longer use
up the sequence.

Revision ID: d7a3f9c2e4b8
Revises: c4d8e2f6a913
Create Date: 2026-10-14 00:00:00.000000

"""

from collections.abc import Sequence

from alembic import op

revision: str = "d7a3f9c2e4b8"
down_revision: str | None = "c4d8e2f6a913"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.execute("SELECT nextval('agent_event_boot')")


def downgrade() -> None:
    # Processes from before this revision draw a value on every start, so the
    # sequence moves on by itself; there is nothing to give back.
    pass
