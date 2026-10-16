/**
 * Connecting from a Connectors profile, in the profile's workspace: the modal
 * opens the step the catalog entry calls for, a key form for a key service, GitHub's own step for
 * GitHub, and the generic sign-in otherwise. Once signed in, one screen
 * confirms the account and then turns the service on for each agent ticked;
 * a refused confirm turns nothing on.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { ConnectionCatalogEntry } from '@shared/core/switch-servers/connection-catalog';
import { RpcError, serializeRpcError } from '@shared/lib/ipc/rpc-error';

const switchServers = vi.hoisted(() => ({
  getGitHubConnection: vi.fn(),
}));
const workspaces = vi.hoisted(() => ({
  getConnectionAgents: vi.fn(),
  setServiceGrant: vi.fn(),
  startServiceConnection: vi.fn(),
  getServiceFlow: vi.fn(),
  confirmServiceConnection: vi.fn(),
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
  workspaces.getConnectionAgents.mockResolvedValue([
    { agent_id: 'm1', name: 'M1', granted: false, addressing_open: false },
    { agent_id: 'm2', name: 'M2', granted: false, addressing_open: true },
  ]);
});

afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  container?.remove();
  container = null;
  root = null;
});

async function render(
  connection: ConnectionCatalogEntry,
  onConnected: () => void = () => {}
): Promise<HTMLElement> {
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
              onConnected={onConnected}
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
  expect(workspaces.startServiceConnection).not.toHaveBeenCalled();
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

/** Signs in through the browser and waits for the one screen. */
async function signIn(modal: HTMLElement): Promise<void> {
  workspaces.startServiceConnection.mockResolvedValue('flow-1');
  workspaces.getServiceFlow.mockResolvedValue({
    status: 'ready',
    account: 'ada@example.test',
    error: null,
  });
  await act(async () => button(/^connect example/i, modal)!.click());
  await vi.waitFor(() => expect(modal.textContent).toMatch(/Signed in as ada@example\.test/));
  await vi.waitFor(() => expect(modal.querySelector('[aria-label="Your agents"]')).not.toBeNull());
}

it('confirms the account, then turns the service on for each agent ticked', async () => {
  workspaces.confirmServiceConnection.mockResolvedValue({ warning: null });
  workspaces.setServiceGrant.mockResolvedValue(null);
  const onConnected = vi.fn();
  const modal = await render(entry({}), onConnected);
  await signIn(modal);

  const agents = modal.querySelector('[aria-label="Your agents"]')!;
  expect(agents.textContent).toBe(
    'M1Others can address these agents; they would act as you. Tick one to turn it on anyway.M2'
  );
  await act(async () => button(/^connect and turn on for 1 agent$/i, modal)!.click());

  await vi.waitFor(() => expect(modal.textContent).toMatch(/Example connected/));
  expect(workspaces.confirmServiceConnection).toHaveBeenCalledWith({
    workspaceId: 'workspace',
    service: 'example',
    flowId: 'flow-1',
  });
  expect(workspaces.setServiceGrant).toHaveBeenCalledOnce();
  expect(workspaces.setServiceGrant).toHaveBeenCalledWith({
    workspaceId: 'workspace',
    agentId: 'm1',
    service: 'example',
    access: null,
    resources: {},
  });
  expect(onConnected).toHaveBeenCalledOnce();
  expect(modal.querySelector('[role="status"]')?.textContent).toBe('Example is on for M1.');
});

it('names an agent it could not turn the service on for', async () => {
  workspaces.confirmServiceConnection.mockResolvedValue({ warning: null });
  workspaces.setServiceGrant.mockRejectedValue(new Error('Agent not found.'));
  const modal = await render(entry({}));
  await signIn(modal);
  await act(async () => button(/^connect and turn on for 1 agent$/i, modal)!.click());

  await vi.waitFor(() =>
    expect(modal.querySelector('[role="alert"]')?.textContent).toMatch(
      /^Could not turn Example on for M1 \(.*\)\. It is not on for any agent\.$/
    )
  );
});

it('turns nothing on when Switch refuses the account', async () => {
  workspaces.confirmServiceConnection.mockRejectedValue(
    new RpcError(
      serializeRpcError(
        Object.assign(new Error('Switch gateway returned 403'), {
          name: 'GatewayError',
          kind: 'http',
          status: 403,
          detail: 'Example is switched off for this workspace.',
          retryable: false,
        })
      )
    )
  );
  const onConnected = vi.fn();
  const modal = await render(entry({}), onConnected);
  await signIn(modal);
  await act(async () => button(/^connect and turn on for 1 agent$/i, modal)!.click());

  await vi.waitFor(() =>
    expect(modal.querySelector('[role="alert"]')?.textContent).toContain(
      'Example is switched off for this workspace.'
    )
  );
  expect(workspaces.setServiceGrant).not.toHaveBeenCalled();
  expect(onConnected).not.toHaveBeenCalled();
  expect(modal.querySelector('[data-slot="dialog-close"]')).not.toBeNull();
});
