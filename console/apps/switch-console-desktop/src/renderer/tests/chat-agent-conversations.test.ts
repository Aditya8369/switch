import { describe, expect, it } from 'vitest';
import { agentConversations, chatRowLabel } from '@renderer/features/chats/agent-conversations';
import type { ChatSummary } from '@shared/core/chats/chats';
import type { RemoteAgentRoom } from '@shared/core/switch-servers/switch-servers';

const agent = (id: string, name: string, displayName: string | null = null) => ({
  id,
  name,
  displayName,
  iconUrl: null,
  provider: null,
});

const summary = (overrides: Partial<ChatSummary>): ChatSummary => ({
  roomId: 'r',
  name: 'Chat with helper',
  channelType: 'direct',
  bridgeType: null,
  channelName: null,
  agents: [],
  canManage: false,
  ownsAgent: false,
  lastMessage: null,
  ...overrides,
});

describe('agentConversations', () => {
  const room = (roomId: string, roomName: string, archived = false): RemoteAgentRoom => ({
    roomId,
    roomName,
    archived,
    status: 'live',
    roomRole: null,
  });

  it('puts unbridged direct chats under Direct chats and every other room under Rooms', () => {
    const direct = summary({ roomId: 'dm', agents: [agent('a', 'alpha')] });
    const slackDm = summary({ roomId: 'slack-dm', bridgeType: 'slack' });
    const channel = summary({ roomId: 'team', channelType: 'channel_private' });
    const split = agentConversations(
      [direct, slackDm, channel],
      [room('team', 'team'), room('dm', 'dm'), room('slack-dm', 'Dana'), room('old', 'old', true)]
    );
    expect(split.direct.map((chat) => chat.roomId)).toEqual(['dm']);
    expect(split.rooms.map((each) => each.roomId)).toEqual(['slack-dm', 'team']);
  });
});

describe('chatRowLabel', () => {
  it('names a messaging-app channel by its channel, with the app', () => {
    expect(
      chatRowLabel(
        summary({
          name: 'Acme: general',
          channelType: 'channel_public',
          bridgeType: 'slack',
          channelName: 'general',
        })
      )
    ).toEqual({ name: '#general', platform: 'Slack' });
  });

  it('names a messaging-app DM without a hash', () => {
    expect(
      chatRowLabel(summary({ name: 'DM with Dana', bridgeType: 'discord', channelName: 'Dana' }))
    ).toEqual({ name: 'Dana', platform: 'Discord' });
  });

  it('names an internal chat by its own name', () => {
    expect(chatRowLabel(summary({}))).toEqual({ name: 'Chat with helper', platform: null });
  });
});
