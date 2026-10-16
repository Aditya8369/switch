/**
 * The Connectors page of the workspace in scope: its grid shows the
 * workspace's catalog, a service that cannot be used here says so, and a
 * catalog that cannot be read shows the real error with a way to retry
 * rather than an empty grid.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { ConnectionCatalogEntry } from '@shared/core/switch-servers/connection-catalog';
import { RpcError, serializeRpcError } from '@shared/lib/ipc/rpc-error';

const workspaces = vi.hoisted(() => ({
  getServiceConnections: vi.fn(),
  getConnectionAgents: vi.fn(),
  getWorkspaceServices: vi.fn(),
}));
const featureFlags = vi.hoisted(() => ({
  get: vi.fn(async () => ({
    success: true,
    data: {
      serverId: 'server',
      flags: { service_connections: true },
      fetchedAt: 1,
      error: null,
    },
  })),
}));

vi.mock('@renderer/lib/ipc', () => ({
  events: { on: () => () => {} },
  rpc: { workspaces, featureFlags },
}));

vi.mock('@renderer/features/workspaces/workspaces-store', () => ({
  workspacesStore: { idOnServerInScope: () => 'workspace' },
}));

vi.mock('@renderer/features/switch-servers/workspace-admin', () => ({
  administersWorkspaceInScope: () => false,
}));

vi.mock('@renderer/lib/layout/navigation-provider', () => ({
  useNavigate: () => ({ navigate: () => {} }),
  useParams: () => ({ params: { serverId: 'server' } }),
}));

vi.mock('@renderer/lib/modal/modal-provider', () => ({
  useShowModal: () => () => {},
  useModalContext: () => ({ setCloseGuard: () => {} }),
}));

import { connectorsView } from '@renderer/features/connectors/connectors-view';

function entry(overrides: Partial<ConnectionCatalogEntry>): ConnectionCatalogEntry {
  return {
    slug: 'example',
    name: 'Example',
    category: 'Development',
    description: 'Example access',
    enabled: true,
    auth_type: 'oauth',
    connectable: true,
    status: 'not_connected',
    unavailable_reason: null,
    pass_through: true,
    token_lifetime: 3600,
    loopback_ports: null,
    key: null,
    external_identity: null,
    consent: null,
    workspace_enabled: true,
    ...overrides,
  };
}

const CATALOG = [
  entry({ slug: 'atlassian', name: 'Atlassian', status: 'connected', external_identity: 'ada' }),
  entry({ slug: 'example', name: 'Example' }),
  entry({ slug: 'linear', name: 'Linear', enabled: false, status: 'coming_soon' }),
  entry({
    slug: 'github',
    name: 'GitHub',
    connectable: false,
    unavailable_reason: 'GitHub is not set up on this server.',
  }),
];

let container: HTMLDivElement | null = null;
let root: Root | null = null;

beforeEach(() => {
  for (const mock of Object.values(workspaces)) mock.mockReset();
  workspaces.getConnectionAgents.mockResolvedValue([]);
  workspaces.getWorkspaceServices.mockResolvedValue(null);
});

afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  container?.remove();
  container = null;
  root = null;
});

async function render(): Promise<HTMLElement> {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  const Panel = connectorsView.MainPanel;
  await act(async () =>
    root!.render(
      <QueryClientProvider client={client}>
        <Panel />
      </QueryClientProvider>
    )
  );
  return container;
}

function button(name: RegExp, within: ParentNode): HTMLButtonElement | undefined {
  return [...within.querySelectorAll('button')].find((b) => name.test(b.textContent ?? ''));
}

function grid(page: HTMLElement): HTMLElement | null {
  return page.querySelector<HTMLElement>(
    '[role="group"][aria-label="Connectors"]:not([data-slot="toggle-group"])'
  );
}

it("shows the workspace's catalog, what the person has on Yours and everything on Discover", async () => {
  workspaces.getServiceConnections.mockResolvedValue(CATALOG);
  const page = await render();

  await vi.waitFor(() => expect(grid(page)).not.toBeNull());
  expect(workspaces.getServiceConnections).toHaveBeenCalledWith('workspace');
  expect(button(/^Atlassian/, grid(page)!)).toBeDefined();
  expect(button(/^Example/, grid(page)!)).toBeUndefined();
  expect(page.querySelector('[aria-label="Atlassian connected"]')).not.toBeNull();

  await act(async () => page.querySelector<HTMLElement>('button[aria-label="Discover"]')!.click());
  await vi.waitFor(() => expect(button(/^Example/, grid(page)!)).toBeDefined());
  expect(page.querySelector('button[aria-label="Connect Example"]')).not.toBeNull();
  expect(button(/^Linear/, grid(page)!)?.disabled).toBe(true);
  expect(button(/^Linear/, grid(page)!)?.textContent).toMatch(/Coming soon/);
});

it('marks a service the server cannot use, without offering to connect it', async () => {
  workspaces.getServiceConnections.mockResolvedValue(CATALOG);
  const page = await render();
  await vi.waitFor(() => expect(grid(page)).not.toBeNull());
  await act(async () => page.querySelector<HTMLElement>('button[aria-label="Discover"]')!.click());

  await vi.waitFor(() => expect(button(/^GitHub/, grid(page)!)).toBeDefined());
  expect(button(/^GitHub/, grid(page)!)!.textContent).toMatch(/Unavailable/);
  expect(page.querySelector('button[aria-label="Connect GitHub"]')).toBeNull();
});

it('shows the real error when the catalog cannot be read, with Retry', async () => {
  workspaces.getServiceConnections.mockRejectedValue(
    new RpcError(
      serializeRpcError(
        Object.assign(new Error('Switch gateway returned 404'), {
          name: 'GatewayError',
          kind: 'http',
          status: 404,
          detail: 'Not Found',
        })
      )
    )
  );
  const page = await render();

  await vi.waitFor(() =>
    expect(page.querySelector('[role="alert"]')?.textContent).toContain(
      'Could not load the connectors. (HTTP 404: Not Found)'
    )
  );
  expect(grid(page)).toBeNull();

  workspaces.getServiceConnections.mockResolvedValue(CATALOG);
  await act(async () => button(/^retry$/i, page)!.click());
  await vi.waitFor(() => expect(grid(page)).not.toBeNull());
});
