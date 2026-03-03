'use client';

import { PageHeader } from '@/components/PageHeader';
import { StatusCard } from '@/components/StatusCard';
import { useGateway, useGatewayQuery } from '@/lib/hooks';
import {
  Bot, Clock, Wifi, WifiOff, Zap,
} from 'lucide-react';
import { clsx } from 'clsx';

function SessionRow({ session }: { session: any }) {
  const kind: string = session.kind || 'direct';
  const isActive = session.updatedAt && Date.now() - session.updatedAt < 300000;
  const displayName = session.displayName || session.label || session.key?.split(':').pop() || 'Session';
  const model = session.model?.split('/').pop() || '';

  const kindDot: Record<string, string> = {
    direct: 'bg-[var(--accent-primary)]',
    run: 'bg-[var(--info)]',
    session: 'bg-[var(--success)]',
    cron: 'bg-[var(--warning)]',
  };

  return (
    <div className="flex items-center gap-3 py-3 px-4 rounded-[var(--radius-md)] hover:bg-[var(--bg-hover)] transition-colors">
      <div className={clsx('w-2 h-2 rounded-full shrink-0', kindDot[kind] || 'bg-zinc-500',
        isActive && 'shadow-[0_0_6px_rgba(255,92,92,0.4)]'
      )} />
      <div className="flex-1 min-w-0">
        <p className="text-[var(--text-sm)] font-medium text-[var(--text-primary)] truncate">{displayName}</p>
        <p className="text-[var(--text-xs)] text-[var(--text-muted)] truncate font-[var(--font-mono)] mt-0.5">
          {model}{session.channel ? ` · ${session.channel}` : ''}
        </p>
      </div>
      <span className={clsx(
        'text-[var(--text-xs)] font-semibold px-2.5 py-1 rounded-full',
        isActive ? 'text-[var(--success)] bg-[var(--success-subtle)]' : 'text-[var(--text-muted)] bg-[var(--bg-tertiary)]'
      )}>
        {isActive ? 'Active' : 'Idle'}
      </span>
    </div>
  );
}

function CronJobRow({ job }: { job: any }) {
  const isEnabled = job.enabled !== false;
  const lastStatus = job.state?.lastStatus || job.state?.lastRunStatus;
  const name = job.name || job.label || job.id?.slice(0, 8) || 'Job';
  const scheduleExpr = typeof job.schedule === 'string' ? job.schedule : job.schedule?.expr || job.cron || '';

  return (
    <div className="flex items-center gap-3 py-3 px-4 rounded-[var(--radius-md)] hover:bg-[var(--bg-hover)] transition-colors">
      <div className={clsx(
        'w-2 h-2 rounded-full shrink-0',
        !isEnabled ? 'bg-zinc-600'
          : lastStatus === 'ok' ? 'bg-[var(--success)] shadow-[0_0_6px_rgba(52,211,153,0.4)]'
          : lastStatus === 'error' ? 'bg-[var(--error)] shadow-[0_0_6px_rgba(248,113,113,0.4)]'
          : 'bg-[var(--warning)]'
      )} />
      <div className="flex-1 min-w-0">
        <p className="text-[var(--text-sm)] font-medium text-[var(--text-primary)] truncate">{name}</p>
        <p className="text-[var(--text-xs)] text-[var(--text-muted)] truncate font-[var(--font-mono)] mt-0.5">{scheduleExpr}</p>
      </div>
      <span className={clsx(
        'text-[var(--text-xs)] font-semibold px-2.5 py-1 rounded-full',
        isEnabled
          ? 'text-[var(--success)] bg-[var(--success-subtle)]'
          : 'text-[var(--text-muted)] bg-[var(--bg-tertiary)]'
      )}>
        {isEnabled ? 'Active' : 'Off'}
      </span>
    </div>
  );
}

