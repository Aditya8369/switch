import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CONTROL_FILE,
  type ControlContext,
  serveControl,
  type SessionLinks,
  sharedSessionRoot,
  WatcherControl,
} from '@switch-console/agent-providers';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { silentLogger } from './log';
import {
  type LocalControl,
  PAGE_BYTES,
  readControlFile,
  RelayControl,
  type RelayControlDeps,
} from './relay-control';
import type { AgentControlFrame, ControlPushBody, ControlReply } from './schemas';

const AGENT = 'agent-1';

type Posted = { path: string; body: unknown };

let posts: Posted[];
let pushAnswers: unknown[];
let controls: RelayControl[];
let roots: string[];
let relayIds: number;

beforeEach(() => {
  posts = [];
  pushAnswers = [];
  controls = [];
  roots = [];
  relayIds = 0;
});

afterEach(async () => {
  for (const control of controls) control.close();
  for (const root of roots) await rm(root, { recursive: true, force: true });
});

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'relay-control-'));
  roots.push(root);
  return root;
}

function relayControl(overrides: Partial<RelayControlDeps>): RelayControl {
  const control = new RelayControl({
    post: async (path, body) => {
      posts.push({ path, body });
      return path === '/control/push' ? (pushAnswers.shift() ?? {}) : null;
    },
    assigned: () => true,
    controlFile: () => join(tmpdir(), 'no-such-control-file.json'),
    localControl: () => null,
    log: silentLogger,
    now: Date.now,
    timing: {
      pushBatchMs: 30,
      pushBatchBytes: 64 * 1024,
      reconnectMs: 30,
      connectTimeoutMs: 1_000,
    },
    ...overrides,
  });
  controls.push(control);
  return control;
}

function frame(message: unknown, deadlineMs = Date.now() + 5_000): AgentControlFrame {
  return { relay_id: `relay-${++relayIds}`, agent_id: AGENT, message, deadline_ms: deadlineMs };
}

/** Sends a relay and resolves Switch's reply to it. */
async function relay(control: RelayControl, message: unknown, deadlineMs?: number) {
  const sent = frame(message, deadlineMs);
  control.handle(sent);
  return replyTo(sent.relay_id);
}

async function replyTo(relayId: string): Promise<ControlReply> {
  const path = `/control/${relayId}`;
  await vi.waitFor(() => expect(posts.some((post) => post.path === path)).toBe(true));
  return posts.find((post) => post.path === path)!.body as ControlReply;
}

function pushes(): ControlPushBody[] {
  return posts
    .filter((post) => post.path === '/control/push')
    .map((post) => post.body as ControlPushBody);
}

function failed(reply: ControlReply): string {
  expect(reply.ok).toBe(false);
  return (reply as { error: { code: string } }).error.code;
}

/** The session links of a sidecar, as far as a subscription reaches them. */
function fakeLinks(answer?: (request: unknown) => unknown) {
  const listeners = new Map<string, Set<(event: unknown) => void>>();
  const failures = new Set<(root: string, failure: string) => void>();
  const roots = new Map<string, string>();
  const links = {
    subscribe: (root: string, listener: (event: unknown) => void) => {
      let set = listeners.get(root);
      if (!set) listeners.set(root, (set = new Set()));
      set.add(listener);
      return () => set.delete(listener);
    },
    onFailure: (listener: (root: string, failure: string) => void) => {
      failures.add(listener);
      return () => failures.delete(listener);
    },
    onReady: () => () => {},
    failure: () => null,
    dispatch: async (_root: string, request: unknown, _wait: number, dispatching: () => void) => {
      dispatching();
      if (answer) return answer(request);
      return { throughSequence: 3, session: { epoch: 'e1' }, request };
    },
  };
  return {
    links: links as unknown as SessionLinks,
    roots,
    subscribers: () => [...listeners.values()].reduce((total, set) => total + set.size, 0),
    emit: (event: unknown) => {
      for (const set of listeners.values()) for (const listener of set) listener(event);
    },
    fail: (failure: string) => {
      for (const root of listeners.keys()) for (const listener of failures) listener(root, failure);
    },
  };
}

const sessionEvent = (sequence: number) => ({
  contractVersion: 1,
  eventId: `event-${sequence}`,
  sessionId: 's1',
  sequence,
  occurredAt: '2026-09-24T12:00:00.000Z',
  body: { type: 'notice', level: 'info', code: 'X', message: 'hi' },
});

