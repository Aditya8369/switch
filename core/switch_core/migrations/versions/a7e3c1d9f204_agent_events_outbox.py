"""Agent events in Postgres: what is for each agent, and where each reader is

Revision ID: a7e3c1d9f204
Revises: dce217a97f54
Create Date: 2026-10-12

The event buffer kept each agent's queued events, and every reader's place in
them, in one process's memory, so a restart lost them and a second replica
could not see them. These tables hold them durably:

- `agent_events`: the events that are for an agent (addressed messages,
  listened-for joins, tasks, commands) at the agent's own offsets, each with
  the room row it came from. The rest of a room's conversation is read from
  `messages` and not copied.
- `agent_event_heads`: where each agent's offsets start and have reached, so
  none is handed out twice after old rows are deleted.
- `agent_event_drops`: the newest event deleted from each room, so a reader
  resuming from before it is told what it missed.
- `agent_room_reads`: how far each agent has caught up on each room, and who
  is reading it, so "what did I miss" survives a restart.
- `agent_poll_positions`: where each long-polling client has read up to.
- `agent_position_tickets`: positions handed to clients that hold one number.

An insert into `agent_events` announces itself, as a message does, so the
process holding the agent's connection reads the new rows.
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
        sa.Column("room_seq", sa.BigInteger(), nullable=False),
        sa.Column("message_key", sa.Text(), nullable=True),
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
        "ix_agent_events_agent_room_seq",
        "agent_events",
        ["tenant_id", "agent_id", "room_id", "room_seq"],
    )
    op.create_index(
        "ix_agent_events_agent_message_key",
        "agent_events",
        ["agent_id", "message_key"],
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
    op.create_table(
        "agent_room_reads",
        _tenant("agent_room_reads"),
        sa.Column("agent_id", sa.Text(), nullable=False),
        sa.Column("room_id", sa.Text(), nullable=False),
        sa.Column("caught_up_seq", sa.BigInteger(), nullable=False),
        sa.Column("occupant_id", sa.Text(), nullable=False),
        sa.Column("occupant_is_session", sa.Boolean(), nullable=False),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            nullable=False,
        ),
        sa.PrimaryKeyConstraint("agent_id", "room_id"),
        _agent_fk("agent_room_reads"),
        sa.ForeignKeyConstraint(
            ["tenant_id", "room_id"],
            ["rooms.tenant_id", "rooms.id"],
            name="fk_agent_room_reads_room",
            ondelete="CASCADE",
        ),
    )
    op.create_table(
        "agent_poll_positions",
        _tenant("agent_poll_positions"),
        sa.Column("agent_id", sa.Text(), nullable=False),
        sa.Column("reader_id", sa.Text(), nullable=False),
        sa.Column("position", postgresql.JSONB(), nullable=False),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            nullable=False,
        ),
        sa.PrimaryKeyConstraint("agent_id", "reader_id"),
        _agent_fk("agent_poll_positions"),
    )
    # Above every number an agent stream issued before positions, and below
    # 2**53, where a JavaScript client stops counting exactly.
    op.execute("CREATE SEQUENCE agent_position_ticket START WITH 281474976710656")
    op.create_table(
        "agent_position_tickets",
        _tenant("agent_position_tickets"),
        sa.Column(
            "id",
            sa.BigInteger(),
            server_default=sa.text("nextval('agent_position_ticket')"),
            nullable=False,
        ),
        sa.Column("agent_id", sa.Text(), nullable=False),
        sa.Column("position", postgresql.JSONB(), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            nullable=False,
        ),
        sa.PrimaryKeyConstraint("id"),
        _agent_fk("agent_position_tickets"),
    )
    op.create_index(
        "ix_agent_position_tickets_created_at",
        "agent_position_tickets",
        ["created_at"],
    )
    for table in (
        "agent_events",
        "agent_event_heads",
        "agent_event_drops",
        "agent_room_reads",
        "agent_poll_positions",
        "agent_position_tickets",
    ):
        op.create_index(f"ix_{table}_tenant_id", table, ["tenant_id"])
        op.execute(f"ALTER TABLE {table} ENABLE ROW LEVEL SECURITY")
        op.execute(_POLICY.format(table=table))
    op.execute(CREATE_NOTIFY_FUNCTION)
    op.execute(CREATE_NOTIFY_TRIGGER)


def downgrade() -> None:
    op.execute("DROP TRIGGER IF EXISTS agent_events_notify ON agent_events")
    op.execute("DROP FUNCTION IF EXISTS switch_notify_agent_event()")
    op.drop_table("agent_position_tickets")
    op.execute("DROP SEQUENCE IF EXISTS agent_position_ticket")
    op.drop_table("agent_poll_positions")
    op.drop_table("agent_room_reads")
    op.drop_table("agent_event_drops")
    op.drop_table("agent_event_heads")
    op.drop_table("agent_events")
