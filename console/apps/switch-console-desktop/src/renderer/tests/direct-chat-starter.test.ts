import { describe, expect, it, vi } from 'vitest';
import { DirectChatStarter } from '@renderer/features/chats/stores/direct-chat-starter';
import type { ChatSummary } from '@shared/core/chats/chats';

const chat = { roomId: 'r1', channelType: 'direct' } as ChatSummary;

function setup(create: () => Promise<ChatSummary>) {
  let id = 0;
  const deps = {
    create: vi.fn(create),
    created: vi.fn(),
    failed: vi.fn(),
    newId: () => `req-${++id}`,
  };
  return { deps, starter: new DirectChatStarter(deps) };
}

describe('DirectChatStarter', () => {
  it('creates an unnamed direct chat with the one agent and reports it', async () => {
    const { deps, starter } = setup(async () => chat);
    await expect(starter.start('s1', 'a1')).resolves.toBe(chat);
    expect(deps.create).toHaveBeenCalledWith({
      serverId: 's1',
      agentIds: ['a1'],
      name: null,
      requestId: 'req-1',
    });
    expect(deps.created).toHaveBeenCalledWith('s1', chat);
  });

  it('ignores a second start for the same agent while one is in flight', async () => {
    let finish: (value: ChatSummary) => void = () => {};
    const { deps, starter } = setup(() => new Promise((resolve) => (finish = resolve)));
    const first = starter.start('s1', 'a1');
    await expect(starter.start('s1', 'a1')).resolves.toBeNull();
    finish(chat);
    await expect(first).resolves.toBe(chat);
    expect(deps.create).toHaveBeenCalledOnce();
  });

  it('reports a failure and reuses the request id after an uncertain one', async () => {
    const { deps, starter } = setup(async () => {
      throw new Error('offline');
    });
    await expect(starter.start('s1', 'a1')).resolves.toBeNull();
    expect(deps.failed).toHaveBeenCalledWith(expect.stringContaining('Try again'));
    expect(deps.created).not.toHaveBeenCalled();
    deps.create.mockResolvedValueOnce(chat);
    await starter.start('s1', 'a1');
    expect(deps.create).toHaveBeenLastCalledWith(expect.objectContaining({ requestId: 'req-1' }));
  });
});
