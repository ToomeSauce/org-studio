/**
 * Pure helper: compute delivery metrics for a set of tasks within a given day,
 * optionally filtered to a specific sectionId.
 *
 * Used by server.mjs computeDailyMetrics and by tests.
 */

export interface SectionMetricsInput {
  /** All tasks assigned to this agent (already filtered by agent). */
  agentTasks: any[];
  /** Agent name (lowercase). */
  agentNameLower: string;
  /** Agent id (lowercase). */
  agentIdLower: string;
  /** Day boundary (epoch ms). */
  dayStart: number;
  /** Day boundary (epoch ms). */
  dayEnd: number;
  /** If provided, only count tasks in this section. If null/undefined, count all. */
  sectionId?: string | null;
}

export interface SectionMetricsOutput {
  tasks_completed: number;
  tasks_started: number;
  avg_duration_min: number | null;
  median_duration_min: number | null;
  avg_gap_min: number | null;
  chain_rate: number | null;
  throughput: number | null;
  first_pass_rate: number | null;
  bounce_count: number;
  stall_count: number;
  active_minutes: number;
  review_notes_rate: number | null;
  test_plan_rate: number | null;
  roadmap_throughput: number;  // #698: count of done transitions for taskKind='roadmap'
  adhoc_throughput: number;    // #698: count of done transitions for taskKind='adhoc'
}

/**
 * Returns null if zero activity (caller should skip upsert).
 */
export function computeSectionMetrics(input: SectionMetricsInput): SectionMetricsOutput | null {
  const { agentTasks, dayStart, dayEnd, sectionId } = input;

  // Filter to section if specified
  const tasks = sectionId
    ? agentTasks.filter(t => t.sectionId === sectionId)
    : agentTasks;

  let tasksCompleted = 0;
  let tasksStarted = 0;
  const durations: number[] = [];
  const gaps: number[] = [];
  let prevCompleted: number | null = null;
  let bounceCount = 0;
  let stallCount = 0;
  let firstPassCount = 0;
  let doneCount = 0;
  let reviewNotesCount = 0;
  let testPlanCount = 0;
  let roadmapThroughput = 0;
  let adhocThroughput = 0;

  for (const task of tasks) {
    const history = task.statusHistory || [];
    for (const h of history) {
      if (!h.timestamp || h.timestamp < dayStart || h.timestamp >= dayEnd) continue;
      if (h.status === 'done') {
        tasksCompleted++;
        doneCount++;
        if (task.reviewNotes) reviewNotesCount++;
        if (task.testPlan) testPlanCount++;
        // #698: bucket by taskKind
        if (task.taskKind === 'roadmap') roadmapThroughput++;
        else adhocThroughput++;
      }
      if (h.status === 'in-progress') {
        tasksStarted++;
      }
    }

    // Duration: first in-progress to last done within the day
    const startedAt = history.find((h: any) => h.status === 'in-progress' && h.timestamp >= dayStart && h.timestamp < dayEnd)?.timestamp;
    const completedAt = [...history].reverse().find((h: any) => h.status === 'done' && h.timestamp >= dayStart && h.timestamp < dayEnd)?.timestamp;
    if (startedAt && completedAt && completedAt > startedAt) {
      durations.push((completedAt - startedAt) / 60000);
      if (prevCompleted) {
        const gap = (startedAt - prevCompleted) / 60000;
        if (gap >= 0) gaps.push(gap);
      }
      prevCompleted = completedAt;
    }

    // Bounce detection
    for (let i = 1; i < history.length; i++) {
      if (history[i].timestamp < dayStart || history[i].timestamp >= dayEnd) continue;
      if (history[i].status === 'in-progress' && (history[i - 1]?.status === 'review' || history[i - 1]?.status === 'qa')) {
        bounceCount++;
      }
    }

    // First-pass
    const dayHistory = history.filter((h: any) => h.timestamp >= dayStart && h.timestamp < dayEnd);
    const statusSequence = dayHistory.map((h: any) => h.status);
    if (statusSequence.includes('done') && !statusSequence.includes('blocked')) {
      let bounced = false;
      for (let i = 1; i < statusSequence.length; i++) {
        if (statusSequence[i] === 'in-progress' && (statusSequence[i - 1] === 'review' || statusSequence[i - 1] === 'qa')) {
          bounced = true;
          break;
        }
      }
      if (!bounced) firstPassCount++;
    }

    // Stall
    if (task.loopPausedAt && task.loopPausedAt >= dayStart && task.loopPausedAt < dayEnd) {
      stallCount++;
    }
  }

  // Zero-activity check
  if (tasksCompleted === 0 && tasksStarted === 0) {
    return null;
  }

  // Derived metrics
  const avgDuration = durations.length > 0 ? durations.reduce((a, b) => a + b, 0) / durations.length : null;
  const medianDuration = durations.length > 0 ? durations.sort((a, b) => a - b)[Math.floor(durations.length / 2)] : null;
  const avgGap = gaps.length > 0 ? gaps.reduce((a, b) => a + b, 0) / gaps.length : null;
  const chainRate = gaps.length > 0 ? gaps.filter(g => g < 2).length / gaps.length : null;

  let activeMinutes = 0;
  if (durations.length > 0) {
    activeMinutes = durations.reduce((a, b) => a + b, 0) + gaps.filter(g => g < 30).reduce((a, b) => a + b, 0);
  }
  const throughput = activeMinutes > 0 ? (tasksCompleted / (activeMinutes / 60)) : null;
  const firstPassRate = doneCount > 0 ? firstPassCount / doneCount : null;
  const reviewNotesRate = doneCount > 0 ? reviewNotesCount / doneCount : null;
  const testPlanRate = doneCount > 0 ? testPlanCount / doneCount : null;

  return {
    tasks_completed: tasksCompleted,
    tasks_started: tasksStarted,
    avg_duration_min: avgDuration != null ? Math.round(avgDuration * 10) / 10 : null,
    median_duration_min: medianDuration != null ? Math.round(medianDuration * 10) / 10 : null,
    avg_gap_min: avgGap != null ? Math.round(avgGap * 10) / 10 : null,
    chain_rate: chainRate != null ? Math.round(chainRate * 1000) / 1000 : null,
    throughput: throughput != null ? Math.round(throughput * 10) / 10 : null,
    first_pass_rate: firstPassRate != null ? Math.round(firstPassRate * 1000) / 1000 : null,
    bounce_count: bounceCount,
    stall_count: stallCount,
    active_minutes: Math.round(activeMinutes),
    review_notes_rate: reviewNotesRate != null ? Math.round(reviewNotesRate * 1000) / 1000 : null,
    test_plan_rate: testPlanRate != null ? Math.round(testPlanRate * 1000) / 1000 : null,
    roadmap_throughput: roadmapThroughput,
    adhoc_throughput: adhocThroughput,
  };
}
