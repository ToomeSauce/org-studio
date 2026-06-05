import { NextRequest, NextResponse } from 'next/server';
import { cloudReadGate } from '@/lib/read-gate';

/**
 * GET /api/activity-feed
 * Returns the last 50 events from the activity feed
 */
export async function GET(req: NextRequest) {
  const denied = await cloudReadGate(req); // #1624 F-P5
  if (denied) return denied;
  try {
    // Get feed from global storage (set by server.mjs)
    const feedApi = (globalThis as any).__orgStudioActivityFeed;
    const feed = feedApi?.get?.() || [];
    
    return NextResponse.json({
      events: feed,
      ts: Date.now(),
    });
  } catch (e: any) {
    console.error('[Activity Feed] GET failed:', e?.message);
    return NextResponse.json({ error: e?.message }, { status: 500 });
  }
}
