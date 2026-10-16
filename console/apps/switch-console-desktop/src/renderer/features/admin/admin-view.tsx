import { ShieldCheck } from 'lucide-react';
import { observer } from 'mobx-react-lite';
import { useEffect, useState } from 'react';
import type { GuardResult, ViewDefinition } from '@renderer/app/view-registry';
import { connectorsPageAccess } from '@renderer/features/connectors/connectors-catalog';
import { useServerFeatureFlags } from '@renderer/features/connectors/connectors-queries';
import { ServerPage } from '@renderer/features/switch-servers/server-page';
import { ServerSectionTitlebar } from '@renderer/features/switch-servers/server-section-titlebar';
import { administersWorkspaceInScope } from '@renderer/features/switch-servers/workspace-admin';
import { workspacesStore } from '@renderer/features/workspaces/workspaces-store';
import { useNavigate, useParams } from '@renderer/lib/layout/navigation-provider';
import { SearchInput } from '@renderer/lib/ui/search-input';
import { SegmentedControl } from '@renderer/lib/ui/segmented-control';
import { Spinner } from '@renderer/lib/ui/spinner';
import { ADMIN_TAB_LABELS, type AdminTab, adminTabs, shownAdminTab } from './admin-tabs';
import { WorkspaceSwitchesTab } from './workspace-switches-tab';

type AdminParams = {
  serverId: string;
  /** The tab asked for; the first the person may use when absent or not theirs. */
  tab?: AdminTab;
};

const WIDTH = 880;

const AdminTitlebar = observer(function AdminTitlebar() {
  const { serverId } = useParams('admin').params;
  return <ServerSectionTitlebar serverId={serverId} icon={ShieldCheck} label="Admin" />;
});

/**
 * What the workspace's admins, and the server's operator, manage for other
 * people: one page, with a tab for each thing, each shown only to the role
 * that may use it. Like the Connectors page it is behind the server's
 * `service_connections` flag, since everything on it is about connectors:
 * with it off there is no page, and reaching it anyway goes to Your Agents.
 */
const AdminPanel = observer(function AdminPanel() {
  const { params } = useParams('admin');
  const { serverId } = params;
  const { navigate } = useNavigate();
  const access = connectorsPageAccess(useServerFeatureFlags(serverId));
  const workspace = workspacesStore.onServerInScope(serverId);
  useEffect(() => {
    if (access === 'absent') navigate('serverAgents', { serverId });
  }, [access, navigate, serverId]);

  if (access !== 'shown' || workspace === null)
    return (
      <ServerPage width={WIDTH} title="Admin" description="">
        <Spinner />
      </ServerPage>
    );
  const tabs = adminTabs({ administers: administersWorkspaceInScope(serverId) });
  // Keyed so a workspace switch starts the search afresh.
  return (
    <Admin
      key={workspace.id}
      tabs={tabs}
      tab={shownAdminTab(tabs, params.tab)}
      workspace={workspace}
      onTab={(tab) => navigate('admin', { serverId, tab })}
    />
  );
});

function Admin({
  tabs,
  tab,
  workspace,
  onTab,
}: {
  tabs: AdminTab[];
  tab: AdminTab | null;
  workspace: { id: string; name: string };
  onTab: (tab: AdminTab) => void;
}) {
  const [query, setQuery] = useState('');
  if (tab === null)
    return (
      <ServerPage
        width={WIDTH}
        title="Admin"
        description="Only an admin of this workspace, or the operator of this server, manages what is here."
      >
        {null}
      </ServerPage>
    );
  return (
    <ServerPage width={WIDTH} title="Admin" description={tabDescription(tab, workspace.name)}>
      <div className="flex items-center gap-3">
        {/* One tab is a title, not a choice. */}
        {tabs.length > 1 && (
          <SegmentedControl
            ariaLabel="Admin"
            value={tab}
            onChange={onTab}
            options={tabs.map((value) => ({ value, label: ADMIN_TAB_LABELS[value] }))}
          />
        )}
        <SearchInput
          containerClassName="flex-1"
          aria-label="Search services"
          placeholder="Search by name or category"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
      </div>
      <WorkspaceSwitchesTab workspaceId={workspace.id} query={query} />
    </ServerPage>
  );
}

/** Each tab says who it reaches, since the tabs reach different people. */
function tabDescription(tab: AdminTab, workspaceName: string): string {
  switch (tab) {
    case 'connectors':
      return `Turn a service on or off for everyone in ${workspaceName}. Switched off, nobody here can connect it, grant it or use it, and agents that have it lose it within a minute. Grants are kept, so switching it back on returns them.`;
  }
}

export const adminView = {
  WrapView: ({ children }: { children: React.ReactNode } & AdminParams) => <>{children}</>,
  TitlebarSlot: AdminTitlebar,
  MainPanel: AdminPanel,
  canActivate: (params: unknown): GuardResult => {
    const serverId =
      typeof params === 'object' && params !== null
        ? (params as { serverId?: unknown }).serverId
        : undefined;
    if (typeof serverId !== 'string') return { ok: false, redirect: 'home' };
    return { ok: true };
  },
} satisfies ViewDefinition<AdminParams>;
