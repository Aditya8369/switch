import { useState } from 'react';
import { ManagedGitHubStep } from '@renderer/features/switch-servers/managed-github-step';
import {
  type ServiceCalls,
  workspaceServiceCalls,
} from '@renderer/features/switch-servers/service-calls';
import {
  ServiceConnectStep,
  ServiceSignInStep,
} from '@renderer/features/switch-servers/service-connect-step';
import { ServiceKeyStep } from '@renderer/features/switch-servers/service-key-step';
import type { BaseModalProps } from '@renderer/lib/modal/modal-provider';
import type { ConnectionCatalogEntry } from '@shared/core/switch-servers/connection-catalog';
import { type GrantOutcome, connectButtonLabel, offersPicker } from './grant-agents';
import { AgentPicker, ConnectedStep, GrantAgentsStep, useAgentPicker } from './grant-agents-step';

/**
 * Connecting one service from its Connectors profile: GitHub's own step, a key
 * form, or the generic sign-in, as the catalog entry calls for. A service a
 * grant simply switches on is turned on for the person's agents as it is
 * connected: on the signed-in screen for a sign-in, and on a second screen
 * after a key. `startAt: 'grant'` opens straight on that second screen, and
 * `startAt: 'replace'` on the form that replaces a connected key, which keeps
 * every agent's access and so is followed by no picker.
 */
export function ConnectServiceModal({
  serverId,
  workspaceId,
  connection,
  startAt,
  onConnected,
  onClose,
}: {
  serverId: string;
  workspaceId: string;
  connection: ConnectionCatalogEntry;
  startAt: 'connect' | 'grant' | 'replace';
  /** Runs as soon as the service is connected, before the dialog closes. */
  onConnected: () => void;
} & BaseModalProps) {
  const [step, setStep] = useState<'connect' | 'grant' | 'replace'>(startAt);
  const calls = workspaceServiceCalls(workspaceId);
  const [warning, setWarning] = useState<string | null>(null);
  const keyConnected = (result: string | null) => {
    onConnected();
    if (!offersPicker(connection)) return;
    setWarning(result);
    setStep('grant');
  };

  if (startAt === 'replace' && connection.key)
    return (
      <ServiceKeyStep
        calls={calls}
        connection={connection}
        form={connection.key}
        replacing
        onBack={onClose}
        onConnected={() => onConnected()}
      />
    );
  if (step === 'grant')
    return (
      <GrantAgentsStep
        serverId={serverId}
        workspaceId={workspaceId}
        connection={connection}
        warning={warning}
        onDone={onClose}
      />
    );
  if (connection.slug === 'github')
    return <ManagedGitHubStep serverId={serverId} onBack={onClose} />;
  if (connection.key)
    return (
      <ServiceKeyStep
        calls={calls}
        connection={connection}
        form={connection.key}
        replacing={false}
        onBack={onClose}
        onConnected={keyConnected}
      />
    );
  if (offersPicker(connection))
    return (
      <SignInAndTurnOn
        calls={calls}
        serverId={serverId}
        workspaceId={workspaceId}
        connection={connection}
        onConnected={onConnected}
        onDone={onClose}
      />
    );
  return (
    <ServiceConnectStep
      calls={calls}
      connection={connection}
      onBack={onClose}
      onConnected={onConnected}
    />
  );
}

/**
 * One screen once the browser has signed in: the account, the picker, and
 * one button that confirms the account with Switch and then turns the service
 * on for each agent picked. A refused confirm turns nothing on.
 */
function SignInAndTurnOn({
  calls,
  serverId,
  workspaceId,
  connection,
  onConnected,
  onDone,
}: {
  calls: ServiceCalls;
  serverId: string;
  workspaceId: string;
  connection: ConnectionCatalogEntry;
  onConnected: () => void;
  onDone: () => void;
}) {
  const picker = useAgentPicker(workspaceId, connection);
  const [done, setDone] = useState<{ warning: string | null; outcome: GrantOutcome } | null>(null);
  if (done)
    return (
      <ConnectedStep
        connection={connection}
        warning={done.warning}
        outcome={done.outcome}
        onDone={onDone}
      />
    );
  return (
    <ServiceSignInStep
      calls={calls}
      connection={connection}
      onBack={onDone}
      readyContent={(busy) => (
        <>
          <p className="text-sm text-foreground-muted">
            An agent you turn {connection.name} on for acts as you there, with what your connection
            allows.
          </p>
          <AgentPicker
            name={connection.name}
            serverId={serverId}
            workspaceId={workspaceId}
            picker={picker}
            disabled={busy}
          />
        </>
      )}
      confirmLabel={() => connectButtonLabel(picker.toGrant.length)}
      onConnected={async (warning) => {
        onConnected();
        setDone({ warning, outcome: await picker.grant() });
      }}
    />
  );
}
