/**
 * The generic sign-in step: it starts the sign-in at the vendor, waits for the
 * browser to finish, and keeps the account only once the person confirms it.
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { ConnectionCatalogEntry } from '@shared/core/switch-servers/connection-catalog';

const switchServers = vi.hoisted(() => ({
  startServiceConnection: vi.fn(),
  getServiceFlow: vi.fn(),
  confirmServiceConnection: vi.fn(),
  cancelServiceConnection: vi.fn(),
  disconnectService: vi.fn(),
}));

vi.mock('@renderer/lib/ipc', () => ({
  events: { on: () => () => {} },
  rpc: { switchServers },
}));

vi.mock('@renderer/lib/modal/modal-provider', () => ({
  useModalContext: () => ({ setCloseGuard: () => {} }),
}));

import { ServiceConnectStep } from '@renderer/features/switch-servers/service-connect-step';
import { Dialog, DialogContent } from '@renderer/lib/ui/dialog';

const EXAMPLE: ConnectionCatalogEntry = {
  slug: 'example',
  name: 'Example',
  category: 'Development',
  description: 'Example access',
  enabled: true,
  auth_type: 'oauth',
  connectable: true,
  status: 'not_connected',
  unavailable_reason: null,
  pass_through: false,
  token_lifetime: null,
  loopback_ports: null,
  key: null,
  external_identity: null,
  consent: null,
  workspace_enabled: null,
};

let container: HTMLDivElement | null = null;
let root: Root | null = null;

beforeEach(() => {
  for (const mock of Object.values(switchServers)) mock.mockReset();
});

afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  container?.remove();
  container = null;
  root = null;
});

async function render(onConnected: (warning: string | null) => void): Promise<void> {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () =>
    root!.render(
      <Dialog open>
        <DialogContent>
          <ServiceConnectStep
            serverId="server"
            connection={EXAMPLE}
            onBack={() => {}}
            onConnected={onConnected}
          />
        </DialogContent>
      </Dialog>
    )
  );
}

function button(name: RegExp, within: ParentNode = document): HTMLButtonElement | undefined {
  return [...within.querySelectorAll('button')].find((b) => name.test(b.textContent ?? ''));
}

function dialog(): HTMLElement {
  return document.querySelector<HTMLElement>('[data-slot="dialog-content"]')!;
}

it('connects through the sign-in, once the person confirms the account', async () => {
  switchServers.startServiceConnection.mockResolvedValue('flow-1');
  switchServers.getServiceFlow.mockResolvedValue({
    status: 'ready',
    account: 'ada@example.test',
    error: null,
  });
  switchServers.confirmServiceConnection.mockResolvedValue({ warning: null });
  const onConnected = vi.fn();
  await render(onConnected);

  await vi.waitFor(() => expect(button(/^connect example/i, dialog())).toBeDefined());
  await act(async () => button(/^connect example/i, dialog())!.click());
  expect(switchServers.startServiceConnection).toHaveBeenCalledWith('server', 'example');

  await vi.waitFor(() => expect(dialog().textContent).toMatch(/Signed in as ada@example\.test/));
  await act(async () => button(/^connect ada@example\.test/i, dialog())!.click());
  expect(switchServers.confirmServiceConnection).toHaveBeenCalledWith(
    'server',
    'example',
    'flow-1'
  );
  expect(onConnected).toHaveBeenCalledWith(null);
  await vi.waitFor(() => expect(dialog().textContent).toMatch(/Example connected/));
  expect(button(/^disconnect$/i, dialog())).toBeDefined();
});
