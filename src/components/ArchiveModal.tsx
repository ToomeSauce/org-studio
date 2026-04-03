'use client';

import { type Task, unarchiveTask, permanentlyDeleteTask, getArchivedTasks } from '@/lib/store';
import { Archive, Trash2, RotateCcw, X } from 'lucide-react';
import { useState, useMemo } from 'react';
import { toast } from 'react-toastify';
import { clsx } from 'clsx';

export function ArchiveModal({ onClose, projects }: { onClose: () => void; projects: any[] }) {
  const archivedTasks = getArchivedTasks();
  const [searchQuery, setSearchQuery] = useState('');

  const filteredArchived = useMemo(() => {
    if (!searchQuery.trim()) return archivedTasks;
    const q = searchQuery.toLowerCase();
    return archivedTasks.filter(t =>
      t.title.toLowerCase().includes(q) ||
      t.ticketNumber?.toString().includes(q) ||
      t.assignee.toLowerCase().includes(q)
    );
  }, [archivedTasks, searchQuery]);

  const handleUnarchive = async (taskId: string) => {
    try {
      await unarchiveTask(taskId);
      toast.success('Task restored to active board');
    } catch (e: any) {
      toast.error(`Failed to restore: ${e.message}`);
    }
  };

  const handlePermanentlyDelete = async (taskId: string, taskTitle: string) => {
    if (!confirm(`Permanently delete "${taskTitle}"? This cannot be undone.`)) {
      return;
    }
    try {
      await permanentlyDeleteTask(taskId);
      toast.success('Task permanently deleted');
    } catch (e: any) {
      toast.error(`Failed to delete: ${e.message}`);
    }
  };

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
      <div className="bg-[var(--bg-primary)] rounded-lg shadow-lg max-w-2xl w-full max-h-[80vh] flex flex-col mx-4">
        {/* Header */}
        <div className="flex items-center justify-between p-6 border-b border-[var(--border-default)]">
          <div className="flex items-center gap-2">
            <Archive size={20} className="text-[var(--accent-primary)]" />
            <h2 className="text-lg font-semibold text-[var(--text-primary)]">Archived Tasks</h2>
            <span className="text-sm text-[var(--text-muted)] ml-auto">{filteredArchived.length} archived</span>
          </div>
          <button
            onClick={onClose}
            className="p-1 rounded hover:bg-[var(--bg-hover)] text-[var(--text-muted)] transition-colors"
          >
            <X size={18} />
          </button>
        </div>

        {/* Search */}
        <div className="p-4 border-b border-[var(--border-default)]">
          <input
            type="text"
            placeholder="Search by title, ticket #, or assignee..."
            value={searchQuery}
            onChange={e => setSearchQuery(e.target.value)}
            className="w-full px-3 py-2 bg-[var(--bg-secondary)] border border-[var(--border-default)] rounded-md text-[var(--text-sm)] text-[var(--text-primary)] placeholder-[var(--text-muted)] outline-none focus:border-[var(--accent-primary)] transition-colors"
          />
        </div>

        {/* Task List */}
        <div className="flex-1 overflow-y-auto">
          {filteredArchived.length === 0 ? (
            <div className="p-6 text-center">
              <Archive size={32} className="text-[var(--text-muted)] mx-auto mb-2 opacity-50" />
              <p className="text-[var(--text-muted)]">
                {archivedTasks.length === 0
                  ? 'No archived tasks yet'
                  : 'No matches found'}
              </p>
            </div>
          ) : (
            <div className="divide-y divide-[var(--border-subtle)]">
              {filteredArchived.map(task => {
                const proj = projects.find(p => p.id === task.projectId);
                const archivedDate = task.archivedAt
                  ? new Date(task.archivedAt).toLocaleDateString()
                  : 'unknown';

                return (
                  <div key={task.id} className="p-4 hover:bg-[var(--bg-secondary)] transition-colors">
                    <div className="flex items-start justify-between gap-4 mb-2">
                      <div className="flex-1">
                        <div className="flex items-center gap-2 mb-1">
                          {task.ticketNumber && (
                            <span className="text-[10px] font-semibold bg-[var(--accent-primary)]/10 text-[var(--accent-primary)] px-2 py-0.5 rounded">
                              #{task.ticketNumber}
                            </span>
                          )}
                          {proj && (
                            <span className="text-[10px] font-semibold uppercase tracking-wide text-[var(--text-muted)]">
                              {proj.name}
                            </span>
                          )}
                        </div>
                        <p className="text-[var(--text-sm)] font-medium text-[var(--text-primary)] mb-1">
                          {task.title}
                        </p>
                        <div className="flex items-center gap-2 text-[var(--text-xs)] text-[var(--text-muted)]">
                          <span>{task.assignee}</span>
                          <span>·</span>
                          <span>Archived {archivedDate}</span>
                          {task.archivedBy && task.archivedBy !== 'unknown' && (
                            <>
                              <span>·</span>
                              <span>by {task.archivedBy}</span>
                            </>
                          )}
                        </div>
                      </div>
                    </div>

                    {/* Action Buttons */}
                    <div className="flex items-center gap-2 mt-3">
                      <button
                        onClick={() => handleUnarchive(task.id)}
                        className="flex items-center gap-1.5 px-3 py-1.5 bg-[var(--info)]/10 text-[var(--info)] hover:bg-[var(--info)]/20 rounded text-[var(--text-xs)] font-medium transition-colors"
                      >
                        <RotateCcw size={12} />
                        Restore
                      </button>
                      <button
                        onClick={() => handlePermanentlyDelete(task.id, task.title)}
                        className="flex items-center gap-1.5 px-3 py-1.5 bg-[var(--error)]/10 text-[var(--error)] hover:bg-[var(--error)]/20 rounded text-[var(--text-xs)] font-medium transition-colors"
                      >
                        <Trash2 size={12} />
                        Delete Forever
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
