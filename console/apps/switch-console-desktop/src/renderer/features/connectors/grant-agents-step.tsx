import { useEffect, useState } from 'react';
import { failureText } from '@renderer/lib/errors/describe-failure';
import { rpc } from '@renderer/lib/ipc';
import { useCloseGuard } from '@renderer/lib/modal/use-close-guard';
import { Button } from '@renderer/lib/ui/button';
import { Checkbox } from '@renderer/lib/ui/checkbox';
import {
  DialogContentArea,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@renderer/lib/ui/dialog';
import { Spinner } from '@renderer/lib/ui/spinner';
import type { ConnectionCatalogEntry } from '@shared/core/switch-servers/connection-catalog';
import { useConnectionAgents } from './connectors-queries';
import {
  ALREADY_ON_NOTE,
  type ChecklistRow,
  type GrantOutcome,
  OPEN_GROUP_NOTE,
  agentsUnlistedText,
  checklistGroups,
  grantEach,
  grantFailureText,
  grantSuccessText,
  noAgentsText,
} from './grant-agents';

export type AgentChecklistState = ReturnType<typeof useAgentChecklist>;

/**
 * The person's agents for `connection`, which of them are ticked, and turning
 * the service on for the ticked ones that do not have it yet.
 */
export function useAgentChecklist(workspaceId: string, connection: ConnectionCatalogEntry) {
  const agents = useConnectionAgents(workspaceId, connection.slug);
  const groups = agents.data ? checklistGroups(agents.data) : null;
  const rows = groups ? [...groups.ticked, ...groups.open] : [];
  const [ticked, setTicked] = useState<Set<string> | null>(null);
  useEffect(() => {
    if (agents.data && ticked === null)
      setTicked(new Set(checklistGroups(agents.data).ticked.map((row) => row.agentId)));
  }, [agents.data, ticked]);
  const toGrant = rows.filter((row) => !row.granted && ticked?.has(row.agentId));
  const toggle = (agentId: string, on: boolean) =>
    setTicked((now) => {
      const next = new Set(now);
      if (on) next.add(agentId);
      else next.delete(agentId);
      return next;
    });
  const grant = async (): Promise<GrantOutcome> => {
    const outcome = await grantEach(
      toGrant,
      (agentId) =>
        rpc.workspaces.setServiceGrant({
          workspaceId,
          agentId,
          service: connection.slug,
          access: null,
          resources: {},
        }),
      (cause) => failureText(cause, 'Could not turn it on.')
    );
    await agents.refetch();
    return outcome;
  };
  return { agents, groups, ticked, toggle, toGrant, grant };
}

/**
 * The checklist itself: the agents it starts ticked, then those others can
 * address under one line saying why they are not, or why there is no list.
 */
export function AgentChecklist({
  name,
  checklist,
  disabled,
}: {
  name: string;
  checklist: AgentChecklistState;
  disabled: boolean;
}) {
  const { agents, groups } = checklist;
  return (
    <>
      {agents.isPending && (
        <p className="flex items-center gap-2 text-sm">
          <Spinner /> Loading your agents…
        </p>
      )}
      {agents.isError && (
        <p role="alert" className="text-sm text-destructive">
          {failureText(agents.error, 'Could not load your agents.')}
        </p>
      )}
      {agents.data === null && (
        <p className="text-sm text-foreground-muted">{agentsUnlistedText(name)}</p>
      )}
      {groups && groups.ticked.length + groups.open.length === 0 && (
        <p className="text-sm text-foreground-muted">{noAgentsText(name)}</p>
      )}
      {groups && groups.ticked.length + groups.open.length > 0 && (
        <div role="group" aria-label="Your agents" className="max-h-72 space-y-2 overflow-auto">
          {groups.ticked.map((row) => (
            <ChecklistItem key={row.agentId} row={row} checklist={checklist} disabled={disabled} />
          ))}
          {groups.open.length > 0 && (
            <p className="pt-1 text-xs text-foreground-muted">{OPEN_GROUP_NOTE}</p>
          )}
          {groups.open.map((row) => (
            <ChecklistItem key={row.agentId} row={row} checklist={checklist} disabled={disabled} />
          ))}
        </div>
      )}
    </>
  );
}

function ChecklistItem({
  row,
  checklist,
  disabled,
}: {
  row: ChecklistRow;
  checklist: AgentChecklistState;
  disabled: boolean;
}) {
  return (
    <label className="flex items-start gap-2 text-sm">
      <Checkbox
        className="mt-0.5"
        checked={row.granted || (checklist.ticked?.has(row.agentId) ?? false)}
        disabled={row.granted || disabled}
        onCheckedChange={(on) => checklist.toggle(row.agentId, on)}
      />
      <span>
        <span className="block">{row.name}</span>
        {row.granted && (
          <span className="block text-xs text-foreground-muted">{ALREADY_ON_NOTE}</span>
        )}
      </span>
    </label>
  );
}

/** What turning the service on did: who it failed for, or who has it now. */
function GrantOutcomeLines({ name, outcome }: { name: string; outcome: GrantOutcome }) {
  const failure = grantFailureText(name, outcome);
  return (
    <>
      {failure ? (
        <p role="alert" className="text-sm text-destructive">
          {failure}
        </p>
      ) : (
        <p role="status" className="text-sm">
          {grantSuccessText(name, outcome)}
        </p>
      )}
      {outcome.warnings.map((text) => (
        <p key={text} className="text-xs text-foreground-muted">
          {text}
        </p>
      ))}
    </>
  );
}

function WarningNote({ warning }: { warning: string | null }) {
  if (!warning) return null;
  return (
    <p role="status" className="rounded-md border p-3 text-sm text-foreground-muted">
      {warning}
    </p>
  );
}

/**
 * After connecting a service a grant simply switches on: which of the
 * person's agents get it. Agents only their owner can address start ticked;
 * one others can address starts unticked, since it would act as its owner for
 * whoever addresses it.
 */
export function GrantAgentsStep({
  workspaceId,
  connection,
  warning,
  onDone,
}: {
  workspaceId: string;
  connection: ConnectionCatalogEntry;
  /** What connecting left to say, shown above the list. */
  warning: string | null;
  onDone: () => void;
}) {
  const name = connection.name;
  const checklist = useAgentChecklist(workspaceId, connection);
  const [saving, setSaving] = useState(false);
  const [outcome, setOutcome] = useState<GrantOutcome | null>(null);
  useCloseGuard(saving);
  const save = async () => {
    setSaving(true);
    try {
      setOutcome(await checklist.grant());
    } finally {
      setSaving(false);
    }
  };
  const count = checklist.toGrant.length;

  return (
    <>
      <DialogHeader showCloseButton={!saving}>
        <DialogTitle>Turn {name} on for your agents</DialogTitle>
      </DialogHeader>
      <DialogContentArea className="space-y-4 pt-0">
        <WarningNote warning={warning} />
        <p className="text-sm text-foreground-muted">
          An agent you turn {name} on for acts as you there, with what your connection allows.
        </p>
        <AgentChecklist name={name} checklist={checklist} disabled={saving || outcome !== null} />
        {outcome && <GrantOutcomeLines name={name} outcome={outcome} />}
      </DialogContentArea>
      <DialogFooter>
        {outcome || checklist.agents.data === null ? (
          <Button onClick={onDone}>Done</Button>
        ) : (
          <>
            <Button variant="ghost" disabled={saving} onClick={onDone}>
              Not now
            </Button>
            <Button disabled={saving || count === 0} onClick={() => void save()}>
              {saving && <Spinner />}
              Turn on for {count} {count === 1 ? 'agent' : 'agents'}
            </Button>
          </>
        )}
      </DialogFooter>
    </>
  );
}

/** The sign-in's last screen: the service is connected, and what turning it on did. */
export function ConnectedStep({
  connection,
  warning,
  outcome,
  onDone,
}: {
  connection: ConnectionCatalogEntry;
  warning: string | null;
  outcome: GrantOutcome;
  onDone: () => void;
}) {
  return (
    <>
      <DialogHeader>
        <DialogTitle>{connection.name} connected</DialogTitle>
      </DialogHeader>
      <DialogContentArea className="space-y-4 pt-0">
        <WarningNote warning={warning} />
        <GrantOutcomeLines name={connection.name} outcome={outcome} />
      </DialogContentArea>
      <DialogFooter>
        <Button onClick={onDone}>Done</Button>
      </DialogFooter>
    </>
  );
}
