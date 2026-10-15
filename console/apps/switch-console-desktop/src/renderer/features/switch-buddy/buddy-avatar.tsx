import buddyAvatar from '@/assets/images/switch-buddy/avatar.png';
import { cn } from '@renderer/utils/utils';

/**
 * switch-buddy's face, the same picture the agent itself carries: round, like
 * every agent's avatar in lists and chats, or as a rounded tile where it is
 * introduced.
 */
export function BuddyAvatar({
  size,
  shape,
  className,
}: {
  size: number;
  shape: 'round' | 'tile';
  className?: string;
}) {
  return (
    <img
      src={buddyAvatar}
      alt=""
      width={size}
      height={size}
      className={cn(
        'shrink-0 object-cover',
        shape === 'round' ? 'rounded-full' : 'rounded-[22%]',
        className
      )}
      style={{ width: size, height: size }}
    />
  );
}
