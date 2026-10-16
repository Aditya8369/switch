import { describe, expect, it, vi } from 'vitest';
import {
  type ConnectFlowState,
  canCloseConnectFlow,
  connectFlowReducer,
  initialConnectFlow,
  isFinalRefusal,
} from '@renderer/features/connectors/connect-flow';
import { connectorCardState } from '@renderer/features/connectors/connector-card-state';
import {
  disconnectCopy,
  switchOffConfirmation,
  workspaceSwitchNote,
} from '@renderer/features/connectors/connector-copy';
import {
  cardQuickAction,
  connectedAsLine,
  connectorsInTab,
  connectorsPageAccess,
  profileConnectAction,
  signInLabel,
  tokenLifetimeLabel,
  workspaceOffNotice,
} from '@renderer/features/connectors/connectors-catalog';
import {
  OPEN_GROUP_NOTE,
  agentsUnlistedText,
  checklistGroups,
  connectButtonLabel,
  grantEach,
  grantFailureText,
  grantSuccessText,
  noAgentsText,
  offersChecklist,
} from '@renderer/features/connectors/grant-agents';
import { workspaceNavViews } from '@renderer/features/sidebar/workspace-nav-views';
import {
  FLAGS_NOT_READ_YET,
  allFeatureFlagsOff,
  type ServerFeatureFlags,
} from '@shared/core/feature-flags/feature-flags';
import type { ConnectionCatalogEntry } from '@shared/core/switch-servers/connection-catalog';
import { RpcError, serializeRpcError } from '@shared/lib/ipc/rpc-error';

