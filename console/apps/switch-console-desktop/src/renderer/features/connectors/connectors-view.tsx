import { Check, Plug, Plus } from 'lucide-react';
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
import { cn } from '@renderer/utils/utils';
import type { ConnectionCatalogEntry } from '@shared/core/switch-servers/connection-catalog';
import { TONE_BADGE, connectorCardState } from './connector-card-state';
import { ConnectorProfile } from './connector-profile';
import {
  type ConnectorsTab,
  cardQuickAction,
  connectorsInTab,
  connectorsPageAccess,
} from './connectors-catalog';
import {
  useConnectorCatalog,
  useServerFeatureFlags,
  useWorkspaceServices,
} from './connectors-queries';
import { useConnectService } from './use-connect-service';
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
  const connect = useConnectService(serverId, workspaceId);

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
  // The profile replaces the whole page, title included: it is a place of its
  // own, reached from the catalog, with the way back at its top. Same column
  // as `ServerPage`, so moving between the two does not shift the content.
  // A failed re-read keeps the last data, so the profile says so rather than
  // showing what may no longer be true as if it were.
  if (opened)
    return (
      <div className="relative z-10 flex min-h-0 flex-1 flex-col bg-background">
        <div className="flex min-h-0 flex-1 flex-col overflow-auto">
          <div className="mx-auto w-full space-y-4 p-6" style={{ maxWidth: 880 }}>
            {catalog.isError && (
              <CatalogError error={catalog.error} onRetry={() => void catalog.refetch()} />
            )}
            <ConnectorProfile
              serverId={serverId}
              workspaceId={workspaceId}
              connection={opened}
              administers={administers}
              onBack={() => setOpen(null)}
            />
          </div>
        </div>
      </div>
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
            placeholder="Search by name, category or description"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        )}
      </div>
      {shownTab === 'workspace' ? (
        <WorkspaceServicesSection workspaceId={workspaceId} services={workspaceServices} />
      ) : catalog.isError ? (
        <CatalogError error={catalog.error} onRetry={() => void catalog.refetch()} />
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
          onConnect={(entry) => connect(entry, 'connect')}
        />
      )}
    </ServerPage>
  );
}

function CatalogError({ error, onRetry }: { error: unknown; onRetry: () => void }) {
  return (
    <Alert variant="destructive">
      <AlertDescription>{failureText(error, 'Could not load the connectors.')}</AlertDescription>
      <AlertAction>
        <Button size="sm" variant="outline" onClick={onRetry}>
          Retry
        </Button>
      </AlertAction>
    </Alert>
  );
}

function ConnectorGrid({
  entries,
  tab,
  query,
  onOpen,
  onConnect,
}: {
  entries: ConnectionCatalogEntry[];
  tab: 'yours' | 'discover';
  query: string;
  onOpen: (slug: string) => void;
  onConnect: (entry: ConnectionCatalogEntry) => void;
}) {
  if (entries.length === 0)
    return (
      <p className="text-sm text-foreground-muted">
        {query.trim()
          ? `No connector matches “${query.trim()}”.`
          : tab === 'yours'
            ? 'You have not connected anything yet. Find a service under Discover.'
            : 'This server offers no connectors.'}
      </p>
    );
  return (
    <div
      role="group"
      aria-label="Connectors"
      className="grid grid-cols-[repeat(auto-fill,minmax(320px,1fr))] gap-3"
    >
      {entries.map((entry) => (
        <ConnectorCard
          key={entry.slug}
          entry={entry}
          onOpen={() => onOpen(entry.slug)}
          onConnect={() => onConnect(entry)}
        />
      ))}
    </div>
  );
}

/**
 * One catalog card, showing one state with its reason. The whole card opens
 * the profile; the control at its top right connects in one click, or marks
 * a connection that is there and usable. Disconnecting is only on the profile.
 */
function ConnectorCard({
  entry,
  onOpen,
  onConnect,
}: {
  entry: ConnectionCatalogEntry;
  onOpen: () => void;
  onConnect: () => void;
}) {
  const state = connectorCardState(entry);
  const quick = cardQuickAction(entry, state);
  const comingSoon = state.kind === 'coming_soon';
  return (
    <div
      className={cn(
        'relative flex items-start gap-3 rounded-lg border border-border p-4 transition-colors',
        comingSoon ? 'opacity-60' : 'hover:bg-background-tertiary-2'
      )}
    >
      <ConnectionIcon slug={entry.slug} name={entry.name} size="lg" />
      <button
        type="button"
        disabled={comingSoon}
        onClick={onOpen}
        className="focus-visible:ring-ring min-w-0 flex-1 rounded-sm text-left focus-visible:ring-2 focus-visible:outline-none enabled:cursor-pointer disabled:cursor-not-allowed"
      >
        {/* Stretched over the card, so the whole card opens the profile while the
            control beside it keeps its own target. */}
        <span aria-hidden className="absolute inset-0 rounded-lg" />
        <span className="block truncate text-sm font-medium text-foreground">{entry.name}</span>
        <span className="mt-1 line-clamp-2 block text-sm text-foreground-muted">
          {entry.description}
        </span>
        <span className="mt-2 flex flex-wrap items-center gap-2 text-xs text-foreground-muted">
          {entry.category}
          {state.kind !== 'connect' && state.kind !== 'connected' && (
            <Badge variant={TONE_BADGE[state.tone]}>{state.label}</Badge>
          )}
        </span>
        {state.detail && (
          <span className="mt-1 block text-xs text-foreground-muted">{state.detail}</span>
        )}
      </button>
      {quick === 'connect' && (
        <Button
          variant="outline"
          size="icon"
          className="relative z-10 shrink-0"
          aria-label={`Connect ${entry.name}`}
          title={`Connect ${entry.name}`}
          onClick={onConnect}
        >
          <Plus className="size-4" />
        </Button>
      )}
      {quick === 'connected' && (
        <span
          role="img"
          aria-label={`${entry.name} connected`}
          title="Connected"
          className="relative z-10 flex size-8 shrink-0 items-center justify-center rounded-md border border-border-success bg-background-success text-foreground-success"
        >
          <Check className="size-4" />
        </span>
      )}
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
