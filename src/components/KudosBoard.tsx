'use client';

import { useEffect, useState } from 'react';
import { clsx } from 'clsx';
import { Trash2, Pencil, Check, X } from 'lucide-react';
import { toast } from 'react-toastify';

interface Kudos {
  id: string;
  agentId: string;
  givenBy: string;
  taskId?: string;
  projectId?: string;
  values: string[];
  note: string;
  type: 'kudos' | 'flag';
  autoDetected: boolean;
  confirmed: boolean;
  createdAt: number;
}

const VALUE_COLORS: Record<string, { bg: string; text: string }> = {
  'people-first': { bg: 'bg-red-500/10', text: 'text-red-500' },
  autonomy: { bg: 'bg-orange-500/10', text: 'text-orange-500' },
  curiosity: { bg: 'bg-cyan-500/10', text: 'text-cyan-500' },
  teamwork: { bg: 'bg-emerald-500/10', text: 'text-emerald-500' },
};

function formatTime(timestamp: number): string {
  const now = Date.now();
  const diff = now - timestamp;
  const days = Math.floor(diff / (24 * 60 * 60 * 1000));
  if (days === 0) return 'today';
  if (days === 1) return '1d ago';
  if (days < 7) return `${days}d ago`;
  const weeks = Math.floor(days / 7);
  if (weeks === 1) return '1w ago';
  return `${weeks}w ago`;
}

export function KudosBoard() {
  const [kudos, setKudos] = useState<Kudos[]>([]);
  const [loading, setLoading] = useState(true);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editNote, setEditNote] = useState('');

  useEffect(() => {
    async function load() {
      try {
        const res = await fetch('/api/kudos?limit=10');
        const data = await res.json();
        setKudos(data.kudos || []);
      } catch (err) {
        console.error('Failed to load kudos:', err);
      } finally {
        setLoading(false);
      }
    }
    load();
  }, []);

  const handleDelete = async (id: string) => {
    try {
      const res = await fetch('/api/kudos', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'delete', id }),
      });

      if (res.ok) {
        setKudos(kudos.filter(k => k.id !== id));
        toast.success('Kudos deleted');
      } else {
        toast.error('Failed to delete kudos');
      }
    } catch (err) {
      console.error('Error deleting kudos:', err);
      toast.error('Failed to delete kudos');
    }
  };

  const handleEditStart = (item: Kudos) => {
    setEditingId(item.id);
    setEditNote(item.note);
  };

  const handleEditSave = async (id: string, k: Kudos) => {
    try {
      const res = await fetch('/api/kudos', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'update',
          id,
          note: editNote,
          values: k.values,
        }),
      });

      if (res.ok) {
        setKudos(kudos.map(item => 
          item.id === id ? { ...item, note: editNote } : item
        ));
        setEditingId(null);
        setEditNote('');
      } else {
        alert('Failed to update kudos');
      }
    } catch (err) {
      console.error('Error updating kudos:', err);
      alert('Error updating kudos');
    }
  };

  const handleEditCancel = () => {
    setEditingId(null);
    setEditNote('');
  };

  if (loading) {
    return (
      <div className="bg-[var(--card)] border border-[var(--border-default)] rounded-[var(--radius-lg)] p-8 text-center">
        <p className="text-[var(--text-muted)]">Loading kudos board...</p>
      </div>
    );
  }

  if (kudos.length === 0) {
    return (
      <div className="bg-[var(--card)] border border-[var(--border-default)] rounded-[var(--radius-lg)] p-8 text-center">
        <p className="text-[var(--text-muted)] text-[var(--text-sm)]">
          No kudos yet. Be the first to give some! 🚀
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {kudos.map(k => (
        <div
          key={k.id}
          className={clsx(
            'bg-[var(--card)] border-l-4 rounded-[var(--radius-md)] p-4',
            k.type === 'kudos'
              ? 'border-l-emerald-500 bg-emerald-500/5'
              : 'border-l-amber-500 bg-amber-500/5'
          )}
        >
          <div className="flex items-start gap-3">
            <span className="text-xl mt-0.5">{k.type === 'kudos' ? '⭐' : '🚩'}</span>
            <div className="flex-1 min-w-0">
              <p className="text-[var(--text-sm)] font-semibold text-[var(--text-primary)] mb-1">
                {k.agentId} {k.type === 'flag' ? '(flag)' : ''}
              </p>
              {editingId === k.id ? (
                <div className="space-y-2 mb-2">
                  <textarea
                    value={editNote}
                    onChange={(e) => setEditNote(e.target.value)}
                    className="w-full px-3 py-2 bg-[var(--bg-primary)] border border-[var(--border-color)] rounded-lg text-[var(--text-primary)] placeholder-[var(--text-muted)] focus:outline-none focus:border-[var(--accent)] text-sm"
                    rows={3}
                  />
                  <div className="flex gap-2">
                    <button
                      onClick={() => handleEditSave(k.id, k)}
                      className="flex items-center gap-1.5 px-3 py-1.5 bg-[var(--accent)] text-white rounded-lg text-sm font-medium hover:opacity-90 transition-opacity"
                    >
                      <Check size={14} />
                      Save
                    </button>
                    <button
                      onClick={handleEditCancel}
                      className="flex items-center gap-1.5 px-3 py-1.5 bg-[var(--bg-tertiary)] text-[var(--text-secondary)] rounded-lg text-sm font-medium hover:bg-[var(--bg-hover)] transition-colors"
                    >
                      <X size={14} />
                      Cancel
                    </button>
                  </div>
                </div>
              ) : (
                <p className="text-[var(--text-sm)] text-[var(--text-tertiary)] mb-2 leading-relaxed">
                  "{k.note}"
                </p>
              )}
              <div className="flex flex-wrap gap-1.5 mb-2">
                {k.values.map(v => {
                  const colors = VALUE_COLORS[v] || VALUE_COLORS.autonomy;
                  return (
                    <span
                      key={v}
                      className={clsx(
                        'inline-block px-2 py-0.5 rounded-full text-[10px] font-semibold',
                        colors.bg,
                        colors.text
                      )}
                    >
                      #{v}
                    </span>
                  );
                })}
              </div>
              <p className="text-[var(--text-xs)] text-[var(--text-muted)]">
                {k.givenBy}, {formatTime(k.createdAt)}
              </p>
            </div>
            {editingId !== k.id && (
              <div className="flex gap-1.5 flex-shrink-0">
                <button
                  onClick={() => handleEditStart(k)}
                  className="p-2 hover:bg-[var(--bg-tertiary)] rounded-lg transition-colors"
                  title="Edit kudos"
                >
                  <Pencil size={16} className="text-[var(--text-muted)]" />
                </button>
                <button
                  onClick={() => handleDelete(k.id)}
                  className="p-2 hover:bg-red-100 dark:hover:bg-red-950/30 rounded-lg transition-colors"
                  title="Delete kudos"
                >
                  <Trash2 size={16} className="text-red-600 dark:text-red-400" />
                </button>
              </div>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}
