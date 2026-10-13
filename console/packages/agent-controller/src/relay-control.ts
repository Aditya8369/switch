import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { open, readFile } from 'node:fs/promises';
import { connect } from 'node:net';
import { join } from 'node:path';
import {
  ControlClient,
  type ControlContext,
  ControlError,
  type ControlMessage,
  controlMessageSchema,
  ControlPeer,
  type ControlPush,
  handleControlMessage,
  SessionHostFailedError,
  SessionUnavailableError,
  sharedSessionRoot,
  SidecarConnectionClosedError,
  type WatcherHealth,
} from '@switch-console/agent-providers';
import { z } from 'zod';
import { ControllerApiError } from './api';
import { errorMessage, type Logger } from './log';
import {
  type AgentControlCancelFrame,
  type AgentControlFrame,
  type ControlPushBody,
  controlPushAnswerSchema,
  type ControlPushEvent,
  type ControlReply,
} from './schemas';

/**
 * Console's control messages for this controller's agents, relayed by Switch
 * on the controller stream (`agent.control`), answered with
 * `POST …/control/{relay_id}`, and the live views they open pushed back with
 * `POST …/control/push`.
 *
 * An agent host in a process of its own answers on its loopback control
 * port, found in the `control.json` that host writes. That file is the
 * agent's, so it is read as untrusted. An agent host in this process is
 * answered here, limited to the agent's own sessions: the in-process hosts
 * share one session registry. Starting a session (`ensure`) and reading reasoning are refused:
 * a session is started by the agent's own watcher, and reasoning never leaves
 * this machine.
 */

/** The subscription name a watcher's health is pushed under. */
export const HEALTH_SUBSCRIPTION = 'health';
export const RELAY_REQUEST_LIMIT_BYTES = 2 * 1024 * 1024;
export const RELAY_REPLY_LIMIT_BYTES = 1024 * 1024 + 64 * 1024;
export const RELAY_TIMEOUT_LIMIT_MS = 30_000;
export const REPLY_ERROR_CHARS = 2048;
/** A page's slice; its base64 fits a relay reply. */
export const PAGE_BYTES = 768 * 1024;
export const PAGE_IDLE_MS = 120_000;
const MAX_PINS_PER_AGENT = 4;
const MAX_PINNED_BYTES = 64 * 1024 * 1024;
export const CONTROL_FILE_LIMIT_BYTES = 4096;

export type RelayControlTiming = {
  /** The longest a live update waits to be pushed with others. */
  pushBatchMs: number;
  /** A batch this large is pushed at once. */
  pushBatchBytes: number;
  /** How often a lost connection to an agent's control port is retried while Switch holds a view of it. */
  reconnectMs: number;
  /** How long a control port has to accept the token. */
  connectTimeoutMs: number;
};

export const DEFAULT_RELAY_CONTROL_TIMING: RelayControlTiming = {
  pushBatchMs: 250,
  pushBatchBytes: 64 * 1024,
  reconnectMs: 2_000,
  connectTimeoutMs: 5_000,
};

export type RelayControlDeps = {
  /** POSTs under the controller's management path; resolves the answer's JSON, null when it has none. */
  post: (path: string, body: unknown) => Promise<unknown>;
  /** Whether the agent is assigned to this controller. */
  assigned: (agentId: string) => boolean;
  /** The `control.json` the agent's host writes. */
  controlFile: (agentId: string) => string;
  /** The agent's host when it runs in this process; null when it does not. */
  localControl: (agentId: string) => LocalControl | null;
  log: Logger;
  /** Unix epoch ms, as `deadline_ms` counts. */
  now: () => number;
  timing: RelayControlTiming;
};

export class RelayAbandonedError extends Error {
  constructor() {
    super('The relay was cancelled before it reached the agent’s host.');
    this.name = 'RelayAbandonedError';
  }
}

export class RelayTimeoutError extends Error {
  constructor() {
    super('The agent’s host did not answer before the relay’s deadline.');
    this.name = 'RelayTimeoutError';
  }
}

