import { describe, expect, it, vi } from 'vitest';
import { parseChatRows } from './gateway';

const warn = vi.hoisted(() => vi.fn());
vi.mock('@main/lib/logger', () => ({ log: { warn } }));
vi.mock('@main/core/switch-servers/gateway-client', () => ({
  GatewayError: class extends Error {},
  gatewayFetch: vi.fn(),
}));

function row(roomId: string, channelType: string) {
  return {
    roomId,
    name: roomId,
    channelType,
    bridgeType: null,
    channelName: null,
    agents: [],
    canManage: true,
    ownsAgent: false,
    lastMessage: null,
  };
}

describe('parseChatRows', () => {
  it('accepts every channel type the server sends', () => {
    const types = ['lobby', 'channel_public', 'channel_private', 'group', 'direct'];
    expect(parseChatRows(types.map((type) => row(type, type))).map((c) => c.roomId)).toEqual(types);
  });

  it('skips a row that fails the contract with a warning and keeps the rest', () => {
    const chats = parseChatRows([row('room-a', 'direct'), row('room-bad', 'unknown')]);
    expect(chats.map((chat) => chat.roomId)).toEqual(['room-a']);
    expect(warn).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ roomId: 'room-bad' })
    );
  });
});
