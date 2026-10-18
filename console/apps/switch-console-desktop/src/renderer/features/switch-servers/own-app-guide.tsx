import { useQuery } from '@tanstack/react-query';
import { CircleCheck, CircleX, ExternalLink } from 'lucide-react';
import { type ReactNode, useEffect, useState } from 'react';
import { failureText } from '@renderer/lib/errors/describe-failure';
import { rpc } from '@renderer/lib/ipc';
import { openExternalUrl } from '@renderer/lib/open-external';
import { Button } from '@renderer/lib/ui/button';
import { Spinner } from '@renderer/lib/ui/spinner';
import { cn } from '@renderer/utils/utils';

/** The platforms whose own-app setup Console walks through. */
export const GUIDED_PLATFORMS = ['slack', 'discord'] as const;
export type GuidedPlatform = (typeof GUIDED_PLATFORMS)[number];

export function isGuidedPlatform(key: string | null | undefined): key is GuidedPlatform {
  return GUIDED_PLATFORMS.includes(key as GuidedPlatform);
}

/** The fields the guide fills in itself, which the form does not ask for. */
export const GUIDE_FILLED_FIELDS: Record<GuidedPlatform, readonly string[]> = {
  slack: ['workspace_id'],
  discord: ['guild_id'],
};

const DISCORD_PORTAL = 'https://discord.com/developers/applications';

/** How long to wait after typing stops before checking a token. */
const CHECK_DELAY_MS = 600;
/** How often a Discord token is read again while its setup is unfinished. */
const DISCORD_POLL_MS = 4000;

type Props = {
  workspaceId: string;
  config: Record<string, string | boolean>;
  /** Fill in, or clear with null, a field the guide works out itself. */
  setField: (key: string, value: string | null) => void;
};

/**
 * Creating a Slack or Discord app of your own, one step at a time, with the
 * parts Console can do done for you: the Slack app comes pre-filled from this
 * server, the tokens are checked as they are pasted, and the workspace or
 * server id is read from them rather than copied by hand.
 */
export function OwnAppGuide({ platform, ...props }: Props & { platform: GuidedPlatform }) {
  return platform === 'slack' ? <SlackGuide {...props} /> : <DiscordGuide {...props} />;
}

function Step({ n, done, children }: { n: number; done?: boolean; children: ReactNode }) {
  return (
    <li className="flex gap-3">
      <span
        className={cn(
          'mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full border text-[11px] font-medium',
          done ? 'border-transparent bg-foreground-success text-background' : 'border-border'
        )}
      >
        {done ? '✓' : n}
      </span>
      <div className="min-w-0 flex-1 space-y-1.5 text-sm text-foreground">{children}</div>
    </li>
  );
}

function Status({ ok, children }: { ok: boolean; children: ReactNode }) {
  return (
    <p
      className={cn(
        'flex items-start gap-1.5 text-xs',
        ok ? 'text-foreground' : 'text-destructive'
      )}
    >
      {ok ? (
        <CircleCheck className="mt-px size-3.5 shrink-0 text-foreground-success" />
      ) : (
        <CircleX className="mt-px size-3.5 shrink-0" />
      )}
      <span>{children}</span>
    </p>
  );
}

function text(config: Props['config'], key: string): string {
  const value = config[key];
  return typeof value === 'string' ? value.trim() : '';
}

/** `value`, once it has stopped changing for a moment. */
function useSettled<T>(value: T): T {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setSettled(value), CHECK_DELAY_MS);
    return () => clearTimeout(timer);
  }, [value]);
  return settled;
}

function SlackGuide({ workspaceId, config, setField }: Props) {
  const setup = useQuery({
    queryKey: ['slack-own-app-setup', workspaceId],
    queryFn: () => rpc.workspaces.slackOwnAppSetup(workspaceId),
  });
  const botToken = useSettled(text(config, 'bot_token'));
  const appToken = useSettled(text(config, 'app_token'));
  const ready = botToken.length > 0 && appToken.length > 0;
  const check = useQuery({
    queryKey: ['slack-own-app-check', workspaceId, botToken, appToken],
    queryFn: () => rpc.workspaces.checkSlackTokens({ workspaceId, botToken, appToken }),
    enabled: ready,
    retry: false,
    gcTime: 0,
  });

  useEffect(() => {
    setField('workspace_id', check.data?.workspaceId ?? null);
  }, [check.data, setField]);

  return (
    <ol className="space-y-3 rounded-lg border border-border bg-background-1 p-3">
      <Step n={1} done={ready}>
        <p>Create the app in Slack. It opens already set up for this server.</p>
        <Button
          size="sm"
          variant="outline"
          disabled={!setup.data}
          onClick={() =>
            setup.data && void openExternalUrl(setup.data.createUrl, 'Could not open Slack')
          }
        >
          {setup.isPending && <Spinner className="size-3.5" />}
          Create the Slack app
          <ExternalLink className="size-3.5" />
        </Button>
        <p className="text-xs text-foreground-muted">
          Pick your workspace, click Next, then Create.
        </p>
        {setup.isError && (
          <Status ok={false}>{failureText(setup.error, 'Could not prepare the Slack app.')}</Status>
        )}
      </Step>
      <Step n={2} done={botToken.length > 0}>
        <p>
          In Slack, open <b>Install App</b>, click <b>Install to your workspace</b> and allow it.
          Copy the <b>Bot User OAuth Token</b> (xoxb-…) into <b>Bot token</b> below.
        </p>
      </Step>
      <Step n={3} done={appToken.length > 0}>
        <p>
          Open <b>Basic Information</b>, and under <b>App-Level Tokens</b> click{' '}
          <b>Generate Token and Scopes</b>. Add the <b>connections:write</b> scope, generate, and
          copy the token (xapp-…) into <b>App-level token</b> below.
        </p>
      </Step>
      {ready && check.isFetching && (
        <p className="flex items-center gap-1.5 text-xs text-foreground-muted">
          <Spinner className="size-3" /> Checking the tokens with Slack…
        </p>
      )}
      {ready && check.data && !check.isFetching && (
        <Status ok>
          Both tokens work, for the <b>{check.data.workspaceName}</b> workspace.
        </Status>
      )}
      {ready && check.isError && !check.isFetching && (
        <Status ok={false}>{failureText(check.error, 'Could not check the tokens.')}</Status>
      )}
    </ol>
  );
}

