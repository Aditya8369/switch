import { Plug } from 'lucide-react';
import { observer } from 'mobx-react-lite';
import { useEffect, useState } from 'react';
import type { GuardResult, ViewDefinition } from '@renderer/app/view-registry';
import { ConnectionIcon } from '@renderer/features/switch-servers/connection-icon';
import { ServerPage } from '@renderer/features/switch-servers/server-page';
import { ServerSectionTitlebar } from '@renderer/features/switch-servers/server-section-titlebar';
import { administersWorkspaceInScope } from '@renderer/features/switch-servers/workspace-admin';
import { workspacesStore } from '@renderer/features/workspaces/workspaces-store';
import { failureText } from '@renderer/lib/errors/describe-failure';
import { useNavigate, useParams } from '@renderer/lib/layout/navigation-provider';
import { Alert, AlertAction, AlertDescription } from '@renderer/lib/ui/alert';
import { Badge } from '@renderer/lib/ui/badge';
import { Button } from '@renderer/lib/ui/button';
import { SearchInput } from '@renderer/lib/ui/search-input';
import { SegmentedControl } from '@renderer/lib/ui/segmented-control';
import { Spinner } from '@renderer/lib/ui/spinner';
import type { ConnectionCatalogEntry } from '@shared/core/switch-servers/connection-catalog';
import { TONE_BADGE, connectorCardState } from './connector-card-state';
import { ConnectorProfile } from './connector-profile';
import { type ConnectorsTab, connectorsInTab, connectorsPageAccess } from './connectors-catalog';
import {
  useConnectorCatalog,
  useServerFeatureFlags,
  useWorkspaceServices,
} from './connectors-queries';
import { WorkspaceServicesSection } from './workspace-services-section';

function useServerId(): string {
  return useParams('connectors').params.serverId;
}

const ConnectorsTitlebar = observer(function ConnectorsTitlebar() {
  return <ServerSectionTitlebar serverId={useServerId()} icon={Plug} label="Connectors" />;
});

const DESCRIPTION =
  'Connect the services your agents work with. An agent uses one only once you turn it on for that agent.';

/**
 * The connector catalog of the workspace in scope on the server. Behind the
 * server's `service_connections` flag: with it off there is no page, and
 * reaching it anyway goes to Your Agents rather than drawing an empty one.
 */
const ConnectorsPanel = observer(function ConnectorsPanel() {
  const serverId = useServerId();
  const { navigate } = useNavigate();
  const access = connectorsPageAccess(useServerFeatureFlags(serverId));
  const workspaceId = workspacesStore.idOnServerInScope(serverId);
  useEffect(() => {
    if (access === 'absent') navigate('serverAgents', { serverId });
  }, [access, navigate, serverId]);

  if (access !== 'shown' || workspaceId === null)
    return (
      <ServerPage width={880} title="Connectors" description={DESCRIPTION}>
        <Spinner />
      </ServerPage>
    );
  // Keyed so a workspace switch starts from the catalog, not another workspace's profile.
  return (
    <Connectors
      key={workspaceId}
      serverId={serverId}
      workspaceId={workspaceId}
      administers={administersWorkspaceInScope(serverId)}
    />
  );
});

