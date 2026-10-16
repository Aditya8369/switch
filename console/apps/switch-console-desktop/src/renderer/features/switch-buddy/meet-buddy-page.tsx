import { observer } from 'mobx-react-lite';
import { useMemo, useState, type ReactNode } from 'react';
import { useManagedAgents } from '@renderer/features/managed-agents/use-managed-agents';
import { switchServersStore } from '@renderer/features/switch-servers/switch-servers-store';
import { failureText } from '@renderer/lib/errors/describe-failure';
import { Button } from '@renderer/lib/ui/button';
import { Spinner } from '@renderer/lib/ui/spinner';
import { OnboardingSurface, useWizardExit } from '@renderer/lib/ui/wizard-frame';
import { agentProviders } from '@shared/core/providers/agent-provider-registry';
import { BuddyAvatar } from './buddy-avatar';
import { firstNameOf, isBuddy } from './buddy-identity';
import { type BuddyProvider, buddyProviders } from './buddy-providers';
import { createBuddy } from './create-buddy';
import { ProviderSetup } from './provider-setup';
import { useThisComputer } from './use-this-computer';

/** How many providers the page offers to start with outright; the rest are a click further. */
const START_BUTTONS = 2;

/** The order the "Start with …" buttons go in: the most used first. */
const PREFERRED = ['claude', 'codex'];

function startOrder(providers: BuddyProvider[]): BuddyProvider[] {
  const rank = (id: string) => {
    const at = PREFERRED.indexOf(id);
    return at === -1 ? PREFERRED.length : at;
  };
  return [...providers].sort((a, b) => rank(a.id) - rank(b.id));
}

/**
 * Meet switch-buddy: who it is, in its own short lines, and the quickest way
 * to start it.
 *
 * A provider already installed and signed in on this computer is offered as
 * "Start with …" straight away, for the first two; the others, and providers
 * still to set up, are behind "Use another provider". It can be skipped, for
 * the chat to open without the buddy, asking for a provider there. Someone who
 * already has a buddy (replaying these pages) is offered to open it instead.
 *
 * This computer starts running agents for the workspace as the page opens, so
 * what its providers are ready for is known by the time it has been read.
 */
export const MeetBuddyPage = observer(function MeetBuddyPage({
  serverId,
  workspaceId,
  onCreated,
  onSkip,
}: {
  serverId: string;
  workspaceId: string;
  onCreated: (agent: { agentId: string; name: string }) => void;
  onSkip: () => void;
}) {
  const exit = useWizardExit();
  const [settingUp, setSettingUp] = useState(false);
  const { state: computer } = useThisComputer(serverId, workspaceId);
  const ready = useMemo(
    () =>
      startOrder(
        buddyProviders(
          agentProviders(),
          computer.kind === 'ready' ? computer.machine : null
        ).filter((provider) => provider.state === 'ready')
      ).slice(0, START_BUTTONS),
    [computer]
  );
  const existing = useManagedAgents(serverId).data?.find(isBuddy) ?? null;
  const [starting, setStarting] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const user = switchServersStore.statusFor(serverId)?.user ?? null;
  const firstName = firstNameOf(user?.name);

  const startWith = async (providerId: string) => {
    if (computer.kind !== 'ready') return;
    setStarting(providerId);
    setError(null);
    try {
      onCreated(
        await createBuddy({
          serverId,
          workspaceId,
          machineId: computer.machine.id,
          provider: providerId,
          person: { name: user?.name ?? null, email: user?.email ?? null },
        })
      );
    } catch (cause) {
      setError(failureText(cause, 'Could not create switch-buddy.'));
      setStarting(null);
    }
  };

  const header = (
    <div className="flex flex-col items-center gap-2 text-center">
      <BuddyAvatar size={settingUp ? 48 : 80} shape="tile" />
      <h1 className="mt-2 text-2xl font-semibold">Meet switch-buddy</h1>
      {!settingUp && (
        <p className="text-sm text-foreground-muted">Your first AI assistant in Switch</p>
      )}
    </div>
  );

  if (settingUp)
    return (
      <OnboardingSurface
        exit={exit}
        footer={
          <>
            <Button variant="outline" onClick={() => setSettingUp(false)}>
              Back
            </Button>
            <Button variant="ghost" onClick={onSkip}>
              Skip for now
            </Button>
          </>
        }
      >
        {header}
        <ProviderSetup serverId={serverId} workspaceId={workspaceId} onCreated={onCreated} />
      </OnboardingSurface>
    );

  const busy = starting !== null;
  return (
    <OnboardingSurface
      exit={exit}
      footer={
        existing ? (
          <Button onClick={() => onCreated(existing)}>Open switch-buddy</Button>
        ) : (
          <>
            <Button variant="outline" onClick={onSkip} disabled={busy}>
              Skip
            </Button>
            {ready.map((provider, index) => (
              <Button
                key={provider.id}
                variant={index === 0 ? 'default' : 'outline'}
                onClick={() => void startWith(provider.id)}
                disabled={busy}
              >
                {starting === provider.id && <Spinner className="size-3.5" />}
                Start with {provider.name}
              </Button>
            ))}
            <Button
              variant={ready.length === 0 ? 'default' : 'outline'}
              onClick={() => setSettingUp(true)}
              disabled={busy}
            >
              {ready.length === 0 ? 'Set up AI provider' : 'Use another provider'}
            </Button>
          </>
        )
      }
    >
      {header}
      <div className="mx-auto flex w-full max-w-[540px] flex-col items-start gap-3">
        <Line>
          Hey{firstName ? ` ${firstName}` : ''}! I’ll be your assistant for everything Switch.
        </Line>
        <Line>I can create new agents for you.</Line>
        <Line>Also bring your human and agent teams into different rooms.</Line>
        <Line>…and set up and manage your workflows, permissions and guardrails!</Line>
        <Line>Ready to go?</Line>
      </div>
      {/* One line, always there: what is still being checked, or why it
          failed, without the lines above moving when it changes. */}
      <div className="flex min-h-5 items-center justify-center">
        {computer.kind === 'starting' && (
          <p className="flex items-center gap-2 text-xs text-foreground-muted">
            <Spinner className="size-3" />
            Checking which AI providers this computer has…
          </p>
        )}
        {computer.kind === 'failed' && (
          <p role="alert" className="text-center text-sm text-destructive">
            {computer.error}
          </p>
        )}
      </div>
      {error && (
        <p role="alert" className="text-center text-sm text-destructive">
          {error}
        </p>
      )}
    </OnboardingSurface>
  );
});

function Line({ children }: { children: ReactNode }) {
  return (
    <p className="rounded-2xl bg-background px-4 py-3 text-sm text-foreground shadow-sm">
      {children}
    </p>
  );
}
