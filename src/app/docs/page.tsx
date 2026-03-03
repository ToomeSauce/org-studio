'use client';

import { PageHeader } from '@/components/PageHeader';
import { FileText, Search, FolderOpen } from 'lucide-react';
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
    <div className="space-y-6">
      <PageHeader title="Docs" description={`${docs.length} documents across ${categories.length} categories`} />

      {/* Search + filter */}
      <div className="flex gap-3 items-center">
        <div className="relative flex-1 max-w-md">
          <Search size={15} className="absolute left-3.5 top-1/2 -translate-y-1/2 text-[var(--text-muted)]" />
          <input value={searchQuery} onChange={e => setSearchQuery(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && handleSearch()}
            placeholder="Search all docs..."
            className="w-full pl-10 pr-4 py-2.5 text-[var(--text-base)] bg-[var(--bg-secondary)] border border-[var(--border-default)] rounded-[var(--radius-md)] text-[var(--text-primary)] placeholder-[var(--text-muted)] outline-none focus:border-[var(--accent-primary)] transition-colors"
          />
        </div>
        <button onClick={handleSearch}
          className="px-4 py-2.5 text-[var(--text-sm)] font-medium bg-[var(--accent-primary)] text-white rounded-[var(--radius-md)] hover:bg-[var(--accent-hover)] transition-colors">
          Search
        </button>
        <select value={filterCat} onChange={e => setFilterCat(e.target.value)}
          className="text-[var(--text-sm)] px-3 py-2.5 bg-[var(--bg-secondary)] border border-[var(--border-default)] rounded-[var(--radius-md)] text-[var(--text-secondary)] outline-none">
          <option value="all">All Categories</option>
          {categories.map(c => <option key={c} value={c}>{c}</option>)}
        </select>
      </div>

      <div className="flex gap-6" style={{ height: 'calc(100vh - 260px)' }}>
        {/* File list */}
        <div className="w-[300px] shrink-0 overflow-y-auto pr-2 space-y-1.5">
          {filteredDocs.map(doc => (
            <button key={doc.id} onClick={() => loadDoc(doc.path)}
              className={clsx(
                'w-full text-left px-4 py-3 rounded-[var(--radius-md)] border transition-all',
                selectedDoc === doc.path
                  ? 'border-[rgba(255,92,92,0.3)] bg-[var(--accent-muted)]'
                  : 'border-transparent hover:bg-[var(--bg-hover)]'
              )}
            >
              <div className="flex items-center gap-2.5 mb-1">
                <FileText size={14} className={selectedDoc === doc.path ? 'text-[var(--accent-primary)]' : 'text-[var(--text-muted)]'} />
                <span className={clsx('text-[var(--text-sm)] font-medium truncate',
                  selectedDoc === doc.path ? 'text-[var(--accent-primary)]' : 'text-[var(--text-primary)]'
                )}>{doc.name}</span>
              </div>
              <div className="flex items-center gap-2.5 text-[var(--text-xs)] text-[var(--text-muted)] pl-6">
                <span className="px-2 py-0.5 rounded bg-[var(--bg-tertiary)]">{doc.category}</span>
                <span>{formatDate(doc.modifiedAt)}</span>
                <span>{Math.round(doc.size / 1024)}kb</span>
              </div>
            </button>
          ))}
          {filteredDocs.length === 0 && (
            <p className="text-[var(--text-sm)] text-[var(--text-muted)] px-4 py-6 text-center">No docs found</p>
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
                    onClick={() => loadDoc(r.path)}>
                    <div className="flex items-center gap-2.5 mb-1">
                      <FileText size={13} className="text-[var(--text-muted)]" />
                      <span className="text-[var(--text-sm)] font-medium text-[var(--accent-primary)]">{r.name}</span>
                      <span className="text-[var(--text-xs)] px-2 py-0.5 rounded bg-[var(--bg-tertiary)] text-[var(--text-muted)]">{r.category}</span>
                      <span className="text-[var(--text-xs)] text-[var(--text-muted)]">line {r.line}</span>
                    </div>
                    <p className="text-[var(--text-sm)] text-[var(--text-secondary)] leading-relaxed">{r.text}</p>
                  </div>
                ))}
              </div>
            </div>
          ) : selectedDoc ? (
            <div className="bg-[var(--card)] border border-[var(--border-default)] rounded-[var(--radius-lg)] h-full flex flex-col">
              <div className="px-5 py-4 border-b border-[var(--border-subtle)] flex items-center gap-2.5">
                <FileText size={16} className="text-[var(--accent-primary)]" />
                <h2 className="text-[var(--text-md)] font-semibold">{selectedName}</h2>
              </div>
              <div className="flex-1 overflow-y-auto p-5">
                <pre className="text-[var(--text-base)] text-[var(--text-secondary)] leading-relaxed whitespace-pre-wrap font-[var(--font-body)]">{content}</pre>
              </div>
            </div>
          ) : (
            <div className="h-full flex items-center justify-center text-[var(--text-base)] text-[var(--text-muted)]">
              <div className="text-center space-y-3">
                <FolderOpen size={28} className="mx-auto opacity-50" />
                <p>Select a document to view</p>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
