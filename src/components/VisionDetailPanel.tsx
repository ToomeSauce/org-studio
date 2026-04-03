'use client';

import { Project, updateProject } from '@/lib/store';
import { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import { X, RefreshCw, Pencil, Eye, Save, Loader, CheckCircle2, XCircle, FileText, Clock, ChevronDown, ChevronRight } from 'lucide-react';
import { clsx } from 'clsx';
import { Teammate } from '@/lib/teammates';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

interface VisionDetailPanelProps {
  project: Project;
  teammates: Teammate[];
  allProjects: Project[];
  onClose: () => void;
}

/**
 * Extract a section from markdown by heading.
 * Returns the content between ## <heading> and the next ## heading (or EOF).
 */
function extractSection(content: string, heading: string): string | null {
  const sections = content.split(/^(?=## [^#])/m);
  const target = sections.find((s) => s.startsWith(`## ${heading}`));
  if (!target) return null;
  const body = target.replace(new RegExp(`^## ${heading}\\s*\\n`), '');
  return body.trim() || null;
}

/**
 * Extract the last-updated date from ## Meta section.
 */
function extractLastUpdated(content: string): string | null {
  const meta = extractSection(content, 'Meta');
  if (!meta) return null;
  const match = meta.match(/\*\*Last Updated\*\*\s*(.+)/);
  return match ? match[1].trim() : null;
}

export function VisionDetailPanel({
  project,
  teammates,
  allProjects,
  onClose,
}: VisionDetailPanelProps) {
  const [docContent, setDocContent] = useState<string | null>(null);
  const [docLoading, setDocLoading] = useState(true);
  const [roadmapProgress, setRoadmapProgress] = useState<any>(null);
  const [parsedMeta, setParsedMeta] = useState<Record<string, any>>({});

  // Editor state
  const [editing, setEditing] = useState(false);
  const [editorContent, setEditorContent] = useState('');
  const [saving, setSaving] = useState(false);
  const [saveStatus, setSaveStatus] = useState<'idle' | 'saved' | 'error'>('idle');
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Collapsible sections
  const [metadataOpen, setMetadataOpen] = useState(false);
  const [autonomyOpen, setAutonomyOpen] = useState(false);

  // Autonomy state
  const [autonomyEnabled, setAutonomyEnabled] = useState(project.autonomy?.enabled || false);
  const [autonomyCadence, setAutonomyCadence] = useState<'daily' | 'weekly' | 'biweekly' | 'monthly'>(
    (project.autonomy?.cadence as any) || 'weekly'
  );

  // Load vision doc on mount
  useEffect(() => {
    loadVisionDoc();
  }, [project.id]);

  const loadVisionDoc = async () => {
    setDocLoading(true);
    try {
      const res = await fetch(`/api/vision/${project.id}/doc`);
      if (res.ok) {
        const data = await res.json();
        setDocContent(data.content);
        setEditorContent(data.content);
        setRoadmapProgress(data.roadmapProgress);
        setParsedMeta(data.parsedMeta || {});
      } else {
        setDocContent(null);
      }
    } catch (e) {
      console.error('Failed to load vision doc:', e);
      setDocContent(null);
    } finally {
      setDocLoading(false);
    }
  };

  const handleSave = async () => {
    setSaving(true);
    setSaveStatus('idle');
    try {
      const res = await fetch(`/api/vision/${project.id}/doc`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: editorContent }),
      });
      if (res.ok) {
        const data = await res.json();
        setDocContent(editorContent);
        setRoadmapProgress(data.roadmapProgress);
        setParsedMeta(data.parsedMeta || {});
        setSaveStatus('saved');
        setEditing(false);
        setTimeout(() => setSaveStatus('idle'), 3000);
      } else {
        setSaveStatus('error');
      }
    } catch (e) {
      console.error('Failed to save vision doc:', e);
      setSaveStatus('error');
    } finally {
      setSaving(false);
    }
  };

  const handleCancelEdit = () => {
    setEditorContent(docContent || '');
    setEditing(false);
  };

  const handleStartEdit = () => {
    setEditorContent(docContent || '');
    setEditing(true);
    // Focus textarea after render
    setTimeout(() => textareaRef.current?.focus(), 50);
  };

  const handleToggleAutonomy = async () => {
    const newEnabled = !autonomyEnabled;
    setAutonomyEnabled(newEnabled);
    await updateProject(project.id, {
      autonomy: {
        enabled: newEnabled,
        cadence: autonomyCadence,
        lastProposedAt: project.autonomy?.lastProposedAt,
        lastApprovedAt: project.autonomy?.lastApprovedAt,
        pendingVersion: project.autonomy?.pendingVersion,
      },
    });
  };

  const handleCadenceChange = async (cadence: string) => {
    const validated = cadence as 'daily' | 'weekly' | 'biweekly' | 'monthly';
    setAutonomyCadence(validated);
    await updateProject(project.id, {
      autonomy: {
        enabled: autonomyEnabled,
        cadence: validated,
        lastProposedAt: project.autonomy?.lastProposedAt,
        lastApprovedAt: project.autonomy?.lastApprovedAt,
        pendingVersion: project.autonomy?.pendingVersion,
      },
    });
  };

  // Derived data from doc content
  const northStar = docContent ? extractSection(docContent, 'North Star') : null;
  const currentStatus = docContent ? extractSection(docContent, 'Current Status') : null;
  const lastUpdated = docContent ? extractLastUpdated(docContent) : null;

  const lifecycleBadgeConfig: Record<string, { label: string; color: string; bgColor: string }> = {
    inspiration: { label: '💡 Idea', color: 'text-amber-400', bgColor: 'bg-amber-400/10' },
    building: { label: '🔨 Building', color: 'text-blue-400', bgColor: 'bg-blue-400/10' },
    mature: { label: '🌿 Mature', color: 'text-green-400', bgColor: 'bg-green-400/10' },
    bau: { label: '🔄 BAU', color: 'text-amber-400', bgColor: 'bg-amber-400/10' },
    sunset: { label: '🌅 Sunset', color: 'text-red-400', bgColor: 'bg-red-400/10' },
  };

  const lifecycleBadge = lifecycleBadgeConfig[project.lifecycle || 'building'] || lifecycleBadgeConfig.building;

  // Handle keyboard shortcuts in editor
  const handleEditorKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 's' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      handleSave();
    }
    if (e.key === 'Escape') {
      handleCancelEdit();
    }
    // Tab inserts spaces
    if (e.key === 'Tab') {
      e.preventDefault();
      const target = e.target as HTMLTextAreaElement;
      const start = target.selectionStart;
      const end = target.selectionEnd;
      const newValue = editorContent.substring(0, start) + '  ' + editorContent.substring(end);
      setEditorContent(newValue);
      // Restore cursor position
      setTimeout(() => {
        target.selectionStart = target.selectionEnd = start + 2;
      }, 0);
    }
  };

  const formatTimestamp = (ts?: number): string => {
    if (!ts) return 'Never';
    const now = Date.now();
    const diff = now - ts;
    const seconds = Math.floor(diff / 1000);
    const minutes = Math.floor(seconds / 60);
    const hours = Math.floor(minutes / 60);
    const days = Math.floor(hours / 24);
    if (days > 0) return `${days}d ago`;
    if (hours > 0) return `${hours}h ago`;
    if (minutes > 0) return `${minutes}m ago`;
    return 'just now';
  };

  return (
    <div className="fixed inset-y-0 right-0 w-[640px] max-w-[90vw] bg-[var(--card)] border-l border-[var(--border-default)] shadow-2xl z-40 flex flex-col">
      {/* Header */}
      <div className="flex items-center justify-between px-6 py-4 border-b border-[var(--border-subtle)] shrink-0">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-3 mb-1">
            <FileText size={18} className="text-[var(--accent-primary)] shrink-0" />
            <h2 className="text-lg font-bold text-[var(--text-primary)] truncate">{project.name}</h2>
          </div>
          <div className="flex items-center gap-3 text-[10px]">
            <span className={clsx('font-medium px-2 py-0.5 rounded-full', lifecycleBadge.color, lifecycleBadge.bgColor)}>
              {lifecycleBadge.label}
            </span>
            {project.currentVersion && (
              <span className="text-[var(--text-muted)]">v{project.currentVersion}</span>
            )}
            {lastUpdated && (
              <span className="text-[var(--text-muted)] flex items-center gap-1">
                <Clock size={10} />
                Updated {lastUpdated}
              </span>
            )}
            {roadmapProgress && roadmapProgress.total > 0 && (
              <span className="text-[var(--text-muted)]">
                Roadmap: {roadmapProgress.done}/{roadmapProgress.total}
              </span>
            )}
          </div>
        </div>

        <div className="flex items-center gap-2 shrink-0 ml-3">
          {/* Edit / View toggle */}
          {docContent !== null && !editing && (
            <button
              onClick={handleStartEdit}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-[var(--radius-sm)] bg-[var(--bg-tertiary)] text-[var(--text-muted)] text-[var(--text-xs)] font-medium hover:text-[var(--text-primary)] hover:bg-[var(--bg-secondary)] transition-colors"
              title="Edit document (Markdown)"
            >
              <Pencil size={13} />
              Edit
            </button>
          )}
          {editing && (
            <>
              <button
                onClick={handleSave}
                disabled={saving}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-[var(--radius-sm)] bg-[var(--accent-primary)] text-white text-[var(--text-xs)] font-medium hover:bg-[var(--accent-hover)] transition-colors disabled:opacity-50"
                title="Save (⌘S)"
              >
                {saving ? <Loader size={13} className="animate-spin" /> : <Save size={13} />}
                Save
              </button>
              <button
                onClick={handleCancelEdit}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-[var(--radius-sm)] bg-[var(--bg-tertiary)] text-[var(--text-muted)] text-[var(--text-xs)] font-medium hover:text-[var(--text-primary)] transition-colors"
                title="Cancel (Esc)"
              >
                Cancel
              </button>
            </>
          )}
          {saveStatus === 'saved' && (
            <span className="text-[var(--success)] text-[10px] font-medium flex items-center gap-1">
              <CheckCircle2 size={12} /> Saved
            </span>
          )}
          {saveStatus === 'error' && (
            <span className="text-[var(--error)] text-[10px] font-medium flex items-center gap-1">
              <XCircle size={12} /> Error
            </span>
          )}
          <button
            onClick={onClose}
            className="p-1.5 text-[var(--text-muted)] hover:text-[var(--text-primary)] transition-colors"
          >
            <X size={20} />
          </button>
        </div>
      </div>

      {/* Main content */}
      <div className="flex-1 overflow-y-auto">
        {/* Loading state */}
        {docLoading && (
          <div className="flex flex-col items-center justify-center py-20 text-[var(--text-muted)]">
            <Loader size={24} className="animate-spin mb-3" />
            <span className="text-[var(--text-xs)]">Loading vision document...</span>
          </div>
        )}

        {/* No doc state */}
        {!docLoading && docContent === null && (
          <div className="flex flex-col items-center justify-center py-20 px-8 text-center">
            <FileText size={40} className="text-[var(--text-muted)] mb-4 opacity-40" />
            <h3 className="text-[var(--text-sm)] font-bold text-[var(--text-secondary)] mb-2">No Vision Document</h3>
            <p className="text-[var(--text-xs)] text-[var(--text-muted)] mb-4 max-w-[300px]">
              This project doesn't have a vision document yet. Create one to track the project's north star, roadmap, and boundaries.
            </p>
            <button
              onClick={() => {
                const template = `# ${project.name}\n\n## Meta\n- **Version:** 0.1\n- **Last Updated:** ${new Date().toISOString().split('T')[0]}\n- **Vision Owner:** ${project.visionOwner || ''}\n- **Dev Owner:** ${project.devOwner || ''}\n- **Lifecycle:** ${project.lifecycle || 'building'}\n\n## North Star\n\n_What is the ultimate vision for this project?_\n\n## Current Status\n\n_Where are we right now?_\n\n## Roadmap\n\n### v0.1 (current)\n- [ ] First milestone\n\n## Boundaries\n\n_What are we NOT doing?_\n\n## Change History\n| Date | Version | Author | Change |\n|------|---------|--------|--------|\n| ${new Date().toISOString().split('T')[0]} | 0.1 | — | Initial vision document |\n`;
                setEditorContent(template);
                setDocContent(''); // Placeholder so we enter edit mode
                setEditing(true);
                setTimeout(() => textareaRef.current?.focus(), 50);
              }}
              className="flex items-center gap-2 px-4 py-2 rounded-[var(--radius-sm)] bg-[var(--accent-primary)] text-white text-[var(--text-xs)] font-medium hover:bg-[var(--accent-hover)] transition-colors"
            >
              <Pencil size={14} />
              Create Vision Doc
            </button>
          </div>
        )}

        {/* Editor mode */}
        {!docLoading && editing && (
          <div className="flex flex-col h-full">
            {/* Editor toolbar hint */}
            <div className="px-6 py-2 bg-[var(--bg-secondary)] border-b border-[var(--border-subtle)] flex items-center justify-between">
              <span className="text-[10px] text-[var(--text-muted)] font-medium">
                Editing Markdown — <kbd className="px-1 py-0.5 bg-[var(--bg-tertiary)] rounded text-[9px]">⌘S</kbd> to save, <kbd className="px-1 py-0.5 bg-[var(--bg-tertiary)] rounded text-[9px]">Esc</kbd> to cancel
              </span>
              <span className="text-[10px] text-[var(--text-muted)]">
                {editorContent.length.toLocaleString()} chars
              </span>
            </div>
            <textarea
              ref={textareaRef}
              value={editorContent}
              onChange={e => setEditorContent(e.target.value)}
              onKeyDown={handleEditorKeyDown}
              className="flex-1 w-full px-6 py-4 bg-[var(--bg-primary)] text-[var(--text-primary)] font-mono text-[13px] leading-[1.7] resize-none focus:outline-none selection:bg-[var(--accent-primary)]/20"
              spellCheck={false}
              style={{ minHeight: 'calc(100vh - 180px)' }}
            />
          </div>
        )}

        {/* Reader mode — rendered markdown */}
        {!docLoading && docContent !== null && !editing && (
          <div className="px-6 py-5">
            {/* North Star callout — hero section */}
            {northStar && (
              <div className="mb-6 p-4 rounded-[var(--radius-md)] bg-gradient-to-br from-[var(--accent-primary)]/[0.06] to-[var(--accent-primary)]/[0.02] border border-[var(--accent-primary)]/20">
                <h3 className="text-[10px] font-bold uppercase tracking-wider text-[var(--accent-primary)] mb-2 flex items-center gap-1.5">
                  🎯 North Star
                </h3>
                <div className="text-[var(--text-sm)] text-[var(--text-secondary)] leading-relaxed">
                  <ReactMarkdown remarkPlugins={[remarkGfm]}>{northStar}</ReactMarkdown>
                </div>
              </div>
            )}

            {/* Current Status */}
            {currentStatus && (
              <div className="mb-6 p-4 rounded-[var(--radius-md)] bg-[var(--bg-secondary)] border border-[var(--border-subtle)]">
                <h3 className="text-[10px] font-bold uppercase tracking-wider text-[var(--text-secondary)] mb-2">
                  📍 Current Status
                </h3>
                <div className="text-[var(--text-xs)] text-[var(--text-tertiary)] leading-relaxed">
                  <ReactMarkdown remarkPlugins={[remarkGfm]}>{currentStatus}</ReactMarkdown>
                </div>
              </div>
            )}

            {/* Roadmap progress bar */}
            {roadmapProgress && roadmapProgress.total > 0 && (
              <div className="mb-6">
                <div className="flex items-center justify-between mb-2">
                  <h3 className="text-[10px] font-bold uppercase tracking-wider text-[var(--text-secondary)]">
                    🗺️ Roadmap Progress
                  </h3>
                  <span className="text-[var(--text-xs)] font-bold text-[var(--text-secondary)]">
                    {roadmapProgress.done}/{roadmapProgress.total} ({Math.round((roadmapProgress.done / roadmapProgress.total) * 100)}%)
                  </span>
                </div>
                <div className="h-2 bg-[var(--bg-tertiary)] rounded-full overflow-hidden">
                  <div
                    className="h-full bg-[var(--success)] rounded-full transition-all duration-500"
                    style={{ width: `${(roadmapProgress.done / roadmapProgress.total) * 100}%` }}
                  />
                </div>
              </div>
            )}

            {/* Full document rendered */}
            <div className="vision-doc-content prose prose-sm max-w-none">
              <ReactMarkdown
                remarkPlugins={[remarkGfm]}
                components={{
                  h1: ({ children }) => (
                    <h1 className="text-xl font-bold text-[var(--text-primary)] mt-0 mb-4 pb-2 border-b border-[var(--border-subtle)]">
                      {children}
                    </h1>
                  ),
                  h2: ({ children }) => (
                    <h2 className="text-base font-bold text-[var(--text-primary)] mt-8 mb-3 pb-1.5 border-b border-[var(--border-subtle)]">
                      {children}
                    </h2>
                  ),
                  h3: ({ children }) => (
                    <h3 className="text-sm font-bold text-[var(--text-secondary)] mt-5 mb-2">
                      {children}
                    </h3>
                  ),
                  p: ({ children }) => (
                    <p className="text-[var(--text-xs)] text-[var(--text-tertiary)] leading-relaxed mb-3">
                      {children}
                    </p>
                  ),
                  ul: ({ children }) => (
                    <ul className="text-[var(--text-xs)] text-[var(--text-tertiary)] leading-relaxed mb-3 pl-4 space-y-1 list-disc">
                      {children}
                    </ul>
                  ),
                  ol: ({ children }) => (
                    <ol className="text-[var(--text-xs)] text-[var(--text-tertiary)] leading-relaxed mb-3 pl-4 space-y-1 list-decimal">
                      {children}
                    </ol>
                  ),
                  li: ({ children }) => (
                    <li className="text-[var(--text-xs)] text-[var(--text-tertiary)] leading-relaxed">
                      {children}
                    </li>
                  ),
                  strong: ({ children }) => (
                    <strong className="font-semibold text-[var(--text-secondary)]">{children}</strong>
                  ),
                  em: ({ children }) => (
                    <em className="italic text-[var(--text-muted)]">{children}</em>
                  ),
                  a: ({ href, children }) => (
                    <a href={href} className="text-[var(--accent-primary)] hover:underline" target="_blank" rel="noopener noreferrer">
                      {children}
                    </a>
                  ),
                  code: ({ children, className }) => {
                    const isBlock = className?.includes('language-');
                    if (isBlock) {
                      return (
                        <code className="block bg-[var(--bg-secondary)] rounded-[var(--radius-sm)] p-3 text-[11px] font-mono text-[var(--text-tertiary)] overflow-x-auto mb-3">
                          {children}
                        </code>
                      );
                    }
                    return (
                      <code className="bg-[var(--bg-tertiary)] px-1.5 py-0.5 rounded text-[11px] font-mono text-[var(--text-secondary)]">
                        {children}
                      </code>
                    );
                  },
                  pre: ({ children }) => (
                    <pre className="bg-[var(--bg-secondary)] rounded-[var(--radius-md)] p-4 overflow-x-auto mb-4 border border-[var(--border-subtle)]">
                      {children}
                    </pre>
                  ),
                  table: ({ children }) => (
                    <div className="overflow-x-auto mb-4 rounded-[var(--radius-sm)] border border-[var(--border-subtle)]">
                      <table className="w-full text-[11px]">
                        {children}
                      </table>
                    </div>
                  ),
                  thead: ({ children }) => (
                    <thead className="bg-[var(--bg-secondary)]">
                      {children}
                    </thead>
                  ),
                  th: ({ children }) => (
                    <th className="px-3 py-2 text-left font-semibold text-[var(--text-secondary)] border-b border-[var(--border-subtle)]">
                      {children}
                    </th>
                  ),
                  td: ({ children }) => (
                    <td className="px-3 py-2 text-[var(--text-tertiary)] border-b border-[var(--border-subtle)]">
                      {children}
                    </td>
                  ),
                  input: ({ type, checked, ...props }) => {
                    if (type === 'checkbox') {
                      return (
                        <input
                          type="checkbox"
                          checked={checked}
                          readOnly
                          className="mr-1.5 accent-[var(--success)] pointer-events-none"
                        />
                      );
                    }
                    return <input type={type} {...props} />;
                  },
                  hr: () => (
                    <hr className="my-6 border-[var(--border-subtle)]" />
                  ),
                  blockquote: ({ children }) => (
                    <blockquote className="border-l-3 border-[var(--accent-primary)]/40 pl-4 my-3 text-[var(--text-muted)] italic">
                      {children}
                    </blockquote>
                  ),
                }}
              >
                {docContent}
              </ReactMarkdown>
            </div>

            {/* Refresh button */}
            <div className="mt-6 pt-4 border-t border-[var(--border-subtle)]">
              <button
                onClick={loadVisionDoc}
                className="flex items-center gap-1.5 px-3 py-1.5 bg-[var(--bg-tertiary)] text-[var(--text-muted)] text-[var(--text-xs)] font-medium rounded-[var(--radius-sm)] hover:text-[var(--text-primary)] transition-colors"
              >
                <RefreshCw size={12} /> Refresh Document
              </button>
            </div>
          </div>
        )}

        {/* Collapsible: Metadata */}
        {!docLoading && docContent !== null && !editing && (
          <div className="px-6 pb-4">
            <button
              onClick={() => setMetadataOpen(!metadataOpen)}
              className="flex items-center gap-2 w-full py-2 text-[var(--text-xs)] font-bold uppercase tracking-wider text-[var(--text-muted)] hover:text-[var(--text-secondary)] transition-colors"
            >
              {metadataOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
              Project Metadata
            </button>
            {metadataOpen && (
              <div className="space-y-3 pb-3 pl-5">
                <MetaField label="Vision Owner" value={project.visionOwner} />
                <MetaField label="Dev Owner" value={project.devOwner} />
                <MetaField label="QA Owner" value={project.qaOwner} />
                <MetaField label="Version" value={project.currentVersion ? `v${project.currentVersion}` : undefined} />
                <MetaField label="Repository" value={project.repoUrl} />
                {project.dependsOn && project.dependsOn.length > 0 && (
                  <div className="text-[var(--text-xs)]">
                    <span className="text-[var(--text-muted)] font-semibold">Dependencies: </span>
                    <span className="text-[var(--text-tertiary)]">
                      {project.dependsOn.map(id => allProjects.find(p => p.id === id)?.name || id).join(', ')}
                    </span>
                  </div>
                )}
              </div>
            )}

            {/* Collapsible: Autonomy */}
            <button
              onClick={() => setAutonomyOpen(!autonomyOpen)}
              className="flex items-center gap-2 w-full py-2 text-[var(--text-xs)] font-bold uppercase tracking-wider text-[var(--text-muted)] hover:text-[var(--text-secondary)] transition-colors"
            >
              {autonomyOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
              🤖 Autonomy
            </button>
            {autonomyOpen && (
              <div className="space-y-3 pb-4 pl-5">
                <div className="flex items-center justify-between">
                  <span className="text-[var(--text-xs)] text-[var(--text-muted)]">Enabled</span>
                  <button
                    onClick={handleToggleAutonomy}
                    className={clsx(
                      'relative inline-flex h-5 w-9 items-center rounded-full transition-colors',
                      autonomyEnabled ? 'bg-[var(--success)]' : 'bg-[var(--bg-tertiary)]'
                    )}
                  >
                    <span className={clsx(
                      'inline-block h-4 w-4 transform rounded-full bg-white transition-transform',
                      autonomyEnabled ? 'translate-x-4' : 'translate-x-0.5'
                    )} />
                  </button>
                </div>
                {autonomyEnabled && (
                  <>
                    <div className="flex items-center justify-between">
                      <span className="text-[var(--text-xs)] text-[var(--text-muted)]">Cadence</span>
                      <select
                        value={autonomyCadence}
                        onChange={e => handleCadenceChange(e.target.value)}
                        className="bg-[var(--bg-tertiary)] border border-[var(--border-strong)] rounded px-2 py-1 text-[var(--text-xs)] text-[var(--text-primary)] cursor-pointer"
                      >
                        <option value="daily">Daily</option>
                        <option value="weekly">Weekly</option>
                        <option value="biweekly">Biweekly</option>
                        <option value="monthly">Monthly</option>
                      </select>
                    </div>
                    <div className="text-[10px] text-[var(--text-muted)] space-y-1">
                      <div className="flex justify-between">
                        <span>Last Proposed:</span>
                        <span className="text-[var(--text-tertiary)]">{formatTimestamp(project.autonomy?.lastProposedAt)}</span>
                      </div>
                      <div className="flex justify-between">
                        <span>Last Approved:</span>
                        <span className="text-[var(--text-tertiary)]">{formatTimestamp(project.autonomy?.lastApprovedAt)}</span>
                      </div>
                    </div>
                  </>
                )}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function MetaField({ label, value }: { label: string; value?: string }) {
  return (
    <div className="text-[var(--text-xs)]">
      <span className="text-[var(--text-muted)] font-semibold">{label}: </span>
      <span className="text-[var(--text-tertiary)]">{value || 'Not set'}</span>
    </div>
  );
}
