/**
 * RepoContextPack (#1690) — a compact, cached map of a project's checkout.
 *
 * `renderRepoContextPack` is deliberately pure: callers provide discovered
 * paths/conventions and receive bounded markdown. `inspectRepoCheckout` is
 * the small IO adapter used by the manual generation route.
 */
import { readFile, readdir } from 'node:fs/promises';
import { basename, join } from 'node:path';

export const MAX_REPO_CONTEXT_BYTES = 4 * 1024;
export const REPO_CONTEXT_STALE_AFTER_MS = 30 * 24 * 60 * 60 * 1000;
export const REPO_CONTEXT_TRUNCATION_MARKER = '[TRUNCATED: repo context exceeded 4KB budget]';

export interface RepoContextTreeEntry {
  path: string;
  kind: 'directory' | 'file';
  annotation?: string;
}

export interface RepoContextInput {
  repoName: string;
  tree: RepoContextTreeEntry[];
  entrypoints: string[];
  typeLocations: string[];
  testLayout: string[];
  verificationCommands: string[];
  conventions: string[];
}

function section(title: string, values: string[]): string {
  if (values.length === 0) return `## ${title}\n- Not detected`;
  return `## ${title}\n${values.map((value) => `- ${value}`).join('\n')}`;
}

function truncateUtf8(value: string, maxBytes: number): string {
  if (Buffer.byteLength(value, 'utf8') <= maxBytes) return value;
  const marker = `\n\n${REPO_CONTEXT_TRUNCATION_MARKER}`;
  const markerBytes = Buffer.byteLength(marker, 'utf8');
  if (maxBytes <= markerBytes) {
    return Buffer.from(REPO_CONTEXT_TRUNCATION_MARKER, 'utf8').subarray(0, maxBytes).toString('utf8');
  }

  const budget = maxBytes - markerBytes;
  let used = 0;
  const kept: string[] = [];
  for (const codePoint of value) {
    const size = Buffer.byteLength(codePoint, 'utf8');
    if (used + size > budget) break;
    kept.push(codePoint);
    used += size;
  }
  return kept.join('').trimEnd() + marker;
}

/** Render a deterministic markdown pack whose UTF-8 representation is ≤4KB. */
export function renderRepoContextPack(
  input: RepoContextInput,
  maxBytes = MAX_REPO_CONTEXT_BYTES,
): string {
  const tree = input.tree.map((entry) => {
    const suffix = entry.kind === 'directory' ? '/' : '';
    return `\`${entry.path}${suffix}\`${entry.annotation ? ` — ${entry.annotation}` : ''}`;
  });
  const commands = input.verificationCommands.map((command) => `\`${command}\``);
  const rendered = [
    `# Repository context — ${input.repoName}`,
    section('Directory map (2 levels)', tree),
    section('Key entrypoints', input.entrypoints.map((path) => `\`${path}\``)),
    section('Core interfaces and types', input.typeLocations.map((path) => `\`${path}\``)),
    section('Test layout', input.testLayout.map((path) => `\`${path}\``)),
    section('Verification commands', commands),
    section('Conventions', input.conventions),
  ].join('\n\n');
  return truncateUtf8(rendered, Math.max(0, maxBytes));
}

const SKIP_DIRS = new Set([
  '.git', '.next', '.turbo', 'backups', 'build', 'coverage', 'dist', 'node_modules', 'vendor',
]);
const ROOT_CONTEXT_FILES = new Set([
  'AGENTS.md', 'CONTRIBUTING.md', 'README.md', 'package.json', 'server.mjs',
  'tsconfig.json', 'eslint.config.mjs', 'next.config.ts',
]);

const PATH_ANNOTATIONS: Record<string, string> = {
  src: 'application source',
  'src/app': 'Next.js routes and pages',
  'src/components': 'React UI components',
  'src/lib': 'domain and infrastructure modules',
  'src/__tests__': 'Vitest tests',
  scripts: 'operator and migration scripts',
  docs: 'architecture and product documentation',
  public: 'static assets',
};

async function pathExists(path: string): Promise<boolean> {
  try {
    await readFile(path);
    return true;
  } catch {
    try {
      await readdir(path);
      return true;
    } catch {
      return false;
    }
  }
}

