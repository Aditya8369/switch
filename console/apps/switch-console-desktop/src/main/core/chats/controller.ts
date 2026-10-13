import { listManagedAgentRecords } from '@main/core/agent-migration/managed-agents-store';
import { getAgentLocation } from '@main/core/agents/agent-location';
import { getAgents } from '@main/core/agents/getAgents';
import { agentPlacements } from '@main/core/sdk-host/connection-health';
import { controllerControl } from '@main/core/sdk-host/controller-control';
import {
  AgentManagementUnavailableError,
  fetchAgents,
  fetchManagedAgents,
  fetchManagementControllers,
  fetchMe,
} from '@main/core/switch-servers/gateway-client';
import { withServerWorkspaceSession } from '@main/core/workspaces/workspace-session';
import { requireWorkspaceForServer } from '@main/core/workspaces/workspaces-store';
import { log } from '@main/lib/logger';
import type { ChatActivityTarget } from '@shared/core/chats/activity';
import type {
  ChatMember,
  ChatMessage,
  ChatMessagesPage,
  ChatSendInput,
  ChatSummary,
  ChatUpload,
  ChatUploadInput,
} from '@shared/core/chats/chats';
import { controllerAgentKey } from '@shared/core/managed-agents/controller-agent-key';
import { createRPCController } from '@shared/lib/ipc/rpc';
import { type ActivityDeps, type OwnedManagedAgent, resolveChatActivity } from './activity';
import {
  connectChatStream,
  disconnectChatStream,
  resetChatStream,
  resyncChatStream,
} from './chat-streams';
import { generateChatTitle } from './chat-title';
import {
  archiveChat,
  createChat,
  fetchChatMedia,
  fetchChatMembers,
  fetchChatMessages,
  fetchTenantMembers,
  inviteChatMember,
  listChats,
  removeChatMember,
  renameChat,
  sendChatMessage,
  setChatHidden,
  uploadChatAttachment,
} from './gateway';

const onServer = withServerWorkspaceSession;

/** Short-lived reads the activity lookup repeats on every placement change. */
const CACHE_MS = 10_000;
const cache = new Map<string, { at: number; value: Promise<unknown> }>();
function cached<T>(key: string, read: () => Promise<T>): Promise<T> {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.value as Promise<T>;
  const value = read();
  value.catch(() => {
    if (cache.get(key)?.value === value) cache.delete(key);
  });
  cache.set(key, { at: Date.now(), value });
  return value;
}

function dropServerCaches(serverId: string): void {
  for (const key of [...cache.keys()]) if (key.startsWith(`${serverId}:`)) cache.delete(key);
}

const activityDeps: ActivityDeps = {
  localAgents: async (serverId) => {
    const moved = new Set((await listManagedAgentRecords()).map((record) => record.agentId));
    const linked = (await getAgents()).filter(
      (agent) => agent.serverId === serverId && agent.switchAgentId && !moved.has(agent.id)
    );
    return Promise.all(
      linked.map(async (agent) => ({
        id: agent.id,
        switchAgentId: agent.switchAgentId!,
        ssh: Boolean((await getAgentLocation(agent)).sshHost),
      }))
    );
  },
  placements: (serverId, consoleAgentId) => agentPlacements(serverId, consoleAgentId),
  controllerPlacements: async (serverId, agentId) => {
    try {
      const client = await controllerControl(controllerAgentKey(serverId, agentId));
      return (await client.health()).placements;
    } catch (error) {
      log.warn(
        'Could not ask a managed agent’s controller for its placements; showing messages only',
        {
          serverId,
          agentId,
          error: String(error),
        }
      );
      return null;
    }
  },
  ownedManagedAgents: (serverId) =>
    cached(`${serverId}:managed`, () =>
      onServer(serverId, async (server): Promise<OwnedManagedAgent[] | null> => {
        try {
          const [agents, controllers] = await Promise.all([
            fetchManagedAgents(server),
            fetchManagementControllers(server),
          ]);
          const byId = new Map(controllers.map((controller) => [controller.id, controller]));
          return agents.map((agent) => {
            const controller = agent.controllerId ? byId.get(agent.controllerId) : undefined;
            return {
              agentId: agent.agentId,
              controllerId: agent.controllerId,
              controllerOnline: controller?.state === 'online',
            };
          });
        } catch (error) {
          if (error instanceof AgentManagementUnavailableError) return null;
          throw error;
        }
      })
    ),
  ownsAgent: async (serverId, agentId) => {
    const [me, agents] = await Promise.all([
      cached(`${serverId}:me`, () => onServer(serverId, fetchMe)),
      cached(`${serverId}:agents`, () => onServer(serverId, fetchAgents)),
    ]);
    return agents.some((agent) => agent.id === agentId && agent.ownerId === me.id);
  },
};

