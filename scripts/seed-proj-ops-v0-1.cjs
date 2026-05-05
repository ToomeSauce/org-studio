const fs = require('fs');
const path = require('path');
const envPath = path.resolve(__dirname, '..', '.env.local');
for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
  const m = line.match(/^([A-Z_]+)=(.*)$/);
  if (m) process.env[m[1]] = m[2];
}

const API = 'http://localhost:4501';
const TOKEN = process.env.ORG_STUDIO_API_KEY || '8ce80b4d1379aed97fcd4d75c4a53562';
const H = { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` };

async function storeApi(action, body) {
  const res = await fetch(`${API}/api/store`, { method: 'POST', headers: H, body: JSON.stringify({ action, ...body }) });
  if (!res.ok) throw new Error(`store.${action} → HTTP ${res.status}: ${await res.text()}`);
  return res.json();
}

(async () => {
  const ITEM_ID = 'ri-ops-0-1-1';

  // ---- 1. Upsert v0.1.0 with the roadmap item (taskId still null) ----
  console.log('1. Upserting v0.1.0 in roadmap_versions (item, no taskId yet)...');
  let upsert = await fetch(`${API}/api/roadmap/proj-ops`, {
    method: 'POST',
    headers: H,
    body: JSON.stringify({
      action: 'upsert',
      version: '0.1.0',
      title: 'Operations baseline',
      status: 'planned',
      versionType: 'outcome',
      owner: 'Henry',
      items: [
        {
          id: ITEM_ID,
          title: 'Operations baseline — inventory + README + v0.2 plan',
          taskId: null,
          done: false,
        },
      ],
    }),
  });
  if (!upsert.ok) throw new Error(`roadmap upsert HTTP ${upsert.status}: ${await upsert.text()}`);
  console.log(`   ✓ v0.1.0 upserted with item ${ITEM_ID}`);

  // ---- 2. Create the seed task referencing the roadmap item ----
  console.log('2. Creating seed task...');
  const task = await storeApi('addTask', {
    task: {
      projectId: 'proj-ops',
      sectionId: 'sec-main-proj-ops',
      roadmapItemId: ITEM_ID,
      title: 'Operations baseline — inventory crons, research reports, Moltbook, reMarkable sync',
      description: `Baseline pass over the Agent Operations surface area.

Scope:
- Inventory active operational crons (email digests, research reports, Moltbook updates, reMarkable sync) with current schedule + owner + last-success timestamp
- Document each in a proj-ops README so anyone can pick up an outage
- Flag any cron that's silently broken or missing
- Propose v0.2.0 roadmap based on what gaps surface`,
      doneWhen: `- README at the project root with one section per operational surface (crons, research reports, Moltbook, reMarkable sync)
- Each section lists: what runs, when, who owns, where logs/output land, last-known-good
- Any broken/stale crons flagged with recommended fix
- v0.2.0 outcomes proposed in a comment on this task or as a roadmap update`,
      assignee: 'henry',
      priority: 'medium',
      version: '0.1.0',
      taskKind: 'roadmap',
      taskType: 'feature',
      testType: 'self',
      status: 'planning',
      initiatedBy: 'mikey',
    },
  });
  const taskId = task.task?.id || task.id;
  console.log(`   ✓ task ${taskId}`);

  // ---- 3. Re-upsert with taskId filled in ----
  console.log('3. Re-upserting roadmap item with taskId...');
  upsert = await fetch(`${API}/api/roadmap/proj-ops`, {
    method: 'POST',
    headers: H,
    body: JSON.stringify({
      action: 'upsert',
      version: '0.1.0',
      title: 'Operations baseline',
      status: 'planned',
      versionType: 'outcome',
      owner: 'Henry',
      items: [
        {
          id: ITEM_ID,
          title: 'Operations baseline — inventory + README + v0.2 plan',
          taskId,
          done: false,
        },
      ],
    }),
  });
  if (!upsert.ok) throw new Error(`roadmap upsert (link) HTTP ${upsert.status}: ${await upsert.text()}`);
  console.log(`   ✓ item linked to ${taskId}`);

  // ---- 4. Stub vision doc ----
  console.log('4. Writing stub vision doc...');
  const visionContent = `# Agent Operations — Vision

## North Star

Keep the lights on for everything that runs in the background of the agent team. Crons, recurring research, recurring sync to physical devices (reMarkable), the daily/weekly digest cadence — all of it.

If a cron silently dies, this project is the place we notice and fix it.

## Scope

- **Email crons** — automated digests, summaries, scheduled sends
- **Research reports** — recurring research jobs that produce artifacts
- **Moltbook** — internal knowledge / research notebook updates
- **reMarkable sync** — Planning Board + research artifacts to tablet

Out of scope: production app crons (those live with their owning project — Catpilot, Org Studio, etc.).

## Owner

**Henry** — Chief of Staff. Owns the operational surface area; coordinates across agents when a cron crosses domains.

## v0.1.0 — Operations baseline

Goal: take inventory. We don't know what's running, when, or who owns it. v0.1 fixes that.

- Inventory all proj-ops crons (schedule, owner, last-success)
- README documents each surface so any agent can debug an outage
- Flag broken / stale / missing
- Propose v0.2.0 outcomes from what surfaces

## Future arc (rough)

- **v0.2.0** — fill the gaps surfaced in v0.1 (TBD after baseline)
- **v0.3.0+** — productize the cron-watch story (alerts, dashboards, runbook automation)

## Change history

- 2026-05-05 — Mikey: stub vision doc to unblock launch (#proj-ops). Henry to flesh out v0.1 outcomes during baseline.
`;
  const docRes = await fetch(`${API}/api/vision/proj-ops/doc`, {
    method: 'PUT',
    headers: H,
    body: JSON.stringify({ content: visionContent, version: '0.1.0' }),
  });
  if (!docRes.ok) throw new Error(`vision PUT HTTP ${docRes.status}: ${await docRes.text()}`);
  console.log(`   ✓ vision doc saved`);

  console.log('\nReady. proj-ops should now be launchable from the UI.');
  console.log(`Task: ${taskId}`);
})().catch((e) => {
  console.error('FAILED:', e.message);
  process.exit(1);
});
