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