const controlFileSchema = z.strictObject({
  port: z.number().int().min(1024).max(65535),
  token: z.string().regex(/^[A-Za-z0-9_-]{16,256}$/),
});

/**
 * The port and token in an agent's `control.json`: not followed
 * through a symlink, a regular file of at most `CONTROL_FILE_LIMIT_BYTES`,
 * naming nothing but a port (always on 127.0.0.1) and a token.
 */
export async function readControlFile(path: string): Promise<{ port: number; token: string }> {
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT')
      throw new ControlError('agent_not_running', 'The agent’s host has no control port open.');
    if (code === 'ELOOP' || code === 'EMLINK')
      throw new ControlError('control_file_invalid', `${path} is a symlink; it is not followed.`);
    throw error;
  }
  let text: string;
  try {
    const stat = await handle.stat();
    if (!stat.isFile())
      throw new ControlError('control_file_invalid', `${path} is not a regular file.`);
    if (stat.size > CONTROL_FILE_LIMIT_BYTES)
      throw new ControlError(
        'control_file_invalid',
        `${path} is ${stat.size} bytes, over the ${CONTROL_FILE_LIMIT_BYTES} a control file can be.`
      );
    const buffer = Buffer.alloc(CONTROL_FILE_LIMIT_BYTES + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead > CONTROL_FILE_LIMIT_BYTES)
      throw new ControlError('control_file_invalid', `${path} grew past its limit while read.`);
    text = buffer.subarray(0, bytesRead).toString('utf8');
  } finally {
    await handle.close();
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new ControlError('control_file_invalid', `${path} is not JSON.`);
  }
  const file = controlFileSchema.safeParse(parsed);
  if (!file.success)
    throw new ControlError(
      'control_file_invalid',
      `${path} is not a control file this controller reads: ${file.error.issues[0]?.message ?? 'invalid'}.`
    );
  return file.data;
}

/** How a relay reaches an agent host that runs in this controller's process. */
export type LocalControl = {
  context: ControlContext;
  /** Settles when that agent host stops. */
  closed: Promise<unknown>;
};

/** The session a message names, if it names one. */
function namedSession(message: ControlMessage): string | null {
  if ('request' in message) return message.sessionId;
  if ('subscribe' in message) return message.subscribe;
  if ('place' in message) return message.place.sessionId;
  if ('forget' in message) return message.forget;
  if ('journal' in message) return message.journal;
  if ('reasoning' in message) return message.reasoning.sessionId;
  if ('attachment' in message) return message.attachment.sessionId;
  return null;
}

/** Refuses a session whose saved configuration does not name `agentId` as its agent. */
export async function assertOwnSession(agentId: string, sessionId: string): Promise<void> {
  let owner: unknown = null;
  try {
    const text = await readFile(join(sharedSessionRoot(sessionId), 'config.json'), 'utf8');
    owner = (JSON.parse(text) as { session?: { agentId?: unknown } } | null)?.session?.agentId;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT' && !(error instanceof SyntaxError))
      throw error;
  }
  if (owner !== agentId)
    throw new ControlError(
      'not_own_session',
      `Session ${sessionId} is not a session of agent ${agentId}.`
    );
}

/** An agent host in this process, answered directly; its live views push through `sink`. */
class LocalTransport {
  private readonly peer: ControlPeer;

  constructor(
    readonly local: LocalControl,
    sink: (push: ControlPush) => void
  ) {
    this.peer = new ControlPeer(sink);
  }

  private async handle(message: ControlMessage, dispatching: () => void): Promise<unknown> {
    const sessionId = namedSession(message);
    if (sessionId !== null) await assertOwnSession(this.local.context.agentId, sessionId);
    dispatching();
    return handleControlMessage(this.local.context, this.peer, message, () => {});
  }

  call(message: ControlMessage, dispatching: () => void): Promise<unknown> {
    return this.handle(message, dispatching);
  }

  subscribe(sessionId: string): Promise<unknown> {
    return this.handle({ subscribe: sessionId }, () => {});
  }

  async watchHealth(): Promise<void> {
    await this.handle({ watchHealth: true }, () => {});
  }

