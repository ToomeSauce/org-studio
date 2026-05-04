import { describe, it, expect } from 'vitest';
import { validateUpdateTaskPayload } from '@/lib/update-task-validation';

// #1195: validation guards for POST /api/store action=updateTask.
// Previously bad payloads silently returned { ok: true } — now they 400.
describe('validateUpdateTaskPayload (#1195)', () => {
  it('rejects `patch` typo with a "did you mean `updates`?" hint', () => {
    const err = validateUpdateTaskPayload({
      id: 'task-123',
      patch: { status: 'done' },
    });
    expect(err).not.toBeNull();
    expect(err?.status).toBe(400);
    expect(err?.body.error).toMatch(/did you mean `updates`/);
  });

  it('rejects `changes` typo with the same hint', () => {
    const err = validateUpdateTaskPayload({
      id: 'task-123',
      changes: { status: 'done' },
    });
    expect(err?.status).toBe(400);
    expect(err?.body.error).toMatch(/did you mean `updates`/);
  });

  it('rejects empty updates object with "no fields to update"', () => {
    const err = validateUpdateTaskPayload({
      id: 'task-123',
      updates: {},
    });
    expect(err?.status).toBe(400);
    expect(err?.body.error).toMatch(/no fields to update/);
  });

  it('rejects missing id', () => {
    const err = validateUpdateTaskPayload({
      updates: { status: 'done' },
    });
    expect(err?.status).toBe(400);
    expect(err?.body.error).toMatch(/requires `id`/);
  });

  it('rejects non-string id', () => {
    const err = validateUpdateTaskPayload({
      id: 42,
      updates: { status: 'done' },
    });
    expect(err?.status).toBe(400);
    expect(err?.body.error).toMatch(/requires `id`/);
  });

  it('rejects missing updates (no typo) with "requires `updates`"', () => {
    const err = validateUpdateTaskPayload({ id: 'task-123' });
    expect(err?.status).toBe(400);
    expect(err?.body.error).toMatch(/requires `updates`/);
  });

  it('rejects updates that is an array', () => {
    const err = validateUpdateTaskPayload({
      id: 'task-123',
      updates: ['status', 'done'],
    });
    expect(err?.status).toBe(400);
    expect(err?.body.error).toMatch(/must be an object/);
  });

  it('rejects updates that is a string', () => {
    const err = validateUpdateTaskPayload({
      id: 'task-123',
      updates: 'status=done',
    });
    expect(err?.status).toBe(400);
    expect(err?.body.error).toMatch(/must be an object/);
  });

  it('accepts a valid payload (regression: happy path passes through)', () => {
    const err = validateUpdateTaskPayload({
      id: 'task-123',
      updates: { status: 'done' },
    });
    expect(err).toBeNull();
  });

  it('accepts updates with multiple fields', () => {
    const err = validateUpdateTaskPayload({
      id: 'task-123',
      updates: { status: 'in-progress', assignee: 'mikey', title: 'New' },
    });
    expect(err).toBeNull();
  });

  it('rejects null payload', () => {
    const err = validateUpdateTaskPayload(null);
    expect(err?.status).toBe(400);
  });
});
