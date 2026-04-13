'use client';

import { useEffect, useState } from 'react';
import { useWSData } from '@/lib/ws';
import { clsx } from 'clsx';

interface TeamSummary {
  totalDone: number;
  firstPassRate: number;
  reviewNotesRate: number;
  testPlanRate: number;
  bounceRate: number;
}

interface AgentScore {
  agentId: string;
  totalDone: number;
  firstPassRate: number;
  reviewNotesRate: number;
  testPlanRate: number;
  bounceCount: number;
  cleanStreak: number;
  longestCleanStreak: number;
  recentTasks?: { bounced: boolean }[];
}

interface ScorecardData {
  teamSummary: TeamSummary;
  agents: AgentScore[];
}

interface Teammate {
  agentId?: string;
  name?: string;
  emoji?: string;
}

// ---- Threshold helpers ----
function firstPassColor(rate: number): string {
  if (rate >= 0.9) return 'text-green-500';
  if (rate >= 0.7) return 'text-amber-500';
  return 'text-red-500';
}
function firstPassBg(rate: number): string {
  if (rate >= 0.9) return 'bg-green-500/20';
  if (rate >= 0.7) return 'bg-amber-500/20';
  return 'bg-red-500/20';
}
function reviewNotesColor(rate: number): string {
  if (rate >= 0.8) return 'text-green-500';
  if (rate >= 0.6) return 'text-amber-500';
  return 'text-red-500';
}
function reviewNotesBg(rate: number): string {
  if (rate >= 0.8) return 'bg-green-500/20';
  if (rate >= 0.6) return 'bg-amber-500/20';
  return 'bg-red-500/20';
}
function testPlanColor(rate: number): string {
  if (rate >= 0.5) return 'text-green-500';
  if (rate >= 0.25) return 'text-amber-500';
  return 'text-red-500';
}
function testPlanBg(rate: number): string {
  if (rate >= 0.5) return 'bg-green-500/20';
  if (rate >= 0.25) return 'bg-amber-500/20';
  return 'bg-red-500/20';
}
function bounceRateColor(rate: number): string {
  if (rate <= 0.1) return 'text-green-500';
  if (rate <= 0.2) return 'text-amber-500';
  return 'text-red-500';
}
function bounceRateBg(rate: number): string {
  if (rate <= 0.1) return 'bg-green-500/20';
  if (rate <= 0.2) return 'bg-amber-500/20';
  return 'bg-red-500/20';
}

function pct(rate: number): string {
  return `${Math.round(rate * 100)}%`;
}

function streakLabel(streak: number): string {
  if (streak >= 5) return `🔥 ${streak}`;
  if (streak === 0) return `❄️ 0`;
  return `${streak}`;
}

