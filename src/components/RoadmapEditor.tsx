'use client';

import { useState, useCallback } from 'react';
import { Pencil, Trash2, X, Plus, Check, ChevronRight } from 'lucide-react';
import { clsx } from 'clsx';

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

interface RoadmapEditorProps {
  projectId: string;
  versions: RoadmapVersion[];
  onVersionsChange?: (versions: RoadmapVersion[]) => void;
}

export function RoadmapEditor({ projectId, versions, onVersionsChange }: RoadmapEditorProps) {
  const [editingVersionId, setEditingVersionId] = useState<string | null>(null);
  const [addingNew, setAddingNew] = useState(false);
  const [loading, setLoading] = useState(false);
  const [roadmapOpen, setRoadmapOpen] = useState(true);
  const [expandedVersionIds, setExpandedVersionIds] = useState<Set<string>>(
    new Set(versions.map((v) => v.id))
  );

  // Edit form state
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

  // New version form state
  const [newForm, setNewForm] = useState({
    version: '',
    title: '',
    status: 'planned' as const,
  });

  const sortVersions = (versionList: RoadmapVersion[]) => {
    return [...versionList].sort((a, b) => {
      const aOrder = a.sort_order ?? parseFloat(a.version);
      const bOrder = b.sort_order ?? parseFloat(b.version);
      return aOrder - bOrder;
    });
  };

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

  const startEdit = (v: RoadmapVersion) => {
    setEditForm({
      version: v.version,
      title: v.title,
      status: v.status,
      items: v.items,
    });
    setEditingVersionId(v.id);
  };

  const cancelEdit = () => {
    setEditingVersionId(null);
    setEditForm({ version: '', title: '', status: 'planned', items: [] });
  };

  const getStatusBadge = (status: string) => {
    switch (status) {
      case 'shipped':
        return { emoji: '🟢', label: 'Shipped', bgClass: 'bg-green-100 dark:bg-green-950/30' };
      case 'current':
        return { emoji: '🔵', label: 'Current', bgClass: 'bg-blue-100 dark:bg-blue-950/30' };
      case 'planned':
        return { emoji: '⚪', label: 'Planned', bgClass: 'bg-gray-100 dark:bg-gray-800' };
      default:
        return { emoji: '⚪', label: 'Planned', bgClass: 'bg-gray-100 dark:bg-gray-800' };
    }
  };

  const sortedVersions = sortVersions(versions);

    return (
    <div className="space-y-4">
      {/* Roadmap Section Header with Collapse Toggle */}
      <button
        onClick={() => setRoadmapOpen(!roadmapOpen)}
        className="flex items-center gap-2 hover:opacity-70 transition-opacity"
      >
        <ChevronRight
          className={clsx('transition-transform', roadmapOpen && 'rotate-90')}
          size={18}
        />
        <h2 className="text-lg font-semibold text-[var(--text-primary)]">Roadmap</h2>
      </button>

      {roadmapOpen && (
        <div className="space-y-4">
          {/* Add Version Button */}
          {!addingNew && !editingVersionId && (
            <button
              onClick={() => setAddingNew(true)}
              className="flex items-center gap-2 px-4 py-2 bg-[var(--accent)] text-white rounded-lg font-medium hover:opacity-90 transition-opacity"
            >
              <Plus className="w-4 h-4" />
              Add Version
            </button>
          )}

      {/* New Version Form */}
      {addingNew && (
        <div className="border border-[var(--border-color)] rounded-lg p-4 bg-[var(--bg-secondary)]">
          <div className="space-y-3">
            <input
              type="text"
              placeholder="Version (e.g., 0.4)"
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
                onClick={() =>
                  saveVersion(newForm.version, newForm.title, newForm.status, [])
                }
                disabled={!newForm.version.trim() || !newForm.title.trim() || loading}
                className="flex-1 px-4 py-2 bg-[var(--accent)] text-white rounded-lg font-medium hover:opacity-90 transition-opacity disabled:opacity-50 disabled:cursor-not-allowed"
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
        </div>
      )}

          {/* Version Cards */}
          <div className="space-y-3">
            {sortedVersions.map((v) => {
                const badge = getStatusBadge(v.status);
            const progress = v.progress || { done: v.items.filter((i) => i.done).length, total: v.items.length };
            const isEditing = editingVersionId === v.id;
            const isExpanded = expandedVersionIds.has(v.id);

            return (
              <div
                key={v.id}
                className={clsx(
                  'border rounded-lg transition-colors',
                  isEditing
                    ? 'border-[var(--accent)] bg-[var(--bg-secondary)]'
                    : 'border-[var(--border-color)] hover:border-[var(--border-color)]'
                )}
              >
                {/* Card Header */}
                <div
                  className={clsx(
                    'p-4 cursor-pointer',
                    !isEditing && 'hover:bg-[var(--bg-secondary)]'
                  )}
                  onClick={() => !isEditing && setExpandedVersionIds((s) => {
                    const newSet = new Set(s);
                    newSet.has(v.id) ? newSet.delete(v.id) : newSet.add(v.id);
                    return newSet;
                  })}
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="flex-1">
                      {isEditing ? (
                        <div className="space-y-2">
                          <input
                            type="text"
                            value={editForm.title}
                            onChange={(e) => setEditForm({ ...editForm, title: e.target.value })}
                            placeholder="Version title"
                            className="w-full px-3 py-2 bg-[var(--bg-primary)] border border-[var(--border-color)] rounded-lg text-[var(--text-primary)] focus:outline-none focus:border-[var(--accent)]"
                          />
                          <select
                            value={editForm.status}
                            onChange={(e) => setEditForm({ ...editForm, status: e.target.value as any })}
                            className="w-full px-3 py-2 bg-[var(--bg-primary)] border border-[var(--border-color)] rounded-lg text-[var(--text-primary)] focus:outline-none focus:border-[var(--accent)]"
                          >
                            <option value="planned">⚪ Planned</option>
                            <option value="current">🔵 Current</option>
                            <option value="shipped">🟢 Shipped</option>
                          </select>
                        </div>
                      ) : (
                        <>
                          <div className="flex items-center gap-3">
                            <span className="font-semibold text-lg text-[var(--text-primary)]">
                              v{v.version}
                            </span>
                            <span className={clsx('px-2 py-1 rounded text-xs font-medium', badge.bgClass)}>
                              {badge.emoji} {badge.label}
                            </span>
                          </div>
                          <div className="mt-1 text-sm text-[var(--text-secondary)]">{v.title}</div>
                        </>
                      )}
                    </div>

                    {/* Control Buttons */}
                    {!isEditing ? (
                      <div className="flex gap-1 flex-shrink-0">
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            startEdit(v);
                          }}
                          className="p-2 hover:bg-[var(--bg-tertiary)] rounded-lg transition-colors"
                          title="Edit version"
                        >
                          <Pencil className="w-4 h-4 text-[var(--text-muted)]" />
                        </button>
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            deleteVersion(v.version);
                          }}
                          disabled={loading}
                          className="p-2 hover:bg-red-100 dark:hover:bg-red-950/30 rounded-lg transition-colors disabled:opacity-50"
                          title="Delete version"
                        >
                          <Trash2 className="w-4 h-4 text-red-600 dark:text-red-400" />
                        </button>
                      </div>
                    ) : null}

                    {/* Expand/Collapse Toggle */}
                    {!isEditing && (
                      <span className="text-sm text-[var(--text-muted)] flex-shrink-0">
                        {isExpanded ? '▼' : '▶'}
                      </span>
                    )}
                  </div>

                  {/* Progress Bar (View Mode) */}
                  {!isEditing && progress.total > 0 && (
                    <div className="mt-3 flex items-center gap-3">
                      <div className="flex-1 h-2 bg-[var(--bg-tertiary)] rounded-full overflow-hidden">
                        <div
                          className="h-full bg-[var(--accent)] transition-all duration-300"
                          style={{ width: `${(progress.done / progress.total) * 100}%` }}
                        />
                      </div>
                      <span className="text-xs text-[var(--text-muted)] whitespace-nowrap">
                        {progress.done}/{progress.total}
                      </span>
                    </div>
                  )}
                </div>

                {/* Expanded Content */}
                {isExpanded && (
                  <div className="border-t border-[var(--border-color)] p-4 space-y-3 bg-[var(--bg-primary)]">
                    {isEditing ? (
                      <>
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
                                  className="p-2 hover:bg-red-100 dark:hover:bg-red-950/30 rounded-lg transition-colors"
                                >
                                  <X className="w-4 h-4 text-red-600 dark:text-red-400" />
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
                            className="flex items-center gap-2 w-full px-3 py-2 text-sm border border-dashed border-[var(--border-color)] rounded-lg text-[var(--text-muted)] hover:text-[var(--text-secondary)] hover:border-[var(--border-color)] transition-colors"
                          >
                            <Plus className="w-4 h-4" />
                            Add Item
                          </button>
                        </div>

                        {/* Save/Cancel Buttons */}
                        <div className="flex gap-2 pt-3 border-t border-[var(--border-color)]">
                          <button
                            onClick={() =>
                              saveVersion(
                                editForm.version,
                                editForm.title,
                                editForm.status,
                                editForm.items.filter((i) => i.title.trim())
                              )
                            }
                            disabled={!editForm.title.trim() || loading}
                            className="flex-1 px-4 py-2 bg-[var(--accent)] text-white rounded-lg font-medium hover:opacity-90 transition-opacity disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2"
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
                        {/* Items View Mode */}
                        {v.items.length > 0 ? (
                          <div className="space-y-1 text-sm">
                            {v.items.map((item, idx) => (
                              <div
                                key={idx}
                                onClick={() => toggleItemDone(v, idx)}
                                className="flex items-start gap-2 cursor-pointer p-2 rounded hover:bg-[var(--bg-secondary)] transition-colors"
                              >
                                <input
                                  type="checkbox"
                                  checked={item.done}
                                  onChange={(e) => {
                                    e.stopPropagation();
                                    toggleItemDone(v, idx);
                                  }}
                                  className="w-4 h-4 rounded flex-shrink-0 mt-0.5"
                                />
                                <span
                                  className={clsx(
                                    'flex-1',
                                    item.done ? 'font-normal text-[var(--text-tertiary)]' : 'font-semibold text-[var(--text-primary)]'
                                  )}
                                >
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
        })}
        </div>

        {sortedVersions.length === 0 && !addingNew && (
          <p className="text-center text-[var(--text-muted)] py-8">No versions yet. Create one to get started.</p>
        )}
        </div>
      )}
    </div>
  );
}
