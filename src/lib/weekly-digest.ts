/**
 * Weekly Team Performance Digest
 * Aggregates team metrics, kudos, coaching insights, and version progress
 * into a structured digest suitable for reporting and Telegram delivery.
 */

const BASE_URL = 'http://localhost:4501';

import { compareVersions } from './version-utils';

export interface WeeklyDigest {
  weekLabel: string;        // e.g. "Apr 7 – Apr 13, 2026"
  generatedAt: string;      // ISO timestamp
  summary: {
    totalCompleted: number;
    totalStarted: number;
    totalBounces: number;
    avgFirstPass: number;
    activeAgents: number;
    activeDays: number;
  };
  topPerformers: {
    mostCompleted: { agentId: string; count: number } | null;
    highestThroughput: { agentId: string; value: number } | null;
    bestFirstPass: { agentId: string; rate: number; tasks: number } | null;
    longestStreak: { agentId: string; streak: number } | null;
  };
  areasOfAttention: string[];
  versionProgress: { projectName: string; version: string; done: number; total: number }[];
  recentKudos: { agentId: string; note: string; type: 'kudos' | 'flag' }[];
  coachingHighlights: { agentId: string; insight: string }[];
}

function getWeekLabel(): string {
  const now = new Date();
  // ISO week: Mon–Sun
  const dayOfWeek = now.getDay(); // 0=Sun
  const diffToMon = (dayOfWeek + 6) % 7;
  const monday = new Date(now);
  monday.setDate(now.getDate() - diffToMon);
  const sunday = new Date(monday);
  sunday.setDate(monday.getDate() + 6);

  const fmt = (d: Date) =>
    d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });

  return `${fmt(monday).replace(', 2026', '')} – ${fmt(sunday)}`;
}

async function fetchJSON<T>(path: string): Promise<T> {
  const res = await fetch(`${BASE_URL}${path}`, {
    headers: { 'X-Internal-Request': 'true' },
    // next.js cache bypass in server context
    cache: 'no-store',
  });
  if (!res.ok) throw new Error(`${path} returned ${res.status}`);
  return res.json() as Promise<T>;
}

