import { ChevronDown, ChevronRight, Plus } from 'lucide-react';
import { observer } from 'mobx-react-lite';
import { type ReactNode, useEffect, useState } from 'react';
import { agentConversations } from '@renderer/features/chats/agent-conversations';
import { ChatPanel } from '@renderer/features/chats/components/chat-panel';
import { ChatRow } from '@renderer/features/chats/components/chat-row';
import { directChats } from '@renderer/features/chats/start-direct-chat';
import { chatsStore } from '@renderer/features/chats/stores/chats';
import { RoomListRow } from '@renderer/features/sidebar/main-section';
import { SidebarItemMiniButton } from '@renderer/features/sidebar/sidebar-primitives';
import { switchRoomsStore } from '@renderer/features/switch-servers/switch-rooms-store';
import { useParams } from '@renderer/lib/layout/navigation-provider';
import { showModal } from '@renderer/lib/modal/modal-provider';
import { Button } from '@renderer/lib/ui/button';
import { EmptyState } from '@renderer/lib/ui/empty-state';
import type { ManagedAgentView } from '@shared/core/managed-agents/managed-agents';

function Section({
  title,
  addLabel,
  onAdd,
  children,
}: {
  title: string;
  addLabel: string;
  onAdd: () => void;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(true);
  const Chevron = open ? ChevronDown : ChevronRight;
  return (
    <section aria-label={title} className="flex flex-col gap-[2px] pb-3">
      <div className="flex items-center justify-between px-1 pb-1">
        <button
          type="button"
          aria-expanded={open}
          onClick={() => setOpen(!open)}
          className="flex items-center gap-1 text-xs font-medium text-foreground-muted hover:text-foreground"
        >
          <Chevron className="size-3.5" />
          {title}
        </button>
        <SidebarItemMiniButton aria-label={addLabel} title={addLabel} onClick={onAdd}>
          <Plus className="size-3.5" />
        </SidebarItemMiniButton>
      </div>
      {open && children}
    </section>
  );
}

const Note = ({ children }: { children: ReactNode }) => (
  <p className="px-2 py-1 text-xs text-foreground-muted">{children}</p>
);

/**
 * An agent's chats: its direct chats and the rooms it is in, beside the one
 * open. The open one is kept in the view's params; with none chosen it is the
 * newest direct chat.
 */
export const AgentChats = observer(function AgentChats({ agent }: { agent: ManagedAgentView }) {
  const { params, setParams } = useParams('managedAgent');
  const { serverId, workspaceId, agentId } = agent;
  useEffect(() => {
    void switchRoomsStore.fetchAgentRooms(workspaceId, agentId);
  }, [workspaceId, agentId]);

  // The chats store follows the window's server; another server's chats are not in it.
  const agentChats = chatsStore.serverId === serverId ? chatsStore.chatsOfAgent(agentId) : [];
  const agentRooms = switchRoomsStore.roomsFor(workspaceId, agentId);
  const { direct, rooms } = agentConversations(agentChats, agentRooms ?? []);
  const roomsError = switchRoomsStore.errorFor(workspaceId, agentId);
  const roomId = params.roomId ?? direct[0]?.roomId ?? null;
  const open = (id: string) => setParams({ roomId: id });
  const newChat = async () => {
    const chat = await directChats.start(serverId, agentId);
    if (chat) open(chat.roomId);
  };

  return (
    <div className="flex h-full min-h-0">
      <div className="flex w-[300px] shrink-0 flex-col overflow-y-auto border-r border-border p-2">
        <Section title="Direct chats" addLabel="New chat" onAdd={() => void newChat()}>
          {chatsStore.listError && <Note>{chatsStore.listError}</Note>}
          {direct.map((chat) => (
            <ChatRow
              key={chat.roomId}
              serverId={serverId}
              chat={chat}
              isActive={chat.roomId === roomId}
              onOpen={() => open(chat.roomId)}
            />
          ))}
          {direct.length === 0 && <Note>No direct chats yet.</Note>}
        </Section>
        <Section
          title="Rooms"
          addLabel="Create room"
          onAdd={() => showModal('createRoomModal', { serverId })}
        >
          {roomsError && <Note>{roomsError}</Note>}
          {rooms.map((room) => (
            <RoomListRow
              key={room.roomId}
              room={{
                name: switchRoomsStore.roomNameById(room.roomId) ?? room.roomName,
                bridgeType: switchRoomsStore.roomBridgeTypeById(room.roomId),
                bridgeDisplayName:
                  switchRoomsStore.roomSummaryById(room.roomId)?.bridgeDisplayName ?? null,
              }}
              isActive={room.roomId === roomId}
              onOpen={() => open(room.roomId)}
            />
          ))}
          {!agentRooms && !roomsError && <Note>Loading…</Note>}
          {agentRooms && rooms.length === 0 && <Note>Not in any room yet.</Note>}
        </Section>
      </div>
      <div className="min-w-0 flex-1">
        {roomId ? (
          <ChatPanel
            key={`${serverId}:${roomId}`}
            serverId={serverId}
            roomId={roomId}
            agentId={agentId}
            showHeader
          />
        ) : (
          <EmptyState
            label="No chat open"
            description="Start a chat with this agent, or open one of its rooms."
            action={<Button onClick={() => void newChat()}>Start a chat</Button>}
          />
        )}
      </div>
    </div>
  );
});
