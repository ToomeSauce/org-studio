'use client';

import { useState, useEffect } from 'react';
import { ChevronRight, Plus, Pencil, Trash2, X, Check, GripVertical } from 'lucide-react';
import { clsx } from 'clsx';

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

interface RoadmapVersion {
  id: string;
  version: string;
  title: string;
  status: 'planned' | 'current' | 'shipped';
  items: RoadmapItem[];
  progress?: { done: number; total: number };
  shipped_at?: number | null;
  sort_order?: number;
}

interface Project {
  id: string;
  autonomy?: {
    approvedThrough?: string | null;
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
  onVersionsChange?: (versions: RoadmapVersion[]) => void;
  selectedTask?: any;
  onTaskSelect?: (task: any) => void;
}

export function RoadmapWithApprovalHorizon({
  projectId,
  project,
  versions,
  onVersionsChange,
  selectedTask,
  onTaskSelect,
}: RoadmapWithApprovalHorizonProps) {
  const [expandedVersionIds, setExpandedVersionIds] = useState<Set<string>>(
    new Set(versions.filter(v => v.status === 'current').map(v => v.id))
  );
  const [addingNew, setAddingNew] = useState(false);
  const [loading, setLoading] = useState(false);
  const [editingVersionId, setEditingVersionId] = useState<string | null>(null);
  const [dragActive, setDragActive] = useState(false);
  const [dragOverSlot, setDragOverSlot] = useState<number | null>(null);

  const [editForm, setEditForm] = useState<{
    version: string;
    title: string;
    status: 'planned' | 'current' | 'shipped';
    items: RoadmapItem[];
  }>({
    version: '',
    title: '',
    status: 'planned',
    items: [],
  });

  const [newForm, setNewForm] = useState({
    version: '',
    title: '',
    status: 'planned' as const,
  });

  // Optimistic local state for approval — overrides prop for instant UI response
  const [optimisticApproval, setOptimisticApproval] = useState<string | null | undefined>(undefined);
  const approvedThrough = optimisticApproval !== undefined ? optimisticApproval : (project.autonomy?.approvedThrough || null);
  
  // Sync optimistic state back to prop when it catches up (via useEffect, not during render)
  const propApproval = project.autonomy?.approvedThrough || null;
  useEffect(() => {
    if (optimisticApproval !== undefined && optimisticApproval === propApproval) {
      setOptimisticApproval(undefined);
    }
  }, [propApproval, optimisticApproval]);
  
  const currentVersion = project.currentVersion;

  // Drag-and-drop safety net: reset drag state on drag end
  useEffect(() => {
    const cleanup = () => {
      console.log('[ApprovalCard] window dragend cleanup fired');
      setDragActive(false);
      setDragOverSlot(null);
    };
    window.addEventListener('dragend', cleanup);
    return () => window.removeEventListener('dragend', cleanup);
  }, []);

  const sortVersions = (versionList: RoadmapVersion[]) => {
    return [...versionList].sort((a, b) => {
      const aOrder = a.sort_order ?? parseFloat(a.version);
      const bOrder = b.sort_order ?? parseFloat(b.version);
      return aOrder - bOrder;
    });
  };

  const sortedVersions = sortVersions(versions);

  // Categorize versions
  const shippedVersions = sortedVersions.filter(v => v.status === 'shipped');
  const currentIdx = sortedVersions.findIndex(v => v.version === currentVersion);
  const currentVersionObj = currentIdx !== -1 ? sortedVersions[currentIdx] : null;

  const saveVersion = async (version: string, title: string, status: string, items: RoadmapItem[]) => {
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
      console.error('Error saving version:', err);
      alert(`Failed to save version: ${err instanceof Error ? err.message : 'Unknown error'}`);
    } finally {
      setLoading(false);
      setEditingVersionId(null);
      setAddingNew(false);
    }
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

    await saveVersion(versionData.version, versionData.title, versionData.status, updatedItems);
  };

