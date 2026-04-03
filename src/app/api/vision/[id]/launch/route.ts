/**
 * POST /api/vision/[id]/launch
 * 
 * @deprecated — Launch flow simplified to direct task creation from roadmap.
 * This endpoint is no longer called by the Launch button or auto-advance.
 * Kept for potential future use (e.g., AI-generated roadmap proposals).
 */

import { NextRequest, NextResponse } from 'next/server';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { rpc } from '@/lib/gateway-rpc';
import { buildLaunchMessage } from '@/lib/vision-cron';
import { getStoreProvider } from '@/lib/store-provider';

export const dynamic = 'force-dynamic';

/**
 * Detect if we're running with a local Gateway (can make RPC calls)
 * vs. cloud-only mode (must write intent for local LISTEN to pick up)
 */
async function hasLocalGateway(): Promise<boolean> {
  try {
    // Quick check: try connecting to Gateway with a short timeout
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 2000);
    const gatewayUrl = process.env.GATEWAY_URL || 'ws://127.0.0.1:18789';
    // Convert ws:// to http:// for a simple health check
    const httpUrl = gatewayUrl.replace(/^ws/, 'http').replace(/\/+$/, '');
    const res = await fetch(httpUrl, { signal: controller.signal }).catch(() => null);
    clearTimeout(timeout);
    return !!res; // Any response means Gateway is reachable
  } catch {
    return false;
  }
}

/**
 * Resolve devOwner → agentId from store
 */
function resolveAgentId(project: any, store: any): string {
  const teammates = store.settings?.teammates || [];
  const devOwner = project.devOwner || project.owner;
  const match = teammates.find((t: any) =>
    t.name?.toLowerCase() === devOwner?.toLowerCase()
  );
  return match?.agentId || 'main';
}

/**
 * POST /api/vision/[id]/launch
 * 
 * Intent-based launch:
 * - With local Gateway: fires cron job directly + updates state
 * - Without Gateway (cloud): writes needs_launch intent to Postgres,
 *   local LISTEN handler picks it up and executes
 */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id: projectId } = await params;
    const store = await getStoreProvider().read();

    const project = store.projects.find((p: any) => p.id === projectId);
    if (!project) {
      return NextResponse.json({ error: `Project ${projectId} not found` }, { status: 404 });
    }

    // Check for VISION.md — try Postgres doc first, then filesystem
    let hasDoc = false;
    try {
      const docRes = await fetch(`http://127.0.0.1:${process.env.PORT || 4501}/api/vision/${projectId}/doc`);
      hasDoc = docRes.ok;
    } catch {
      // Fallback: check filesystem
      const docPath = project.visionDocPath
        ? project.visionDocPath.startsWith('/') ? project.visionDocPath : join(process.cwd(), project.visionDocPath)
        : join(process.cwd(), 'docs', 'visions', `${projectId}.md`);
      hasDoc = existsSync(docPath);
    }

    if (!hasDoc) {
      return NextResponse.json({ error: 'No vision document found' }, { status: 400 });
    }

    // Check if version already in-flight
    // Allow re-launch from needs_launch (intent pickup) and awaiting_agent_response
    const allowedStates = [null, undefined, 'awaiting_agent_response', 'needs_launch'];
    if (project.autonomy?.pendingVersion && 
        !allowedStates.includes(project.autonomy.pendingVersion)) {
      return NextResponse.json({ error: 'Version already in progress' }, { status: 409 });
    }

    const agentId = resolveAgentId(project, store);
    const gateway = await hasLocalGateway();

    if (gateway) {
      // Local mode: fire directly via Gateway RPC
      const message = buildLaunchMessage(project);
      const at = new Date(Date.now() + 5000).toISOString();
      
      const result = await rpc('cron.add', {
        name: `Vision Launch: ${project.name}`,
        agentId,
        sessionTarget: 'isolated',
        schedule: { kind: 'at', at },
        payload: {
          kind: 'agentTurn',
          message,
          model: 'foundry-openai/gpt-5.4',
          timeoutSeconds: 600,
        },
        delivery: { mode: 'none' },
        deleteAfterRun: true,
      });

      const jobId = result?.id || result?.jobId || undefined;

      // Update state directly — clear _launchIntent if it existed
      const { _launchIntent, ...restAutonomy } = (project.autonomy || {});
      await getStoreProvider().updateProject(projectId, {
        autonomy: {
          ...restAutonomy,
          pendingVersion: 'awaiting_agent_response',
          lastLaunchedAt: Date.now(),
        },
      });

      console.log(`[Vision Launch] Direct — ${project.name} (agent: ${agentId}, job: ${jobId})`);
      return NextResponse.json({ ok: true, launched: true, mode: 'direct', projectId, jobId });

    } else {
      // Cloud/remote mode: write intent — local LISTEN will pick it up
      await getStoreProvider().updateProject(projectId, {
        autonomy: {
          ...(project.autonomy || {}),
          pendingVersion: 'needs_launch',
          lastLaunchedAt: Date.now(),
          _launchIntent: {
            agentId,
            projectName: project.name,
            timestamp: Date.now(),
          },
        },
      });

      console.log(`[Vision Launch] Intent written — ${project.name} (agent: ${agentId}, awaiting local pickup)`);
      return NextResponse.json({ ok: true, launched: true, mode: 'intent', projectId });
    }
  } catch (e: any) {
    console.error('[Vision Launch]', e);
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}
