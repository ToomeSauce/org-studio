import { describe, it, expect } from 'vitest';
import {
  evaluateOnboardingRecovery,
  type OnboardingRecoveryInput,
} from '@/lib/onboarding-recovery';

// #1607 — Onboarding recovery hardening (follow-up from #1601/#1606).
//
// Self-test for the recovery-surface decision logic. Covers the three flows
// called out in done-when #4 — first-run, partial-setup, and reset/restart
// recovery — plus the mutual-exclusivity invariants Henry verified by hand on
// #1606 (banner and full-wizard never both fire from the natural state; a
// deliberate skipper is never nagged; dismissal is per-session, not permanent).

// Sensible defaults = "store loaded, mid-recovery candidate". Each test overrides
// only the fields that matter to the case it exercises.
const base: OnboardingRecoveryInput = {
  storeLoaded: true,
  onboardingComplete: false,
  storeIsEmpty: false,
  bannerDismissed: false,
  forceWizard: false,
};

describe('evaluateOnboardingRecovery (#1607)', () => {
  // ── Flow 1: First run ──────────────────────────────────────────────────────
  describe('first-run flow (empty workspace, never onboarded)', () => {
    it('shows the full-screen wizard when the workspace is empty and not onboarded', () => {
      const d = evaluateOnboardingRecovery({ ...base, storeIsEmpty: true });
      expect(d.mode).toBe('full-wizard');
      expect(d.showWizard).toBe(true);
      expect(d.showResumeBanner).toBe(false);
    });

    it('does NOT show the banner on a first run (wizard takes over instead)', () => {
      const d = evaluateOnboardingRecovery({ ...base, storeIsEmpty: true });
      expect(d.showResumeBanner).toBe(false);
    });

    it('a per-session dismissal does NOT suppress the first-run wizard takeover', () => {
      // Dismissal is a banner concern only; an empty workspace still gets the wizard.
      const d = evaluateOnboardingRecovery({
        ...base,
        storeIsEmpty: true,
        bannerDismissed: true,
      });
      expect(d.mode).toBe('full-wizard');
      expect(d.showWizard).toBe(true);
    });
  });

  // ── Flow 2: Partial setup (started, has data, never finished) ───────────────
  describe('partial-setup flow (data exists, onboarding incomplete)', () => {
    it('shows the dismissible resume banner, NOT a full-screen takeover', () => {
      const d = evaluateOnboardingRecovery(base); // data exists, incomplete, not dismissed
      expect(d.mode).toBe('resume-banner');
      expect(d.showResumeBanner).toBe(true);
      expect(d.showWizard).toBe(false);
    });

    it('hides the banner for the session once dismissed', () => {
      const d = evaluateOnboardingRecovery({ ...base, bannerDismissed: true });
      expect(d.mode).toBe('none');
      expect(d.showResumeBanner).toBe(false);
      expect(d.showWizard).toBe(false);
    });

    it('dismissal is per-session only — banner returns next session (fresh dismissed=false)', () => {
      // Simulate "next session": same incomplete+data state, dismissal flag reset.
      const dismissed = evaluateOnboardingRecovery({ ...base, bannerDismissed: true });
      const nextSession = evaluateOnboardingRecovery({ ...base, bannerDismissed: false });
      expect(dismissed.showResumeBanner).toBe(false);
      expect(nextSession.showResumeBanner).toBe(true);
    });
  });

  // ── Flow 3: Reset / restart recovery ────────────────────────────────────────
  describe('reset/restart flow (Settings reset on a non-empty workspace)', () => {
    it('after reset (onboardingComplete=false) on a workspace WITH data, the banner returns', () => {
      // This is the latent bug #1606 fixed and #1607 hardens: reset used to be a
      // no-op on non-empty workspaces. The recovery surface must appear.
      const afterReset = evaluateOnboardingRecovery({
        ...base,
        onboardingComplete: false,
        storeIsEmpty: false,
        bannerDismissed: false, // reset clears the dismissal flag
      });
      expect(afterReset.mode).toBe('resume-banner');
      expect(afterReset.showResumeBanner).toBe(true);
    });

    it('resume re-entry works without ?onboarding=true (banner drives it, not the URL param)', () => {
      // The natural decision (no forceWizard) still surfaces a recovery affordance;
      // the URL param is only an extra escape hatch, never the sole path.
      const natural = evaluateOnboardingRecovery(base);
      expect(natural.showResumeBanner).toBe(true);
      expect(natural.reason).toMatch(/recoverable/i);
    });

    it('reset on a truly EMPTY workspace goes full-wizard (not banner)', () => {
      const afterResetEmpty = evaluateOnboardingRecovery({
        ...base,
        onboardingComplete: false,
        storeIsEmpty: true,
      });
      expect(afterResetEmpty.mode).toBe('full-wizard');
      expect(afterResetEmpty.showWizard).toBe(true);
    });
  });

  // ── Completion / no-nag contract ────────────────────────────────────────────
  describe('completion contract (deliberate skip = done, no nag)', () => {
    it('shows NOTHING once onboarding is complete, even with a stale dismissal flag', () => {
      const d = evaluateOnboardingRecovery({
        ...base,
        onboardingComplete: true,
        bannerDismissed: true,
      });
      expect(d.mode).toBe('none');
      expect(d.showWizard).toBe(false);
      expect(d.showResumeBanner).toBe(false);
    });

    it('"Skip for now" (which sets onboardingComplete=true) is NOT nagged with a banner', () => {
      // A user who skipped on a non-empty workspace made a choice; no recovery surface.
      const skipper = evaluateOnboardingRecovery({
        ...base,
        onboardingComplete: true,
        storeIsEmpty: false,
      });
      expect(skipper.showResumeBanner).toBe(false);
      expect(skipper.showWizard).toBe(false);
    });

    it('completion wins even on an empty workspace (no wizard re-takeover after completing)', () => {
      const d = evaluateOnboardingRecovery({
        ...base,
        onboardingComplete: true,
        storeIsEmpty: true,
      });
      expect(d.mode).toBe('none');
    });
  });

  // ── Loading gate (no flash before data) ─────────────────────────────────────
  describe('load gating (do not flash a recovery surface before data loads)', () => {
    it('shows nothing while the store has not loaded yet — empty case', () => {
      const d = evaluateOnboardingRecovery({
        ...base,
        storeLoaded: false,
        storeIsEmpty: true,
      });
      expect(d.mode).toBe('none');
      expect(d.showWizard).toBe(false);
    });

    it('shows nothing while the store has not loaded yet — partial case', () => {
      const d = evaluateOnboardingRecovery({ ...base, storeLoaded: false });
      expect(d.mode).toBe('none');
      expect(d.showResumeBanner).toBe(false);
    });
  });

  // ── Force escape hatch (?onboarding=true) ───────────────────────────────────
  describe('forceWizard escape hatch (?onboarding=true)', () => {
    it('forces the wizard regardless of completion/data state', () => {
      const d = evaluateOnboardingRecovery({
        ...base,
        onboardingComplete: true,
        storeIsEmpty: false,
        forceWizard: true,
      });
      expect(d.mode).toBe('full-wizard');
      expect(d.showWizard).toBe(true);
      expect(d.showResumeBanner).toBe(false);
    });

    it('force wins even before the store loads (demo/screenshot path)', () => {
      const d = evaluateOnboardingRecovery({
        ...base,
        storeLoaded: false,
        forceWizard: true,
      });
      expect(d.showWizard).toBe(true);
    });
  });

  // ── Mutual-exclusivity invariant (Henry's edge case #3, exhaustive) ─────────
  describe('invariant: wizard and resume-banner are never both true', () => {
    it('holds across the full boolean cross-product of inputs', () => {
      const bools = [true, false];
      for (const storeLoaded of bools) {
        for (const onboardingComplete of bools) {
          for (const storeIsEmpty of bools) {
            for (const bannerDismissed of bools) {
              for (const forceWizard of bools) {
                const d = evaluateOnboardingRecovery({
                  storeLoaded,
                  onboardingComplete,
                  storeIsEmpty,
                  bannerDismissed,
                  forceWizard,
                });
                // Never both surfaces at once.
                expect(d.showWizard && d.showResumeBanner).toBe(false);
                // The convenience booleans always agree with the mode.
                expect(d.showWizard).toBe(d.mode === 'full-wizard');
                expect(d.showResumeBanner).toBe(d.mode === 'resume-banner');
                // Every decision carries a non-empty reason.
                expect(d.reason.length).toBeGreaterThan(0);
              }
            }
          }
        }
      }
    });
  });
});
