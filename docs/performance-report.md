# Performance Report — Org Studio

**Date:** 2026-04-19  
**Task:** #733 — Performance optimization: bundle size audit + lazy-loading + build optimization  
**Commit:** `80acd1a` on `staging`

---

## 1. Bundle Size Baseline

### Before optimization (commit `33b66c5`)
| Metric | Value |
|--------|-------|
| Total JS (uncompressed) | 1,347.6 KB |
| Total JS (gzipped est.) | ~471.7 KB |
| Total CSS | 121.8 KB |
| JS chunk count | 38 |
| Build time | 26.3s |

### After optimization (commit `80acd1a`)
| Metric | Value |
|--------|-------|
| Total JS (uncompressed) | 1,374.2 KB |
| Total JS (gzipped est.) | ~481.0 KB |
| Total CSS | 121.8 KB |
| JS chunk count | 46 |
| Build time | 26.4s |

**Why total JS increased slightly:** Lazy-loading splits code into more, smaller chunks. The total includes all chunks for all pages. The trade-off is that any single page now loads *less* JS upfront since heavy components are loaded on-demand.

### Top 5 Largest Chunks (after)
| Size | Chunk |
|------|-------|
| 222.2 KB | React/Next.js framework |
| 133.4 KB | Shared component code |
| 111.8 KB | Route-specific code |
| 110.0 KB | Shared utilities |
| 69.3 KB | Route-specific code |

---

## 2. Heavy Components Identified

| Component | Lines | Used On | Lazy-Loaded? |
|-----------|-------|---------|--------------|
| RoadmapWithApprovalHorizon | 959 | `/projects/[id]` | ✅ Yes |
| ForceGraph | 714 | `/team` | ✅ Yes |
| TaskDetailPanel | 668 | `/context`, `/projects/[id]` | ❌ Used on 2 pages |
| VisionDetailPanel | 667 | *unused (dead code)* | N/A |
| SettingsModal | 641 | Layout (TopBar) | ❌ Critical path |
| OnboardingWizard | 641 | `/` (dashboard) | ✅ Yes |
| RoadmapEditor | 505 | *unused (dead code)* | N/A |
| SolarSystem | ~300 | *unused (dead code)* | N/A |
| AgentComparisonSection | 457 | `/performance` | ✅ Yes |
| CulturalAlignmentSection | 436 | `/performance` | ✅ Yes |
| TeamHealthSection | 372 | `/performance` | ✅ Yes |
| QualityScorecardSection | 382 | `/performance` | ✅ Yes |
| WeeklyDigestSection | ~300 | `/performance` | ✅ Yes |
| ReactMarkdown + remarkGfm | ext. dep | `/vision`, `/projects/[id]` | ✅ Yes |

---

## 3. Optimizations Applied

### 3.1 Lazy-Loading (next/dynamic, ssr: false)

**8 components lazy-loaded across 5 pages:**

1. **`/team` page** — `ForceGraph` (canvas physics simulation, 714 lines)
2. **`/projects/[id]` page** — `RoadmapWithApprovalHorizon` (959 lines) + `ReactMarkdown`
3. **`/performance` page** — 5 sections: `TeamHealthSection`, `QualityScorecardSection`, `CulturalAlignmentSection`, `AgentComparisonSection`, `WeeklyDigestSection` (~2000+ lines combined)
4. **`/vision` page** — `ReactMarkdown` (heavy markdown parser + micromark deps)
5. **`/` (dashboard)** — `OnboardingWizard` (641 lines, conditional display)

All lazy-loaded components include:
- `ssr: false` — skip server-side rendering for client-only components
- `loading` fallback — pulse animation or "Loading…" text

### 3.2 next.config.ts Improvements

- `compress: true` — Enable gzip compression for responses
- `reactStrictMode: true` — Catch potential issues in development
- `turbopack.root: '.'` — Silence the multi-lockfile workspace root warning

### 3.3 Dead Code Identified (not removed, flagged for cleanup)

These components exist but are never imported:
- `VisionDetailPanel.tsx` (667 lines)
- `RoadmapEditor.tsx` (505 lines)
- `SolarSystem.tsx` (~300 lines)

**Dead dependency:** `@hello-pangea/dnd` — in package.json but never imported in source. Tree-shaken out of the production build.

---

## 4. Build Performance

| Metric | Baseline | After | Target |
|--------|----------|-------|--------|
| Build time (wall clock) | 26.3s | 26.4s | <30s ✅ |
| Compile time (Turbopack) | 7.1s | 6.8s | — |
| TypeScript check | 15.6s | 15.5s | — |
| Static page gen | 0.85s | 0.82s | — |
| Build errors | 0 | 0 | 0 ✅ |

Build already met the <30s target before optimization. Turbopack (default in Next.js 16) handles this well.

---

## 5. Lighthouse Guidance for QA

**Cannot run Lighthouse in this environment.** Here's what to test:

### Setup
1. `cd org-studio && npm run build && npm start`
2. Open Chrome → DevTools → Lighthouse tab
3. Run audit with: Performance, Desktop, Navigation mode

### Expected Improvements
- **Reduced main thread work** on `/team`, `/performance`, `/projects/[id]`, `/vision` pages
- **Faster Time to Interactive (TTI)** — heavy components load after initial paint
- **Smaller initial JS** per page — chunks are split and loaded on-demand

### Target
- Desktop Performance score: **≥75**
- Key pages to test: `/`, `/team`, `/performance`, `/projects/<any-id>`, `/vision`

### What to watch for
- Components should show loading placeholder, then content
- No layout shift when lazy components load (placeholders have fixed height)
- Navigation between pages should work normally
- ForceGraph canvas on `/team` should render after brief "Loading graph…"

---

## 6. Implementation Checklist

- [x] Bundle size baseline documented (total + gzipped)
- [x] At least 2 heavy components lazy-loaded (8 components across 5 pages)
- [x] Build time measured (26.4s, target <30s)
- [x] Build passes (zero TS errors)
- [x] Performance report generated
- [x] Changes committed and pushed to staging
- [ ] QA: verify no navigation breakage (manual test needed)
- [ ] QA: Lighthouse desktop performance ≥75 (manual test needed)

---

## 7. Future Optimization Opportunities

1. **Remove dead code** — Delete `VisionDetailPanel.tsx`, `RoadmapEditor.tsx`, `SolarSystem.tsx` (~1,472 lines)
2. **Remove dead dependency** — `npm uninstall @hello-pangea/dnd`
3. **Image optimization** — Use `next/image` for any user avatars or team photos
4. **Font optimization** — Verify `geist` font is loaded with `display: swap`
5. **API route optimization** — Consider edge runtime for lightweight API routes