/** A real control port, as an agent's host serves it. */
async function sidecar(root: string, links = fakeLinks()) {
  const watcher = new WatcherControl();
  const stop = new AbortController();
  const context: ControlContext = {
    agentId: AGENT,
    links: links.links,
    ensure: async () => null,
    watcher,
    transfers: {} as ControlContext['transfers'],
  };
  const serving = serveControl(root, context, stop.signal);
  await vi.waitFor(async () =>
    expect(await readFile(join(root, CONTROL_FILE), 'utf8')).toBeTruthy()
  );
  return { links, watcher, stop: () => (stop.abort(), serving) };
}

describe('relaying to an agent’s host', () => {
  it('refuses what only the watcher sends, reasoning, and what it cannot read', async () => {
    const control = relayControl({});
    const ensure = { ensure: { config: {}, resuming: false, restart: false } };
    expect(failed(await relay(control, ensure))).toBe('refused_message');
    const handoff = { sequence: 1, roomId: 'r', messageId: 'm', event: {} };
    const room = { sessionId: 's1', request: { type: 'room', handoff } };
    expect(failed(await relay(control, room))).toBe('refused_message');
    const reasoning = { sessionId: 's1', request: { type: 'reasoning', turnIds: null } };
    expect(failed(await relay(control, reasoning))).toBe('refused_message');
    const riding = { health: true, reasoning: { sessionId: 's1', turnIds: null } };
    expect(failed(await relay(control, riding))).toBe('refused_message');
    expect(failed(await relay(control, { nonsense: 1 }))).toBe('refused_message');
  });

  it('answers not_assigned and agent_not_running for an agent it cannot reach', async () => {
    let assigned = false;
    const control = relayControl({ assigned: () => assigned });
    expect(failed(await relay(control, { health: true }))).toBe('not_assigned');
    assigned = true;
    expect(failed(await relay(control, { health: true }))).toBe('agent_not_running');
  });

  it('answers relay_timeout without asking the host once the deadline has passed', async () => {
    const control = relayControl({});
    expect(failed(await relay(control, { health: true }, Date.now() - 1))).toBe('relay_timeout');
  });

  it('answers relay_timeout when the host does not answer before the deadline', async () => {
    const root = await tempRoot();
    const host = await sidecar(
      root,
      fakeLinks(() => new Promise<unknown>(() => {}))
    );
    const control = relayControl({ controlFile: () => join(root, CONTROL_FILE) });
    const started = Date.now();
    const snapshot = { sessionId: 's1', request: { type: 'snapshot' } };
    const reply = await relay(control, snapshot, Date.now() + 300);
    expect(failed(reply)).toBe('relay_timeout');
    expect(Date.now() - started).toBeLessThan(2_000);
    await host.stop();
  });

  it('abandons a relay cancelled before it reached the agent’s host', async () => {
    const root = await tempRoot();
    let sent = false;
    const host = await sidecar(
      root,
      fakeLinks(() => {
        sent = true;
        return null;
      })
    );
    const control = relayControl({ controlFile: () => join(root, CONTROL_FILE) });
    const sentFrame = frame({
      sessionId: 's1',
      request: { type: 'command', command: {}, requesterName: null },
    });
    control.handle(sentFrame);
    control.cancel({ relay_id: sentFrame.relay_id });
    expect(failed(await replyTo(sentFrame.relay_id))).toBe('relay_abandoned');
    expect(sent).toBe(false);
    await host.stop();
  });

  it('pages an answer too large for one reply', async () => {
    const big = { sessions: ['x'.repeat(2 * PAGE_BYTES)] };
    const root = await tempRoot();
    const host = await sidecar(
      root,
      fakeLinks(() => big)
    );
    const control = relayControl({ controlFile: () => join(root, CONTROL_FILE) });
    const first = (await relay(control, { sessionId: 's1', request: { type: 'snapshot' } })) as {
      ok: true;
      result: {
        snapshotId: string;
        pageCount: number;
        bytes: number;
        sha256: string;
        page: { index: number; data: string };
      };
    };
    expect(first.ok).toBe(true);
    const { snapshotId, pageCount, sha256 } = first.result;
    expect(pageCount).toBe(3);
    const parts = [Buffer.from(first.result.page.data, 'base64')];
    for (let index = 1; index < pageCount; index++) {
      const next = (await relay(control, { page: { snapshotId, index } })) as {
        ok: true;
        result: { snapshotId: string; page: { index: number; data: string } };
      };
      expect(next.result.page.index).toBe(index);
      parts.push(Buffer.from(next.result.page.data, 'base64'));
    }
    const whole = Buffer.concat(parts);
    expect(whole.byteLength).toBe(first.result.bytes);
    expect(createHash('sha256').update(whole).digest('hex')).toBe(sha256);
    expect(JSON.parse(whole.toString('utf8'))).toEqual(big);
    expect(failed(await relay(control, { page: { snapshotId, index: 3 } }))).toBe('invalid_page');
    expect(failed(await relay(control, { page: { snapshotId: 'gone', index: 1 } }))).toBe(
      'snapshot_expired'
    );
    await host.stop();
  });

  it('batches a subscription’s pushes, numbered one after another', async () => {
    const root = await tempRoot();
    const host = await sidecar(root);
    const control = relayControl({ controlFile: () => join(root, CONTROL_FILE) });
    expect(await relay(control, { subscribe: 's1' })).toEqual({
      ok: true,
      result: { failure: null },
    });
    control.push(AGENT, { sessionId: 's1', event: { n: 1 } as never });
    control.push(AGENT, { sessionId: 's1', event: { n: 2 } as never });
    control.push(AGENT, { sessionId: 's1', failure: 'it crashed' });
    control.push(AGENT, { sessionId: 'not-subscribed', failure: null });
    await vi.waitFor(() => expect(pushes()).toHaveLength(1));
    const [body] = pushes();
    expect(body!.agent_id).toBe(AGENT);
    expect(body!.subscription).toBe('s1');
    const seqs = body!.events.map((event) => event.seq);
    expect(seqs[1]).toBe(seqs[0]! + 1);
    expect(seqs[2]).toBe(seqs[0]! + 2);
    expect(body!.events.map(({ seq: _, ...rest }) => rest)).toEqual([
      { event: { n: 1 } },
      { event: { n: 2 } },
      { failure: 'it crashed' },
    ]);
    control.push(AGENT, { sessionId: 's1', event: { n: 3 } as never });
    await vi.waitFor(() => expect(pushes()).toHaveLength(2));
    expect(pushes()[1]!.events[0]!.seq).toBe(seqs[2]! + 1);
    await host.stop();
  });

  it('pushes at once when a batch reaches its byte limit', async () => {
    const root = await tempRoot();
    const host = await sidecar(root);
    const control = relayControl({
      controlFile: () => join(root, CONTROL_FILE),
      timing: {
        pushBatchMs: 60_000,
        pushBatchBytes: 1024,
        reconnectMs: 30,
        connectTimeoutMs: 1_000,
      },
    });
    await relay(control, { subscribe: 's1' });
    control.push(AGENT, { sessionId: 's1', event: { text: 'y'.repeat(600) } as never });
    expect(pushes()).toHaveLength(0);
    control.push(AGENT, { sessionId: 's1', event: { text: 'y'.repeat(600) } as never });
    await vi.waitFor(() => expect(pushes()).toHaveLength(1));
    expect(pushes()[0]!.events).toHaveLength(2);
    await host.stop();
  });

  it('drops a subscription Switch says it holds no view of', async () => {
    const root = await tempRoot();
    const host = await sidecar(root);
    const control = relayControl({ controlFile: () => join(root, CONTROL_FILE) });
    await relay(control, { subscribe: 's1' });
    expect(host.links.subscribers()).toBe(1);
    pushAnswers.push({ unsubscribe: true });
    control.push(AGENT, { sessionId: 's1', failure: null });
    await vi.waitFor(() => expect(host.links.subscribers()).toBe(0));
    control.push(AGENT, { sessionId: 's1', failure: null });
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(pushes()).toHaveLength(1);
    await host.stop();
  });

  it('answers on the agent’s control port, and pushes what it subscribed to', async () => {
    const root = await tempRoot();
    const host = await sidecar(root);
    const control = relayControl({
      controlFile: () => join(root, CONTROL_FILE),
    });
    const health = (await relay(control, { health: true })) as {
      ok: true;
      result: { state: string };
    };
    expect(health.result.state).toBe('not-running');

    const snapshot = (await relay(control, { sessionId: 's1', request: { type: 'snapshot' } })) as {
      ok: true;
      result: { epoch: string; pageCount: number; page: { data: string } };
    };
    expect(snapshot.result).toMatchObject({ epoch: 'e1', pageCount: 1 });

    expect(await relay(control, { subscribe: 's1' })).toEqual({
      ok: true,
      result: { failure: null },
    });
    expect(await relay(control, { watchHealth: true })).toEqual({ ok: true, result: null });
    host.links.emit(sessionEvent(1));
    host.links.fail('it crashed');
    host.watcher.report({ state: 'connected' });
    await vi.waitFor(() => {
      const bodies = pushes();
      expect(bodies.flatMap((body) => body.events)).toHaveLength(3);
    });
    const session = pushes()
      .filter((body) => body.subscription === 's1')
      .flatMap((body) => body.events);
    expect(session.map(({ seq: _, ...rest }) => rest)).toEqual([
      { event: sessionEvent(1) },
      { failure: 'it crashed' },
    ]);
    const watched = pushes().filter((body) => body.subscription === 'health');
    expect(watched[0]!.events[0]).toMatchObject({ health: { state: 'connected' } });
    await host.stop();
  });

  it('subscribes again on a host that came back, skipping a number', async () => {
    const root = await tempRoot();
    const first = await sidecar(root);
    const control = relayControl({
      controlFile: () => join(root, CONTROL_FILE),
    });
    await relay(control, { subscribe: 's1' });
    first.links.emit(sessionEvent(1));
    await vi.waitFor(() => expect(pushes()).toHaveLength(1));
    const before = pushes()[0]!.events[0]!.seq;
    await first.stop();
    const second = await sidecar(root);
    await vi.waitFor(() => expect(pushes()).toHaveLength(2), { timeout: 3_000 });
    expect(pushes()[1]!.events).toEqual([{ seq: before + 2, failure: null }]);
    second.links.emit(sessionEvent(2));
    await vi.waitFor(() => expect(pushes()).toHaveLength(3));
    expect(pushes()[2]!.events).toEqual([{ seq: before + 3, event: sessionEvent(2) }]);
    await second.stop();
  });

  it('answers agent_not_running when the host has no control port', async () => {
    const root = await tempRoot();
    const control = relayControl({
      controlFile: () => join(root, CONTROL_FILE),
    });
    expect(failed(await relay(control, { health: true }))).toBe('agent_not_running');
  });
});

