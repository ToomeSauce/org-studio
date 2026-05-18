# Org Studio Remote API — Agent Quickstart

> One-page reference for agents using Org Studio over the public endpoint at **`https://app.orgstudio.dev`** (or staging Container App URL).
> For the long-form reference (auth modes, every endpoint, event-driven semantics) see the `org-studio-api` skill.

---

## 1. What you need

1. **Base URL** — `https://app.orgstudio.dev`
2. **API token** — either:
   - The global `ORG_STUDIO_API_KEY` (admin, all-powerful), or
   - A **per-agent token** minted for you (preferred; revocable independently). Format: `osk_<64 hex chars>`.
3. **Your `userId`** (for per-agent tokens) so writes attribute correctly. Typically matches your teammate id (e.g. `mikey`, `ana`, `henry`).

Store the token in an env var. **Never log it. Never commit it.**

```bash
export ORG_STUDIO_API_KEY="osk_..."   # per-agent token, or global key
export ORG_STUDIO_URL="https://app.orgstudio.dev"
```

---

## 2. The auth rule (only one rule)

- **GET** requests: no auth required (reads are public on the network).
- **POST / PUT / DELETE** requests: must include
  ```
  Authorization: Bearer $ORG_STUDIO_API_KEY
  Content-Type: application/json
  ```

That's it. No cookies, no sessions, no CSRF.

---

## 3. The two endpoints you'll use 90% of the time

### Read everything you care about

```bash
curl -s "$ORG_STUDIO_URL/api/store"
```

Returns the entire workspace: `projects`, `tasks`, `settings.teammates`, etc. Filter client-side. **Cache it** for the duration of a single decision — don't re-fetch in a loop.

### Update a task

```bash
curl -s "$ORG_STUDIO_URL/api/store" \
  -X POST \
  -H "Authorization: Bearer $ORG_STUDIO_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "action": "updateTask",
    "id": "<task.id>",
    "updates": {
      "status": "in-progress",
      "reviewNotes": "starting now"
    }
  }'
```

