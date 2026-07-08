/**
 * M-3 (#1664): Slack adapter tests — fake fetch + fake WebSocket, no network.
 * Covers: Socket Mode connect/ack/reconnect envelopes, events_api text
 * routing (mention stripping, bot-echo guard), block_actions button
 * round-trip via response_url, outbound Block Kit rendering, env gate.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { SlackAdapter, slackAdapterFromEnv, type WsLike } from '@/lib/messaging/slack';
import type { ChatBinding, InboundHandler } from '@/lib/messaging/types';

const BINDING: ChatBinding = { channel: 'slack', chatUserId: 'U111', teammate: 'Basil' };

/** Controllable fake socket. */
class FakeWs implements WsLike {
  sent: string[] = [];
  listeners: Record<string, Array<(ev: any) => void>> = {};
  closed = false;
  send(data: string) {
    this.sent.push(data);
  }
  close() {
    if (this.closed) return;
    this.closed = true;
    for (const fn of this.listeners['close'] || []) fn({});
  }
  addEventListener(type: string, fn: (ev: any) => void) {
    (this.listeners[type] ||= []).push(fn);
  }
  emit(type: string, ev: any) {
    for (const fn of this.listeners[type] || []) fn(ev);
  }
  message(obj: any) {
    this.emit('message', { data: JSON.stringify(obj) });
  }
}

/** Slack Web API fake: records calls; apps.connections.open returns a wss url. */
function fakeSlackApi() {
  const calls: Array<{ method: string; body: any; url: string }> = [];
  const impl = vi.fn(async (url: any, init?: any) => {
    const u = String(url);
    const method = u.startsWith('https://slack.com/api/') ? u.split('/api/')[1] : u;
    const body = init?.body ? JSON.parse(init.body) : {};
    calls.push({ method, body, url: u });
    if (method === 'apps.connections.open') {
      return { status: 200, json: async () => ({ ok: true, url: 'wss://fake' }) } as any;
    }
    // response_url posts are plain 200s without an ok field requirement.
    if (!u.startsWith('https://slack.com/api/')) {
      return { status: 200, json: async () => ({ ok: true }) } as any;
    }
    return { status: 200, json: async () => ({ ok: true }) } as any;
  });
  return { impl, calls };
}

function makeAdapter() {
  const { impl, calls } = fakeSlackApi();
  const sockets: FakeWs[] = [];
  const adapter = new SlackAdapter({
    appToken: 'xapp-t',
    botToken: 'xoxb-t',
    fetchImpl: impl as any,
    wsFactory: () => {
      const ws = new FakeWs();
      sockets.push(ws);
      return ws;
    },
  });
  return { adapter, calls, sockets };
}

const tick = () => new Promise((r) => setTimeout(r, 10));

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('#1664 SlackAdapter outbound', () => {
  it('renders section + actions Block Kit; button value = canonical command', async () => {
    const { adapter, calls } = makeAdapter();
    const ok = await adapter.sendNotification(BINDING, {
      kind: 'approval-request',
      title: 'Approve 1.2.3?',
      body: 'Gate ready',
      actions: [
        { label: 'Approve', command: 'approve proj-x 1.2.3' },
        { label: 'Status', command: 'status proj-x' },
      ],
    });
    expect(ok).toBe(true);
    const post = calls.find((c) => c.method === 'chat.postMessage')!;
    expect(post.body.channel).toBe('U111');
    expect(post.body.blocks[0].text.text).toContain('*Approve 1.2.3?*');
    const buttons = post.body.blocks[1].elements;
    expect(buttons[0].value).toBe('approve proj-x 1.2.3');
    expect(buttons[1].text.text).toBe('Status');
  });

  it('no actions → section only, no actions block', async () => {
    const { adapter, calls } = makeAdapter();
    await adapter.sendNotification(BINDING, { kind: 'generic', title: 'T', body: 'B' });
    const post = calls.find((c) => c.method === 'chat.postMessage')!;
    expect(post.body.blocks).toHaveLength(1);
  });

  it('chatTargetId (channel id) wins over chatUserId', async () => {
    const { adapter, calls } = makeAdapter();
    await adapter.sendNotification({ ...BINDING, chatTargetId: 'C42' }, { kind: 'generic', title: 'T', body: 'B' });
    expect(calls.find((c) => c.method === 'chat.postMessage')!.body.channel).toBe('C42');
  });

  it('API failure returns false, never throws', async () => {
    const impl = vi.fn(async () => ({ status: 200, json: async () => ({ ok: false, error: 'channel_not_found' }) }));
    const adapter = new SlackAdapter({ appToken: 'a', botToken: 'b', fetchImpl: impl as any, wsFactory: () => new FakeWs() });
    expect(await adapter.sendNotification(BINDING, { kind: 'generic', title: 'T', body: 'B' })).toBe(false);
  });
});