describe('relaying to an agent host in the controller’s process', () => {
  const OTHER = 'agent-2';

  /** Gives `sessionId` a saved configuration naming `agentId`, as its host's launch writes it. */
  async function savedSession(sessionId: string, agentId: string): Promise<void> {
    const root = sharedSessionRoot(sessionId);
    await mkdir(root, { recursive: true });
    await writeFile(join(root, 'config.json'), JSON.stringify({ session: { sessionId, agentId } }));
  }

  /** Every in-process agent host shares one session registry: `links` serves both agents. */
  async function inProcess() {
    vi.stubEnv('HOME', await tempRoot());
    await savedSession('mine', AGENT);
    await savedSession('theirs', OTHER);
    const dispatched: string[] = [];
    const links = fakeLinks((request) => {
      dispatched.push(JSON.stringify(request));
      return { throughSequence: 1, session: { epoch: 'e1' } };
    });
    const watcher = new WatcherControl();
    let stopped!: () => void;
    let running = true;
    const local: LocalControl = {
      context: {
        agentId: AGENT,
        links: links.links,
        ensure: async () => null,
        watcher,
        transfers: {} as ControlContext['transfers'],
      },
      closed: new Promise<void>((resolve) => (stopped = resolve)),
    };
    const control = relayControl({
      localControl: (agentId) => (agentId === AGENT && running ? local : null),
    });
    const stop = () => {
      running = false;
      stopped();
    };
    return { control, links, watcher, dispatched, stop };
  }

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('answers in the process, with no control port, and pushes what it subscribed to', async () => {
    const host = await inProcess();
    const health = (await relay(host.control, { health: true })) as {
      ok: true;
      result: { state: string };
    };
    expect(health.result.state).toBe('not-running');
    const snapshot = await relay(host.control, {
      sessionId: 'mine',
      request: { type: 'snapshot' },
    });
    expect(snapshot).toMatchObject({ ok: true, result: { epoch: 'e1', pageCount: 1 } });
    expect(await relay(host.control, { subscribe: 'mine' })).toEqual({
      ok: true,
      result: { failure: null },
    });
    expect(await relay(host.control, { watchHealth: true })).toEqual({ ok: true, result: null });
    host.links.emit(sessionEvent(1));
    host.watcher.report({ state: 'connected' });
    await vi.waitFor(() => expect(pushes().flatMap((body) => body.events)).toHaveLength(2));
    expect(pushes().find((body) => body.subscription === 'mine')!.events[0]).toMatchObject({
      event: sessionEvent(1),
    });
    expect(pushes().find((body) => body.subscription === 'health')!.events[0]).toMatchObject({
      health: { state: 'connected' },
    });
  });

  it('never reads or commands a session of another agent', async () => {
    const host = await inProcess();
    const command = { type: 'command', command: {}, requesterName: null };
    for (const message of [
      { sessionId: 'theirs', request: { type: 'snapshot' } },
      { sessionId: 'theirs', request: command },
      { sessionId: 'unknown', request: command },
      { subscribe: 'theirs' },
      { journal: 'theirs' },
      { place: { sessionId: 'theirs', roomId: 'r' } },
      { forget: 'theirs' },
    ])
      expect(failed(await relay(host.control, message))).toBe('not_own_session');
    expect(host.dispatched).toEqual([]);
    expect(host.links.subscribers()).toBe(0);
    expect(await relay(host.control, { sessionId: 'mine', request: command })).toMatchObject({
      ok: true,
    });
    expect(host.dispatched).toHaveLength(1);
  });

  it('falls back to the control port once the agent host stops', async () => {
    const host = await inProcess();
    await relay(host.control, { health: true });
    host.stop();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(failed(await relay(host.control, { health: true }))).toBe('agent_not_running');
  });
});

