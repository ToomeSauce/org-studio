/**
 * /projects/[id] — Studio Ledger project page.
 *
 * The legacy dashboard project page was retired during the Studio Ledger
 * cutover. This file is now a thin re-export of the ledger page so that
 * Next.js still finds a route component here.
 *
 * If you're hunting for project-page rendering, see:
 *   src/components/ledger/LedgerProjectPage.tsx
 */

export { default } from '@/components/ledger/LedgerProjectPage';