async function walkFiles(root: string, depth: number, prefix = ''): Promise<string[]> {
  if (depth < 0) return [];
  let entries;
  try {
    entries = await readdir(join(root, prefix), { withFileTypes: true });
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.name.startsWith('.') || SKIP_DIRS.has(entry.name)) continue;
    const path = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...await walkFiles(root, depth - 1, path));
    else if (entry.isFile()) out.push(path);
  }
  return out;
}

interface PackageMetadata {
  name?: string;
  scripts?: Record<string, string>;
}

async function readPackageJson(root: string): Promise<PackageMetadata | null> {
  try {
    return JSON.parse(await readFile(join(root, 'package.json'), 'utf8')) as PackageMetadata;
  } catch {
    return null;
  }
}

/** Inspect a checkout without external dependencies; output feeds the pure renderer. */
export async function inspectRepoCheckout(
  repoRoot: string,
  verificationCommands: string[] = [],
): Promise<RepoContextInput> {
  const rootEntries = await readdir(repoRoot, { withFileTypes: true });
  const tree: RepoContextTreeEntry[] = [];
  for (const entry of rootEntries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.name.startsWith('.') || SKIP_DIRS.has(entry.name)) continue;
    if (!entry.isDirectory() && !ROOT_CONTEXT_FILES.has(entry.name)) continue;
    const firstPath = entry.name;
    tree.push({
      path: firstPath,
      kind: entry.isDirectory() ? 'directory' : 'file',
      annotation: PATH_ANNOTATIONS[firstPath],
    });
    if (!entry.isDirectory()) continue;
    let children;
    try {
      children = await readdir(join(repoRoot, entry.name), { withFileTypes: true });
    } catch {
      continue;
    }
    for (const child of children.sort((a, b) => a.name.localeCompare(b.name))) {
      if (child.name.startsWith('.') || SKIP_DIRS.has(child.name) || !child.isDirectory()) continue;
      const childPath = `${entry.name}/${child.name}`;
      tree.push({
        path: childPath,
        kind: 'directory',
        annotation: PATH_ANNOTATIONS[childPath],
      });
      if (tree.length >= 60) break;
    }
    if (tree.length >= 60) break;
  }

  const allFiles = await walkFiles(repoRoot, 3);
  const entrypointCandidates = [
    'package.json', 'server.mjs', 'src/index.ts', 'src/index.tsx', 'src/app/layout.tsx',
    'src/app/page.tsx', 'src/app/api/store/route.ts', 'app/page.tsx', 'index.ts', 'index.js',
  ];
  const entrypoints: string[] = [];
  for (const candidate of entrypointCandidates) {
    if (await pathExists(join(repoRoot, candidate))) entrypoints.push(candidate);
  }

  const coreCandidates = [
    'src/lib/store.ts',
    'src/lib/postgres-column-map.ts',
    'src/lib/workers/config.ts',
    'src/lib/workers/context-assembler.ts',
    'src/lib/workers/worker-runtime.ts',
  ];
  const detectedTypes = allFiles.filter(
    (path) =>
      !/(^|\/)(__tests__|tests?)(\/|$)|\.(test|spec)\.[jt]sx?$/.test(path) &&
      /(^|\/)(types?|schema|interfaces?|store)([-.][^/]*)?\.(ts|tsx|js)$/.test(path),
  );
  const typeLocations: string[] = [];
  for (const path of [...coreCandidates, ...detectedTypes]) {
    if (allFiles.includes(path) && !typeLocations.includes(path)) typeLocations.push(path);
    if (typeLocations.length >= 12) break;
  }
  const testLayout = allFiles
    .filter((path) => /(^|\/)(__tests__|tests?|spec)(\/|$)|\.(test|spec)\.[jt]sx?$/.test(path))
    .slice(0, 10);

  const conventions: string[] = [];
  const conventionFiles = ['AGENTS.md', 'CONTRIBUTING.md', 'README.md', 'tsconfig.json', 'eslint.config.mjs'];
  for (const file of conventionFiles) {
    if (await pathExists(join(repoRoot, file))) conventions.push(`Follow \`${file}\``);
  }
  const pkg = await readPackageJson(repoRoot);
  if (pkg?.scripts?.test) conventions.push(`Test script: \`npm test\` → ${pkg.scripts.test}`);
  if (pkg?.scripts?.lint) conventions.push(`Lint script: \`npm run lint\` → ${pkg.scripts.lint}`);

  return {
    repoName: pkg?.name || basename(repoRoot),
    tree,
    entrypoints,
    typeLocations,
    testLayout,
    verificationCommands,
    conventions,
  };
}
