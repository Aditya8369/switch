import { makeAutoObservable, observable, runInAction } from 'mobx';
import { failureText } from '@renderer/lib/errors/describe-failure';
import type {
  ChatActivityItem,
  ChatActivityTarget,
  ChatApproval,
  ChatApprovalAnswer,
  ChatControlCommand,
  RoomActivity,
} from '@shared/core/chats/activity';
import type { ReasoningList, ReasoningTurn, ToolDetail } from '@shared/core/sessions/reasoning';
import { bindTurns, groupTurns, itemKey, type TurnActivity } from '../activity-join';
import { chatFailure } from './chat-errors';

/**
 * What one agent is doing in one chat, from Switch's activity feed: the
 * steps of its turns and the requests it put to people, joined to the room
 * messages that started them. Snapshots and live rows are merged by
 * revision, so a row older than the one held is dropped whichever arrives
 * first.
 *
 * Stop, Reset and Compact are posted to the room as commands; the agent
 * answers each in a thread rooted at the command. Reasoning and full tool
 * input and output are read from the agent's session host when it runs on
 * this machine or its SSH host — the only thing the host is asked for.
 */

export type ActivityApi = {
  resolve: (serverId: string, agentId: string, roomId: string) => Promise<ChatActivityTarget>;
  reasoning: (
    hostAgentKey: string,
    sessionId: string,
    turnIds: string[] | null
  ) => Promise<ReasoningList | null>;
  /** Call `onChange` whenever the server's local or SSH placements change. */
  watchPlacements: (serverId: string, onChange: () => void) => () => void;
  roomActivity: (serverId: string, roomId: string) => Promise<RoomActivity>;
  control: (input: {
    serverId: string;
    roomId: string;
    requestId: string;
    agentId: string;
    command: ChatControlCommand;
  }) => Promise<string>;
  answerApproval: (input: {
    serverId: string;
    agentId: string;
    sessionId: string;
    requestId: string;
    answer: ChatApprovalAnswer;
  }) => Promise<ChatApproval>;
};

/** A Stop, Reset or Compact sent from here: `requested` once Switch posted it, not once done. */
export type ControlRequest = {
  requestId: string;
  command: ChatControlCommand;
  state: 'sending' | 'requested' | 'failed';
  /** The room message the command is; the agent's answer threads under it. */
  commandId: string | null;
  error: string | null;
};

const approvalKey = (approval: ChatApproval) =>
  JSON.stringify([approval.sessionId, approval.requestId]);

export class AgentActivity {
  target: ChatActivityTarget | null = null;
  resolveError: string | null = null;
  /** Why the room's activity snapshot could not be read; null once it has been. */
  feedError: string | null = null;
  readonly items = observable.map<string, ChatActivityItem>({}, { deep: false });
  readonly approvals = observable.map<string, ChatApproval>({}, { deep: false });
  controls: ControlRequest[] = [];
  reasoning = new Map<string, ReasoningTurn>();
  /** Tool item id → what the call was given and gave back; local and SSH hosts only. */
  toolDetails = new Map<string, ToolDetail>();
  private resolving = false;

  constructor(
    readonly serverId: string,
    readonly tenantId: string | null,
    readonly roomId: string,
    readonly agentId: string,
    private readonly api: ActivityApi
  ) {
    makeAutoObservable<AgentActivity, 'api' | 'resolving'>(this, {
      api: false,
      resolving: false,
      target: observable.ref,
    });
  }

  /** Take a row of this agent in this room, unless one at least as new is held. */
  applyItem(item: ChatActivityItem): void {
    if (item.agentId !== this.agentId || item.roomId !== this.roomId) return;
    const key = itemKey(item);
    const held = this.items.get(key);
    if (held && held.revision >= item.revision) return;
    this.items.set(key, item);
  }

  /** Take a request of this agent in this room; a settled one is never reopened by an older copy. */
  applyApproval(approval: ChatApproval): void {
    if (approval.agentId !== this.agentId || approval.roomId !== this.roomId) return;
    const key = approvalKey(approval);
    const held = this.approvals.get(key);
    if (held && held.state !== 'open' && approval.state === 'open') return;
    this.approvals.set(key, approval);
  }

