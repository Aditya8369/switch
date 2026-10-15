import { focusComposerWhenOpened } from '@renderer/features/chats/components/chat-composer';
import { chatsStore, chatTitler } from '@renderer/features/chats/stores/chats';
import { agentTabStore } from '@renderer/features/managed-agents/agent-tab-store';
import { failureText } from '@renderer/lib/errors/describe-failure';
import { toast } from '@renderer/lib/hooks/use-toast';
import { rpc } from '@renderer/lib/ipc';
import { appState } from '@renderer/lib/stores/app-state';
import type { ChatSummary } from '@shared/core/chats/chats';

/** What the buddy's first chat is called, as on the board; it keeps it. */
export const BUDDY_CHAT_NAME = 'Welcome';

/**
 * The buddy's chat to open: the one named Welcome, else its newest direct
 * chat; a new Welcome chat only when it has none. Opening the buddy again —
 * replaying onboarding, a second Start — lands in the same chat rather than
 * adding one each time.
 */
async function buddyChat(serverId: string, agentId: string): Promise<ChatSummary> {
  const direct = (await rpc.chats.list(serverId)).filter(
    (chat) => chat.channelType === 'direct' && chat.agents.some((agent) => agent.id === agentId)
  );
  const existing = direct.find((chat) => chat.name === BUDDY_CHAT_NAME) ?? direct[0];
  if (existing) return existing;
  const chat = await rpc.chats.create({
    serverId,
    agentIds: [agentId],
    name: BUDDY_CHAT_NAME,
    requestId: crypto.randomUUID(),
  });
  chatsStore.add(serverId, chat);
  // Named here, so its first message does not rename it.
  chatTitler.created(chat, true);
  return chat;
}

/**
 * Opens the person's buddy on its Chats tab, in its chat. When the chat cannot
 * be had the agent's page still opens, and a toast says why.
 */
export async function openBuddyChat(
  serverId: string,
  agent: { agentId: string; name: string }
): Promise<void> {
  let roomId: string | null = null;
  try {
    roomId = (await buddyChat(serverId, agent.agentId)).roomId;
    focusComposerWhenOpened(roomId);
  } catch (cause) {
    toast({
      title: 'Could not open the chat with switch-buddy',
      description: failureText(cause, 'Switch did not answer.'),
      variant: 'destructive',
    });
  }
  agentTabStore.setTab(agent.agentId, 'chats');
  appState.navigation.navigate('managedAgent', {
    serverId,
    agentId: agent.agentId,
    name: agent.name,
    ...(roomId ? { roomId } : {}),
  });
}
