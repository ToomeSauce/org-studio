/**
 * #1353 slice 3 — Runtime metadata consistency audit
 *
 * Compares what each runtime DECLARES about its agents (via
 * AgentRuntime.getAgentMetadata) against what the teammate store
 * RECORDS for the same agent. Surfaces three kinds of disagreement:
 *
 *   1. 'mismatch'  — teammate.model is set AND runtime.model is set
 *                    AND they differ. The interesting case.
 *   2. 'missing'   — runtime.model is set but teammate.model is not.
 *                    User hasn't declared an expected model yet —
 *                    audit suggests adopting the runtime value.
 *   3. 'unbound'   — teammate.model is set but runtime returns
 *                    undefined (runtime down, agent not yet bound to
 *                    a session, etc.). Cannot verify.
 *
 * NOTE: Per doneWhen #6 + constraints, the audit is ADVISORY:
 *   - Logs structured warnings on detection.
 *   - Exposes via /api/runtimes for UI surfacing (doneWhen #7).
 *   - NEVER auto-writes teammate records. Apply happens via explicit
 *     user action in Settings UI (slice 4).
 *
 * Best-effort, non-blocking (constraint): the audit runs after
 * discoverAll() completes; if any getAgentMetadata() call throws (it
 * shouldn't — the AgentRuntime contract says best-effort/never-throws
 * — but defense-in-depth), that agent is skipped and we continue.
 */

import type { RuntimeAgent, AgentRuntime } from './types';

export interface RuntimeMetadataMismatch {
  agentId: string;
  runtimeId: string;
  kind: 'mismatch' | 'missing' | 'unbound';
  /** What the runtime says the model is (undefined for 'unbound'). */
  runtimeModel?: string;
  /** What the teammate record says (undefined for 'missing'). */
  teammateModel?: string;
  /** Human-readable summary for logging + UI. */
  message: string;
}

/**
 * Audit input: the agents discovered by registry.discoverAll(), the
 * runtimes that produced them (so we can ask each one for canonical
 * metadata), and the teammates slice of the store.
 *
 * We split runtime lookup out as an injectable resolver so this is
 * easily unit-tested without instantiating real runtimes.
 */
export interface RuntimeAuditInput {
  agents: RuntimeAgent[];
  /** runtimeId → AgentRuntime instance, used to call getAgentMetadata. */
  runtimes: Map<string, AgentRuntime>;
  /** Teammate records keyed by agentId (case-insensitive normalization
   *  is the caller's job; we compare strings as-given). */
  teammates: Array<{ agentId?: string; model?: string; [k: string]: any }>;
}

/**
 * Normalize model strings before comparison. Same string formatting
 * decisions as resolveAgentModel + HermesRuntime: provider/model for
 * 'real' providers, bare model for custom: providers. We normalize
 * here so a teammate declaring 'claude-opus-4.7' and a runtime
 * reporting 'github-copilot/claude-opus-4.7' don't false-positive.
 *
 * Strategy: strip the leading 'provider/' segment if present. Two
 * strings match iff their stripped tails are equal.
 */
export function normalizeModelForComparison(model?: string): string | undefined {
  if (!model) return undefined;
  const slash = model.indexOf('/');
  if (slash === -1) return model.trim();
  // 'github-copilot/claude-opus-4.7' → 'claude-opus-4.7'
  // 'custom:burner/gpt-5.5' → 'gpt-5.5'
  return model.slice(slash + 1).trim();
}

/**
 * Compare two model stamps for audit equality. Returns true if they
 * refer to the same underlying model, regardless of provider prefix.
 */
export function modelsMatch(a?: string, b?: string): boolean {
  if (!a || !b) return false;
  const na = normalizeModelForComparison(a);
  const nb = normalizeModelForComparison(b);
  return !!na && !!nb && na === nb;
}

/**
 * Run the audit. Returns a list of disagreements; empty list means
 * everything is consistent.
 *
 * Implementation notes:
 *  - We iterate over agents (not teammates) so the audit only
 *    surfaces things a runtime ACTUALLY produced. Teammates with
 *    no live runtime backing are silent here.
 *  - We do NOT block on slow runtime calls: each getAgentMetadata
 *    has its own ~1s budget internally. Total time is bounded by
 *    (agent count) × (1s) in the worst case; in practice all calls
 *    are sequential but small. If perf becomes an issue we can
 *    Promise.all later.
 */
export async function auditRuntimeMetadata(
  input: RuntimeAuditInput,
): Promise<RuntimeMetadataMismatch[]> {
  const mismatches: RuntimeMetadataMismatch[] = [];

  // Build teammate lookup once.
  const teammateByAgentId = new Map<string, { model?: string }>();
  for (const tm of input.teammates) {
    if (!tm.agentId) continue;
    teammateByAgentId.set(tm.agentId, tm);
  }

  for (const agent of input.agents) {
    const runtime = input.runtimes.get(agent.runtime);
    if (!runtime) continue; // shouldn't happen, but defensive
    let runtimeMeta;
    try {
      runtimeMeta = await runtime.getAgentMetadata(agent.id);
    } catch {
      continue; // contract says never throw; if it does, skip this agent
    }
    const teammate = teammateByAgentId.get(agent.id);
    const teammateModel = teammate?.model;
    const runtimeModel = runtimeMeta?.model;

    if (runtimeModel && teammateModel) {
      if (!modelsMatch(runtimeModel, teammateModel)) {
        mismatches.push({
          agentId: agent.id,
          runtimeId: agent.runtime,
          kind: 'mismatch',
          runtimeModel,
          teammateModel,
          message: `Agent '${agent.id}' (${agent.runtime}): teammate record says '${teammateModel}' but runtime reports '${runtimeModel}'`,
        });
      }
    } else if (runtimeModel && !teammateModel) {
      mismatches.push({
        agentId: agent.id,
        runtimeId: agent.runtime,
        kind: 'missing',
        runtimeModel,
        message: `Agent '${agent.id}' (${agent.runtime}): runtime reports '${runtimeModel}' but teammate record has no model field`,
      });
    } else if (!runtimeModel && teammateModel) {
      mismatches.push({
        agentId: agent.id,
        runtimeId: agent.runtime,
        kind: 'unbound',
        teammateModel,
        message: `Agent '${agent.id}' (${agent.runtime}): teammate record says '${teammateModel}' but runtime returned no model (down or unbound)`,
      });
    }
    // Both undefined: silent. Nothing to compare.
  }

  return mismatches;
}

/**
 * Log mismatches as structured warnings. Called by /api/runtimes after
 * the audit so operators see the discrepancy in journalctl even if no
 * one opens Settings. Format is grep-friendly: each line is one warn.
 */
export function logMismatches(mismatches: RuntimeMetadataMismatch[]): void {
  if (mismatches.length === 0) return;
  console.warn(
    `[Runtimes #1353] Found ${mismatches.length} agent-metadata disagreement(s):`,
  );
  for (const m of mismatches) {
    console.warn(
      `[Runtimes #1353]   ${m.kind.toUpperCase()} ${m.agentId} (${m.runtimeId}): teammate=${m.teammateModel ?? '∅'} runtime=${m.runtimeModel ?? '∅'}`,
    );
  }
}
