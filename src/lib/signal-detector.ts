/**
 * Signal Detection Engine
 * 
 * Analyzes task data and produces suggested cultural signals (kudos/flags).
 * Runs server-side, pure computation on store data.
 */

import { Task, Project } from './store';
import crypto from 'crypto';

const STATUS_ORDER: Record<string, number> = {
  backlog: 0,
  planning: 1,
  'in-progress': 2,
  qa: 3,
  review: 4,
  done: 5,
};

/**
 * Get the timestamp when a task was last moved to 'done'
 */
function getDoneTimestamp(task: Task): number | null {
  const history = task.statusHistory || [];
  for (let i = history.length - 1; i >= 0; i--) {
    if (history[i].status === 'done') return history[i].timestamp;
  }
  if (task.status === 'done') return task.lastActivityAt || task.createdAt;
  return null;
}

/**
 * Check if a task had any backward status moves (a bounce)
 */
function hasBounce(task: Task): boolean {
  const history = task.statusHistory || [];
  for (let i = 1; i < history.length; i++) {
    const prev = STATUS_ORDER[history[i - 1].status] ?? -1;
    const curr = STATUS_ORDER[history[i].status] ?? -1;
    if (curr < prev) return true;
  }
  return false;
}

/**
 * Format milliseconds into a human-readable duration string
 */
function formatDuration(ms: number): string {
  const hours = ms / (1000 * 60 * 60);
  if (hours < 1) return `${Math.round(hours * 60)}m`;
  if (hours < 24) return `${Math.round(hours)}h`;
  return `${Math.round(hours / 24)}d`;
}

/**
 * Compute version duration: from first in-progress to last done (ms)
 */
function getVersionDuration(tasks: Task[]): number | null {
  let firstInProgress: number | null = null;
  let lastDone: number | null = null;
  for (const task of tasks) {
    for (const entry of (task.statusHistory || [])) {
      if (entry.status === 'in-progress') {
        if (firstInProgress === null || entry.timestamp < firstInProgress) firstInProgress = entry.timestamp;
      }
      if (entry.status === 'done') {
        if (lastDone === null || entry.timestamp > lastDone) lastDone = entry.timestamp;
      }
    }
  }
  if (!firstInProgress || !lastDone || lastDone <= firstInProgress) return null;
  return lastDone - firstInProgress;
}

export interface DetectedSignal {
  id: string;
  agentId: string;
  agentName: string;
  type: 'kudos' | 'flag';
  values: string[];
  note: string;
  evidence: string;
  taskId?: string;
  projectId?: string;
  detectedAt: number;
}

interface StoreData {
  tasks: Task[];
  projects: Project[];
  teammates?: Array<{ name: string; agentId: string; isHuman?: boolean }>;
  settings?: { teammates?: Array<{ name: string; agentId: string; isHuman?: boolean }> };
}

/**
 * Generate deterministic signal ID from type + agent + evidence
 * Same signal = same ID (allows deduplication on dismiss)
 */
function signalId(type: string, agentId: string, evidence: string): string {
  const hash = crypto.createHash('md5').update(`${type}:${agentId}:${evidence}`).digest('hex').slice(0, 12);
  return `sig-${hash}`;
}

/**
 * Check if an author is human (not an agent)
 */
function isHumanAuthor(author: string, teammates?: Array<{ name: string; agentId: string; isHuman?: boolean }>): boolean {
  if (!teammates) return true; // Default to human if no teammate list
  const tm = teammates.find(t => t.name === author || t.agentId === author);
  return !tm || tm.isHuman !== false; // Default to human if not found or explicitly marked
}

/**
 * SIGNAL 1: Silent Autonomy
 * Agent completed N tasks (N >= 3) in a row without any human comments
 */
function detectSilentAutonomy(tasks: Task[], agentName: string, teammates?: Array<{ name: string; agentId: string; isHuman?: boolean }>): DetectedSignal | null {
  const doneTasks = tasks
    .filter(t => t.assignee === agentName && t.status === 'done' && !t.isArchived)
    .sort((a, b) => (b.lastActivityAt || b.createdAt) - (a.lastActivityAt || a.createdAt));

  if (doneTasks.length < 3) return null;

  // Check the last 3 done tasks - are they all without human comments?
  const lastN = doneTasks.slice(0, 3);
  const allAutonomous = lastN.every(task => {
    const hasHumanComment = (task.comments || []).some(c => isHumanAuthor(c.author, teammates));
    return !hasHumanComment;
  });

  if (!allAutonomous) return null;

  const taskIds = lastN.map(t => `#${t.ticketNumber || t.id.slice(0, 5)}`).join('-');
  
  return {
    id: signalId('silent-autonomy', agentName, taskIds),
    agentId: agentName,
    agentName,
    type: 'kudos',
    values: ['autonomy'],
    note: `${agentName} completed ${lastN.length} tasks autonomously — no human intervention needed`,
    evidence: `tasks ${taskIds}`,
    detectedAt: Date.now(),
  };
}

