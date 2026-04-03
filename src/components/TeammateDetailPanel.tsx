'use client';

import { useState, useEffect, useCallback, useMemo } from 'react';
import { X, ChevronDown, ExternalLink, Pencil, Check, Clock, Zap, Timer } from 'lucide-react';
import { clsx } from 'clsx';
import { Teammate, resolveColor } from '@/lib/teammates';
import type { AgentLoop } from '@/lib/store';
import Link from 'next/link';

// --- Status badge colors (matches context board) ---
const STATUS_STYLES: Record<string, { bg: string; text: string; label: string }> = {
  'planning': { bg: 'bg-indigo-500/15', text: 'text-indigo-400', label: 'Planning' },
  'backlog': { bg: 'bg-zinc-500/15', text: 'text-zinc-400', label: 'Backlog' },
  'in-progress': { bg: 'bg-[var(--warning-subtle)]', text: 'text-[var(--warning)]', label: 'In Progress' },
  'review': { bg: 'bg-purple-500/15', text: 'text-purple-400', label: 'Review' },
  'done': { bg: 'bg-[var(--success-subtle)]', text: 'text-[var(--success)]', label: 'Done' },
};

function StatusBadge({ status }: { status: string }) {
  const style = STATUS_STYLES[status] || STATUS_STYLES['backlog'];
  return (
    <span className={clsx('text-[10px] font-semibold px-1.5 py-0.5 rounded-full whitespace-nowrap', style.bg, style.text)}>
      {style.label}
    </span>
  );
}

function timeAgo(ts: number): string {
  const diff = Date.now() - ts;
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  const months = Math.floor(days / 30);
  return `${months}mo ago`;
}

function timeSince(ts: number): string {
  const diff = Date.now() - ts;
  const mins = Math.floor(diff / 60000);
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  return `${days}d`;
}

// --- Collapsible Section ---
function Section({ title, defaultOpen = true, children }: { title: string; defaultOpen?: boolean; children: React.ReactNode }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="border-t border-[var(--border-default)]">
      <button
        onClick={() => setOpen(!open)}
        className="w-full flex items-center justify-between py-3 px-5 text-left hover:bg-[var(--bg-hover)] transition-colors"
      >
        <span className="text-[var(--text-sm)] font-semibold text-[var(--text-secondary)] uppercase tracking-wider">
          {title}
        </span>
        <ChevronDown
          size={14}
          className={clsx(
            'text-[var(--text-muted)] transition-transform duration-200',
            open ? 'rotate-0' : '-rotate-90'
          )}
        />
      </button>
      <div
        className={clsx(
          'overflow-hidden transition-all duration-200',
          open ? 'max-h-[2000px] opacity-100' : 'max-h-0 opacity-0'
        )}
      >
        <div className="px-5 pb-4">
          {children}
        </div>
      </div>
    </div>
  );
}

// --- Main Panel ---
interface TeammateDetailPanelProps {
  teammate: Teammate;
  isActive: boolean;
  activityStatus?: { status: string; detail?: string };
  overrides?: { title?: string; domain?: string; owns?: string; defers?: string; description?: string };
  tasks: any[];
  projects: any[];
  loops: AgentLoop[];
  isDisconnected?: boolean;
  onClose: () => void;
  onSave: (id: string, updates: { title?: string; domain?: string; owns?: string; defers?: string; description?: string }) => void;
  onUpdateTeammate: (id: string, updates: Partial<Teammate>) => void;
}

