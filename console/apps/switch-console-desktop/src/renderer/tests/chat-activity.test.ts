import { describe, expect, it, vi } from 'vitest';
import {
  bindTurns,
  foldTurnEndNotices,
  groupTurns,
  isThinking,
  placeTurns,
  toolState,
  type TurnActivity,
  turnTools,
} from '@renderer/features/chats/activity-join';
import {
  type ActivityApi,
  AgentActivities,
} from '@renderer/features/chats/stores/chat-activity-store';
import type { ChatActivityItem, ChatApproval, RoomActivity } from '@shared/core/chats/activity';
import type { ChatMessage } from '@shared/core/chats/chats';
import { RpcError } from '@shared/lib/ipc/rpc-error';

let clock = 0;
function row(
  turnId: string,
  itemId: string,
  extra: Partial<ChatActivityItem> = {}
): ChatActivityItem {
  const at = new Date(Date.UTC(2026, 0, 1, 0, 0, clock++)).toISOString();
  return {
    agentId: 'agent-a',
    sessionId: 's1',
    turnId,
    itemId,
    kind: itemId === 'turn' ? 'turn' : 'tool-activity',
    revision: 1,
    status: itemId === 'turn' ? 'running' : 'completed',
    title: '',
    text: '',
    commandId: null,
    roomId: 'room-1',
    threadId: null,
    messageId: `m-${turnId}`,
    occurredAt: at,
    createdAt: at,
    updatedAt: at,
    ...extra,
  };
}

function approval(turnId: string, extra: Partial<ChatApproval> = {}): ChatApproval {
  return {
    agentId: 'agent-a',
    sessionId: 's1',
    requestId: `req-${turnId}`,
    turnId,
    kind: 'approval',
    roomId: 'room-1',
    threadId: null,
    title: 'Run tests?',
    detail: null,
    options: [{ id: 'yes', label: 'Yes', decision: 'accept' }],
    questions: [],
    state: 'open',
    expiresAt: null,
    answer: null,
    answers: null,
    answeredBy: null,
    answeredAt: null,
    ...extra,
  };
}

function turnOf(items: ChatActivityItem[], status: TurnActivity['status']): TurnActivity {
  return {
    sessionId: 's1',
    turnId: 't1',
    status,
    roomId: 'room-1',
    messageId: 'm1',
    items,
    requests: [],
  };
}

describe('placeTurns', () => {
  const said = (messageId: string, agentId: string | null): ChatMessage =>
    ({
      messageId,
      body: messageId,
      sender: { kind: agentId ? 'agent' : 'human', agentId, clientId: agentId ?? 'me' },
    }) as unknown as ChatMessage;
  const turn = (turnId: string, status: TurnActivity['status'] = 'completed'): TurnActivity => ({
    sessionId: 's1',
    turnId,
    status,
    roomId: 'room-1',
    messageId: null,
    items: [],
    requests: [],
  });
  const ids = (placed: Map<string, TurnActivity[]>) =>
    Object.fromEntries([...placed].map(([at, turns]) => [at, turns.map((each) => each.turnId)]));

  it('shows a turn under the message that started it', () => {
    const messages = [said('q1', null), said('r1', 'helper'), said('q2', null)];
    const bound = new Map([
      ['q1', turn('t1')],
      ['q2', turn('t2', 'running')],
    ]);
    expect(ids(placeTurns(messages, 'helper', bound))).toEqual({ q1: ['t1'], q2: ['t2'] });
  });

  it('shows a queued turn under the reply to the turn it waited for', () => {
    const bound = new Map([
      ['q1', turn('t1', 'running')],
      ['q2', turn('t2', 'queued')],
    ]);
    expect(ids(placeTurns([said('q1', null), said('q2', null)], 'helper', bound))).toEqual({
      q1: ['t1'],
      q2: ['t2'],
    });
    const replied = [said('q1', null), said('q2', null), said('r1', 'helper')];
    expect(ids(placeTurns(replied, 'helper', bound))).toEqual({ q1: ['t1'], r1: ['t2'] });
  });

  it('chains turns queued one after another under each reply in turn', () => {
    const messages = [
      said('q1', null),
      said('q2', null),
      said('q3', null),
      said('r1', 'helper'),
      said('other', 'reviewer'),
      said('r2', 'helper'),
    ];
    const bound = new Map([
      ['q1', turn('t1')],
      ['q2', turn('t2')],
      ['q3', turn('t3', 'running')],
    ]);
    expect(ids(placeTurns(messages, 'helper', bound))).toEqual({
      q1: ['t1'],
      r1: ['t2'],
      r2: ['t3'],
    });
  });

  it('does not wait on a reply from a turn that ended with an error', () => {
    const messages = [said('q1', null), said('q2', null), said('r2', 'helper')];
    const bound = new Map([
      ['q1', turn('t1', 'error')],
      ['q2', turn('t2')],
    ]);
    expect(ids(placeTurns(messages, 'helper', bound))).toEqual({ q1: ['t1'], q2: ['t2'] });
  });
});

