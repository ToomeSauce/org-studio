import { describe, it, expect } from 'vitest';
import { getEffectiveOwner } from '../lib/component-helpers';

/**
 * #1126 PR 1 — unit tests for `getEffectiveOwner`.
 *
 * Precedence: version.owner > component.owner > undefined.
 * (task.assignee is the highest layer in the full chain but is resolved
 * by the caller, not this helper — see jsdoc on getEffectiveOwner.)
 */

function project(overrides: any = {}) {
  return {
    id: 'proj-test',
    name: 'Test',
    components: [
      {
        id: 'cmp-main',
        name: 'Main',
        owner: 'Mikey',
        versions: [
          { id: 'v-1', version: '0.1.0', status: 'shipped' },
          { id: 'v-2', version: '0.2.0', status: 'current', owner: 'Billy' },
          { id: 'v-3', version: '0.3.0', status: 'planned', owner: '   ' }, // whitespace-only
          { id: 'v-4', version: '0.4.0', status: 'planned', owner: '' }, // empty string
        ],
      },
      {
        id: 'cmp-no-owner',
        name: 'Orphan',
        owner: '',
        versions: [
          { id: 'v-x', version: '1.0.0', status: 'planned' },
        ],
      },
    ],
    ...overrides,
  };
}

describe('getEffectiveOwner (#1126 PR 1)', () => {
  it('returns version.owner when set', () => {
    expect(getEffectiveOwner(project(), 'cmp-main', 'v-2')).toBe('Billy');
  });

  it('falls back to component.owner when version has no owner field', () => {
    expect(getEffectiveOwner(project(), 'cmp-main', 'v-1')).toBe('Mikey');
  });

  it('falls back to component.owner when version.owner is whitespace-only', () => {
    expect(getEffectiveOwner(project(), 'cmp-main', 'v-3')).toBe('Mikey');
  });

  it('falls back to component.owner when version.owner is empty string', () => {
    expect(getEffectiveOwner(project(), 'cmp-main', 'v-4')).toBe('Mikey');
  });

  it('falls back to component.owner when versionId is undefined', () => {
    expect(getEffectiveOwner(project(), 'cmp-main', undefined)).toBe('Mikey');
  });

  it('falls back to component.owner when versionId does not match any version', () => {
    expect(getEffectiveOwner(project(), 'cmp-main', 'v-does-not-exist')).toBe('Mikey');
  });

  it('returns undefined when component has no owner and version has no override', () => {
    expect(getEffectiveOwner(project(), 'cmp-no-owner', 'v-x')).toBeUndefined();
  });

  it('returns undefined when component cannot be resolved', () => {
    expect(getEffectiveOwner(project(), 'cmp-does-not-exist', 'v-1')).toBeUndefined();
  });

  it('reads from project.sections[] if project.components[] is absent (legacy shape)', () => {
    const legacy = {
      id: 'proj-legacy',
      name: 'Legacy',
      sections: [
        {
          id: 'sec-main',
          name: 'Main',
          owner: 'Henry',
          versions: [
            { id: 'sv-1', version: '0.1.0', status: 'shipped', owner: 'Ana' },
          ],
        },
      ],
    };
    expect(getEffectiveOwner(legacy, 'sec-main', 'sv-1')).toBe('Ana');
    expect(getEffectiveOwner(legacy, 'sec-main', undefined)).toBe('Henry');
  });

  it('does not consult task.assignee (caller responsibility, not helper)', () => {
    // Smoke-test: a task with assignee=Sam is irrelevant to this helper's output.
    // Callers must check task.assignee BEFORE falling back to getEffectiveOwner.
    const result = getEffectiveOwner(project(), 'cmp-main', 'v-2');
    expect(result).toBe('Billy'); // version owner wins over component owner
    // (no task.assignee handling at all — that's intentional)
  });
});
