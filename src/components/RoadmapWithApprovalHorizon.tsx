'use client';

import { useState, useEffect } from 'react';
import { ChevronRight, Plus, Pencil, Trash2, X, Check } from 'lucide-react';
import { clsx } from 'clsx';
import { compareVersions } from '@/lib/version-utils';

/**
 * RoadmapWithApprovalHorizon
 *
 * Sync model between roadmap items and context board tasks:
 *
 * 1. LAUNCH creates tasks from roadmap items (title-level dedup):
 * handleLaunch in page.tsx → creates backlog tasks only for the CURRENT version
 * Future version tasks are NOT created until that version becomes current.
 *
 * 2. TASK COMPLETION updates roadmap items:
 * When a task moves to "done" on the context board, the store API (updateTask)
 * auto-syncs the matching roadmap item to done (fuzzy title match in store/route.ts).
 * This update propagates via WebSocket push — the project page shows the check instantly.
 *
 * 3. AUTO-ADVANCE creates next version's tasks:
 * sprintCompletionCheck in server.mjs detects all tasks done → creates tasks for the
 * next version (if within approvedThrough) → triggers dev agent scheduler.
 *
 * 4. NO DUPLICATES:
 * Task creation uses title-level dedup (exact match, case-insensitive).
 * Future version tasks are never pre-created.
 */

interface RoadmapItem {
  title: string;
  done: boolean;
  taskId?: string | null;
}

/**
 * #1216: tiny inline owner picker reused per version row. Click the chip,
 * pick a teammate, save fires. "(inherited)" hint when value is empty (so
 * the dispatch fallback resolves to component.owner).
 *
 * Kept module-local: reuses the same teammate-select pattern as
 * RoadmapTaskCreator without pulling in the dashboard's richer chip.
 */
function OwnerSelectInline({
  value,
  fallback,
  teammates,
  onSave,
}: {
  value: string;
  fallback: string;
  teammates: string[];
  onSave: (next: string) => void | Promise<void>;
}) {
  const [editing, setEditing] = useState(false);
  const inherited = !value || value === fallback;
  const display = value && value.length > 0 ? value : (fallback || '—');
  if (!editing) {
    return (
      <button
        type="button"
        onClick={(e) => { e.stopPropagation(); setEditing(true); }}
        className="text-xs px-1.5 py-0.5 rounded text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)] hover:text-[var(--text-primary)] transition-colors"
        title={inherited ? 'Owner inherited from component — click to override' : 'Owner override — click to change'}
        style={inherited ? { fontStyle: 'italic', opacity: 0.75 } : undefined}
      >
        ○ {display}
        {inherited && <span className="ml-1 text-[10px] uppercase tracking-wider">(inherited)</span>}
      </button>
    );
  }
  // Include current value (in case it's stale-out-of-roster) so the picker
  // never silently drops it.
  const options = Array.from(new Set([
    ...(value ? [value] : []),
    ...teammates,
  ]));
  return (
    <select
      autoFocus
      defaultValue={value || ''}
      onClick={(e) => e.stopPropagation()}
      onChange={async (e) => {
        const next = e.target.value;
        setEditing(false);
        if (next !== (value || '')) {
          await onSave(next);
        }
      }}
      onBlur={() => setEditing(false)}
      className="text-xs px-1.5 py-0.5 rounded bg-[var(--bg-secondary)] text-[var(--text-primary)] border border-[var(--border-color)] outline-none"
    >
      <option value="">— inherit —</option>
      {options.map((t) => (
        <option key={t} value={t}>{t}</option>
      ))}
    </select>
  );
}

interface RoadmapVersion {
  id: string;
  version: string;
  title: string;
  status: 'planned' | 'current' | 'shipped';
  items: RoadmapItem[];
  progress?: { done: number; total: number };
  shipped_at?: number | null;
  sort_order?: number;
  version_type?: 'outcome' | 'foundation' | 'chore';
  // #1216: per-version owner override. When set, this overrides the
  // component-level owner for dispatch + UI display. When unset/empty, owner
  // falls back to component.owner.
  owner?: string | null;
  // #1263 — outcome-bound version fields. All optional; absence = no gate.
  successCriteria?: string;
  metricCurrent?: number;
  metricTarget?: number;
  metricComparator?: 'gte' | 'lte' | 'eq';
  loopPaused?: boolean;
}

interface Project {
  id: string;
  autonomy?: {
    [key: string]: any;
  };
  currentVersion?: string;
  [key: string]: any;
}

interface RoadmapTask {
  id: string;
  title: string;
  status: string;
  projectId: string;
  assignee?: string;
  createdAt?: number;
  [key: string]: any;
}

interface RoadmapWithApprovalHorizonProps {
  projectId: string;
  project: Project;
  versions: RoadmapVersion[];
  tasks?: any[];
  onVersionsChange?: (versions: RoadmapVersion[]) => void;
  selectedTask?: any;
  onTaskSelect?: (task: any) => void;
  /**
   * #1112 PR 6 follow-up: when set, the approval banner is scoped to this
   * component — writes go to `components[i].approvedThrough` instead of the
   * legacy project-wide `project.autonomy.approvedThrough`. Reads also pull
   * from the component's own `approvedThrough` field. When unset (no
   * components defined yet), falls back to legacy project-level write so
   * brand-new projects still work before they grow a Main component.
   */
  componentId?: string;
  /**
   * The component object itself — used to read its own `approvedVersions[]`
   * without re-traversing `project.components[]` on every render. Required
   * when `componentId` is set; ignored otherwise.
   *
   * #1216: also reads `owner` so the per-version owner editor can render the
   * "(inherited)" hint when version.owner === component.owner.
   */
  component?: {
    id: string;
    approvedVersions?: string[];
    owner?: string;
    [key: string]: any;
  };
  /**
   * #1216: roster of teammate names for the per-version owner picker.
   * Optional: when omitted, the picker is hidden (e.g. legacy callers).
   */
  teammates?: string[];
}

