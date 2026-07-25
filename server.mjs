import { createServer } from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import { watch, readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import next from 'next';

// Load .env.local so server.mjs has the same env vars as Next.js route handlers
// (notably ORG_STUDIO_API_KEY for self-calls to /api/scheduler)
const __envDir = dirname(fileURLToPath(import.meta.url));
try {
  const envPath = join(__envDir, '.env.local');
  if (existsSync(envPath)) {
    const envContent = readFileSync(envPath, 'utf-8');
    for (const line of envContent.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eqIdx = trimmed.indexOf('=');
      if (eqIdx < 0) continue;
      const key = trimmed.slice(0, eqIdx).trim();
      const val = trimmed.slice(eqIdx + 1).trim();
      if (!process.env[key]) process.env[key] = val; // don't override existing
    }
  }
} catch {} // best-effort
import { getRuntimeRegistry } from './lib/runtimes.mjs';
import { renderLeashBlock } from './lib/leash-block.mjs';
import { ensureHeartbeatSchema, startLoopWatchdog, logIncident } from './lib/heartbeats.mjs';
import { ensureOutboxSchema, startOutboxWorker } from './lib/outbox.mjs';
import { ensureSkillInstallsSchema, runDriftCheck } from './lib/skill-installs.mjs';
import { initHealthAlerts, sendHealthAlert, isHealthAlertsEnabled } from './lib/health-alerts.mjs';
import { startHostSampler } from './lib/host-sampler.mjs';
import { verifyWebhookSignature, resolveWebhookSecret } from './lib/webhook-auth.mjs';
import { shouldRunNotificationListenBridge } from './lib/runtime-ownership.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const port = parseInt(process.env.PORT || '4501');
const dev = false;

// --- Telegram comms guard (v0.15) ---
const ENABLE_TELEGRAM_COMMS = (() => {
  const val = (process.env.ENABLE_TELEGRAM_COMMS || 'false').toLowerCase().trim();
  return val === 'true' || val === '1' || val === 'yes';
})();

// --- Telegram notification helper ---
const TG_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const TG_CHAT_ID = process.env.TELEGRAM_CHAT_ID || process.env.NOTIFY_CHAT_ID || '';

function sendTelegramNotification(message) {
  if (!ENABLE_TELEGRAM_COMMS) return; // v0.15: comms relay disabled by default
  if (!TG_BOT_TOKEN || !TG_CHAT_ID) return;
  fetch(`https://api.telegram.org/bot${TG_BOT_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: TG_CHAT_ID, text: message, parse_mode: 'Markdown' }),
  }).catch(err => console.error('[Telegram] Send failed:', err.message));
}

// --- Activity Feed (in-memory ring buffer) ---
const ACTIVITY_FEED_MAX = 200;
const activityFeed = [];
function addActivityEvent(event) {
  const entry = {
    id: `evt-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    timestamp: Date.now(),
    ...event,
  };
  activityFeed.unshift(entry);
  if (activityFeed.length > ACTIVITY_FEED_MAX) activityFeed.length = ACTIVITY_FEED_MAX;
  broadcast('activity-feed', activityFeed.slice(0, 50)); // send latest 50 to clients
  return entry;
}

// Export for use by API routes
globalThis.__orgStudioActivityFeed = {
  add: addActivityEvent,
  get: () => activityFeed.slice(0, 50),
};

// Seed the activity feed from recent task statusHistory (survives restarts)
function seedActivityFeedFromStore(store) {
  if (!store?.tasks?.length) return;
  const projects = store.projects || [];
  const projectMap = {};
  for (const p of projects) projectMap[p.id] = p.name;

  // #1290 (2026-05-08): 'review' kept here so legacy activity-feed entries still emojify; new tasks won't produce them.
  const statusEmoji = { 'in-progress': '⚙️', 'review': '👀', 'done': '✅', 'blocked': '🚫', 'qa': '🧪' };
  const recentEvents = [];
  const oneDayAgo = Date.now() - 24 * 60 * 60 * 1000;

  for (const task of store.tasks) {
    if (!task.statusHistory?.length) continue;
    for (const entry of task.statusHistory) {
      if (!entry.timestamp || entry.timestamp < oneDayAgo) continue;
      recentEvents.push({
        id: `seed-${task.id}-${entry.status}-${entry.timestamp}`,
        timestamp: entry.timestamp,
        type: 'task-status',
        emoji: statusEmoji[entry.status] || '📋',
        agent: entry.by || task.assignee || 'Unknown',
        project: projectMap[task.projectId] || '',
        taskId: task.id,
        message: `${entry.by || task.assignee || 'Unknown'} moved "${task.title}" to ${entry.status}`,
      });
    }
  }

  // Sort by timestamp descending and take latest 50
  recentEvents.sort((a, b) => b.timestamp - a.timestamp);
  for (const evt of recentEvents.slice(0, 50)) {
    activityFeed.push(evt);
  }
  if (activityFeed.length > 0) {
    console.log(`[Activity Feed] Seeded ${activityFeed.length} events from task history`);
  }
}

// --- Next.js ---
const app = next({ dev, dir: __dirname, port });
const handle = app.getRequestHandler();
await app.prepare();

// #1261 — log build identity at boot so `systemctl --user status` /
// journalctl makes it obvious which commit is actually serving traffic.
// Cheap (read once at startup) and rescues us when somebody forgets the
// build step before restarting in production mode.
try {
  const fs = await import('node:fs');
  const child = await import('node:child_process');
  let buildId = 'unknown';
  try {
    buildId = fs.readFileSync(new URL('./.next/BUILD_ID', import.meta.url), 'utf8').trim();
  } catch { /* .next not present yet (first boot of dev container) */ }
  let sha = 'unknown';
  let branch = 'unknown';
  try {
    sha = child.execSync('git rev-parse --short HEAD', { cwd: __dirname, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
    branch = child.execSync('git rev-parse --abbrev-ref HEAD', { cwd: __dirname, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
  } catch { /* not a git checkout */ }
  console.log(`[boot] org-studio dashboard live: BUILD_ID=${buildId} SHA=${sha} branch=${branch} dev=${dev}`);
} catch (err) {
  console.warn('[boot] could not stamp build identity:', err?.message || err);
}

const server = createServer((req, res) => {
  // Activity feed REST endpoint
  // Debug: confirm server.mjs is running (not standalone server.js)
  if (req.url === "/api/debug-server" && req.method === "GET") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ server: "server.mjs", feedSize: activityFeed.length, uptime: process.uptime() }));
    return;
  }
  if (req.url === '/api/activity-feed' && req.method === 'GET') {
    const feed = globalThis.__orgStudioActivityFeed?.get() || [];
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ events: feed }));
    return;
  }

  // --- Health-alerts webhook (v0.15) ---
  if (req.url === '/api/webhooks/health-alerts' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', async () => {
      try {
        // #1621 (F-P2): verify shared-secret/HMAC signature before processing.
        // Open only when HEALTH_ALERTS_WEBHOOK_SECRET is unset (OSS/dev parity);
        // when configured, unsigned/incorrectly-signed POSTs are rejected 401.
        const sig = verifyWebhookSignature(
          body,
          (name) => req.headers[name.toLowerCase()],
          resolveWebhookSecret(),
        );
        if (!sig.ok) {
          res.writeHead(401, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Unauthorized: invalid or missing webhook signature' }));
          return;
        }
        const data = JSON.parse(body);
        const { agentId, metric, value, threshold, status } = data;
        if (!agentId || !metric) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Missing required fields: agentId, metric' }));
          return;
        }

        const alertType = `webhook_${metric}_${agentId}`;
        const emoji = status === 'critical' ? '🚨' : status === 'warning' ? '⚠️' : '📊';
        const title = `Health Alert: ${metric}`;
        const context = `Agent: ${agentId} | ${metric}: ${value} (threshold: ${threshold}) | Status: ${status || 'unknown'}`;

        // 1. Forward to external webhook URL if configured
        const webhookUrl = process.env.TELEGRAM_HEALTH_ALERTS_WEBHOOK_URL;
        if (webhookUrl) {
          fetch(webhookUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ agentId, metric, value, threshold, status, timestamp: Date.now() }),
          }).catch(err => console.error('[HealthWebhook] Forward failed:', err.message));
        }

        // 2. Forward to Telegram health bot if configured (independent of ENABLE_TELEGRAM_COMMS)
        const sent = await sendHealthAlert({ type: alertType, emoji, title, context });

        // 3. Add to activity feed
        const feedApi = globalThis.__orgStudioActivityFeed;
        if (feedApi?.add) {
          feedApi.add({
            type: 'health-alert',
            emoji,
            agent: agentId,
            message: `${emoji} ${title}: ${context}`,
          });
        }

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, telegramSent: sent, webhookForwarded: !!webhookUrl }));
      } catch (err) {
        console.error('[HealthWebhook] Parse error:', err.message);
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid JSON body' }));
      }
    });
    return;
  }

  handle(req, res);
});

// --- WebSocket server on /ws ---
const wss = new WebSocketServer({ server, path: '/ws' });

const DATA_DIR = join(__dirname, 'data');
// #1265: STORE_PATH retained only for legacy backups/restore + dev offline mode.
// In Postgres mode (DATABASE_URL set), the file is never read or written by the live app.
// data/store.json was removed in this commit; the path stays so existsSync() guards skip cleanly.
const STORE_PATH = join(DATA_DIR, 'store.json');
const STATUS_PATH = join(DATA_DIR, 'activity-status.json');

function safeRead(path) {
  try {
    if (!existsSync(path)) return null;
    return JSON.parse(readFileSync(path, 'utf-8'));
  } catch { return null; }
}

// --- Broadcast ---
// #1387 A.2: workspace id constants + per-workspace cache live here so that
// every downstream broadcast/refresh site (file watcher, LISTEN handler, WS
// connection handler, startup initial sync) can reference them without TDZ issues.
const DEFAULT_WORKSPACE_ID = 'default-workspace';
// Map<workspaceId, StoreData>. Lazy-populated on first refresh per workspace.
// In OSS mode (no DATABASE_URL) only one entry exists, keyed by 'default-workspace';
// the code path is identical to the pre-refactor single-global behaviour.
const cachedStoreByWorkspace = new Map();
// Back-compat shim: legacy code paths still read the default-workspace store
// directly (projectIntegrityAudit, stuckTaskWatchdog, drift check, health monitor).
// They were system-level watchdogs that have always operated on the default
// workspace; a follow-up will iterate every workspace via getStoreProviderAllWorkspaces().
function getCachedStore(workspaceId = DEFAULT_WORKSPACE_ID) {
  return cachedStoreByWorkspace.get(workspaceId) || null;
}

// #1387 A.2: workspace-scoped broadcasts.
//
//   broadcast(type, data)                        — system-global (fleet-wide). Goes to every WS client.
//                                                  Used for 'sessions', 'cron', 'gateway-status',
//                                                  'gateway-agents' (gateway/OS-level facts that don't
//                                                  belong to a single workspace).
//                                                  TODO(#1387 A-followup): some of these (e.g. sessions)
//                                                  could be filtered by workspace membership once the
//                                                  membership table is wired in.
//
//   broadcast(type, data, workspaceId)           — workspace-scoped. Only clients whose ws.workspaceId
//                                                  matches receive the message. Used for 'store' pushes
//                                                  driven by LISTEN/NOTIFY and file-watcher events.
function broadcast(type, data, workspaceId) {
  const msg = JSON.stringify({ type, data, ts: Date.now() });
  for (const client of wss.clients) {
    if (client.readyState !== WebSocket.OPEN) continue;
    if (workspaceId && client.workspaceId && client.workspaceId !== workspaceId) continue;
    client.send(msg);
  }
}

// --- File watchers (debounced) ---
const usePostgres = !!process.env.DATABASE_URL;

function watchDataFile(path, type) {
  if (!existsSync(path)) return;
  let timer = null;
  watch(path, () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(async () => {
      if (type === 'store' && usePostgres) {
        // Postgres is source of truth — fetch from API, not stale file.
        // #1387 A.2: file watcher is a legacy dev-mode path. With DATABASE_URL set,
        // LISTEN/NOTIFY drives store refreshes. To stay safe we invalidate ALL
        // workspace cache entries here and refresh the default-workspace one to keep
        // the existing connection-time push behaviour. A targeted per-workspace refresh
        // is unnecessary because Postgres NOTIFY is the live signal.
        cachedStoreByWorkspace.clear();
        const fresh = await refreshCachedStore(DEFAULT_WORKSPACE_ID);
        if (fresh) broadcast('store', fresh, DEFAULT_WORKSPACE_ID);
      } else {
        const data = safeRead(path);
        if (data) {
          if (type === 'store') {
            // Legacy OSS-file path: single default-workspace store.
            cachedStoreByWorkspace.set(DEFAULT_WORKSPACE_ID, data);
            broadcast(type, data, DEFAULT_WORKSPACE_ID);
          } else {
            broadcast(type, data);
          }
        }
      }
    }, 150);
  });
}

// --- ORG.md sync — write to agent workspaces on store change ---
let WORKSPACE_BASE = null;

// Initialize WORKSPACE_BASE intelligently
function initWorkspaceBase() {
  if (process.env.WORKSPACE_BASE) {
    WORKSPACE_BASE = process.env.WORKSPACE_BASE;
    console.log(`Using WORKSPACE_BASE from env: ${WORKSPACE_BASE}`);
    return;
  }

  // Try ~/.openclaw
  const homeOCL = join(process.env.HOME || '/tmp', '.openclaw');
  if (existsSync(homeOCL)) {
    WORKSPACE_BASE = homeOCL;
    console.log(`Found ~/.openclaw, using for ORG.md sync: ${WORKSPACE_BASE}`);
    return;
  }

  console.log('WORKSPACE_BASE not found, skipping ORG.md sync. Set WORKSPACE_BASE env var to enable.');
}

