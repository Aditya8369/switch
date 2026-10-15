import { useState } from 'react';
import { ManagedGitHubStep } from '@renderer/features/switch-servers/managed-github-step';
import { ServiceConnectStep } from '@renderer/features/switch-servers/service-connect-step';
import { ServiceKeyStep } from '@renderer/features/switch-servers/service-key-step';
import type { BaseModalProps } from '@renderer/lib/modal/modal-provider';
import type { ConnectionCatalogEntry } from '@shared/core/switch-servers/connection-catalog';
import { offersChecklist } from './grant-agents';
import { GrantAgentsStep } from './grant-agents-step';

/**
 * Connecting one service from its Connectors profile: GitHub's own step, a key
 * form, or the generic sign-in, as the catalog entry calls for. Once a service
 * a grant simply switches on is connected, it moves on to turning it on for
 * the person's agents; `startAt: 'grant'` opens straight there.
 */
export function ConnectServiceModal({
  serverId,
  workspaceId,
  connection,
  startAt,
  onClose,
}: {
  serverId: string;
  workspaceId: string;
  connection: ConnectionCatalogEntry;
  startAt: 'connect' | 'grant';
} & BaseModalProps) {
  const [step, setStep] = useState(startAt);
  const [warning, setWarning] = useState<string | null>(null);
  const connected = (result: string | null) => {
    if (!offersChecklist(connection)) return;
    setWarning(result);
    setStep('grant');
  };

  if (step === 'grant')
    return (
      <GrantAgentsStep
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
        serverId={serverId}
        connection={connection}
        form={connection.key}
        onBack={onClose}
        onConnected={connected}
      />
    );
  return (
    <ServiceConnectStep
      serverId={serverId}
      connection={connection}
      onBack={onClose}
      onConnected={connected}
    />
  );
}
