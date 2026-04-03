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
  description: string;
  color: string; // color key: 'red', 'emerald', 'cyan', 'purple', 'amber', etc.
  isHuman?: boolean;
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
