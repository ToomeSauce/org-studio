import { NextRequest, NextResponse } from 'next/server';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { authenticateRequestWithContext, requireWriteScope } from '@/lib/auth';
import { resolveWorkspaceIdForRequest } from '@/lib/workspace-auth';
import { getStoreProvider } from '@/lib/store-provider';
import { getWorkerConfigs } from '@/lib/workers/config';
import {
  inspectRepoCheckout,
  MAX_REPO_CONTEXT_BYTES,
  renderRepoContextPack,
} from '@/lib/workers/repo-context';

export const dynamic = 'force-dynamic';

function parseMap(name: string): Record<string, string> {
  try {
    const value = JSON.parse(process.env[name] || '{}');
    return value && typeof value === 'object' ? value : {};
  } catch {
    return {};
  }
}

function currentRepoSlug(cwd: string): string | null {
  try {
    const pkg = JSON.parse(readFileSync(join(cwd, 'package.json'), 'utf8'));
    const raw = typeof pkg?.repository === 'string' ? pkg.repository : pkg?.repository?.url;
    if (typeof raw !== 'string') return null;
    return raw.replace(/^git\+/, '').replace(/^https?:\/\/github\.com\//, '').replace(/\.git$/, '');
  } catch {
    return null;
  }
}

/** Resolve only operator-configured checkouts; never accept a request path. */
function resolveCheckout(projectId: string): string | null {
  const local = parseMap('WORKER_REPO_PATHS')[projectId];
  if (typeof local === 'string' && existsSync(join(local, 'package.json'))) return local;

  // Remote worker configs use repo slugs. Permit the running app checkout only
  // when its package metadata proves it is that configured repository.
  const configuredSlug = parseMap('WORKER_REPO_SLUGS')[projectId];
  const cwd = process.cwd();
  if (configuredSlug && currentRepoSlug(cwd)?.toLowerCase() === configuredSlug.toLowerCase()) {
    return cwd;
  }
  return null;
}

/** Manual v1 generator: inspect configured checkout, render ≤4KB, cache on project. */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const authCtx = await authenticateRequestWithContext(req);
  if (authCtx.error) return authCtx.error;
  const scopeFail = requireWriteScope(authCtx.context);
  if (scopeFail) return scopeFail;

  const { id: projectId } = await params;
  const workspaceId = await resolveWorkspaceIdForRequest(req);
  const provider = getStoreProvider(workspaceId);
  const store = await provider.read();
  const project = store.projects.find((candidate: { id?: string }) => candidate.id === projectId);
  if (!project) return NextResponse.json({ error: 'Project not found' }, { status: 404 });

  const checkout = resolveCheckout(projectId);
  if (!checkout) {
    return NextResponse.json(
      {
        error:
          `No configured checkout for ${projectId}. Set WORKER_REPO_PATHS, or map the running repo in WORKER_REPO_SLUGS.`,
      },
      { status: 409 },
    );
  }

  const worker = getWorkerConfigs().find(
    (candidate) =>
      candidate.lane.projectIds.length === 0 || candidate.lane.projectIds.includes(projectId),
  );
  const input = await inspectRepoCheckout(checkout, worker?.verificationCommands || []);
  const repoContextPack = renderRepoContextPack(input);
  const repoContextPackGeneratedAt = Date.now();
  await provider.updateProject(projectId, { repoContextPack, repoContextPackGeneratedAt });

  return NextResponse.json({
    ok: true,
    projectId,
    generatedAt: repoContextPackGeneratedAt,
    bytes: Buffer.byteLength(repoContextPack, 'utf8'),
    maxBytes: MAX_REPO_CONTEXT_BYTES,
    repoContextPack,
  });
}