  unsubscribe(name: string): void {
    void this.handle(
      name === HEALTH_SUBSCRIPTION ? { watchHealth: false } : { unsubscribe: name },
      () => {}
    );
  }

  close(): void {
    this.peer.close();
  }
}

type Transport = PortTransport | LocalTransport;

/** A connection to an agent's control port; its live views push through `sink`. */
class PortTransport {
  private readonly offs = new Map<string, () => void>();
  private readonly failures = new Map<string, string | null>();

  constructor(
    readonly client: ControlClient,
    private readonly sink: (push: ControlPush) => void
  ) {}

  call(message: ControlMessage, dispatching: () => void): Promise<unknown> {
    dispatching();
    return this.client.send(message);
  }

  async subscribe(sessionId: string): Promise<unknown> {
    if (!this.offs.has(sessionId)) {
      let answered = false;
      const off = await this.client.subscribe(
        sessionId,
        (event) => this.sink({ sessionId, event }),
        (failure) => {
          this.failures.set(sessionId, failure);
          if (answered) this.sink({ sessionId, failure });
          answered = true;
        }
      );
      answered = true;
      this.offs.set(sessionId, off);
    }
    return { failure: this.failures.get(sessionId) ?? null };
  }

  async watchHealth(): Promise<void> {
    if (this.offs.has(HEALTH_SUBSCRIPTION)) return;
    this.offs.set(
      HEALTH_SUBSCRIPTION,
      await this.client.onHealth((health) => this.sink({ health }))
    );
  }

  unsubscribe(name: string): void {
    this.offs.get(name)?.();
    this.offs.delete(name);
    this.failures.delete(name);
  }

  close(): void {
    this.client.close();
  }
}

type Inflight = { agentId: string; cancelled: boolean; dispatched: boolean };

type Outbox = {
  agentId: string;
  subscription: string;
  events: ControlPushEvent[];
  bytes: number;
  timer: ReturnType<typeof setTimeout> | null;
  sending: Promise<void>;
};

const pinnedSnapshotSchema = z.object({
  throughSequence: z.number().int(),
  session: z.object({ epoch: z.string() }),
});

type Pin = { agentId: string; data: Buffer; pageCount: number; touchedAt: number };

/** Relayed answers too large for one reply, serialized once so every page is a slice of the same bytes. */
class RelayPages {
  private readonly pins = new Map<string, Pin>();

  constructor(private readonly now: () => number) {}

  private sweep(): void {
    const now = this.now();
    for (const [snapshotId, pin] of this.pins)
      if (now - pin.touchedAt >= PAGE_IDLE_MS) this.pins.delete(snapshotId);
  }

  pin(agentId: string, value: unknown): unknown {
    this.sweep();
    const data = Buffer.from(JSON.stringify(value ?? null));
    const snapshot = pinnedSnapshotSchema.safeParse(value);
    const pageCount = Math.max(1, Math.ceil(data.byteLength / PAGE_BYTES));
    const snapshotId = randomUUID();
    if (pageCount > 1) {
      const pins = [...this.pins.values()];
      const pinned = pins.reduce((total, pin) => total + pin.data.byteLength, 0);
      const mine = pins.filter((pin) => pin.agentId === agentId).length;
      if (mine >= MAX_PINS_PER_AGENT || pinned + data.byteLength > MAX_PINNED_BYTES)
        throw new ControlError(
          'snapshot_busy',
          'Too many paged answers are pinned; retry shortly.'
        );
      this.pins.set(snapshotId, { agentId, data, pageCount, touchedAt: this.now() });
    }
    return {
      snapshotId,
      epoch: snapshot.success ? snapshot.data.session.epoch : null,
      throughSequence: snapshot.success ? snapshot.data.throughSequence : null,
      bytes: data.byteLength,
      sha256: createHash('sha256').update(data).digest('hex'),
      pageCount,
      page: { index: 0, data: data.subarray(0, PAGE_BYTES).toString('base64') },
    };
  }

