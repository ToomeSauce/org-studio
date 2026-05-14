/**
 * #1353 slice 3 — Unit tests for auditRuntimeMetadata().
 *
 * Validates the consistency-audit logic with hand-crafted stub
 * runtimes — no Gateway or filesystem touched. Covers all four
 * states: clean / mismatch / missing / unbound, plus edge cases:
 *   - Empty inputs.
 *   - Provider-prefix normalization (so 'claude-opus-4.7' vs
 *     'github-copilot/claude-opus-4.7' is NOT flagged).
 *   - Mixed-case agentIds.
 *   - Throwing getAgentMetadata (defense-in-depth: contract says
 *     never throw, but we still don't break if one does).
 */
import { describe, it, expect, vi } from 'vitest';
import {
  auditRuntimeMetadata,
  modelsMatch,
  normalizeModelForComparison,
  logMismatches,
  type RuntimeMetadataMismatch,
} from '../lib/runtimes/audit';
import type { AgentRuntime, RuntimeAgent } from '../lib/runtimes/types';

/** Build a minimal stub AgentRuntime that returns canned metadata. */
function stubRuntime(metaByAgentId: Record<string, { model?: string } | undefined>): AgentRuntime {
  return {
    id: 'stub',
    name: 'Stub',
    discover: async () => [],
    send: async () => undefined,
    health: async () => ({ connected: true }),
    getAgentMetadata: async (agentId: string) => metaByAgentId[agentId],
    dispose: () => undefined,
  };
}

/** Build a stub agent record. */
function agent(id: string, runtime = 'stub'): RuntimeAgent {
  return { id, name: id, runtime } as RuntimeAgent;
}

describe('#1353 slice 3 — normalizeModelForComparison', () => {
  it('strips provider prefix', () => {
    expect(normalizeModelForComparison('github-copilot/claude-opus-4.7')).toBe('claude-opus-4.7');
    expect(normalizeModelForComparison('foundry-southcentral/gpt-5.5')).toBe('gpt-5.5');
  });

  it('passes through bare model ids', () => {
    expect(normalizeModelForComparison('gpt-5.5')).toBe('gpt-5.5');
  });

  it('handles custom: providers (only strips the first slash)', () => {
    expect(normalizeModelForComparison('custom:burner/gpt-5.5')).toBe('gpt-5.5');
  });

  it('returns undefined for empty/missing input', () => {
    expect(normalizeModelForComparison(undefined)).toBeUndefined();
    expect(normalizeModelForComparison('')).toBeUndefined();
  });
});

describe('#1353 slice 3 — modelsMatch', () => {
  it('matches identical strings', () => {
    expect(modelsMatch('gpt-5.5', 'gpt-5.5')).toBe(true);
  });

  it('matches across provider prefixes', () => {
    // The original #1350 bug surface: teammate declares the model
    // without a provider; runtime reports it with one. These must
    // be treated as the SAME model so the audit doesn't false-flag.
    expect(modelsMatch('claude-opus-4.7', 'github-copilot/claude-opus-4.7')).toBe(true);
    expect(modelsMatch('foundry-southcentral/gpt-5.5', 'gpt-5.5')).toBe(true);
  });

  it('returns false for genuinely different models', () => {
    expect(modelsMatch('gpt-5.5', 'gpt-5.4')).toBe(false);
    expect(modelsMatch('claude-opus-4.7', 'claude-opus-4.6')).toBe(false);
  });

  it('returns false when either side is undefined', () => {
    expect(modelsMatch(undefined, 'gpt-5.5')).toBe(false);
    expect(modelsMatch('gpt-5.5', undefined)).toBe(false);
    expect(modelsMatch(undefined, undefined)).toBe(false);
  });
});

describe('#1353 slice 3 — auditRuntimeMetadata: state classification', () => {
  it('returns empty array when everything is consistent', async () => {
    const runtimes = new Map<string, AgentRuntime>([
      ['stub', stubRuntime({ mikey: { model: 'github-copilot/claude-opus-4.7' } })],
    ]);
    const result = await auditRuntimeMetadata({
      agents: [agent('mikey')],
      runtimes,
      teammates: [{ agentId: 'mikey', model: 'claude-opus-4.7' }],
    });
    expect(result).toEqual([]);
  });

  it("flags 'mismatch' when runtime + teammate both declare and differ", async () => {
    const runtimes = new Map<string, AgentRuntime>([
      ['stub', stubRuntime({ mikey: { model: 'claude-opus-4.6' } })],
    ]);
    const result = await auditRuntimeMetadata({
      agents: [agent('mikey')],
      runtimes,
      teammates: [{ agentId: 'mikey', model: 'claude-opus-4.7' }],
    });
    expect(result).toHaveLength(1);
    expect(result[0].kind).toBe('mismatch');
    expect(result[0].agentId).toBe('mikey');
    expect(result[0].runtimeModel).toBe('claude-opus-4.6');
    expect(result[0].teammateModel).toBe('claude-opus-4.7');
    expect(result[0].message).toContain('mikey');
    expect(result[0].message).toContain('claude-opus-4.7');
    expect(result[0].message).toContain('claude-opus-4.6');
  });

  it("flags 'missing' when runtime declares but teammate has no model", async () => {
    const runtimes = new Map<string, AgentRuntime>([
      ['stub', stubRuntime({ mikey: { model: 'claude-opus-4.7' } })],
    ]);
    const result = await auditRuntimeMetadata({
      agents: [agent('mikey')],
      runtimes,
      teammates: [{ agentId: 'mikey' }], // no model
    });
    expect(result).toHaveLength(1);
    expect(result[0].kind).toBe('missing');
    expect(result[0].runtimeModel).toBe('claude-opus-4.7');
    expect(result[0].teammateModel).toBeUndefined();
  });

  it("flags 'unbound' when teammate declares but runtime returns undefined", async () => {
    const runtimes = new Map<string, AgentRuntime>([
      ['stub', stubRuntime({ mikey: undefined })],
    ]);
    const result = await auditRuntimeMetadata({
      agents: [agent('mikey')],
      runtimes,
      teammates: [{ agentId: 'mikey', model: 'claude-opus-4.7' }],
    });
    expect(result).toHaveLength(1);
    expect(result[0].kind).toBe('unbound');
    expect(result[0].teammateModel).toBe('claude-opus-4.7');
    expect(result[0].runtimeModel).toBeUndefined();
  });

  it('stays silent when both sides are undefined', async () => {
    const runtimes = new Map<string, AgentRuntime>([
      ['stub', stubRuntime({ mikey: undefined })],
    ]);
    const result = await auditRuntimeMetadata({
      agents: [agent('mikey')],
      runtimes,
      teammates: [{ agentId: 'mikey' }],
    });
    expect(result).toEqual([]);
  });
});

