import type { RemoteRoomSummary } from '@shared/core/switch-servers/switch-servers';

/**
 * A Console direct chat: a direct room with one agent and no messaging-app
 * bridge. The same rule used to identify "Direct chats" on the agent page.
 */
export function isConsoleDirectChat(
  room: Pick<RemoteRoomSummary, 'channelType' | 'bridgeType'>
): boolean {
  return room.channelType === 'direct' && room.bridgeType === null;
}
