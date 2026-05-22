/**
 * Store Provider abstraction layer
 * 
 * Allows swapping between file-based (JSON) and Postgres storage without changing routes or UI.
 * Implements CRUD operations for projects and tasks.
 */

import { join } from 'path';
import {
  TASK_COLUMNS,
  PROJECT_COLUMNS,
  rowToObject,
  buildInsert,
  buildUpdate,
} from './postgres-column-map';

export interface StoreData {
  projects: any[];
  tasks: any[];
  settings?: Record<string, any>;
}

export interface StoreProvider {
  /**
   * Read the entire store (projects, tasks, settings)
   */
  read(): Promise<StoreData>;

  /**
   * Write the entire store (atomic operation)
   */
  write(data: StoreData): Promise<void>;

  /**
   * Create a new project
   */
  createProject(project: any): Promise<any>;

  /**
   * Update an existing project
   */
  updateProject(projectId: string, updates: Partial<any>): Promise<any>;

  /**
   * Delete a project
   */
  deleteProject(projectId: string): Promise<void>;

  /**
   * Create a new task
   */
  createTask(task: any): Promise<any>;

  /**
   * Allocate the next ticket number atomically.
   * Postgres impl uses a sequence. File-mode uses an in-process mutex.
   * Safe under concurrent addTask calls — never returns duplicates. (#863)
   */
  allocateTicketNumber(): Promise<number>;

  /**
   * Update an existing task
   */
  updateTask(taskId: string, updates: Partial<any>): Promise<any>;

  /**
   * Delete a task (or archive it)
   */
  deleteTask(taskId: string): Promise<void>;

  /**
   * Add a comment to a task (legacy) or to any scope (new).
   * Legacy: addComment(taskId: string, comment)
   * New:    addComment(scope: { kind, taskId?, ... }, comment)
   */
  addComment(taskIdOrScope: string | { kind: string; taskId?: string; sectionId?: string; boardProjectId?: string; dmThreadId?: string }, comment: any): Promise<any>;

  /**
   * List comments for a given scope (reads from org_studio_comments table).
   * Optional — only Postgres provider implements this initially.
   */
  listComments?(scope: { kind: string; taskId?: string; sectionId?: string; boardProjectId?: string; dmThreadId?: string }, opts?: { limit?: number; before?: number }): Promise<any[]>;

  /**
   * Bulk-fetch comments for many tasks in a single query (#1524).
   * Returns a Map keyed by taskId; missing tasks resolve to an empty array.
   * This is the N+1-safe path for hot loops over `store.tasks` that previously
   * read the inline `task.comments[]` blob. Server-side consumers (scheduler,
   * signal-detector, evidence-detector, section-access, metrics, snapshot
   * STOP-window detection) MUST use this rather than awaiting `listComments`
   * per task.
   *
   * `opts.limit` caps comments **per task**, not total. Default 50.
   */
  listCommentsForTasks?(taskIds: string[], opts?: { limit?: number; before?: number }): Promise<Map<string, any[]>>;

  /**
   * Update settings (mission statement, values, teammates, etc.)
   */
  updateSettings(updates: Partial<Record<string, any>>): Promise<any>;

  upsertMetrics?(agentId: string, date: string, metrics: Record<string, any>, sectionId?: string | null): Promise<any>;
  getMetrics?(agentId: string, opts?: { from?: string; to?: string; limit?: number; sectionId?: string }): Promise<any[]>;
  getTeamMetrics?(opts?: { from?: string; to?: string; sectionId?: string }): Promise<any[]>;

  // --- Section CRUD ---
  addSection(projectId: string, section: { id?: string; name: string; owner: string; outcomes: string; contract: string }): Promise<any>;
  updateSection(projectId: string, sectionId: string, updates: Partial<{ name: string; owner: string; outcomes: string; contract: string }>): Promise<void>;
  deleteSection(projectId: string, sectionId: string): Promise<void>;
  /** Hard-delete a section — truly removes it from the project. Use deleteSection for soft-delete. */
  purgeSection(projectId: string, sectionId: string): Promise<void>;
  reorderSections(projectId: string, sectionIds: string[]): Promise<void>;

  /**
   * List DM threads with last-message metadata.
   * Returns distinct threads sorted by last message timestamp DESC.
   */
  listDmThreads?(forAgent?: string): Promise<{ threadId: string; participantIds: string[]; lastCommentAt: number; lastCommentPreview: string; lastCommentAuthor?: string }[]>;

  /**
   * Health check — verify provider is operational
   */
  health(): Promise<boolean>;

  /**
   * Close any connections (for cleanup)
   */
  close?(): Promise<void>;
}

/**
 * File-based store provider (current implementation)
 * Reads/writes JSON from disk
 */
export class FileStoreProvider implements StoreProvider {
  private storePath: string;
  private backupDir: string;
  private maxBackups = 20;
  private migrated = false;

  constructor(storePath: string, backupDir?: string) {
    this.storePath = storePath;
    this.backupDir = backupDir || storePath.replace(/store\.json$/, 'backups');
  }

  /**
   * Detect old top-level shape and silently migrate to workspace envelope.
   * Old shape: { projects, tasks, settings }
   * New shape: { activeWorkspace, workspaces: { 'default-workspace': { projects, tasks, settings, ... } } }
   */
  private migrateIfNeeded(raw: any): any {
    // Already new shape
    if (raw.workspaces && raw.activeWorkspace) return raw;

    // Old shape detected — wrap into workspace envelope
    const { existsSync, copyFileSync } = require('fs');
    const timestamp = Date.now();
    const backupPath = this.storePath.replace(/\.json$/, `.json.pre-workspace-migration.${timestamp}`);

    try {
      if (existsSync(this.storePath)) {
        copyFileSync(this.storePath, backupPath);
      }
    } catch (e) {
      console.error('[FileStore] Backup before workspace migration failed:', e);
    }

    const migrated = {
      activeWorkspace: 'default-workspace',
      workspaces: {
        'default-workspace': {
          projects: raw.projects || [],
          tasks: raw.tasks || [],
          settings: raw.settings || {},
          kudos: raw.kudos || [],
          roadmapVersions: raw.roadmapVersions || [],
          visionDocs: raw.visionDocs || {},
        },
      },
    };

    // Write migrated shape back
    try {
      const { writeFileSync } = require('fs');
      writeFileSync(this.storePath, JSON.stringify(migrated, null, 2));
      console.log(`[FileStore] Migrated store.json to workspace envelope (backup: ${backupPath})`);
    } catch (e) {
      console.error('[FileStore] Failed to write migrated store:', e);
    }

    return migrated;
  }

  /** Read workspace data from the envelope, returning the active workspace slice as StoreData */
  private readEnvelope(): { root: any; ws: any } {
    const { existsSync, readFileSync } = require('fs');

    if (!existsSync(this.storePath)) {
      const root = {
        activeWorkspace: 'default-workspace',
        workspaces: {
          'default-workspace': { projects: [], tasks: [], settings: {} },
        },
      };
      return { root, ws: root.workspaces['default-workspace'] };
    }

    try {
      const content = readFileSync(this.storePath, 'utf-8');
      let data = JSON.parse(content);
      data = this.migrateIfNeeded(data);

      const activeWs = data.activeWorkspace || 'default-workspace';
      if (!data.workspaces[activeWs]) {
        data.workspaces[activeWs] = { projects: [], tasks: [], settings: {} };
      }
      return { root: data, ws: data.workspaces[activeWs] };
    } catch (e) {
      console.error(`Failed to read store at ${this.storePath}:`, e);
      const root = {
        activeWorkspace: 'default-workspace',
        workspaces: {
          'default-workspace': { projects: [], tasks: [], settings: {} },
        },
      };
      return { root, ws: root.workspaces['default-workspace'] };
    }
  }

  /** Write back the full envelope to disk */
  private writeEnvelope(root: any): void {
    const { existsSync, writeFileSync, mkdirSync, readdirSync, unlinkSync, copyFileSync } = require('fs');
    const { join } = require('path');

    // Auto-backup before every write
    try {
      if (existsSync(this.storePath)) {
        mkdirSync(this.backupDir, { recursive: true });
        const ts = new Date().toISOString().replace(/[:.]/g, '-');
        copyFileSync(this.storePath, join(this.backupDir, `store-${ts}.json`));

        // Prune old backups
        const backups = readdirSync(this.backupDir)
          .filter((f: string) => f.startsWith('store-') && f.endsWith('.json'))
          .sort()
          .reverse();
        for (const old of backups.slice(this.maxBackups)) {
          unlinkSync(join(this.backupDir, old));
        }
      }
    } catch (e) {
      console.error('Backup creation failed:', e);
    }

    try {
      writeFileSync(this.storePath, JSON.stringify(root, null, 2));
    } catch (e) {
      console.error(`Failed to write store to ${this.storePath}:`, e);
      throw e;
    }
  }

