"""The `NOTIFY` that announces a new row in `agent_events`.

The same arrangement as `notify_ddl.py` for rooms: the insert names who moved
and how far, never what was said, and the process holding that agent's
connection reads the rows after its own position. `agent_events/listener.py`
is the listening half.
"""

AGENT_EVENT_CHANNEL = "switch_agent_event"

AGENT_EVENT_NOTIFY_FUNCTION_NAME = "switch_notify_agent_event"
AGENT_EVENT_NOTIFY_TRIGGER_NAME = "agent_events_notify"

CREATE_AGENT_EVENT_NOTIFY_FUNCTION = f"""
CREATE OR REPLACE FUNCTION {AGENT_EVENT_NOTIFY_FUNCTION_NAME}() RETURNS trigger AS $$
BEGIN
    PERFORM pg_notify(
        '{AGENT_EVENT_CHANNEL}',
        json_build_object('agent_id', NEW.agent_id, 'seq', NEW.seq)::text
    );
    RETURN NULL;
END;
$$ LANGUAGE plpgsql
"""

CREATE_AGENT_EVENT_NOTIFY_TRIGGER = f"""
CREATE TRIGGER {AGENT_EVENT_NOTIFY_TRIGGER_NAME}
    AFTER INSERT ON agent_events
    FOR EACH ROW EXECUTE FUNCTION {AGENT_EVENT_NOTIFY_FUNCTION_NAME}()
"""

DROP_AGENT_EVENT_NOTIFY_TRIGGER = (
    f"DROP TRIGGER IF EXISTS {AGENT_EVENT_NOTIFY_TRIGGER_NAME} ON agent_events"
)
DROP_AGENT_EVENT_NOTIFY_FUNCTION = (
    f"DROP FUNCTION IF EXISTS {AGENT_EVENT_NOTIFY_FUNCTION_NAME}()"
)