describe('#1664 SlackAdapter Socket Mode inbound', () => {
  it('acks every envelope BEFORE handling (no redelivery double-runs)', async () => {
    const { adapter, sockets } = makeAdapter();
    let resolveHandler!: () => void;
    const handler: InboundHandler = vi.fn(
      () =>
        new Promise<{ ok: boolean; text: string }>(
          (res) => (resolveHandler = () => res({ ok: true, text: 'ok' })),
        ),
    );
    await adapter.start(handler);
    await tick();
    const ws = sockets[0];
    ws.message({
      envelope_id: 'env-1',
      type: 'events_api',
      payload: { event: { type: 'message', user: 'U111', text: 'status p', channel: 'D9' } },
    });
    await tick();
    // Ack sent even though the handler hasn't resolved yet.
    expect(ws.sent.map((s) => JSON.parse(s))).toContainEqual({ envelope_id: 'env-1' });
    resolveHandler();
    await adapter.stop();
  });

  it('events_api message routes text through handler and replies in-channel', async () => {
    const { adapter, sockets, calls } = makeAdapter();
    const handler = vi.fn(async () => ({ ok: true, text: 'reply!' }));
    await adapter.start(handler);
    await tick();
    sockets[0].message({
      envelope_id: 'e1',
      type: 'events_api',
      payload: { event: { type: 'message', user: 'U111', text: 'status proj-x', channel: 'D9' } },
    });
    await tick();
    expect(handler).toHaveBeenCalledWith({ channel: 'slack', chatUserId: 'U111', text: 'status proj-x' });
    const post = calls.find((c) => c.method === 'chat.postMessage');
    expect(post?.body).toMatchObject({ channel: 'D9', text: 'reply!' });
    await adapter.stop();
  });

  it('strips leading bot mention from app_mention text', async () => {
    const { adapter, sockets } = makeAdapter();
    const handler = vi.fn(async () => ({ ok: true, text: 'ok' }));
    await adapter.start(handler);
    await tick();
    sockets[0].message({
      envelope_id: 'e2',
      type: 'events_api',
      payload: { event: { type: 'app_mention', user: 'U111', text: '<@UBOT> pause proj-x', channel: 'C1' } },
    });
    await tick();
    expect(handler).toHaveBeenCalledWith({ channel: 'slack', chatUserId: 'U111', text: 'pause proj-x' });
    await adapter.stop();
  });

  it('ignores bot-authored and subtype messages (echo-loop guard)', async () => {
    const { adapter, sockets } = makeAdapter();
    const handler = vi.fn(async () => ({ ok: true, text: 'ok' }));
    await adapter.start(handler);
    await tick();
    sockets[0].message({
      envelope_id: 'e3',
      type: 'events_api',
      payload: { event: { type: 'message', bot_id: 'B1', user: 'U111', text: 'status p', channel: 'D9' } },
    });
    sockets[0].message({
      envelope_id: 'e4',
      type: 'events_api',
      payload: { event: { type: 'message', subtype: 'message_changed', user: 'U111', text: 'status p', channel: 'D9' } },
    });
    await tick();
    expect(handler).not.toHaveBeenCalled();
    await adapter.stop();
  });

  it('block_actions button routes value through handler, replies via response_url', async () => {
    const { adapter, sockets, calls } = makeAdapter();
    const handler = vi.fn(async () => ({ ok: true, text: 'approved ✔' }));
    await adapter.start(handler);
    await tick();
    sockets[0].message({
      envelope_id: 'e5',
      type: 'interactive',
      payload: {
        type: 'block_actions',
        user: { id: 'U111' },
        actions: [{ action_id: 'orgstudio_cmd_0', value: 'approve proj-x 1.2.3' }],
        response_url: 'https://hooks.slack.test/resp/1',
      },
    });
    await tick();
    expect(handler).toHaveBeenCalledWith({ channel: 'slack', chatUserId: 'U111', text: 'approve proj-x 1.2.3' });
    const respPost = calls.find((c) => c.url === 'https://hooks.slack.test/resp/1');
    expect(respPost?.body.text).toBe('approved ✔');
    await adapter.stop();
  });

  it('disconnect envelope triggers immediate reconnect (new connections.open)', async () => {
    const { adapter, sockets, calls } = makeAdapter();
    const handler = vi.fn(async () => ({ ok: true, text: 'ok' }));
    await adapter.start(handler);
    await tick();
    expect(sockets).toHaveLength(1);
    sockets[0].message({ envelope_id: 'e6', type: 'disconnect', reason: 'refresh_requested' });
    await tick();
    expect(sockets).toHaveLength(2); // rotated onto a fresh socket
    expect(calls.filter((c) => c.method === 'apps.connections.open')).toHaveLength(2);
    await adapter.stop();
  });

  it('a throwing handler does not kill the socket', async () => {
    const { adapter, sockets } = makeAdapter();
    const handler = vi
      .fn()
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce({ ok: true, text: 'second fine' });
    await adapter.start(handler);
    await tick();
    const ws = sockets[0];
    ws.message({
      envelope_id: 'e7',
      type: 'events_api',
      payload: { event: { type: 'message', user: 'U111', text: 'status a', channel: 'D9' } },
    });
    ws.message({
      envelope_id: 'e8',
      type: 'events_api',
      payload: { event: { type: 'message', user: 'U111', text: 'status b', channel: 'D9' } },
    });
    await tick();
    expect(handler).toHaveBeenCalledTimes(2);
    expect(ws.closed).toBe(false);
    await adapter.stop();
  });
});

describe('#1664 env gate', () => {
  it('slackAdapterFromEnv requires BOTH tokens', () => {
    vi.stubEnv('MESSAGING_SLACK_APP_TOKEN', '');
    vi.stubEnv('MESSAGING_SLACK_BOT_TOKEN', '');
    expect(slackAdapterFromEnv()).toBeNull();
    vi.stubEnv('MESSAGING_SLACK_APP_TOKEN', 'xapp-1');
    expect(slackAdapterFromEnv()).toBeNull();
    vi.stubEnv('MESSAGING_SLACK_BOT_TOKEN', 'xoxb-1');
    expect(slackAdapterFromEnv()).toBeInstanceOf(SlackAdapter);
  });
});
