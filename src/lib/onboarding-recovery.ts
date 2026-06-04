// #1607 — Onboarding recovery hardening (follow-up from #1601/#1606).
//
// Pure, side-effect-free decision logic for "what onboarding recovery surface
// (if any) should the dashboard show right now?". Extracted from inline booleans
// in app/(dashboard)/page.tsx so the first-run / partial-setup / reset-restart
// recovery flows are unit-testable (done-when #4) and the mutually-exclusive
// invariants Henry verified on #1606 are encoded in one place rather than three
// scattered conditions.
//
// The route/component applies the decision (renders the wizard, the banner, or
// neither); this function only decides. No React, no DOM, no storage access here.

export type OnboardingRecoveryMode =
  | 'full-wizard' // truly empty workspace, never onboarded → full-screen auto-takeover
  | 'resume-banner' // setup started but unfinished AND data exists → dismissible banner
  | 'none'; // nothing to recover (completed, or not yet loaded, or banner dismissed)

export interface OnboardingRecoveryInput {
  /** True once the store snapshot has loaded; gates against flashing a recovery
   *  surface before we know the real state. */
  storeLoaded: boolean;
  /** settings.onboardingComplete === true. Skip-for-now sets this true (#1604),
   *  so a deliberate skipper is NOT a recovery candidate. */
  onboardingComplete: boolean;
  /** No teammates, no projects, and no real mission statement set. */
  storeIsEmpty: boolean;
  /** Per-session banner dismissal (sessionStorage). Hides the banner for the
   *  session but does NOT suppress the full-wizard first-run takeover. */
  bannerDismissed: boolean;
  /** ?onboarding=true escape hatch — force the wizard regardless of state
   *  (demos/screenshots, or a manual re-entry link). */
  forceWizard?: boolean;
}

export interface OnboardingRecoveryDecision {
  mode: OnboardingRecoveryMode;
  /** Whether the full-screen wizard should render (mode === 'full-wizard' OR forced). */
  showWizard: boolean;
  /** Whether the dismissible resume banner should render (mode === 'resume-banner'). */
  showResumeBanner: boolean;
  /** Human-readable reason for the chosen mode — for debugging/telemetry/tests. */
  reason: string;
}

/**
 * Decide the onboarding recovery surface for the current dashboard state.
 *
 * Precedence (mutually exclusive by construction — never both wizard + banner
 * from the natural state; the only way both-ish happens is an explicit
 * `forceWizard`, which intentionally wins):
 *   1. forceWizard            → full-wizard   (explicit ?onboarding=true / manual)
 *   2. !storeLoaded           → none          (don't flash before data loads)
 *   3. onboardingComplete     → none          (done — incl. deliberate skip)
 *   4. storeIsEmpty           → full-wizard   (genuine first run, auto-takeover)
 *   5. bannerDismissed        → none          (recovery available, hidden this session)
 *   6. otherwise              → resume-banner (started but unfinished, data exists)
 */
export function evaluateOnboardingRecovery(
  input: OnboardingRecoveryInput,
): OnboardingRecoveryDecision {
  const {
    storeLoaded,
    onboardingComplete,
    storeIsEmpty,
    bannerDismissed,
    forceWizard = false,
  } = input;

  // 1. Explicit force always wins (demos/screenshots/manual re-entry link).
  if (forceWizard) {
    return {
      mode: 'full-wizard',
      showWizard: true,
      showResumeBanner: false,
      reason: 'forced via ?onboarding=true',
    };
  }

  // 2. Never render a recovery surface before the store has loaded — avoids a
  //    flash of the wizard/banner on first paint, then a snap to the real state.
  if (!storeLoaded) {
    return {
      mode: 'none',
      showWizard: false,
      showResumeBanner: false,
      reason: 'store not loaded yet',
    };
  }

  // 3. Onboarding complete (includes the deliberate "Skip for now" path, which
  //    sets onboardingComplete=true) → no recovery surface, ever. The moment
  //    setup finishes the banner is gone for good regardless of any stale
  //    sessionStorage dismissal flag.
  if (onboardingComplete) {
    return {
      mode: 'none',
      showWizard: false,
      showResumeBanner: false,
      reason: 'onboarding already complete',
    };
  }

  // 4. Truly empty workspace + not onboarded → full-screen auto-takeover
  //    (genuine first run). This is the ONLY path that hijacks the screen.
  if (storeIsEmpty) {
    return {
      mode: 'full-wizard',
      showWizard: true,
      showResumeBanner: false,
      reason: 'empty workspace, first run',
    };
  }

  // 5. Recovery is available (incomplete + data exists), but the user dismissed
  //    the banner this session. Hide it for now; it returns next session until
  //    onboarding actually completes (the dismissal is per-session, not permanent).
  if (bannerDismissed) {
    return {
      mode: 'none',
      showWizard: false,
      showResumeBanner: false,
      reason: 'incomplete but banner dismissed this session',
    };
  }

  // 6. Started but never finished AND the workspace already has data (abandoned
  //    mid-flow, or Settings → Reset Onboarding on a non-empty workspace). Show
  //    the dismissible "Resume setup" banner — discoverable, not a full-screen nag.
  return {
    mode: 'resume-banner',
    showWizard: false,
    showResumeBanner: true,
    reason: 'onboarding incomplete with existing data — recoverable',
  };
}
