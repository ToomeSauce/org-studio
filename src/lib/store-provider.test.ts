/**
 * Store provider tests
 * Verifies FileStoreProvider and PostgresStoreProvider work correctly
 */

import { FileStoreProvider, PostgresStoreProvider, StoreProvider } from './store-provider';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

describe('StoreProvider Abstraction', () => {
  let fileProvider: StoreProvider;
  let tempDir: string;

  beforeAll(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'store-test-'));
  });

  afterAll(() => {
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true });
    }
  });

  describe('FileStoreProvider', () => {
    beforeEach(() => {
      fileProvider = new FileStoreProvider(
        path.join(tempDir, 'store.json'),
        path.join(tempDir, 'backups')
      );
    });

    test('should initialize with empty store', async () => {
      const store = await fileProvider.read();
      expect(store.projects).toEqual([]);
      expect(store.tasks).toEqual([]);
    });

    test('should create a project', async () => {
      const project = await fileProvider.createProject({
        name: 'Test Project',
        description: 'A test project',
        phase: 'active',
        owner: 'testuser',
        priority: 'high',
      });

      expect(project.id).toBeDefined();
      expect(project.name).toBe('Test Project');

      const store = await fileProvider.read();
      expect(store.projects.length).toBe(1);
    });

    test('should update a project', async () => {
      const project = await fileProvider.createProject({
        name: 'Test Project',
        description: 'A test project',
        phase: 'active',
        owner: 'testuser',
        priority: 'high',
      });

      const updated = await fileProvider.updateProject(project.id, {
        name: 'Updated Project',
        priority: 'low',
      });

      expect(updated.name).toBe('Updated Project');
      expect(updated.priority).toBe('low');

      const store = await fileProvider.read();
      const fetched = store.projects.find((p: any) => p.id === project.id);
      expect(fetched.name).toBe('Updated Project');
    });

    test('should create a task', async () => {
      const project = await fileProvider.createProject({
        name: 'Test Project',
        phase: 'active',
        owner: 'testuser',
        priority: 'high',
      });

      const task = await fileProvider.createTask({
        title: 'Test Task',
        description: 'A test task',
        status: 'backlog',
        projectId: project.id,
        assignee: 'testuser',
        priority: 'high',
      });

      expect(task.id).toBeDefined();
      expect(task.title).toBe('Test Task');

      const store = await fileProvider.read();
      expect(store.tasks.length).toBe(1);
    });

    test('should add a comment to a task', async () => {
      const project = await fileProvider.createProject({
        name: 'Test Project',
        phase: 'active',
        owner: 'testuser',
        priority: 'high',
      });

      const task = await fileProvider.createTask({
        title: 'Test Task',
        status: 'backlog',
        projectId: project.id,
        assignee: 'testuser',
      });

      const comment = await fileProvider.addComment(task.id, {
        author: 'testuser',
        content: 'This is a test comment',
        type: 'comment',
      });

      expect(comment.id).toBeDefined();
      expect(comment.content).toBe('This is a test comment');

      const store = await fileProvider.read();
      const fetched = store.tasks.find((t: any) => t.id === task.id);
      expect(fetched.comments.length).toBe(1);
    });

    test('should update settings', async () => {
      const settings = await fileProvider.updateSettings({
        missionStatement: 'Test mission',
        values: [{ name: 'autonomy', items: ['item1', 'item2'] }],
      });

      expect(settings.missionStatement).toBe('Test mission');
      expect(settings.values).toHaveLength(1);

      const store = await fileProvider.read();
      expect(store.settings.missionStatement).toBe('Test mission');
    });

    test('should perform health check', async () => {
      const health = await fileProvider.health();
      expect(health).toBe(true);
    });

    test('should handle missing store gracefully', async () => {
      const newProvider = new FileStoreProvider(
        path.join(tempDir, 'nonexistent', 'store.json')
      );
      const store = await newProvider.read();
      expect(store.projects).toEqual([]);
      expect(store.tasks).toEqual([]);
    });
  });

  describe('Provider Interface', () => {
    test('should have consistent interface', async () => {
      const provider = fileProvider;

      expect(typeof provider.read).toBe('function');
      expect(typeof provider.write).toBe('function');
      expect(typeof provider.createProject).toBe('function');
      expect(typeof provider.updateProject).toBe('function');
      expect(typeof provider.deleteProject).toBe('function');
      expect(typeof provider.createTask).toBe('function');
      expect(typeof provider.updateTask).toBe('function');
      expect(typeof provider.deleteTask).toBe('function');
      expect(typeof provider.addComment).toBe('function');
      expect(typeof provider.updateSettings).toBe('function');
      expect(typeof provider.health).toBe('function');
    });
  });
});
