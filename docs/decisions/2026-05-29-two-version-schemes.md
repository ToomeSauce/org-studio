# Version Scheme Decision — Two Schemes, Never Crossed

- **Date:** 2026-05-29
- **Decider:** Basil (blessed); investigated + authored by Mikey
- **Ticket:** #1560
- **Supersedes:** the "semver everywhere" framing in [`2026-04-19-version-numbering-convention.md`](./2026-04-19-version-numbering-convention.md) (see Amendment note below)

## Decision

Org Studio uses **two deliberate, independent version schemes**. They answer different questions and must never be crossed or reconciled into one.

| Scheme | Surface | Format | Answers |
|---|---|---|---|
| **semver** | `package.json`, git release tags, org-studio-api skill releases | `MAJOR.MINOR.PATCH` (e.g. `0.4.0`) | "Is this a breaking change to the published artifact?" |
| **calver** | store `project.currentVersion`, section `approvedVersions[]`, task `version`, the autonomy horizon | `YYYY.MM.DD` (e.g. `2026.05.07`) | "How far along is the product, and how far is the agent leash extended?" |

## Why two, not one

The earlier instinct ("pick ONE scheme") was wrong. The repo was not running four competing schemes for one concept — it was running **two legitimate schemes for two different concepts**, plus noise:

- `package.json` semver (`0.3.1 → … → 0.4.0`) tracks the **published repo/skill artifact** release cadence. Correct use of semver. The `0.4.0` was never a "reset" of the product milestone — it's the skill/repo release line.
- The store has always used **calver** for the product roadmap and the autonomy horizon. The roadmap is inherently date-driven; calver reads naturally for a horizon leash.
- The `v0.11`–`v0.16` numbers existed **only in git commit-message prose** — never in a data field. Retired as a labeling habit.
- Sentinel junk (`99.99.99` / `99.99.95` / `99.99.20`) on 4 probe/smoke test tasks — deleted 2026-05-29.

Conflating the two is what *created* the appearance of a mess. Naming them clearly and never crossing them is the fix.

## The autonomy horizon — corrected mechanism note

During #1560 investigation we confirmed the horizon is **NOT** controlled by `project.autonomy.approvedThrough`. That field was a legacy single-scalar bridge and is now **actively stripped** by the store route (#1112 / #1224, defense-in-depth in `addProject` + `updateProject`). The live leash is **per-section/component `approvedVersions[]`** (a calver set-membership list). For `proj-org-studio` the "Main" section's `approvedVersions[]` runs clean calver through `2026.05.07`. There was no missing anchor to fix — the earlier audit looked at the dead field.

## Amendment to the 2026-04-19 convention doc

The 2026-04-19 doc said "3-part semver everywhere, no `v` prefix, single source of truth = `autonomy.approvedThrough`." Two parts of that are now superseded:
1. "semver everywhere" → **semver for the published artifact only; calver for roadmap + horizon.**
2. "single source of truth = `autonomy.approvedThrough`" → **per-section/component `approvedVersions[]`** (the scalar field is retired).
The "no `v` prefix" rule stands for both schemes.

## Cleanup done under #1560
- ✅ Deleted 4 sentinel-version probe/smoke test tasks (`99.99.x`).
- ✅ Confirmed `project.currentVersion` (`2026.05.07`) and `approvedVersions[]` are already valid calver — no migration needed.
- ✅ This decision doc recorded.

## Follow-up (not blocking #1560 close)
- **Validation guard** (CI or pre-commit): assert `package.json` version is valid semver; assert all store `version` / `approvedVersions[]` / `currentVersion` entries match `YYYY.MM(.DD)(.N)?` calver; reject `99.99.x` and bare `vX.Y` strings. Filed as a follow-up so the schemes can't silently drift again.
- **Git convention:** stop `v`-prefixing feat commit messages; release commits use bare semver.
