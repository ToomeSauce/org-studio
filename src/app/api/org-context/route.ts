/**
 * GET /api/org-context
 *
 * Returns org context for agents to consume.
 *
 * Query params:
 *   ?agent=<agentId>  — returns personalized ORG.md with "Your Domain" section
 *   ?format=json      — returns structured JSON instead of markdown
 *   (no params)       — returns generic ORG.md for all agents
 *
 * This is the generic REST API that any agent framework can poll.
 */
import { NextRequest, NextResponse } from 'next/server';
import { generateOrgMd, AgentPerformance, TeamPerformance } from '@/lib/org-generator';
import { generatePrinciples } from '@/lib/principles-generator';
import { getStoreProvider } from '@/lib/store-provider';

async function readStore() {
  try {
    return await getStoreProvider().read();
  } catch {
    return null;
  }
}

const INTERNAL_HEADERS = { 'X-Internal-Request': 'true' };
const BASE_URL = 'http://localhost:4501';

async function fetchMetrics(agentId?: string): Promise<{
  teamPerformance?: TeamPerformance;
  agentPerformance?: AgentPerformance;
}> {
  try {
    const teamRes = await fetch(`${BASE_URL}/api/metrics/team`, { headers: INTERNAL_HEADERS });
    if (!teamRes.ok) return {};
    const teamData = await teamRes.json();
    const metrics: any[] = teamData.metrics || [];

    if (!metrics.length) return {};

    // Compute team averages
    const agentCount = metrics.length;
    const totalCompleted = metrics.reduce((s, m) => s + (m.totalCompleted || 0), 0);
    const totalBounces = metrics.reduce((s, m) => s + (m.totalBounces || 0), 0);

    const throughputVals = metrics.map(m => m.avgThroughput).filter((v): v is number => v != null);
    const firstPassVals = metrics.map(m => m.avgFirstPass).filter((v): v is number => v != null);
    const avgThroughput = throughputVals.length
      ? throughputVals.reduce((s, v) => s + v, 0) / throughputVals.length
      : 0;
    const avgFirstPass = firstPassVals.length
      ? firstPassVals.reduce((s, v) => s + v, 0) / firstPassVals.length
      : 0;

    const avgActiveDays = metrics.reduce((s, m) => s + (m.activeDays || 0), 0) / agentCount;

    const teamPerformance: TeamPerformance = {
      totalCompleted,
      avgThroughput,
      avgFirstPass,
      totalBounces,
      agentCount,
      avgActiveDays,
    };

    if (!agentId) return { teamPerformance };

    // Fetch agent-specific metrics
    const agentRes = await fetch(`${BASE_URL}/api/metrics/${agentId}?limit=7`, { headers: INTERNAL_HEADERS });
    if (!agentRes.ok) return { teamPerformance };
    const agentData = await agentRes.json();

    // Also look up agent summary from team metrics
    const agentSummary = metrics.find(m => m.agentId === agentId);

    const recentDays = (agentData.metrics || []).map((d: any) => ({
      date: d.date,
      completed: d.tasksCompleted ?? 0,
      throughput: d.throughput ?? null,
      firstPassRate: d.firstPassRate ?? null,
    }));

    const agentPerformance: AgentPerformance = {
      totalCompleted: agentSummary?.totalCompleted ?? 0,
      totalBounces: agentSummary?.totalBounces ?? 0,
      avgThroughput: agentSummary?.avgThroughput ?? null,
      avgFirstPass: agentSummary?.avgFirstPass ?? null,
      avgChainRate: agentSummary?.avgChainRate ?? null,
      activeDays: agentSummary?.activeDays ?? 0,
      recentDays,
    };

    return { teamPerformance, agentPerformance };
  } catch {
    return {};
  }
}

export async function GET(request: NextRequest) {
  const store = await readStore();
  if (!store) {
    return NextResponse.json({ error: 'Store not initialized' }, { status: 503 });
  }

  const { searchParams } = new URL(request.url);
  const agentId = searchParams.get('agent');
  const format = searchParams.get('format');

  // Load operating principles for agent if specified
  let operatingPrinciples = undefined;
  if (agentId) {
    operatingPrinciples = await generatePrinciples(agentId);
  }

  // Fetch coaching insights for agent (best-effort)
  let coachingInsights = undefined;
  if (agentId) {
    try {
      const res = await fetch(`${BASE_URL}/api/metrics/coaching-insights?agent=${agentId}`, {
        headers: INTERNAL_HEADERS,
      });
      if (res.ok) {
        const data = await res.json();
        coachingInsights = data.insights;
      }
    } catch {
      // silently ignore
    }
  }

  // Fetch performance metrics (best-effort, won't fail if unavailable)
  const { teamPerformance, agentPerformance } = await fetchMetrics(agentId || undefined);

  const ctx = {
    missionStatement: store.settings?.missionStatement || '',
    values: store.settings?.values,
    teammates: store.settings?.teammates || [],
    operatingPrinciples,
    agentPerformance,
    teamPerformance,
    coachingInsights,
    projects: store.projects || [],
  };

  // JSON format — structured data for programmatic consumption
  if (format === 'json') {
    const teammate = agentId
      ? ctx.teammates.find((t: any) => t.agentId === agentId || t.id === agentId)
      : null;

    return NextResponse.json({
      mission: ctx.missionStatement,
      values: ctx.values,
      team: ctx.teammates.map((t: any) => ({
        id: t.agentId || t.id,
        name: t.name,
        domain: t.domain,
        owns: t.owns || null,
        defers: t.defers || null,
        isHuman: t.isHuman || false,
      })),
      ...(operatingPrinciples ? { operatingPrinciples } : {}),
      ...(teammate ? {
        you: {
          id: teammate.agentId || teammate.id,
          name: teammate.name,
          domain: teammate.domain,
          role: teammate.title,
          owns: teammate.owns || null,
          defers: teammate.defers || null,
        },
      } : {}),
      performance: {
        agent: agentPerformance || null,
        team: teamPerformance || null,
      },
    });
  }

  // Markdown format (default) — ready to drop into agent workspace
  const md = generateOrgMd(ctx, agentId || undefined);
  return new NextResponse(md, {
    headers: { 'Content-Type': 'text/markdown; charset=utf-8' },
  });
}

