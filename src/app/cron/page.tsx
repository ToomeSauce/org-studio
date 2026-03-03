'use client';

import { PageHeader } from '@/components/PageHeader';
import { useGateway, useGatewayQuery } from '@/lib/hooks';
import { Clock, Play, Pause, RotateCcw, Circle, Plus } from 'lucide-react';
import { clsx } from 'clsx';
import { useState } from 'react';

function formatRelative(ms: number): string {
  if (!ms) return '—';
  const diff = Date.now() - ms;
  if (diff < 60000) return 'just now';
  if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
  if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`;
  return `${Math.floor(diff / 86400000)}d ago`;
}

function CronJobCard({ job, onToggle, onRun, stagger }: {
  job: any;
  onToggle: (id: string, enabled: boolean) => void;
  onRun: (id: string) => void;
  stagger: number;
}) {
  const isEnabled = job.enabled !== false;
  const [running, setRunning] = useState(false);
  const lastStatus = job.state?.lastStatus || job.state?.lastRunStatus;
  const lastRun = job.state?.lastRunAtMs;
  const lastDuration = job.state?.lastDurationMs;
  const name = job.name || job.label || job.id?.slice(0, 8) || 'Cron Job';
  const scheduleExpr = typeof job.schedule === 'string' ? job.schedule : job.schedule?.expr || job.cron || '';
  const tz = typeof job.schedule === 'object' ? job.schedule?.tz : '';
  const model = job.payload?.model?.split('/').pop() || '';
  const delivery = job.delivery?.mode || '';

  const handleRun = async () => {
    setRunning(true);
    await onRun(job.id);
    setTimeout(() => setRunning(false), 3000);
  };

  return (
    <div className={clsx(
      'animate-rise bg-[var(--card)] border border-[var(--border-default)] rounded-[var(--radius-lg)] p-4',
      'hover:border-[var(--border-strong)] transition-all duration-200',
      'shadow-[var(--shadow-sm),inset_0_1px_0_var(--card-highlight)]',
      `stagger-${stagger}`
    )}>
      {/* Header */}
      <div className="flex items-start justify-between mb-3">
        <div className="flex items-center gap-2.5 min-w-0">
          <div className={clsx(
            'w-[8px] h-[8px] rounded-full shrink-0',
            !isEnabled ? 'bg-zinc-600'
              : lastStatus === 'error' ? 'bg-[var(--error)] shadow-[0_0_8px_rgba(239,68,68,0.5)] animate-[pulse-subtle_2s_ease-in-out_infinite]'
              : 'bg-[var(--success)] shadow-[0_0_8px_rgba(34,197,94,0.5)]'
          )} />
          <span className="text-sm font-semibold text-[var(--text-primary)] truncate tracking-tight">{name}</span>
        </div>
        <div className="flex items-center gap-1 shrink-0">
          <button
            onClick={handleRun}
            disabled={running}
            className="p-1.5 rounded-[var(--radius-md)] hover:bg-[var(--bg-hover)] text-[var(--text-tertiary)] hover:text-[var(--text-primary)] transition-colors disabled:opacity-50"
            title="Run now"
          >
            {running ? <RotateCcw size={14} className="animate-spin" /> : <Play size={14} />}
          </button>
          <button
            onClick={() => onToggle(job.id, !isEnabled)}
            className={clsx(
              'p-1.5 rounded-[var(--radius-md)] hover:bg-[var(--bg-hover)] transition-colors',
              isEnabled ? 'text-[var(--success)] hover:text-[var(--warning)]' : 'text-zinc-500 hover:text-[var(--success)]'
            )}
            title={isEnabled ? 'Disable' : 'Enable'}
          >
            {isEnabled ? <Pause size={14} /> : <Play size={14} />}
          </button>
        </div>
      </div>

      {/* Schedule info */}
      <div className="flex items-center gap-2 text-[11px] text-[var(--text-tertiary)] mb-3">
        <Clock size={11} className="shrink-0" />
        <span className="font-[var(--font-mono)]">{scheduleExpr}</span>
        {tz && <span className="text-[var(--text-muted)]">({tz})</span>}
      </div>

      {/* Chips */}
      <div className="flex flex-wrap gap-1.5">
        {model && (
          <span className="text-[10px] font-medium px-2 py-0.5 rounded-full border border-[var(--border-default)] bg-[var(--bg-tertiary)] text-[var(--text-muted)]">
            {model}
          </span>
        )}
        {delivery && (
          <span className={clsx(
            'text-[10px] font-medium px-2 py-0.5 rounded-full border',
            delivery === 'none' ? 'border-[var(--border-default)] bg-[var(--bg-tertiary)] text-[var(--text-muted)]'
              : 'border-[rgba(59,130,246,0.3)] bg-[var(--info-subtle)] text-[var(--info)]'
          )}>
            {delivery}
          </span>
        )}
        {lastStatus && (
          <span className={clsx(
            'text-[10px] font-semibold px-2 py-0.5 rounded-full border',
            lastStatus === 'ok' ? 'border-[rgba(34,197,94,0.3)] bg-[var(--success-subtle)] text-[var(--success)]'
              : lastStatus === 'error' ? 'border-[rgba(239,68,68,0.3)] bg-[var(--error-subtle)] text-[var(--error)]'
              : 'border-[var(--border-default)] bg-[var(--bg-tertiary)] text-[var(--text-muted)]'
          )}>
            {lastStatus}
          </span>
        )}
      </div>

      {/* Last run */}
      {lastRun && (
        <div className="mt-3 pt-3 border-t border-[var(--border-subtle)] flex items-center justify-between text-[11px] text-[var(--text-muted)]">
          <span>Last run: {formatRelative(lastRun)}</span>
          {lastDuration && <span>{(lastDuration / 1000).toFixed(1)}s</span>}
        </div>
      )}
    </div>
  );
}

export default function CronPage() {
  const { gateway } = useGateway();
  const { data: cronData, refetch } = useGatewayQuery<any>('cron.list', {}, 30000);
  const cronJobs = cronData?.jobs || cronData || [];

  const handleToggle = async (jobId: string, enabled: boolean) => {
    if (!gateway) return;
    try {
      await gateway.toggleCronJob(jobId, enabled);
      refetch();
    } catch (e) {
      console.error('Failed to toggle:', e);
    }
  };

  const handleRun = async (jobId: string) => {
    if (!gateway) return;
    try {
      await gateway.runCronJob(jobId);
    } catch (e) {
      console.error('Failed to run:', e);
    }
  };

  const enabled = Array.isArray(cronJobs) ? cronJobs.filter((j: any) => j.enabled !== false) : [];
  const disabled = Array.isArray(cronJobs) ? cronJobs.filter((j: any) => j.enabled === false) : [];

  return (
    <div className="space-y-6">
      <PageHeader
        title="Cron Jobs"
        description={`${enabled.length} active, ${disabled.length} disabled`}
      />

      {/* Active */}
      <div>
        <h2 className="text-[11px] uppercase tracking-[0.04em] font-semibold text-[var(--text-muted)] mb-3">
          Active ({enabled.length})
        </h2>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          {enabled.map((job: any, i: number) => (
            <CronJobCard key={job.id || i} job={job} onToggle={handleToggle} onRun={handleRun} stagger={Math.min(i + 1, 6)} />
          ))}
        </div>
      </div>

      {/* Disabled */}
      {disabled.length > 0 && (
        <div>
          <h2 className="text-[11px] uppercase tracking-[0.04em] font-semibold text-[var(--text-muted)] mb-3">
            Disabled ({disabled.length})
          </h2>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3 opacity-60">
            {disabled.map((job: any, i: number) => (
              <CronJobCard key={job.id || i} job={job} onToggle={handleToggle} onRun={handleRun} stagger={Math.min(i + 1, 6)} />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
