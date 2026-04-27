/**
 * /projects/[id] — operations dashboard (default view).
 *
 * The default project page is now the operations console. It answers the
 * everyday questions: which version is current, what's left to ship it,
 * who owns each component, what's next. See:
 *   src/components/dashboard/ProjectDashboardPage.tsx
 *
 * The editorial Studio Ledger view is one click away at
 *   /projects/[id]/ledger
 * (route file: src/app/(dashboard)/projects/[id]/ledger/page.tsx).
 */

export { default } from '@/components/dashboard/ProjectDashboardPage';
