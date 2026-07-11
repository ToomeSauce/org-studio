import { describe, expect, it } from 'vitest';
import { assembleBrief } from '@/lib/workers/context-assembler';
import { DEFAULT_WORKERS } from '@/lib/workers/config';
import {
  inspectRepoCheckout,
  MAX_REPO_CONTEXT_BYTES,
  REPO_CONTEXT_STALE_AFTER_MS,
  REPO_CONTEXT_TRUNCATION_MARKER,
  renderRepoContextPack,
  type RepoContextInput,
} from '@/lib/workers/repo-context';

const BASE_INPUT: RepoContextInput = {
  repoName: 'org-studio',
  tree: [
    { path: 'src', kind: 'directory', annotation: 'application source' },
    { path: 'src/lib', kind: 'directory', annotation: 'domain modules' },
  ],
  entrypoints: ['server.mjs', 'src/app/api/store/route.ts'],
  typeLocations: ['src/lib/store.ts'],
  testLayout: ['src/__tests__'],
  verificationCommands: ['npx vitest run src/__tests__/repo-context.test.ts'],
  conventions: ['Follow `AGENTS.md`'],
};

describe('#1690: RepoContextPack renderer', () => {
  it('renders every required section deterministically', () => {
    const first = renderRepoContextPack(BASE_INPUT);
    const second = renderRepoContextPack(BASE_INPUT);
    expect(second).toBe(first);
    expect(first).toContain('Directory map (2 levels)');
    expect(first).toContain('Key entrypoints');
    expect(first).toContain('Core interfaces and types');
    expect(first).toContain('Test layout');
    expect(first).toContain('Verification commands');
    expect(first).toContain('Conventions');
    expect(first).toContain('`src/lib/` — domain modules');
  });

  it('enforces the 4KB UTF-8 budget with a visible marker', () => {
    const pack = renderRepoContextPack({
      ...BASE_INPUT,
      conventions: Array.from({ length: 200 }, (_, i) => `${i}: ${'🧭'.repeat(50)}`),
    });
    expect(Buffer.byteLength(pack, 'utf8')).toBeLessThanOrEqual(MAX_REPO_CONTEXT_BYTES);
    expect(pack).toContain(REPO_CONTEXT_TRUNCATION_MARKER);
    expect(pack).not.toContain('�');
  });

  it('generates Org Studio’s own pack and carries it in a real brief', async () => {
    const input = await inspectRepoCheckout(
      process.cwd(),
      DEFAULT_WORKERS[0].verificationCommands,
    );
    const pack = renderRepoContextPack(input);
    const brief = assembleBrief({
      dispatchMessage: 'REAL DISPATCH',
      task: { id: 't-real', ticketNumber: 1690, title: 'Repo context' },
      project: {
        id: 'proj-org-studio',
        name: 'Org Studio',
        repoContextPack: pack,
        repoContextPackGeneratedAt: Date.now(),
      },
    });
    expect(Buffer.byteLength(pack, 'utf8')).toBeLessThanOrEqual(MAX_REPO_CONTEXT_BYTES);
    expect(pack).toContain('`src/lib/workers/context-assembler.ts`');
    expect(pack).toContain('npx vitest run <target-test-file>');
    expect(brief).toContain(pack);
  });
});

describe('#1690: worker brief injection', () => {
  const task = { id: 't1', ticketNumber: 1690, title: 'Repo context' };

  it('injects a cached pack after ticket fields and before discussion', () => {
    const brief = assembleBrief({
      dispatchMessage: 'DISPATCH',
      task,
      project: {
        id: 'proj-org-studio',
        name: 'Org Studio',
        repoContextPack: 'PACK-CONTENT',
        repoContextPackGeneratedAt: 100,
      },
      comments: [{ author: 'Basil', content: 'Keep it small.', createdAt: 1 }],
      nowMs: 100 + REPO_CONTEXT_STALE_AFTER_MS,
    });
    expect(brief).toContain('## Repository context pack\n\nPACK-CONTENT');
    expect(brief.indexOf('Your ticket')).toBeLessThan(brief.indexOf('Repository context pack'));
    expect(brief.indexOf('Repository context pack')).toBeLessThan(brief.indexOf('Ticket discussion'));
    expect(brief).not.toContain('over 30 days old');
  });

  it('warns when the cached pack is older than 30 days', () => {
    const generatedAt = Date.UTC(2026, 0, 1);
    const brief = assembleBrief({
      dispatchMessage: 'DISPATCH',
      task,
      project: {
        id: 'proj-org-studio',
        name: 'Org Studio',
        repoContextPack: 'PACK-CONTENT',
        repoContextPackGeneratedAt: generatedAt,
      },
      nowMs: generatedAt + REPO_CONTEXT_STALE_AFTER_MS + 1,
    });
    expect(brief).toContain('over 30 days old');
    expect(brief).toContain('2026-01-01T00:00:00.000Z');
  });

  it('keeps today’s brief shape when no pack exists', () => {
    const brief = assembleBrief({
      dispatchMessage: 'DISPATCH',
      task,
      project: { id: 'proj-org-studio', name: 'Org Studio' },
    });
    expect(brief).not.toContain('Repository context pack');
    expect(brief).toContain('Operating rules');
  });
});