export default function QualityScorecardSection() {
  const storeData = useWSData<any>('store');
  const [data, setData] = useState<ScorecardData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [expandedAgent, setExpandedAgent] = useState<string | null>(null);

  useEffect(() => {
    fetch('/api/metrics/quality-scorecard')
      .then((res) => {
        if (!res.ok) throw new Error('Failed');
        return res.json();
      })
      .then((d) => {
        setData(d);
        setLoading(false);
      })
      .catch(() => {
        setError(true);
        setLoading(false);
      });
  }, []);

  // Build teammate map from store settings
  const teammates: Teammate[] = storeData?.settings?.teammates || [];
  const tmMap: Record<string, Teammate> = {};
  for (const t of teammates) {
    if (t.agentId) tmMap[t.agentId] = t;
    if (t.name) tmMap[t.name.toLowerCase()] = t;
  }

  function getTeammate(agentId: string): Teammate {
    return tmMap[agentId] || tmMap[agentId.toLowerCase()] || {};
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center py-10 text-[var(--text-muted)] text-sm">
        Loading quality data...
      </div>
    );
  }

  if (error || !data) {
    return (
      <div className="flex items-center justify-center py-10 text-[var(--text-muted)] text-sm">
        No data available
      </div>
    );
  }

  const { teamSummary, agents } = data;

  const expandedData = expandedAgent
    ? agents.find((a) => a.agentId === expandedAgent) ?? null
    : null;

  return (
    <div className="space-y-4">
      {/* Section Header */}
      <div>
        <h2 className="text-lg font-semibold text-[var(--text-primary)]">Quality Scorecard</h2>
        <p className="text-sm text-[var(--text-muted)]">Code quality and process adherence signals</p>
      </div>

      {/* Team Summary Pills */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <MetricPill
          label="First Pass Rate"
          value={pct(teamSummary.firstPassRate)}
          textColor={firstPassColor(teamSummary.firstPassRate)}
          bgColor={firstPassBg(teamSummary.firstPassRate)}
        />
        <MetricPill
          label="Review Notes"
          value={pct(teamSummary.reviewNotesRate)}
          textColor={reviewNotesColor(teamSummary.reviewNotesRate)}
          bgColor={reviewNotesBg(teamSummary.reviewNotesRate)}
        />
        <MetricPill
          label="Test Plan Coverage"
          value={pct(teamSummary.testPlanRate)}
          textColor={testPlanColor(teamSummary.testPlanRate)}
          bgColor={testPlanBg(teamSummary.testPlanRate)}
        />
        <MetricPill
          label="Bounce Rate"
          value={pct(teamSummary.bounceRate)}
          textColor={bounceRateColor(teamSummary.bounceRate)}
          bgColor={bounceRateBg(teamSummary.bounceRate)}
        />
      </div>

      {/* Agent Scorecard Table */}
      <div className="border border-[var(--border-default)] rounded-[var(--radius-md)] overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="bg-[var(--bg-secondary)] border-b border-[var(--border-default)]">
              <th className="text-left px-4 py-3 text-xs font-semibold text-[var(--text-muted)]">Agent</th>
              <th className="text-right px-4 py-3 text-xs font-semibold text-[var(--text-muted)]">Done</th>
              <th className="text-right px-4 py-3 text-xs font-semibold text-[var(--text-muted)]">First Pass</th>
              <th className="text-right px-4 py-3 text-xs font-semibold text-[var(--text-muted)]">Review Notes</th>
              <th className="text-right px-4 py-3 text-xs font-semibold text-[var(--text-muted)]">Test Plan</th>
              <th className="text-right px-4 py-3 text-xs font-semibold text-[var(--text-muted)]">Bounces</th>
              <th className="text-right px-4 py-3 text-xs font-semibold text-[var(--text-muted)]">Clean Streak</th>
              <th className="text-right px-4 py-3 text-xs font-semibold text-[var(--text-muted)]">Best Streak</th>
            </tr>
          </thead>
          <tbody>
            {agents.map((agent) => {
              const tm = getTeammate(agent.agentId);
              const isExpanded = expandedAgent === agent.agentId;
              const leftBorder =
                agent.cleanStreak >= 10
                  ? 'border-l-2 border-l-green-500/50'
                  : agent.cleanStreak === 0
                  ? 'border-l-2 border-l-red-500/50'
                  : '';

              return (
                <tr
                  key={agent.agentId}
                  onClick={() =>
                    setExpandedAgent(isExpanded ? null : agent.agentId)
                  }
                  className={clsx(
                    'border-b border-[var(--border-subtle)] hover:bg-[var(--bg-secondary)] transition-colors cursor-pointer',
                    leftBorder
                  )}
                >
                  <td className="px-4 py-3 text-[var(--text-primary)] font-medium">
                    <span className="mr-2">{tm.emoji || '🤖'}</span>
                    {tm.name || agent.agentId}
                  </td>
                  <td className="px-4 py-3 text-right text-[var(--text-secondary)] tabular-nums">
                    {agent.totalDone}
                  </td>
                  <td className="px-4 py-3 text-right">
                    <span
                      className={clsx(
                        'text-xs font-semibold px-2 py-0.5 rounded-full',
                        firstPassBg(agent.firstPassRate),
                        firstPassColor(agent.firstPassRate)
                      )}
                    >
                      {pct(agent.firstPassRate)}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-right">
                    <span
                      className={clsx(
                        'text-xs font-semibold px-2 py-0.5 rounded-full',
                        reviewNotesBg(agent.reviewNotesRate),
                        reviewNotesColor(agent.reviewNotesRate)
                      )}
                    >
                      {pct(agent.reviewNotesRate)}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-right">
                    <span
                      className={clsx(
                        'text-xs font-semibold px-2 py-0.5 rounded-full',
                        testPlanBg(agent.testPlanRate),
                        testPlanColor(agent.testPlanRate)
                      )}
                    >
                      {pct(agent.testPlanRate)}
                    </span>
                  </td>
                  <td
                    className={clsx(
                      'px-4 py-3 text-right tabular-nums',
                      agent.bounceCount > 0 ? 'text-amber-500' : 'text-[var(--text-secondary)]'
                    )}
                  >
                    {agent.bounceCount}
                  </td>
                  <td className="px-4 py-3 text-right font-medium text-[var(--text-primary)] tabular-nums">
                    {streakLabel(agent.cleanStreak)}
                  </td>
                  <td className="px-4 py-3 text-right text-[var(--text-secondary)] tabular-nums">
                    {agent.longestCleanStreak}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* Agent Detail Expand Panel */}
      {expandedData && (
        <AgentDetailPanel agent={expandedData} teammate={getTeammate(expandedData.agentId)} />
      )}
    </div>
  );
}

function MetricPill({
  label,
  value,
  textColor,
  bgColor,
}: {
  label: string;
  value: string;
  textColor: string;
  bgColor: string;
}) {
  return (
    <div className="p-4 bg-[var(--card)] border border-[var(--border-default)] rounded-[var(--radius-md)]">
      <p className="text-xs text-[var(--text-muted)] mb-1">{label}</p>
      <p className={clsx('text-2xl font-bold', textColor)}>{value}</p>
      <div className={clsx('mt-2 h-1 rounded-full', bgColor)} />
    </div>
  );
}

function AgentDetailPanel({
  agent,
  teammate,
}: {
  agent: AgentScore;
  teammate: Teammate;
}) {
  const tasks = agent.recentTasks || [];

  return (
    <div className="p-5 bg-[var(--card)] border border-[var(--border-default)] rounded-[var(--radius-md)] space-y-4">
      <div className="flex items-center gap-2">
        <span className="text-xl">{teammate.emoji || '🤖'}</span>
        <h3 className="font-semibold text-[var(--text-primary)]">
          {teammate.name || agent.agentId} — Quality Detail
        </h3>
      </div>

      {/* Streak Timeline */}
      {tasks.length > 0 && (
        <div>
          <p className="text-xs text-[var(--text-muted)] mb-2">
            Last {tasks.length} tasks (oldest → newest)
          </p>
          <div className="flex gap-1.5 flex-wrap">
            {tasks.map((t, i) => (
              <div
                key={i}
                title={t.bounced ? 'Bounced' : 'Clean'}
                className={clsx(
                  'w-5 h-5 rounded-full border',
                  t.bounced
                    ? 'bg-red-500/30 border-red-500/60'
                    : 'bg-green-500/30 border-green-500/60'
                )}
              />
            ))}
          </div>
          <div className="flex gap-4 mt-1">
            <span className="text-[10px] text-[var(--text-muted)]">← older</span>
            <span className="text-[10px] text-[var(--text-muted)]">newer →</span>
          </div>
        </div>
      )}

      {/* Streak Stats */}
      <div className="flex gap-6 text-sm">
        <div>
          <p className="text-xs text-[var(--text-muted)]">Current streak</p>
          <p className="font-semibold text-[var(--text-primary)]">
            {agent.cleanStreak} task{agent.cleanStreak !== 1 ? 's' : ''}
          </p>
        </div>
        <div>
          <p className="text-xs text-[var(--text-muted)]">Longest streak</p>
          <p className="font-semibold text-[var(--text-primary)]">
            {agent.longestCleanStreak} task{agent.longestCleanStreak !== 1 ? 's' : ''}
          </p>
        </div>
        <div>
          <p className="text-xs text-[var(--text-muted)]">Total bounces</p>
          <p
            className={clsx(
              'font-semibold',
              agent.bounceCount > 0 ? 'text-amber-500' : 'text-green-500'
            )}
          >
            {agent.bounceCount}
          </p>
        </div>
      </div>
    </div>
  );
}
