import type { ServerAddressCheck } from '@shared/core/switch-servers/server-address';

/**
 * The server page's suggestion that a saved server's agent address has moved.
 *
 * It only ever offers. Accepting goes through a confirmation, because saving
 * the new address rewrites every member agent's credentials and restarts this
 * computer's controller; dismissing hides it for this run of the app.
 */
export type AddressNotice =
  | { kind: 'hidden' }
  | { kind: 'offering'; savedApiUrl: string; advertisedApiUrl: string }
  | { kind: 'confirming'; savedApiUrl: string; advertisedApiUrl: string }
  | { kind: 'saving'; savedApiUrl: string; advertisedApiUrl: string };

/** Servers whose suggestion was dismissed, until the app is restarted. The
 * key holds the suggestion too, so a different one later is offered again. */
const dismissed = new Set<string>();

function key(serverId: string, advertisedApiUrl: string): string {
  return `${serverId} ${advertisedApiUrl}`;
}

export function noticeFor(serverId: string, check: ServerAddressCheck | null): AddressNotice {
  if (check?.status !== 'mismatch') return { kind: 'hidden' };
  if (dismissed.has(key(serverId, check.advertisedApiUrl))) return { kind: 'hidden' };
  return {
    kind: 'offering',
    savedApiUrl: check.savedApiUrl,
    advertisedApiUrl: check.advertisedApiUrl,
  };
}

export function dismissNotice(serverId: string, notice: AddressNotice): AddressNotice {
  if (notice.kind === 'hidden') return notice;
  dismissed.add(key(serverId, notice.advertisedApiUrl));
  return { kind: 'hidden' };
}

export function confirmNotice(notice: AddressNotice): AddressNotice {
  return notice.kind === 'offering' ? { ...notice, kind: 'confirming' } : notice;
}

export function cancelNotice(notice: AddressNotice): AddressNotice {
  return notice.kind === 'confirming' ? { ...notice, kind: 'offering' } : notice;
}

export function savingNotice(notice: AddressNotice): AddressNotice {
  return notice.kind === 'confirming' ? { ...notice, kind: 'saving' } : notice;
}

/** For tests: forget every dismissal. */
export function resetDismissedNotices(): void {
  dismissed.clear();
}
