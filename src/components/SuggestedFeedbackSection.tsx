'use client';

import { useEffect, useState, useMemo } from 'react';
import { clsx } from 'clsx';
import { AlertCircle, CheckCircle2 } from 'lucide-react';

interface Signal {
  id: string;
  agentId: string;
  agentName: string;
  type: 'kudos' | 'flag';
  values: string[];
  note: string;
  evidence: string;
  taskId?: string;
  projectId?: string;
  detectedAt: number;
}

interface SuggestedFeedbackSectionProps {
  // No props needed - fetches its own data
}

export function SuggestedFeedbackSection({}: SuggestedFeedbackSectionProps) {
  const [signals, setSignals] = useState<Signal[]>([]);
  const [loading, setLoading] = useState(true);
  const [actioningId, setActioningId] = useState<string | null>(null);

  const fetchSignals = async () => {
    try {
      const response = await fetch('/api/signals');
      if (response.ok) {
        const data = await response.json();
        setSignals(data.signals || []);
      }
    } catch (err) {
      console.error('Failed to fetch signals:', err);
    } finally {
      setLoading(false);
    }
  };

  // Fetch once on mount — no polling interval
  useEffect(() => {
    fetchSignals();
  }, []);

  const handleConfirm = async (signalId: string) => {
    setActioningId(signalId);
    try {
      const response = await fetch('/api/signals', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'confirm', signalId }),
      });
      if (response.ok) {
        setSignals(signals.filter(s => s.id !== signalId));
      }
    } catch (err) {
      console.error('Failed to confirm signal:', err);
    } finally {
      setActioningId(null);
    }
  };

  const handleDismiss = async (signalId: string) => {
    setActioningId(signalId);
    try {
      const response = await fetch('/api/signals', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'dismiss', signalId }),
      });
      if (response.ok) {
        setSignals(signals.filter(s => s.id !== signalId));
      }
    } catch (err) {
      console.error('Failed to dismiss signal:', err);
    } finally {
      setActioningId(null);
    }
  };

  if (loading || signals.length === 0) {
    return null;
  }

  return (
    <div>
      <h2 className="text-[var(--text-md)] font-semibold text-[var(--text-primary)] mb-3">
        💡 Suggested Feedback
      </h2>
      <p className="text-[var(--text-xs)] text-[var(--text-muted)] mb-3">
        {signals.length} signal{signals.length !== 1 ? 's' : ''} detected — review and confirm
      </p>
      <div className="space-y-3">
        {signals.map((signal) => (
          <div
            key={signal.id}
            className={clsx(
              'p-4 rounded-[var(--radius-md)] border-l-4 bg-[var(--card)]',
              signal.type === 'kudos'
                ? 'border-l-[var(--success)] bg-gradient-to-r from-[rgba(34,197,94,0.03)] to-transparent'
                : 'border-l-[var(--warning)] bg-gradient-to-r from-[rgba(251,146,60,0.03)] to-transparent'
            )}
          >
            {/* Header: Icon + Note + Values */}
            <div className="flex items-start gap-3 mb-2">
              <span className="flex-shrink-0 text-lg">
                {signal.type === 'kudos' ? '⭐' : '🚩'}
              </span>
              <div className="flex-1 min-w-0">
                <p className="text-[var(--text-sm)] font-semibold text-[var(--text-primary)] mb-2">
                  {signal.note}
                </p>
                <div className="flex flex-wrap gap-1.5 mb-2">
                  {signal.values.map((value) => (
                    <span
                      key={value}
                      className="inline-block px-2 py-1 text-[var(--text-xs)] font-medium rounded-full bg-[var(--bg-tertiary)] text-[var(--text-secondary)]"
                    >
                      #{value}
                    </span>
                  ))}
                </div>
              </div>
            </div>

            {/* Evidence */}
            <p className="text-[var(--text-xs)] text-[var(--text-muted)] mb-3 ml-7">
              evidence: {signal.evidence}
            </p>

            {/* Actions */}
            <div className="flex gap-2 ml-7">
              <button
                onClick={() => handleConfirm(signal.id)}
                disabled={actioningId !== null}
                className={clsx(
                  'px-3 py-1.5 text-[var(--text-xs)] font-medium rounded-[var(--radius-sm)] transition-all',
                  signal.type === 'kudos'
                    ? 'bg-[var(--success)] text-white hover:opacity-90'
                    : 'bg-[var(--warning)] text-white hover:opacity-90',
                  actioningId !== null && 'opacity-50 cursor-not-allowed'
                )}
              >
                {actioningId === signal.id ? 'Confirming...' : 'Confirm'}
              </button>
              <button
                onClick={() => handleDismiss(signal.id)}
                disabled={actioningId !== null}
                className={clsx(
                  'px-3 py-1.5 text-[var(--text-xs)] font-medium rounded-[var(--radius-sm)] bg-[var(--bg-tertiary)] text-[var(--text-secondary)] hover:bg-[var(--bg-secondary)] transition-all',
                  actioningId !== null && 'opacity-50 cursor-not-allowed'
                )}
              >
                Dismiss
              </button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
