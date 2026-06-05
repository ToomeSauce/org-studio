import { describe, test, expect } from 'vitest';
import {
  filterByWorkspace,
  belongsToWorkspace,
  stampWorkspace,
  DEFAULT_WORKSPACE_ID,
} from '@/lib/workspace-auth';

/**
 * #1622 (F-13) regression guard for the workspace-isolation filter helpers.
 *
 * These tests lock in the CURRENT, deliberate behavior:
 *  - a record with an explicit workspace_id is matched/isolated correctly;
 *  - a record with NO workspace_id coalesces to DEFAULT_WORKSPACE_ID (the
 *    documented legacy backward-compat path, and the F-13 leak surface).
 *
 * The authoritative fix for F-13 is the DB-level NOT NULL constraint on
 * workspace_id (scripts/migrate-workspace-id-phase3-notnull.mjs, applied
 * post-sign-off). After backfill there are 0 NULL rows, so the coalesce branch
 * is provably dead in practice; these tests document that the coalesce must NOT
 * be tightened to treat NULL as a non-match until NOT NULL is enforced
 * everywhere (un-migrated single-workspace instances still rely on it).
 */
describe('#1622 / F-13 — workspace isolation filters', () => {
  const WS_A = 'workspace-a';
  const WS_B = 'workspace-b';

  describe('filterByWorkspace', () => {
    test('keeps only records matching the workspace', () => {
      const rows = [
        { id: 1, workspace_id: WS_A },
        { id: 2, workspace_id: WS_B },
        { id: 3, workspace_id: WS_A },
      ];
      expect(filterByWorkspace(rows, WS_A).map((r) => r.id)).toEqual([1, 3]);
      expect(filterByWorkspace(rows, WS_B).map((r) => r.id)).toEqual([2]);
    });

    test('does NOT leak another workspace’s rows into a non-default workspace', () => {
      const rows = [
        { id: 1, workspace_id: WS_A },
        { id: 2, workspace_id: WS_B },
      ];
      // A request scoped to WS_A must never see WS_B's row.
      expect(filterByWorkspace(rows, WS_A)).toHaveLength(1);
      expect(filterByWorkspace(rows, WS_A)[0].id).toBe(1);
    });

    test('legacy: a row with no workspace_id is treated as default-workspace (documented F-13 behavior)', () => {
      const rows = [
        { id: 1 }, // unstamped legacy row
        { id: 2, workspace_id: WS_A },
      ];
      // Visible to the DEFAULT workspace...
      expect(filterByWorkspace(rows, DEFAULT_WORKSPACE_ID).map((r) => r.id)).toEqual([1]);
      // ...but NOT to any other workspace.
      expect(filterByWorkspace(rows, WS_A).map((r) => r.id)).toEqual([2]);
    });

    test('an unstamped row never appears in a non-default workspace', () => {
      const rows = [{ id: 1, workspace_id: null }, { id: 2, workspace_id: undefined }];
      expect(filterByWorkspace(rows, WS_A)).toHaveLength(0);
    });
  });

  describe('belongsToWorkspace', () => {
    test('true only for the owning workspace', () => {
      expect(belongsToWorkspace({ workspace_id: WS_A }, WS_A)).toBe(true);
      expect(belongsToWorkspace({ workspace_id: WS_A }, WS_B)).toBe(false);
    });

    test('unstamped record belongs to default-workspace only', () => {
      expect(belongsToWorkspace({}, DEFAULT_WORKSPACE_ID)).toBe(true);
      expect(belongsToWorkspace({}, WS_A)).toBe(false);
      expect(belongsToWorkspace({ workspace_id: null }, WS_A)).toBe(false);
    });
  });

  describe('stampWorkspace', () => {
    test('stamps an unstamped record with the request workspace', () => {
      expect(stampWorkspace({ id: 1 }, WS_A)).toEqual({ id: 1, workspace_id: WS_A });
    });

    test('no-ops when the record already matches the workspace', () => {
      expect(stampWorkspace({ id: 1, workspace_id: WS_A }, WS_A)).toEqual({
        id: 1,
        workspace_id: WS_A,
      });
    });

    test('rejects a cross-workspace write (record stamped for a different workspace)', () => {
      expect(() => stampWorkspace({ id: 1, workspace_id: WS_B }, WS_A)).toThrow(
        /Cross-workspace write rejected/,
      );
    });
  });
});
