/**
 * #1642 — schedule registry + drift reconciliation tests.
 *
 * Pure-function tests over analyzeDrift/buildScheduleRegistry with an
 * injected gateway job list (no live gateway needed). Covers the ticket's
 * doneWhen: orphan detection (seeded fake orphan cron), zombie detection,
 * the #1633 zero-model-call regression guard, and gateway-unreachable
 * degradation.
 */
import { describe, it, expect } from 'vitest';
import {
  analyzeDrift,
  buildScheduleRegistry,
  classifyGatewayCron,
  SERVER_INTERVALS,
} from '@/lib/schedule-registry';

const baseLoops = [
  { agentId: 'mikey', enabled: true, intervalMinutes: 240, cronJobId: null },
  { agentId: 'ana', enabled: true, intervalMinutes: 240, cronJobId: null },
];

describe('classifyGatewayCron', () => {
  it('classifies agentTurn payloads as model-call', () => {
    expect(classifyGatewayCron({ payload: { kind: 'agentTurn', message: 'do work' } })).toBe('model-call');
  });
  it('classifies systemEvent payloads as query', () => {
    expect(classifyGatewayCron({ payload: { kind: 'systemEvent', text: 'reminder' } })).toBe('query');
  });
  it('defaults unknown payloads to query', () => {
    expect(classifyGatewayCron({})).toBe('query');
  });
});

describe('analyzeDrift — orphans', () => {
  it('detects a seeded legacy Scheduler cron no loop references (#1633 shape)', () => {
    const findings = analyzeDrift({
      loops: baseLoops,
      gatewayJobs: [
        { id: 'cron-orphan-1', name: 'Scheduler: Billy', payload: { kind: 'agentTurn', message: 'SCHEDULER_LOOP: autonomous work cycle' } },
      ],
    });
    const orphans = findings.filter((f) => f.kind === 'orphan');
    expect(orphans).toHaveLength(1);
    expect(orphans[0].scheduleId).toBe('cron-orphan-1');
    expect(orphans[0].explanation).toContain('#1633');
  });

  it('does NOT flag a Scheduler cron that a loop still references', () => {
    const findings = analyzeDrift({
      loops: [{ agentId: 'billy', enabled: true, cronJobId: 'cron-legit-1' }],
      gatewayJobs: [{ id: 'cron-legit-1', name: 'Scheduler: Billy', payload: { kind: 'agentTurn' } }],
    });
    expect(findings.filter((f) => f.kind === 'orphan')).toHaveLength(0);
  });

  it('does NOT flag operator-owned crons outside the Scheduler namespace', () => {
    const findings = analyzeDrift({
      loops: baseLoops,
      gatewayJobs: [
        { id: 'cron-user-1', name: 'M2M market hours', payload: { kind: 'systemEvent', text: 'check market' } },
      ],
    });
    expect(findings).toHaveLength(0);
  });

  it('flags a prefix-less agentTurn cron carrying the scheduler work-loop fingerprint', () => {
    const findings = analyzeDrift({
      loops: baseLoops,
      gatewayJobs: [
        { id: 'cron-sneaky', name: 'Innocent looking job', payload: { kind: 'agentTurn', message: 'SCHEDULER_LOOP: autonomous work cycle for kate' } },
      ],
    });
    const orphans = findings.filter((f) => f.kind === 'orphan');
    expect(orphans).toHaveLength(1);
    expect(orphans[0].scheduleId).toBe('cron-sneaky');
  });
});

