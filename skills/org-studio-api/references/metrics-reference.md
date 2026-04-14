# Metrics API Reference — Org Studio

All metrics endpoints for querying agent and team performance data.

## Table of Contents
- [Team Metrics](#team-metrics)
- [Agent Daily Metrics](#agent-daily-metrics)
- [Quality Scorecard](#quality-scorecard)
- [Team Health](#team-health)
- [Coaching Insights](#coaching-insights)
- [Cultural Alignment](#cultural-alignment)
- [Agent Comparison](#agent-comparison)
- [Weekly Digest](#weekly-digest)

---

## Team Metrics

### GET /api/metrics/team

Aggregated metrics per agent across all time (or filtered by date range).

Query params: `?from=2026-04-01&to=2026-04-14` (optional)

```json
{
  "metrics": [
    {
      "agentId": "mikey",
      "totalCompleted": 103,
      "totalStarted": 132,
      "avgDuration": 52.2,
      "avgChainRate": 0.3,
      "avgThroughput": 70.5,
      "avgFirstPass": 0.88,
      "totalBounces": 54,
      "totalStalls": 0,
      "totalComments": 107,
      "totalKudos": 2,
      "totalFlags": 1,
      "activeDays": 23
    }
  ]
}
```

---

## Agent Daily Metrics

### GET /api/metrics/{agentId}

Daily snapshots for one agent. Returns newest-first.

Query params: `?limit=7&from=2026-04-01&to=2026-04-14` (all optional)

```json
{
  "agentId": "mikey",
  "metrics": [
    {
      "date": "2026-04-13T04:00:00.000Z",
      "tasksCompleted": 14,
      "tasksStarted": 8,
      "avgDurationMin": 5.1,
      "throughput": 9.0,
      "firstPassRate": 1.0,
      "bounceCount": 0,
      "commentsPosted": 12,
      "activeMinutes": 93,
      "chainRate": 0.286,
      "kudosCount": 0,
      "flagCount": 0
    }
  ]
}
```

---

## Quality Scorecard

### GET /api/metrics/quality-scorecard

Per-agent quality signals computed from store data.

```json
{
  "teamSummary": {
    "totalDone": 347,
    "firstPassRate": 0.83,
    "reviewNotesRate": 0.70,
    "testPlanRate": 0.15,
    "bounceRate": 0.17
  },
  "agents": [
    {
      "agentId": "Ana",
      "totalDone": 114,
      "firstPassRate": 0.95,
      "reviewNotesRate": 0.38,
      "testPlanRate": 0.05,
      "bounceCount": 6,
      "cleanStreak": 8,
      "longestCleanStreak": 67
    }
  ]
}
```

---

## Team Health

### GET /api/metrics/team-health

Cross-team health signals computed from task statusHistory.

```json
{
  "velocityTrend": [
    { "date": "2026-04-13", "completed": 14, "started": 8, "bounced": 0 }
  ],
  "activeHoursHeatmap": [
    { "day": 3, "hour": 14, "count": 29 }
  ],
  "stalls": {
    "current": [{ "taskId": "...", "title": "...", "assignee": "...", "stalledMinutes": 180 }],
    "frequency": { "last7d": 5, "last30d": 16, "avgStallMinutes": 1085 }
  },
  "reviewBottlenecks": {
    "avgReviewMinutes": 3883,
    "maxReviewMinutes": 10176,
    "tasksInReview": 0,
    "recentBottlenecks": [{ "taskId": "...", "title": "...", "reviewMinutes": 10176 }]
  }
}
```

---

## Coaching Insights

### GET /api/metrics/coaching-insights?agent={agentId}

Auto-generated coaching based on metric patterns.

```json
{
  "agentId": "mikey",
  "insights": [
    {
      "type": "celebration",
      "category": "quality",
      "title": "First-Pass Improvement",
      "message": "First-pass rate improved from 63% to 100% — great progress.",
      "severity": 2
    },
    {
      "type": "celebration",
      "category": "quality",
      "title": "Hot Streak",
      "message": "6-day clean streak — zero bounces.",
      "severity": 2
    }
  ],
  "generatedAt": "2026-04-14T17:23:29.075Z"
}
```

Types: `warning`, `improvement`, `celebration`, `suggestion`
Categories: `throughput`, `quality`, `engagement`, `consistency`, `general`

---

## Cultural Alignment

### GET /api/metrics/cultural-alignment

PACT values breakdown from kudos/flags data.

```json
{
  "pactValues": [
    { "slug": "autonomy", "title": "Autonomy", "kudosCount": 15, "flagsCount": 0, "total": 15, "ratio": 1.0 }
  ],
  "agentBreakdown": [
    { "agentId": "Ana", "values": { "autonomy": { "kudos": 3, "flags": 0 } }, "totalKudos": 3, "totalFlags": 0 }
  ],
  "timeline": [
    { "week": "2026-W15", "kudos": 10, "flags": 2, "values": { "autonomy": 10 } }
  ],
  "principles": [
    { "text": "Autonomy is the team's strongest cultural signal", "type": "strength" }
  ],
  "totals": { "kudos": 15, "flags": 4, "total": 19 }
}
```

---

## Agent Comparison

### GET /api/metrics/agent-comparison

All agents with sparkline trend data for side-by-side comparison.

```json
{
  "agents": [
    {
      "agentId": "mikey",
      "totalCompleted": 103,
      "avgThroughput": 70.5,
      "avgFirstPass": 0.88,
      "totalBounces": 54,
      "activeDays": 23,
      "sparklines": {
        "tasksCompleted": [0, 2, 5, 3, 14, ...],
        "throughput": [0, 1.5, 3.0, 9.0, ...],
        "firstPassRate": [1, 1, 0.8, 1, ...]
      }
    }
  ]
}
```

---

## Weekly Digest

### GET /api/metrics/weekly-digest

Auto-generated team performance summary.

```json
{
  "digest": {
    "weekLabel": "Apr 7 – Apr 13, 2026",
    "summary": { "totalCompleted": 263, "avgFirstPass": 0.96, "totalBounces": 56, "activeAgents": 5 },
    "topPerformers": {
      "mostCompleted": { "agentId": "mikey", "count": 106 },
      "highestThroughput": { "agentId": "mikey", "value": 65.3 },
      "bestFirstPass": { "agentId": "ana", "rate": 1.0, "tasks": 89 },
      "longestStreak": { "agentId": "Mikey", "streak": 23 }
    },
    "areasOfAttention": ["⚠️ 56 bounces this week across the team"],
    "versionProgress": [{ "projectName": "Org Studio", "version": "1.6", "done": 3, "total": 6 }],
    "recentKudos": [...],
    "coachingHighlights": [...]
  },
  "markdown": "📊 *Weekly Team Digest*\n..."
}
```

### POST /api/metrics/weekly-digest

Send digest to Telegram:
```json
{ "action": "send" }
```

Response: `{ "ok": true, "telegramSent": true, "digest": {...}, "markdown": "..." }`
