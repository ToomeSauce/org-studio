'use client';

/**
 * #1390 — Admin Audit Log section in Settings.
 *
 * Renders the workspace's break-glass audit history (org_studio_admin_audit).
 * Owner-only — the /api/audit endpoint gates on workspace owner role and
 * will return 403/401 to non-owners; we render an empty state in that case
 * rather than hiding the section entirely (so the surface is discoverable).
 *
 * Features:
 *   - Paginated (limit/offset, 25 per page by default)
 *   - Filterable by `via` (session | agent-token | break-glass) and `action`
 *     (LIKE filter — e.g. 'store.%' to see all store mutations)
 *   - Auto-refresh on filter change
 *   - File-mode shows a friendly disabled message (the backend returns
 *     { disabled: 'file-mode' } when DATABASE_URL is unset)
 */

import { useState, useEffect, useCallback } from 'react';
import { clsx } from 'clsx';
import { ScrollText, RefreshCw, AlertCircle, Filter } from 'lucide-react';

interface AuditRow {
  id: string;
  workspaceId: string;
  userId: string | null;
  action: string;
  endpoint: string;
  method: string;
  via: 'session' | 'agent-token' | 'break-glass';
  requestMeta: any;
  createdAt: string;
}

interface AuditResponse {
  rows: AuditRow[];
  total: number;
  limit: number;
  offset: number;
  workspaceId: string;
  disabled?: string;
}

const PAGE_SIZE = 25;
const VIA_OPTIONS: Array<'' | 'session' | 'agent-token' | 'break-glass'> = [
  '',
  'session',
  'agent-token',
  'break-glass',
];