function generateOrgMd(store, forAgentId) {
  const settings = store?.settings || {};
  const mission = settings.missionStatement || 'No mission defined.';
  const values = settings.values;
  const teammates = settings.teammates || [];
  const lines = [];

  lines.push('# Org Context');
  lines.push('> Auto-generated by Org Studio. Do not edit — changes will be overwritten.');
  lines.push('');
  lines.push('## Mission');
  lines.push(mission);
  lines.push('');

  if (values?.items?.length) {
    lines.push(`## Values — ${values.name || 'Values'}`);
    for (const v of values.items) {
      lines.push(`- **${v.title}** ${v.icon}: ${v.description}`);
    }
    lines.push('');
  }

  if (forAgentId) {
    const me = teammates.find(t => t.agentId === forAgentId || t.id === forAgentId);
    if (me) {
      lines.push(`## Your Domain: ${me.domain || 'Unassigned'}`);
      lines.push(`**Role:** ${me.title || 'Team Member'}`);
      if (me.owns) lines.push(`**Owns (autonomous decisions):** ${me.owns}`);
      if (me.defers) lines.push(`**Defers (needs confirmation):** ${me.defers}`);
      if (me.description) lines.push(`**Description:** ${me.description}`);
      if (me.context) {
        lines.push('');
        lines.push('### Context');
        lines.push(me.context);
      }
      lines.push('');
    }
  }

  lines.push('## Team');
  for (const t of teammates) {
    const type = t.isHuman ? 'Human' : 'Agent';
    const owns = t.owns ? ` | Owns: ${t.owns}` : '';
    lines.push(`- **${t.name}** ${t.emoji} (${type}) — ${t.domain || 'Unassigned'}${owns}`);
  }
  lines.push('');

  // Team-level shared protocols — same for every agent
  lines.push('## How the Team Works');
  lines.push('- **Own your domain.** You don\'t report status to a manager — the Org Studio board is your status. Update it, don\'t narrate it.');
  lines.push('- **Humans task you directly.** Their word is final. When a human and another agent conflict, the human wins.');
  lines.push('- **Coordinators don\'t manage you.** Agents tagged as cross-cutting coordinators handle work that spans domains (email, calendar, onboarding). They don\'t approve your domain work.');
  lines.push('- **Go direct when it makes sense.** Need to sync with another agent on shared code or a blocker? Ping them directly. Don\'t route through a coordinator.');
  lines.push('- **Ask for help when you\'re stuck.** Missing context that spans domains? Need something from email or calendar? That\'s when you ping a coordinator.');
  lines.push('');
  lines.push('### What NOT to do');
  lines.push('- ❌ Send teammates status updates about your work (update the board instead)');
  lines.push('- ❌ Ask permission to do things in your own domain (just do them)');
  lines.push('- ❌ Route messages through coordinators when you can talk to the other agent directly');
  lines.push('');

  lines.push('## Inter-Agent Communication');
  lines.push('You can reach other agents directly. Use the `wake-agent` command to send a message that will wake the target even if they\'re idle:');
  lines.push('```bash');
  lines.push('wake-agent <agentId> "<message>"');
  lines.push('```');
  lines.push('Valid agent IDs are listed in the Team roster above (use the lowercase name, e.g. `henry`, `ana`, `mikey`).');
  lines.push('');
  lines.push('**Cross-runtime mentions.** @mention another agent in a task comment (e.g. `@Ana please check this`) and the notification routes cross-runtime (OpenClaw ↔ Hermes) automatically. Preferred for task-specific coordination.');
  lines.push('');

  lines.push('## Cross-Agent Delivery Rule (MANDATORY)');
  lines.push('When another agent routes work to you (via wake event, cross-session message, or cron) and the result needs to reach a human:');
  lines.push('1. **ALWAYS** deliver the result via the messaging tool (e.g. `message(action=send, channel=telegram, target=<humanId>)`) — do NOT rely on normal reply routing.');
  lines.push('2. After sending, reply `NO_REPLY` to avoid duplicates.');
  lines.push('3. **Why:** Wake events and cross-agent sessions have `channel: "unknown"` — normal replies go nowhere.');
  lines.push('');

  lines.push('## Sub-Agent Model Selection');
  lines.push('For code sub-agents use **Codex** (`foundry-openai-responses/gpt-5.3-codex`) — zero cost on Foundry, purpose-built for code. For research/analysis sub-agents use `foundry-openai/gpt-5.4`. Keep your main session on your primary model for orchestration.');
  lines.push('');
  lines.push('**Rule of thumb:** task ends with a code commit → Codex. Task ends with a report or decision → 5.4.');
  lines.push('');

  // Vision docs summary — fetch from API (Postgres) with local file fallback
  const projects = store?.projects || [];
  const activeProjects = projects.filter(p => p.phase === 'active' || p.lifecycle === 'building' || p.lifecycle === 'mature');
  if (activeProjects.length > 0) {
    lines.push('## Active Projects');
    lines.push('');
    for (const p of activeProjects) {
      const versionStr = p.currentVersion ? ` v${p.currentVersion}` : '';
      const devStr = p.devOwner ? ` | Dev: ${p.devOwner}` : '';
      const qaStr = p.qaOwner ? ` | QA: ${p.qaOwner}` : '';
      lines.push(`- **${p.name}**${versionStr}${devStr}${qaStr}`);
      // #1654 Phase A-3 — static leash block (budget ceiling + boundaries).
      // Renders nothing for projects without either field.
      const leash = renderLeashBlock(p);
      if (leash) {
        for (const l of leash.split('\n')) lines.push(`  ${l}`);
      }
    }
    lines.push('');
    lines.push('Read full vision docs: `GET /api/vision/{projectId}/doc`');
    lines.push('');
  }

  lines.push('## Reference');
  lines.push('For Org Studio workflows and usage, see docs/guide.md in your workspace.');
  lines.push('For the full API reference, see the org-studio-api skill: skills/org-studio-api/SKILL.md');
  lines.push('');

  // API quick reference — so agents can interact with Org Studio immediately
  const port = process.env.PORT || 4501;
  const baseUrl = `http://localhost:${port}`;
  const apiKey = process.env.ORG_STUDIO_API_KEY;

  lines.push('## Org Studio API');
  lines.push(`Dashboard: ${baseUrl}`);
  if (apiKey) {
    lines.push(`Auth: All writes require header \`Authorization: Bearer ${apiKey}\``);
  } else {
    lines.push('Auth: All writes require header `Authorization: Bearer <key>` (set ORG_STUDIO_API_KEY in .env.local)');
  }
  lines.push('');
  lines.push('**Quick reference:**');
  lines.push('```');
  lines.push(`GET  ${baseUrl}/api/store                    — fetch tasks, projects, team`);
  lines.push(`POST ${baseUrl}/api/store                    — create/update tasks, add comments`);
  lines.push(`GET  ${baseUrl}/api/vision/{projectId}/doc   — read project vision doc`);
  lines.push(`POST ${baseUrl}/api/roadmap/{projectId}      — create/update roadmap versions`);
  lines.push(`GET  ${baseUrl}/api/stats/{agentId}          — your delivery metrics`);
  lines.push('```');
  lines.push('');

  // Work loop — canonical workflow. Full work contract is in the org-studio-api skill.
  lines.push('## Work Loop');
  lines.push('1. Scan **in-progress** for tasks assigned to you. Resume the highest priority one.');
  lines.push('2. If nothing in-progress, scan **backlog**. Pick the highest priority task.');
  lines.push('   - Read the full task description and comments FIRST.');
  lines.push('   - Only move to in-progress AFTER actual work starts. Do NOT claim tasks speculatively.');
  lines.push('3. Before moving any task out of in-progress, check `testType`:');
  lines.push('   - `self` (default): self-test, document results in a comment or `reviewNotes`, move to **done** (or **review** if `needsReview: true`).');
  lines.push('   - `qa`: self-test first, write a test plan, move to QA column.');
  lines.push('4. **When complete:** move to **done** by default. Move to **review** ONLY when `needsReview: true` — set this flag when the work is:');
  lines.push('   - **(a) Irreversible** — DB migrations, deletions, money/billing, external API writes with cost');
  lines.push('   - **(b) Cross-domain** — touching another agent\'s owned code');
  lines.push('   - **(c) Mission/vision/roadmap** direction changes');
  lines.push('   - **(d) Security-sensitive**');
  lines.push('   When in doubt about reversibility, set needsReview=true. Include `reviewReason` when you do.');
  lines.push('5. `reviewNotes` required ONLY when moving to review. For direct-to-done, the commit message + a final summary comment is sufficient.');
  lines.push('6. Clear activity status when done. If more backlog tasks remain, continue with the next one. If you run out of time mid-task, leave it where it is.');
  lines.push('');
  lines.push('**Planning column:** You ARE encouraged to pull from planning — scope the task (acceptance criteria, constraints, context), then move to backlog when ready for execution. If the task lacks context to scope, post a comment asking instead of guessing.');
  lines.push('');
  lines.push('**Primary directive:** Org Studio exists to unlock continuous agent delivery. After mission/vision/domain/boundaries are set, deliver autonomously. Human involvement is for blockers, irreversible decisions, and cross-domain changes — not routine work in your owned domain.');
  lines.push('');
  lines.push('**Default task lifecycle:** `backlog → in-progress → done`');
  lines.push('**Review lifecycle (opt-in, when `needsReview: true`):** `backlog → in-progress → review → done`');
  lines.push('**With QA:** insert `qa` after in-progress when `testType: qa`.');
  lines.push('Always include `version` when creating tasks for a sprint.');
  lines.push('');
  lines.push('**Full work contract** (columns, testing details, handoffs, examples) lives in the `org-studio-api` skill at `skills/org-studio-api/SKILL.md`. Read it when in doubt.');
  lines.push('');

  lines.push('## Cross-Project Blockers');
  lines.push('When you hit a blocker caused by another project:');
  lines.push('1. **Mark your task as blocked** (status = blocked) with a comment explaining the issue.');
  lines.push('2. **Create a new task** in the blocking project, assigned to that project\'s dev owner.');
  lines.push('   - Reference your blocked task ID in the description.');
  lines.push('3. The other dev owner fixes the issue and uses `addHandoff` to inject context back.');
  lines.push('4. Your task auto-unblocks and you get dispatched to continue.');
  lines.push('');
  lines.push('**Do NOT** reassign your own task to another project\'s dev owner. Keep tasks in their project.');
  lines.push('**Do NOT** fix issues in codebases you don\'t own - create a task for the owner instead.');
  lines.push('');
  // Activity status — so agents can report what they're doing
  lines.push('## Activity Status');
  lines.push('Report your status (visible in Mission Control Live Activity feed):');
  lines.push('```');
  lines.push(`POST ${baseUrl}/api/activity-status`);
  lines.push(`  {"agent":"<your-agentId>","status":"<what you are doing>","detail":"<optional>"}`);
  lines.push('');
  lines.push(`DELETE ${baseUrl}/api/activity-status`);
  lines.push(`  {"agent":"<your-agentId>"}`);
  lines.push('```');
  lines.push('');

  // Comments — how to communicate about tasks
  lines.push('## Task Comments');
  lines.push('Use comments to communicate about a task (questions, updates, findings):');
  lines.push('```');
  lines.push(`POST ${baseUrl}/api/store`);
  lines.push(`  {"action":"addComment","taskId":"<id>","comment":{"author":"<Your Name>","content":"<message>","type":"comment"}}`);
  lines.push('```');
  lines.push('- When a task is sent back (review → in-progress), check comments for feedback.');
  lines.push('- Post questions as comments instead of guessing.');
  lines.push('');

  return lines.join('\n');
}

function resolveWorkspaceDir(agentId) {
  // Hermes agents: check ~/.hermes/profiles/{profileName}/workspace/ first
  if (agentId.startsWith('hermes-')) {
    const profileName = agentId.replace('hermes-', '');
    const hermesWorkspace = join(process.env.HOME || '/tmp', '.hermes', 'profiles', profileName, 'workspace');
    // Create workspace dir if it doesn't exist (Hermes profiles don't always have one)
    if (!existsSync(hermesWorkspace)) {
      try { mkdirSync(hermesWorkspace, { recursive: true }); } catch {}
    }
    if (existsSync(hermesWorkspace)) return hermesWorkspace;
  }
  // Default agent id is 'main' but workspace is the bare 'workspace' dir
  if (agentId === 'main') {
    const bare = join(WORKSPACE_BASE, 'workspace');
    if (existsSync(bare)) return bare;
  }
  // Standard OpenClaw path: workspace-{agentId}
  const suffixed = join(WORKSPACE_BASE, `workspace-${agentId}`);
  if (existsSync(suffixed)) return suffixed;
  return null;
}

function syncOrgFiles(store) {
  if (!WORKSPACE_BASE) return; // Skip if WORKSPACE_BASE is null
  
  const teammates = store?.settings?.teammates || [];
  const agents = teammates.filter(t => !t.isHuman && t.agentId);
  let synced = 0;

  // Copy docs/guide.md and skills/org-studio-api/ to each workspace if they exist
  const guideSrc = join(process.cwd(), 'docs', 'guide.md');
  const guideContent = existsSync(guideSrc) ? readFileSync(guideSrc, 'utf-8') : null;
  
  // Sync the org-studio-api skill (SKILL.md + references/) as the canonical API reference
  const skillDir = join(process.cwd(), 'skills', 'org-studio-api');
  const skillContent = existsSync(join(skillDir, 'SKILL.md')) ? readFileSync(join(skillDir, 'SKILL.md'), 'utf-8') : null;
  const apiRefContent = existsSync(join(skillDir, 'references', 'api-reference.md')) ? readFileSync(join(skillDir, 'references', 'api-reference.md'), 'utf-8') : null;
  const metricsRefContent = existsSync(join(skillDir, 'references', 'metrics-reference.md')) ? readFileSync(join(skillDir, 'references', 'metrics-reference.md'), 'utf-8') : null;

  for (const agent of agents) {
    const workspaceDir = resolveWorkspaceDir(agent.agentId);
    if (!workspaceDir) continue;
    const orgPath = join(workspaceDir, 'ORG.md');
    const content = generateOrgMd(store, agent.agentId);
    try {
      writeFileSync(orgPath, content);
      // Sync docs/guide.md and org-studio-api skill alongside ORG.md
      if (guideContent || skillContent) {
        const docsDir = join(workspaceDir, 'docs');
        mkdirSync(docsDir, { recursive: true });
        if (guideContent) {
          writeFileSync(join(docsDir, 'guide.md'), guideContent);
        }
        if (skillContent) {
          const skillOutDir = join(workspaceDir, 'skills', 'org-studio-api', 'references');
          mkdirSync(skillOutDir, { recursive: true });
          writeFileSync(join(workspaceDir, 'skills', 'org-studio-api', 'SKILL.md'), skillContent);
          if (apiRefContent) writeFileSync(join(skillOutDir, 'api-reference.md'), apiRefContent);
          if (metricsRefContent) writeFileSync(join(skillOutDir, 'metrics-reference.md'), metricsRefContent);
        }
      }
      synced++;
    } catch {}
  }
  if (synced > 0) console.log(`  ORG.md + docs/guide.md + skills/org-studio-api synced to ${synced} agent workspace(s)`);

  // Async: fetch performance data and append to ORG.md for each agent
  appendPerformanceToOrgFiles(agents).catch(e => {
    console.warn('[Performance] Failed to append performance data:', e.message);
  });
}

/**
 * Fetch kudos + stats for each agent and append a tiered Performance section to their ORG.md.
 * Three tiers: Core Identity (all-time), Recent Feedback (30 days), Operating Principles (patterns)
 * Target: <400 tokens total regardless of volume.
 * Runs async after the initial sync so it doesn't block.
 */
