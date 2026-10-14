import { toast } from '@renderer/lib/hooks/use-toast';
import { rpc } from '@renderer/lib/ipc';
import { focusComposerWhenOpened } from './components/chat-composer';
import { chatsStore, chatTitler } from './stores/chats';
import { DirectChatStarter } from './stores/direct-chat-starter';

/** Starts a direct chat with one agent, named later from its first message. */
export const directChats = new DirectChatStarter({
  create: (input) => rpc.chats.create(input),
  created: (serverId, chat) => {
    chatsStore.add(serverId, chat);
    chatTitler.created(chat, false);
    focusComposerWhenOpened(chat.roomId);
  },
  failed: (message) =>
    toast({ title: 'Could not start the chat', description: message, variant: 'destructive' }),
  newId: () => crypto.randomUUID(),
});
