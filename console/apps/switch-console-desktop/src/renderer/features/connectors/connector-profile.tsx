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
  keyAccessText,
  profileConnectAction,
  signInLabel,
  tokenLifetimeLabel,
  workspaceOffNotice,
} from './connectors-catalog';
import { useConnectionAgents, useReloadConnectors } from './connectors-queries';
import { agentsUnlistedText, offersChecklist } from './grant-agents';
import { useConnectService } from './use-connect-service';

const ACTION_LABEL = {
  connect: 'Connect to Switch',
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
  const connect = useConnectService(serverId, workspaceId);
  const showDisconnect = useShowModal('disconnectServiceModal');
  const agents = useConnectionAgents(workspaceId, connection.slug);
  const [enabling, setEnabling] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const state = connectorCardState(connection);
  const offNotice = workspaceOffNotice(connection, administers);
  // Whatever the server or workspace says, a connection the person has can be disconnected.
  const hasConnection = isYours(connection);
  const connectedAs = connectedAsLine(connection);
  const keyAccess = keyAccessText(connection);
  const action = profileConnectAction(connection);
  const usedBy = agents.data?.filter((agent) => agent.granted) ?? [];

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
    <div>
      <Button variant="ghost" size="sm" className="-ml-2" onClick={onBack}>
        <ArrowLeft className="size-4" />
        Connectors
      </Button>
      <header className="mt-4 flex items-start gap-4">
        <ConnectionIcon slug={connection.slug} name={connection.name} size="xl" />
        <div className="min-w-0 flex-1 space-y-1">
          <div className="flex items-center gap-2">
            <h1 className="truncate text-3xl font-semibold tracking-tight text-foreground">
              {connection.name}
            </h1>
            {state.kind !== 'connect' && state.kind !== 'connected' && (
              <Badge variant={TONE_BADGE[state.tone]}>{state.label}</Badge>
            )}
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
            <Button variant="outline" onClick={() => showDisconnect({ workspaceId, connection })}>
              Disconnect
            </Button>
          )}
        </div>
      </header>

      {offNotice && (
        <div className="mt-4 flex items-center gap-3 rounded-lg border border-border p-3">
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
        <p role="alert" className="mt-4 text-sm text-destructive">
          {error}
        </p>
      )}

      <div className="mt-6 grid grid-cols-[minmax(0,1fr)_240px] gap-8 border-t border-border pt-6">
        <section className="min-w-0 space-y-2">
          <div className="flex items-center gap-2">
            <h2 className="flex-1 text-lg font-semibold text-foreground">Used by</h2>
            {state.kind === 'connected' && offersChecklist(connection) && (
              <Button size="sm" variant="outline" onClick={() => connect(connection, 'grant')}>
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
        <aside className="space-y-6">
          <Fact label="Category">
            <span className="inline-flex items-center rounded-md border border-border px-2 py-0.5 text-sm">
              {connection.category}
            </span>
          </Fact>
          <Fact label="Sign-in">{signInLabel(connection)}</Fact>
          {keyAccess && <Fact label="What agents can do">{keyAccess}</Fact>}
          <Fact label="Agent access lasts">{tokenLifetimeLabel(connection)}</Fact>
          {connection.key?.help_url && (
            <Fact label="More info">
              <button
                type="button"
                className="flex w-fit items-center gap-1 text-sm underline underline-offset-2 hover:text-foreground"
                onClick={() =>
                  void openExternalUrl(
                    connection.key!.help_url!,
                    `Could not open ${connection.name}'s help on keys`
                  )
                }
              >
                How to make a {connection.name} key <ExternalLink className="size-3.5" />
              </button>
            </Fact>
          )}
        </aside>
      </div>
    </div>
  );
}

function Fact({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <h3 className="text-xs font-medium tracking-wide text-foreground-muted uppercase">{label}</h3>
      <div className="mt-1.5 text-sm text-foreground">{children}</div>
    </div>
  );
}