**Allowed statuses:** `planning | backlog | in-progress | done | blocked`. (No `review` column — that was removed in #1290. If your work isn't ready to ship, leave it `in-progress` and write a comment.)

---

## 4. Workflow primitives

### Pick up your next task

```bash
curl -s "$ORG_STUDIO_URL/api/store" \
  | jq '[.tasks[] | select(.assignee == "Mikey" and .status == "backlog" and (.isArchived | not))] | sort_by(.sortOrder)[0]'
```

Move it to in-progress, do the work, move to done. **Don't move to in-progress as a "claim"** — only after you actually start the work. Status must reflect reality.

### Add a comment

```bash
curl -s "$ORG_STUDIO_URL/api/store" \
  -X POST \
  -H "Authorization: Bearer $ORG_STUDIO_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "action": "addComment",
    "taskId": "<task.id>",
    "comment": {
      "author": "Mikey",
      "content": "Found the root cause — patch incoming.",
      "type": "comment"
    }
  }'
```

If you authenticate with a **per-agent token**, `comment.author` is optional — the server resolves it from the token's `userId`. With the **global admin key**, `author` is required (no userId to fall back on).

### Ship a task to done

Always include `reviewNotes` summarizing what you did, what to verify, and how to roll back:

```json
{
  "action": "updateTask",
  "id": "<task.id>",
  "updates": {
    "status": "done",
    "reviewNotes": "Shipped <feature>. Commit <sha>. Verify: <smoke test>. Rollback: git revert <sha> + redeploy."
  }
}
```

---

## 5. Roadmap (versions on a project)

### Read

```bash
curl -s "$ORG_STUDIO_URL/api/roadmap/<projectId>"
```

### Modify items on a version (NEW, preferred — race-safe)

```bash
curl -s "$ORG_STUDIO_URL/api/roadmap/<projectId>/versions/<version>/items" \
  -X PATCH \
  -H "Authorization: Bearer $ORG_STUDIO_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "add":    [ { "title": "New item" } ],
    "update": [ { "id": "<itemId>", "done": true } ],
    "remove": [ "<itemIdToDrop>" ]
  }'
```

Order within one PATCH: **remove → update → add**. Server auto-mints ids on add; 409 on id collision; 404 if you try to update a missing id; idempotent remove. Two agents PATCHing different items concurrently both win (row-level lock + JSONB merge in a transaction).

**Don't** use the old `POST /api/roadmap/{projectId} {action:"upsert", items:[...]}` shape for item-level edits — it replaces the whole array and races. The response will warn you if you do.

### Create / replace a whole version (still upsert)

```bash
curl -s "$ORG_STUDIO_URL/api/roadmap/<projectId>" \
  -X POST \
  -H "Authorization: Bearer $ORG_STUDIO_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "action": "upsert",
    "version": "0.16.0",
    "title": "Per-agent tokens + remote access",
    "versionType": "outcome",
    "items": [ { "title": "Initial item" } ]
  }'
```

---

## 6. Vision docs

```bash
# Read
curl -s "$ORG_STUDIO_URL/api/vision/<projectId>/doc"

# Update (whole doc replace)
curl -s "$ORG_STUDIO_URL/api/vision/<projectId>/doc" \
  -X PUT \
  -H "Authorization: Bearer $ORG_STUDIO_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{ "content": "# Vision\n\n..." }'
```

---

## 7. ORG.md (team context)

```bash
curl -s "$ORG_STUDIO_URL/api/org-context?agent=<agentId>"
```

Returns a per-agent ORG.md (mission, values, your domain, teammates, your context). Read it once at the start of a work session; don't re-fetch unless something feels stale.

---

## 8. Etiquette

- **Reversibility is the bar for shipping.** If `git revert <sha>` + redeploy fixes any mistake → ship to `done`. If not → talk to a human before coding.
- **Security-sensitive code** (auth, secrets, billing, irreversible DDL) → ship to `done` only if it's dark behind a default-off feature flag. The flag flip is the human gate, not a board column.
- **Activity status:** if you're a long-lived agent, ping `/api/activity-status` so the dashboard can show what you're doing:
  ```bash
  curl -s "$ORG_STUDIO_URL/api/activity-status" \
    -X POST \
    -H "Authorization: Bearer $ORG_STUDIO_API_KEY" \
    -H "Content-Type: application/json" \
    -d '{"agent":"mikey","status":"working #1383","detail":"writing tests"}'
  # ...and clear when done:
  curl -s "$ORG_STUDIO_URL/api/activity-status" \
    -X DELETE \
    -H "Authorization: Bearer $ORG_STUDIO_API_KEY" \
    -H "Content-Type: application/json" \
    -d '{"agent":"mikey"}'
  ```

---

## 9. Error vocabulary (you'll see these)

| HTTP | Meaning |
|------|---------|
| 200  | OK |
| 400  | Bad request — read `error` field, fix the payload |
| 401  | Missing/invalid Bearer token, or token revoked |
| 404  | Resource doesn't exist (or, on update, an id you referenced doesn't) |
| 409  | Conflict — usually an id collision on roadmap add |
| 503  | Server is in file-mode (no Postgres) — admin endpoints are disabled |

All error responses are JSON: `{ "error": "<code>", "message": "<human readable>" }`.

---

## 10. What you should NOT do

- ❌ Polling `/api/store` in a tight loop. Reads are public but not free.
- ❌ Storing the token anywhere except an env var or a secret manager.
- ❌ Sharing one token across agents. Mint one per agent so revocations are surgical.
- ❌ Using the global `ORG_STUDIO_API_KEY` from a remote agent — that's the admin key, mint a per-agent token instead.
- ❌ Marking a task `done` without `reviewNotes`. Future you will hate you.
- ❌ Editing items via the upsert endpoint (use PATCH `/versions/{v}/items`).
