/**
 * GET /api/runtimes — Get all runtimes with health + discovered agents
 * Used by onboarding wizard and settings pages
 */
import { NextRequest, NextResponse } from 'next/server';
import { getRuntimeRegistry } from '@/lib/runtimes/registry';

export async function GET(request: NextRequest) {
  try {
    const registry = await getRuntimeRegistry();

    // Discover all agents from all runtimes
    const allAgents = await registry.discoverAll();

    // Get health status for each runtime
    const health = await registry.healthAll();

    // Group agents by runtime for the response
    const runtimes = [
      {
        id: 'openclaw',
        name: 'OpenClaw',
        connected: health.openclaw?.connected || false,
        detail: health.openclaw?.detail,
        agents: allAgents.filter(a => a.runtime === 'openclaw'),
      },
      {
        id: 'hermes',
        name: 'Hermes Agent',
        connected: health.hermes?.connected || false,
        detail: health.hermes?.detail,
        agents: allAgents.filter(a => a.runtime === 'hermes'),
      },
    ];

    return NextResponse.json({ runtimes });
  } catch (e: any) {
    const msg = typeof e === 'string' ? e : e?.message || 'Unknown error';
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
