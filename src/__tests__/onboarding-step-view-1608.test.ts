import { describe, it, expect } from 'vitest';
import {
  deriveRuntimeStepView,
  deriveTeamStepView,
  type RuntimeStepInput,
  type TeamStepInput,
} from '@/lib/onboarding-step-view';

// #1608 — Onboarding wizard runtime/team guidance clarity (follow-up from #1601).
//
// Self-test for the wizard step-view derivation. Covers the states called out in
// done-when #4 — no-runtime, runtime-detected, and mixed detected/manual team —
// asserting the copy/state transitions that reduce first-pass ambiguity.

describe('deriveRuntimeStepView (#1608 — runtime step copy/state)', () => {
  const base: RuntimeStepInput = {
    hasPolledRuntimes: false,
    connectedRuntimeCount: 0,
    detectedAgentCount: 0,
  };

  // done-when #1: explains what a connected runtime MEANS — present in every phase.
  it('always explains what a runtime is (done-when #1), in all three phases', () => {
    const phases = [
      deriveRuntimeStepView(base), // not polled
      deriveRuntimeStepView({ hasPolledRuntimes: true, connectedRuntimeCount: 1, detectedAgentCount: 2 }), // detected
      deriveRuntimeStepView({ hasPolledRuntimes: true, connectedRuntimeCount: 0, detectedAgentCount: 0 }), // none
    ];
    for (const v of phases) {
      expect(v.whatIsRuntime.length).toBeGreaterThan(0);
      expect(v.whatIsRuntime).toMatch(/runtime/i);
      // mentions that agents receive/work tasks OR that you can skip/standalone — the "why it matters"
      expect(v.whatIsRuntime).toMatch(/agents|standalone|tasks/i);
    }
  });

  describe('not-polled phase (haven’t detected yet)', () => {
    it('prompts to detect and does not encourage skip yet', () => {
      const v = deriveRuntimeStepView(base);
      expect(v.phase).toBe('not-polled');
      expect(v.statusHeadline).toMatch(/detect/i);
      expect(v.skipEncouraged).toBe(false);
    });
  });

  describe('none-detected phase (polled, zero connected) — done-when #1 "what to do if none"', () => {
    it('reassures standalone is fine and encourages skip', () => {
      const v = deriveRuntimeStepView({
        hasPolledRuntimes: true,
        connectedRuntimeCount: 0,
        detectedAgentCount: 0,
      });
      expect(v.phase).toBe('none-detected');
      expect(v.skipEncouraged).toBe(true);
      expect(v.statusHeadline).toMatch(/no runtime/i);
      // tells the user the concrete recovery: Settings or GATEWAY_URL
      expect(v.statusDetail).toMatch(/Settings|GATEWAY_URL/);
    });
  });

  describe('detected phase (at least one connected)', () => {
    it('reports connected count and that agents auto-join the roster', () => {
      const v = deriveRuntimeStepView({
        hasPolledRuntimes: true,
        connectedRuntimeCount: 1,
        detectedAgentCount: 3,
      });
      expect(v.phase).toBe('detected');
      expect(v.statusHeadline).toMatch(/connected/i);
      expect(v.statusDetail).toMatch(/3 agents/);
      expect(v.statusDetail).toMatch(/roster|team/i);
      expect(v.skipEncouraged).toBe(false);
    });

    it('handles connected-but-zero-agents without claiming agents were found', () => {
      const v = deriveRuntimeStepView({
        hasPolledRuntimes: true,
        connectedRuntimeCount: 1,
        detectedAgentCount: 0,
      });
      expect(v.phase).toBe('detected');
      expect(v.statusDetail).toMatch(/no agents|yet/i);
      // must NOT claim "Found 0 agents — added to roster"
      expect(v.statusDetail).not.toMatch(/Found 0 agents/i);
    });

    it('singularizes "1 agent" correctly', () => {
      const v = deriveRuntimeStepView({
        hasPolledRuntimes: true,
        connectedRuntimeCount: 1,
        detectedAgentCount: 1,
      });
      expect(v.statusDetail).toMatch(/\b1 agent\b/);
      expect(v.statusDetail).not.toMatch(/1 agents/);
    });
  });
});

describe('deriveTeamStepView (#1608 — team step detected-vs-manual clarity)', () => {
  const empty: TeamStepInput = { detectedAgentCount: 0, manualTeammateCount: 0 };

  describe('empty composition (nothing configured)', () => {
    it('uses "Build Your Team" and hides the detected-agents block', () => {
      const v = deriveTeamStepView(empty);
      expect(v.composition).toBe('empty');
      expect(v.heading).toMatch(/build your team/i);
      expect(v.showDetectedAgents).toBe(false);
      // tells the user agents come from a runtime later — sets expectations
      expect(v.subcopy).toMatch(/agents are imported|runtime/i);
    });
  });

  describe('agents-only composition (detected agents, no humans yet)', () => {
    it('shows the agents block and makes clear this step is for humans (done-when #2)', () => {
      const v = deriveTeamStepView({ detectedAgentCount: 4, manualTeammateCount: 0 });
      expect(v.composition).toBe('agents-only');
      expect(v.heading).toMatch(/add team members/i);
      expect(v.showDetectedAgents).toBe(true);
      expect(v.detectedAgentsLabel).toMatch(/Agents already added \(4\)/);
      // distinction: already on roster vs. adding humans
      expect(v.subcopy).toMatch(/already on your roster/i);
      expect(v.subcopy).toMatch(/humans/i);
    });
  });

  describe('manual-only composition (humans added, no detected agents)', () => {
    it('hides the agents block and frames it as building the team from scratch', () => {
      const v = deriveTeamStepView({ detectedAgentCount: 0, manualTeammateCount: 2 });
      expect(v.composition).toBe('manual-only');
      expect(v.showDetectedAgents).toBe(false);
      expect(v.heading).toMatch(/build your team/i);
    });
  });

  describe('mixed composition (detected agents AND manual humans) — the confusion case', () => {
    it('distinguishes the two groups: agents on roster (shown), humans being added', () => {
      const v = deriveTeamStepView({ detectedAgentCount: 3, manualTeammateCount: 2 });
      expect(v.composition).toBe('mixed');
      expect(v.showDetectedAgents).toBe(true);
      expect(v.detectedAgentsLabel).toMatch(/Agents already added \(3\)/);
      // sub-copy still clarifies agents are already configured, humans are the task here
      expect(v.subcopy).toMatch(/already on your roster/i);
      expect(v.detectedAgentsNote).toMatch(/adding humans/i);
    });
  });

  it('singularizes "1 agent" in the sub-copy', () => {
    const v = deriveTeamStepView({ detectedAgentCount: 1, manualTeammateCount: 0 });
    expect(v.subcopy).toMatch(/\b1 agent\b/);
    expect(v.subcopy).not.toMatch(/1 agents/);
  });

  // Invariant: the detected-agents block visibility always tracks agent presence,
  // and the heading flips on the same condition — no state where they disagree.
  it('invariant: showDetectedAgents iff agents exist, heading flips on the same condition', () => {
    for (const detectedAgentCount of [0, 1, 5]) {
      for (const manualTeammateCount of [0, 1, 3]) {
        const v = deriveTeamStepView({ detectedAgentCount, manualTeammateCount });
        expect(v.showDetectedAgents).toBe(detectedAgentCount > 0);
        expect(/add team members/i.test(v.heading)).toBe(detectedAgentCount > 0);
      }
    }
  });
});