describe('an agent’s control.json, read as untrusted', () => {
  const token = 'a'.repeat(64);

  it('reads a port and a token', async () => {
    const root = await tempRoot();
    await writeFile(join(root, CONTROL_FILE), JSON.stringify({ port: 40123, token }));
    expect(await readControlFile(join(root, CONTROL_FILE))).toEqual({ port: 40123, token });
  });

  it('refuses a symlink', async () => {
    const root = await tempRoot();
    await writeFile(join(root, 'elsewhere.json'), JSON.stringify({ port: 40123, token }));
    await symlink(join(root, 'elsewhere.json'), join(root, CONTROL_FILE));
    await expect(readControlFile(join(root, CONTROL_FILE))).rejects.toMatchObject({
      code: 'control_file_invalid',
    });
  });

  it('refuses one naming a host, so only loopback is ever reached', async () => {
    const root = await tempRoot();
    await writeFile(
      join(root, CONTROL_FILE),
      JSON.stringify({ host: '192.0.2.10', port: 40123, token })
    );
    await expect(readControlFile(join(root, CONTROL_FILE))).rejects.toMatchObject({
      code: 'control_file_invalid',
    });
  });

  it('refuses an oversized file', async () => {
    const root = await tempRoot();
    await writeFile(
      join(root, CONTROL_FILE),
      JSON.stringify({ port: 40123, token, padding: ' '.repeat(8192) })
    );
    await expect(readControlFile(join(root, CONTROL_FILE))).rejects.toMatchObject({
      code: 'control_file_invalid',
    });
  });

  it('refuses a privileged port, a bad token and a directory', async () => {
    const root = await tempRoot();
    const path = join(root, CONTROL_FILE);
    await writeFile(path, JSON.stringify({ port: 22, token }));
    await expect(readControlFile(path)).rejects.toMatchObject({ code: 'control_file_invalid' });
    await writeFile(path, JSON.stringify({ port: 40123, token: 'short' }));
    await expect(readControlFile(path)).rejects.toMatchObject({ code: 'control_file_invalid' });
    await writeFile(path, 'not json');
    await expect(readControlFile(path)).rejects.toMatchObject({ code: 'control_file_invalid' });
    await expect(readControlFile(root)).rejects.toMatchObject({ code: 'control_file_invalid' });
  });

  it('answers a relay for an agent with a hostile control.json as control_file_invalid', async () => {
    const root = await tempRoot();
    await writeFile(join(root, 'elsewhere.json'), JSON.stringify({ port: 40123, token }));
    await symlink(join(root, 'elsewhere.json'), join(root, CONTROL_FILE));
    const control = relayControl({
      controlFile: () => join(root, CONTROL_FILE),
    });
    expect(failed(await relay(control, { health: true }))).toBe('control_file_invalid');
  });
});
