'use client';

import { PageHeader } from '@/components/PageHeader';
import { FileText, Search, Filter, Calendar, FolderOpen } from 'lucide-react';
import { clsx } from 'clsx';
import { useState, useEffect, useMemo } from 'react';

interface Doc { id: string; name: string; category: string; path: string; size: number; modifiedAt: number; }
interface SearchResult { name: string; category: string; path: string; line: number; text: string; }

function formatDate(ms: number) {
  const d = new Date(ms);
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

export default function DocsPage() {
  const [docs, setDocs] = useState<Doc[]>([]);
  const [categories, setCategories] = useState<string[]>([]);
  const [filterCat, setFilterCat] = useState('all');
  const [selectedDoc, setSelectedDoc] = useState<string | null>(null);
  const [content, setContent] = useState('');
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<SearchResult[]>([]);

  useEffect(() => {
    fetch('/api/docs?action=list')
      .then(r => r.json())
      .then(d => { setDocs(d.docs || []); setCategories(d.categories || []); })
      .catch(() => {});
  }, []);

  const filteredDocs = useMemo(() => {
    if (filterCat === 'all') return docs;
    return docs.filter(d => d.category === filterCat);
  }, [docs, filterCat]);

  const loadDoc = async (docPath: string) => {
    setSelectedDoc(docPath);
    setSearchResults([]);
    try {
      const r = await fetch(`/api/docs?action=read&path=${encodeURIComponent(docPath)}`);
      const d = await r.json();
      setContent(d.content || '');
    } catch { setContent('Failed to load'); }
  };

  const handleSearch = async () => {
    if (!searchQuery.trim()) return;
    setSelectedDoc(null);
    try {
      const r = await fetch(`/api/docs?action=search&q=${encodeURIComponent(searchQuery)}`);
      const d = await r.json();
      setSearchResults(d.results || []);
    } catch { setSearchResults([]); }
  };

  const selectedName = docs.find(d => d.path === selectedDoc)?.name || '';

  return (
    <div className="space-y-5">
      <PageHeader title="Docs" description={`${docs.length} documents across ${categories.length} categories`} />

      {/* Search + filter */}
      <div className="flex gap-2 items-center">
        <div className="relative flex-1 max-w-md">
          <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-[var(--text-muted)]" />
          <input value={searchQuery} onChange={e => setSearchQuery(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && handleSearch()}
            placeholder="Search all docs..."
            className="w-full pl-9 pr-3 py-2 text-sm bg-[var(--bg-secondary)] border border-[var(--border-default)] rounded-[var(--radius-md)] text-[var(--text-primary)] placeholder-[var(--text-muted)] outline-none focus:border-[var(--accent-primary)] transition-colors"
          />
        </div>
        <button onClick={handleSearch}
          className="px-3 py-2 text-sm bg-[var(--accent-primary)] text-white rounded-[var(--radius-md)] hover:bg-[var(--accent-hover)] transition-colors">
          Search
        </button>
        <select value={filterCat} onChange={e => setFilterCat(e.target.value)}
          className="text-[12px] px-2.5 py-2 bg-[var(--bg-secondary)] border border-[var(--border-default)] rounded-[var(--radius-md)] text-[var(--text-secondary)] outline-none">
          <option value="all">All Categories</option>
          {categories.map(c => <option key={c} value={c}>{c}</option>)}
        </select>
      </div>

      <div className="flex gap-5" style={{ height: 'calc(100vh - 240px)' }}>
        {/* File list */}
        <div className="w-[280px] shrink-0 overflow-y-auto pr-2 space-y-1">
          {filteredDocs.map(doc => (
            <button key={doc.path} onClick={() => loadDoc(doc.path)}
              className={clsx(
                'w-full text-left px-3 py-2.5 rounded-[var(--radius-md)] border transition-all',
                selectedDoc === doc.path
                  ? 'border-[rgba(255,92,92,0.3)] bg-[var(--accent-muted)]'
                  : 'border-transparent hover:bg-[var(--bg-hover)]'
              )}
            >
              <div className="flex items-center gap-2 mb-0.5">
                <FileText size={12} className={selectedDoc === doc.path ? 'text-[var(--accent-primary)]' : 'text-[var(--text-muted)]'} />
                <span className={clsx('text-[12px] font-medium truncate',
                  selectedDoc === doc.path ? 'text-[var(--accent-primary)]' : 'text-[var(--text-primary)]'
                )}>{doc.name}</span>
              </div>
              <div className="flex items-center gap-2 text-[10px] text-[var(--text-muted)] pl-5">
                <span className="px-1.5 py-px rounded bg-[var(--bg-tertiary)]">{doc.category}</span>
                <span>{formatDate(doc.modifiedAt)}</span>
                <span>{Math.round(doc.size / 1024)}kb</span>
              </div>
            </button>
          ))}
          {filteredDocs.length === 0 && (
            <p className="text-[11px] text-[var(--text-muted)] px-3 py-4 text-center">No docs found</p>
          )}
        </div>

        {/* Content */}
        <div className="flex-1 min-w-0">
          {searchResults.length > 0 ? (
            <div className="bg-[var(--card)] border border-[var(--border-default)] rounded-[var(--radius-lg)] h-full overflow-y-auto">
              <div className="px-4 py-3 border-b border-[var(--border-subtle)]">
                <h2 className="text-[13px] font-semibold">Search Results ({searchResults.length})</h2>
              </div>
              <div className="divide-y divide-[var(--border-subtle)]">
                {searchResults.map((r, i) => (
                  <div key={i} className="px-4 py-2.5 hover:bg-[var(--bg-hover)] cursor-pointer transition-colors"
                    onClick={() => loadDoc(r.path)}>
                    <div className="flex items-center gap-2 mb-0.5">
                      <FileText size={11} className="text-[var(--text-muted)]" />
                      <span className="text-[11px] font-medium text-[var(--accent-primary)]">{r.name}</span>
                      <span className="text-[10px] px-1.5 py-px rounded bg-[var(--bg-tertiary)] text-[var(--text-muted)]">{r.category}</span>
                      <span className="text-[10px] text-[var(--text-muted)]">line {r.line}</span>
                    </div>
                    <p className="text-[12px] text-[var(--text-secondary)] leading-snug">{r.text}</p>
                  </div>
                ))}
              </div>
            </div>
          ) : selectedDoc ? (
            <div className="bg-[var(--card)] border border-[var(--border-default)] rounded-[var(--radius-lg)] h-full flex flex-col">
              <div className="px-4 py-3 border-b border-[var(--border-subtle)] flex items-center gap-2">
                <FileText size={14} className="text-[var(--accent-primary)]" />
                <h2 className="text-[13px] font-semibold">{selectedName}</h2>
              </div>
              <div className="flex-1 overflow-y-auto p-4">
                <pre className="text-[13px] text-[var(--text-secondary)] leading-relaxed whitespace-pre-wrap font-[var(--font-body)]">{content}</pre>
              </div>
            </div>
          ) : (
            <div className="h-full flex items-center justify-center text-sm text-[var(--text-muted)]">
              <div className="text-center space-y-2">
                <FolderOpen size={24} className="mx-auto opacity-50" />
                <p>Select a document to view</p>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
