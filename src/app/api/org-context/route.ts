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
import { generateOrgMd } from '@/lib/org-generator';
import { generatePrinciples } from '@/lib/principles-generator';
import { getStoreProvider } from '@/lib/store-provider';

async function readStore() {
  try {
    return await getStoreProvider().read();
  } catch {
    return null;
  }
}

export async function GET(request: NextRequest) {
  const store = await readStore();
  if (!store) {
    return NextResponse.json({ error: 'Store not initialized' }, { status: 503 });
  }

  const { searchParams } = new URL(request.url);
  const agentId = searchParams.get('agent');
  const format = searchParams.get('format');

  // Load operating principles for agent if specified
  let operatingPrinciples = undefined;
  if (agentId) {
    operatingPrinciples = await generatePrinciples(agentId);
  }

  const ctx = {
    missionStatement: store.settings?.missionStatement || '',
    values: store.settings?.values,
    teammates: store.settings?.teammates || [],
    operatingPrinciples,
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
      ...(operatingPrinciples ? { operatingPrinciples } : {}),
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

