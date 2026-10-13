import { useQueryClient } from '@tanstack/react-query';
import { MoreVertical, Play, Square, Trash2 } from 'lucide-react';
import { observer } from 'mobx-react-lite';
import { type ReactNode, useState } from 'react';
import type { GuardResult, ViewDefinition } from '@renderer/app/view-registry';
import { ServiceGrantsRow } from '@renderer/features/locations/components/settings-view/sections/service-grants-settings-section';
import { ServerPage } from '@renderer/features/switch-servers/server-page';
import { ServerStatusPill } from '@renderer/features/switch-servers/server-presentation';
import { switchServersStore } from '@renderer/features/switch-servers/switch-servers-store';
import { AgentAvatar } from '@renderer/lib/components/agent-avatar';
import { Titlebar } from '@renderer/lib/components/titlebar/Titlebar';
import { TitlebarBreadcrumb } from '@renderer/lib/components/titlebar/titlebar-breadcrumb';
import { describeFailure, failureText } from '@renderer/lib/errors/describe-failure';
import { toast } from '@renderer/lib/hooks/use-toast';
import { useFeatureFlags } from '@renderer/lib/hooks/useFeatureFlags';
import { rpc } from '@renderer/lib/ipc';
import { useNavigate, useParams } from '@renderer/lib/layout/navigation-provider';
import { useShowModal } from '@renderer/lib/modal/modal-provider';
import { Button } from '@renderer/lib/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@renderer/lib/ui/dropdown-menu';
import { SegmentedControl } from '@renderer/lib/ui/segmented-control';
import { isCloudMachine, type ManagedAgentView } from '@shared/core/managed-agents/managed-agents';
import { AgentChats } from './agent-chats';
import { type AgentTab, agentTabStore } from './agent-tab-store';
import { ManagedAgentPage } from './managed-agent-page';
import { managedAgentLabel } from './managed-agent-state';
import { MANAGED_AGENTS_KEY, useManagedAgents } from './use-managed-agents';

type ManagedAgentParams = {
  serverId: string;
  agentId: string;
  name: string;
  /** The chat open on the Chats tab. */
  roomId?: string;
};

const TABS = [
  { value: 'chats', label: 'Chats' },
  { value: 'connections', label: 'Connections' },
  { value: 'settings', label: 'Settings' },
] as const satisfies readonly { value: AgentTab; label: string }[];

const ManagedAgentTitlebar = observer(function ManagedAgentTitlebar() {
  const { params } = useParams('managedAgent');
  const agents = useManagedAgents(params.serverId);
  const agent = agents.data?.find((listed) => listed.agentId === params.agentId) ?? null;
  const server = switchServersStore.servers.find((s) => s.id === params.serverId) ?? null;
  const label = agent ? managedAgentLabel(agent) : params.name;
  const { navigate } = useNavigate();
  const tabbed = useFeatureFlags(params.serverId).agent_chats;
  const breadcrumb = (
    <TitlebarBreadcrumb
      crumbs={[
        ...(tabbed
          ? [
              {
                key: 'agents',
                label: 'Your Agents',
                onClick: () => navigate('serverAgents', { serverId: params.serverId }),
              },
            ]
          : []),
        {
          key: 'agent',
          icon: (
            <AgentAvatar
              name={label}
              iconUrl={agent?.iconUrl ?? null}
              serverId={params.serverId}
              size={16}
              className="bg-transparent"
            />
          ),
          label,
        },
      ]}
    />
  );
  return (
    <Titlebar
      leftSlot={
        tabbed ? (
          <div className="flex min-w-0 items-center gap-3">
            {breadcrumb}
            <SegmentedControl
              value={agentTabStore.tabFor(params.agentId)}
              onChange={(tab) => agentTabStore.setTab(params.agentId, tab)}
              options={TABS}
              ariaLabel="Agent view"
            />
          </div>
        ) : (
          breadcrumb
        )
      }
      rightSlot={
        <div className="mr-1 flex items-center gap-1.5">
          {server && <ServerStatusPill server={server} />}
          {agent && <ManagedAgentActionsMenu agent={agent} />}
        </div>
      }
    />
  );
});

