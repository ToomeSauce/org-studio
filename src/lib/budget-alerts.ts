/**
 * Budget threshold alerts (#1653, Phase A-2) — alert-once per project per
 * calendar month per state (warn at alertPct%, exceeded at 100%).
 *
 * IO module (provider write + Telegram send). Pure decision logic lives in
 * budget-gate.ts (budgetAlertState / shouldSendBudgetAlert) so it's testable
 * without mocks. Called fire-and-forget from the scheduler trigger path —
 * failures log and never break dispatch.
 *
 * Human delivery: direct Telegram sendMessage to NOTIFY_CHAT_ID — the same
 * human-delivery path the Domain Steward summary uses (rpc 'chat.send'
 * routes to an agent session, not a human chat).
 */
import {
  budgetAlertState,
  currentMonthKey,
  shouldSendBudgetAlert,
  type BudgetAlertsMarker,
  type ProjectSpendSnapshot,
} from '@/lib/budget-gate';
import { getStoreProvider } from '@/lib/store-provider';
import { DEFAULT_WORKSPACE_ID } from '@/lib/workspace-auth';

interface AlertableProject {
  id: string;
  name?: string;
  budget?: { ceilingUsdMonth?: number; alertPct?: number };
  budgetAlerts?: BudgetAlertsMarker;
}

function pace(spend: number, now: Date = new Date()): number {
  const dayOfMonth = now.getUTCDate();
  const daysInMonth = new Date(now.getUTCFullYear(), now.getUTCMonth() + 1, 0).getDate();
  if (dayOfMonth <= 0) return spend;
  return (spend / dayOfMonth) * daysInMonth;
}

async function sendHuman(text: string): Promise<boolean> {
  const TG_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
  const TG_CHAT = process.env.TELEGRAM_CHAT_ID || process.env.NOTIFY_CHAT_ID || '';
  if (!TG_TOKEN || !TG_CHAT) {
    console.info('[budget-alerts] no Telegram human channel configured; alert logged only:', text);
    return false;
  }
  try {
    await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: TG_CHAT, text, parse_mode: 'Markdown' }),
    });
    return true;
  } catch (e: any) {
    console.warn('[budget-alerts] Telegram send failed:', e?.message || e);
    return false;
  }
}

/**
 * Check every budgeted project against the snapshot and send at most one
 * warn + one exceeded notification per project per month. Persists the dedup
 * marker via provider.updateProject (data overflow field `budgetAlerts`).
 */
export async function checkBudgetAlerts(
  projects: AlertableProject[],
  snapshot: ProjectSpendSnapshot | null,
): Promise<void> {
  if (!snapshot) return; // fail-open: no data, no alerts
  const monthKey = currentMonthKey();
  for (const project of projects || []) {
    try {
      const state = budgetAlertState(project as any, snapshot);
      if (state === 'none') continue;
      if (!shouldSendBudgetAlert(project.budgetAlerts, state, monthKey)) continue;

      const spend = snapshot[project.id] ?? 0;
      const ceiling = project.budget?.ceilingUsdMonth ?? 0;
      const projected = pace(spend);
      const name = project.name || project.id;
      const text =
        state === 'exceeded'
          ? `🛑 *Budget exceeded — ${name}*\nMetered spend $${spend.toFixed(2)} ≥ ceiling $${ceiling.toFixed(2)} this month. New dispatch is on hold until the ceiling is raised or the month rolls over. (Unmetered burn not included — see /usage.)`
          : `⚠️ *Budget warning — ${name}*\nMetered spend $${spend.toFixed(2)} of $${ceiling.toFixed(2)} (${Math.round((spend / ceiling) * 100)}%). Pace projects ~$${projected.toFixed(2)} by month end.`;

      await sendHuman(text);

      // M-1 (#1662): additive emission via the messaging registry — no-op
      // until adapters register (M-2+). Budget alerts are exactly the class
      // of outbound the native layer exists for.
      try {
        const { getMessagingRegistry } = await import('./messaging/registry');
        getMessagingRegistry()
          .notify({
            kind: 'budget-alert',
            title: state === 'exceeded' ? `Budget exceeded — ${name}` : `Budget warning — ${name}`,
            body: text,
            projectId: project.id,
            actions: [
              { label: '⏸️ Pause loop', command: `pause ${project.id}` },
              { label: '📊 Status', command: `status ${project.id}` },
            ],
          })
          .catch(() => {});
      } catch {
        /* messaging must never break the alert path */
      }

      const marker: BudgetAlertsMarker = { ...(project.budgetAlerts || {}) };
      const month = { ...(marker[monthKey] || {}) };
      if (state === 'exceeded') month.exceededAt = Date.now();
      else month.warnedAt = Date.now();
      marker[monthKey] = month;
      const provider = getStoreProvider(DEFAULT_WORKSPACE_ID);
      await provider.updateProject(project.id, { budgetAlerts: marker });
    } catch (e: any) {
      console.warn(`[budget-alerts] check failed for project ${project?.id}:`, e?.message || e);
    }
  }
}
