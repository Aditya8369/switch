import { Plus, Search, X } from 'lucide-react';
import { observer } from 'mobx-react-lite';
import { useState } from 'react';
import { AgentAvatar } from '@renderer/lib/components/agent-avatar';
import { agentProviderLabelFor } from '@renderer/lib/components/agent-picker';
import { failureText } from '@renderer/lib/errors/describe-failure';
import { rpc } from '@renderer/lib/ipc';
import { useWorkspaceAgents } from '@renderer/lib/stores/use-workspace-agents';
import { Button } from '@renderer/lib/ui/button';
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput,
} from '@renderer/lib/ui/input-group';
import { Spinner } from '@renderer/lib/ui/spinner';
import { cn } from '@renderer/utils/utils';
import type {
  ConnectionAgent,
  ConnectionCatalogEntry,
} from '@shared/core/switch-servers/connection-catalog';
import { useConnectionAgents, useReloadConnectors } from './connectors-queries';
import {
  OPEN_AGENT_NOTE,
  addableAgents,
  agentsSummary,
  agentsUnlistedText,
  noAgentsText,
  offersAddAgent,
} from './grant-agents';

/**
 * The agents using the connector, drawn as a room's participants are: a
 * heading with the count, a card per agent, and an "Add agent" that opens a
 * search of the person's other agents under the cards. Adding one turns the
 * service on for it there and then.
 */
export const ConnectorAgentsSection = observer(function ConnectorAgentsSection({
  serverId,
  workspaceId,
  connection,
  connected,
  adding,
  onAddingChange,
  notice,
}: {
  serverId: string;
  workspaceId: string;
  connection: ConnectionCatalogEntry;
  /** The person has a usable connection, so agents can be added. */
  connected: boolean;
  adding: boolean;
  onAddingChange: (adding: boolean) => void;
  /** What connecting left to say, shown above the search while it is open. */
  notice: string | null;
}) {
  const name = connection.name;
  const agents = useConnectionAgents(workspaceId, connection.slug);
  const remote = useWorkspaceAgents(workspaceId);
  const iconFor = (agentId: string) =>
    remote.data?.find((agent) => agent.id === agentId)?.iconUrl ?? null;
  const usedBy = agents.data?.filter((agent) => agent.granted) ?? [];
  const canAdd = connected && offersAddAgent(connection) && agents.data != null;

  return (
    <section className="flex flex-col gap-3">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-baseline gap-2">
          <h2 className="text-sm font-semibold text-foreground">Agents</h2>
          {agents.data && (
            <span className="text-xs text-foreground-muted">{agentsSummary(usedBy.length)}</span>
          )}
        </div>
        {canAdd && (
          <Button
            variant="outline"
            size="sm"
            aria-expanded={adding}
            onClick={() => onAddingChange(!adding)}
          >
            <Plus className="size-3.5" />
            Add agent
          </Button>
        )}
      </div>

      {agents.isPending && (
        <p className="flex items-center gap-2 text-sm">
          <Spinner /> Loading your agents…
        </p>
      )}
      {agents.isError && (
        <p role="alert" className="text-sm text-destructive">
          {failureText(agents.error, 'Could not load which of your agents use it.')}
        </p>
      )}
      {agents.data === null && (
        <p className="text-sm text-foreground-muted">{agentsUnlistedText(name)}</p>
      )}
      {agents.data && agents.data.length === 0 && (
        <p className="text-sm text-foreground-muted">{noAgentsText(name)}</p>
      )}
      {agents.data && agents.data.length > 0 && usedBy.length === 0 && (
        <p className="text-sm text-foreground-muted">None of your agents use {name} yet.</p>
      )}
      {usedBy.length > 0 && (
        <div role="list" aria-label="Agents" className="grid grid-cols-2 gap-2.5">
          {usedBy.map((agent) => (
            <div
              key={agent.agent_id}
              role="listitem"
              className="flex items-center gap-3 rounded-[10px] border border-border bg-[var(--surface-2)] px-3.5 py-3"
            >
              <span className="flex size-7 shrink-0 items-center justify-center">
                <AgentAvatar
                  name={agent.name}
                  iconUrl={iconFor(agent.agent_id)}
                  serverId={serverId}
                  size={26}
                />
              </span>
              <div className="flex min-w-0 flex-col">
                <span className="truncate text-sm font-medium text-foreground">{agent.name}</span>
                <span className="truncate text-xs text-foreground-muted">
                  {agentProviderLabelFor(agent.agent_id, workspaceId)}
                </span>
              </div>
            </div>
          ))}
        </div>
      )}

      {canAdd && adding && agents.data && (
        <AddAgentPanel
          serverId={serverId}
          workspaceId={workspaceId}
          connection={connection}
          agents={agents.data}
          iconFor={iconFor}
          notice={notice}
        />
      )}
      <p className="text-xs text-foreground-muted">
        Turn it on or off for one agent from that agent&apos;s settings.
      </p>
    </section>
  );
});

