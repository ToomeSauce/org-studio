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
import { ensureHeartbeatSchema, startLoopWatchdog, logIncident } from './lib/heartbeats.mjs';
import { ensureOutboxSchema, startOutboxWorker } from './lib/outbox.mjs';
import { initHealthAlerts, sendHealthAlert, isHealthAlertsEnabled } from './lib/health-alerts.mjs';

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
const STORE_PATH = join(DATA_DIR, 'store.json');
const STATUS_PATH = join(DATA_DIR, 'activity-status.json');

function safeRead(path) {
  try {
    if (!existsSync(path)) return null;
    return JSON.parse(readFileSync(path, 'utf-8'));
  } catch { return null; }
}

// --- Broadcast ---
function broadcast(type, data) {
  const msg = JSON.stringify({ type, data, ts: Date.now() });
  for (const client of wss.clients) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(msg);
    }
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
        // Postgres is source of truth — fetch from API, not stale file
        await refreshCachedStore();
        if (cachedStore) broadcast('store', cachedStore);
      } else {
        const data = safeRead(path);
        if (data) {
          if (type === 'store') cachedStore = data;
          broadcast(type, data);
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
  lines.push('   - `self` (default): self-test, write results in reviewNotes, move to review/done.');
  lines.push('   - `qa`: self-test first, write a test plan, move to QA column.');
  lines.push('4. When complete: update status + always include `reviewNotes`. Clear activity status.');
  lines.push('5. If more backlog tasks remain, continue with the next one.');
  lines.push('6. If you run out of time mid-task, leave it where it is.');
  lines.push('');
  lines.push('**Planning column:** You ARE encouraged to pull from planning — scope the task (acceptance criteria, constraints, context), then move to backlog when ready for execution. If the task lacks context to scope, post a comment asking instead of guessing.');
  lines.push('');
  lines.push('**Task lifecycle:** planning → backlog → in-progress → [qa] → review → done');
  lines.push('Always include `reviewNotes` when moving to review/done.');
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
        const storeRes = await fetch(`http://127.0.0.1:${port}/api/store`);
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
          const storeRes = await fetch(`http://127.0.0.1:${port}/api/store`);
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
async function initializePostgresListener() {
  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) {
    console.log('[LISTEN] DATABASE_URL not set — skipping PostgreSQL listener');
    return;
  }

  try {
    const pg = await import('pg');
    const Client = pg.default?.Client || pg.Client;
    const listener = new Client({ connectionString: dbUrl });
    
    // Error handler — reconnect on disconnect
    listener.on('error', (err) => {
      console.error('[LISTEN] Connection error:', err.message);
      setTimeout(() => initializePostgresListener(), 5000);
    });

    listener.on('end', () => {
      console.log('[LISTEN] Connection closed, will reconnect in 5s');
      setTimeout(() => initializePostgresListener(), 5000);
    });

    // Listen for store update events
    listener.on('notification', async (msg) => {
      try {
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

          // Process @mentions from comments added via remote (staging) UI
          if (changeEvent.type === 'comment_added' && changeEvent.taskId) {
            console.log(`[LISTEN] comment_added taskId=${changeEvent.taskId} commentId=${changeEvent.commentId || 'none'}`);
            try {
              const freshStore = await refreshCachedStore();
              if (freshStore) {
                const task = freshStore.tasks?.find(t => t.id === changeEvent.taskId);
                // Look up by commentId if available, fall back to last comment
                let comment;
                if (changeEvent.commentId && task?.comments) {
                  comment = task.comments.find(c => c.id === changeEvent.commentId);
                }
                if (!comment) {
                  comment = task?.comments?.[task.comments.length - 1];
                }
                if (comment?.content && comment.mentions?.length > 0) {
                  const teammates = freshStore.settings?.teammates || [];
                  for (const mentionName of comment.mentions) {
                    const tm = teammates.find(t =>
                      t.name?.toLowerCase() === mentionName.toLowerCase() ||
                      t.agentId?.toLowerCase() === mentionName.toLowerCase()
                    );
                    if (tm?.agentId && !tm.isHuman) {
                      const msg = `\ud83d\udcac **${comment.author}** mentioned you on task: **${task.title}**\n\n> ${comment.content}\n\nTask ID: ${task.id}\n\n**Reply on the task, not in chat.** Call \`addComment\` against this task id so ${comment.author} sees your response on the ticket. Include @${comment.author} in your reply to notify them.`;
                      try {
                        // Route based on agent type: Hermes → /v1/runs, OpenClaw → rpc
                        if (tm.agentId.startsWith('hermes-')) {
                          // Resolve Hermes profile URL from filesystem
                          const profileName = tm.agentId.replace('hermes-', '');
                          let hermesUrl = process.env.HERMES_URL || 'http://127.0.0.1:8642';
                          try {
                            const hermesHome = join(process.env.HOME || '', '.hermes');
                            const cfgPath = profileName === 'default' 
                              ? join(hermesHome, 'config.yaml')
                              : join(hermesHome, 'profiles', profileName, 'config.yaml');
                            if (existsSync(cfgPath)) {
                              const cfg = readFileSync(cfgPath, 'utf-8');
                              const portMatch = cfg.match(/port:\s*(\d+)/);
                              if (portMatch) hermesUrl = `http://127.0.0.1:${portMatch[1]}`;
                            }
                          } catch {}
                          if (hermesUrl) {
                            const runRes = await fetch(`${hermesUrl}/v1/runs`, {
                              method: 'POST',
                              headers: { 'Content-Type': 'application/json' },
                              body: JSON.stringify({ input: msg, session_id: `mention-${task.id}` }),
                            });
                            if (runRes.ok) {
                              const runData = await runRes.json();
                              console.log(`[LISTEN] Mention routed to Hermes ${mentionName}: run ${runData.run_id}`);
                            } else {
                              console.warn(`[LISTEN] Hermes mention dispatch failed: ${runRes.status}`);
                            }
                          }
                        } else {
                          // OpenClaw agent — inject mention text directly via chat.send so the
                          // mention content actually lands in the agent's session, not just
                          // a generic scheduler wake. (The scheduler trigger path dispatches
                          // task-work prompts that ignore comment content, so mentions on
                          // paused/blocked tasks were silently dropped before this fix.)
                          let delivered = false;
                          try {
                            const chatRes = await fetch(`http://127.0.0.1:${port}/api/gateway`, {
                              method: 'POST',
                              headers: { 'Content-Type': 'application/json' },
                              body: JSON.stringify({
                                method: 'chat.send',
                                params: {
                                  sessionKey: `agent:${tm.agentId}:main`,
                                  message: msg,
                                  idempotencyKey: `mention-${comment.id}-${tm.agentId}`,
                                },
                              }),
                            });
                            if (chatRes.ok) {
                              delivered = true;
                              console.log(`[LISTEN] Mention delivered via chat.send: recipient=${mentionName} agentId=${tm.agentId} commentId=${comment.id}`);
                            } else {
                              console.warn(`[LISTEN] chat.send failed for ${mentionName}: HTTP ${chatRes.status}`);
                            }
                          } catch (chatErr) {
                            console.warn(`[LISTEN] chat.send threw for ${mentionName}:`, chatErr.message);
                          }

                          // Also nudge the scheduler — harmless if the session is already
                          // awake from chat.send, and ensures a wake even if chat.send was
                          // best-effort-lost.
                          const apiKey = process.env.ORG_STUDIO_API_KEY || '';
                          const triggerHeaders = { 'Content-Type': 'application/json' };
                          if (apiKey) triggerHeaders['Authorization'] = `Bearer ${apiKey}`;
                          try {
                            const triggerRes = await fetch(`http://127.0.0.1:${port}/api/scheduler`, {
                              method: 'POST',
                              headers: triggerHeaders,
                              body: JSON.stringify({ action: 'trigger', agentId: tm.agentId }),
                            });
                            if (!triggerRes.ok && !delivered) {
                              console.warn(`[LISTEN] Mention trigger failed for ${mentionName}: HTTP ${triggerRes.status}`);
                            }
                          } catch { /* best-effort */ }
                        }
                      } catch (e) {
                        console.warn(`[LISTEN] Mention dispatch failed for ${mentionName}:`, e.message);
                      }
                    }
                  }
                }
              }
            } catch (e) {
              console.warn('[LISTEN] Mention processing error:', e.message);
            }
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
              const freshStore = await refreshCachedStore();
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
          try {
            const freshStore = await refreshCachedStore();
            if (freshStore) {
              broadcast('store', freshStore);
              
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
    console.log('[LISTEN] Connected to PostgreSQL, listening for org_studio_change events');
    
    // Subscribe to notifications
    await listener.query('LISTEN org_studio_change');
  } catch (e) {
    console.warn('[LISTEN] Failed to initialize PostgreSQL listener:', e.message);
    // Not fatal — file system watchers are still working
    setTimeout(() => initializePostgresListener(), 5000);
  }
}

// Also sync ORG.md when store changes
initWorkspaceBase();

if (WORKSPACE_BASE && existsSync(STORE_PATH)) {
  let orgTimer = null;
  watch(STORE_PATH, () => {
    if (orgTimer) clearTimeout(orgTimer);
    orgTimer = setTimeout(() => {
      const data = safeRead(STORE_PATH);
      if (data) syncOrgFiles(data);
    }, 500);
  });
  // Initial sync on startup
  const initialStore = safeRead(STORE_PATH);
  if (initialStore) syncOrgFiles(initialStore);

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
      const store = cachedStore || await refreshCachedStore();
      if (!store?.tasks?.length) return;
      const now = Date.now();
      const RECENT_MS = 30 * 60 * 1000; // 30 minutes
      for (const task of store.tasks) {
        if (task.isArchived) continue;
        const lastEntry = (task.statusHistory || []).at(-1);
        if (!lastEntry) continue;
        if (now - lastEntry.timestamp > RECENT_MS) continue;
        if (lastEntry.status !== task.status) {
          console.warn(
            `[Reconcile] Task ${task.id} (#${task.ticketNumber || '?'}): ` +
            `statusHistory says '${lastEntry.status}' but current status is '${task.status}'. ` +
            `Possible lost write. Last transition at ${new Date(lastEntry.timestamp).toISOString()}`
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
let cachedStore = null;
let cachedGatewayStatus = null;
let cachedAgents = null;
let pollFailureCount = 0;
let pollTimeoutHandle = null;

/** Fetch store from the API (Postgres-backed) and cache it. Returns the store or null. */
async function refreshCachedStore() {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/store`);
    if (res.ok) {
      cachedStore = await res.json();
      return cachedStore;
    }
  } catch (e) {
    // Fallback to local file
    cachedStore = safeRead(STORE_PATH);
  }
  return cachedStore;
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
wss.on('connection', (ws) => {
  // Reset failure counter and poll immediately when a new client connects
  // (user opened dashboard, worth retrying)
  pollFailureCount = 0;
  scheduleNextPoll(100);

  // Send all cached state immediately
  const store = cachedStore || safeRead(STORE_PATH);
  if (store) ws.send(JSON.stringify({ type: 'store', data: store, ts: Date.now() }));

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
const WATCHDOG_STUCK_THRESHOLD_MS = 30 * 60 * 1000; // 30 minutes idle
const VISION_CYCLE_TIMEOUT_MS = 15 * 60 * 1000; // 15 minutes — vision cycles should complete within this

// --- Stuck Task Detector (incident logging, separate from re-trigger watchdog) ---
const STUCK_TASK_DETECT_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
const STUCK_TASK_THRESHOLD_MIN = parseInt(process.env.STUCK_TASK_THRESHOLD_MIN || '30', 10);
const STUCK_TASK_THRESHOLD_MS_DETECT = STUCK_TASK_THRESHOLD_MIN * 60 * 1000;
const _stuckTaskLoggedSet = new Set(); // task ids already emitted this uptime

async function stuckTaskDetector() {
  const store = cachedStore || safeRead(STORE_PATH);
  if (!store?.tasks?.length) return;

  const now = Date.now();
  const projects = store.projects || [];
  const currentStuckIds = new Set();

  for (const task of store.tasks) {
    if (task.isArchived || task.status !== 'in-progress') continue;

    // Compute time in-progress from statusHistory or fallback
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

    if (elapsed > STUCK_TASK_THRESHOLD_MS_DETECT) {
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
          console.error('[StuckTaskDetector] logIncident failed (non-fatal):', e.message);
        }
        _stuckTaskLoggedSet.add(task.id);
      }
    }
  }

  // Remove recovered tasks from the logged set so future stalls re-fire
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
  const store = cachedStore || safeRead(STORE_PATH);
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
  // Use cachedStore (Postgres-backed) if available, fall back to file
  const store = cachedStore || safeRead(STORE_PATH);
  if (!store?.tasks?.length) return;

  const now = Date.now();
  const teammates = store.settings?.teammates || [];
  const triggered = new Set();

  for (const task of store.tasks) {
    if (task.isArchived || task.loopPausedAt) continue;
    if (task.status !== 'in-progress') continue;

    const lastActivity = task.lastActivityAt
      || (task.statusHistory?.length ? task.statusHistory[task.statusHistory.length - 1]?.timestamp : null)
      || task.createdAt || 0;

    if (now - lastActivity < WATCHDOG_STUCK_THRESHOLD_MS) continue;

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
        const comments = task.comments || [];
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
        const taskComments = (task.comments || []).filter(c =>
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
      const { rows } = await client.query(
        `SELECT count(*)::int AS cnt FROM org_studio_outbox WHERE status = 'dead_letter' AND workspace_id = $1`,
        ['default-workspace'] // TODO(v0.17-multi-workspace): aggregate across all workspaces or scope per-request
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

  // Start outbox worker (drains outbox → /api/outbox/drain)
  startOutboxWorker();

  // Initialize health alerts (startup log)
  initHealthAlerts();

  // --- Telegram comms deprecation notice (v0.15) ---
  if (!ENABLE_TELEGRAM_COMMS) {
    console.log('[Telegram] Comms relay DISABLED (v0.15 default). Set ENABLE_TELEGRAM_COMMS=true to re-enable.');
  } else {
    console.log('[Telegram] Comms relay ENABLED (ENABLE_TELEGRAM_COMMS=true)');
  }
  // Send deprecation notice to Telegram once on startup (best-effort)
  if (TG_BOT_TOKEN && TG_CHAT_ID) {
    const deprecationSent = globalThis.__tgDeprecationSent;
    if (!deprecationSent) {
      globalThis.__tgDeprecationSent = true;
      const deprecationMsg = [
        '📢 *Org Studio v0.15 — Telegram Transition Notice*',
        '',
        "We're transitioning to in-app notifications. Task updates and mentions will no longer be sent to Telegram in v0.16.",
        '',
        'Please enable in-app push notifications in Settings → Notifications.',
        '',
        'Health alerts will continue via this channel for now.',
        '',
        '→ Settings: ' + (process.env.ORG_STUDIO_PUBLIC_URL || 'http://localhost:4501') + '/settings',
      ].join('\n');
      fetch(`https://api.telegram.org/bot${TG_BOT_TOKEN}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: TG_CHAT_ID, text: deprecationMsg, parse_mode: 'Markdown', disable_web_page_preview: true }),
      }).then(() => console.log('[Telegram] Deprecation notice sent'))
        .catch(err => console.error('[Telegram] Deprecation notice failed:', err.message));
    }
  }

  // Initialize PostgreSQL LISTEN for bidirectional sync
  await initializePostgresListener();

  // Roadmap reconcile: startup (30s delay so Next.js route is warm) + every 10 minutes.
  // Heals any item-done drift caused by missed sync calls or past races.
  const safeRoadmapReconcile = async () => {
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
      if (!res.ok) {
        console.warn(`[RoadmapReconcile] API returned HTTP ${res.status}`);
      }
    } catch (e) {
      console.error('[RoadmapReconcile] self-call failed (non-fatal):', e.message);
    }
  };
  setTimeout(() => {
    safeRoadmapReconcile();
    setInterval(safeRoadmapReconcile, 10 * 60_000);
    console.log('[RoadmapReconcile] Scheduled: startup + every 10 min');
  }, 30_000);

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
    // Gateway disconnect check (every 30s)
    const safeCheckGateway = async () => {
      try { await checkGatewayDisconnect(); } catch (e) {
        console.error('[HealthMonitor] Gateway check error (non-fatal):', e.message);
      }
    };
    setInterval(safeCheckGateway, 30_000);
    console.log('[HealthMonitor] Gateway disconnect monitor started (30s tick)');

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

    // LISTEN stale check (every 60s)
    const safeCheckListen = async () => {
      try { await checkListenStale(); } catch (e) {
        console.error('[HealthMonitor] LISTEN check error (non-fatal):', e.message);
      }
    };
    setInterval(safeCheckListen, 60_000);
    console.log('[HealthMonitor] LISTEN stale monitor started (60s tick)');

    // Start stuck-task detector (incident logging, no auto-recovery)
    const safeStuckTaskDetector = async () => {
      try {
        await stuckTaskDetector();
      } catch (e) {
        console.error('[StuckTaskDetector] Unhandled error (non-fatal):', e.message);
      }
    };
    // First tick after 30s delay (let heartbeats / store warm up)
    setTimeout(() => {
      safeStuckTaskDetector();
      setInterval(safeStuckTaskDetector, STUCK_TASK_DETECT_INTERVAL_MS);
      console.log(`[StuckTaskDetector] Started (interval: 5min, threshold: ${STUCK_TASK_THRESHOLD_MIN}min)`);

      // Project integrity audit (#697) — 60s interval
      const safeProjectIntegrityAudit = async () => {
        try {
          await projectIntegrityAudit();
        } catch (e) {
          console.error('[ProjectIntegrityAudit] Unhandled error (non-fatal):', e.message);
        }
      };
      safeProjectIntegrityAudit();
      setInterval(safeProjectIntegrityAudit, PROJECT_INTEGRITY_INTERVAL_MS);
      console.log('[ProjectIntegrityAudit] Started (interval: 60s, dedup: 60min)');
    }, 30_000);
  }, 60_000);
});