async function appendPerformanceToOrgFiles(agents) {
  if (!WORKSPACE_BASE) return;

  for (const agent of agents) {
    const workspaceDir = resolveWorkspaceDir(agent.agentId);
    if (!workspaceDir) continue;
    const orgPath = join(workspaceDir, 'ORG.md');
    if (!existsSync(orgPath)) continue;

    try {
      // Fetch all kudos for this agent (all-time)
      const kudosRes = await fetch(`http://127.0.0.1:${port}/api/kudos?agentId=${agent.agentId}&limit=100`);
      const kudosData = kudosRes.ok ? await kudosRes.json() : { kudos: [] };
      const allKudos = kudosData.kudos || [];

      // Separate kudos and flags, convert createdAt
      const kudos = allKudos.filter(k => k.type === 'kudos').map(k => ({
        ...k,
        createdAt: new Date(k.createdAt || k.created_at || Date.now())
      }));
      const flags = allKudos.filter(k => k.type === 'flag').map(k => ({
        ...k,
        createdAt: new Date(k.createdAt || k.created_at || Date.now())
      }));

      const now = new Date();
      const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
      const ninetyDaysAgo = new Date(now.getTime() - 90 * 24 * 60 * 60 * 1000);

      // Build tiered performance section
      const lines = [];
      lines.push('');
      lines.push('## Your Performance');
      lines.push('');

      // TIER 1: Core Identity (all-time, compressed)
      const coreIdentity = buildCoreIdentity(kudos, flags, ninetyDaysAgo);
      if (coreIdentity.length > 0) {
        lines.push('### Core Identity');
        lines.push(...coreIdentity);
        lines.push('');
      }

      // TIER 2: Recent Feedback (last 30 days, specific)
      const recentFeedback = buildRecentFeedback(kudos, flags, thirtyDaysAgo);
      if (recentFeedback.length > 0) {
        lines.push('### Recent Feedback (last 30 days)');
        lines.push(...recentFeedback);
        lines.push('');
      }

      // TIER 3: Operating Principles (derived from patterns, enhanced)
      const principles = generateOperatingPrinciples(kudos, flags, ninetyDaysAgo);
      if (principles.length > 0) {
        lines.push('### Operating Principles');
        lines.push(...principles);
        lines.push('');
      }

      // Append to ORG.md, respecting 400-token budget
      if (lines.length > 3) {
        const existing = readFileSync(orgPath, 'utf-8');
        const cleaned = existing.replace(/\n## Your Performance[\s\S]*$/, '');
        const perfSection = lines.join('\n');
        writeFileSync(orgPath, cleaned + perfSection);
      }
    } catch (e) {
      console.warn(`[Performance] Failed for ${agent.agentId}:`, e.message);
    }
  }
}

/**
 * TIER 1: Core Identity — Aggregated from all-time kudos/flags
 * Returns array of markdown lines (compressed themes).
 */
function buildCoreIdentity(kudos, flags, ninetyDaysAgo) {
  const lines = [];

  // Count all-time kudos by value tag
  const kudosValueCounts = {};
  const kudosExamples = {};
  for (const k of kudos) {
    const values = parseValueTags(k.value_tags || k.values || '[]');
    for (const v of values) {
      kudosValueCounts[v] = (kudosValueCounts[v] || 0) + 1;
      if (!kudosExamples[v]) kudosExamples[v] = k;
    }
  }

  // Count all-time flags by value tag
  const flagValueCounts = {};
  const flagExamples = {};
  const flagLastSeen = {}; // Track last flag date per value
  for (const f of flags) {
    const values = parseValueTags(f.value_tags || f.values || '[]');
    for (const v of values) {
      flagValueCounts[v] = (flagValueCounts[v] || 0) + 1;
      if (!flagExamples[v]) flagExamples[v] = f;
      flagLastSeen[v] = f.createdAt; // Keep latest
    }
  }

  // Top 3 recognized strengths (kudos)
  const topKudos = Object.entries(kudosValueCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3);
  
  for (const [value, count] of topKudos) {
    lines.push(`- Recognized strength: ${sanitizeValue(value)} (${count} kudos all-time, #${value})`);
  }

  // Growth areas (flags with 2+ occurrences)
  const growthAreas = Object.entries(flagValueCounts)
    .filter(([_, count]) => count >= 2)
    .sort((a, b) => b[1] - a[1]);

  for (const [value, count] of growthAreas) {
    const lastFlagDate = flagLastSeen[value] || new Date();
    const daysAgo = Math.floor((Date.now() - lastFlagDate.getTime()) / (24 * 60 * 60 * 1000));
    let daysStr = `${daysAgo} days ago`;
    if (daysAgo < 1) daysStr = 'today';
    else if (daysAgo === 1) daysStr = 'yesterday';
    else if (daysAgo >= 90) daysStr = 'improving';

    if (daysAgo >= 90) {
      lines.push(`- Growth area: ${sanitizeValue(value)} (${count} flags, last ${daysAgo} days ago — improving, #${value})`);
    } else {
      lines.push(`- Growth area: ${sanitizeValue(value)} (${count} flags, last ${daysStr}, #${value})`);
    }
  }

  return lines;
}

/**
 * TIER 2: Recent Feedback — Specific kudos/flags from last 30 days
 * Returns array of markdown lines (up to 5 recent items).
 */
function buildRecentFeedback(kudos, flags, thirtyDaysAgo) {
  const lines = [];
  const recent = [];

  // Combine and filter to last 30 days
  for (const k of kudos) {
    if (k.createdAt >= thirtyDaysAgo) {
      recent.push({ type: 'kudos', ...k });
    }
  }
  for (const f of flags) {
    if (f.createdAt >= thirtyDaysAgo) {
      recent.push({ type: 'flag', ...f });
    }
  }

  // Sort by date, most recent first
  recent.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());

  // Take top 5
  for (const item of recent.slice(0, 5)) {
    const emoji = item.type === 'kudos' ? '⭐' : '🚩';
    const givenBy = item.given_by || item.givenBy || 'team';
    lines.push(`- ${emoji} "${item.note}" — ${givenBy}`);
  }

  return lines;
}

/**
 * TIER 3: Operating Principles — Derived from feedback patterns
 * Enhanced to soften principles when underlying pattern improves (no flags in 90+ days).
 * Returns array of markdown lines.
 */
function generateOperatingPrinciples(kudos, flags, ninetyDaysAgo) {
  const principles = [];

  // Count flag values (for pattern detection)
  const flagValueCounts = {};
  const flagLastSeen = {};
  for (const f of flags) {
    const values = parseValueTags(f.value_tags || f.values || '[]');
    for (const v of values) {
      flagValueCounts[v] = (flagValueCounts[v] || 0) + 1;
      flagLastSeen[v] = f.createdAt;
    }
  }

  // Count kudos values
  const kudosValueCounts = {};
  for (const k of kudos) {
    const values = parseValueTags(k.value_tags || k.values || '[]');
    for (const v of values) {
      kudosValueCounts[v] = (kudosValueCounts[v] || 0) + 1;
    }
  }

  // Generate principles dynamically from ANY value tags (not hardcoded to specific values)
  // Flag-based principles (areas to improve)
  for (const [value, count] of Object.entries(flagValueCounts)) {
    const valueName = sanitizeValue(value);
    if (count >= 2) {
      if (flagLastSeen[value] >= ninetyDaysAgo) {
        principles.push(`Area for growth: "${valueName}" has been flagged ${count} times. Focus on improving this deliberately.`);
      } else {
        principles.push(`You've shown improvement in "${valueName}". Keep it up — no flags in over 90 days.`);
      }
    } else if (count === 1) {
      principles.push(`Reminder: "${valueName}" was flagged once. Stay mindful of this area.`);
    }
  }

  // Kudos-based principles (strengths to reinforce)
  for (const [value, count] of Object.entries(kudosValueCounts)) {
    const valueName = sanitizeValue(value);
    if (count >= 3) {
      principles.push(`Recognized strength: "${valueName}" (${count} kudos). This is core to your identity — keep leading with it.`);
    } else if (count >= 2) {
      principles.push(`Emerging strength: "${valueName}" (${count} kudos). Your work here is being noticed.`);
    }
  }

  return principles.map(p => `- ${p}`);
}

/**
 * Parse value tags from stored format (string, array, or JSON).
 */
function parseValueTags(rawTags) {
  if (Array.isArray(rawTags)) return rawTags;
  if (typeof rawTags === 'string') {
    if (rawTags === '[]') return [];
    try {
      const parsed = JSON.parse(rawTags);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }
  return [];
}

/**
 * Sanitize a value tag for display (convert 'people-first' to 'People-First', etc.).
 */
function sanitizeValue(value) {
  return value
    .split('-')
    .map(word => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
    .join('-');
}

watchDataFile(STORE_PATH, 'store');
watchDataFile(STATUS_PATH, 'activity-status');

// --- Intent Router ---
// Processes intents written to Postgres by remote Org Studio instances.
// Bridges remote writes to local Gateway execution.

/**
 * Process a change event from Postgres NOTIFY and execute any pending intents.
 * Intents are signaled via special values in the data (e.g. pendingVersion: 'needs_launch').
 */
async function processIntent(changeEvent) {
  try {
    // --- Vision Launch Intent ---
    if (changeEvent.action === 'updateProject' && changeEvent.updates?.autonomy?.pendingVersion === 'needs_launch') {
      const projectId = changeEvent.projectId;
      const intent = changeEvent.updates.autonomy._launchIntent;
      console.log(`[Intent] Vision launch detected for project ${projectId}`);

      // Fetch the project and build the launch message
      try {
        const storeAuth = process.env.ORG_STUDIO_API_KEY ? { Authorization: `Bearer ${process.env.ORG_STUDIO_API_KEY}` } : {};
        const storeRes = await fetch(`http://127.0.0.1:${port}/api/store`, { headers: storeAuth });
        const store = await storeRes.json();
        const project = store.projects?.find(p => p.id === projectId);
        if (!project) {
          console.error(`[Intent] Project ${projectId} not found in store`);
          return;
        }

        // Build the launch message by calling the launch endpoint in direct mode
        // We call the propose endpoint to get the message, then fire via scheduler
        const agentId = intent?.agentId || 'main';

        // Fire the vision launch via the local scheduler/api
        const launchRes = await fetch(`http://127.0.0.1:${port}/api/vision/${projectId}/launch`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
        });
        const launchData = await launchRes.json();

        if (launchData.ok) {
          console.log(`[Intent] Vision launch executed for ${project.name} (mode: ${launchData.mode})`);
        } else {
          console.error(`[Intent] Vision launch failed for ${project.name}:`, launchData.error);
          // Revert state on failure
          await fetch(`http://127.0.0.1:${port}/api/store`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              action: 'updateProject',
              id: projectId,
              updates: {
                autonomy: {
                  ...(project.autonomy || {}),
                  pendingVersion: null,
                  _launchIntent: undefined,
                },
              },
            }),
          });
        }
      } catch (e) {
        console.error(`[Intent] Vision launch error for ${projectId}:`, e.message);
      }
      return; // Don't process other intents for this event
    }

    // --- Task-based Agent Triggers ---
    // When a task moves to backlog or QA via remote write, trigger the local scheduler
    if (changeEvent.type === 'task_updated' && changeEvent.updates?.status) {
      const newStatus = changeEvent.updates.status;
      // Use task-level assignee (always present), fall back to updates.assignee
      const assignee = changeEvent.assignee || changeEvent.updates.assignee;

      if ((newStatus === 'backlog' || newStatus === 'qa') && assignee) {
        console.log(`[Intent] Task ${changeEvent.taskId} moved to ${newStatus}, triggering agent for ${assignee}`);
        
        // Resolve assignee → agentId from store
        try {
          const storeAuth = process.env.ORG_STUDIO_API_KEY ? { Authorization: `Bearer ${process.env.ORG_STUDIO_API_KEY}` } : {};
          const storeRes = await fetch(`http://127.0.0.1:${port}/api/store`, { headers: storeAuth });
          const store = await storeRes.json();
          const teammates = store.settings?.teammates || [];
          const match = teammates.find(t =>
            t.name?.toLowerCase() === assignee.toLowerCase() ||
            t.agentId === assignee?.toLowerCase()
          );
          const agentId = match?.agentId;

          if (agentId) {
            const triggerRes = await fetch(`http://127.0.0.1:${port}/api/scheduler`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ action: 'trigger', agentId }),
            });
            if (triggerRes.ok) {
              console.log(`[Intent] Scheduler triggered for ${agentId}`);
            } else {
              console.warn(`[Intent] Scheduler trigger failed: HTTP ${triggerRes.status}`);
            }
          }
        } catch (e) {
          console.warn(`[Intent] Scheduler trigger error:`, e.message);
        }
      }
    }
  } catch (e) {
    console.warn(`[Intent] Processing error:`, e.message);
  }
}

// --- PostgreSQL LISTEN for bidirectional sync ---
// When remote server makes changes via /api/store, they trigger NOTIFY events
// that the local server receives and broadcasts to all WebSocket clients.

// PubSub health state (exported via /api/health/pubsub and MC dashboard)
const pubsubHealth = {
  connected: false,
  lastHeartbeatAt: null,    // ISO string
  reconnectCount: 0,
  lastError: null,          // string
  lastConnectedAt: null,    // ISO string
};
// Expose for health endpoint
globalThis.__pubsubHealth = pubsubHealth;

let _pubsubHeartbeatTimer = null;
let _pubsubReconnectAttempt = 0;
const PUBSUB_HEARTBEAT_INTERVAL_MS = 30_000; // 30s
const PUBSUB_RECONNECT_DELAYS = [5000, 10000, 20000, 60000]; // exponential backoff, cap at 60s

// --- Single-flight reconnect guards (fix: reconnect-storm OOM) ---
// Root cause of the 2026-06 Postgres connection storm: every 'end'/'error'
// event called scheduleReconnect(), which unconditionally setTimeout'd a new
// initializePostgresListener(). With no dedupe, no old-client teardown, and
// two event sources (end AND error) firing on the same dying socket, reconnect
// timers and pg.Client objects compounded — 67k reconnects, Postgres "too many
// clients", then Node OOM. These guards enforce exactly one live listener and
// at most one pending reconnect timer at any time.
let _pubsubListener = null;        // the current active pg.Client (or null)
let _pubsubReconnectTimer = null;  // pending reconnect setTimeout handle (or null)
let _pubsubConnecting = false;     // true while a connect attempt is in flight
let _pubsubListenerSeq = 0;        // monotonic id; stale clients' handlers no-op
const PUBSUB_APP_NAME = 'org-studio-listener'; // identifies this conn in pg_stat_activity
const _pubsubReconnectWindow = []; // timestamps of recent reconnects (rolling 10-min window)
const PUBSUB_RECONNECT_ALARM_WINDOW_MS = 10 * 60 * 1000;
const PUBSUB_RECONNECT_ALARM_THRESHOLD = 5; // >5 reconnects / 10 min = abnormal

function getPubsubReconnectDelay() {
  const idx = Math.min(_pubsubReconnectAttempt, PUBSUB_RECONNECT_DELAYS.length - 1);
  return PUBSUB_RECONNECT_DELAYS[idx];
}

// Tear down the current listener client: detach all handlers (so a late
// end/error from the dying socket can't schedule another reconnect) and end it.
function teardownPubsubListener() {
  if (_pubsubHeartbeatTimer) {
    clearInterval(_pubsubHeartbeatTimer);
    _pubsubHeartbeatTimer = null;
  }
  const old = _pubsubListener;
  _pubsubListener = null;
  if (old) {
    try { old.removeAllListeners(); } catch {}
    // best-effort async close; swallow errors (socket may already be dead)
    try { Promise.resolve(old.end()).catch(() => {}); } catch {}
  }
}

