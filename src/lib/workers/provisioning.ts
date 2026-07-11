/**
 * ProvisioningAdapter — where a worker job actually runs (#1660, W-5).
 *
 * The security ladder from docs/design/execution-workers.md:
 *   local-process   → zero isolation, trusted like a runtime (W-2 behavior)
 *   local-container → Docker, shared kernel            (future)
 *   gh-actions      → ephemeral runner, our dogfood    (THIS ticket)
 *   vm              → full isolation, cloud/enterprise (future)
 *
 * Same shell, ledger, and HostProfile enforcement in every mode — only the
 * adapter changes. WorkerRuntime picks the adapter from WorkerConfig.mode.
 *
 * gh-actions flow (dogfood lane — chore/bug on OSS repos, NOT hanktank):
 *   1. dispatch fires the `worker-job.yml` workflow via workflow_dispatch
 *      with ticket inputs (repo, ticket number, brief).
 *   2. The runner checks out the target repo, runs the engine, pushes a
 *      `worker/<ticket>-<runid>` branch, opens a PR. Workers NEVER merge —
 *      the workflow has no merge step; humans own the merge gate.
 *   3. This adapter polls the run to completion and reports the outcome
 *      (+ PR URL when the workflow surfaced one).
 *   4. Teardown = the runner is ephemeral and GITHUB_TOKEN auto-revokes at
 *      job end. Nothing persists but the branch + PR (both reversible:
 *      close PR, delete branch).
 *
 * Auth: same-repo dogfood uses the workflow's GITHUB_TOKEN. Cross-repo
 * uses a custom GitHub App (github-app-auth.ts) whose credentials live in
 * repo/org secrets (ORG_WORKER_APP_ID / ORG_WORKER_APP_PRIVATE_KEY /
 * ORG_WORKER_APP_INSTALLATION_ID) — read inside the workflow, never here.
 */
