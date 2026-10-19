import { beforeEach, describe, expect, it } from 'vitest';
import {
  cancelNotice,
  confirmNotice,
  dismissNotice,
  noticeFor,
  resetDismissedNotices,
  savingNotice,
} from './server-address-notice-state';

const SAVED = 'http://10.0.0.5:8000';
const ADVERTISED = 'https://switch-api.example.com';
const mismatch = { status: 'mismatch', savedApiUrl: SAVED, advertisedApiUrl: ADVERTISED } as const;

beforeEach(() => resetDismissedNotices());

describe('the address notice', () => {
  it('is hidden on a match, an unknown, or before the check answers', () => {
    expect(noticeFor('s1', { status: 'match' })).toEqual({ kind: 'hidden' });
    expect(noticeFor('s1', { status: 'unknown' })).toEqual({ kind: 'hidden' });
    expect(noticeFor('s1', null)).toEqual({ kind: 'hidden' });
  });

  it('offers the advertised address on a mismatch, naming both', () => {
    expect(noticeFor('s1', mismatch)).toEqual({
      kind: 'offering',
      savedApiUrl: SAVED,
      advertisedApiUrl: ADVERTISED,
    });
  });

  it('confirms before saving, and cancelling goes back to offering', () => {
    const offering = noticeFor('s1', mismatch);
    const confirming = confirmNotice(offering);

    expect(confirming.kind).toBe('confirming');
    expect(cancelNotice(confirming).kind).toBe('offering');
    expect(savingNotice(confirming).kind).toBe('saving');
    // Saving is only reachable through the confirmation.
    expect(savingNotice(offering).kind).toBe('offering');
  });

  it('stays dismissed for the rest of the run, for that server and suggestion only', () => {
    dismissNotice('s1', noticeFor('s1', mismatch));

    expect(noticeFor('s1', mismatch)).toEqual({ kind: 'hidden' });
    expect(noticeFor('s2', mismatch).kind).toBe('offering');
    expect(
      noticeFor('s1', { ...mismatch, advertisedApiUrl: 'https://agents.example.com' }).kind
    ).toBe('offering');
  });
});
