/**
 * Connecting from a Connectors profile: the modal opens the step the catalog
 * entry calls for, a key form for a key service, GitHub's own step for
 * GitHub, and the generic sign-in otherwise.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { ConnectionCatalogEntry } from '@shared/core/switch-servers/connection-catalog';

const switchServers = vi.hoisted(() => ({
  getGitHubConnection: vi.fn(),
  startServiceConnection: vi.fn(),
}));
const workspaces = vi.hoisted(() => ({
  getConnectionAgents: vi.fn(),
  setServiceGrant: vi.fn(),
}));

vi.mock('@renderer/lib/ipc', () => ({
  events: { on: () => () => {} },
  rpc: { switchServers, workspaces },
}));

vi.mock('@renderer/lib/modal/modal-provider', () => ({
  useModalContext: () => ({ setCloseGuard: () => {} }),
}));

import { ConnectServiceModal } from '@renderer/features/connectors/connect-service-modal';
import { Dialog, DialogContent } from '@renderer/lib/ui/dialog';

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

const KEYED = entry({
  slug: 'datadog',
  name: 'Datadog',
  auth_type: 'api_key',
  key: {
    fields: [{ name: 'api_key', label: 'API key', secret: true, help: null, choices: null }],
    help_url: null,
  },
});

let container: HTMLDivElement | null = null;
let root: Root | null = null;

beforeEach(() => {
  for (const mock of [...Object.values(switchServers), ...Object.values(workspaces)])
    mock.mockReset();
});

afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  container?.remove();
  container = null;
  root = null;
});

async function render(connection: ConnectionCatalogEntry): Promise<HTMLElement> {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  await act(async () =>
    root!.render(
      <QueryClientProvider client={client}>
        <Dialog open>
          <DialogContent>
            <ConnectServiceModal
              serverId="server"
              workspaceId="workspace"
              connection={connection}
              startAt="connect"
              onSuccess={() => {}}
              onClose={() => {}}
            />
          </DialogContent>
        </Dialog>
      </QueryClientProvider>
    )
  );
  return document.querySelector<HTMLElement>('[data-slot="dialog-content"]')!;
}

function button(name: RegExp, within: ParentNode): HTMLButtonElement | undefined {
  return [...within.querySelectorAll('button')].find((b) => name.test(b.textContent ?? ''));
}

it('opens a key service on its key form', async () => {
  const modal = await render(KEYED);

  expect(modal.querySelector('[aria-label="Datadog key"]')).not.toBeNull();
  expect(switchServers.startServiceConnection).not.toHaveBeenCalled();
  expect(switchServers.getGitHubConnection).not.toHaveBeenCalled();
});

it('opens GitHub on its own step', async () => {
  switchServers.getGitHubConnection.mockResolvedValue({
    status: 'not_connected',
    install_url: 'https://github.com/apps/example/installations/new',
  });
  const modal = await render(entry({ slug: 'github', name: 'GitHub', pass_through: false }));

  await vi.waitFor(() => expect(button(/^connect github\s*$/i, modal)).toBeDefined());
  expect(switchServers.getGitHubConnection).toHaveBeenCalledWith('server');
});

it('opens any other service on the sign-in', async () => {
  const modal = await render(entry({}));

  expect(button(/^connect example/i, modal)).toBeDefined();
  expect(modal.querySelector('[aria-label="Example key"]')).toBeNull();
  expect(switchServers.getGitHubConnection).not.toHaveBeenCalled();
});