async function initializePostgresListener() {
  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) {
    console.log('[LISTEN] DATABASE_URL not set — skipping PostgreSQL listener');
    return;
  }

  // Single-flight entry guard: never start a second concurrent connect.
  if (_pubsubConnecting) {
    console.warn('[LISTEN] connect already in flight — skipping duplicate initialize');
    return;
  }
  _pubsubConnecting = true;

  // A fresh attempt supersedes any pending reconnect timer.
  if (_pubsubReconnectTimer) {
    clearTimeout(_pubsubReconnectTimer);
    _pubsubReconnectTimer = null;
  }

  // Tear down any prior client (handlers + socket) before opening a new one.
  // This is what prevents old clients from piling up.
  teardownPubsubListener();

  // Tag this listener generation; handlers below ignore events if superseded.
  const mySeq = ++_pubsubListenerSeq;

  // Schedule exactly one reconnect. Ignored if this generation is stale or a
  // reconnect is already pending.
  function scheduleReconnect(reason) {
    if (mySeq !== _pubsubListenerSeq) return; // a newer listener already owns the world
    pubsubHealth.connected = false;
    pubsubHealth.lastError = reason;
    if (_pubsubReconnectTimer) return; // already one pending — don't stack
    teardownPubsubListener();
    const delay = getPubsubReconnectDelay();
    _pubsubReconnectAttempt++;
    pubsubHealth.reconnectCount++;
    // Reconnect-rate alarm (defense-in-depth): the single-flight guard above makes
    // the old storm structurally impossible, but if some future change reopens it,
    // surface it loudly instead of letting it ramp silently to OOM.
    const _now = Date.now();
    _pubsubReconnectWindow.push(_now);
    while (_pubsubReconnectWindow.length && _now - _pubsubReconnectWindow[0] > PUBSUB_RECONNECT_ALARM_WINDOW_MS) {
      _pubsubReconnectWindow.shift();
    }
    if (_pubsubReconnectWindow.length > PUBSUB_RECONNECT_ALARM_THRESHOLD) {
      console.error(`[LISTEN][ALARM] ${_pubsubReconnectWindow.length} reconnects in <10min — possible reconnect storm (expected <=${PUBSUB_RECONNECT_ALARM_THRESHOLD})`);
    }
    console.warn(`[LISTEN] ${reason}. Reconnecting in ${delay / 1000}s (attempt #${_pubsubReconnectAttempt})`);
    _pubsubReconnectTimer = setTimeout(() => {
      _pubsubReconnectTimer = null;
      initializePostgresListener();
    }, delay);
  }

  let listener;
  try {
    const pg = await import('pg');
    const Client = pg.default?.Client || pg.Client;
    listener = new Client({ connectionString: dbUrl, application_name: PUBSUB_APP_NAME });
    _pubsubListener = listener;

    listener.on('error', (err) => {
      scheduleReconnect(`Connection error: ${err.message}`);
    });

    listener.on('end', () => {
      scheduleReconnect('Connection closed');
    });

    // Listen for store update events + heartbeat
    listener.on('notification', async (msg) => {
      try {
        // Heartbeat channel — just update timestamp, don't process further
        if (msg.channel === 'org_studio_heartbeat') {
          pubsubHealth.lastHeartbeatAt = new Date().toISOString();
          return;
        }
        // msg.channel is the event name, msg.payload is the JSON data
        if (msg.channel === 'org_studio_change') {
          const changeEvent = JSON.parse(msg.payload);
          // Ensure workspace_id is present; default to 'default-workspace' if missing
          if (!changeEvent.workspace_id) {
            changeEvent.workspace_id = 'default-workspace';
            // Only warn once per server lifetime for missing workspace_id
            if (!globalThis.__wsIdWarnLogged) {
              console.warn('[LISTEN] Notification missing workspace_id — defaulting to default-workspace');
              globalThis.__wsIdWarnLogged = true;
            }
          }
          console.log(`[LISTEN] Received ${changeEvent.type} event:`, changeEvent.action || '');
          
          // --- Intent Router ---
          // Process intents BEFORE refreshing the store cache, so we can act on the intent
          // and update state in the same cycle
          await processIntent(changeEvent);

          // Process comments only on a runtime-connected bridge. Cloud/store
          // replicas also receive this LISTEN event for cache freshness, but
          // cannot reach agents. If they call /api/notify/comment they can win
          // the durable lease and make the real bridge suppress the wake as a
          // duplicate. Ticket #1809 exposed this second ownership race after
          // the direct store-route path had already been gated.
          if (
            changeEvent.type === 'comment_added' &&
            changeEvent.taskId &&
            shouldRunNotificationListenBridge(process.env)
          ) {
            console.log(`[LISTEN] comment_added taskId=${changeEvent.taskId} commentId=${changeEvent.commentId || 'none'}`);

            // #1268 — Bridge to unified notification router so comments inserted
            // by OTHER processes (notably the staging Next.js instance) still page
            // the task assignee + dev/qa owners, not just explicit @mentions.
            // Router has its own LRU dedup keyed on (agentId, commentId) so this
            // is safe to fire alongside the legacy @mention block below.
            // System comments are filtered inside the router itself.
            try {
              const apiKey = process.env.ORG_STUDIO_API_KEY || '';
              const headers = { 'Content-Type': 'application/json' };
              if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;
              fetch(`http://127.0.0.1:${port}/api/notify/comment`, {
                method: 'POST',
                headers,
                body: JSON.stringify({
                  taskId: changeEvent.taskId,
                  commentId: changeEvent.commentId,
                  scope: { kind: 'task', taskId: changeEvent.taskId },
                }),
              })
                .then(async (r) => {
                  if (!r.ok) {
                    const txt = await r.text().catch(() => '');
                    console.warn(`[LISTEN] notify-comment bridge failed: HTTP ${r.status} ${txt.slice(0, 120)}`);
                  } else {
                    const j = await r.json().catch(() => ({}));
                    if (Array.isArray(j.notified) && j.notified.length > 0) {
                      console.log(`[LISTEN] notify-comment delivered: ${j.notified.join(', ')} commentId=${changeEvent.commentId || 'none'}`);
                    }
                    const deliveryFailures = Array.isArray(j.skipped)
                      ? j.skipped.filter((entry) => entry?.reason === 'delivery-failed')
                      : [];
                    if (deliveryFailures.length > 0) {
                      console.error(
                        `[LISTEN] notify-comment runtime delivery failed: ` +
                        `${deliveryFailures.map((entry) => entry.agentId).join(', ')} ` +
                        `commentId=${changeEvent.commentId || 'none'}; durable claim released for replay`,
                      );
                    }
                  }
                })
                .catch((e) => console.warn('[LISTEN] notify-comment bridge threw:', e?.message || e));
            } catch (e) {
              console.warn('[LISTEN] notify-comment bridge sync error:', e?.message || e);
            }
            // #1513 — Legacy inline @mention dispatch removed. The /api/notify/comment
            // bridge above (lines ~1071-1093) calls routeCommentNotifications() which
            // handles mentions + assignee + version-owner + project-owner with a single
            // gateway-level idempotency key. The legacy block used a different idem key
            // (`mention-${id}-${agentId}` vs `notify-task-${id}-${agentId}`), causing
            // gateway to deliver both as separate messages. This was the root cause of
            // the multi-delivery pattern in #1513. The redundant scheduler `trigger`
            // call that lived in the legacy block was also removed — chat.send to a
            // live session already wakes the agent, and `sendToAgent()` (in
            // src/lib/runtimes/registry.ts, used by the unified router) auto-routes
            // `hermes-*` agentIds to the Hermes runtime.
          }

          // Process new task creation — trigger agent dispatch
          if (changeEvent.type === 'task_created' && changeEvent.assignee && changeEvent.status === 'backlog') {
            console.log(`[LISTEN] New task created for ${changeEvent.assignee}, triggering dispatch`);
            const apiKey = process.env.ORG_STUDIO_API_KEY || '';
            const triggerHeaders = { 'Content-Type': 'application/json' };
            if (apiKey) triggerHeaders['Authorization'] = `Bearer ${apiKey}`;
            fetch(`http://127.0.0.1:${port}/api/scheduler`, {
              method: 'POST',
              headers: triggerHeaders,
              body: JSON.stringify({ action: 'trigger', agentId: changeEvent.assignee }),
            }).catch(e => console.warn('[LISTEN] Task trigger failed:', e.message));

            // Also try resolving assignee name to agentId
            try {
              const freshStore = await refreshCachedStore(changeEvent.workspace_id);
              if (freshStore) {
                const teammates = freshStore.settings?.teammates || [];
                const match = teammates.find(t =>
                  t.name?.toLowerCase() === changeEvent.assignee.toLowerCase() ||
                  t.agentId?.toLowerCase() === changeEvent.assignee.toLowerCase()
                );
                if (match?.agentId && match.agentId !== changeEvent.assignee) {
                  fetch(`http://127.0.0.1:${port}/api/scheduler`, {
                    method: 'POST',
                    headers: triggerHeaders,
                    body: JSON.stringify({ action: 'trigger', agentId: match.agentId }),
                  }).catch(() => {});
                }
              }
            } catch {} // best-effort
          }

          // Read fresh store from Postgres via internal API (not local file)
          // #1387 A.2: route NOTIFY -> per-workspace cache slot + scoped broadcast.
          // The NOTIFY payload carries workspace_id (defaulted to 'default-workspace'
          // upstream if missing — see line ~1000). We refresh and broadcast only for
          // that workspace, so cross-workspace WS clients aren't notified of an event
          // they don't own.
          try {
            const wsIdForEvent = changeEvent.workspace_id || DEFAULT_WORKSPACE_ID;
            const freshStore = await refreshCachedStore(wsIdForEvent);
            if (freshStore) {
              broadcast('store', freshStore, wsIdForEvent);

              // Also sync ORG.md on any store change
              if (WORKSPACE_BASE) {
                syncOrgFiles(freshStore);
              }
            }
          } catch (fetchErr) {
            console.error('[LISTEN] Failed to fetch fresh store:', fetchErr.message);
          }
        }
      } catch (e) {
        console.warn('[LISTEN] Failed to process notification:', e.message);
      }
    });

    await listener.connect();
    pubsubHealth.connected = true;
    pubsubHealth.lastConnectedAt = new Date().toISOString();
    pubsubHealth.lastError = null;
    _pubsubReconnectAttempt = 0; // reset backoff on successful connect
    _pubsubConnecting = false;   // connect finished; release single-flight gate
    console.log(`[LISTEN] Connected to PostgreSQL (application_name=${PUBSUB_APP_NAME}), listening for org_studio_change events`);
    
    // Subscribe to notifications
    await listener.query('LISTEN org_studio_change');
    await listener.query('LISTEN org_studio_heartbeat');

    // Start heartbeat: NOTIFY every 30s so we know the connection is alive
    _pubsubHeartbeatTimer = setInterval(async () => {
      // If a newer listener generation has taken over, stop this stale heartbeat.
      if (mySeq !== _pubsubListenerSeq) {
        clearInterval(_pubsubHeartbeatTimer);
        return;
      }
      try {
        await listener.query("NOTIFY org_studio_heartbeat, 'ping'");
      } catch (err) {
        console.warn('[LISTEN] Heartbeat NOTIFY failed:', err.message);
        // Connection is likely dead — the error/end handler will reconnect
      }
    }, PUBSUB_HEARTBEAT_INTERVAL_MS);
    console.log('[LISTEN] Heartbeat started (30s interval)');
  } catch (e) {
    console.warn('[LISTEN] Failed to initialize PostgreSQL listener:', e.message);
    _pubsubConnecting = false; // release gate so the scheduled reconnect can run
    // Route through the deduped scheduler instead of a raw setTimeout so a
    // connect failure can't stack its own reconnect on top of an event-driven one.
    scheduleReconnect(`Init failed: ${e.message}`);
  }
}

// Also sync ORG.md when store changes
initWorkspaceBase();

if (WORKSPACE_BASE) {
  let orgTimer = null;
  // #1265: ORG.md sync now driven by Postgres LISTEN/NOTIFY (see syncOrgFiles call in the
  // notification handler). The file watcher below is a no-op safety net for non-Postgres
  // dev mode only — under Postgres it never fires because data/store.json is never written.
  if (existsSync(STORE_PATH) && !usePostgres) {
    watch(STORE_PATH, () => {
      if (orgTimer) clearTimeout(orgTimer);
      orgTimer = setTimeout(() => {
        const data = safeRead(STORE_PATH);
        if (data) syncOrgFiles(data);
      }, 500);
    });
  }

  // Initial sync on startup — Postgres-first.
  // (#1265: previously read stale STORE_PATH here, which fed agents April-15 ORG.md
  // data on every restart. Now we always pull from /api/store like the rest of server.mjs.)
  (async () => {
    try {
      const initialStore = await refreshCachedStore();
      if (initialStore) syncOrgFiles(initialStore);
    } catch (e) {
      console.warn('[ORG sync] initial sync skipped:', e?.message || e);
    }
  })();

  // Seed activity feed from recent task history
  // Always fetch from API (Postgres) to get current data — local store.json may be stale
  const seedFromApi = async (attempt = 1) => {
    try {
      console.log(`[Activity Feed] Seeding from API (attempt ${attempt})...`);
      const store = await refreshCachedStore();
      if (store?.tasks?.length) {
        seedActivityFeedFromStore(store);
        if (activityFeed.length > 0) {
          broadcast('activity-feed', activityFeed.slice(0, 50));
        }
      } else {
        console.warn(`[Activity Feed] No tasks in store`);
        if (attempt < 3) setTimeout(() => seedFromApi(attempt + 1), 5000);
      }
    } catch (e) {
      console.warn(`[Activity Feed] Seed attempt ${attempt} failed:`, e.message);
      if (attempt < 3) {
        setTimeout(() => seedFromApi(attempt + 1), 5000);
      } else if (initialStore) {
        console.log('[Activity Feed] Falling back to local store');
        seedActivityFeedFromStore(initialStore);
      }
    }
  };
  setTimeout(() => seedFromApi(), 10000); // wait for server + Postgres to be fully ready

  // --- Project state migration (idempotent, runs on every startup) ---
  setTimeout(async () => {
    try {
      const { migrateProjectState } = await import('./scripts/migrate-project-state.mjs');
      await migrateProjectState();
    } catch (e) {
      console.warn('[MigrateState] Startup migration failed (non-fatal):', e.message);
    }
  }, 12000); // after Postgres is ready

  // --- Startup reconcile: warn if recent task status transitions disagree ---
  setTimeout(async () => {
    try {
      const store = getCachedStore() || await refreshCachedStore();
      if (!store?.tasks?.length) return;
      const now = Date.now();
      const RECENT_MS = 30 * 60 * 1000; // 30 minutes
      for (const task of store.tasks) {
        if (task.isArchived) continue;
        const lastEntry = (task.statusHistory || []).at(-1);
        if (!lastEntry) continue;
        // #1313: guard against malformed timestamps (undefined/null/NaN/string)
        // which made `new Date(...).toISOString()` throw "Invalid time value" and
        // spam the warn-block on every restart even though it was caught as
        // non-fatal. Skip the row instead of crashing the whole reconcile pass.
        const ts = Number(lastEntry.timestamp);
        if (!Number.isFinite(ts) || ts <= 0) continue;
        if (now - ts > RECENT_MS) continue;
        if (lastEntry.status !== task.status) {
          console.warn(
            `[Reconcile] Task ${task.id} (#${task.ticketNumber || '?'}): ` +
            `statusHistory says '${lastEntry.status}' but current status is '${task.status}'. ` +
            `Possible lost write. Last transition at ${new Date(ts).toISOString()}`
          );
        }
      }
    } catch (e) {
      console.warn('[Reconcile] Startup reconcile failed (non-fatal):', e.message);
    }
  }, 15000);
}

// --- Gateway polling (server-side, pushes to WS clients) with exponential backoff ---
let lastSessionsHash = '';
let lastCronHash = '';
let lastAgentsHash = '';
let cachedSessions = null;
let cachedCron = null;
let cachedGatewayStatus = null;
let cachedAgents = null;
let pollFailureCount = 0;
let pollTimeoutHandle = null;

/**
 * Fetch store from the API (Postgres-backed) for a specific workspace and cache it.
 * #1387 A.2: pass workspaceId to scope the fetch via X-Workspace-Id header. In OSS
 * mode the header is harmless — /api/store still returns the single default-workspace.
 * Returns the store or null.
 */
async function refreshCachedStore(workspaceId = DEFAULT_WORKSPACE_ID) {
  try {
    // #1387 hotfix: A.3 added a cloud-mode auth gate on /api/store GET. This
    // internal self-call must carry the break-glass key or it 401s and the
    // WS clients never receive any store payload. ORG_STUDIO_API_KEY is
    // always present in cloud mode (cluster secret) and unused/null in OSS.
    const headers = { 'X-Workspace-Id': workspaceId };
    if (process.env.ORG_STUDIO_API_KEY) {
      headers['Authorization'] = `Bearer ${process.env.ORG_STUDIO_API_KEY}`;
    }
    const res = await fetch(`http://127.0.0.1:${port}/api/store`, { headers });
    if (res.ok) {
      const data = await res.json();
      cachedStoreByWorkspace.set(workspaceId, data);
      return data;
    }
  } catch (e) {
    // #1265: Postgres-first. Falling back to STORE_PATH used to silently feed stale
    // April-15 data into the in-memory cache. Now we just log and return null —
    // callers already gracefully handle a missing cachedStore.
    console.warn(`[refreshCachedStore ws=${workspaceId}] /api/store fetch failed:`, e?.message || e);
    cachedStoreByWorkspace.delete(workspaceId);
  }
  return null;
}

