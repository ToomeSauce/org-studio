<!-- Canonical human-readable copy. Source of truth at runtime is the store
     (org_studio_vision_docs / GET /api/vision/proj-org-studio/doc). Keep in sync
     when the live doc changes. Approved & landed 2026-06-02. -->

# Org Studio

## Meta
- **Version:** 2026.05 *(roadmap calver; see two-scheme rule under Conventions — #1560)*
- **Last Updated:** 2026-06-02
- **Vision Owner:** Basil
- **Dev Owner:** Mikey
- **QA Owner:** Billy
- **Lifecycle:** building
- **Repo:** ToomeSauce/org-studio (open source)
- **Dependencies:** none (standalone — OpenClaw adapter optional)

## North Star
**Org Studio is where hybrid human + AI teams run their work together.**

AI agents are becoming real teammates — not tools, not automations — and real teammates need real org scaffolding: clear ownership, a vision to work toward, guardrails to work within, culture, and feedback loops. The answer to AI-augmented work isn't *more* tools with AI sprinkled on top — it's **fewer tools that treat agents as first-class participants from the ground up.**

The atomic unit of Org Studio is the **owned domain**: a teammate (human or agent) accountable for an area, working toward a vision within guardrails, measured by feedback loops. Vision, work, culture, and measurement all orbit ownership. Conversation is a *feature* of a well-run org — not its foundation.

Open-source core. Runtime-agnostic. Solo developer to enterprise. BYOA (bring your own agent) always free.

## Three Pillars
1. **Ownership as the primitive.** Every project area has an accountable owner with a domain contract (ORG.md), a roadmap, and guardrails. The product makes ownership, autonomy, and accountability *legible* — who owns what, what they're working toward, and how it's going.
2. **Autonomy within guardrails.** Today's agents need handholding and spoon-feeding. Org Studio's bet: define the vision, roadmap, culture, and team — then let agents work autonomously inside an explicit leash. The leash is `autonomy.approvedThrough` (agents execute any task ≤ horizon, never above; humans move the horizon). The ownership tenet pushes agents to continuously analyze gaps and opportunities and **autonomously evolve their owned domain** — gated, when a version declares a measurable goal, on the metric being met (outcome-bound versions), not just child-ticket status.
3. **Turnkey teams.** A library of teammate archetypes — each with default skills and a default runtime (OpenClaw or Hermes) — lets anyone staff a domain in seconds instead of configuring from scratch. (e.g., Sam the lawyer · Kate the GTM specialist · Billy the fullstack eng.) Persona archetypes are also the delivery vehicle for vertical org templates (SMB / startup / enterprise).

## Current Status (audited 2026-05-29 against HEAD 1059d40)

### Shipped & live
- **Autonomy horizon (`approvedThrough`)** — agents execute ≤ horizon, hard-stop above; auto-advance within. Wired across scheduler, vision, roadmap, store APIs.
- **Outcome-bound versions (#1263)** — `successCriteria` / `metricCurrent` / `metricTarget` / `metricComparator` / `loopPaused` on versions; completion gates on the metric, not just child tickets. **Shipped & tested** (`version-metric.test.ts`).
- **Multi-tenant schema** — `org_studio_workspaces` + `org_studio_workspace_memberships` tables, `workspace-auth.ts` middleware, `/api/workspaces`, isolation tests. **Shipped.**
- **Per-agent API tokens (#1383)** — `api-tokens.ts`, `/api/admin/tokens`, tests.
- **Semver + approval-horizon convention** — decision doc present; *but repo does not actually follow one scheme — see Known Issues / #1560.*
- **Telegram demoted to health-alerts bridge** — comms relay OFF by default (`ENABLE_TELEGRAM_COMMS`).
- **Offline draft queue** — `useOfflineQueue`, drafts persist + flush on reconnect.
- **Activity feed + Performance dashboard** — real-time feed on home; `/performance` per-agent metrics.
- **Classic dashboard IA** — sidebar route group: projects, tasks, agents, cron, calendar, memory, vision, team, performance, health, activity, settings.

### Reverted (do not claim as shipped)
- **Thread-as-universal-primitive + mobile-first 3-tab IA (the v0.14 pivot)** — built, then **fully reverted** (commit `3c86dac "remove chat/DM feature"`). `ChatThread`, `DmSidebar`, `/dms/*`, `tabs/` routes, and the `proto-mobile` prototype are all gone. It crippled the structured affordances (roadmap, board, vision doc) by flattening everything into chat — fighting its own North Star. **Demoted permanently from a pillar.** May be revisited ONLY as an opt-in comms feature *within* a domain, siloed behind a `new-experience` flag, never as the product's foundation.

### Vaporware in the old doc (claimed, never built)
- **Web push notifications** — no service worker, no `pushManager`, zero push code. A `PUSH_NOTIFICATIONS` flag exists with no consumer. Either schedule for real or cut the claim. *(This revision cuts it from "shipped.")*

### Dead feature flags (toggles with no consumer)
- `MOBILE_FIRST_UX` (IA deleted), `PUSH_NOTIFICATIONS` (no push code), `TELEGRAM_MIGRATION` (script never authored). All three render in Settings but do nothing. **Action: remove or wire — tracked separately.**

## Conventions
- **Ownership is the primitive.** Tasks, roadmaps, vision sections, and metrics all hang off an accountable owner + domain. Any feature that doesn't sharpen ownership/autonomy/accountability is suspect.
- **One leash.** `autonomy.approvedThrough` per project is the single autonomy control. Agents execute ≤ horizon; humans move it. No parallel auto-approve flows.
- **One field per concept.** If the product grows a second flag/column describing the same thing as an existing one, simplify before shipping.
- **No dead toggles.** Don't ship a feature flag without a working consumer behind it. (Violated today — see Dead feature flags.)
- **Versioning — two deliberate schemes, never crossed (#1560):**
  - **Repo / skill releases → semver** (`package.json`, git release tags). Answers "is this a breaking change to the published artifact?"
  - **Product roadmap + autonomy horizon → calver** (`YYYY.MM`, e.g. `2026.05`). The store and `autonomy.approvedThrough` use this. Answers "how far along is the product, and how far is the agent leash extended?"
  - These answer different questions; conflating them caused the version mess. Repo semver and roadmap calver are independent and that is correct.

## Forward Arc
*Milestones are named; calver targets are the roadmap anchor (not `v0.x` labels — that numbering is retired per #1560). "Cloud Launch" remains the qualitative v1.0-equivalent gate: bet-your-business ready.*

- **Cloud Prep (current, ~2026.05–06).** Multi-tenant ✅, per-workspace auth ✅, per-agent tokens ✅. Remaining: onboarding flow polish, pre-launch security audit, Telegram migration script (or formally drop it). Close out the dead-flag cleanup + version-scheme reconciliation (#1560) here.
- **Autonomous Domain Evolution (Pillar 2 made real).** Promote outcome-bound versions from "shipped primitive" to a *product story*: manual→assisted metric capture, the experiment-loop UX, the "all tickets done but metric unmet → propose next experiment" nudge surfaced in the UI, loop safety caps visible. This is the moat — the thing competitors don't have.
- **Teammate Library (Pillar 3 made real).** Persona archetypes catalog with default skills + runtime. One-click staff-a-domain. Showcases runtime-agnosticism as a visible feature. Foundation for vertical templates.
- **Cloud Launch + Billing (the commercial-readiness gate).** Multi-tenant cloud opens publicly. Free tier (BYOA, 1 workspace). Paid tiers delivered as **vertical org templates** (SMB: accounting/legal/marketing/support · startup: MVP/design/GTM/CS · enterprise: TBD) — curated persona + roadmap bundles on top of the free core, not just seat counts. Legal + ops (LLC, ToS, privacy, GDPR, SLA).

## Commercialization (reframed)
- **OSS core stays free forever** — MIT, BYOA, runtime-agnostic. This is the top of the funnel, not a loss leader to be paywalled later.
- **Activation = Teammate Library.** A new workspace is useful in 60 seconds because you staff it from persona archetypes, not a blank board.
- **Monetization = vertical org templates, not seats.** Paid tiers are curated bundles of personas + roadmap scaffolding per segment (SMB / startup / enterprise), sitting on the free BYOA core.
- **Retention = autonomous evolution.** Owned domains that self-improve within guardrails are sticky in a way that a task board isn't.

## Designed but Unscheduled
*(Outcome-bound versions moved OUT of this section — it shipped. See Current Status.)*
- Thread-as-comms-within-a-domain (opt-in, flagged) — only if a clear need surfaces.
- Native mobile apps (post-v1.0 parking lot).
- Plugin system, calendar integration, AI task decomposition, agent self-awareness API — post-v1.0 parking lot.

## Boundaries
- **Fewer tools, not better tools** — every feature must replace a tool or deepen an existing surface.
- **Don't rebuild Slack.** Conversation is a feature inside a domain, never the product's foundation.
- No production deployments from Org Studio — it's the org layer, not CI/CD.
- No direct DB access — all data through store API.
- Runtime-agnostic by design — OpenClaw adapter optional.
- Keep the store file-backed for local mode — Postgres optional.
- MIT license — no proprietary features in the OSS core.
- **Versioning — two deliberate schemes, never crossed (#1560):** repo/skill releases use semver (`package.json`, git release tags); product roadmap + `autonomy.approvedThrough` use calver (`YYYY.MM`). Independent by design.
- **Stay pre-launch indefinitely until commercial readiness** — "Cloud Launch" = "bet-your-business ready," nothing before.

## Change History
| Date | Version | Author | Change |
|------|---------|--------|--------|
| 2026-06-02 | 2026.05 | Basil/Mikey | **Reality audit + North Star reframe.** Full codebase audit (HEAD 1059d40) corrected major drift: thread-as-primitive / mobile-first IA were REVERTED (not shipped) — demoted from a pillar; web push was never built — claim cut; multi-tenant schema + outcome-bound versions (#1263) were SHIPPED — promoted out of blocked/unscheduled. Reframed the North Star primitive from *thread* to *owned domain*. Established three pillars (Ownership / Autonomy within guardrails / Turnkey teams). Scheduled v0.17 (Autonomous Domain Evolution) + v0.18 (Teammate Library). Reframed commercialization around vertical org templates over seat tiers. Flagged 3 dead feature flags + the four-way version-scheme collision (cleanup ticket #1560). |
