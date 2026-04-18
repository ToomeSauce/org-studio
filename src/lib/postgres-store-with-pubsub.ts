/**
 * postgres-store-with-pubsub.ts
 * 
 * Enhanced PostgresStoreProvider that publishes change notifications
 * when tasks/projects are created, updated, or deleted.
 * 
 * This allows remote instances to stay in sync via Postgres LISTEN/NOTIFY.
 */

import type { StoreProvider, StoreData } from './store-provider';
import { PostgresStoreProvider } from './store-provider';
import type { PostgresPubSub } from './postgres-pubsub';

export class PostgresStoreProviderWithPubSub implements StoreProvider {
  private baseProvider: PostgresStoreProvider;
  private pubsub: PostgresPubSub | null = null;

  constructor(baseProvider: PostgresStoreProvider, pubsub?: PostgresPubSub) {
    this.baseProvider = baseProvider;
    this.pubsub = pubsub || null;
  }

  setPubSub(pubsub: PostgresPubSub) {
    this.pubsub = pubsub;
  }

  // Delegate all methods to base provider, adding pub/sub notifications

  async read(): Promise<StoreData> {
    return await this.baseProvider.read();
  }

  async write(data: StoreData): Promise<void> {
    return await this.baseProvider.write(data);
  }

  async createProject(project: any): Promise<any> {
    const result = await this.baseProvider.createProject(project);
    if (this.pubsub) {
      await this.pubsub.notifyChange('projects', 'create', project.id);
    }
    return result;
  }

  async updateProject(projectId: string, updates: Partial<any>): Promise<any> {
    const result = await this.baseProvider.updateProject(projectId, updates);
    if (this.pubsub) {
      await this.pubsub.notifyChange('projects', 'update', projectId);
    }
    return result;
  }

  async deleteProject(projectId: string): Promise<void> {
    const result = await this.baseProvider.deleteProject(projectId);
    if (this.pubsub) {
      await this.pubsub.notifyChange('projects', 'delete', projectId);
    }
    return result;
  }

  async createTask(task: any): Promise<any> {
    const result = await this.baseProvider.createTask(task);
    if (this.pubsub) {
      await this.pubsub.notifyChange('tasks', 'create', task.id);
    }
    return result;
  }

  async updateTask(taskId: string, updates: Partial<any>): Promise<any> {
    const result = await this.baseProvider.updateTask(taskId, updates);
    if (this.pubsub) {
      await this.pubsub.notifyChange('tasks', 'update', taskId);
    }
    return result;
  }

  async deleteTask(taskId: string): Promise<void> {
    const result = await this.baseProvider.deleteTask(taskId);
    if (this.pubsub) {
      await this.pubsub.notifyChange('tasks', 'delete', taskId);
    }
    return result;
  }

  async addComment(taskIdOrScope: string | { kind: string; taskId?: string; sectionId?: string; boardProjectId?: string; dmThreadId?: string }, comment: any): Promise<any> {
    const result = await this.baseProvider.addComment(taskIdOrScope, comment);
    // Determine taskId for pubsub notification
    const scope = typeof taskIdOrScope === 'string'
      ? { kind: 'task', taskId: taskIdOrScope }
      : taskIdOrScope;
    if (this.pubsub && scope.kind === 'task' && scope.taskId) {
      await this.pubsub.notifyChange('tasks', 'update', scope.taskId, { commentAdded: comment.id || result.id });
    }
    return result;
  }

  async listComments(scope: { kind: string; taskId?: string; sectionId?: string; boardProjectId?: string; dmThreadId?: string }): Promise<any[]> {
    if (typeof (this.baseProvider as any).listComments === 'function') {
      return (this.baseProvider as any).listComments(scope);
    }
    return [];
  }

  async listDmThreads(forAgent?: string): Promise<any[]> {
    if (typeof (this.baseProvider as any).listDmThreads === 'function') {
      return (this.baseProvider as any).listDmThreads(forAgent);
    }
    return [];
  }

  async updateSettings(updates: Partial<Record<string, any>>): Promise<any> {
    const result = await this.baseProvider.updateSettings(updates);
    if (this.pubsub) {
      await this.pubsub.notifyChange('settings', 'update', 'default');
    }
    return result;
  }

  async health(): Promise<boolean> {
    return await this.baseProvider.health();
  }

  // --- Section CRUD (delegate to base provider with pubsub notification) ---

  async addSection(projectId: string, section: { id?: string; name: string; owner: string; outcomes: string; contract: string }): Promise<any> {
    const result = await this.baseProvider.addSection(projectId, section);
    if (this.pubsub) {
      await this.pubsub.notifyChange('projects', 'update', projectId, { sectionAdded: result.id });
    }
    return result;
  }

  async updateSection(projectId: string, sectionId: string, updates: Partial<{ name: string; owner: string; outcomes: string; contract: string }>): Promise<void> {
    await this.baseProvider.updateSection(projectId, sectionId, updates);
    if (this.pubsub) {
      await this.pubsub.notifyChange('projects', 'update', projectId, { sectionUpdated: sectionId });
    }
  }

  async deleteSection(projectId: string, sectionId: string): Promise<void> {
    await this.baseProvider.deleteSection(projectId, sectionId);
    if (this.pubsub) {
      await this.pubsub.notifyChange('projects', 'update', projectId, { sectionDeleted: sectionId });
    }
  }

  async purgeSection(projectId: string, sectionId: string): Promise<void> {
    await this.baseProvider.purgeSection(projectId, sectionId);
    if (this.pubsub) {
      await this.pubsub.notifyChange('projects', 'update', projectId, { sectionPurged: sectionId });
    }
  }

  async reorderSections(projectId: string, sectionIds: string[]): Promise<void> {
    await this.baseProvider.reorderSections(projectId, sectionIds);
    if (this.pubsub) {
      await this.pubsub.notifyChange('projects', 'update', projectId, { sectionsReordered: true });
    }
  }

  async close?(): Promise<void> {
    if (this.pubsub) {
      await this.pubsub.close();
    }
    if (this.baseProvider.close) {
      await this.baseProvider.close();
    }
  }
}
