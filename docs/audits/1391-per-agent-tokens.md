# 1391 — Per-agent token migration: prep, findings, runbook

**Status:** Plumbing verified end-to-end on local. Production migration blocked on OpenClaw upstream (per-agent env injection). Documented runbook + first agent (`mikey`) minted as proof.

**Reversibility:** every step in §3 is reversible — revoke the token, unset `ENABLE_PER_AGENT_TOKENS`, remove `agentToken` field from teammate record. No DDL, no irreversible writes.

---

## 1. What the ticket originally asked

From #1391: *"Today every agent loop calls /api/store etc. with the global ORG_STUDIO_API_KEY (the break-glass path in #1387 B.3 audit). Once #1383 per-agent tokens are GA, migrate each agent loop to use a per-agent token instead. Per agent: assign token, update env in systemd unit / scheduler config, verify org_studio_admin_audit shows via='agent-token' + correct userId."*

## 2. What I found (the gap)

### 2a. #1383 per-agent tokens are code-GA but flag-gated

- Mint/list/revoke API: `src/app/api/admin/tokens/route.ts` + `[id]/route.ts` — work.
- Verification path in `/api/store/route.ts:455-465` — works, but gated on `perAgentTokensEnabled()`.
- The flag (`ENABLE_PER_AGENT_TOKENS`) was **not set anywhere in deployed env**. So #1383 was effectively dark in production.
- Action taken locally: set `ENABLE_PER_AGENT_TOKENS=true` in `.env.local` for verification. Restarted dashboard, end-to-end works.
- **For production rollout:** the flag has to be flipped in the deployed env (staging Azure Container App / wherever) before any per-agent token will actually authenticate.

### 2b. Agent "loops" don't live where the ticket assumed they did

The ticket says: *"update env in systemd unit / scheduler config"*. Reality is more layered:

- The only systemd unit is `mc-dashboard.service` — runs the Next.js server + the scheduler that polls agent state and dispatches via OpenClaw gateway.
- The actual agent loops (mikey, ana, henry, sam, billy, hermes-*) run inside **OpenClaw**, which dispatches them via `sendToAgent(agentId, message)` → `chat.send` RPC on the gateway. The agents are subagent processes managed by OpenClaw, not separate systemd units.
- Each agent process inherits its env from the **OpenClaw gateway shell env**, which is currently a single process with one shared `ORG_STUDIO_API_KEY`. **There is no per-agent env injection hook in OpenClaw config.** Verified via `gateway config.schema.lookup agents.list.*` — `agents.list.*` is `additionalProperties: false` and exposes no `env`/`docker.env` field for the OpenClaw runtime.
- There IS an `agentDocker.env` map in OpenClaw's dist code, but that's a docker sandbox config, not the per-session env construction.

**Conclusion:** even if we mint a per-agent token for every teammate, there's no way to wire it into the right agent's runtime env from inside this repo. The OpenClaw gateway would need a new config field (e.g. `agents.list[].env`) that agent sessions read from, or a side-channel where org-studio publishes per-agent tokens and OpenClaw fetches them at session-spawn time. **Both are upstream changes outside Mikey's domain (Labs).**

### 2c. Audit path doesn't cover legitimate per-agent token writes

- `auditBreakGlassIfNeeded` (in `/api/store/route.ts` and elsewhere) is named that way for a reason: it ONLY writes an audit row when the request authenticated via the **break-glass** path (global ORG_STUDIO_API_KEY). Per-agent tokens are by-design the legitimate path — they're not audited as break-glass.
- Verified locally: addComment with `osk_*` per-agent token → response 200, comment posted, **zero audit rows written**. Token's `last_used_at` IS updated in `org_studio_api_tokens`.
- The ticket's success criterion ("audit shows via='agent-token' + correct userId") is therefore wrong-shaped. Per-agent token attribution is observable via:
  - `org_studio_api_tokens.last_used_at` per token row (already wired)
  - `last_used_at` joined to `user_id` for "who acted when"
  - NOT `org_studio_admin_audit` rows (which would defeat the purpose of the audit log — it's there to surface the break-glass exceptions, not the normal traffic)

### 2d. Caller-supplied `comment.author` is trusted by the route

Tested by posting a comment via per-agent token with `comment.author = "mikey-via-per-agent-token"`. The route accepted that string verbatim. Meaning **a per-agent token authenticated as user=mikey could post a comment claiming to be from "ana".** That's a latent issue. Out of scope here, but flag this when planning #1393+ — the right behavior is "if authenticated as user X via per-agent token, force comment.author = X (or X's display name)".

## 3. Migration runbook (for when OpenClaw can inject per-agent envs)

### 3.1 Mint tokens — DONE for `mikey`, deferred for others

```bash
source .env.local
curl -s -X POST -H "Authorization: Bearer $ORG_STUDIO_API_KEY" -H "Content-Type: application/json" \
  -d '{"userId":"<AGENT_ID>","label":"<AGENT> scheduler loop (#1391)","scope":"write","createdBy":"basil"}' \
  http://localhost:4501/api/admin/tokens
```