/** Starting, stopping and deleting the agent, from the titlebar's menu as a Console agent's actions are. */
function ManagedAgentActionsMenu({ agent }: { agent: ManagedAgentView }) {
  const label = managedAgentLabel(agent);
  const queryClient = useQueryClient();
  const { navigate } = useNavigate();
  const confirm = useShowModal('confirmActionModal');
  const [busy, setBusy] = useState(false);

  const act = async (fallback: string, run: () => Promise<void>) => {
    setBusy(true);
    try {
      await run();
      await queryClient.invalidateQueries({ queryKey: [MANAGED_AGENTS_KEY] });
    } catch (failure) {
      const { headline, detail } = describeFailure(failure, fallback);
      toast({ title: headline, description: detail ?? undefined, variant: 'destructive' });
    } finally {
      setBusy(false);
    }
  };
  const setDesiredState = (desiredState: 'running' | 'stopped') =>
    act(
      desiredState === 'running'
        ? `${label} could not be started.`
        : `${label} could not be stopped.`,
      () =>
        rpc.managedAgents.setDesiredState({
          serverId: agent.serverId,
          agentId: agent.agentId,
          desiredState,
        })
    );
  const remove = () =>
    confirm({
      title: `Delete ${label}?`,
      description: `Its machine stops it and it is deleted from Switch, for every room it is in.`,
      confirmLabel: 'Delete',
      onSuccess: () =>
        void act(`${label} could not be deleted.`, async () => {
          await rpc.managedAgents.remove({ serverId: agent.serverId, agentId: agent.agentId });
          // Its name is free again: the New agent form checks names against this list.
          await queryClient.invalidateQueries({ queryKey: ['workspace-agents'] });
          navigate('serverAgents', { serverId: agent.serverId });
        }),
    });

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button variant="ghost" size="sm" className="size-7 p-0" aria-label={`${label} actions`}>
            <MoreVertical className="size-4" />
          </Button>
        }
      />
      <DropdownMenuContent align="end">
        {agent.desiredState === 'running' ? (
          <DropdownMenuItem disabled={busy} onClick={() => void setDesiredState('stopped')}>
            <Square className="size-4" />
            Stop
          </DropdownMenuItem>
        ) : (
          <DropdownMenuItem disabled={busy} onClick={() => void setDesiredState('running')}>
            <Play className="size-4" />
            Start
          </DropdownMenuItem>
        )}
        <DropdownMenuSeparator />
        <DropdownMenuItem variant="destructive" disabled={busy} onClick={remove}>
          <Trash2 className="size-4" />
          Delete agent…
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

const ManagedAgentPanel = observer(function ManagedAgentPanel() {
  const { params } = useParams('managedAgent');
  const agents = useManagedAgents(params.serverId);
  const agent = agents.data?.find((listed) => listed.agentId === params.agentId);
  const flags = useFeatureFlags(params.serverId);
  const tabbed = flags.agent_chats;
  const serviceConnections = flags.service_connections;
  if (agents.error)
    return (
      <ServerPage width={900} title={params.name} description="">
        <p role="alert" className="text-sm text-destructive">
          {failureText(agents.error, 'The agent could not be read from its server.')}
        </p>
      </ServerPage>
    );
  if (agents.data === null)
    return (
      <ServerPage width={900} title={params.name} description="">
        <p role="alert" className="text-sm text-destructive">
          This server no longer runs managed agents.
        </p>
      </ServerPage>
    );
  if (!agents.data)
    return (
      <ServerPage width={900} title={params.name} description="Loading…">
        {null}
      </ServerPage>
    );
  if (!agent)
    return (
      <ServerPage width={900} title={params.name} description="">
        <p role="alert" className="text-sm text-destructive">
          This agent is no longer on its Switch server.
        </p>
      </ServerPage>
    );
  if (!tabbed) return <ManagedAgentPage key={agent.agentId} agent={agent} />;
  const tab = agentTabStore.tabFor(agent.agentId);
  if (tab === 'chats') return <AgentChats key={agent.agentId} agent={agent} />;
  if (tab === 'connections')
    return (
      <ServerPage
        width={900}
        title="Connections"
        description="The service connections this agent may use."
      >
        {serviceConnections ? (
          <ServiceGrantsRow
            serverId={agent.serverId}
            workspaceId={agent.workspaceId}
            agentId={agent.agentId}
            agentName={managedAgentLabel(agent)}
            cloud={agent.machine !== null && isCloudMachine(agent.machine)}
          />
        ) : (
          <p className="text-sm text-foreground-muted">
            Service connections are not turned on for this server.
          </p>
        )}
      </ServerPage>
    );
  return <ManagedAgentPage key={agent.agentId} agent={agent} />;
});

export const managedAgentView = {
  WrapView: ({ children }: ManagedAgentParams & { children: ReactNode }) => <>{children}</>,
  TitlebarSlot: ManagedAgentTitlebar,
  MainPanel: ManagedAgentPanel,
  canActivate: (params: unknown): GuardResult => {
    const value = (params ?? {}) as Partial<Record<keyof ManagedAgentParams, unknown>>;
    if (
      typeof value.serverId !== 'string' ||
      typeof value.agentId !== 'string' ||
      typeof value.name !== 'string' ||
      (value.roomId !== undefined && typeof value.roomId !== 'string')
    )
      return { ok: false, redirect: 'home', discardParams: true };
    return { ok: true };
  },
} satisfies ViewDefinition<ManagedAgentParams>;
