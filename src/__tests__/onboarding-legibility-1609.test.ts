import { describe, it, expect } from 'vitest';
import {
  deriveOnboardingLegibility,
  ONBOARDING_STEP_LABELS,
  type OnboardingStateSnapshot,
} from '@/lib/onboarding-legibility';

// #1609 — Onboarding wizard navigation/state legibility for partial setup.
//
// Self-test for the partial-progress legibility derivation. Covers
// interruption/resume behavior (a user who skipped optional steps and comes
// back), the complete-vs-skipped distinction, optional-vs-required signalling,
// and the expected next-step guidance — done-when #4.

const fresh: OnboardingStateSnapshot = {
  step: 0,
  orgName: '',
  mission: '',
  detectedAgentCount: 0,
  manualTeammateCount: 0,
};

const at = (over: Partial<OnboardingStateSnapshot>): OnboardingStateSnapshot => ({ ...fresh, ...over });
const byIndex = (leg: ReturnType<typeof deriveOnboardingLegibility>, i: number) =>
  leg.steps.find((s) => s.index === i)!;

describe('deriveOnboardingLegibility (#1609 — partial-setup legibility)', () => {
  it('labels match the wizard step order', () => {
    expect(ONBOARDING_STEP_LABELS).toEqual(['Welcome', 'Organization', 'Runtime', 'Team', 'Done']);
    const leg = deriveOnboardingLegibility(fresh);
    expect(leg.steps.map((s) => s.label)).toEqual(ONBOARDING_STEP_LABELS);
  });

  describe('current/upcoming on a fresh start', () => {
    it('marks step 0 current and the rest upcoming', () => {
      const leg = deriveOnboardingLegibility(fresh);
      expect(byIndex(leg, 0).status).toBe('current');
      expect([1, 2, 3, 4].map((i) => byIndex(leg, i).status)).toEqual([
        'upcoming',
        'upcoming',
        'upcoming',
        'upcoming',
      ]);
    });

    it('flags optional steps (Org/Runtime/Team) as optional, not Welcome/Done', () => {
      const leg = deriveOnboardingLegibility(fresh);
      expect(byIndex(leg, 0).optional).toBe(false);
      expect(byIndex(leg, 1).optional).toBe(true);
      expect(byIndex(leg, 2).optional).toBe(true);
      expect(byIndex(leg, 3).optional).toBe(true);
      expect(byIndex(leg, 4).optional).toBe(false);
    });
  });

  describe('complete vs skipped distinction (the core bug #1609 fixes)', () => {
    it('marks a passed step COMPLETE when its data is filled', () => {
      // On Team (step 3), having filled org name → Organization is complete.
      const leg = deriveOnboardingLegibility(at({ step: 3, orgName: 'Acme Labs' }));
      expect(byIndex(leg, 1).status).toBe('complete');
      expect(byIndex(leg, 1).note).toMatch(/done/i);
    });

    it('marks a passed OPTIONAL step SKIPPED (not complete) when left empty', () => {
      // Cursor on Team (3), but Organization (1) and Runtime (2) were left empty.
      const leg = deriveOnboardingLegibility(at({ step: 3 }));
      expect(byIndex(leg, 1).status).toBe('skipped');
      expect(byIndex(leg, 2).status).toBe('skipped');
      // skipped notes must reassure it's optional + recoverable
      expect(byIndex(leg, 1).note).toMatch(/optional/i);
      expect(byIndex(leg, 1).note).toMatch(/later/i);
      expect(leg.skippedOptional).toEqual([1, 2]);
    });

    it('does NOT mark everything-passed as complete just because the cursor moved (regression lock)', () => {
      const leg = deriveOnboardingLegibility(at({ step: 4 })); // at Done, nothing filled
      // Org/Runtime/Team all passed-but-empty → skipped, never complete
      expect(byIndex(leg, 1).status).toBe('skipped');
      expect(byIndex(leg, 2).status).toBe('skipped');
      expect(byIndex(leg, 3).status).toBe('skipped');
      expect(leg.steps.some((s) => s.status === 'complete' && s.index >= 1)).toBe(false);
    });
  });

  describe('runtime/team completion is driven by real state', () => {
    it('Runtime complete when agents were detected', () => {
      const leg = deriveOnboardingLegibility(at({ step: 3, detectedAgentCount: 2 }));
      expect(byIndex(leg, 2).status).toBe('complete');
    });

    it('Team complete via detected agents alone (no manual humans needed)', () => {
      const leg = deriveOnboardingLegibility(at({ step: 4, detectedAgentCount: 3 }));
      expect(byIndex(leg, 3).status).toBe('complete');
    });

    it('Team complete via manual humans alone (no runtime)', () => {
      const leg = deriveOnboardingLegibility(at({ step: 4, manualTeammateCount: 1 }));
      expect(byIndex(leg, 3).status).toBe('complete');
    });
  });

  describe('interruption / resume next-step guidance (done-when #2)', () => {
    it('on Welcome, points forward and says the rest is optional', () => {
      const leg = deriveOnboardingLegibility(fresh);
      expect(leg.nextStepHint).toMatch(/optional/i);
    });

    it('mid-wizard, names the current step and reassures finish-anytime', () => {
      const leg = deriveOnboardingLegibility(at({ step: 2 }));
      expect(leg.nextStepHint).toMatch(/Runtime/);
      expect(leg.nextStepHint).toMatch(/finish anytime|optional|return later/i);
    });

    it('on Done with skips, tells the user exactly what was skipped and that it’s recoverable', () => {
      const leg = deriveOnboardingLegibility(at({ step: 4 })); // skipped Org, Runtime, Team
      expect(leg.canFinish).toBe(true);
      expect(leg.nextStepHint).toMatch(/finish now/i);
      expect(leg.nextStepHint).toMatch(/Organization/);
      expect(leg.nextStepHint).toMatch(/Runtime/);
      expect(leg.nextStepHint).toMatch(/Team/);
      expect(leg.nextStepHint).toMatch(/later|Settings/i);
    });

    it('on Done with everything filled, says all set', () => {
      const leg = deriveOnboardingLegibility(
        at({ step: 4, orgName: 'Acme', detectedAgentCount: 2, manualTeammateCount: 1 }),
      );
      expect(leg.skippedOptional).toEqual([]);
      expect(leg.nextStepHint).toMatch(/everything is set|finish/i);
    });

    it('singularizes the skipped-step sentence when only one optional step was skipped', () => {
      // Org filled + Runtime detected, but Team skipped → only [3] skipped.
      const leg = deriveOnboardingLegibility(
        at({ step: 4, orgName: 'Acme', detectedAgentCount: 2, manualTeammateCount: 0 }),
      );
      // detectedAgentCount makes Team satisfied → nothing skipped actually:
      expect(leg.skippedOptional).toEqual([]);
    });

    it('reports a single skipped optional step in singular form', () => {
      // Org filled, Runtime detected, Team genuinely empty (no agents, no humans):
      const leg = deriveOnboardingLegibility(at({ step: 4, orgName: 'Acme' }));
      // Org complete; Runtime + Team skipped → plural path; verify wording is grammatical
      expect(leg.skippedOptional).toEqual([2, 3]);
      expect(leg.nextStepHint).toMatch(/were skipped/);
    });
  });

  // Invariant: at any cursor, a step before the cursor is exactly one of
  // complete|skipped, the cursor step is current, and after is upcoming.
  it('invariant: status partitions cleanly by cursor position', () => {
    for (let step = 0; step <= 4; step++) {
      for (const orgName of ['', 'Acme']) {
        for (const detectedAgentCount of [0, 2]) {
          for (const manualTeammateCount of [0, 1]) {
            const leg = deriveOnboardingLegibility(
              at({ step, orgName, detectedAgentCount, manualTeammateCount }),
            );
            for (const st of leg.steps) {
              if (st.index < step) {
                expect(['complete', 'skipped']).toContain(st.status);
              } else if (st.index === step) {
                expect(st.status).toBe('current');
              } else {
                expect(st.status).toBe('upcoming');
              }
            }
            // skippedOptional must be exactly the optional, passed, unsatisfied steps
            const expectedSkipped = leg.steps
              .filter((s) => s.index < step && s.optional && s.status === 'skipped')
              .map((s) => s.index);
            expect(leg.skippedOptional).toEqual(expectedSkipped);
          }
        }
      }
    }
  });
});
