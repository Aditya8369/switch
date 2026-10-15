import type { ManagedAgentView } from '@shared/core/managed-agents/managed-agents';

/** The template every person's buddy is created from, served by the server. */
export const BUDDY_TEMPLATE_ID = 'official:switch-buddy';

/** What people see the buddy called, whoever's it is. */
export const BUDDY_DISPLAY_NAME = 'switch-buddy';

const NAME_PREFIX = 'switch-buddy';

/** Agent names are lowercase letters, digits, `.`, `-` and `_`. */
function slug(value: string): string {
  return value
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9._]+/g, '-')
    .replace(/^[._-]+|[._-]+$/g, '')
    .slice(0, 40);
}

/**
 * The name a person's buddy is created under: `switch-buddy-<person>`, from
 * their name, else the part of their e-mail before the @. Names are unique per
 * workspace and everyone there gets a buddy, hence the person in it; when even
 * that is taken, a number follows (`switch-buddy-max-2`).
 */
export function buddyAgentName(
  person: { name: string | null; email: string | null },
  taken: ReadonlySet<string>
): string {
  const who = slug(person.name ?? '') || slug(person.email?.split('@')[0] ?? '');
  const base = who ? `${NAME_PREFIX}-${who}` : NAME_PREFIX;
  if (!taken.has(base)) return base;
  for (let n = 2; ; n++) if (!taken.has(`${base}-${n}`)) return `${base}-${n}`;
}

/** Whether one of the person's own managed agents is their buddy. */
export function isBuddy(agent: Pick<ManagedAgentView, 'name' | 'displayName'>): boolean {
  return agent.displayName === BUDDY_DISPLAY_NAME && agent.name.startsWith(NAME_PREFIX);
}

/** The first name to greet someone by: the first word of their name. */
export function firstNameOf(name: string | null | undefined): string | null {
  return name?.trim().split(/\s+/)[0] || null;
}
