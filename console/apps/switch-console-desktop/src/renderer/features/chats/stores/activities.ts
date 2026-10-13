import { hostJournalTransport } from '@renderer/features/sessions/components/transcript/shared-session-transport';
import { events, rpc } from '@renderer/lib/ipc';
import { chatRemovedChannel, chatResetChannel } from '@shared/core/chats/chatEvents';
import { roomHealthChangedChannel } from '@shared/core/switch-rooms/switchRoomEvents';
import { AgentActivities } from './chat-activity-store';

/** The app's agent activities, kept in step with placements and access. */
export const agentActivities = new AgentActivities({
  resolve: (serverId, agentId, roomId) => rpc.chats.activity({ serverId, agentId, roomId }),
  transport: (target) => hostJournalTransport(target.hostAgentKey),
  reasoning: (hostAgentKey, sessionId, turnIds) =>
    rpc.sdkHost.reasoningList(hostAgentKey, sessionId, turnIds),
  watchPlacements: (serverId, onChange) => events.on(roomHealthChangedChannel, onChange, serverId),
});

events.on(chatRemovedChannel, ({ serverId, roomId, reason }) => {
  if (reason === 'access') agentActivities.drop(serverId, roomId);
});
events.on(chatResetChannel, ({ serverId }) => agentActivities.drop(serverId, null));
