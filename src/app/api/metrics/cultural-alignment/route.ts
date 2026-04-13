import { NextResponse } from 'next/server';
import { getStoreProvider } from '@/lib/store-provider';

interface KudosEntry {
  id: string;
  agentId: string;
  givenBy: string;
  taskId?: string;
  projectId?: string;
  values: string[];
  note: string;
  type: 'kudos' | 'flag';
  autoDetected: boolean;
  confirmed: boolean;
  createdAt: number;
}

interface PactValueConfig {
  icon: string;
  title: string;
  letter: string;
  description?: string;
}

/** Normalize agentId to Title Case — e.g. "ana" → "Ana" */
function toTitleCase(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** Compute ISO 8601 week string e.g. "2026-W13" */
function getISOWeek(ts: number): string {
  const date = new Date(ts);
  // Clone date, set to Thursday of current week (ISO weeks start Monday)
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  // ISO week: Thursday of the week
  const day = d.getUTCDay() === 0 ? 7 : d.getUTCDay();
  d.setUTCDate(d.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const weekNum = Math.ceil((((d.getTime() - yearStart.getTime()) / 86400000) + 1) / 7);
  return `${d.getUTCFullYear()}-W${String(weekNum).padStart(2, '0')}`;
}

const VALUE_SLUGS = ['people-first', 'autonomy', 'curiosity', 'teamwork'];

const DEFAULT_PACT_VALUES: PactValueConfig[] = [
  { icon: '📣', title: 'People-First', letter: 'P' },
  { icon: '🔥', title: 'Autonomy', letter: 'A' },
  { icon: '🔍', title: 'Curiosity', letter: 'C' },
  { icon: '🤝', title: 'Teamwork', letter: 'T' },
];

export async function GET() {
  try {
    // --- Load PACT values from store ---
    const provider = getStoreProvider();
    const store = await provider.read();
    const pactConfig: PactValueConfig[] =
      store?.settings?.values?.items || DEFAULT_PACT_VALUES;

    // Build slug → config map (match by letter order or title slug)
    const slugToConfig: Record<string, PactValueConfig> = {};
    VALUE_SLUGS.forEach((slug, idx) => {
      slugToConfig[slug] = pactConfig[idx] || DEFAULT_PACT_VALUES[idx];
    });

    // --- Fetch kudos ---
    let allKudos: KudosEntry[] = [];
    try {
      const res = await fetch('http://localhost:4501/api/kudos?limit=500', {
        headers: { 'X-Internal-Request': 'true' },
      });
      if (res.ok) {
        const data = await res.json();
        allKudos = data.kudos || [];
      }
    } catch (e) {
      console.warn('[cultural-alignment] Failed to fetch kudos:', e);
    }

    // --- pactValues: per-value counts ---
    const valueCounts: Record<string, { kudos: number; flags: number }> = {};
    for (const slug of VALUE_SLUGS) {
      valueCounts[slug] = { kudos: 0, flags: 0 };
    }

    for (const entry of allKudos) {
      for (const val of entry.values || []) {
        if (valueCounts[val]) {
          if (entry.type === 'kudos') valueCounts[val].kudos++;
          else valueCounts[val].flags++;
        }
      }
    }

    const pactValues = VALUE_SLUGS.map((slug) => {
      const cfg = slugToConfig[slug];
      const { kudos: kudosCount, flags: flagsCount } = valueCounts[slug];
      const total = kudosCount + flagsCount;
      const ratio = total > 0 ? kudosCount / total : 1.0;
      return {
        slug,
        title: cfg.title,
        icon: cfg.icon,
        letter: cfg.letter,
        kudosCount,
        flagsCount,
        total,
        ratio: parseFloat(ratio.toFixed(4)),
      };
    });

    // --- agentBreakdown: per-agent per-value counts ---
    const agentMap: Record<
      string,
      { values: Record<string, { kudos: number; flags: number }>; totalKudos: number; totalFlags: number }
    > = {};

    for (const entry of allKudos) {
      const normalId = toTitleCase(entry.agentId);
      if (!agentMap[normalId]) {
        agentMap[normalId] = {
          values: Object.fromEntries(VALUE_SLUGS.map((s) => [s, { kudos: 0, flags: 0 }])),
          totalKudos: 0,
          totalFlags: 0,
        };
      }
      const agent = agentMap[normalId];
      for (const val of entry.values || []) {
        if (agent.values[val]) {
          if (entry.type === 'kudos') agent.values[val].kudos++;
          else agent.values[val].flags++;
        }
      }
      if (entry.type === 'kudos') agent.totalKudos++;
      else agent.totalFlags++;
    }

    const agentBreakdown = Object.entries(agentMap)
      .map(([agentId, data]) => ({ agentId, ...data }))
      .sort((a, b) => b.totalKudos - a.totalKudos);

    // --- timeline: per ISO week ---
    const weekMap: Record<
      string,
      { kudos: number; flags: number; values: Record<string, number> }
    > = {};

    for (const entry of allKudos) {
      const week = getISOWeek(typeof entry.createdAt === 'string' ? parseInt(entry.createdAt, 10) : entry.createdAt);
      if (!weekMap[week]) {
        weekMap[week] = {
          kudos: 0,
          flags: 0,
          values: Object.fromEntries(VALUE_SLUGS.map((s) => [s, 0])),
        };
      }
      const wk = weekMap[week];
      if (entry.type === 'kudos') wk.kudos++;
      else wk.flags++;
      for (const val of entry.values || []) {
        if (wk.values[val] !== undefined) wk.values[val]++;
      }
    }

    const timeline = Object.entries(weekMap)
      .map(([week, data]) => ({ week, ...data }))
      .sort((a, b) => a.week.localeCompare(b.week));

    // --- totals ---
    const totals = {
      kudos: allKudos.filter((k) => k.type === 'kudos').length,
      flags: allKudos.filter((k) => k.type === 'flag').length,
      total: allKudos.length,
    };

    // --- principles: auto-generated ---
    const principles: { text: string; type: 'strength' | 'opportunity' | 'concern' | 'trend' }[] = [];
    const total = totals.total;

    // Strength: value with >50% of total entries
    for (const pv of pactValues) {
      if (pv.total > 0 && total > 0 && pv.total / total > 0.5) {
        principles.push({
          text: `${pv.title} is the team's strongest cultural signal — ${pv.total} of ${total} entries reference it.`,
          type: 'strength',
        });
      }
    }

    // Opportunity: value with 0 entries or <10%
    const underrepresented = pactValues.filter(
      (pv) => total > 0 && pv.total / total < 0.1
    );
    if (underrepresented.length > 0) {
      const names = underrepresented.map((pv) => pv.title).join(' and ');
      principles.push({
        text: `${names} ${underrepresented.length === 1 ? 'is' : 'are'} underrepresented — consider recognizing more ${underrepresented.length === 1 ? 'this behavior' : 'these behaviors'} in recognition.`,
        type: 'opportunity',
      });
    }

    // Concern: flags > 25% of total
    if (total > 0 && totals.flags / total > 0.25) {
      principles.push({
        text: `Flag rate is elevated at ${Math.round((totals.flags / total) * 100)}% — review recent flags to address recurring concerns.`,
        type: 'concern',
      });
    }

    // Trend: compare last 2 weeks vs prior 2 weeks
    if (timeline.length >= 4) {
      const recent = timeline.slice(-2).reduce((sum, w) => sum + w.kudos + w.flags, 0);
      const prior = timeline.slice(-4, -2).reduce((sum, w) => sum + w.kudos + w.flags, 0);
      if (recent > prior * 1.3) {
        principles.push({
          text: `Recognition activity has increased over the last two weeks — a positive sign of team engagement.`,
          type: 'trend',
        });
      } else if (prior > 0 && recent < prior * 0.7) {
        principles.push({
          text: `Recognition activity has slowed recently — consider prompting the team to share kudos.`,
          type: 'trend',
        });
      }
    }

    // Ensure at least 1 principle
    if (principles.length === 0) {
      if (total > 0) {
        const topValue = [...pactValues].sort((a, b) => b.total - a.total)[0];
        principles.push({
          text: `${topValue.title} leads recognition so far with ${topValue.total} entries — keep up the momentum.`,
          type: 'strength',
        });
      } else {
        principles.push({
          text: 'No recognition entries yet — start giving kudos to build your cultural signal data.',
          type: 'opportunity',
        });
      }
    }

    return NextResponse.json({
      pactValues,
      agentBreakdown,
      timeline,
      principles,
      totals,
    });
  } catch (e: any) {
    console.error('[cultural-alignment] Error:', e);
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}
