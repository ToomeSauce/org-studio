# Vision Launch Model — Design Spec

> **⚠️ DEPRECATED** — This design was replaced on 2026-03-31.
> The launch flow now creates tasks directly from roadmap items (no vision cycle agent).
> Auto-advance is controlled by a 3-mode dropdown: next-only, auto-minor, auto-all.
> See `docs/guide.md` for the current model.

## Summary
Replace the cron-based vision cycle with a human-initiated "Launch" model. The human clicks a button to start the next version cycle. After launch, dev and QA agents work autonomously with status updates in the Telegram sprint topic. The human is notified of blockers and version completion.

## Current Model (being replaced)
- Daily/weekly cron fires → agent proposes version → human approves/rejects
- `cadence` field on project autonomy (daily/weekly/biweekly/monthly)
- Cron auto-created/deleted when autonomy toggled

## New Model

### Launch Flow
1. Human clicks **"Launch"** on a vision card in the UI
2. System calls `POST /api/vision/{id}/launch`
3. Launch endpoint fires a one-shot agent session (dev owner)
4. Dev agent reads VISION.md, finds next unshipped version, proposes it
5. Proposal sent to human via Telegram with ✅ Approve / ❌ Reject buttons
6. On approve: tasks created in backlog, sprint topic created, dev agent triggered
7. Dev works through tasks → QA validates → blockers notify human in topic
8. All tasks done → version ships → VISION.md auto-updates
9. **If within approval boundary** → system auto-launches next version (back to step 3)
10. **If at approval boundary** → stops, human must click Launch again

### Approval Boundaries
Two modes, configured per project:

| Mode | Field Value | Behavior |
|------|------------|----------|
| **Per-version** | `approvalMode: "per-version"` | Every version needs explicit human approval. After v0.9 ships, system waits for Launch again. |
| **Per-major** | `approvalMode: "per-major"` | Human approves once per major version. v0.9 ships → v0.10 auto-launches → v0.11 auto-launches → v1.0 stops and waits. |

Default: `per-version` (safest).

### What Changes

#### Remove
- `cadence` field from project autonomy config
- All vision cron jobs (delete existing project-specific crons)
- Auto-create/update/delete cron logic in `updateProject` store action
- `vision-cron.ts` cron management functions (registerVisionCron, updateVisionCron, deleteVisionCron)
- Cadence picker in UI

#### Add
- `approvalMode` field on project autonomy: `"per-version"` | `"per-major"` (default: per-version)
- `POST /api/vision/{id}/launch` endpoint — fires one-shot vision cycle for dev agent
- "Launch" button on vision cards in UI (only shown when project has a VISION.md)
- Auto-launch logic in `vision-completion.ts` — after version ships, check approval boundary and auto-launch if within bounds
- Approval mode picker in vision card UI (dropdown: "Approve each version" / "Approve per major version")

#### Keep
- Everything about sprint topics, status updates, devHandoff, board cross-referencing
- The propose/approve/reject flow (human still approves the specific version plan)
- The vision prompt builder (`vision-prompt.ts`)
- The VISION.md auto-update on completion

### API

```
POST /api/vision/{id}/launch
→ Fires one-shot agent session with vision cycle prompt
→ Returns { ok: true, launched: true }
→ If no VISION.md: returns { error: "No vision document" }
→ If already in-flight (pendingVersion set): returns { error: "Version already in progress" }
```

### Auto-Launch Logic (in vision-completion.ts)
When a version completes:
1. Check project.autonomy.approvalMode
2. If `per-major`: parse completed version number. If next version is same major (e.g., 0.9 → 0.10), auto-call launch endpoint. If next is new major (0.x → 1.0), stop.
3. If `per-version`: always stop. Human must click Launch.

### UI Changes
- Vision card: Replace cadence dropdown with approval mode dropdown
- Vision card: Add "🚀 Launch" button (disabled if no VISION.md or version in-flight)
- Vision card: Show current status (idle / proposing / in-progress / awaiting approval)
