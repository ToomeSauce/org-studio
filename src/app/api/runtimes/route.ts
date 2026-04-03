/**
 * GET /api/runtimes — Discover all configured runtimes with health + agents
 * 
 * Returns only runtimes that are actually configured (based on env vars
 * and local detection). A fresh install with no runtimes returns an empty array.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getRuntimeRegistry } from '@/lib/runtimes/registry';

export async function GET(request: NextRequest) {
  try {
    const registry = await getRuntimeRegistry();

    // Discover all agents from all configured runtimes
    const allAgents = await registry.discoverAll();

    // Get health status for each runtime
    const health = await registry.healthAll();

    // Build response dynamically from whatever runtimes are registered
    const runtimes = Object.entries(health).map(([id, status]) => ({
      id,
      name: registry.getRuntimeName(id) || id,
      connected: status.connected,
      detail: status.detail,
      agents: allAgents.filter(a => a.runtime === id),
    }));

    return NextResponse.json({ runtimes });
  } catch (e: any) {
    const msg = typeof e === 'string' ? e : e?.message || 'Unknown error';
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