  page(agentId: string, snapshotId: string, index: number): unknown {
    this.sweep();
    const pin = this.pins.get(snapshotId);
    if (!pin || pin.agentId !== agentId)
      throw new ControlError('snapshot_expired', 'That paged answer has expired; start over.');
    if (index >= pin.pageCount)
      throw new ControlError('invalid_page', `That answer has ${pin.pageCount} page(s).`);
    pin.touchedAt = this.now();
    const data = pin.data.subarray(index * PAGE_BYTES, (index + 1) * PAGE_BYTES);
    return { snapshotId, page: { index, data: data.toString('base64') } };
  }

  forget(agentId: string): void {
    for (const [snapshotId, pin] of this.pins)
      if (pin.agentId === agentId) this.pins.delete(snapshotId);
  }

  clear(): void {
    this.pins.clear();
  }
}

function isPaged(message: ControlMessage): boolean {
  return (
    ('request' in message && message.request.type === 'snapshot') ||
    'journal' in message ||
    'list' in message
  );
}

export function controlErrorCode(error: unknown): string {
  if (error instanceof ControlError) return error.code;
  if (error instanceof SessionHostFailedError) return 'session_failed';
  if (error instanceof SessionUnavailableError) return 'session_unavailable';
  if (error instanceof RelayAbandonedError) return 'relay_abandoned';
  if (error instanceof RelayTimeoutError) return 'relay_timeout';
  if (error instanceof SidecarConnectionClosedError) return 'agent_unreachable';
  return 'failed';
}

const key = (agentId: string, name: string) => `${agentId}\n${name}`;

export class RelayControl {
  private readonly inflight = new Map<string, Inflight>();
  private readonly ports = new Map<string, Transport>();
  private readonly connecting = new Map<string, Promise<Transport>>();
  /** The subscriptions Switch holds a view of, per agent. */
  private readonly wanted = new Map<string, Set<string>>();
  /** Subscriptions whose transport went away; each skipped a `seq` when it did. */
  private readonly lost = new Set<string>();
  private readonly seqs = new Map<string, number>();
  private readonly outboxes = new Map<string, Outbox>();
  private readonly retries = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly pages: RelayPages;
  private closed = false;

  constructor(private readonly deps: RelayControlDeps) {
    this.pages = new RelayPages(deps.now);
  }

  // -- Relays -----------------------------------------------------------------

  handle(frame: AgentControlFrame): void {
    if (this.closed || this.inflight.has(frame.relay_id)) return;
    const relay: Inflight = { agentId: frame.agent_id, cancelled: false, dispatched: false };
    this.inflight.set(frame.relay_id, relay);
    void this.answer(frame, relay).finally(() => this.inflight.delete(frame.relay_id));
  }

  /** Switch gave up on the relay: one not yet sent to the agent's host is not sent. */
  cancel(frame: AgentControlCancelFrame): void {
    const relay = this.inflight.get(frame.relay_id);
    if (relay) relay.cancelled = true;
  }

  private async answer(frame: AgentControlFrame, relay: Inflight): Promise<void> {
    let reply: ControlReply;
    try {
      const result = await this.withinDeadline(frame, relay);
      reply = { ok: true, result: result ?? null };
      const bytes = Buffer.byteLength(JSON.stringify(reply));
      if (bytes > RELAY_REPLY_LIMIT_BYTES)
        reply = this.failure(
          new ControlError(
            'too_large',
            `The answer is ${bytes} bytes, over the ${RELAY_REPLY_LIMIT_BYTES} a relay reply carries.`
          )
        );
    } catch (error) {
      reply = this.failure(error);
    }
    try {
      await this.deps.post(`/control/${encodeURIComponent(frame.relay_id)}`, reply);
    } catch (error) {
      if (error instanceof ControllerApiError && (error.status === 404 || error.status === 409)) {
        this.deps.log.debug('Switch no longer waits for this relay', {
          relayId: frame.relay_id,
          status: error.status,
        });
        return;
      }
      this.deps.log.warn('Could not answer a relayed control message', {
        relayId: frame.relay_id,
        agentId: frame.agent_id,
        error: errorMessage(error),
      });
    }
  }

