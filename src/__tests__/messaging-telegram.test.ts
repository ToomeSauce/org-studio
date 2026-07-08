/**
 * M-2 (#1663): Telegram adapter tests — fake fetch, no network.
 * Covers: outbound sendMessage + inline keyboard, 64-byte callback_data cap,
 * inbound message + callback_query routing through the handler, poll-loop
 * offset advancement, config gate for legacy-path disable.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { TelegramAdapter, CALLBACK_DATA_MAX_BYTES, telegramAdapterFromEnv } from '@/lib/messaging/telegram';
import { isLegacyChannelDisabled, nativeChannels } from '@/lib/messaging/config';
import type { ChatBinding, InboundHandler } from '@/lib/messaging/types';

const BINDING: ChatBinding = { channel: 'telegram', chatUserId: '111', teammate: 'Basil' };

/** fetch fake: records calls, replies per-method via `respond`. A respond
 *  value of the HANG sentinel blocks until the request's abort signal fires
 *  (mimics a long-poll hold) so adapter.stop() can unwind it. */
const HANG = Symbol('hang');
function fakeFetch(respond: (method: string, body: any) => any) {
  const calls: Array<{ method: string; body: any }> = [];
  const impl = vi.fn(async (url: any, init?: any) => {
    const method = String(url).split('/').pop()!;
    const body = init?.body ? JSON.parse(init.body) : {};
    calls.push({ method, body });
    const result = respond(method, body);
    if (result === HANG) {
      await new Promise((_, reject) => {
        const sig: AbortSignal | undefined = init?.signal;
        if (sig?.aborted) return reject(new Error('aborted'));
        sig?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
      });
    }
    return {
      status: 200,
      json: async () => ({ ok: true, result }),
    } as any;
  });
  return { impl, calls };
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('#1663 TelegramAdapter outbound', () => {
  it('sendNotification posts title+body to the binding chat', async () => {
    const { impl, calls } = fakeFetch(() => ({}));
    const a = new TelegramAdapter({ botToken: 't', fetchImpl: impl as any });
    const ok = await a.sendNotification(BINDING, {
      kind: 'task-transition',
      title: 'T',
      body: 'B',
    });
    expect(ok).toBe(true);
    expect(calls[0].method).toBe('sendMessage');
    expect(calls[0].body.chat_id).toBe('111');
    expect(calls[0].body.text).toBe('T\nB');
    expect(calls[0].body.reply_markup).toBeUndefined();
  });

  it('chatTargetId wins over chatUserId for delivery', async () => {
    const { impl, calls } = fakeFetch(() => ({}));
    const a = new TelegramAdapter({ botToken: 't', fetchImpl: impl as any });
    await a.sendNotification({ ...BINDING, chatTargetId: '-100999' }, {
      kind: 'generic',
      title: 'T',
      body: 'B',
    });
    expect(calls[0].body.chat_id).toBe('-100999');
  });

  it('actions render as inline keyboard with command as callback_data', async () => {
    const { impl, calls } = fakeFetch(() => ({}));
    const a = new TelegramAdapter({ botToken: 't', fetchImpl: impl as any });
    await a.sendNotification(BINDING, {
      kind: 'budget-alert',
      title: 'T',
      body: 'B',
      actions: [
        { label: 'Pause', command: 'pause proj-x' },
        { label: 'Status', command: 'status proj-x' },
      ],
    });
    const kb = calls[0].body.reply_markup.inline_keyboard;
    expect(kb).toHaveLength(2);
    expect(kb[0][0]).toEqual({ text: 'Pause', callback_data: 'pause proj-x' });
  });

  it('drops (not truncates) actions whose command exceeds the 64-byte cap', async () => {
    const { impl, calls } = fakeFetch(() => ({}));
    const a = new TelegramAdapter({ botToken: 't', fetchImpl: impl as any });
    const long = 'approve ' + 'x'.repeat(CALLBACK_DATA_MAX_BYTES) + ' 1.2.3';
    await a.sendNotification(BINDING, {
      kind: 'approval-request',
      title: 'T',
      body: 'B',
      actions: [
        { label: 'TooLong', command: long },
        { label: 'Fine', command: 'status p' },
      ],
    });
    const kb = calls[0].body.reply_markup.inline_keyboard;
    expect(kb).toHaveLength(1);
    expect(kb[0][0].text).toBe('Fine');
  });

  it('send failure returns false, never throws', async () => {
    const impl = vi.fn(async () => ({ status: 400, json: async () => ({ ok: false, description: 'bad chat' }) }));
    const a = new TelegramAdapter({ botToken: 't', fetchImpl: impl as any });
    const ok = await a.sendNotification(BINDING, { kind: 'generic', title: 'T', body: 'B' });
    expect(ok).toBe(false);
  });
});

describe('#1663 TelegramAdapter inbound (long-poll)', () => {
  /** One poll cycle: getUpdates returns `updates` once, then the adapter is
   *  stopped. Returns all API calls + what the handler saw. */
  async function pollOnce(updates: any[], handler: InboundHandler) {
    let served = false;
    const { impl, calls } = fakeFetch((method) => {
      if (method === 'getUpdates') {
        if (served) return HANG; // second poll blocks until stop() aborts
        served = true;
        return updates;
      }
      return {};
    });
    const a = new TelegramAdapter({ botToken: 't', fetchImpl: impl as any });
    await a.start(handler);
    // Let the first poll cycle + handler dispatch complete.
    await new Promise((r) => setTimeout(r, 20));
    await a.stop();
    return calls;
  }

  it('text message routes through handler and replies via sendMessage', async () => {
    const handler = vi.fn(async () => ({ ok: true, text: 'done!' }));
    const calls = await pollOnce(
      [{ update_id: 7, message: { text: 'status proj-x', from: { id: 111 }, chat: { id: 555 } } }],
      handler,
    );
    expect(handler).toHaveBeenCalledWith({ channel: 'telegram', chatUserId: '111', text: 'status proj-x' });
    const send = calls.find((c) => c.method === 'sendMessage');
    expect(send?.body).toMatchObject({ chat_id: 555, text: 'done!' });
  });

  it('callback_query routes callback_data through handler, acks, and posts result', async () => {
    const handler = vi.fn(async () => ({ ok: true, text: 'approved' }));
    const calls = await pollOnce(
      [
        {
          update_id: 8,
          callback_query: {
            id: 'cq1',
            data: 'approve proj-x 1.2.3',
            from: { id: 111 },
            message: { chat: { id: 555 } },
          },
        },
      ],
      handler,
    );
    expect(handler).toHaveBeenCalledWith({
      channel: 'telegram',
      chatUserId: '111',
      text: 'approve proj-x 1.2.3',
    });
    expect(calls.find((c) => c.method === 'answerCallbackQuery')?.body.callback_query_id).toBe('cq1');
    expect(calls.find((c) => c.method === 'sendMessage')?.body.text).toBe('approved');
  });

  it('denied callback acks with alert (spinner always clears)', async () => {
    const handler = vi.fn(async () => ({ ok: false, text: 'Not authorized.' }));
    const calls = await pollOnce(
      [
        {
          update_id: 9,
          callback_query: { id: 'cq2', data: 'pause p', from: { id: 999 }, message: { chat: { id: 555 } } },
        },
      ],
      handler,
    );
    const ack = calls.find((c) => c.method === 'answerCallbackQuery');
    expect(ack?.body.show_alert).toBe(true);
  });

  it('advances offset past the highest update_id seen', async () => {
    const handler = vi.fn(async () => ({ ok: true, text: 'ok' }));
    let secondPollBody: any = null;
    let served = false;
    const { impl } = fakeFetch((method, body) => {
      if (method === 'getUpdates') {
        if (served) {
          secondPollBody = body;
          return HANG;
        }
        served = true;
        return [
          { update_id: 41, message: { text: 'help', from: { id: 111 }, chat: { id: 5 } } },
          { update_id: 42, message: { text: 'help', from: { id: 111 }, chat: { id: 5 } } },
        ];
      }
      return {};
    });
    const a = new TelegramAdapter({ botToken: 't', fetchImpl: impl as any });
    await a.start(handler);
    await new Promise((r) => setTimeout(r, 20));
    await a.stop();
    expect(secondPollBody?.offset).toBe(43);
  });

  it('a throwing handler does not kill the poll loop', async () => {
    const handler = vi.fn(async () => {
      throw new Error('boom');
    });
    // Two updates in one batch: first throws, second must still be processed.
    const calls = await pollOnce(
      [
        { update_id: 1, message: { text: 'a', from: { id: 111 }, chat: { id: 5 } } },
        { update_id: 2, message: { text: 'b', from: { id: 111 }, chat: { id: 5 } } },
      ],
      handler,
    );
    expect(handler).toHaveBeenCalledTimes(2);
    expect(calls.filter((c) => c.method === 'getUpdates').length).toBeGreaterThanOrEqual(1);
  });
});

describe('#1663 env + config gates', () => {
  it('telegramAdapterFromEnv returns null without token', () => {
    vi.stubEnv('MESSAGING_TELEGRAM_BOT_TOKEN', '');
    expect(telegramAdapterFromEnv()).toBeNull();
    vi.stubEnv('MESSAGING_TELEGRAM_BOT_TOKEN', 'tok');
    expect(telegramAdapterFromEnv()).toBeInstanceOf(TelegramAdapter);
  });

  it('isLegacyChannelDisabled reflects MESSAGING_NATIVE_CHANNELS', () => {
    vi.stubEnv('MESSAGING_NATIVE_CHANNELS', '');
    expect(isLegacyChannelDisabled('telegram')).toBe(false);
    vi.stubEnv('MESSAGING_NATIVE_CHANNELS', 'telegram, slack');
    expect(isLegacyChannelDisabled('telegram')).toBe(true);
    expect(isLegacyChannelDisabled('TELEGRAM')).toBe(true);
    expect(isLegacyChannelDisabled('teams')).toBe(false);
    expect(nativeChannels()).toEqual(new Set(['telegram', 'slack']));
  });
});