  async read(): Promise<StoreData> {
    const { ws } = this.readEnvelope();
    const data: StoreData = {
      projects: ws.projects || [],
      tasks: ws.tasks || [],
      settings: ws.settings || {},
    };
    // Inject default "Main" section for projects missing sections
    if (data.projects) {
      for (const p of data.projects) {
        if (!p.sections || p.sections.length === 0) {
          p.sections = [{ id: `sec-main-${p.id}`, name: 'Main', owner: p.owner || '', outcomes: '', contract: '' }];
        }
      }
    }
    return data;
  }

  async write(data: StoreData): Promise<void> {
    const { root } = this.readEnvelope();
    const activeWs = root.activeWorkspace || 'default-workspace';
    root.workspaces[activeWs] = {
      ...root.workspaces[activeWs],
      projects: data.projects,
      tasks: data.tasks,
      settings: data.settings,
    };
    this.writeEnvelope(root);
  }

  async createProject(project: any): Promise<any> {
    const { root, ws } = this.readEnvelope();
    project.id = project.id || `proj-${Date.now()}`;
    project.createdAt = project.createdAt || Date.now();
    // #1145: persist the default Main section explicitly. The legacy behavior
    // injected it virtually inside read(), which made the disk reality drift
    // from the read reality — addSection couldn't find it, deleteSection
    // couldn't reference it, and tests reading the file directly saw no
    // sections. Persist on create so disk and read agree.
    if (!project.sections || project.sections.length === 0) {
      project.sections = [{
        id: `sec-main-${project.id}`,
        name: 'Main',
        owner: project.owner || '',
        outcomes: '',
        contract: '',
      }];
    }
    ws.projects.push(project);
    this.writeEnvelope(root);
    return project;
  }

  async updateProject(projectId: string, updates: Partial<any>): Promise<any> {
    const { root, ws } = this.readEnvelope();
    const idx = ws.projects.findIndex((p: any) => p.id === projectId);
    if (idx === -1) throw new Error(`Project not found: ${projectId}`);
    ws.projects[idx] = { ...ws.projects[idx], ...updates };
    this.writeEnvelope(root);
    return ws.projects[idx];
  }

  async deleteProject(projectId: string): Promise<void> {
    const { root, ws } = this.readEnvelope();
    ws.projects = ws.projects.filter((p: any) => p.id !== projectId);
    this.writeEnvelope(root);
  }

