/**
 * A managed agent run by an agent controller (a daemon on a machine, the
 * embedded controller, a cloud machine), named the way the session calls
 * (`rpc.sdkHost.*`) name an agent. Its sessions are reached through the
 * Switch server's relay for the agent, never directly, and never started
 * from Console.
 */

const PREFIX = 'controller:';
const AGENT_MARK = 'agent=';

export type ControllerAgentTarget = { serverId: string; agentId: string };

export function controllerAgentKey(serverId: string, agentId: string): string {
  return `${PREFIX}${serverId}:${AGENT_MARK}${agentId}`;
}

export function parseControllerAgentKey(key: string): ControllerAgentTarget | null {
  if (!key.startsWith(PREFIX)) return null;
  const at = key.lastIndexOf(':');
  const serverId = key.slice(PREFIX.length, at);
  const rest = key.slice(at + 1);
  if (!serverId || !rest.startsWith(AGENT_MARK)) return null;
  const agentId = rest.slice(AGENT_MARK.length);
  return agentId ? { serverId, agentId } : null;
}
