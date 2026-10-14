import { createHash } from 'node:crypto';
import {
  serverEventSchema,
  type ServerEvent,
  type Snapshot,
  snapshotSchema,
} from '@switch-console/shared/session-v1';
import { z } from 'zod';
import type { ControlMessage } from './control';
import {
  SessionHostFailedError,
  SessionUnavailableError,
  type SessionRequest,
} from './session-channel';
import { type WatcherHealth, watcherHealthSchema } from './watcher-tools';

/**
 * Console's end of a managed agent's sessions on its controller, relayed
 * through Switch.
 *
 * A controller accepts no inbound connection, so where a sidecar is reached
 * over its loopback control port this goes through the Switch gateway: one
 * `POST <base>` per request, answered by the agent's controller, and one
 * `GET <base>/stream` per live view. The messages are the control
 * vocabulary's (`ControlMessage`), and the methods are `ControlClient`'s, so
 * the callers of either do not tell them apart. Large answers arrive in pages
 * and are put together here.
 *
 * The base is the managed agent's control route
 * (`/management/agents/{id}/control`). Switch refuses to start a session or
 * read reasoning through it.
 */

/** One call to the relay routes; `path` is relative to the gateway and starts with the base path. */
export type RelayFetch = (
  path: string,
  init: { method: 'GET' | 'POST'; body: unknown; signal: AbortSignal }
) => Promise<Response>;

/** A relay that the controller or Switch refused, with the code Console acts on. */
export class RelayError extends Error {
  constructor(
    readonly relayCode: string,
    message: string,
    readonly status: number
  ) {
    super(message);
    this.name = 'RelayError';
  }
}

export class RelayClosedError extends Error {
  constructor(reason: string) {
    super(`The relay to the agent's controller closed: ${reason}`);
    this.name = 'RelayClosedError';
  }
}

/** The longest a relay may wait for the controller, as Switch allows it. */
export const RELAY_TIMEOUT_MS = 30_000;
const PAGED_ATTEMPTS = 3;

/** Nothing was sent to the agent's host: asking again cannot act twice. */
const RETRYABLE = new Set(['controller_busy', 'snapshot_busy']);
const RESTART_PAGED = new Set(['snapshot_expired']);

const replySchema = z.object({
  ok: z.boolean(),
  value: z.unknown().optional(),
  error: z.object({ code: z.string(), message: z.string() }).optional(),
});

const firstPageSchema = z.object({
  snapshotId: z.string().min(1),
  bytes: z.number().int().nonnegative(),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  pageCount: z.number().int().positive(),
  page: z.object({ index: z.literal(0), data: z.string() }),
});
const pageSchema = z.object({
  snapshotId: z.string().min(1),
  page: z.object({ index: z.number().int().positive(), data: z.string() }),
});

const workerFrameSchema = z.object({ generation: z.number().nullable() });
const eventFrameSchema = z.object({ sessionId: z.string(), event: z.unknown() });
const failureFrameSchema = z.object({ sessionId: z.string(), failure: z.string().nullable() });
const resyncFrameSchema = z.object({ sessionId: z.string().nullable(), reason: z.string() });
const errorFrameSchema = z.object({
  sessionId: z.string().nullable(),
  code: z.string(),
  message: z.string(),
});

/** The refusal as the error `ControlClient` raises for the same case. */
function refusal(code: string, message: string, status: number): Error {
  if (code === 'session_unavailable') return new SessionUnavailableError(message);
  if (code === 'session_failed')
    return new SessionHostFailedError(message.replace(/^The session host failed: /, ''));
  return new RelayError(code, message, status);
}

async function readReply(response: Response): Promise<z.infer<typeof replySchema>> {
  const text = await response.text();
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    throw new RelayError(
      'http',
      `Switch answered the relay with ${response.status}: ${text.slice(0, 500)}`,
      response.status
    );
  }
  const reply = replySchema.safeParse(body);
  if (reply.success) return reply.data;
  if (response.status === 404) throw new RelayError('not_found', 'Managed agent not found.', 404);
  const detail = z.object({ detail: z.unknown() }).safeParse(body);
  throw new RelayError(
    'http',
    `Switch answered the relay with ${response.status}: ${JSON.stringify(detail.success ? detail.data.detail : body).slice(0, 500)}`,
    response.status
  );
}

