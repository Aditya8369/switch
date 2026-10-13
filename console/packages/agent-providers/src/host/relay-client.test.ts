import { createHash } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { ServerEvent, Session, Snapshot } from '@switch-console/shared/session-v1';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { RelayClient } from './relay-client';
import { SessionHostFailedError, SessionUnavailableError } from './session-channel';

type Reply = { status: number; body: unknown };
type Relayed = { message: Record<string, unknown>; timeout_ms: number };

const AGENT_BASE = '/management/agents/agent-1/control';

const worker = { launch_revision: null, boot_id: null, generation: 1 };
const ok = (value: unknown): Reply => ({ status: 200, body: { ok: true, value, worker } });
const refused = (status: number, code: string, message = code, extra = {}): Reply => ({
  status,
  body: { ok: false, error: { code, message }, worker, ...extra },
});

let server: Server;
let base: string;
let relayed: Relayed[];
let relayedTo: string[];
let answer: (message: Record<string, unknown>) => Reply;
let streams: { path: string; query: URLSearchParams; response: ServerResponse }[];

beforeEach(async () => {
  relayed = [];
  relayedTo = [];
  streams = [];
  answer = () => refused(500, 'unexpected');
  server = createServer((request: IncomingMessage, response: ServerResponse) => {
    const url = new URL(request.url ?? '/', 'http://relay');
    const streamOf = url.pathname.replace(/\/stream$/, '');
    if (request.method === 'GET' && streamOf !== url.pathname && streamOf === AGENT_BASE) {
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.write(': keepalive\n\n');
      streams.push({ path: url.pathname, query: url.searchParams, response });
      return;
    }
    let body = '';
    request.on('data', (chunk: Buffer) => (body += chunk.toString()));
    request.on('end', () => {
      if (request.method !== 'POST' || url.pathname !== AGENT_BASE) {
        response.writeHead(404, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ detail: 'Managed agent not found.' }));
        return;
      }
      const parsed = JSON.parse(body) as Relayed;
      relayed.push(parsed);
      relayedTo.push(url.pathname);
      const reply = answer(parsed.message);
      response.writeHead(reply.status, { 'content-type': 'application/json' });
      response.end(JSON.stringify(reply.body));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(async () => {
  for (const { response } of streams) response.destroy();
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
});

function client(basePath = AGENT_BASE, retryMs = 2000): RelayClient {
  return new RelayClient(
    (path, init) =>
      fetch(`${base}${path}`, {
        method: init.method,
        headers: { 'content-type': 'application/json' },
        body: init.body === undefined ? undefined : JSON.stringify(init.body),
        signal: init.signal,
      }),
    basePath,
    { retryMs, timeoutMs: 1000 }
  );
}

function frame(index: number, event: string, data: unknown): void {
  streams[index]!.response.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

const session = (sessionId: string): Session => ({
  sessionId,
  agentId: 'agent',
  hostId: 'host',
  epoch: 'epoch-1',
  provider: 'claude',
  status: 'ready',
  connectivity: 'online',
  pendingRequestIds: [],
  capabilities: {
    input: 'queue',
    approvals: true,
    questions: true,
    interrupt: true,
    reset: true,
    compact: false,
    modelChange: false,
    attachmentMimeTypes: ['text/plain'],
  },
});

const snapshot = (text: string): Snapshot => ({
  contractVersion: 1,
  throughSequence: 7,
  session: session('one'),
  turns: [{ type: 'turn.upsert', turnId: 'turn', status: 'completed', commandId: 'command' }],
  items: [
    {
      itemId: 'item',
      turnId: 'turn',
      revision: 1,
      kind: 'assistant-message',
      status: 'completed',
      title: '',
      text,
      attachments: [],
      origin: null,
    },
  ],
  requests: [],
  commandStatuses: [],
  notices: [],
  nextPageToken: null,
});

const event = (sequence: number): ServerEvent => ({
  contractVersion: 1,
  eventId: `event-${sequence}`,
  sessionId: 'one',
  sequence,
  occurredAt: '2026-09-25T12:00:00.000Z',
  body: { type: 'turn.upsert', turnId: 'turn', status: 'running', commandId: 'command' },
});

/** Answers paged the way the worker pages them, `size` bytes a page. */
function pager(value: unknown, size: number) {
  const data = Buffer.from(JSON.stringify(value));
  const pages: Buffer[] = [];
  for (let at = 0; at < data.byteLength; at += size) pages.push(data.subarray(at, at + size));
  let pins = 0;
  const first = () => {
    pins++;
    return ok({
      snapshotId: `snap-${pins}`,
      epoch: 'epoch-1',
      throughSequence: 7,
      bytes: data.byteLength,
      sha256: createHash('sha256').update(data).digest('hex'),
      pageCount: pages.length,
      page: { index: 0, data: pages[0]!.toString('base64') },
    });
  };
  const page = (message: Record<string, unknown>) => {
    const { snapshotId, index } = message.page as { snapshotId: string; index: number };
    return ok({ snapshotId, page: { index, data: pages[index]!.toString('base64') } });
  };
  return { first, page, count: pages.length, pins: () => pins };
}

it('reassembles a paged snapshot and checks it against its digest', async () => {
  const value = snapshot('x'.repeat(5000));
  const pages = pager(value, 1500);
  answer = (message) => ('page' in message ? pages.page(message) : pages.first());
  const result = await client().request('one', { type: 'snapshot' });
  expect(result).toEqual(value);
  expect(pages.count).toBeGreaterThan(3);
  expect(relayed.map((each) => each.message)).toEqual([
    { sessionId: 'one', request: { type: 'snapshot' } },
    ...Array.from({ length: pages.count - 1 }, (_, index) => ({
      page: { snapshotId: 'snap-1', index: index + 1 },
    })),
  ]);
  expect(relayed.every((each) => each.timeout_ms === 1000)).toBe(true);
});

it('refuses a paged answer that does not match its digest', async () => {
  const pages = pager(snapshot('text'), 100);
  answer = (message) => {
    if ('page' in message) return pages.page(message);
    const first = pages.first();
    (first.body as { value: { sha256: string } }).value.sha256 = '0'.repeat(64);
    return first;
  };
  await expect(client().journal('one')).rejects.toThrow(/does not match its digest/);
});

it('asks again while the controller is busy, within its window', async () => {
  const replies = [refused(503, 'controller_busy')];
  answer = () =>
    replies.shift() ??
    ok({ state: 'connected', detail: null, since: '2026-09-25T12:00:00Z', placements: {} });
  expect((await client().health()).state).toBe('connected');
  expect(relayed).toHaveLength(2);

  answer = () => refused(503, 'controller_offline', 'The machine is offline.');
  await expect(client().health()).rejects.toMatchObject({ relayCode: 'controller_offline' });
  expect(relayed).toHaveLength(3);
});

it('never sends a command twice on a timeout', async () => {
  const command = {
    type: 'command' as const,
    command: {
      contractVersion: 1 as const,
      commandId: 'command',
      sessionId: 'one',
      origin: null,
      body: { type: 'interrupt' as const },
    },
  };
  answer = () => refused(504, 'relay_timeout', 'The controller did not answer in time.');
  await expect(client().request('one', command as never)).rejects.toMatchObject({
    relayCode: 'relay_timeout',
    status: 504,
  });
  expect(relayed).toHaveLength(1);
});

it('raises the errors a sidecar raises for a stopped or failed session', async () => {
  const status = { type: 'commandStatus', commandId: 'command' } as never;
  answer = () => refused(200, 'session_unavailable', 'Session one is not running.');
  await expect(client().request('one', status)).rejects.toBeInstanceOf(SessionUnavailableError);

  answer = () => refused(200, 'session_failed', 'The session host failed: out of credits');
  const failed = await client()
    .request('one', status)
    .catch((caught: unknown) => caught);
  expect(failed).toBeInstanceOf(SessionHostFailedError);
  expect((failed as SessionHostFailedError).failure).toBe('out of credits');

  answer = () => refused(400, 'refused_message', 'Console may not send that.');
  await expect(client().request('one', status)).rejects.toMatchObject({
    relayCode: 'refused_message',
  });

  await expect(
    client('/management/agents/elsewhere/control').request('one', status)
  ).rejects.toMatchObject({ relayCode: 'not_found', status: 404 });
});

it('delivers a session’s events once Switch holds the view, and resets it on a resync', async () => {
  const relay = client();
  const events: number[] = [];
  const failures: (string | null)[] = [];
  const onReset = vi.fn();
  const subscribing = relay.subscribe(
    'one',
    (each) => events.push(each.sequence),
    (failure) => failures.push(failure),
    onReset
  );
  await vi.waitFor(() => expect(streams).toHaveLength(1));
  expect(streams[0]!.query.get('subscribe')).toBe('one');
  frame(0, 'worker', worker);
  const off = await subscribing;
  frame(0, 'event', { sessionId: 'one', event: event(8) });
  frame(0, 'failure', { sessionId: 'one', failure: 'out of credits' });
  frame(0, 'event', { sessionId: 'one', event: event(9) });
  await vi.waitFor(() => expect(events).toEqual([8, 9]));
  expect(failures).toEqual(['out of credits']);
  frame(0, 'resync', { sessionId: 'one', reason: 'overflow' });
  frame(0, 'event', { sessionId: 'one', event: event(10) });
  await vi.waitFor(() => expect(onReset).toHaveBeenCalledOnce());
  expect(onReset.mock.calls[0]![0]).toMatch(/overflow/);
  expect(events).toEqual([8, 9]);
  off();
});

it('resets a view when the controller behind it reconnects or the stream ends', async () => {
  const relay = client();
  const onReset = vi.fn();
  const subscribing = relay.subscribe(
    'one',
    () => {},
    () => {},
    onReset
  );
  await vi.waitFor(() => expect(streams).toHaveLength(1));
  frame(0, 'worker', worker);
  frame(0, 'worker', worker);
  await subscribing;
  frame(0, 'worker', { ...worker, generation: 2 });
  await vi.waitFor(() =>
    expect(onReset).toHaveBeenCalledWith('The agent’s controller reconnected.')
  );

  const again = vi.fn();
  const second = relay.subscribe(
    'one',
    () => {},
    () => {},
    again
  );
  await vi.waitFor(() => expect(streams).toHaveLength(2));
  frame(1, 'worker', worker);
  await second;
  streams[1]!.response.end();
  await vi.waitFor(() => expect(again).toHaveBeenCalledOnce());
});

it('refuses a view of an agent Switch will not relay', async () => {
  await expect(
    client('/management/agents/elsewhere/control').subscribe(
      'one',
      () => {},
      () => {},
      () => {}
    )
  ).rejects.toMatchObject({ relayCode: 'not_found' });
});
