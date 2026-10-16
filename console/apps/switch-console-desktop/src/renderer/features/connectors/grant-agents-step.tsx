import { useEffect, useState } from 'react';
import {
  AgentPickerRow,
  ChosenAgentTile,
  agentProviderLabelFor,
} from '@renderer/lib/components/agent-picker';
import { PickerCombobox } from '@renderer/lib/components/picker-combobox';
import { failureText } from '@renderer/lib/errors/describe-failure';
import { rpc } from '@renderer/lib/ipc';
import { useCloseGuard } from '@renderer/lib/modal/use-close-guard';
import { useWorkspaceAgents } from '@renderer/lib/stores/use-workspace-agents';
import { Button } from '@renderer/lib/ui/button';
import {
  DialogContentArea,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@renderer/lib/ui/dialog';
import { Field, FieldLabel } from '@renderer/lib/ui/field';
import { Spinner } from '@renderer/lib/ui/spinner';
import type { ConnectionCatalogEntry } from '@shared/core/switch-servers/connection-catalog';
import { useConnectionAgents } from './connectors-queries';
import {
  type AgentRow,
  type GrantOutcome,
  OPEN_AGENT_NOTE,
  agentsUnlistedText,
  alreadyOnText,
  grantEach,
  grantFailureText,
  grantSuccessText,
  noAgentsText,
  pickerGroups,
} from './grant-agents';

export type AgentPickerState = ReturnType<typeof useAgentPicker>;

/**
 * The person's agents for `connection`, which of them are picked, and turning
 * the service on for the picked ones.
 */
export function useAgentPicker(workspaceId: string, connection: ConnectionCatalogEntry) {
  const agents = useConnectionAgents(workspaceId, connection.slug);
  const groups = agents.data ? pickerGroups(agents.data) : null;
  const [picked, setPicked] = useState<AgentRow[] | null>(null);
  useEffect(() => {
    if (agents.data && picked === null) setPicked(pickerGroups(agents.data).picked);
  }, [agents.data, picked]);
  const toGrant = picked ?? [];
  const candidates = groups
    ? [...groups.picked, ...groups.offered].filter(
        (row) => !toGrant.some((chosen) => chosen.agentId === row.agentId)
      )
    : [];
  const pick = (row: AgentRow) => setPicked((now) => [...(now ?? []), row]);
  const unpick = (agentId: string) =>
    setPicked((now) => (now ?? []).filter((row) => row.agentId !== agentId));
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
  return { agents, groups, toGrant, candidates, pick, unpick, grant };
}

/**
 * The picker itself, shaped like adding agents to a room: the agents picked
 * so far as tiles, a search box that adds one more, and under it the agents
 * that already have the service. An agent others can address is offered with
 * a note saying it would act as its owner, and keeps that note on its tile.
 */
export function AgentPicker({
  name,
  serverId,
  workspaceId,
  picker,
  disabled,
}: {
  name: string;
  serverId: string;
  workspaceId: string;
  picker: AgentPickerState;
  disabled: boolean;
}) {
  const { agents, groups, toGrant, candidates } = picker;
  const remote = useWorkspaceAgents(workspaceId);
  const iconFor = (agentId: string) =>
    remote.data?.find((agent) => agent.id === agentId)?.iconUrl ?? null;
  const subtitleFor = (row: AgentRow) =>
    row.open ? OPEN_AGENT_NOTE : agentProviderLabelFor(row.agentId, workspaceId);
  const nothingToAdd = candidates.length === 0 && toGrant.length === 0;
  if (agents.isPending)
    return (
      <p className="flex items-center gap-2 text-sm">
        <Spinner /> Loading your agents…
      </p>
    );
  if (agents.isError)
    return (
      <p role="alert" className="text-sm text-destructive">
        {failureText(agents.error, 'Could not load your agents.')}
      </p>
    );
  if (agents.data === null)
    return <p className="text-sm text-foreground-muted">{agentsUnlistedText(name)}</p>;
  if (!groups || agents.data.length === 0)
    return <p className="text-sm text-foreground-muted">{noAgentsText(name)}</p>;
  return (
    <Field>
      <div className="flex items-center justify-between gap-3">
        <FieldLabel>Agents</FieldLabel>
        {toGrant.length > 0 && (
          <span className="text-sm text-foreground-muted">{toGrant.length} selected</span>
        )}
      </div>
      {toGrant.length > 0 && (
        <div className="grid grid-cols-3 gap-2.5">
          {toGrant.map((row) => (
            <ChosenAgentTile
              key={row.agentId}
              agent={{ id: row.agentId, name: row.name, iconUrl: iconFor(row.agentId) }}
              serverId={serverId}
              subtitle={subtitleFor(row)}
              subtitleTone={row.open ? 'warning' : 'muted'}
              onRemove={() => {
                if (!disabled) picker.unpick(row.agentId);
              }}
            />
          ))}
        </div>
      )}
      <PickerCombobox
        items={candidates.map((row) => ({ ...row, id: row.agentId }))}
        onPick={(item) => picker.pick({ agentId: item.agentId, name: item.name, open: item.open })}
        searchText={(item) => item.name}
        renderItem={(item) => (
          <AgentPickerRow
            agent={{ id: item.agentId, name: item.name, iconUrl: iconFor(item.agentId) }}
            serverId={serverId}
            subtitle={subtitleFor(item)}
          />
        )}
        disabled={disabled || nothingToAdd}
        placeholder="Search agents to add..."
        emptyText="No agents found"
      />
      {groups.on.length > 0 && (
        <p className="text-xs text-foreground-muted">
          {alreadyOnText(
            name,
            groups.on.map((row) => row.name)
          )}
        </p>
      )}
    </Field>
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
 * person's agents get it. Agents only their owner can address start picked;
 * one others can address is found through the search, since it would act as
 * its owner for whoever addresses it.
 */
export function GrantAgentsStep({
  serverId,
  workspaceId,
  connection,
  warning,
  onDone,
}: {
  serverId: string;
  workspaceId: string;
  connection: ConnectionCatalogEntry;
  /** What connecting left to say, shown above the list. */
  warning: string | null;
  onDone: () => void;
}) {
  const name = connection.name;
  const picker = useAgentPicker(workspaceId, connection);
  const [saving, setSaving] = useState(false);
  const [outcome, setOutcome] = useState<GrantOutcome | null>(null);
  useCloseGuard(saving);
  const save = async () => {
    setSaving(true);
    try {
      setOutcome(await picker.grant());
    } finally {
      setSaving(false);
    }
  };
  const count = picker.toGrant.length;

  return (
    <>
      <DialogHeader showCloseButton={!saving}>
        <DialogTitle>Turn {name} on for your agents</DialogTitle>
      </DialogHeader>
      <DialogContentArea className="space-y-4 pt-0">
        <WarningNote warning={warning} />
        {outcome ? (
          <GrantOutcomeLines name={name} outcome={outcome} />
        ) : (
          <>
            <p className="text-sm text-foreground-muted">
              An agent you turn {name} on for acts as you there, with what your connection allows.
            </p>
            <AgentPicker
              name={name}
              serverId={serverId}
              workspaceId={workspaceId}
              picker={picker}
              disabled={saving}
            />
          </>
        )}
      </DialogContentArea>
      <DialogFooter>
        {outcome || picker.agents.data === null ? (
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
