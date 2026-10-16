import type { ServiceFlow } from '@shared/core/switch-servers/service-connection';
import { RpcError } from '@shared/lib/ipc/rpc-error';

/**
 * A service sign-in as the dialog holds it: the flow Switch is running for
 * it, if any, and what the person is shown.
 */
export type ConnectFlowState = {
  connected: boolean;
  flowId: string | null;
  flow: ServiceFlow | null;
  busy: boolean;
  warning: string | null;
  error: string | null;
};

export type ConnectFlowEvent =
  /** An action begins: start, confirm, cancel or disconnect. */
  | { type: 'act' }
  | { type: 'started'; flowId: string }
  /** `failure` is what to say if the sign-in failed without saying why. */
  | { type: 'polled'; flow: ServiceFlow; failure: string }
  | { type: 'poll_failed'; error: string }
  | { type: 'confirmed'; warning: string | null }
  | { type: 'confirm_failed'; cause: unknown; error: string }
  | { type: 'cancelled' }
  | { type: 'cancel_failed'; cause: unknown; error: string }
  | { type: 'disconnected'; warning: string | null }
  /** Starting or disconnecting failed; nothing about a flow changes. */
  | { type: 'failed'; error: string };

export function initialConnectFlow(connected: boolean): ConnectFlowState {
  return { connected, flowId: null, flow: null, busy: false, warning: null, error: null };
}

const NO_FLOW = { flowId: null, flow: null } as const;

/**
 * The sign-in's state after `event`. A confirm the server refuses for good
 * drops the flow, since the server has dropped or will never accept it; one
 * it may still accept keeps it, so the person can try again. A cancel the
 * server answers with 410 found the flow already gone, which is what
 * cancelling wanted.
 */
export function connectFlowReducer(
  state: ConnectFlowState,
  event: ConnectFlowEvent
): ConnectFlowState {
  switch (event.type) {
    case 'act':
      return { ...state, busy: true, error: null };
    case 'started':
      return { ...state, busy: false, flowId: event.flowId, flow: null, warning: null };
    case 'polled':
      return {
        ...state,
        flow: event.flow,
        error: event.flow.status === 'failed' ? (event.flow.error ?? event.failure) : state.error,
      };
    case 'poll_failed':
      return { ...state, ...NO_FLOW, error: event.error };
    case 'confirmed':
      return { ...state, ...NO_FLOW, busy: false, connected: true, warning: event.warning };
    case 'confirm_failed':
      return {
        ...state,
        ...(isFinalRefusal(event.cause) ? NO_FLOW : {}),
        busy: false,
        error: event.error,
      };
    case 'cancelled':
      return { ...state, ...NO_FLOW, busy: false, error: null };
    case 'cancel_failed':
      return isGone(event.cause)
        ? { ...state, ...NO_FLOW, busy: false, error: null }
        : { ...state, busy: false, error: event.error };
    case 'disconnected':
      return { ...state, busy: false, connected: false, warning: event.warning };
    case 'failed':
      return { ...state, busy: false, error: event.error };
  }
}

/**
 * Whether the dialog may close: never mid-call, and not while a sign-in is
 * under way unless an error is showing, so a refusal can never strand it.
 */
export function canCloseConnectFlow(state: ConnectFlowState): boolean {
  return !state.busy && (state.flowId === null || state.error !== null);
}

/**
 * Whether the server refused for good, so trying the same flow again cannot
 * succeed. Read from the server's `retryable` where it says, else from the
 * status: 403 (not allowed here), 409 (the account or flow conflicts) and
 * 410 (the flow is gone).
 */
export function isFinalRefusal(cause: unknown): boolean {
  if (!(cause instanceof RpcError)) return false;
  const retryable = cause.data.retryable;
  if (typeof retryable === 'boolean') return !retryable;
  const status = cause.numberField('status');
  return status === 403 || status === 409 || status === 410;
}

function isGone(cause: unknown): boolean {
  return cause instanceof RpcError && cause.numberField('status') === 410;
}