  const updateApproval = (versionNum: string | null) => {
    // Optimistic — update UI instantly
    setOptimisticApproval(versionNum);
    
    // Fire API in background (no await)
    fetch('/api/store', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action: 'updateProject',
        id: projectId,
        updates: {
          autonomy: {
            ...project.autonomy,
            approvedThrough: versionNum,
            autoAdvance: !!versionNum,
          },
        },
      }),
    }).catch((e) => {
      console.error('Failed to update approval:', e);
      // Revert on failure
      setOptimisticApproval(undefined);
    });
  };

  const moveApprovalUp = async () => {
    // Move card up = approve one fewer version
    const plannedVersions = sortedVersions.filter(v => v.status !== 'shipped' && v.version !== currentVersion);
    const approvalIndex = getApprovalIndex(plannedVersions);
    
    if (approvalIndex <= 0) {
      updateApproval(null); // Nothing approved
    } else {
      updateApproval(plannedVersions[approvalIndex - 1].version);
    }
  };

  const moveApprovalDown = async () => {
    // Move card down = approve one more version
    const plannedVersions = sortedVersions.filter(v => v.status !== 'shipped' && v.version !== currentVersion);
    const approvalIndex = getApprovalIndex(plannedVersions);
    
    if (approvalIndex < plannedVersions.length - 1) {
      updateApproval(plannedVersions[approvalIndex + 1].version);
    }
  };

  const getApprovalIndex = (plannedVersions: RoadmapVersion[]): number => {
    // Returns the index AFTER which the approval card sits
    // -1 means before all (nothing approved)
    // 0 means after first version (first version approved)
    // n-1 means after last (all approved)
    if (!approvedThrough) return -1;
    
    const approvedNum = parseFloat(approvedThrough);
    let lastApprovedIdx = -1;
    for (let i = 0; i < plannedVersions.length; i++) {
      if (parseFloat(plannedVersions[i].version) <= approvedNum) {
        lastApprovedIdx = i;
      }
    }
    return lastApprovedIdx;
  };

  const handleDragStart = (e: React.DragEvent) => {
    console.log('[ApprovalCard] dragStart fired');
    e.dataTransfer!.effectAllowed = 'move';
    e.dataTransfer!.setData('text/plain', 'approval-card');
    if (e.currentTarget instanceof HTMLElement) {
      e.dataTransfer!.setDragImage(e.currentTarget, e.currentTarget.offsetWidth / 2, 20);
    }
    setDragActive(true);
  };

  const handleDragEnd = () => {
    console.log('[ApprovalCard] dragEnd fired, dragActive was:', dragActive);
    setDragActive(false);
    setDragOverSlot(null);
  };

  const handleDrop = (slotIndex: number) => {
    console.log('[ApprovalCard] drop at slot:', slotIndex);
    setDragActive(false);
    setDragOverSlot(null);
    
    if (slotIndex < 0) {
      updateApproval(null);
    } else {
      const plannedVersions = sortedVersions.filter(v => v.status !== 'shipped' && v.version !== currentVersion);
      const version = plannedVersions[slotIndex]?.version;
      if (version) updateApproval(version);
    }
  };

  const startEdit = (v: RoadmapVersion) => {
    setEditForm({
      version: v.version,
      title: v.title,
      status: v.status,
      items: v.items,
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
    setEditForm({ version: '', title: '', status: 'planned', items: [] });
  };

  const renderVersionRow = (version: RoadmapVersion, isApproved: boolean = false, bgColor?: string) => {
    const isEditing = editingVersionId === version.id;
    const isExpanded = expandedVersionIds.has(version.id);
    const progress = version.progress || { done: version.items.filter((i) => i.done).length, total: version.items.length };

    return (
      <div
        key={version.id}
        className={clsx(
          'border rounded-lg transition-colors',
          isApproved === false && 'opacity-50 hover:opacity-80 transition-opacity',
          isEditing
            ? 'border-[var(--accent-primary)] bg-[var(--bg-secondary)]'
            : bgColor || 'border-[var(--border-color)]'
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
            <span className="font-medium">v{version.version}</span>
            <span className="text-sm text-[var(--text-secondary)]">— {version.title}</span>
          </div>

          {!isEditing && (
            <span className="text-xs text-[var(--text-muted)]">
              {progress.done}/{progress.total}
            </span>
          )}

          {/* Edit/Delete buttons */}
          {!isEditing && (
            <div className="flex gap-1 ml-3 flex-shrink-0">
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

                {/* Save/Cancel Buttons */}
                <div className="flex gap-2 pt-3 border-t border-[var(--border-color)]">
                  <button
                    onClick={() => {
                      const cleanVersion = editForm.version.replace(/^v/i, '').trim();
                      saveVersion(
                        cleanVersion,
                        editForm.title,
                        editForm.status,
                        editForm.items.filter((i) => i.title.trim())
                      )
                    }}
                    disabled={!editForm.title.trim() || loading}
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
            ) : (
              <>
                {/* Items View */}
                {version.items.length > 0 ? (
                  <div className="space-y-1 text-sm">
                    {version.items.map((item, idx) => (
                      <div
                        key={idx}
                        onClick={() => toggleItemDone(version, idx)}
                        className="flex items-start gap-2 cursor-pointer p-2 rounded hover:bg-[var(--bg-secondary)] transition-colors"
                      >
                        <input
                          type="checkbox"
                          checked={item.done}
                          onChange={(e) => {
                            e.stopPropagation();
                            toggleItemDone(version, idx);
                          }}
                          className="w-4 h-4 rounded flex-shrink-0 mt-0.5"
                        />
                        <span
                          className={clsx(
                            'flex-1',
                            item.done ? 'text-[var(--text-muted)]' : 'text-[var(--text-primary)]'
                          )}
                        >
                          {item.done && '✅ '}
                          {item.title}
                        </span>
                      </div>
                    ))}
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

  const renderApprovalCard = () => (
    <div
      draggable
      onDragStart={handleDragStart}
      onDragEnd={handleDragEnd}
      className="flex items-center justify-between px-4 py-3 border rounded-lg cursor-grab active:cursor-grabbing select-none bg-green-100 dark:bg-green-900/40 border-green-300 dark:border-green-700"
    >
      <div className="flex-1 text-center">
        <span className="text-sm font-semibold text-green-700 dark:text-green-300 tracking-wide flex items-center justify-center gap-2">
          <GripVertical size={16} className="opacity-60" />
          Above versions are approved for delivery
        </span>
      </div>
      <div className="flex items-center gap-1 ml-3">
        <button
          onClick={(e) => {
            e.stopPropagation();
            moveApprovalUp();
          }}
          className="p-1 hover:bg-green-200 dark:hover:bg-green-800/50 rounded transition-colors text-green-600 dark:text-green-400 text-sm font-bold"
          title="Move up (approve less)"
        >
          ▲
        </button>
        <button
          onClick={(e) => {
            e.stopPropagation();
            moveApprovalDown();
          }}
          className="p-1 hover:bg-green-200 dark:hover:bg-green-800/50 rounded transition-colors text-green-600 dark:text-green-400 text-sm font-bold"
          title="Move down (approve more)"
        >
          ▼
        </button>
      </div>
    </div>
  );

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
                const cleanVersion = newForm.version.replace(/^v/i, '').trim();
                saveVersion(cleanVersion, newForm.title, newForm.status, [])
              }}
              disabled={!newForm.version.trim() || !newForm.title.trim() || loading}
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
        {currentVersionObj && (
          <div className="border-l-4 border-[var(--accent-primary)] rounded-lg bg-[var(--bg-secondary)] p-4 space-y-4">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-3">
                <span className="text-lg font-bold">v{currentVersionObj.version}</span>
                <span className="text-sm text-[var(--text-secondary)]">{currentVersionObj.title}</span>
                <span className="px-2 py-0.5 bg-blue-100 dark:bg-blue-950/30 text-blue-700 dark:text-blue-400 text-xs font-medium rounded flex items-center gap-1">Current
                  <span className="relative flex h-2 w-2 ml-1">
                    <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-green-400 opacity-75"></span>
                    <span className="relative inline-flex rounded-full h-2 w-2 bg-green-500"></span>
                  </span>
                </span>
              </div>
              <span className="text-sm font-medium">
                {currentVersionObj.items.filter(i => i.done).length}/{currentVersionObj.items.length}
              </span>
            </div>

            {/* Progress bar */}
            {currentVersionObj.items.length > 0 && (
              <div className="h-2 bg-[var(--bg-tertiary)] rounded-full overflow-hidden">
                <div
                  className="h-full bg-[var(--accent-primary)] transition-all"
                  style={{width: `${(currentVersionObj.items.filter(i => i.done).length / currentVersionObj.items.length) * 100}%`}}
                />
              </div>
            )}

            {/* Task items */}
            {currentVersionObj.items.length > 0 && (
              <div className="space-y-1">
                {currentVersionObj.items.map((item, idx) => (
                  <div key={idx} className="flex items-center gap-2 text-sm py-1">
                    <span>{item.done ? '✅' : '⬜'}</span>
                    <span className={item.done ? 'text-[var(--text-muted)]' : 'text-[var(--text-primary)] font-medium'}>{item.title}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {/* Planned versions with draggable approval card */}
        {(() => {
          const plannedVersions = sortedVersions.filter(v => v.status !== 'shipped' && v.version !== currentVersion);
          if (plannedVersions.length === 0 && !addingNew) {
            return null;
          }

          const approvalIndex = getApprovalIndex(plannedVersions);
          const elements: React.ReactNode[] = [];

          for (let i = 0; i < plannedVersions.length; i++) {
            const v = plannedVersions[i];
            const isAboveApproval = i <= approvalIndex;
            const bgColor = isAboveApproval
              ? 'bg-green-50 dark:bg-green-950/30 border-green-200 dark:border-green-800/50'
              : 'bg-red-50 dark:bg-red-950/30 border-red-200 dark:border-red-800/50';

            // Drop zone before this version (only visible during drag)
            if (dragActive) {
              const slotIdx = i - 1; // dropping here means approval goes before version i
              elements.push(
                <div
                  key={`drop-${i}`}
                  onDragOver={(e) => {
                    e.preventDefault();
                    setDragOverSlot(slotIdx);
                  }}
                  onDragLeave={() => {
                    if (dragOverSlot === slotIdx) setDragOverSlot(null);
                  }}
                  onDrop={(e) => {
                    e.preventDefault();
                    handleDrop(slotIdx);
                  }}
                  className={clsx(
                    'rounded transition-all',
                    dragOverSlot === slotIdx
                      ? 'h-12 bg-[var(--accent-primary)]/20 border-2 border-dashed border-[var(--accent-primary)]'
                      : 'h-6'
                  )}
                />
              );
            }

            // Insert approval card if it goes before this version (only when approvalIndex is -1 and i is 0)
            if (i === 0 && approvalIndex === -1) {
              elements.push(
                <div key="approval-card" className={clsx(dragActive && 'opacity-30')}>
                  {renderApprovalCard()}
                </div>
              );
            }

            // Version card with colored background
            elements.push(
              <div key={v.id} className="relative">
                {renderVersionRow(v, isAboveApproval, bgColor)}
              </div>
            );

            // Insert approval card after this version if it's the last approved one
            if (i === approvalIndex && approvalIndex >= 0) {
              elements.push(
                <div key="approval-card" className={clsx(dragActive && 'opacity-30')}>
                  {renderApprovalCard()}
                </div>
              );
            }
          }

          // Drop zone after the last version (during drag)
          if (dragActive) {
            const slotIdx = plannedVersions.length - 1;
            elements.push(
              <div
                key="drop-last"
                onDragOver={(e) => {
                  e.preventDefault();
                  setDragOverSlot(slotIdx);
                }}
                onDragLeave={() => {
                  if (dragOverSlot === slotIdx) setDragOverSlot(null);
                }}
                onDrop={(e) => {
                  e.preventDefault();
                  handleDrop(slotIdx);
                }}
                className={clsx(
                  'rounded transition-all',
                  dragOverSlot === slotIdx
                    ? 'h-12 bg-[var(--accent-primary)]/20 border-2 border-dashed border-[var(--accent-primary)]'
                    : 'h-6'
                )}
              />
            );
          }

          // If all are approved and card goes at the end
          if (approvalIndex === plannedVersions.length - 1) {
            // Already rendered above after the last approved version
          }

          return <div className="space-y-2">{elements}</div>;
        })()}

      </div>
    </div>
  );
}
