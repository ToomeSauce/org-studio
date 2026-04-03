'use client';

import { useState } from 'react';
import { X, Send } from 'lucide-react';
import { clsx } from 'clsx';

export interface GiveKudosModalProps {
  isOpen: boolean;
  onClose: () => void;
  prefilledAgent?: string;
  prefilledTask?: { id: string; title: string };
  onSubmit: (data: {
    agentId: string;
    givenBy: string;
    type: 'kudos' | 'flag';
    values: string[];
    note: string;
    taskId?: string;
  }) => Promise<void>;
}

const PACT_VALUES = [
  { id: 'people-first', label: 'People-First', icon: '📣' },
  { id: 'autonomy', label: 'Autonomy', icon: '🔥' },
  { id: 'curiosity', label: 'Curiosity', icon: '🔍' },
  { id: 'teamwork', label: 'Teamwork', icon: '🤝' },
];

export function GiveKudosModal({
  isOpen,
  onClose,
  prefilledAgent,
  prefilledTask,
  onSubmit,
}: GiveKudosModalProps) {
  const [agentId, setAgentId] = useState(prefilledAgent || '');
  const [givenBy, setGivenBy] = useState('');
  const [type, setType] = useState<'kudos' | 'flag'>('kudos');
  const [selectedValues, setSelectedValues] = useState<string[]>([]);
  const [note, setNote] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState('');

  const toggleValue = (valueId: string) => {
    setSelectedValues(prev =>
      prev.includes(valueId) ? prev.filter(v => v !== valueId) : [...prev, valueId]
    );
  };

  const handleSubmit = async () => {
    setError('');

    if (!agentId.trim()) {
      setError('Please select or enter an agent name');
      return;
    }
    if (!note.trim()) {
      setError('Please provide a note');
      return;
    }
    if (selectedValues.length === 0) {
      setError('Please select at least one value');
      return;
    }

    setIsSubmitting(true);
    try {
      await onSubmit({
        agentId: agentId.trim(),
        givenBy: givenBy.trim(),
        type,
        values: selectedValues,
        note: note.trim(),
        taskId: prefilledTask?.id,
      });
      // Clear form on success
      setAgentId(prefilledAgent || '');
      setSelectedValues([]);
      setNote('');
      onClose();
    } catch (err) {
      setError((err as any).message || 'Failed to submit');
    } finally {
      setIsSubmitting(false);
    }
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
      <div className="bg-[var(--card)] border border-[var(--border-strong)] rounded-[var(--radius-lg)] w-full max-w-md shadow-lg">
        {/* Header */}
        <div className="flex items-center justify-between p-5 border-b border-[var(--border-default)]">
          <h2 className="text-[var(--text-md)] font-bold text-[var(--text-primary)]">
            {type === 'kudos' ? '⭐ Give Kudos' : '🚩 Give Flag'}
          </h2>
          <button
            onClick={onClose}
            className="text-[var(--text-muted)] hover:text-[var(--text-primary)] transition-colors"
          >
            <X size={18} />
          </button>
        </div>

        {/* Body */}
        <div className="p-5 space-y-4">
          {/* Agent */}
          <div>
            <label className="block text-[var(--text-xs)] font-semibold text-[var(--text-muted)] mb-1.5">
              Agent
            </label>
            <input
              type="text"
              value={agentId}
              onChange={e => setAgentId(e.target.value)}
              placeholder="e.g. Alex, Riley, Jordan..."
              className="w-full bg-[var(--bg-secondary)] border border-[var(--border-strong)] rounded-[var(--radius-md)] px-3 py-2 text-[var(--text-sm)] text-[var(--text-primary)] placeholder-[var(--text-muted)] focus:outline-none focus:border-[var(--accent-primary)] focus:ring-1 focus:ring-[var(--accent-primary)]"
            />
          </div>

          {/* Given By */}
          <div>
            <label className="block text-[var(--text-xs)] font-semibold text-[var(--text-muted)] mb-1.5">
              From (optional)
            </label>
            <input
              type="text"
              value={givenBy}
              onChange={e => setGivenBy(e.target.value)}
              placeholder="Your name"
              className="w-full bg-[var(--bg-secondary)] border border-[var(--border-strong)] rounded-[var(--radius-md)] px-3 py-2 text-[var(--text-sm)] text-[var(--text-primary)] placeholder-[var(--text-muted)] focus:outline-none focus:border-[var(--accent-primary)] focus:ring-1 focus:ring-[var(--accent-primary)]"
            />
          </div>

          {/* Type Toggle */}
          <div>
            <label className="block text-[var(--text-xs)] font-semibold text-[var(--text-muted)] mb-1.5">
              Type
            </label>
            <div className="flex gap-2">
              <button
                onClick={() => setType('kudos')}
                className={clsx(
                  'flex-1 px-3 py-2 rounded-[var(--radius-md)] font-medium text-[var(--text-sm)] transition-colors',
                  type === 'kudos'
                    ? 'bg-[var(--success-subtle)] text-[var(--success)] border border-[var(--success)]'
                    : 'bg-[var(--bg-secondary)] text-[var(--text-muted)] border border-[var(--border-strong)] hover:text-[var(--text-primary)]'
                )}
              >
                ⭐ Kudos
              </button>
              <button
                onClick={() => setType('flag')}
                className={clsx(
                  'flex-1 px-3 py-2 rounded-[var(--radius-md)] font-medium text-[var(--text-sm)] transition-colors',
                  type === 'flag'
                    ? 'bg-amber-500/15 text-amber-500 border border-amber-500/30'
                    : 'bg-[var(--bg-secondary)] text-[var(--text-muted)] border border-[var(--border-strong)] hover:text-[var(--text-primary)]'
                )}
              >
                🚩 Flag
              </button>
            </div>
          </div>

          {/* Values */}
          <div>
            <label className="block text-[var(--text-xs)] font-semibold text-[var(--text-muted)] mb-2">
              Values
            </label>
            <div className="grid grid-cols-2 gap-2">
              {PACT_VALUES.map(value => (
                <button
                  key={value.id}
                  onClick={() => toggleValue(value.id)}
                  className={clsx(
                    'px-3 py-2 rounded-[var(--radius-md)] text-[var(--text-xs)] font-semibold transition-all',
                    selectedValues.includes(value.id)
                      ? 'bg-[var(--accent-primary)] text-white'
                      : 'bg-[var(--bg-secondary)] text-[var(--text-muted)] border border-[var(--border-strong)] hover:text-[var(--text-primary)]'
                  )}
                >
                  {value.icon} {value.label}
                </button>
              ))}
            </div>
          </div>

          {/* Note */}
          <div>
            <label className="block text-[var(--text-xs)] font-semibold text-[var(--text-muted)] mb-1.5">
              Note (required)
            </label>
            <textarea
              value={note}
              onChange={e => setNote(e.target.value)}
              placeholder="What did they do and why does it matter?"
              rows={4}
              className="w-full bg-[var(--bg-secondary)] border border-[var(--border-strong)] rounded-[var(--radius-md)] px-3 py-2 text-[var(--text-sm)] text-[var(--text-primary)] placeholder-[var(--text-muted)] focus:outline-none focus:border-[var(--accent-primary)] focus:ring-1 focus:ring-[var(--accent-primary)] resize-none"
            />
          </div>

          {/* Task Reference */}
          {prefilledTask && (
            <div className="p-2 rounded-[var(--radius-md)] bg-[var(--bg-tertiary)] text-[var(--text-xs)] text-[var(--text-muted)]">
              Linked to: <strong>{prefilledTask.title}</strong>
            </div>
          )}

          {/* Error */}
          {error && (
            <div className="p-3 rounded-[var(--radius-md)] bg-red-500/10 border border-red-500/20 text-[var(--text-xs)] text-red-400">
              {error}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex gap-2 p-5 border-t border-[var(--border-default)]">
          <button
            onClick={onClose}
            disabled={isSubmitting}
            className="flex-1 px-3 py-2 rounded-[var(--radius-md)] bg-[var(--bg-secondary)] text-[var(--text-sm)] font-medium text-[var(--text-muted)] hover:text-[var(--text-primary)] transition-colors disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            onClick={handleSubmit}
            disabled={isSubmitting}
            className="flex-1 flex items-center justify-center gap-1.5 px-3 py-2 rounded-[var(--radius-md)] bg-[var(--accent-primary)] text-white text-[var(--text-sm)] font-medium hover:bg-[var(--accent-primary-hover)] transition-colors disabled:opacity-50"
          >
            <Send size={14} /> {isSubmitting ? 'Sending...' : 'Submit'}
          </button>
        </div>
      </div>
    </div>
  );
}
