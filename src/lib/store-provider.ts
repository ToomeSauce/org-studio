/**
 * Store Provider abstraction layer
 * 
 * Allows swapping between file-based (JSON) and Postgres storage without changing routes or UI.
 * Implements CRUD operations for projects and tasks.
 */

import { join } from 'path';

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

  constructor(storePath: string, backupDir?: string) {
    this.storePath = storePath;
    this.backupDir = backupDir || storePath.replace(/store\.json$/, 'backups');
  }

  async read(): Promise<StoreData> {
    const { existsSync, readFileSync } = require('fs');
    const { dirname } = require('path');
    
    if (!existsSync(this.storePath)) {
      // Return empty store structure
      return { projects: [], tasks: [], settings: {} };
    }

    try {
      const content = readFileSync(this.storePath, 'utf-8');
      const data = JSON.parse(content);
      // Inject default "Main" section for projects missing sections
      if (data.projects) {
        for (const p of data.projects) {
          if (!p.sections || p.sections.length === 0) {
            p.sections = [{ id: `sec-main-${p.id}`, name: 'Main', owner: p.owner || '', outcomes: '', contract: '' }];
          }
        }
      }
      return data;
    } catch (e) {
      console.error(`Failed to read store at ${this.storePath}:`, e);
      return { projects: [], tasks: [], settings: {} };
    }
  }

  async write(data: StoreData): Promise<void> {
    const { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync, unlinkSync, copyFileSync } = require('fs');
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
      // Don't block write on backup failure
    }

    try {
      writeFileSync(this.storePath, JSON.stringify(data, null, 2));
    } catch (e) {
      console.error(`Failed to write store to ${this.storePath}:`, e);
      throw e;
    }
  }

  async createProject(project: any): Promise<any> {
    const store = await this.read();
    project.id = project.id || `proj-${Date.now()}`;
    project.createdAt = project.createdAt || Date.now();
    store.projects.push(project);
    await this.write(store);
    return project;
  }

  async updateProject(projectId: string, updates: Partial<any>): Promise<any> {
    const store = await this.read();
    const idx = store.projects.findIndex((p: any) => p.id === projectId);
    if (idx === -1) throw new Error(`Project not found: ${projectId}`);
    store.projects[idx] = { ...store.projects[idx], ...updates };
    await this.write(store);
    return store.projects[idx];
  }

  async deleteProject(projectId: string): Promise<void> {
    const store = await this.read();
    store.projects = store.projects.filter((p: any) => p.id !== projectId);
    await this.write(store);
  }

  async createTask(task: any): Promise<any> {
    const store = await this.read();
    task.id = task.id || `task-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    task.createdAt = task.createdAt || Date.now();
    store.tasks.push(task);
    await this.write(store);
    return task;
  }

  async updateTask(taskId: string, updates: Partial<any>): Promise<any> {
    const store = await this.read();
    const idx = store.tasks.findIndex((t: any) => t.id === taskId);
    if (idx === -1) throw new Error(`Task not found: ${taskId}`);
    store.tasks[idx] = { ...store.tasks[idx], ...updates };
    await this.write(store);
    return store.tasks[idx];
  }

  async deleteTask(taskId: string): Promise<void> {
    const store = await this.read();
    store.tasks = store.tasks.filter((t: any) => t.id !== taskId);
    await this.write(store);
  }

  async addComment(taskIdOrScope: string | { kind: string; taskId?: string; sectionId?: string; boardProjectId?: string; dmThreadId?: string }, comment: any): Promise<any> {
    // Normalize: extract taskId from legacy or new-style call
    const scope = typeof taskIdOrScope === 'string'
      ? { kind: 'task' as const, taskId: taskIdOrScope }
      : taskIdOrScope;

    // For task-scoped comments, write inline on the task (FileStore only supports tasks)
    if (scope.kind === 'task' && scope.taskId) {
      const store = await this.read();
      const task = store.tasks.find((t: any) => t.id === scope.taskId);
      if (!task) throw new Error(`Task not found: ${scope.taskId}`);

      if (!task.comments) task.comments = [];
      comment.id = comment.id || `comment-${Date.now()}`;
      comment.createdAt = comment.createdAt || Date.now();
      if (!comment.scope) comment.scope = scope;
      task.comments.push(comment);

      await this.write(store);
      return comment;
    }

    // Non-task scopes: FileStoreProvider doesn't have a comments table.
    // Store in a best-effort in-memory way (not persisted — Postgres is needed for non-task scopes).
    comment.id = comment.id || `comment-${Date.now()}`;
    comment.createdAt = comment.createdAt || Date.now();
    if (!comment.scope) comment.scope = scope;
    return comment;
  }

  async updateSettings(updates: Partial<Record<string, any>>): Promise<any> {
    const store = await this.read();
    if (!store.settings) store.settings = {};
    store.settings = { ...store.settings, ...updates };
    await this.write(store);
    return store.settings;
  }

  // --- Section CRUD (FileStoreProvider) ---

  async addSection(projectId: string, section: { id?: string; name: string; owner: string; outcomes: string; contract: string }): Promise<any> {
    const store = await this.read();
    const project = store.projects.find((p: any) => p.id === projectId);
    if (!project) throw new Error(`Project not found: ${projectId}`);
    const id = section.id || `sec-${Math.random().toString(36).slice(2, 10)}`;
    const newSection = { ...section, id };
    if (!project.sections) project.sections = [];
    project.sections.push(newSection);
    await this.write(store);
    return newSection;
  }

  async updateSection(projectId: string, sectionId: string, updates: Partial<{ name: string; owner: string; outcomes: string; contract: string }>): Promise<void> {
    const store = await this.read();
    const project = store.projects.find((p: any) => p.id === projectId);
    if (!project) throw new Error(`Project not found: ${projectId}`);
    const section = (project.sections || []).find((s: any) => s.id === sectionId);
    if (!section) throw new Error(`Section not found: ${sectionId}`);
    Object.assign(section, updates);
    await this.write(store);
  }

  async deleteSection(projectId: string, sectionId: string): Promise<void> {
    const store = await this.read();
    const project = store.projects.find((p: any) => p.id === projectId);
    if (!project) throw new Error(`Project not found: ${projectId}`);
    const sections = project.sections || [];
    const section = sections.find((s: any) => s.id === sectionId);
    if (!section) throw new Error(`Section not found: ${sectionId}`);
    // Count non-archived sections
    const activeCount = sections.filter((s: any) => !s.archivedAt).length;
    if (activeCount <= 1 && !section.archivedAt) throw new Error('Cannot delete the last section');
    // Soft-delete: set archivedAt instead of removing
    section.archivedAt = Date.now();
    section.archivedBy = 'user';
    await this.write(store);
  }

  async purgeSection(projectId: string, sectionId: string): Promise<void> {
    const store = await this.read();
    const project = store.projects.find((p: any) => p.id === projectId);
    if (!project) throw new Error(`Project not found: ${projectId}`);
    const sections = project.sections || [];
    project.sections = sections.filter((s: any) => s.id !== sectionId);
    await this.write(store);
  }

  async reorderSections(projectId: string, sectionIds: string[]): Promise<void> {
    const store = await this.read();
    const project = store.projects.find((p: any) => p.id === projectId);
    if (!project) throw new Error(`Project not found: ${projectId}`);
    const current = project.sections || [];
    const map = new Map(current.map((s: any) => [s.id, s]));
    const ordered = sectionIds.filter(id => map.has(id)).map(id => map.get(id)!);
    const rest = current.filter((s: any) => !sectionIds.includes(s.id));
    project.sections = [...ordered, ...rest];
    await this.write(store);
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
      });
    }
    return this.pool;
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
    const overflow = typeof row.data === 'string' ? JSON.parse(row.data) : (row.data || {});
    const obj: Record<string, any> = {
      id: row.id,
      name: row.name,
      description: row.description,
      phase: row.phase,
      owner: row.owner,
      priority: row.priority,
      sortOrder: row.sort_order,
      createdAt: this.parseBigint(row.created_at),
      createdBy: row.created_by,
      ...overflow,
    };
    // Remove keys that are undefined (not null — null is valid)
    const cleaned = Object.fromEntries(Object.entries(obj).filter(([_, v]) => v !== undefined));
    // Inject default "Main" section if sections missing or empty
    if (!cleaned.sections || (Array.isArray(cleaned.sections) && cleaned.sections.length === 0)) {
      cleaned.sections = [{ id: `sec-main-${row.id}`, name: 'Main', owner: row.owner || '', outcomes: '', contract: '' }];
    }
    return cleaned;
  }

  /**
   * Reconstruct a task object from DB row, merging typed columns with overflow data.
   * BIGINT columns are coerced back to numbers. Null fields are preserved (matches file store).
   */
  private reconstructTask(row: any): any {
    const overflow = typeof row.data === 'string' ? JSON.parse(row.data) : (row.data || {});
    const statusHistory = typeof row.status_history === 'string' ? JSON.parse(row.status_history) : (row.status_history || []);
    const comments = typeof row.comments === 'string' ? JSON.parse(row.comments) : (row.comments || []);
    
    const obj: Record<string, any> = {
      id: row.id,
      ticketNumber: row.ticket_number,
      title: row.title,
      status: row.status,
      projectId: row.project_id,
      assignee: row.assignee,
      priority: row.priority,
      testType: row.test_type,
      testAssignee: row.test_assignee,
      initiatedBy: row.initiated_by,
      description: row.description,
      doneWhen: row.done_when,
      constraints: row.constraints,
      testPlan: row.test_plan,
      reviewNotes: row.review_notes,
      loopCount: row.loop_count,
      loopPausedAt: this.parseBigint(row.loop_paused_at),
      loopPauseReason: row.loop_pause_reason,
      lastActivityAt: this.parseBigint(row.last_activity_at),
      createdAt: this.parseBigint(row.created_at),
      version: row.version,
      statusHistory,
      comments,
      ...overflow,
    };
    // Remove keys that are undefined (not null — null is intentional data)
    return Object.fromEntries(Object.entries(obj).filter(([_, v]) => v !== undefined));
  }

  async read(): Promise<StoreData> {
    const pool = await this.getPool();
    const client = await pool.connect();
    try {
      const projectsResult = await client.query(
        'SELECT * FROM org_studio_projects WHERE workspace_id = $1 ORDER BY created_at',
        [this.workspaceId]
      );
      const tasksResult = await client.query(
        'SELECT * FROM org_studio_tasks WHERE workspace_id = $1 ORDER BY created_at',
        [this.workspaceId]
      );
      const settingsResult = await client.query(
        'SELECT data FROM org_studio_settings WHERE id = $1 AND workspace_id = $2',
        ['default', this.workspaceId]
      );

      const projects = projectsResult.rows.map((row: any) => this.reconstructProject(row));
      const tasks = tasksResult.rows.map((row: any) => this.reconstructTask(row));
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

  async write(data: StoreData): Promise<void> {
    const pool = await this.getPool();
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      // Clear and rewrite projects (scoped to workspace)
      await client.query('DELETE FROM org_studio_projects WHERE workspace_id = $1', [this.workspaceId]);
      for (const project of data.projects) {
        const {
          id,
          name,
          description,
          phase,
          owner,
          priority,
          sortOrder,
          createdAt,
          createdBy,
          ...overflow
        } = project;

        await client.query(
          `INSERT INTO org_studio_projects
           (id, name, description, phase, owner, priority, sort_order, created_at, created_by, data, workspace_id)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
          [
            id,
            name || null,
            description || null,
            phase || 'active',
            owner || null,
            priority || null,
            sortOrder || 5000,
            createdAt || null,
            createdBy || null,
            JSON.stringify(overflow),
            this.workspaceId,
          ]
        );
      }

      // Clear and rewrite tasks (scoped to workspace)
      await client.query('DELETE FROM org_studio_tasks WHERE workspace_id = $1', [this.workspaceId]);
      for (const task of data.tasks) {
        const {
          id,
          ticketNumber,
          title,
          status,
          projectId,
          assignee,
          priority,
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
          ...overflow
        } = task;

        await client.query(
          `INSERT INTO org_studio_tasks
           (id, ticket_number, title, status, project_id, assignee, priority, test_type, test_assignee,
            initiated_by, description, done_when, constraints, test_plan, review_notes, loop_count,
            loop_paused_at, loop_pause_reason, last_activity_at, created_at, status_history, comments, data, workspace_id)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, $24)`,
          [
            id,
            ticketNumber || null,
            title || null,
            status || 'backlog',
            projectId || null,
            assignee || null,
            priority || null,
            testType || null,
            testAssignee || null,
            initiatedBy || null,
            description || null,
            doneWhen || null,
            constraints || null,
            testPlan || null,
            reviewNotes || null,
            loopCount || 0,
            loopPausedAt || null,
            loopPauseReason || null,
            lastActivityAt || null,
            createdAt || null,
            JSON.stringify(statusHistory || []),
            JSON.stringify(comments || []),
            JSON.stringify(overflow),
            this.workspaceId,
          ]
        );
      }

      // Update settings (scoped to workspace)
      await client.query(
        'INSERT INTO org_studio_settings (id, data, workspace_id) VALUES ($1, $2, $3) ON CONFLICT (id) DO UPDATE SET data = $2',
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

      const {
        id: _,
        createdAt: __,
        createdBy: ___,
        name,
        description,
        phase,
        owner,
        priority,
        sortOrder,
        ...overflow
      } = project;

      await client.query(
        `INSERT INTO org_studio_projects
         (id, name, description, phase, owner, priority, sort_order, created_at, created_by, data, workspace_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
        [
          id,
          name || null,
          description || null,
          phase || 'active',
          owner || null,
          priority || null,
          sortOrder || 5000,
          createdAt,
          createdBy,
          JSON.stringify(overflow),
          this.workspaceId,
        ]
      );

      return {
        id,
        createdAt,
        createdBy,
        name,
        description,
        phase,
        owner,
        priority,
        sortOrder,
        ...overflow,
      };
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

      const {
        id,
        name,
        description,
        phase,
        owner,
        priority,
        sortOrder,
        createdAt,
        createdBy,
        ...overflow
      } = updated;

      await client.query(
        `UPDATE org_studio_projects
         SET name = $1, description = $2, phase = $3, owner = $4, priority = $5,
             sort_order = $6, created_at = $7, created_by = $8, data = $9
         WHERE id = $10 AND workspace_id = $11`,
        [
          name || null,
          description || null,
          phase || 'active',
          owner || null,
          priority || null,
          sortOrder || 5000,
          createdAt || null,
          createdBy || null,
          JSON.stringify(overflow),
          id,
          this.workspaceId,
        ]
      );

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

      const {
        id: _,
        createdAt: __,
        createdBy: ___,
        ticketNumber,
        title,
        status,
        projectId,
        assignee,
        priority,
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
        statusHistory,
        comments,
        ...overflow
      } = task;

      await client.query(
        `INSERT INTO org_studio_tasks
         (id, ticket_number, title, status, project_id, assignee, priority, test_type, test_assignee,
          initiated_by, description, done_when, constraints, test_plan, review_notes, loop_count,
          loop_paused_at, loop_pause_reason, last_activity_at, created_at, status_history, comments, data, workspace_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, $24)`,
        [
          id,
          ticketNumber || null,
          title || null,
          status || 'backlog',
          projectId || null,
          assignee || null,
          priority || null,
          testType || null,
          testAssignee || null,
          initiatedBy || null,
          description || null,
          doneWhen || null,
          constraints || null,
          testPlan || null,
          reviewNotes || null,
          loopCount || 0,
          loopPausedAt || null,
          loopPauseReason || null,
          lastActivityAt || null,
          createdAt,
          JSON.stringify(statusHistory || []),
          JSON.stringify(comments || []),
          JSON.stringify(overflow),
          this.workspaceId,
        ]
      );

      return {
        id,
        createdAt,
        createdBy,
        ticketNumber,
        title,
        status,
        projectId,
        assignee,
        priority,
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
        statusHistory,
        comments,
        ...overflow,
      };

      // Emit NOTIFY for task creation — triggers agent dispatch on local server
      const changePayload = JSON.stringify({
        type: 'task_created',
        taskId: id,
        status: status || 'backlog',
        assignee: assignee || null,
        projectId: projectId || null,
        timestamp: Date.now(),
        source: 'postgres',
      });
      try { await client.query(`NOTIFY org_studio_change, '${changePayload.replace(/'/g, "''")}'`); } catch {} // best-effort

      return {
        id, createdAt, createdBy, ticketNumber, title, status, projectId, assignee, priority,
        testType, testAssignee, initiatedBy, description, doneWhen, constraints, testPlan,
        reviewNotes, loopCount, loopPausedAt, loopPauseReason, lastActivityAt, statusHistory,
        comments, ...overflow,
      };
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

      const {
        id,
        ticketNumber,
        title,
        status,
        projectId,
        assignee,
        priority,
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
        version,
        statusHistory,
        comments,
        ...overflow
      } = updated;

      await client.query(
        `UPDATE org_studio_tasks
         SET ticket_number = $1, title = $2, status = $3, project_id = $4, assignee = $5,
             priority = $6, test_type = $7, test_assignee = $8, initiated_by = $9, description = $10,
             done_when = $11, constraints = $12, test_plan = $13, review_notes = $14, loop_count = $15,
             loop_paused_at = $16, loop_pause_reason = $17, last_activity_at = $18, created_at = $19,
             version = $20, status_history = $21, comments = $22, data = $23
         WHERE id = $24 AND workspace_id = $25`,
        [
          ticketNumber || null,
          title || null,
          status || 'backlog',
          projectId || null,
          assignee || null,
          priority || null,
          testType || null,
          testAssignee || null,
          initiatedBy || null,
          description || null,
          doneWhen || null,
          constraints || null,
          testPlan || null,
          reviewNotes || null,
          loopCount || 0,
          loopPausedAt || null,
          loopPauseReason || null,
          lastActivityAt || null,
          createdAt || null,
          version || null,
          JSON.stringify(statusHistory || []),
          JSON.stringify(comments || []),
          JSON.stringify(overflow),
          id,
          this.workspaceId,
        ]
      );

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
            JSON.stringify({ scope: commentObj.scope }),
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
        current.comments.push(commentObj);

        const {
          id,
          ticketNumber,
          title,
          status,
          projectId,
          assignee,
          priority,
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
      // Reverse to ASC for rendering
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

      await client.query(
        'INSERT INTO org_studio_settings (id, data, workspace_id) VALUES ($1, $2, $3) ON CONFLICT (id) DO UPDATE SET data = $2',
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
    await pool.query(`
      INSERT INTO org_studio_agent_metrics (
        id, agent_id, date, section_id, tasks_completed, tasks_started, avg_duration_min,
        median_duration_min, avg_gap_min, chain_rate, throughput, first_pass_rate,
        bounce_count, stall_count, comments_posted, mentions_received, mentions_sent,
        mention_response_min, kudos_count, flag_count, review_notes_rate, test_plan_rate,
        active_minutes, versions_completed, data, updated_at)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16,
              $17, $18, $19, $20, $21, $22, $23, $24, $25, NOW())
      ON CONFLICT (agent_id, date, COALESCE(section_id, '')) DO UPDATE SET
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
      id, agentId, date, sectionVal,
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
    const conditions = ['agent_id = $1'];
    const params: any[] = [agentId];
    let paramIdx = 2;
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
    const conditions: string[] = [];
    const params: any[] = [];
    let paramIdx = 1;
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

// Singleton instance
let instance: StoreProvider | null = null;

export function getStoreProvider(): StoreProvider {
  if (!instance) {
    instance = createStoreProvider();
  }
  return instance;
}

// Re-export for convenience
export { join } from 'path';
