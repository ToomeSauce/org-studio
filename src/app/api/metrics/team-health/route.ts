import { NextResponse } from 'next/server';
import { getStoreProvider } from '@/lib/store-provider';

const TZ = 'America/New_York';
const STALL_THRESHOLD_MIN = 120;
const CURRENT_STALL_THRESHOLD_MIN = 60;

const STATUS_ORDER: Record<string, number> = {
  backlog: 0,
  planning: 1,
  'in-progress': 2,
  review: 3,
  qa: 4,
  done: 5,
};

function toNYDate(ts: number): string {
  return new Date(ts).toLocaleDateString('en-CA', { timeZone: TZ }); // YYYY-MM-DD
}

function toNYHour(ts: number): number {
  return parseInt(
    new Date(ts).toLocaleString('en-US', { timeZone: TZ, hour: 'numeric', hour12: false }),
    10
  );
}

function toNYDayOfWeek(ts: number): number {
  // 0=Sun, 6=Sat
  return new Date(
    new Date(ts).toLocaleString('en-US', { timeZone: TZ })
  ).getDay();
}

function getLast30Days(): string[] {
  const days: string[] = [];
  const now = Date.now();
  for (let i = 29; i >= 0; i--) {
    const d = new Date(now - i * 86400000);
    days.push(d.toLocaleDateString('en-CA', { timeZone: TZ }));
  }
  return days;
}

