import { describe, expect, it } from 'vitest';
import type { ParsedAgentEntry } from '@main/core/agent-templates/template-document';
import type { OwnedMachine } from '@shared/core/managed-agents/managed-agents';
import type { ConnectionCatalogEntry } from '@shared/core/switch-servers/connection-catalog';
import {
  connectionStates,
  connectionsFor,
  directoryUnresolved,
  machineFor,
  machineProblem,
  managedDirectory,
  runAgent,
  shownDirectory,
} from './managed-run';

function machine(overrides: Partial<OwnedMachine>): OwnedMachine {
  return {
    id: 'm1',
    name: 'laptop',
    kind: 'console',
    state: 'online',
    providers: [{ provider: 'claude', ready: true, problem: null }],
    acceptsLogins: true,
    cloud: false,
    workspacesDir: '/home/me/.switch/agents',
    os: 'linux',
    local: { kind: 'this-computer' },
    ...overrides,
  };
}

function entry(overrides: Partial<ParsedAgentEntry>): ParsedAgentEntry {
  return {
    name: 'a',
    displayName: null,
    description: '',
    instructions: 'Do it.',
    repoUrl: null,
    sources: [],
    addressing: null,
    provider: 'claude',
    location: null,
    machine: null,
    model: null,
    advancedConfig: {},
    isolation: null,
    autoApprove: null,
    connections: [],
    directory: null,
    join: [],
    placeholders: [],
    allowExisting: false,
    ...overrides,
  };
}

const LAPTOP = machine({});
const BOX = machine({
  id: 'm2',
  name: 'box',
  state: 'offline',
  local: { kind: 'ssh-host', sshHost: 'box.lan' },
});

describe('machineFor', () => {
  it('finds a machine by id or by name', () => {
    expect(machineFor([LAPTOP, BOX], 'm2', null)).toBe(BOX);
    expect(machineFor([LAPTOP, BOX], 'laptop', null)).toBe(LAPTOP);
  });

  it('turns a location into the machine behind it', () => {
    expect(machineFor([LAPTOP, BOX], null, 'local')).toBe(LAPTOP);
    expect(machineFor([LAPTOP, BOX], null, 'box.lan')).toBe(BOX);
    expect(machineFor([BOX], null, 'local')).toBeNull();
  });

  it('does not guess between machines that share a name', () => {
    expect(machineFor([LAPTOP, machine({ id: 'm3' })], 'laptop', null)).toBeNull();
  });
});

describe('machineProblem', () => {
  it('says when the machine cannot take the agent', () => {
    expect(machineProblem(BOX, 'claude', 'a')).toMatch(/box is offline/);
    expect(machineProblem(LAPTOP, 'codex', 'a')).toBe('codex is not installed on laptop.');
    expect(
      machineProblem(
        machine({ providers: [{ provider: 'claude', ready: false, problem: 'not logged in' }] }),
        'claude',
        'a'
      )
    ).toBe('claude on laptop is not ready: not logged in.');
    expect(machineProblem(LAPTOP, 'claude', 'a')).toBeNull();
  });
});

describe('connectionsFor', () => {
  it('folds a GitHub repo into the GitHub connection', () => {
    expect(
      connectionsFor(
        entry({
          repoUrl: 'https://github.com/acme/{repo}.git',
          connections: [{ service: 'github', access: 'write', repos: [] }],
        }),
        { repo: 'widgets' }
      )
    ).toEqual([{ service: 'github', access: 'write', repos: ['acme/widgets'] }]);
    expect(connectionsFor(entry({ repoUrl: 'https://github.com/acme/widgets' }), {})).toEqual([
      { service: 'github', access: null, repos: ['acme/widgets'] },
    ]);
  });
});

describe('connectionStates', () => {
  const catalog = [
    { slug: 'github', name: 'GitHub', status: 'connected', unavailable_reason: null },
    { slug: 'atlassian', name: 'Atlassian', status: 'not_connected', unavailable_reason: null },
  ] as ConnectionCatalogEntry[];

  it('says whether the deployer can grant each connection', () => {
    const states = connectionStates(
      [
        { service: 'github', access: null, repos: ['acme/widgets'] },
        { service: 'atlassian', access: null, repos: [] },
        { service: 'nope', access: null, repos: [] },
      ],
      catalog
    );
    expect(states.map((s) => [s.name, s.ready, s.note])).toEqual([
      ['GitHub', true, null],
      ['Atlassian', false, 'Connect Atlassian under Connections first.'],
      ['nope', false, 'This server has no such connection.'],
    ]);
  });
});

describe('directories', () => {
  it('keeps {$agents_dir} for the server and fills the rest', () => {
    const directory = managedDirectory('{$agents_dir}/{team}/{agent}', { team: 'red' }, 'a');
    expect(directory).toBe('{$agents_dir}/red/a');
    expect(directoryUnresolved(directory)).toBe(false);
    expect(directoryUnresolved(managedDirectory('{root}/a', {}, 'a'))).toBe(true);
    expect(shownDirectory(directory, LAPTOP)).toBe('/home/me/.switch/agents/red/a');
  });
});

describe('runAgent', () => {
  it('sends the agent as the server takes it', () => {
    const agent = runAgent({
      slot: 'red-a',
      name: 'red-a',
      entry: entry({
        description: 'Works on {team}',
        model: '{model}',
        advancedConfig: { effort: '{effort}' },
        isolation: 'isolated',
        autoApprove: '{yolo}',
        addressing: 'owner-agents',
        repoUrl: 'https://github.com/acme/widgets',
      }),
      values: { team: 'red', model: 'sonnet', effort: 'high', yolo: true },
      displayName: null,
      provider: 'claude',
      machine: LAPTOP,
      directoryText: '{$agents_dir}/red-a',
    });
    expect(agent).toMatchObject({
      description: 'Works on red',
      machine: 'm1',
      model: 'sonnet',
      advancedConfig: { effort: 'high' },
      isolation: 'isolated',
      autoApprove: true,
      directory: null,
      addressing: 'owner-agents',
      connections: [{ service: 'github', access: null, repos: ['acme/widgets'] }],
    });
    expect(agent.instructions).toContain('clone https://github.com/acme/widgets.git');
  });
});
