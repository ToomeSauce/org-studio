/**
 * GitHub PR cache (#1351 slice 1)
 * ================================
 *
 * Fetches merged PRs per `owner/repo` via the `gh` CLI (which carries the
 * toomesauce GitHub auth from `~/.config/gh/hosts.yml` — no env var or
 * token management here). Results are cached in-process with a 15-minute
 * TTL and an inflight-promise dedupe so a burst of `addTask` calls against
 * the same repo doesn't fan out into N subprocess invocations.
 *
 * Used by the fuzzy matcher (slice 2) to score newly created or updated
 * tickets against recent merged PRs across every linked repo. Never
 * blocks: every public entry point is wrapped in a timeout and returns
 * `[]` on failure rather than throwing.
 *
 * Scope (v1):
 *   - Merged PRs only (open/closed-without-merge are not "shipped work")
 *   - Last 90 days only (configurable via WINDOW_MS)
 *   - At most 100 PRs per repo per refresh (gh CLI page-1 default cap)
 *   - No DB persistence — purely in-memory; a process restart re-fetches
 *
 * Out of scope (later slices / future work):
 *   - Persistent disk cache (would survive restarts; not needed yet)
 *   - Pagination beyond 100 (large monorepos may want this)
 *   - Subscribing to webhooks for live invalidation
 *   - Querying Org Studio's own done tasks (matcher does that directly
 *     from `cachedStore`, no caching layer needed)
 */

import { spawn } from 'node:child_process';

export interface MergedPR {
  /** "owner/repo#123" — stable cross-repo identifier */
  id: string;
  number: number;
  owner: string;
  repo: string;
  title: string;
  body: string;
  url: string;
  /** ms epoch */
  mergedAt: number;
  author?: string;
}

interface CacheEntry {
  prs: MergedPR[];
  fetchedAt: number;
}

/** 15 minutes — see ticket constraint */
const TTL_MS = 15 * 60 * 1000;

/** 90 days */
const WINDOW_MS = 90 * 24 * 60 * 60 * 1000;

/** Per-call gh subprocess timeout */
const FETCH_TIMEOUT_MS = 8000;

/** Most callers should request just a few repos at once */
const MAX_REPOS_PER_CALL = 12;

/** Max merged PRs we'll keep per repo (matches gh default page size) */
const PER_REPO_LIMIT = 100;

const cache = new Map<string, CacheEntry>();
const inflight = new Map<string, Promise<MergedPR[]>>();

/**
 * Run `gh api` and parse JSON. Resolves on success; rejects (or times out)
 * on failure — caller handles fallback.
 */
function runGh(args: string[], timeoutMs: number): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    let settled = false;
    const child = spawn('gh', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { child.kill('SIGTERM'); } catch {}
      reject(new Error(`gh ${args[0]} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    child.stdout.on('data', (b) => { stdout += b.toString(); });
    child.stderr.on('data', (b) => { stderr += b.toString(); });
    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(err);
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error(`gh exited ${code}: ${stderr.trim().slice(0, 200)}`));
        return;
      }
      try {
        resolve(JSON.parse(stdout));
      } catch (e: any) {
        reject(new Error(`gh JSON parse: ${e?.message || e}`));
      }
    });
  });
}

/** Normalize "https://github.com/owner/repo[.git]" or "owner/repo" → "owner/repo" */
export function normalizeRepo(input: string | null | undefined): string | null {
  if (!input) return null;
  let s = String(input).trim();
  s = s.replace(/^https?:\/\/github\.com\//i, '');
  s = s.replace(/^git@github\.com:/i, '');
  s = s.replace(/\.git$/i, '');
  s = s.replace(/^\/+|\/+$/g, '');
  if (!/^[\w.-]+\/[\w.-]+$/.test(s)) return null;
  return s;
}

async function fetchOne(repo: string, windowMs: number): Promise<MergedPR[]> {
  const sinceIso = new Date(Date.now() - windowMs).toISOString();
  // gh api search/issues with `is:pr is:merged repo:X merged:>=YYYY-MM-DD`
  // — search endpoint scales better than /repos/X/pulls?state=closed and
  // returns the same fields we need.
  const q = `repo:${repo} is:pr is:merged merged:>=${sinceIso.slice(0, 10)}`;
  const args = [
    'api',
    '-X', 'GET',
    'search/issues',
    '-f', `q=${q}`,
    '-f', 'sort=updated',
    '-f', 'order=desc',
    '-f', `per_page=${PER_REPO_LIMIT}`,
  ];
  const raw = (await runGh(args, FETCH_TIMEOUT_MS)) as any;
  const items: any[] = Array.isArray(raw?.items) ? raw.items : [];
  const [owner, repoName] = repo.split('/');
  return items
    .map((it): MergedPR | null => {
      const number = Number(it?.number);
      const url = String(it?.html_url || '');
      const title = String(it?.title || '');
      const body = String(it?.body || '');
      // search/issues for is:merged returns `pull_request.merged_at` when
      // hydrated via expansion; the bare endpoint returns `closed_at` only.
      // For our recency scoring we treat closed_at on a merged PR as a
      // close-enough proxy.
      const mergedAt = Date.parse(
        it?.pull_request?.merged_at || it?.closed_at || it?.updated_at || '',
      );
      if (!number || !url || !title || !Number.isFinite(mergedAt)) return null;
      return {
        id: `${repo}#${number}`,
        number,
        owner,
        repo: repoName,
        title,
        body,
        url,
        mergedAt,
        author: it?.user?.login,
      };
    })
    .filter((x): x is MergedPR => x !== null);
}