function quickHash(obj) {
  return JSON.stringify(obj).length + ':' + JSON.stringify(obj).slice(0, 200);
}

async function pollGateway() {
  if (wss.clients.size === 0) return; // No clients, skip

  try {
    const sessResp = await fetch(`http://127.0.0.1:${port}/api/gateway`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ method: 'sessions.list', params: { limit: 50 } }),
    });
    const sessData = await sessResp.json();
    if (sessData.result) {
      cachedSessions = sessData.result;
      const hash = quickHash(sessData.result);
      if (hash !== lastSessionsHash) {
        lastSessionsHash = hash;
        broadcast('sessions', sessData.result);
      }
    }
  } catch {}

  try {
    const cronResp = await fetch(`http://127.0.0.1:${port}/api/gateway`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ method: 'cron.list' }),
    });
    const cronData = await cronResp.json();
    if (cronData.result) {
      cachedCron = cronData.result;
      const hash = quickHash(cronData.result);
      if (hash !== lastCronHash) {
        lastCronHash = hash;
        broadcast('cron', cronData.result);
      }
    }
  } catch {}

  try {
    const statusResp = await fetch(`http://127.0.0.1:${port}/api/gateway`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ method: 'status' }),
    });
    const statusData = await statusResp.json();
    if (statusData.result) {
      cachedGatewayStatus = statusData.result;
      broadcast('gateway-status', statusData.result);
    }
  } catch {}

  // Agent discovery is on-demand (triggered by UI sync button via /api/runtimes).
  // No automatic polling — agents rarely change and Hermes hits are HTTP.

  // On success, reset failure count and schedule next poll
  pollFailureCount = 0;
  scheduleNextPoll(8000);
}

function scheduleNextPoll(delay) {
  if (pollTimeoutHandle) clearTimeout(pollTimeoutHandle);
  pollTimeoutHandle = setTimeout(pollGateway, delay);
}

// Wrap original pollGateway with error handling + backoff
const originalPollGateway = pollGateway;
async function pollGatewayWithBackoff() {
  try {
    await originalPollGateway();
  } catch {
    // On failure, increment counter and back off
    pollFailureCount++;
    const nextInterval = Math.min(8000 * Math.pow(1.5, pollFailureCount), 120000);
    scheduleNextPoll(nextInterval);
  }
}

// Replace the pollGateway reference
pollGateway = pollGatewayWithBackoff;

scheduleNextPoll(3000); // Initial poll after 3s

// --- Client connection ---
wss.on('connection', (ws, req) => {
  // Reset failure counter and poll immediately when a new client connects
  // (user opened dashboard, worth retrying)
  pollFailureCount = 0;
  scheduleNextPoll(100);

  // #1387 A.2: Resolve workspace from the upgrade request. The browser sends its
  // cookies on the WS handshake; we look for org_studio_workspace_id, fall back to
  // a ?workspace_id=... query param, then default-workspace. In OSS mode every
  // client resolves to 'default-workspace' — identical to pre-refactor behaviour.
  let workspaceId = DEFAULT_WORKSPACE_ID;
  try {
    const cookieHeader = req?.headers?.cookie || '';
    const m = cookieHeader.match(/(?:^|;\s*)org_studio_workspace_id=([^;]+)/);
    if (m) {
      workspaceId = decodeURIComponent(m[1]);
    } else if (req?.url) {
      const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
      const qp = url.searchParams.get('workspace_id');
      if (qp) workspaceId = qp;
    }
  } catch { /* fall back to default */ }
  ws.workspaceId = workspaceId;

  // Send all cached state immediately. cachedStore is Postgres-backed and warmed at
  // startup via refreshCachedStore(); if it's null the client will pick it up on the
  // next /api/store HTTP poll. (#1265: dropped stale STORE_PATH fallback.)
  // #1387 A.2: only send THIS client's workspace store. Lazily refresh if we haven't
  // populated this workspace's slot yet.
  let store = getCachedStore(workspaceId);
  if (!store) {
    // Fire-and-forget refresh; the client will also poll /api/store on its own.
    refreshCachedStore(workspaceId)
      .then((fresh) => {
        if (fresh && ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: 'store', data: fresh, ts: Date.now() }));
        }
      })
      .catch(() => {});
  } else {
    ws.send(JSON.stringify({ type: 'store', data: store, ts: Date.now() }));
  }

  const statuses = safeRead(STATUS_PATH);
  if (statuses) ws.send(JSON.stringify({ type: 'activity-status', data: statuses, ts: Date.now() }));

  if (cachedSessions) ws.send(JSON.stringify({ type: 'sessions', data: cachedSessions, ts: Date.now() }));
  if (cachedCron) ws.send(JSON.stringify({ type: 'cron', data: cachedCron, ts: Date.now() }));
  if (cachedGatewayStatus) ws.send(JSON.stringify({ type: 'gateway-status', data: cachedGatewayStatus, ts: Date.now() }));
  if (cachedAgents) ws.send(JSON.stringify({ type: 'gateway-agents', data: cachedAgents, ts: Date.now() }));

  // Ping/pong keepalive
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });
});

// Keepalive sweep
setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.isAlive) { ws.terminate(); continue; }
    ws.isAlive = false;
    ws.ping();
  }
}, 30000);



// --- Cron One-Shot Garbage Collection ---
// On server startup, clean up stale one-shot jobs (deleteAfterRun = true && schedule.at in past)
async function cleanupStaleCrons() {
  const CRON_PATH = join(process.env.HOME || '/tmp', '.openclaw', 'cron', 'jobs.json');
  try {
    if (!existsSync(CRON_PATH)) return;
    const cronData = JSON.parse(readFileSync(CRON_PATH, 'utf-8'));
    if (!Array.isArray(cronData.jobs)) return;

    const now = Date.now();
    const before = cronData.jobs.length;
    cronData.jobs = cronData.jobs.filter(job => {
      // Keep jobs unless they are one-shots in the past
      if (job.deleteAfterRun !== true) return true;
      if (!job.schedule?.at) return true;
      // schedule.at is a timestamp in ms
      const runAt = typeof job.schedule.at === 'number' ? job.schedule.at : parseInt(job.schedule.at, 10);
      return runAt > now; // keep if future, discard if past
    });
    const removed = before - cronData.jobs.length;
    if (removed > 0) {
      writeFileSync(CRON_PATH, JSON.stringify(cronData, null, 2));
      console.log(`[Cron GC] Cleaned up ${removed} stale one-shot job(s)`);
    }
  } catch (e) {
    console.warn('[Cron GC] Cleanup failed:', e?.message);
  }
}

// --- Lightweight Stuck-Task Watchdog (30-minute safety net) ---
// Catches tasks stuck in in-progress when nobody is watching the dashboard.
// Only fires event-driven triggers — never creates cron jobs.
const WATCHDOG_INTERVAL_MS = 30 * 60 * 1000; // 30 minutes
const VISION_CYCLE_TIMEOUT_MS = 15 * 60 * 1000; // 15 minutes — vision cycles should complete within this

// --- Stuck Task constants (shared between watchdog + incident logging, merged by KISS cleanup) ---
const STUCK_TASK_THRESHOLD_MIN = parseInt(process.env.STUCK_TASK_THRESHOLD_MIN || '30', 10);
const STUCK_TASK_THRESHOLD_MS = STUCK_TASK_THRESHOLD_MIN * 60 * 1000;
const _stuckTaskLoggedSet = new Set(); // task ids already emitted this uptime

// Log incident for stuck tasks (called from stuckTaskWatchdog, no separate interval).
async function logStuckTaskIncidents(store) {
  if (!store?.tasks?.length) return;

  const now = Date.now();
  const projects = store.projects || [];
  const currentStuckIds = new Set();

  for (const task of store.tasks) {
    if (task.isArchived || task.status !== 'in-progress') continue;

    let inProgressSince = task.updatedAt || task.createdAt || now;
    const history = task.statusHistory || [];
    for (let i = history.length - 1; i >= 0; i--) {
      if (history[i].status === 'in-progress') {
        inProgressSince = history[i].timestamp;
        break;
      }
    }

    const elapsed = now - new Date(inProgressSince).getTime();
    const minutesInStatus = Math.round(elapsed / 60000);

    if (elapsed > STUCK_TASK_THRESHOLD_MS) {
      currentStuckIds.add(task.id);

      if (!_stuckTaskLoggedSet.has(task.id)) {
        const proj = projects.find(p => p.id === task.projectId);
        const projectName = proj?.name || '(unknown)';
        try {
          await logIncident({
            type: 'stuck_task',
            agentId: task.assigneeId || null,
            message: `Task "${task.title}" stuck in-progress for ${minutesInStatus}m (assignee: ${task.assignee || 'none'}, project: ${projectName})`,
            context: {
              taskId: task.id,
              title: task.title,
              assignee: task.assignee || null,
              projectId: task.projectId || null,
              projectName,
              minutesInStatus,
              lastStatusTimestamp: inProgressSince,
            },
          });
        } catch (e) {
          console.error('[Watchdog] logIncident failed (non-fatal):', e.message);
        }
        _stuckTaskLoggedSet.add(task.id);
      }
    }
  }

  for (const id of _stuckTaskLoggedSet) {
    if (!currentStuckIds.has(id)) {
      _stuckTaskLoggedSet.delete(id);
    }
  }
}

// --- Project Integrity Audit (#697) ---
const PROJECT_INTEGRITY_INTERVAL_MS = 60_000; // 60 seconds
const _projectIntegrityLoggedMap = new Map(); // key: `${projectId}:${violationType}` -> timestamp
const PROJECT_INTEGRITY_DEDUP_MS = 60 * 60_000; // 60 minutes

async function projectIntegrityAudit() {
  // #1387 A.2: this watchdog originally ran against the single global cachedStore.
  // It still reads only the default-workspace store; a follow-up will iterate every
  // workspace via getStoreProviderAllWorkspaces(). For now we preserve identical
  // behaviour by reading default-workspace explicitly.
  // TODO(#1387 A-followup): iterate all workspaces.
  const store = getCachedStore(); // #1265: Postgres-backed only; no stale STORE_PATH fallback.
  if (!store?.projects?.length) return;

  const now = Date.now();

  for (const project of store.projects) {
    if (project.isArchived) continue;

    const pid = project.id;
    const pname = project.name || '(unnamed)';

    // Check 1: no roadmap versions
    if (!project.versions || !Array.isArray(project.versions) || project.versions.length === 0) {
      const dedupKey = `${pid}:project_no_roadmap`;
      const lastEmit = _projectIntegrityLoggedMap.get(dedupKey) || 0;
      if (now - lastEmit > PROJECT_INTEGRITY_DEDUP_MS) {
        try {
          await logIncident({
            type: 'project_no_roadmap',
            agentId: null,
            message: `Project "${pname}" has no roadmap versions — dispatch and auto-advance will not work`,
            context: { projectId: pid, projectName: pname, severity: 'warning' },
          });
        } catch (e) {
          console.error('[ProjectIntegrityAudit] logIncident failed (non-fatal):', e.message);
        }
        _projectIntegrityLoggedMap.set(dedupKey, now);
      }
    }

    // Check 2: autoAdvance unset
    if (project.autoAdvance === undefined) {
      const dedupKey = `${pid}:project_autoadvance_unset`;
      const lastEmit = _projectIntegrityLoggedMap.get(dedupKey) || 0;
      if (now - lastEmit > PROJECT_INTEGRITY_DEDUP_MS) {
        try {
          await logIncident({
            type: 'project_autoadvance_unset',
            agentId: null,
            message: `Project "${pname}" has autoAdvance undefined — auto-advance disabled by default`,
            context: { projectId: pid, projectName: pname, severity: 'warning' },
          });
        } catch (e) {
          console.error('[ProjectIntegrityAudit] logIncident failed (non-fatal):', e.message);
        }
        _projectIntegrityLoggedMap.set(dedupKey, now);
      }
    }

    // Check 3: currentVersion orphan
    if (project.currentVersion) {
      const versions = project.versions || [];
      const found = versions.some(v =>
        v.id === project.currentVersion ||
        v.version === project.currentVersion
      );
      if (!found) {
        const dedupKey = `${pid}:project_current_version_orphan`;
        const lastEmit = _projectIntegrityLoggedMap.get(dedupKey) || 0;
        if (now - lastEmit > PROJECT_INTEGRITY_DEDUP_MS) {
          try {
            await logIncident({
              type: 'project_current_version_orphan',
              agentId: null,
              message: `Project "${pname}" currentVersion "${project.currentVersion}" does not match any roadmap version`,
              context: { projectId: pid, projectName: pname, currentVersion: project.currentVersion, severity: 'warning' },
            });
          } catch (e) {
            console.error('[ProjectIntegrityAudit] logIncident failed (non-fatal):', e.message);
          }
          _projectIntegrityLoggedMap.set(dedupKey, now);
        }
      }
    }
  }
}

