'use client';

import { useState, useEffect, useMemo, useCallback } from 'react';
import { clsx } from 'clsx';
import {
  Play, Pause, RotateCcw, ChevronDown, ChevronUp, Plus, Trash2,
  Clock, Zap, Check, X, Shuffle, BookOpen, ClipboardList, Wrench, Send,
  RefreshCw, FileText, Save, Cpu,
} from 'lucide-react';
import { useWSData } from '@/lib/ws';
import { Teammate, resolveColor } from '@/lib/teammates';
import { AgentLoop, LoopStep, DEFAULT_LOOP_STEPS } from '@/lib/store';
import { PageHeader } from '@/components/PageHeader';
import RunHistoryPanel from '@/components/RunHistoryPanel';

// ─── Helpers ──────────────────────────────────────────────────────

function staggerOffsets(count: number, interval: number): number[] {
  if (count <= 0) return [];
  const gap = Math.max(Math.floor(interval / count), 1);
  return Array.from({ length: count }, (_, i) => ((i + 1) * gap) % 60);
}

function formatOffset(mins: number): string {
  return `:${String(mins).padStart(2, '0')}`;
}

function formatNextRun(loop: AgentLoop): string {
  if (!loop.enabled) return 'Paused';
  const now = new Date();
  const currentMin = now.getMinutes();
  const offset = loop.startOffsetMinutes % 60;
  const interval = loop.intervalMinutes;

  let nextMin = offset;
  while (nextMin <= currentMin) nextMin += interval;
  if (nextMin >= 60) nextMin = offset;

  const diff = nextMin > currentMin ? nextMin - currentMin : 60 - currentMin + nextMin;
  if (diff <= 1) return 'Running soon';
  return `~${diff}m`;
}

function shortModelName(model?: string): string {
  if (!model) return '5.4';
  if (model.includes('codex')) return 'Codex';
  if (model.includes('opus')) return 'Opus';
  if (model.includes('5.4')) return '5.4';
  const slash = model.lastIndexOf('/');
  return slash >= 0 ? model.slice(slash + 1) : model;
}

function formatRelativeTime(ts?: number): string {
  if (!ts) return '';
  const diff = Date.now() - ts;
  if (diff < 60_000) return 'just now';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return `${Math.floor(diff / 86_400_000)}d ago`;
}

const STEP_ICONS: Record<string, typeof BookOpen> = {
  'read-org': BookOpen,
  'sync-tasks': ClipboardList,
  'work-next': Wrench,
  'report': Send,
  'custom': Zap,
};

// ─── Step Card ────────────────────────────────────────────────────

function StepCard({ step, onToggle, onEdit, onRemove, isCustom }: {
  step: LoopStep;
  onToggle: () => void;
  onEdit: (updates: Partial<LoopStep>) => void;
  onRemove?: () => void;
  isCustom?: boolean;
}) {
  const [editing, setEditing] = useState(false);
  const [desc, setDesc] = useState(step.description);
  const [instruction, setInstruction] = useState(step.instruction || '');
  const Icon = STEP_ICONS[step.type] || Zap;

  return (
    <div className={clsx(
      'flex items-start gap-3 px-3 py-2.5 rounded-[var(--radius-md)] border transition-all',
      step.enabled
        ? 'bg-[var(--bg-primary)] border-[var(--border-default)]'
        : 'bg-[var(--bg-secondary)] border-[var(--border-default)] opacity-50'
    )}>
      <button onClick={onToggle} className="mt-0.5 shrink-0">
        <div className={clsx(
          'w-4 h-4 rounded border-2 flex items-center justify-center transition-colors',
          step.enabled
            ? 'bg-[var(--accent-primary)] border-[var(--accent-primary)]'
            : 'border-[var(--border-strong)] bg-transparent'
        )}>
          {step.enabled && <Check size={10} className="text-white" />}
        </div>
      </button>

      <div className="flex-1 min-w-0">
        {editing ? (
          <div className="space-y-2">
            <input
              value={desc}
              onChange={e => setDesc(e.target.value)}
              className="w-full bg-[var(--bg-secondary)] border border-[var(--border-strong)] rounded-[var(--radius-sm)] px-2 py-1 text-[var(--text-xs)] text-[var(--text-primary)] focus:outline-none focus:border-[var(--accent-primary)]"
              placeholder="Step description"
            />
            {isCustom && (
              <textarea
                value={instruction}
                onChange={e => setInstruction(e.target.value)}
                rows={2}
                className="w-full bg-[var(--bg-secondary)] border border-[var(--border-strong)] rounded-[var(--radius-sm)] px-2 py-1 text-[var(--text-xs)] text-[var(--text-tertiary)] resize-none focus:outline-none focus:border-[var(--accent-primary)]"
                placeholder="Custom instruction for the agent..."
              />
            )}
            <div className="flex gap-2">
              <button onClick={() => { onEdit({ description: desc, instruction }); setEditing(false); }}
                className="text-[var(--text-xs)] px-2 py-1 rounded-[var(--radius-sm)] bg-[var(--success-subtle)] text-[var(--success)] font-medium hover:bg-[var(--success)] hover:text-white transition-colors">
                Save
              </button>
              <button onClick={() => { setDesc(step.description); setInstruction(step.instruction || ''); setEditing(false); }}
                className="text-[var(--text-xs)] px-2 py-1 text-[var(--text-muted)] hover:text-[var(--text-primary)] transition-colors">
                Cancel
              </button>
            </div>
          </div>
        ) : (
          <div className="flex items-start gap-2">
            <Icon size={13} className="text-[var(--text-muted)] mt-0.5 shrink-0" />
            <div className="flex-1">
              <p className="text-[var(--text-xs)] text-[var(--text-secondary)] leading-relaxed cursor-pointer hover:text-[var(--text-primary)] transition-colors"
                onClick={() => setEditing(true)}>
                {step.description}
              </p>
              {step.instruction && (
                <p className="text-[var(--text-xs)] text-[var(--text-muted)] mt-0.5 italic truncate">{step.instruction}</p>
              )}
            </div>
          </div>
        )}
      </div>

      {isCustom && onRemove && (
        <button onClick={onRemove} className="text-[var(--text-muted)] hover:text-[var(--error)] transition-colors shrink-0 mt-0.5">
          <Trash2 size={12} />
        </button>
      )}
    </div>
  );
}