describe('foldTurnEndNotices', () => {
  const said = (messageId: string, agentId: string | null, body = messageId): ChatMessage =>
    ({
      messageId,
      body,
      sender: { kind: agentId ? 'agent' : 'human', agentId, clientId: agentId ?? 'me' },
    }) as unknown as ChatMessage;
  const turn = (turnId: string, status: TurnActivity['status']): TurnActivity => ({
    sessionId: 's1',
    turnId,
    status,
    roomId: 'room-1',
    messageId: null,
    items: [],
    requests: [],
  });
  const interrupted = 'I finished without replying. The turn was interrupted: Claude turn ended';

  it("folds a notice into the agent's last turn when that turn shows the same ending", () => {
    const messages = [
      said('q1', null),
      said('q2', null),
      said('r1', 'helper'),
      said('n2', 'helper', interrupted),
    ];
    const bound = new Map([
      ['q1', turn('t1', 'completed')],
      ['q2', turn('t2', 'interrupted')],
    ]);
    expect(foldTurnEndNotices(messages, 'helper', bound)).toEqual(new Map([['n2', 't2']]));
  });

  it('folds the notice of a stopped turn that a queued turn followed', () => {
    const messages = [
      said('what means second', null),
      said('actually', null),
      said('n1', 'helper', 'I finished without replying. The turn was interrupted: error'),
    ];
    const bound = new Map([
      ['what means second', turn('t1', 'interrupted')],
      ['actually', turn('t2', 'running')],
    ]);
    expect(foldTurnEndNotices(messages, 'helper', bound)).toEqual(new Map([['n1', 't1']]));
  });

  it('gives each stopped turn one notice at most', () => {
    const messages = [
      said('q1', null),
      said('n1', 'helper', interrupted),
      said('q2', null),
      said('n2', 'helper', interrupted),
      said('n3', 'helper', interrupted),
    ];
    const bound = new Map([
      ['q1', turn('t1', 'interrupted')],
      ['q2', turn('t2', 'interrupted')],
    ]);
    expect(foldTurnEndNotices(messages, 'helper', bound)).toEqual(
      new Map([
        ['n1', 't1'],
        ['n2', 't2'],
      ])
    );
  });

  it('keeps a notice whose turn shows no such ending, or is not known', () => {
    const messages = [said('q1', null), said('n1', 'helper', interrupted)];
    expect(
      foldTurnEndNotices(messages, 'helper', new Map([['q1', turn('t1', 'running')]]))
    ).toEqual(new Map());
    expect(foldTurnEndNotices(messages, 'helper', new Map())).toEqual(new Map());
    expect(
      foldTurnEndNotices(messages, 'reviewer', new Map([['q1', turn('t1', 'interrupted')]]))
    ).toEqual(new Map());
  });

  it('does not take a notice as the reply a queued turn waits for', () => {
    const messages = [
      said('q1', null),
      said('q2', null),
      said('n1', 'helper', 'I finished without replying.'),
      said('r2', 'helper'),
    ];
    const bound = new Map([
      ['q1', turn('t1', 'completed')],
      ['q2', turn('t2', 'running')],
    ]);
    expect([...placeTurns(messages, 'helper', bound).keys()]).toEqual(['q1', 'r2']);
  });
});

