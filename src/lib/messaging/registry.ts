/**
 * M-1 (#1662): Messaging registry — adapter registration, outbound fan-out,
 * and the default CommandEffects wired to Org Studio's own HTTP APIs.
 *
 * One Leash rule: every command effect goes through the SAME validated API
 * write path the dashboard UI uses (updateComponent / roadmap upsert /
 * updateProject) — no parallel mutation paths, so promote flows, budget
 * validation, and workspace checks all apply for free.
 *
 * Additive: nothing here starts unless startMessaging() is called AND at
 * least one adapter is registered (M-2+). Existing chat.send / direct
 * Telegram notification paths are untouched.
 */

import type {
  MessagingAdapter,
  ChatBinding,
  OutboundNotification,
  InboundMessage,
  InboundReply,
} from './types';
import { handleInbound, type CommandEffects } from './commands';

const ORG_STUDIO_BASE = () => `http://localhost:${process.env.PORT || 4501}`;

function authHeaders(): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    ...(process.env.ORG_STUDIO_API_KEY
      ? { Authorization: `Bearer ${process.env.ORG_STUDIO_API_KEY}` }
      : {}),
  };
}

async function storePost(body: any): Promise<any> {
  const r = await fetch(`${ORG_STUDIO_BASE()}/api/store`, {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify(body),
  });
  const json = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(json?.error || `HTTP ${r.status}`);
  return json;
}

async function storeGet(): Promise<any> {
  const r = await fetch(`${ORG_STUDIO_BASE()}/api/store`, { headers: authHeaders() });
  if (!r.ok) throw new Error(`store read failed: HTTP ${r.status}`);
  return r.json();
}

/** Primary component = first non-qa/non-support, else first — the same
 *  rule the promote path uses (see project-state.ts / MEMORY 2026-06-03). */
function primaryComponent(project: any): any | null {
  const comps: any[] = Array.isArray(project?.components)
    ? project.components
    : Array.isArray(project?.sections)
      ? project.sections
      : [];
  if (comps.length === 0) return null;
  const nonAux = comps.find((c) => {
    const n = (c?.name || '').toLowerCase();
    return !n.includes('qa') && !n.includes('support');
  });
  return nonAux || comps[0];
}

/** The version the dispatcher is actually working: explicit 'current', else
 *  first unshipped approved — mirrors AutonomyPanel's killTargetVersion. */
async function activeVersion(projectId: string, approved: string[]): Promise<any | null> {
  const r = await fetch(`${ORG_STUDIO_BASE()}/api/roadmap/${projectId}`, { headers: authHeaders() });
  if (!r.ok) throw new Error(`roadmap read failed: HTTP ${r.status}`);
  const data = await r.json();
  const versions: any[] = data?.versions || data?.roadmap || [];
  const explicit = versions.find((v) => v.status === 'current');
  if (explicit) return explicit;
  return versions.find((v) => v.status !== 'shipped' && approved.includes(v.version)) ?? null;
}

export const defaultEffects: CommandEffects = {
  async approveVersion(projectId, version, by) {
    const store = await storeGet();
    const project = (store.projects || []).find((p: any) => p.id === projectId);
    if (!project) throw new Error(`Project '${projectId}' not found`);
    const comp = primaryComponent(project);
    if (!comp) throw new Error(`Project '${projectId}' has no components`);
    const existing: string[] = Array.isArray(comp.approvedVersions) ? comp.approvedVersions : [];
    if (existing.includes(version)) {
      return `${version} is already approved on ${project.name || projectId}.`;
    }
    // Same write the AutonomyPanel horizon dial does — fires the promote flow.
    await storePost({
      action: 'updateComponent',
      projectId,
      componentId: comp.id,
      updates: { approvedVersions: [...existing, version] },
    });
    return `✅ Approved ${version} on ${project.name || projectId} (by ${by}). Promote flow fires if eligible.`;
  },

  async setLoopPaused(projectId, paused, by) {
    const store = await storeGet();
    const project = (store.projects || []).find((p: any) => p.id === projectId);
    if (!project) throw new Error(`Project '${projectId}' not found`);
    const comp = primaryComponent(project);
    const approved: string[] = Array.isArray(comp?.approvedVersions) ? comp.approvedVersions : [];
    const target = await activeVersion(projectId, approved);
    if (!target) throw new Error(`No active version to ${paused ? 'pause' : 'resume'} on '${projectId}'`);
    // Full-field upsert — the roadmap upsert replaces title/status/items, so
    // a meta-only payload would clobber them (same shape AutonomyPanel sends).
    const r = await fetch(`${ORG_STUDIO_BASE()}/api/roadmap/${projectId}`, {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({
        action: 'upsert',
        version: target.version,
        title: target.title,
        status: target.status,
        items: target.items || [],
        versionType: target.version_type || 'outcome',
        loopPaused: paused,
      }),
    });
    if (!r.ok) {
      const j = await r.json().catch(() => ({}));
      throw new Error(j?.error || `HTTP ${r.status}`);
    }
    return paused
      ? `⏸️ Paused loop on ${project.name || projectId} ${target.version} (by ${by}).`
      : `▶️ Resumed loop on ${project.name || projectId} ${target.version} (by ${by}).`;
  },

  async setBudget(projectId, ceilingUsdMonth, by) {
    const store = await storeGet();
    const project = (store.projects || []).find((p: any) => p.id === projectId);
    if (!project) throw new Error(`Project '${projectId}' not found`);
    // Whole-object replace preserving other keys — validateBudget rejects
    // unknown keys, and a partial object would drop ceilingUsdVersion.
    const budget = {
      ...(project.budget || {}),
      ceilingUsdMonth,
    };
    await storePost({ action: 'updateProject', id: projectId, updates: { budget } });
    return `💰 Budget ceiling on ${project.name || projectId} set to $${ceilingUsdMonth}/mo (by ${by}).`;
  },

  async getStatus(projectId) {
    const store = await storeGet();
    const project = (store.projects || []).find((p: any) => p.id === projectId);
    if (!project) throw new Error(`Project '${projectId}' not found`);
    const comp = primaryComponent(project);
    const approved: string[] = Array.isArray(comp?.approvedVersions) ? comp.approvedVersions : [];
    const ceiling = project.budget?.ceilingUsdMonth;
    let active: any = null;
    try {
      active = await activeVersion(projectId, approved);
    } catch {
      /* roadmap read is best-effort for status */
    }
    const parts = [
      `📊 ${project.name || projectId}`,
      `Active version: ${active ? `${active.version} (${active.status}${active.loopPaused ? ', ⏸️ paused' : ''})` : 'none'}`,
      `Approved: ${approved.length ? approved.join(', ') : 'none'}`,
      `Budget: ${typeof ceiling === 'number' ? `$${ceiling}/mo ceiling` : 'not set'}`,
    ];
    return parts.join('\n');
  },
};