describe('#1353 slice 3 — auditRuntimeMetadata: integration scenarios', () => {
  it('reports mixed states across multiple agents in one pass', async () => {
    const runtimes = new Map<string, AgentRuntime>([
      [
        'stub',
        stubRuntime({
          alice: { model: 'gpt-5.5' },                     // matches teammate → silent
          bob: { model: 'claude-opus-4.7' },               // mismatch with teammate
          carol: { model: 'gpt-5.4' },                     // missing from teammate
          dave: undefined,                                  // unbound (teammate has model)
          eve: undefined,                                   // both empty → silent
        }),
      ],
    ]);
    const result = await auditRuntimeMetadata({
      agents: ['alice', 'bob', 'carol', 'dave', 'eve'].map(id => agent(id)),
      runtimes,
      teammates: [
        { agentId: 'alice', model: 'gpt-5.5' },
        { agentId: 'bob', model: 'claude-opus-4.6' },
        { agentId: 'carol' },
        { agentId: 'dave', model: 'gpt-5.5' },
        { agentId: 'eve' },
      ],
    });
    expect(result).toHaveLength(3);
    const byAgent = Object.fromEntries(result.map(m => [m.agentId, m.kind]));
    expect(byAgent.bob).toBe('mismatch');
    expect(byAgent.carol).toBe('missing');
    expect(byAgent.dave).toBe('unbound');
    expect(byAgent.alice).toBeUndefined();
    expect(byAgent.eve).toBeUndefined();
  });

  it("doesn't false-flag provider-prefix differences (#1350 bug surface)", async () => {
    // Teammate declares 'claude-opus-4.7'; runtime reports
    // 'github-copilot/claude-opus-4.7'. These name the SAME model.
    const runtimes = new Map<string, AgentRuntime>([
      ['stub', stubRuntime({ mikey: { model: 'github-copilot/claude-opus-4.7' } })],
    ]);
    const result = await auditRuntimeMetadata({
      agents: [agent('mikey')],
      runtimes,
      teammates: [{ agentId: 'mikey', model: 'claude-opus-4.7' }],
    });
    expect(result).toEqual([]);
  });

  it('skips agents whose runtime throws (defense-in-depth)', async () => {
    // AgentRuntime contract says never-throw, but if one does,
    // the audit MUST NOT propagate and break /api/runtimes for
    // the rest of the team. Skip and continue.
    const throwingRuntime: AgentRuntime = {
      id: 'thrower',
      name: 'Thrower',
      discover: async () => [],
      send: async () => undefined,
      health: async () => ({ connected: true }),
      getAgentMetadata: async () => {
        throw new Error('runtime exploded');
      },
      dispose: () => undefined,
    };
    const goodRuntime = stubRuntime({ alice: { model: 'gpt-5.5' } });
    const runtimes = new Map<string, AgentRuntime>([
      ['thrower', throwingRuntime],
      ['stub', goodRuntime],
    ]);
    const result = await auditRuntimeMetadata({
      agents: [agent('bomb', 'thrower'), agent('alice', 'stub')],
      runtimes,
      teammates: [
        { agentId: 'bomb', model: 'whatever' },
        { agentId: 'alice' },
      ],
    });
    // bomb is skipped; alice flags 'missing'.
    expect(result).toHaveLength(1);
    expect(result[0].agentId).toBe('alice');
    expect(result[0].kind).toBe('missing');
  });

  it('handles empty agents list', async () => {
    const result = await auditRuntimeMetadata({
      agents: [],
      runtimes: new Map(),
      teammates: [{ agentId: 'mikey', model: 'gpt-5.5' }],
    });
    expect(result).toEqual([]);
  });
});

describe('#1353 slice 3 — logMismatches', () => {
  it('is silent for empty input', () => {
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    logMismatches([]);
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it('logs one summary + one line per mismatch', () => {
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const mismatches: RuntimeMetadataMismatch[] = [
      {
        agentId: 'mikey',
        runtimeId: 'openclaw',
        kind: 'mismatch',
        runtimeModel: 'claude-opus-4.6',
        teammateModel: 'claude-opus-4.7',
        message: 'test',
      },
      {
        agentId: 'trevor',
        runtimeId: 'hermes',
        kind: 'unbound',
        teammateModel: 'gpt-5.5',
        message: 'test',
      },
    ];
    logMismatches(mismatches);
    // 1 summary + 2 detail lines = 3 calls
    expect(spy).toHaveBeenCalledTimes(3);
    expect(spy.mock.calls[0][0]).toContain('Found 2');
    expect(spy.mock.calls[1][0]).toContain('MISMATCH mikey');
    expect(spy.mock.calls[2][0]).toContain('UNBOUND trevor');
    spy.mockRestore();
  });
});
