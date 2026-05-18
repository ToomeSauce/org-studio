// Shared teammate color system — maps color key to CSS classes
// All components (team page, dashboard, tasks, projects, force graph, solar system)
// should resolve teammate colors through these maps.

export interface Teammate {
  id: string;
  agentId: string;
  name: string;
  emoji: string;
  avatar?: string; // URL or data URI for custom avatar image (overrides emoji)
  title: string;
  domain: string;
  owns?: string;    // What this teammate owns — autonomous decision scope
  defers?: string;  // What requires escalation / confirmation
  context?: string; // Free-text domain context injected into ORG.md (branch policies, repo paths, safety rules, coordination notes)
  description: string;
  color: string; // color key: 'red', 'emerald', 'cyan', 'purple', 'amber', etc.
  isHuman?: boolean;

  // #1352 — Claim contract escalation ladder. Per-teammate counters with
  // 24-hour decay: each auto-bounce event from a stale claim increments
  // staleClaimCount and stamps staleClaimCountedAt. The scheduler tick
  // is responsible for decaying entries older than 24h on read. Ladder:
  //   count == 1 within 24h → system comment on the offending task
  //   count == 2 within 24h → topic ping to the agent + offending list
  //   count == 3 within 24h → set loopDisabledAt; dispatch path skips
  //     this agent until cleared. Cleared on next agent start OR by a
  //     human via the Team page (it's a flag, not a kill).
  // All fields are best-effort: missing means "no penalty yet".
  staleClaimCount?: number;
  staleClaimCountedAt?: number; // ms epoch of the most recent increment
  loopDisabledAt?: number;      // ms epoch when scheduler dispatch was disabled
  loopDisableReason?: string;   // human-readable cause for audit/UI

  // #1386 Phase 2 — optional per-agent API token (plaintext fallback string).
  // When present, the scheduler/dispatch path prefers this token over the
  // global ORG_STUDIO_API_KEY when launching the agent. Mint via the Team
  // page UI (which calls POST /api/admin/tokens). Storing plaintext in
  // settings is acceptable for the per-agent token because settings.json
  // already lives on the same host the agent runs on — it's not crossing
  // a trust boundary. For tighter isolation, store the token id only and
  // re-resolve at launch time (future hardening).
  agentToken?: string;
}



export const COLOR_MAP: Record<string, {
  text: string;
  bg: string;
  glow: string;
  glowRgba: string;
  bgRgba: string;
  border: string;
}> = {
  red: {
    text: 'text-[var(--accent-primary)]',
    bg: 'bg-[rgba(255,92,92,0.15)]',
    glow: 'hover:shadow-[0_0_20px_rgba(255,92,92,0.15)]',
    glowRgba: 'rgba(255,92,92,0.4)',
    bgRgba: 'rgba(255,92,92,0.15)',
    border: 'rgba(255,92,92,0.3)',
  },
  emerald: {
    text: 'text-emerald-400',
    bg: 'bg-[rgba(52,211,153,0.12)]',
    glow: 'hover:shadow-[0_0_20px_rgba(52,211,153,0.12)]',
    glowRgba: 'rgba(52,211,153,0.4)',
    bgRgba: 'rgba(52,211,153,0.12)',
    border: 'rgba(52,211,153,0.3)',
  },
  cyan: {
    text: 'text-cyan-400',
    bg: 'bg-[rgba(34,211,238,0.12)]',
    glow: 'hover:shadow-[0_0_20px_rgba(34,211,238,0.12)]',
    glowRgba: 'rgba(34,211,238,0.4)',
    bgRgba: 'rgba(34,211,238,0.12)',
    border: 'rgba(34,211,238,0.3)',
  },
  purple: {
    text: 'text-purple-400',
    bg: 'bg-[rgba(168,85,247,0.12)]',
    glow: 'hover:shadow-[0_0_20px_rgba(168,85,247,0.12)]',
    glowRgba: 'rgba(168,85,247,0.4)',
    bgRgba: 'rgba(168,85,247,0.12)',
    border: 'rgba(168,85,247,0.3)',
  },
  amber: {
    text: 'text-amber-400',
    bg: 'bg-[rgba(251,191,36,0.15)]',
    glow: 'hover:shadow-[0_0_20px_rgba(251,191,36,0.15)]',
    glowRgba: 'rgba(251,191,36,0.4)',
    bgRgba: 'rgba(251,191,36,0.15)',
    border: 'rgba(251,191,36,0.3)',
  },
  blue: {
    text: 'text-blue-400',
    bg: 'bg-[rgba(96,165,250,0.12)]',
    glow: 'hover:shadow-[0_0_20px_rgba(96,165,250,0.12)]',
    glowRgba: 'rgba(96,165,250,0.4)',
    bgRgba: 'rgba(96,165,250,0.12)',
    border: 'rgba(96,165,250,0.3)',
  },
  pink: {
    text: 'text-pink-400',
    bg: 'bg-[rgba(244,114,182,0.12)]',
    glow: 'hover:shadow-[0_0_20px_rgba(244,114,182,0.12)]',
    glowRgba: 'rgba(244,114,182,0.4)',
    bgRgba: 'rgba(244,114,182,0.12)',
    border: 'rgba(244,114,182,0.3)',
  },
  orange: {
    text: 'text-orange-400',
    bg: 'bg-[rgba(251,146,60,0.12)]',
    glow: 'hover:shadow-[0_0_20px_rgba(251,146,60,0.12)]',
    glowRgba: 'rgba(251,146,60,0.4)',
    bgRgba: 'rgba(251,146,60,0.12)',
    border: 'rgba(251,146,60,0.3)',
  },
};

const DEFAULT_COLOR = COLOR_MAP.blue;

export const COLOR_KEYS = Object.keys(COLOR_MAP);

export function resolveColor(key: string) {
  return COLOR_MAP[key] || DEFAULT_COLOR;
}

// Build a name→color lookup from teammate list (for tasks/projects pages)
export function buildNameColorMap(teammates: Teammate[]): Record<string, string> {
  const map: Record<string, string> = {};
  for (const t of teammates) {
    map[t.name] = resolveColor(t.color).text;
  }
  return map;
}

// Build an agentId→teammate lookup
export function buildAgentMap(teammates: Teammate[]): Record<string, Teammate> {
  const map: Record<string, Teammate> = {};
  for (const t of teammates) {
    if (t.agentId) map[t.agentId] = t;
    map[t.id] = t;
  }
  return map;
}

/**
 * #1386 Phase 2 — Resolve the API token an agent should use when calling
 * org-studio APIs from its own shell. Prefers a per-agent token from
 * settings.teammates[i].agentToken, falls back to the global
 * ORG_STUDIO_API_KEY env var (current behavior).
 *
 * The dispatch path is the consumer: it injects the resolved value as
 * ORG_STUDIO_API_KEY in the agent process's environment. Prompts continue
 * to reference ${ORG_STUDIO_API_KEY} literally — they never see whether
 * it's a global or per-agent token. This means existing prompts work
 * unchanged; only the launch-time env construction changes.
 *
 * Returns null if no token is available (auth disabled / dev mode).
 */
export function resolveAgentApiToken(teammates: Teammate[], agentId: string): string | null {
  const t = teammates.find((x) => x.agentId === agentId || x.id === agentId);
  if (t?.agentToken && typeof t.agentToken === 'string' && t.agentToken.trim()) {
    return t.agentToken.trim();
  }
  return process.env.ORG_STUDIO_API_KEY || null;
}