  applySnapshot(snapshot: RoomActivity): void {
    this.feedError = null;
    for (const item of snapshot.items) this.applyItem(item);
    for (const approval of snapshot.approvals) this.applyApproval(approval);
  }

  get allTurns(): TurnActivity[] {
    return groupTurns(this.items.values(), this.approvals.values());
  }

  /** Turns joined to the room messages that started them. */
  get bound(): Map<string, TurnActivity> {
    return bindTurns(this.allTurns, this.roomId);
  }

  turns(): Map<string, TurnActivity> {
    return this.bound;
  }

  /** The turn running now, which Stop interrupts. */
  get runningTurn(): TurnActivity | null {
    return this.allTurns.findLast((turn) => turn.status === 'running') ?? null;
  }

  get working(): boolean {
    return this.allTurns.some((turn) => turn.status === 'running' || turn.status === 'queued');
  }

  /** A Stop, Reset or Compact still being posted. */
  get pendingControl(): ControlRequest | null {
    return this.controls.findLast((control) => control.state === 'sending') ?? null;
  }

  async resolve(): Promise<void> {
    if (this.resolving) return;
    this.resolving = true;
    try {
      const target = await this.api.resolve(this.serverId, this.agentId, this.roomId);
      runInAction(() => {
        this.resolveError = null;
        this.target = target;
      });
    } catch (error) {
      runInAction(() => {
        this.resolveError = failureText(error, "The agent's session could not be looked up.");
      });
    } finally {
      this.resolving = false;
    }
  }

  /** Post a command to the room for this agent; the request id stays with it. */
  async control(command: ChatControlCommand): Promise<void> {
    const control: ControlRequest = {
      requestId: crypto.randomUUID(),
      command,
      state: 'sending',
      commandId: null,
      error: null,
    };
    this.controls.push(control);
    const held = this.controls.at(-1)!;
    try {
      const commandId = await this.api.control({
        serverId: this.serverId,
        roomId: this.roomId,
        requestId: control.requestId,
        agentId: this.agentId,
        command,
      });
      runInAction(() => {
        held.state = 'requested';
        held.commandId = commandId;
      });
    } catch (error) {
      runInAction(() => {
        held.state = 'failed';
        held.error = chatFailure(error).message;
      });
    }
  }

  dismissControl(requestId: string): void {
    this.controls = this.controls.filter((control) => control.requestId !== requestId);
  }

  /** Answer a request as the signed-in person; the answered copy replaces the held one. */
  async answer(approval: ChatApproval, answer: ChatApprovalAnswer): Promise<void> {
    const answered = await this.api.answerApproval({
      serverId: this.serverId,
      agentId: approval.agentId,
      sessionId: approval.sessionId,
      requestId: approval.requestId,
      answer,
    });
    runInAction(() => this.applyApproval(answered));
  }

  /** Ask the host for the reasoning and tool details of these turns; local and SSH hosts only. */
  async readReasoning(turns: TurnActivity[]): Promise<void> {
    const target = this.target;
    if (target?.kind !== 'session' || target.target === 'controller') return;
    const turnIds = turns
      .filter((turn) => turn.sessionId === target.sessionId)
      .map((turn) => turn.turnId);
    if (!turnIds.length) return;
    const list = await this.api.reasoning(target.hostAgentKey, target.sessionId, turnIds);
    runInAction(() => {
      if (!list) return;
      for (const turn of list.turns) this.reasoning.set(turn.turnId, turn);
      for (const turn of list.tools ?? [])
        for (const tool of turn.tools) this.toolDetails.set(tool.itemId, tool);
    });
  }
}

/** Activities by server, room and agent, shared by the views showing them. */
export class AgentActivities {
  /** Observable so a view that only peeks (the chat's title bar) follows the one holding it. */
  private readonly entries = observable.map<string, { activity: AgentActivity; users: number }>(
    {},
    { deep: false }
  );
  private readonly watches = new Map<string, () => void>();
  /** Rooms whose snapshot is due, read once per room however many agents asked. */
  private readonly due = new Set<string>();

  constructor(private readonly api: ActivityApi) {}