async function stuckTaskWatchdog() {
  // #1265: cachedStore is Postgres-backed; no stale STORE_PATH fallback.
  // #1387 A.2: default-workspace only for now — see projectIntegrityAudit note.
  // TODO(#1387 A-followup): iterate all workspaces.
  const store = getCachedStore();
  if (!store?.tasks?.length) return;

  // Log incidents for stuck tasks (merged from standalone stuckTaskDetector)
  await logStuckTaskIncidents(store);

  const now = Date.now();
  const teammates = store.settings?.teammates || [];
  const triggered = new Set();

  for (const task of store.tasks) {
    if (task.isArchived || task.loopPausedAt) continue;
    if (task.status !== 'in-progress') continue;

    const lastActivity = task.lastActivityAt
      || (task.statusHistory?.length ? task.statusHistory[task.statusHistory.length - 1]?.timestamp : null)
      || task.createdAt || 0;

    if (now - lastActivity < STUCK_TASK_THRESHOLD_MS) continue;

    const assignee = task.assignee;
    if (!assignee || triggered.has(assignee.toLowerCase())) continue;

    const match = teammates.find(t =>
      t.name?.toLowerCase() === assignee.toLowerCase() || t.agentId === assignee.toLowerCase()
    );
    const agentId = match?.agentId;
    if (!agentId) continue;

    triggered.add(assignee.toLowerCase());
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/scheduler`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'trigger', agentId }),
      });
      if (res.ok) {
        const data = await res.json();
        if (data.triggered) {
          console.log(`[Watchdog] Re-triggered ${agentId}: stuck task "${task.title?.substring(0, 40)}"`);
        }
      }
    } catch { /* non-fatal */ }
  }

  // --- Chain Recovery: re-trigger agents with orphaned backlog ---
  // Catches the case where an agent completed work but never updated task status,
  // or where the chain broke (status update failed, session errored, etc.)
  const agentsWithBacklog = new Map();
  for (const task of store.tasks) {
    if (task.isArchived || task.loopPausedAt) continue;
    if (task.status !== 'backlog') continue;
    const assignee = task.assignee;
    if (!assignee) continue;
    const key = assignee.toLowerCase();
    if (triggered.has(key)) continue; // already triggered above for stuck in-progress
    if (!agentsWithBacklog.has(key)) agentsWithBacklog.set(key, []);
    agentsWithBacklog.get(key).push(task);
  }

  for (const [assigneeLower, tasks] of agentsWithBacklog) {
    // Check if this agent has any in-progress tasks — if so, they're working, skip
    const hasInProgress = store.tasks.some(t =>
      !t.isArchived && t.status === 'in-progress' &&
      (t.assignee || '').toLowerCase() === assigneeLower
    );
    if (hasInProgress) continue;

    const match = teammates.find(t =>
      t.name?.toLowerCase() === assigneeLower || t.agentId === assigneeLower
    );
    const agentId = match?.agentId;
    if (!agentId) continue;

    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/scheduler`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${process.env.ORG_STUDIO_API_KEY || ''}` },
        body: JSON.stringify({ action: 'trigger', agentId }),
      });
      if (res.ok) {
        const data = await res.json();
        if (data.triggered) {
          console.log(`[Watchdog] Chain recovery — re-triggered ${agentId}: ${tasks.length} orphaned backlog task(s)`);
        }
      }
    } catch { /* non-fatal */ }
  }

  // --- Stale Vision Cycle Recovery ---
  await staleVisionCycleCheck(store);
}

/**
 * Detect and recover from stale vision cycles.
 * If pendingVersion is 'awaiting_agent_response' or 'needs_launch' for longer than
 * VISION_CYCLE_TIMEOUT_MS, auto-retry once, then clear and notify on second failure.
 */
async function staleVisionCycleCheck(store) {
  if (!store?.projects?.length) return;
  const now = Date.now();
  const NOTIFY_CHAT_ID = process.env.NOTIFY_CHAT_ID || '';
  const ONE_HOUR = 60 * 60 * 1000;

  for (const project of store.projects) {
    const autonomy = project.autonomy;
    if (!autonomy) continue;

    const pending = autonomy.pendingVersion;
    if (!pending || pending === null) continue;

    // Only recover from in-flight states (not version proposals like "0.8")
    if (pending !== 'awaiting_agent_response' && pending !== 'needs_launch' && pending !== 'in-progress') continue;

    const launchedAt = autonomy.lastLaunchedAt || 0;
    const elapsed = now - launchedAt;

    if (elapsed < VISION_CYCLE_TIMEOUT_MS) continue;

    const elapsedMin = Math.round(elapsed / 60000);
    const lastTimeoutAt = autonomy.lastTimeoutAt || 0;
    const recentlyTimedOut = (now - lastTimeoutAt) < ONE_HOUR;

    const apiKey = process.env.ORG_STUDIO_API_KEY;
    const headers = { 'Content-Type': 'application/json' };
    if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;

    if (!recentlyTimedOut) {
      // First timeout — auto-retry once
      console.log(`[Watchdog] Stale vision cycle: ${project.name} (${pending} for ${elapsedMin}m) — auto-retrying`);

      try {
        // Mark the timeout so we don't retry again within the hour
        await fetch(`http://127.0.0.1:${port}/api/store`, {
          method: 'POST',
          headers,
          body: JSON.stringify({
            action: 'updateProject',
            id: project.id,
            updates: {
              autonomy: {
                ...autonomy,
                pendingVersion: null,
                lastTimeoutAt: now,
                _launchIntent: undefined,
              },
            },
          }),
        });

        // Re-launch the vision cycle
        const launchRes = await fetch(`http://127.0.0.1:${port}/api/vision/${project.id}/launch`, {
          method: 'POST',
          headers,
        });
        const launchData = await launchRes.json();

        if (launchData.ok) {
          console.log(`[Watchdog] Auto-retried vision cycle for ${project.name} (mode: ${launchData.mode})`);
          // Notify about the retry
          try {
            await fetch(`http://127.0.0.1:${port}/api/gateway`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                method: 'chat.send',
                params: {
                  sessionKey: 'agent:main:main',
                  message: `🔄 **Vision cycle auto-retry: ${project.name}**\nPrevious cycle timed out after ${elapsedMin}m. Re-launched automatically.`,
                  idempotencyKey: `vision-retry-${project.id}-${now}`,
                },
              }),
            });
          } catch { /* best-effort notification */ }
        } else {
          console.error(`[Watchdog] Auto-retry launch failed for ${project.name}:`, launchData.error);
        }
      } catch (e) {
        console.error(`[Watchdog] Auto-retry failed for ${project.name}:`, e.message);
      }
    } else {
      // Second timeout within the hour — give up, clear, and notify
      console.log(`[Watchdog] Stale vision cycle: ${project.name} (${pending} for ${elapsedMin}m, retried recently) — giving up`);

      try {
        await fetch(`http://127.0.0.1:${port}/api/store`, {
          method: 'POST',
          headers,
          body: JSON.stringify({
            action: 'updateProject',
            id: project.id,
            updates: {
              autonomy: {
                ...autonomy,
                pendingVersion: null,
                _launchIntent: undefined,
              },
            },
          }),
        });

        console.log(`[Watchdog] Cleared stale vision cycle for ${project.name} (retry also failed)`);

        try {
          await fetch(`http://127.0.0.1:${port}/api/gateway`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              method: 'chat.send',
              params: {
                sessionKey: 'agent:main:main',
                message: `⏰ **Vision cycle failed: ${project.name}**\nTimed out twice (last attempt ${elapsedMin}m ago). Auto-retry also failed. Cleared — re-launch manually from the Vision page if needed.`,
                idempotencyKey: `vision-timeout-${project.id}-${now}`,
              },
            }),
          });
        } catch { /* best-effort notification */ }
      } catch (e) {
        console.error(`[Watchdog] Failed to clear stale vision cycle for ${project.name}:`, e.message);
      }
    }
  }
}

/**
 * Compute daily metrics for all agents and upsert to the metrics table.
 * Accepts an optional targetDate (YYYY-MM-DD); defaults to today.
 * Runs at startup + daily at midnight.
 */
async function computeDailyMetrics(targetDate) {
  try {
    const store = await refreshCachedStore();
    if (!store?.tasks?.length) return;

    const teammates = store.settings?.teammates || [];
    const agents = teammates.filter(t => !t.isHuman && t.agentId);

    const today = targetDate || new Date().toISOString().split('T')[0]; // YYYY-MM-DD
    const dayStart = new Date(today + 'T00:00:00Z').getTime();
    const dayEnd = dayStart + 24 * 60 * 60 * 1000;

    console.log(`[Metrics] Computing daily metrics for ${agents.length} agents (${today})`);

    // #1524 — bulk-fetch all comments in the day window from
    // org_studio_comments in one query, then index by task_id. Replaces
    // the previous per-task inline task.comments[] reads which were
    // about to silently break once #1294 stops the dual-write. Falls
    // back to the inline blob on DB error so a stale Postgres
    // connection doesn't drop daily metrics on the floor.
    const commentsByTaskId = new Map();
    let bulkOk = false;
    const dbUrl = process.env.DATABASE_URL;
    if (dbUrl) {
      try {
        const { default: pg } = await import('pg');
        const client = new pg.Client({ connectionString: dbUrl });
        await client.connect();
        try {
          const { rows } = await client.query(
            `SELECT id, task_id, author, content, type, mentions, created_at
               FROM org_studio_comments
              WHERE scope_kind = 'task'
                -- created_at is a BIGINT ms-epoch (matches createdAt across the
                -- store), NOT timestamptz. Comparing via to_timestamp() threw
                -- 'cannot compare bigint >= timestamp with time zone' on every
                -- run — primary path never succeeded, fallback masked it (#1649).
                AND created_at >= $1
                AND created_at <  $2
              ORDER BY task_id, created_at ASC`,
            [dayStart, dayEnd],
          );
          for (const row of rows) {
            const c = {
              id: row.id,
              author: row.author,
              content: row.content,
              type: row.type,
              mentions: Array.isArray(row.mentions) ? row.mentions : [],
              createdAt: row.created_at instanceof Date ? row.created_at.getTime() : Number(row.created_at),
            };
            const list = commentsByTaskId.get(row.task_id) || [];
            list.push(c);
            commentsByTaskId.set(row.task_id, list);
          }
          bulkOk = true;
        } finally {
          await client.end();
        }
      } catch (err) {
        console.warn(`[Metrics #1524] bulk comments query failed; falling back to inline blob: ${err?.message || err}`);
      }
    }

    // #1524 — helper to resolve a task's comments preferring the bulk
    // result (Postgres) and falling back to the inline blob. Returns the
    // ALL-time comments list for the inline path (legacy compat) or the
    // day-window comments from the bulk query (sufficient because every
    // metrics check is already day-window-gated).
    const getTaskComments = (task) => {
      if (bulkOk) return commentsByTaskId.get(task.id) || [];
      return Array.isArray(task.comments) ? task.comments : [];
    };

    let computedCount = 0;
    for (const agent of agents) {
      const agentId = agent.agentId;
      const nameLower = agent.name.toLowerCase();
      const agentIdLower = agentId.toLowerCase();

      // Filter tasks assigned to this agent
      const agentTasks = store.tasks.filter(t => {
        const assignee = (t.assignee || '').toLowerCase();
        return assignee === nameLower || assignee === agentIdLower;
      });

      // --- Tasks completed/started today ---
      let tasksCompleted = 0;
      let tasksStarted = 0;
      const durations = [];
      const gaps = [];
      let prevCompleted = null;
      let bounceCount = 0;
      let stallCount = 0;
      let firstPassCount = 0;
      let doneCount = 0;
      let reviewNotesCount = 0;
      let testPlanCount = 0;

      for (const task of agentTasks) {
        const history = task.statusHistory || [];
        for (const h of history) {
          if (!h.timestamp || h.timestamp < dayStart || h.timestamp >= dayEnd) continue;
          if (h.status === 'done') {
            tasksCompleted++;
            doneCount++;
            if (task.reviewNotes) reviewNotesCount++;
            if (task.testPlan) testPlanCount++;
          }
          if (h.status === 'in-progress') {
            tasksStarted++;
          }
        }

        // Compute duration (first in-progress to last done within the day)
        const startedAt = history.find(h => h.status === 'in-progress' && h.timestamp >= dayStart && h.timestamp < dayEnd)?.timestamp;
        const completedAt = [...history].reverse().find(h => h.status === 'done' && h.timestamp >= dayStart && h.timestamp < dayEnd)?.timestamp;
        if (startedAt && completedAt && completedAt > startedAt) {
          durations.push((completedAt - startedAt) / 60000);
          if (prevCompleted) {
            const gap = (startedAt - prevCompleted) / 60000;
            if (gap >= 0) gaps.push(gap);
          }
          prevCompleted = completedAt;
        }

        // Bounce detection: task went from review/qa back to in-progress
        for (let i = 1; i < history.length; i++) {
          if (history[i].timestamp < dayStart || history[i].timestamp >= dayEnd) continue;
          if (history[i].status === 'in-progress' && (history[i-1]?.status === 'review' || history[i-1]?.status === 'qa')) {
            bounceCount++;
          }
        }

        // First-pass: went straight to done without bouncing
        const dayHistory = history.filter(h => h.timestamp >= dayStart && h.timestamp < dayEnd);
        const statusSequence = dayHistory.map(h => h.status);
        if (statusSequence.includes('done') && !statusSequence.includes('blocked')) {
          let bounced = false;
          for (let i = 1; i < statusSequence.length; i++) {
            if (statusSequence[i] === 'in-progress' && (statusSequence[i-1] === 'review' || statusSequence[i-1] === 'qa')) {
              bounced = true;
              break;
            }
          }
          if (!bounced) firstPassCount++;
        }

        // Stall detection
        if (task.loopPausedAt && task.loopPausedAt >= dayStart && task.loopPausedAt < dayEnd) {
          stallCount++;
        }
      }

      // --- Comments + Mention Response Time ---
      let commentsPosted = 0;
      let mentionsSent = 0;
      let mentionsReceived = 0;
      const mentionResponseTimes = []; // minutes between @mention and agent reply

      for (const task of store.tasks) {
        const comments = getTaskComments(task);
        for (let ci = 0; ci < comments.length; ci++) {
          const comment = comments[ci];
          if (!comment.createdAt || comment.createdAt < dayStart || comment.createdAt >= dayEnd) continue;
          if (comment.type === 'system') continue;
          const author = (comment.author || '').toLowerCase();
          if (author === nameLower || author === agentIdLower) {
            commentsPosted++;
            const mentionMatches = (comment.content || '').match(/@[\w-]+/g) || [];
            mentionsSent += mentionMatches.length;
          }
          const mentions = comment.mentions || [];
          if (mentions.some(m => m.toLowerCase() === nameLower || m.toLowerCase() === agentIdLower)) {
            mentionsReceived++;
            // Find the agent's next reply on this task (any comment after this one by the agent)
            for (let ri = ci + 1; ri < comments.length; ri++) {
              const reply = comments[ri];
              if (reply.type === 'system') continue;
              const replyAuthor = (reply.author || '').toLowerCase();
              if (replyAuthor === nameLower || replyAuthor === agentIdLower) {
                if (reply.createdAt && reply.createdAt > comment.createdAt) {
                  const responseMin = (reply.createdAt - comment.createdAt) / 60000;
                  if (responseMin < 1440) { // ignore responses > 24h (likely unrelated)
                    mentionResponseTimes.push(responseMin);
                  }
                }
                break; // only count the first reply
              }
            }
          }
        }
      }
      const mentionResponseMin = mentionResponseTimes.length > 0
        ? Math.round((mentionResponseTimes.reduce((a, b) => a + b, 0) / mentionResponseTimes.length) * 10) / 10
        : null;

      // --- Cross-Agent Collaboration ---
      let handoffCount = 0;
      const sharedTaskIds = new Set();
      const mentionedAgents = {}; // agentName -> count (who this agent mentions most)
      const mentionedByAgents = {}; // agentName -> count (who mentions this agent most)

      for (const task of store.tasks) {
        // Handoff tracking: devHandoff set by this agent
        if (task.devHandoff?.author?.toLowerCase() === nameLower || task.devHandoff?.author?.toLowerCase() === agentIdLower) {
          if (task.devHandoff.timestamp >= dayStart && task.devHandoff.timestamp < dayEnd) {
            handoffCount++;
          }
        }

        // Shared task detection: multiple agents commented on same task
        const taskComments = (getTaskComments(task)).filter(c =>
          c.createdAt >= dayStart && c.createdAt < dayEnd && c.type !== 'system'
        );
        const commentAuthors = new Set(taskComments.map(c => (c.author || '').toLowerCase()));
        if (commentAuthors.has(nameLower) || commentAuthors.has(agentIdLower)) {
          if (commentAuthors.size > 1) sharedTaskIds.add(task.id);
        }

        // Per-agent mention breakdown
        for (const comment of taskComments) {
          const author = (comment.author || '').toLowerCase();
          if (author === nameLower || author === agentIdLower) {
            // Outbound mentions from this agent
            for (const m of (comment.mentions || [])) {
              const target = m.toLowerCase();
              mentionedAgents[target] = (mentionedAgents[target] || 0) + 1;
            }
          }
          // Inbound mentions to this agent
          if ((comment.mentions || []).some(m => m.toLowerCase() === nameLower || m.toLowerCase() === agentIdLower)) {
            mentionedByAgents[author] = (mentionedByAgents[author] || 0) + 1;
          }
        }
      }

      const collaboration = {
        handoffCount,
        sharedTaskCount: sharedTaskIds.size,
        mentionedAgents, // who this agent mentions
        mentionedByAgents, // who mentions this agent
      };

      // --- Compute derived metrics ---
      const avgDuration = durations.length > 0 ? durations.reduce((a, b) => a + b, 0) / durations.length : null;
      const medianDuration = durations.length > 0 ? durations.sort((a, b) => a - b)[Math.floor(durations.length / 2)] : null;
      const avgGap = gaps.length > 0 ? gaps.reduce((a, b) => a + b, 0) / gaps.length : null;
      const chainRate = gaps.length > 0 ? gaps.filter(g => g < 2).length / gaps.length : null;

      let activeMinutes = 0;
      if (durations.length > 0) {
        activeMinutes = durations.reduce((a, b) => a + b, 0) + gaps.filter(g => g < 30).reduce((a, b) => a + b, 0);
      }
      const throughput = activeMinutes > 0 ? (tasksCompleted / (activeMinutes / 60)) : null;
      const firstPassRate = doneCount > 0 ? firstPassCount / doneCount : null;
      const reviewNotesRate = doneCount > 0 ? reviewNotesCount / doneCount : null;
      const testPlanRate = doneCount > 0 ? testPlanCount / doneCount : null;

      // --- Kudos/flags ---
      let kudosCount = 0;
      let flagCount = 0;
      try {
        // Try both agentId (e.g. hermes-gem) and name (e.g. Gem) since kudos may be stored under either
        const kudosRes = await fetch(`http://127.0.0.1:${port}/api/kudos?agentId=${agentId}&limit=100`);
        const kudosRes2 = agent.name && agent.name.toLowerCase() !== agentIdLower
          ? await fetch(`http://127.0.0.1:${port}/api/kudos?agentId=${encodeURIComponent(agent.name)}&limit=100`)
          : null;
        if (kudosRes.ok) {
          const kudosData = await kudosRes.json();
          const kudosData2 = kudosRes2?.ok ? await kudosRes2.json() : { kudos: [] };
          // Merge and deduplicate by id
          const kudosMap = new Map();
          for (const k of [...(kudosData.kudos || []), ...(kudosData2.kudos || [])]) {
            if (!kudosMap.has(k.id)) kudosMap.set(k.id, k);
          }
          const allKudos = Array.from(kudosMap.values());
          for (const k of allKudos) {
            const rawTs = k.createdAt || k.created_at;
            const ts = typeof rawTs === 'number' ? rawTs : (typeof rawTs === 'string' ? (Number(rawTs) || new Date(rawTs).getTime()) : NaN);
            if (ts >= dayStart && ts < dayEnd) {
              if (k.type === 'kudos') kudosCount++;
              if (k.type === 'flag') flagCount++;
            }
          }
        }
      } catch {} // best-effort

      // Skip agents with zero activity (but keep if they received kudos/flags)
      if (tasksCompleted === 0 && tasksStarted === 0 && commentsPosted === 0 && kudosCount === 0 && flagCount === 0) continue;

      // --- Upsert ---
      const metrics = {
        tasks_completed: tasksCompleted,
        tasks_started: tasksStarted,
        avg_duration_min: avgDuration ? Math.round(avgDuration * 10) / 10 : null,
        median_duration_min: medianDuration ? Math.round(medianDuration * 10) / 10 : null,
        avg_gap_min: avgGap ? Math.round(avgGap * 10) / 10 : null,
        chain_rate: chainRate ? Math.round(chainRate * 1000) / 1000 : null,
        throughput: throughput ? Math.round(throughput * 10) / 10 : null,
        first_pass_rate: firstPassRate ? Math.round(firstPassRate * 1000) / 1000 : null,
        bounce_count: bounceCount,
        stall_count: stallCount,
        comments_posted: commentsPosted,
        mentions_received: mentionsReceived,
        mentions_sent: mentionsSent,
        mention_response_min: mentionResponseMin,
        kudos_count: kudosCount,
        flag_count: flagCount,
        review_notes_rate: reviewNotesRate ? Math.round(reviewNotesRate * 1000) / 1000 : null,
        test_plan_rate: testPlanRate ? Math.round(testPlanRate * 1000) / 1000 : null,
        active_minutes: Math.round(activeMinutes),
        versions_completed: 0,
        collaboration, // stored in JSONB overflow
      };

      try {
        const apiKey = process.env.ORG_STUDIO_API_KEY || '';
        const headers = { 'Content-Type': 'application/json' };
        if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;
        await fetch(`http://127.0.0.1:${port}/api/metrics/${agentId}`, {
          method: 'POST',
          headers,
          body: JSON.stringify({ date: today, metrics }),
        });
        console.log(`[Metrics] ${agent.name}: ${tasksCompleted} completed, ${commentsPosted} comments, throughput ${throughput?.toFixed(1) || '?'}/hr${mentionResponseMin ? `, mention response ${mentionResponseMin}m` : ''}`);
        computedCount++;

        // --- Per-section metrics ---
        // Collect distinct sectionIds from tasks touched today
        const sectionIds = new Set();
        for (const task of agentTasks) {
          if (task.sectionId) {
            const history = task.statusHistory || [];
            for (const h of history) {
              if (h.timestamp >= dayStart && h.timestamp < dayEnd) {
                sectionIds.add(task.sectionId);
                break;
              }
            }
          }
        }

        for (const secId of sectionIds) {
          // Recompute metrics for tasks in this section only
          const secTasks = agentTasks.filter(t => t.sectionId === secId);
          let secCompleted = 0, secStarted = 0;
          const secDurations = [], secGaps = [];
          let secPrev = null, secBounce = 0, secStall = 0, secFirstPass = 0, secDone = 0;
          let secReviewNotes = 0, secTestPlan = 0;

          for (const task of secTasks) {
            const h = task.statusHistory || [];
            for (const entry of h) {
              if (!entry.timestamp || entry.timestamp < dayStart || entry.timestamp >= dayEnd) continue;
              if (entry.status === 'done') { secCompleted++; secDone++; if (task.reviewNotes) secReviewNotes++; if (task.testPlan) secTestPlan++; }
              if (entry.status === 'in-progress') secStarted++;
            }
            const sAt = h.find(e => e.status === 'in-progress' && e.timestamp >= dayStart && e.timestamp < dayEnd)?.timestamp;
            const cAt = [...h].reverse().find(e => e.status === 'done' && e.timestamp >= dayStart && e.timestamp < dayEnd)?.timestamp;
            if (sAt && cAt && cAt > sAt) {
              secDurations.push((cAt - sAt) / 60000);
              if (secPrev) { const g = (sAt - secPrev) / 60000; if (g >= 0) secGaps.push(g); }
              secPrev = cAt;
            }
            for (let i = 1; i < h.length; i++) {
              if (h[i].timestamp < dayStart || h[i].timestamp >= dayEnd) continue;
              if (h[i].status === 'in-progress' && (h[i-1]?.status === 'review' || h[i-1]?.status === 'qa')) secBounce++;
            }
            const dayH = h.filter(e => e.timestamp >= dayStart && e.timestamp < dayEnd).map(e => e.status);
            if (dayH.includes('done') && !dayH.includes('blocked')) {
              let b = false;
              for (let i = 1; i < dayH.length; i++) { if (dayH[i] === 'in-progress' && (dayH[i-1] === 'review' || dayH[i-1] === 'qa')) { b = true; break; } }
              if (!b) secFirstPass++;
            }
            if (task.loopPausedAt && task.loopPausedAt >= dayStart && task.loopPausedAt < dayEnd) secStall++;
          }

          if (secCompleted === 0 && secStarted === 0) continue;

          const secAvgDur = secDurations.length > 0 ? secDurations.reduce((a,b) => a+b, 0) / secDurations.length : null;
          const secMedDur = secDurations.length > 0 ? secDurations.sort((a,b) => a-b)[Math.floor(secDurations.length / 2)] : null;
          const secAvgGap = secGaps.length > 0 ? secGaps.reduce((a,b) => a+b, 0) / secGaps.length : null;
          const secChain = secGaps.length > 0 ? secGaps.filter(g => g < 2).length / secGaps.length : null;
          let secActive = 0;
          if (secDurations.length > 0) secActive = secDurations.reduce((a,b) => a+b, 0) + secGaps.filter(g => g < 30).reduce((a,b) => a+b, 0);
          const secThru = secActive > 0 ? secCompleted / (secActive / 60) : null;
          const secFP = secDone > 0 ? secFirstPass / secDone : null;
          const secRNR = secDone > 0 ? secReviewNotes / secDone : null;
          const secTPR = secDone > 0 ? secTestPlan / secDone : null;

          const secMetrics = {
            tasks_completed: secCompleted, tasks_started: secStarted,
            avg_duration_min: secAvgDur ? Math.round(secAvgDur * 10) / 10 : null,
            median_duration_min: secMedDur ? Math.round(secMedDur * 10) / 10 : null,
            avg_gap_min: secAvgGap ? Math.round(secAvgGap * 10) / 10 : null,
            chain_rate: secChain ? Math.round(secChain * 1000) / 1000 : null,
            throughput: secThru ? Math.round(secThru * 10) / 10 : null,
            first_pass_rate: secFP ? Math.round(secFP * 1000) / 1000 : null,
            bounce_count: secBounce, stall_count: secStall,
            comments_posted: 0, mentions_received: 0, mentions_sent: 0, mention_response_min: null,
            kudos_count: 0, flag_count: 0,
            review_notes_rate: secRNR ? Math.round(secRNR * 1000) / 1000 : null,
            test_plan_rate: secTPR ? Math.round(secTPR * 1000) / 1000 : null,
            active_minutes: Math.round(secActive), versions_completed: 0,
          };

          try {
            await fetch(`http://127.0.0.1:${port}/api/metrics/${agentId}`, {
              method: 'POST', headers,
              body: JSON.stringify({ date: today, metrics: secMetrics, sectionId: secId }),
            });
          } catch (secErr) {
            console.warn(`[Metrics] Failed section upsert for ${agentId}/${secId}:`, secErr.message);
          }
        }
      } catch (e) {
        console.warn(`[Metrics] Failed to upsert for ${agentId}:`, e.message);
      }
    }

    console.log(`[Metrics] Daily computation complete (${today}: ${computedCount} agents)`);
    return computedCount;
  } catch (e) {
    console.error('[Metrics] Computation error:', e.message);
  }
}
// Expose for API route (backfill endpoint)
globalThis.__computeDailyMetrics = computeDailyMetrics;