/**
 * SIGNAL 2: Clean Sprint
 * Agent completed all tasks in a version with 0 QA bounces
 */
function detectCleanSprint(tasks: Task[], agentName: string, projects: Project[]): DetectedSignal | null {
  // Find versions where this agent is dev owner
  const devOwnedProjects = projects.filter(p => p.devOwner === agentName);
  
  for (const project of devOwnedProjects) {
    if (!project.currentVersion) continue;
    
    // Get all tasks for this version assigned to this agent
    const versionTasks = tasks.filter(
      t => t.projectId === project.id && 
           t.version === project.currentVersion &&
           t.assignee === agentName &&
           !t.isArchived
    );

    if (versionTasks.length === 0) continue;

    // Check if all are done
    const allDone = versionTasks.every(t => t.status === 'done');
    if (!allDone) continue;

    // Check for QA bounces (review → in-progress or qa → in-progress)
    const hasQABounce = versionTasks.some(task => {
      const history = task.statusHistory || [];
      for (let i = 1; i < history.length; i++) {
        const prev = history[i - 1].status;
        const curr = history[i].status;
        if ((prev === 'review' || prev === 'qa') && curr === 'in-progress') {
          return true;
        }
      }
      return false;
    });

    if (hasQABounce) continue;

    // Clean sprint detected!
    return {
      id: signalId('clean-sprint', agentName, `${project.id}:${project.currentVersion}`),
      agentId: agentName,
      agentName,
      type: 'kudos',
      values: ['autonomy', 'people-first'],
      note: `${agentName} shipped ${project.currentVersion} with zero QA bounces — clean sprint`,
      evidence: `${versionTasks.length} tasks completed`,
      projectId: project.id,
      detectedAt: Date.now(),
    };
  }

  return null;
}

/**
 * SIGNAL 3: Above and Beyond
 * Agent completed a task they created themselves (not from vision cycle)
 * NOTE: Task interface doesn't have 'createdBy', so this signal is disabled
 */
function detectAboveAndBeyond(tasks: Task[], agentName: string): DetectedSignal | null {
  // Disabled: Task interface doesn't track who created it
  return null;
}

/**
 * SIGNAL 4: Fast Delivery
 * Agent's average cycle time for last 5 tasks is under 1 hour
 */
function detectFastDelivery(tasks: Task[], agentName: string): DetectedSignal | null {
  const doneTasks = tasks
    .filter(t => t.assignee === agentName && t.status === 'done' && !t.isArchived)
    .sort((a, b) => (b.lastActivityAt || b.createdAt) - (a.lastActivityAt || a.createdAt))
    .slice(0, 5);

  if (doneTasks.length < 5) return null;

  // Calculate cycle time for each task (from created to done)
  const cycleTimes = doneTasks.map(t => {
    const created = t.createdAt;
    const done = t.lastActivityAt || t.createdAt; // Approximate
    return done - created;
  });

  const avgCycleTime = cycleTimes.reduce((a, b) => a + b, 0) / cycleTimes.length;
  const avgHours = avgCycleTime / (1000 * 60 * 60);

  if (avgHours >= 1) return null;

  const timeStr = avgHours < 0.1 ? '<6 min' : `${Math.round(avgHours * 60)} min`;

  return {
    id: signalId('fast-delivery', agentName, `avg-${Math.round(avgHours * 100)}`),
    agentId: agentName,
    agentName,
    type: 'kudos',
    values: ['autonomy'],
    note: `${agentName} averaging ${timeStr} per task over last 5 completions`,
    evidence: `${doneTasks.length} tasks`,
    detectedAt: Date.now(),
  };
}

/**
 * SIGNAL 5: Going Dark
 * Agent has a task in-progress for >4 hours with no comments/updates
 */
