import { describe, expect, it } from 'vitest';
import { controllerAgentKey, parseControllerAgentKey } from './controller-agent-key';

describe('controller agent keys', () => {
  it('round-trips, and is not read from a Console agent id', () => {
    const key = controllerAgentKey('server:1', 'agent-1');
    expect(parseControllerAgentKey(key)).toEqual({ serverId: 'server:1', agentId: 'agent-1' });
    expect(parseControllerAgentKey('5f0c2a3e-1b2c-4d5e-8f90-123456789abc')).toBeNull();
  });

  it('refuses keys without an agent', () => {
    expect(parseControllerAgentKey('controller:server-1:agent=')).toBeNull();
    expect(parseControllerAgentKey('controller::agent=a')).toBeNull();
  });
});
