'use client';

import { PageHeader } from '@/components/PageHeader';
import { useWSData } from '@/lib/ws';
import { getGateway } from '@/lib/gateway';
import { Clock, Play, Pause, RotateCcw } from 'lucide-react';
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
      'animate-rise bg-[var(--card)] border border-[var(--border-default)] rounded-[var(--radius-lg)] p-5',
      'hover:border-[var(--border-strong)] transition-all duration-200',
      'shadow-[var(--shadow-sm),inset_0_1px_0_var(--card-highlight)]',
      `stagger-${stagger}`
    )}>
      {/* Header */}
      <div className="flex items-start justify-between mb-3">
        <div className="flex items-center gap-3 min-w-0">
          <div className={clsx(
            'w-2.5 h-2.5 rounded-full shrink-0',
            !isEnabled ? 'bg-zinc-600'
              : lastStatus === 'error' ? 'bg-[var(--error)] shadow-[0_0_8px_rgba(248,113,113,0.5)] animate-[pulse-subtle_2s_ease-in-out_infinite]'
              : 'bg-[var(--success)] shadow-[0_0_8px_rgba(52,211,153,0.5)]'
          )} />
          <span className="text-[var(--text-base)] font-semibold text-[var(--text-primary)] truncate">{name}</span>
        </div>
        <div className="flex items-center gap-1.5 shrink-0">
          <button
            onClick={handleRun}
            disabled={running}
            className="p-2 rounded-[var(--radius-md)] hover:bg-[var(--bg-hover)] text-[var(--text-tertiary)] hover:text-[var(--text-primary)] transition-colors disabled:opacity-50"
            title="Run now"
          >
            {running ? <RotateCcw size={15} className="animate-spin" /> : <Play size={15} />}
          </button>
          <button
            onClick={() => onToggle(job.id, !isEnabled)}
            className={clsx(
              'p-2 rounded-[var(--radius-md)] hover:bg-[var(--bg-hover)] transition-colors',
              isEnabled ? 'text-[var(--success)] hover:text-[var(--warning)]' : 'text-zinc-500 hover:text-[var(--success)]'
            )}
            title={isEnabled ? 'Disable' : 'Enable'}
          >
            {isEnabled ? <Pause size={15} /> : <Play size={15} />}
          </button>
        </div>
      </div>

      {/* Schedule info */}
      <div className="flex items-center gap-2.5 text-[var(--text-sm)] text-[var(--text-tertiary)] mb-3">
        <Clock size={13} className="shrink-0" />
        <span className="font-[var(--font-mono)]">{scheduleExpr}</span>
        {tz && <span className="text-[var(--text-muted)]">({tz})</span>}
      </div>

      {/* Chips */}
      <div className="flex flex-wrap gap-2">
        {model && (
          <span className="text-[var(--text-xs)] font-medium px-2.5 py-1 rounded-full border border-[var(--border-default)] bg-[var(--bg-tertiary)] text-[var(--text-muted)]">
            {model}
          </span>
        )}
        {delivery && (
          <span className={clsx(
            'text-[var(--text-xs)] font-medium px-2.5 py-1 rounded-full border',
            delivery === 'none' ? 'border-[var(--border-default)] bg-[var(--bg-tertiary)] text-[var(--text-muted)]'
              : 'border-[rgba(96,165,250,0.3)] bg-[var(--info-subtle)] text-[var(--info)]'
          )}>
            {delivery}
          </span>
        )}
        {lastStatus && (
          <span className={clsx(
            'text-[var(--text-xs)] font-semibold px-2.5 py-1 rounded-full border',
            lastStatus === 'ok' ? 'border-[rgba(52,211,153,0.3)] bg-[var(--success-subtle)] text-[var(--success)]'
              : lastStatus === 'error' ? 'border-[rgba(248,113,113,0.3)] bg-[var(--error-subtle)] text-[var(--error)]'
              : 'border-[var(--border-default)] bg-[var(--bg-tertiary)] text-[var(--text-muted)]'
          )}>
            {lastStatus}
          </span>
        )}
      </div>

      {/* Last run */}
      {lastRun && (
        <div className="mt-4 pt-3 border-t border-[var(--border-subtle)] flex items-center justify-between text-[var(--text-sm)] text-[var(--text-muted)]">
          <span>Last run: {formatRelative(lastRun)}</span>
          {lastDuration && <span>{(lastDuration / 1000).toFixed(1)}s</span>}
        </div>
      )}
    </div>
  );
}

export default function CronPage() {
  const cronData = useWSData<any>('cron');
  const cronJobs = cronData?.jobs || cronData || [];
  const gateway = getGateway();

  const handleToggle = async (jobId: string, enabled: boolean) => {
    try {
      await gateway.toggleCronJob(jobId, enabled);
    } catch (e) {
      console.error('Failed to toggle:', e);
    }
  };

  const handleRun = async (jobId: string) => {
    try {
      await gateway.runCronJob(jobId);
    } catch (e) {
      console.error('Failed to run:', e);
    }
  };

  const enabled = Array.isArray(cronJobs) ? cronJobs.filter((j: any) => j.enabled !== false) : [];
  const disabled = Array.isArray(cronJobs) ? cronJobs.filter((j: any) => j.enabled === false) : [];

  return (
    <div className="space-y-8">
      <PageHeader
        title="Cron Jobs"
        description={`${enabled.length} active, ${disabled.length} disabled`}
      />

      <div>
        <h2 className="text-[var(--text-xs)] uppercase tracking-[0.05em] font-semibold text-[var(--text-muted)] mb-4">
          Active ({enabled.length})
        </h2>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {enabled.map((job: any, i: number) => (
            <CronJobCard key={job.id || i} job={job} onToggle={handleToggle} onRun={handleRun} stagger={Math.min(i + 1, 6)} />
          ))}
        </div>
      </div>

      {disabled.length > 0 && (
        <div>
          <h2 className="text-[var(--text-xs)] uppercase tracking-[0.05em] font-semibold text-[var(--text-muted)] mb-4">
            Disabled ({disabled.length})
          </h2>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4 opacity-60">
            {disabled.map((job: any, i: number) => (
              <CronJobCard key={job.id || i} job={job} onToggle={handleToggle} onRun={handleRun} stagger={Math.min(i + 1, 6)} />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
