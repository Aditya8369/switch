import { CONSOLE_LINK_SCHEME } from '@shared/core/deeplinks/console-links';

/**
 * A messaging app's logo, written into a chat message as an image whose
 * address is this prefix and the app's `bridge_type`, and drawn by the chat
 * inline in the text, where an emoji would go. No emoji exists for Slack,
 * Teams and the rest. Only Console draws it: anywhere else it is an image that
 * does not load, so it is for messages read in Console.
 */
export const PLATFORM_LOGO_PREFIX = `${CONSOLE_LINK_SCHEME}://logo/`;

/** The markdown for `platform`'s logo, `label` naming it to a screen reader. */
export function platformLogoMarkdown(platform: string, label: string): string {
  return `![${label}](${PLATFORM_LOGO_PREFIX}${platform})`;
}

/** The `bridge_type` an image address draws the logo of, or null when it is any other image. */
export function platformOfLogoUrl(src: unknown): string | null {
  if (typeof src !== 'string' || !src.startsWith(PLATFORM_LOGO_PREFIX)) return null;
  const platform = src.slice(PLATFORM_LOGO_PREFIX.length);
  return /^[a-z][a-z0-9_-]{0,40}$/.test(platform) ? platform : null;
}
