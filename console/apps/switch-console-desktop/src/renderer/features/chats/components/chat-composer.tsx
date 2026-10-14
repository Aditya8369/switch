import type { Command } from '@switch-console/shared/session-v1';
import { ChevronDown, Loader2, Minimize2, Plus, RotateCcw, Users, X } from 'lucide-react';
import { observer } from 'mobx-react-lite';
import { useEffect, useRef, useState } from 'react';
import { AgentAvatar } from '@renderer/lib/components/agent-avatar';
import { failureText } from '@renderer/lib/errors/describe-failure';
import { Button } from '@renderer/lib/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from '@renderer/lib/ui/dropdown-menu';
import { Popover, PopoverContent, PopoverTitle, PopoverTrigger } from '@renderer/lib/ui/popover';
import { Tooltip, TooltipContent, TooltipTrigger } from '@renderer/lib/ui/tooltip';
import { cn } from '@renderer/utils/utils';
import { type ChatAgent, type ChatMessage, chatAgentLabel } from '@shared/core/chats/chats';
import { mentionAgentIdFor, ROOM_ONLY } from '../addressee';
import { type ContextMeter, contextBlocker, contextMeter, isCompacting } from '../chat-context';
import { snippetOf } from '../chat-threads';
import type { AgentActivity } from '../stores/chat-activity-store';
import type { ChatFile, ChatTimeline } from '../stores/chat-timeline-store';
import { chatTitler } from '../stores/chats';
import {
  PromptInput,
  PromptInputAttachments,
  PromptInputButton,
  PromptInputSubmit,
  PromptInputTextarea,
} from '../ui/prompt-input';

async function toBase64(file: File): Promise<string> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = '';
  for (let at = 0; at < bytes.length; at += 0x8000)
    binary += String.fromCharCode(...bytes.subarray(at, at + 0x8000));
  return btoa(binary);
}

function chatFile(file: File): ChatFile {
  return { name: file.name, type: file.type, size: file.size, read: () => toBase64(file) };
}

/** Drafts by chat, so a draft outlives navigating away. */
const drafts = new Map<string, string>();

/** Chats just created here, whose composer takes focus when it first shows. */
const focusOnOpen = new Set<string>();

export function focusComposerWhenOpened(roomId: string): void {
  focusOnOpen.add(roomId);
}

/** Why Stop cannot be used on the running turn, or null when it can. */
function stopBlocker(activity: AgentActivity | null): string | null {
  if (!activity?.session) return null;
  if (!activity.session.capabilities.interrupt)
    return "This agent's provider cannot be interrupted from here.";
  if (!activity.view?.connected) return "Reconnecting to the agent's session...";
  if (activity.client?.hasPendingCommand())
    return 'Waiting for the previous command to be confirmed.';
  return null;
}

function ContextDonut({ meter }: { meter: ContextMeter }) {
  return (
    <Tooltip>
      <TooltipTrigger render={<span className="flex" aria-label={meter.label} />}>
        <svg viewBox="0 0 16 16" className="size-3.5 -rotate-90" aria-hidden>
          <circle cx="8" cy="8" r="6" fill="none" strokeWidth="2.5" className="stroke-border" />
          {meter.fraction !== null && (
            <circle
              cx="8"
              cy="8"
              r="6"
              fill="none"
              strokeWidth="2.5"
              pathLength={100}
              strokeDasharray={`${meter.fraction * 100} 100`}
              className={meter.warning ? 'stroke-foreground-warning' : 'stroke-foreground-muted'}
            />
          )}
        </svg>
      </TooltipTrigger>
      <TooltipContent>{meter.label}</TooltipContent>
    </Tooltip>
  );
}

/**
 * The chat's composer. Sending posts the message to the room and nothing
 * else: which session answers, and starting or waking it, is up to the
 * agent's host. The model picker and Stop act on the selected agent's own
 * session, and are offered only as far as that session says they work.
 */