describe('bindTurns', () => {
  it('joins each turn to the room message its rows name, with its steps and requests', () => {
    const turns = groupTurns(
      [
        row('t1', 'turn', { status: 'completed' }),
        row('t1', 'grep', { title: 'grep' }),
        row('t1', 'reply', { kind: 'assistant-message', text: 'done' }),
        row('t2', 'turn'),
        row('t3', 'turn', { roomId: 'room-2' }),
        row('t4', 'turn', { messageId: null, commandId: 'cmd' }),
        row('t5', 'orphan'),
      ],
      [approval('t2')]
    );
    const bound = bindTurns(turns, 'room-1');
    expect([...bound.keys()]).toEqual(['m-t1', 'm-t2']);
    expect(bound.get('m-t1')!.items.map((each) => each.kind)).toEqual([
      'tool-activity',
      'assistant-message',
    ]);
    expect(bound.get('m-t2')!.requests.map((each) => each.requestId)).toEqual(['req-t2']);
    expect(isThinking(bound.get('m-t2')!)).toBe(true);
    expect(isThinking(bound.get('m-t1')!)).toBe(false);
  });

  it('keeps a turn thinking while it has written text but run no tool', () => {
    const turn = turnOf(
      [row('t1', 'draft', { kind: 'assistant-message', text: 'draft' })],
      'running'
    );
    expect(isThinking(turn)).toBe(true);
    expect(isThinking({ ...turn, items: [row('t1', 'tool')] })).toBe(false);
  });

  it("shows tools only, with Switch's own tools set apart", () => {
    const turn = turnOf(
      [
        row('t1', 'a', { title: 'mcp__switch__read_context' }),
        row('t1', 'b', { title: 'ls -la' }),
        row('t1', 'c', { kind: 'assistant-message', text: 'the answer' }),
        row('t1', 'd', { title: 'mcp__switch__post_message' }),
      ],
      'completed'
    );
    const { work, switchActions } = turnTools(turn);
    expect(work.map((each) => each.title)).toEqual(['ls -la']);
    expect(switchActions.map((each) => each.title)).toEqual([
      'mcp__switch__read_context',
      'mcp__switch__post_message',
    ]);
  });

  it('shows an unfinished tool of an interrupted turn as failed', () => {
    const tool = row('t', 'tool', { status: 'in-progress' });
    expect(toolState(tool, 'running')).toBe('running');
    expect(toolState(tool, 'interrupted')).toBe('failed');
    expect(toolState({ ...tool, status: 'completed' }, 'running')).toBe('done');
  });
});

function rpcError(code: string, message: string, data: Record<string, unknown>): RpcError {
  return new RpcError({ code, message, data } as unknown as ConstructorParameters<
    typeof RpcError
  >[0]);
}

function fakeApi(snapshots: RoomActivity[]) {
  const reads: string[] = [];
  const controls: unknown[] = [];
  const api: ActivityApi = {
    resolve: async () => ({
      kind: 'unavailable',
      reason: 'not-on-this-machine',
      message: 'Activity not available on this machine.',
    }),
    reasoning: async () => null,
    watchPlacements: () => () => {},
    roomActivity: async (_server, roomId) => {
      reads.push(roomId);
      return snapshots.shift() ?? { items: [], approvals: [] };
    },
    control: async (input) => {
      controls.push(input);
      return 'cmd-1';
    },
    answerApproval: async (input) =>
      approval('t1', { requestId: input.requestId, state: 'answered', answer: 'yes' }),
  };
  return { api, reads, controls };
}