  private syncWatches(): void {
    const servers = new Set([...this.entries.values()].map(({ activity }) => activity.serverId));
    for (const serverId of servers)
      if (!this.watches.has(serverId))
        this.watches.set(
          serverId,
          this.api.watchPlacements(serverId, () => this.refresh(serverId, null))
        );
    for (const [serverId, off] of this.watches)
      if (!servers.has(serverId)) {
        off();
        this.watches.delete(serverId);
      }
  }

  private inRoom(serverId: string, roomId: string): AgentActivity[] {
    return [...this.entries.values()]
      .map(({ activity }) => activity)
      .filter((activity) => activity.serverId === serverId && activity.roomId === roomId);
  }

  /** Read the room's snapshot soon, once for every agent asking in the same tick. */
  private scheduleLoad(serverId: string, roomId: string): void {
    const key = JSON.stringify([serverId, roomId]);
    if (this.due.has(key)) return;
    this.due.add(key);
    queueMicrotask(() => {
      this.due.delete(key);
      void this.loadRoom(serverId, roomId);
    });
  }

  async loadRoom(serverId: string, roomId: string): Promise<void> {
    try {
      const snapshot = await this.api.roomActivity(serverId, roomId);
      runInAction(() => {
        for (const activity of this.inRoom(serverId, roomId)) activity.applySnapshot(snapshot);
      });
    } catch (error) {
      const message = failureText(error, "The agents' activity in this chat could not be read.");
      runInAction(() => {
        for (const activity of this.inRoom(serverId, roomId)) activity.feedError = message;
      });
    }
  }

  /** The feed reconnected or may have missed changes: read every room shown again. */
  resync(serverId: string): void {
    const rooms = new Set(
      [...this.entries.values()]
        .filter(({ activity }) => activity.serverId === serverId)
        .map(({ activity }) => activity.roomId)
    );
    for (const roomId of rooms) this.scheduleLoad(serverId, roomId);
  }

  applyItem(serverId: string, item: ChatActivityItem): void {
    if (!item.roomId) return;
    for (const activity of this.inRoom(serverId, item.roomId)) activity.applyItem(item);
  }

  applyApproval(serverId: string, approval: ChatApproval): void {
    if (!approval.roomId) return;
    for (const activity of this.inRoom(serverId, approval.roomId)) activity.applyApproval(approval);
  }

  acquire(
    serverId: string,
    tenantId: string | null,
    roomId: string,
    agentId: string
  ): AgentActivity {
    const key = JSON.stringify([serverId, tenantId, roomId, agentId]);
    let entry = this.entries.get(key);
    if (!entry) {
      entry = {
        activity: new AgentActivity(serverId, tenantId, roomId, agentId, this.api),
        users: 0,
      };
      const created = entry;
      runInAction(() => this.entries.set(key, created));
      this.syncWatches();
      void entry.activity.resolve();
      this.scheduleLoad(serverId, roomId);
    }
    entry.users += 1;
    return entry.activity;
  }

  /** An activity some view already holds, without holding it. */
  peek(
    serverId: string,
    tenantId: string | null,
    roomId: string,
    agentId: string
  ): AgentActivity | null {
    return (
      this.entries.get(JSON.stringify([serverId, tenantId, roomId, agentId]))?.activity ?? null
    );
  }

  release(activity: AgentActivity): void {
    const key = JSON.stringify([
      activity.serverId,
      activity.tenantId,
      activity.roomId,
      activity.agentId,
    ]);
    const entry = this.entries.get(key);
    if (!entry || entry.activity !== activity) return;
    entry.users -= 1;
    if (entry.users > 0) return;
    runInAction(() => this.entries.delete(key));
    this.syncWatches();
  }

  /** Look again for where every activity on the server runs (placements changed). */
  refresh(serverId: string, agentId: string | null): void {
    for (const { activity } of this.entries.values())
      if (activity.serverId === serverId && (agentId === null || activity.agentId === agentId))
        void activity.resolve();
  }

  /** Forget everything for a room the person lost, or a whole server on reset. */
  drop(serverId: string, roomId: string | null): void {
    for (const [key, { activity }] of this.entries)
      if (activity.serverId === serverId && (roomId === null || activity.roomId === roomId))
        runInAction(() => this.entries.delete(key));
    this.syncWatches();
  }
}
