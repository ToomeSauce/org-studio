# Decision: Calendar Versioning (CalVer)

**Status:** ✅ Approved & implemented  
**Date:** 2026-04-22  
**Supersedes:** `2026-04-19-version-numbering-convention.md`

---

## Rule

### Versions

All new Org Studio releases use **CalVer**: `YYYY.MM.DD` or `YYYY.MM.DD.N` for same-day hotfixes.

```
2026.04.22      first release of the day
2026.04.22.1    same-day hotfix
2026.04.22.2    second same-day hotfix
```

No `v` prefix. Storage and display match exactly.

**Legacy SemVer entries** (`MAJOR.MINOR.PATCH`) remain valid for read purposes — the historical roadmap (v0.1.0 through v0.16.0) was migrated to CalVer dates in this session. New entries must use CalVer.

### Approval horizon

`project.autonomy.approvedThrough` — a single CalVer string per project.

Same semantics as before: agent executes tasks whose version ≤ `approvedThrough`. Only humans move the horizon.

---

## Why CalVer

- Releases map to real dates, not arbitrary numbers. Much easier to reason about history.
- Eliminates "what does 1.0 mean?" decisions.
- Same-day hotfixes are obvious: `2026.04.22.1`.
- Sort order is natural chronological order.

---

## Implementation

### Version format rules

| Format | Example | Valid |
|--------|---------|-------|
| CalVer full date | `2026.04.22` | ✅ |
| CalVer with micro | `2026.04.22.1` | ✅ |
| SemVer (legacy) | `0.15.0` | ✅ (read only) |
| SemVer with v prefix | `v0.15.0` | ❌ |
| 2-part | `0.15` | ❌ |

### Files changed

| File | Change |
|------|--------|
| `src/lib/version-utils.ts` | Rewrote — dropped semver package, native part-by-part comparison supporting both CalVer and SemVer; added `isCalver()`, `todayCalver()`, `nextCalver()` helpers |
| `src/app/api/roadmap/[projectId]/route.ts` | Validation now accepts CalVer **or** SemVer (removed hard semver dependency) |
| `src/lib/org-generator.ts` | Updated ORG.md version rule to document CalVer |
| `scripts/migrate-to-calver.mjs` | One-shot migration script (already applied) |

### Migration applied (2026-04-22)

All 18 proj-mc roadmap versions migrated:

| SemVer | CalVer |
|--------|--------|
| 0.1.0 | 2026.03.15 |
| 0.2.0 | 2026.03.18 |
| 0.3.0 | 2026.03.19 |
| 0.4.0 | 2026.03.20 |
| 0.5.0 | 2026.03.25 |
| 0.6.0 | 2026.03.29 |
| 0.7.0 | 2026.03.29.1 |
| 0.8.0 | 2026.04.01 |
| 0.9.0 | 2026.04.05 |
| 0.10.0 | 2026.04.10 |
| 0.11.0 | 2026.04.17 |
| 0.12.0 | 2026.04.18 |
| 0.13.0 | 2026.04.18.1 |
| 0.14.0 | 2026.04.18.2 |
| 0.14.1 | 2026.04.19 |
| 0.15.0 | 2026.04.20 |
| 0.16.0 | 2026.04.22 ← current release |
| 1.0.0 | 2026.05.01 ← planned public launch |

`approvedThrough`: `0.16.1` → `2026.04.22.1`

---

## Next release

The current release is `2026.04.22`. The next planned version is `2026.05.01` (public launch).
To cut a release today: use `2026.04.22` (already shipped). Next same-day: `2026.04.22.1`.
Tomorrow's first release: `2026.04.23`.
