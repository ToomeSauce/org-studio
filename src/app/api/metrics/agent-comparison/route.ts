import { NextResponse } from 'next/server';

interface TeamMetric {
  agentId: string;
  totalCompleted: number;
  totalStarted: number;
  avgDuration: number | null;
  avgChainRate: number | null;
  avgThroughput: number | null;
  avgFirstPass: number | null;
  totalBounces: number;
  totalStalls: number;
  totalComments: number;
  totalKudos: number;
  totalFlags: number;
  activeDays: number;
}

interface DailyMetric {
  date: string;
  tasksCompleted: number;
  throughput: number | null;
  firstPassRate: number | null;
  [key: string]: unknown;
}

/**
 * GET /api/metrics/agent-comparison
 * Returns team metrics with sparklines for each agent.
 */
export async function GET() {
  const headers = { 'X-Internal-Request': 'true' };

  // 1. Fetch team aggregates
  let teamMetrics: TeamMetric[] = [];
  try {
    const res = await fetch('http://localhost:4501/api/metrics/team', { headers });
    if (res.ok) {
      const data = await res.json();
      teamMetrics = data.metrics || [];
    }
  } catch {
    return NextResponse.json({ error: 'Failed to fetch team metrics' }, { status: 502 });
  }

  // 2. For each agent fetch daily data and build sparklines
  const agents = await Promise.all(
    teamMetrics.map(async (tm) => {
      let sparklines = {
        tasksCompleted: [] as number[],
        throughput: [] as number[],
        firstPassRate: [] as number[],
      };

      try {
        const res = await fetch(
          `http://localhost:4501/api/metrics/${tm.agentId}?limit=30`,
          { headers }
        );
        if (res.ok) {
          const data = await res.json();
          // Reverse so oldest is first (API returns newest first)
          const daily: DailyMetric[] = ((data.metrics || []) as DailyMetric[]).reverse();
          sparklines = {
            tasksCompleted: daily.map((d) => d.tasksCompleted || 0),
            throughput: daily.map((d) => d.throughput ?? 0),
            firstPassRate: daily.map((d) => d.firstPassRate ?? 0),
          };
        }
      } catch {
        // sparklines stay empty — handled gracefully by the UI
      }

      return {
        agentId: tm.agentId,
        totalCompleted: tm.totalCompleted,
        totalStarted: tm.totalStarted,
        avgDuration: tm.avgDuration,
        avgChainRate: tm.avgChainRate,
        avgThroughput: tm.avgThroughput,
        avgFirstPass: tm.avgFirstPass,
        totalBounces: tm.totalBounces,
        totalStalls: tm.totalStalls,
        totalComments: tm.totalComments,
        totalKudos: tm.totalKudos,
        totalFlags: tm.totalFlags,
        activeDays: tm.activeDays,
        sparklines,
      };
    })
  );

  // 3. Sort by totalCompleted descending
  agents.sort((a, b) => b.totalCompleted - a.totalCompleted);

  return NextResponse.json({ agents });
}
