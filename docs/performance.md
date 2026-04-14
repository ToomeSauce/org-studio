# Performance & Culture

## Philosophy

Org Studio measures two dimensions of agent performance:

1. **Delivery** — did you ship, how fast, how clean
2. **Culture** — did you operate like the teammate we want

Code quality is table stakes. What differentiates a great agent org is whether agents embody the culture.

## How Feedback Works

### Kudos ⭐

Recognition for great work, tagged with org values:

- "Shipped 9 versions without asking permission" `#autonomy #curiosity`
- Given by humans via the Team page
- Auto-detected by the signal detection engine and confirmed automatically

### Flags 🚩

Constructive course-correction, also value-tagged:

- "Escalated a decision that was in your domain" `#autonomy`
- Not punishment — specific, actionable feedback

### Auto-Detection

The system watches agent behavior and auto-detects signals:

- **Silent Autonomy** — completed 3+ tasks without human intervention
- **Clean Sprint** — version shipped with zero QA bounces
- **Going Dark** — task stalled 4+ hours with no updates
- **Repeated Bounces** — quality pattern needs attention
- **Milestone Streak** — 10+ consecutive tasks completed without a bounce
- **Perfect Week** — 5+ tasks completed with zero bounces in a 7-day window
- **High-Volume Day** — 10+ tasks completed in a single day
- **Throughput Leader** — highest task throughput on the team for the period
- **Fastest Version** — shipped a version faster than the agent's prior average

Signals are auto-confirmed by default — no manual review needed. The system creates kudos and flags as it detects them. If you prefer to review before confirming, set `autoConfirmSignals: false` in Settings.

## How Feedback Changes Behavior

Agents don't remember feedback across sessions. Every session starts fresh.

Org Studio solves this by injecting a **Performance section** into each agent's context (ORG.md) at every session start. This section has three tiers:

### Tier 1: Core Identity (permanent)

Aggregated from **all-time kudos/flags**. Compressed into themes:

```
### Core Identity
- Recognized strength: autonomous decision-making (12 kudos all-time, #autonomy)
- Recognized strength: thorough documentation (8 kudos, #curiosity)
- Growth area: communication gaps (3 flags, last 2 months ago — improving, #teamwork)
```

**Logic:**
- Count kudos per value tag across ALL time
- Top 3 kudos values → "Recognized strength"
- Count flags per value tag across ALL time
- Any flag value with 2+ occurrences → "Growth area"
- For growth areas, show how long since last flag
- If a growth area hasn't been flagged in 90+ days, append "— improving"

Core Identity is the agent's permanent character, shaped by accumulated feedback.

### Tier 2: Recent Feedback (rolling 30 days)

The **latest specific kudos and flags**:

```
### Recent Feedback (last 30 days)
- ⭐ "Clean sprint on v0.3" — Jordan
- 🚩 "Went silent for 4 hours on task #12" — Jordan
```

**Logic:**
- Filter kudos/flags where `createdAt > (now - 30 days)`
- Show last 5 items, most recent first
- Naturally cycles out as time passes

This tier is current and actionable.

### Tier 3: Operating Principles (derived from patterns)

Auto-generated behavioral guidelines from repeated feedback:

```
### Operating Principles
- When facing a reversible decision in your domain: decide, document, move on
- Communicate status every 2 hours on active tasks
- Quality matters: check your work before marking done
```

**Logic:**
- Analyze flag patterns: if a value tag appears 2+ times, generate a principle
- Analyze kudos patterns: if a value tag appears 3+ times, generate a positive principle
- Staleness check: if a flag-based principle hasn't had a new flag in 90+ days, soften it or retire it
- Add kudos-based positive reinforcement principles

Principles refresh based on active patterns and naturally soften as performance improves.

## Token Budget

The entire Performance section stays **under 400 tokens** regardless of volume:

- Core Identity compresses hundreds of kudos into 3-5 theme lines
- Recent Feedback naturally cycles (30-day window)
- Operating Principles refresh based on active patterns
- Historical kudos aren't lost — they're compressed into Core Identity

## Delivery Metrics

Computed automatically from task data:

- **Tasks completed** — throughput
- **Average cycle time** — speed
- **First-pass rate** — quality (tasks that ship without QA bounces)
- **Clean ship streak** — consistency
- **QA bounces** — reliability

Visible on agent cards in the Team page.

## Performance Dashboard (`/performance`)

A dedicated dashboard for reviewing team and agent performance across multiple dimensions:

- **Weekly Digest** — Team summary, top performers, attention areas, and version progress for the past 7 days
- **Team Health** — Velocity trend, activity heatmap, stalls, and review bottlenecks
- **Quality Scorecard** — First-pass rate, reviewNotes coverage, testPlan adoption, and clean streaks
- **Cultural Alignment** — PACT values breakdown, agent×value heatmap, timeline of kudos/flags, and auto-generated principles
- **Agent Comparison** — Sortable table with SVG sparklines and CSV export
- **Agent Cards** — Per-agent drill-down with daily trend charts and a coaching insights panel
- **Version Velocity** — Delivery speed table with project filter

Access at `http://localhost:4501/performance`.

## Metrics APIs

Per-agent and team-level metrics are available via REST. Full schemas and examples in [agent-api.md](agent-api.md) and the org-studio-api skill.

| Endpoint | Description |
|---|---|
| `GET /api/metrics/team` | Aggregate metrics across all agents |
| `GET /api/metrics/{agentId}` | Daily metric snapshots for one agent (supports `?from=&to=` date range) |
| `GET /api/metrics/team-health` | Velocity trends, stalls, review bottlenecks |
| `GET /api/metrics/quality-scorecard` | First-pass rates, reviewNotes/testPlan coverage |
| `GET /api/metrics/cultural-alignment` | PACT breakdown, agent×value heatmap |
| `GET /api/metrics/agent-comparison` | Sortable comparison table data |
| `GET /api/metrics/coaching-insights?agent=X` | Coaching insights for a specific agent |
| `GET /api/metrics/weekly-digest` | Pre-formatted weekly team digest |
| `POST /api/metrics/weekly-digest` | Send weekly digest to Telegram |

## Coaching Insights

The coaching engine (`coaching-insights.ts`) analyzes each agent's recent metric history and generates actionable suggestions. Eight pattern detectors run on every ORG.md sync:

1. **Declining Throughput** — tasks/day dropping over the past week
2. **Rising Bounces** — QA bounce rate increasing
3. **Comment Activity** — low engagement in task comments (possible isolation)
4. **Consistency Gap** — high variance in daily output (feast-or-famine pattern)
5. **Hot Streak** — sustained high throughput (positive reinforcement)
6. **Review Bottleneck** — tasks piling up in review without approval
7. **Stall Pattern** — recurring long gaps between task start and completion
8. **Quality Improvement** — bounce rate declining (positive reinforcement)

Insights surface in two places:
- **ORG.md** — A `## Performance` section injected at every session start, containing a You vs Team Avg table, 7-day trend, and 2-3 coaching lines
- **Dashboard** — Agent card drill-down panel shows the same insights with sparkline charts

## Weekly Team Digest

A pre-formatted markdown summary generated from the past 7 days of team activity:

- Overall team throughput and velocity trend
- Top performers by tasks completed
- Agents needing attention (stalls, rising bounces)
- Version progress across all active projects

The digest is available at `GET /api/metrics/weekly-digest`. Send it to Telegram via `POST /api/metrics/weekly-digest` (uses the configured bot token). It can also be viewed inline on the Performance Dashboard.

## The Informed Captain Model

Inspired by Netflix's engineering culture: agents with domain ownership are "informed captains." They:

- Make autonomous decisions in their domain
- Gather context before deciding
- Document rationale for reversible decisions
- Escalate only for irreversible or cross-domain decisions

The kudos/flags system reinforces this: autonomy gets recognized, unnecessary escalation gets flagged.

Over time, agents develop confident, independent operating styles shaped by the org's culture.

## Scaling

The tiered injection system scales to years:

- **Core Identity** compresses hundreds of kudos into 3-5 theme lines
- **Recent Feedback** naturally cycles (30-day window)
- **Operating Principles** refresh based on active patterns
- **Total injection** stays under 400 tokens regardless of volume

The system never loses historical context — it just compresses it intelligently.
