// #1609 — Onboarding wizard navigation/state legibility for partial setup
// (follow-up from #1601).
//
// Pure, side-effect-free derivation of per-step *legibility* for the onboarding
// wizard: which steps are genuinely complete, which were skipped, which is
// current, which are upcoming, and which are optional — plus a short "what
// remains / what to do next" summary so a user returning to a partially
// completed setup can resume without guessing (done-when #1/#2/#3).
//
// Extracted from the cursor-position logic inside OnboardingWizard.tsx, where a
// step was marked "done" (green ✓) purely because the cursor had moved past it
// (`i < step`) — which falsely implied skipped-but-passed steps were completed.
// This helper distinguishes *completed* from *skipped* from *passed*, based on
// the actual field state, and is unit-tested (done-when #4) across
// interruption/resume scenarios. No React/DOM/fetch here.

export type StepStatus =
  | 'complete' // genuinely filled in / satisfied
  | 'skipped' // cursor moved past it but it was left empty (optional steps only)
  | 'current' // the step the user is on right now
  | 'upcoming'; // not reached yet

export interface OnboardingStateSnapshot {
  /** Current step cursor (0-based): 0=Welcome 1=Org 2=Runtime 3=Team 4=Done. */
  step: number;
  /** Trimmed org name (empty string if unset). */
  orgName: string;
  /** Trimmed mission statement (empty string if unset). */
  mission: string;
  /** Agents auto-detected from a connected runtime. */
  detectedAgentCount: number;
  /** Humans the user added manually. */
  manualTeammateCount: number;
}

export interface StepLegibility {
  index: number;
  label: string;
  status: StepStatus;
  /** True if the step can be safely skipped without blocking completion. */
  optional: boolean;
  /** Short human note shown in a resume summary, e.g. "Skipped — optional". */
  note: string;
}

export interface OnboardingLegibility {
  steps: StepLegibility[];
  /** Indices of optional steps that were skipped (passed but left empty). */
  skippedOptional: number[];
  /** True once the user can finish (always true here — no step is hard-required;
   *  finishing is the only requirement). Surfaced so the UI can say so plainly. */
  canFinish: boolean;
  /** One-line guidance for resuming/next action, given the current state. */
  nextStepHint: string;
}

export const ONBOARDING_STEP_LABELS = ['Welcome', 'Organization', 'Runtime', 'Team', 'Done'];

// Which steps are optional. Welcome (0) is informational; Done (4) is terminal.
// Organization (1), Runtime (2), Team (3) are all individually skippable — the
// only true requirement is clicking Finish, so the UI should make "optional"
// explicit rather than implying every step must be filled.
const OPTIONAL_STEPS = new Set([1, 2, 3]);

/** Whether a given step's data is genuinely satisfied (not just passed by). */
function isStepSatisfied(index: number, s: OnboardingStateSnapshot): boolean {
  switch (index) {
    case 0:
      return true; // Welcome — informational, satisfied by acknowledgement
    case 1:
      return s.orgName.trim().length > 0 || s.mission.trim().length > 0;
    case 2:
      return s.detectedAgentCount > 0; // a runtime produced agents
    case 3:
      return s.detectedAgentCount > 0 || s.manualTeammateCount > 0;
    case 4:
      return false; // Done is terminal; never "complete" mid-wizard
    default:
      return false;
  }
}

export function deriveOnboardingLegibility(s: OnboardingStateSnapshot): OnboardingLegibility {
  const labels = ONBOARDING_STEP_LABELS;
  const skippedOptional: number[] = [];

  const steps: StepLegibility[] = labels.map((label, index) => {
    const optional = OPTIONAL_STEPS.has(index);
    let status: StepStatus;
    let note = '';

    if (index === s.step) {
      status = 'current';
      note = optional ? 'In progress — optional' : 'In progress';
    } else if (index > s.step) {
      status = 'upcoming';
      note = optional ? 'Optional' : '';
    } else {
      // index < cursor: passed. Did the user actually complete it?
      if (isStepSatisfied(index, s)) {
        status = 'complete';
        note = 'Done';
      } else {
        // passed but empty → skipped (only optional steps can legitimately be here)
        status = 'skipped';
        note = optional ? 'Skipped — optional, add later' : 'Skipped';
        if (optional) skippedOptional.push(index);
      }
    }

    return { index, label, status, optional, note };
  });

  // No step is hard-required; finishing is the only requirement.
  const canFinish = true;

  return {
    steps,
    skippedOptional,
    canFinish,
    nextStepHint: buildNextStepHint(s, skippedOptional),
  };
}

/** One-line resume/next-action guidance (done-when #2). */
function buildNextStepHint(s: OnboardingStateSnapshot, skippedOptional: number[]): string {
  // On the final step: tell them what's optional-but-empty so the finish is informed.
  if (s.step >= 4) {
    if (skippedOptional.length === 0) {
      return 'Everything is set — finish to go to your workspace.';
    }
    const names = skippedOptional.map((i) => ONBOARDING_STEP_LABELS[i]).join(', ');
    return `You can finish now. ${names} ${skippedOptional.length === 1 ? 'was' : 'were'} skipped (optional) — add ${skippedOptional.length === 1 ? 'it' : 'them'} later in Settings.`;
  }

  // Mid-wizard: name the current step and reassure that the rest is optional.
  const current = ONBOARDING_STEP_LABELS[s.step] ?? 'this step';
  if (s.step === 0) {
    return 'Continue to set up your organization, runtime, and team — all optional, and editable later.';
  }
  return `You're on ${current}. The remaining steps are optional — you can finish anytime, or fill them in and return later.`;
}