type Frame = { event: string; data: unknown };

/** Server-sent events from a streaming response, one `{event, data}` per frame. */
export async function* relayFrames(response: Response): AsyncGenerator<Frame> {
  if (!response.body) throw new Error('The relay stream has no body.');
  const decoder = new TextDecoder();
  let buffered = '';
  for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
    buffered += decoder.decode(chunk, { stream: true }).replace(/\r\n/g, '\n');
    let at = buffered.indexOf('\n\n');
    while (at !== -1) {
      const block = buffered.slice(0, at);
      buffered = buffered.slice(at + 2);
      let event = 'message';
      const data: string[] = [];
      for (const line of block.split('\n')) {
        if (line.startsWith(':')) continue;
        if (line.startsWith('event:')) event = line.slice(6).trim();
        else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
      }
      if (data.length) yield { event, data: JSON.parse(data.join('\n')) };
      at = buffered.indexOf('\n\n');
    }
  }
}

export type RelayClientOptions = {
  /** How long a request keeps asking while the controller's queue is full. */
  retryMs: number;
  /** How long the controller has to answer one request, at most `RELAY_TIMEOUT_MS`. */
  timeoutMs: number;
};

export class RelayClient {
  constructor(
    private readonly fetchRelay: RelayFetch,
    readonly basePath: string,
    private readonly options: RelayClientOptions
  ) {
    if (options.timeoutMs > RELAY_TIMEOUT_MS)
      throw new Error(`A relay waits at most ${RELAY_TIMEOUT_MS} ms.`);
  }

  private async once(message: ControlMessage): Promise<unknown> {
    let response: Response;
    try {
      response = await this.fetchRelay(this.basePath, {
        method: 'POST',
        body: { message, timeout_ms: this.options.timeoutMs },
        signal: AbortSignal.timeout(this.options.timeoutMs + 15_000),
      });
    } catch (error) {
      throw new RelayError(
        'unreachable',
        `Switch could not be reached: ${error instanceof Error ? error.message : String(error)}`,
        0
      );
    }
    const reply = await readReply(response);
    if (reply.ok) return reply.value ?? null;
    throw refusal(
      reply.error?.code ?? 'failed',
      reply.error?.message ?? 'The agent’s controller refused the request.',
      response.status
    );
  }

