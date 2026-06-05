/**
 * GET /api/metrics/coaching-insights
 *
 * Returns auto-generated coaching insights for an agent based on their
 * delivery metrics patterns.
 *
 * Query params:
 *   ?agent=<agentId>  — required
 */
import { NextRequest, NextResponse } from 'next/server';
import { cloudReadGate, internalAuthHeaders } from '@/lib/read-gate';
import { generateCoachingInsights, DailyMetric, TeamAvg } from '@/lib/coaching-insights';

const INTERNAL_HEADERS = internalAuthHeaders();
const BASE_URL = 'http://localhost:4501';

export async function GET(request: NextRequest) {
  const denied = await cloudReadGate(request); // #1624 F-P5
  if (denied) return denied;
  const { searchParams } = new URL(request.url);
  const agentId = searchParams.get('agent');

  if (!agentId) {
    return NextResponse.json({ error: 'Missing required query param: agent' }, { status: 400 });
  }

  try {
    // Fetch daily metrics (newest-first)
    const dailyRes = await fetch(`${BASE_URL}/api/metrics/${agentId}?limit=14`, {
      headers: INTERNAL_HEADERS,
    });

    if (!dailyRes.ok) {
      return NextResponse.json(
        { error: `Failed to fetch daily metrics: ${dailyRes.status}` },
        { status: 502 }
      );
    }

    const dailyData = await dailyRes.json();
    const dailyMetrics: DailyMetric[] = dailyData.metrics || [];

    // Fetch team metrics
    const teamRes = await fetch(`${BASE_URL}/api/metrics/team`, {
      headers: INTERNAL_HEADERS,
    });

    let teamAvg: TeamAvg = { avgThroughput: 0, avgFirstPass: 0, totalBounces: 0, agentCount: 0 };

    if (teamRes.ok) {
      const teamData = await teamRes.json();
      const metrics: any[] = teamData.metrics || [];

      if (metrics.length > 0) {
        const agentCount = metrics.length;
        const totalBounces = metrics.reduce((s: number, m: any) => s + (m.totalBounces || 0), 0);

        const throughputVals = metrics
          .map((m: any) => m.avgThroughput)
          .filter((v: any): v is number => v != null);
        const firstPassVals = metrics
          .map((m: any) => m.avgFirstPass)
          .filter((v: any): v is number => v != null);

        teamAvg = {
          avgThroughput: throughputVals.length
            ? throughputVals.reduce((s: number, v: number) => s + v, 0) / throughputVals.length
            : 0,
          avgFirstPass: firstPassVals.length
            ? firstPassVals.reduce((s: number, v: number) => s + v, 0) / firstPassVals.length
            : 0,
          totalBounces,
          agentCount,
        };
      }
    }

    const insights = generateCoachingInsights(agentId, dailyMetrics, teamAvg);

    return NextResponse.json({
      agentId,
      insights,
      generatedAt: new Date().toISOString(),
    });
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}
