"""remember which agent created a managed agent; limit an agent to templates

`agent_definitions.created_by_agent_id` names the agent that created a managed
agent for its owner (`create_agent`, or a template or document it ran); null
when a person created it. The per-owner caps on agent-created agents count
these rows, and an agent may delete only the agents it created.

`agents.manage_agents_templates` narrows an agent's "can manage agents"
capability to the listed saved templates: when it is set, the agent may only
run those templates, and may not create agents any other way. Null leaves
the capability as it was.

Expand only: both columns are nullable, and a process from before this
revision never reads them.

Revision ID: a3c9e5d1b7f2
Revises: c7715ebb95c9
Create Date: 2026-10-17 12:00:00.000000

"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "a3c9e5d1b7f2"
down_revision: str | None = "c7715ebb95c9"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None
expand_only: bool = True


def upgrade() -> None:
    op.add_column(
        "agent_definitions",
        sa.Column("created_by_agent_id", sa.Text(), nullable=True),
    )
    op.create_index(
        "ix_agent_definitions_created_by_agent_id",
        "agent_definitions",
        ["created_by_agent_id"],
    )
    op.add_column(
        "agents",
        sa.Column(
            "manage_agents_templates",
            postgresql.JSONB(astext_type=sa.Text()),
            nullable=True,
        ),
    )


def downgrade() -> None:
    op.drop_column("agents", "manage_agents_templates")
    op.drop_index(
        "ix_agent_definitions_created_by_agent_id", table_name="agent_definitions"
    )
    op.drop_column("agent_definitions", "created_by_agent_id")