import type { EngineRunOpts, WorkerRunResult } from './engine-codex';
import { runCodexEngine } from './engine-codex';
import { redactTokens, type FetchLike } from './github-app-auth';
import { execFileSync } from 'child_process';
import { randomBytes } from 'crypto';
import { unlinkSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

export interface ProvisionJobSpec {
  /** Target repo, "owner/name". */
  repo: string;
  ticketNumber: number;
  title: string;
  brief: string;
  engine?: 'codex' | 'openai-compat';
  model: string;
  baseUrl?: string;
  apiKeyEnv?: string;
  timeoutMs: number;
  verificationCommands?: string[];
  /** Engine opts threaded for local modes (sandbox/argv from HostProfile). */
  engineOpts?: Partial<EngineRunOpts>;
  /** Local checkout path (local modes only). */
  localRepoPath?: string;
  /** Plan jobs inspect the checkout and return structured messages without
   *  creating a branch, commit, push, or PR. */
  jobKind?: 'code' | 'plan';
  /** Smoke mode: the workflow proves provision→branch→PR→teardown without
   *  invoking a real engine (no engine secrets needed on the runner). */
  smoke?: boolean;
}

export interface ProvisionResult {
  ok: boolean;
  mode: string;
  detail: string;
  /** PR URL when the adapter opened one (gh-actions lane). */
  prUrl?: string;
  usage?: {
    inputTokens: number | null;
    cachedInputTokens: number | null;
    outputTokens: number | null;
    reasoningOutputTokens: number | null;
  } | null;
  /** Agent messages returned in the workflow artifact (planner output lives here). */
  messages?: string[];
  /** Engine result when the job ran in-process (local modes). */
  engineResult?: WorkerRunResult;
}

export interface ProvisioningAdapter {
  mode: 'local-process' | 'local-container' | 'gh-actions' | 'vm';
  provision(spec: ProvisionJobSpec): Promise<ProvisionResult>;
}

// ---------------------------------------------------------------------------
// local-process — wraps the W-2 path unchanged
// ---------------------------------------------------------------------------

export class LocalProcessAdapter implements ProvisioningAdapter {
  mode = 'local-process' as const;
  constructor(private runEngine: (o: EngineRunOpts) => Promise<WorkerRunResult> = runCodexEngine) {}

  async provision(spec: ProvisionJobSpec): Promise<ProvisionResult> {
    if (!spec.localRepoPath) {
      return { ok: false, mode: this.mode, detail: 'localRepoPath required for local-process mode' };
    }
    const res = await this.runEngine({
      cwd: spec.localRepoPath,
      brief: spec.brief,
      model: spec.model,
      timeoutMs: spec.timeoutMs,
      ...(spec.engineOpts || {}),
    });
    return {
      ok: res.ok,
      mode: this.mode,
      detail: `engine exit ${res.exitCode}, ${Math.round(res.durationMs / 1000)}s`,
      engineResult: res,
    };
  }
}

// ---------------------------------------------------------------------------
// gh-actions — ephemeral runner via workflow_dispatch
// ---------------------------------------------------------------------------

export interface GhActionsAdapterOpts {
  /** Repo hosting worker-job.yml (usually the org-studio repo itself). */
  workflowRepo: string;
  workflowFile?: string; // default worker-job.yml
  /** Token with `actions:write` on workflowRepo (fires the dispatch + polls). */
  token: string;
  fetchImpl?: FetchLike;
  /** Poll interval ms (default 15s) and max polls (default 80 ≈ 20min). */
  pollIntervalMs?: number;
  maxPolls?: number;
  sleep?: (ms: number) => Promise<void>;
  extractZipEntry?: (zipBuf: Buffer, entry: string) => string;
}

const GH_API = 'https://api.github.com';

function defaultExtractZipEntry(zipBuf: Buffer, entry: string): string {
  const tmpPath = join(tmpdir(), `worker-result-${randomBytes(8).toString('hex')}.zip`);
  try {
    writeFileSync(tmpPath, zipBuf);
    return execFileSync('unzip', ['-p', tmpPath, entry], { encoding: 'utf8' });
  } finally {
    try {
      unlinkSync(tmpPath);
    } catch {
      // best effort temp cleanup
    }
  }
}

export class GhActionsAdapter implements ProvisioningAdapter {
  mode = 'gh-actions' as const;
  private o: Required<
    Pick<GhActionsAdapterOpts, 'workflowFile' | 'pollIntervalMs' | 'maxPolls' | 'extractZipEntry'>
  > &
    GhActionsAdapterOpts;

  constructor(opts: GhActionsAdapterOpts) {
    this.o = {
      workflowFile: 'worker-job.yml',
      pollIntervalMs: 15_000,
      maxPolls: 80,
      extractZipEntry: defaultExtractZipEntry,
      ...opts,
    };
  }

  private get f(): FetchLike {
    return this.o.fetchImpl || (fetch as any);
  }

  private headers() {
    return {
      Authorization: `Bearer ${this.o.token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'Content-Type': 'application/json',
    };
  }

  async provision(spec: ProvisionJobSpec): Promise<ProvisionResult> {
    const sleep = this.o.sleep || ((ms: number) => new Promise((r) => setTimeout(r, ms)));
    // Correlate the dispatch to its run: workflow_dispatch returns 204 with
    // no run id, so we stamp a unique marker input and find the run by it.
    const marker = `wrk-${spec.ticketNumber}-${Date.now().toString(36)}`;

    const dispatchRes = await this.f(
      `${GH_API}/repos/${this.o.workflowRepo}/actions/workflows/${this.o.workflowFile}/dispatches`,
      {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify({
          ref: 'main',
          inputs: {
            target_repo: spec.repo,
            ticket: String(spec.ticketNumber),
            title: spec.title.slice(0, 120),
            brief: spec.brief.slice(0, 60_000), // workflow_dispatch input cap safety
            engine: spec.engine || 'codex',
            model: spec.model,
            base_url: spec.baseUrl || '',
            api_key_env: spec.apiKeyEnv || '',
            verification_commands: JSON.stringify(spec.verificationCommands || []),
            marker,
            job_kind: spec.jobKind || 'code',
            smoke: spec.smoke ? 'true' : 'false',
          },
        }),
      },
    );
    if (!(dispatchRes.status === 204 || dispatchRes.ok)) {
      return {
        ok: false,
        mode: this.mode,
        detail: redactTokens(`workflow_dispatch failed: HTTP ${dispatchRes.status}`),
      };
    }

    // Find the run carrying our marker (run name includes it — see workflow).
    let runId: number | null = null;
    let runUrl = '';
    for (let i = 0; i < 20 && runId === null; i++) {
      await sleep(3000);
      const list = await this.f(
        `${GH_API}/repos/${this.o.workflowRepo}/actions/workflows/${this.o.workflowFile}/runs?event=workflow_dispatch&per_page=10`,
        { headers: this.headers() },
      );
      if (!list.ok) continue;
      const data = await list.json();
      const hit = (data.workflow_runs || []).find((r: any) => (r.name || '').includes(marker));
      if (hit) {
        runId = hit.id;
        runUrl = hit.html_url || '';
      }
    }
    if (runId === null) {
      return { ok: false, mode: this.mode, detail: 'dispatched but run not found by marker (20 lookups)' };
    }

    // Poll to completion.
    for (let i = 0; i < this.o.maxPolls; i++) {
      await sleep(this.o.pollIntervalMs);
      const runRes = await this.f(`${GH_API}/repos/${this.o.workflowRepo}/actions/runs/${runId}`, {
        headers: this.headers(),
      });
      if (!runRes.ok) continue;
      const run = await runRes.json();
      if (run.status === 'completed') {
        const ok = run.conclusion === 'success';
        const out: ProvisionResult = {
          ok,
          mode: this.mode,
          detail: `run ${run.conclusion} — ${runUrl}`,
        };

        try {
          const artifactsRes = await this.f(
            `${GH_API}/repos/${this.o.workflowRepo}/actions/runs/${runId}/artifacts`,
            { headers: this.headers() },
          );
          if (!artifactsRes.ok) {
            throw new Error(`artifacts list HTTP ${artifactsRes.status}`);
          }
          const artifactsData = await artifactsRes.json();
          const artifact = (Array.isArray(artifactsData?.artifacts) ? artifactsData.artifacts : []).find(
            (a: any) => a?.name === 'worker-result' && typeof a.archive_download_url === 'string',
          );

          if (artifact?.archive_download_url) {
            const downloadRes = await this.f(artifact.archive_download_url, {
              headers: this.headers(),
            });
            if (!downloadRes.ok) {
              throw new Error(`artifact download HTTP ${downloadRes.status}`);
            }
            const zipBuf = Buffer.from(await (downloadRes as any).arrayBuffer());
            const resultJson = this.o.extractZipEntry(zipBuf, 'result.json');
            const parsed = JSON.parse(resultJson);

            if (typeof parsed?.pr_url === 'string' && parsed.pr_url) {
              out.prUrl = parsed.pr_url;
            }
            if (
              Array.isArray(parsed?.messages) &&
              parsed.messages.every((message: unknown) => typeof message === 'string')
            ) {
              out.messages = parsed.messages;
            }
            if (typeof parsed?.engine_exit === 'number' && parsed.engine_exit !== 0) {
              out.ok = false;
              out.detail = `engine exit ${parsed.engine_exit} — ${runUrl}`;
            }

            if (parsed?.usage === null) {
              out.usage = null;
            } else if (parsed?.usage && typeof parsed.usage === 'object') {
              const u = parsed.usage;
              out.usage = {
                inputTokens: typeof u.input_tokens === 'number' ? u.input_tokens : null,
                cachedInputTokens:
                  typeof u.cached_input_tokens === 'number' ? u.cached_input_tokens : null,
                outputTokens: typeof u.output_tokens === 'number' ? u.output_tokens : null,
                reasoningOutputTokens:
                  typeof u.reasoning_output_tokens === 'number' ? u.reasoning_output_tokens : null,
              };
            }
          }
        } catch (e: any) {
          console.warn('[worker-provision] artifact parse failed:', redactTokens(String(e?.message || e)));
        }

        return out;
      }
    }
    return { ok: false, mode: this.mode, detail: `run ${runId} did not complete within poll budget — ${runUrl}` };
  }
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

export function adapterForMode(
  mode: string,
  ghOpts?: GhActionsAdapterOpts,
): ProvisioningAdapter | null {
  switch (mode) {
    case 'local-process':
      return new LocalProcessAdapter();
    case 'gh-actions':
      if (!ghOpts) return null;
      return new GhActionsAdapter(ghOpts);
    // local-container / vm: future rungs of the ladder.
    default:
      return null;
  }
}
