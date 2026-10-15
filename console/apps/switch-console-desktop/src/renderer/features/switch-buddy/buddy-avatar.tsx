import { cn } from '@renderer/utils/utils';

/** switch-buddy's face: a tilted blue square with two eyes, on a soft tile. */
export function BuddyAvatar({ size, className }: { size: number; className?: string }) {
  return (
    <span
      className={cn(
        'inline-flex shrink-0 items-center justify-center rounded-[22%] bg-background-tertiary',
        className
      )}
      style={{ width: size, height: size }}
      aria-hidden
    >
      <svg viewBox="0 0 40 40" width={size * 0.72} height={size * 0.72}>
        <rect
          x="5"
          y="5"
          width="30"
          height="30"
          rx="7"
          fill="#8fb1f7"
          transform="rotate(6 20 20)"
        />
        <circle cx="15" cy="19" r="2.4" fill="#16181d" />
        <circle cx="25" cy="20.5" r="2.4" fill="#16181d" />
        <circle cx="15.7" cy="18.3" r="0.7" fill="#fff" />
        <circle cx="25.7" cy="19.8" r="0.7" fill="#fff" />
      </svg>
    </span>
  );
}