/**
 * The signed-in person's chats on a server: rooms they are a member of, read
 * and written through the gateway's `/chats` routes, kept live by one feed
 * per server and tenant. Sending only ever posts to the room — routing,
 * waking and starting a session belong to the agent's host.
 */
export const chatsController = createRPCController({
  /** Start (or keep) the server's live feed for the window's tenant; returns its state. */
  connect: (serverId: string) => connectChatStream(serverId),
  disconnect: (serverId: string) => {
    disconnectChatStream(serverId);
  },
  resync: (serverId: string) => {
    resyncChatStream(serverId);
  },
  /** Drop everything held for the server, as on sign-out. */
  reset: (serverId: string) => {
    dropServerCaches(serverId);
    resetChatStream(serverId);
  },
  /** Who the person is on the server, and the tenant the chats belong to. */
  identity: async (serverId: string): Promise<{ userId: string; tenantId: string | null }> => {
    const workspace = await requireWorkspaceForServer(serverId);
    const me = await cached(`${serverId}:me`, () => onServer(serverId, fetchMe));
    return { userId: me.id, tenantId: workspace.tenantId };
  },
  list: (serverId: string): Promise<ChatSummary[]> => onServer(serverId, listChats),
  create: (params: {
    serverId: string;
    agentIds: string[];
    name: string | null;
    requestId: string;
  }): Promise<ChatSummary> => onServer(params.serverId, (server) => createChat(server, params)),
  messages: (params: {
    serverId: string;
    roomId: string;
    beforeSeq: number | null;
    limit: number;
  }): Promise<ChatMessagesPage> =>
    onServer(params.serverId, (server) =>
      fetchChatMessages(server, params.roomId, {
        beforeSeq: params.beforeSeq,
        limit: Math.min(200, Math.max(1, params.limit)),
      })
    ),
  send: (input: ChatSendInput): Promise<ChatMessage[]> =>
    onServer(input.serverId, (server) =>
      sendChatMessage(server, input.roomId, {
        requestId: input.requestId,
        body: input.body,
        threadRootId: input.threadRootId,
        uploadIds: input.uploadIds,
        mentionAgentId: input.mentionAgentId,
      })
    ),
  upload: (input: ChatUploadInput): Promise<ChatUpload> =>
    onServer(input.serverId, (server) =>
      uploadChatAttachment(server, input.roomId, {
        uploadId: input.uploadId,
        name: input.name,
        mimeType: input.mimeType,
        bytes: Buffer.from(input.data, 'base64'),
      })
    ),
  /** A room attachment's bytes, base64, for display. */
  media: async (params: {
    serverId: string;
    roomId: string;
    uri: string;
  }): Promise<{ mimeType: string; data: string }> => {
    const media = await onServer(params.serverId, (server) =>
      fetchChatMedia(server, params.roomId, params.uri)
    );
    return { mimeType: media.mimeType, data: Buffer.from(media.bytes).toString('base64') };
  },
  members: (serverId: string, roomId: string): Promise<ChatMember[]> =>
    onServer(serverId, (server) => fetchChatMembers(server, roomId)),
  /** The workspace's members, for a manager's Invite. */
  tenantMembers: async (serverId: string): Promise<{ userId: string; name: string }[]> => {
    const workspace = await requireWorkspaceForServer(serverId);
    if (!workspace.tenantId)
      throw new Error('This workspace has not been matched to a tenant yet.');
    const tenantId = workspace.tenantId;
    return onServer(serverId, (server) => fetchTenantMembers(server, tenantId));
  },
  invite: (serverId: string, roomId: string, userId: string): Promise<ChatMember[]> =>
    onServer(serverId, (server) => inviteChatMember(server, roomId, userId)),
  removeMember: (serverId: string, roomId: string, userId: string): Promise<void> =>
    onServer(serverId, (server) => removeChatMember(server, roomId, userId)),
  hide: (serverId: string, roomId: string): Promise<void> =>
    onServer(serverId, (server) => setChatHidden(server, roomId, true)),
  unhide: (serverId: string, roomId: string): Promise<void> =>
    onServer(serverId, (server) => setChatHidden(server, roomId, false)),
  archive: (serverId: string, roomId: string): Promise<void> =>
    onServer(serverId, (server) => archiveChat(server, roomId)),
  rename: (serverId: string, roomId: string, name: string): Promise<void> =>
    onServer(serverId, (server) => renameChat(server, roomId, name)),
  /** A short chat name from its first message, from the user's local Claude CLI. */
  title: (message: string): Promise<string> => generateChatTitle(message),
  /**
   * Where the agent's session for the chat runs, as seen from this machine.
   * Changes follow on the room health channel.
   */
  activity: (params: {
    serverId: string;
    agentId: string;
    roomId: string;
  }): Promise<ChatActivityTarget> => resolveChatActivity(activityDeps, params),
});