  async createTask(task: any): Promise<any> {
    const { root, ws } = this.readEnvelope();
    task.id = task.id || `task-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    task.createdAt = task.createdAt || Date.now();
    ws.tasks.push(task);
    this.writeEnvelope(root);
    return task;
  }

  // #863: serialize ticket-number allocation in file mode (single-process).
  private _allocateChain: Promise<number> = Promise.resolve(0);

  async allocateTicketNumber(): Promise<number> {
    const next = this._allocateChain.then(() => {
      const { ws } = this.readEnvelope();
      const existing = (ws.tasks || [])
        .map((t: any) => (typeof t.ticketNumber === 'number' ? t.ticketNumber : 0));
      return Math.max(0, ...existing) + 1;
    });
    this._allocateChain = next.catch(() => 0);
    return next;
  }

  async updateTask(taskId: string, updates: Partial<any>): Promise<any> {
    const { root, ws } = this.readEnvelope();
    const idx = ws.tasks.findIndex((t: any) => t.id === taskId);
    if (idx === -1) throw new Error(`Task not found: ${taskId}`);
    ws.tasks[idx] = { ...ws.tasks[idx], ...updates };
    this.writeEnvelope(root);
    return ws.tasks[idx];
  }

  async deleteTask(taskId: string): Promise<void> {
    const { root, ws } = this.readEnvelope();
    ws.tasks = ws.tasks.filter((t: any) => t.id !== taskId);
    this.writeEnvelope(root);
  }

  async addComment(taskIdOrScope: string | { kind: string; taskId?: string; sectionId?: string; boardProjectId?: string; dmThreadId?: string }, comment: any): Promise<any> {
    const scope = typeof taskIdOrScope === 'string'
      ? { kind: 'task' as const, taskId: taskIdOrScope }
      : taskIdOrScope;

    if (scope.kind === 'task' && scope.taskId) {
      const { root, ws } = this.readEnvelope();
      const task = ws.tasks.find((t: any) => t.id === scope.taskId);
      if (!task) throw new Error(`Task not found: ${scope.taskId}`);

      if (!task.comments) task.comments = [];
      comment.id = comment.id || `comment-${Date.now()}`;
      comment.createdAt = comment.createdAt || Date.now();
      if (!comment.scope) comment.scope = scope;
      task.comments.push(comment);

      this.writeEnvelope(root);
      return comment;
    }

    comment.id = comment.id || `comment-${Date.now()}`;
    comment.createdAt = comment.createdAt || Date.now();
    if (!comment.scope) comment.scope = scope;
    return comment;
  }

  async updateSettings(updates: Partial<Record<string, any>>): Promise<any> {
    const { root, ws } = this.readEnvelope();
    if (!ws.settings) ws.settings = {};
    ws.settings = { ...ws.settings, ...updates };
    this.writeEnvelope(root);
    return ws.settings;
  }

  // --- Section CRUD (FileStoreProvider) ---

  async addSection(projectId: string, section: { id?: string; name: string; owner: string; outcomes: string; contract: string }): Promise<any> {
    const { root, ws } = this.readEnvelope();
    const project = ws.projects.find((p: any) => p.id === projectId);
    if (!project) throw new Error(`Project not found: ${projectId}`);
    const id = section.id || `sec-${Math.random().toString(36).slice(2, 10)}`;
    const newSection = { ...section, id };
    if (!project.sections) project.sections = [];
    project.sections.push(newSection);
    this.writeEnvelope(root);
    return newSection;
  }

  async updateSection(projectId: string, sectionId: string, updates: Partial<{ name: string; owner: string; outcomes: string; contract: string }>): Promise<void> {
    const { root, ws } = this.readEnvelope();
    const project = ws.projects.find((p: any) => p.id === projectId);
    if (!project) throw new Error(`Project not found: ${projectId}`);
    const section = (project.sections || []).find((s: any) => s.id === sectionId);
    if (!section) throw new Error(`Section not found: ${sectionId}`);
    Object.assign(section, updates);
    this.writeEnvelope(root);
  }

  async deleteSection(projectId: string, sectionId: string): Promise<void> {
    const { root, ws } = this.readEnvelope();
    const project = ws.projects.find((p: any) => p.id === projectId);
    if (!project) throw new Error(`Project not found: ${projectId}`);
    const sections = project.sections || [];
    const section = sections.find((s: any) => s.id === sectionId);
    if (!section) throw new Error(`Section not found: ${sectionId}`);
    const activeCount = sections.filter((s: any) => !s.archivedAt).length;
    if (activeCount <= 1 && !section.archivedAt) throw new Error('Cannot delete the last section');
    section.archivedAt = Date.now();
    section.archivedBy = 'user';
    this.writeEnvelope(root);
  }

  async purgeSection(projectId: string, sectionId: string): Promise<void> {
    const { root, ws } = this.readEnvelope();
    const project = ws.projects.find((p: any) => p.id === projectId);
    if (!project) throw new Error(`Project not found: ${projectId}`);
    const sections = project.sections || [];
    project.sections = sections.filter((s: any) => s.id !== sectionId);
    this.writeEnvelope(root);
  }

  async reorderSections(projectId: string, sectionIds: string[]): Promise<void> {
    const { root, ws } = this.readEnvelope();
    const project = ws.projects.find((p: any) => p.id === projectId);
    if (!project) throw new Error(`Project not found: ${projectId}`);
    const current = project.sections || [];
    const map = new Map(current.map((s: any) => [s.id, s]));
    const ordered = sectionIds.filter(id => map.has(id)).map(id => map.get(id)!);
    const rest = current.filter((s: any) => !sectionIds.includes(s.id));
    project.sections = [...ordered, ...rest];
    this.writeEnvelope(root);
  }

  /** File provider: DM threads are not indexed — return empty array. */
  async listDmThreads(): Promise<{ threadId: string; participantIds: string[]; lastCommentAt: number; lastCommentPreview: string; lastCommentAuthor?: string }[]> {
    return [];
  }

  async health(): Promise<boolean> {
    try {
      await this.read();
      return true;
    } catch {
      return false;
    }
  }
}

/**
 * Postgres store provider (new implementation)
 * Stores projects and tasks using typed columns + JSONB overflow
 */
export class PostgresStoreProvider implements StoreProvider {
  private connectionString: string;
  private pool: any;
  private workspaceId: string;

  constructor(connectionString: string, workspaceId: string = 'default-workspace') {
    this.connectionString = connectionString;
    this.workspaceId = workspaceId;
  }

  private async getPool() {
    if (!this.pool) {
      const { Pool } = require('pg');
      this.pool = new Pool({
        connectionString: this.connectionString,
        max: 10,
        min: 1, // #1528: keep one connection warm so the first request of
                // the burst doesn't pay the TLS+auth handshake cost (~500ms).
      });
    }
    return this.pool;
  }

  /**
   * #1528: prewarm the pool so the first read after app start doesn't pay
   * the cold TLS+auth handshake cost. Safe to call multiple times; cheap
   * if the pool is already populated. Designed to be invoked at app boot
   * from server.mjs / next.config bootstrap, but `read()` is the only
   * mandatory entry point so missing prewarm degrades gracefully.
   */
  async prewarm(): Promise<void> {
    const pool = await this.getPool();
    try {
      const c = await pool.connect();
      try { await c.query('SELECT 1'); } finally { c.release(); }
    } catch (e: any) {
      // Don't block app start on a transient DB hiccup. The next real read
      // will surface any persistent failure.
      console.warn('[prewarm] PostgresStoreProvider warmup failed (non-fatal):', e?.message || e);
    }
  }

  /**
   * Parse a BIGINT value from pg (returned as string) back to a number, or null
   */
  private parseBigint(val: any): number | null {
    if (val === null || val === undefined) return null;
    const n = Number(val);
    return isNaN(n) ? null : n;
  }

  /**
   * Reconstruct a project object from DB row, merging typed columns with overflow data.
   * Strips keys with undefined values so the shape matches the file store.
   */
  private reconstructProject(row: any): any {
    const cleaned = rowToObject(row, PROJECT_COLUMNS);
    // Inject default "Main" section if sections missing or empty
    if (!cleaned.sections || (Array.isArray(cleaned.sections) && cleaned.sections.length === 0)) {
      cleaned.sections = [{ id: `sec-main-${row.id}`, name: 'Main', owner: row.owner || '', outcomes: '', contract: '' }];
    }
    return cleaned;
  }

  /**
   * Reconstruct a task object from DB row.
   * All column/field mapping is driven by TASK_COLUMNS — see postgres-column-map.ts.
   */
  private reconstructTask(row: any): any {
    return rowToObject(row, TASK_COLUMNS);
  }

  async read(): Promise<StoreData> {
    const pool = await this.getPool();
    const client = await pool.connect();
    try {
      // #1520 — build a slim task SELECT that excludes the inline `comments`
      // JSONB column. Per the column-size audit on prod-shape data, that
      // single column was 66% of every read payload (5977 KB out of 9093 KB
      // for 1366 tasks). After #1524, every server-side reader fetches
      // comments via `listComments` / `listCommentsForTasks` from the
      // normalized `org_studio_comments` table, so we no longer need to
      // ship the inline blob over the wire. The dual-write (until #1294)
      // keeps the column populated for rollback; #1295 drops it.
      //
      // Use a column subset for BOTH the SELECT and the rowToObject
      // reconstruction — the latter would otherwise default the missing
      // typed field to `[]` and stamp it onto every task, which is wasted
      // bytes and would shadow any stale `data.comments` overflow.
      const READ_TASK_COLUMNS = TASK_COLUMNS.filter((c) => c.col !== 'comments');
      const TASK_SELECT_COLS = READ_TASK_COLUMNS.map((c) => c.col).join(', ');

      // #1520 — parallelize the three independent table reads. Was 3
      // serial round-trips (projects → tasks → settings), now one
      // Promise.all.
      //
      // #1528 — also fold the roadmap-versions hydration query into the
      // parallel batch. The original implementation ran it as a 4th
      // SERIAL query after the projects rows arrived, costing 80-110ms.
      // The hydration query only filters by workspace_id (no per-project
      // narrowing) so it's safe to issue in parallel with the projects
      // query — we just process the rows after both arrive. The
      // workspace_id filter is sufficient because every roadmap_version
      // row's project_id belongs to a project within the same workspace.
      const [projectsResult, tasksResult, settingsResult, rvResult] = await Promise.all([
        client.query(
          'SELECT * FROM org_studio_projects WHERE workspace_id = $1 ORDER BY created_at',
          [this.workspaceId],
        ),
        client.query(
          `SELECT ${TASK_SELECT_COLS} FROM org_studio_tasks WHERE workspace_id = $1 ORDER BY created_at`,
          [this.workspaceId],
        ),
        client.query(
          'SELECT data FROM org_studio_settings WHERE id = $1 AND workspace_id = $2',
          ['default', this.workspaceId],
        ),
        client.query(
          `SELECT project_id, id, version, title, status, items, sort_order, version_type, owner, shipped_at, created_at, meta
             FROM org_studio_roadmap_versions
            WHERE workspace_id = $1`,
          [this.workspaceId],
        ),
      ]);

      const projects = projectsResult.rows.map((row: any) => this.reconstructProject(row));

      // #1125: hydrate component.versions[] from org_studio_roadmap_versions
      // table on every read. The rv-table is the canonical source of truth;
      // the shadow `component.versions[]` inside the project document used to
      // drift silently. Single batched query (no N+1). Idempotent: re-running
      // produces the same result. QA components (role==='qa') and support
      // components are NOT auto-hydrated here — those are managed by the
      // one-shot migration script (scripts/hydrate-component-versions.mjs).
      // Existing component.versions[] entries with no matching rv-table row
      // are preserved (manual edits / legacy data).
      //
      // #1528: rvResult is now fetched in the Promise.all above; this helper
      // just processes the rows.
      this.applyComponentVersionHydration(projects, rvResult.rows);

      const tasks = tasksResult.rows.map((row: any) => rowToObject(row, READ_TASK_COLUMNS));
      const rawSettings = settingsResult.rows[0]?.data;
      const settings = rawSettings
        ? (typeof rawSettings === 'string' ? JSON.parse(rawSettings) : rawSettings)
        : {};

      return {
        projects,
        tasks,
        settings,
      };
    } finally {
      client.release();
    }
  }

  /**
   * #1125: hydrate component.versions[] for the primary component on each
   * project from the canonical org_studio_roadmap_versions table. Mutates
   * `projects` in place. See read() for rationale.
   *
   * Field shape mirrors scripts/hydrate-component-versions.mjs so the read
   * path and the migration script produce identical version objects.
   */
  private async hydrateComponentVersions(client: any, projects: any[]): Promise<void> {
    if (projects.length === 0) return;
    const rvResult = await client.query(
      `SELECT project_id, id, version, title, status, items, sort_order, version_type, owner, shipped_at, created_at, meta
         FROM org_studio_roadmap_versions
        WHERE workspace_id = $1`,
      [this.workspaceId]
    );
    this.applyComponentVersionHydration(projects, rvResult.rows);
  }

  /**
   * #1528: row-processing half of hydrateComponentVersions, split out so
   * the read() path can pass in rows already fetched by the parallel
   * Promise.all batch. The query half is kept for any future caller that
   * wants the convenient one-shot interface, but read() no longer uses it.
   */
  private applyComponentVersionHydration(projects: any[], rvRows: any[]): void {
    if (projects.length === 0) return;
    const escapeForRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    if (rvRows.length === 0) return;

    // Group rv rows by projectId, then sort by sort_order/version (parity
    // with migration script).
    const byProject = new Map<string, any[]>();
    for (const r of rvRows) {
      if (!byProject.has(r.project_id)) byProject.set(r.project_id, []);
      const meta = (r.meta && typeof r.meta === 'object') ? r.meta : {};
      byProject.get(r.project_id)!.push({
        id: r.id,
        version: r.version,
        status: r.status,
        items: Array.isArray(r.items) ? r.items : (r.items ? (typeof r.items === 'string' ? JSON.parse(r.items) : r.items) : []),
        sort_order: r.sort_order ?? undefined,
        version_type: r.version_type || 'outcome',
        owner: r.owner ?? undefined,
        title: r.title,
        shipped_at: r.shipped_at ?? undefined,
        createdAt: r.created_at ?? undefined,
        // #1263 — lift outcome-bound metric fields from `meta` jsonb so
        // helpers reading ComponentVersionLike (e.g. dispatch-gate, version-
        // metric helpers) see them at the top level.
        ...(meta.successCriteria !== undefined ? { successCriteria: meta.successCriteria } : {}),
        ...(meta.metricCurrent !== undefined ? { metricCurrent: meta.metricCurrent } : {}),
        ...(meta.metricTarget !== undefined ? { metricTarget: meta.metricTarget } : {}),
        ...(meta.metricComparator !== undefined ? { metricComparator: meta.metricComparator } : {}),
        ...(meta.loopPaused !== undefined ? { loopPaused: meta.loopPaused } : {}),
      });
    }
    for (const [, list] of byProject) {
      list.sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0) || String(a.version).localeCompare(String(b.version)));
    }

    for (const project of projects) {
      // Effective components list: prefer `components[]`, fall back to `sections[]`.
      // Mirrors getEffectiveComponents() and the migration script's behavior.
      const components = (project.components && project.components.length > 0)
        ? project.components
        : (project.sections || []);
      if (components.length === 0) continue;
      // Primary = first component whose role is not 'qa' or 'support', else components[0]
      const primary = components.find((c: any) => {
        const role = c?.role ? String(c.role).toLowerCase() : '';
        return role !== 'qa' && role !== 'support';
      }) || components[0];
      if (!primary) continue;
      const primaryRole = primary.role ? String(primary.role).toLowerCase() : '';
      if (primaryRole === 'qa' || primaryRole === 'support') continue;

      const rvRows = byProject.get(project.id) || [];
      if (rvRows.length === 0) continue;

      const existing = Array.isArray(primary.versions) ? primary.versions : [];
      const rvVersions = new Set(rvRows.map(r => r.version));
      // #1267: drop orphan shadow entries whose `id` matches the rv-derived
      // shape (`rv-<projectId>-...`) but whose version isn't in the rv-table.
      // These are stranded copies left behind by buggy rename writes.
      // Custom-id entries (e.g. `legacy-x`) MUST still be preserved — the
      // older test `preserves existing component.versions entries that
      // have no rv-table row` covers that. We use the simpler id-shape
      // heuristic (no task-table check) for clarity; the convention is that
      // rv-shaped ids only ever exist when paired with an rv-table row.
      const rvShapedRe = new RegExp(`^rv-${escapeForRegExp(project.id)}-`);
      const merged: any[] = [...rvRows];
      for (const ex of existing) {
        if (rvVersions.has(ex.version)) continue; // canonical row already in merged
        const isRvShaped = typeof ex.id === 'string' && rvShapedRe.test(ex.id);
        if (isRvShaped) continue; // orphan
        merged.push(ex); // preserve legacy/custom-id entry
      }
      primary.versions = merged;

      // Non-primary components (qa/support) keep their own version[] shape
      // — we don't add or remove entries — but if a version string overlaps
      // with the canonical rv-table row, refresh the editable fields
      // (title, status, version_type, owner, items, shipped_at) so per-
      // component views don't render stale data after a save against the
      // project-scoped rv-table. Without this, editing a roadmap title
      // while viewing a support component appears to silently revert on
      // refresh because that component's shadow never got the new title.
      const rvByVersion = new Map(rvRows.map(r => [r.version, r]));
      for (const comp of components) {
        if (comp === primary) continue;
        const list = Array.isArray(comp.versions) ? comp.versions : [];
        for (const entry of list) {
          const rv = rvByVersion.get(entry.version);
          if (!rv) continue;
          entry.title = rv.title;
          entry.status = rv.status;
          entry.version_type = rv.version_type;
          entry.owner = rv.owner;
          entry.items = rv.items;
          entry.shipped_at = rv.shipped_at;
        }
      }
    }
  }

  async write(data: StoreData): Promise<void> {
    const pool = await this.getPool();
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      // Clear and rewrite projects (scoped to workspace)
      await client.query('DELETE FROM org_studio_projects WHERE workspace_id = $1', [this.workspaceId]);
      for (const project of data.projects) {
        const plan = buildInsert('org_studio_projects', PROJECT_COLUMNS, project, this.workspaceId);
        await client.query(plan.sql, plan.values);
      }

      // Clear and rewrite tasks (scoped to workspace)
      // Column/field mapping is driven by TASK_COLUMNS — impossible for
      // the destructure, INSERT column list, placeholders and values
      // array to drift out of sync (see postgres-column-map.ts).
      await client.query('DELETE FROM org_studio_tasks WHERE workspace_id = $1', [this.workspaceId]);
      for (const task of data.tasks) {
        const plan = buildInsert('org_studio_tasks', TASK_COLUMNS, task, this.workspaceId);
        await client.query(plan.sql, plan.values);
      }

      // Update settings (scoped to workspace)
      // #1388 A.4-schema: PK is (workspace_id, id) — settings rows are independent per workspace.
      await client.query(
        'INSERT INTO org_studio_settings (id, data, workspace_id) VALUES ($1, $2, $3) ON CONFLICT (workspace_id, id) DO UPDATE SET data = $2',
        ['default', JSON.stringify(data.settings || {}), this.workspaceId]
      );

      await client.query('COMMIT');

      // Emit NOTIFY event for bidirectional sync (remote server listening)
      const changePayload = JSON.stringify({
        type: 'store_update',
        timestamp: Date.now(),
        source: 'postgres',
      });
      try { await client.query(`NOTIFY org_studio_change, '${changePayload.replace(/'/g, "''")}'`); } catch {} // best-effort
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
  }

  async createProject(project: any): Promise<any> {
    const pool = await this.getPool();
    const client = await pool.connect();
    try {
      const id = project.id || `proj-${Date.now()}`;
      const createdAt = project.createdAt || Date.now();
      const createdBy = project.createdBy || 'system';

      const full = { ...project, id, createdAt, createdBy };
      const plan = buildInsert('org_studio_projects', PROJECT_COLUMNS, full, this.workspaceId);
      await client.query(plan.sql, plan.values);

      return full;
    } finally {
      client.release();
    }
  }

  async updateProject(projectId: string, updates: Partial<any>): Promise<any> {
    const pool = await this.getPool();
    const client = await pool.connect();
    try {
      const result = await client.query(
        'SELECT * FROM org_studio_projects WHERE id = $1 AND workspace_id = $2',
        [projectId, this.workspaceId]
      );
      if (result.rows.length === 0) throw new Error(`Project not found: ${projectId}`);

      const current = this.reconstructProject(result.rows[0]);
      const updated = { ...current, ...updates };

      const plan = buildUpdate('org_studio_projects', PROJECT_COLUMNS, updated, this.workspaceId);
      await client.query(plan.sql, plan.values);

      // Emit NOTIFY event for bidirectional sync — include updates for intent routing
      const changePayload = JSON.stringify({ type: 'store_update', action: 'updateProject', projectId, updates });
      try { await client.query(`NOTIFY org_studio_change, '${changePayload.replace(/'/g, "''")}'`); } catch {} // best-effort

      return updated;
    } finally {
      client.release();
    }
  }

  async deleteProject(projectId: string): Promise<void> {
    const pool = await this.getPool();
    const client = await pool.connect();
    try {
      await client.query('DELETE FROM org_studio_projects WHERE id = $1 AND workspace_id = $2', [projectId, this.workspaceId]);
    } finally {
      client.release();
    }
  }

  async createTask(task: any): Promise<any> {
    const pool = await this.getPool();
    const client = await pool.connect();
    try {
      const id = task.id || `task-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
      const createdAt = task.createdAt || Date.now();
      const createdBy = task.createdBy || 'system';

      const full = { ...task, id, createdAt, createdBy };
      const plan = buildInsert('org_studio_tasks', TASK_COLUMNS, full, this.workspaceId);
      await client.query(plan.sql, plan.values);

      // Emit NOTIFY for task creation — triggers agent dispatch on local server.
      // (Previously this was dead code after an early return; the refactor restores it.)
      const changePayload = JSON.stringify({
        type: 'task_created',
        taskId: id,
        status: full.status || 'backlog',
        assignee: full.assignee || null,
        projectId: full.projectId || null,
        timestamp: Date.now(),
        source: 'postgres',
      });
      try { await client.query(`NOTIFY org_studio_change, '${changePayload.replace(/'/g, "''")}'`); } catch {} // best-effort

      return full;
    } finally {
      client.release();
    }
  }

  // #863: atomic ticket-number allocator backed by a Postgres sequence.
  // Lazily creates the sequence on first use, seeded at MAX(ticket_number)+1.
  // Safe under any concurrency level — nextval() is atomic.
  private _seqEnsurePromise: Promise<void> | null = null;

  private async ensureTicketSequence(client: any): Promise<void> {
    if (this._seqEnsurePromise) return this._seqEnsurePromise;
    this._seqEnsurePromise = (async () => {
      // Use a Postgres advisory lock so cross-process init is also safe.
      // Lock id: arbitrary constant derived from 'skill_installs' hash region.
      const LOCK_ID = 8636_3863;
      await client.query('SELECT pg_advisory_lock($1)', [LOCK_ID]);
      try {
        const exists = await client.query(
          `SELECT 1 FROM pg_class WHERE relkind = 'S' AND relname = 'org_studio_ticket_number_seq'`
        );
        if (exists.rowCount === 0) {
          const { rows } = await client.query(
            `SELECT COALESCE(MAX(ticket_number), 0)::BIGINT AS m FROM org_studio_tasks`
          );
          const start = Number(rows[0]?.m || 0) + 1;
          await client.query(
            `CREATE SEQUENCE IF NOT EXISTS org_studio_ticket_number_seq START WITH ${start} MINVALUE 1`
          );
        } else {
          // Sequence exists. Only bump forward if MAX(ticket_number) > last_value.
          // Never setval backward — that would hand out duplicates.
          const { rows } = await client.query(
            `SELECT (SELECT COALESCE(MAX(ticket_number), 0) FROM org_studio_tasks)::BIGINT AS data_max,
                    (SELECT last_value FROM org_studio_ticket_number_seq)::BIGINT AS seq_last`
          );
          const dataMax = Number(rows[0]?.data_max || 0);
          const seqLast = Number(rows[0]?.seq_last || 0);
          if (dataMax > seqLast) {
            await client.query(`SELECT setval('org_studio_ticket_number_seq', $1, true)`, [dataMax]);
          }
        }
      } finally {
        await client.query('SELECT pg_advisory_unlock($1)', [LOCK_ID]).catch(() => {});
      }
    })();
    try {
      await this._seqEnsurePromise;
    } catch (e) {
      // Reset so a future call can retry.
      this._seqEnsurePromise = null;
      throw e;
    }
  }

  async allocateTicketNumber(): Promise<number> {
    const pool = await this.getPool();
    const client = await pool.connect();
    try {
      await this.ensureTicketSequence(client);
      const { rows } = await client.query(
        `SELECT nextval('org_studio_ticket_number_seq')::BIGINT AS n`
      );
      return Number(rows[0].n);
    } finally {
      client.release();
    }
  }

  async updateTask(taskId: string, updates: Partial<any>): Promise<any> {
    const pool = await this.getPool();
    const client = await pool.connect();
    try {
      const result = await client.query(
        'SELECT * FROM org_studio_tasks WHERE id = $1 AND workspace_id = $2',
        [taskId, this.workspaceId]
      );
      if (result.rows.length === 0) throw new Error(`Task not found: ${taskId}`);

      const current = this.reconstructTask(result.rows[0]);
      const updated = { ...current, ...updates };

      const plan = buildUpdate('org_studio_tasks', TASK_COLUMNS, updated, this.workspaceId);
      const _updRes = await client.query(plan.sql, plan.values);

      // #948 debug — log row count; if 0, the WHERE didn't match and we silently missed.
      if (_updRes.rowCount === 0) {
        console.warn(`[updateTask] ⚠️ UPDATE affected 0 rows for taskId=${taskId} workspace_id=${this.workspaceId}`);
      }

      // Emit NOTIFY event for bidirectional sync — include updates + assignee for intent routing
      const changePayload = JSON.stringify({
        type: 'task_updated',
        taskId,
        updates,
        assignee: updated.assignee || null,
        testAssignee: updated.testAssignee || null,
        timestamp: Date.now(),
        source: 'postgres',
      });
      try { await client.query(`NOTIFY org_studio_change, '${changePayload.replace(/'/g, "''")}'`); } catch {} // best-effort

      return updated;
    } finally {
      client.release();
    }
  }

  async deleteTask(taskId: string): Promise<void> {
    const pool = await this.getPool();
    const client = await pool.connect();
    try {
      await client.query('DELETE FROM org_studio_tasks WHERE id = $1 AND workspace_id = $2', [taskId, this.workspaceId]);
    } finally {
      client.release();
    }
  }

  async addComment(taskIdOrScope: string | { kind: string; taskId?: string; sectionId?: string; boardProjectId?: string; dmThreadId?: string }, comment: any): Promise<any> {
    // Normalize scope
    const scope = typeof taskIdOrScope === 'string'
      ? { kind: 'task' as const, taskId: taskIdOrScope }
      : taskIdOrScope;

    const pool = await this.getPool();
    const client = await pool.connect();
    try {
      const commentObj = {
        id: comment.id || `comment-${Date.now()}`,
        createdAt: comment.createdAt || Date.now(),
        ...comment,
        scope,
      };

      // 1. Insert into org_studio_comments table (best-effort — table may not exist yet)
      try {
        await client.query(
          `INSERT INTO org_studio_comments (id, scope_kind, task_id, section_id, board_project_id, dm_thread_id, author, content, created_at, type, model, mentions, data)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
           ON CONFLICT (id) DO NOTHING`,
          [
            commentObj.id,
            scope.kind,
            scope.taskId || null,
            scope.sectionId || null,
            scope.boardProjectId || null,
            scope.dmThreadId || null,
            commentObj.author,
            commentObj.content,
            commentObj.createdAt,
            commentObj.type || null,
            commentObj.model || null,
            commentObj.mentions ? JSON.stringify(commentObj.mentions) : null,
            // #1506 — persist audit metadata into the comment row's JSONB data
            // bag for after-the-fact forensics. Read paths intentionally do not
            // surface this field (see route.ts stripAuditMeta + listComments map).
            JSON.stringify({ scope: commentObj.scope, audit: commentObj.auditMeta || null }),
          ]
        );
      } catch (e: any) {
        // Table may not exist yet (migration not run) — log and continue
        if (e.code !== '42P01') throw e; // 42P01 = undefined_table
        console.warn('[addComment] org_studio_comments table not found — skipping new-table write');
      }

      // 2. For task-scoped comments, also write inline on the task (dual-write)
      if (scope.kind === 'task' && scope.taskId) {
        const result = await client.query(
          'SELECT * FROM org_studio_tasks WHERE id = $1 AND workspace_id = $2',
          [scope.taskId, this.workspaceId]
        );
        if (result.rows.length === 0) throw new Error(`Task not found: ${scope.taskId}`);

        const current = this.reconstructTask(result.rows[0]);
        if (!current.comments) current.comments = [];
        // #1506 — the inline task.comments[] dual-write is a read-access path
        // (the GET /api/store snapshot historically read from it). Audit data
        // must NOT leak into this path; strip auditMeta before pushing.
        const { auditMeta: _strippedForInline, ...commentForInline } = commentObj as any;
        current.comments.push(commentForInline);

        const {
          id,
          ticketNumber,
          title,
          status,
          projectId,
          assignee,
          // priority removed (#1249) — ordering is via sortOrder/column position.
          // Existing tasks may still carry a stale priority; we strip it from the
          // working object below so it does not get persisted into the data bag.
          testType,
          testAssignee,
          initiatedBy,
          description,
          doneWhen,
          constraints,
          testPlan,
          reviewNotes,
          loopCount,
          loopPausedAt,
          loopPauseReason,
          lastActivityAt,
          createdAt,
          statusHistory,
          comments,
          sortOrder: _droppedSortOrder, // #1250 — typed column, do not let it bleed into the data bag overflow on this UPDATE path
          priority: _droppedPriority, // #1249 — strip stale priority off old rows so it does not bleed into the data JSON bag
          ...overflow
        } = current;

        await client.query(
          `UPDATE org_studio_tasks
           SET comments = $1, data = $2
           WHERE id = $3`,
          [JSON.stringify(comments), JSON.stringify(overflow), id]
        );
      }

      // Emit NOTIFY event for bidirectional sync
      const notifyTaskId = scope.kind === 'task' ? scope.taskId : null;
      const changePayload = JSON.stringify({
        type: 'comment_added',
        taskId: notifyTaskId,
        commentId: commentObj.id,
        scopeKind: scope.kind,
        timestamp: Date.now(),
        source: 'postgres',
      });
      try { await client.query(`NOTIFY org_studio_change, '${changePayload.replace(/'/g, "''")}'`); } catch {} // best-effort

      return commentObj;
    } finally {
      client.release();
    }
  }

  async listComments(scope: { kind: string; taskId?: string; sectionId?: string; boardProjectId?: string; dmThreadId?: string }, opts?: { limit?: number; before?: number }): Promise<any[]> {
    const scopeKey = scope.kind + ':' + (scope.taskId || scope.sectionId || scope.boardProjectId || scope.dmThreadId || '');
    const limit = opts?.limit || 50;
    const before = opts?.before || Date.now() + 1; // default: everything up to now
    const pool = await this.getPool();
    const client = await pool.connect();
    try {
      const result = await client.query(
        `SELECT * FROM org_studio_comments WHERE scope_key = $1 AND created_at < $2 ORDER BY created_at DESC LIMIT $3`,
        [scopeKey, before, limit]
      );
      // Reverse to ASC for rendering. #1506 — explicitly do NOT include
      // row.data here; that JSONB bag carries audit metadata which must not
      // leak to clients via list endpoints. (The shape below is the contract.)
      return result.rows.reverse().map((row: any) => ({
        id: row.id,
        author: row.author,
        content: row.content,
        createdAt: typeof row.created_at === 'string' ? parseInt(row.created_at, 10) : row.created_at,
        type: row.type || undefined,
        model: row.model || undefined,
        mentions: row.mentions || undefined,
        scope: {
          kind: row.scope_kind,
          taskId: row.task_id || undefined,
          sectionId: row.section_id || undefined,
          boardProjectId: row.board_project_id || undefined,
          dmThreadId: row.dm_thread_id || undefined,
        },
      }));
    } catch (e: any) {
      if (e.code === '42P01') return []; // table not yet created
      throw e;
    } finally {
      client.release();
    }
  }

  /**
   * Bulk-fetch comments for many tasks in one query (#1524).
   * Used by hot loops over `store.tasks` that previously read the inline
   * `task.comments[]` blob. Returns a Map<taskId, Comment[]> where each
   * array is ASC-ordered (oldest first), matching the legacy inline shape.
   *
   * Tasks with no comments still return an entry with an empty array, so
   * callers can do `byTask.get(taskId) || []` safely without checking has().
   */
  async listCommentsForTasks(taskIds: string[], opts?: { limit?: number; before?: number }): Promise<Map<string, any[]>> {
    const out = new Map<string, any[]>();
    if (!taskIds || taskIds.length === 0) return out;
    // Seed empty arrays so callers can blindly `.get(id) || []`.
    for (const id of taskIds) out.set(id, []);

    const limit = opts?.limit ?? 50;
    const before = opts?.before ?? (Date.now() + 1);
    const pool = await this.getPool();
    const client = await pool.connect();
    try {
      // Single query, IN-clause on task_id, plus a per-task row_number window
      // to cap at `limit` per task. This is the N+1-safe shape.
      // Note: we keep scope_kind='task' explicit so this never accidentally
      // pulls in section/board/dm comments that happen to share an id.
      const result = await client.query(
        `SELECT id, author, content, created_at, type, model, mentions,
                scope_kind, task_id, section_id, board_project_id, dm_thread_id
         FROM (
           SELECT *,
                  ROW_NUMBER() OVER (PARTITION BY task_id ORDER BY created_at DESC) AS rn
           FROM org_studio_comments
           WHERE scope_kind = 'task'
             AND task_id = ANY($1::text[])
             AND created_at < $2
         ) sub
         WHERE rn <= $3
         ORDER BY task_id, created_at ASC`,
        [taskIds, before, limit]
      );

      for (const row of result.rows) {
        const c = {
          id: row.id,
          author: row.author,
          content: row.content,
          createdAt: typeof row.created_at === 'string' ? parseInt(row.created_at, 10) : row.created_at,
          type: row.type || undefined,
          model: row.model || undefined,
          mentions: row.mentions || undefined,
          scope: {
            kind: row.scope_kind,
            taskId: row.task_id || undefined,
            sectionId: row.section_id || undefined,
            boardProjectId: row.board_project_id || undefined,
            dmThreadId: row.dm_thread_id || undefined,
          },
        };
        const bucket = out.get(row.task_id);
        if (bucket) bucket.push(c);
      }
      return out;
    } catch (e: any) {
      if (e.code === '42P01') return out; // table not yet created — return seeded empties
      throw e;
    } finally {
      client.release();
    }
  }

  /**
   * List distinct DM threads with last-message metadata.
   * Uses DISTINCT ON (dm_thread_id) to get one row per thread, ordered by created_at DESC.
   */
  async listDmThreads(forAgent?: string): Promise<{ threadId: string; participantIds: string[]; lastCommentAt: number; lastCommentPreview: string; lastCommentAuthor?: string }[]> {
    const pool = await this.getPool();
    const client = await pool.connect();
    try {
      const result = await client.query(
        `SELECT DISTINCT ON (dm_thread_id)
           dm_thread_id, author, content, created_at
         FROM org_studio_comments
         WHERE scope_kind = 'dm' AND dm_thread_id IS NOT NULL
         ORDER BY dm_thread_id, created_at DESC`
      );

      // Sort threads by last message timestamp DESC
      const rows = result.rows.sort((a: any, b: any) => {
        const aTs = typeof a.created_at === 'string' ? parseInt(a.created_at, 10) : a.created_at;
        const bTs = typeof b.created_at === 'string' ? parseInt(b.created_at, 10) : b.created_at;
        return bTs - aTs;
      });

      return rows.map((row: any) => {
        const threadId = row.dm_thread_id;
        // Extract participant IDs from thread ID: "dm::<id1>::<id2>"
        const parts = threadId.split('::');
        const participantIds = parts.length === 3 ? [parts[1], parts[2]] : [];
        const createdAt = typeof row.created_at === 'string' ? parseInt(row.created_at, 10) : row.created_at;
        const preview = (row.content || '').slice(0, 100);
        return {
          threadId,
          participantIds,
          lastCommentAt: createdAt,
          lastCommentPreview: preview,
          lastCommentAuthor: row.author || undefined,
        };
      });
    } catch (e: any) {
      if (e.code === '42P01') return []; // table not yet created
      throw e;
    } finally {
      client.release();
    }
  }

  async updateSettings(updates: Partial<Record<string, any>>): Promise<any> {
    const pool = await this.getPool();
    const client = await pool.connect();
    try {
      const result = await client.query(
        'SELECT data FROM org_studio_settings WHERE id = $1 AND workspace_id = $2',
        ['default', this.workspaceId]
      );
      const rawData = result.rows[0]?.data;
      const current = rawData
        ? (typeof rawData === 'string' ? JSON.parse(rawData) : rawData)
        : {};
      const updated = { ...current, ...updates };

      // #1388 A.4-schema: PK is (workspace_id, id).
      await client.query(
        'INSERT INTO org_studio_settings (id, data, workspace_id) VALUES ($1, $2, $3) ON CONFLICT (workspace_id, id) DO UPDATE SET data = $2',
        ['default', JSON.stringify(updated), this.workspaceId]
      );

      // Emit NOTIFY event for bidirectional sync
      const changePayload = JSON.stringify({
        type: 'settings_updated',
        timestamp: Date.now(),
        source: 'postgres',
      });
      try { await client.query(`NOTIFY org_studio_change, '${changePayload.replace(/'/g, "''")}'`); } catch {} // best-effort

      return updated;
    } finally {
      client.release();
    }
  }

  // --- Agent Metrics ---

  // --- Section CRUD (PostgresStoreProvider) ---
  // Sections live in the jsonb overflow `data` column — no schema change needed.

  async addSection(projectId: string, section: { id?: string; name: string; owner: string; outcomes: string; contract: string }): Promise<any> {
    const pool = await this.getPool();
    const client = await pool.connect();
    try {
      const result = await client.query('SELECT * FROM org_studio_projects WHERE id = $1 AND workspace_id = $2', [projectId, this.workspaceId]);
      if (result.rows.length === 0) throw new Error(`Project not found: ${projectId}`);
      const current = this.reconstructProject(result.rows[0]);
      const id = section.id || `sec-${Math.random().toString(36).slice(2, 10)}`;
      const newSection = { ...section, id };
      if (!current.sections) current.sections = [];
      current.sections.push(newSection);
      await this.updateProject(projectId, { sections: current.sections });
      return newSection;
    } finally {
      client.release();
    }
  }

  async updateSection(projectId: string, sectionId: string, updates: Partial<{ name: string; owner: string; outcomes: string; contract: string }>): Promise<void> {
    const pool = await this.getPool();
    const client = await pool.connect();
    try {
      const result = await client.query('SELECT * FROM org_studio_projects WHERE id = $1 AND workspace_id = $2', [projectId, this.workspaceId]);
      if (result.rows.length === 0) throw new Error(`Project not found: ${projectId}`);
      const current = this.reconstructProject(result.rows[0]);
      const section = (current.sections || []).find((s: any) => s.id === sectionId);
      if (!section) throw new Error(`Section not found: ${sectionId}`);
      Object.assign(section, updates);
      await this.updateProject(projectId, { sections: current.sections });
    } finally {
      client.release();
    }
  }

  async deleteSection(projectId: string, sectionId: string): Promise<void> {
    const pool = await this.getPool();
    const client = await pool.connect();
    try {
      const result = await client.query('SELECT * FROM org_studio_projects WHERE id = $1 AND workspace_id = $2', [projectId, this.workspaceId]);
      if (result.rows.length === 0) throw new Error(`Project not found: ${projectId}`);
      const current = this.reconstructProject(result.rows[0]);
      const sections = current.sections || [];
      const section = sections.find((s: any) => s.id === sectionId);
      if (!section) throw new Error(`Section not found: ${sectionId}`);
      // Count non-archived sections
      const activeCount = sections.filter((s: any) => !s.archivedAt).length;
      if (activeCount <= 1 && !section.archivedAt) throw new Error('Cannot delete the last section');
      // Soft-delete: set archivedAt instead of removing
      section.archivedAt = Date.now();
      section.archivedBy = 'user';
      await this.updateProject(projectId, { sections: current.sections });
    } finally {
      client.release();
    }
  }

  async purgeSection(projectId: string, sectionId: string): Promise<void> {
    const pool = await this.getPool();
    const client = await pool.connect();
    try {
      const result = await client.query('SELECT * FROM org_studio_projects WHERE id = $1 AND workspace_id = $2', [projectId, this.workspaceId]);
      if (result.rows.length === 0) throw new Error(`Project not found: ${projectId}`);
      const current = this.reconstructProject(result.rows[0]);
      const sections = current.sections || [];
      current.sections = sections.filter((s: any) => s.id !== sectionId);
      await this.updateProject(projectId, { sections: current.sections });
    } finally {
      client.release();
    }
  }

  async reorderSections(projectId: string, sectionIds: string[]): Promise<void> {
    const pool = await this.getPool();
    const client = await pool.connect();
    try {
      const result = await client.query('SELECT * FROM org_studio_projects WHERE id = $1 AND workspace_id = $2', [projectId, this.workspaceId]);
      if (result.rows.length === 0) throw new Error(`Project not found: ${projectId}`);
      const current = this.reconstructProject(result.rows[0]);
      const currentSections = current.sections || [];
      const map = new Map(currentSections.map((s: any) => [s.id, s]));
      const ordered = sectionIds.filter(id => map.has(id)).map(id => map.get(id)!);
      const rest = currentSections.filter((s: any) => !sectionIds.includes(s.id));
      current.sections = [...ordered, ...rest];
      await this.updateProject(projectId, { sections: current.sections });
    } finally {
      client.release();
    }
  }

  // --- Agent Metrics (continued) ---
  async upsertMetrics(agentId: string, date: string, metrics: Record<string, any>, sectionId?: string | null): Promise<any> {
    const pool = await this.getPool();
    const id = `${agentId}-${date}-${sectionId || 'all'}`;
    const {
      tasks_completed, tasks_started, avg_duration_min, median_duration_min, avg_gap_min,
      chain_rate, throughput, first_pass_rate, bounce_count, stall_count,
      comments_posted, mentions_received, mentions_sent, mention_response_min,
      kudos_count, flag_count, review_notes_rate, test_plan_rate, active_minutes,
      versions_completed, ...overflow
    } = metrics;
    const sectionVal = sectionId || null;
    // #1388 A.4-schema: include workspace_id in the INSERT — the new unique
    // index is (workspace_id, agent_id, date, COALESCE(section_id,'')) and
    // workspace_id is now NOT NULL.
    await pool.query(`
      INSERT INTO org_studio_agent_metrics (
        id, agent_id, date, section_id, workspace_id, tasks_completed, tasks_started, avg_duration_min,
        median_duration_min, avg_gap_min, chain_rate, throughput, first_pass_rate,
        bounce_count, stall_count, comments_posted, mentions_received, mentions_sent,
        mention_response_min, kudos_count, flag_count, review_notes_rate, test_plan_rate,
        active_minutes, versions_completed, data, updated_at)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16,
              $17, $18, $19, $20, $21, $22, $23, $24, $25, $26, NOW())
      ON CONFLICT (workspace_id, agent_id, date, COALESCE(section_id, '')) DO UPDATE SET
        tasks_completed = EXCLUDED.tasks_completed,
        tasks_started = EXCLUDED.tasks_started,
        avg_duration_min = EXCLUDED.avg_duration_min,
        median_duration_min = EXCLUDED.median_duration_min,
        avg_gap_min = EXCLUDED.avg_gap_min,
        chain_rate = EXCLUDED.chain_rate,
        throughput = EXCLUDED.throughput,
        first_pass_rate = EXCLUDED.first_pass_rate,
        bounce_count = EXCLUDED.bounce_count,
        stall_count = EXCLUDED.stall_count,
        comments_posted = EXCLUDED.comments_posted,
        mentions_received = EXCLUDED.mentions_received,
        mentions_sent = EXCLUDED.mentions_sent,
        mention_response_min = EXCLUDED.mention_response_min,
        kudos_count = EXCLUDED.kudos_count,
        flag_count = EXCLUDED.flag_count,
        review_notes_rate = EXCLUDED.review_notes_rate,
        test_plan_rate = EXCLUDED.test_plan_rate,
        active_minutes = EXCLUDED.active_minutes,
        versions_completed = EXCLUDED.versions_completed,
        data = EXCLUDED.data,
        updated_at = NOW()
    `, [
      id, agentId, date, sectionVal, this.workspaceId,
      tasks_completed || 0, tasks_started || 0,
      avg_duration_min || null, median_duration_min || null, avg_gap_min || null,
      chain_rate || null, throughput || null, first_pass_rate || null,
      bounce_count || 0, stall_count || 0, comments_posted || 0,
      mentions_received || 0, mentions_sent || 0, mention_response_min || null,
      kudos_count || 0, flag_count || 0, review_notes_rate || null,
      test_plan_rate || null, active_minutes || 0, versions_completed || 0,
      JSON.stringify(overflow),
    ]);
    return { id, agentId, date, sectionId: sectionVal, ...metrics };
  }

  async getMetrics(agentId: string, opts?: { from?: string; to?: string; limit?: number; sectionId?: string }): Promise<any[]> {
    const pool = await this.getPool();
    // #1388 A.4-schema: filter by workspace_id (PK includes it now).
    const conditions = ['workspace_id = $1', 'agent_id = $2'];
    const params: any[] = [this.workspaceId, agentId];
    let paramIdx = 3;
    if (opts?.from) { conditions.push(`date >= $${paramIdx}`); params.push(opts.from); paramIdx++; }
    if (opts?.to) { conditions.push(`date <= $${paramIdx}`); params.push(opts.to); paramIdx++; }
    // Section filtering: default (undefined) = agent-wide rows only (section_id IS NULL)
    // '__all' = all rows; specific value = that section only
    if (opts?.sectionId === '__all') {
      // No section filter — return all rows
    } else if (opts?.sectionId) {
      conditions.push(`section_id = $${paramIdx}`); params.push(opts.sectionId); paramIdx++;
    } else {
      conditions.push('section_id IS NULL');
    }
    const limit = opts?.limit || 90;
    const result = await pool.query(
      `SELECT * FROM org_studio_agent_metrics WHERE ${conditions.join(' AND ')} ORDER BY date DESC LIMIT ${limit}`,
      params
    );
    return result.rows.map((row: any) => ({
      id: row.id,
      agentId: row.agent_id,
      date: row.date,
      sectionId: row.section_id || null,
      tasksCompleted: row.tasks_completed,
      tasksStarted: row.tasks_started,
      avgDurationMin: parseFloat(row.avg_duration_min) || null,
      medianDurationMin: parseFloat(row.median_duration_min) || null,
      avgGapMin: parseFloat(row.avg_gap_min) || null,
      chainRate: parseFloat(row.chain_rate) || null,
      throughput: parseFloat(row.throughput) || null,
      firstPassRate: parseFloat(row.first_pass_rate) || null,
      bounceCount: row.bounce_count,
      stallCount: row.stall_count,
      commentsPosted: row.comments_posted,
      mentionsReceived: row.mentions_received,
      mentionsSent: row.mentions_sent,
      mentionResponseMin: parseFloat(row.mention_response_min) || null,
      kudosCount: row.kudos_count,
      flagCount: row.flag_count,
      reviewNotesRate: parseFloat(row.review_notes_rate) || null,
      testPlanRate: parseFloat(row.test_plan_rate) || null,
      activeMinutes: row.active_minutes,
      versionsCompleted: row.versions_completed,
      data: typeof row.data === 'string' ? JSON.parse(row.data) : (row.data || {}),
    }));
  }

  async getTeamMetrics(opts?: { from?: string; to?: string; sectionId?: string }): Promise<any[]> {
    const pool = await this.getPool();
    // #1388 A.4-schema: scope to this workspace.
    const conditions: string[] = ['workspace_id = $1'];
    const params: any[] = [this.workspaceId];
    let paramIdx = 2;
    if (opts?.from) { conditions.push(`date >= $${paramIdx}`); params.push(opts.from); paramIdx++; }
    if (opts?.to) { conditions.push(`date <= $${paramIdx}`); params.push(opts.to); paramIdx++; }
    // Section filtering for team metrics
    if (opts?.sectionId === '__all') {
      // No filter
    } else if (opts?.sectionId) {
      conditions.push(`section_id = $${paramIdx}`); params.push(opts.sectionId); paramIdx++;
    } else {
      // Default: agent-wide aggregates only (exclude per-section rows)
      conditions.push('section_id IS NULL');
    }
    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const result = await pool.query(
      `SELECT agent_id,
        SUM(tasks_completed) as total_completed,
        SUM(tasks_started) as total_started,
        AVG(avg_duration_min) as avg_duration,
        AVG(chain_rate) as avg_chain_rate,
        AVG(throughput) as avg_throughput,
        AVG(first_pass_rate) as avg_first_pass,
        SUM(bounce_count) as total_bounces,
        SUM(stall_count) as total_stalls,
        SUM(comments_posted) as total_comments,
        SUM(kudos_count) as total_kudos,
        SUM(flag_count) as total_flags,
        COUNT(DISTINCT date) as active_days
      FROM org_studio_agent_metrics ${where}
      GROUP BY agent_id
      ORDER BY total_completed DESC`,
      params
    );
    return result.rows.map((row: any) => ({
      agentId: row.agent_id,
      totalCompleted: parseInt(row.total_completed) || 0,
      totalStarted: parseInt(row.total_started) || 0,
      avgDuration: parseFloat(row.avg_duration) || null,
      avgChainRate: parseFloat(row.avg_chain_rate) || null,
      avgThroughput: parseFloat(row.avg_throughput) || null,
      avgFirstPass: parseFloat(row.avg_first_pass) || null,
      totalBounces: parseInt(row.total_bounces) || 0,
      totalStalls: parseInt(row.total_stalls) || 0,
      totalComments: parseInt(row.total_comments) || 0,
      totalKudos: parseInt(row.total_kudos) || 0,
      totalFlags: parseInt(row.total_flags) || 0,
      activeDays: parseInt(row.active_days) || 0,
    }));
  }

  async health(): Promise<boolean> {
    try {
      const pool = await this.getPool();
      const client = await pool.connect();
      try {
        await client.query('SELECT 1');
        return true;
      } finally {
        client.release();
      }
    } catch {
      return false;
    }
  }

  async close(): Promise<void> {
    if (this.pool) {
      await this.pool.end();
    }
  }
}