function fmtDate(s: string): string {
  try {
    const d = new Date(s);
    return d.toLocaleString(undefined, {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
  } catch {
    return s;
  }
}

function viaBadgeStyle(via: AuditRow['via']): string {
  switch (via) {
    case 'break-glass':
      return 'bg-amber-500/15 text-amber-300 border-amber-500/30';
    case 'agent-token':
      return 'bg-sky-500/15 text-sky-300 border-sky-500/30';
    case 'session':
      return 'bg-emerald-500/15 text-emerald-300 border-emerald-500/30';
    default:
      return 'bg-[var(--bg-tertiary)] text-[var(--text-tertiary)] border-[var(--border-default)]';
  }
}

export function AuditLogSection() {
  const [rows, setRows] = useState<AuditRow[]>([]);
  const [total, setTotal] = useState(0);
  const [offset, setOffset] = useState(0);
  const [via, setVia] = useState<typeof VIA_OPTIONS[number]>('');
  const [actionLike, setActionLike] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [disabled, setDisabled] = useState<string | null>(null);
  const [forbidden, setForbidden] = useState(false);

  const fetchRows = useCallback(
    async (nextOffset: number) => {
      setLoading(true);
      setError(null);
      try {
        const qs = new URLSearchParams();
        qs.set('limit', String(PAGE_SIZE));
        qs.set('offset', String(nextOffset));
        if (via) qs.set('via', via);
        if (actionLike) qs.set('actionLike', actionLike);

        const resp = await fetch(`/api/audit?${qs.toString()}`, {
          method: 'GET',
          credentials: 'include',
        });

        if (resp.status === 401 || resp.status === 403) {
          setForbidden(true);
          setRows([]);
          setTotal(0);
          return;
        }
        if (!resp.ok) {
          const body = await resp.text();
          setError(`HTTP ${resp.status}: ${body.slice(0, 200)}`);
          return;
        }

        const data: AuditResponse = await resp.json();
        setForbidden(false);
        setDisabled(data.disabled || null);
        setRows(data.rows || []);
        setTotal(data.total || 0);
        setOffset(data.offset || 0);
      } catch (e: any) {
        setError(e?.message || 'unknown error');
      } finally {
        setLoading(false);
      }
    },
    [via, actionLike],
  );

  // Initial load + reload when filters change.
  useEffect(() => {
    fetchRows(0);
  }, [fetchRows]);

  const pageStart = total === 0 ? 0 : offset + 1;
  const pageEnd = Math.min(offset + rows.length, total);
  const canPrev = offset > 0 && !loading;
  const canNext = offset + rows.length < total && !loading;

  return (
    <section
      id="audit-log"
      className="bg-[var(--card)] border border-[var(--border-default)] rounded-[var(--radius-lg)] p-5 space-y-4 shadow-[var(--shadow-sm),inset_0_1px_0_var(--card-highlight)]"
    >
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <ScrollText size={16} className="text-[var(--text-secondary)]" />
          <h2 className="text-[var(--text-sm)] font-semibold text-[var(--text-primary)]">
            Admin Audit Log
          </h2>
        </div>
        <button
          onClick={() => fetchRows(offset)}
          disabled={loading}
          className="flex items-center gap-1.5 px-2.5 py-1 min-h-[32px] rounded-[var(--radius-md)] text-[var(--text-xs)] font-medium border bg-[var(--bg-tertiary)] border-[var(--border-default)] text-[var(--text-secondary)] hover:border-[var(--border-strong)] hover:bg-[var(--bg-hover)] disabled:opacity-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-primary)]"
          aria-label="Refresh audit log"
        >
          <RefreshCw size={12} className={clsx(loading && 'animate-spin')} />
          Refresh
        </button>
      </div>

      <p className="text-[var(--text-xs)] text-[var(--text-tertiary)]">
        Break-glass and session-scoped admin events for this workspace. Owner-only. See{' '}
        <code className="text-[var(--text-secondary)]">docs/audits/1387-slice-b.md</code> for schema.
      </p>

      {forbidden && (
        <div className="flex items-start gap-2 p-3 rounded-[var(--radius-md)] border border-[var(--border-default)] bg-[var(--bg-tertiary)]">
          <AlertCircle size={14} className="text-[var(--text-tertiary)] mt-0.5 flex-shrink-0" />
          <div className="text-[var(--text-xs)] text-[var(--text-tertiary)]">
            You don&apos;t have permission to view the audit log. This page is restricted to
            workspace owners.
          </div>
        </div>
      )}

      {disabled === 'file-mode' && (
        <div className="flex items-start gap-2 p-3 rounded-[var(--radius-md)] border border-[var(--border-default)] bg-[var(--bg-tertiary)]">
          <AlertCircle size={14} className="text-[var(--text-tertiary)] mt-0.5 flex-shrink-0" />
          <div className="text-[var(--text-xs)] text-[var(--text-tertiary)]">
            Audit log is disabled in file-mode (single-user / OSS installs). Set{' '}
            <code className="text-[var(--text-secondary)]">DATABASE_URL</code> to enable.
          </div>
        </div>
      )}

      {!forbidden && !disabled && (
        <>
          {/* Filters */}
          <div className="flex flex-wrap items-center gap-2 text-[var(--text-xs)]">
            <Filter size={12} className="text-[var(--text-tertiary)]" />
            <label className="flex items-center gap-1.5">
              <span className="text-[var(--text-tertiary)]">via</span>
              <select
                value={via}
                onChange={(e) => setVia(e.target.value as any)}
                className="bg-[var(--bg-tertiary)] border border-[var(--border-default)] rounded-[var(--radius-sm)] px-2 py-1 text-[var(--text-xs)] text-[var(--text-primary)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-primary)]"
              >
                {VIA_OPTIONS.map((v) => (
                  <option key={v || 'all'} value={v}>
                    {v || 'all'}
                  </option>
                ))}
              </select>
            </label>
            <label className="flex items-center gap-1.5">
              <span className="text-[var(--text-tertiary)]">action like</span>
              <input
                type="text"
                value={actionLike}
                onChange={(e) => setActionLike(e.target.value)}
                placeholder="e.g. store.%"
                className="bg-[var(--bg-tertiary)] border border-[var(--border-default)] rounded-[var(--radius-sm)] px-2 py-1 text-[var(--text-xs)] text-[var(--text-primary)] placeholder:text-[var(--text-tertiary)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-primary)]"
                style={{ width: 140 }}
              />
            </label>
            <span className="ml-auto text-[var(--text-tertiary)]">
              {total === 0 ? 'no rows' : `${pageStart}–${pageEnd} of ${total}`}
            </span>
          </div>

          {error && (
            <div className="flex items-start gap-2 p-3 rounded-[var(--radius-md)] border border-red-500/30 bg-red-500/10">
              <AlertCircle size={14} className="text-red-300 mt-0.5 flex-shrink-0" />
              <div className="text-[var(--text-xs)] text-red-300">{error}</div>
            </div>
          )}

          {/* Table */}
          <div className="border border-[var(--border-default)] rounded-[var(--radius-md)] overflow-hidden">
            <table className="w-full text-[var(--text-xs)]">
              <thead className="bg-[var(--bg-tertiary)] text-[var(--text-tertiary)]">
                <tr>
                  <th className="text-left px-3 py-2 font-medium">When</th>
                  <th className="text-left px-3 py-2 font-medium">Action</th>
                  <th className="text-left px-3 py-2 font-medium">Endpoint</th>
                  <th className="text-left px-3 py-2 font-medium">Via</th>
                  <th className="text-left px-3 py-2 font-medium">User</th>
                </tr>
              </thead>
              <tbody>
                {rows.length === 0 && !loading && (
                  <tr>
                    <td
                      colSpan={5}
                      className="px-3 py-6 text-center text-[var(--text-tertiary)]"
                    >
                      No audit rows match the current filters.
                    </td>
                  </tr>
                )}
                {rows.map((r) => (
                  <tr
                    key={r.id}
                    className="border-t border-[var(--border-default)] hover:bg-[var(--bg-hover)]/30"
                  >
                    <td className="px-3 py-2 text-[var(--text-secondary)] whitespace-nowrap">
                      {fmtDate(r.createdAt)}
                    </td>
                    <td className="px-3 py-2 text-[var(--text-primary)] font-mono">
                      {r.action}
                    </td>
                    <td className="px-3 py-2 text-[var(--text-secondary)] font-mono">
                      <span className="text-[var(--text-tertiary)]">{r.method}</span>{' '}
                      {r.endpoint}
                    </td>
                    <td className="px-3 py-2">
                      <span
                        className={clsx(
                          'inline-block px-1.5 py-0.5 rounded text-[10px] font-medium border',
                          viaBadgeStyle(r.via),
                        )}
                      >
                        {r.via}
                      </span>
                    </td>
                    <td className="px-3 py-2 text-[var(--text-tertiary)] font-mono">
                      {r.userId || '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* Pagination */}
          <div className="flex items-center justify-end gap-2">
            <button
              onClick={() => fetchRows(Math.max(0, offset - PAGE_SIZE))}
              disabled={!canPrev}
              className="px-2.5 py-1 min-h-[32px] rounded-[var(--radius-md)] text-[var(--text-xs)] font-medium border bg-[var(--bg-tertiary)] border-[var(--border-default)] text-[var(--text-secondary)] hover:border-[var(--border-strong)] hover:bg-[var(--bg-hover)] disabled:opacity-40 disabled:cursor-not-allowed focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-primary)]"
            >
              Previous
            </button>
            <button
              onClick={() => fetchRows(offset + PAGE_SIZE)}
              disabled={!canNext}
              className="px-2.5 py-1 min-h-[32px] rounded-[var(--radius-md)] text-[var(--text-xs)] font-medium border bg-[var(--bg-tertiary)] border-[var(--border-default)] text-[var(--text-secondary)] hover:border-[var(--border-strong)] hover:bg-[var(--bg-hover)] disabled:opacity-40 disabled:cursor-not-allowed focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-primary)]"
            >
              Next
            </button>
          </div>
        </>
      )}
    </section>
  );
}
