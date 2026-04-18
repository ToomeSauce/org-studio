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
      expect(typeof provider.addSection).toBe('function');
      expect(typeof provider.updateSection).toBe('function');
      expect(typeof provider.deleteSection).toBe('function');
      expect(typeof provider.reorderSections).toBe('function');
    });
  });

  describe('FileStoreProvider — Sections', () => {
    let sectionProvider: StoreProvider;
    let sectionTempDir: string;

    beforeEach(() => {
      sectionTempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'section-test-'));
      sectionProvider = new FileStoreProvider(
        path.join(sectionTempDir, 'store.json'),
        path.join(sectionTempDir, 'backups')
      );
    });

    afterEach(() => {
      if (fs.existsSync(sectionTempDir)) {
        fs.rmSync(sectionTempDir, { recursive: true });
      }
    });

    test('should inject default Main section on read for projects without sections', async () => {
      // Write a project without sections directly
      const storePath = path.join(sectionTempDir, 'store.json');
      fs.writeFileSync(storePath, JSON.stringify({
        projects: [{ id: 'proj-1', name: 'Test', phase: 'active', owner: 'Alice', priority: 'high', createdAt: 1 }],
        tasks: [],
        settings: {},
      }));

      const store = await sectionProvider.read();
      const project = store.projects[0];
      expect(project.sections).toBeDefined();
      expect(project.sections).toHaveLength(1);
      expect(project.sections[0].id).toBe('sec-main-proj-1');
      expect(project.sections[0].name).toBe('Main');
      expect(project.sections[0].owner).toBe('Alice');
    });

    test('should NOT inject default section if sections already exist', async () => {
      const storePath = path.join(sectionTempDir, 'store.json');
      fs.writeFileSync(storePath, JSON.stringify({
        projects: [{
          id: 'proj-1', name: 'Test', phase: 'active', owner: 'Alice', priority: 'high', createdAt: 1,
          sections: [{ id: 'sec-custom', name: 'Custom', owner: 'Bob', outcomes: 'Ship it', contract: '' }],
        }],
        tasks: [],
        settings: {},
      }));

      const store = await sectionProvider.read();
      expect(store.projects[0].sections).toHaveLength(1);
      expect(store.projects[0].sections[0].id).toBe('sec-custom');
    });

    test('should add a section to a project', async () => {
      const project = await sectionProvider.createProject({
        name: 'Test', phase: 'active', owner: 'Alice', priority: 'high',
      });

      const section = await sectionProvider.addSection(project.id, {
        name: 'Backend', owner: 'Bob', outcomes: 'API works', contract: 'Returns JSON',
      });

      expect(section.id).toBeDefined();
      expect(section.name).toBe('Backend');

      const store = await sectionProvider.read();
      const p = store.projects.find((pp: any) => pp.id === project.id);
      // Default Main + new Backend section
      expect(p.sections.length).toBeGreaterThanOrEqual(2);
    });

    test('should update a section', async () => {
      const project = await sectionProvider.createProject({
        name: 'Test', phase: 'active', owner: 'Alice', priority: 'high',
      });

      const section = await sectionProvider.addSection(project.id, {
        name: 'Backend', owner: 'Bob', outcomes: '', contract: '',
      });

      await sectionProvider.updateSection(project.id, section.id, { name: 'Backend V2', owner: 'Charlie' });

      const store = await sectionProvider.read();
      const p = store.projects.find((pp: any) => pp.id === project.id);
      const updated = p.sections.find((s: any) => s.id === section.id);
      expect(updated.name).toBe('Backend V2');
      expect(updated.owner).toBe('Charlie');
    });

    test('should delete a section (but not the last one)', async () => {
      const project = await sectionProvider.createProject({
        name: 'Test', phase: 'active', owner: 'Alice', priority: 'high',
      });

      // Add a second section so we can delete one
      const section = await sectionProvider.addSection(project.id, {
        name: 'Backend', owner: 'Bob', outcomes: '', contract: '',
      });

      // Read to see how many sections exist
      let store = await sectionProvider.read();
      let p = store.projects.find((pp: any) => pp.id === project.id);
      const countBefore = p.sections.length;

      await sectionProvider.deleteSection(project.id, section.id);

      store = await sectionProvider.read();
      p = store.projects.find((pp: any) => pp.id === project.id);
      expect(p.sections.length).toBe(countBefore - 1);
    });

    test('should NOT delete the last section', async () => {
      const project = await sectionProvider.createProject({
        name: 'Test', phase: 'active', owner: 'Alice', priority: 'high',
      });

      // Read to get the default section ID
      const store = await sectionProvider.read();
      const p = store.projects.find((pp: any) => pp.id === project.id);
      expect(p.sections).toHaveLength(1);

      await expect(sectionProvider.deleteSection(project.id, p.sections[0].id))
        .rejects.toThrow('Cannot delete the last section');
    });

    test('should reorder sections', async () => {
      const project = await sectionProvider.createProject({
        name: 'Test', phase: 'active', owner: 'Alice', priority: 'high',
      });

      const s1 = await sectionProvider.addSection(project.id, { name: 'A', owner: '', outcomes: '', contract: '' });
      const s2 = await sectionProvider.addSection(project.id, { name: 'B', owner: '', outcomes: '', contract: '' });

      // Get current order (default Main + A + B)
      let store = await sectionProvider.read();
      let p = store.projects.find((pp: any) => pp.id === project.id);
      const mainId = p.sections[0].id;

      // Reorder: B, A, Main
      await sectionProvider.reorderSections(project.id, [s2.id, s1.id, mainId]);

      store = await sectionProvider.read();
      p = store.projects.find((pp: any) => pp.id === project.id);
      expect(p.sections[0].id).toBe(s2.id);
      expect(p.sections[1].id).toBe(s1.id);
      expect(p.sections[2].id).toBe(mainId);
    });

    test('deleteSection should leave tasks intact (reassignment handled at API layer)', async () => {
      // Create a project
      const project = await sectionProvider.createProject({
        name: 'Test', phase: 'active', owner: 'Alice', priority: 'high',
      });

      // Add a second section
      const section = await sectionProvider.addSection(project.id, {
        name: 'Backend', owner: 'Bob', outcomes: '', contract: '',
      });

      // Create a task assigned to that section
      await sectionProvider.createTask({
        id: 'task-in-section',
        title: 'Do backend work',
        status: 'backlog',
        projectId: project.id,
        assignee: 'Bob',
        sectionId: section.id,
        createdAt: Date.now(),
      });

      // Delete the section
      await sectionProvider.deleteSection(project.id, section.id);

      // Task still exists (provider doesn't cascade-delete)
      const store = await sectionProvider.read();
      const task = store.tasks.find((t: any) => t.id === 'task-in-section');
      expect(task).toBeDefined();
      // Task still has the old sectionId (API route handles reassignment, not provider)
      expect(task.sectionId).toBe(section.id);
    });
  });
});