export const ChatComposer = observer(function ChatComposer({
  serverId,
  timeline,
  agents,
  activity,
  selectedAgentId,
  onSelectAgent,
  replyTo,
  onClearReply,
  disabled,
}: {
  serverId: string;
  timeline: ChatTimeline;
  agents: ChatAgent[];
  /** The selected agent's activity, or the chat's own agent's when room-only. */
  activity: AgentActivity | null;
  /** An agent id, `ROOM_ONLY`, or null for the chat's first agent. */
  selectedAgentId: string | null;
  onSelectAgent: (agentId: string) => void;
  replyTo: ChatMessage | null;
  onClearReply: () => void;
  disabled: string | null;
}) {
  const draftKey = `${serverId}\u0000${timeline.roomId}`;
  const [draft, setDraft] = useState(() => drafts.get(draftKey) ?? '');
  useEffect(() => {
    drafts.set(draftKey, draft);
  }, [draftKey, draft]);
  const [files, setFiles] = useState<{ id: string; file: File }[]>([]);
  const [controlError, setControlError] = useState<string | null>(null);
  const [stopping, setStopping] = useState(false);
  const [confirmReset, setConfirmReset] = useState(false);
  const [contextOpen, setContextOpen] = useState(false);
  const picker = useRef<HTMLInputElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    // After the modal's own focus restore, which also runs on the next frame.
    if (focusOnOpen.delete(timeline.roomId)) requestAnimationFrame(() => input.current?.focus());
  }, [timeline.roomId]);
  const roomOnly = agents.length > 1 && selectedAgentId === ROOM_ONLY;
  const selected = roomOnly
    ? null
    : (agents.find((agent) => agent.id === selectedAgentId) ?? agents[0] ?? null);
  const session = activity?.session ?? null;
  const runningTurn = activity?.runningTurn ?? null;

  const addFiles = (list: File[]) => {
    if (!list.length) return;
    setFiles((current) => [...current, ...list.map((file) => ({ id: crypto.randomUUID(), file }))]);
  };

  const send = () => {
    const body = draft.trim();
    if (disabled || (!body && !files.length)) return;
    timeline.send({
      body,
      threadRootId: replyTo?.messageId ?? null,
      mentionAgentId: mentionAgentIdFor(agents, selectedAgentId),
      files: files.map(({ file }) => chatFile(file)),
    });
    void chatTitler.sent(serverId, timeline.roomId, body);
    setDraft('');
    setFiles([]);
    onClearReply();
  };

  const execute = async (body: Command['body']) => {
    if (!activity?.client) return;
    setControlError(null);
    try {
      await activity.client.execute(body, crypto.randomUUID());
    } catch (error) {
      setControlError(failureText(error, "The agent's session did not take the command."));
    }
  };

  const stop = async () => {
    if (!runningTurn) return;
    setStopping(true);
    await execute({ type: 'turn.interrupt', turnId: runningTurn.turnId });
    setStopping(false);
  };

  const blocker = stopBlocker(activity);
  const showStop = Boolean(runningTurn) && !draft.trim() && !files.length;
  const status = stopping ? 'sending' : showStop ? 'running' : 'idle';
  const contextBlocked =
    session && activity?.client
      ? contextBlocker({
          connected: Boolean(activity.view?.connected),
          session,
          pendingCommand: activity.client.hasPendingCommand(),
          working: activity.working,
        })
      : null;
  const meter = contextMeter(session?.context);
  const compacting = session ? isCompacting(session, activity?.view?.notices ?? []) : false;
  const unknownCommands =
    activity?.view?.snapshot?.commandStatuses.filter((each) => each.status === 'unknown') ?? [];

  return (
    <div className="mx-auto w-full max-w-[860px] px-5 pb-1.5">
      {unknownCommands.length > 0 && (
        <p role="status" className="mb-2 text-xs text-foreground-muted">
          Not confirmed: Switch couldn't confirm whether an earlier action finished. It won't run
          that action again automatically.
        </p>
      )}
      {controlError && (
        <p role="alert" className="mb-2 text-sm text-foreground-destructive">
          {controlError}
        </p>
      )}
      {replyTo && (
        <div className="mb-2 flex items-center gap-2 rounded-md border border-border px-3 py-1.5 text-xs text-foreground-muted">
          <span className="min-w-0 flex-1 truncate">
            Replying to {replyTo.sender.name}: {snippetOf(replyTo)}
          </span>
          <button type="button" aria-label="Cancel reply" onClick={onClearReply}>
            <X className="size-3.5" />
          </button>
        </div>
      )}
      <div
        onDragOver={(event) => {
          if (event.dataTransfer.types.includes('Files')) event.preventDefault();
        }}
        onDrop={(event) => {
          if (!event.dataTransfer.files.length) return;
          event.preventDefault();
          addFiles(Array.from(event.dataTransfer.files));
        }}
        onPaste={(event) => {
          if (!event.clipboardData.files.length) return;
          event.preventDefault();
          addFiles(Array.from(event.clipboardData.files));
        }}
      >
        <PromptInput
          onSubmit={send}
          className="rounded-[20px] border-(--composer-border) bg-background-1/50 shadow-(--composer-shadow) duration-200 focus-within:border-(--composer-border-focus)"
        >
          <PromptInputAttachments
            items={files.map(({ id, file }) => ({ id, name: file.name, mediaType: file.type }))}
            onRemove={(id) => setFiles((current) => current.filter((each) => each.id !== id))}
          />
          <div className="flex items-end gap-1 p-2">
            <PromptInputButton
              tooltip="Attach files"
              className="size-8 rounded-full"
              disabled={disabled !== null}
              onClick={() => picker.current?.click()}
            >
              <Plus className="size-4" />
            </PromptInputButton>
            <input
              ref={picker}
              type="file"
              multiple
              className="hidden"
              aria-label="Choose attachments"
              onChange={(event) => {
                addFiles(Array.from(event.target.files ?? []));
                event.target.value = '';
              }}
            />
            <PromptInputTextarea
              ref={input}
              className="min-h-0 px-1 py-1.5"
              aria-label={`Message ${selected ? chatAgentLabel(selected) : 'the room'}`}
              placeholder={
                disabled ?? `Message ${selected ? chatAgentLabel(selected) : 'the room'}...`
              }
              value={draft}
              disabled={disabled !== null}
              onChange={(event) => setDraft(event.target.value)}
            />
            <PromptInputSubmit
              status={status}
              className="h-8 min-w-8"
              onStop={() => void stop()}
              stopDisabledReason={blocker}
              disabled={disabled !== null || (!showStop && !draft.trim() && !files.length)}
            />
          </div>
        </PromptInput>
        <div className="mt-1.5 flex min-h-7 items-center justify-between gap-1 px-2">
          <div className="flex min-w-0 items-center gap-1">
            {agents.length > 1 && (
              <DropdownMenu>
                <DropdownMenuTrigger
                  render={<Button variant="ghost" size="sm" />}
                  className="h-7 gap-1.5 px-2 text-xs font-normal text-foreground-muted"
                  aria-label="Agent to address"
                >
                  {selected ? (
                    <>
                      <AgentAvatar
                        name={chatAgentLabel(selected)}
                        iconUrl={selected.iconUrl}
                        size={14}
                      />
                      {chatAgentLabel(selected)}
                    </>
                  ) : (
                    <>
                      <Users className="size-3.5" />
                      Room only
                    </>
                  )}
                </DropdownMenuTrigger>
                <DropdownMenuContent align="start">
                  <DropdownMenuRadioGroup
                    value={selected?.id ?? ROOM_ONLY}
                    onValueChange={(value) => onSelectAgent(String(value))}
                  >
                    {agents.map((agent) => (
                      <DropdownMenuRadioItem key={agent.id} value={agent.id}>
                        {chatAgentLabel(agent)}
                      </DropdownMenuRadioItem>
                    ))}
                    <DropdownMenuRadioItem value={ROOM_ONLY}>
                      Room only (no agent)
                    </DropdownMenuRadioItem>
                  </DropdownMenuRadioGroup>
                </DropdownMenuContent>
              </DropdownMenu>
            )}
          </div>
          {session && activity?.client && (
            <Popover
              open={contextOpen}
              onOpenChange={(open) => {
                setContextOpen(open);
                setConfirmReset(false);
              }}
            >
              <PopoverTrigger
                render={<Button variant="ghost" size="sm" />}
                className={cn(
                  'h-7 gap-1.5 rounded-md px-2 text-xs font-normal text-foreground-muted',
                  meter?.warning && 'text-foreground-warning'
                )}
                aria-label="Context actions"
              >
                {compacting ? (
                  <Loader2 className="size-3.5 animate-spin" />
                ) : (
                  meter && <ContextDonut meter={meter} />
                )}
                {compacting ? 'Compacting…' : meter ? `Context ${meter.used}` : 'Context'}
                <ChevronDown className="size-3" />
              </PopoverTrigger>
              <PopoverContent
                side="top"
                align="end"
                className="w-80 max-w-[calc(100vw-2rem)] gap-2 p-3"
              >
                <PopoverTitle>
                  {confirmReset ? 'Start a fresh conversation?' : 'Conversation context'}
                </PopoverTitle>
                {confirmReset ? (
                  <>
                    <p className="text-xs text-foreground-muted">
                      The agent starts with a fresh context. Earlier messages stay in the transcript
                      as history.
                    </p>
                    <div className="flex justify-end gap-2 pt-2">
                      <Button size="sm" variant="ghost" onClick={() => setConfirmReset(false)}>
                        Cancel
                      </Button>
                      <Button
                        size="sm"
                        disabled={contextBlocked !== null || !session.capabilities.reset}
                        onClick={() => {
                          setContextOpen(false);
                          setConfirmReset(false);
                          void execute({ type: 'session.reset' });
                        }}
                      >
                        Start fresh
                      </Button>
                    </div>
                  </>
                ) : (
                  <>
                    <Button
                      variant="ghost"
                      disabled={contextBlocked !== null || !session.capabilities.compact}
                      className="h-auto justify-start gap-3 px-2 py-2 text-left"
                      onClick={() => {
                        setContextOpen(false);
                        void execute({ type: 'session.compact' });
                      }}
                    >
                      <Minimize2 className="size-4 shrink-0" />
                      <span>
                        <span className="block">Compact context</span>
                        <span className="block text-xs font-normal text-foreground-muted">
                          {session.capabilities.compact
                            ? 'Free up space in this conversation'
                            : 'Native compaction is unavailable'}
                        </span>
                      </span>
                    </Button>
                    <Button
                      variant="ghost"
                      disabled={contextBlocked !== null || !session.capabilities.reset}
                      className="h-auto justify-start gap-3 px-2 py-2 text-left"
                      onClick={() => setConfirmReset(true)}
                    >
                      <RotateCcw className="size-4 shrink-0" />
                      <span>
                        <span className="block">Reset context...</span>
                        <span className="block text-xs font-normal text-foreground-muted">
                          {session.capabilities.reset
                            ? 'Start fresh and keep transcript history'
                            : 'Reset is unavailable for this session'}
                        </span>
                      </span>
                    </Button>
                    {contextBlocked && (
                      <p className="text-xs text-foreground-muted">{contextBlocked}</p>
                    )}
                    <p className="border-t border-border pt-2 text-xs text-foreground-muted">
                      Skills and MCP load from the execution host. Restart the host while idle after
                      changing their configuration.
                    </p>
                  </>
                )}
              </PopoverContent>
            </Popover>
          )}
        </div>
      </div>
    </div>
  );
});
