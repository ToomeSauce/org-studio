/**
 * GET /api/org-context
 *
 * Returns org context for agents to consume.
 *
 * Query params:
 *   ?agent=<agentId>  — returns personalized ORG.md with "Your Domain" section
 *   ?format=json      — returns structured JSON instead of markdown
 *   (no params)       — returns generic ORG.md for all agents
 *
 * This is the generic REST API that any agent framework can poll.
 */
import { NextRequest, NextResponse } from 'next/server';
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { generateOrgMd } from '@/lib/org-generator';

const STORE_PATH = join(process.cwd(), 'data', 'store.json');

function readStore() {
  if (!existsSync(STORE_PATH)) return null;
  try { return JSON.parse(readFileSync(STORE_PATH, 'utf-8')); } catch { return null; }
}

export async function GET(request: NextRequest) {
  const store = readStore();
  if (!store) {
    return NextResponse.json({ error: 'Store not initialized' }, { status: 503 });
  }

  const { searchParams } = new URL(request.url);
  const agentId = searchParams.get('agent');
  const format = searchParams.get('format');

  const ctx = {
    missionStatement: store.settings?.missionStatement || '',
    values: store.settings?.values,
    teammates: store.settings?.teammates || [],
  };

  // JSON format — structured data for programmatic consumption
  if (format === 'json') {
    const teammate = agentId
      ? ctx.teammates.find((t: any) => t.agentId === agentId || t.id === agentId)
      : null;

    return NextResponse.json({
      mission: ctx.missionStatement,
      values: ctx.values,
      team: ctx.teammates.map((t: any) => ({
        id: t.agentId || t.id,
        name: t.name,
        domain: t.domain,
        owns: t.owns || null,
        defers: t.defers || null,
        isHuman: t.isHuman || false,
      })),
      ...(teammate ? {
        you: {
          id: teammate.agentId || teammate.id,
          name: teammate.name,
          domain: teammate.domain,
          role: teammate.title,
          owns: teammate.owns || null,
          defers: teammate.defers || null,
        },
      } : {}),
    });
  }

  // Markdown format (default) — ready to drop into agent workspace
  const md = generateOrgMd(ctx, agentId || undefined);
  return new NextResponse(md, {
    headers: { 'Content-Type': 'text/markdown; charset=utf-8' },
  });
}
