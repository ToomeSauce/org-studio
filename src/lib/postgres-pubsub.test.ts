/**
 * postgres-pubsub.test.ts
 * 
 * Tests for the PostgresPubSub system
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PostgresPubSub } from '../lib/postgres-pubsub';

describe('PostgresPubSub', () => {
  let pubsubPublisher: PostgresPubSub;
  let pubsubSubscriber: PostgresPubSub;
  const CONNECTION_STRING = process.env.DATABASE_URL;

  beforeAll(async () => {
    if (!CONNECTION_STRING) {
      console.log('Skipping pub/sub tests — DATABASE_URL not set');
      return;
    }

    pubsubPublisher = new PostgresPubSub(CONNECTION_STRING, 'test-publisher');
    pubsubSubscriber = new PostgresPubSub(CONNECTION_STRING, 'test-subscriber');

    await pubsubPublisher.initialize();
    await pubsubSubscriber.initialize();

    // Subscribe to all changes
    await pubsubSubscriber.subscribe([
      'tasks:create',
      'tasks:update',
      'tasks:delete',
      'projects:create',
      'projects:update',
      'settings:update',
    ]);
  });

  afterAll(async () => {
    if (pubsubPublisher) await pubsubPublisher.close();
    if (pubsubSubscriber) await pubsubSubscriber.close();
  });

  it('should be initialized', async () => {
    if (!CONNECTION_STRING) return;
    expect(pubsubPublisher).toBeDefined();
    expect(pubsubSubscriber).toBeDefined();
  });

  it('should publish and receive notifications', async (ctx) => {
    if (!CONNECTION_STRING) return;

    const testId = `test-task-${Date.now()}`;
    let notificationReceived = false;

    // Set up listener
    pubsubSubscriber.once('tasks:create', (data) => {
      if (data.id === testId) {
        notificationReceived = true;
      }
    });

    // Give listener time to set up
    await new Promise((r) => setTimeout(r, 100));

    // Publish notification
    await pubsubPublisher.notifyChange('tasks', 'create', testId);

    // Wait for notification
    await new Promise((r) => setTimeout(r, 500));

    expect(notificationReceived).toBe(true);
  });

  it('health check should return true', async () => {
    if (!CONNECTION_STRING) return;
    const health1 = await pubsubPublisher.health();
    const health2 = await pubsubSubscriber.health();
    expect(health1).toBe(true);
    expect(health2).toBe(true);
  });

  it('should emit generic change event', async () => {
    if (!CONNECTION_STRING) return;

    const testId = `test-proj-${Date.now()}`;
    let genericChangeReceived = false;
    let projectUpdateReceived = false;

    pubsubSubscriber.once('change', (data) => {
      if (data.id === testId && data.entity === 'projects') {
        genericChangeReceived = true;
      }
    });

    pubsubSubscriber.once('projects:update', (data) => {
      if (data.id === testId) {
        projectUpdateReceived = true;
      }
    });

    await new Promise((r) => setTimeout(r, 100));
    await pubsubPublisher.notifyChange('projects', 'update', testId);
    await new Promise((r) => setTimeout(r, 500));

    expect(genericChangeReceived).toBe(true);
    expect(projectUpdateReceived).toBe(true);
  });
});
