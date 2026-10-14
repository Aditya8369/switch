import type { Item, Session } from '@switch-console/shared/session-v1';
import { describe, expect, it } from 'vitest';
import {
  contextBlocker,
  contextMarkerSlots,
  contextMeter,
  isCompacting,
} from '@renderer/features/chats/chat-context';

const session = (patch: Partial<Session> = {}): Session => ({
  sessionId: 's',
  agentId: 'a',
  provider: 'claude',
  hostId: 'h',
  epoch: 'e',
  status: 'ready',
  connectivity: 'online',
  pendingRequestIds: [],
  capabilities: {
    input: 'queue',
    approvals: true,
    questions: true,
    interrupt: true,
    reset: true,
    compact: true,
    modelChange: false,
    attachmentMimeTypes: [],
  },
  ...patch,
});
const updatedAt = '2026-10-14T09:00:00Z';

describe('contextMeter', () => {
  it('is hidden without data', () => {
    expect(contextMeter(undefined)).toBeNull();
    expect(contextMeter(null)).toBeNull();
  });

  it('shows used against the window', () => {
    expect(contextMeter({ usedTokens: 134_000, windowTokens: 1_000_000, updatedAt })).toEqual({
      label: 'Context 134k / 1M (13%)',
      used: '134k',
      fraction: 0.134,
      warning: false,
    });
  });

  it('shows only what is used when the window is unknown', () => {
    expect(contextMeter({ usedTokens: 134_000, windowTokens: null, updatedAt })).toEqual({
      label: 'Context 134k used',
      used: '134k',
      fraction: null,
      warning: false,
    });
  });

  it('warns from 80%', () => {
    expect(contextMeter({ usedTokens: 159_999, windowTokens: 200_000, updatedAt })?.warning).toBe(
      false
    );
    expect(contextMeter({ usedTokens: 160_000, windowTokens: 200_000, updatedAt })?.warning).toBe(
      true
    );
  });
});

describe('contextBlocker', () => {
  const idle = { connected: true, session: session(), pendingCommand: false, working: false };

  it('allows an idle connected session', () => {
    expect(contextBlocker(idle)).toBeNull();
  });

  it.each([
    [{ connected: false }, "The agent's machine is offline."],
    [{ session: session({ connectivity: 'offline' }) }, "The agent's machine is offline."],
    [
      { session: session({ pendingRequestIds: ['r'] }), working: true },
      'Waiting for a pending request.',
    ],
    [{ working: true }, 'The agent is working — wait for it to finish.'],
    [{ session: session({ status: 'running' }) }, 'The agent is working — wait for it to finish.'],
    [{ pendingCommand: true }, 'Waiting for the previous command to be confirmed.'],
    [
      { session: session({ status: 'starting' }) },
      'The session is starting — wait for it to be ready.',
    ],
    [{ session: session({ status: 'stopped' }) }, 'No live session yet — send a message first.'],
    [{ session: session({ status: 'error' }) }, "The agent's session stopped with an error."],
  ])('%o → %s', (patch, reason) => {
    expect(contextBlocker({ ...idle, ...patch })).toBe(reason);
  });
});

describe('isCompacting', () => {
  const notice = (code: string) => ({
    level: 'info' as const,
    code,
    message: '',
    afterItemId: null,
  });

  it('follows the latest compaction notice while the session runs', () => {
    const running = session({ status: 'running' });
    expect(isCompacting(running, [notice('COMPACTION_STARTED')])).toBe(true);
    expect(
      isCompacting(running, [notice('COMPACTION_STARTED'), notice('COMPACTION_COMPLETED')])
    ).toBe(false);
    expect(isCompacting(session(), [notice('COMPACTION_STARTED')])).toBe(false);
  });
});

describe('contextMarkerSlots', () => {
  const item = (itemId: string, turnId: string) => ({ itemId, turnId }) as Item;
  const notice = (code: string, afterItemId: string | null) => ({
    level: 'info' as const,
    code,
    message: '',
    afterItemId,
  });
  const base = {
    messageIds: ['m1', 'reply1', 'm2', 'reply2'],
    bound: new Map([
      ['m1', { turnId: 't1' }],
      ['m2', { turnId: 't2' }],
    ]),
    turnIds: ['t1', 'other', 't2'],
    items: [item('i1', 't1'), item('io', 'other'), item('i2', 't2')],
    hasMore: false,
  };

  it('places a marker before the next turn that ran after it, or at the end', () => {
    const slots = contextMarkerSlots({
      ...base,
      notices: [
        notice('COMPACTION_COMPLETED', 'i1'),
        notice('CONTEXT_RESET', 'io'),
        notice('COMPACTION_COMPLETED', 'i2'),
        notice('MODEL_CHANGED', 'i2'),
      ],
    });
    expect(slots).toEqual(
      new Map([
        ['m2', ['compacted', 'reset']],
        [null, ['compacted']],
      ])
    );
  });

  it('leaves out a marker older than the loaded messages while more can load', () => {
    const notices = [notice('CONTEXT_RESET', null)];
    expect(contextMarkerSlots({ ...base, notices, hasMore: true }).size).toBe(0);
    expect(contextMarkerSlots({ ...base, notices })).toEqual(new Map([['m1', ['reset']]]));
  });
});
