import { NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';

/**
 * GET /api/settings/storage
 * Returns info about the current storage provider (file vs postgres)
 */
export async function GET() {
  const dbUrl = process.env.DATABASE_URL;

  if (dbUrl) {
    // Parse connection string for display (mask password)
    let host = 'remote';
    let database = 'unknown';
    let connected = false;

    try {
      const url = new URL(dbUrl.replace(/^postgresql:/, 'http:'));
      host = url.hostname;
      database = url.pathname.replace(/^\//, '') || 'unknown';
    } catch {}

    // Test connection
    try {
      const { getStoreProvider } = await import('@/lib/store-provider');
      const provider = getStoreProvider();
      const store = await provider.read();
      connected = !!(store && store.projects);
    } catch {
      connected = false;
    }

    return NextResponse.json({
      provider: 'postgres',
      host,
      database,
      connected,
    });
  }

  // File-based storage
  const { existsSync } = await import('fs');
  const { join } = await import('path');
  const storePath = join(process.cwd(), 'data', 'store.json');

  return NextResponse.json({
    provider: 'file',
    path: 'data/store.json',
    connected: existsSync(storePath),
  });
}