describe('AgentActivities', () => {
  it('reads one snapshot for the agents of a room and keeps them apart', async () => {
    const { api, reads } = fakeApi([
      {
        items: [row('ta', 'turn'), row('tb', 'turn', { agentId: 'agent-b', status: 'completed' })],
        approvals: [],
      },
    ]);
    const activities = new AgentActivities(api);
    const a = activities.acquire('server', 'tenant', 'room-1', 'agent-a');
    const b = activities.acquire('server', 'tenant', 'room-1', 'agent-b');
    await vi.waitFor(() => expect(b.turns().size).toBe(1));
    expect(reads).toEqual(['room-1']);
    expect(a.working).toBe(true);
    expect(a.runningTurn?.turnId).toBe('ta');
    expect(b.working).toBe(false);
    activities.release(a);
    activities.release(b);
  });

  it('merges live rows with the snapshot by revision, dropping stale ones', async () => {
    const snapshotTool = row('t1', 'tool', { revision: 5, title: 'from snapshot' });
    const { api } = fakeApi([{ items: [row('t1', 'turn'), snapshotTool], approvals: [] }]);
    const activities = new AgentActivities(api);
    const activity = activities.acquire('server', null, 'room-1', 'agent-a');
    // A newer row arrives over the feed before the snapshot is read.
    activities.applyItem('server', { ...snapshotTool, revision: 7, title: 'live' });
    await vi.waitFor(() => expect(activity.turns().size).toBe(1));
    expect(activity.turns().get('m-t1')!.items[0].title).toBe('live');
    activities.applyItem('server', { ...snapshotTool, revision: 7, title: 'replayed' });
    activities.applyItem('server', { ...snapshotTool, revision: 6, title: 'stale' });
    expect(activity.turns().get('m-t1')!.items[0].title).toBe('live');
    activities.applyItem('server', { ...snapshotTool, revision: 8, title: 'newer' });
    expect(activity.turns().get('m-t1')!.items[0].title).toBe('newer');
    activities.applyItem('server', row('t1', 'other-room', { roomId: 'room-2' }));
    expect(activity.turns().get('m-t1')!.items).toHaveLength(1);
    activities.release(activity);
  });

  it('reads every shown room again on resync, and says when a read fails', async () => {
    const { api, reads } = fakeApi([
      { items: [], approvals: [] },
      { items: [row('t1', 'turn', { status: 'completed' })], approvals: [] },
    ]);
    const activities = new AgentActivities(api);
    const activity = activities.acquire('server', null, 'room-1', 'agent-a');
    await vi.waitFor(() => expect(reads).toEqual(['room-1']));
    activities.resync('server');
    activities.resync('other-server');
    await vi.waitFor(() => expect(activity.turns().size).toBe(1));
    expect(reads).toEqual(['room-1', 'room-1']);
    api.roomActivity = async () => {
      throw new Error('Switch did not answer.');
    };
    await activities.loadRoom('server', 'room-1');
    expect(activity.feedError).toContain('Switch did not answer.');
    activities.release(activity);
  });

  it('never reopens an answered request from an older copy', async () => {
    const { api } = fakeApi([]);
    const activities = new AgentActivities(api);
    const activity = activities.acquire('server', null, 'room-1', 'agent-a');
    await activities.loadRoom('server', 'room-1');
    activities.applyItem('server', row('t1', 'turn'));
    activities.applyApproval('server', approval('t1'));
    await activity.answer(approval('t1'), { answer: 'yes' });
    activities.applyApproval('server', approval('t1'));
    expect(activity.turns().get('m-t1')!.requests[0]).toMatchObject({
      state: 'answered',
      answer: 'yes',
    });
    activities.release(activity);
  });

  it('keeps a settled request settled when a resync snapshot still has it open', async () => {
    const { api } = fakeApi([
      { items: [row('t1', 'turn')], approvals: [] },
      { items: [row('t1', 'turn')], approvals: [approval('t1'), approval('t2')] },
    ]);
    const activities = new AgentActivities(api);
    const activity = activities.acquire('server', null, 'room-1', 'agent-a');
    await vi.waitFor(() => expect(activity.turns().size).toBe(1));
    activities.applyApproval('server', approval('t1', { state: 'expired' }));
    await activities.loadRoom('server', 'room-1');
    expect(activity.turns().get('m-t1')!.requests[0].state).toBe('expired');
    expect(activity.approvals.size).toBe(2);
    activities.applyApproval('server', approval('t1', { state: 'closed' }));
    expect(activity.turns().get('m-t1')!.requests[0].state).toBe('closed');
    activities.release(activity);
  });

  it('posts Stop to the room and holds its command id as requested', async () => {
    const { api, controls } = fakeApi([]);
    const activities = new AgentActivities(api);
    const activity = activities.acquire('server', null, 'room-1', 'agent-a');
    await activity.control('interrupt');
    expect(controls).toEqual([
      {
        serverId: 'server',
        roomId: 'room-1',
        requestId: activity.controls[0].requestId,
        agentId: 'agent-a',
        command: 'interrupt',
      },
    ]);
    expect(activity.controls[0]).toMatchObject({ state: 'requested', commandId: 'cmd-1' });
    api.control = async () => {
      throw rpcError('ChatApiError', 'That agent is not in this chat.', {
        apiCode: 'NOT_A_MEMBER',
      });
    };
    await activity.control('reset');
    expect(activity.controls[1]).toMatchObject({ state: 'failed' });
    expect(activity.controls[1].error).toContain('That agent is not in this chat.');
    activities.release(activity);
  });

  it('keeps the request id of a command whose answer was lost until a retry settles it', async () => {
    const { api, controls } = fakeApi([]);
    const activities = new AgentActivities(api);
    const activity = activities.acquire('server', null, 'room-1', 'agent-a');
    const sent = () => (controls as { requestId: string }[]).map((input) => input.requestId);
    api.control = async (input) => {
      controls.push(input);
      throw rpcError('GatewayError', 'socket hang up', { kind: 'network' });
    };
    await activity.control('reset');
    expect(activity.controls[0]).toMatchObject({ state: 'unknown' });
    // A second click, the Retry button and a feed reconnect all reuse the request id.
    await activity.control('reset');
    await activity.retryControl(activity.controls[0].requestId);
    activity.dismissControl(activity.controls[0].requestId);
    expect(activity.controls).toHaveLength(1);
    api.control = async (input) => {
      controls.push(input);
      return 'cmd-1';
    };
    activities.resync('server');
    await vi.waitFor(() => expect(activity.controls[0]).toMatchObject({ state: 'requested' }));
    expect(new Set(sent()).size).toBe(1);
    expect(sent()).toHaveLength(4);
    // Settled: the next Reset is a new request.
    await activity.control('reset');
    expect(new Set(sent()).size).toBe(2);
    activities.release(activity);
  });

  it('keeps the request id of a lost command across leaving and reopening the chat', async () => {
    const { api, controls } = fakeApi([]);
    const activities = new AgentActivities(api);
    const sent = () => (controls as { requestId: string }[]).map((input) => input.requestId);
    api.control = async (input) => {
      controls.push(input);
      throw rpcError('GatewayError', 'socket hang up', { kind: 'network' });
    };
    const first = activities.acquire('server', null, 'room-1', 'agent-a');
    await first.control('reset');
    activities.release(first);
    const reopened = activities.acquire('server', null, 'room-1', 'agent-a');
    expect(reopened.controls[0]).toMatchObject({ state: 'unknown' });
    await reopened.control('reset');
    expect(new Set(sent()).size).toBe(1);
    activities.release(reopened);
  });

  it('keeps the request id of a command still sending when the chat closes', async () => {
    const { api, controls } = fakeApi([]);
    const activities = new AgentActivities(api);
    const sent = () => (controls as { requestId: string }[]).map((input) => input.requestId);
    let fail!: (error: unknown) => void;
    api.control = (input) => {
      controls.push(input);
      return new Promise((_resolve, reject) => (fail = reject));
    };
    const first = activities.acquire('server', null, 'room-1', 'agent-a');
    const pending = first.control('reset');
    activities.release(first);
    fail(rpcError('GatewayError', 'socket hang up', { kind: 'network' }));
    await pending;
    const reopened = activities.acquire('server', null, 'room-1', 'agent-a');
    expect(reopened.controls[0]).toMatchObject({ state: 'unknown' });
    api.control = async (input) => {
      controls.push(input);
      return 'cmd-1';
    };
    await reopened.control('reset');
    expect(new Set(sent()).size).toBe(1);
    activities.release(reopened);
  });

  it('drops rows and settled requests a snapshot no longer has, keeping live ones from during the read', async () => {
    const { api } = fakeApi([
      { items: [row('t1', 'turn')], approvals: [approval('t1', { state: 'answered' })] },
    ]);
    const activities = new AgentActivities(api);
    const activity = activities.acquire('server', null, 'room-1', 'agent-a');
    await vi.waitFor(() => expect(activity.working).toBe(true));
    expect(activity.approvals.size).toBe(1);
    let release!: (snapshot: RoomActivity) => void;
    api.roomActivity = () => new Promise((resolve) => (release = resolve));
    const load = activities.loadRoom('server', 'room-1');
    // Arrives over the live feed while the snapshot is read; the snapshot predates it.
    activities.applyItem('server', row('t2', 'turn'));
    activities.applyApproval('server', approval('t2'));
    release({ items: [], approvals: [] });
    await load;
    expect(activity.allTurns.map((turn) => turn.turnId)).toEqual(['t2']);
    expect([...activity.approvals.values()].map((each) => each.turnId)).toEqual(['t2']);
    activities.release(activity);
  });

  it('says the activity feed is down until it is live again', () => {
    const activities = new AgentActivities(fakeApi([]).api);
    activities.feedState('server', 'offline', 'The server closed the activity feed.');
    expect(activities.feedDown.get('server')).toBe('The server closed the activity feed.');
    activities.feedState('server', 'live', null);
    expect(activities.feedDown.has('server')).toBe(false);
  });

  it('reads reasoning and tool details from a local host for its own session only', async () => {
    const tool = {
      itemId: '["t1","tool"]',
      type: 'tool_call',
      toolName: 'Read',
      input: { file_path: '/a.ts' },
      output: 'x',
      truncated: false,
      exitCode: null,
    };
    const asked: string[][] = [];
    const { api } = fakeApi([]);
    api.resolve = async () => ({
      kind: 'session',
      target: 'local',
      hostAgentKey: 'console-a',
      sessionId: 's1',
    });
    api.reasoning = async (_key, _session, turnIds) => {
      asked.push(turnIds ?? []);
      return { epoch: 'e1', turns: [], tools: [{ turnId: 't1', tools: [tool] }] };
    };
    const activities = new AgentActivities(api);
    const activity = activities.acquire('server', null, 'room-1', 'agent-a');
    await vi.waitFor(() => expect(activity.target?.kind).toBe('session'));
    await activity.readReasoning([
      { ...turnOf([], 'completed'), turnId: 't1' },
      { ...turnOf([], 'completed'), turnId: 't0', sessionId: 'older-session' },
    ]);
    expect(asked).toEqual([['t1']]);
    expect(activity.toolDetails.get(tool.itemId)).toEqual(tool);
    activities.release(activity);
  });
});
