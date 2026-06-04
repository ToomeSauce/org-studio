// #1608 — Onboarding wizard runtime/team guidance clarity (follow-up from #1601).
//
// Pure, side-effect-free derivation of the *view state* (headings, sub-copy,
// hints, status lines) for the wizard's Runtime step (Step 2) and Team step
// (Step 3). Extracted from inline JSX in OnboardingWizard.tsx so the copy/state
// transitions can be unit-tested (done-when #4) across the no-runtime,
// runtime-detected, and mixed detected+manual states — instead of relying on a
// DOM render harness to assert wizard wording.
//
// The component renders whatever these helpers return; no React/DOM/fetch here.

// ── Runtime step (Step 2) ──────────────────────────────────────────────────

export type RuntimePhase =
  | 'not-polled' // detection hasn't run yet → prompt the user to detect
  | 'detected' // poll completed, at least one runtime connected
  | 'none-detected'; // poll completed, zero runtimes connected → standalone is fine

export interface RuntimeStepInput {
  /** Whether a detection poll has completed at least once. */
  hasPolledRuntimes: boolean;
  /** Number of runtimes reported as connected by the last poll. */
  connectedRuntimeCount: number;
  /** Number of agents discovered across all connected runtimes. */
  detectedAgentCount: number;
}

export interface RuntimeStepView {
  phase: RuntimePhase;
  /** One-line explanation of WHAT a connected runtime is / why it matters
   *  (done-when #1) — always present, regardless of phase. */
  whatIsRuntime: string;
  /** Phase-specific status headline shown near the detect button. */
  statusHeadline: string;
  /** Phase-specific guidance under the headline. */
  statusDetail: string;
  /** True when the "Continue to skip" affordance should be emphasized (no runtime). */
  skipEncouraged: boolean;
}

const WHAT_IS_RUNTIME =
  'A runtime is the live connection (OpenClaw or Hermes) that lets your agents actually receive and work on tasks. Connect one to auto-import your agents; skip it to run Org Studio standalone and connect later.';

export function deriveRuntimeStepView(input: RuntimeStepInput): RuntimeStepView {
  const { hasPolledRuntimes, connectedRuntimeCount, detectedAgentCount } = input;

  if (!hasPolledRuntimes) {
    return {
      phase: 'not-polled',
      whatIsRuntime: WHAT_IS_RUNTIME,
      statusHeadline: 'Detect your agent runtime',
      statusDetail:
        'Click “Detect Runtimes” to find connected agent services (OpenClaw, Hermes). This is optional — you can skip and connect later.',
      skipEncouraged: false,
    };
  }

  if (connectedRuntimeCount > 0) {
    const agentsPart =
      detectedAgentCount > 0
        ? `Found ${detectedAgentCount} agent${detectedAgentCount !== 1 ? 's' : ''} — they’ll be added to your team roster automatically.`
        : 'Connected, but no agents are registered on it yet. You can add agents to the runtime later; they’ll appear here next time.';
    return {
      phase: 'detected',
      whatIsRuntime: WHAT_IS_RUNTIME,
      statusHeadline: `Runtime connected (${connectedRuntimeCount})`,
      statusDetail: agentsPart,
      skipEncouraged: false,
    };
  }

  // Polled, zero connected.
  return {
    phase: 'none-detected',
    whatIsRuntime: WHAT_IS_RUNTIME,
    statusHeadline: 'No runtime detected — that’s fine.',
    statusDetail:
      'You can run Org Studio standalone and connect an agent runtime later in Settings, or set GATEWAY_URL in .env.local. Click Continue to skip this step.',
    skipEncouraged: true,
  };
}

// ── Team step (Step 3) ─────────────────────────────────────────────────────

export type TeamComposition =
  | 'agents-only' // detected agents, no manual humans added (yet)
  | 'manual-only' // no detected agents, humans added manually
  | 'mixed' // both detected agents AND manual humans
  | 'empty'; // neither — nothing configured yet

export interface TeamStepInput {
  /** Agents auto-detected from the runtime (already on the roster, read-only). */
  detectedAgentCount: number;
  /** Humans the user has added manually in this step. */
  manualTeammateCount: number;
}

export interface TeamStepView {
  composition: TeamComposition;
  /** Step heading — reflects whether agents are already present. */
  heading: string;
  /** Sub-copy that distinguishes detected agents from manual setup (done-when #2). */
  subcopy: string;
  /** Whether to render the read-only "agents already added" chips block. */
  showDetectedAgents: boolean;
  /** Label for the detected-agents block, e.g. "Agents already added (3)". */
  detectedAgentsLabel: string;
  /** Clarifier under the detected-agents chips, present only when agents exist. */
  detectedAgentsNote: string;
}

export function deriveTeamStepView(input: TeamStepInput): TeamStepView {
  const { detectedAgentCount, manualTeammateCount } = input;
  const hasAgents = detectedAgentCount > 0;
  const hasHumans = manualTeammateCount > 0;

  const composition: TeamComposition = hasAgents
    ? hasHumans
      ? 'mixed'
      : 'agents-only'
    : hasHumans
      ? 'manual-only'
      : 'empty';

  const agentWord = `agent${detectedAgentCount !== 1 ? 's' : ''}`;

  const heading = hasAgents ? 'Add Team Members' : 'Build Your Team';

  // Sub-copy always makes the agents-vs-humans distinction explicit so the user
  // is never confused about what is already configured vs. what they're adding.
  const subcopy = hasAgents
    ? `We found ${detectedAgentCount} ${agentWord} — they're already on your roster (shown below). This step is for adding humans.`
    : 'Add the people on your team. Agents are imported automatically when a runtime is connected — you can do that later.';

  const detectedAgentsLabel = `Agents already added (${detectedAgentCount})`;
  const detectedAgentsNote =
    'Auto-imported from your runtime. This step is for adding humans — add them below.';

  return {
    composition,
    heading,
    subcopy,
    showDetectedAgents: hasAgents,
    detectedAgentsLabel,
    detectedAgentsNote,
  };
}