  /** One relayed message, asked again while the agent's host cannot have received it. */
  private async call(message: ControlMessage): Promise<unknown> {
    const deadline = Date.now() + this.options.retryMs;
    let pause = 250;
    for (;;) {
      try {
        return await this.once(message);
      } catch (error) {
        const again = error instanceof RelayError && RETRYABLE.has(error.relayCode);
        if (!again || Date.now() + pause > deadline) throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, pause));
      pause = Math.min(pause * 2, 2000);
    }
  }

  /** A paged answer, put together and checked against its size and digest. */
  private async paged(message: ControlMessage): Promise<unknown> {
    for (let attempt = 1; ; attempt++) {
      try {
        const first = firstPageSchema.parse(await this.call(message));
        const parts = [Buffer.from(first.page.data, 'base64')];
        for (let index = 1; index < first.pageCount; index++) {
          const next = pageSchema.parse(
            await this.call({ page: { snapshotId: first.snapshotId, index } })
          );
          if (next.snapshotId !== first.snapshotId || next.page.index !== index)
            throw new Error(`The agent’s controller answered page ${index} with another page.`);
          parts.push(Buffer.from(next.page.data, 'base64'));
        }
        const data = Buffer.concat(parts);
        const sha256 = createHash('sha256').update(data).digest('hex');
        if (data.byteLength !== first.bytes || sha256 !== first.sha256)
          throw new Error('A paged answer from the agent’s controller does not match its digest.');
        return JSON.parse(data.toString('utf8')) as unknown;
      } catch (error) {
        const restart =
          error instanceof RelayError &&
          RESTART_PAGED.has(error.relayCode) &&
          attempt < PAGED_ATTEMPTS;
        if (!restart) throw error;
      }
    }
  }

  /** A session request; a snapshot comes back whole however many pages it took. */
  async request(sessionId: string, request: SessionRequest): Promise<unknown> {
    const message = { sessionId, request };
    return request.type === 'snapshot' ? this.paged(message) : this.call(message);
  }

  /** A session read from its journal on the controller, whether or not its host runs. */
  async journal(sessionId: string): Promise<Snapshot> {
    return snapshotSchema.parse(await this.paged({ journal: sessionId }));
  }

  /** Start the session a message to this room would start, through the agent's room watcher. */
  async warm(roomId: string): Promise<string | null> {
    return z
      .string()
      .nullable()
      .parse(await this.call({ warm: { roomId } }));
  }

  /** The agent's room watcher: its connection state and placements. */
  async health(): Promise<WatcherHealth> {
    return watcherHealthSchema.parse(await this.call({ health: true }));
  }

  /**
   * Hear every event the session's host records, and `onFailure` whenever it
   * stops on a failure or comes up again. `onReset` is called once, instead
   * of any further event, when the live view can no longer be trusted: the
   * controller's stream changed, Switch reported a gap or an overflow, or the
   * stream closed. The view is then rebuilt from a new snapshot.
   *
   * Resolves once Switch holds the view, so a snapshot asked for after it
   * misses nothing the view does not also carry.
   */
  async subscribe(
    sessionId: string,
    listener: (event: ServerEvent) => void,
    onFailure: (failure: string | null) => void,
    onReset: (reason: string) => void
  ): Promise<() => void> {
    const abort = new AbortController();
    let done = false;
    const reset = (reason: string) => {
      if (done) return;
      done = true;
      abort.abort();
      onReset(reason);
    };
    let controller: number | null | undefined;
    let opened!: { resolve: () => void; reject: (error: Error) => void };
    const ready = new Promise<void>((resolve, reject) => {
      opened = { resolve, reject };
    });
    let isOpen = false;
    const onFrame = (frame: Frame) => {
      switch (frame.event) {
        case 'worker': {
          const { generation } = workerFrameSchema.parse(frame.data);
          if (!isOpen) {
            isOpen = true;
            controller = generation;
            opened.resolve();
          } else if (generation !== controller) reset('The agent’s controller reconnected.');
          return;
        }
        case 'event': {
          const parsed = serverEventSchema.safeParse(eventFrameSchema.parse(frame.data).event);
          if (parsed.success) listener(parsed.data);
          else reset(`The agent’s controller sent an unreadable event: ${parsed.error.message}`);
          return;
        }
        case 'failure':
          onFailure(failureFrameSchema.parse(frame.data).failure);
          return;
        case 'resync':
          reset(`Switch asked for a resync (${resyncFrameSchema.parse(frame.data).reason}).`);
          return;
        case 'error': {
          const error = errorFrameSchema.parse(frame.data);
          reset(`${error.message} (${error.code})`);
          return;
        }
      }
    };
    void (async () => {
      const response = await this.fetchRelay(
        `${this.basePath}/stream?${new URLSearchParams({ subscribe: sessionId })}`,
        { method: 'GET', body: undefined, signal: abort.signal }
      );
      if (!response.ok) {
        const reply = await readReply(response);
        throw refusal(
          reply.error?.code ?? 'failed',
          reply.error?.message ?? `The relay stream was refused (${response.status}).`,
          response.status
        );
      }
      for await (const frame of relayFrames(response)) {
        if (done) return;
        onFrame(frame);
      }
      throw new RelayClosedError('Switch ended the stream.');
    })().catch((error: unknown) => {
      if (abort.signal.aborted) return;
      const failure = error instanceof Error ? error : new RelayClosedError(String(error));
      if (isOpen) reset(failure.message);
      else opened.reject(failure);
    });
    try {
      await ready;
    } catch (error) {
      done = true;
      abort.abort();
      throw error;
    }
    return () => {
      done = true;
      abort.abort();
    };
  }
}
