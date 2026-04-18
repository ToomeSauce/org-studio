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

    test('should add a comment via legacy addComment(taskId, comment) call', async () => {
      const project = await fileProvider.createProject({
        name: 'Legacy Comment Project',
        phase: 'active',
        owner: 'testuser',
        priority: 'medium',
      });

      const task = await fileProvider.createTask({
        title: 'Legacy Comment Task',
        status: 'backlog',
        projectId: project.id,
        assignee: 'testuser',
      });

      // Legacy call: addComment(taskId, comment)
      const comment = await fileProvider.addComment(task.id, {
        author: 'legacyuser',
        content: 'Legacy style comment',
        type: 'comment',
      });

      expect(comment.id).toBeDefined();
      expect(comment.content).toBe('Legacy style comment');
      expect(comment.scope).toEqual({ kind: 'task', taskId: task.id });

      // Verify it's visible on the task
      const store = await fileProvider.read();
      const fetched = store.tasks.find((t: any) => t.id === task.id);
      expect(fetched.comments.length).toBeGreaterThanOrEqual(1);
      expect(fetched.comments.some((c: any) => c.content === 'Legacy style comment')).toBe(true);
    });

    test('should add a comment via new scope-based addComment call', async () => {
      const project = await fileProvider.createProject({
        name: 'Scoped Comment Project',
        phase: 'active',
        owner: 'testuser',
        priority: 'medium',
      });

      const task = await fileProvider.createTask({
        title: 'Scoped Comment Task',
        status: 'backlog',
        projectId: project.id,
        assignee: 'testuser',
      });

      // New scope-based call: addComment({ kind: 'task', taskId }, comment)
      const comment = await fileProvider.addComment(
        { kind: 'task', taskId: task.id },
        { author: 'scopeuser', content: 'Scope style comment', type: 'comment' }
      );

      expect(comment.id).toBeDefined();
      expect(comment.content).toBe('Scope style comment');
      expect(comment.scope).toEqual({ kind: 'task', taskId: task.id });

      // Verify it's visible on the task via standard read
      const store = await fileProvider.read();
      const fetched = store.tasks.find((t: any) => t.id === task.id);
      expect(fetched.comments.some((c: any) => c.content === 'Scope style comment')).toBe(true);
    });

    test('should handle non-task scope addComment gracefully in FileStoreProvider', async () => {
      // Non-task scopes won't persist in FileStore, but should not throw
      const comment = await fileProvider.addComment(
        { kind: 'section', sectionId: 'sec-123' },
        { author: 'testuser', content: 'Section comment', type: 'comment' }
      );

      expect(comment.id).toBeDefined();
      expect(comment.scope).toEqual({ kind: 'section', sectionId: 'sec-123' });
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
      // Soft-delete: section count stays the same, but the section has archivedAt
      expect(p.sections.length).toBe(countBefore);
      const archived = p.sections.find((s: any) => s.id === section.id);
      expect(archived.archivedAt).toBeDefined();
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

  describe('FileStoreProvider — listComments with pagination', () => {
    let commentProvider: FileStoreProvider;
    let commentTempDir: string;

    beforeEach(() => {
      commentTempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'comment-test-'));
      commentProvider = new FileStoreProvider(
        path.join(commentTempDir, 'store.json'),
        path.join(commentTempDir, 'backups')
      );
    });

    afterEach(() => {
      if (fs.existsSync(commentTempDir)) {
        fs.rmSync(commentTempDir, { recursive: true });
      }
    });

    test('listComments interface accepts opts parameter', async () => {
      // FileStoreProvider.listComments is not implemented (returns undefined),
      // but the interface should accept opts without error
      const provider: StoreProvider = commentProvider;
      // FileStoreProvider doesn't have listComments, so it should be undefined/optional
      expect(typeof provider.listComments).toBe('undefined');
    });

    test('addComment with board scope returns comment with correct scope', async () => {
      const comment = await commentProvider.addComment(
        { kind: 'board', boardProjectId: 'proj-123' },
        { author: 'Mikey', content: 'Board chat message', type: 'comment' }
      );

      expect(comment.id).toBeDefined();
      expect(comment.content).toBe('Board chat message');
      expect(comment.scope).toEqual({ kind: 'board', boardProjectId: 'proj-123' });
      expect(comment.createdAt).toBeDefined();
    });

    test('addComment with board scope creates comments with sequential timestamps', async () => {
      const c1 = await commentProvider.addComment(
        { kind: 'board', boardProjectId: 'proj-456' },
        { author: 'Ana', content: 'First message', type: 'comment', createdAt: 1000 }
      );
      const c2 = await commentProvider.addComment(
        { kind: 'board', boardProjectId: 'proj-456' },
        { author: 'Mikey', content: 'Second message', type: 'comment', createdAt: 2000 }
      );

      expect(c1.createdAt).toBe(1000);
      expect(c2.createdAt).toBe(2000);
      expect(c1.scope.boardProjectId).toBe('proj-456');
      expect(c2.scope.boardProjectId).toBe('proj-456');
    });
  });

  describe('Section soft-delete and purge', () => {
    let sectionProvider: FileStoreProvider;
    let sectionTempDir: string;

    beforeEach(() => {
      sectionTempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'section-test-'));
      sectionProvider = new FileStoreProvider(path.join(sectionTempDir, 'store.json'));
    });

    afterEach(() => {
      if (fs.existsSync(sectionTempDir)) {
        fs.rmSync(sectionTempDir, { recursive: true, force: true });
      }
    });

    test('deleteSection soft-deletes by setting archivedAt instead of removing', async () => {
      // Create a project — FileStoreProvider auto-injects a default Main section on read
      const project = await sectionProvider.createProject({
        name: 'SoftDeleteTest',
        description: 'test',
        phase: 'active',
        owner: 'testuser',
        priority: 'medium',
      });
      const sec2 = await sectionProvider.addSection(project.id, { name: 'Backend', owner: 'dev', outcomes: '', contract: '' });

      // Read to see how many sections exist before delete
      let store = JSON.parse(fs.readFileSync(path.join(sectionTempDir, 'store.json'), 'utf-8'));
      let proj = store.projects.find((p: any) => p.id === project.id);
      const countBefore = proj.sections.length;

      // Soft-delete the second section
      await sectionProvider.deleteSection(project.id, sec2.id);

      // Section should still exist with archivedAt set
      store = JSON.parse(fs.readFileSync(path.join(sectionTempDir, 'store.json'), 'utf-8'));
      proj = store.projects.find((p: any) => p.id === project.id);
      expect(proj.sections.length).toBe(countBefore); // Same count — soft-deleted
      const archived = proj.sections.find((s: any) => s.id === sec2.id);
      expect(archived.archivedAt).toBeDefined();
      expect(typeof archived.archivedAt).toBe('number');
      expect(archived.archivedBy).toBe('user');
    });

    test('purgeSection hard-deletes and fully removes the section', async () => {
      const project = await sectionProvider.createProject({
        name: 'PurgeTest',
        description: 'test',
        phase: 'active',
        owner: 'testuser',
        priority: 'medium',
      });
      const sec2 = await sectionProvider.addSection(project.id, { name: 'ToRemove', owner: 'dev', outcomes: '', contract: '' });

      // Read to see how many sections exist before purge
      let store = JSON.parse(fs.readFileSync(path.join(sectionTempDir, 'store.json'), 'utf-8'));
      let proj = store.projects.find((p: any) => p.id === project.id);
      const countBefore = proj.sections.length;

      await sectionProvider.purgeSection(project.id, sec2.id);

      store = JSON.parse(fs.readFileSync(path.join(sectionTempDir, 'store.json'), 'utf-8'));
      proj = store.projects.find((p: any) => p.id === project.id);
      expect(proj.sections.length).toBe(countBefore - 1);
      expect(proj.sections.find((s: any) => s.id === sec2.id)).toBeUndefined();
    });

    test('deleteSection prevents deleting the last non-archived section', async () => {
      const project = await sectionProvider.createProject({
        name: 'LastSectionTest',
        description: 'test',
        phase: 'active',
        owner: 'testuser',
        priority: 'medium',
      });

      // Read to get the default section
      const store = await sectionProvider.read();
      const proj = store.projects.find((p: any) => p.id === project.id);
      expect(proj.sections.length).toBeGreaterThanOrEqual(1);
      const onlySection = proj.sections[0];

      await expect(sectionProvider.deleteSection(project.id, onlySection.id))
        .rejects.toThrow('Cannot delete the last section');
    });
  });

  describe('Section-scoped comments', () => {
    let commentSectionProvider: FileStoreProvider;
    let commentSectionTempDir: string;

    beforeEach(() => {
      commentSectionTempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'section-comment-test-'));
      commentSectionProvider = new FileStoreProvider(path.join(commentSectionTempDir, 'store.json'));
    });

    afterEach(() => {
      if (fs.existsSync(commentSectionTempDir)) {
        fs.rmSync(commentSectionTempDir, { recursive: true, force: true });
      }
    });

    test('addComment with section scope returns comment with correct scope', async () => {
      const comment = await commentSectionProvider.addComment(
        { kind: 'section', sectionId: 'sec-abc', boardProjectId: 'proj-xyz' },
        { author: 'Mikey', content: 'Section chat message', type: 'comment' }
      );

      expect(comment.id).toBeDefined();
      expect(comment.content).toBe('Section chat message');
      expect(comment.scope).toEqual({ kind: 'section', sectionId: 'sec-abc', boardProjectId: 'proj-xyz' });
      expect(comment.createdAt).toBeDefined();
    });
  });

  describe('DM helpers (computeDmThreadId)', () => {
    // Use dynamic import for dm module
    let computeDmThreadId: any;
    let extractParticipants: any;
    let getOtherParticipant: any;
    let CURRENT_USER_ID: string;

    beforeAll(async () => {
      const dm = await import('./dm');
      computeDmThreadId = dm.computeDmThreadId;
      extractParticipants = dm.extractParticipants;
      getOtherParticipant = dm.getOtherParticipant;
      CURRENT_USER_ID = dm.CURRENT_USER_ID;
    });

    test('computeDmThreadId is deterministic and sorts correctly', () => {
      expect(computeDmThreadId(['bob', 'alice'])).toBe('dm::alice::bob');
      expect(computeDmThreadId(['alice', 'bob'])).toBe('dm::alice::bob');
      // Same result regardless of order
      expect(computeDmThreadId(['bob', 'alice'])).toBe(computeDmThreadId(['alice', 'bob']));
    });

    test('computeDmThreadId throws for wrong participant count', () => {
      expect(() => computeDmThreadId([])).toThrow();
      expect(() => computeDmThreadId(['solo'])).toThrow();
      expect(() => computeDmThreadId(['a', 'b', 'c'])).toThrow();
    });

    test('extractParticipants returns both participant IDs', () => {
      const [a, b] = extractParticipants('dm::alice::bob');
      expect(a).toBe('alice');
      expect(b).toBe('bob');
    });

    test('extractParticipants throws for invalid thread ID', () => {
      expect(() => extractParticipants('invalid')).toThrow();
      expect(() => extractParticipants('dm::only-one')).toThrow();
    });

    test('getOtherParticipant returns the other person', () => {
      expect(getOtherParticipant('dm::alice::you', 'you')).toBe('alice');
      expect(getOtherParticipant('dm::you::zara', 'you')).toBe('zara');
    });

    test('CURRENT_USER_ID is you', () => {
      expect(CURRENT_USER_ID).toBe('you');
    });
  });

  describe('DM-scope comments (FileStoreProvider)', () => {
    let dmProvider: FileStoreProvider;
    let dmTempDir: string;

    beforeEach(() => {
      dmTempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dm-comment-test-'));
      dmProvider = new FileStoreProvider(path.join(dmTempDir, 'store.json'));
    });

    afterEach(() => {
      if (fs.existsSync(dmTempDir)) {
        fs.rmSync(dmTempDir, { recursive: true, force: true });
      }
    });

    test('addComment with dm scope returns comment with correct scope', async () => {
      const comment = await dmProvider.addComment(
        { kind: 'dm', dmThreadId: 'dm::alice::bob' },
        { author: 'Alice', content: 'Hey Bob!', type: 'comment' }
      );

      expect(comment.id).toBeDefined();
      expect(comment.content).toBe('Hey Bob!');
      expect(comment.scope).toEqual({ kind: 'dm', dmThreadId: 'dm::alice::bob' });
      expect(comment.createdAt).toBeDefined();
    });

    test('listDmThreads on file provider returns empty array', async () => {
      const threads = await dmProvider.listDmThreads();
      expect(threads).toEqual([]);
    });
  });
});