function detectGoingDark(tasks: Task[]): DetectedSignal[] {
  const signals: DetectedSignal[] = [];
  const now = Date.now();
  const FOUR_HOURS = 4 * 60 * 60 * 1000;

  for (const task of tasks) {
    if (task.status !== 'in-progress' || task.isArchived) continue;

    const lastActivity = task.lastActivityAt || task.createdAt;
    const inactiveTime = now - lastActivity;

    if (inactiveTime > FOUR_HOURS) {
      signals.push({
        id: signalId('going-dark', task.assignee, task.id),
        agentId: task.assignee,
        agentName: task.assignee,
        type: 'flag',
        values: ['teamwork'],
        note: `${task.assignee}'s task "${task.title}" has been active for ${Math.round(inactiveTime / (60 * 60 * 1000))}h with no updates`,
        evidence: `last update ${new Date(lastActivity).toLocaleString()}`,
        taskId: task.id,
        detectedAt: Date.now(),
      });
    }
  }

  return signals;
}

/**
 * SIGNAL 6: Repeated QA Bounces
 * Agent had 2+ tasks bounced from QA/review in last 7 days
 */
function detectRepeatedQABounces(tasks: Task[]): DetectedSignal[] {
  const signals: DetectedSignal[] = [];
  const now = Date.now();
  const SEVEN_DAYS = 7 * 24 * 60 * 60 * 1000;

  const bouncesByAgent: Record<string, Task[]> = {};

  for (const task of tasks) {
    if (task.isArchived) continue;

    const history = task.statusHistory || [];
    let bounceTimestamp = 0;

    // Detect bounces: review→in-progress or qa→in-progress
    for (let i = 1; i < history.length; i++) {
      const prev = history[i - 1];
      const curr = history[i];
      if ((prev.status === 'review' || prev.status === 'qa') && curr.status === 'in-progress') {
        bounceTimestamp = curr.timestamp;
        break;
      }
    }

    if (bounceTimestamp && now - bounceTimestamp < SEVEN_DAYS) {
      const agentId = task.assignee;
      if (!bouncesByAgent[agentId]) bouncesByAgent[agentId] = [];
      bouncesByAgent[agentId].push(task);
    }
  }

  // Create signals for agents with 2+ bounces
  for (const [agentId, bouncedTasks] of Object.entries(bouncesByAgent)) {
    if (bouncedTasks.length >= 2) {
      signals.push({
        id: signalId('repeated-bounces', agentId, `count-${bouncedTasks.length}`),
        agentId,
        agentName: agentId,
        type: 'flag',
        values: ['people-first'],
        note: `${agentId} had ${bouncedTasks.length} tasks bounced from QA this week — review quality may need attention`,
        evidence: `${bouncedTasks.map(t => `#${t.ticketNumber || t.id.slice(0, 5)}`).join(', ')}`,
        detectedAt: Date.now(),
      });
    }
  }

  return signals;
}

/**
 * SIGNAL 8: Milestone Streak
 * Agent completed N consecutive tasks (N >= 10) with no backward status moves
 */
function detectMilestoneStreak(tasks: Task[], agentName: string): DetectedSignal | null {
  const doneTasks = tasks
    .filter(t => t.assignee === agentName && t.status === 'done' && !t.isArchived)
    .sort((a, b) => (getDoneTimestamp(b) ?? 0) - (getDoneTimestamp(a) ?? 0)); // newest first

  if (doneTasks.length < 10) return null;

  let streak = 0;
  for (const task of doneTasks) {
    if (hasBounce(task)) break;
    streak++;
  }

  if (streak < 10) return null;

  // Round down to nearest 10 to avoid re-firing every task
  const roundedStreak = Math.floor(streak / 10) * 10;

  return {
    id: signalId('milestone-streak', agentName, `streak-${roundedStreak}`),
    agentId: agentName,
    agentName,
    type: 'kudos',
    values: ['autonomy', 'people-first'],
    note: `${agentName} hit a ${streak}-task clean streak — no bounces or rework`,
    evidence: `last ${streak} tasks completed cleanly`,
    detectedAt: Date.now(),
  };
}

/**
 * SIGNAL 9: Perfect Week
 * Agent completed 5+ tasks in last 7 days with zero backward status moves
 */