/**
 * Factory function to create the right provider based on environment
 */
export function createStoreProvider(workspaceId: string = 'default-workspace'): StoreProvider {
  const dbUrl = process.env.DATABASE_URL;
  const storePath = process.env.STORE_PATH || join(process.cwd(), 'data', 'store.json');

  if (dbUrl) {
    console.log('Using Postgres store provider');
    return new PostgresStoreProvider(dbUrl, workspaceId);
  }

  console.log('Using file store provider');
  return new FileStoreProvider(storePath);
}

// Per-workspace provider cache.
// In OSS mode (no DATABASE_URL) all workspace ids map to a single FileStoreProvider
// because the file-store's envelope is keyed by data.activeWorkspace, not by
// constructor arg — callers that need cross-workspace behaviour in OSS rewrite
// the active slice via setActiveWorkspace().
//
// In Postgres mode we keep one PostgresStoreProvider per workspaceId so each
// instance carries its own this.workspaceId. The underlying connection pool
// is process-singleton inside PostgresStoreProvider itself; per-workspace
// instances are cheap.
const instances = new Map<string, StoreProvider>();
let fileInstance: StoreProvider | null = null;
let allWorkspacesInstance: StoreProvider | null = null;

/**
 * Get a workspace-scoped StoreProvider.
 *
 * #1387 slice A.1: This function used to return a process-singleton pinned to
 * 'default-workspace'. It now requires the workspaceId of the request so each
 * caller's reads/writes are scoped to its tenant.
 *
 * @param workspaceId  The workspace this provider is scoped to. Required.
 *                     Callers in request handlers should pass the value
 *                     returned by `resolveWorkspaceContext(req, userId)`
 *                     from `@/lib/workspace-auth`.
 */
