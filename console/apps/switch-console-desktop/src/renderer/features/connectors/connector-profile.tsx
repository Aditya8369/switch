import { ArrowLeft, ExternalLink } from 'lucide-react';
import { useState } from 'react';
import { ConnectionIcon } from '@renderer/features/switch-servers/connection-icon';
import { failureText } from '@renderer/lib/errors/describe-failure';
import { rpc } from '@renderer/lib/ipc';
import { useShowModal } from '@renderer/lib/modal/modal-provider';
import { openExternalUrl } from '@renderer/lib/open-external';
import { Badge } from '@renderer/lib/ui/badge';
import { Button } from '@renderer/lib/ui/button';
import { Spinner } from '@renderer/lib/ui/spinner';
import type { ConnectionCatalogEntry } from '@shared/core/switch-servers/connection-catalog';
import { TONE_BADGE, connectorCardState } from './connector-card-state';
import {
  connectedAsLine,
  isYours,
  profileConnectAction,
  signInLabel,
  tokenLifetimeLabel,
  workspaceOffNotice,
} from './connectors-catalog';
import { useConnectionAgents, useReloadConnectors } from './connectors-queries';
import { agentsUnlistedText, offersChecklist } from './grant-agents';

const ACTION_LABEL = {
  connect: 'Connect',
  reconnect: 'Reconnect',
  manage: 'Manage repositories',
} as const;

/**
 * One connector, in place of the catalog: who the person is connected as and
 * what they allowed, which of their agents use it, and the way to connect,
 * reconnect or disconnect. When the workspace has it off, a member is told
 * who can switch it on and an admin is offered the switch.
 */
export function ConnectorProfile({
  serverId,
  workspaceId,
  connection,
  administers,
  onBack,
}: {
  serverId: string;
  workspaceId: string;
  connection: ConnectionCatalogEntry;
  administers: boolean;
  onBack: () => void;
}) {
  const reload = useReloadConnectors(workspaceId);
  const showConnect = useShowModal('connectServiceModal');
  const showDisconnect = useShowModal('disconnectServiceModal');
  const agents = useConnectionAgents(workspaceId, connection.slug);
  const [enabling, setEnabling] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const state = connectorCardState(connection);
  const offNotice = workspaceOffNotice(connection, administers);
  // Whatever the server or workspace says, a connection the person has can be disconnected.
  const hasConnection = isYours(connection);
  const connectedAs = connectedAsLine(connection);
  const action = profileConnectAction(connection);
  const usedBy = agents.data?.filter((agent) => agent.granted) ?? [];

  const connect = (entry: ConnectionCatalogEntry, startAt: 'connect' | 'grant') =>
    showConnect({
      serverId,
      workspaceId,
      connection: entry,
      startAt,
      onSuccess: () => void reload(),
      onClose: () => void reload(),
    });
  const enable = async () => {
    setEnabling(true);
    setError(null);
    try {
      await rpc.workspaces.setWorkspaceService({
        workspaceId,
        service: connection.slug,
        enabled: true,
      });
      await reload();
      if (!hasConnection && connection.connectable)
        connect({ ...connection, workspace_enabled: true }, 'connect');
    } catch (cause) {
      setError(failureText(cause, `Could not switch ${connection.name} on for the workspace.`));
    } finally {
      setEnabling(false);
    }
  };

  return (
    <div className="space-y-6">
      <Button variant="ghost" size="sm" onClick={onBack}>
        <ArrowLeft className="size-4" />
        All connectors
      </Button>
      <header className="flex items-start gap-4">
        <ConnectionIcon slug={connection.slug} name={connection.name} />
        <div className="min-w-0 flex-1 space-y-1">
          <div className="flex items-center gap-2">
            <h2 className="truncate text-2xl font-semibold text-foreground">{connection.name}</h2>
            <Badge variant={TONE_BADGE[state.tone]}>{state.label}</Badge>
          </div>
          <p className="text-sm text-foreground-muted">{connection.description}</p>
          {connectedAs && <p className="text-sm">{connectedAs}</p>}
          {state.detail && <p className="text-sm text-foreground-muted">{state.detail}</p>}
        </div>
        <div className="flex shrink-0 gap-2">
          {action && (
            <Button
              variant={action === 'manage' ? 'outline' : 'default'}
              disabled={!connection.connectable}
              onClick={() => connect(connection, 'connect')}
            >
              {ACTION_LABEL[action]}
            </Button>
          )}
          {hasConnection && (
            <Button
              variant="outline"
              onClick={() =>
                showDisconnect({
                  serverId,
                  workspaceId,
                  connection,
                  onSuccess: () => void reload(),
                })
              }
            >
              Disconnect
            </Button>
          )}
        </div>
      </header>

      {offNotice && (
        <div className="flex items-center gap-3 rounded-lg border border-border p-3">
          <p className="flex-1 text-sm">{offNotice.text}</p>
          {offNotice.canEnable && (
            <Button size="sm" disabled={enabling} onClick={() => void enable()}>
              {enabling && <Spinner />}
              {hasConnection || !connection.connectable
                ? 'Enable for the workspace'
                : 'Enable for the workspace and connect'}
            </Button>
          )}
        </div>
      )}
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}

      <div className="grid grid-cols-[1fr_220px] gap-6">
        <section className="space-y-2">
          <div className="flex items-center gap-2">
            <h3 className="flex-1 text-sm font-medium">Used by</h3>
            {state.kind === 'connected' && offersChecklist(connection) && (
              <Button size="sm" variant="ghost" onClick={() => connect(connection, 'grant')}>
                Turn on for agents
              </Button>
            )}
          </div>
          {agents.isPending && <Spinner />}
          {agents.isError && (
            <p role="alert" className="text-sm text-destructive">
              {failureText(agents.error, 'Could not load which of your agents use it.')}
            </p>
          )}
          {agents.data === null && (
            <p className="text-sm text-foreground-muted">{agentsUnlistedText(connection.name)}</p>
          )}
          {agents.data && usedBy.length === 0 && (
            <p className="text-sm text-foreground-muted">None of your agents use it.</p>
          )}
          {usedBy.length > 0 && (
            <ul className="space-y-1 text-sm">
              {usedBy.map((agent) => (
                <li key={agent.agent_id}>{agent.name}</li>
              ))}
            </ul>
          )}
          <p className="text-xs text-foreground-muted">
            Turn it on or off for one agent from that agent&apos;s settings.
          </p>
        </section>
        <aside className="space-y-3 text-sm">
          <Fact label="Category" value={connection.category} />
          <Fact label="Sign-in" value={signInLabel(connection)} />
          <Fact label="Agent access lasts" value={tokenLifetimeLabel(connection)} />
          {connection.key?.help_url && (
            <button
              type="button"
              className="flex w-fit items-center gap-1 text-xs text-foreground-muted underline underline-offset-2 hover:text-foreground"
              onClick={() =>
                void openExternalUrl(
                  connection.key!.help_url!,
                  `Could not open ${connection.name}'s help on keys`
                )
              }
            >
              How to make a {connection.name} key <ExternalLink className="size-3" />
            </button>
          )}
        </aside>
      </div>
    </div>
  );
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-xs text-foreground-muted">{label}</div>
      <div>{value}</div>
    </div>
  );
}
