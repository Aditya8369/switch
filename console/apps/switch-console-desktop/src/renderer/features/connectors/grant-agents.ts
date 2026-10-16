import type {
  ConnectionAgent,
  ConnectionCatalogEntry,
} from '@shared/core/switch-servers/connection-catalog';

export const OPEN_GROUP_NOTE =
  'Others can address these agents; they would act as you. Tick one to turn it on anyway.';
export const ALREADY_ON_NOTE = 'Already on.';

export type ChecklistRow = {
  agentId: string;
  name: string;
  /** Ticked when the list opens. */
  ticked: boolean;
  /** Already granted: shown ticked, and not asked for again. */
  granted: boolean;
};

/**
 * Whether connecting `entry` is followed by the checklist that turns it on for
 * the person's agents. Only for a service a grant simply switches on: GitHub's
 * grant names repositories, which the agent's settings choose.
 */
export function offersChecklist(entry: ConnectionCatalogEntry): boolean {
  return entry.pass_through && entry.slug !== 'github';
}

/**
 * The checklist, in two groups. First the agents it starts ticked: those only
 * their owner can address, and those that already have the service. Then the
 * agents others can address, unticked under {@link OPEN_GROUP_NOTE}, since
 * whoever addresses one would have it act as the owner.
 */
export function checklistGroups(agents: ConnectionAgent[]): {
  ticked: ChecklistRow[];
  open: ChecklistRow[];
} {
  const row = (agent: ConnectionAgent, ticked: boolean): ChecklistRow => ({
    agentId: agent.agent_id,
    name: agent.name,
    ticked,
    granted: agent.granted,
  });
  return {
    ticked: agents
      .filter((agent) => agent.granted || !agent.addressing_open)
      .map((agent) => row(agent, true)),
    open: agents
      .filter((agent) => !agent.granted && agent.addressing_open)
      .map((agent) => row(agent, false)),
  };
}

/** The one button after signing in: connect, and turn it on for the agents ticked. */
export function connectButtonLabel(ticked: number): string {
  if (ticked === 0) return 'Connect';
  return `Connect and turn on for ${ticked} ${ticked === 1 ? 'agent' : 'agents'}`;
}

/** What the checklist says when the person has no agents in the workspace. */
export function noAgentsText(serviceName: string): string {
  return `You have no agents in this workspace yet. Once you add one, turn ${serviceName} on for it from its settings.`;
}

/** What stands in for the agents on a server that cannot list them. */
export function agentsUnlistedText(serviceName: string): string {
  return `This server can't list your agents here. Turn ${serviceName} on for an agent from its settings.`;
}

export type GrantOutcome = {
  granted: string[];
  failed: { name: string; reason: string }[];
  /** What the server said stays usable a while, once each. */
  warnings: string[];
};

/**
 * Grant the service to each agent, one call each. A failure does not stop the
 * others; each is recorded with the agent it was for, so the person is told
 * exactly which did not happen.
 */
export async function grantEach(
  agents: { agentId: string; name: string }[],
  grant: (agentId: string) => Promise<string | null>,
  describe: (cause: unknown) => string
): Promise<GrantOutcome> {
  const results = await Promise.allSettled(agents.map((agent) => grant(agent.agentId)));
  const outcome: GrantOutcome = { granted: [], failed: [], warnings: [] };
  results.forEach((result, index) => {
    const name = agents[index]!.name;
    if (result.status === 'fulfilled') {
      outcome.granted.push(name);
      if (result.value && !outcome.warnings.includes(result.value))
        outcome.warnings.push(result.value);
    } else {
      outcome.failed.push({ name, reason: describe(result.reason) });
    }
  });
  return outcome;
}

/** The error after granting, naming every agent it failed for; null when none failed. */
export function grantFailureText(serviceName: string, outcome: GrantOutcome): string | null {
  if (outcome.failed.length === 0) return null;
  const failed = outcome.failed.map(({ name, reason }) => `${name} (${reason})`).join('; ');
  const done =
    outcome.granted.length > 0
      ? ` It is on for ${listOf(outcome.granted)}.`
      : ' It is not on for any agent.';
  return `Could not turn ${serviceName} on for ${failed}.${done}`;
}

/** What granting did, when every call succeeded. */
export function grantSuccessText(serviceName: string, outcome: GrantOutcome): string {
  return outcome.granted.length > 0
    ? `${serviceName} is on for ${listOf(outcome.granted)}.`
    : `${serviceName} is not on for any agent. Turn it on later from an agent's settings.`;
}

export function listOf(names: string[]): string {
  return new Intl.ListFormat('en', { type: 'conjunction' }).format(names);
}
