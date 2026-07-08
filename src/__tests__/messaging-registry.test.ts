/**
 * M-1 (#1662): messaging registry — registration, outbound fan-out,
 * binding-scoped delivery, and fail-closed inbound wiring.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { getMessagingRegistry, resetMessagingRegistry } from '@/lib/messaging/registry';
import type { MessagingAdapter, ChatBinding, InboundHandler } from '@/lib/messaging/types';
import type { CommandEffects } from '@/lib/messaging/commands';

function fakeAdapter(id: string): MessagingAdapter & {
  handler: InboundHandler | null;
  sent: any[];
} {
  const a: any = {
    id,
    name: id,
    handler: null,
    sent: [],
    start: vi.fn(async (h: InboundHandler) => {
      a.handler = h;
    }),
    stop: vi.fn(async () => undefined),
    sendNotification: vi.fn(async (binding: ChatBinding, n: any) => {
      a.sent.push({ binding, n });
      return true;
    }),
  };
  return a;
}

const BINDINGS: ChatBinding[] = [
  { channel: 'telegram', chatUserId: 'u1', teammate: 'Basil' },
  { channel: 'telegram', chatUserId: 'u2', teammate: 'Mikey' },
  { channel: 'slack', chatUserId: 'u3', teammate: 'Basil' },
];

function fakeEffects(): CommandEffects {
  return {
    approveVersion: vi.fn(async () => 'ok'),
    setLoopPaused: vi.fn(async () => 'ok'),
    setBudget: vi.fn(async () => 'ok'),
    getStatus: vi.fn(async () => 'ok'),
  };
}

/** Registry with bindings injected by stubbing the store read. */
function makeRegistry(effects = fakeEffects()) {
  resetMessagingRegistry();
  const reg = getMessagingRegistry(effects) as any;
  reg.loadBindings = vi.fn(async () => BINDINGS);
  return reg;
}

describe('#1662 MessagingRegistry', () => {
  beforeEach(() => resetMessagingRegistry());

  it('singleton returns the same instance', () => {
    expect(getMessagingRegistry()).toBe(getMessagingRegistry());
  });

  it('notify with zero adapters is a no-op returning 0', async () => {
    const reg = makeRegistry();
    const n = await reg.notify({ kind: 'generic', title: 't', body: 'b' });
    expect(n).toBe(0);
  });

  it('notify fans out to all bindings on registered channels when no recipients', async () => {
    const reg = makeRegistry();
    const tg = fakeAdapter('telegram');
    reg.register(tg);
    const delivered = await reg.notify({ kind: 'budget-alert', title: 't', body: 'b' });
    // 2 telegram bindings; the slack binding has no adapter registered.
    expect(delivered).toBe(2);
    expect(tg.sent.map((s: any) => s.binding.chatUserId).sort()).toEqual(['u1', 'u2']);
  });

  it('notify with recipients filters by teammate (case-insensitive)', async () => {
    const reg = makeRegistry();
    const tg = fakeAdapter('telegram');
    reg.register(tg);
    const delivered = await reg.notify({
      kind: 'approval-request',
      title: 't',
      body: 'b',
      recipients: ['basil'],
    });
    expect(delivered).toBe(1);
    expect(tg.sent[0].binding.teammate).toBe('Basil');
  });

  it('a throwing adapter never breaks fan-out to others', async () => {
    const reg = makeRegistry();
    const tg = fakeAdapter('telegram');
    (tg.sendNotification as any).mockRejectedValueOnce(new Error('channel down'));
    reg.register(tg);
    const delivered = await reg.notify({ kind: 'generic', title: 't', body: 'b' });
    expect(delivered).toBe(1); // u1 failed, u2 delivered
  });

  it('start wires the inbound handler through parse→authz→effects', async () => {
    const effects = fakeEffects();
    const reg = makeRegistry(effects);
    const tg = fakeAdapter('telegram');
    reg.register(tg);
    await reg.start();
    expect(tg.handler).toBeTruthy();
    const reply = await tg.handler!({ channel: 'telegram', chatUserId: 'u1', text: 'status proj-x' });
    expect(reply.ok).toBe(true);
    expect(effects.getStatus).toHaveBeenCalledWith('proj-x');
  });

  it('inbound from unbound chat user is denied and runs no effects', async () => {
    const effects = fakeEffects();
    const reg = makeRegistry(effects);
    const tg = fakeAdapter('telegram');
    reg.register(tg);
    await reg.start();
    const reply = await tg.handler!({ channel: 'telegram', chatUserId: 'nobody', text: 'pause proj-x' });
    expect(reply.ok).toBe(false);
    expect(effects.setLoopPaused).not.toHaveBeenCalled();
  });

  it('bindings load failure fails closed (deny), not open', async () => {
    const effects = fakeEffects();
    const reg = makeRegistry(effects);
    reg.loadBindings = vi.fn(async () => []); // store unreachable → []
    const tg = fakeAdapter('telegram');
    reg.register(tg);
    await reg.start();
    const reply = await tg.handler!({ channel: 'telegram', chatUserId: 'u1', text: 'status p' });
    expect(reply.ok).toBe(false);
    expect(effects.getStatus).not.toHaveBeenCalled();
  });
});
