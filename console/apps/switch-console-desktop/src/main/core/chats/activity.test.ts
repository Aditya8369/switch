import { describe, expect, it } from 'vitest';
import { controllerAgentKey } from '@shared/core/managed-agents/controller-agent-key';
import { type ActivityDeps, resolveChatActivity } from './activity';

function deps(overrides: Partial<ActivityDeps>): ActivityDeps {
  return {
    localAgents: async () => [],
    placements: async () => ({}),
    controllerPlacements: async () => 'on-controller',
    ownedManagedAgents: async () => [],
    ownsAgent: async () => false,
    ...overrides,
  };
}

describe('resolveChatActivity', () => {
  it('gives two local agents in one room their own sessions', async () => {
    const d = deps({
      localAgents: async () => [
        { id: 'console-a', switchAgentId: 'agent-a', ssh: false },
        { id: 'console-b', switchAgentId: 'agent-b', ssh: true },
      ],
      placements: async (_server, consoleAgentId): Promise<Record<string, string>> =>
        consoleAgentId === 'console-a'
          ? { 'session-a': 'room-1', 'session-a2': 'room-2' }
          : { 'session-b': 'room-1' },
    });
    const a = await resolveChatActivity(d, { serverId: 's', agentId: 'agent-a', roomId: 'room-1' });
    const b = await resolveChatActivity(d, { serverId: 's', agentId: 'agent-b', roomId: 'room-1' });
    expect(a).toMatchObject({
      kind: 'session',
      target: 'local',
      hostAgentKey: 'console-a',
      sessionId: 'session-a',
    });
    expect(b).toMatchObject({
      kind: 'session',
      target: 'ssh',
      hostAgentKey: 'console-b',
      sessionId: 'session-b',
    });
  });

  it('says a local agent has no session in a room it is not placed in', async () => {
    const d = deps({
      localAgents: async () => [{ id: 'console-a', switchAgentId: 'agent-a', ssh: false }],
      placements: async () => ({ 'session-a': 'room-2' }),
    });
    expect(
      await resolveChatActivity(d, { serverId: 's', agentId: 'agent-a', roomId: 'room-1' })
    ).toMatchObject({ kind: 'unavailable', reason: 'not-placed' });
  });

  it('shows no activity for an agent someone else owns', async () => {
    expect(
      await resolveChatActivity(deps({}), { serverId: 's', agentId: 'theirs', roomId: 'room-1' })
    ).toMatchObject({
      kind: 'unavailable',
      reason: 'not-owner',
      message: 'Agent activity is visible to its owner.',
    });
  });

  it('reaches a managed agent’s session on its online controller through the relay', async () => {
    const d = deps({
      ownedManagedAgents: async () => [
        { agentId: 'agent-c', controllerId: 'ctl-1', controllerOnline: true },
      ],
      controllerPlacements: async (_server, agentId) =>
        agentId === 'agent-c' ? { 'session-c': 'room-1' } : 'on-controller',
    });
    expect(
      await resolveChatActivity(d, { serverId: 's', agentId: 'agent-c', roomId: 'room-1' })
    ).toEqual({
      kind: 'session',
      target: 'controller',
      hostAgentKey: controllerAgentKey('s', 'agent-c'),
      sessionId: 'session-c',
      controllerId: 'ctl-1',
      generation: null,
    });
    expect(
      await resolveChatActivity(d, { serverId: 's', agentId: 'agent-c', roomId: 'room-2' })
    ).toMatchObject({ kind: 'unavailable', reason: 'not-placed' });
  });

  it('shows messages only when the relay fails, and says when the controller is offline', async () => {
    const managed = (online: boolean) => async () => [
      { agentId: 'agent-c', controllerId: 'ctl-1', controllerOnline: online },
    ];
    const input = { serverId: 's', agentId: 'agent-c', roomId: 'room-1' };
    expect(
      await resolveChatActivity(deps({ ownedManagedAgents: managed(true) }), input)
    ).toMatchObject({ kind: 'unavailable', reason: 'on-controller' });
    expect(
      await resolveChatActivity(deps({ ownedManagedAgents: managed(false) }), input)
    ).toMatchObject({ kind: 'unavailable', reason: 'controller-offline' });
    expect(
      await resolveChatActivity(
        deps({
          ownedManagedAgents: managed(true),
          controllerPlacements: async () => 'host-unreachable',
        }),
        input
      )
    ).toMatchObject({ kind: 'unavailable', reason: 'host-unreachable' });
  });
});
