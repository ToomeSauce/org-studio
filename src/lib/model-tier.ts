/**
 * #1689 — modelTier tagging substrate.
 *
 * Optional per-task complexity tag: 'trivial' | 'standard' | 'complex'.
 * Persisted via the `data` JSONB overflow (NOT a typed column — see
 * src/lib/postgres-column-map.ts; anything not in TASK_COLUMNS falls into
 * the overflow automatically). Same no-migration pattern as
 * blockedReasonType (#1588).
 *
 * IMPORTANT: nothing consumes this field yet. Dispatch behavior is
 * unchanged whether the field is absent, present, or cleared. P-4 will
 * add the consumer (model routing). Keep this file dumb: constants +
 * validation only, no I/O, no dispatch logic.
 */

export type ModelTier = 'trivial' | 'standard' | 'complex';

export const MODEL_TIERS: ModelTier[] = ['trivial', 'standard', 'complex'];

export interface ModelTierValidationResult {
  ok: boolean;
  /** Normalized value to persist: a valid tier, or null to clear. */
  value?: ModelTier | null;
  /** Human-readable error when ok=false. Suitable for a 400 body. */
  error?: string;
}

/**
 * Validate an incoming `modelTier` value from addTask/updateTask payloads.
 *
 * - `undefined` → ok, no value (caller should not write the field)
 * - `null` / `''` → ok, value=null (explicit clear on updateTask)
 * - valid tier string → ok, value=tier
 * - anything else → not ok, with a helpful error message
 */
export function validateModelTier(raw: unknown): ModelTierValidationResult {
  if (raw === undefined) return { ok: true };
  if (raw === null || raw === '') return { ok: true, value: null };
  if (typeof raw === 'string' && (MODEL_TIERS as string[]).includes(raw)) {
    return { ok: true, value: raw as ModelTier };
  }
  return {
    ok: false,
    error: `Invalid modelTier '${String(raw)}'. Allowed: ${MODEL_TIERS.join(', ')} (or null to clear).`,
  };
}