  private failure(error: unknown): ControlReply {
    return {
      ok: false,
      error: {
        code: controlErrorCode(error),
        message: errorMessage(error).slice(0, REPLY_ERROR_CHARS),
      },
    };
  }

  private async withinDeadline(frame: AgentControlFrame, relay: Inflight): Promise<unknown> {
    const remaining = Math.min(frame.deadline_ms - this.deps.now(), RELAY_TIMEOUT_LIMIT_MS);
    if (remaining <= 0) throw new RelayTimeoutError();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const expired = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        relay.cancelled = true;
        reject(new RelayTimeoutError());
      }, remaining);
    });
    try {
      return await Promise.race([this.dispatch(frame, relay), expired]);
    } finally {
      clearTimeout(timer);
    }
  }

  private async dispatch(frame: AgentControlFrame, relay: Inflight): Promise<unknown> {
    const agentId = frame.agent_id;
    if (Buffer.byteLength(JSON.stringify(frame.message ?? null)) > RELAY_REQUEST_LIMIT_BYTES)
      throw new ControlError(
        'refused_message',
        `The message is over the ${RELAY_REQUEST_LIMIT_BYTES} bytes a relay carries.`
      );
    const parsed = controlMessageSchema.safeParse(frame.message);
    if (!parsed.success)
      throw new ControlError('refused_message', 'The relayed message is unreadable.');
    const message = parsed.data;
    if ('request' in message && ['room', 'approvals'].includes(message.request.type))
      throw new ControlError('refused_message', 'Only the agent’s watcher sends that message.');
    if ('ensure' in message)
      throw new ControlError('refused_message', 'Only the agent’s watcher starts a session.');
    if ('reasoning' in message || ('request' in message && message.request.type === 'reasoning'))
      throw new ControlError('refused_message', 'Reasoning is not relayed.');
    if (!this.deps.assigned(agentId))
      throw new ControlError(
        'not_assigned',
        `Agent ${agentId} is not assigned to this controller.`
      );
    if ('page' in message)
      return this.pages.page(agentId, message.page.snapshotId, message.page.index);
    const dispatching = () => {
      if (relay.cancelled) throw new RelayAbandonedError();
      relay.dispatched = true;
    };
    if ('subscribe' in message) return this.subscribe(agentId, message.subscribe, dispatching);
    if ('watchHealth' in message)
      return message.watchHealth
        ? this.subscribe(agentId, HEALTH_SUBSCRIPTION, dispatching)
        : this.release(agentId, HEALTH_SUBSCRIPTION, dispatching);
    if ('unsubscribe' in message) return this.release(agentId, message.unsubscribe, dispatching);
    const transport = await this.transport(agentId);
    const value = await transport.call(message, dispatching);
    return isPaged(message) ? this.pages.pin(agentId, value) : value;
  }

  // -- Subscriptions ----------------------------------------------------------

  private async subscribe(
    agentId: string,
    name: string,
    dispatching: () => void
  ): Promise<unknown> {
    const transport = await this.transport(agentId);
    dispatching();
    const answer =
      name === HEALTH_SUBSCRIPTION
        ? await transport.watchHealth().then(() => null)
        : await transport.subscribe(name);
    let names = this.wanted.get(agentId);
    if (!names) {
      names = new Set();
      this.wanted.set(agentId, names);
    }
    names.add(name);
    this.lost.delete(key(agentId, name));
    return answer;
  }

  private release(agentId: string, name: string, dispatching: () => void): null {
    dispatching();
    this.drop(agentId, name);
    return null;
  }

  private drop(agentId: string, name: string): void {
    const names = this.wanted.get(agentId);
    names?.delete(name);
    if (names?.size === 0) this.wanted.delete(agentId);
    this.lost.delete(key(agentId, name));
    this.reachable(agentId)?.unsubscribe(name);
  }

  /**
   * A live update from an agent's host. Pushed in batches per subscription,
   * each update numbered; one for a subscription Switch holds no view of is
   * dropped.
   */
  push(agentId: string, push: ControlPush): void {
    if (this.closed) return;
    const name = 'health' in push ? HEALTH_SUBSCRIPTION : push.sessionId;
    if (!this.wanted.get(agentId)?.has(name)) return;
    const seq = this.nextSeq(agentId, name);
    const event: ControlPushEvent =
      'health' in push
        ? { seq, health: push.health }
        : 'event' in push
          ? { seq, event: push.event }
          : { seq, failure: push.failure };
    const id = key(agentId, name);
    let outbox = this.outboxes.get(id);
    if (!outbox) {
      outbox = {
        agentId,
        subscription: name,
        events: [],
        bytes: 0,
        timer: null,
        sending: Promise.resolve(),
      };
      this.outboxes.set(id, outbox);
    }
    outbox.events.push(event);
    outbox.bytes += Buffer.byteLength(JSON.stringify(event));
    if (outbox.bytes >= this.deps.timing.pushBatchBytes) this.flush(outbox);
    else outbox.timer ??= setTimeout(() => this.flush(outbox), this.deps.timing.pushBatchMs);
  }

  /**
   * Numbers a subscription's updates. The first is the time it was first
   * numbered, in ms, so the numbers keep rising across a controller restart
   * and Switch sees the restart as a gap.
   */
  private nextSeq(agentId: string, name: string): number {
    const id = key(agentId, name);
    const seq = (this.seqs.get(id) ?? this.deps.now()) + 1;
    this.seqs.set(id, seq);
    return seq;
  }

  private flush(outbox: Outbox): void {
    if (outbox.timer) clearTimeout(outbox.timer);
    outbox.timer = null;
    if (!outbox.events.length) return;
    const body: ControlPushBody = {
      agent_id: outbox.agentId,
      subscription: outbox.subscription,
      events: outbox.events,
    };
    outbox.events = [];
    outbox.bytes = 0;
    outbox.sending = outbox.sending.then(() => this.send(body));
  }

  private async send(body: ControlPushBody): Promise<void> {
    if (this.closed) return;
    try {
      const answer = controlPushAnswerSchema.parse(
        (await this.deps.post('/control/push', body)) ?? {}
      );
      if (answer.unsubscribe) {
        this.deps.log.info('Switch holds no view of a subscription any more; dropping it', {
          agentId: body.agent_id,
          subscription: body.subscription,
        });
        this.drop(body.agent_id, body.subscription);
      }
    } catch (error) {
      this.deps.log.warn('Could not push live updates; Switch sees the gap and resyncs', {
        agentId: body.agent_id,
        subscription: body.subscription,
        events: body.events.length,
        error: errorMessage(error),
      });
    }
  }

  /** Pushes everything batched, and waits for it to be sent. */
  async flushAll(): Promise<void> {
    for (const outbox of this.outboxes.values()) this.flush(outbox);
    await Promise.all([...this.outboxes.values()].map((outbox) => outbox.sending));
  }

  // -- Transports -------------------------------------------------------------

  private async transport(agentId: string): Promise<Transport> {
    if (!this.deps.assigned(agentId))
      throw new ControlError(
        'not_assigned',
        `Agent ${agentId} is not assigned to this controller.`
      );
    const open = this.ports.get(agentId);
    const local = this.deps.localControl(agentId);
    if (local) {
      if (open instanceof LocalTransport && open.local === local) return open;
      if (open) this.closeTransport(agentId, open);
      const transport = new LocalTransport(local, (push) => this.push(agentId, push));
      this.ports.set(agentId, transport);
      void local.closed.then(() => this.closeTransport(agentId, transport));
      return transport;
    }
    if (open) return open;
    let connecting = this.connecting.get(agentId);
    if (!connecting) {
      connecting = this.connect(agentId).finally(() => this.connecting.delete(agentId));
      this.connecting.set(agentId, connecting);
    }
    return connecting;
  }

  /** The transport live views are on now, without opening one. */
  private reachable(agentId: string): Transport | null {
    return this.ports.get(agentId) ?? null;
  }

  private async connect(agentId: string): Promise<Transport> {
    const { port, token } = await readControlFile(this.deps.controlFile(agentId));
    if (this.closed) throw new ControlError('agent_unreachable', 'The controller is stopping.');
    const socket = connect({ host: '127.0.0.1', port });
    const client = new ControlClient(socket, token);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        client.ready,
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error('it did not accept the token in time')),
            this.deps.timing.connectTimeoutMs
          );
        }),
      ]);
    } catch (error) {
      client.close();
      throw new ControlError(
        'agent_unreachable',
        `Could not reach the control port of agent ${agentId}: ${errorMessage(error)}`
      );
    } finally {
      clearTimeout(timer);
    }
    const transport = new PortTransport(client, (push) => this.push(agentId, push));
    this.ports.set(agentId, transport);
    client.onClose(() => this.closeTransport(agentId, transport));
    return transport;
  }

  /** The agent's host went away from under `transport`: its live views are opened again once it is back. */
  private closeTransport(agentId: string, transport: Transport): void {
    if (this.ports.get(agentId) !== transport) return;
    this.ports.delete(agentId);
    transport.close();
    this.deps.log.warn('The connection to an agent’s host closed', { agentId });
    this.transportLost(agentId);
    this.resubscribeLater(agentId);
  }

  /** Every live view of the agent is gone: each skips a `seq`, so Switch resyncs once it is back. */
  private transportLost(agentId: string): void {
    for (const name of this.wanted.get(agentId) ?? []) {
      const id = key(agentId, name);
      if (this.lost.has(id)) continue;
      this.lost.add(id);
      this.nextSeq(agentId, name);
    }
  }

  private resubscribeLater(agentId: string): void {
    if (this.closed || this.retries.has(agentId) || !this.wanted.get(agentId)?.size) return;
    this.retries.set(
      agentId,
      setTimeout(() => {
        this.retries.delete(agentId);
        void this.resubscribe(agentId);
      }, this.deps.timing.reconnectMs)
    );
  }

  /** Opens again the live views that were lost, pushing each one's state as it stands. */
  private async resubscribe(agentId: string): Promise<void> {
    const lost = [...(this.wanted.get(agentId) ?? [])].filter((name) =>
      this.lost.has(key(agentId, name))
    );
    if (!lost.length || this.closed) return;
    try {
      const transport = await this.transport(agentId);
      for (const name of lost) {
        if (!this.wanted.get(agentId)?.has(name)) continue;
        if (name === HEALTH_SUBSCRIPTION) {
          await transport.watchHealth();
          this.lost.delete(key(agentId, name));
          const health = await transport.call({ health: true }, () => {});
          this.push(agentId, { health: health as WatcherHealth });
        } else {
          const answer = (await transport.subscribe(name)) as { failure?: string | null } | null;
          this.lost.delete(key(agentId, name));
          this.push(agentId, { sessionId: name, failure: answer?.failure ?? null });
        }
      }
    } catch (error) {
      this.deps.log.debug('Could not open an agent’s live views again yet', {
        agentId,
        error: errorMessage(error),
      });
      if (this.deps.assigned(agentId)) this.resubscribeLater(agentId);
    }
  }

  /** The agent is no longer assigned here. */
  forget(agentId: string): void {
    this.wanted.delete(agentId);
    for (const id of [...this.lost]) if (id.startsWith(`${agentId}\n`)) this.lost.delete(id);
    for (const [id, outbox] of this.outboxes)
      if (outbox.agentId === agentId) {
        if (outbox.timer) clearTimeout(outbox.timer);
        this.outboxes.delete(id);
      }
    const retry = this.retries.get(agentId);
    if (retry) clearTimeout(retry);
    this.retries.delete(agentId);
    const port = this.ports.get(agentId);
    this.ports.delete(agentId);
    port?.close();
    this.pages.forget(agentId);
  }

  close(): void {
    this.closed = true;
    for (const relay of this.inflight.values()) relay.cancelled = true;
    for (const retry of this.retries.values()) clearTimeout(retry);
    this.retries.clear();
    for (const outbox of this.outboxes.values()) if (outbox.timer) clearTimeout(outbox.timer);
    this.outboxes.clear();
    const ports = [...this.ports.values()];
    this.ports.clear();
    for (const port of ports) port.close();
    this.pages.clear();
  }
}