export default function DashboardPage() {
  const { state } = useGateway();
  const { data: status } = useGatewayQuery<any>('status', {}, 15000);
  const { data: sessions } = useGatewayQuery<any>('sessions.list', { limit: 20 }, 10000);
  const { data: cronData } = useGatewayQuery<any>('cron.list', {}, 30000);

  const sessionList = sessions?.sessions || sessions || [];
  const cronJobs = cronData?.jobs || cronData || [];
  const activeSessions = Array.isArray(sessionList)
    ? sessionList.filter((s: any) => s.updatedAt && Date.now() - s.updatedAt < 300000)
    : [];
  const enabledCrons = Array.isArray(cronJobs)
    ? cronJobs.filter((j: any) => j.enabled !== false)
    : [];

  return (
    <div className="space-y-8">
      <PageHeader
        title="Dashboard"
        description="System overview and live status"
      />

      {/* Status cards */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-5">
        <StatusCard
          title="Gateway"
          value={state === 'connected' ? 'Online' : state}
          subtitle={status?.version ? `v${status.version}` : undefined}
          icon={state === 'connected' ? Wifi : WifiOff}
          color={state === 'connected' ? 'success' : 'error'}
          stagger={1}
        />
        <StatusCard
          title="Active Sessions"
          value={activeSessions.length}
          subtitle={`${Array.isArray(sessionList) ? sessionList.length : 0} total`}
          icon={Bot}
          color="accent"
          stagger={2}
        />
        <StatusCard
          title="Cron Jobs"
          value={enabledCrons.length}
          subtitle={`${Array.isArray(cronJobs) ? cronJobs.length : 0} total`}
          icon={Clock}
          color="default"
          stagger={3}
        />
        <StatusCard
          title="Model"
          value={status?.model?.split('/')?.pop() || '—'}
          subtitle={status?.provider || status?.modelProvider || undefined}
          icon={Zap}
          color="accent"
          stagger={4}
        />
      </div>

      {/* Two-column layout */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Recent sessions */}
        <div className="animate-rise stagger-5 bg-[var(--card)] border border-[var(--border-default)] rounded-[var(--radius-lg)] shadow-[var(--shadow-sm),inset_0_1px_0_var(--card-highlight)] hover:border-[var(--border-strong)] transition-all">
          <div className="flex items-center justify-between px-5 py-4 border-b border-[var(--border-subtle)]">
            <h2 className="text-[var(--text-md)] font-semibold text-[var(--text-primary)]">Recent Sessions</h2>
            <span className="text-[var(--text-xs)] text-[var(--text-muted)] font-medium">
              {Array.isArray(sessionList) ? sessionList.length : 0} total
            </span>
          </div>
          <div className="divide-y divide-[var(--border-subtle)] max-h-[420px] overflow-y-auto">
            {Array.isArray(sessionList) && sessionList.length > 0 ? (
              sessionList.slice(0, 10).map((session: any, i: number) => (
                <SessionRow key={session.key || session.sessionKey || i} session={session} />
              ))
            ) : (
              <div className="p-8 text-[var(--text-base)] text-[var(--text-muted)] text-center">
                {state !== 'connected' ? 'Connecting to Gateway...' : 'No sessions'}
              </div>
            )}
          </div>
        </div>

        {/* Cron jobs */}
        <div className="animate-rise stagger-6 bg-[var(--card)] border border-[var(--border-default)] rounded-[var(--radius-lg)] shadow-[var(--shadow-sm),inset_0_1px_0_var(--card-highlight)] hover:border-[var(--border-strong)] transition-all">
          <div className="flex items-center justify-between px-5 py-4 border-b border-[var(--border-subtle)]">
            <h2 className="text-[var(--text-md)] font-semibold text-[var(--text-primary)]">Cron Jobs</h2>
            <span className="text-[var(--text-xs)] text-[var(--text-muted)] font-medium">
              {enabledCrons.length} active
            </span>
          </div>
          <div className="divide-y divide-[var(--border-subtle)] max-h-[420px] overflow-y-auto">
            {Array.isArray(cronJobs) && cronJobs.length > 0 ? (
              cronJobs.slice(0, 10).map((job: any, i: number) => (
                <CronJobRow key={job.id || i} job={job} />
              ))
            ) : (
              <div className="p-8 text-[var(--text-base)] text-[var(--text-muted)] text-center">
                {state !== 'connected' ? 'Connecting to Gateway...' : 'No cron jobs'}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
