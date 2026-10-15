import { useState } from 'react';
import { failureText } from '@renderer/lib/errors/describe-failure';
import { rpc } from '@renderer/lib/ipc';
import { useShowModal } from '@renderer/lib/modal/modal-provider';
import { Alert, AlertAction, AlertDescription } from '@renderer/lib/ui/alert';
import { Button } from '@renderer/lib/ui/button';
import { Spinner } from '@renderer/lib/ui/spinner';
import { Switch } from '@renderer/lib/ui/switch';
import type { WorkspaceService } from '@shared/core/switch-servers/connection-catalog';
import { switchOffConfirmation, workspaceSwitchNote } from './connector-copy';
import { useReloadConnectors } from './connectors-queries';

type Outcome = { warning: string | null; error: string | null };

/**
 * A workspace admin's switch for each service. Switching one off reaches
 * other people's running sessions, so when anyone is connected or any agent
 * uses it, it asks first, naming both counts. A switch shows what the server
 * says: it never flips before the server has answered, and a failure leaves
 * it as it was.
 */
export function WorkspaceServicesSection({
  workspaceId,
  services,
}: {
  workspaceId: string;
  services: { data: WorkspaceService[] | null | undefined; error: unknown; refetch: () => void };
}) {
  const reload = useReloadConnectors(workspaceId);
  const confirm = useShowModal('confirmActionModal');
  const [pending, setPending] = useState<string | null>(null);
  const [outcomes, setOutcomes] = useState<Record<string, Outcome>>({});

  const change = async (service: WorkspaceService, enabled: boolean) => {
    setPending(service.slug);
    setOutcomes((now) => ({ ...now, [service.slug]: { warning: null, error: null } }));
    try {
      const result = await rpc.workspaces.setWorkspaceService({
        workspaceId,
        service: service.slug,
        enabled,
      });
      setOutcomes((now) => ({ ...now, [service.slug]: { warning: result.warning, error: null } }));
      await reload();
    } catch (cause) {
      setOutcomes((now) => ({
        ...now,
        [service.slug]: {
          warning: null,
          error: failureText(
            cause,
            `Could not switch ${service.name} ${enabled ? 'on' : 'off'} for the workspace.`
          ),
        },
      }));
    } finally {
      setPending(null);
    }
  };
  const flip = (service: WorkspaceService, enabled: boolean) => {
    const asked = enabled ? null : switchOffConfirmation(service);
    if (asked)
      confirm({
        title: asked.title,
        description: asked.description,
        confirmLabel: 'Switch off',
        onSuccess: () => void change(service, false),
      });
    else void change(service, enabled);
  };

  if (services.error)
    return (
      <Alert variant="destructive">
        <AlertDescription>
          {failureText(services.error, "Could not load the workspace's services.")}
        </AlertDescription>
        <AlertAction>
          <Button size="sm" variant="outline" onClick={() => services.refetch()}>
            Retry
          </Button>
        </AlertAction>
      </Alert>
    );
  if (!services.data)
    return (
      <p className="flex items-center gap-2 text-sm">
        <Spinner /> Loading the workspace&apos;s services…
      </p>
    );
  return (
    <div className="space-y-3">
      <p className="text-sm text-foreground-muted">
        Switch a service off and nobody in this workspace can connect it, grant it or use it. Agents
        that have it lose it within a minute. Grants are kept, so switching it back on returns them.
      </p>
      <div className="divide-y divide-border rounded-lg border border-border">
        {services.data.map((service) => {
          const outcome = outcomes[service.slug];
          return (
            <div key={service.slug} className="space-y-1 px-3 py-2.5">
              <div className="flex items-center gap-3">
                <div className="min-w-0 flex-1">
                  <div className="text-sm font-medium">{service.name}</div>
                  <div className="text-xs text-foreground-muted">
                    {service.connected_members} connected · {service.granted_agents}{' '}
                    {service.granted_agents === 1 ? 'agent uses' : 'agents use'} it ·{' '}
                    {workspaceSwitchNote(service, (iso) => new Date(iso).toLocaleString())}
                  </div>
                </div>
                {pending === service.slug && <Spinner />}
                <Switch
                  aria-label={`${service.name} for this workspace`}
                  checked={service.enabled}
                  disabled={pending !== null}
                  onCheckedChange={(on) => flip(service, on)}
                />
              </div>
              {outcome?.warning && (
                <p role="status" className="text-xs text-foreground-warning">
                  {outcome.warning}
                </p>
              )}
              {outcome?.error && (
                <p role="alert" className="text-xs text-destructive">
                  {outcome.error}
                </p>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
