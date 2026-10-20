import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { ManagedAgentView } from '@shared/core/managed-agents/managed-agents';
import type { ServiceGrants } from '@shared/core/switch-servers/service-grants';

const flags = vi.hoisted(() => ({ agent_chats: true, service_connections: true }));
const grants = vi.hoisted(() => ({ data: undefined as ServiceGrants | null | undefined }));

/** Stands in for the app's navigation: the agent column picks a section by setting params. */
const navigation = vi.hoisted(() => {
  let params: Record<string, string | undefined> = {};
  const listeners = new Set<() => void>();
  const set = (next: Record<string, string | undefined>) => {
    params = next;
    for (const listener of listeners) listener();
  };
  return {
    params: () => params,
    setParams: (update: Record<string, string | undefined>) => set({ ...params, ...update }),
    reset: (next: Record<string, string | undefined>) => set(next),
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
});

vi.mock('@renderer/lib/layout/navigation-provider', async (importOriginal) => {
  const { useSyncExternalStore } = await import('react');
  return {
    ...(await importOriginal<object>()),
    useParams: () => ({
      params: useSyncExternalStore(navigation.subscribe, navigation.params),
      setParams: navigation.setParams,
    }),
  };
});
vi.mock('@renderer/lib/hooks/useFeatureFlags', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useFeatureFlags: () => flags,
}));
vi.mock('@renderer/lib/ipc', () => ({ events: { on: () => () => {} }, rpc: {} }));
vi.mock('@renderer/lib/modal/modal-provider', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  showModal: vi.fn(),
}));
vi.mock('@renderer/features/switch-servers/switch-rooms-store', () => ({
  switchRoomsStore: {
    watchMembership: () => () => {},
    roomsFor: () => [],
    errorFor: () => null,
  },
}));
vi.mock('@renderer/features/managed-agents/agent-connections-tab', () => ({
  useAgentServiceGrants: () => grants,
  AgentConnectionsTab: (props: { agentId: string; agentName: string }) => (
    <div data-testid="connections">
      Connections for {props.agentName} ({props.agentId})
    </div>
  ),
}));
vi.mock('@renderer/features/managed-agents/managed-agent-page', () => ({
  ManagedAgentPage: (props: { serviceGrants: boolean }) => (
    <div data-testid="settings">
      Settings, service access {props.serviceGrants ? 'shown' : 'not shown'}
    </div>
  ),
}));
vi.mock('@renderer/features/chats/components/chat-panel', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  ChatPanel: () => null,
}));

import '@renderer/index.css';
import { AgentChats } from '@renderer/features/managed-agents/agent-chats';

const AGENT: ManagedAgentView = {
  serverId: 'server-1',
  workspaceId: 'workspace-1',
  agentId: 'agent-1',
  name: 'pm-agent',
  displayName: null,
  iconUrl: null,
  description: '',
  machine: null,
  desiredState: 'running',
  revision: 1,
  definition: {
    provider: 'claude',
    model: null,
    advancedConfig: {},
    instructions: '',
    autoApprove: false,
    directory: null,
    isolation: 'shared',
  },
  status: null,
};

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  flags.service_connections = true;
  grants.data = { grants: [], addressing_open: false };
  navigation.reset({ serverId: 'server-1', agentId: 'agent-1', name: 'pm-agent' });
  container = document.createElement('div');
  container.style.width = '1100px';
  container.style.height = '700px';
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

/** The section buttons under the agent's profile, by their labels. */
const navButtons = () => [
  ...container.querySelectorAll<HTMLButtonElement>('[role="toolbar"][aria-label="Agent"] button'),
];
const navLabels = () => navButtons().map((button) => button.getAttribute('aria-label'));
const navItem = (label: string) =>
  navButtons().find((button) => button.getAttribute('aria-label') === label)!;

it("puts Connectors under the agent's profile, before Agent settings, and opens it there", async () => {
  await act(async () => root.render(<AgentChats agent={AGENT} />));
  expect(navLabels()).toEqual(['Connectors', 'Agent settings']);
  expect(navItem('Connectors').getAttribute('aria-pressed')).toBe('false');

  await act(async () => navItem('Connectors').click());
  expect(navigation.params().section).toBe('connections');
  expect(navItem('Connectors').getAttribute('aria-pressed')).toBe('true');
  expect(container.querySelector('[data-testid="connections"]')?.textContent).toBe(
    'Connections for pm-agent (agent-1)'
  );

  await act(async () => navItem('Agent settings').click());
  expect(navItem('Agent settings').getAttribute('aria-pressed')).toBe('true');
  expect(navItem('Connectors').getAttribute('aria-pressed')).toBe('false');
  expect(container.querySelector('[data-testid="settings"]')?.textContent).toBe(
    'Settings, service access not shown'
  );
});

it("shows the agent's name and where it runs at the top of its column", async () => {
  await act(async () =>
    root.render(
      <AgentChats
        agent={{
          ...AGENT,
          displayName: 'PM agent',
          machine: { id: 'machine-1', name: 'Max’s computer', kind: 'local', state: 'online' },
        }}
      />
    )
  );
  expect(container.querySelector('h2')?.textContent).toBe('PM agent');
  expect(container.textContent).toContain('Max’s computer');
});

it('says so when the agent has no machine', async () => {
  await act(async () => root.render(<AgentChats agent={AGENT} />));
  expect(container.textContent).toContain('No machine');
});

it("leaves Connections out for an agent whose grants aren't yours, keeping service access in settings", async () => {
  grants.data = null;
  navigation.reset({ ...navigation.params(), section: 'connections' });
  await act(async () => root.render(<AgentChats agent={AGENT} />));
  expect(navLabels()).toEqual(['Agent settings']);
  expect(container.querySelector('[data-testid="connections"]')).toBeNull();

  await act(async () => navItem('Agent settings').click());
  expect(container.querySelector('[data-testid="settings"]')?.textContent).toBe(
    'Settings, service access shown'
  );
});

it('leaves Connections out when the server has service connections off', async () => {
  flags.service_connections = false;
  await act(async () => root.render(<AgentChats agent={AGENT} />));
  expect(navLabels()).toEqual(['Agent settings']);
});
