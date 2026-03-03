'use client';

import { useEffect, useState } from 'react';
import { PageHeader } from '@/components/PageHeader';
import { StatusCard } from '@/components/StatusCard';
import { useGateway, useGatewayQuery } from '@/lib/hooks';
import {
  Bot, Clock, Activity, Wifi, WifiOff, Zap,
  CheckCircle2, AlertCircle, PlayCircle,
} from 'lucide-react';

function ActivityItem({ event }: { event: any }) {
  return (
    <div className="flex items-start gap-3 py-2.5 px-3 rounded-md hover:bg-[var(--bg-hover)] transition-colors">
      <div className="mt-0.5">
        <Activity size={14} className="text-[var(--text-tertiary)]" />
      </div>
      <div className="flex-1 min-w-0">
        <p className="text-sm text-[var(--text-primary)] truncate">
          {event.label || event.task || event.kind || 'Event'}
        </p>
        <p className="text-xs text-[var(--text-tertiary)]">
          {event.sessionKey || event.id || ''}
        </p>
      </div>
      <span className="text-xs text-[var(--text-muted)] shrink-0">
        {event.status || ''}
      </span>
    </div>
  );
}

function CronJobRow({ job }: { job: any }) {
  const isEnabled = job.enabled !== false;
  return (
    <div className="flex items-center gap-3 py-2 px-3 rounded-md hover:bg-[var(--bg-hover)] transition-colors">
      <div className={`w-1.5 h-1.5 rounded-full ${isEnabled ? 'bg-[var(--success)]' : 'bg-[var(--text-muted)]'}`} />
      <div className="flex-1 min-w-0">
        <p className="text-sm text-[var(--text-primary)] truncate">
          {job.label || job.id?.slice(0, 8) || 'Job'}
        </p>
        <p className="text-xs text-[var(--text-tertiary)] truncate">
          {job.schedule || job.cron || ''}
        </p>
      </div>
      <span className="text-xs text-[var(--text-muted)]">
        {isEnabled ? 'Active' : 'Disabled'}
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
    ? sessionList.filter((s: any) => s.status === 'active' || s.kind === 'run')
    : [];

  const enabledCrons = Array.isArray(cronJobs)
    ? cronJobs.filter((j: any) => j.enabled !== false)
    : [];

  return (
    <div className="space-y-6">
      <PageHeader
        title="Dashboard"
        description="System overview and live status"
      />

      {/* Status cards */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <StatusCard
          title="Gateway"
          value={state === 'connected' ? 'Online' : state}
          subtitle={status?.version ? `v${status.version}` : undefined}
          icon={state === 'connected' ? Wifi : WifiOff}
          color={state === 'connected' ? 'success' : 'error'}
        />
        <StatusCard
          title="Active Sessions"
          value={activeSessions.length}
          subtitle={`${Array.isArray(sessionList) ? sessionList.length : 0} total`}
          icon={Bot}
          color="accent"
        />
        <StatusCard
          title="Cron Jobs"
          value={enabledCrons.length}
          subtitle={`${Array.isArray(cronJobs) ? cronJobs.length : 0} total`}
          icon={Clock}
          color="default"
        />
        <StatusCard
          title="Model"
          value={status?.model?.split('/')?.pop() || '—'}
          subtitle={status?.provider || undefined}
          icon={Zap}
          color="accent"
        />
      </div>

      {/* Two-column layout */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Recent sessions */}
        <div className="bg-[var(--bg-secondary)] border border-[var(--border-default)] rounded-lg">
          <div className="flex items-center justify-between px-4 py-3 border-b border-[var(--border-subtle)]">
            <h2 className="text-sm font-medium text-[var(--text-primary)]">Recent Sessions</h2>
            <span className="text-xs text-[var(--text-tertiary)]">
              {Array.isArray(sessionList) ? sessionList.length : 0} sessions
            </span>
          </div>
          <div className="divide-y divide-[var(--border-subtle)] max-h-[320px] overflow-y-auto">
            {Array.isArray(sessionList) && sessionList.length > 0 ? (
              sessionList.slice(0, 8).map((session: any, i: number) => (
                <ActivityItem key={session.sessionKey || i} event={session} />
              ))
            ) : (
              <div className="p-4 text-sm text-[var(--text-tertiary)] text-center">
                {state !== 'connected' ? 'Connecting to Gateway...' : 'No sessions'}
              </div>
            )}
          </div>
        </div>

        {/* Cron jobs */}
        <div className="bg-[var(--bg-secondary)] border border-[var(--border-default)] rounded-lg">
          <div className="flex items-center justify-between px-4 py-3 border-b border-[var(--border-subtle)]">
            <h2 className="text-sm font-medium text-[var(--text-primary)]">Cron Jobs</h2>
            <span className="text-xs text-[var(--text-tertiary)]">
              {enabledCrons.length} active
            </span>
          </div>
          <div className="divide-y divide-[var(--border-subtle)] max-h-[320px] overflow-y-auto">
            {Array.isArray(cronJobs) && cronJobs.length > 0 ? (
              cronJobs.slice(0, 8).map((job: any, i: number) => (
                <CronJobRow key={job.id || i} job={job} />
              ))
            ) : (
              <div className="p-4 text-sm text-[var(--text-tertiary)] text-center">
                {state !== 'connected' ? 'Connecting to Gateway...' : 'No cron jobs'}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
