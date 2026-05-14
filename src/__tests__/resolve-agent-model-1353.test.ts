/**
 * #1353 slice 2 \u2014 Static regression: route.ts must NOT contain
 * per-runtime branching for model resolution.
 *
 * doneWhen #4 + #8 require resolveAgentModel() to dispatch through
 * RuntimeRegistry.getRuntimeForAgent(agentId) instead of branching on
 * agentId prefix. This test reads the route.ts source and asserts the
 * structural shape, so any future PR that reintroduces an
 * `if (agentId.startsWith('hermes-'))` style branch in the FUNCTIONAL
 * code of resolveAgentModel will go red.
 *
 * What this test ALLOWS (intentionally):
 *   - The string "hermes-" appearing in DOCSTRINGS / comments (the
 *     refactor preserved the history of what was removed).
 *   - The import of getRuntimeRegistry from runtimes/registry.
 *
 * What it DISALLOWS:
 *   - Any `agentId.startsWith('hermes-')` runtime branch inside the
 *     resolveAgentModel function body.
 *   - Direct import of resolveHermesPrimaryModel from route.ts (that
 *     helper is now only consumed by HermesRuntime.getAgentMetadata
 *     internally).
 *   - The old inline Gateway sessions.list fetch (now lives in
 *     OpenClawRuntime.getAgentMetadata).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

const routePath = join(process.cwd(), 'src/app/api/store/route.ts');
const routeSrc = readFileSync(routePath, 'utf-8');

/**
 * Returns the function body of resolveAgentModel, stripped of all
 * /** ... *\/ block comments and // line comments. Used for "is this
 * functional code or just a docstring?" assertions.
 */
function extractResolveAgentModelBody(): string {
  const match = routeSrc.match(
    /async function resolveAgentModel\([^)]*\)[^{]*\{([\s\S]*?)\n\}/,
  );
  if (!match) {
    throw new Error('resolveAgentModel function not found in route.ts');
  }
  return match[1]
    .replace(/\/\*[\s\S]*?\*\//g, '')   // strip block comments
    .replace(/\/\/[^\n]*/g, '');        // strip line comments
}

describe('#1353 slice 2 \u2014 route.ts has no per-runtime branching', () => {
  it('imports getRuntimeRegistry (the new dispatch mechanism)', () => {
    // doneWhen #4: resolveAgentModel uses registry dispatch.
    expect(routeSrc).toMatch(
      /import\s*\{\s*getRuntimeRegistry\s*\}\s*from\s*['"]@\/lib\/runtimes\/registry['"]/,
    );
  });

  it('does NOT import resolveHermesPrimaryModel (now an internal helper)', () => {
    // The helper still exists in src/lib/runtimes/hermes.ts (for use
    // by HermesRuntime.getAgentMetadata internally), but route.ts
    // should never call it directly anymore.
    expect(routeSrc).not.toMatch(/import[^;]*resolveHermesPrimaryModel/);
  });

  it("doesn't branch on agentId.startsWith('hermes-') in functional code", () => {
    // doneWhen #8: no per-runtime branching remains in route.ts.
    // Docstrings are allowed to mention the removed pattern; the
    // function body itself must be clean.
    const body = extractResolveAgentModelBody();
    expect(body).not.toMatch(/agentId\.startsWith\(['"]hermes-['"]\)/);
    expect(body).not.toMatch(/\.startsWith\(['"]hermes-['"]\)/);
  });

  it('does not inline a Gateway sessions.list fetch (moved to OpenClawRuntime)', () => {
    // The Gateway round-trip used to be inline; doneWhen #2 moves
    // it into OpenClawRuntime.getAgentMetadata. resolveAgentModel
    // should not reference sessions.list at all.
    const body = extractResolveAgentModelBody();
    expect(body).not.toContain('sessions.list');
  });

  it('does call runtime.getAgentMetadata(agentId)', () => {
    // Positive assertion: the new dispatch IS present.
    const body = extractResolveAgentModelBody();
    expect(body).toMatch(/\.getAgentMetadata\s*\(\s*agentId\s*\)/);
  });

  it("preserves resolveAgentModel's external signature (backwards compat)", () => {
    // The constraint section of #1353 specifies callers (~L989, ~L1744)
    // must not change. The signature is the contract:
    //   async function resolveAgentModel(agentName: string, store: StoreData): Promise<string | undefined>
    expect(routeSrc).toMatch(
      /async function resolveAgentModel\(\s*agentName:\s*string\s*,\s*store:\s*StoreData\s*\)\s*:\s*Promise<string\s*\|\s*undefined>/,
    );
  });
});
