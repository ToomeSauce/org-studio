/**
 * M-1 (#1662): messaging command layer — parse, authz, pipeline tests.
 * Deterministic-only constraint: these tests assert no effect is invoked
 * unless parse AND authz both pass.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  parseCommand,
  authorize,
  handleInbound,
  type CommandEffects,
} from '@/lib/messaging/commands';
import type { ChatBinding } from '@/lib/messaging/types';

function fakeEffects(overrides: Partial<CommandEffects> = {}): CommandEffects {
  return {
    approveVersion: vi.fn(async (p, v) => `approved ${v} on ${p}`),
    setLoopPaused: vi.fn(async (p, paused) => (paused ? `paused ${p}` : `resumed ${p}`)),
    setBudget: vi.fn(async (p, usd) => `budget ${p} ${usd}`),
    getStatus: vi.fn(async (p) => `status ${p}`),
    ...overrides,
  };
}

const BASIL: ChatBinding = {
  channel: 'telegram',
  chatUserId: '8585437942',
  teammate: 'Basil',
};

describe('#1662 parseCommand', () => {
  it('parses approve with projectId + version', () => {
    const r = parseCommand('approve proj-org-studio 2026.10.01');
    expect(r).toEqual({
      ok: true,
      cmd: { verb: 'approve', projectId: 'proj-org-studio', version: '2026.10.01' },
    });
  });

  it('accepts semver and 4-part calver versions', () => {
    expect(parseCommand('approve p 1.2.3').ok).toBe(true);
    expect(parseCommand('approve p 2026.10.01.2').ok).toBe(true);
  });

  it('rejects v-prefixed and malformed versions', () => {
    expect(parseCommand('approve p v1.2.3').ok).toBe(false);
    expect(parseCommand('approve p 1.2').ok).toBe(false);
    expect(parseCommand('approve p banana').ok).toBe(false);
  });

  it('tolerates leading slash and mixed-case verb', () => {
    expect(parseCommand('/PAUSE proj-x')).toEqual({
      ok: true,
      cmd: { verb: 'pause', projectId: 'proj-x' },
    });
  });

  it('parses budget with positive number, rejects non-positive/NaN', () => {
    expect(parseCommand('budget p 250')).toEqual({
      ok: true,
      cmd: { verb: 'budget', projectId: 'p', usd: 250 },
    });
    expect(parseCommand('budget p 0').ok).toBe(false);
    expect(parseCommand('budget p -5').ok).toBe(false);
    expect(parseCommand('budget p lots').ok).toBe(false);
  });

  it('rejects wrong arity with usage text', () => {
    const r = parseCommand('approve proj-x');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('Usage: approve');
  });

  it('rejects unknown verbs and hostile projectIds', () => {
    expect(parseCommand('deploy prod').ok).toBe(false);
    expect(parseCommand('pause "; DROP TABLE --"').ok).toBe(false);
    expect(parseCommand('pause ../../etc').ok).toBe(false);
  });

  it('handles empty input', () => {
    expect(parseCommand('').ok).toBe(false);
    expect(parseCommand('   ').ok).toBe(false);
  });
});

describe('#1662 authorize (fail closed)', () => {
  it('unknown chat user is denied', () => {
    const r = authorize({ channel: 'telegram', chatUserId: 'stranger' }, 'status', [BASIL]);
    expect(r.ok).toBe(false);
  });

  it('same user id on a different channel is denied', () => {
    const r = authorize({ channel: 'slack', chatUserId: '8585437942' }, 'status', [BASIL]);
    expect(r.ok).toBe(false);
  });

  it('bound user is allowed', () => {
    const r = authorize({ channel: 'telegram', chatUserId: '8585437942' }, 'approve', [BASIL]);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.binding.teammate).toBe('Basil');
  });

  it('allowedCommands narrows the verb set', () => {
    const limited: ChatBinding = { ...BASIL, allowedCommands: ['status'] };
    expect(authorize({ channel: 'telegram', chatUserId: '8585437942' }, 'status', [limited]).ok).toBe(true);
    expect(authorize({ channel: 'telegram', chatUserId: '8585437942' }, 'approve', [limited]).ok).toBe(false);
  });

  it('empty bindings list denies everyone', () => {
    expect(authorize({ channel: 'telegram', chatUserId: '8585437942' }, 'help', []).ok).toBe(false);
  });
});

describe('#1662 handleInbound pipeline', () => {
  it('parse+authz pass → effect runs with binding teammate as actor', async () => {
    const effects = fakeEffects();
    const reply = await handleInbound(
      { channel: 'telegram', chatUserId: '8585437942', text: 'approve proj-x 1.2.3' },
      [BASIL],
      effects,
    );
    expect(reply.ok).toBe(true);
    expect(effects.approveVersion).toHaveBeenCalledWith('proj-x', '1.2.3', 'Basil');
  });

  it('unauthorized user: NO effect runs, generic denial even for bad parse', async () => {
    const effects = fakeEffects();
    const r1 = await handleInbound(
      { channel: 'telegram', chatUserId: 'stranger', text: 'approve proj-x 1.2.3' },
      [BASIL],
      effects,
    );
    expect(r1.ok).toBe(false);
    const r2 = await handleInbound(
      { channel: 'telegram', chatUserId: 'stranger', text: 'gibberish' },
      [BASIL],
      effects,
    );
    // Parse-error detail must not leak to unbound users.
    expect(r2.text).toBe('Not authorized.');
    for (const fn of Object.values(effects)) {
      expect(fn).not.toHaveBeenCalled();
    }
  });

  it('bound user with parse error gets usage text, no effect', async () => {
    const effects = fakeEffects();
    const r = await handleInbound(
      { channel: 'telegram', chatUserId: '8585437942', text: 'approve nope' },
      [BASIL],
      effects,
    );
    expect(r.ok).toBe(false);
    expect(r.text).toContain('Usage: approve');
    expect(effects.approveVersion).not.toHaveBeenCalled();
  });

  it('pause/resume map to setLoopPaused true/false', async () => {
    const effects = fakeEffects();
    await handleInbound({ channel: 'telegram', chatUserId: '8585437942', text: 'pause p' }, [BASIL], effects);
    await handleInbound({ channel: 'telegram', chatUserId: '8585437942', text: 'resume p' }, [BASIL], effects);
    expect(effects.setLoopPaused).toHaveBeenNthCalledWith(1, 'p', true, 'Basil');
    expect(effects.setLoopPaused).toHaveBeenNthCalledWith(2, 'p', false, 'Basil');
  });

  it('effect throw becomes ok:false reply, never an exception', async () => {
    const effects = fakeEffects({
      setBudget: vi.fn(async () => {
        throw new Error('validateBudget rejected it');
      }),
    });
    const r = await handleInbound(
      { channel: 'telegram', chatUserId: '8585437942', text: 'budget p 50' },
      [BASIL],
      effects,
    );
    expect(r.ok).toBe(false);
    expect(r.text).toContain('validateBudget rejected it');
  });

  it('help lists only allowed commands for narrowed bindings', async () => {
    const limited: ChatBinding = { ...BASIL, allowedCommands: ['help', 'status'] };
    const r = await handleInbound(
      { channel: 'telegram', chatUserId: '8585437942', text: 'help' },
      [limited],
      fakeEffects(),
    );
    expect(r.ok).toBe(true);
    expect(r.text).toContain('status');
    expect(r.text).not.toContain('approve');
  });
});
