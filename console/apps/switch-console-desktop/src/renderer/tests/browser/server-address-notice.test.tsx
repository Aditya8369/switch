/**
 * The server page's suggestion that a saved server's agent address has moved:
 * shown only on a mismatch, dismissable, and applied only after a
 * confirmation, through the same save the edit form uses.
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SwitchServer } from '@shared/core/switch-servers/switch-servers';

const checkServerAddresses = vi.hoisted(() => vi.fn());
const updateServer = vi.hoisted(() => vi.fn());

vi.hoisted(() => {
  window.electronAPI ??= {
    invoke: () => Promise.resolve(undefined),
    eventOn: () => () => {},
    eventSend: () => {},
  } as unknown as typeof window.electronAPI;
});

vi.mock('@renderer/lib/ipc', () => ({
  events: { on: () => () => {} },
  rpc: { switchServers: { checkServerAddresses } },
}));

vi.mock('@renderer/features/switch-servers/switch-servers-store', () => ({
  switchServersStore: { updateServer, errorText: null },
}));

vi.mock('@renderer/lib/telemetry/report', () => ({ report: vi.fn() }));

import { ServerAddressNotice } from '@renderer/features/switch-servers/server-address-notice';
import { resetDismissedNotices } from '@renderer/features/switch-servers/server-address-notice-state';

const SERVER: SwitchServer = {
  id: 'srv-1',
  name: 'Pilot',
  gatewayUrl: 'https://switch.example.com',
  apiUrl: 'http://10.0.0.5:8000',
  managed: false,
  managementKind: null,
  sshHost: null,
  createdAt: '',
  updatedAt: '',
};
const ADVERTISED = 'https://switch-api.example.com';

let container: HTMLDivElement | null = null;
let root: Root | null = null;

beforeEach(() => {
  checkServerAddresses.mockReset();
  updateServer.mockReset();
  resetDismissedNotices();
});

afterEach(async () => {
  await act(async () => root?.unmount());
  container?.remove();
  container = null;
  root = null;
});

async function render(): Promise<HTMLElement> {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => root!.render(<ServerAddressNotice server={SERVER} />));
  // Let the check's promise settle.
  await act(async () => {});
  return container;
}

function button(el: HTMLElement, label: string): HTMLButtonElement {
  const found = [...el.querySelectorAll<HTMLButtonElement>('button')].find(
    (b) => b.textContent?.trim() === label
  );
  expect(found, `no ${label} button`).toBeDefined();
  return found!;
}

describe('the address notice', () => {
  it.each([{ status: 'match' }, { status: 'unknown' }])(
    'shows nothing on $status',
    async (check) => {
      checkServerAddresses.mockResolvedValue(check);
      const el = await render();

      expect(el.textContent).toBe('');
    }
  );

  it('names both addresses on a mismatch', async () => {
    checkServerAddresses.mockResolvedValue({
      status: 'mismatch',
      savedApiUrl: SERVER.apiUrl,
      advertisedApiUrl: ADVERTISED,
    });
    const el = await render();

    expect(el.textContent).toContain(SERVER.apiUrl);
    expect(el.textContent).toContain(ADVERTISED);
  });

  it('changes nothing when dismissed', async () => {
    checkServerAddresses.mockResolvedValue({
      status: 'mismatch',
      savedApiUrl: SERVER.apiUrl,
      advertisedApiUrl: ADVERTISED,
    });
    const el = await render();

    await act(async () => button(el, 'Dismiss').click());

    expect(el.textContent).toBe('');
    expect(updateServer).not.toHaveBeenCalled();
  });

  it('saves the suggested address only after the confirmation', async () => {
    checkServerAddresses.mockResolvedValue({
      status: 'mismatch',
      savedApiUrl: SERVER.apiUrl,
      advertisedApiUrl: ADVERTISED,
    });
    updateServer.mockResolvedValue({
      server: { ...SERVER, apiUrl: ADVERTISED },
      propagation: { apiUrlChanged: true, agents: [] },
    });
    const el = await render();

    await act(async () => button(el, 'Use suggested address').click());
    expect(updateServer).not.toHaveBeenCalled();
    expect(el.textContent).toContain('restarts the agents this computer runs');

    await act(async () => button(el, 'Switch agents to it').click());

    expect(updateServer).toHaveBeenCalledWith(
      'srv-1',
      'Pilot',
      'https://switch.example.com',
      ADVERTISED
    );
    expect(el.textContent).toBe('');
  });
});