// --- Health Alert Monitors ---
// Gateway disconnect >2min, Dead-letter backlog >10, LISTEN stale >5min

let _gatewayDownSinceMs = 0; // 0 = not down
let _gatewayAlertFired = false;

async function checkGatewayDisconnect() {
  try {
    const resp = await fetch(`http://127.0.0.1:${port}/api/gateway`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ method: 'status' }),
    });
    const data = await resp.json();
    if (data.result) {
      // Gateway is responding — reset
      if (_gatewayDownSinceMs) {
        console.log('[HealthMonitor] Gateway recovered');
      }
      _gatewayDownSinceMs = 0;
      _gatewayAlertFired = false;
      return;
    }
  } catch {
    // Gateway is down
  }

  const now = Date.now();
  if (!_gatewayDownSinceMs) {
    _gatewayDownSinceMs = now;
  }

  const downMs = now - _gatewayDownSinceMs;
  const TWO_MIN = 2 * 60 * 1000;

  if (downMs >= TWO_MIN && !_gatewayAlertFired) {
    _gatewayAlertFired = true;
    const downMin = Math.round(downMs / 60000);
    try {
      await logIncident({
        type: 'gateway_disconnect',
        agentId: null,
        message: `Gateway disconnected for ${downMin}m`,
        context: { downSince: new Date(_gatewayDownSinceMs).toISOString(), downMinutes: downMin },
      });
    } catch (e) {
      console.error('[HealthMonitor] logIncident gateway_disconnect failed:', e.message);
    }
    try {
      await sendHealthAlert({
        type: 'gateway_disconnect',
        emoji: '🔌',
        title: 'Gateway disconnected',
        context: `Gateway unreachable for ${downMin}m`,
      });
    } catch (e) {
      console.error('[HealthMonitor] sendHealthAlert gateway_disconnect failed:', e.message);
    }
  }
}

async function checkDeadLetterBacklog() {
  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) return;

  try {
    const { default: pg } = await import('pg');
    const client = new pg.Client({ connectionString: dbUrl });
    await client.connect();
    try {
      // #1387 A.3: global dead-letter watchdog — aggregate across all
      // workspaces. Drops the per-workspace filter intentionally so the
      // alert reflects fleet state. (Per-workspace alerts would belong on a
      // workspace-scoped dashboard, not a single global SRE watchdog.)
      const { rows } = await client.query(
        `SELECT count(*)::int AS cnt FROM org_studio_outbox WHERE status = 'dead_letter'`,
      );
      const count = rows[0]?.cnt || 0;
      if (count > 10) {
        try {
          await logIncident({
            type: 'dead_letter_backlog',
            agentId: null,
            message: `Dead-letter backlog: ${count} messages`,
            context: { count },
          });
        } catch (e) {
          console.error('[HealthMonitor] logIncident dead_letter_backlog failed:', e.message);
        }
        try {
          await sendHealthAlert({
            type: 'dead_letter_backlog',
            emoji: '📬',
            title: 'Dead-letter backlog',
            context: `${count} messages stuck in dead-letter queue`,
          });
        } catch (e) {
          console.error('[HealthMonitor] sendHealthAlert dead_letter_backlog failed:', e.message);
        }
      }
    } finally {
      await client.end();
    }
  } catch (e) {
    console.error('[HealthMonitor] Dead-letter check error (non-fatal):', e.message);
  }
}

let _listenDownSinceMs = 0; // 0 = healthy
let _listenAlertFired = false;

async function checkListenStale() {
  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) return;

  let healthy = false;
  try {
    const { default: pg } = await import('pg');
    const client = new pg.Client({ connectionString: dbUrl });
    await client.connect();
    try {
      await client.query('SELECT 1');
      // Also verify LISTEN is possible
      await client.query('LISTEN _health_probe');
      await client.query('UNLISTEN _health_probe');
      healthy = true;
    } finally {
      await client.end();
    }
  } catch {
    // Connection failed — LISTEN is stale
  }

  if (healthy) {
    if (_listenDownSinceMs) {
      console.log('[HealthMonitor] LISTEN connection recovered');
    }
    _listenDownSinceMs = 0;
    _listenAlertFired = false;
    return;
  }

  const now = Date.now();
  if (!_listenDownSinceMs) {
    _listenDownSinceMs = now;
  }

  const downMs = now - _listenDownSinceMs;
  const FIVE_MIN = 5 * 60 * 1000;

  if (downMs >= FIVE_MIN && !_listenAlertFired) {
    _listenAlertFired = true;
    const downMin = Math.round(downMs / 60000);
    try {
      await logIncident({
        type: 'listen_stale',
        agentId: null,
        message: `LISTEN connection stale for ${downMin}m`,
        context: { downSince: new Date(_listenDownSinceMs).toISOString(), downMinutes: downMin },
      });
    } catch (e) {
      console.error('[HealthMonitor] logIncident listen_stale failed:', e.message);
    }
    try {
      await sendHealthAlert({
        type: 'listen_stale',
        emoji: '🔇',
        title: 'LISTEN connection stale',
        context: `Postgres LISTEN unhealthy for ${downMin}m — notifications may be delayed`,
      });
    } catch (e) {
      console.error('[HealthMonitor] sendHealthAlert listen_stale failed:', e.message);
    }
  }
}