function Connectors({
  serverId,
  workspaceId,
  administers,
}: {
  serverId: string;
  workspaceId: string;
  administers: boolean;
}) {
  const catalog = useConnectorCatalog(workspaceId);
  const workspaceServices = useWorkspaceServices(workspaceId, administers);
  const [tab, setTab] = useState<ConnectorsTab>('yours');
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState<string | null>(null);

  // An admin's switches, where the server has them: a server without them
  // answers null, and the page then has no workspace layer at all.
  const switchesShown =
    administers && (workspaceServices.data != null || workspaceServices.isError);
  const tabs = [
    { value: 'yours', label: 'Yours' },
    { value: 'discover', label: 'Discover' },
    ...(switchesShown ? [{ value: 'workspace', label: 'Workspace' } as const] : []),
  ] as const satisfies readonly { value: ConnectorsTab; label: string }[];
  const shownTab = tab === 'workspace' && !switchesShown ? 'yours' : tab;

  const opened = catalog.data?.find((entry) => entry.slug === open);
  if (opened)
    return (
      <ServerPage width={880} title="Connectors" description={DESCRIPTION}>
        <ConnectorProfile
          serverId={serverId}
          workspaceId={workspaceId}
          connection={opened}
          administers={administers}
          onBack={() => setOpen(null)}
        />
      </ServerPage>
    );

  return (
    <ServerPage width={880} title="Connectors" description={DESCRIPTION}>
      <div className="flex items-center gap-3">
        <SegmentedControl
          ariaLabel="Connectors"
          value={shownTab}
          onChange={setTab}
          options={tabs}
        />
        {shownTab !== 'workspace' && (
          <SearchInput
            className="flex-1"
            aria-label="Search connectors"
            placeholder="Search by name or category"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        )}
      </div>
      {shownTab === 'workspace' ? (
        <WorkspaceServicesSection workspaceId={workspaceId} services={workspaceServices} />
      ) : catalog.isError ? (
        <Alert variant="destructive">
          <AlertDescription>
            {failureText(catalog.error, 'Could not load the connectors.')}
          </AlertDescription>
          <AlertAction>
            <Button size="sm" variant="outline" onClick={() => void catalog.refetch()}>
              Retry
            </Button>
          </AlertAction>
        </Alert>
      ) : !catalog.data ? (
        <p className="flex items-center gap-2 text-sm">
          <Spinner /> Loading connectors…
        </p>
      ) : (
        <ConnectorGrid
          entries={connectorsInTab(catalog.data, shownTab, query)}
          tab={shownTab}
          query={query}
          onOpen={setOpen}
        />
      )}
    </ServerPage>
  );
}

function ConnectorGrid({
  entries,
  tab,
  query,
  onOpen,
}: {
  entries: ConnectionCatalogEntry[];
  tab: 'yours' | 'discover';
  query: string;
  onOpen: (slug: string) => void;
}) {
  if (entries.length === 0)
    return (
      <p className="text-sm text-foreground-muted">
        {query.trim()
          ? `No connector matches “${query.trim()}”.`
          : tab === 'yours'
            ? 'You have not connected anything yet. Find a service under Discover.'
            : 'You have connected every service there is.'}
      </p>
    );
  return (
    <div
      role="group"
      aria-label="Connectors"
      className="grid grid-cols-[repeat(auto-fill,minmax(240px,1fr))] gap-2"
    >
      {entries.map((entry) => {
        const state = connectorCardState(entry);
        return (
          <button
            key={entry.slug}
            type="button"
            title={entry.description}
            disabled={state.kind === 'coming_soon'}
            onClick={() => onOpen(entry.slug)}
            className="group flex items-start gap-3 rounded-lg border border-border p-3 text-left enabled:cursor-pointer enabled:hover:bg-background-tertiary-2 disabled:cursor-not-allowed"
          >
            <ConnectionIcon slug={entry.slug} name={entry.name} />
            <span className="min-w-0 flex-1 group-disabled:opacity-60">
              <span className="block truncate text-sm font-medium text-foreground">
                {entry.name}
              </span>
              <span className="block truncate text-xs text-foreground-muted">{entry.category}</span>
              <Badge className="mt-1.5" variant={TONE_BADGE[state.tone]}>
                {state.label}
              </Badge>
              {state.detail && (
                <span className="mt-1 block text-xs text-foreground-muted">{state.detail}</span>
              )}
            </span>
          </button>
        );
      })}
    </div>
  );
}

export const connectorsView = {
  WrapView: ({ children }: { children: React.ReactNode; serverId: string }) => <>{children}</>,
  TitlebarSlot: ConnectorsTitlebar,
  MainPanel: ConnectorsPanel,
  canActivate: (params: unknown): GuardResult => {
    const serverId =
      typeof params === 'object' && params !== null
        ? (params as { serverId?: unknown }).serverId
        : undefined;
    if (typeof serverId !== 'string') return { ok: false, redirect: 'home' };
    return { ok: true };
  },
} satisfies ViewDefinition<{ serverId: string }>;
