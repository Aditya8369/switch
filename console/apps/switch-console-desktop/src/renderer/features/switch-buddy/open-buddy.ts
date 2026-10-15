import { directChats } from '@renderer/features/chats/start-direct-chat';
import { agentTabStore } from '@renderer/features/managed-agents/agent-tab-store';
import { appState } from '@renderer/lib/stores/app-state';

/**
 * Opens the person's buddy on its Chats tab, in a direct chat with it: the
 * empty one it already has, else a new one. When the chat cannot be made the
 * agent's page still opens, and the starter has said why.
 */
export async function openBuddyChat(
  serverId: string,
  agent: { agentId: string; name: string }
): Promise<void> {
  const chat = await directChats.start(serverId, agent.agentId);
  agentTabStore.setTab(agent.agentId, 'chats');
  appState.navigation.navigate('managedAgent', {
    serverId,
    agentId: agent.agentId,
    name: agent.name,
    ...(chat ? { roomId: chat.roomId } : {}),
  });
}
