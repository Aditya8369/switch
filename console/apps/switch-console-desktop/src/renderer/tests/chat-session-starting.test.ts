import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  type ChatMessage,
  liveSessionStartingNotices,
  SESSION_STARTING_MESSAGE,
} from '@shared/core/chats/chats';

function message(messageId: string, clientId: string, body: string): ChatMessage {
  return {
    messageId,
    body,
    sender: { clientId, name: clientId, kind: 'agent', agentId: clientId, userId: null },
  } as unknown as ChatMessage;
}

describe('session-starting notices', () => {
  it('shows a notice while it is the latest message from its agent', () => {
    const messages = [
      message('$ask', 'helper', 'hi'),
      message('$start', 'helper', SESSION_STARTING_MESSAGE),
      message('$other', 'reviewer', 'unrelated'),
    ];
    expect(liveSessionStartingNotices(messages)).toEqual(new Set(['$start']));
  });

  it('hides a notice once its agent posts again', () => {
    const messages = [
      message('$start', 'helper', SESSION_STARTING_MESSAGE),
      message('$reply', 'helper', 'Here is the answer.'),
    ];
    expect(liveSessionStartingNotices(messages)).toEqual(new Set());
  });

  it('matches the text the host posts', () => {
    const source = readFileSync(
      join(__dirname, '../../../../../packages/agent-providers/src/host/watcher-tools.ts'),
      'utf8'
    );
    expect(source).toContain(`SESSION_STARTING_MESSAGE = '${SESSION_STARTING_MESSAGE}'`);
  });
});
