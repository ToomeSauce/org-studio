'use client';

import { PageHeader } from '@/components/PageHeader';
import { useGateway, useGatewayQuery } from '@/lib/hooks';
import { Clock, Play, Pause, RotateCcw, Circle, Plus } from 'lucide-react';
import { clsx } from 'clsx';
import { useState } from 'react';

function CronJobCard({ job, onToggle, onRun }: {
  job: any;
  onToggle: (id: string, enabled: boolean) => void;
  onRun: (id: string) => void;
}) {
  const isEnabled = job.enabled !== false;
  const [running, setRunning] = useState(false);

  const handleRun = async () => {
    setRunning(true);
    await onRun(job.id);
    setTimeout(() => setRunning(false), 3000);
  };

  return (
    <div className="bg-[var(--bg-secondary)] border border-[var(--border-default)] rounded-lg p-4 hover:border-[var(--border-strong)] transition-colors">
      <div className="flex items-start justify-between mb-2">
        <div className="flex items-center gap-2 min-w-0">
          <Circle
            size={8}
            className={clsx('fill-current shrink-0', isEnabled ? 'text-green-500' : 'text-zinc-600')}
          />
          <span className="text-sm font-medium text-[var(--text-primary)] truncate">
            {job.label || job.id?.slice(0, 8)}
          </span>
        </div>
        <div className="flex items-center gap-1 shrink-0">
          <button
            onClick={handleRun}
            disabled={running}
            className="p-1.5 rounded hover:bg-[var(--bg-hover)] text-[var(--text-tertiary)] hover:text-[var(--text-primary)] transition-colors disabled:opacity-50"
            title="Run now"
          >
            {running ? <RotateCcw size={14} className="animate-spin" /> : <Play size={14} />}
          </button>
          <button
            onClick={() => onToggle(job.id, !isEnabled)}
            className={clsx(
              'p-1.5 rounded hover:bg-[var(--bg-hover)] transition-colors',
              isEnabled ? 'text-green-500 hover:text-yellow-500' : 'text-zinc-500 hover:text-green-500'
            )}
            title={isEnabled ? 'Disable' : 'Enable'}
          >
            {isEnabled ? <Pause size={14} /> : <Play size={14} />}
          </button>
        </div>
      </div>

      <p className="text-xs text-[var(--text-secondary)] mb-2 line-clamp-2">
        {job.task?.slice(0, 120) || 'No task description'}
      </p>

      <div className="flex items-center gap-3 text-[11px] text-[var(--text-tertiary)]">
        <span className="flex items-center gap-1">
          <Clock size={11} />
          {job.schedule || job.cron || 'No schedule'}
        </span>
        {job.model && (
          <span className="truncate">
            {job.model.split('/').pop()}
          </span>
        )}
        {job.delivery?.mode && (
          <span className="px-1.5 py-0.5 bg-[var(--bg-tertiary)] rounded text-[var(--text-muted)]">
            {job.delivery.mode}
          </span>
        )}
      </div>

      {job.lastRun && (
        <div className="mt-2 pt-2 border-t border-[var(--border-subtle)] text-[11px] text-[var(--text-muted)]">
          Last run: {new Date(job.lastRun).toLocaleString()}
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
      console.error('Failed to toggle cron job:', e);
    }
  };

  const handleRun = async (jobId: string) => {
    if (!gateway) return;
    try {
      await gateway.runCronJob(jobId);
    } catch (e) {
      console.error('Failed to run cron job:', e);
    }
  };

  const enabled = Array.isArray(cronJobs) ? cronJobs.filter((j: any) => j.enabled !== false) : [];
  const disabled = Array.isArray(cronJobs) ? cronJobs.filter((j: any) => j.enabled === false) : [];

  return (
    <div className="space-y-6">
      <PageHeader
        title="Cron Jobs"
        description={`${enabled.length} active, ${disabled.length} disabled`}
        actions={
          <button className="flex items-center gap-1.5 px-3 py-1.5 text-sm bg-[var(--accent-primary)] hover:bg-[var(--accent-hover)] text-white rounded-md transition-colors">
            <Plus size={14} />
            New Job
          </button>
        }
      />

      {/* Active jobs */}
      <div>
        <h2 className="text-xs uppercase tracking-wide text-[var(--text-tertiary)] mb-3">
          Active ({enabled.length})
        </h2>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          {enabled.map((job: any, i: number) => (
            <CronJobCard key={job.id || i} job={job} onToggle={handleToggle} onRun={handleRun} />
          ))}
        </div>
      </div>

      {/* Disabled jobs */}
      {disabled.length > 0 && (
        <div>
          <h2 className="text-xs uppercase tracking-wide text-[var(--text-tertiary)] mb-3">
            Disabled ({disabled.length})
          </h2>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3 opacity-60">
            {disabled.map((job: any, i: number) => (
              <CronJobCard key={job.id || i} job={job} onToggle={handleToggle} onRun={handleRun} />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
