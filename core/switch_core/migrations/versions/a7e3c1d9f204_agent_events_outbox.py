"""Agent events in Postgres: the event buffer's events, offsets and drops

Revision ID: a7e3c1d9f204
Revises: dce217a97f54
Create Date: 2026-10-12

The event buffer kept each agent's queued events in one process's memory, so a
restart lost them and a second replica could not see them. These tables hold
the same thing durably: the events at their offsets, where each agent's
offsets start and have reached, and the newest event deleted from each room so
a reader resuming from before it is told what it missed. An insert announces
itself, as a message does, so the process holding the agent's connection reads
the new rows.
"""

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision = "a7e3c1d9f204"
down_revision = "dce217a97f54"
branch_labels = None
depends_on = None

# Frozen copies of `db/agent_event_notify_ddl.py`, as migrations keep their DDL.
CREATE_NOTIFY_FUNCTION = """
CREATE OR REPLACE FUNCTION switch_notify_agent_event() RETURNS trigger AS $$
BEGIN
    PERFORM pg_notify(
        'switch_agent_event',
        json_build_object('agent_id', NEW.agent_id, 'seq', NEW.seq)::text
    );
    RETURN NULL;
END;
$$ LANGUAGE plpgsql
"""

CREATE_NOTIFY_TRIGGER = """
CREATE TRIGGER agent_events_notify
    AFTER INSERT ON agent_events
    FOR EACH ROW EXECUTE FUNCTION switch_notify_agent_event()
"""

_POLICY = (
    "CREATE POLICY tenant_isolation ON {table} FOR ALL "
    "USING (tenant_id = (SELECT require_tenant_id())) "
    "WITH CHECK (tenant_id = (SELECT require_tenant_id()))"
)


def _tenant(table: str) -> sa.Column:  # type: ignore[type-arg]
    return sa.Column(
        "tenant_id",
        sa.Text(),
        sa.ForeignKey("tenants.id", name=f"fk_{table}_tenant"),
        nullable=False,
    )


def _agent_fk(table: str) -> sa.ForeignKeyConstraint:
    return sa.ForeignKeyConstraint(
        ["tenant_id", "agent_id"],
        ["agents.tenant_id", "agents.id"],
        name=f"fk_{table}_agent",
        ondelete="CASCADE",
    )


def upgrade() -> None:
    op.create_table(
        "agent_events",
        _tenant("agent_events"),
        sa.Column("agent_id", sa.Text(), nullable=False),
        sa.Column("seq", sa.BigInteger(), nullable=False),
        sa.Column("room_id", sa.Text(), nullable=False),
        sa.Column("type", sa.Text(), nullable=False),
        sa.Column("payload", postgresql.JSONB(), nullable=False),
        sa.Column("notifiable", sa.Boolean(), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            nullable=False,
        ),
        sa.PrimaryKeyConstraint("agent_id", "seq"),
        _agent_fk("agent_events"),
    )
    op.create_index("ix_agent_events_created_at", "agent_events", ["created_at"])
    op.create_index(
        "ix_agent_events_agent_room",
        "agent_events",
        ["tenant_id", "agent_id", "room_id"],
    )
    op.create_table(
        "agent_event_heads",
        _tenant("agent_event_heads"),
        sa.Column("agent_id", sa.Text(), nullable=False),
        sa.Column("first_seq", sa.BigInteger(), nullable=False),
        sa.Column("last_seq", sa.BigInteger(), nullable=False),
        sa.PrimaryKeyConstraint("agent_id"),
        _agent_fk("agent_event_heads"),
    )
    op.create_table(
        "agent_event_drops",
        _tenant("agent_event_drops"),
        sa.Column("agent_id", sa.Text(), nullable=False),
        sa.Column("room_id", sa.Text(), nullable=False),
        sa.Column("dropped_through", sa.BigInteger(), nullable=False),
        sa.PrimaryKeyConstraint("agent_id", "room_id"),
        _agent_fk("agent_event_drops"),
    )
    for table in ("agent_events", "agent_event_heads", "agent_event_drops"):
        op.create_index(f"ix_{table}_tenant_id", table, ["tenant_id"])
        op.execute(f"ALTER TABLE {table} ENABLE ROW LEVEL SECURITY")
        op.execute(_POLICY.format(table=table))
    op.execute(CREATE_NOTIFY_FUNCTION)
    op.execute(CREATE_NOTIFY_TRIGGER)


def downgrade() -> None:
    op.execute("DROP TRIGGER IF EXISTS agent_events_notify ON agent_events")
    op.execute("DROP FUNCTION IF EXISTS switch_notify_agent_event()")
    op.drop_table("agent_event_drops")
    op.drop_table("agent_event_heads")
    op.drop_table("agent_events")
