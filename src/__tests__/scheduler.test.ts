import { describe, it, expect } from 'vitest';
import { buildLoopPrompt } from '@/lib/scheduler';
import type { AgentLoop, LoopStep } from '@/lib/store';
import { DEFAULT_LOOP_STEPS } from '@/lib/store';

function makeLoop(overrides: Partial<AgentLoop> = {}): AgentLoop {
  return {
    id: 'loop-test',
    agentId: 'alex',
    enabled: true,
    intervalMinutes: 60,
    startOffsetMinutes: 0,
    steps: [...DEFAULT_LOOP_STEPS],
    ...overrides,
  };
}

describe('buildLoopPrompt', () => {
  it('builds prompt with default steps when no systemPrompt override', async () => {
    const loop = makeLoop();
    const prompt = await buildLoopPrompt(loop, 'Alex');

    // Should contain the SCHEDULER_LOOP header
    expect(prompt).toContain('SCHEDULER_LOOP: autonomous work cycle for Alex');

    // Should list default steps
    expect(prompt).toContain('[read-org]');
    expect(prompt).toContain('[sync-tasks]');
    expect(prompt).toContain('[work-next]');
    expect(prompt).toContain('[report]');

    // Should contain the numbered step format
    expect(prompt).toMatch(/1\. \[read-org\]/);
    expect(prompt).toMatch(/2\. \[sync-tasks\]/);
  });

  it('uses systemPrompt override instead of default steps', async () => {
    const loop = makeLoop({
      systemPrompt: 'You are a custom agent. Do special things.',
    });
    const prompt = await buildLoopPrompt(loop, 'Alex');

    // Should contain the custom system prompt
    expect(prompt).toContain('You are a custom agent. Do special things.');

    // Should NOT contain the default step format
    expect(prompt).not.toContain('[read-org]');
    expect(prompt).not.toContain('[sync-tasks]');
    expect(prompt).not.toContain('Follow these steps in order');
  });

  it('prepends global preamble when provided', async () => {
    const loop = makeLoop();
    const preamble = 'IMPORTANT: Always read ORG.md before starting work.';
    const prompt = await buildLoopPrompt(loop, 'Alex', preamble);

    // Preamble should appear at the very beginning
    expect(prompt.startsWith(preamble)).toBe(true);

    // Rest of prompt should still be there
    expect(prompt).toContain('SCHEDULER_LOOP');
  });

  it('omits preamble when empty or whitespace', async () => {
    const loop = makeLoop();
    const prompt = await buildLoopPrompt(loop, 'Alex', '   ');

    // Should start directly with SCHEDULER_LOOP
    expect(prompt.trimStart().startsWith('SCHEDULER_LOOP')).toBe(true);
  });

  it('contains HEARTBEAT_OK idle suppression instructions', async () => {
    const loop = makeLoop();
    const prompt = await buildLoopPrompt(loop, 'Alex');

    expect(prompt).toContain('HEARTBEAT_OK');
    expect(prompt).toContain('IF IDLE');
  });

  it('contains column workflow rules', async () => {
    const loop = makeLoop();
    const prompt = await buildLoopPrompt(loop, 'Alex');

    expect(prompt).toContain('COLUMN WORKFLOW');
    expect(prompt).toContain('planning');
    expect(prompt).toContain('backlog');
    expect(prompt).toContain('in-progress');
    expect(prompt).toContain('review');
    expect(prompt).toContain('done');
  });

  it('contains "NEVER pull from planning" rule', async () => {
    const loop = makeLoop();
    const prompt = await buildLoopPrompt(loop, 'Alex');

    // Should appear at least once (it's in both COLUMN WORKFLOW and RULES)
    expect(prompt).toContain('NEVER pull from "planning"');
  });

  it('only includes enabled steps in default mode', async () => {
    const steps: LoopStep[] = [
      { id: 's1', type: 'read-org', description: 'Read org', enabled: true },
      { id: 's2', type: 'sync-tasks', description: 'Sync tasks', enabled: false },
      { id: 's3', type: 'work-next', description: 'Work next', enabled: true },
    ];
    const loop = makeLoop({ steps });
    const prompt = await buildLoopPrompt(loop, 'Alex');

    expect(prompt).toContain('[read-org]');
    expect(prompt).toContain('[work-next]');
    expect(prompt).not.toContain('[sync-tasks]');
  });

  it('includes step instructions when provided', async () => {
    const steps: LoopStep[] = [
      {
        id: 's1',
        type: 'custom',
        description: 'Deploy to staging',
        instruction: 'Run npm run deploy:staging',
        enabled: true,
      },
    ];
    const loop = makeLoop({ steps });
    const prompt = await buildLoopPrompt(loop, 'Alex');

    expect(prompt).toContain('Deploy to staging');
    expect(prompt).toContain('Instructions: Run npm run deploy:staging');
  });

  it('interpolates agentId into activity status API calls', async () => {
    const loop = makeLoop({ agentId: 'ana' });
    const prompt = await buildLoopPrompt(loop, 'Ana');

    expect(prompt).toContain('"agent":"ana"');
  });
});
