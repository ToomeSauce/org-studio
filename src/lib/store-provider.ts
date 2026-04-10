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
   * Add a comment to a task
   */
  addComment(taskId: string, comment: any): Promise<any>;

  /**
   * Update settings (mission statement, values, teammates, etc.)
   */
  updateSettings(updates: Partial<Record<string, any>>): Promise<any>;

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
      return JSON.parse(content);
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

  async addComment(taskId: string, comment: any): Promise<any> {
    const store = await this.read();
    const task = store.tasks.find((t: any) => t.id === taskId);
    if (!task) throw new Error(`Task not found: ${taskId}`);

    if (!task.comments) task.comments = [];
    comment.id = comment.id || `comment-${Date.now()}`;
    comment.createdAt = comment.createdAt || Date.now();
    task.comments.push(comment);

    await this.write(store);
    return comment;
  }

  async updateSettings(updates: Partial<Record<string, any>>): Promise<any> {
    const store = await this.read();
    if (!store.settings) store.settings = {};
    store.settings = { ...store.settings, ...updates };
    await this.write(store);
    return store.settings;
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

  constructor(connectionString: string) {
    this.connectionString = connectionString;
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
    return Object.fromEntries(Object.entries(obj).filter(([_, v]) => v !== undefined));
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
        'SELECT * FROM org_studio_projects ORDER BY created_at'
      );
      const tasksResult = await client.query(
        'SELECT * FROM org_studio_tasks ORDER BY created_at'
      );
      const settingsResult = await client.query(
        'SELECT data FROM org_studio_settings WHERE id = $1',
        ['default']
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

      // Clear and rewrite projects
      await client.query('DELETE FROM org_studio_projects');
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
           (id, name, description, phase, owner, priority, sort_order, created_at, created_by, data)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
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
          ]
        );
      }

      // Clear and rewrite tasks
      await client.query('DELETE FROM org_studio_tasks');
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
            loop_paused_at, loop_pause_reason, last_activity_at, created_at, status_history, comments, data)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23)`,
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
          ]
        );
      }

      // Update settings
      await client.query(
        'INSERT INTO org_studio_settings (id, data) VALUES ($1, $2) ON CONFLICT (id) DO UPDATE SET data = $2',
        ['default', JSON.stringify(data.settings || {})]
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
         (id, name, description, phase, owner, priority, sort_order, created_at, created_by, data)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
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
        'SELECT * FROM org_studio_projects WHERE id = $1',
        [projectId]
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
         WHERE id = $10`,
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
      await client.query('DELETE FROM org_studio_projects WHERE id = $1', [projectId]);
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
          loop_paused_at, loop_pause_reason, last_activity_at, created_at, status_history, comments, data)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23)`,
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
        'SELECT * FROM org_studio_tasks WHERE id = $1',
        [taskId]
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
         WHERE id = $24`,
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
      await client.query('DELETE FROM org_studio_tasks WHERE id = $1', [taskId]);
    } finally {
      client.release();
    }
  }

  async addComment(taskId: string, comment: any): Promise<any> {
    const pool = await this.getPool();
    const client = await pool.connect();
    try {
      const result = await client.query(
        'SELECT * FROM org_studio_tasks WHERE id = $1',
        [taskId]
      );
      if (result.rows.length === 0) throw new Error(`Task not found: ${taskId}`);

      const current = this.reconstructTask(result.rows[0]);
      if (!current.comments) current.comments = [];

      const commentObj = {
        id: comment.id || `comment-${Date.now()}`,
        createdAt: comment.createdAt || Date.now(),
        ...comment,
      };
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

      // Emit NOTIFY event for bidirectional sync
      const changePayload = JSON.stringify({
        type: 'comment_added',
        taskId: id,
        timestamp: Date.now(),
        source: 'postgres',
      });
      try { await client.query(`NOTIFY org_studio_change, '${changePayload.replace(/'/g, "''")}'`); } catch {} // best-effort

      return commentObj;
    } finally {
      client.release();
    }
  }

  async updateSettings(updates: Partial<Record<string, any>>): Promise<any> {
    const pool = await this.getPool();
    const client = await pool.connect();
    try {
      const result = await client.query(
        'SELECT data FROM org_studio_settings WHERE id = $1',
        ['default']
      );
      const rawData = result.rows[0]?.data;
      const current = rawData
        ? (typeof rawData === 'string' ? JSON.parse(rawData) : rawData)
        : {};
      const updated = { ...current, ...updates };

      await client.query(
        'INSERT INTO org_studio_settings (id, data) VALUES ($1, $2) ON CONFLICT (id) DO UPDATE SET data = $2',
        ['default', JSON.stringify(updated)]
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
export function createStoreProvider(): StoreProvider {
  const dbUrl = process.env.DATABASE_URL;
  const storePath = process.env.STORE_PATH || join(process.cwd(), 'data', 'store.json');

  if (dbUrl) {
    console.log('Using Postgres store provider');
    return new PostgresStoreProvider(dbUrl);
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
