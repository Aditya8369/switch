import { useEffect, useState } from 'react';
import { failureText } from '@renderer/lib/errors/describe-failure';
import { rpc } from '@renderer/lib/ipc';
import { useCloseGuard } from '@renderer/lib/modal/use-close-guard';
import { Button } from '@renderer/lib/ui/button';
import { Checkbox } from '@renderer/lib/ui/checkbox';
import {
  DialogContentArea,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@renderer/lib/ui/dialog';
import { Spinner } from '@renderer/lib/ui/spinner';
import type { ConnectionCatalogEntry } from '@shared/core/switch-servers/connection-catalog';
import { useConnectionAgents } from './connectors-queries';
import {
  type GrantOutcome,
  agentsUnlistedText,
  checklistRows,
  grantEach,
  grantFailureText,
  grantSuccessText,
  noAgentsText,
} from './grant-agents';

/**
 * After connecting a service a grant simply switches on: which of the
 * person's agents get it. Agents only their owner can address start ticked;
 * one others can address starts unticked, since it would act as its owner for
 * whoever addresses it.
 */
export function GrantAgentsStep({
  workspaceId,
  connection,
  warning,
  onDone,
}: {
  workspaceId: string;
  connection: ConnectionCatalogEntry;
  /** What connecting left to say, shown above the list. */
  warning: string | null;
  onDone: () => void;
}) {
  const name = connection.name;
  const agents = useConnectionAgents(workspaceId, connection.slug);
  const rows = agents.data ? checklistRows(agents.data) : null;
  const [ticked, setTicked] = useState<Set<string> | null>(null);
  const [saving, setSaving] = useState(false);
  const [outcome, setOutcome] = useState<GrantOutcome | null>(null);
  useCloseGuard(saving);
  useEffect(() => {
    if (agents.data && ticked === null)
      setTicked(
        new Set(
          checklistRows(agents.data)
            .filter((row) => row.ticked)
            .map((row) => row.agentId)
        )
      );
  }, [agents.data, ticked]);

  const toGrant = (rows ?? []).filter((row) => !row.granted && ticked?.has(row.agentId));
  const save = async () => {
    setSaving(true);
    try {
      setOutcome(
        await grantEach(
          toGrant,
          (agentId) =>
            rpc.workspaces.setServiceGrant({
              workspaceId,
              agentId,
              service: connection.slug,
              access: null,
              resources: {},
            }),
          (cause) => failureText(cause, 'Could not turn it on.')
        )
      );
      await agents.refetch();
    } finally {
      setSaving(false);
    }
  };
  const failure = outcome ? grantFailureText(name, outcome) : null;

  return (
    <>
      <DialogHeader showCloseButton={!saving}>
        <DialogTitle>Turn {name} on for your agents</DialogTitle>
      </DialogHeader>
      <DialogContentArea className="space-y-4 pt-0">
        {warning && (
          <p role="status" className="rounded-md border p-3 text-sm text-foreground-muted">
            {warning}
          </p>
        )}
        <p className="text-sm text-foreground-muted">
          An agent you turn {name} on for acts as you there, with what your connection allows.
        </p>
        {agents.isPending && (
          <p className="flex items-center gap-2 text-sm">
            <Spinner /> Loading your agents…
          </p>
        )}
        {agents.isError && (
          <p role="alert" className="text-sm text-destructive">
            {failureText(agents.error, 'Could not load your agents.')}
          </p>
        )}
        {agents.data === null && (
          <p className="text-sm text-foreground-muted">{agentsUnlistedText(name)}</p>
        )}
        {rows?.length === 0 && (
          <p className="text-sm text-foreground-muted">{noAgentsText(name)}</p>
        )}
        {rows && rows.length > 0 && (
          <div role="group" aria-label="Your agents" className="max-h-72 space-y-2 overflow-auto">
            {rows.map((row) => (
              <label key={row.agentId} className="flex items-start gap-2 text-sm">
                <Checkbox
                  className="mt-0.5"
                  checked={row.granted || (ticked?.has(row.agentId) ?? false)}
                  disabled={row.granted || saving || outcome !== null}
                  onCheckedChange={(on) =>
                    setTicked((now) => {
                      const next = new Set(now);
                      if (on) next.add(row.agentId);
                      else next.delete(row.agentId);
                      return next;
                    })
                  }
                />
                <span>
                  <span className="block">{row.name}</span>
                  {row.note && (
                    <span className="block text-xs text-foreground-muted">{row.note}</span>
                  )}
                </span>
              </label>
            ))}
          </div>
        )}
        {failure && (
          <p role="alert" className="text-sm text-destructive">
            {failure}
          </p>
        )}
        {outcome && !failure && (
          <p role="status" className="text-sm">
            {grantSuccessText(name, outcome)}
          </p>
        )}
        {outcome?.warnings.map((text) => (
          <p key={text} className="text-xs text-foreground-muted">
            {text}
          </p>
        ))}
      </DialogContentArea>
      <DialogFooter>
        {outcome || agents.data === null ? (
          <Button onClick={onDone}>Done</Button>
        ) : (
          <>
            <Button variant="ghost" disabled={saving} onClick={onDone}>
              Not now
            </Button>
            <Button disabled={saving || toGrant.length === 0} onClick={() => void save()}>
              {saving && <Spinner />}
              Turn on for {toGrant.length} {toGrant.length === 1 ? 'agent' : 'agents'}
            </Button>
          </>
        )}
      </DialogFooter>
    </>
  );
}
