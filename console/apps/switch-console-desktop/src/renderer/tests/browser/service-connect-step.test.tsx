/**
 * The generic sign-in step: it starts the sign-in at the vendor, waits for the
 * browser to finish, and keeps the account only once the person confirms it,
 * on one screen whose content and button the caller chooses. A refusal never
 * strands the dialog: one the server will not take back drops the sign-in and
 * lets the dialog close, and a cancel of a sign-in already gone is a cancel.
 */
import { type ReactNode, act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { ConnectionCatalogEntry } from '@shared/core/switch-servers/connection-catalog';
import { RpcError, serializeRpcError } from '@shared/lib/ipc/rpc-error';

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

import { serverServiceCalls } from '@renderer/features/switch-servers/service-calls';
import {
  ServiceConnectStep,
  ServiceSignInStep,
} from '@renderer/features/switch-servers/service-connect-step';
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

async function render(step: ReactNode): Promise<void> {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () =>
    root!.render(
      <Dialog open>
        <DialogContent>{step}</DialogContent>
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

function closable(): boolean {
  return dialog().querySelector('[data-slot="dialog-close"]') !== null;
}

function refusal(status: number, detail: string, retryable?: boolean): RpcError {
  return new RpcError(
    serializeRpcError(
      Object.assign(new Error(`Switch gateway returned ${status}`), {
        name: 'GatewayError',
        kind: 'http',
        status,
        detail,
        ...(retryable === undefined ? {} : { retryable }),
      })
    )
  );
}

/** Starts a sign-in and waits for the signed-in screen. */
async function signIn(): Promise<void> {
  switchServers.startServiceConnection.mockResolvedValue('flow-1');
  switchServers.getServiceFlow.mockResolvedValue({
    status: 'ready',
    account: 'ada@example.test',
    error: null,
  });
  await vi.waitFor(() => expect(button(/^connect example/i, dialog())).toBeDefined());
  await act(async () => button(/^connect example/i, dialog())!.click());
  await vi.waitFor(() => expect(dialog().textContent).toMatch(/Signed in as ada@example\.test/));
}

function signInStep(onConnected: (warning: string | null) => Promise<void>): ReactNode {
  return (
    <ServiceSignInStep
      calls={serverServiceCalls('server')}
      connection={EXAMPLE}
      onBack={() => {}}
      readyContent={(busy) => <p data-testid="ready">{busy ? 'Busy' : 'Your agents'}</p>}
      confirmLabel={() => 'Connect and turn on for 2 agents'}
      onConnected={onConnected}
    />
  );
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
  await render(
    <ServiceConnectStep
      calls={serverServiceCalls('server')}
      connection={EXAMPLE}
      onBack={() => {}}
      onConnected={onConnected}
    />
  );

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

it('shows the account, what the caller puts under it and its one button on one screen', async () => {
  switchServers.confirmServiceConnection.mockResolvedValue({ warning: null });
  let finish = () => {};
  const onConnected = vi.fn(() => new Promise<void>((resolve) => (finish = resolve)));
  await render(signInStep(onConnected));
  await signIn();

  expect(dialog().querySelector('[data-testid="ready"]')?.textContent).toBe('Your agents');
  expect(closable()).toBe(false);
  await act(async () => button(/^connect and turn on for 2 agents$/i, dialog())!.click());
  expect(switchServers.confirmServiceConnection).toHaveBeenCalledWith(
    'server',
    'example',
    'flow-1'
  );
  expect(onConnected).toHaveBeenCalledWith(null);
  // Still on the one screen, busy, until what follows the confirm is done.
  expect(dialog().querySelector('[data-testid="ready"]')?.textContent).toBe('Busy');

  await act(async () => finish());
  await vi.waitFor(() => expect(dialog().textContent).toMatch(/Example connected/));
});

it('drops a sign-in whose confirm is refused for good, and lets the dialog close', async () => {
  switchServers.confirmServiceConnection.mockRejectedValue(
    refusal(
      409,
      'This Example account is already linked to another Switch user in this workspace. Remove that link first.',
      false
    )
  );
  const onConnected = vi.fn(async () => {});
  await render(signInStep(onConnected));
  await signIn();

  await act(async () => button(/^connect and turn on/i, dialog())!.click());
  await vi.waitFor(() =>
    expect(dialog().querySelector('[role="alert"]')?.textContent).toContain(
      'already linked to another Switch user'
    )
  );
  expect(onConnected).not.toHaveBeenCalled();
  expect(closable()).toBe(true);
  expect(button(/^cancel$/i, dialog())).toBeUndefined();
  expect(button(/^connect example/i, dialog())).toBeDefined();
});

it('counts a cancel of a sign-in the server already dropped as cancelled', async () => {
  switchServers.cancelServiceConnection.mockRejectedValue(refusal(410, 'Sign-in not found.'));
  await render(signInStep(async () => {}));
  await signIn();

  await act(async () => button(/^cancel$/i, dialog())!.click());
  await vi.waitFor(() => expect(button(/^connect example/i, dialog())).toBeDefined());
  expect(dialog().querySelector('[role="alert"]')).toBeNull();
  expect(closable()).toBe(true);
});