// ─── Agent Loop Card ──────────────────────────────────────────────

function LoopCard({ loop, teammate, onUpdate, onDelete, onToggleEnabled, onRunNow }: {
  loop: AgentLoop;
  teammate?: Teammate;
  onUpdate: (id: string, updates: Partial<AgentLoop>) => void;
  onDelete: (id: string) => void;
  onToggleEnabled: (id: string, enable: boolean) => void;
  onRunNow: (id: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [addingStep, setAddingStep] = useState(false);
  const [newStepDesc, setNewStepDesc] = useState('');
  const [newStepInstruction, setNewStepInstruction] = useState('');
  const [runningNow, setRunningNow] = useState(false);
  const [toggling, setToggling] = useState(false);
  const [runStats, setRunStats] = useState<{ ok: number; total: number } | null>(null);
  const [statusMsg, setStatusMsg] = useState<string | null>(null);
  const colors = teammate ? resolveColor(teammate.color) : resolveColor('blue');

  const handleStatsLoaded = useCallback((stats: { ok: number; total: number }) => {
    setRunStats(stats);
  }, []);

  const handleToggleEnabled = async () => {
    setToggling(true);
    try {
      await onToggleEnabled(loop.id, !loop.enabled);
      const enable = !loop.enabled;
      setStatusMsg(enable ? '✓ Loop enabled — cron job created' : '✓ Loop paused — cron job removed');
      setTimeout(() => setStatusMsg(null), 3000);
    } finally {
      setToggling(false);
    }
  };

  const handleRunNow = async () => {
    setRunningNow(true);
    try {
      await onRunNow(loop.id);
      setStatusMsg('✓ Loop triggered — agent session starting');
      setTimeout(() => setStatusMsg(null), 3000);
    } finally {
      setTimeout(() => setRunningNow(false), 2000);
    }
  };

  const updateStep = (stepId: string, updates: Partial<LoopStep>) => {
    const steps = loop.steps.map(s => s.id === stepId ? { ...s, ...updates } : s);
    onUpdate(loop.id, { steps });
  };

  const toggleStep = (stepId: string) => {
    const step = loop.steps.find(s => s.id === stepId);
    if (step) updateStep(stepId, { enabled: !step.enabled });
  };

  const removeStep = (stepId: string) => {
    const steps = loop.steps.filter(s => s.id !== stepId);
    onUpdate(loop.id, { steps });
  };

  const addCustomStep = () => {
    if (!newStepDesc.trim()) return;
    const step: LoopStep = {
      id: 'step-' + Math.random().toString(36).slice(2, 8),
      type: 'custom',
      description: newStepDesc.trim(),
      instruction: newStepInstruction.trim() || undefined,
      enabled: true,
    };
    onUpdate(loop.id, { steps: [...loop.steps, step] });
    setNewStepDesc('');
    setNewStepInstruction('');
    setAddingStep(false);
  };

  const enabledSteps = loop.steps.filter(s => s.enabled).length;
  const lastRunText = formatRelativeTime(loop.lastRun);

  return (
    <div className={clsx(
      'rounded-[var(--radius-lg)] border overflow-hidden transition-all',
      loop.enabled ? 'border-[var(--border-default)]' : 'border-[var(--border-default)] opacity-60'
    )}>
      {/* Header */}
      <div className="flex items-center gap-4 px-5 py-4 bg-[var(--bg-primary)]">
        {/* Avatar */}
        <div className={clsx('w-10 h-10 rounded-full flex items-center justify-center text-lg shrink-0', colors.bg)}
          style={{ boxShadow: loop.enabled ? `0 0 12px ${colors.glowRgba}` : 'none' }}>
          {teammate?.emoji || '🤖'}
        </div>

        {/* Info */}
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className={clsx('text-[var(--text-base)] font-bold', colors.text)}>
              {teammate?.name || loop.agentId}
            </span>
            <span className={clsx(
              'text-[var(--text-xs)] px-1.5 py-0.5 rounded-full font-medium',
              loop.enabled
                ? 'bg-[var(--success-subtle)] text-[var(--success)]'
                : 'bg-[var(--bg-tertiary)] text-[var(--text-muted)]'
            )}>
              {toggling ? '...' : loop.enabled ? 'ACTIVE' : 'PAUSED'}
            </span>
          </div>
          <p className="text-[var(--text-xs)] text-[var(--text-muted)]">
            Every {loop.intervalMinutes}m · starts {formatOffset(loop.startOffsetMinutes)} · {shortModelName(loop.model)} · {enabledSteps} step{enabledSteps !== 1 ? 's' : ''} · next: {formatNextRun(loop)}
            {lastRunText && ` · ran ${lastRunText}`}
            {runStats && runStats.total > 0 && ` · ${runStats.ok}/${runStats.total} ok`}
          </p>
        </div>

        {/* Controls */}
        <div className="flex items-center gap-2">
          <button
            onClick={handleRunNow}
            disabled={runningNow}
            className={clsx(
              'flex items-center gap-1.5 px-3 py-1.5 rounded-[var(--radius-md)] text-[var(--text-xs)] font-medium border transition-all',
              runningNow
                ? 'bg-[var(--success-subtle)] text-[var(--success)] border-[var(--success)]'
                : 'bg-[var(--bg-secondary)] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)] border-[var(--border-default)]'
            )}
            title="Run now"
          >
            {runningNow ? <Check size={12} /> : <Play size={12} />}
            {runningNow ? 'Triggered' : 'Run Now'}
          </button>
          <button
            onClick={handleToggleEnabled}
            disabled={toggling}
            className={clsx(
              'p-2 rounded-[var(--radius-md)] border transition-all',
              loop.enabled
                ? 'bg-[var(--success-subtle)] border-[var(--success)] text-[var(--success)] hover:bg-[var(--success)] hover:text-white'
                : 'bg-[var(--bg-secondary)] border-[var(--border-default)] text-[var(--text-muted)] hover:text-[var(--text-primary)]'
            )}
            title={loop.enabled ? 'Pause loop' : 'Enable loop'}
          >
            {loop.enabled ? <Pause size={14} /> : <Play size={14} />}
          </button>
          <button
            onClick={() => setExpanded(!expanded)}
            className="p-2 rounded-[var(--radius-md)] text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-hover)] transition-all"
          >
            {expanded ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
          </button>
        </div>
      </div>

      {/* Status message */}
      {statusMsg && (
        <div className="px-5 py-2 text-[var(--text-xs)] font-medium text-[var(--success)] bg-[var(--success-subtle)] border-b border-[var(--border-default)]">
          {statusMsg}
        </div>
      )}

      {/* Expanded: steps + config */}
      {expanded && (
        <div className="border-t border-[var(--border-default)] bg-[var(--bg-secondary)]">
          {/* Interval config */}
          <div className="px-5 py-3 flex items-center gap-6 flex-wrap border-b border-[var(--border-default)]">
            <div className="flex items-center gap-2">
              <Clock size={13} className="text-[var(--text-muted)]" />
              <label className="text-[var(--text-xs)] text-[var(--text-muted)]">Interval</label>
              <select
                value={loop.intervalMinutes}
                onChange={e => onUpdate(loop.id, { intervalMinutes: parseInt(e.target.value) })}
                className="bg-[var(--bg-primary)] border border-[var(--border-strong)] rounded-[var(--radius-sm)] px-2 py-1 text-[var(--text-xs)] text-[var(--text-primary)] focus:outline-none focus:border-[var(--accent-primary)]"
              >
                {[5, 10, 15, 20, 30, 45, 60, 120].map(m => (
                  <option key={m} value={m}>{m} min</option>
                ))}
              </select>
            </div>
            <div className="flex items-center gap-2">
              <label className="text-[var(--text-xs)] text-[var(--text-muted)]">Start offset</label>
              <select
                value={loop.startOffsetMinutes}
                onChange={e => onUpdate(loop.id, { startOffsetMinutes: parseInt(e.target.value) })}
                className="bg-[var(--bg-primary)] border border-[var(--border-strong)] rounded-[var(--radius-sm)] px-2 py-1 text-[var(--text-xs)] text-[var(--text-primary)] focus:outline-none focus:border-[var(--accent-primary)]"
              >
                {Array.from({ length: 60 }, (_, i) => (
                  <option key={i} value={i}>{formatOffset(i)}</option>
                ))}
              </select>
            </div>
            <div className="flex items-center gap-2">
              <Cpu size={13} className="text-[var(--text-muted)]" />
              <label className="text-[var(--text-xs)] text-[var(--text-muted)]">Model</label>
              <select
                value={loop.model || ''}
                onChange={e => onUpdate(loop.id, { model: e.target.value || undefined })}
                className="bg-[var(--bg-primary)] border border-[var(--border-strong)] rounded-[var(--radius-sm)] px-2 py-1 text-[var(--text-xs)] text-[var(--text-primary)] focus:outline-none focus:border-[var(--accent-primary)]"
              >
                <option value="">GPT-5.4 (default)</option>
                <option value="foundry-openai/gpt-5.3-codex">GPT-5.3 Codex</option>
                <option value="foundry/claude-opus-4-6">Claude Opus 4.6</option>
              </select>
            </div>
          </div>

          {/* Cron job info */}
          {loop.cronJobId && (
            <div className="px-5 py-2 border-b border-[var(--border-default)]">
              <p className="text-[var(--text-xs)] text-[var(--text-muted)]">
                cron: <code className="text-[var(--text-tertiary)] font-mono">{loop.cronJobId}</code>
              </p>
            </div>
          )}

          {/* System prompt override */}
          <div className="px-5 py-3 border-b border-[var(--border-default)]">
            <div className="flex items-center justify-between mb-2">
              <p className="text-[var(--text-xs)] font-semibold text-[var(--text-secondary)] uppercase tracking-[0.05em]">
                System Prompt
              </p>
              <span className="text-[var(--text-xs)] text-[var(--text-muted)]">
                {loop.systemPrompt ? 'Custom' : 'Using default steps'}
              </span>
            </div>
            <textarea
              value={loop.systemPrompt || ''}
              onChange={e => onUpdate(loop.id, { systemPrompt: e.target.value || undefined })}
              rows={3}
              placeholder="Optional: override the default step-based prompt with custom instructions for this agent"
              className="w-full bg-[var(--bg-primary)] border border-[var(--border-strong)] rounded-[var(--radius-sm)] px-2 py-1.5 text-[var(--text-xs)] text-[var(--text-primary)] placeholder:text-[var(--text-muted)] resize-y focus:outline-none focus:border-[var(--accent-primary)]"
            />
            {loop.systemPrompt && (
              <p className="text-[var(--text-xs)] text-[var(--text-muted)] mt-1">
                When set, this replaces the default steps above. The task management and rules sections are still included.
              </p>
            )}
          </div>

          {/* Steps */}
          <div className={clsx('px-5 py-3 space-y-2', loop.systemPrompt && 'opacity-40 pointer-events-none')}>
            <div className="flex items-center justify-between mb-2">
              <p className="text-[var(--text-xs)] font-semibold text-[var(--text-secondary)] uppercase tracking-[0.05em]">Loop Steps</p>
              {loop.systemPrompt && (
                <span className="text-[var(--text-xs)] text-[var(--text-muted)] italic">Steps overridden by system prompt above</span>
              )}
            </div>
            {loop.steps.map(step => (
              <StepCard
                key={step.id}
                step={step}
                onToggle={() => toggleStep(step.id)}
                onEdit={updates => updateStep(step.id, updates)}
                onRemove={step.type === 'custom' ? () => removeStep(step.id) : undefined}
                isCustom={step.type === 'custom'}
              />
            ))}

            {addingStep ? (
              <div className="border border-dashed border-[var(--border-strong)] rounded-[var(--radius-md)] p-3 space-y-2">
                <input
                  value={newStepDesc}
                  onChange={e => setNewStepDesc(e.target.value)}
                  placeholder="Step description (e.g. Check email for feedback)"
                  className="w-full bg-[var(--bg-primary)] border border-[var(--border-strong)] rounded-[var(--radius-sm)] px-2 py-1.5 text-[var(--text-xs)] text-[var(--text-primary)] focus:outline-none focus:border-[var(--accent-primary)]"
                  autoFocus
                  onKeyDown={e => { if (e.key === 'Enter') addCustomStep(); if (e.key === 'Escape') setAddingStep(false); }}
                />
                <textarea
                  value={newStepInstruction}
                  onChange={e => setNewStepInstruction(e.target.value)}
                  placeholder="Custom instruction for the agent (optional)"
                  rows={2}
                  className="w-full bg-[var(--bg-primary)] border border-[var(--border-strong)] rounded-[var(--radius-sm)] px-2 py-1.5 text-[var(--text-xs)] text-[var(--text-tertiary)] resize-none focus:outline-none focus:border-[var(--accent-primary)]"
                />
                <div className="flex gap-2">
                  <button onClick={addCustomStep}
                    className="text-[var(--text-xs)] px-3 py-1.5 bg-[var(--accent-primary)] text-white rounded-[var(--radius-sm)] hover:bg-[var(--accent-hover)] font-medium transition-colors">
                    Add Step
                  </button>
                  <button onClick={() => { setAddingStep(false); setNewStepDesc(''); setNewStepInstruction(''); }}
                    className="text-[var(--text-xs)] px-3 py-1.5 text-[var(--text-muted)] hover:text-[var(--text-primary)] transition-colors">
                    Cancel
                  </button>
                </div>
              </div>
            ) : (
              <button
                onClick={() => setAddingStep(true)}
                className="w-full py-2 text-[var(--text-xs)] text-[var(--text-muted)] hover:text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] rounded-[var(--radius-md)] transition-colors flex items-center justify-center gap-1.5 border border-dashed border-[var(--border-default)]"
              >
                <Plus size={13} /> Add custom step
              </button>
            )}
          </div>

          {/* Run History */}
          <RunHistoryPanel
            loopId={loop.id}
            cronJobId={loop.cronJobId}
            visible={expanded}
            onStatsLoaded={handleStatsLoaded}
          />

          {/* Danger zone */}
          <div className="px-5 py-3 border-t border-[var(--border-default)] flex justify-end">
            <button onClick={() => onDelete(loop.id)}
              className="text-[var(--text-xs)] px-3 py-1.5 text-[var(--error)] hover:bg-[var(--error)]/10 rounded-[var(--radius-sm)] transition-colors flex items-center gap-1.5">
              <Trash2 size={12} /> Remove loop
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Main Page ────────────────────────────────────────────────────

export default function SchedulerPage() {
  const storeData = useWSData<any>('store');
  const [loops, setLoops] = useState<AgentLoop[]>([]);
  const [syncing, setSyncing] = useState(false);
  const [syncResult, setSyncResult] = useState<string | null>(null);
  const [preamble, setPreamble] = useState('');
  const [preambleExpanded, setPreambleExpanded] = useState(false);
  const [preambleSaving, setPreambleSaving] = useState(false);
  const [preambleSaved, setPreambleSaved] = useState(false);
  const [preambleDirty, setPreambleDirty] = useState(false);

  const teammates: Teammate[] = useMemo(() => storeData?.settings?.teammates || [], [storeData]);
  const agents = useMemo(() => teammates.filter(t => !t.isHuman && t.agentId), [teammates]);

  // Sync loops from store
  useEffect(() => {
    if (storeData?.settings?.loops) {
      setLoops(storeData.settings.loops);
    }
  }, [storeData]);

  // Sync preamble from store (only when not actively editing)
  useEffect(() => {
    if (storeData?.settings?.loopPreamble != null && !preambleDirty) {
      setPreamble(storeData.settings.loopPreamble || '');
    }
  }, [storeData, preambleDirty]);

  const savePreamble = useCallback(async (text: string) => {
    setPreambleSaving(true);
    try {
      await fetch('/api/store', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'updateLoopPreamble', loopPreamble: text }),
      });
      setPreambleSaved(true);
      setPreambleDirty(false);
      setTimeout(() => setPreambleSaved(false), 2000);
    } catch (e) {
      console.error('Failed to save preamble:', e);
    } finally {
      setPreambleSaving(false);
    }
  }, []);

  const agentMap = useMemo(() => {
    const map: Record<string, Teammate> = {};
    for (const t of teammates) {
      if (t.agentId) map[t.agentId] = t;
      map[t.id] = t;
    }
    return map;
  }, [teammates]);

  // Agents without a loop
  const unassignedAgents = useMemo(() => {
    const loopAgentIds = new Set(loops.map(l => l.agentId));
    return agents.filter(a => !loopAgentIds.has(a.agentId));
  }, [agents, loops]);

  const saveLoop = useCallback(async (id: string, updates: Partial<AgentLoop>) => {
    // Optimistic
    setLoops(prev => prev.map(l => l.id === id ? { ...l, ...updates } : l));
    await fetch('/api/store', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'updateLoop', id, updates }),
    });
  }, []);

  const deleteLoop = useCallback(async (id: string) => {
    const loop = loops.find(l => l.id === id);
    // If loop has a cron job, disable it first
    if (loop?.cronJobId) {
      try {
        await fetch('/api/scheduler', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'disable', loopId: id }),
        });
      } catch {}
    }
    setLoops(prev => prev.filter(l => l.id !== id));
    await fetch('/api/store', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'deleteLoop', id }),
    });
  }, [loops]);

  const addLoop = useCallback(async (agentId: string, offset: number) => {
    const loop: Omit<AgentLoop, 'id'> = {
      agentId,
      enabled: false,
      intervalMinutes: 30,
      startOffsetMinutes: offset,
      steps: DEFAULT_LOOP_STEPS.map(s => ({ ...s })),
    };
    const res = await fetch('/api/store', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'addLoop', loop }),
    });
    const data = await res.json();
    if (data.loop) setLoops(prev => [...prev, data.loop]);
  }, []);

  const toggleEnabled = useCallback(async (loopId: string, enable: boolean) => {
    // Optimistic update
    setLoops(prev => prev.map(l => l.id === loopId ? { ...l, enabled: enable } : l));

    try {
      const res = await fetch('/api/scheduler', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: enable ? 'enable' : 'disable', loopId }),
      });
      const data = await res.json();
      if (!data.ok) {
        // Revert optimistic update
        setLoops(prev => prev.map(l => l.id === loopId ? { ...l, enabled: !enable } : l));
        console.error('Toggle failed:', data.error);
        return;
      }
      // Update with cronJobId from response
      if (enable && data.cronJobId) {
        setLoops(prev => prev.map(l => l.id === loopId ? { ...l, cronJobId: data.cronJobId, enabled: true } : l));
      } else if (!enable) {
        setLoops(prev => prev.map(l => l.id === loopId ? { ...l, cronJobId: undefined, enabled: false } : l));
      }
    } catch (e) {
      // Revert on error
      setLoops(prev => prev.map(l => l.id === loopId ? { ...l, enabled: !enable } : l));
      console.error('Toggle error:', e);
    }
  }, []);

  const runNow = useCallback(async (loopId: string) => {
    try {
      const res = await fetch('/api/scheduler', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'runNow', loopId }),
      });
      const data = await res.json();
      if (data.ok) {
        // Update lastRun in local state
        setLoops(prev => prev.map(l => l.id === loopId ? { ...l, lastRun: Date.now() } : l));
      } else {
        console.error('Run now failed:', data.error);
      }
    } catch (e) {
      console.error('Run now error:', e);
    }
  }, []);

  const syncCronJobs = useCallback(async () => {
    setSyncing(true);
    setSyncResult(null);
    try {
      const res = await fetch('/api/scheduler', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'sync' }),
      });
      const data = await res.json();
      if (data.ok) {
        setSyncResult(`Synced ${data.synced} loop${data.synced !== 1 ? 's' : ''}`);
        // Re-fetch store to get updated loop state
        // (the ws data should auto-refresh, but show result for a few seconds)
        setTimeout(() => setSyncResult(null), 4000);
      } else {
        setSyncResult(`Sync failed: ${data.error}`);
        setTimeout(() => setSyncResult(null), 5000);
      }
    } catch (e) {
      setSyncResult('Sync error');
      setTimeout(() => setSyncResult(null), 5000);
    } finally {
      setSyncing(false);
    }
  }, []);

  const autoStagger = useCallback(async () => {
    if (loops.length === 0) return;
    const offsets = staggerOffsets(loops.length, loops[0]?.intervalMinutes || 30);
    const updated = loops.map((l, i) => ({ ...l, startOffsetMinutes: offsets[i] }));
    setLoops(updated);
    await Promise.all(updated.map(l =>
      fetch('/api/store', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'updateLoop', id: l.id, updates: { startOffsetMinutes: l.startOffsetMinutes } }),
      })
    ));
  }, [loops]);

  const addAllAgents = useCallback(async () => {
    const existingCount = loops.length;
    const totalCount = existingCount + unassignedAgents.length;
    const interval = 30;
    const offsets = staggerOffsets(totalCount, interval);

    for (let i = 0; i < unassignedAgents.length; i++) {
      await addLoop(unassignedAgents[i].agentId, offsets[existingCount + i]);
    }
  }, [agents, loops, unassignedAgents, addLoop]);

  const activeCount = loops.filter(l => l.enabled).length;

  return (
    <div className="p-6 max-w-4xl mx-auto space-y-8">
      {/* Header */}
      <PageHeader
        title="Scheduler"
        description="Agent work loops — each agent runs on a schedule, reading context, working tasks, and reporting progress."
      />

      {/* Stats bar */}
      <div className="flex items-center gap-6 text-[var(--text-xs)]">
        <span className="text-[var(--text-muted)]">
          <span className="font-semibold text-[var(--text-secondary)]">{loops.length}</span> loop{loops.length !== 1 ? 's' : ''} configured
        </span>
        <span className="text-[var(--text-muted)]">
          <span className="font-semibold text-[var(--success)]">{activeCount}</span> active
        </span>
        {syncResult && (
          <span className="text-[var(--text-muted)] italic">{syncResult}</span>
        )}
        <div className="flex items-center gap-2 ml-auto">
          <button
            onClick={syncCronJobs}
            disabled={syncing}
            className={clsx(
              'flex items-center gap-1.5 px-3 py-1.5 rounded-[var(--radius-md)] text-[var(--text-xs)] font-medium border transition-all',
              syncing
                ? 'bg-[var(--bg-tertiary)] text-[var(--text-muted)] border-[var(--border-default)]'
                : 'bg-[var(--bg-secondary)] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] border-[var(--border-default)]'
            )}
            title="Reconcile loops with Gateway cron jobs"
          >
            <RefreshCw size={12} className={syncing ? 'animate-spin' : ''} /> Sync
          </button>
          {loops.length > 1 && (
            <button
              onClick={autoStagger}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-[var(--radius-md)] text-[var(--text-xs)] font-medium bg-[var(--bg-secondary)] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] border border-[var(--border-default)] transition-all"
              title="Auto-stagger start times so no two agents overlap"
            >
              <Shuffle size={12} /> Auto-stagger
            </button>
          )}
        </div>
      </div>

      {/* Global Preamble */}
      <div className="border border-[var(--border-default)] rounded-[var(--radius-lg)] overflow-hidden">
        <button
          onClick={() => setPreambleExpanded(!preambleExpanded)}
          className="w-full flex items-center gap-3 px-5 py-3.5 bg-[var(--bg-primary)] hover:bg-[var(--bg-hover)] transition-colors"
        >
          <FileText size={14} className="text-[var(--text-muted)] shrink-0" />
          <div className="flex-1 text-left">
            <span className="text-[var(--text-sm)] font-semibold text-[var(--text-secondary)]">Global Preamble</span>
            <span className="text-[var(--text-xs)] text-[var(--text-muted)] ml-2">
              {preamble.trim() ? `${preamble.trim().split('\n').length} lines` : 'Not set'}
            </span>
          </div>
          {preambleSaved && (
            <span className="text-[var(--text-xs)] text-[var(--success)] font-medium flex items-center gap-1">
              <Check size={11} /> Saved
            </span>
          )}
          {preambleExpanded ? <ChevronUp size={14} className="text-[var(--text-muted)]" /> : <ChevronDown size={14} className="text-[var(--text-muted)]" />}
        </button>

        {preambleExpanded && (
          <div className="border-t border-[var(--border-default)] bg-[var(--bg-secondary)] px-5 py-4 space-y-3">
            <p className="text-[var(--text-xs)] text-[var(--text-muted)] leading-relaxed">
              Prepended to every agent loop prompt. Use this to inject mission, values, org context, or shared instructions across all loops.
            </p>
            <textarea
              value={preamble}
              onChange={e => { setPreamble(e.target.value); setPreambleDirty(true); }}
              onBlur={() => { if (preambleDirty) savePreamble(preamble); }}
              rows={8}
              placeholder={`Example:\nMission: Foster continuous learning and growth with coaching agents that make hard things easy.\n\nValues — P.A.C.T.:\n1. People-First — obsessed with the people we serve\n2. Autonomy — own your domain, act on what matters\n3. Curiosity — ask why, dig deeper, never stop learning\n4. Teamwork — communicate openly, share wins and failures`}
              className="w-full bg-[var(--bg-primary)] border border-[var(--border-strong)] rounded-[var(--radius-md)] px-3 py-2.5 text-[var(--text-sm)] text-[var(--text-primary)] placeholder:text-[var(--text-muted)] resize-y focus:outline-none focus:border-[var(--accent-primary)] font-mono leading-relaxed min-h-[120px]"
            />
            <div className="flex items-center justify-between">
              <p className="text-[var(--text-xs)] text-[var(--text-muted)]">
                Auto-saves on blur. Active loops will use the updated preamble on their next run.
              </p>
              <button
                onClick={() => savePreamble(preamble)}
                disabled={preambleSaving || !preambleDirty}
                className={clsx(
                  'flex items-center gap-1.5 px-3 py-1.5 rounded-[var(--radius-md)] text-[var(--text-xs)] font-medium border transition-all',
                  preambleDirty
                    ? 'bg-[var(--accent-primary)] text-white border-[var(--accent-primary)] hover:bg-[var(--accent-hover)]'
                    : 'bg-[var(--bg-primary)] text-[var(--text-muted)] border-[var(--border-default)] cursor-default'
                )}
              >
                <Save size={11} /> {preambleSaving ? 'Saving…' : preambleSaved ? 'Saved' : 'Save'}
              </button>
            </div>
          </div>
        )}
      </div>

      {/* Loop cards */}
      <div className="space-y-3">
        {loops.map(loop => (
          <LoopCard
            key={loop.id}
            loop={loop}
            teammate={agentMap[loop.agentId]}
            onUpdate={saveLoop}
            onDelete={deleteLoop}
            onToggleEnabled={toggleEnabled}
            onRunNow={runNow}
          />
        ))}

        {/* Empty state / add buttons */}
        {loops.length === 0 ? (
          <div className="border-2 border-dashed border-[var(--border-default)] rounded-[var(--radius-lg)] py-16 text-center">
            <div className="text-4xl mb-3">⏱️</div>
            <p className="text-[var(--text-base)] font-medium text-[var(--text-secondary)] mb-1">No loops configured</p>
            <p className="text-[var(--text-sm)] text-[var(--text-muted)] mb-6">
              Set up agent work loops to keep your team progressing autonomously.
            </p>
            {agents.length > 0 ? (
              <button
                onClick={addAllAgents}
                className="px-4 py-2 bg-[var(--accent-primary)] text-white rounded-[var(--radius-md)] text-[var(--text-sm)] font-medium hover:bg-[var(--accent-hover)] transition-colors"
              >
                Add loops for all agents
              </button>
            ) : (
              <p className="text-[var(--text-xs)] text-[var(--text-muted)]">Add agents on the Team page first.</p>
            )}
          </div>
        ) : unassignedAgents.length > 0 && (
          <div className="border border-dashed border-[var(--border-default)] rounded-[var(--radius-lg)] p-4">
            <p className="text-[var(--text-xs)] text-[var(--text-muted)] mb-3">
              {unassignedAgents.length} agent{unassignedAgents.length !== 1 ? 's' : ''} without a loop:
            </p>
            <div className="flex flex-wrap gap-2">
              {unassignedAgents.map(agent => {
                const c = resolveColor(agent.color);
                return (
                  <button
                    key={agent.agentId}
                    onClick={() => addLoop(agent.agentId, staggerOffsets(loops.length + 1, 30).pop() || 0)}
                    className={clsx(
                      'flex items-center gap-1.5 px-3 py-1.5 rounded-[var(--radius-md)] text-[var(--text-xs)] font-medium border border-[var(--border-default)] hover:border-[var(--border-strong)] transition-all',
                      c.text
                    )}
                  >
                    <span>{agent.emoji}</span> {agent.name}
                    <Plus size={11} />
                  </button>
                );
              })}
              {unassignedAgents.length > 1 && (
                <button
                  onClick={addAllAgents}
                  className="flex items-center gap-1.5 px-3 py-1.5 rounded-[var(--radius-md)] text-[var(--text-xs)] font-medium text-[var(--text-muted)] hover:text-[var(--text-secondary)] border border-dashed border-[var(--border-default)] transition-all"
                >
                  Add all <Plus size={11} />
                </button>
              )}
            </div>
          </div>
        )}
      </div>

      {/* How it works */}
      <div className="border border-[var(--border-default)] rounded-[var(--radius-lg)] p-5 bg-[var(--bg-secondary)]">
        <p className="text-[var(--text-xs)] font-semibold text-[var(--text-secondary)] uppercase tracking-[0.05em] mb-3">How it works</p>
        <div className="grid grid-cols-4 gap-4">
          {[
            { icon: '📖', label: 'Read ORG.md', desc: 'Refresh mission, values, domain boundaries' },
            { icon: '📋', label: 'Sync tasks', desc: 'Check Context Board, create task if doing untracked work' },
            { icon: '🔧', label: 'Work next', desc: 'Progress highest priority task, or pull from backlog' },
            { icon: '📤', label: 'Report', desc: 'Update status, move done tasks, set activity' },
          ].map(item => (
            <div key={item.label} className="text-center">
              <div className="text-xl mb-1.5">{item.icon}</div>
              <p className="text-[var(--text-xs)] font-semibold text-[var(--text-secondary)] mb-0.5">{item.label}</p>
              <p className="text-[var(--text-xs)] text-[var(--text-muted)] leading-relaxed">{item.desc}</p>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
