import {
  ACTIVITY_UNAVAILABLE_TEXT,
  type ChatActivityTarget,
  type ChatActivityUnavailableReason,
} from '@shared/core/chats/activity';
import { controllerAgentKey } from '@shared/core/managed-agents/controller-agent-key';

/**
 * Which session of an agent attends a chat, from where it runs.
 *
 * A Console agent on this machine or its SSH host is asked through its own
 * room watcher's placements. A managed agent's sessions run on its
 * controller, whose watcher is asked through the Switch relay; while that
 * cannot be asked its chat shows messages only, and says so.
 */

export type LocalChatAgent = { id: string; switchAgentId: string; ssh: boolean };
export type OwnedManagedAgent = {
  agentId: string;
  controllerId: string | null;
  controllerOnline: boolean;
};

export type ActivityDeps = {
  /** This Console's agents linked to the server and not moved to a controller. */
  localAgents: (serverId: string) => Promise<LocalChatAgent[]>;
  /** A local agent's placements (session → room), or null while its watcher cannot be asked. */
  placements: (serverId: string, consoleAgentId: string) => Promise<Record<string, string> | null>;
  /** A managed agent's placements on its controller, through the relay; null when the relay fails. */
  controllerPlacements: (
    serverId: string,
    agentId: string
  ) => Promise<Record<string, string> | null>;
  /** The signed-in person's managed agents, or null where the server has no agent management. */
  ownedManagedAgents: (serverId: string) => Promise<OwnedManagedAgent[] | null>;
  /** Whether the signed-in person owns the Switch agent. */
  ownsAgent: (serverId: string, agentId: string) => Promise<boolean>;
};

const unavailable = (
  reason: ChatActivityUnavailableReason,
  message: string = ACTIVITY_UNAVAILABLE_TEXT[reason]
): ChatActivityTarget => ({ kind: 'unavailable', reason, message });

/** The session placed in `roomId`, from a placements map. */
export function placedSession(placements: Record<string, string>, roomId: string): string | null {
  for (const [sessionId, placedRoom] of Object.entries(placements))
    if (placedRoom === roomId) return sessionId;
  return null;
}

export async function resolveChatActivity(
  deps: ActivityDeps,
  input: { serverId: string; agentId: string; roomId: string }
): Promise<ChatActivityTarget> {
  const { serverId, agentId, roomId } = input;
  const local = (await deps.localAgents(serverId)).find((agent) => agent.switchAgentId === agentId);
  if (local) {
    const placements = await deps.placements(serverId, local.id);
    if (placements === null) return unavailable('watcher-unreachable');
    const sessionId = placedSession(placements, roomId);
    if (sessionId === null) return unavailable('not-placed');
    return {
      kind: 'session',
      target: local.ssh ? 'ssh' : 'local',
      hostAgentKey: local.id,
      sessionId,
      controllerId: null,
      generation: null,
    };
  }
  const managed = (await deps.ownedManagedAgents(serverId))?.find(
    (agent) => agent.agentId === agentId
  );
  if (!managed)
    return (await deps.ownsAgent(serverId, agentId))
      ? unavailable('not-on-this-machine')
      : unavailable('not-owner');
  if (managed.controllerId === null) return unavailable('not-on-this-machine');
  if (!managed.controllerOnline) return unavailable('controller-offline');
  const placements = await deps.controllerPlacements(serverId, agentId);
  if (placements === null) return unavailable('on-controller');
  const sessionId = placedSession(placements, roomId);
  if (sessionId === null) return unavailable('not-placed');
  return {
    kind: 'session',
    target: 'controller',
    hostAgentKey: controllerAgentKey(serverId, agentId),
    sessionId,
    controllerId: managed.controllerId,
    generation: null,
  };
}
