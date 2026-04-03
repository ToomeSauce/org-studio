'use server';

import { NextRequest, NextResponse } from 'next/server';
import { getStoreProvider } from '@/lib/store-provider';
import { join } from 'path';
import { readFileSync, existsSync } from 'fs';

/**
 * Delivery Stats API
 * GET /api/stats/{agentId}
 * 
 * Returns computed delivery metrics for an agent over a 30-day period
 */

interface DeliveryStats {
  agentId: string;
  period: string;
  tasksCompleted: number;
  avgCycleTimeMs: number;
  avgCycleTimeHuman: string;
  firstPassRate: number;
  qaBounces: number;
  currentStreak: number;
  kudosCount: number;
  flagsCount: number;
  topValue: string | null;
  tasksInProgress: number;
  tasksInBacklog: number;
}

function humanizeDuration(ms: number): string {
  const minutes = Math.round(ms / 60000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.round(hours / 24);
  return `${days}d`;
}

function loadKudosForAgent(agentId: string): { kudos: number; flags: number; topValue: string | null } {
  const KUDOS_FILE = join(process.cwd(), 'data', 'kudos.json');
  let kudos: any[] = [];

  try {
    if (existsSync(KUDOS_FILE)) {
      kudos = JSON.parse(readFileSync(KUDOS_FILE, 'utf-8')) || [];
    }
  } catch {
    // Ignore errors, use empty array
  }

  // Filter for this agent
  const forAgent = kudos.filter(
    (k: any) => k.agentId?.toLowerCase() === agentId?.toLowerCase()
  );

  const kudosCount = forAgent.filter((k: any) => k.type === 'kudos').length;
  const flagsCount = forAgent.filter((k: any) => k.type === 'flag').length;

  // Top value (most frequent across all kudos for this agent)
  const valueCounts: Record<string, number> = {};
  for (const k of forAgent.filter((k: any) => k.type === 'kudos')) {
    for (const v of k.values || []) {
      valueCounts[v] = (valueCounts[v] || 0) + 1;
    }
  }
  const topValue =
    Object.entries(valueCounts).sort(([, a], [, b]) => b - a)[0]?.[0] || null;

  return { kudos: kudosCount, flags: flagsCount, topValue };
}

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ agentId: string }> }
) {
  const { agentId } = await params;
  const now = Date.now();
  const thirtyDaysAgo = now - 30 * 24 * 60 * 60 * 1000;

  try {
    // Read store data
    const store = await getStoreProvider().read();
    const tasks = store.tasks || [];

    // Filter tasks for this agent, completed in last 30 days
    const agentTasks = tasks.filter(
      (t: any) =>
        !t.isArchived &&
        t.assignee?.toLowerCase() === agentId?.toLowerCase()
    );

    const completedTasks = agentTasks.filter((t: any) => {
      if (t.status !== 'done' && t.status !== 'review') return false;
      // Check if marked done within period
      const doneEntry = t.statusHistory?.find(
        (e: any) => e.status === 'done'
      );
      if (!doneEntry) return t.createdAt > thirtyDaysAgo;
      return doneEntry.timestamp > thirtyDaysAgo;
    });

    // Compute cycle time: from first 'in-progress' to 'done'
    const cycleTimes: number[] = [];
    for (const task of completedTasks) {
      const history = task.statusHistory || [];
      const inProgressEntry = history.find((e: any) => e.status === 'in-progress');
      const doneEntry = history.find((e: any) => e.status === 'done');

      if (inProgressEntry && doneEntry) {
        const cycleMs = doneEntry.timestamp - inProgressEntry.timestamp;
        if (cycleMs > 0) cycleTimes.push(cycleMs);
      }
    }

    const avgCycleTimeMs =
      cycleTimes.length > 0
        ? Math.round(cycleTimes.reduce((a, b) => a + b) / cycleTimes.length)
        : 0;

    // First-pass rate: tasks that went directly done/review without bouncing
    let firstPassCount = 0;
    for (const task of completedTasks) {
      const history = task.statusHistory || [];
      let bounced = false;

      // Check if task went review/qa → in-progress
      for (let i = 0; i < history.length - 1; i++) {
        const curr = history[i];
        const next = history[i + 1];
        if (['review', 'qa'].includes(curr.status) && next.status === 'in-progress') {
          bounced = true;
          break;
        }
      }

      if (!bounced) firstPassCount++;
    }

    const firstPassRate =
      completedTasks.length > 0 ? firstPassCount / completedTasks.length : 0;

    // QA bounces: count review/qa → in-progress transitions
    let qaBounces = 0;
    for (const task of agentTasks) {
      const history = task.statusHistory || [];
      for (let i = 0; i < history.length - 1; i++) {
        const curr = history[i];
        const next = history[i + 1];
        if (['review', 'qa'].includes(curr.status) && next.status === 'in-progress') {
          qaBounces++;
        }
      }
    }

    // Current streak: consecutive most-recent completed tasks with 0 bounces
    let currentStreak = 0;
    const sortedCompleted = [...completedTasks].sort(
      (a, b) => (b.updatedAt || b.createdAt) - (a.updatedAt || a.createdAt)
    );

    for (const task of sortedCompleted) {
      const history = task.statusHistory || [];
      let hasBounce = false;
      for (let i = 0; i < history.length - 1; i++) {
        const curr = history[i];
        const next = history[i + 1];
        if (['review', 'qa'].includes(curr.status) && next.status === 'in-progress') {
          hasBounce = true;
          break;
        }
      }

      if (!hasBounce) {
        currentStreak++;
      } else {
        break;
      }
    }

    // Kudos and flags
    const { kudos: kudosCount, flags: flagsCount, topValue } = loadKudosForAgent(agentId);

    // In-progress and backlog counts
    const tasksInProgress = agentTasks.filter((t: any) => t.status === 'in-progress').length;
    const tasksInBacklog = agentTasks.filter((t: any) => t.status === 'backlog').length;

    const stats: DeliveryStats = {
      agentId,
      period: '30d',
      tasksCompleted: completedTasks.length,
      avgCycleTimeMs,
      avgCycleTimeHuman: humanizeDuration(avgCycleTimeMs),
      firstPassRate: Math.round(firstPassRate * 100) / 100,
      qaBounces,
      currentStreak,
      kudosCount,
      flagsCount,
      topValue,
      tasksInProgress,
      tasksInBacklog,
    };

    return NextResponse.json(stats);
  } catch (err) {
    console.error('[Stats API] Error:', (err as any).message);
    return NextResponse.json(
      { error: 'Failed to compute stats' },
      { status: 500 }
    );
  }
}
