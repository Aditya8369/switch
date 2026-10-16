/**
 * The Connectors page of the workspace in scope: its grid shows the
 * workspace's catalog, a service that cannot be used here says so, and a
 * catalog that cannot be read shows the real error with a way to retry
 * rather than an empty grid. A profile shows the truth after a disconnect,
 * made in the page's workspace: the page is re-read before the dialog
 * closes, and a re-read that fails says so on the profile.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, useEffect, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { ConnectionCatalogEntry } from '@shared/core/switch-servers/connection-catalog';
import { RpcError, serializeRpcError } from '@shared/lib/ipc/rpc-error';

const workspaces = vi.hoisted(() => ({
  getServiceConnections: vi.fn(),
  getConnectionAgents: vi.fn(),
  getWorkspaceServices: vi.fn(),
  disconnectService: vi.fn(),
}));
const modalHost = vi.hoisted(() => ({
  show: (_id: string, _args: unknown): void => {
    throw new Error('No modal host is mounted.');
  },
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
  useShowModal: (id: string) => (args: unknown) => modalHost.show(id, args),
  useModalContext: () => ({ setCloseGuard: () => {} }),
}));

import { connectorsView } from '@renderer/features/connectors/connectors-view';
import { DisconnectServiceDialog } from '@renderer/features/connectors/disconnect-dialog';
import { Dialog, DialogContent } from '@renderer/lib/ui/dialog';

type DisconnectArgs = {
  workspaceId: string;
  connection: ConnectionCatalogEntry;
  onSuccess?: (result: unknown) => void;
};

/** Stands in for the modal renderer: shows the disconnect dialog once the profile asks for it. */
function ModalHost() {
  const [shown, setShown] = useState<{ id: string; args: DisconnectArgs } | null>(null);
  useEffect(() => {
    modalHost.show = (id, args) => setShown({ id, args: args as DisconnectArgs });
  }, []);
  if (shown?.id !== 'disconnectServiceModal') return null;
  const { args } = shown;
  return (
    <Dialog open>
      <DialogContent>
        <DisconnectServiceDialog
          workspaceId={args.workspaceId}
          connection={args.connection}
          onSuccess={(result) => {
            setShown(null);
            args.onSuccess?.(result);
          }}
          onClose={() => setShown(null)}
        />
      </DialogContent>
    </Dialog>
  );
}

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
        <ModalHost />
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

it('marks a service the server cannot use with its reason, without offering to connect it', async () => {
  workspaces.getServiceConnections.mockResolvedValue(CATALOG);
  const page = await render();
  await vi.waitFor(() => expect(grid(page)).not.toBeNull());
  await act(async () => page.querySelector<HTMLElement>('button[aria-label="Discover"]')!.click());

  await vi.waitFor(() => expect(button(/^GitHub/, grid(page)!)).toBeDefined());
  expect(button(/^GitHub/, grid(page)!)!.textContent).toMatch(/Unavailable/);
  expect(button(/^GitHub/, grid(page)!)!.textContent).toContain(
    'GitHub is not set up on this server.'
  );
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

/** The catalog and agents as the server answers before and after Atlassian is disconnected. */
function serveDisconnect(): void {
  let connected = true;
  workspaces.getServiceConnections.mockImplementation(async () =>
    CATALOG.map((item) =>
      item.slug === 'atlassian' && !connected
        ? { ...item, status: 'not_connected', external_identity: null }
        : item
    )
  );
  workspaces.getConnectionAgents.mockImplementation(async () => [
    { agent_id: 'm1', name: 'M1', granted: connected, addressing_open: false },
  ]);
  workspaces.disconnectService.mockImplementation(async () => {
    connected = false;
    return { warning: null };
  });
}

async function openAtlassian(page: HTMLElement): Promise<void> {
  await vi.waitFor(() => expect(button(/^Atlassian/, grid(page)!)).toBeDefined());
  await act(async () => button(/^Atlassian/, grid(page)!)!.click());
  await vi.waitFor(() => expect(page.querySelector('h1')?.textContent).toBe('Atlassian'));
  await vi.waitFor(() => expect(page.textContent).toContain('M1'));
}

async function disconnect(page: HTMLElement): Promise<void> {
  await act(async () => button(/^Disconnect$/, page)!.click());
  const dialog = () => document.querySelector<HTMLElement>('[data-slot="dialog-content"]');
  await vi.waitFor(() => expect(dialog()?.textContent).toContain('M1 loses Atlassian'));
  await act(async () => button(/^Disconnect$/, dialog()!)!.click());
  await vi.waitFor(() => expect(dialog()).toBeNull());
}

it('offers Connect on the profile after a disconnect, made in the workspace shown', async () => {
  serveDisconnect();
  const page = await render();
  await openAtlassian(page);

  await disconnect(page);
  expect(workspaces.disconnectService).toHaveBeenCalledWith({
    workspaceId: 'workspace',
    service: 'atlassian',
  });
  expect(button(/^Connect to Switch$/, page)).toBeDefined();
  expect(button(/^Disconnect$/, page)).toBeUndefined();
  expect(page.textContent).not.toContain('Connected as ada');
  expect(page.textContent).toContain('None of your agents use it.');
});

it('says on the profile when re-reading the catalog fails, with Retry', async () => {
  serveDisconnect();
  const page = await render();
  await openAtlassian(page);
  const serve = workspaces.getServiceConnections.getMockImplementation()!;
  workspaces.getServiceConnections.mockRejectedValue(new Error('Switch is down.'));

  await disconnect(page);
  await vi.waitFor(() =>
    expect(page.querySelector('[role="alert"]')?.textContent).toContain(
      'Could not load the connectors.'
    )
  );

  workspaces.getServiceConnections.mockImplementation(serve);
  await act(async () => button(/^retry$/i, page)!.click());
  await vi.waitFor(() => expect(button(/^Connect to Switch$/, page)).toBeDefined());
  expect(page.querySelector('[role="alert"]')).toBeNull();
});

it('shows a connection the workspace has switched off as off, not as connected', async () => {
  workspaces.getServiceConnections.mockResolvedValue([
    entry({ slug: 'atlassian', name: 'Atlassian', status: 'connected', workspace_enabled: false }),
  ]);
  const page = await render();

  await vi.waitFor(() => expect(button(/^Atlassian/, grid(page)!)).toBeDefined());
  expect(page.querySelector('[aria-label="Atlassian connected"]')).toBeNull();
  expect(button(/^Atlassian/, grid(page)!)!.textContent).toContain('Off in this workspace');
  expect(button(/^Atlassian/, grid(page)!)!.textContent).toContain(
    'A workspace admin has switched it off.'
  );
});
