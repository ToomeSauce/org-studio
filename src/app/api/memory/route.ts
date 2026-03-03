import { NextRequest, NextResponse } from 'next/server';
import fs from 'fs';
import path from 'path';

const WORKSPACE = process.env.HOME ? path.join(process.env.HOME, '.openclaw/workspace') : '/tmp';
const MEMORY_DIR = path.join(WORKSPACE, 'memory');
const MEMORY_MD = path.join(WORKSPACE, 'MEMORY.md');

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const action = searchParams.get('action') || 'list';
  const file = searchParams.get('file');
  const query = searchParams.get('q');

  try {
    if (action === 'list') {
      // List daily memory files
      const files: { name: string; date: string; size: number }[] = [];
      if (fs.existsSync(MEMORY_DIR)) {
        const entries = fs.readdirSync(MEMORY_DIR).filter(f => f.endsWith('.md')).sort().reverse();
        for (const entry of entries) {
          const stat = fs.statSync(path.join(MEMORY_DIR, entry));
          const dateMatch = entry.match(/(\d{4}-\d{2}-\d{2})/);
          files.push({ name: entry, date: dateMatch?.[1] || entry, size: stat.size });
        }
      }
      const hasLongTerm = fs.existsSync(MEMORY_MD);
      return NextResponse.json({ files, hasLongTerm });
    }

    if (action === 'read' && file) {
      let filePath: string;
      if (file === 'MEMORY.md') {
        filePath = MEMORY_MD;
      } else {
        // Sanitize
        const safe = path.basename(file);
        filePath = path.join(MEMORY_DIR, safe);
      }
      if (!fs.existsSync(filePath)) return NextResponse.json({ error: 'Not found' }, { status: 404 });
      const content = fs.readFileSync(filePath, 'utf-8');
      return NextResponse.json({ content, file });
    }

    if (action === 'search' && query) {
      const q = query.toLowerCase();
      const results: { file: string; line: number; text: string }[] = [];
      const searchFile = (filePath: string, name: string) => {
        if (!fs.existsSync(filePath)) return;
        const lines = fs.readFileSync(filePath, 'utf-8').split('\n');
        lines.forEach((line, i) => {
          if (line.toLowerCase().includes(q)) {
            results.push({ file: name, line: i + 1, text: line.trim().slice(0, 200) });
          }
        });
      };
      searchFile(MEMORY_MD, 'MEMORY.md');
      if (fs.existsSync(MEMORY_DIR)) {
        for (const entry of fs.readdirSync(MEMORY_DIR).filter(f => f.endsWith('.md'))) {
          searchFile(path.join(MEMORY_DIR, entry), entry);
        }
      }
      return NextResponse.json({ results: results.slice(0, 50), query });
    }

    return NextResponse.json({ error: 'Unknown action' }, { status: 400 });
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}
