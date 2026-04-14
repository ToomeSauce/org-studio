/**
 * coaching-insights.ts
 *
 * Pattern detection engine that analyzes an agent's daily metrics and generates
 * coaching insights. Called by /api/metrics/coaching-insights and injected into
 * ORG.md via org-generator.ts.
 */

export interface DailyMetric {
  date: string;
  tasksCompleted?: number | null;
  throughput?: number | null;
  firstPassRate?: number | null;
  bounceCount?: number | null;
  commentsPosted?: number | null;
  activeMinutes?: number | null;
}

export interface TeamAvg {
  avgThroughput: number;
  avgFirstPass: number;
  totalBounces: number;
  agentCount: number;
}

export interface CoachingInsight {
  type: 'warning' | 'improvement' | 'celebration' | 'suggestion';
  category: 'throughput' | 'quality' | 'engagement' | 'consistency' | 'general';
  title: string;
  message: string;
  severity: number; // 1-5
  dataPoints?: { label: string; value: string }[];
}

/** Days with tasksCompleted > 0 */
function activeDays(metrics: DailyMetric[]): DailyMetric[] {
  return metrics.filter(m => (m.tasksCompleted ?? 0) > 0);
}

function avg(vals: number[]): number {
  if (!vals.length) return 0;
  return vals.reduce((s, v) => s + v, 0) / vals.length;
}

function pct(val: number): string {
  return `${Math.round(val * 100)}%`;
}

// ─── Pattern Detectors ────────────────────────────────────────────────────────

function detectDecliningThroughput(active: DailyMetric[]): CoachingInsight | null {
  const withThroughput = active.filter(m => m.throughput != null);
  if (withThroughput.length < 6) return null;

  // newest-first: recent = first 3, prior = next 3
  const recent = withThroughput.slice(0, 3).map(m => m.throughput as number);
  const prior = withThroughput.slice(3, 6).map(m => m.throughput as number);

  const recentAvg = avg(recent);
  const priorAvg = avg(prior);

  if (priorAvg === 0) return null;
  if (recentAvg < priorAvg * 0.7) {
    const dropPct = Math.round((1 - recentAvg / priorAvg) * 100);
    return {
      type: 'warning',
      category: 'throughput',
      title: 'Declining Throughput',
      message: `Your throughput has dropped ${dropPct}% over the last week.`,
      severity: dropPct > 40 ? 5 : dropPct > 25 ? 4 : 3,
      dataPoints: [
        { label: 'Recent avg (last 3 active days)', value: `${recentAvg.toFixed(1)}/hr` },
        { label: 'Prior avg (3 days before)', value: `${priorAvg.toFixed(1)}/hr` },
      ],
    };
  }
  return null;
}

function detectRisingBounceRate(active: DailyMetric[]): CoachingInsight | null {
  if (active.length < 10) return null;

  const recent5 = active.slice(0, 5);
  const prior5 = active.slice(5, 10);

  const recentBounces = recent5.reduce((s, m) => s + (m.bounceCount ?? 0), 0);
  const priorBounces = prior5.reduce((s, m) => s + (m.bounceCount ?? 0), 0);

  if (recentBounces > priorBounces && recentBounces >= 3) {
    return {
      type: 'warning',
      category: 'quality',
      title: 'Rising Bounce Rate',
      message: `Bounce rate is climbing — ${recentBounces} bounces in the last 5 active days vs ${priorBounces} previously.`,
      severity: recentBounces >= 8 ? 5 : recentBounces >= 5 ? 4 : 3,
      dataPoints: [
        { label: 'Recent bounces (last 5 active days)', value: String(recentBounces) },
        { label: 'Prior bounces (5 days before)', value: String(priorBounces) },
      ],
    };
  }
  return null;
}

function detectCommentActivity(active: DailyMetric[]): CoachingInsight | null {
  const last7 = active.slice(0, 7);
  if (last7.length === 0) return null;

  const totalComments = last7.reduce((s, m) => s + (m.commentsPosted ?? 0), 0);
  const totalTasks = last7.reduce((s, m) => s + (m.tasksCompleted ?? 0), 0);
  if (totalTasks === 0) return null;

  const ratio = totalComments / totalTasks;
  const ratioStr = ratio.toFixed(2);

  if (ratio < 0.5) {
    return {
      type: 'suggestion',
      category: 'engagement',
      title: 'Low Comment Activity',
      message: `You're averaging ${ratioStr} comments per task — consider documenting decisions more.`,
      severity: 2,
      dataPoints: [
        { label: 'Comments per task (last 7 active days)', value: ratioStr },
      ],
    };
  }
  if (ratio > 2.0) {
    return {
      type: 'celebration',
      category: 'engagement',
      title: 'Strong Documentation',
      message: `Strong documentation habit — ${ratioStr} comments per task.`,
      severity: 1,
      dataPoints: [
        { label: 'Comments per task (last 7 active days)', value: ratioStr },
      ],
    };
  }
  return null;
}

function detectConsistencyGap(allMetrics: DailyMetric[]): CoachingInsight | null {
  // All metrics (newest-first), look at days with any activity in last 14 calendar entries
  const last14 = allMetrics.slice(0, 14);
  const activeDates = last14
    .filter(m => (m.tasksCompleted ?? 0) > 0 || (m.activeMinutes ?? 0) > 0)
    .map(m => new Date(m.date).getTime())
    .sort((a, b) => a - b); // oldest-first for gap calc

  if (activeDates.length < 2) return null;

  const gaps: number[] = [];
  for (let i = 1; i < activeDates.length; i++) {
    const dayGap = (activeDates[i] - activeDates[i - 1]) / (1000 * 60 * 60 * 24);
    gaps.push(dayGap);
  }

  const avgGap = avg(gaps);
  if (avgGap > 3) {
    return {
      type: 'suggestion',
      category: 'consistency',
      title: 'Consistency Gap',
      message: `Your active days have gaps of ${avgGap.toFixed(1)} days on average — try to maintain more consistent activity.`,
      severity: avgGap > 6 ? 4 : 2,
      dataPoints: [
        { label: 'Avg gap between active days', value: `${avgGap.toFixed(1)} days` },
      ],
    };
  }
  return null;
}