/**
 * Search the person's agents and turn the service on for one. An agent others
 * can address is offered with a note in place of what runs it, since whoever
 * addresses it would have it act as the person.
 */
const AddAgentPanel = observer(function AddAgentPanel({
  serverId,
  workspaceId,
  connection,
  agents,
  iconFor,
  notice,
}: {
  serverId: string;
  workspaceId: string;
  connection: ConnectionCatalogEntry;
  agents: ConnectionAgent[];
  iconFor: (agentId: string) => string | null;
  notice: string | null;
}) {
  const name = connection.name;
  const reload = useReloadConnectors(workspaceId);
  const [filter, setFilter] = useState('');
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [warning, setWarning] = useState<string | null>(null);
  const candidates = addableAgents(agents, filter);
  const query = filter.trim();

  async function add(agentId: string) {
    setBusyId(agentId);
    setError(null);
    try {
      const result = await rpc.workspaces.setServiceGrant({
        workspaceId,
        agentId,
        service: connection.slug,
        access: null,
        resources: {},
      });
      setWarning(result);
      await reload();
    } catch (cause) {
      setError(failureText(cause, `Could not turn ${name} on for the agent.`));
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div className="flex flex-col gap-2 pt-1">
      {notice && (
        <p role="status" className="rounded-md border p-3 text-sm text-foreground-muted">
          {notice}
        </p>
      )}
      <p className="text-sm text-foreground-muted">
        An agent you add acts as you at {name}, with what your connection allows.
      </p>
      <InputGroup>
        <InputGroupAddon>
          <Search className="size-3.5 text-foreground-muted" />
        </InputGroupAddon>
        <InputGroupInput
          autoFocus
          placeholder="Search your agents…"
          aria-label="Search agents to add"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />
        {filter !== '' && (
          <InputGroupAddon align="inline-end">
            <InputGroupButton
              size="icon-xs"
              aria-label="Clear the search"
              onClick={() => setFilter('')}
            >
              <X className="size-3.5" />
            </InputGroupButton>
          </InputGroupAddon>
        )}
      </InputGroup>

      {error !== null && <p className="text-xs text-destructive">Not added — {error}</p>}
      {warning !== null && (
        <p role="status" className="text-xs text-foreground-muted">
          {warning}
        </p>
      )}

      {candidates.length === 0 ? (
        <p className="px-1 py-2 text-sm text-foreground-muted">
          {query === ''
            ? `Every one of your agents already uses ${name}.`
            : `No agent here matches “${query}”.`}
        </p>
      ) : (
        <div className="divide-y divide-border overflow-hidden rounded-[10px] border border-border">
          {candidates.map((agent) => {
            const busy = busyId === agent.agent_id;
            return (
              <button
                key={agent.agent_id}
                type="button"
                disabled={busyId !== null}
                onClick={() => void add(agent.agent_id)}
                className={cn(
                  'flex w-full cursor-pointer items-center gap-3 bg-background px-3.5 py-2.5 text-left transition-colors hover:bg-[var(--fill)]',
                  busyId !== null && 'cursor-wait'
                )}
              >
                <AgentAvatar
                  name={agent.name}
                  iconUrl={iconFor(agent.agent_id)}
                  serverId={serverId}
                  size={22}
                />
                <span className="min-w-0 flex-1 truncate text-sm text-foreground">
                  {agent.name}
                </span>
                <span
                  className={cn(
                    'shrink-0 text-xs',
                    agent.addressing_open
                      ? 'text-amber-600 dark:text-amber-500'
                      : 'text-foreground-muted'
                  )}
                >
                  {agent.addressing_open
                    ? OPEN_AGENT_NOTE
                    : agentProviderLabelFor(agent.agent_id, workspaceId)}
                </span>
                <span className="shrink-0 text-xs font-medium text-foreground">
                  {busy ? 'Adding…' : 'Add'}
                </span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
});