describe('analyzeDrift — zombies', () => {
  it('flags an enabled loop with a last-fire older than 7 days', () => {
    const eightDaysAgo = new Date(Date.now() - 8 * 86400000).toISOString();
    const findings = analyzeDrift({
      loops: [{ agentId: 'mikey', enabled: true, cronJobId: null }],
      gatewayJobs: [],
      heartbeatsByAgent: { mikey: { lastFire: eightDaysAgo } },
    });
    const zombies = findings.filter((f) => f.kind === 'zombie');
    expect(zombies).toHaveLength(1);
    expect(zombies[0].scheduleId).toBe('loop-mikey');
    expect(zombies[0].explanation).toContain('dispatch-health');
  });

  it('does not flag loops with recent heartbeats or no heartbeat data', () => {
    const findings = analyzeDrift({
      loops: [
        { agentId: 'mikey', enabled: true, cronJobId: null },
        { agentId: 'ana', enabled: true, cronJobId: null },
      ],
      gatewayJobs: [],
      heartbeatsByAgent: {
        mikey: { lastFire: new Date().toISOString() },
        // ana: no heartbeat row — push-idle, presumed fine
      },
    });
    expect(findings.filter((f) => f.kind === 'zombie')).toHaveLength(0);
  });

  it('never flags disabled loops', () => {
    const findings = analyzeDrift({
      loops: [{ agentId: 'kate', enabled: false, cronJobId: null }],
      gatewayJobs: [],
      heartbeatsByAgent: { kate: { lastFire: new Date(0).toISOString() } },
    });
    expect(findings).toHaveLength(0);
  });
});

describe('buildScheduleRegistry', () => {
  it('inventories all three sources and counts enabled model-call schedules', async () => {
    const snap = await buildScheduleRegistry({
      loops: baseLoops,
      listGatewayJobs: async () => [
        { id: 'cron-1', name: 'Scheduler: Ghost', enabled: true, schedule: { kind: 'every', everyMs: 1800000 }, payload: { kind: 'agentTurn' } },
        { id: 'cron-2', name: 'Health ping', enabled: true, schedule: { kind: 'cron', expr: '0 9 * * *' }, payload: { kind: 'systemEvent' } },
      ],
    });
    expect(snap.gatewayReachable).toBe(true);
    const sources = new Set(snap.entries.map((e) => e.source));
    expect(sources).toEqual(new Set(['org-studio-loop', 'gateway-cron', 'server-interval']));
    expect(snap.entries.filter((e) => e.source === 'org-studio-loop')).toHaveLength(2);
    expect(snap.entries.filter((e) => e.source === 'gateway-cron')).toHaveLength(2);
    expect(snap.entries.filter((e) => e.source === 'server-interval')).toHaveLength(SERVER_INTERVALS.length);
    // The seeded orphan agentTurn cron is the only model-call schedule.
    expect(snap.modelCallScheduleCount).toBe(1);
    // And it also shows up as a drift finding (fake orphan detected within one cycle).
    expect(snap.findings.some((f) => f.kind === 'orphan' && f.scheduleId === 'cron-1')).toBe(true);
  });

  it('#1633 invariant: zero enabled model-call schedules in the DECLARED baseline', async () => {
    // With no gateway crons at all, nothing in Org Studio's own inventory
    // (loops + server intervals) may be model-call class. This is the
    // regression guard: if someone reintroduces a heavy recurring turn as
    // a declared schedule, this test goes red.
    const snap = await buildScheduleRegistry({
      loops: baseLoops,
      listGatewayJobs: async () => [],
    });
    expect(snap.modelCallScheduleCount).toBe(0);
    expect(snap.findings).toHaveLength(0);
  });

  it('degrades gracefully when the gateway is unreachable', async () => {
    const snap = await buildScheduleRegistry({
      loops: baseLoops,
      listGatewayJobs: async () => { throw new Error('gateway down'); },
    });
    expect(snap.gatewayReachable).toBe(false);
    // Loops + server intervals still inventoried.
    expect(snap.entries.length).toBe(baseLoops.length + SERVER_INTERVALS.length);
  });
});

describe('SERVER_INTERVALS declaration', () => {
  it('contains no model-call entries (recurring work must be query-class or cheaper)', () => {
    expect(SERVER_INTERVALS.filter((s) => s.costClass === 'model-call')).toHaveLength(0);
  });
  it('self-inventories the #1642 drift reconcile tick', () => {
    expect(SERVER_INTERVALS.some((s) => s.id === 'srv-schedule-drift-reconcile')).toBe(true);
  });
});
