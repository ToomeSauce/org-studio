/**
 * M-3 (#1664): Slack adapter on the M-1 messaging core — Socket Mode.
 *
 * Socket Mode = outbound WebSocket to Slack (apps.connections.open → wss URL),
 * so local installs need NO public endpoint — same deployment posture as the
 * Telegram long-poll adapter (M-2).
 *
 * No @slack/bolt dependency: the protocol surface we need is tiny (open a
 * socket, ack envelopes, read two event shapes, call chat.postMessage) and
 * Node 22 ships a native WebSocket. Injectable fetch + WebSocket factory keep
 * it fully unit-testable offline.
 *
 * Deterministic constraint carries through: inbound is either a DM/mention
 * text command or a Block Kit button whose `value` IS the canonical command
 * string — both feed the M-1 parse→authz→effects pipeline. No LLM anywhere.
 *
 * Env (both required, distinct from any legacy Slack config):
 *   MESSAGING_SLACK_APP_TOKEN — xapp-… app-level token (connections:write)
 *   MESSAGING_SLACK_BOT_TOKEN — xoxb-… bot token (chat:write, im:history, …)
 */

import type {
  MessagingAdapter,
  ChatBinding,
  OutboundNotification,
  InboundHandler,
} from './types';

const SLACK_API = 'https://slack.com/api';
/** Reconnect back-off after socket loss / failed open. */
const RECONNECT_BACKOFF_MS = 5_000;

/** Minimal WebSocket surface we use — native WebSocket and `ws` both fit. */
export interface WsLike {
  send(data: string): void;
  close(): void;
  addEventListener(type: 'open' | 'message' | 'close' | 'error', fn: (ev: any) => void): void;
}

export interface SlackAdapterOpts {
  appToken: string;
  botToken: string;
  fetchImpl?: typeof fetch;
  /** Test seam: produce a socket for a wss URL. Default: native WebSocket. */
  wsFactory?: (url: string) => WsLike;
}

export class SlackAdapter implements MessagingAdapter {
  id = 'slack';
  name = 'Slack (native, Socket Mode)';

  private appToken: string;
  private botToken: string;
  private fetchImpl: typeof fetch;
  private wsFactory: (url: string) => WsLike;
  private running = false;
  private ws: WsLike | null = null;

  constructor(opts: SlackAdapterOpts) {
    this.appToken = opts.appToken;
    this.botToken = opts.botToken;
    this.fetchImpl = opts.fetchImpl || fetch;
    this.wsFactory = opts.wsFactory || ((url) => new WebSocket(url) as unknown as WsLike);
  }

