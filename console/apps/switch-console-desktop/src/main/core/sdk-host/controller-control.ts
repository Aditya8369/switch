import { RELAY_TIMEOUT_MS, RelayClient } from '@switch-console/agent-providers';
import { gatewayRequest } from '@main/core/switch-servers/gateway-client';
import { getServer } from '@main/core/switch-servers/servers-store';
import { withServerWorkspaceSession } from '@main/core/workspaces/workspace-session';
import { parseControllerAgentKey } from '@shared/core/managed-agents/controller-agent-key';

/**
 * Console's reach into a managed agent's sessions on its controller, through
 * the Switch server's owner-only relay for the agent
 * (`/management/agents/{id}/control`).
 */

export function isControllerAgent(agentId: string): boolean {
  return parseControllerAgentKey(agentId) !== null;
}

/** The relay client for a controller agent key. */
export async function controllerControl(key: string): Promise<RelayClient> {
  const target = parseControllerAgentKey(key);
  if (!target) throw new Error(`${key} is not a controller agent.`);
  if (!(await getServer(target.serverId)))
    throw new Error('The Switch server for this agent was removed.');
  return new RelayClient(
    (path, init) =>
      withServerWorkspaceSession(target.serverId, (server) =>
        gatewayRequest(server, path, {
          authenticated: true,
          method: init.method,
          body: init.body,
          signal: init.signal,
        })
      ),
    `/management/agents/${encodeURIComponent(target.agentId)}/control`,
    { retryMs: 20_000, timeoutMs: RELAY_TIMEOUT_MS }
  );
}
