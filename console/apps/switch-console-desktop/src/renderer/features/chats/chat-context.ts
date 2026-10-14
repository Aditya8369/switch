import type { Item, Session, SnapshotNotice } from '@switch-console/shared/session-v1';

/** Why Compact and Reset cannot be used now, or null when they can. */
export function contextBlocker(state: {
  connected: boolean;
  session: Session;
  pendingCommand: boolean;
  working: boolean;
}): string | null {
  const { session } = state;
  if (!state.connected || session.connectivity !== 'online')
    return "The agent's machine is offline.";
  if (session.pendingRequestIds.length > 0) return 'Waiting for a pending request.';
  if (state.working || session.status === 'running')
    return 'The agent is working — wait for it to finish.';
  if (state.pendingCommand) return 'Waiting for the previous command to be confirmed.';
  if (session.status === 'starting') return 'The session is starting — wait for it to be ready.';
  if (session.status === 'stopped') return 'No live session yet — send a message first.';
  if (session.status === 'error') return "The agent's session stopped with an error.";
  return null;
}

/** Whether the session's latest compaction has started and not yet ended. */
export function isCompacting(session: Session, notices: readonly SnapshotNotice[]): boolean {
  if (session.status !== 'running') return false;
  for (let at = notices.length - 1; at >= 0; at--)
    if (notices[at].code.startsWith('COMPACTION_'))
      return notices[at].code === 'COMPACTION_STARTED';
  return false;
}

export type ContextMarker = 'compacted' | 'reset';
const MARKERS: Record<string, ContextMarker> = {
  COMPACTION_COMPLETED: 'compacted',
  CONTEXT_RESET: 'reset',
};

/**
 * Where each compaction and reset the session recorded falls among the room's
 * messages: before the first message whose turn ran after it, or at the end
 * (key null). One older than every loaded turn is left out while earlier
 * messages are still unloaded, since its place is not known yet.
 */
export function contextMarkerSlots(input: {
  messageIds: readonly string[];
  bound: ReadonlyMap<string, { turnId: string }>;
  turnIds: readonly string[];
  items: readonly Item[];
  notices: readonly SnapshotNotice[];
  hasMore: boolean;
}): Map<string | null, ContextMarker[]> {
  const order = new Map(input.turnIds.map((turnId, at) => [turnId, at]));
  const turnOfItem = new Map(input.items.map((item) => [item.itemId, item.turnId]));
  const placed = input.messageIds.flatMap((messageId) => {
    const turnId = input.bound.get(messageId)?.turnId;
    const at = turnId === undefined ? undefined : order.get(turnId);
    return at === undefined ? [] : [{ messageId, at }];
  });
  const slots = new Map<string | null, ContextMarker[]>();
  for (const notice of input.notices) {
    const marker = MARKERS[notice.code];
    if (!marker) continue;
    const turnId = notice.afterItemId === null ? null : turnOfItem.get(notice.afterItemId);
    if (turnId === undefined) continue;
    const at = turnId === null ? -1 : order.get(turnId);
    if (at === undefined) continue;
    const next = placed.find((each) => each.at > at);
    if (input.hasMore && next === placed[0]) continue;
    const key = next?.messageId ?? null;
    slots.set(key, [...(slots.get(key) ?? []), marker]);
  }
  return slots;
}