export async function generateWeeklyDigest(): Promise<WeeklyDigest> {
  // ── 1. Team metrics ──────────────────────────────────────────────────────
  const teamData = await fetchJSON<{ metrics: any[] }>('/api/metrics/team').catch(() => ({ metrics: [] }));
  const teamMetrics: any[] = teamData.metrics || [];

  const totalCompleted = teamMetrics.reduce((s, m) => s + (m.totalCompleted || 0), 0);
  const totalStarted   = teamMetrics.reduce((s, m) => s + (m.totalStarted   || 0), 0);
  const totalBounces   = teamMetrics.reduce((s, m) => s + (m.totalBounces   || 0), 0);
  const activeDays     = teamMetrics.reduce((s, m) => s + (m.activeDays     || 0), 0);
  const activeAgents   = teamMetrics.filter(m => (m.activeDays || 0) > 0).length;

  const firstPassVals  = teamMetrics.map(m => m.avgFirstPass).filter((v): v is number => v != null);
  const avgFirstPass   = firstPassVals.length
    ? firstPassVals.reduce((a, b) => a + b, 0) / firstPassVals.length
    : 0;

  // ── 2. Quality scorecard (for streaks and per-agent firstPassRate) ────────
  const scorecardData = await fetchJSON<{ teamSummary: any; agents: any[] }>('/api/metrics/quality-scorecard')
    .catch(() => ({ teamSummary: null, agents: [] }));
  const scorecardAgents: any[] = scorecardData.agents || [];

  // ── 3. Team health (stalls) ───────────────────────────────────────────────
  const healthData = await fetchJSON<{ stalls: any; velocityTrend: any[] }>('/api/metrics/team-health')
    .catch(() => ({ stalls: { current: [] }, velocityTrend: [] }));
  const stalls = healthData.stalls || { current: [] };

  // ── 4. Kudos (last 50) ────────────────────────────────────────────────────
  const kudosData = await fetchJSON<{ kudos: any[] }>('/api/kudos?limit=50').catch(() => ({ kudos: [] }));
  const allKudos: any[] = kudosData.kudos || [];
  const sevenDaysAgo = Date.now() - 7 * 86400000;
  const recentKudosRaw = allKudos
    .filter(k => (k.createdAt || 0) >= sevenDaysAgo)
    .slice(0, 6);

  const recentKudos = recentKudosRaw.map(k => ({
    agentId: k.agentId,
    note: k.note,
    type: k.type as 'kudos' | 'flag',
  }));

  // ── 5. Coaching highlights (top 3 agents by totalCompleted) ──────────────
  const top3 = [...teamMetrics]
    .sort((a, b) => (b.totalCompleted || 0) - (a.totalCompleted || 0))
    .slice(0, 3);

  const coachingHighlights: { agentId: string; insight: string }[] = [];
  for (const agent of top3) {
    try {
      const insightData = await fetchJSON<{ insights: any[] }>(
        `/api/metrics/coaching-insights?agent=${encodeURIComponent(agent.agentId)}`
      ).catch(() => ({ insights: [] }));
      const insights = insightData.insights || [];
      if (insights.length > 0) {
        coachingHighlights.push({
          agentId: agent.agentId,
          insight: insights[0].message || insights[0].title || '',
        });
      }
    } catch {
      // skip on error
    }
  }

  // ── 6. Version progress ───────────────────────────────────────────────────
  const storeData = await fetchJSON<{ tasks: any[]; projects: any[] }>('/api/store')
    .catch(() => ({ tasks: [], projects: [] }));

  const storeTasks: any[]    = (storeData as any).tasks    || [];
  const storeProjects: any[] = (storeData as any).projects || [];

  const versionProgress: { projectName: string; version: string; done: number; total: number }[] = [];

  for (const project of storeProjects) {
    if (project.isArchived) continue;

    const versionMap: Record<string, any[]> = {};
    for (const task of storeTasks) {
      if (task.projectId !== project.id || !task.version || task.isArchived) continue;
      if (!versionMap[task.version]) versionMap[task.version] = [];
      versionMap[task.version].push(task);
    }

    for (const [version, vTasks] of Object.entries(versionMap)) {
      const done  = (vTasks as any[]).filter(t => t.status === 'done').length;
      const total = (vTasks as any[]).length;
      if (total > 0) {
        versionProgress.push({ projectName: project.name, version, done, total });
      }
    }
  }

  // Sort: by project name, then version number
  versionProgress.sort((a, b) => {
    if (a.projectName !== b.projectName) return a.projectName.localeCompare(b.projectName);
    return compareVersions(a.version, b.version);
  });

  // ── Top Performers ────────────────────────────────────────────────────────
  // mostCompleted
  const sortedByCompleted = [...teamMetrics].sort((a, b) => (b.totalCompleted || 0) - (a.totalCompleted || 0));
  const mostCompleted = sortedByCompleted.length > 0 && sortedByCompleted[0].totalCompleted > 0
    ? { agentId: sortedByCompleted[0].agentId, count: sortedByCompleted[0].totalCompleted }
    : null;

  // highestThroughput
  const withThroughput = teamMetrics.filter(m => m.avgThroughput != null && m.avgThroughput > 0);
  withThroughput.sort((a, b) => (b.avgThroughput || 0) - (a.avgThroughput || 0));
  const highestThroughput = withThroughput.length > 0
    ? { agentId: withThroughput[0].agentId, value: withThroughput[0].avgThroughput }
    : null;

  // bestFirstPass (min 3 tasks done)
  const withFirstPass = teamMetrics.filter(m => m.avgFirstPass != null && (m.totalCompleted || 0) >= 3);
  withFirstPass.sort((a, b) => (b.avgFirstPass || 0) - (a.avgFirstPass || 0));
  const bestFirstPass = withFirstPass.length > 0
    ? { agentId: withFirstPass[0].agentId, rate: withFirstPass[0].avgFirstPass, tasks: withFirstPass[0].totalCompleted }
    : null;

  // longestStreak: from scorecard cleanStreak
  const withStreak = scorecardAgents.filter(a => (a.cleanStreak || 0) > 0);
  withStreak.sort((a, b) => (b.cleanStreak || 0) - (a.cleanStreak || 0));
  const longestStreak = withStreak.length > 0
    ? { agentId: withStreak[0].agentId, streak: withStreak[0].cleanStreak }
    : null;

  // ── Areas of Attention ────────────────────────────────────────────────────
  const areasOfAttention: string[] = [];

  // Per-agent firstPassRate < 70% (from scorecard)
  for (const sa of scorecardAgents) {
    if ((sa.firstPassRate || 0) < 0.70 && (sa.totalDone || 0) >= 3) {
      const pct = Math.round((sa.firstPassRate || 0) * 100);
      areasOfAttention.push(
        `⚠️ ${sa.agentId}'s first-pass rate is ${pct}% — may need review process improvement`
      );
    }
  }

  // Total bounces > 10
  if (totalBounces > 10) {
    areasOfAttention.push(`⚠️ ${totalBounces} bounces this week across the team`);
  }

  // Current stalls
  if ((stalls.current || []).length > 0) {
    areasOfAttention.push(`⚠️ ${stalls.current.length} task(s) currently stalled`);
  }

  // Agents with 0 active days
  for (const m of teamMetrics) {
    if ((m.activeDays || 0) === 0) {
      areasOfAttention.push(`⚠️ ${m.agentId} had no active days this period`);
    }
  }

  return {
    weekLabel: getWeekLabel(),
    generatedAt: new Date().toISOString(),
    summary: {
      totalCompleted,
      totalStarted,
      totalBounces,
      avgFirstPass,
      activeAgents,
      activeDays,
    },
    topPerformers: {
      mostCompleted,
      highestThroughput,
      bestFirstPass,
      longestStreak,
    },
    areasOfAttention,
    versionProgress,
    recentKudos,
    coachingHighlights,
  };
}

