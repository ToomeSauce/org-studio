/**
 * M-2 (#1663): Telegram adapter on the M-1 messaging core.
 *
 * Long-polling only (v1 constraint): getUpdates with a 25s hold — works from
 * localhost with zero public endpoint / webhook infra. Outbound = sendMessage
 * with inline keyboards; every button's callback_data is a canonical command
 * string (Telegram hard limit: 64 bytes) that rounds back through the
 * deterministic M-1 pipeline. No LLM anywhere.
 *
 * Bot token comes from MESSAGING_TELEGRAM_BOT_TOKEN — deliberately a
 * DIFFERENT env var from the legacy TELEGRAM_BOT_TOKEN relay so the two
 * paths can't silently share identity, and turning this adapter on is
 * reversible by unsetting one var.
 *
 * IO seam: `fetchImpl` injectable for tests; production uses global fetch.
 */

import type {
  MessagingAdapter,
  ChatBinding,
  OutboundNotification,
  InboundHandler,
} from './types';

const API = 'https://api.telegram.org';
/** Telegram's documented hard cap on callback_data. */
export const CALLBACK_DATA_MAX_BYTES = 64;
/** Long-poll hold (seconds). Telegram allows up to 50; 25 keeps restarts snappy. */
const POLL_TIMEOUT_S = 25;
/** Backoff after a failed poll so a bad token can't hot-loop the process. */
const POLL_ERROR_BACKOFF_MS = 5_000;

export interface TelegramAdapterOpts {
  botToken: string;
  fetchImpl?: typeof fetch;
}

export class TelegramAdapter implements MessagingAdapter {
  id = 'telegram';
  name = 'Telegram (native)';

  private token: string;
  private fetchImpl: typeof fetch;
  private running = false;
  private offset = 0;
  private loopPromise: Promise<void> | null = null;
  private abort: AbortController | null = null;

  constructor(opts: TelegramAdapterOpts) {
    this.token = opts.botToken;
    this.fetchImpl = opts.fetchImpl || fetch;
  }

  private async api(method: string, body: any, signal?: AbortSignal): Promise<any> {
    const r = await this.fetchImpl(`${API}/bot${this.token}/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal,
    });
    const json: any = await r.json().catch(() => ({}));
    if (!json?.ok) {
      throw new Error(`telegram ${method} failed: ${json?.description || `HTTP ${r.status}`}`);
    }
    return json.result;
  }

  // ---------- Inbound: long-polling loop ----------

  async start(handler: InboundHandler): Promise<void> {
    if (this.running) return;
    this.running = true;
    this.abort = new AbortController();
    this.loopPromise = this.pollLoop(handler);
  }

  async stop(): Promise<void> {
    this.running = false;
    this.abort?.abort();
    try {
      await this.loopPromise;
    } catch {
      /* loop exit is best-effort */
    }
    this.loopPromise = null;
  }

  private async pollLoop(handler: InboundHandler): Promise<void> {
    while (this.running) {
      try {
        const updates: any[] = await this.api(
          'getUpdates',
          {
            offset: this.offset,
            timeout: POLL_TIMEOUT_S,
            allowed_updates: ['message', 'callback_query'],
          },
          this.abort?.signal,
        );
        for (const u of updates || []) {
          if (typeof u.update_id === 'number') this.offset = u.update_id + 1;
          await this.handleUpdate(u, handler);
        }
      } catch (e: any) {
        if (!this.running) break;
        console.warn('[telegram] poll error:', e?.message || e);
        await new Promise((r) => setTimeout(r, POLL_ERROR_BACKOFF_MS));
      }
    }
  }

  /** One update → handler → reply back into the chat. Never throws: a bad
   *  update must not kill the poll loop. */
  private async handleUpdate(u: any, handler: InboundHandler): Promise<void> {
    try {
      if (u.callback_query) {
        const cq = u.callback_query;
        const chatUserId = String(cq.from?.id ?? '');
        const text = String(cq.data ?? '');
        const chatId = cq.message?.chat?.id;
        const reply = await handler({ channel: this.id, chatUserId, text });
        // Always ack the callback so the button spinner clears — even on deny.
        await this.api('answerCallbackQuery', {
          callback_query_id: cq.id,
          text: reply.text.slice(0, 200),
          show_alert: !reply.ok,
        }).catch(() => {});
        // Full result lands in the chat (answerCallbackQuery toasts truncate).
        if (chatId != null) {
          await this.api('sendMessage', { chat_id: chatId, text: reply.text }).catch(() => {});
        }
        return;
      }
      if (u.message?.text) {
        const m = u.message;
        const chatUserId = String(m.from?.id ?? '');
        const reply = await handler({ channel: this.id, chatUserId, text: String(m.text) });
        await this.api('sendMessage', { chat_id: m.chat?.id, text: reply.text }).catch(() => {});
      }
    } catch (e: any) {
      console.warn('[telegram] update handling failed:', e?.message || e);
    }
  }

  // ---------- Outbound ----------

  async sendNotification(binding: ChatBinding, n: OutboundNotification): Promise<boolean> {
    const chatId = binding.chatTargetId || binding.chatUserId;
    if (!chatId) return false;

    // Inline keyboard from actions; drop (don't truncate) any command that
    // would exceed Telegram's 64-byte callback_data cap — a truncated
    // command would parse into a DIFFERENT command, which is worse than no
    // button.
    const buttons = (n.actions || [])
      .filter((a) => Buffer.byteLength(a.command, 'utf8') <= CALLBACK_DATA_MAX_BYTES)
      .map((a) => [{ text: a.label, callback_data: a.command }]);

    const payload: any = {
      chat_id: chatId,
      text: `${n.title}\n${n.body}`,
    };
    if (buttons.length > 0) payload.reply_markup = { inline_keyboard: buttons };

    try {
      await this.api('sendMessage', payload);
      return true;
    } catch (e: any) {
      console.warn('[telegram] sendNotification failed:', e?.message || e);
      return false;
    }
  }
}

/** Build from env. Null when the token is unset — adapter stays off. */
export function telegramAdapterFromEnv(): TelegramAdapter | null {
  const token = process.env.MESSAGING_TELEGRAM_BOT_TOKEN || '';
  if (!token) return null;
  return new TelegramAdapter({ botToken: token });
}
