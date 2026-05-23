/**
 * #1535 — invariant test: no direct `UPDATE org_studio_tasks SET status`
 * outside the allowlisted promote-transaction site.
 *
 * Plus unit coverage on buildStatusTransition() itself.
 *
 * # Why this exists
 *
 * #1531 root-caused as one hand-rolled SQL UPDATE that mutated typed
 * `status` without appending to `status_history`. The fix consolidates
 * every status writer through `buildStatusTransition()` so the
 * bookkeeping shape lives in exactly one file.
 *
 * This test FAILS the build if anyone adds a new raw-SQL status writer
 * without the `STATUS_TRANSITION_ALLOWED` sentinel nearby. That sentinel
 * is the explicit "I know what I'm doing" opt-in for the rare cases
 * (transactional writes) that can't go through `provider.updateTask`.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'fs';
import { join } from 'path';

import { buildStatusTransition } from '../lib/task-status';

const SRC_ROOT = join(__dirname, '..');

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === '__tests__' || entry === 'dist' || entry === '.next') continue;
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) walk(full, out);
    else if (
      st.isFile() &&
      (full.endsWith('.ts') || full.endsWith('.tsx') || full.endsWith('.mjs') || full.endsWith('.js')) &&
      !full.endsWith('.d.ts') &&
      !full.endsWith('.test.ts')
    )
      out.push(full);
  }
  return out;
}

describe('#1535 — status-transition invariant', () => {
  it('no raw-SQL status writer exists in src/** without STATUS_TRANSITION_ALLOWED', () => {
    const offenders: Array<{ file: string; snippet: string }> = [];

    for (const file of walk(SRC_ROOT)) {
      const text = readFileSync(file, 'utf8');
      // Look for UPDATE org_studio_tasks blocks that touch a `status =`
      // assignment in the SET clause. Multi-line: SQL is often spread
      // across several lines in tagged-template form.
      const updateRegex = /UPDATE\s+org_studio_tasks[\s\S]{0,800}?SET[\s\S]{0,400}?\bstatus\s*=/gi;
      let match: RegExpExecArray | null;
      while ((match = updateRegex.exec(text)) !== null) {
        // Allowlist: STATUS_TRANSITION_ALLOWED tag must appear within
        // the 600 chars BEFORE the match (in the comment that documents
        // why the raw SQL is okay).
        const beforeStart = Math.max(0, match.index - 600);
        const window = text.slice(beforeStart, match.index);
        if (window.includes('STATUS_TRANSITION_ALLOWED')) continue;

        // task-status.ts itself only documents the sentinel — no SQL.
        if (file.endsWith('task-status.ts')) continue;

        const snippet = text.slice(match.index, Math.min(text.length, match.index + 200));
        offenders.push({ file: file.replace(SRC_ROOT + '/', ''), snippet });
      }
    }

    if (offenders.length > 0) {
      const detail = offenders
        .map((o) => `  - ${o.file}\n      ${o.snippet.replace(/\s+/g, ' ').slice(0, 140)}…`)
        .join('\n');
      throw new Error(
        `${offenders.length} raw-SQL status writer(s) found without STATUS_TRANSITION_ALLOWED sentinel:\n${detail}\n\n` +
          `Either route the write through provider.updateTask (which goes through buildStatusTransition),\n` +
          `or, if you're inside a transaction that can't use the provider, build the patch via\n` +
          `buildStatusTransition() and tag your raw SQL with a comment containing STATUS_TRANSITION_ALLOWED.`,
      );
    }
  });
});

describe('#1535 — buildStatusTransition()', () => {
  const baseTask = {
    id: 't1',
    status: 'backlog',
    statusHistory: [{ status: 'backlog', timestamp: 1000, by: 'Mikey' }],
    assignee: 'Mikey',
  };

  it('returns changed=false and empty updates on no-op transition', () => {
    const r = buildStatusTransition({
      task: baseTask,
      newStatus: 'backlog',
      by: 'Mikey',
      now: 2000,
    });
    expect(r.changed).toBe(false);
    expect(r.updates).toEqual({});
    expect(r.sideEffects).toEqual({ notify: false, checkVersionCompletion: false });
  });

  it('appends to statusHistory, bumps lastActivityAt, resets loop on backlog→in-progress', () => {
    const r = buildStatusTransition({
      task: baseTask,
      newStatus: 'in-progress',
      by: 'Mikey',
      model: 'claude-opus-4.7',
      now: 2000,
    });
    expect(r.changed).toBe(true);
    expect(r.updates.status).toBe('in-progress');
    expect(r.updates.statusHistory).toHaveLength(2);
    expect(r.updates.statusHistory[1]).toMatchObject({
      status: 'in-progress',
      timestamp: 2000,
      by: 'Mikey',
      model: 'claude-opus-4.7',
    });
    expect(r.updates.lastActivityAt).toBe(2000);
    expect(r.updates.loopCount).toBe(0);
    expect(r.updates.loopPausedAt).toBeNull();
    expect(r.updates.loopPauseReason).toBeNull();
  });

  it('stamps claim lease on transition INTO in-progress', () => {
    const r = buildStatusTransition({
      task: baseTask,
      newStatus: 'in-progress',
      by: 'Mikey',
      now: 5000,
      leaseWindowMs: 60_000,
    });
    expect(r.updates.claim_started_at).toBe(5000);
    expect(r.updates.claim_lease_expires_at).toBe(65_000);
  });

  it('clears claim lease on transition OUT of in-progress', () => {
    const ip = { ...baseTask, status: 'in-progress' };
    const r = buildStatusTransition({
      task: ip,
      newStatus: 'done',
      by: 'Mikey',
      now: 3000,
    });
    expect(r.updates.claim_started_at).toBeNull();
    expect(r.updates.claim_lease_expires_at).toBeNull();
  });

  it('detaches assignee in lease-bounce flavor', () => {
    const ip = { ...baseTask, status: 'in-progress' };
    const r = buildStatusTransition({
      task: ip,
      newStatus: 'backlog',
      by: 'lease-bounce',
      now: 4000,
      detachAssignee: true,
    });
    expect(r.updates.assignee).toBe('');
    expect(r.updates._lastDispatchedAt).toBeNull();
  });

  it('notify rule fires on enter/leave in-progress and entry to done/blocked', () => {
    const bl = { ...baseTask, status: 'backlog' };
    expect(buildStatusTransition({ task: bl, newStatus: 'in-progress', by: 'm' }).sideEffects.notify).toBe(true);
    expect(buildStatusTransition({ task: bl, newStatus: 'planning', by: 'm' }).sideEffects.notify).toBe(false);
    expect(buildStatusTransition({ task: bl, newStatus: 'done', by: 'm' }).sideEffects.notify).toBe(true);
    expect(buildStatusTransition({ task: bl, newStatus: 'blocked', by: 'm' }).sideEffects.notify).toBe(true);

    const ip = { ...baseTask, status: 'in-progress' };
    // Leaving in-progress fires regardless of destination
    expect(buildStatusTransition({ task: ip, newStatus: 'backlog', by: 'm' }).sideEffects.notify).toBe(true);
  });

  it('checkVersionCompletion fires only on entry to done', () => {
    const ip = { ...baseTask, status: 'in-progress' };
    expect(buildStatusTransition({ task: ip, newStatus: 'done', by: 'm' }).sideEffects.checkVersionCompletion).toBe(true);
    expect(buildStatusTransition({ task: ip, newStatus: 'backlog', by: 'm' }).sideEffects.checkVersionCompletion).toBe(false);
    expect(buildStatusTransition({ task: ip, newStatus: 'blocked', by: 'm' }).sideEffects.checkVersionCompletion).toBe(false);
  });

  it('omits model from history entry when not provided', () => {
    const r = buildStatusTransition({
      task: baseTask,
      newStatus: 'in-progress',
      by: 'System',
      now: 1500,
    });
    const entry = r.updates.statusHistory[r.updates.statusHistory.length - 1];
    expect(entry).toMatchObject({ status: 'in-progress', timestamp: 1500, by: 'System' });
    expect(entry.model).toBeUndefined();
  });
});
