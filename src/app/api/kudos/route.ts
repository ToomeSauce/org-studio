'use server';

import { NextRequest, NextResponse } from 'next/server';
import { join } from 'path';
import { writeFileSync, readFileSync, existsSync, mkdirSync } from 'fs';

/**
 * Kudos API — Store & retrieve kudos/flags for agents
 * 
 * GET /api/kudos?agentId=ana&type=kudos&limit=20
 * POST /api/kudos { agentId, givenBy, values, note, type, taskId?, projectId? }
 * 
 * Fallback: data/kudos.json when DATABASE_URL unavailable
 */

interface Kudos {
  id: string;
  agentId: string;
  givenBy: string;
  taskId?: string;
  projectId?: string;
  values: string[];
  note: string;
  type: 'kudos' | 'flag';
  autoDetected: boolean;
  confirmed: boolean;
  createdAt: number;
}

// Fallback file path for local storage
const KUDOS_FILE = join(process.cwd(), 'data', 'kudos.json');

/**
 * Load kudos from file (fallback when DB unavailable)
 */
function loadKudosFile(): Kudos[] {
  try {
    if (!existsSync(KUDOS_FILE)) return [];
    const content = readFileSync(KUDOS_FILE, 'utf-8');
    return JSON.parse(content) || [];
  } catch {
    return [];
  }
}

/**
 * Save kudos to file (fallback when DB unavailable)
 */
function saveKudosFile(kudos: Kudos[]): void {
  const dir = join(process.cwd(), 'data');
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(KUDOS_FILE, JSON.stringify(kudos, null, 2), 'utf-8');
}

/**
 * Try to load from PostgreSQL; fallback to file
 */
async function loadKudosFromDB(): Promise<Kudos[]> {
  if (!process.env.DATABASE_URL) {
    return loadKudosFile();
  }

  try {
    const { Pool } = require('pg');
    const pool = new Pool({ connectionString: process.env.DATABASE_URL });
    const result = await pool.query(
      'SELECT id, agent_id as "agentId", given_by as "givenBy", task_id as "taskId", project_id as "projectId", value_tags as "valueTags", note, type, auto_detected as "autoDetected", confirmed, created_at as "createdAt" FROM org_studio_kudos ORDER BY created_at DESC'
    );
    await pool.end();

    return result.rows.map((row: any) => ({
      ...row,
      values: typeof row.valueTags === 'string' ? JSON.parse(row.valueTags) : row.valueTags,
    }));
  } catch (err) {
    console.warn('[Kudos API] DB load failed, falling back to file:', (err as any).message);
    return loadKudosFile();
  }
}

/**
 * Save to PostgreSQL; fallback to file
 */