function entry(overrides: Partial<ConnectionCatalogEntry> = {}): ConnectionCatalogEntry {
  return {
    slug: 'example',
    name: 'Example',
    category: 'Project management',
    description: 'Example work items.',
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

describe('the state a connector card shows', () => {
  it('shows each state on its own', () => {
    expect(connectorCardState(entry({ status: 'coming_soon', enabled: false })).kind).toBe(
      'coming_soon'
    );
    expect(
      connectorCardState(entry({ unavailable_reason: 'Maintenance', connectable: false }))
    ).toMatchObject({ kind: 'unavailable', detail: 'Maintenance' });
    expect(connectorCardState(entry({ workspace_enabled: false }))).toMatchObject({
      kind: 'workspace_off',
      label: 'Off in this workspace',
    });
    expect(connectorCardState(entry({ status: 'needs_reauthorization' }))).toMatchObject({
      kind: 'reconnect',
      label: 'Reconnect needed',
      tone: 'problem',
    });
    expect(connectorCardState(entry({ status: 'error' }))).toMatchObject({
      kind: 'reconnect',
      label: 'Connection failed',
    });
    expect(connectorCardState(entry({ status: 'connected' })).kind).toBe('connected');
    expect(connectorCardState(entry()).kind).toBe('connect');
  });

  it('reads a server without the workspace switch as on', () => {
    expect(connectorCardState(entry({ workspace_enabled: null })).kind).toBe('connect');
    expect(connectorCardState(entry({ workspace_enabled: null, status: 'connected' })).kind).toBe(
      'connected'
    );
  });

  it('picks the first that applies when several do', () => {
    const everything = entry({
      status: 'needs_reauthorization',
      unavailable_reason: 'Maintenance',
      workspace_enabled: false,
    });
    expect(connectorCardState({ ...everything, status: 'coming_soon' }).kind).toBe('coming_soon');
    // The server's reason wins over the workspace's switch.
    expect(connectorCardState(everything).kind).toBe('unavailable');
    // Off in the workspace wins over a sign-in that needs renewing.
    expect(connectorCardState({ ...everything, unavailable_reason: null }).kind).toBe(
      'workspace_off'
    );
    expect(
      connectorCardState({ ...everything, unavailable_reason: null, status: 'connected' }).kind
    ).toBe('workspace_off');
  });
});

describe('the Yours and Discover tabs', () => {
  const catalog = [
    entry({ slug: 'atlassian', name: 'Atlassian', category: 'Project management' }),
    entry({
      slug: 'datadog',
      name: 'Datadog',
      category: 'Observability',
      description: 'Monitors, logs and incidents.',
      status: 'connected',
    }),
    entry({ slug: 'github', name: 'GitHub', category: 'Source control', status: 'error' }),
    entry({
      slug: 'jira-ish',
      name: 'Linear',
      category: 'Project management',
      status: 'needs_reauthorization',
    }),
    entry({ slug: 'notion', name: 'Notion', category: 'Docs', status: 'coming_soon' }),
  ];
  const names = (list: ConnectionCatalogEntry[]) => list.map((item) => item.name);

  it('puts every connection the person has on Yours, working or not', () => {
    expect(names(connectorsInTab(catalog, 'yours', ''))).toEqual(['Datadog', 'GitHub', 'Linear']);
  });

  it('puts the whole catalog on Discover, connected services and coming soon included', () => {
    expect(names(connectorsInTab(catalog, 'discover', ''))).toEqual([
      'Atlassian',
      'Datadog',
      'GitHub',
      'Linear',
      'Notion',
    ]);
  });

  it('searches within the tab by name, category or description', () => {
    expect(names(connectorsInTab(catalog, 'discover', 'project'))).toEqual(['Atlassian', 'Linear']);
    expect(names(connectorsInTab(catalog, 'yours', 'project'))).toEqual(['Linear']);
    expect(names(connectorsInTab(catalog, 'yours', 'atlas'))).toEqual([]);
    expect(names(connectorsInTab(catalog, 'discover', ' NOTION '))).toEqual(['Notion']);
    expect(names(connectorsInTab(catalog, 'discover', 'incidents'))).toEqual(['Datadog']);
  });
});

describe("a card's own control", () => {
  it('connects where the profile would offer Connect', () => {
    expect(cardQuickAction(entry())).toBe('connect');
    // Connectable where it cannot be granted: still offered, as on the profile.
    expect(cardQuickAction(entry({ unavailable_reason: 'Not fully set up.' }))).toBe('connect');
  });

  it('only marks a connection, never offering to disconnect it', () => {
    expect(cardQuickAction(entry({ status: 'connected' }))).toBe('connected');
    expect(cardQuickAction(entry({ status: 'connected', workspace_enabled: false }))).toBe(
      'connected'
    );
  });

  it('offers nothing it would be refused, or that needs the profile', () => {
    expect(cardQuickAction(entry({ connectable: false }))).toBeNull();
    expect(cardQuickAction(entry({ workspace_enabled: false }))).toBeNull();
    expect(cardQuickAction(entry({ status: 'coming_soon' }))).toBeNull();
    expect(cardQuickAction(entry({ status: 'needs_reauthorization' }))).toBeNull();
    expect(cardQuickAction(entry({ status: 'error' }))).toBeNull();
  });
});

describe('the profile', () => {
  it('says who the connection is as, and what was allowed', () => {
    expect(connectedAsLine(entry())).toBeNull();
    expect(
      connectedAsLine(entry({ status: 'connected', external_identity: 'ada', consent: 'write' }))
    ).toBe('Connected as ada · Read and write');
    expect(
      connectedAsLine(entry({ status: 'connected', external_identity: 'ada', consent: 'read' }))
    ).toBe('Connected as ada · Read');
    expect(connectedAsLine(entry({ status: 'needs_reauthorization', consent: null }))).toBe(
      'Connected'
    );
    expect(
      connectedAsLine(
        entry({
          status: 'connected',
          auth_type: 'api_key',
          external_identity: 'Key · example.test',
        })
      )
    ).toBe('Connected with Key · example.test');
  });

  it('names the sign-in type and how long access lasts', () => {
    expect(signInLabel(entry())).toBe('Sign in at Example');
    expect(signInLabel(entry({ auth_type: 'api_key' }))).toBe('Key');
    expect(signInLabel(entry({ slug: 'github' }))).toBe('GitHub App');
    expect(tokenLifetimeLabel(entry({ token_lifetime: 3600 }))).toBe('1 hour');
    expect(tokenLifetimeLabel(entry({ token_lifetime: 28_800 }))).toBe('8 hours');
    expect(tokenLifetimeLabel(entry({ token_lifetime: 900 }))).toBe('15 minutes');
    expect(tokenLifetimeLabel(entry({ token_lifetime: 172_800 }))).toBe('2 days');
    expect(tokenLifetimeLabel(entry({ token_lifetime: null }))).toBe('Not stated');
    expect(tokenLifetimeLabel(entry({ auth_type: 'api_key' }))).toBe(
      "The key itself, which doesn't expire"
    );
  });

  it('offers connecting, signing in again, or choosing repositories', () => {
    expect(profileConnectAction(entry())).toBe('connect');
    expect(profileConnectAction(entry({ status: 'needs_reauthorization' }))).toBe('reconnect');
    expect(profileConnectAction(entry({ status: 'error' }))).toBe('reconnect');
    expect(profileConnectAction(entry({ status: 'connected' }))).toBeNull();
    expect(profileConnectAction(entry({ slug: 'github', status: 'connected' }))).toBe('manage');
    expect(profileConnectAction(entry({ status: 'coming_soon' }))).toBeNull();
    // Connectable where it cannot be granted: the server's reason does not hide Connect.
    expect(
      profileConnectAction(entry({ slug: 'github', unavailable_reason: 'Not fully set up.' }))
    ).toBe('connect');
    // Off in the workspace: the notice, not a button that would be refused.
    expect(profileConnectAction(entry({ workspace_enabled: false }))).toBeNull();
    expect(
      profileConnectAction(entry({ workspace_enabled: false, status: 'needs_reauthorization' }))
    ).toBeNull();
  });

  it('tells a member who can switch it on, and offers an admin the switch', () => {
    const off = entry({ workspace_enabled: false });
    expect(workspaceOffNotice(off, false)).toEqual({
      text: 'Not enabled in this workspace. Ask a workspace admin.',
      canEnable: false,
    });
    expect(workspaceOffNotice(off, true)).toEqual({
      text: 'Example is switched off for this workspace.',
      canEnable: true,
    });
    expect(workspaceOffNotice(entry(), true)).toBeNull();
    // No workspace layer on this server: nothing to say.
    expect(workspaceOffNotice(entry({ workspace_enabled: null }), false)).toBeNull();
  });
});

describe('the checklist after connecting', () => {
  it('follows only a service a grant simply switches on, never GitHub', () => {
    expect(offersChecklist(entry({ pass_through: true }))).toBe(true);
    expect(offersChecklist(entry({ pass_through: false }))).toBe(false);
    expect(offersChecklist(entry({ slug: 'github', pass_through: true }))).toBe(false);
  });

  it('groups the agents it ticks first, then the open ones under one line', () => {
    expect(
      checklistGroups([
        { agent_id: 'm2', name: 'M2', granted: false, addressing_open: true },
        { agent_id: 'm1', name: 'M1', granted: false, addressing_open: false },
        { agent_id: 'm3', name: 'M3', granted: true, addressing_open: true },
      ])
    ).toEqual({
      ticked: [
        { agentId: 'm1', name: 'M1', ticked: true, granted: false },
        { agentId: 'm3', name: 'M3', ticked: true, granted: true },
      ],
      open: [{ agentId: 'm2', name: 'M2', ticked: false, granted: false }],
    });
    expect(OPEN_GROUP_NOTE).toBe(
      'Others can address these agents; they would act as you. Tick one to turn it on anyway.'
    );
  });

  it('labels the one button by how many agents are ticked', () => {
    expect(connectButtonLabel(0)).toBe('Connect');
    expect(connectButtonLabel(1)).toBe('Connect and turn on for 1 agent');
    expect(connectButtonLabel(3)).toBe('Connect and turn on for 3 agents');
  });

  it('sends the person to agent settings where the server cannot list agents', () => {
    expect(agentsUnlistedText('Example')).toBe(
      "This server can't list your agents here. Turn Example on for an agent from its settings."
    );
  });

  it('says so when the person has no agents yet', () => {
    expect(checklistGroups([])).toEqual({ ticked: [], open: [] });
    expect(noAgentsText('Example')).toBe(
      'You have no agents in this workspace yet. Once you add one, turn Example on for it from its settings.'
    );
  });
});

describe('granting several agents', () => {
  const agents = [
    { agentId: 'm1', name: 'M1' },
    { agentId: 'gone', name: 'M3' },
    { agentId: 'm4', name: 'M4' },
  ];

  it('makes the other grants when one fails, and names the agent it failed for', async () => {
    const grant = vi.fn(async (agentId: string) => {
      if (agentId === 'gone') throw new Error('Agent not found.');
      return null;
    });
    const outcome = await grantEach(agents, grant, (cause) => (cause as Error).message);

    expect(grant.mock.calls.map(([id]) => id)).toEqual(['m1', 'gone', 'm4']);
    expect(outcome).toEqual({
      granted: ['M1', 'M4'],
      failed: [{ name: 'M3', reason: 'Agent not found.' }],
      warnings: [],
    });
    expect(grantFailureText('Example', outcome)).toBe(
      'Could not turn Example on for M3 (Agent not found.). It is on for M1 and M4.'
    );
  });

  it('never reports success when every call failed', async () => {
    const outcome = await grantEach(
      agents.slice(0, 2),
      async () => {
        throw new Error('boom');
      },
      () => 'boom'
    );
    expect(grantFailureText('Example', outcome)).toBe(
      'Could not turn Example on for M1 (boom); M3 (boom). It is not on for any agent.'
    );
  });

  it('reports what was granted, and each warning once, when nothing failed', async () => {
    const outcome = await grantEach(agents, async () => 'Access stays a while.', String);
    expect(grantFailureText('Example', outcome)).toBeNull();
    expect(outcome.warnings).toEqual(['Access stays a while.']);
    expect(grantSuccessText('Example', outcome)).toBe('Example is on for M1, M3, and M4.');
    expect(grantSuccessText('Example', { granted: [], failed: [], warnings: [] })).toBe(
      "Example is not on for any agent. Turn it on later from an agent's settings."
    );
  });
});

/** A refusal as it reaches the renderer from the gateway. */
function refusal(status: number, retryable?: boolean): RpcError {
  return new RpcError(
    serializeRpcError(
      Object.assign(new Error(`Switch gateway returned ${status}`), {
        name: 'GatewayError',
        kind: 'http',
        status,
        detail: 'Refused.',
        ...(retryable === undefined ? {} : { retryable }),
      })
    )
  );
}

describe('the sign-in flow', () => {
  const ready: ConnectFlowState = {
    ...initialConnectFlow(false),
    flowId: 'flow-1',
    flow: { status: 'ready', account: 'ada@example.test', error: null },
  };
  const run = (state: ConnectFlowState, ...events: Parameters<typeof connectFlowReducer>[1][]) =>
    events.reduce(connectFlowReducer, state);

  it('cannot be closed while waiting for the browser, or mid-call', () => {
    expect(canCloseConnectFlow(initialConnectFlow(false))).toBe(true);
    expect(canCloseConnectFlow(ready)).toBe(false);
    expect(canCloseConnectFlow(run(initialConnectFlow(false), { type: 'act' }))).toBe(false);
  });

  it('drops the flow on a confirm refused for good, keeps the error, and can close', () => {
    for (const cause of [refusal(403, false), refusal(409, false), refusal(410), refusal(409)]) {
      const after = run(
        ready,
        { type: 'act' },
        { type: 'confirm_failed', cause, error: 'Refused.' }
      );
      expect(after).toMatchObject({ flowId: null, flow: null, busy: false, error: 'Refused.' });
      expect(canCloseConnectFlow(after)).toBe(true);
    }
  });

  it('keeps the flow on a confirm that can be tried again, and can still close', () => {
    const after = run(
      ready,
      { type: 'act' },
      { type: 'confirm_failed', cause: refusal(503, true), error: 'Try again.' }
    );
    expect(after).toMatchObject({ flowId: 'flow-1', error: 'Try again.' });
    expect(canCloseConnectFlow(after)).toBe(true);
  });

  it("reads the server's retryable over the status, and never the text", () => {
    expect(isFinalRefusal(refusal(409, true))).toBe(false);
    expect(isFinalRefusal(refusal(500, false))).toBe(true);
    expect(isFinalRefusal(refusal(500))).toBe(false);
    expect(isFinalRefusal(new Error('409 account linked elsewhere'))).toBe(false);
  });

  it('counts a cancel answered 410 as cancelled, not as an error', () => {
    expect(
      run(ready, { type: 'act' }, { type: 'cancel_failed', cause: refusal(410), error: 'Gone.' })
    ).toMatchObject({ flowId: null, flow: null, busy: false, error: null });
    expect(
      run(ready, { type: 'act' }, { type: 'cancel_failed', cause: refusal(503), error: 'Down.' })
    ).toMatchObject({ flowId: 'flow-1', error: 'Down.' });
  });

  it('says why a sign-in failed, and lets the dialog close', () => {
    const failed = run(ready, {
      type: 'polled',
      flow: { status: 'failed', account: null, error: null },
      failure: 'Signing in failed.',
    });
    expect(failed.error).toBe('Signing in failed.');
    expect(canCloseConnectFlow(failed)).toBe(true);
  });

  it('connects on a confirm, and the grants after it name an agent they failed for', async () => {
    const after = run(ready, { type: 'act' }, { type: 'confirmed', warning: null });
    expect(after).toMatchObject({ connected: true, flowId: null, busy: false, error: null });

    const outcome = await grantEach(
      [
        { agentId: 'm1', name: 'M1' },
        { agentId: 'm2', name: 'M2' },
      ],
      async (agentId) => {
        if (agentId === 'm2') throw new Error('Agent not found.');
        return null;
      },
      (cause) => (cause as Error).message
    );
    expect(grantFailureText('Example', outcome)).toBe(
      'Could not turn Example on for M2 (Agent not found.). It is on for M1.'
    );
  });
});

describe('the disconnect dialog', () => {
  it('names the agents that lose the service', () => {
    expect(disconnectCopy(entry(), ['M1']).lines[0]).toBe(
      'M1 loses Example: disconnecting removes its grant.'
    );
    expect(disconnectCopy(entry(), ['M1', 'M3']).lines[0]).toBe(
      'M1 and M3 lose Example: disconnecting removes their grants.'
    );
    expect(disconnectCopy(entry(), []).lines[0]).toBe('None of your agents use Example.');
    expect(disconnectCopy(entry(), []).title).toBe('Disconnect Example?');
  });

  it('says every agent loses it where the server cannot say which', () => {
    expect(disconnectCopy(entry(), null).lines[0]).toBe(
      "Disconnecting removes every agent's access to Example."
    );
  });

  it('adds that the key cannot be revoked only for a key', () => {
    const note = "Switch can't revoke this key at Example; delete it there.";
    expect(disconnectCopy(entry({ auth_type: 'api_key' }), ['M1']).lines).toContain(note);
    expect(disconnectCopy(entry({ auth_type: 'oauth' }), ['M1']).lines).not.toContain(note);
  });
});

describe('an admin switching a service off', () => {
  const service = { name: 'Example', connected_members: 0, granted_agents: 0 };

  it('asks first when anyone is connected or any agent uses it, naming both counts', () => {
    expect(switchOffConfirmation({ ...service, connected_members: 3, granted_agents: 5 })).toEqual({
      title: 'Switch Example off for this workspace?',
      description:
        '3 members are connected and 5 agents use it. Their sessions lose it within a minute.',
    });
    expect(
      switchOffConfirmation({ ...service, connected_members: 1, granted_agents: 0 })?.description
    ).toBe('1 member is connected and 0 agents use it. Their sessions lose it within a minute.');
    expect(
      switchOffConfirmation({ ...service, connected_members: 0, granted_agents: 1 })?.description
    ).toBe('0 members are connected and 1 agent uses it. Their sessions lose it within a minute.');
  });

  it('does not ask when nobody is connected and no agent uses it', () => {
    expect(switchOffConfirmation(service)).toBeNull();
  });

  it('says who last switched it, or that nobody has', () => {
    const at = (iso: string) => `at ${iso}`;
    expect(
      workspaceSwitchNote({ enabled: true, updated_by_name: null, updated_at: null }, at)
    ).toBe('On by default.');
    expect(
      workspaceSwitchNote({ enabled: false, updated_by_name: 'Ada', updated_at: 'T' }, at)
    ).toBe('Switched off by Ada, at T.');
  });
});

describe('with the service_connections flag off', () => {
  const flags = (on: boolean): ServerFeatureFlags => ({
    serverId: 'server',
    flags: { ...allFeatureFlagsOff(), service_connections: on },
    fetchedAt: 1,
    error: null,
  });

  it('leaves Connectors out of the nav', () => {
    expect(workspaceNavViews({ managed: false, serviceConnections: false })).not.toContain(
      'connectors'
    );
    expect(workspaceNavViews({ managed: true, serviceConnections: true })).toEqual([
      'server',
      'serverAgents',
      'serverRooms',
      'connectors',
      'templates',
      'managedServer',
    ]);
  });

  it('has no page to show, rather than an empty one', () => {
    expect(connectorsPageAccess(flags(false))).toBe('absent');
    expect(connectorsPageAccess({ ...flags(false), fetchedAt: null, error: 'down' })).toBe(
      'absent'
    );
    expect(connectorsPageAccess(null)).toBe('loading');
    expect(
      connectorsPageAccess({ ...flags(false), fetchedAt: null, error: FLAGS_NOT_READ_YET })
    ).toBe('loading');
    expect(connectorsPageAccess(flags(true))).toBe('shown');
  });
});
