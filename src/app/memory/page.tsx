'use client';

import { PageHeader } from '@/components/PageHeader';
import { Brain, Search, Calendar, FileText, BookOpen } from 'lucide-react';
import { clsx } from 'clsx';
import { useState, useEffect } from 'react';

interface MemoryFile { name: string; date: string; size: number; }
interface SearchResult { file: string; line: number; text: string; }

export default function MemoryPage() {
  const [files, setFiles] = useState<MemoryFile[]>([]);
  const [hasLongTerm, setHasLongTerm] = useState(false);
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [content, setContent] = useState<string>('');
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<SearchResult[]>([]);
  const [searching, setSearching] = useState(false);

  useEffect(() => {
    fetch('/api/memory?action=list')
      .then(r => r.json())
      .then(d => { setFiles(d.files || []); setHasLongTerm(d.hasLongTerm); })
      .catch(() => {});
  }, []);

  const loadFile = async (file: string) => {
    setSelectedFile(file);
    setSearchResults([]);
    try {
      const r = await fetch(`/api/memory?action=read&file=${encodeURIComponent(file)}`);
      const d = await r.json();
      setContent(d.content || '');
    } catch { setContent('Failed to load'); }
  };

  const handleSearch = async () => {
    if (!searchQuery.trim()) return;
    setSearching(true);
    setSelectedFile(null);
    try {
      const r = await fetch(`/api/memory?action=search&q=${encodeURIComponent(searchQuery)}`);
      const d = await r.json();
      setSearchResults(d.results || []);
    } catch { setSearchResults([]); }
    setSearching(false);
  };

  return (
    <div className="space-y-6">
      <PageHeader title="Memory" description="Daily journal entries and long-term memory" />

      {/* Search */}
      <div className="flex gap-3">
        <div className="relative flex-1 max-w-md">
          <Search size={15} className="absolute left-3.5 top-1/2 -translate-y-1/2 text-[var(--text-muted)]" />
          <input
            value={searchQuery}
            onChange={e => setSearchQuery(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && handleSearch()}
            placeholder="Search memories..."
            className="w-full pl-10 pr-4 py-2.5 text-[var(--text-base)] bg-[var(--bg-secondary)] border border-[var(--border-default)] rounded-[var(--radius-md)] text-[var(--text-primary)] placeholder-[var(--text-muted)] outline-none focus:border-[var(--accent-primary)] transition-colors"
          />
        </div>
        <button onClick={handleSearch}
          className="px-4 py-2.5 text-[var(--text-sm)] font-medium bg-[var(--accent-primary)] text-white rounded-[var(--radius-md)] hover:bg-[var(--accent-hover)] transition-colors">
          Search
        </button>
      </div>

      <div className="flex gap-6" style={{ height: 'calc(100vh - 260px)' }}>
        {/* File list */}
        <div className="w-[260px] shrink-0 space-y-2 overflow-y-auto pr-2">
          {hasLongTerm && (
            <button
              onClick={() => loadFile('MEMORY.md')}
              className={clsx(
                'w-full text-left px-4 py-3 rounded-[var(--radius-md)] border transition-all',
                selectedFile === 'MEMORY.md'
                  ? 'border-[rgba(255,92,92,0.3)] bg-[var(--accent-muted)] text-[var(--accent-primary)]'
                  : 'border-[var(--border-default)] bg-[var(--card)] hover:border-[var(--border-strong)] text-[var(--text-primary)]'
              )}
            >
              <div className="flex items-center gap-2.5 mb-1">
                <BookOpen size={15} className="text-[var(--accent-primary)]" />
                <span className="text-[var(--text-sm)] font-semibold">Long-Term Memory</span>
              </div>
              <span className="text-[var(--text-xs)] text-[var(--text-muted)]">MEMORY.md — curated knowledge</span>
            </button>
          )}

          <div className="text-[var(--text-xs)] font-semibold text-[var(--text-muted)] uppercase tracking-wide px-2 pt-3">
            Daily Journal ({files.length})
          </div>

          {files.map(f => (
            <button
              key={f.name}
              onClick={() => loadFile(f.name)}
              className={clsx(
                'w-full text-left px-4 py-2.5 rounded-[var(--radius-md)] border transition-all',
                selectedFile === f.name
                  ? 'border-[rgba(255,92,92,0.3)] bg-[var(--accent-muted)] text-[var(--accent-primary)]'
                  : 'border-transparent hover:bg-[var(--bg-hover)] text-[var(--text-secondary)]'
              )}
            >
              <div className="flex items-center gap-2.5">
                <Calendar size={14} className="shrink-0 text-[var(--text-muted)]" />
                <span className="text-[var(--text-sm)] font-medium">{f.date}</span>
                <span className="text-[var(--text-xs)] text-[var(--text-muted)] ml-auto">{Math.round(f.size / 1024)}kb</span>
              </div>
            </button>
          ))}

          {files.length === 0 && (
            <p className="text-[var(--text-sm)] text-[var(--text-muted)] px-4 py-6">No memory files found</p>
          )}
        </div>

        {/* Content */}
        <div className="flex-1 min-w-0">
          {searchResults.length > 0 ? (
            <div className="bg-[var(--card)] border border-[var(--border-default)] rounded-[var(--radius-lg)] h-full overflow-y-auto">
              <div className="px-5 py-4 border-b border-[var(--border-subtle)]">
                <h2 className="text-[var(--text-md)] font-semibold">Search Results ({searchResults.length})</h2>
              </div>
              <div className="divide-y divide-[var(--border-subtle)]">
                {searchResults.map((r, i) => (
                  <div key={i} className="px-5 py-3.5 hover:bg-[var(--bg-hover)] cursor-pointer transition-colors"
                    onClick={() => loadFile(r.file)}>
                    <div className="flex items-center gap-2.5 mb-1">
                      <FileText size={13} className="text-[var(--text-muted)]" />
                      <span className="text-[var(--text-sm)] font-medium text-[var(--accent-primary)]">{r.file}</span>
                      <span className="text-[var(--text-xs)] text-[var(--text-muted)]">line {r.line}</span>
                    </div>
                    <p className="text-[var(--text-sm)] text-[var(--text-secondary)] leading-relaxed">{r.text}</p>
                  </div>
                ))}
              </div>
            </div>
          ) : selectedFile ? (
            <div className="bg-[var(--card)] border border-[var(--border-default)] rounded-[var(--radius-lg)] h-full flex flex-col">
              <div className="px-5 py-4 border-b border-[var(--border-subtle)] flex items-center gap-2.5">
                <Brain size={16} className="text-[var(--accent-primary)]" />
                <h2 className="text-[var(--text-md)] font-semibold">{selectedFile}</h2>
              </div>
              <div className="flex-1 overflow-y-auto p-5">
                <pre className="text-[var(--text-base)] text-[var(--text-secondary)] leading-relaxed whitespace-pre-wrap font-[var(--font-body)]">{content}</pre>
              </div>
            </div>
          ) : (
            <div className="h-full flex items-center justify-center text-[var(--text-base)] text-[var(--text-muted)]">
              Select a memory file or search to get started
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
