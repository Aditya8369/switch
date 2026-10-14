import { describe, expect, it, vi } from 'vitest';

vi.mock('@main/lib/logger', () => ({ log: { warn: () => {} } }));

const { ChatActivityStream } = await import('./activity-stream');

const item = {
  agentId: 'a',
  sessionId: 's',
  turnId: 't',
  itemId: 'turn',
  kind: 'turn',
  revision: 1,
  status: 'running',
  title: '',
  text: '',
  commandId: null,
  roomId: 'room-1',
  threadId: null,
  messageId: 'm1',
  occurredAt: '2026-01-01T00:00:00Z',
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
};

describe('ChatActivityStream', () => {
  it('asks for snapshots on ready and resync, and passes rows that match the contract', async () => {
    const body = [
      'event: ready\ndata: {}\n\n',
      ': ping\n\n',
      `event: activity\ndata: ${JSON.stringify(item)}\n\n`,
      'event: activity\ndata: {"roomId":"room-1"}\n\n',
      'event: resync\ndata: {}\n\n',
    ].join('');
    const seen: string[] = [];
    const stream = new ChatActivityStream({
      open: async () => new Response(body),
      isUnauthorized: () => false,
      backoffMs: () => 60_000,
      setTimer: () => () => {},
      sink: {
        activity: (row) => seen.push(`activity:${row.messageId}`),
        approval: () => seen.push('approval'),
        resync: () => seen.push('resync'),
      },
    });
    stream.start();
    await vi.waitFor(() => expect(seen).toEqual(['resync', 'activity:m1', 'resync']));
    stream.stop();
  });
});
