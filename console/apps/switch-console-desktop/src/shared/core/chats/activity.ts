import { z } from 'zod';

/**
 * What a chat shows of its agents' work. Turns, tool rows and approval
 * requests come from Switch's activity feed, the same rows the platforms draw
 * their progress messages from. Where an agent's session runs as seen from
 * this machine (a local or SSH host) is looked up only for what the host
 * alone keeps — reasoning and full tool input and output — and for restarting
 * the session.
 */

export type ChatActivityHostTarget = 'local' | 'ssh' | 'controller';

export type ChatActivityUnavailableReason =
  /** The relay and the host are owner-only; someone else's agent shows no activity. */
  | 'not-owner'
  /** Not a local agent here and not a managed agent the person owns. */
  | 'not-on-this-machine'
  /** The agent's watcher runs, but no session of it is placed in this room. */
  | 'not-placed'
  /** The agent's watcher could not be asked. */
  | 'watcher-unreachable'
  /** The agent's controller is offline. */
  | 'controller-offline'
  /** The agent runs on a controller, which the Switch relay could not reach. */
  | 'on-controller'
  /** The controller answered, but the agent's host on it is not running or does not answer. */
  | 'host-unreachable';

export type ChatActivityTarget =
  | {
      kind: 'unavailable';
      reason: ChatActivityUnavailableReason;
      message: string;
    }
  | {
      kind: 'session';
      target: ChatActivityHostTarget;
      /** What the session calls (`rpc.sdkHost.*`) name the agent by. */
      hostAgentKey: string;
      sessionId: string;
      /** The controller running it; null on a local or SSH host. */
      controllerId: string | null;
      /**
       * The controller watcher's run, as the moment its state began: a new
       * run is a new generation, so bindings keyed by it are dropped.
       */
      generation: string | null;
    };

export const ACTIVITY_UNAVAILABLE_TEXT: Record<ChatActivityUnavailableReason, string> = {
  'not-owner': 'Agent activity is visible to its owner.',
  'not-on-this-machine': 'Activity not available on this machine.',
  'not-placed': 'The agent has no session in this chat yet.',
  'watcher-unreachable': "The agent's room watcher cannot be reached.",
  'controller-offline':
    "The agent's controller is offline. Messages are kept and delivered when it reconnects.",
  'on-controller':
    "The agent's controller could not be reached for live activity. This chat shows its messages only.",
  'host-unreachable':
    "The agent's controller is online, but the agent's host on it is not running or does not answer. This chat shows its messages only.",
};

/**
 * One step of an agent's turn as Switch stores it (`GET /chats/{room}/activity`
 * and the activity feed): the turn's own row (`itemId` {@link TURN_ITEM_ID}),
 * a message, a tool call or a notice. `revision` only grows, so a row at or
 * below the one held is stale.
 */
export const TURN_ITEM_ID = 'turn';

export const chatActivityItemSchema = z.object({
  agentId: z.string(),
  sessionId: z.string(),
  turnId: z.string(),
  itemId: z.string(),
  kind: z.enum(['turn', 'user-message', 'assistant-message', 'tool-activity', 'notice']),
  revision: z.number().int(),
  status: z.string(),
  title: z.string(),
  text: z.string(),
  commandId: z.string().nullable(),
  roomId: z.string().nullable(),
  threadId: z.string().nullable(),
  messageId: z.string().nullable(),
  occurredAt: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type ChatActivityItem = z.infer<typeof chatActivityItemSchema>;

/** A request an agent's session put to a person, in any state, so a settled one survives reload. */
export const chatApprovalSchema = z.object({
  agentId: z.string(),
  sessionId: z.string(),
  requestId: z.string(),
  turnId: z.string(),
  kind: z.string(),
  roomId: z.string().nullable(),
  threadId: z.string().nullable(),
  title: z.string(),
  detail: z.string().nullable(),
  options: z.array(z.object({ id: z.string(), label: z.string(), decision: z.string() })),
  questions: z.array(
    z.object({
      id: z.string(),
      title: z.string(),
      prompt: z.string(),
      options: z.array(
        z.object({ id: z.string(), label: z.string(), description: z.string().nullable() })
      ),
      multiSelect: z.boolean(),
      allowCustomAnswer: z.boolean(),
    })
  ),
  state: z.string(),
  expiresAt: z.string().nullable(),
  answer: z.string().nullable(),
  answers: z
    .array(
      z.object({
        questionId: z.string(),
        selectedOptionIds: z.array(z.string()),
        customText: z.string().nullable(),
      })
    )
    .nullable(),
  answeredBy: z.string().nullable(),
  answeredAt: z.string().nullable(),
});
export type ChatApproval = z.infer<typeof chatApprovalSchema>;

export const roomActivitySchema = z.object({
  items: z.array(chatActivityItemSchema),
  approvals: z.array(chatApprovalSchema),
});
export type RoomActivity = z.infer<typeof roomActivitySchema>;

/** An approval's chosen option, or an answer per question. */
export type ChatApprovalAnswer =
  | { answer: string }
  | { answers: NonNullable<ChatApproval['answers']> };

/** What the chat's Stop, Reset and Compact post to the room for an agent. */
export type ChatControlCommand = 'interrupt' | 'reset' | 'compact';

export const chatControlAcceptedSchema = z.object({ commandId: z.string() });
