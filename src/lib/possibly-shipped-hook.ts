/**
 * Hook (#1351 slice 2): populate `possibly_already_shipped` on a task
 * after create or update by scoring it against the project's linked repos
 * (last-90d merged PRs) and the done-task corpus.
 *
 * Fire-and-forget by design — the caller in `route.ts` invokes this in a
 * detached async IIFE so ticket create / update never blocks on the
 * lookup. On any failure the task is left unchanged.
 *
 * Lives in its own module (not inline in `route.ts`) so the matcher hook
 * is unit-testable in isolation and so future slices (e.g. backfill
 * pass in slice 5) can reuse it.
 */

import { getMergedPRsForRepos, normalizeRepo } from './gh-pr-cache';
import { findMatches, type MatchableTask } from './duplicate-matcher';
import type { Task, Project } from './store';

/** 90 days */
const DONE_TASK_WINDOW_MS = 90 * 24 * 60 * 60 * 1000;

/**
 * Resolve the list of GitHub repos (owner/repo form) attached to a project.
 * Honors the new `repoUrls?: string[]` array first, falls back to the
 * legacy single `repoUrl` field.
 */
export function resolveProjectRepos(project: Project | undefined | null): string[] {
  if (!project) return [];
  const raw = Array.isArray(project.repoUrls) && project.repoUrls.length > 0
    ? project.repoUrls
    : project.repoUrl ? [project.repoUrl] : [];
  return raw.map((r) => normalizeRepo(r)).filter((r): r is string => !!r);
}

/**
 * Find done-status tasks completed in the last 90 days, optionally
 * filtered to the same project. Used as the second matcher corpus
 * (alongside merged PRs).
 */
export function selectDoneTaskCorpus(
  allTasks: Task[],
  opts: { sameProjectId?: string; now?: number } = {},
): MatchableTask[] {
  const now = opts.now ?? Date.now();
  const cutoff = now - DONE_TASK_WINDOW_MS;
  const out: MatchableTask[] = [];
  for (const t of allTasks) {
    if (t.status !== 'done') continue;
    if (opts.sameProjectId && t.projectId !== opts.sameProjectId) continue;
    // Best-available "doneAt" — prefer statusHistory's last done entry, fall
    // back to createdAt so very-old tasks still have a recency value.
    let doneAt: number | undefined;
    if (Array.isArray(t.statusHistory)) {
      for (let i = t.statusHistory.length - 1; i >= 0; i--) {
        if (t.statusHistory[i]?.status === 'done') {
          doneAt = t.statusHistory[i]?.timestamp;
          break;
        }
      }
    }
    const recency = doneAt ?? t.createdAt;
    if (recency && recency < cutoff) continue;
    out.push({
      id: t.id,
      ticketNumber: t.ticketNumber,
      title: t.title,
      description: t.description,
      doneWhen: t.doneWhen,
      status: t.status,
      createdAt: t.createdAt,
      doneAt,
    });
  }
  return out;
}

export interface ApplyHookInput {
  task: Task;
  project: Project | undefined | null;
  allTasks: Task[];
  /** Override clock for tests */
  now?: number;
}

export interface ApplyHookResult {
  matches: Task['possibly_already_shipped'];
  /** Diagnostic info — never persisted */
  meta: {
    repos: string[];
    prCount: number;
    doneTaskCount: number;
    durationMs: number;
    error?: string;
  };
}

/**
 * Compute `possibly_already_shipped` for one task. Returns the matches
 * array (empty if nothing crosses threshold) plus diagnostic metadata.
 * Does NOT write to the store — the caller is responsible for that so
 * write paths stay symmetric.
 *
 * Never throws.
 */
export async function computeMatches(input: ApplyHookInput): Promise<ApplyHookResult> {
  const t0 = Date.now();
  const meta = {
    repos: [] as string[],
    prCount: 0,
    doneTaskCount: 0,
    durationMs: 0,
    error: undefined as string | undefined,
  };
  try {
    const repos = resolveProjectRepos(input.project ?? null);
    meta.repos = repos;
    const [prs, doneTasks] = await Promise.all([
      repos.length > 0 ? getMergedPRsForRepos(repos) : Promise.resolve([]),
      Promise.resolve(
        selectDoneTaskCorpus(input.allTasks, {
          sameProjectId: input.task.projectId,
          now: input.now,
        }),
      ),
    ]);
    meta.prCount = prs.length;
    meta.doneTaskCount = doneTasks.length;
    const candidates = findMatches({
      sourceTitle: input.task.title,
      sourceDescription: input.task.description,
      sourceTicketNumber: input.task.ticketNumber,
      sourceTaskId: input.task.id,
      prs,
      doneTasks,
      now: input.now,
    });
    const matches = candidates.map((c) => ({
      type: c.type,
      id: c.id,
      title: c.title,
      score: Number(c.score.toFixed(3)),
      url: c.url,
      mergedAt: c.type === 'pr' ? c.recency : undefined,
      matchedAt: input.now ?? Date.now(),
    }));
    meta.durationMs = Date.now() - t0;
    return { matches, meta };
  } catch (err: any) {
    meta.error = err?.message || String(err);
    meta.durationMs = Date.now() - t0;
    return { matches: [], meta };
  }
}
