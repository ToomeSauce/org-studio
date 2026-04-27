/**
 * /projects/[id]/ledger — editorial Studio Ledger read-view.
 *
 * The Studio Ledger aesthetic is lovely for reading a project end-to-end
 * (vision \u2192 components \u2192 every shipped version) but bad for the
 * everyday "is v0.16.2 done yet" check. The default `/projects/[id]` route
 * now renders the operations dashboard (see ProjectDashboardPage); this
 * sub-route preserves the editorial view as a tab one click away.
 */

export { default } from '@/components/ledger/LedgerProjectPage';