/**
 * Get merged PRs for `repo` (owner/repo form). Returns `[]` on any failure
 * — never throws.
 *
 * The cache is keyed by normalized repo + window bucket. If you pass a
 * non-default `windowMs`, results aren't shared with default-window
 * callers; that's intentional.
 */
export async function getMergedPRs(
  repoInput: string,
  opts: { windowMs?: number; force?: boolean } = {},
): Promise<MergedPR[]> {
  const repo = normalizeRepo(repoInput);
  if (!repo) return [];
  const windowMs = opts.windowMs ?? WINDOW_MS;
  const key = `${repo}@${windowMs}`;
  const now = Date.now();
  if (!opts.force) {
    const hit = cache.get(key);
    if (hit && now - hit.fetchedAt < TTL_MS) return hit.prs;
  }
  const existing = inflight.get(key);
  if (existing) return existing;
  const pending = (async () => {
    try {
      const prs = await fetchOne(repo, windowMs);
      cache.set(key, { prs, fetchedAt: Date.now() });
      return prs;
    } catch (err: any) {
      // On failure, keep any stale entry so we degrade rather than thrash.
      const stale = cache.get(key);
      // eslint-disable-next-line no-console
      console.warn(
        `[gh-pr-cache] fetch failed for ${repo}: ${err?.message || err}` +
          (stale ? ` (serving ${stale.prs.length} stale PRs)` : ''),
      );
      return stale?.prs ?? [];
    } finally {
      inflight.delete(key);
    }
  })();
  inflight.set(key, pending);
  return pending;
}

/**
 * Fetch merged PRs for multiple repos in parallel (capped). Used by the
 * matcher when scoring a ticket against every linked repo of its project.
 */
export async function getMergedPRsForRepos(
  repos: Array<string | null | undefined>,
  opts: { windowMs?: number; force?: boolean } = {},
): Promise<MergedPR[]> {
  const normalized = Array.from(
    new Set(
      repos
        .map((r) => normalizeRepo(r))
        .filter((r): r is string => r !== null),
    ),
  ).slice(0, MAX_REPOS_PER_CALL);
  if (normalized.length === 0) return [];
  const lists = await Promise.all(
    normalized.map((repo) => getMergedPRs(repo, opts)),
  );
  return lists.flat();
}

/**
 * Cache introspection for tests + the /api/runtimes style status panel
 * we'll add in slice 3.
 */
export function getCacheStats() {
  const now = Date.now();
  const entries = Array.from(cache.entries()).map(([key, v]) => ({
    key,
    prCount: v.prs.length,
    ageMs: now - v.fetchedAt,
    stale: now - v.fetchedAt >= TTL_MS,
  }));
  return { entryCount: entries.length, entries };
}

/** Test helper — wipes the cache. Not exported via index. */
export function _clearCacheForTests() {
  cache.clear();
  inflight.clear();
}

export const _internal = {
  TTL_MS,
  WINDOW_MS,
  FETCH_TIMEOUT_MS,
  MAX_REPOS_PER_CALL,
  PER_REPO_LIMIT,
};