function detectPerfectWeek(tasks: Task[], agentName: string): DetectedSignal | null {
  const now = Date.now();
  const SEVEN_DAYS = 7 * 24 * 60 * 60 * 1000;

  const weekTasks = tasks.filter(t => {
    if (t.assignee !== agentName || t.status !== 'done' || t.isArchived) return false;
    const doneTs = getDoneTimestamp(t);
    return doneTs !== null && now - doneTs < SEVEN_DAYS;
  });

  if (weekTasks.length < 5) return null;
  if (weekTasks.some(t => hasBounce(t))) return null;

  const timestamps = weekTasks.map(t => getDoneTimestamp(t) ?? 0).filter(ts => ts > 0);
  const minTs = Math.min(...timestamps);
  const maxTs = Math.max(...timestamps);
  const startDate = new Date(minTs).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  const endDate = new Date(maxTs).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });

  // ISO week for stable signal ID
  const weekDate = new Date(maxTs);
  const dayOfWeek = weekDate.getUTCDay() || 7;
  weekDate.setUTCDate(weekDate.getUTCDate() + 4 - dayOfWeek);
  const yearStart = new Date(Date.UTC(weekDate.getUTCFullYear(), 0, 1));
  const isoWeek = `${weekDate.getUTCFullYear()}-W${Math.ceil(((weekDate.getTime() - yearStart.getTime()) / 86400000 + 1) / 7)}`;

  return {
    id: signalId('perfect-week', agentName, isoWeek),
    agentId: agentName,
    agentName,
    type: 'kudos',
    values: ['people-first'],
    note: `${agentName} had a perfect week — ${weekTasks.length} tasks, zero bounces`,
    evidence: `week of ${startDate}–${endDate}`,
    detectedAt: Date.now(),
  };
}

/**
 * SIGNAL 10: High-Volume Day
 * Agent completed 10+ tasks on a single day
 */
function detectHighVolumeDay(tasks: Task[], agentName: string): DetectedSignal | null {
  const doneTasks = tasks.filter(t => t.assignee === agentName && t.status === 'done' && !t.isArchived);

  const byDate: Record<string, Task[]> = {};
  for (const task of doneTasks) {
    const doneTs = getDoneTimestamp(task);
    if (!doneTs) continue;
    const dateStr = new Date(doneTs).toISOString().slice(0, 10);
    if (!byDate[dateStr]) byDate[dateStr] = [];
    byDate[dateStr].push(task);
  }

  const qualifyingDays = Object.entries(byDate)
    .filter(([, dayTasks]) => dayTasks.length >= 10)
    .sort(([a], [b]) => b.localeCompare(a)); // newest first

  if (qualifyingDays.length === 0) return null;

  const [dateStr, dayTasks] = qualifyingDays[0];
  const displayDate = new Date(dateStr + 'T12:00:00Z').toLocaleDateString('en-US', {
    month: 'short', day: 'numeric', year: 'numeric',
  });

  return {
    id: signalId('high-volume-day', agentName, dateStr),
    agentId: agentName,
    agentName,
    type: 'kudos',
    values: ['autonomy'],
    note: `${agentName} completed ${dayTasks.length} tasks on ${displayDate} — massive output`,
    evidence: `${dayTasks.length} tasks on ${displayDate}`,
    detectedAt: Date.now(),
  };
}

/**
 * SIGNAL 11: Throughput Leader
 * Agent has the highest avgThroughput on the team
 */
async function detectThroughputLeader(agentName: string): Promise<DetectedSignal | null> {
  try {
    const response = await fetch('http://localhost:4501/api/metrics/team', {
      headers: { 'X-Internal-Request': 'true' },
    });
    if (!response.ok) return null;
    const data = await response.json();
    const metrics: Array<{ agentId: string; avgThroughput: number }> = data.metrics || [];

    if (metrics.length === 0) return null;

    const sorted = [...metrics].sort((a, b) => (b.avgThroughput ?? 0) - (a.avgThroughput ?? 0));
    const top = sorted[0];
    if (!top || (top.avgThroughput ?? 0) <= 0) return null;

    // Match by agentId or name (case-insensitive)
    const isTopAgent = top.agentId === agentName ||
      top.agentId.toLowerCase() === agentName.toLowerCase();
    if (!isTopAgent) return null;

    const teamAvg = metrics.reduce((sum, m) => sum + (m.avgThroughput ?? 0), 0) / metrics.length;
    const roundedTop = Math.round(top.avgThroughput * 100) / 100;
    const roundedAvg = Math.round(teamAvg * 100) / 100;

    return {
      id: signalId('throughput-leader', agentName, 'leader'),
      agentId: agentName,
      agentName,
      type: 'kudos',
      values: ['autonomy'],
      note: `${agentName} leads the team in throughput at ${roundedTop}/hr`,
      evidence: `team average: ${roundedAvg}/hr`,
      detectedAt: Date.now(),
    };
  } catch (err) {
    console.warn('[signal-detector] Throughput leader fetch failed:', err);
    return null;
  }
}

/**
 * SIGNAL 12: Fastest Version
 * Agent shipped current project version faster than any prior version
 */
