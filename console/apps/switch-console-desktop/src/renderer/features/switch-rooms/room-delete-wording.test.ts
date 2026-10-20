import { describe, expect, it } from 'vitest';
import { channelCleanupText, channelOnDeleteText } from './room-delete-wording';

describe('channelOnDeleteText', () => {
  it('says a Slack channel will be archived, not deleted', () => {
    expect(channelOnDeleteText('Slack', 'archived')).toBe('Its Slack channel will be archived.');
  });

  it('says a Discord channel will be deleted', () => {
    expect(channelOnDeleteText('Discord', 'deleted')).toBe('Its Discord channel will be deleted.');
  });

  it('says the bot will leave a Telegram chat', () => {
    expect(channelOnDeleteText('Telegram', 'left')).toContain(
      'The bot will leave the Telegram chat'
    );
  });

  it('says a Teams channel stays and has to be removed in Teams', () => {
    expect(channelOnDeleteText('Microsoft Teams', 'kept')).toBe(
      'Its Microsoft Teams channel stays in Microsoft Teams; remove it there.'
    );
  });

  it('claims nothing beyond "may remain" when the server does not say', () => {
    expect(channelOnDeleteText('Slack', undefined)).toBe(
      'The Slack channel may remain after the room is deleted.'
    );
  });

  it('says nothing about a channel the room does not have', () => {
    expect(channelOnDeleteText('Slack', null)).toBeNull();
  });
});

describe('channelCleanupText', () => {
  it('asks for a channel Slack would not archive to be archived by hand', () => {
    const text = channelCleanupText('Slack', 'archived', {
      outcome: 'failed',
      reason: 'The Switch app is no longer in this Slack channel',
    });

    expect(text).toContain('could not be archived');
    expect(text).toContain('no longer in this Slack channel');
    expect(text).toContain('Archive it in Slack by hand.');
  });

  it('has nothing to say when the channel was retired', () => {
    expect(
      channelCleanupText('Slack', 'archived', { outcome: 'archived', reason: null })
    ).toBeNull();
    expect(channelCleanupText('Slack', 'archived', null)).toBeNull();
  });

  it('still asks for cleanup when the planned outcome was never read', () => {
    expect(channelCleanupText('Slack', undefined, { outcome: 'failed', reason: null })).toBe(
      'The room was deleted, but its Slack channel was not cleaned up. Remove it in Slack by hand.'
    );
  });
});
