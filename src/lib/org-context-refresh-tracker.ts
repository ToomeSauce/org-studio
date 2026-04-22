// In-memory tracker for the last ORG.md refresh per agent.
// Populated by /api/org-context on every generation; read by
// /api/org-context/refreshes (and any UI that wants to show freshness).

export interface OrgRefreshRecord {
  sha: string;
  generatedAt: string;
  sections: number;
}

const GENERIC_KEY = '__generic__';

// Module-scoped map survives HMR in dev and warm starts in prod.
const refreshes = new Map<string, OrgRefreshRecord>();

export function recordOrgRefresh(agentId: string | null | undefined, record: OrgRefreshRecord): void {
  const key = agentId && agentId.length ? agentId : GENERIC_KEY;
  refreshes.set(key, record);
}

export function getOrgRefresh(agentId: string): OrgRefreshRecord | null {
  const key = agentId && agentId.length ? agentId : GENERIC_KEY;
  return refreshes.get(key) ?? null;
}

export function getOrgRefreshes(): Record<string, OrgRefreshRecord> {
  const out: Record<string, OrgRefreshRecord> = {};
  for (const [key, value] of refreshes.entries()) {
    out[key] = value;
  }
  return out;
}

export { GENERIC_KEY as GENERIC_ORG_AGENT_KEY };
