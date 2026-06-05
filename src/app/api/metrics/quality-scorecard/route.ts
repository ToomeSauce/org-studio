import { NextRequest, NextResponse } from 'next/server';
import { cloudReadGate } from '@/lib/read-gate';
import { getStoreProvider } from '@/lib/store-provider';
import { resolveWorkspaceIdForRequest } from '@/lib/workspace-auth';

const STATUS_ORDER: Record<string, number> = {
  backlog: 0,
  planning: 1,
  'in-progress': 2,
  qa: 3,
  review: 4,
  done: 5,
};

function hasBounce(statusHistory: { status: string; timestamp: number }[]): boolean {
  for (let i = 1; i < statusHistory.length; i++) {
    const prev = STATUS_ORDER[statusHistory[i - 1].status] ?? -1;
    const curr = STATUS_ORDER[statusHistory[i].status] ?? -1;
    if (curr < prev) return true;
  }
  return false;
}

function getDoneTimestamp(statusHistory: { status: string; timestamp: number }[]): number | null {
  // Find the last 'done' entry
  for (let i = statusHistory.length - 1; i >= 0; i--) {
    if (statusHistory[i].status === 'done') return statusHistory[i].timestamp;
  }
  return null;
}

export async function GET(request: NextRequest) {
  const denied = await cloudReadGate(request); // #1624 F-P5
  if (denied) return denied;
  try {
    const workspaceId = await resolveWorkspaceIdForRequest(request);
    const provider = getStoreProvider(workspaceId);
    const store = await provider.read();
    const tasks = store.tasks || [];

    // Filter: non-archived done tasks only
    const doneTasks = tasks.filter(
      (t: any) => t.status === 'done' && !t.isArchived
    );

    // ---- Team summary ----
    const totalDone = doneTasks.length;
    let teamFirstPass = 0;
    let teamReviewNotes = 0;
    let teamTestPlan = 0;

    for (const task of doneTasks) {
      const history: { status: string; timestamp: number }[] = task.statusHistory || [];
      if (!hasBounce(history)) teamFirstPass++;
      if (task.reviewNotes && task.reviewNotes.trim().length > 0) teamReviewNotes++;
      if (task.testPlan && task.testPlan.trim().length > 0) teamTestPlan++;
    }

    const firstPassRateTeam = totalDone > 0 ? teamFirstPass / totalDone : 0;

    const teamSummary = {
      totalDone,
      firstPassRate: parseFloat(firstPassRateTeam.toFixed(4)),
      reviewNotesRate: parseFloat((totalDone > 0 ? teamReviewNotes / totalDone : 0).toFixed(4)),
      testPlanRate: parseFloat((totalDone > 0 ? teamTestPlan / totalDone : 0).toFixed(4)),
      bounceRate: parseFloat((1 - firstPassRateTeam).toFixed(4)),
    };

    // ---- Per-agent metrics ----
    // Group done tasks by assignee
    const agentTaskMap: Record<string, any[]> = {};
    for (const task of doneTasks) {
      const key = task.assignee || 'Unassigned';
      if (!agentTaskMap[key]) agentTaskMap[key] = [];
      agentTaskMap[key].push(task);
    }

    const agents = Object.entries(agentTaskMap).map(([agentId, agentTasks]) => {
      const total = agentTasks.length;
      let firstPassCount = 0;
      let reviewNotesCount = 0;
      let testPlanCount = 0;
      let bounceCount = 0;

      // For streak: annotate each task with bounce status + done timestamp
      const annotated: { bounced: boolean; doneTs: number }[] = [];

      for (const task of agentTasks) {
        const history: { status: string; timestamp: number }[] = task.statusHistory || [];
        const bounced = hasBounce(history);
        const doneTs = getDoneTimestamp(history) ?? task.createdAt ?? 0;

        if (!bounced) firstPassCount++;
        else bounceCount++;
        if (task.reviewNotes && task.reviewNotes.trim().length > 0) reviewNotesCount++;
        if (task.testPlan && task.testPlan.trim().length > 0) testPlanCount++;

        annotated.push({ bounced, doneTs });
      }

      // Sort by done timestamp ascending (oldest first)
      annotated.sort((a, b) => a.doneTs - b.doneTs);

      // Compute cleanStreak (from most recent, counting back) and longestCleanStreak
      let cleanStreak = 0;
      let longestCleanStreak = 0;
      let runningStreak = 0;

      for (let i = 0; i < annotated.length; i++) {
        if (!annotated[i].bounced) {
          runningStreak++;
          if (runningStreak > longestCleanStreak) longestCleanStreak = runningStreak;
        } else {
          runningStreak = 0;
        }
      }
      // cleanStreak = current streak (from most recent backward)
      for (let i = annotated.length - 1; i >= 0; i--) {
        if (!annotated[i].bounced) cleanStreak++;
        else break;
      }

      // Last 20 done tasks (most recent last) for streak timeline
      const last20 = annotated.slice(-20).map((t) => ({ bounced: t.bounced }));

      return {
        agentId,
        totalDone: total,
        firstPassRate: parseFloat((total > 0 ? firstPassCount / total : 0).toFixed(4)),
        reviewNotesRate: parseFloat((total > 0 ? reviewNotesCount / total : 0).toFixed(4)),
        testPlanRate: parseFloat((total > 0 ? testPlanCount / total : 0).toFixed(4)),
        bounceCount,
        cleanStreak,
        longestCleanStreak,
        recentTasks: last20,
      };
    });

    // Sort by firstPassRate descending
    agents.sort((a, b) => b.firstPassRate - a.firstPassRate);

    return NextResponse.json({ teamSummary, agents });
  } catch (e: any) {
    console.error('Quality scorecard error:', e);
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}
