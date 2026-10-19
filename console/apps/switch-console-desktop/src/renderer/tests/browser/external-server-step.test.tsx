/**
 * The connect form asks for one address. The rules behind it are tested in
 * `server-address-form.test.ts`; this checks the form puts them on screen:
 * the agent address is shown before anything is saved, it can be changed, it
 * is asked for when the server could not say, an unreachable or malformed
 * address saves nothing, and editing a saved server confirms before it moves
 * the agents.
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SwitchServer } from '@shared/core/switch-servers/switch-servers';

const resolveServerAddress = vi.hoisted(() => vi.fn());
const addServer = vi.hoisted(() => vi.fn());
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
  rpc: { switchServers: { resolveServerAddress } },
}));

vi.mock('@renderer/features/switch-servers/switch-servers-store', () => ({
  switchServersStore: { addServer, updateServer, errorText: null },
}));

vi.mock('@renderer/lib/telemetry/report', () => ({ report: vi.fn() }));

import { ExternalServerStep } from '@renderer/features/switch-servers/AddServerModal';
import { WizardChromeProvider } from '@renderer/lib/ui/wizard-frame';

const DASH = 'https://switch.example.com';
const API = 'https://switch-api.example.com';

function server(overrides: Partial<SwitchServer> = {}): SwitchServer {
  return {
    id: 'srv-1',
    name: 'Pilot',
    gatewayUrl: DASH,
    apiUrl: API,
    managed: false,
    managementKind: null,
    sshHost: null,
    createdAt: '',
    updatedAt: '',
    ...overrides,
  };
}

const discovered = {
  kind: 'resolved',
  gatewayUrl: DASH,
  apiUrl: API,
  apiSource: 'discovered',
  manualReason: null,
  refusedApiUrl: null,
};

let container: HTMLDivElement | null = null;
let root: Root | null = null;
const onConnected = vi.fn();
const onSuccess = vi.fn();

beforeEach(() => {
  resolveServerAddress.mockReset();
  addServer.mockReset();
  updateServer.mockReset();
  onConnected.mockReset();
  onSuccess.mockReset();
});

afterEach(async () => {
  await act(async () => root?.unmount());
  container?.remove();
  container = null;
  root = null;
});

async function render(props: { edit?: SwitchServer } = {}): Promise<HTMLElement> {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  const edit = props.edit ?? null;
  await act(async () =>
    root!.render(
      <WizardChromeProvider chrome="page" exit={null}>
        <ExternalServerStep
          initialGatewayUrl={edit?.gatewayUrl ?? null}
          initialApiUrl={edit?.apiUrl ?? null}
          initialName={edit?.name ?? null}
          serverId={edit?.id ?? null}
          isEdit={edit !== null}
          firstRun={false}
          existing={null}
          onBack={null}
          onClose={() => {}}
          onSuccess={onSuccess}
          onConnected={onConnected}
        />
      </WizardChromeProvider>
    )
  );
  return document.body;
}

function field(el: HTMLElement, label: string): HTMLInputElement | null {
  const match = [...el.querySelectorAll<HTMLElement>('label')].find(
    (l) => l.textContent?.trim() === label
  );
  return (match?.parentElement?.querySelector('input') as HTMLInputElement | null) ?? null;
}

function button(el: HTMLElement, label: string): HTMLButtonElement {
  const found = [...el.querySelectorAll<HTMLButtonElement>('button')].find(
    (b) => b.textContent?.trim() === label
  );
  expect(found, `no ${label} button`).toBeDefined();
  return found!;
}

async function type(input: HTMLInputElement, value: string): Promise<void> {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
  await act(async () => {
    setter.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

async function press(el: HTMLElement, label: string): Promise<void> {
  await act(async () => button(el, label).click());
}

describe('adding a server', () => {
  it('asks for one address and no agent address', async () => {
    const el = await render();

    expect(field(el, 'Server address')).not.toBeNull();
    expect(field(el, 'Agent address')).toBeNull();
    expect(el.textContent).not.toContain('API URL');
  });

  it('shows the agent address the server gave before saving it', async () => {
    resolveServerAddress.mockResolvedValue(discovered);
    addServer.mockResolvedValue(server());
    const el = await render();
    await type(field(el, 'Name')!, 'Pilot');
    await type(field(el, 'Server address')!, DASH);

    await press(el, 'Continue');

    expect(resolveServerAddress).toHaveBeenCalledWith(DASH);
    expect(addServer).not.toHaveBeenCalled();
    expect(el.textContent).toContain('Agents connect to');
    expect(el.textContent).toContain(API);

    await press(el, 'Add server');

    expect(addServer).toHaveBeenCalledWith('Pilot', DASH, API);
    expect(onConnected).toHaveBeenCalled();
  });

  it('saves the agent address the person changed it to', async () => {
    resolveServerAddress.mockResolvedValue(discovered);
    addServer.mockResolvedValue(server());
    const el = await render();
    await type(field(el, 'Name')!, 'Pilot');
    await type(field(el, 'Server address')!, DASH);
    await press(el, 'Continue');

    await press(el, 'Change');
    await type(field(el, 'Agent address')!, 'https://agents.internal.example.com');
    await press(el, 'Add server');

    expect(addServer).toHaveBeenCalledWith('Pilot', DASH, 'https://agents.internal.example.com');
  });

  it('asks for the agent address, saying why, when the server could not say', async () => {
    resolveServerAddress.mockResolvedValue({
      ...discovered,
      apiUrl: null,
      apiSource: 'manual',
      manualReason: 'not_advertised',
    });
    addServer.mockResolvedValue(server());
    const el = await render();
    await type(field(el, 'Name')!, 'Pilot');
    await type(field(el, 'Server address')!, DASH);
    await press(el, 'Continue');

    expect(field(el, 'Agent address')).not.toBeNull();
    expect(el.textContent).toContain("didn't say where agents connect");
    expect(button(el, 'Add server').disabled).toBe(true);

    await type(field(el, 'Agent address')!, API);
    await press(el, 'Add server');

    expect(addServer).toHaveBeenCalledWith('Pilot', DASH, API);
  });

  it('reports an unreachable address and saves nothing', async () => {
    resolveServerAddress.mockResolvedValue({ kind: 'unreachable', address: DASH });
    const el = await render();
    await type(field(el, 'Name')!, 'Pilot');
    await type(field(el, 'Server address')!, DASH);

    await press(el, 'Continue');

    expect(el.textContent).toContain(
      'Could not reach a Switch server at https://switch.example.com'
    );
    expect(addServer).not.toHaveBeenCalled();
  });

  it('refuses an address that is not a URL without asking the server', async () => {
    const el = await render();
    await type(field(el, 'Server address')!, 'ftp://switch.example.com');

    expect(el.textContent).toContain('Enter a full address');
    expect(resolveServerAddress).not.toHaveBeenCalled();
  });
});

describe('editing a connection', () => {
  it('shows the saved addresses, and saving unchanged leaves them alone', async () => {
    updateServer.mockResolvedValue({
      server: server(),
      propagation: { apiUrlChanged: false, agents: [] },
    });
    const el = await render({ edit: server() });

    expect(field(el, 'Server address')!.value).toBe(DASH);
    expect(el.textContent).toContain(API);

    await press(el, 'Save changes');

    expect(resolveServerAddress).not.toHaveBeenCalled();
    expect(updateServer).toHaveBeenCalledWith('srv-1', 'Pilot', DASH, API);
  });

  it('confirms before moving the agents, and cancelling saves nothing', async () => {
    updateServer.mockResolvedValue({
      server: server({ apiUrl: 'https://agents.example.com' }),
      propagation: { apiUrlChanged: true, agents: [] },
    });
    const el = await render({ edit: server() });
    await press(el, 'Change');
    await type(field(el, 'Agent address')!, 'https://agents.example.com');

    await press(el, 'Save changes');

    expect(updateServer).not.toHaveBeenCalled();
    expect(el.textContent).toContain('Your agents on this server will be reconfigured');

    await press(el, 'Keep the current address');
    expect(updateServer).not.toHaveBeenCalled();

    await press(el, 'Save changes');
    await press(el, 'Save and reconfigure agents');

    expect(updateServer).toHaveBeenCalledWith('srv-1', 'Pilot', DASH, 'https://agents.example.com');
  });
});