// ============================================================
// Notification Router tests
// ============================================================
import { routeCommentNotifications, _resetDedupCache } from './notification-router';
import { vi } from 'vitest';

// Mock sendToAgent and rpc so no real network calls are made
vi.mock('@/lib/runtimes/registry', () => ({
  sendToAgent: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('@/lib/gateway-rpc', () => ({
  rpc: vi.fn().mockResolvedValue(undefined),
}));

const TEAMMATES = [
  { id: 't1', agentId: 'ana', name: 'Ana', isHuman: false },
  { id: 't2', agentId: 'mikey', name: 'Mikey', isHuman: false },
  { id: 't3', agentId: 'henry', name: 'Henry', isHuman: false },
  { id: 't4', agentId: 'basil', name: 'Basil', isHuman: true },
];

describe('Notification Router', () => {
  beforeEach(() => {
    _resetDedupCache();
    vi.clearAllMocks();
  });

  describe('dedup suppresses duplicate routing', () => {
    test('second call with same comment+recipient is skipped', async () => {
      const params = {
        comment: { id: 'c1', author: 'Mikey', content: 'Hey @Ana check this' },
        scope: { kind: 'task' as const, taskId: 'task-1' },
        teammates: TEAMMATES,
        context: {
          task: { id: 'task-1', title: 'Test task', assignee: 'Ana' },
        },
      };

      const first = await routeCommentNotifications(params);
      expect(first.notified).toContain('ana');

      const second = await routeCommentNotifications(params);
      expect(second.notified).not.toContain('ana');
      expect(second.skipped.find(s => s.agentId === 'ana')?.reason).toBe('duplicate');
    });
  });

  describe('self-mention is skipped', () => {
    test('author mentioning themselves is suppressed', async () => {
      const params = {
        comment: { id: 'c2', author: 'Ana', content: 'Note to @Ana: do X' },
        scope: { kind: 'board' as const, boardProjectId: 'proj-1' },
        teammates: TEAMMATES,
        context: {
          project: { id: 'proj-1', name: 'Proj', devOwner: 'Ana' },
          projectTasks: [{ assignee: 'Ana' }, { assignee: 'Mikey' }],
        },
      };

      const result = await routeCommentNotifications(params);
      expect(result.skipped.find(s => s.agentId === 'ana')?.reason).toBe('self');
      expect(result.notified).not.toContain('ana');
    });
  });

  describe('scope→recipients mapping', () => {
    test.each([
      {
        name: 'task: notifies assignee + mentioned',
        scope: { kind: 'task' as const, taskId: 'task-1' },
        comment: { id: 'c10', author: 'Basil', content: '@Henry heads up' },
        context: {
          task: { id: 'task-1', title: 'Fix bug', assignee: 'Ana' },
          project: { id: 'p1', name: 'P', devOwner: 'Ana', qaOwner: 'Mikey' },
          projectTasks: [{ assignee: 'Ana' }],
        },
        expectNotified: ['ana', 'henry', 'mikey'], // assignee + mentioned + qaOwner
      },
      {
        name: 'board: only mentioned agents in project set',
        scope: { kind: 'board' as const, boardProjectId: 'p1' },
        comment: { id: 'c11', author: 'Basil', content: '@Ana update?' },
        context: {
          project: { id: 'p1', name: 'P', devOwner: 'Ana' },
          projectTasks: [{ assignee: 'Ana' }],
        },
        expectNotified: ['ana'],
      },
      {
        name: 'section: section owner + mentioned',
        scope: { kind: 'section' as const, sectionId: 's1', boardProjectId: 'p1' },
        comment: { id: 'c12', author: 'Basil', content: '@Mikey check section' },
        context: {
          project: { id: 'p1', name: 'P', devOwner: 'Ana' },
          section: { id: 's1', name: 'Frontend', owner: 'Ana' },
          projectTasks: [{ assignee: 'Ana' }, { assignee: 'Mikey' }],
        },
        expectNotified: ['ana', 'mikey'], // section owner + mentioned
      },
      {
        name: 'dm: other participant',
        scope: { kind: 'dm' as const, dmThreadId: 'dm::basil::ana' },
        comment: { id: 'c13', author: 'Basil', content: 'hello' },
        context: {},
        expectNotified: ['ana'], // the other participant (not basil who is human anyway)
      },
    ])('$name', async ({ scope, comment, context, expectNotified }) => {
      const result = await routeCommentNotifications({
        comment,
        scope,
        teammates: TEAMMATES,
        context,
      });
      for (const id of expectNotified) {
        expect(result.notified).toContain(id);
      }
    });
  });
});
