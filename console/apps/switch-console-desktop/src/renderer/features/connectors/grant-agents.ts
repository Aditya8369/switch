import type {
  ConnectionAgent,
  ConnectionCatalogEntry,
} from '@shared/core/switch-servers/connection-catalog';

/** Said of an agent others can address: whoever addresses it would have it act as its owner. */
export const OPEN_AGENT_NOTE = 'Others can address it; it would act as you.';

export type AgentRow = {
  agentId: string;
  name: string;
  /** Others can address it, so it is offered rather than picked to begin with. */
  open: boolean;
};

/**
 * Whether connecting `entry` is followed by the picker that turns it on for
 * the person's agents. Only for a service a grant simply switches on: GitHub's
 * grant names repositories, which the agent's settings choose.
 */
export function offersPicker(entry: ConnectionCatalogEntry): boolean {
  return entry.pass_through && entry.slug !== 'github';
}

/**
 * The person's agents, as the picker starts: `picked` are the agents only
 * their owner can address, added before the person touches anything;
 * `offered` are the agents others can address, found through the search and
 * added by hand under {@link OPEN_AGENT_NOTE}; `on` already have the service
 * and are only named.
 */
export function pickerGroups(agents: ConnectionAgent[]): {
  picked: AgentRow[];
  offered: AgentRow[];
  on: AgentRow[];
} {
  const row = (agent: ConnectionAgent): AgentRow => ({
    agentId: agent.agent_id,
    name: agent.name,
    open: agent.addressing_open,
  });
  const off = agents.filter((agent) => !agent.granted);
  return {
    picked: off.filter((agent) => !agent.addressing_open).map(row),
    offered: off.filter((agent) => agent.addressing_open).map(row),
    on: agents.filter((agent) => agent.granted).map(row),
  };
}

/** The line under the search box naming the agents that already have the service. */
export function alreadyOnText(serviceName: string, names: string[]): string {
  return `${serviceName} is already on for ${listOf(names)}.`;
}

/** The one button after signing in: connect, and turn it on for the agents ticked. */
export function connectButtonLabel(ticked: number): string {
  if (ticked === 0) return 'Connect';
  return `Connect and turn on for ${ticked} ${ticked === 1 ? 'agent' : 'agents'}`;
}

/** What the picker says when the person has no agents in the workspace. */
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