export function formatDigestMarkdown(digest: WeeklyDigest): string {
  const lines: string[] = [];

  lines.push(`📊 *Weekly Team Digest*`);
  lines.push(`_${digest.weekLabel}_`);
  lines.push('');

  // Summary
  lines.push('*Summary*');
  lines.push(`• Tasks Completed: ${digest.summary.totalCompleted}`);
  lines.push(`• First Pass Rate: ${Math.round(digest.summary.avgFirstPass * 100)}%`);
  lines.push(`• Bounces: ${digest.summary.totalBounces}`);
  lines.push(`• Active Agents: ${digest.summary.activeAgents}`);
  lines.push('');

  // Top Performers
  const { topPerformers: tp } = digest;
  const hasTopPerformers =
    tp.mostCompleted || tp.highestThroughput || tp.bestFirstPass || tp.longestStreak;

  if (hasTopPerformers) {
    lines.push('*🏆 Top Performers*');
    if (tp.mostCompleted) {
      lines.push(`• Most Completed: ${tp.mostCompleted.agentId} (${tp.mostCompleted.count} tasks)`);
    }
    if (tp.highestThroughput) {
      lines.push(`• Highest Throughput: ${tp.highestThroughput.agentId} (${tp.highestThroughput.value.toFixed(1)}/hr)`);
    }
    if (tp.bestFirstPass) {
      lines.push(`• Best Quality: ${tp.bestFirstPass.agentId} (${Math.round(tp.bestFirstPass.rate * 100)}% first-pass, ${tp.bestFirstPass.tasks} tasks)`);
    }
    if (tp.longestStreak) {
      lines.push(`• Longest Streak: ${tp.longestStreak.agentId} (${tp.longestStreak.streak} clean tasks)`);
    }
    lines.push('');
  }

  // Areas of Attention
  if (digest.areasOfAttention.length > 0) {
    lines.push('*⚠️ Attention Needed*');
    for (const item of digest.areasOfAttention) {
      lines.push(`• ${item}`);
    }
    lines.push('');
  }

  // Version Progress
  if (digest.versionProgress.length > 0) {
    lines.push('*📈 Version Progress*');
    for (const vp of digest.versionProgress) {
      const complete = vp.done === vp.total ? ' ✅' : '';
      lines.push(`• ${vp.projectName} ${vp.version}: ${vp.done}/${vp.total} done${complete}`);
    }
    lines.push('');
  }

  // Recent Kudos
  if (digest.recentKudos.length > 0) {
    lines.push('*🌟 Recent Kudos*');
    for (const k of digest.recentKudos) {
      const prefix = k.type === 'flag' ? '🚩' : '⭐';
      lines.push(`• ${prefix} ${k.agentId}: ${k.note}`);
    }
    lines.push('');
  }

  // Coaching Highlights
  if (digest.coachingHighlights.length > 0) {
    lines.push('*💡 Coaching Highlights*');
    for (const ch of digest.coachingHighlights) {
      lines.push(`• ${ch.agentId}: ${ch.insight}`);
    }
    lines.push('');
  }

  return lines.join('\n').trim();
}