- One token per agent, scope=`write` (they mutate the store via addComment/updateTask).
- Plaintext token is shown ONCE in the response. Store securely (e.g., Azure Key Vault) — it cannot be retrieved later, only revoked + re-minted.
- For `mikey`: minted on 2026-05-18 with id `tok-5095e63578d8`, label `"mikey scheduler loop (#1391 prep)"`. Plaintext stored in `/tmp/mikey-token-1391.txt` on hanktank (0600). Will be moved to a real secret store once the rollout is real.

### 3.2 Enable the feature flag in deployed env

```bash
# Staging Azure Container App
az containerapp update --name aca-catcontainerapp-staging --resource-group rg-cat-staging \
  --set-env-vars ENABLE_PER_AGENT_TOKENS=true
```

(Confirm with `az containerapp show --query 'properties.template.containers[0].env'`.)

This makes `/api/store` accept per-agent tokens. Until the upstream is wired, the global key continues to work (the route checks the global key first, falls through to per-agent).

### 3.3 OpenClaw upstream: per-agent env injection (BLOCKED)

This is the actual cutover step. Two viable shapes:

- **Shape A — static config:** OpenClaw adds `agents.list[].env` as a string map in the config schema. Operator sets `agents.list[id=mikey].env.ORG_STUDIO_API_KEY = osk_xxx` for each agent. Restart gateway, done. Simple, but rotates require a config edit + restart.

- **Shape B — side-channel:** OpenClaw adds a `org-studio.api-token-endpoint` config field pointing to e.g. `http://localhost:4501/api/agent-env`. At session-spawn time, OpenClaw POSTs `{ agentId }` (signed with a shared secret or via a service-side admin key) and gets back `{ env: { ORG_STUDIO_API_KEY: "osk_xxx" } }` to inject into the session env. Rotations don't need a gateway restart.

Either way, this is an **OpenClaw repo change**, not an Org Studio repo change. File a parallel ticket against the OpenClaw project once this is prioritized.

### 3.4 Per-agent verification (after upstream lands)

For each migrated agent:
1. Confirm the agent's runtime now sees `ORG_STUDIO_API_KEY=osk_xxx` (not the global key). The agent itself can `echo "$ORG_STUDIO_API_KEY" | head -c 8` in an exec call and confirm it starts with `osk_`.
2. Have the agent perform a real action (addComment on their own current ticket).
3. Verify `SELECT user_id, last_used_at FROM org_studio_api_tokens WHERE id = '<token-id>'` updated.
4. Confirm `org_studio_admin_audit` does NOT have a new row for that action (= correct: legitimate per-agent path is not break-glass).
5. Try a write WITHOUT the token (e.g., empty Authorization header) and confirm 401 — proves the global key was actually removed from that agent's env.

### 3.5 Rollback (per agent)

If an agent fails after migration:
1. Revoke the per-agent token: `DELETE /api/admin/tokens/<id>` (soft-revoke, sets `revoked_at`).
2. Reset the agent's `ORG_STUDIO_API_KEY` env to the global key (re-deploy gateway config or via side-channel).
3. Restart the agent's session — it picks up the global key on next dispatch.

Token revocation is fast (one row update). The agent will fail-401 immediately on next write attempt, which is the desired safe-stop behavior.

## 4. What I shipped on this ticket

| Item | Status |
|---|---|
| Mint #1383 token for `mikey` | ✅ `tok-5095e63578d8` |
| Verify per-agent token authenticates on /api/store | ✅ GET 200, POST 200 (with `ENABLE_PER_AGENT_TOKENS=true`) |
| Verify `last_used_at` updates on the token row | ✅ |
| Verify caller-supplied comment.author is trusted (latent issue logged) | ✅ |
| Local env: `ENABLE_PER_AGENT_TOKENS=true` in `.env.local` | ✅ |
| Production env flag flip (Azure) | ⏸ Defer until upstream gateway plumbing is ready |
| Migrate remaining agents (ana, henry, sam, billy, hermes-*) | ⏸ Defer to per-agent tickets after upstream lands |
| OpenClaw upstream: per-agent env injection | ❌ Out of Mikey's domain — file as separate ticket against OpenClaw |
| Document the runbook | ✅ This file |

## 5. Recommended follow-ups

1. **#1391-A (OpenClaw):** Add per-agent env injection (Shape A or B above). Owner: ask Basil to route to the right person — could be a Henry/Ana/upstream-OpenClaw split.
2. **#1391-B (org-studio):** Trust-the-token-not-the-claim for `comment.author`. When authenticated via per-agent token (user_id known), override caller-supplied `author` with the resolved user_id's display name. Low risk, in-domain.
3. **#1391-C (per-agent rollout):** Once 1391-A lands, mint tokens for the remaining 8 teammates and do the cutover one agent at a time over a week (so failures are isolated and bounce-back is per-agent).
4. **Investigate stale-write replay surfaced by audit log** (logged in 2026-05-18 memory note): a mysterious break-glass `store.updateTask` at 20:28:16 reverted my done write on #1389. The audit log can surface this kind of bug today, but needs caller fingerprinting (requestMeta) to be diagnostically useful.

---

*Author: mikey · Date: 2026-05-18 · Branch: mikey/1391-per-agent-token-migration-prep*
