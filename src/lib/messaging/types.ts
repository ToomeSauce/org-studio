/**
 * M-1 (#1662): Native messaging layer — core types.
 *
 * A MessagingAdapter is a CHANNEL binding (Telegram, Slack, Teams…), not an
 * agent runtime. Outbound: notifications (task transitions, budget alerts,
 * approval requests). Inbound: DETERMINISTIC commands only — buttons and
 * short text commands parsed by `commands.ts`, never LLM interpretation.
 *
 * M-1 ships the interface + registry + command layer with NO concrete
 * adapters; nothing runs until an adapter registers (M-2 Telegram, M-3
 * Slack). The existing OpenClaw chat.send + direct-Telegram paths keep
 * working unchanged — outbound emission here is additive best-effort.
 */

export type OutboundNotificationKind =
  | 'task-transition'
  | 'budget-alert'
  | 'approval-request'
  | 'generic';

/** A suggested deterministic action — adapters render these as inline
 *  buttons where the channel supports it; `command` is the canonical
 *  command string fed back through parseCommand on callback. */
export interface CommandAction {
  label: string;
  command: string;
}

export interface OutboundNotification {
  kind: OutboundNotificationKind;
  title: string;
  body: string;
  projectId?: string;
  taskId?: string;
  /** Teammate names to deliver to. Empty/undefined = all bound owners. */
  recipients?: string[];
  actions?: CommandAction[];
}

/** Chat-user → teammate auth mapping. Stored in settings.messagingBindings.
 *  A user with no binding can run NOTHING — fail closed. */
export interface ChatBinding {
  /** Adapter id, e.g. 'telegram'. */
  channel: string;
  /** Channel-native user id (Telegram user id, Slack user id…). */
  chatUserId: string;
  /** Where outbound lands (chat/channel id). Defaults to chatUserId. */
  chatTargetId?: string;
  /** Teammate name as it appears in settings.teammates. */
  teammate: string;
  /** Command allow-list. Omitted = all registered commands. */
  allowedCommands?: string[];
}

export interface InboundMessage {
  channel: string;
  chatUserId: string;
  /** Raw text ('/approve proj 1.2.3') or button callback payload. */
  text: string;
}

export interface InboundReply {
  ok: boolean;
  text: string;
}

export type InboundHandler = (msg: InboundMessage) => Promise<InboundReply>;

export interface MessagingAdapter {
  id: string;
  name: string;
  /** Begin listening for inbound; route everything through `handler`. */
  start(handler: InboundHandler): Promise<void>;
  stop(): Promise<void>;
  /** Deliver one notification to one binding. True = delivered. */
  sendNotification(binding: ChatBinding, n: OutboundNotification): Promise<boolean>;
}