function detectFastestVersion(tasks: Task[], agentName: string, projects: Project[]): DetectedSignal | null {
  const devOwnedProjects = projects.filter(p => p.devOwner === agentName && p.currentVersion);

  for (const project of devOwnedProjects) {
    const currentVersion = project.currentVersion!;
    const projectTasks = tasks.filter(t => t.projectId === project.id && !t.isArchived && t.version);

    const byVersion: Record<string, Task[]> = {};
    for (const task of projectTasks) {
      const v = task.version!;
      if (!byVersion[v]) byVersion[v] = [];
      byVersion[v].push(task);
    }

    const currentTasks = byVersion[currentVersion] || [];
    if (currentTasks.length === 0) continue;
    if (!currentTasks.every(t => t.status === 'done')) continue;

    const currentDuration = getVersionDuration(currentTasks);
    if (!currentDuration) continue;

    const priorDurations = Object.entries(byVersion)
      .filter(([v, vTasks]) => v !== currentVersion && vTasks.every(t => t.status === 'done'))
      .map(([, vTasks]) => getVersionDuration(vTasks))
      .filter((d): d is number => d !== null);

    if (priorDurations.length === 0) continue;

    const bestPrior = Math.min(...priorDurations);
    if (currentDuration >= bestPrior) continue;

    return {
      id: signalId('fastest-version', agentName, `${project.id}:${currentVersion}`),
      agentId: agentName,
      agentName,
      type: 'kudos',
      values: ['autonomy', 'curiosity'],
      note: `${agentName} shipped ${currentVersion} in ${formatDuration(currentDuration)} — fastest version yet for ${project.name}`,
      evidence: `${formatDuration(currentDuration)} vs prior best of ${formatDuration(bestPrior)}`,
      projectId: project.id,
      detectedAt: Date.now(),
    };
  }

  return null;
}

/**
 * SIGNAL 7: Scope Creep
 * Agent created 3+ new tasks on a project they're not the devOwner of
 * NOTE: Task interface doesn't have 'createdBy', so this signal is disabled
 */
function detectScopeCreep(tasks: Task[], projects: Project[]): DetectedSignal[] {
  // Disabled: Task interface doesn't track who created it
  return [];
}

/**
 * Main detection function
 * Runs all detectors and returns list of suggested signals
 */
export async function detectSignals(store: StoreData): Promise<DetectedSignal[]> {
  const { tasks = [], projects = [] } = store;
  const teammates = store.teammates || store.settings?.teammates || [];
  const signals: DetectedSignal[] = [];

  // Only detect signals for agents registered in the teammate roster
  const agentTeammates = teammates.filter(t => !t.isHuman && t.name);
  const agentNames = new Set(agentTeammates.map(t => t.name!));

  // Skip if no agent teammates registered yet
  if (agentNames.size === 0) return signals;

  // POSITIVE SIGNALS: Run per registered agent
  for (const agentName of agentNames) {
    const silentAuto = detectSilentAutonomy(tasks, agentName, teammates);
    if (silentAuto) signals.push(silentAuto);

    const cleanSprint = detectCleanSprint(tasks, agentName, projects);
    if (cleanSprint) signals.push(cleanSprint);

    const aboveAndBeyond = detectAboveAndBeyond(tasks, agentName);
    if (aboveAndBeyond) signals.push(aboveAndBeyond);

    const fastDelivery = detectFastDelivery(tasks, agentName);
    if (fastDelivery) signals.push(fastDelivery);

    const milestoneStreak = detectMilestoneStreak(tasks, agentName);
    if (milestoneStreak) signals.push(milestoneStreak);

    const perfectWeek = detectPerfectWeek(tasks, agentName);
    if (perfectWeek) signals.push(perfectWeek);

    const highVolumeDay = detectHighVolumeDay(tasks, agentName);
    if (highVolumeDay) signals.push(highVolumeDay);

    const fastestVersion = detectFastestVersion(tasks, agentName, projects);
    if (fastestVersion) signals.push(fastestVersion);

    const throughputLeader = await detectThroughputLeader(agentName);
    if (throughputLeader) signals.push(throughputLeader);
  }

  // NEGATIVE SIGNALS: Global scans (filter to registered agents only)
  const negativeSignals = [
    ...detectGoingDark(tasks),
    ...detectRepeatedQABounces(tasks),
    ...detectScopeCreep(tasks, projects),
  ].filter(s => agentNames.has(s.agentName));
  signals.push(...negativeSignals);

  return signals;
}