export function RoadmapWithApprovalHorizon({
  projectId,
  project,
  versions,
  tasks: allTasks,
  onVersionsChange,
  selectedTask,
  onTaskSelect,
  componentId,
  component,
  teammates,
}: RoadmapWithApprovalHorizonProps) {
  // #1112 PR 5: filtering / synthetic-card code removed — the parent page now
  // passes per-component versions directly. This component renders whatever
  // versions it's given, unfiltered.
  const [expandedVersionIds, setExpandedVersionIds] = useState<Set<string>>(
    new Set(versions.filter(v => v.status === 'current').map(v => v.id))
  );
  const [addingNew, setAddingNew] = useState(false);
  const [loading, setLoading] = useState(false);
  const [editingVersionId, setEditingVersionId] = useState<string | null>(null);

  const [editForm, setEditForm] = useState<{
    version: string;
    title: string;
    status: 'planned' | 'current' | 'shipped';
    items: RoadmapItem[];
    version_type: 'outcome' | 'foundation' | 'chore';
    originalVersion: string;
    // #1263 — outcome-bound metric fields. All optional; the API only
    // persists them when present (and treats null as "clear").
    successCriteria: string;
    metricCurrent: string; // kept as string in form state so the input is
                            // controlled cleanly; coerced to number on save.
    metricTarget: string;
    metricComparator: 'gte' | 'lte' | 'eq';
    loopPaused: boolean;
  }>({
    version: '',
    title: '',
    status: 'planned',
    items: [],
    version_type: 'outcome',
    originalVersion: '',
    successCriteria: '',
    metricCurrent: '',
    metricTarget: '',
    metricComparator: 'gte',
    loopPaused: false,
  });

  const [newForm, setNewForm] = useState({
    version: '',
    title: '',
    status: 'planned' as const,
  });

  // #1188: optimistic local state for approvedVersions list — overrides prop
  // for instant UI response after a checkbox toggle.
  const [optimisticApprovedVersions, setOptimisticApprovedVersions] =
    useState<string[] | undefined>(undefined);

  // #1216: optimistic per-version owner overrides. Keyed by version string so
  // multiple in-flight edits don't clobber each other. Cleared on each
  // versions-prop change (new fetch lands).
  const [optimisticVersionOwners, setOptimisticVersionOwners] =
    useState<Record<string, string>>({});
  useEffect(() => {
    setOptimisticVersionOwners({});
  }, [versions]);

  const saveVersionOwner = async (v: RoadmapVersion, nextOwner: string) => {
    const prev = optimisticVersionOwners;
    setOptimisticVersionOwners({ ...prev, [v.version]: nextOwner });
    try {
      // Pass the existing fields so the API doesn't drop them. The route's
      // owner-COALESCE preserves owner when omitted, but title/status/items
      // always overwrite — so we must echo them back unchanged.
      await saveVersion(
        v.version,
        v.title,
        v.status,
        v.items || [],
        v.version_type || 'outcome',
        nextOwner,
      );
    } catch (e) {
      console.error('Failed to update version owner:', e);
      setOptimisticVersionOwners(prev);
    }
  };  // #1224: source of truth is component.approvedVersions[]. The legacy
  // project-level autonomy.approvedThrough scalar is gone.
  const propApprovedVersions: string[] = (() => {
    if (componentId && Array.isArray(component?.approvedVersions)) {
      return component!.approvedVersions!;
    }
    return [];
  })();

  const approvedVersionsList: string[] =
    optimisticApprovedVersions !== undefined
      ? optimisticApprovedVersions
      : propApprovedVersions;

  // Single "approved through" string for caption display = max of the list.
  const approvedThrough: string | null =
    approvedVersionsList.length > 0
      ? approvedVersionsList.reduce((best, v) =>
          compareVersions(v, best) > 0 ? v : best,
        )
      : null;

  const isVersionApproved = (versionStr: string): boolean =>
    approvedVersionsList.includes(versionStr);

  // Sync optimistic state back to prop when it catches up
  useEffect(() => {
    if (
      optimisticApprovedVersions !== undefined &&
      JSON.stringify([...optimisticApprovedVersions].sort()) ===
        JSON.stringify([...propApprovedVersions].sort())
    ) {
      setOptimisticApprovedVersions(undefined);
    }
  }, [propApprovedVersions, optimisticApprovedVersions]);

  const currentVersion = project.currentVersion;

  const sortVersions = (versionList: RoadmapVersion[]) => {
    return [...versionList].sort((a, b) => {
      // Prefer explicit sort_order; otherwise semver-compare versions.
      if (a.sort_order != null && b.sort_order != null) return a.sort_order - b.sort_order;
      if (a.sort_order != null) return -1;
      if (b.sort_order != null) return 1;
      return compareVersions(a.version, b.version);
    });
  };

  const sortedVersions = sortVersions(versions);

  // Categorize versions
  const shippedVersions = sortedVersions.filter(v => v.status === 'shipped');
  const currentIdx = sortedVersions.findIndex(v => v.version === currentVersion);
  const currentVersionObj = currentIdx !== -1 ? sortedVersions[currentIdx] : null;

  const saveVersion = async (
    version: string,
    title: string,
    status: string,
    items: RoadmapItem[],
    versionType?: string,
    owner?: string | null,
    originalVersion?: string,
    // #1263 — outcome-bound metric fields. All optional. Pass `null` to
    // explicitly clear a previously-set value; omit (undefined) to leave
    // the existing value alone.
    metricFields?: Partial<{
      successCriteria: string | null;
      metricCurrent: number | null;
      metricTarget: number | null;
      metricComparator: 'gte' | 'lte' | 'eq' | null;
      loopPaused: boolean | null;
    }>,
  ) => {
    setLoading(true);
    try {
      const isRename =
        typeof originalVersion === 'string' &&
        originalVersion.length > 0 &&
        originalVersion !== version;
      const response = await fetch(`/api/roadmap/${projectId}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'upsert',
          version,
          title,
          status,
          items,
          versionType: versionType || 'outcome',
          // #1216: only include owner when caller passed it. The API
          // preserves existing owner when the field is absent (COALESCE).
          ...(owner !== undefined ? { owner } : {}),
          // #1267: include originalVersion only when actually renaming
          // so the backward-compat upsert path stays untouched.
          ...(isRename ? { originalVersion } : {}),
          // #1263: only include metric fields the caller actually passed.
          ...(metricFields || {}),
        }),
      });

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        throw new Error(errorData.error || `API error: ${response.status}`);
      }

      const responseData = await response.json().catch(() => ({}));

      // Refetch roadmap
      const getRoadmap = await fetch(`/api/roadmap/${projectId}`);
      if (getRoadmap.ok) {
        const data = await getRoadmap.json();
        onVersionsChange?.(data.versions || []);
      }

      // #1267: surface rename outcome so the user sees the task migration count.
      if (responseData?.action === 'renamed') {
        const migrated = Number(responseData.tasksMigrated || 0);
        alert(`Renamed → ${version} (migrated ${migrated} task(s))`);
      }
    } catch (err) {
      console.error('Error saving version:', err);
      alert(`Failed to save version: ${err instanceof Error ? err.message : 'Unknown error'}`);
    } finally {
      setLoading(false);
      setEditingVersionId(null);
      setAddingNew(false);
    }
  };

  // #1263 — partial upsert for outcome-bound fields. Used by both the
  // "Update measurement" inline button and the success-criteria editor.
  // Sends only the fields the caller wants to change; the route preserves
  // unset meta keys via the merge in #1263.
  const saveVersionMeta = async (
    version: string,
    title: string,
    status: string,
    items: RoadmapItem[],
    versionType: string,
    metaPatch: {
      successCriteria?: string;
      metricCurrent?: number | null;
      metricTarget?: number | null;
      metricComparator?: 'gte' | 'lte' | 'eq';
      loopPaused?: boolean;
    },
  ) => {
    setLoading(true);
    try {
      const response = await fetch(`/api/roadmap/${projectId}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'upsert',
          version,
          title,
          status,
          items,
          versionType,
          ...metaPatch,
        }),
      });
      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        throw new Error(errorData.error || `API error: ${response.status}`);
      }
      const getRoadmap = await fetch(`/api/roadmap/${projectId}`);
      if (getRoadmap.ok) {
        const data = await getRoadmap.json();
        onVersionsChange?.(data.versions || []);
      }
    } catch (err) {
      console.error('Error saving version metric:', err);
      alert(`Failed to save: ${err instanceof Error ? err.message : 'Unknown error'}`);
    } finally {
      setLoading(false);
    }
  };

  // Inline measurement-update prompt. Tiny by design — no modal, no form.
  const promptUpdateMeasurement = async (v: RoadmapVersion) => {
    const cur = typeof v.metricCurrent === 'number' ? v.metricCurrent : '';
    const next = window.prompt(
      `Update measurement for ${v.version}` +
        (typeof v.metricTarget === 'number' ? ` (target ${v.metricComparator || 'gte'} ${v.metricTarget})` : '') +
        ':',
      String(cur),
    );
    if (next === null) return;
    const trimmed = next.trim();
    if (trimmed === '') return;
    const num = Number(trimmed);
    if (!Number.isFinite(num)) {
      alert('Measurement must be a number');
      return;
    }
    await saveVersionMeta(
      v.version,
      v.title,
      v.status,
      v.items || [],
      v.version_type || 'outcome',
      { metricCurrent: num },
    );
  };

  const deleteVersion = async (version: string) => {
    if (!confirm(`Delete version ${version}?`)) return;

    setLoading(true);
    try {
      const response = await fetch(`/api/roadmap/${projectId}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'delete',
          version,
        }),
      });

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        throw new Error(errorData.error || `API error: ${response.status}`);
      }

      // Refetch roadmap
      const getRoadmap = await fetch(`/api/roadmap/${projectId}`);
      if (getRoadmap.ok) {
        const data = await getRoadmap.json();
        onVersionsChange?.(data.versions || []);
      }
    } catch (err) {
      console.error('Error deleting version:', err);
      alert(`Failed to delete version: ${err instanceof Error ? err.message : 'Unknown error'}`);
    } finally {
      setLoading(false);
    }
  };

  const toggleItemDone = async (versionData: RoadmapVersion, itemIndex: number) => {
    const updatedItems = versionData.items.map((item, idx) =>
      idx === itemIndex ? { ...item, done: !item.done } : item
    );

    await saveVersion(versionData.version, versionData.title, versionData.status, updatedItems, versionData.version_type || 'outcome');
  };

  /**
   * #1224: persist a new approvedVersions[] list to the component.
   *
   * Optimistic-first: updates UI state immediately, fires the API write in
   * the background, reverts on failure. Empty array clears approval entirely.
   *
   * When this instance isn't bound to a component (brand-new project with
   * no Main component yet), the action is a no-op — there's no longer a
   * project-level approval scalar to fall back to.
   */
  const persistApprovedVersions = (next: string[]) => {
    setOptimisticApprovedVersions(next);

    if (!componentId) {
      // No-op: project has no component to attach approval to. The user
      // must add a Main component first.
      return;
    }

    const body = {
      action: 'updateComponent',
      projectId,
      componentId,
      updates: { approvedVersions: next },
    };

    fetch('/api/store', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }).catch((e) => {
      console.error('Failed to update approval:', e);
      // Revert on failure
      setOptimisticApprovedVersions(undefined);
    });
  };

  /**
   * #1224: toggle a single version's approval (set membership).
   */
  const toggleVersionApproval = (versionStr: string) => {
    const baseList = [...approvedVersionsList];
    const idx = baseList.indexOf(versionStr);
    if (idx >= 0) {
      baseList.splice(idx, 1);
    } else {
      baseList.push(versionStr);
    }
    persistApprovedVersions(baseList);
  };

  const startEdit = (v: RoadmapVersion) => {
    setEditForm({
      version: v.version || '',
      title: v.title || '',
      status: v.status,
      // Defensive copy: ensure every item has string title + boolean done
      // so the edit modal's `<input value={item.title}>` and trim()/filter
      // calls never crash on a sparse legacy item.
      items: (v.items || []).map((it: any) => ({
        ...it,
        title: typeof it?.title === 'string' ? it.title : '',
        done: !!it?.done,
      })),
      version_type: v.version_type || 'outcome',
      // #1267: stash the pre-edit version so saveVersion can request a
      // server-side rename instead of an insert-or-update.
      originalVersion: v.version || '',
      // #1263: hydrate metric fields from the version (lifted by the API
      // GET response from `meta` jsonb).
      successCriteria: ((v as any).successCriteria as string) || '',
      metricCurrent: typeof (v as any).metricCurrent === 'number' ? String((v as any).metricCurrent) : '',
      metricTarget: typeof (v as any).metricTarget === 'number' ? String((v as any).metricTarget) : '',
      metricComparator: ((v as any).metricComparator as any) || 'gte',
      loopPaused: !!(v as any).loopPaused,
    });
    setEditingVersionId(v.id);
    // Ensure the version is expanded so the edit form is visible
    setExpandedVersionIds(prev => {
      const next = new Set(prev);
      next.add(v.id);
      return next;
    });
  };

  const cancelEdit = () => {
    setEditingVersionId(null);
    setEditForm({
      version: '', title: '', status: 'planned', items: [], version_type: 'outcome',
      originalVersion: '',
      successCriteria: '', metricCurrent: '', metricTarget: '', metricComparator: 'gte', loopPaused: false,
    });
  };

  // #1215: extracted from renderVersionRow so Zone B's hero card can render the
  // same approval checkbox as Zone C without duplicating logic.
  const renderApprovalCheckbox = (version: RoadmapVersion) => {
    const checked = isVersionApproved(version.version);
    const missingCount = (version.items || []).filter(
      (item: any) => !item.taskId,
    ).length;
    const disabledReason =
      !checked && missingCount > 0
        ? `${missingCount} item(s) need planning tickets before approval`
        : '';
    return (
      <button
        type="button"
        role="checkbox"
        aria-checked={checked}
        aria-label={
          checked
            ? `Unapprove version ${version.version}`
            : `Approve version ${version.version}`
        }
        disabled={!!disabledReason}
        title={
          disabledReason ||
          (checked
            ? 'Approved — click to unapprove'
            : 'Click to approve this version')
        }
        onClick={(e) => {
          e.stopPropagation();
          if (disabledReason) return;
          toggleVersionApproval(version.version);
        }}
        className={clsx(
          'w-4 h-4 rounded border-2 flex-shrink-0 flex items-center justify-center transition-colors',
          'disabled:cursor-not-allowed disabled:opacity-40',
          checked
            ? 'bg-green-500 border-green-500 text-white hover:bg-green-600 hover:border-green-600'
            : 'bg-transparent border-[var(--border-color)] hover:border-green-500',
        )}
      >
        {checked && <Check size={10} strokeWidth={3} />}
      </button>
    );
  };

  // #1276 — Shared edit-form JSX. Used by both renderVersionRow (planned
  // / shipped versions) AND the inline current-version editor below.
  // Closes over editForm/setEditForm/saveVersion/cancelEdit/loading from
  // component scope. Caller is responsible for rendering only when
  // editingVersionId === version.id.
  const renderEditForm = () => (
    <>
      <div className="space-y-2">
        <input
          type="text"
          value={editForm.version}
          onChange={(e) => setEditForm({ ...editForm, version: e.target.value.replace(/^v/i, '') })}
          placeholder="Version number"
          className="w-24 px-3 py-2 bg-[var(--bg-secondary)] border border-[var(--border-color)] rounded-lg text-[var(--text-primary)] focus:outline-none focus:border-[var(--accent)]"
        />
        <input
          type="text"
          value={editForm.title}
          onChange={(e) => setEditForm({ ...editForm, title: e.target.value })}
          placeholder="Version title"
          className="w-full px-3 py-2 bg-[var(--bg-secondary)] border border-[var(--border-color)] rounded-lg text-[var(--text-primary)] focus:outline-none focus:border-[var(--accent)]"
        />
        <select
          value={editForm.status}
          onChange={(e) => setEditForm({ ...editForm, status: e.target.value as any })}
          className="w-full px-3 py-2 bg-[var(--bg-secondary)] border border-[var(--border-color)] rounded-lg text-[var(--text-primary)] focus:outline-none focus:border-[var(--accent)]"
        >
          <option value="planned">⚪ Planned</option>
          <option value="current">🔵 Current</option>
          <option value="shipped">🟢 Shipped</option>
        </select>
        <select
          value={editForm.version_type}
          onChange={(e) => setEditForm({ ...editForm, version_type: e.target.value as any })}
          className="w-full px-3 py-2 bg-[var(--bg-secondary)] border border-[var(--border-color)] rounded-lg text-[var(--text-primary)] focus:outline-none focus:border-[var(--accent)]"
        >
          <option value="outcome">🎯 Outcome (user-facing result)</option>
          <option value="foundation">🏗️ Foundation (scaffolding/plumbing)</option>
          <option value="chore">🧹 Chore (refactor/tech debt)</option>
        </select>
      </div>

      {/* Items Editor */}
      <div className="space-y-2">
        <label className="text-sm font-medium text-[var(--text-secondary)]">Items</label>
        <div className="space-y-2">
          {editForm.items.map((item, idx) => (
            <div key={idx} className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={item.done}
                onChange={(e) => {
                  const newItems = [...editForm.items];
                  newItems[idx].done = e.target.checked;
                  setEditForm({ ...editForm, items: newItems });
                }}
                className="w-4 h-4 rounded"
              />
              <input
                type="text"
                value={item.title}
                onChange={(e) => {
                  const newItems = [...editForm.items];
                  newItems[idx].title = e.target.value;
                  setEditForm({ ...editForm, items: newItems });
                }}
                placeholder="Item text"
                className="flex-1 px-3 py-2 bg-[var(--bg-secondary)] border border-[var(--border-color)] rounded-lg text-[var(--text-primary)] placeholder-[var(--text-muted)] focus:outline-none focus:border-[var(--accent)]"
              />
              <button
                onClick={() => {
                  const newItems = editForm.items.filter((_, i) => i !== idx);
                  setEditForm({ ...editForm, items: newItems });
                }}
                className="p-1.5 hover:bg-red-100 dark:hover:bg-red-950/30 rounded transition-colors"
              >
                <X className="w-3 h-3 text-red-600 dark:text-red-400" />
              </button>
            </div>
          ))}
        </div>

        {/* Add Item Button */}
        <button
          onClick={() =>
            setEditForm({
              ...editForm,
              items: [...editForm.items, { title: '', done: false }],
            })
          }
          className="flex items-center gap-2 w-full px-3 py-2 text-sm border border-dashed border-[var(--border-color)] rounded-lg text-[var(--text-muted)] hover:text-[var(--text-secondary)] transition-colors"
        >
          <Plus className="w-4 h-4" />
          Add Item
        </button>
      </div>

      {/* #1263 — Outcome-bound success criteria. */}
      <div className="space-y-2 pt-3 border-t border-[var(--border-color)]">
        <label className="text-sm font-medium text-[var(--text-secondary)]">
          Success Criteria <span className="text-[var(--text-muted)] font-normal">(optional — gates auto-ship on a measurable outcome)</span>
        </label>
        <textarea
          value={editForm.successCriteria}
          onChange={(e) => setEditForm({ ...editForm, successCriteria: e.target.value })}
          placeholder="e.g. ‘onboarding completion rate hits 60%’"
          rows={2}
          className="w-full px-3 py-2 bg-[var(--bg-secondary)] border border-[var(--border-color)] rounded-lg text-[var(--text-primary)] placeholder-[var(--text-muted)] focus:outline-none focus:border-[var(--accent)]"
        />
        <div className="grid grid-cols-3 gap-2">
          <input
            type="number"
            step="any"
            value={editForm.metricCurrent}
            onChange={(e) => setEditForm({ ...editForm, metricCurrent: e.target.value })}
            placeholder="current"
            className="px-3 py-2 bg-[var(--bg-secondary)] border border-[var(--border-color)] rounded-lg text-[var(--text-primary)] placeholder-[var(--text-muted)] focus:outline-none focus:border-[var(--accent)]"
          />
          <select
            value={editForm.metricComparator}
            onChange={(e) => setEditForm({ ...editForm, metricComparator: e.target.value as any })}
            className="px-3 py-2 bg-[var(--bg-secondary)] border border-[var(--border-color)] rounded-lg text-[var(--text-primary)] focus:outline-none focus:border-[var(--accent)]"
          >
            <option value="gte">≥ (at least)</option>
            <option value="lte">≤ (at most)</option>
            <option value="eq">= (exactly)</option>
          </select>
          <input
            type="number"
            step="any"
            value={editForm.metricTarget}
            onChange={(e) => setEditForm({ ...editForm, metricTarget: e.target.value })}
            placeholder="target"
            className="px-3 py-2 bg-[var(--bg-secondary)] border border-[var(--border-color)] rounded-lg text-[var(--text-primary)] placeholder-[var(--text-muted)] focus:outline-none focus:border-[var(--accent)]"
          />
        </div>
        <label className="flex items-center gap-2 text-sm text-[var(--text-secondary)] cursor-pointer">
          <input
            type="checkbox"
            checked={editForm.loopPaused}
            onChange={(e) => setEditForm({ ...editForm, loopPaused: e.target.checked })}
            className="w-4 h-4 rounded"
          />
          Pause this version (kill-switch — dispatcher will skip its tickets)
        </label>
      </div>

      {/* Save/Cancel Buttons */}
      <div className="flex gap-2 pt-3 border-t border-[var(--border-color)]">
        <button
          onClick={() => {
            const cleanVersion = (editForm.version || '').replace(/^v/i, '').trim();
            const isRename =
              editForm.originalVersion &&
              editForm.originalVersion !== cleanVersion;
            if (isRename) {
              const linkedCount = (editForm.items || []).filter(
                (it: any) => it && it.taskId,
              ).length;
              if (linkedCount > 0) {
                const ok = confirm(
                  `This will rename ${linkedCount} task(s) tagged with version ${editForm.originalVersion} to ${cleanVersion}. Proceed?`,
                );
                if (!ok) return;
              }
            }
            saveVersion(
              cleanVersion,
              editForm.title,
              editForm.status,
              editForm.items.filter((i) => typeof i.title === 'string' && i.title.trim()),
              editForm.version_type,
              undefined,
              editForm.originalVersion,
              {
                successCriteria: editForm.successCriteria.trim() ? editForm.successCriteria.trim() : null,
                metricCurrent: editForm.metricCurrent.trim() === '' ? null : Number(editForm.metricCurrent),
                metricTarget: editForm.metricTarget.trim() === '' ? null : Number(editForm.metricTarget),
                metricComparator: editForm.metricComparator,
                loopPaused: editForm.loopPaused,
              },
            )
          }}
          disabled={!(editForm.title || '').trim() || loading}
          className="flex-1 px-4 py-2 bg-[var(--accent-primary)] text-white rounded-lg font-medium hover:opacity-90 transition-opacity disabled:opacity-50 flex items-center justify-center gap-2"
        >
          <Check className="w-4 h-4" />
          {loading ? 'Saving...' : 'Save'}
        </button>
        <button
          onClick={cancelEdit}
          className="flex-1 px-4 py-2 bg-[var(--bg-tertiary)] text-[var(--text-secondary)] rounded-lg font-medium hover:bg-[var(--bg-hover)] transition-colors"
        >
          Cancel
        </button>
      </div>
    </>
  );

  // #1276 — Loud-confirm wrapper around deleteVersion for the current-version
  // block. Two-step: standard confirm, then a typed-string confirm so a
  // misclick can't nuke the active version.
  const deleteCurrentVersion = async (versionStr: string) => {
    const typed = window.prompt(
      `⚠️ You are about to delete v${versionStr} — the project's CURRENT (active) version.\n\nThis will detach all linked tasks from the version and the project will have no current version until you launch the next one.\n\nType DELETE to confirm.`
    );
    if (typed !== 'DELETE') return;
    await deleteVersion(versionStr);
  };

  const renderVersionRow = (
    version: RoadmapVersion,
    isApproved: boolean = false,
    bgColor?: string,
    showApprovalCheckbox: boolean = false,
  ) => {
    const isEditing = editingVersionId === version.id;
    const isExpanded = expandedVersionIds.has(version.id);
    const progress = version.progress || { done: (version.items || []).filter((i) => i.done).length, total: (version.items || []).length };
    const versionType = version.version_type || 'outcome';
    const typeBadge = getVersionTypeBadge(versionType);
    const isNonShipped = version.status !== 'shipped';
    const typeBgClass = (isNonShipped && versionType !== 'outcome')
      ? 'bg-gray-50 dark:bg-gray-900/30'
      : '';

    return (
      <div
        key={version.id}
        className={clsx(
          'border rounded-lg transition-colors',
          isApproved === false && 'opacity-50 hover:opacity-80 transition-opacity',
          isEditing
            ? 'border-[var(--accent-primary)] bg-[var(--bg-secondary)]'
            : bgColor || (typeBgClass || 'border-[var(--border-color)]')
        )}
      >
        {/* Header Row */}
        <div
          className={clsx(
            'px-4 py-3 flex items-center justify-between cursor-pointer',
            !isEditing && 'hover:bg-[var(--bg-secondary)]'
          )}
          onClick={() => {
            if (!isEditing) {
              // Always allow click to expand/collapse
              const newSet = new Set(expandedVersionIds);
              newSet.has(version.id) ? newSet.delete(version.id) : newSet.add(version.id);
              setExpandedVersionIds(newSet);
            }
          }}
        >
          <div className="flex items-center gap-3 flex-1">
            {!isEditing && (
              <ChevronRight
                size={14}
                className={clsx('text-[var(--text-muted)] flex-shrink-0', isExpanded && 'rotate-90 transition-transform')}
              />
            )}
            {showApprovalCheckbox && !isEditing && renderApprovalCheckbox(version)}
            <span title={`Version type: ${versionType}`}>{typeBadge}</span>
            <span className="font-medium">{version.version}</span>
            <span className="text-sm text-[var(--text-secondary)]">— {version.title}</span>
            {/* #1216: per-version owner picker. Renders only when teammates
             * are passed in (parent supplies roster from settings). Inline
             * click-to-edit so it doesn't fight the row's expand/collapse. */}
            {!isEditing && teammates && teammates.length > 0 && (
              <span
                className="ml-auto mr-2 flex-shrink-0"
                onClick={(e) => e.stopPropagation()}
              >
                <OwnerSelectInline
                  value={
                    optimisticVersionOwners[version.version] !== undefined
                      ? optimisticVersionOwners[version.version]
                      : (version.owner || '')
                  }
                  fallback={component?.owner || ''}
                  teammates={teammates}
                  onSave={(next) => saveVersionOwner(version, next)}
                />
              </span>
            )}
          </div>

          {!isEditing && (
            <span className="text-xs text-[var(--text-muted)]">
              {progress.done}/{progress.total}
            </span>
          )}

          {/* #1263 — outcome-bound metric pill. Renders only when criteria
           * are set on this version. Greyed when loopPaused. */}
          {!isEditing && (version.successCriteria || '').trim() && (
            <span
              title={`Success criteria: ${version.successCriteria}` + (version.loopPaused ? ' (loop paused)' : '')}
              className={
                'ml-2 inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-medium border ' +
                (version.loopPaused
                  ? 'border-[var(--border-color)] text-[var(--text-muted)] bg-[var(--bg-tertiary)] opacity-60'
                  : 'border-[var(--border-color)] text-[var(--text-secondary)] bg-[var(--bg-secondary)]')
              }
            >
              metric:&nbsp;
              {typeof version.metricCurrent === 'number' ? version.metricCurrent : '?'}
              /
              {typeof version.metricTarget === 'number' ? version.metricTarget : '?'}
              {version.loopPaused ? ' · paused' : ''}
            </span>
          )}

          {/* Edit/Delete buttons */}
          {!isEditing && (
            <div className="flex gap-1 ml-3 flex-shrink-0">
              {/* #1263 — inline measurement update. Renders only when
               * criteria are set on this version. */}
              {(version.successCriteria || '').trim() && (
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    promptUpdateMeasurement(version);
                  }}
                  disabled={loading}
                  className="px-1.5 py-0.5 text-[10px] hover:bg-[var(--bg-tertiary)] rounded transition-colors text-[var(--text-secondary)] border border-[var(--border-color)]"
                  title="Update measurement"
                >
                  +·
                </button>
              )}
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  startEdit(version);
                }}
                className="p-1.5 hover:bg-[var(--bg-tertiary)] rounded transition-colors"
                title="Edit version"
              >
                <Pencil className="w-3 h-3 text-[var(--text-muted)]" />
              </button>
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  deleteVersion(version.version);
                }}
                disabled={loading}
                className="p-1.5 hover:bg-red-100 dark:hover:bg-red-950/30 rounded transition-colors disabled:opacity-50"
                title="Delete version"
              >
                <Trash2 className="w-3 h-3 text-red-600 dark:text-red-400" />
              </button>
            </div>
          )}
        </div>

        {/* Expanded Content */}
        {isExpanded && (
          <div className="border-t border-[var(--border-color)] px-4 py-3 bg-[var(--bg-primary)] space-y-3">
            {isEditing ? (
              renderEditForm()
            ) : (
              <>
                {/* Items View */}
                {(version.items || []).length > 0 ? (
                  <div className="space-y-1 text-sm">
                    {(version.items || []).map((item, idx) => {
                      const statusEmoji = item.done ? '✅' : item.taskId ? '⬜' : '📝';
                      return (
                        <div
                          key={idx}
                          className="flex items-start gap-2 p-2 rounded"
                        >
                          <span className="flex-shrink-0 mt-0.5">{statusEmoji}</span>
                          <span
                            className={clsx(
                              'flex-1',
                              item.done ? 'text-[var(--text-muted)]' : 'text-[var(--text-primary)]'
                            )}
                          >
                            {item.title}
                          </span>
                        </div>
                      );
                    })}
                  </div>
                ) : (
                  <p className="text-sm text-[var(--text-muted)]">No items yet. Edit to add items.</p>
                )}
              </>
            )}
          </div>
        )}
      </div>
    );
  };

  const getVersionTypeBadge = (vt: string) => {
    switch (vt) {
      case 'foundation': return '🏗️';
      case 'chore': return '🧹';
      default: return '🎯';
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <h2 className="text-base font-semibold text-[var(--text-primary)]">Roadmap</h2>
        <span
          className="inline-flex items-center justify-center w-4 h-4 rounded-full bg-[var(--bg-tertiary)] text-[var(--text-muted)] text-[10px] font-bold cursor-help"
          title="Roadmap versions are proposed by the dev owner agent based on your vision and outcomes. To add, change, or extend the roadmap, work with your dev owner agent directly."
        >?</span>
      </div>

      {/* Agent-driven roadmap guidance (when empty) */}
      {sortedVersions.length === 0 && !addingNew && (
        <div className="border border-dashed border-[var(--border-color)] rounded-lg p-4 text-center">
          <p className="text-sm text-[var(--text-muted)]">
            No versions yet. The dev owner agent will propose a roadmap based on your vision and outcomes.
          </p>
        </div>
      )}

      {/* New Version Form */}
      {addingNew && (
        <div className="border border-[var(--border-color)] rounded-lg p-4 bg-[var(--bg-secondary)] space-y-3">
          <input
            type="text"
            placeholder="Version number (e.g. 0.4 — no 'v' prefix)"
            value={newForm.version}
            onChange={(e) => setNewForm({ ...newForm, version: e.target.value })}
            className="w-full px-3 py-2 bg-[var(--bg-primary)] border border-[var(--border-color)] rounded-lg text-[var(--text-primary)] placeholder-[var(--text-muted)] focus:outline-none focus:border-[var(--accent)]"
          />
          <input
            type="text"
            placeholder="Title (e.g., Authentication & Security)"
            value={newForm.title}
            onChange={(e) => setNewForm({ ...newForm, title: e.target.value })}
            className="w-full px-3 py-2 bg-[var(--bg-primary)] border border-[var(--border-color)] rounded-lg text-[var(--text-primary)] placeholder-[var(--text-muted)] focus:outline-none focus:border-[var(--accent)]"
          />
          <select
            value={newForm.status}
            onChange={(e) => setNewForm({ ...newForm, status: e.target.value as any })}
            className="w-full px-3 py-2 bg-[var(--bg-primary)] border border-[var(--border-color)] rounded-lg text-[var(--text-primary)] focus:outline-none focus:border-[var(--accent)]"
          >
            <option value="planned">⚪ Planned</option>
            <option value="current">🔵 Current</option>
            <option value="shipped">🟢 Shipped</option>
          </select>
          <div className="flex gap-2">
            <button
              onClick={() => {
                const cleanVersion = (newForm.version || '').replace(/^v/i, '').trim();
                saveVersion(cleanVersion, newForm.title, newForm.status, [])
              }}
              disabled={!(newForm.version || '').trim() || !(newForm.title || '').trim() || loading}
              className="flex-1 px-4 py-2 bg-[var(--accent-primary)] text-white rounded-lg font-medium hover:opacity-90 transition-opacity disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {loading ? 'Creating...' : 'Create'}
            </button>
            <button
              onClick={() => {
                setAddingNew(false);
                setNewForm({ version: '', title: '', status: 'planned' });
              }}
              className="flex-1 px-4 py-2 bg-[var(--bg-tertiary)] text-[var(--text-secondary)] rounded-lg font-medium hover:bg-[var(--bg-hover)] transition-colors"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      <div className="space-y-4">
        {/* Zone A: Shipped versions (collapsed accordion) */}
        {shippedVersions.length > 0 && (
          <details className="border border-[var(--border-color)] rounded-lg overflow-hidden group">
            <summary className="cursor-pointer px-4 py-3 flex items-center gap-2 text-sm font-medium text-[var(--text-primary)] hover:bg-[var(--bg-secondary)] transition-colors select-none list-none">
              <ChevronRight size={14} className="text-[var(--text-muted)] group-open:rotate-90 transition-transform" />
              <span>Shipped ({shippedVersions.length} versions)</span>
            </summary>
            <div className="border-t border-[var(--border-color)] bg-[var(--bg-primary)] space-y-2 p-4">
              {shippedVersions.map(v => renderVersionRow(v, true, 'border-green-200 dark:border-green-800/50 bg-green-50/50 dark:bg-green-950/20'))}
            </div>
          </details>
        )}

        {/* Zone B: Current version (always expanded with accent border) */}
        {currentVersionObj && (() => {
          // Cross-reference roadmap items with actual tasks to show real status
          const versionTasks = (allTasks || []).filter((t: any) => 
            t.projectId === projectId && t.version === currentVersion && !t.isArchived
          );
          const reviewTasks = versionTasks.filter((t: any) => t.status === 'review');
          const blockedTasks = versionTasks.filter((t: any) => t.status === 'blocked');
          const hasStall = reviewTasks.length > 0 || blockedTasks.length > 0;
          // #1276 — surface edit / delete / measurement-update on current version
          const isEditingCurrent = editingVersionId === currentVersionObj.id;
          const hasCriteria = ((currentVersionObj as any).successCriteria || '').trim();

          return (
          <div className={clsx(
            'border-l-4 rounded-lg bg-[var(--bg-secondary)] p-4 space-y-4',
            hasStall ? 'border-amber-500' : 'border-[var(--accent-primary)]'
          )}>
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-3">
                {/* #1215: same approval checkbox as Zone C */}
                {renderApprovalCheckbox(currentVersionObj)}
                <span className="text-lg font-bold">v{currentVersionObj.version}</span>
                <span className="text-sm text-[var(--text-secondary)]">{currentVersionObj.title}</span>
                <span className="px-2 py-0.5 bg-blue-100 dark:bg-blue-950/30 text-blue-700 dark:text-blue-400 text-xs font-medium rounded flex items-center gap-1">Current
                  <span className="relative flex h-2 w-2 ml-1">
                    <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-green-400 opacity-75"></span>
                    <span className="relative inline-flex rounded-full h-2 w-2 bg-green-500"></span>
                  </span>
                </span>
                {/* #1263 — metric pill, mirroring renderVersionRow */}
                {hasCriteria && (
                  <span
                    title={`Success criteria: ${(currentVersionObj as any).successCriteria}` + ((currentVersionObj as any).loopPaused ? ' (loop paused)' : '')}
                    className={
                      'inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-medium border ' +
                      ((currentVersionObj as any).loopPaused
                        ? 'border-[var(--border-color)] text-[var(--text-muted)] bg-[var(--bg-tertiary)] opacity-60'
                        : 'border-[var(--border-color)] text-[var(--text-secondary)] bg-[var(--bg-secondary)]')
                    }
                  >
                    metric:&nbsp;
                    {typeof (currentVersionObj as any).metricCurrent === 'number' ? (currentVersionObj as any).metricCurrent : '?'}
                    /
                    {typeof (currentVersionObj as any).metricTarget === 'number' ? (currentVersionObj as any).metricTarget : '?'}
                    {(currentVersionObj as any).loopPaused ? ' · paused' : ''}
                  </span>
                )}
                {/* #1280 — placeholder removed; picker now lives in the
                 * right-side action cluster below for reliable visibility.
                 * Earlier iteration placed it in the left cluster after the
                 * metric pill, but with the approval checkbox + version
                 * label + title + Current pill + metric pill all crowding
                 * the same flex row, the picker either wrapped weird or
                 * got squeezed out of view depending on viewport. */}
              </div>
              <div className="flex items-center gap-2">
                {/* #1280 — owner picker on the right cluster, before the
                 * progress count + action buttons. Reliably visible because
                 * justify-between guarantees this cluster sits at the far
                 * right of the row. Hidden while editing.
                 *
                 * Wraps OwnerSelectInline in a labeled, bordered chip so it
                 * reads unambiguously as a control rather than blending in
                 * with the surrounding metric/count text. The wrapping span
                 * is purely visual; click forwarding still goes through
                 * OwnerSelectInline's own button. */}
                {!isEditingCurrent && teammates && teammates.length > 0 && (
                  <span
                    className="flex-shrink-0 inline-flex items-center gap-1 px-2 py-0.5 rounded border border-[var(--border-color)] bg-[var(--bg-tertiary)] text-[10px] uppercase tracking-wider text-[var(--text-muted)]"
                    onClick={(e) => e.stopPropagation()}
                    title="Version owner — click to reassign"
                  >
                    <span>owner</span>
                    <OwnerSelectInline
                      value={
                        optimisticVersionOwners[currentVersionObj.version] !== undefined
                          ? optimisticVersionOwners[currentVersionObj.version]
                          : (currentVersionObj.owner || '')
                      }
                      fallback={component?.owner || ''}
                      teammates={teammates}
                      onSave={(next) => saveVersionOwner(currentVersionObj, next)}
                    />
                    <span className="text-[var(--text-muted)]">▾</span>
                  </span>
                )}
                <span className="text-sm font-medium">
                  {(currentVersionObj.items || []).filter(i => i.done).length}/{(currentVersionObj.items || []).length}
                </span>
                {/* #1276 — edit / delete / update-measurement buttons. Hidden
                 * while editing to mirror renderVersionRow behavior. */}
                {!isEditingCurrent && (
                  <div className="flex gap-1 ml-2">
                    {hasCriteria && (
                      <button
                        onClick={(e) => { e.stopPropagation(); promptUpdateMeasurement(currentVersionObj); }}
                        disabled={loading}
                        className="px-1.5 py-0.5 text-[10px] hover:bg-[var(--bg-tertiary)] rounded transition-colors text-[var(--text-secondary)] border border-[var(--border-color)]"
                        title="Update measurement"
                      >
                        +·
                      </button>
                    )}
                    <button
                      onClick={(e) => { e.stopPropagation(); startEdit(currentVersionObj); }}
                      className="p-1.5 hover:bg-[var(--bg-tertiary)] rounded transition-colors"
                      title="Edit version"
                    >
                      <Pencil className="w-3 h-3 text-[var(--text-muted)]" />
                    </button>
                    <button
                      onClick={(e) => { e.stopPropagation(); deleteCurrentVersion(currentVersionObj.version); }}
                      disabled={loading}
                      className="p-1.5 hover:bg-red-100 dark:hover:bg-red-950/30 rounded transition-colors disabled:opacity-50"
                      title="Delete current version (extra confirm)"
                    >
                      <Trash2 className="w-3 h-3 text-red-600 dark:text-red-400" />
                    </button>
                  </div>
                )}
              </div>
            </div>

            {/* #1276 — inline editor on current version. Renders the same
             * form as renderVersionRow via the shared helper. */}
            {isEditingCurrent ? (
              <div className="border-t border-[var(--border-color)] pt-4 space-y-3">
                {renderEditForm()}
              </div>
            ) : (<>

            {/* Stall banner */}
            {hasStall && (
              <div className="flex items-center gap-2 px-3 py-2 rounded-md bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-800/50">
                <span className="text-amber-600 dark:text-amber-400 text-sm font-medium">
                  ⚠️ {reviewTasks.length > 0 ? `${reviewTasks.length} task(s) awaiting review` : ''}
                  {reviewTasks.length > 0 && blockedTasks.length > 0 ? ' · ' : ''}
                  {blockedTasks.length > 0 ? `${blockedTasks.length} blocked` : ''}
                </span>
              </div>
            )}

            {/* Progress bar */}
            {(currentVersionObj.items || []).length > 0 && (
              <div className="h-2 bg-[var(--bg-tertiary)] rounded-full overflow-hidden">
                <div
                  className="h-full bg-[var(--accent-primary)] transition-all"
                  style={{width: `${((currentVersionObj.items || []).filter(i => i.done).length / (currentVersionObj.items || []).length) * 100}%`}}
                />
              </div>
            )}

            {/* Task items with real status + deep links */}
            {(currentVersionObj.items || []).length > 0 && (
              <div className="space-y-1">
                {(currentVersionObj.items || []).map((item, idx) => {
                  // Find matching task for this roadmap item
                  const matchedTask = versionTasks.find((t: any) => {
                    if (item.taskId && t.id === item.taskId) return true;
                    // Fall back to fuzzy title match — guard both sides; either may be undefined.
                    const tTitle = typeof t.title === 'string' ? t.title.toLowerCase().trim() : '';
                    const itTitle = typeof item.title === 'string' ? item.title.toLowerCase().trim() : '';
                    return !!tTitle && tTitle === itTitle;
                  });
                  const taskStatus = matchedTask?.status;
                  const statusIndicator = taskStatus === 'blocked' ? '🔴'
                    : taskStatus === 'review' ? '🟡'
                    : taskStatus === 'in-progress' ? '👀'
                    : taskStatus === 'qa' ? '🧪'
                    : item.done ? '✅'
                    : item.taskId ? '⬜'   // has ticket = ready
                    : '📝';               // no ticket = draft
                  const isClickable = !!matchedTask;

                  return (
                    <div key={idx} className={clsx(
                      'flex items-center gap-2 text-sm py-1 rounded px-1',
                      isClickable && 'hover:bg-amber-50 dark:hover:bg-amber-950/20 cursor-pointer',
                    )}>
                      <span>{statusIndicator}</span>
                      {isClickable ? (
                        <a
                          href={`/context?task=${matchedTask.id}`}
                          className={clsx(
                            'font-medium hover:underline',
                            taskStatus === 'blocked' ? 'text-red-600 dark:text-red-400'
                            : taskStatus === 'review' ? 'text-amber-600 dark:text-amber-400'
                            : taskStatus === 'in-progress' ? 'text-[var(--text-primary)]'
                            : taskStatus === 'qa' ? 'text-teal-600 dark:text-teal-400'
                            : item.done ? 'text-[var(--text-muted)]'
                            : 'text-[var(--text-primary)]'
                          )}
                        >
                          {item.title}
                          {taskStatus && taskStatus !== 'done' && taskStatus !== 'backlog' && (
                            <span className="ml-1.5 text-xs opacity-70">({taskStatus})</span>
                          )}
                        </a>
                      ) : (
                        <span className={item.done ? 'text-[var(--text-muted)]' : 'text-[var(--text-primary)] font-medium'}>
                          {item.title}
                        </span>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
            </>)}
          </div>
          );
        })()}

        {/* #1188: Planned versions with per-version approval checkboxes.
            Replaces the legacy single draggable approval banner. Each row
            renders its own checkbox via renderVersionRow(showApprovalCheckbox=true). */}
        {(() => {
          const plannedVersions = sortedVersions.filter(
            (v) => v.status !== 'shipped' && v.version !== currentVersion,
          );
          if (plannedVersions.length === 0 && !addingNew) {
            return null;
          }

          return (
            <div className="space-y-2">
              {plannedVersions.map((v) => {
                const approved = isVersionApproved(v.version);
                const bgColor = approved
                  ? 'bg-green-50 dark:bg-green-950/30 border-green-200 dark:border-green-800/50'
                  : 'border-[var(--border-color)]';
                return (
                  <div key={v.id} className="relative">
                    {renderVersionRow(v, approved, bgColor, true)}
                  </div>
                );
              })}
            </div>
          );
        })()}

      </div>
    </div>
  );
}
