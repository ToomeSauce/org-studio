import { describe, expect, it } from 'vitest';
import { formatDigestMarkdown, type WeeklyDigest } from '@/lib/weekly-digest';

function fixture(): WeeklyDigest {
  return {
    weekLabel: 'Jul 6 – Jul 12, 2026',
    generatedAt: '2026-07-11T21:30:00.000Z',
    summary: {
      totalCompleted: 5,
      totalStarted: 5,
      totalBounces: 1,
      avgFirstPass: 0.4,
      activeAgents: 1,
      activeDays: 5,
    },
    topPerformers: {
      mostCompleted: null,
      highestThroughput: null,
      bestFirstPass: null,
      longestStreak: null,
    },
    areasOfAttention: [],
    versionProgress: [],
    recentKudos: [],
    coachingHighlights: [],
    workerRouting: {
      windowDays: 7,
      tierModel: [{
        tier: 'trivial',
        model: 'gpt-mini',
        workerIds: ['worker-cheap'],
        tickets: 5,
        ticketsDone: 5,
        firstPassTickets: 2,
        firstPassRate: 0.4,
        bounceCount: 1,
        attemptsToDone: 1.6,
        costTotalUsd: 1.7,
        costPerDoneTicketUsd: 0.34,
      }],
      recommendations: [{
        tier: 'trivial',
        model: 'gpt-mini',
        nextModel: 'gpt-strong',
        nextWorkerId: 'worker-strong',
        tickets: 5,
        firstPassRate: 0.4,
        message: 'trivial on gpt-mini is 40% first-pass over 5 done tickets; consider moving the tier to gpt-strong (worker-strong).',
      }],
    },
  };
}

describe('#1694 weekly digest routing feedback', () => {
  it('renders the tier matrix and advisory without implying an automatic routing change', () => {
    const markdown = formatDigestMarkdown(fixture());

    expect(markdown).toContain('*🧭 Worker Routing Feedback*');
    expect(markdown).toContain('trivial × gpt-mini: 40% first-pass, 1.60 attempts/done, $0.34/done');
    expect(markdown).toContain('consider moving the tier to gpt-strong');
    expect(markdown).toContain('Advisory only; no routing changed.');
  });

  it('renders a stable no-change statement when the matrix has enough data but no advisory', () => {
    const digest = fixture();
    digest.workerRouting.recommendations = [];

    expect(formatDigestMarkdown(digest)).toContain(
      'No tier-routing changes recommended from the current sample.',
    );
  });
});
