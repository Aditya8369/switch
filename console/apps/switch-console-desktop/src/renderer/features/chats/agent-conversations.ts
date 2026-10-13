import { bridgePlatformLabel } from '@renderer/lib/components/bridge-platform';
import type { ChatSummary } from '@shared/core/chats/chats';
import type { RemoteAgentRoom } from '@shared/core/switch-servers/switch-servers';

/**
 * An agent's conversations, in two lists that never share a room: its direct
 * chats made in Console (a direct room bridged to no messaging app), newest
 * first, and every other room it is in, by name — a messaging-app DM and a
 * chat with several agents included, whether or not its membership lists it.
 */
export function agentConversations(
  agentChats: readonly ChatSummary[],
  agentRooms: readonly RemoteAgentRoom[]
): { direct: ChatSummary[]; rooms: Pick<RemoteAgentRoom, 'roomId' | 'roomName'>[] } {
  const direct = agentChats.filter(
    (chat) => chat.channelType === 'direct' && chat.bridgeType === null
  );
  const directIds = new Set(direct.map((chat) => chat.roomId));
  const listed = agentRooms.filter((room) => !room.archived && !directIds.has(room.roomId));
  const listedIds = new Set(agentRooms.map((room) => room.roomId));
  const unlisted = agentChats
    .filter((chat) => !directIds.has(chat.roomId) && !listedIds.has(chat.roomId))
    .map((chat) => ({ roomId: chat.roomId, roomName: chat.name }));
  const rooms = [...listed, ...unlisted].sort((a, b) => a.roomName.localeCompare(b.roomName));
  return { direct, rooms };
}

/**
 * How a chat's row names it: a messaging-app room by its channel ("#general")
 * with the app beside it, any other room by its own name.
 */
export function chatRowLabel(chat: ChatSummary): { name: string; platform: string | null } {
  if (!chat.bridgeType) return { name: chat.name, platform: null };
  const channel = chat.channelName ?? chat.name;
  const name = chat.channelType === 'direct' || channel.startsWith('#') ? channel : `#${channel}`;
  return { name, platform: bridgePlatformLabel(chat.bridgeType) };
}