async function saveKudosToDB(kudos: Kudos): Promise<void> {
  if (!process.env.DATABASE_URL) {
    const all = loadKudosFile();
    all.push(kudos);
    saveKudosFile(all);
    return;
  }

  try {
    const { Pool } = require('pg');
    const pool = new Pool({ connectionString: process.env.DATABASE_URL });
    await pool.query(
      `INSERT INTO org_studio_kudos 
        (id, agent_id, given_by, task_id, project_id, value_tags, note, type, auto_detected, confirmed, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
      [
        kudos.id,
        kudos.agentId,
        kudos.givenBy,
        kudos.taskId || null,
        kudos.projectId || null,
        JSON.stringify(kudos.values),
        kudos.note,
        kudos.type,
        kudos.autoDetected,
        kudos.confirmed,
        kudos.createdAt,
      ]
    );
    await pool.end();
  } catch (err) {
    console.warn('[Kudos API] DB save failed, falling back to file:', (err as any).message);
    const all = loadKudosFile();
    all.push(kudos);
    saveKudosFile(all);
  }
}

/**
 * GET /api/kudos
 * Query params: ?agentId=ana&type=kudos&limit=20
 */
async function handleGET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const agentId = searchParams.get('agentId');
  const type = searchParams.get('type') as 'kudos' | 'flag' | null;
  const limit = parseInt(searchParams.get('limit') || '20', 10);

  let kudos = await loadKudosFromDB();

  // Filter
  if (agentId) {
    kudos = kudos.filter(k => k.agentId.toLowerCase() === agentId.toLowerCase());
  }
  if (type) {
    kudos = kudos.filter(k => k.type === type);
  }

  // Sort by most recent first
  kudos.sort((a, b) => b.createdAt - a.createdAt);

  // Limit
  kudos = kudos.slice(0, limit);

  return NextResponse.json({ kudos });
}

/**
 * POST /api/kudos
 * Create kudos, delete kudos, or update kudos
 * Body: 
 *   - Create: { agentId, givenBy, values, note, type, taskId?, projectId?, autoDetected?, confirmed? }
 *   - Delete: { action: "delete", id }
 *   - Update: { action: "update", id, note, values }
 */
async function handlePOST(req: NextRequest) {
  // TODO: Require session/Bearer auth
  // For now, assume trusted internal API

  const body = await req.json();
  const { action } = body;

  // DELETE action
  if (action === 'delete') {
    const { id } = body;
    if (!id) {
      return NextResponse.json(
        { error: 'Missing required field: id' },
        { status: 400 }
      );
    }

    if (!process.env.DATABASE_URL) {
      // File-based deletion
      const all = loadKudosFile();
      const filtered = all.filter(k => k.id !== id);
      saveKudosFile(filtered);
      return NextResponse.json({ ok: true });
    }

    try {
      const { Pool } = require('pg');
      const pool = new Pool({ connectionString: process.env.DATABASE_URL });
      await pool.query('DELETE FROM org_studio_kudos WHERE id = $1', [id]);
      await pool.end();
      return NextResponse.json({ ok: true });
    } catch (err) {
      console.error('Error deleting kudos:', err);
      // Fallback to file deletion
      const all = loadKudosFile();
      const filtered = all.filter(k => k.id !== id);
      saveKudosFile(filtered);
      return NextResponse.json({ ok: true });
    }
  }

  // UPDATE action
  if (action === 'update') {
    const { id, note, values } = body;
    if (!id || !note || !values) {
      return NextResponse.json(
        { error: 'Missing required fields: id, note, values' },
        { status: 400 }
      );
    }

    if (!process.env.DATABASE_URL) {
      // File-based update
      const all = loadKudosFile();
      const updated = all.map(k =>
        k.id === id ? { ...k, note, values } : k
      );
      saveKudosFile(updated);
      const kudos = updated.find(k => k.id === id);
      return NextResponse.json({ ok: true, kudos });
    }

    try {
      const { Pool } = require('pg');
      const pool = new Pool({ connectionString: process.env.DATABASE_URL });
      await pool.query(
        'UPDATE org_studio_kudos SET note = $1, value_tags = $2 WHERE id = $3',
        [note, JSON.stringify(values), id]
      );
      await pool.end();
      // Fetch updated kudos
      const result = await loadKudosFromDB();
      const kudos = result.find(k => k.id === id);
      return NextResponse.json({ ok: true, kudos });
    } catch (err) {
      console.error('Error updating kudos:', err);
      // Fallback to file update
      const all = loadKudosFile();
      const updated = all.map(k =>
        k.id === id ? { ...k, note, values } : k
      );
      saveKudosFile(updated);
      const kudos = updated.find(k => k.id === id);
      return NextResponse.json({ ok: true, kudos });
    }
  }

  // CREATE action (default)
  const { agentId, givenBy, values, note, type = 'kudos', taskId, projectId, autoDetected = false, confirmed = true } = body;

  if (!agentId || !givenBy || !note || !values?.length) {
    return NextResponse.json(
      { error: 'Missing required fields: agentId, givenBy, note, values' },
      { status: 400 }
    );
  }

  if (!['kudos', 'flag'].includes(type)) {
    return NextResponse.json(
      { error: 'Invalid type; must be "kudos" or "flag"' },
      { status: 400 }
    );
  }

  const kudos: Kudos = {
    id: Math.random().toString(36).slice(2, 10) + Date.now().toString(36),
    agentId,
    givenBy,
    taskId,
    projectId,
    values,
    note,
    type,
    autoDetected,
    confirmed,
    createdAt: Date.now(),
  };

  await saveKudosToDB(kudos);

  return NextResponse.json({ ok: true, kudos });
}

export async function GET(req: NextRequest) {
  return handleGET(req);
}

export async function POST(req: NextRequest) {
  return handlePOST(req);
}
