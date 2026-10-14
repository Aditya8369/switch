import { describe, expect, it } from 'vitest';
import { isConsoleDirectChat } from './room-filters';

describe('isConsoleDirectChat', () => {
  it('returns true for direct unbridged rooms', () => {
    expect(isConsoleDirectChat({ channelType: 'direct', bridgeType: null })).toBe(true);
  });

  it('returns false for direct bridged rooms', () => {
    expect(isConsoleDirectChat({ channelType: 'direct', bridgeType: 'slack' })).toBe(false);
  });

  it('returns false for non-direct unbridged rooms', () => {
    expect(isConsoleDirectChat({ channelType: 'channel_public', bridgeType: null })).toBe(false);
  });

  it('returns false for non-direct bridged rooms', () => {
    expect(isConsoleDirectChat({ channelType: 'channel_private', bridgeType: 'mattermost' })).toBe(
      false
    );
  });
});
