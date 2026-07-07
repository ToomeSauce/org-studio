export type ProjectBudget = {
  ceilingUsdMonth?: number;
  ceilingUsdVersion?: number;
  alertPct?: number;
};

export type ProjectBoundaries = {
  freeToDecide: string[];
  mustAsk: string[];
};

export type BudgetValidationResult =
  | { ok: true; value: ProjectBudget }
  | { ok: false; error: string };

export type BoundariesValidationResult =
  | { ok: true; value: ProjectBoundaries }
  | { ok: false; error: string };

const BUDGET_KEYS = ['ceilingUsdMonth', 'ceilingUsdVersion', 'alertPct'] as const;
const BUDGET_KEY_SET = new Set<string>(BUDGET_KEYS);

export const DEFAULT_BOUNDARIES: ProjectBoundaries = {
  freeToDecide: [
    'Any reversible decision (git revert + redeploy undoes it)',
    'Tech stack & architecture',
    'Copy, design, experiment details',
  ],
  mustAsk: [
    'Spending real money beyond budget line',
    'Anything user-visible going public',
    'Irreversible ops: data deletion, legal, external outreach',
  ],
};

function isPositiveFiniteNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v) && v > 0;
}

export function validateBudget(
  input: any,
  opts?: { allowUnknownKeys?: boolean },
): BudgetValidationResult {
  if (input == null || typeof input !== 'object' || Array.isArray(input)) {
    return { ok: false, error: 'budget must be an object' };
  }

  const unknownKeys = Object.keys(input).filter((k) => !BUDGET_KEY_SET.has(k));
  if (!opts?.allowUnknownKeys && unknownKeys.length > 0) {
    return {
      ok: false,
      error: `budget has unknown key(s): ${unknownKeys.join(', ')}. Allowed keys: ${BUDGET_KEYS.join(', ')}`,
    };
  }

  const month = input.ceilingUsdMonth;
  if (month != null && !isPositiveFiniteNumber(month)) {
    return { ok: false, error: 'budget.ceilingUsdMonth must be a positive finite number' };
  }

  const version = input.ceilingUsdVersion;
  if (version != null && !isPositiveFiniteNumber(version)) {
    return { ok: false, error: 'budget.ceilingUsdVersion must be a positive finite number' };
  }

  const rawAlert = input.alertPct;
  const alertPct = rawAlert == null ? 80 : rawAlert;
  if (!Number.isInteger(alertPct) || alertPct < 1 || alertPct > 99) {
    return { ok: false, error: 'budget.alertPct must be an integer between 1 and 99' };
  }

  const value: ProjectBudget = {
    alertPct,
    ...(month != null ? { ceilingUsdMonth: month } : {}),
    ...(version != null ? { ceilingUsdVersion: version } : {}),
  };

  return { ok: true, value };
}

function validateNonEmptyStringArray(value: any, fieldName: string): { ok: true; value: string[] } | { ok: false; error: string } {
  if (!Array.isArray(value)) {
    return { ok: false, error: `${fieldName} must be an array of non-empty strings` };
  }

  const normalized: string[] = [];
  for (const [idx, entry] of value.entries()) {
    if (typeof entry !== 'string' || entry.trim().length === 0) {
      return { ok: false, error: `${fieldName}[${idx}] must be a non-empty string` };
    }
    normalized.push(entry.trim());
  }

  return { ok: true, value: normalized };
}

export function validateBoundaries(input: any): BoundariesValidationResult {
  if (input == null || typeof input !== 'object' || Array.isArray(input)) {
    return { ok: false, error: 'boundaries must be an object' };
  }

  const freeToDecide = validateNonEmptyStringArray(input.freeToDecide, 'boundaries.freeToDecide');
  if (!freeToDecide.ok) return freeToDecide;

  const mustAsk = validateNonEmptyStringArray(input.mustAsk, 'boundaries.mustAsk');
  if (!mustAsk.ok) return mustAsk;

  return {
    ok: true,
    value: {
      freeToDecide: freeToDecide.value,
      mustAsk: mustAsk.value,
    },
  };
}