export async function GET() {
  const provider = getStoreProvider();
  const store = await provider.read();
  const tasks = store.tasks || [];
  const now = Date.now();
  const thirtyDaysAgo = now - 30 * 86400000;
  const sevenDaysAgo = now - 7 * 86400000;

  // ---- Velocity Trend (last 30 days) ----
  const last30Days = getLast30Days();
  const velocityByDate: Record<string, { completed: number; started: number; bounced: number }> =
    {};
  for (const d of last30Days) {
    velocityByDate[d] = { completed: 0, started: 0, bounced: 0 };
  }

  for (const task of tasks) {
    const history: { status: string; timestamp: number }[] = task.statusHistory || [];
    if (history.length === 0) continue;

    // completed: date of the `done` entry
    const doneEntry = history.find((h) => h.status === 'done');
    if (doneEntry && doneEntry.timestamp >= thirtyDaysAgo) {
      const d = toNYDate(doneEntry.timestamp);
      if (velocityByDate[d]) velocityByDate[d].completed++;
    }

    // started: date of first `in-progress` entry in the window
    const startedEntry = history.find((h) => h.status === 'in-progress');
    if (startedEntry && startedEntry.timestamp >= thirtyDaysAgo) {
      const d = toNYDate(startedEntry.timestamp);
      if (velocityByDate[d]) velocityByDate[d].started++;
    }

    // bounced: tasks where status went backward at any point in the window
    let bounced = false;
    for (let i = 1; i < history.length && !bounced; i++) {
      const prev = STATUS_ORDER[history[i - 1].status] ?? -1;
      const curr = STATUS_ORDER[history[i].status] ?? -1;
      if (curr < prev && history[i].timestamp >= thirtyDaysAgo) {
        bounced = true;
      }
    }
    if (bounced) {
      // attribute bounce to the day it first occurred
      for (let i = 1; i < history.length; i++) {
        const prev = STATUS_ORDER[history[i - 1].status] ?? -1;
        const curr = STATUS_ORDER[history[i].status] ?? -1;
        if (curr < prev && history[i].timestamp >= thirtyDaysAgo) {
          const d = toNYDate(history[i].timestamp);
          if (velocityByDate[d]) {
            velocityByDate[d].bounced++;
            break;
          }
        }
      }
    }
  }

  const velocityTrend = last30Days.map((date) => ({ date, ...velocityByDate[date] }));

  // ---- Active Hours Heatmap ----
  const heatmapMap: Record<string, number> = {};

  for (const task of tasks) {
    const history: { status: string; timestamp: number }[] = task.statusHistory || [];
    for (const entry of history) {
      if (entry.status !== 'in-progress' && entry.status !== 'done') continue;
      if (!entry.timestamp) continue;
      const day = toNYDayOfWeek(entry.timestamp);
      const hour = toNYHour(entry.timestamp);
      const key = `${day}-${hour}`;
      heatmapMap[key] = (heatmapMap[key] || 0) + 1;
    }
  }

  const activeHoursHeatmap: { day: number; hour: number; count: number }[] = [];
  for (const [key, count] of Object.entries(heatmapMap)) {
    const [dayStr, hourStr] = key.split('-');
    activeHoursHeatmap.push({ day: parseInt(dayStr), hour: parseInt(hourStr), count });
  }

  // ---- Stalls ----
  const currentStalls: {
    taskId: string;
    title: string;
    assignee: string;
    stalledMinutes: number;
    startedAt: number;
  }[] = [];

  let stallCount7d = 0;
  let stallCount30d = 0;
  const stallDurations: number[] = [];

  for (const task of tasks) {
    const history: { status: string; timestamp: number }[] = task.statusHistory || [];

    // Current stalls: in-progress tasks where last status change > CURRENT_STALL_THRESHOLD_MIN ago
    if (task.status === 'in-progress' && history.length > 0) {
      const lastEntry = history[history.length - 1];
      const stalledMs = now - lastEntry.timestamp;
      const stalledMinutes = stalledMs / 60000;
      if (stalledMinutes > CURRENT_STALL_THRESHOLD_MIN) {
        // find when in-progress started
        const ipEntry = [...history].reverse().find((h) => h.status === 'in-progress');
        currentStalls.push({
          taskId: task.id,
          title: task.title || '(untitled)',
          assignee: task.assignee || 'Unknown',
          stalledMinutes: Math.round(stalledMinutes),
          startedAt: ipEntry?.timestamp || lastEntry.timestamp,
        });
      }
    }

    // Historical stalls: tasks that spent > STALL_THRESHOLD_MIN in-progress before moving
    // Look at consecutive in-progress → next-status transitions
    for (let i = 0; i < history.length; i++) {
      if (history[i].status !== 'in-progress') continue;
      // Find when it left in-progress
      let endTs: number | null = null;
      for (let j = i + 1; j < history.length; j++) {
        if (history[j].status !== 'in-progress') {
          endTs = history[j].timestamp;
          break;
        }
      }
      if (!endTs) continue; // still in progress or task is done with no subsequent entry
      const durationMin = (endTs - history[i].timestamp) / 60000;
      if (durationMin > STALL_THRESHOLD_MIN) {
        stallDurations.push(durationMin);
        if (history[i].timestamp >= sevenDaysAgo) stallCount7d++;
        if (history[i].timestamp >= thirtyDaysAgo) stallCount30d++;
      }
    }
  }

  const avgStallMinutes =
    stallDurations.length > 0
      ? Math.round(stallDurations.reduce((a, b) => a + b, 0) / stallDurations.length)
      : 0;

  const stalls = {
    current: currentStalls.sort((a, b) => b.stalledMinutes - a.stalledMinutes),
    frequency: {
      last7d: stallCount7d,
      last30d: stallCount30d,
      avgStallMinutes,
    },
  };

  // ---- Review Bottlenecks ----
  const reviewDurations: number[] = [];
  const recentBottlenecks: {
    taskId: string;
    title: string;
    assignee: string;
    reviewMinutes: number;
  }[] = [];

  // #1290 (2026-05-08): Review column removed. tasksInReview stays in the
  // payload shape for backward compat with any consumers, but it's always 0.
  // The historical review→done duration loop below still runs against old
  // statusHistory entries that carry status='review' so we can show legacy
  // analytics; new transitions never produce these.
  let tasksInReview = 0;

  for (const task of tasks) {
    const history: { status: string; timestamp: number }[] = task.statusHistory || [];

    // (status === 'review' is impossible going forward; check kept for completeness on legacy data)
    if ((task.status as string) === 'review') tasksInReview++;

    // Find pairs of review → done entries
    for (let i = 0; i < history.length; i++) {
      if (history[i].status !== 'review') continue;
      for (let j = i + 1; j < history.length; j++) {
        if (history[j].status === 'done') {
          const reviewMin = (history[j].timestamp - history[i].timestamp) / 60000;
          reviewDurations.push(reviewMin);
          recentBottlenecks.push({
            taskId: task.id,
            title: task.title || '(untitled)',
            assignee: task.assignee || 'Unknown',
            reviewMinutes: Math.round(reviewMin),
          });
          break;
        }
        // If it went to another status that's not done, stop looking for this review entry
        if (history[j].status !== 'review' && history[j].status !== 'done') break;
      }
    }
  }

  const avgReviewMinutes =
    reviewDurations.length > 0
      ? Math.round(reviewDurations.reduce((a, b) => a + b, 0) / reviewDurations.length)
      : 0;
  const maxReviewMinutes =
    reviewDurations.length > 0 ? Math.round(Math.max(...reviewDurations)) : 0;

  // Top 5 longest
  const topBottlenecks = recentBottlenecks
    .sort((a, b) => b.reviewMinutes - a.reviewMinutes)
    .slice(0, 5);

  const reviewBottlenecks = {
    avgReviewMinutes,
    maxReviewMinutes,
    tasksInReview,
    recentBottlenecks: topBottlenecks,
  };

  return NextResponse.json({
    velocityTrend,
    activeHoursHeatmap,
    stalls,
    reviewBottlenecks,
  });
}
