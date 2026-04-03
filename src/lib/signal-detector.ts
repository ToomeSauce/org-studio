/**
 * Signal Detection Engine
 * 
 * Analyzes task data and produces suggested cultural signals (kudos/flags).
 * Runs server-side, pure computation on store data.
 */

import { Task, Project } from './store';
import crypto from 'crypto';

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
