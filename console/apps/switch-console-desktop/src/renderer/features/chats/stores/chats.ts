import { workspacesStore } from '@renderer/features/workspaces/workspaces-store';
import { events, rpc } from '@renderer/lib/ipc';
import { log } from '@renderer/utils/logger';
import { agentChatsFlag } from './agent-chats-flag';
import { ChatTitler } from './chat-titler';
import { ChatsStore, chatsEventsFrom } from './chats-store';

/** The app's chats store, following the workspace the window is scoped to. */
export const chatsStore = new ChatsStore(
  {
    connect: (serverId) => rpc.chats.connect(serverId),
    disconnect: (serverId) => rpc.chats.disconnect(serverId),
    list: (serverId) => rpc.chats.list(serverId),
    identity: (serverId) => rpc.chats.identity(serverId),
    timeline: (serverId) => ({
      messages: (roomId, beforeSeq, limit) =>
        rpc.chats.messages({ serverId, roomId, beforeSeq, limit }),
      upload: (roomId, file) => rpc.chats.upload({ serverId, roomId, ...file }),
      send: (roomId, input) => rpc.chats.send({ serverId, roomId, ...input }),
      newId: () => crypto.randomUUID(),
    }),
  },
  chatsEventsFrom(events)
);

chatsStore.follow(() => {
  const serverId = workspacesStore.activeServerId;
  const active = workspacesStore.active;
  if (!serverId || agentChatsFlag(serverId) !== true) return { serverId: null, key: null };
  return { serverId, key: active ? `${active.id}:${active.tenantId}` : null };
});

export const chatTitler = new ChatTitler({
  title: (message) => rpc.chats.title(message),
  rename: (serverId, roomId, name) => rpc.chats.rename(serverId, roomId, name),
  chat: (roomId) => chatsStore.chat(roomId),
  add: (serverId, chat) => chatsStore.add(serverId, chat),
  warn: (message, context) => log.warn(message, context),
});
