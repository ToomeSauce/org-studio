# Decision: Version Numbering & Approval Horizon

**Status:** ✅ Approved & fully implemented; holding steady in production
**Date:** 2026-04-19
**Last update:** 2026-04-20 (post-migration stability review)

---

## Rule

### Versions

All versions are 3-part semver. No `v` prefix. Storage and display match exactly.

```
0.14.1    0.15.0    1.0.0    2.0.0
```

Sort by semver. That's it.

### Approval horizon

One field per project: `project.autonomy.approvedThrough` (a semver string).

- Agent executes any task whose version ≤ `approvedThrough`.
- Agent does **not** execute anything above it, ever.
- Only a human moves `approvedThrough`.
- **Auto-advance within horizon, hard-stop at horizon.** When all tasks in the current version ship, the system automatically promotes the next planned version to `current` and moves its planning tasks into backlog — but ONLY if that next version is still ≤ horizon. If it exceeds horizon, the system stops and waits for a human to bump `approvedThrough`.
- **In-progress & QA tasks are grandfathered** — once approved to start, they finish even if the horizon doesn't move.

No states, no tags, no notes, no audit log, no patch/minor distinction at the rule level. Humans assign version numbers; semver handles order.

---

## Why this works

- One mental model, one field, one comparison.
- No surprise execution — human always extends the leash explicitly.
- Nothing to maintain: no state machine, no lifecycle enum, no backfill scripts when rules change.
- Trust the human to pick good version numbers and sensible horizon moves.

---

## Implementation status — ✅ Complete

| # | Item | Status |
|---|------|--------|
| 1 | All DB versions in 3-part semver (112 roadmap rows + project `currentVersion`) | ✅ |
| 2 | All `parseFloat` on versions removed from `src/` (10 files) | ✅ |
| 3 | `project.autonomy.approvedThrough` is the single source of truth | ✅ |
| 4 | Version completion no longer bumps `approvedThrough` (auto-advance killed) | ✅ |
| 5 | Backlog-pull horizon-gated (`scheduler.ts` + `scheduler/route.ts`) | ✅ |
| 6 | In-progress + QA tasks grandfathered | ✅ |
| 7 | Vision auto-approve flow quarantined (`complete`, `callback`, `approve`, `reject` → 410 Gone) | ✅ |
| 8 | `roadmap-sync.ts` simplified — only marks current version shipped, no auto-launch | ✅ |
| 9 | Dead `autoAdvance` flag removed from UI (3 sites) + store integrity guard + DB (9 projects) | ✅ |
| 10 | `v` prefix stripped from ~25 display + log + template sites | ✅ |
| 11 | Dead top-level `project.approvedThrough` column dropped from DB (14 projects) | ✅ |
| 12 | Legacy parseFloat-on-version scripts deleted (`reconcile-roadmap-items.mjs`, `repair-current-version.mjs`) | ✅ |
| 13 | API validation: `POST /api/roadmap/[projectId]` rejects non-semver (no `v`, no 2-part) | ✅ |
| 14 | ORG.md generator includes "Versions & Approval Horizon" section so all agents follow the rule | ✅ |

### Backward compat preserved

- `vision-completion.ts` regex accepts both `### v0.14` (legacy) and `### 0.14.0` (new) headers when reading existing VISION.md files. New headers are emitted without `v`.
- DB read paths defensive: `autonomy?.approvedThrough || null` everywhere. Missing field = no execution (safe default).

---

## Audit history

- **2026-04-19 (initial migration):** parseFloat → semver in `projects/[id]/page.tsx` + DB version normalization. Missed 9 other files using parseFloat on versions, missed roadmap-versions table, missed top-level vs nested `approvedThrough` field mismatch.
- **2026-04-19 (part 2):** swept remaining parseFloat sites (10 files), migrated roadmap-versions table (112 rows) + project approvedThrough field.
- **2026-04-19 (KISS pass):** consolidated `approvedThrough` to nested location, killed auto-advance, added horizon-gated task filter in scheduler.
- **2026-04-19 (cleanup pass):** items 7-14 above. Quarantined parallel auto-approve flow, removed dead `autoAdvance` flag, stripped `v` prefix everywhere, added API validation, taught ORG.md generator the rule, dropped dead DB fields, deleted 2 legacy scripts.
- **2026-04-20 (auto-advance within horizon):** Added guarded auto-advance in `roadmap-sync.ts`. When a version's tasks all ship: mark shipped → find next planned → if ≤ horizon, promote to current + move tasks to backlog; if > horizon, hard stop. Horizon itself is never written by this code path. Closes "click Launch once per version" UX gap while preserving human-holds-leash contract.
- **2026-04-20 (stability review):** Convention has survived three sprints (v0.14 cleanup, v0.14.1 composer, v0.15 polish). No parseFloat regressions. No `v`-prefix regressions. `invalid_version` API guard has rejected zero malformed writes in the wild (regex held). Auto-advance fired cleanly for 0.14 → 0.14.1. Open observation: `currentVersion` on `proj-mc` drifted to `null` at some point during the v0.15 sprint — likely a race between roadmap-sync and a manual edit. Symptom: auto-advance couldn't engage even though horizon was 0.16. Remediation is operational (`PATCH` currentVersion on the project), not structural — rule still stands.

---

## Verified contract (smoke tests passed 2026-04-19 23:15 EDT)

```bash
# Reject `v` prefix
$ curl -X POST /api/roadmap/proj-mc -d '{"action":"upsert","version":"v0.99",...}'
{"error":"invalid_version","message":"Version \"v0.99\" is not valid semver..."}

# Reject 2-part
$ curl -X POST /api/roadmap/proj-mc -d '{"action":"upsert","version":"0.99",...}'
{"error":"invalid_version","message":"Version \"0.99\" is not valid semver..."}

# ORG.md teaches the rule
$ curl /api/org-context?agent=mikey | grep "Versions & Approval Horizon"
## Versions & Approval Horizon
- **Versions are 3-part semver.** ...
```
