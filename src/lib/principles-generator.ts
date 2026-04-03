/**
 * Operating Principles Generator
 *
 * Synthesizes behavioral operating principles from kudos/flags data.
 * Reads confirmed feedback signals, groups by value tag, applies templates,
 * and generates actionable principles for ORG.md injection.
 */

import { join } from 'path';
import { readFileSync, existsSync } from 'fs';

export interface OperatingPrinciple {
  text: string;       // The principle itself
  source: 'kudos' | 'flag'; // Derived from positive or negative feedback
  values: string[];   // Which values it maps to
  signalCount: number; // How many signals informed this principle
}

interface Kudos {
  id: string;
  agentId: string;
  givenBy: string;
  values: string[];
  note: string;
  type: 'kudos' | 'flag';
  autoDetected: boolean;
  confirmed: boolean;
  createdAt: number;
}

/**
 * Load kudos from file (mirroring the kudos route implementation)
 */
function loadKudosFromFile(): Kudos[] {
  const kudosFile = join(process.cwd(), 'data', 'kudos.json');
  try {
    if (!existsSync(kudosFile)) return [];
    const content = readFileSync(kudosFile, 'utf-8');
    return JSON.parse(content) || [];
  } catch {
    return [];
  }
}

/**
 * Try to load from PostgreSQL; fallback to file
 */
async function loadKudosFromDB(): Promise<Kudos[]> {
  if (!process.env.DATABASE_URL) {
    return loadKudosFromFile();
  }

  try {
    const pgModule = await import('pg');
    const { Pool } = pgModule as any;
    const pool = new Pool({ connectionString: process.env.DATABASE_URL });
    const result = await pool.query(
      `SELECT id, agent_id as "agentId", given_by as "givenBy", value_tags as "valueTags",
              note, type, auto_detected as "autoDetected", confirmed, created_at as "createdAt"
       FROM org_studio_kudos
       WHERE confirmed = true
       ORDER BY created_at DESC`
    );
    await pool.end();

    return result.rows.map((row: any) => ({
      ...row,
      values: typeof row.valueTags === 'string' ? JSON.parse(row.valueTags) : row.valueTags,
    }));
  } catch {
    // Fallback to file (table may not exist yet)
    return loadKudosFromFile();
  }
}

/**
 * Principle templates for recognised value tags
 */
const PRINCIPLE_TEMPLATES = {
  kudos: {
    autonomy:
      "When facing a reversible decision in your domain: decide, document your rationale, and move on. Don't escalate unless the decision is irreversible or crosses domain boundaries.",
    curiosity:
      'Explore creative solutions before defaulting to the obvious approach. When you find a better way, document what you learned for future reference.',
    teamwork:
      "When your work touches another agent's domain, proactively communicate what you're changing and why. Coordinate before committing, not after.",
    'people-first':
      'Prioritize user-facing impact over internal improvements. When choosing between tasks, pick the one that most directly serves a real user need.',
  },
  flag: {
    autonomy:
      "Avoid unnecessary escalation. If a decision is within your domain and reversible, make the call yourself. Only escalate when the impact is irreversible or outside your ownership.",
    curiosity:
      "Don't take the path of least resistance when a better approach exists. Invest time understanding the problem before jumping to implementation.",
    teamwork:
      "Don't go dark on long-running tasks. Post status updates proactively, especially when something takes longer than expected.",
    'people-first':
      "Don't ship internal improvements without connecting them to user value. Every task should trace back to a user benefit.",
  },
} as const;

type KnownValue = keyof typeof PRINCIPLE_TEMPLATES.kudos;

/**
 * Generate a generic principle for a value tag without a template
 */
function generateGenericPrinciple(value: string, signalCount: number, type: 'kudos' | 'flag'): string {
  const n = signalCount;
  if (type === 'kudos') {
    return `Continue demonstrating ${value} — your track record of ${n} positive signal${n !== 1 ? 's' : ''} shows this is a strength. Keep it up.`;
  }
  return `Pay attention to ${value} — ${n} signal${n !== 1 ? 's' : ''} suggest this is an area for improvement. Be deliberate about it.`;
}

interface GroupedSignals {
  [valueTag: string]: { kudos: Kudos[]; flags: Kudos[] };
}

function groupSignals(kudos: Kudos[]): GroupedSignals {
  const groups: GroupedSignals = {};
  for (const k of kudos) {
    for (const value of k.values) {
      if (!groups[value]) groups[value] = { kudos: [], flags: [] };
      if (k.type === 'kudos') {
        groups[value].kudos.push(k);
      } else {
        groups[value].flags.push(k);
      }
    }
  }
  return groups;
}

/**
 * If 3+ kudos/flags share the exact same note text, surface that note as a custom principle.
 */
function extractCustomPrinciples(kudos: Kudos[]): OperatingPrinciple[] {
  const noteGroups: { [key: string]: Kudos[] } = {};
  for (const k of kudos) {
    const key = k.note.toLowerCase().trim();
    if (!noteGroups[key]) noteGroups[key] = [];
    noteGroups[key].push(k);
  }

  const principles: OperatingPrinciple[] = [];
  for (const [note, signals] of Object.entries(noteGroups)) {
    if (signals.length >= 3) {
      const type = signals[0].type;
      const values = Array.from(new Set(signals.flatMap(s => s.values)));
      principles.push({ text: note, source: type, values, signalCount: signals.length });
    }
  }
  return principles;
}

/**
 * Generate operating principles for a given agent.
 *
 * Requires ≥ 2 confirmed signals of the same type for a given value tag
 * before generating a principle. Flag-derived principles sort first
 * (corrective feedback is more urgent).
 */
export async function generatePrinciples(agentId: string): Promise<OperatingPrinciple[]> {
  const allKudos = await loadKudosFromDB();

  // Case-insensitive match — DB may store mixed-case agent IDs
  const agentKudos = allKudos.filter(
    k => k.agentId.toLowerCase() === agentId.toLowerCase() && k.confirmed
  );

  if (agentKudos.length === 0) return [];

  const principles: OperatingPrinciple[] = [
    // Custom principles from highly repeated identical notes
    ...extractCustomPrinciples(agentKudos),
  ];

  const grouped = groupSignals(agentKudos);

  for (const [value, signals] of Object.entries(grouped)) {
    // Corrections first (flags)
    if (signals.flags.length >= 2) {
      const text =
        PRINCIPLE_TEMPLATES.flag[value as KnownValue] ??
        generateGenericPrinciple(value, signals.flags.length, 'flag');
      principles.push({ text, source: 'flag', values: [value], signalCount: signals.flags.length });
    }

    // Reinforcements (kudos)
    if (signals.kudos.length >= 2) {
      const text =
        PRINCIPLE_TEMPLATES.kudos[value as KnownValue] ??
        generateGenericPrinciple(value, signals.kudos.length, 'kudos');
      principles.push({ text, source: 'kudos', values: [value], signalCount: signals.kudos.length });
    }
  }

  // Flags first, then kudos; preserve insertion order within each group
  return principles.sort((a, b) => {
    if (a.source === b.source) return 0;
    return a.source === 'flag' ? -1 : 1;
  });
}
