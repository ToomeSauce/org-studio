import { createServer } from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import { watch, readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import next from 'next';
import { getRuntimeRegistry } from './lib/runtimes.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const port = parseInt(process.env.PORT || '4501');
const dev = false;

// --- Telegram notification helper ---
const TG_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const TG_CHAT_ID = process.env.TELEGRAM_CHAT_ID || process.env.NOTIFY_CHAT_ID || '';

function sendTelegramNotification(message) {
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
  if (req.url === '/api/activity-feed' && req.method === 'GET') {
    const feed = globalThis.__orgStudioActivityFeed?.get() || [];
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ events: feed }));
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
  lines.push('For the full API reference, see docs/agent-api.md in your workspace.');
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

  // Work loop — so agents know the standard workflow
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
  lines.push('**Task lifecycle:** backlog → in-progress → QA → review → done');
  lines.push('Always include `reviewNotes` when moving to review/done.');
  lines.push('Always include `version` when creating tasks for a sprint.');
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
  // Default agent id is 'main' but workspace is the bare 'workspace' dir
  if (agentId === 'main') {
    const bare = join(WORKSPACE_BASE, 'workspace');
    if (existsSync(bare)) return bare;
  }
  // Standard path: workspace-{agentId}
  const suffixed = join(WORKSPACE_BASE, `workspace-${agentId}`);
  if (existsSync(suffixed)) return suffixed;
  return null;
}