function DiscordGuide({ workspaceId, config, setField }: Props) {
  const botToken = useSettled(text(config, 'bot_token'));
  const [chosen, setChosen] = useState<string | null>(null);
  const check = useQuery({
    queryKey: ['discord-own-app-check', workspaceId, botToken],
    queryFn: () => rpc.workspaces.checkDiscordToken({ workspaceId, botToken }),
    enabled: botToken.length > 0,
    retry: false,
    gcTime: 0,
    // Read again while setup is unfinished: the intents are switched on, and
    // the bot added to a server, in Discord, which tells Console nothing.
    refetchInterval: (query) => {
      const data = query.state.data;
      if (!data) return false;
      return data.messageContent && data.serverMembers && data.servers.length > 0
        ? false
        : DISCORD_POLL_MS;
    },
  });
  const data = check.data;
  const intentsOn = !!data && data.messageContent && data.serverMembers;
  const servers = data?.servers ?? [];
  const server =
    servers.length === 1 ? servers[0]! : (servers.find((s) => s.id === chosen) ?? null);

  useEffect(() => {
    setField('guild_id', intentsOn && server ? server.id : null);
  }, [intentsOn, server, setField]);

  return (
    <ol className="space-y-3 rounded-lg border border-border bg-background-1 p-3">
      <Step n={1} done={!!data}>
        <p>
          Create an application in Discord: <b>New Application</b>, give it a name, then on{' '}
          <b>Bot</b> click <b>Reset Token</b> and copy it into <b>Bot token</b> below.
        </p>
        <Button
          size="sm"
          variant="outline"
          onClick={() => void openExternalUrl(DISCORD_PORTAL, 'Could not open Discord')}
        >
          Open the Discord developer portal
          <ExternalLink className="size-3.5" />
        </Button>
        {botToken.length > 0 && check.isError && (
          <Status ok={false}>{failureText(check.error, 'Could not check the token.')}</Status>
        )}
        {data && <Status ok>Found the application {data.name}.</Status>}
      </Step>
      <Step n={2} done={intentsOn}>
        <p>
          On the same <b>Bot</b> page, turn on <b>Server Members Intent</b> and{' '}
          <b>Message Content Intent</b>, then <b>Save Changes</b>.
        </p>
        {data && (
          <div className="space-y-1">
            <Status ok={data.serverMembers}>Server Members Intent</Status>
            <Status ok={data.messageContent}>Message Content Intent</Status>
          </div>
        )}
      </Step>
      <Step n={3} done={intentsOn && !!server}>
        <p>Add the bot to your Discord server, with the permissions Switch needs.</p>
        <Button
          size="sm"
          variant="outline"
          disabled={!intentsOn}
          onClick={() => data && void openExternalUrl(data.inviteUrl, 'Could not open Discord')}
        >
          Add the bot to your server
          <ExternalLink className="size-3.5" />
        </Button>
        {intentsOn && servers.length === 0 && (
          <p className="flex items-center gap-1.5 text-xs text-foreground-muted">
            <Spinner className="size-3" /> Waiting for the bot to join a server…
          </p>
        )}
        {intentsOn && servers.length > 1 && (
          <div className="space-y-1">
            <p className="text-xs text-foreground-muted">
              The bot is in several servers. Pick one:
            </p>
            {servers.map((each) => (
              <label key={each.id} className="flex cursor-pointer items-center gap-2 text-sm">
                <input
                  type="radio"
                  name="discord-server"
                  checked={chosen === each.id}
                  onChange={() => setChosen(each.id)}
                />
                {each.name}
              </label>
            ))}
          </div>
        )}
        {intentsOn && server && <Status ok>Added to {server.name}.</Status>}
      </Step>
    </ol>
  );
}
