'use client';

import { useState, useEffect, useCallback } from 'react';
import { Plus, Check, Loader, ExternalLink } from 'lucide-react';
import { clsx } from 'clsx';

interface RoadmapItem {
  id?: string;
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
  version_type?: string;
}

interface CreateTaskDialogProps {
  item: RoadmapItem;
  version: string;
  projectId: string;
  teammates: string[];
  onCreated: (taskId: string) => void;
  onCancel: () => void;
}

function CreateTaskDialog({ item, version, projectId, teammates, onCreated, onCancel }: CreateTaskDialogProps) {
  const [title, setTitle] = useState(item.title || '');
  const [assignee, setAssignee] = useState(teammates[0] || '');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSave = async () => {
    setSaving(true);
    setError(null);
    try {
      const res = await fetch('/api/store', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'addTask',
          task: {
            title,
            version,
            roadmapItemId: item.id,
            projectId,
            assignee,
            status: 'backlog',
            taskType: 'feature',
          },
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || 'Failed to create task');
        return;
      }
      onCreated(data.task?.id || '');
    } catch (e: any) {
      setError(e?.message || 'Network error');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50" onClick={onCancel}>
      <div className="bg-[var(--bg-primary)] border border-[var(--border-default)] rounded-lg shadow-2xl w-full max-w-md mx-4 p-5" onClick={e => e.stopPropagation()}>
        <h3 className="text-sm font-bold text-[var(--text-primary)] mb-4">Create Task from Roadmap Item</h3>

        <div className="space-y-3">
          <div>
            <label className="text-xs font-semibold text-[var(--text-muted)] mb-1 block">Title</label>
            <input
              value={title}
              onChange={e => setTitle(e.target.value)}
              className="w-full px-3 py-2 bg-[var(--bg-secondary)] border border-[var(--border-default)] rounded-md text-sm text-[var(--text-primary)] outline-none focus:border-[var(--accent)]"
            />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-xs font-semibold text-[var(--text-muted)] mb-1 block">Version</label>
              <input
                value={`${version}`}
                readOnly
                className="w-full px-3 py-2 bg-[var(--bg-tertiary)] border border-[var(--border-default)] rounded-md text-sm text-[var(--text-muted)] cursor-not-allowed"
              />
            </div>
            <div>
              <label className="text-xs font-semibold text-[var(--text-muted)] mb-1 block">Assignee</label>
              <select
                value={assignee}
                onChange={e => setAssignee(e.target.value)}
                className="w-full px-3 py-2 bg-[var(--bg-secondary)] border border-[var(--border-default)] rounded-md text-sm text-[var(--text-primary)] outline-none focus:border-[var(--accent)]"
              >
                {teammates.map(t => <option key={t} value={t}>{t}</option>)}
              </select>
            </div>
          </div>

          {error && (
            <p className="text-xs text-red-400 bg-red-500/10 px-3 py-2 rounded">{error}</p>
          )}
        </div>

        <div className="flex items-center justify-end gap-3 mt-5">
          <button onClick={onCancel} className="px-3 py-1.5 text-sm text-[var(--text-muted)] hover:text-[var(--text-primary)]">
            Cancel
          </button>
          <button
            onClick={handleSave}
            disabled={saving || !title.trim()}
            className="px-4 py-2 rounded-md bg-[var(--accent)] text-white text-sm font-medium hover:opacity-90 disabled:opacity-40 flex items-center gap-2"
          >
            {saving ? <Loader size={14} className="animate-spin" /> : <Plus size={14} />}
            Create Task
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * RoadmapTaskCreator — shows roadmap items from the API with "Create task" buttons
 * for unshipped items without a linked taskId.
 */
export default function RoadmapTaskCreator({
  projectId,
  teammates,
}: {
  projectId: string;
  teammates: string[];
}) {
  const [versions, setVersions] = useState<RoadmapVersion[]>([]);
  const [loading, setLoading] = useState(true);
  const [creatingFor, setCreatingFor] = useState<{ item: RoadmapItem; version: string } | null>(null);
  const [mintingItemKey, setMintingItemKey] = useState<string | null>(null);

  const fetchRoadmap = useCallback(async () => {
    try {
      const res = await fetch(`/api/roadmap/${projectId}`);
      if (res.ok) {
        const data = await res.json();
        setVersions(data.versions || []);
      }
    } catch (e) {
      console.error('Failed to fetch roadmap:', e);
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => {
    fetchRoadmap();
  }, [fetchRoadmap]);

  // Filter to non-shipped versions with at least one open item
  const actionableVersions = versions.filter(v =>
    v.status !== 'shipped' &&
    v.items.some(item => !item.taskId && !item.done)
  );

  // Lazy id mint: items without an id get one assigned + persisted on first Create-task click.
  const mintIdAndOpen = useCallback(async (item: RoadmapItem, ver: RoadmapVersion, idx: number) => {
    const key = `${ver.id}:${idx}`;
    setMintingItemKey(key);
    try {
      const newId = `item-${Math.random().toString(36).slice(2, 10)}-${Date.now().toString(36)}`;
      const updatedItems = ver.items.map((it, i) => (i === idx ? { ...it, id: newId } : it));
      const res = await fetch(`/api/roadmap/${projectId}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'upsert',
          version: ver.version,
          title: ver.title,
          status: ver.status,
          items: updatedItems,
          versionType: ver.version_type,
        }),
      });
      if (!res.ok) {
        console.error('Failed to mint roadmap item id');
        setMintingItemKey(null);
        return;
      }
      setVersions(prev => prev.map(v => v.id === ver.id ? { ...v, items: updatedItems } : v));
      setCreatingFor({ item: { ...item, id: newId }, version: ver.version });
    } catch (e) {
      console.error('mintIdAndOpen failed', e);
    } finally {
      setMintingItemKey(null);
    }
  }, [projectId]);

  if (loading) return null;
  if (actionableVersions.length === 0) return null;

  return (
    <div className="border border-[var(--accent)]/20 bg-[var(--accent)]/5 rounded-lg p-4 mt-4">
      <h3 className="text-sm font-bold text-[var(--text-primary)] mb-3 flex items-center gap-2">
        <Plus size={14} className="text-[var(--accent)]" />
        Create Tasks from Roadmap
      </h3>

      {actionableVersions.map(ver => (
        <div key={ver.id} className="mb-3 last:mb-0">
          <p className="text-xs font-semibold text-[var(--text-muted)] mb-2">v{ver.version}</p>
          <div className="space-y-1.5">
            {ver.items.map((item, idx) => {
              const hasTask = !!item.taskId;
              const isShipped = item.done;
              const itemKey = `${ver.id}:${idx}`;
              const isMinting = mintingItemKey === itemKey;

              return (
                <div key={item.id || itemKey} className="flex items-center gap-2 text-sm">
                  <input type="checkbox" checked={item.done} readOnly className="mt-0" />
                  <span className={clsx('flex-1', item.done && 'line-through text-[var(--text-muted)]')}>
                    {item.title}
                  </span>
                  {hasTask ? (
                    <span className="text-[10px] text-[var(--success)] flex items-center gap-1">
                      <Check size={12} /> task created
                    </span>
                  ) : !isShipped ? (
                    <button
                      onClick={() => item.id
                        ? setCreatingFor({ item, version: ver.version })
                        : mintIdAndOpen(item, ver, idx)
                      }
                      disabled={isMinting}
                      className="text-[10px] px-2 py-1 rounded bg-[var(--accent)] text-white hover:opacity-90 transition-opacity flex items-center gap-1 disabled:opacity-50"
                    >
                      {isMinting ? <Loader size={10} className="animate-spin" /> : <Plus size={10} />}
                      {isMinting ? 'Preparing…' : 'Create task'}
                    </button>
                  ) : null}
                </div>
              );
            })}
          </div>
        </div>
      ))}

      {creatingFor && (
        <CreateTaskDialog
          item={creatingFor.item}
          version={creatingFor.version}
          projectId={projectId}
          teammates={teammates}
          onCreated={() => {
            setCreatingFor(null);
            fetchRoadmap(); // refresh to show "task created"
          }}
          onCancel={() => setCreatingFor(null)}
        />
      )}
    </div>
  );
}