export function getStoreProvider(workspaceId: string): StoreProvider {
  if (!workspaceId) {
    throw new Error(
      '[store-provider] getStoreProvider(workspaceId) requires a workspaceId. ' +
      'For genuinely cross-workspace callers (admin, cron, principles aggregator), ' +
      'use getStoreProviderAllWorkspaces() — a deliberate, named escape hatch.'
    );
  }
  // OSS / file-store mode: the FileStoreProvider operates on the active
  // workspace slice of store.json, which is process-global. One instance
  // suffices regardless of the workspaceId argument.
  if (!process.env.DATABASE_URL) {
    if (!fileInstance) fileInstance = createStoreProvider(workspaceId);
    return fileInstance;
  }
  let inst = instances.get(workspaceId);
  if (!inst) {
    inst = createStoreProvider(workspaceId);
    instances.set(workspaceId, inst);
  }
  return inst;
}

/**
 * Escape hatch: returns a provider that does NOT scope reads/writes by
 * workspace. Intended for genuinely cross-workspace callers:
 *   - Admin endpoints under /api/admin/* (slice B will re-gate these)
 *   - Cron / scheduler iterators that fan out per workspace
 *   - principles-generator (TODO(#1387 A.3): per-workspace filter)
 *
 * Implementation: returns a Postgres provider with workspaceId='*' so that
 * downstream queries that interpolate `WHERE workspace_id = $1` filter on
 * a sentinel that should match no real row. Callers that need actual
 * cross-workspace reads should issue raw queries via getRawPool() (TODO
 * follow-up) or use the lower-level pg pool directly.
 *
 * For OSS mode, returns the same single file-store instance as
 * getStoreProvider() — OSS only has one workspace.
 */
export function getStoreProviderAllWorkspaces(): StoreProvider {
  if (!process.env.DATABASE_URL) {
    if (!fileInstance) fileInstance = createStoreProvider('default-workspace');
    return fileInstance;
  }
  if (!allWorkspacesInstance) {
    // Use 'default-workspace' as the scope so the provider's standard
    // write paths remain safe (no accidental cross-workspace mutation
    // via the convenience API). Cross-workspace reads should go through
    // raw SQL on the provider's underlying pool, not through .read().
    // This mirrors how the singleton behaved pre-#1387 — reads are
    // default-workspace-only — but with an explicit, named opt-in so we
    // can audit callers.
    allWorkspacesInstance = createStoreProvider('default-workspace');
  }
  return allWorkspacesInstance;
}

// Re-export for convenience
export { join } from 'path';