// --- Start ---
server.listen(port, async () => {
  console.log(`▲ Org Studio ready on http://localhost:${port}`);
  console.log(`  WebSocket: ws://localhost:${port}/ws`);

  // #1387 A.3 decision #4: warn loudly when the transition flag is set in
  // cloud mode — it disables auth on /api/store GET, which is fine for
  // marketing pages / embeds but dangerous if left on by accident.
  if (process.env.DATABASE_URL && process.env.ALLOW_ANONYMOUS_READS === 'true') {
    console.warn(
      '\u26a0\ufe0f  [auth] ALLOW_ANONYMOUS_READS=true with DATABASE_URL set — /api/store GET is publicly readable. ' +
        'This transition flag should not be on in production. Unset it once your callers carry session cookies or Bearer tokens.',
    );
  }

  // Warm the store cache from Postgres (so first WS clients get fresh data)
  await refreshCachedStore();
  
  // Clean up stale one-shot crons on startup
  await cleanupStaleCrons();

  // --- Ensure schemas EARLY (before any scheduler trigger can fire) ---
  try {
    await ensureHeartbeatSchema();
  } catch (e) {
    console.error(`[HeartbeatWatchdog] Schema creation failed (non-fatal):`, e.message);
  }
  try {
    await ensureOutboxSchema();
  } catch (e) {
    console.error(`[Outbox] Schema creation failed (non-fatal):`, e.message);
  }
  try {
    await ensureSkillInstallsSchema();
  } catch (e) {
    console.error(`[SkillInstalls] Schema creation failed (non-fatal):`, e.message);
  }

  // #861: periodic drift check — active agents with no install-ping in 24h.
  // Runs every hour; cooldown inside runDriftCheck prevents incident spam.
  setInterval(async () => {
    try {
      // #1387 A.2: drift check is system-global watchdog; runs against default-workspace.
      // TODO(#1387 A-followup): iterate all workspaces.
      const store = getCachedStore() || await refreshCachedStore();
      await runDriftCheck({
        tasks: store?.tasks || [],
        teammates: store?.settings?.teammates || store?.teammates || [],
      });
    } catch (e) {
      console.error('[SkillInstalls] Drift check failed:', e?.message || e);
    }
  }, 60 * 60 * 1000).unref?.();

  // Start outbox worker (drains outbox → /api/outbox/drain).
  //
  // Disabled in environments that have no agent runtimes (e.g. cloud Org
  // Studio, which is UI+storage only — runtimes live on the on-prem host).
  // Without this guard, the cloud would race the on-prem worker for the
  // advisory lock, win occasionally, and dead-letter every dispatch with
  // "No runtime found for agent <id>" since its local registry is empty.
  // Set OUTBOX_WORKER_DISABLED=1 on environments without local runtimes.
  if (process.env.OUTBOX_WORKER_DISABLED === '1' || process.env.OUTBOX_WORKER_DISABLED === 'true') {
    console.log('[Outbox] Worker disabled via OUTBOX_WORKER_DISABLED env');
  } else {
    startOutboxWorker();
  }

  // Initialize health alerts (startup log)
  initHealthAlerts();

  // #1643 — host-signal sampler (load/event-loop-delay/mem every 30s, direct
  // pg — deliberately not an internal HTTP self-fetch) + breaker drain tick.
  // The drain refires budget-queued dispatch intents when under budget and
  // runs the throttled anomaly checks. Skipped alongside the outbox worker
  // guard: environments without local runtimes shouldn't refire dispatches.
  startHostSampler();
  if (!(process.env.OUTBOX_WORKER_DISABLED === '1' || process.env.OUTBOX_WORKER_DISABLED === 'true')) {
    const BREAKER_DRAIN_MS = 60 * 1000;
    setInterval(async () => {
      try {
        const res = await fetch(`http://127.0.0.1:${port}/api/scheduler`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${process.env.ORG_STUDIO_API_KEY || ''}`,
          },
          body: JSON.stringify({ action: 'breaker-drain' }),
        });
        if (res.ok) {
          const data = await res.json();
          if (data.drained?.length > 0) {
            console.log(`[DispatchBreaker] drain tick refired: ${data.drained.join(', ')} (${data.remaining} still queued)`);
          }
        }
      } catch { /* non-fatal — next tick retries */ }
    }, BREAKER_DRAIN_MS).unref?.();
  }

  // --- Telegram comms deprecation notice (v0.15) ---
  if (!ENABLE_TELEGRAM_COMMS) {
    console.log('[Telegram] Comms relay DISABLED (v0.15 default). Set ENABLE_TELEGRAM_COMMS=true to re-enable.');
  } else {
    console.log('[Telegram] Comms relay ENABLED (ENABLE_TELEGRAM_COMMS=true)');
  }
  // Telegram deprecation notice removed (KISS cleanup) — was spamming on every restart.

  // Initialize PostgreSQL LISTEN for bidirectional sync
  await initializePostgresListener();

  // Roadmap reconcile: startup (30s delay so Next.js route is warm) +
  // periodic safety-net poll (#982). Auto-advance itself is still fully
  // event-driven via checkAndAutoAdvance in roadmap-sync.ts — this poll
  // is a *drift detector*, not the primary path. Edge cases the event
  // path can miss: partial task moves, concurrent done-moves, version-
  // spanning tasks (silent-drift audit vector #8). The poll catches and
  // logs them and pushes a visible event to the activity feed so a
  // silent correction never happens silently.
  const ROADMAP_RECONCILE_HISTORY_MAX = 50;
  const roadmapReconcileHistory = [];
  let lastRoadmapReconcile = null;
  // Expose to API routes (read-only snapshot copies).
  globalThis.__orgStudioRoadmapReconcile = {
    last: () => (lastRoadmapReconcile ? { ...lastRoadmapReconcile } : null),
    history: () => roadmapReconcileHistory.slice().map((r) => ({ ...r })),
  };

  const safeRoadmapReconcile = async (trigger = 'manual') => {
    const startedAt = Date.now();
    let summary = null;
    let error = null;
    let httpStatus = 0;
    try {
      const port = process.env.PORT || 4501;
      const apiKey = process.env.ORG_STUDIO_API_KEY || '';
      const res = await fetch(`http://127.0.0.1:${port}/api/roadmap/reconcile`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
        },
        body: '{}',
      });
      httpStatus = res.status;
      if (!res.ok) {
        console.warn(`[RoadmapReconcile] API returned HTTP ${res.status}`);
        error = `HTTP ${res.status}`;
      } else {
        const body = await res.json().catch(() => ({}));
        summary = {
          scanned: Number(body.scanned) || 0,
          flipped: Number(body.flipped) || 0,
          shipped: Number(body.shipped) || 0,
          advanced: Number(body.advanced) || 0,
          skippedAdvance: Number(body.skippedAdvance) || 0,
        };
      }
    } catch (e) {
      console.error('[RoadmapReconcile] self-call failed (non-fatal):', e.message);
      error = e?.message || String(e);
    }

    const finishedAt = Date.now();
    const record = {
      trigger,                 // 'startup' | 'cron' | 'manual'
      startedAt,
      finishedAt,
      durationMs: finishedAt - startedAt,
      ok: !error,
      httpStatus,
      error,
      summary,                 // null on error
    };
    lastRoadmapReconcile = record;
    roadmapReconcileHistory.unshift(record);
    if (roadmapReconcileHistory.length > ROADMAP_RECONCILE_HISTORY_MAX) {
      roadmapReconcileHistory.length = ROADMAP_RECONCILE_HISTORY_MAX;
    }

    // #982: push a visible event to the activity feed when reconcile
    // *changed* something — flipped an item or shipped a version.
    // Pure-zero ticks are silent (we don't want 96 noop events/day).
    if (summary && (summary.flipped > 0 || summary.shipped > 0 || summary.advanced > 0)) {
      try {
        const parts = [];
        if (summary.flipped > 0) parts.push(`${summary.flipped} item${summary.flipped === 1 ? '' : 's'} flipped`);
        if (summary.shipped > 0) parts.push(`${summary.shipped} version${summary.shipped === 1 ? '' : 's'} shipped`);
        if (summary.advanced > 0) parts.push(`${summary.advanced} project${summary.advanced === 1 ? '' : 's'} advanced`);
        addActivityEvent({
          type: 'roadmap-reconcile',
          emoji: '🧹',
          agent: 'system',
          project: '',
          message: `Roadmap reconcile (${trigger}): ${parts.join(', ')}`,
          detail: summary,
        });
      } catch (e) {
        console.error('[RoadmapReconcile] activity feed emit failed (non-fatal):', e.message);
      }
    }

    return record;
  };

  setTimeout(async () => {
    safeRoadmapReconcile('startup');
    console.log('[RoadmapReconcile] Startup reconcile fired (15-min recurring poll enabled, #982)');

    // #1187: post-reconcile auto-deactivate REMOVED. Project state is
    // user-controlled only — the system never flips active→inactive.
    // If a project's currentVersion is shipped and there's no next approved
    // version, the project simply stays put until the user approves more
    // work or explicitly deactivates from the UI.
  }, 30_000);

  // #982: Periodic reconcile every 15 min. Not a primary path — a drift
  // detector. If it flips/ships/advances anything, the activity-feed
  // emission above makes the silent correction visible to humans.
  const ROADMAP_RECONCILE_INTERVAL_MS = 15 * 60_000;
  setInterval(() => safeRoadmapReconcile('cron'), ROADMAP_RECONCILE_INTERVAL_MS);
  console.log('[RoadmapReconcile] Periodic reconcile cron started (15min tick, #982)');

  // #1642: Daily schedule-drift reconcile — query-class only (one GET; the
  // endpoint reads store + gateway cron.list read-only and persists findings).
  // Orphan/zombie findings render on /health; #1643 will alert on them.
  const SCHEDULE_DRIFT_INTERVAL_MS = 24 * 60 * 60_000;
  const safeScheduleDriftReconcile = async () => {
    try {
      const port = process.env.PORT || 4501;
      const apiKey = process.env.ORG_STUDIO_API_KEY || '';
      const res = await fetch(`http://127.0.0.1:${port}/api/observability/schedules`, {
        headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
      });
      if (!res.ok) {
        console.warn(`[ScheduleDrift #1642] reconcile GET returned HTTP ${res.status}`);
        return;
      }
      const body = await res.json().catch(() => ({}));
      const n = Array.isArray(body.findings) ? body.findings.length : 0;
      const mc = Number(body.modelCallScheduleCount) || 0;
      // Summarize-once discipline: one line per daily tick, only elevated when drift exists.
      if (n > 0 || mc > 0) {
        console.warn(`[ScheduleDrift #1642] findings=${n} modelCallSchedules=${mc} — see /health Schedules panel`);
      } else {
        console.log(`[ScheduleDrift #1642] clean (entries=${Array.isArray(body.entries) ? body.entries.length : '?'}, drift=0)`);
      }
    } catch (e) {
      console.warn('[ScheduleDrift #1642] reconcile failed (non-fatal):', e.message);
    }
  };
  setTimeout(safeScheduleDriftReconcile, 45_000); // startup pass (after routes warm)
  setInterval(safeScheduleDriftReconcile, SCHEDULE_DRIFT_INTERVAL_MS);
  console.log('[ScheduleDrift] Daily schedule-drift reconcile started (24h tick, #1642)');

  // Daily metrics computation — runs at startup (15s delay) + daily at midnight
  setTimeout(async () => {
    await computeDailyMetrics(); // today
    // Backfill yesterday if not yet computed
    const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString().split('T')[0];
    await computeDailyMetrics(yesterday);
  }, 15000);
  // Schedule daily at midnight
  const _metricsNow = new Date();
  const _metricsMidnight = new Date(_metricsNow);
  _metricsMidnight.setHours(24, 0, 0, 0);
  const _msUntilMidnight = _metricsMidnight.getTime() - _metricsNow.getTime();
  setTimeout(() => {
    computeDailyMetrics();
    setInterval(computeDailyMetrics, 24 * 60 * 60 * 1000);
  }, _msUntilMidnight);
  console.log(`[Metrics] Scheduled: startup in 15s, then daily at midnight (${Math.round(_msUntilMidnight / 60000)}m from now)`);

  // Start watchdog after 60s, then every 30 minutes
  setTimeout(async () => {
    // Heartbeat schema already ensured above — no need to redo

    const safeWatchdog = async () => {
      try {
        await stuckTaskWatchdog();
      } catch (e) {
        console.error(`[Watchdog] Unhandled error (non-fatal):`, e.message);
      }
    };
    safeWatchdog();
    setInterval(safeWatchdog, WATCHDOG_INTERVAL_MS);
    console.log(`[Watchdog] Started (interval: 30m, task threshold: 30m, vision cycle timeout: 15m)`);

    // Start heartbeat loop watchdog (faster — every 60s)
    startLoopWatchdog();

    // --- Health alert monitors ---
    // Gateway disconnect check (every 5 min — KISS cleanup: was 30s)
    const safeCheckGateway = async () => {
      try { await checkGatewayDisconnect(); } catch (e) {
        console.error('[HealthMonitor] Gateway check error (non-fatal):', e.message);
      }
    };
    setInterval(safeCheckGateway, 5 * 60_000);
    console.log('[HealthMonitor] Gateway disconnect monitor started (5 min tick)');

    // Dead-letter backlog check (every 5min)
    const safeCheckDeadLetter = async () => {
      try { await checkDeadLetterBacklog(); } catch (e) {
        console.error('[HealthMonitor] Dead-letter check error (non-fatal):', e.message);
      }
    };
    setTimeout(() => {
      safeCheckDeadLetter();
      setInterval(safeCheckDeadLetter, 5 * 60_000);
      console.log('[HealthMonitor] Dead-letter backlog monitor started (5min tick)');
    }, 15_000);

    // #1513 — Hourly prune of the Postgres-backed notification dedup +
    // audit tables. Dedup rows >7d gone, audit rows >30d gone. Inlined here
    // (vs. importing src/lib/notification-dedup.ts from this .mjs server)
    // because server.mjs is plain ESM and the TS lib is Next-compiled.
    const safeNotifyPrune = async () => {
      const dbUrl = process.env.DATABASE_URL;
      if (!dbUrl) return;
      try {
        const { default: pg } = await import('pg');
        const client = new pg.Client({ connectionString: dbUrl });
        await client.connect();
        try {
          const d = await client.query(
            `DELETE FROM org_studio_notification_dedup
              WHERE (claim_state = 'delivered' AND delivered_at < NOW() - INTERVAL '7 days')
                 OR (claim_state = 'pending' AND claim_expires_at < NOW() - INTERVAL '1 day')`
          );
          const a = await client.query(
            `DELETE FROM org_studio_notification_audit WHERE occurred_at < NOW() - INTERVAL '30 days'`
          );
          if ((d.rowCount || 0) + (a.rowCount || 0) > 0) {
            console.log(`[notify-prune] dedup=${d.rowCount || 0} audit=${a.rowCount || 0} rows pruned`);
          }
        } finally {
          await client.end();
        }
      } catch (e) {
        // Tables may not exist yet (first start before any notify happens).
        // notification-dedup.ts ensures schema lazily; this is a best-effort
        // janitor and a missing table just means there's nothing to prune.
        if (!/relation .* does not exist/.test(e?.message || '')) {
          console.warn('[notify-prune] error (non-fatal):', e?.message || e);
        }
      }
    };
    setTimeout(() => {
      safeNotifyPrune();
      setInterval(safeNotifyPrune, 60 * 60_000);
      console.log('[notify-prune] Hourly dedup+audit prune started');
    }, 30_000);

    // LISTEN stale check (every 5 min — KISS cleanup: was 60s)
    const safeCheckListen = async () => {
      try { await checkListenStale(); } catch (e) {
        console.error('[HealthMonitor] LISTEN check error (non-fatal):', e.message);
      }
    };
    setInterval(safeCheckListen, 5 * 60_000);
    console.log('[HealthMonitor] LISTEN stale monitor started (5 min tick)');

    // Stuck-task detector merged into watchdog (KISS cleanup — no separate interval)
    setTimeout(() => {

      // Project integrity audit (#697) — startup only (KISS cleanup: 60s poll removed)
      const safeProjectIntegrityAudit = async () => {
        try {
          await projectIntegrityAudit();
        } catch (e) {
          console.error('[ProjectIntegrityAudit] Unhandled error (non-fatal):', e.message);
        }
      };
      safeProjectIntegrityAudit();
      console.log('[ProjectIntegrityAudit] Startup audit fired (no recurring poll)');
    }, 30_000);
  }, 60_000);
});