  private async api(method: string, body: any, token: 'app' | 'bot' = 'bot'): Promise<any> {
    const r = await this.fetchImpl(`${SLACK_API}/${method}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        Authorization: `Bearer ${token === 'app' ? this.appToken : this.botToken}`,
      },
      body: JSON.stringify(body),
    });
    const json: any = await r.json().catch(() => ({}));
    if (!json?.ok) throw new Error(`slack ${method} failed: ${json?.error || `HTTP ${r.status}`}`);
    return json;
  }

  // ---------- Inbound: Socket Mode ----------

  async start(handler: InboundHandler): Promise<void> {
    if (this.running) return;
    this.running = true;
    void this.connect(handler);
  }

  async stop(): Promise<void> {
    this.running = false;
    try {
      this.ws?.close();
    } catch {
      /* best-effort */
    }
    this.ws = null;
  }

  /** Open (or re-open) the Socket Mode connection. Self-heals: Slack sends
   *  `disconnect` envelopes to rotate connections; socket loss reconnects
   *  with back-off as long as `running` holds. */
  private async connect(handler: InboundHandler): Promise<void> {
    while (this.running) {
      let url: string;
      try {
        const opened = await this.api('apps.connections.open', {}, 'app');
        url = opened.url;
      } catch (e: any) {
        console.warn('[slack] connections.open failed:', e?.message || e);
        await new Promise((r) => setTimeout(r, RECONNECT_BACKOFF_MS));
        continue;
      }

      const done = await this.runSocket(url, handler);
      if (!this.running) break;
      if (done === 'reconnect') continue; // Slack-requested rotation: immediate
      await new Promise((r) => setTimeout(r, RECONNECT_BACKOFF_MS));
    }
  }

  /** Drive one socket until it closes. Resolves 'reconnect' when Slack asked
   *  for rotation, 'closed' otherwise. */
  private runSocket(url: string, handler: InboundHandler): Promise<'reconnect' | 'closed'> {
    return new Promise((resolve) => {
      let ws: WsLike;
      try {
        ws = this.wsFactory(url);
      } catch (e: any) {
        console.warn('[slack] socket create failed:', e?.message || e);
        return resolve('closed');
      }
      this.ws = ws;
      let askedReconnect = false;

      ws.addEventListener('message', (ev: any) => {
        void (async () => {
          let envelope: any;
          try {
            envelope = JSON.parse(typeof ev.data === 'string' ? ev.data : String(ev.data));
          } catch {
            return;
          }
          // Ack FIRST — Slack redelivers unacked envelopes, and a slow
          // command execution must not cause duplicate command runs.
          if (envelope?.envelope_id) {
            try {
              ws.send(JSON.stringify({ envelope_id: envelope.envelope_id }));
            } catch {
              /* socket died mid-ack; redelivery on next connection is fine */
            }
          }
          if (envelope?.type === 'disconnect') {
            askedReconnect = true;
            try {
              ws.close();
            } catch {
              /* ignore */
            }
            return;
          }
          await this.handleEnvelope(envelope, handler);
        })();
      });
      ws.addEventListener('close', () => {
        if (this.ws === ws) this.ws = null;
        resolve(askedReconnect ? 'reconnect' : 'closed');
      });
      ws.addEventListener('error', (e: any) => {
        console.warn('[slack] socket error:', e?.message || e);
      });
    });
  }

  /** Route one envelope through the deterministic handler. Never throws —
   *  a bad envelope must not kill the socket. */
  private async handleEnvelope(envelope: any, handler: InboundHandler): Promise<void> {
    try {
      if (envelope?.type === 'events_api') {
        const event = envelope.payload?.event;
        // Text commands via DM or app_mention. Ignore anything bot-authored
        // (incl. our own replies) — the classic echo-loop guard.
        if (!event || event.bot_id || event.subtype) return;
        if (event.type !== 'message' && event.type !== 'app_mention') return;
        const chatUserId = String(event.user || '');
        // Strip a leading <@BOTID> mention so `@orgstudio status p` parses.
        const text = String(event.text || '').replace(/^\s*<@[^>]+>\s*/, '');
        if (!chatUserId || !text.trim()) return;
        const reply = await handler({ channel: this.id, chatUserId, text });
        await this.api('chat.postMessage', { channel: event.channel, text: reply.text }).catch(
          (e: any) => console.warn('[slack] reply failed:', e?.message),
        );
        return;
      }

      if (envelope?.type === 'interactive') {
        const payload = envelope.payload;
        if (payload?.type !== 'block_actions') return;
        const chatUserId = String(payload.user?.id || '');
        const action = payload.actions?.[0];
        // Block Kit button `value` IS the canonical command string (M-1).
        const text = String(action?.value || '');
        if (!chatUserId || !text) return;
        const reply = await handler({ channel: this.id, chatUserId, text });
        // response_url posts into the source conversation without needing
        // channel scopes; fall back to chat.postMessage.
        if (payload.response_url) {
          await this.fetchImpl(payload.response_url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ text: reply.text, response_type: 'in_channel' }),
          }).catch((e: any) => console.warn('[slack] response_url post failed:', e?.message));
        } else if (payload.channel?.id) {
          await this.api('chat.postMessage', { channel: payload.channel.id, text: reply.text }).catch(
            (e: any) => console.warn('[slack] reply failed:', e?.message),
          );
        }
      }
    } catch (e: any) {
      console.warn('[slack] envelope handling failed:', e?.message || e);
    }
  }

  // ---------- Outbound ----------

  async sendNotification(binding: ChatBinding, n: OutboundNotification): Promise<boolean> {
    // chatTargetId = channel/DM id (C…/D…). Fall back to the user id — Slack
    // lets bots DM by user id via chat.postMessage channel=U… in most cases.
    const channel = binding.chatTargetId || binding.chatUserId;
    if (!channel) return false;

    const blocks: any[] = [
      {
        type: 'section',
        text: { type: 'mrkdwn', text: `*${n.title}*\n${n.body}` },
      },
    ];
    if (n.actions && n.actions.length > 0) {
      blocks.push({
        type: 'actions',
        elements: n.actions.map((a, i) => ({
          type: 'button',
          text: { type: 'plain_text', text: a.label },
          action_id: `orgstudio_cmd_${i}`,
          value: a.command, // canonical command string — M-1 round-trip
        })),
      });
    }

    try {
      await this.api('chat.postMessage', {
        channel,
        text: `${n.title} — ${n.body}`, // notification fallback text
        blocks,
      });
      return true;
    } catch (e: any) {
      console.warn('[slack] sendNotification failed:', e?.message || e);
      return false;
    }
  }
}

/** Build from env. Null unless BOTH tokens are present — adapter stays off. */
export function slackAdapterFromEnv(): SlackAdapter | null {
  const appToken = process.env.MESSAGING_SLACK_APP_TOKEN || '';
  const botToken = process.env.MESSAGING_SLACK_BOT_TOKEN || '';
  if (!appToken || !botToken) return null;
  return new SlackAdapter({ appToken, botToken });
}