function syncOrgFiles(store) {
  if (!WORKSPACE_BASE) return; // Skip if WORKSPACE_BASE is null
  
  const teammates = store?.settings?.teammates || [];
  const agents = teammates.filter(t => !t.isHuman && t.agentId);
  let synced = 0;

  // Copy docs/guide.md and docs/agent-api.md to each workspace if they exist
  const guideSrc = join(process.cwd(), 'docs', 'guide.md');
  const guideContent = existsSync(guideSrc) ? readFileSync(guideSrc, 'utf-8') : null;
  
  const apiDocSrc = join(process.cwd(), 'docs', 'agent-api.md');
  const apiDocContent = existsSync(apiDocSrc) ? readFileSync(apiDocSrc, 'utf-8') : null;

  for (const agent of agents) {
    const workspaceDir = resolveWorkspaceDir(agent.agentId);
    if (!workspaceDir) continue;
    const orgPath = join(workspaceDir, 'ORG.md');
    const content = generateOrgMd(store, agent.agentId);
    try {
      writeFileSync(orgPath, content);
      // Sync docs/guide.md and docs/agent-api.md alongside ORG.md
      if (guideContent || apiDocContent) {
        const docsDir = join(workspaceDir, 'docs');
        mkdirSync(docsDir, { recursive: true });
        if (guideContent) {
          writeFileSync(join(docsDir, 'guide.md'), guideContent);
        }
        if (apiDocContent) {
          writeFileSync(join(docsDir, 'agent-api.md'), apiDocContent);
        }
      }
      synced++;
    } catch {}
  }
  if (synced > 0) console.log(`  ORG.md + docs/guide.md + docs/agent-api.md synced to ${synced} agent workspace(s)`);

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
          console.log(`[LISTEN] Received ${changeEvent.type} event:`, changeEvent.action || '');
          
          // --- Intent Router ---
          // Process intents BEFORE refreshing the store cache, so we can act on the intent
          // and update state in the same cycle
          await processIntent(changeEvent);

          // Read fresh store from Postgres via internal API (not local file)
          try {
            const freshStore = await refreshCachedStore();
            if (freshStore) {
              broadcast('store', freshStore);
              
              // Also sync ORG.md if store changed
              if (changeEvent.type === 'store_update' && WORKSPACE_BASE) {
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

/**
 * Check for sprint completion and trigger auto-advance if enabled.
 * For each project with autoAdvance enabled:
 * 1. Get the current version
 * 2. Find all tasks for that version
 * 3. If all are done, trigger the next version
 */
async function sprintCompletionCheck() {
  const store = cachedStore || safeRead(STORE_PATH);
  if (!store?.projects?.length || !store?.tasks?.length) return;

  const apiKey = process.env.ORG_STUDIO_API_KEY;
  const headers = { 'Content-Type': 'application/json' };
  if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;

  for (const project of store.projects) {
    const autonomy = project.autonomy;
    
    // Skip if approvedThrough is not set
    if (!autonomy?.approvedThrough) continue;

    // Guard: no archived projects
    if (project.archived || project.isArchived) continue;

    const currentVersion = project.currentVersion;
    if (!currentVersion) continue;

    // Find all tasks for this version
    const versionTasks = store.tasks.filter(
      t => t.projectId === project.id && t.version === currentVersion && !t.isArchived
    );

    // Guard: only advance if there are actually tasks
    if (!versionTasks.length) continue;

    // Check if all tasks are done
    const allDone = versionTasks.every(t => t.status === 'done');
    if (!allDone) continue;

    // Get roadmap to find next version
    try {
      const roadmapRes = await fetch(`http://127.0.0.1:${port}/api/roadmap/${project.id}`);
      if (!roadmapRes.ok) continue;

      const roadmapData = await roadmapRes.json();
      const versions = roadmapData.versions || [];

      // Find the current version in roadmap, then get the next one
      const currentIdx = versions.findIndex(v => v.version === currentVersion);
      const nextVersion = versions[currentIdx + 1];

      if (!nextVersion) {
        // Roadmap exhausted — mark current as shipped, clear currentVersion
        await fetch(`http://127.0.0.1:${port}/api/roadmap/${project.id}`, {
          method: 'POST',
          headers,
          body: JSON.stringify({
            action: 'upsert',
            version: currentVersion,
            title: versions[currentIdx]?.title || currentVersion,
            status: 'shipped',
            items: versions[currentIdx]?.items || [],
          }),
        });
        console.log(`[Auto-Advance] Roadmap exhausted for ${project.name} — all versions shipped`);

        // Notify Basil
        sendTelegramNotification(`✅ *${project.name} — all versions shipped!* Roadmap complete.`);
        
        // Emit to activity feed
        addActivityEvent({
          type: 'version-complete',
          emoji: '✅',
          agent: project.devOwner || 'Unknown',
          project: project.name,
          message: `${project.name} — all versions shipped! Roadmap complete.`,
        });
        continue;
      }

      // Check if next version is within approval horizon
      const approvedThrough = autonomy.approvedThrough;
      const nextNum = parseFloat(nextVersion.version);
      const approvedNum = parseFloat(approvedThrough);
      if (nextNum > approvedNum) {
        console.log(`[Auto-Advance] ${project.name} v${nextVersion.version} not approved (approved through ${approvedThrough})`);
        // Mark current as shipped but don't advance
        await fetch(`http://127.0.0.1:${port}/api/roadmap/${project.id}`, {
          method: 'POST',
          headers,
          body: JSON.stringify({
            action: 'upsert',
            version: currentVersion,
            title: versions[currentIdx]?.title || currentVersion,
            status: 'shipped',
            items: versions[currentIdx]?.items || [],
          }),
        });
        continue;
      }

      // Mark current version as shipped
      await fetch(`http://127.0.0.1:${port}/api/roadmap/${project.id}`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          action: 'upsert',
          version: currentVersion,
          title: versions[currentIdx]?.title || currentVersion,
          status: 'shipped',
          items: versions[currentIdx]?.items || [],
        }),
      });

      // Set next version as current
      await fetch(`http://127.0.0.1:${port}/api/roadmap/${project.id}`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          action: 'upsert',
          version: nextVersion.version,
          title: nextVersion.title,
          status: 'current',
          items: nextVersion.items,
        }),
      });

      // Create tasks from next version items (with title-level dedup)
      const existingTitles = new Set(
        store.tasks
          .filter(t => t.projectId === project.id && !t.isArchived)
          .map(t => t.title?.toLowerCase().trim())
          .filter(Boolean)
      );
      let tasksCreated = 0;
      const devOwner = project.devOwner || project.owner || '';
      for (const item of (nextVersion.items || [])) {
        const normalizedTitle = item.title?.toLowerCase().trim();
        if (normalizedTitle && existingTitles.has(normalizedTitle)) continue;
        await fetch(`http://127.0.0.1:${port}/api/store`, {
          method: 'POST',
          headers,
          body: JSON.stringify({
            action: 'addTask',
            task: {
              title: item.title,
              projectId: project.id,
              status: 'backlog',
              assignee: devOwner,
              priority: 'medium',
              version: nextVersion.version,
            },
          }),
        });
        existingTitles.add(normalizedTitle);
        tasksCreated++;
      }

      // Update project currentVersion
      await fetch(`http://127.0.0.1:${port}/api/store`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          action: 'updateProject',
          id: project.id,
          updates: {
            currentVersion: nextVersion.version,
          },
        }),
      });

      console.log(`[Auto-Advance] ${project.name} v${currentVersion} complete → v${nextVersion.version} started (${tasksCreated} tasks created)`);

      // Notify Basil about version completion + auto-advance
      sendTelegramNotification(`🏁 *${project.name} v${currentVersion} complete!*\n→ Auto-launched *v${nextVersion.version}* (${nextVersion.title}) with ${tasksCreated} task(s)`);
      addActivityEvent({
        type: 'version-complete',
        emoji: '🏁',
        agent: project.devOwner || 'Unknown',
        project: project.name,
        message: `${project.name} v${currentVersion} complete → v${nextVersion.version} started (${tasksCreated} tasks)`,
      });
      
      // Emit to activity feed
      addActivityEvent({
        type: 'version-complete',
        emoji: '🏁',
        agent: project.devOwner || 'Unknown',
        project: project.name,
        message: `${project.name} v${currentVersion} complete → v${nextVersion.version} started (${tasksCreated} tasks)`,
      });
    } catch (e) {
      console.error(`[Auto-Advance] Failed for ${project.name}:`, e.message);
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

// --- Start ---
server.listen(port, async () => {
  console.log(`▲ Org Studio ready on http://localhost:${port}`);
  console.log(`  WebSocket: ws://localhost:${port}/ws`);

  // Warm the store cache from Postgres (so first WS clients get fresh data)
  await refreshCachedStore();
  
  // Clean up stale one-shot crons on startup
  await cleanupStaleCrons();

  // Initialize PostgreSQL LISTEN for bidirectional sync
  await initializePostgresListener();

  // Start watchdog after 60s, then every 30 minutes
  setTimeout(() => {
    const safeWatchdog = async () => {
      try {
        await stuckTaskWatchdog();
        await sprintCompletionCheck();
      } catch (e) {
        console.error(`[Watchdog] Unhandled error (non-fatal):`, e.message);
      }
    };
    safeWatchdog();
    setInterval(safeWatchdog, WATCHDOG_INTERVAL_MS);
    console.log(`[Watchdog] Started (interval: 30m, task threshold: 30m, vision cycle timeout: 15m)`);
  }, 60_000);
});
