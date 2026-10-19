/**
 * Joining a workspace from an invite link on a fresh install.
 *
 * The link names its server and carries the token, so the flow skips choosing
 * where Switch runs: a server this install knows goes straight to signing in;
 * one it does not opens the connect form, with both addresses filled in when
 * the server said where its agents connect and with the link's address when
 * it did not; and the invitation is accepted as soon as there is an account to
 * accept it with. A refusal is shown as the server gave it, with a way on that
 * does not need the invitation.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const serverForInvite = vi.hoisted(() => vi.fn());
const acceptInvitation = vi.hoisted(() => vi.fn());
const setActiveWorkspace = vi.hoisted(() => vi.fn());
const resolveWorkspaces = vi.hoisted(() => vi.fn());

vi.hoisted(() => {
  window.electronAPI ??= {
    invoke: () => Promise.resolve(undefined),
    eventOn: () => () => {},
    eventSend: () => {},
  } as unknown as typeof window.electronAPI;
});

vi.mock('@renderer/lib/ipc', () => ({
  rpc: {
    switchServers: {
      resolveWorkspaces,
      listPendingInvitations: () => Promise.resolve({ kind: 'listed', invitations: [] }),
      listJoinableWorkspaces: () => Promise.resolve({ kind: 'listed', workspaces: [] }),
      switchCloud: () => Promise.resolve(null),
      resolveServerAddress: vi.fn(),
    },
    remoteHosts: { listHosts: () => Promise.resolve([]) },
  },
  events: { on: () => () => {}, emit: () => {} },
}));

vi.mock('@renderer/features/workspaces/workspaces-store', () => ({
  workspacesStore: {
    setActive: setActiveWorkspace,
    acceptInvitation,
    idOnServerInScope: () => 'ws-1',
  },
}));

const SERVER = vi.hoisted(() => ({
  id: 'srv-1',
  name: 'switch.example.com',
  gatewayUrl: 'https://switch.example.com',
  apiUrl: 'https://switch-api.example.com',
}));

vi.mock('@renderer/features/switch-servers/switch-servers-store', () => ({
  switchServersStore: {
    serverForInvite,
    setActive: vi.fn(),
    errorText: null,
    isConnected: () => false,
    serverById: (id: string | null) => (id === SERVER.id ? SERVER : null),
    ensureAuthConfig: () => Promise.resolve(),
    authConfigFor: () => ({
      passwordLoginEnabled: true,
      oidcEnabled: false,
      oidcProviderLabel: null,
      oidcLoginOptions: [],
      oidcBrowserHandoff: false,
    }),
    authConfigCheckFailed: () => false,
    authConfigChecking: () => false,
    passwordLogin: () => Promise.resolve(true),
    oidcLogin: () => Promise.resolve(true),
  },
}));

// The buddy page reads providers and machines; what is under test is only
// that an accepted invitation leads to it.
vi.mock('@renderer/features/switch-buddy/buddy-step', () => ({
  BuddyStep: () => <div>Meet switch-buddy</div>,
}));

vi.mock('@renderer/lib/layout/navigation-provider', () => ({
  useNavigate: () => ({ navigate: vi.fn() }),
}));

vi.mock('@renderer/lib/telemetry/report', () => ({ report: vi.fn() }));
vi.mock('@renderer/features/settings/use-app-settings-key', () => ({
  useAppSettingsKey: () => ({
    value: { enabled: true, askedAt: 1 },
    update: () => {},
    isLoading: false,
    isSaving: false,
  }),
}));

import { OnboardingFlow } from '@renderer/features/onboarding/onboarding-flow';
import { onboardingStore } from '@renderer/features/onboarding/onboarding-store';

const LINK = 'https://switch.example.com/invite#token=tok-1';

const ACME = {
  id: 'ws-1',
  serverId: 'srv-1',
  name: 'Acme',
  tenantId: 'tenant-1',
  slug: 'acme',
  role: 'member' as const,
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
};

let container: HTMLDivElement | null = null;
let root: Root | null = null;

beforeEach(() => {
  serverForInvite.mockReset();
  acceptInvitation.mockReset();
  resolveWorkspaces.mockReset().mockResolvedValue([ACME]);
  setActiveWorkspace.mockReset().mockResolvedValue(undefined);
  onboardingStore.reset();
});

afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  container?.remove();
  container = null;
  root = null;
});

async function renderFlow(): Promise<HTMLDivElement> {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  await act(async () =>
    root!.render(
      <QueryClientProvider client={client}>
        <OnboardingFlow />
      </QueryClientProvider>
    )
  );
  await settle();
  return container;
}

async function settle(): Promise<void> {
  for (let i = 0; i < 8; i++) await act(async () => await Promise.resolve());
}

async function click(el: HTMLElement, text: string): Promise<void> {
  const found = [...el.querySelectorAll<HTMLButtonElement>('button')].find((b) =>
    b.textContent?.includes(text)
  );
  expect(found, `nothing to click named ${text}`).toBeDefined();
  await act(async () => found!.click());
  await settle();
}

async function type(input: HTMLInputElement, value: string): Promise<void> {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
  await act(async () => {
    setter.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

function field(el: HTMLElement, label: string): HTMLInputElement | null {
  const match = [...el.querySelectorAll<HTMLElement>('label')].find(
    (l) => l.textContent?.trim() === label
  );
  return (match?.parentElement?.querySelector('input') as HTMLInputElement | null) ?? null;
}

async function pasteLink(el: HTMLElement, text: string): Promise<void> {
  await click(el, 'Get started');
  await click(el, 'Join with an invite link');
  await type(el.querySelector<HTMLInputElement>('#invite-link')!, text);
  await click(el, 'Continue');
}

async function signIn(el: HTMLElement): Promise<void> {
  const [email, password] = [...el.querySelectorAll<HTMLInputElement>('input')];
  await type(email!, 'someone@example.com');
  await type(password!, 'secret');
  await click(el, 'Sign in');
}

describe('joining from an invite link', () => {
  it('is offered where you choose how to run Switch', async () => {
    const el = await renderFlow();
    await click(el, 'Get started');

    expect(el.textContent).toContain('Join with an invite link');
  });

  it('says what is wrong with a paste that is not an invite link', async () => {
    const el = await renderFlow();

    await pasteLink(el, 'https://switch.example.com/rooms');

    expect(el.querySelector('[role="alert"]')?.textContent).toContain('not an invitation');
    expect(serverForInvite).not.toHaveBeenCalled();
  });

  it('signs in to the server the link names and accepts the invitation', async () => {
    serverForInvite.mockResolvedValue({ kind: 'known', server: SERVER, via: 'external' });
    acceptInvitation.mockResolvedValue(ACME);
    const el = await renderFlow();

    await pasteLink(el, LINK);
    expect(serverForInvite).toHaveBeenCalledWith('https://switch.example.com');

    await signIn(el);

    expect(acceptInvitation).toHaveBeenCalledWith('srv-1', 'tok-1');
    expect(setActiveWorkspace).toHaveBeenCalledWith('ws-1');
    expect(el.textContent).toContain('Meet switch-buddy');
    expect(onboardingStore.invite).toBeNull();
  });

  it('opens the connect form with both addresses when the server said where agents connect', async () => {
    serverForInvite.mockResolvedValue({
      kind: 'resolvable',
      origin: 'https://switch.example.com',
      gatewayUrl: 'https://switch.example.com',
      apiUrl: 'https://switch-api.example.com',
    });
    const el = await renderFlow();

    await pasteLink(el, LINK);

    expect(field(el, 'Server address')?.value).toBe('https://switch.example.com');
    expect(el.textContent).toContain('Agents connect to');
    expect(el.textContent).toContain('https://switch-api.example.com');
    expect(onboardingStore.invite?.token).toBe('tok-1');
  });

  it('opens the connect form at the link address when the server could not say', async () => {
    serverForInvite.mockResolvedValue({ kind: 'unknown', origin: 'https://switch.example.com' });
    const el = await renderFlow();

    await pasteLink(el, LINK);

    expect(field(el, 'Server address')?.value).toBe('https://switch.example.com');
    expect(el.textContent).not.toContain('Agents connect to');
    expect(onboardingStore.invite?.token).toBe('tok-1');
  });

  it('shows why the server refused, and goes on to the workspaces without it', async () => {
    serverForInvite.mockResolvedValue({ kind: 'known', server: SERVER, via: 'external' });
    acceptInvitation.mockRejectedValue(new Error('This invitation has expired'));
    resolveWorkspaces.mockResolvedValue([ACME, { ...ACME, id: 'ws-2', name: 'Skunkworks' }]);
    const el = await renderFlow();

    await pasteLink(el, LINK);
    await signIn(el);

    expect(el.querySelector('[role="alert"]')?.textContent).toContain(
      'This invitation has expired'
    );

    await click(el, 'Continue without it');

    expect(resolveWorkspaces).toHaveBeenCalledWith('srv-1');
    expect(el.textContent).toContain('Skunkworks');
    expect(onboardingStore.invite).toBeNull();
  });

  it('forgets the invite link when the user goes back to choosing how to run Switch', async () => {
    serverForInvite.mockResolvedValue({ kind: 'known', server: SERVER, via: 'external' });
    const el = await renderFlow();

    await pasteLink(el, LINK);
    await click(el, 'Back');
    await click(el, 'Back');

    expect(el.textContent).toContain('How do you want to run Switch?');
    expect(onboardingStore.invite).toBeNull();
  });
});