// ---------- Registry ----------

class MessagingRegistry {
  private adapters = new Map<string, MessagingAdapter>();
  private started = false;
  private effects: CommandEffects;

  constructor(effects: CommandEffects = defaultEffects) {
    this.effects = effects;
  }

  register(adapter: MessagingAdapter): void {
    this.adapters.set(adapter.id, adapter);
  }

  get(id: string): MessagingAdapter | undefined {
    return this.adapters.get(id);
  }

  list(): MessagingAdapter[] {
    return [...this.adapters.values()];
  }

  /** Bindings live in settings.messagingBindings — read fresh per inbound
   *  so a binding change doesn't need a restart. */
  private async loadBindings(): Promise<ChatBinding[]> {
    try {
      const store = await storeGet();
      const raw = store?.settings?.messagingBindings;
      return Array.isArray(raw) ? raw : [];
    } catch {
      return []; // fail closed — no bindings, no authz
    }
  }

  /** Start all registered adapters. No adapters = no-op. */
  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    const handler = async (msg: InboundMessage): Promise<InboundReply> => {
      const bindings = await this.loadBindings();
      return handleInbound(msg, bindings, this.effects);
    };
    for (const adapter of this.adapters.values()) {
      try {
        await adapter.start(handler);
        console.log(`[messaging] adapter '${adapter.id}' started`);
      } catch (e: any) {
        console.warn(`[messaging] adapter '${adapter.id}' failed to start:`, e?.message);
      }
    }
  }

  async stop(): Promise<void> {
    this.started = false;
    for (const adapter of this.adapters.values()) {
      try {
        await adapter.stop();
      } catch {
        /* best-effort */
      }
    }
  }

  /** Outbound fan-out: deliver to every binding whose teammate matches a
   *  recipient (or all bindings when recipients omitted). Best-effort —
   *  a dead channel never breaks the caller. Returns delivered count. */
  async notify(n: OutboundNotification): Promise<number> {
    if (this.adapters.size === 0) return 0;
    const bindings = await this.loadBindings();
    const targets = bindings.filter(
      (b) =>
        !n.recipients ||
        n.recipients.length === 0 ||
        n.recipients.some((r) => r.toLowerCase() === b.teammate.toLowerCase()),
    );
    let delivered = 0;
    for (const b of targets) {
      const adapter = this.adapters.get(b.channel);
      if (!adapter) continue;
      try {
        if (await adapter.sendNotification(b, n)) delivered++;
      } catch (e: any) {
        console.warn(`[messaging] notify via '${b.channel}' failed:`, e?.message);
      }
    }
    return delivered;
  }
}

/** Singleton — mirrors the runtime RuntimeRegistry pattern. */
let registry: MessagingRegistry | null = null;

export function getMessagingRegistry(effects?: CommandEffects): MessagingRegistry {
  if (!registry) registry = new MessagingRegistry(effects);
  return registry;
}

/** Test seam. */
export function resetMessagingRegistry(): void {
  registry = null;
}
