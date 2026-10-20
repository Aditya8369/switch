import type { ChannelRetirement, RetireOutcome } from '@shared/core/switch-servers/switch-servers';

/**
 * What deleting a room will do to its channel on `platform`, as the server says
 * that platform's bridge will.
 *
 * Null when the room has no channel. Undefined — a server predating the field —
 * gets the one thing that is true everywhere: the channel may still be there
 * afterwards. Never says a channel is deleted unless it will be.
 */
export function channelOnDeleteText(
  platform: string,
  outcome: ChannelRetirement | null | undefined
): string | null {
  switch (outcome) {
    case null:
      return null;
    case undefined:
      return `The ${platform} channel may remain after the room is deleted.`;
    case 'archived':
      return `Its ${platform} channel will be archived.`;
    case 'deleted':
      return `Its ${platform} channel will be deleted.`;
    case 'left':
      return `The bot will leave the ${platform} chat; the chat itself stays.`;
    case 'kept':
      return `Its ${platform} channel stays in ${platform}; remove it there.`;
  }
}

/**
 * The notice for a channel the server could not retire, or null when there is
 * nothing to clean up. The room is gone by then, so this only says what is left
 * for the person to do by hand, and why.
 */
export function channelCleanupText(
  platform: string,
  planned: ChannelRetirement | null | undefined,
  channel: RetireOutcome | null
): string | null {
  if (channel?.outcome !== 'failed') return null;
  const why = channel.reason ? ` (${channel.reason})` : '';
  switch (planned) {
    case 'archived':
      return `The room was deleted, but its ${platform} channel could not be archived${why}. Archive it in ${platform} by hand.`;
    case 'deleted':
      return `The room was deleted, but its ${platform} channel could not be deleted${why}. Delete it in ${platform} by hand.`;
    case 'left':
      return `The room was deleted, but the bot could not leave the ${platform} chat${why}. Remove the bot from the chat in ${platform}.`;
    default:
      return `The room was deleted, but its ${platform} channel was not cleaned up${why}. Remove it in ${platform} by hand.`;
  }
}