function detectFirstPassImprovement(active: DailyMetric[]): CoachingInsight | null {
  const withFpr = active.filter(m => m.firstPassRate != null);
  if (withFpr.length < 10) return null;

  const recent5 = withFpr.slice(0, 5).map(m => m.firstPassRate as number);
  const prior5 = withFpr.slice(5, 10).map(m => m.firstPassRate as number);

  const recentAvg = avg(recent5);
  const priorAvg = avg(prior5);

  if (recentAvg > priorAvg + 0.1) {
    return {
      type: 'celebration',
      category: 'quality',
      title: 'First-Pass Improvement',
      message: `First-pass rate improved from ${pct(priorAvg)} to ${pct(recentAvg)} — great progress.`,
      severity: 2,
      dataPoints: [
        { label: 'Prior avg first-pass', value: pct(priorAvg) },
        { label: 'Recent avg first-pass', value: pct(recentAvg) },
      ],
    };
  }
  return null;
}

function detectThroughputAboveTeam(active: DailyMetric[], teamAvg: TeamAvg): CoachingInsight | null {
  const last7 = active.slice(0, 7).filter(m => m.throughput != null);
  if (last7.length === 0) return null;

  const agentAvgThr = avg(last7.map(m => m.throughput as number));
  if (teamAvg.avgThroughput === 0) return null;

  if (agentAvgThr > teamAvg.avgThroughput * 1.5) {
    const abovePct = Math.round((agentAvgThr / teamAvg.avgThroughput - 1) * 100);
    return {
      type: 'celebration',
      category: 'throughput',
      title: 'Throughput Above Team',
      message: `Your throughput is ${abovePct}% above team average.`,
      severity: 1,
      dataPoints: [
        { label: 'Your avg throughput (last 7 active days)', value: `${agentAvgThr.toFixed(1)}/hr` },
        { label: 'Team avg throughput', value: `${teamAvg.avgThroughput.toFixed(1)}/hr` },
      ],
    };
  }
  return null;
}

function detectFirstPassBelowTeam(active: DailyMetric[], teamAvg: TeamAvg): CoachingInsight | null {
  const last7 = active.slice(0, 7).filter(m => m.firstPassRate != null);
  if (last7.length === 0) return null;

  const agentFpr = avg(last7.map(m => m.firstPassRate as number));

  if (agentFpr < teamAvg.avgFirstPass - 0.1) {
    return {
      type: 'warning',
      category: 'quality',
      title: 'First-Pass Below Team',
      message: `First-pass rate ${pct(agentFpr)} is notably below team average ${pct(teamAvg.avgFirstPass)}.`,
      severity: 4,
      dataPoints: [
        { label: 'Your avg first-pass (last 7 active days)', value: pct(agentFpr) },
        { label: 'Team avg first-pass', value: pct(teamAvg.avgFirstPass) },
      ],
    };
  }
  return null;
}

function detectHotStreak(active: DailyMetric[]): CoachingInsight | null {
  if (active.length < 3) return null;

  let streak = 0;
  for (const m of active) {
    if (m.firstPassRate === 1.0) {
      streak++;
    } else {
      break;
    }
  }

  if (streak >= 3) {
    return {
      type: 'celebration',
      category: 'quality',
      title: 'Hot Streak',
      message: `${streak}-day clean streak — zero bounces.`,
      severity: 2,
      dataPoints: [
        { label: 'Consecutive 100% first-pass days', value: String(streak) },
      ],
    };
  }
  return null;
}

// ─── Main Export ──────────────────────────────────────────────────────────────

export function generateCoachingInsights(
  agentId: string,
  dailyMetrics: DailyMetric[], // newest-first
  teamAvg: TeamAvg
): CoachingInsight[] {
  const active = activeDays(dailyMetrics);

  if (active.length < 3) {
    return [
      {
        type: 'suggestion',
        category: 'general',
        title: 'Not Enough Data',
        message: 'Not enough data yet — keep working to build your metrics baseline.',
        severity: 1,
      },
    ];
  }

  const candidates: CoachingInsight[] = [];

  const push = (insight: CoachingInsight | null) => {
    if (insight) candidates.push(insight);
  };

  push(detectDecliningThroughput(active));
  push(detectRisingBounceRate(active));
  push(detectCommentActivity(active));
  push(detectConsistencyGap(dailyMetrics));
  push(detectFirstPassImprovement(active));
  push(detectThroughputAboveTeam(active, teamAvg));
  push(detectFirstPassBelowTeam(active, teamAvg));
  push(detectHotStreak(active));

  // Sort: warnings first (severity desc), then suggestions, then celebrations/improvements
  const typeOrder = (t: CoachingInsight['type']) => {
    if (t === 'warning') return 0;
    if (t === 'suggestion') return 1;
    if (t === 'improvement') return 2;
    return 3; // celebration
  };

  candidates.sort((a, b) => {
    const typeDiff = typeOrder(a.type) - typeOrder(b.type);
    if (typeDiff !== 0) return typeDiff;
    return b.severity - a.severity; // higher severity first within same type
  });

  // Max 5 insights
  return candidates.slice(0, 5);
}