export default function TeammateDetailPanel({
  teammate,
  isActive,
  activityStatus,
  overrides,
  tasks: allTasks,
  projects,
  loops,
  isDisconnected,
  onClose,
  onSave,
  onUpdateTeammate,
}: TeammateDetailPanelProps) {
  const colors = resolveColor(teammate.color);

  const displayTitle = overrides?.title || teammate.title;
  const displayDomain = overrides?.domain || teammate.domain;
  const displayOwns = overrides?.owns || teammate.owns || '';
  const displayDefers = overrides?.defers || teammate.defers || '';
  const displayDesc = overrides?.description || teammate.description;

  // Escape key handler
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [onClose]);

  // --- Tasks for this teammate ---
  const myTasks = useMemo(
    () => allTasks.filter(t => t.assignee === teammate.name),
    [allTasks, teammate.name]
  );

  const projectMap = useMemo(() => {
    const m: Record<string, string> = {};
    for (const p of projects) m[p.id] = p.name;
    return m;
  }, [projects]);

  // Group by status in display order, limit 5 per group
  const taskGroups = useMemo(() => {
    const order = ['in-progress', 'backlog', 'review', 'done', 'planning'] as const;
    const groups: { status: string; label: string; tasks: any[] }[] = [];
    for (const s of order) {
      const style = STATUS_STYLES[s];
      const tasksForStatus = myTasks
        .filter(t => t.status === s)
        .sort((a: any, b: any) => (b.createdAt || 0) - (a.createdAt || 0))
        .slice(0, 5);
      if (tasksForStatus.length > 0) {
        groups.push({ status: s, label: style?.label || s, tasks: tasksForStatus });
      }
    }
    return groups;
  }, [myTasks]);

  // --- Loop for this teammate ---
  const loop = useMemo(
    () => loops.find(l => l.agentId === teammate.agentId),
    [loops, teammate.agentId]
  );

  // --- Recent Activity (from statusHistory) ---
  const recentActivity = useMemo(() => {
    const entries: { taskTitle: string; status: string; timestamp: number }[] = [];
    for (const t of myTasks) {
      if (t.statusHistory && Array.isArray(t.statusHistory)) {
        for (const h of t.statusHistory) {
          entries.push({ taskTitle: t.title, status: h.status, timestamp: h.timestamp });
        }
      }
    }
    return entries
      .sort((a, b) => b.timestamp - a.timestamp)
      .slice(0, 10);
  }, [myTasks]);

  // --- Domains edit mode ---
  const [editingDomains, setEditingDomains] = useState(false);
  const [domainDraft, setDomainDraft] = useState({ owns: '', defers: '' });

  const startDomainEdit = () => {
    setDomainDraft({ owns: displayOwns, defers: displayDefers });
    setEditingDomains(true);
  };

  const saveDomainEdit = () => {
    const saveId = teammate.agentId || teammate.id;
    onSave(saveId, { owns: domainDraft.owns, defers: domainDraft.defers });
    setEditingDomains(false);
  };

  // Get last status change timestamp for a task
  const getTimeInStatus = (task: any): string => {
    if (task.statusHistory && Array.isArray(task.statusHistory) && task.statusHistory.length > 0) {
      const last = task.statusHistory[task.statusHistory.length - 1];
      return timeSince(last.timestamp);
    }
    return timeSince(task.createdAt);
  };

  return (
    <div className="fixed inset-0 z-50 flex justify-end" onClick={onClose}>
      <div className="absolute inset-0 bg-black/40 backdrop-blur-sm" />
      <div
        className="relative w-full max-w-lg h-full bg-[var(--bg-primary)] border-l border-[var(--border-default)] shadow-[var(--shadow-lg)] flex flex-col overflow-hidden"
        onClick={e => e.stopPropagation()}
      >
        {/* Header */}
        <div className="px-5 py-5 border-b border-[var(--border-default)] shrink-0">
          <div className="flex items-start gap-4">
            <div
              className={clsx(
                'w-14 h-14 rounded-full flex items-center justify-center text-2xl shrink-0 overflow-hidden',
                colors.bg,
              )}
            >
              {teammate.avatar
                ? <img src={teammate.avatar} alt="" className="w-full h-full object-cover rounded-full" />
                : teammate.emoji}
            </div>
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2.5">
                <h2 className="text-[var(--text-lg)] font-bold text-[var(--text-primary)] tracking-tight">
                  {teammate.name}
                </h2>
                {teammate.isHuman && (
                  <>
                    <span className="text-sm" title="Human">👤</span>
                    <div className="w-2.5 h-2.5 rounded-full bg-[var(--success)] shadow-[0_0_8px_rgba(52,211,153,0.5)]" />
                  </>
                )}
                {!teammate.isHuman && !isDisconnected && (
                  <>
                    <div className={clsx(
                      'w-2.5 h-2.5 rounded-full',
                      isActive ? 'bg-[var(--success)] shadow-[0_0_8px_rgba(52,211,153,0.5)]' : 'bg-zinc-600'
                    )} />
                    <span className={clsx(
                      'text-[10px] font-semibold px-1.5 py-0.5 rounded-full',
                      isActive
                        ? 'bg-[var(--success-subtle)] text-[var(--success)]'
                        : 'bg-[var(--bg-tertiary)] text-[var(--text-muted)]'
                    )}>
                      {isActive ? 'ACTIVE' : 'IDLE'}
                    </span>
                  </>
                )}
                {!teammate.isHuman && isDisconnected && (
                  <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded-full bg-amber-400/10 text-amber-400 border border-amber-400/20">
                    DISCONNECTED
                  </span>
                )}
              </div>
              <p className={clsx('text-[var(--text-base)] font-bold mt-0.5', colors.text)}>
                {displayDomain}
              </p>
              <p className="text-[var(--text-xs)] text-[var(--text-muted)] mt-0.5">
                {displayTitle}
              </p>
              {displayDesc && (
                <p className="text-[var(--text-xs)] text-[var(--text-tertiary)] leading-relaxed mt-1.5">
                  {displayDesc}
                </p>
              )}
            </div>
            <button
              onClick={onClose}
              className="p-1.5 rounded-[var(--radius-md)] hover:bg-[var(--bg-hover)] text-[var(--text-tertiary)] shrink-0"
            >
              <X size={18} />
            </button>
          </div>

          {/* Activity status banner */}
          {activityStatus && (
            <div className="mt-3 px-3 py-2 rounded-[var(--radius-md)] bg-[var(--success-subtle)] border border-[rgba(52,211,153,0.2)]">
              <div className="flex items-center gap-1.5">
                <Zap size={11} className="text-[var(--success)]" />
                <p className="text-[var(--text-xs)] font-semibold text-[var(--success)]">
                  {activityStatus.status}
                </p>
              </div>
              {activityStatus.detail && (
                <p className="text-[var(--text-xs)] text-[var(--success)] opacity-70 mt-0.5">
                  {activityStatus.detail}
                </p>
              )}
            </div>
          )}
        </div>

        {/* Scrollable body */}
        <div className="flex-1 overflow-y-auto">
          {/* Tasks Section */}
          <Section title="Tasks" defaultOpen={true}>
            {taskGroups.length === 0 ? (
              <p className="text-[var(--text-xs)] text-[var(--text-muted)] italic">No tasks assigned</p>
            ) : (
              <div className="space-y-3">
                {taskGroups.map(group => (
                  <div key={group.status}>
                    <div className="flex items-center gap-2 mb-1.5">
                      <StatusBadge status={group.status} />
                      <span className="text-[var(--text-xs)] text-[var(--text-muted)]">
                        {myTasks.filter(t => t.status === group.status).length > 5
                          ? `${group.tasks.length} of ${myTasks.filter(t => t.status === group.status).length}`
                          : group.tasks.length}
                      </span>
                    </div>
                    <div className="space-y-1">
                      {group.tasks.map((task: any) => (
                        <div
                          key={task.id}
                          className="flex items-start justify-between gap-2 py-1.5 px-2 rounded-[var(--radius-sm)] hover:bg-[var(--bg-hover)] transition-colors"
                        >
                          <div className="min-w-0">
                            <p className="text-[var(--text-xs)] text-[var(--text-primary)] leading-snug truncate">
                              {task.title}
                            </p>
                            <p className="text-[10px] text-[var(--text-muted)]">
                              {projectMap[task.projectId] || 'Unassigned'}
                            </p>
                          </div>
                          <div className="flex items-center gap-1 shrink-0">
                            <Timer size={10} className="text-[var(--text-muted)]" />
                            <span className="text-[10px] text-[var(--text-muted)]">
                              {getTimeInStatus(task)}
                            </span>
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                ))}
                <Link
                  href={`/context?assignee=${encodeURIComponent(teammate.name)}`}
                  className="flex items-center gap-1.5 text-[var(--text-xs)] text-[var(--accent-primary)] hover:text-[var(--accent-hover)] transition-colors mt-2"
                >
                  <ExternalLink size={11} />
                  View all on Context board
                </Link>
              </div>
            )}
          </Section>

          {/* Domains Section */}
          <Section title="Domains" defaultOpen={true}>
            {editingDomains ? (
              <div className="space-y-2">
                <div>
                  <label className="text-[var(--text-xs)] font-semibold text-[var(--success)] mb-1 block">
                    ✅ Owns — autonomous decisions
                  </label>
                  <textarea
                    value={domainDraft.owns}
                    onChange={e => setDomainDraft(d => ({ ...d, owns: e.target.value }))}
                    rows={3}
                    className="w-full bg-[var(--bg-secondary)] border border-[var(--border-strong)] rounded-[var(--radius-sm)] px-2 py-1.5 text-[var(--text-xs)] text-[var(--text-tertiary)] leading-relaxed resize-none focus:outline-none focus:border-[var(--accent-primary)]"
                    placeholder="Architecture decisions, CI/CD, staging deploys..."
                  />
                </div>
                <div>
                  <label className="text-[var(--text-xs)] font-semibold text-amber-400 mb-1 block">
                    🛑 Defers — needs confirmation
                  </label>
                  <textarea
                    value={domainDraft.defers}
                    onChange={e => setDomainDraft(d => ({ ...d, defers: e.target.value }))}
                    rows={3}
                    className="w-full bg-[var(--bg-secondary)] border border-[var(--border-strong)] rounded-[var(--radius-sm)] px-2 py-1.5 text-[var(--text-xs)] text-[var(--text-tertiary)] leading-relaxed resize-none focus:outline-none focus:border-[var(--accent-primary)]"
                    placeholder="Production deploys, budget, customer-facing changes..."
                  />
                </div>
                <div className="flex gap-2">
                  <button
                    onClick={saveDomainEdit}
                    className="flex items-center gap-1 px-2 py-1 rounded-[var(--radius-sm)] bg-[var(--success-subtle)] text-[var(--success)] text-[var(--text-xs)] font-medium hover:bg-[var(--success)] hover:text-white transition-colors"
                  >
                    <Check size={11} /> Save
                  </button>
                  <button
                    onClick={() => setEditingDomains(false)}
                    className="flex items-center gap-1 px-2 py-1 rounded-[var(--radius-sm)] bg-[var(--bg-tertiary)] text-[var(--text-muted)] text-[var(--text-xs)] font-medium hover:text-[var(--text-primary)] transition-colors"
                  >
                    <X size={11} /> Cancel
                  </button>
                </div>
              </div>
            ) : (
              <div className="space-y-3">
                {displayOwns ? (
                  <div>
                    <p className="text-[var(--text-xs)] font-semibold text-[var(--success)] mb-1">✅ Owns</p>
                    <p className="text-[var(--text-xs)] text-[var(--text-tertiary)] leading-relaxed">{displayOwns}</p>
                  </div>
                ) : null}
                {displayDefers ? (
                  <div>
                    <p className="text-[var(--text-xs)] font-semibold text-amber-400 mb-1">🛑 Defers</p>
                    <p className="text-[var(--text-xs)] text-[var(--text-tertiary)] leading-relaxed">{displayDefers}</p>
                  </div>
                ) : null}
                {!displayOwns && !displayDefers && (
                  <p className="text-[var(--text-xs)] text-[var(--text-muted)] italic">No domains configured</p>
                )}
                <button
                  onClick={startDomainEdit}
                  className="flex items-center gap-1.5 text-[var(--text-xs)] text-[var(--text-muted)] hover:text-[var(--text-primary)] transition-colors"
                >
                  <Pencil size={11} /> Edit
                </button>
              </div>
            )}
          </Section>

          {/* Scheduler Loop Section */}
          <Section title="Scheduler Loop" defaultOpen={false}>
            {loop ? (
              <div className="space-y-2">
                <div className="flex items-center gap-2">
                  <span className={clsx(
                    'text-[10px] font-semibold px-1.5 py-0.5 rounded-full',
                    loop.enabled
                      ? 'bg-[var(--success-subtle)] text-[var(--success)]'
                      : 'bg-[var(--bg-tertiary)] text-[var(--text-muted)]'
                  )}>
                    {loop.enabled ? 'ENABLED' : 'DISABLED'}
                  </span>
                  <span className="text-[var(--text-xs)] text-[var(--text-muted)]">
                    every {loop.intervalMinutes}min
                  </span>
                </div>
                {loop.model && (
                  <div className="flex items-center gap-1.5">
                    <span className="text-[var(--text-xs)] text-[var(--text-muted)]">Model:</span>
                    <span className="text-[var(--text-xs)] text-[var(--text-secondary)] font-mono">{loop.model}</span>
                  </div>
                )}
                {loop.lastRun && (
                  <div className="flex items-center gap-1.5">
                    <Clock size={11} className="text-[var(--text-muted)]" />
                    <span className="text-[var(--text-xs)] text-[var(--text-muted)]">
                      Last run: {timeAgo(loop.lastRun)}
                    </span>
                  </div>
                )}
                {loop.cronJobId && (
                  <div className="flex items-center gap-1.5">
                    <span className="text-[var(--text-xs)] text-[var(--text-muted)]">Cron ID:</span>
                    <span className="text-[var(--text-xs)] text-[var(--text-secondary)] font-mono truncate">{loop.cronJobId}</span>
                  </div>
                )}
              </div>
            ) : (
              <p className="text-[var(--text-xs)] text-[var(--text-muted)] italic">No scheduler loop configured</p>
            )}
          </Section>

          {/* Recent Activity Section */}
          <Section title="Recent Activity" defaultOpen={true}>
            {recentActivity.length === 0 ? (
              <p className="text-[var(--text-xs)] text-[var(--text-muted)] italic">No recent activity</p>
            ) : (
              <div className="space-y-1.5">
                {recentActivity.map((entry, i) => {
                  const style = STATUS_STYLES[entry.status];
                  return (
                    <div key={`${entry.taskTitle}-${entry.timestamp}-${i}`} className="flex items-start gap-2 py-1">
                      <div className={clsx('w-1.5 h-1.5 rounded-full mt-1.5 shrink-0', style?.text?.replace('text-', 'bg-') || 'bg-zinc-500')} />
                      <div className="min-w-0">
                        <p className="text-[var(--text-xs)] text-[var(--text-secondary)] leading-snug">
                          Moved &lsquo;<span className="text-[var(--text-primary)]">{entry.taskTitle}</span>&rsquo; to{' '}
                          <span className={style?.text || ''}>{style?.label || entry.status}</span>
                        </p>
                        <p className="text-[10px] text-[var(--text-muted)]">{timeAgo(entry.timestamp)}</p>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </Section>
        </div>
      </div>
    </div>
  );
}
