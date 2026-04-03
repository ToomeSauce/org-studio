'use client';

import { PageHeader } from '@/components/PageHeader';
import { type Project, updateProject, addProject } from '@/lib/store';
import { useWSData } from '@/lib/ws';
import { useMemo, useState, useCallback, useRef, useEffect } from 'react';
import { Rocket, Settings, Pencil, Loader, ChevronDown, ChevronRight, CheckCircle2, Plus, X } from 'lucide-react';
import { clsx } from 'clsx';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

// --- Section Parsing Helpers ---

function extractSection(content: string, heading: string): string | null {
  // Split on ## headings (not ### or deeper) and find the matching section
  const sections = content.split(/^(?=## [^#])/m);
  const target = sections.find((s) => s.startsWith(`## ${heading}`));
  if (!target) return null;
  const body = target.replace(new RegExp(`^## ${heading}\\s*\\n`), '');
  return body.trim() || null;
}

interface RoadmapVersion {
  version: string;
  status: 'shipped' | 'current' | 'future';
  date?: string;
  items: Array<{ text: string; done: boolean }>;
}

function parseRoadmapVersions(content: string): RoadmapVersion[] {
  const roadmap = extractSection(content, 'Roadmap');
  if (!roadmap) return [];

  const versions: RoadmapVersion[] = [];
  const versionBlocks = roadmap.split(/(?=### v)/);

  for (const block of versionBlocks) {
    const headerMatch = block.match(
      /### v([\d.]+)\s*(?:—[^(\n]*)?\s*(?:\((shipped[^)]*|current)\))?/
    );
    if (!headerMatch) continue;

    const version = headerMatch[1];
    const statusText = headerMatch[2] || '';
    const status = statusText.startsWith('shipped')
      ? 'shipped'
      : statusText === 'current'
        ? 'current'
        : 'future';
    const dateMatch = statusText.match(/shipped\s+([\d-]+)/);

    const items: Array<{ text: string; done: boolean }> = [];
    const itemMatches = block.matchAll(
      /^-\s+\[([ xX])\]\s+(.+?)(?=\n-\s+\[|$)/gm
    );
    for (const m of itemMatches) {
      items.push({
        text: m[2].split(' — ')[0].trim(),
        done: m[1].toLowerCase() === 'x',
      });
    }

    versions.push({
      version,
      status,
      date: dateMatch?.[1],
      items,
    });
  }

  return versions;
}

// --- Types ---

interface VisionDocData {
  content: string;
  roadmapProgress?: { done: number; total: number };
  parsedMeta?: Record<string, any>;
}

interface ProjectWithVision extends Project {
  visionDoc?: VisionDocData;
  roadmapProgress?: { done: number; total: number };
}

// --- Pill Selector ---

function PillSelector({
  projects,
  selectedId,
  onSelect,
  onNewVision,
}: {
  projects: ProjectWithVision[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  onNewVision: () => void;
}) {
  // Get emoji from project or use a default
  const getEmoji = (project: Project) => {
    const emojiMap: Record<string, string> = {
      Dashboard: '🔧',
      API: '🔌',
      Mobile: '📱',
      Platform: '🎯',
    };
    const firstName = project.name.split(' ')[0];
    return emojiMap[firstName] || '📍';
  };

  // Sort projects by last updated (most recent first), matching sidebar order
  const sortedProjects = [...projects].sort((a, b) => {
    const aTime = ((a as any).updatedAt || (a as any).createdAt || a.autonomy?.lastLaunchedAt || 0);
    const bTime = ((b as any).updatedAt || (b as any).createdAt || b.autonomy?.lastLaunchedAt || 0);
    return bTime - aTime;
  });

  return (
    <div className="flex items-center justify-center gap-3 flex-wrap px-4 py-3">
      {sortedProjects.map((project) => {
        const isActive = project.id === selectedId;
        const emoji = getEmoji(project);
        const progress = project.roadmapProgress;
        const progressPercent = progress
          ? Math.round((progress.done / progress.total) * 100)
          : 0;

        return (
          <div key={project.id} className="flex flex-col items-center">
            <button
              onClick={() => onSelect(project.id)}
              className={clsx(
                'px-4 py-2 rounded-full text-sm font-medium transition-all duration-200 flex items-center gap-2 whitespace-nowrap',
                isActive
                  ? 'bg-[var(--accent)] text-[var(--accent-contrast)] shadow-lg shadow-[var(--accent)]/40'
                  : 'bg-transparent text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-secondary)]'
              )}
            >
              <span>{emoji}</span>
              <span>{project.name}</span>
            </button>
            {progress && progress.total > 0 && (
              <div className="w-10 h-0.5 bg-[var(--bg-tertiary)] rounded-full mt-1 overflow-hidden">
                <div
                  className="h-full bg-[var(--accent)] transition-all duration-300"
                  style={{ width: `${progressPercent}%` }}
                />
              </div>
            )}
          </div>
        );
      })}

      {/* New Vision button */}
      <div className="flex flex-col items-center">
        <button
          onClick={onNewVision}
          className="px-4 py-2 rounded-full text-sm font-medium transition-all duration-200 flex items-center gap-2 whitespace-nowrap border-2 border-dashed border-[var(--border-subtle)] text-[var(--text-muted)] hover:text-[var(--accent)] hover:border-[var(--accent)] hover:bg-[var(--accent)]/5"
        >
          <Plus size={16} />
          <span>New Vision</span>
        </button>
      </div>
    </div>
  );
}

// --- Status Strip ---

function StatusStrip({ project }: { project: ProjectWithVision }) {
  const versionText = project.currentVersion ? `v${project.currentVersion}` : 'no version';
  const pending = project.autonomy?.pendingVersion;

  let statusText: string;
  let detail: string;

  if (pending === 'needs_launch') {
    statusText = 'launching';
    detail = 'waiting for local agent bridge to pick up';
  } else if (pending === 'in-progress') {
    statusText = 'in progress';
    detail = 'version cycle running';
  } else if (pending === 'awaiting_agent_response') {
    statusText = 'awaiting response';
    detail = 'vision cycle launched — waiting for agent';
  } else if (pending) {
    statusText = 'pending approval';
    detail = `v${pending} awaiting approval`;
  } else if (project.autonomy?.lastLaunchedAt) {
    statusText = 'idle';
    detail = `last launched ${new Date(project.autonomy.lastLaunchedAt).toLocaleDateString()}`;
  } else {
    statusText = 'idle';
    detail = 'no active cycle';
  }

  return (
    <div className="text-center py-4 border-b border-[var(--border-subtle)] space-y-2">
      <p className="text-xs text-[var(--text-muted)]">
        {versionText} · {statusText} · {detail}
      </p>
      {/* Outcomes progress summary */}
      {project.outcomes && project.outcomes.length > 0 && (
        <div className="flex flex-col items-center gap-1">
          <span className="text-xs font-semibold text-[var(--text-secondary)]">
            Outcomes: {project.outcomes.filter(o => o.done).length}/{project.outcomes.length}
          </span>
          <div className="w-32 h-1.5 bg-[var(--bg-secondary)] rounded-full overflow-hidden">
            <div
              className="h-full bg-[var(--accent)] transition-all duration-300"
              style={{ width: `${project.outcomes.length > 0 ? Math.round((project.outcomes.filter(o => o.done).length / project.outcomes.length) * 100) : 0}%` }}
            />
          </div>
        </div>
      )}
    </div>
  );
}

// --- Vision Card ---

function VisionCard({
  project,
  docContent,
  docLoading,
  onLaunch,
  onStop,
  onApprovalModeChange,
  launching,
  onEditToggle,
  isEditing,
  onSaveDoc,
}: {
  project: ProjectWithVision;
  docContent: string | null;
  docLoading: boolean;
  onLaunch: () => void;
  onStop: () => void;
  onApprovalModeChange: (mode: 'per-version' | 'per-major') => void;
  launching: boolean;
  onEditToggle: () => void;
  isEditing: boolean;
  onSaveDoc: (content: string) => Promise<void>;
}) {
  const [expandedVersions, setExpandedVersions] = useState<Set<string>>(new Set());
  const [approvalMenuOpen, setApprovalMenuOpen] = useState(false);
  const [viewMode, setViewMode] = useState<'structured' | 'document'>('structured');
  const [editorContent, setEditorContent] = useState(docContent || '');
  const [saving, setSaving] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const serverApprovalMode = project.autonomy?.approvalMode || 'per-version';
  const [optimisticApprovalMode, setOptimisticApprovalMode] = useState<string | null>(null);
  const currentApprovalMode = optimisticApprovalMode || serverApprovalMode;

  // Clear optimistic state when server catches up
  useEffect(() => {
    if (optimisticApprovalMode && serverApprovalMode === optimisticApprovalMode) {
      setOptimisticApprovalMode(null);
    }
  }, [serverApprovalMode, optimisticApprovalMode]);

  // Sync editor content when doc changes externally
  useEffect(() => {
    if (docContent && !isEditing) {
      setEditorContent(docContent);
    }
  }, [docContent, isEditing]);

  // Focus textarea when entering edit mode
  useEffect(() => {
    if (isEditing && textareaRef.current) {
      textareaRef.current.focus();
    }
  }, [isEditing]);

  const versions = docContent ? parseRoadmapVersions(docContent) : [];
  const northStar = docContent ? extractSection(docContent, 'North Star') : null;
  const currentStatus = docContent ? extractSection(docContent, 'Current Status') : null;
  const boundaries = docContent ? extractSection(docContent, 'Boundaries') : null;
  const aspirations = docContent ? extractSection(docContent, 'Aspirations') : null;

  const [boundariesOpen, setBoundariesOpen] = useState(false);
  const [aspirationsOpen, setAspirationsOpen] = useState(false);

  const toggleVersion = (version: string) => {
    const next = new Set(expandedVersions);
    if (next.has(version)) {
      next.delete(version);
    } else {
      next.add(version);
    }
    setExpandedVersions(next);
  };

  // Auto-expand current version on load
  useEffect(() => {
    if (versions.length > 0 && expandedVersions.size === 0) {
      const currentIdx = versions.findIndex((v) => v.status === 'current');
      if (currentIdx >= 0) {
        setExpandedVersions(new Set([versions[currentIdx].version]));
      }
    }
  }, [versions, expandedVersions.size]);

  const pending = project.autonomy?.pendingVersion;
  const versionInFlight =
    pending &&
    pending !== 'in-progress' &&
    pending !== 'awaiting_agent_response' &&
    pending !== 'needs_launch';
  const isRunning = pending === 'in-progress' || pending === 'awaiting_agent_response' || pending === 'needs_launch';
  const canLaunch = docContent && !versionInFlight && !isRunning && !launching;
  const canStop = isRunning && !launching;

  // Debug logging for stop button visibility and state
  console.log('[VisionCard:state]', {
    projectId: project.id,
    pending,
    versionInFlight,
    isRunning,
    canLaunch,
    canStop,
    launching,
    autonomy: project.autonomy,
  });

  return (
    <div className="flex flex-col h-full bg-[var(--bg)]">
      {/* Header Row */}
      <div className="px-4 md:px-6 py-4 border-b border-[var(--border-subtle)] flex flex-col md:flex-row md:items-center md:justify-between gap-4">
        <div className="flex-1 min-w-0">
          <h1 className="text-2xl font-bold text-[var(--text-primary)] mb-2 break-words">
            {project.name}
          </h1>
          {project.currentVersion && (
            <div className="flex flex-wrap items-center gap-2">
              <span className="px-2 py-1 rounded-md bg-[var(--bg-secondary)] text-xs font-medium text-[var(--text-muted)]">
                v{project.currentVersion}
              </span>
              {project.lifecycle && (
                <span className="px-2 py-1 rounded-md bg-[var(--bg-secondary)] text-xs font-medium text-[var(--accent)]">
                  {project.lifecycle}
                </span>
              )}
            </div>
          )}
        </div>

        <div className="flex flex-wrap items-center gap-2 w-full md:w-auto md:shrink-0">
          {/* View Mode Toggle */}
          <div className="flex items-center gap-1 bg-[var(--bg-secondary)] rounded-md p-1">
            <button
              onClick={() => setViewMode('structured')}
              className={clsx(
                'px-3 py-1.5 rounded-sm text-xs font-medium transition-colors',
                viewMode === 'structured'
                  ? 'bg-[var(--accent)] text-[var(--accent-contrast)]'
                  : 'text-[var(--text-muted)] hover:text-[var(--text-primary)]'
              )}
            >
              Structured
            </button>
            <button
              onClick={() => setViewMode('document')}
              className={clsx(
                'px-3 py-1.5 rounded-sm text-xs font-medium transition-colors',
                viewMode === 'document'
                  ? 'bg-[var(--accent)] text-[var(--accent-contrast)]'
                  : 'text-[var(--text-muted)] hover:text-[var(--text-primary)]'
              )}
            >
              Document
            </button>
          </div>

          {/* Approval Mode Toggle */}
          <div className="relative">
            <button
              onClick={() => setApprovalMenuOpen(!approvalMenuOpen)}
              className="p-2 rounded-md hover:bg-[var(--bg-secondary)] transition-colors"
              title="Approval mode"
            >
              <Settings size={18} className="text-[var(--text-muted)]" />
            </button>
            {approvalMenuOpen && (
              <div className="absolute right-0 mt-2 w-56 bg-[var(--card)] border border-[var(--border-subtle)] rounded-md shadow-lg z-50 py-1">
                <button
                  onClick={() => {
                    setOptimisticApprovalMode('per-version');
                    onApprovalModeChange('per-version');
                    setTimeout(() => setApprovalMenuOpen(false), 350);
                  }}
                  className={clsx(
                    'flex items-center justify-between w-full text-left px-4 py-2.5 text-sm transition-colors first:rounded-t-md',
                    currentApprovalMode === 'per-version'
                      ? 'text-[var(--accent)] bg-[var(--accent)]/5'
                      : 'text-[var(--text-primary)] hover:bg-[var(--bg-secondary)]'
                  )}
                >
                  <span>Approve each version</span>
                  {currentApprovalMode === 'per-version' && (
                    <CheckCircle2 size={14} className="text-[var(--accent)]" />
                  )}
                </button>
                <button
                  onClick={() => {
                    setOptimisticApprovalMode('per-major');
                    onApprovalModeChange('per-major');
                    setTimeout(() => setApprovalMenuOpen(false), 350);
                  }}
                  className={clsx(
                    'flex items-center justify-between w-full text-left px-4 py-2.5 text-sm transition-colors last:rounded-b-md',
                    currentApprovalMode === 'per-major'
                      ? 'text-[var(--accent)] bg-[var(--accent)]/5'
                      : 'text-[var(--text-primary)] hover:bg-[var(--bg-secondary)]'
                  )}
                >
                  <span>Approve per major version</span>
                  {currentApprovalMode === 'per-major' && (
                    <CheckCircle2 size={14} className="text-[var(--accent)]" />
                  )}
                </button>
              </div>
            )}
          </div>

          {/* Edit / Save / Cancel */}
          {isEditing ? (
            <>
              <button
                onClick={async () => {
                  setSaving(true);
                  try {
                    await onSaveDoc(editorContent);
                  } finally {
                    setSaving(false);
                  }
                }}
                disabled={saving}
                className="px-3 py-1.5 rounded-md bg-[var(--accent)] text-white text-xs font-medium hover:opacity-90 transition-all flex items-center gap-1.5 disabled:opacity-50"
              >
                {saving ? <Loader size={14} className="animate-spin" /> : <CheckCircle2 size={14} />}
                Save
              </button>
              <button
                onClick={() => {
                  setEditorContent(docContent || '');
                  onEditToggle();
                }}
                className="px-3 py-1.5 rounded-md bg-[var(--bg-secondary)] text-[var(--text-muted)] text-xs font-medium hover:text-[var(--text-primary)] transition-colors"
              >
                Cancel
              </button>
            </>
          ) : (
            <button
              onClick={() => {
                setEditorContent(docContent || '');
                onEditToggle();
              }}
              disabled={!docContent}
              className="p-2 rounded-md hover:bg-[var(--bg-secondary)] transition-colors disabled:opacity-30"
              title="Edit vision document"
            >
              <Pencil size={18} className="text-[var(--text-muted)]" />
            </button>
          )}

          {/* Launch / Stop Button */}
          {canStop ? (
            <button
              onClick={() => {
                console.log('[VisionCard:StopButton] clicked', { projectId: project.id, pending, isRunning });
                onStop();
              }}
              className="px-4 py-2 rounded-md font-medium text-sm flex items-center gap-2 transition-all bg-red-500/10 text-red-400 border border-red-500/30 hover:bg-red-500/20"
            >
              <X size={16} />
              Stop
            </button>
          ) : (
            <button
              onClick={onLaunch}
              disabled={!canLaunch}
              className={clsx(
                'px-4 py-2 rounded-md font-medium text-sm flex items-center gap-2 transition-all',
                canLaunch
                  ? 'bg-[var(--accent)] text-white hover:opacity-90'
                  : 'bg-[var(--bg-secondary)] text-[var(--text-muted)] cursor-not-allowed opacity-50'
              )}
            >
              {launching ? (
                <>
                  <Loader size={16} className="animate-spin" />
                  Launching...
                </>
              ) : versionInFlight ? (
                <>
                  <span>v{pending} Pending</span>
                </>
              ) : (
                <>
                  <Rocket size={16} />
                  Launch
                </>
              )}
            </button>
          )}
        </div>
      </div>

      {/* Main Content - Scrollable */}
      <div className="flex-1 overflow-y-auto">
        {docLoading ? (
          <div className="flex items-center justify-center py-12">
            <Loader size={24} className="animate-spin text-[var(--text-muted)]" />
          </div>
        ) : !docContent ? (
          <div className="text-center py-12 text-[var(--text-muted)] px-6">
            <p className="mb-2">No vision document found</p>
            <p className="text-xs">Create a VISION.md to get started</p>
          </div>
        ) : isEditing ? (
          /* Editor Mode */
          <div className="flex flex-col h-full">
            <div className="px-4 md:px-6 py-2 bg-[var(--bg-secondary)] border-b border-[var(--border-subtle)] flex items-center justify-between">
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
              onChange={(e) => setEditorContent(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 's' && (e.metaKey || e.ctrlKey)) {
                  e.preventDefault();
                  setSaving(true);
                  onSaveDoc(editorContent).finally(() => setSaving(false));
                }
                if (e.key === 'Escape') {
                  setEditorContent(docContent || '');
                  onEditToggle();
                }
              }}
              className="flex-1 w-full px-4 md:px-6 py-4 bg-[var(--bg)] text-[var(--text-primary)] font-mono text-[13px] leading-[1.7] resize-none focus:outline-none"
              spellCheck={false}
              style={{ minHeight: 'calc(100vh - 280px)' }}
            />
          </div>
        ) : viewMode === 'document' ? (
          /* Document View — properly rendered markdown */
          <div className="px-4 md:px-6 py-6">
            <div className="vision-doc-rendered max-w-none">
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
                    <p className="text-sm text-[var(--text-secondary)] leading-relaxed mb-3">
                      {children}
                    </p>
                  ),
                  ul: ({ children }) => (
                    <ul className="text-sm text-[var(--text-secondary)] leading-relaxed mb-3 pl-4 space-y-1 list-disc">
                      {children}
                    </ul>
                  ),
                  ol: ({ children }) => (
                    <ol className="text-sm text-[var(--text-secondary)] leading-relaxed mb-3 pl-4 space-y-1 list-decimal">
                      {children}
                    </ol>
                  ),
                  li: ({ children }) => (
                    <li className="text-sm text-[var(--text-secondary)] leading-relaxed">
                      {children}
                    </li>
                  ),
                  strong: ({ children }) => (
                    <strong className="font-semibold text-[var(--text-primary)]">{children}</strong>
                  ),
                  em: ({ children }) => (
                    <span className="text-[var(--text-muted)]">{children}</span>
                  ),
                  a: ({ href, children }) => (
                    <a href={href} className="text-[var(--accent)] hover:underline" target="_blank" rel="noopener noreferrer">
                      {children}
                    </a>
                  ),
                  code: ({ children, className }) => {
                    const isBlock = className?.includes('language-');
                    if (isBlock) {
                      return (
                        <code className="block bg-[var(--bg-secondary)] rounded-md p-3 text-[11px] font-mono text-[var(--text-secondary)] overflow-x-auto mb-3">
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
                    <pre className="bg-[var(--bg-secondary)] rounded-md p-4 overflow-x-auto mb-4 border border-[var(--border-subtle)]">
                      {children}
                    </pre>
                  ),
                  table: ({ children }) => (
                    <div className="overflow-x-auto mb-4 rounded-md border border-[var(--border-subtle)]">
                      <table className="w-full text-[11px]">{children}</table>
                    </div>
                  ),
                  thead: ({ children }) => (
                    <thead className="bg-[var(--bg-secondary)]">{children}</thead>
                  ),
                  th: ({ children }) => (
                    <th className="px-3 py-2 text-left font-semibold text-[var(--text-secondary)] border-b border-[var(--border-subtle)]">
                      {children}
                    </th>
                  ),
                  td: ({ children }) => (
                    <td className="px-3 py-2 text-[var(--text-secondary)] border-b border-[var(--border-subtle)]">
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
                  hr: () => <hr className="my-6 border-[var(--border-subtle)]" />,
                  blockquote: ({ children }) => (
                    <blockquote className="border-l-3 border-[var(--accent)]/40 pl-4 my-3 text-[var(--text-muted)]">
                      {children}
                    </blockquote>
                  ),
                }}
              >
                {docContent}
              </ReactMarkdown>
            </div>
          </div>
        ) : (
          <div className="px-4 md:px-6 py-6 space-y-6">
            {/* North Star */}
            {northStar ? (
              <div className="bg-gradient-to-br from-[var(--accent)]/5 to-transparent border border-[var(--accent)]/20 rounded-lg p-6">
                <div className="text-lg font-medium text-[var(--text-primary)] leading-relaxed prose prose-invert max-w-none">
                  <ReactMarkdown remarkPlugins={[remarkGfm]}>{northStar}</ReactMarkdown>
                </div>
              </div>
            ) : (
              <div className="text-center py-6 text-[var(--text-muted)]">
                <p className="text-sm">No North Star defined yet</p>
              </div>
            )}

            {/* Current Status */}
            {currentStatus && (
              <div className="bg-[var(--bg-card)] border border-[var(--border)] rounded-lg p-4">
                <h2 className="text-sm font-semibold text-[var(--text-muted)] uppercase tracking-wide mb-2">Current Status</h2>
                <div className="text-sm text-[var(--text-primary)] leading-relaxed">
                  <ReactMarkdown remarkPlugins={[remarkGfm]}>{currentStatus}</ReactMarkdown>
                </div>
              </div>
            )}

            {/* Roadmap Timeline */}
            {versions.length > 0 ? (
              <div className="space-y-3">
                <h2 className="text-lg font-semibold text-[var(--text-primary)]">
                  Roadmap
                </h2>
                <div className="space-y-2">
                  {[...versions].reverse().map((version, idx) => {
                    const isExpanded = expandedVersions.has(version.version);
                    const isShipped = version.status === 'shipped';
                    const isCurrent = version.status === 'current';
                    const tasksDone = version.items.filter((item) => item.done).length;
                    const tasksTotal = version.items.length;

                    return (
                      <div
                        key={version.version}
                        className={clsx(
                          'border rounded-lg transition-all',
                          isCurrent
                            ? 'border-[var(--accent)] bg-[var(--accent)]/5'
                            : isShipped
                              ? 'border-[var(--success)] bg-[var(--success)]/5'
                              : 'border-[var(--border-subtle)] bg-[var(--bg-secondary)]/30 opacity-60'
                        )}
                      >
                        <button
                          onClick={() => toggleVersion(version.version)}
                          className="w-full px-4 py-3 flex items-center justify-between hover:bg-[var(--bg-secondary)]/50 transition-colors"
                        >
                          <div className="flex items-center gap-3 flex-1">
                            {isShipped ? (
                              expandedVersions.has(version.version) ? (
                                <ChevronRight
                                  size={16}
                                  className="text-[var(--success)] transition-transform rotate-90"
                                />
                              ) : (
                                <ChevronRight
                                  size={16}
                                  className="text-[var(--success)] transition-transform"
                                />
                              )
                            ) : (
                              <ChevronRight
                                size={16}
                                className={clsx(
                                  'text-[var(--text-muted)] transition-transform',
                                  isExpanded && 'rotate-90'
                                )}
                              />
                            )}
                            <div className="text-left">
                              <p className="font-semibold text-[var(--text-primary)]">
                                v{version.version}
                              </p>
                              {version.date && (
                                <p className="text-xs text-[var(--text-muted)]">
                                  {version.date}
                                </p>
                              )}
                            </div>
                          </div>

                          {isCurrent && tasksTotal > 0 && (
                            <div className="text-right">
                              <p className="text-xs font-medium text-[var(--text-primary)]">
                                {tasksDone}/{tasksTotal}
                              </p>
                              <div className="w-16 h-1.5 bg-[var(--bg-secondary)] rounded-full overflow-hidden mt-1">
                                <div
                                  className="h-full bg-[var(--accent)]"
                                  style={{
                                    width: `${(tasksDone / tasksTotal) * 100}%`,
                                  }}
                                />
                              </div>
                            </div>
                          )}
                        </button>

                        {/* Expanded Content */}
                        {(isExpanded || isCurrent) && (
                          <div className="px-4 py-3 border-t border-[var(--border-subtle)]/50 bg-[var(--bg-secondary)]/30">
                            <ul className="space-y-2">
                              {version.items.map((item, itemIdx) => (
                                <li
                                  key={itemIdx}
                                  className="flex items-start gap-2 text-sm text-[var(--text-secondary)]"
                                >
                                  <input
                                    type="checkbox"
                                    checked={item.done}
                                    readOnly
                                    className="mt-0.5"
                                  />
                                  <span
                                    className={clsx(
                                      'flex-1',
                                      item.done &&
                                        'line-through text-[var(--text-muted)]'
                                    )}
                                  >
                                    <ReactMarkdown 
                                      remarkPlugins={[remarkGfm]}
                                      components={{
                                        p: ({ children }) => <span>{children}</span>,
                                      }}
                                    >
                                      {item.text}
                                    </ReactMarkdown>
                                  </span>
                                </li>
                              ))}
                            </ul>
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>
            ) : (
              <div className="text-center py-6 text-[var(--text-muted)]">
                <p className="text-sm">No roadmap defined yet</p>
              </div>
            )}

            {/* Boundaries Section */}
            {boundaries && (
              <div>
                <button
                  onClick={() => setBoundariesOpen(!boundariesOpen)}
                  className="flex items-center gap-2 text-lg font-semibold text-[var(--text-primary)] mb-2 hover:text-[var(--accent)] transition-colors"
                >
                  <ChevronRight
                    size={18}
                    className={clsx(
                      'transition-transform',
                      boundariesOpen && 'rotate-90'
                    )}
                  />
                  Boundaries
                </button>
                {boundariesOpen && (
                  <div className="prose prose-invert max-w-none text-sm text-[var(--text-secondary)]">
                    <ReactMarkdown remarkPlugins={[remarkGfm]}>
                      {boundaries}
                    </ReactMarkdown>
                  </div>
                )}
              </div>
            )}

            {/* Aspirations Section */}
            {aspirations && (
              <div>
                <button
                  onClick={() => setAspirationsOpen(!aspirationsOpen)}
                  className="flex items-center gap-2 text-lg font-semibold text-[var(--text-primary)] mb-2 hover:text-[var(--accent)] transition-colors"
                >
                  <ChevronRight
                    size={18}
                    className={clsx(
                      'transition-transform',
                      aspirationsOpen && 'rotate-90'
                    )}
                  />
                  Aspirations
                </button>
                {aspirationsOpen && (
                  <div className="prose prose-invert max-w-none text-sm text-[var(--text-secondary)]">
                    <ReactMarkdown remarkPlugins={[remarkGfm]}>
                      {aspirations}
                    </ReactMarkdown>
                  </div>
                )}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

// --- New Vision Modal ---

function NewVisionModal({
  existingProjects,
  teammates,
  onCreated,
  onClose,
}: {
  existingProjects: Project[];
  teammates: string[];
  onCreated: (projectId: string) => void;
  onClose: () => void;
}) {
  const [name, setName] = useState('');
  const [lifecycle, setLifecycle] = useState<'building' | 'mature' | 'bau' | 'sunset'>('building');
  const [visionOwner, setVisionOwner] = useState(teammates[0] || '');
  const [devOwner, setDevOwner] = useState(teammates[1] || teammates[0] || '');
  const [northStar, setNorthStar] = useState('');
  const [creating, setCreating] = useState(false);
  const [useExisting, setUseExisting] = useState(false);
  const [existingProjectId, setExistingProjectId] = useState('');

  // Projects that don't have vision docs yet
  const projectsWithoutVision = existingProjects.filter(p => !p.visionDocPath);

  const handleCreate = async () => {
    if (useExisting && !existingProjectId) return;
    if (!useExisting && !name.trim()) return;
    setCreating(true);

    try {
      let projectId: string;

      if (useExisting) {
        projectId = existingProjectId;
        // Set the visionDocPath on the existing project
        await updateProject(projectId, {
          visionDocPath: `docs/visions/${projectId}.md`,
          lifecycle,
          visionOwner: visionOwner || undefined,
          devOwner: devOwner || undefined,
        });
      } else {
        // Create new project
        const project = await addProject({
          name: name.trim(),
          description: '',
          phase: 'active',
          owner: visionOwner || '',
          priority: 'medium',
          createdBy: 'vision-page',
          visionDocPath: '', // Will be set after ID is generated
          lifecycle,
          visionOwner: visionOwner || undefined,
          devOwner: devOwner || undefined,
        });
        projectId = project.id;

        // Update with the vision doc path now that we have the ID
        await updateProject(projectId, {
          visionDocPath: `docs/visions/${projectId}.md`,
        });
      }

      const projectName = useExisting
        ? existingProjects.find(p => p.id === existingProjectId)?.name || name
        : name.trim();

      // Create the vision doc template
      const today = new Date().toISOString().split('T')[0];
      const template = `# ${projectName}

## Meta
- **Version:** 0.1
- **Last Updated:** ${today}
- **Vision Owner:** ${visionOwner}
- **Dev Owner:** ${devOwner}
- **Lifecycle:** ${lifecycle}

## North Star
${northStar.trim() || '_What is the ultimate vision for this project?_'}

## Current Status
_Starting fresh — v0.1 development has not begun._

## Roadmap

### v0.1 (current)
- [ ] Define scope and first milestone

## Boundaries
_What are we NOT doing?_

## Change History
| Date | Version | Author | Change |
|------|---------|--------|--------|
| ${today} | 0.1 | ${visionOwner} | Initial vision document |
`;

      await fetch(`/api/vision/${projectId}/doc`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: template }),
      });

      onCreated(projectId);
    } catch (e) {
      console.error('Create vision error:', e);
    } finally {
      setCreating(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
      <div className="bg-[var(--bg-primary)] border border-[var(--border-default)] rounded-lg shadow-2xl w-full max-w-lg mx-4">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-[var(--border-subtle)]">
          <h2 className="text-lg font-bold text-[var(--text-primary)]">New Vision</h2>
          <button
            onClick={onClose}
            className="p-1.5 rounded-md hover:bg-[var(--bg-hover)] text-[var(--text-muted)] transition-colors"
          >
            <X size={18} />
          </button>
        </div>

        {/* Body */}
        <div className="px-6 py-5 space-y-4">
          {/* Toggle: new project vs existing */}
          {projectsWithoutVision.length > 0 && (
            <div className="flex items-center gap-1 bg-[var(--bg-secondary)] rounded-md p-1 mb-2">
              <button
                onClick={() => setUseExisting(false)}
                className={clsx(
                  'flex-1 px-3 py-1.5 rounded-sm text-xs font-medium transition-colors',
                  !useExisting
                    ? 'bg-[var(--accent)] text-white'
                    : 'text-[var(--text-muted)] hover:text-[var(--text-primary)]'
                )}
              >
                New Project
              </button>
              <button
                onClick={() => setUseExisting(true)}
                className={clsx(
                  'flex-1 px-3 py-1.5 rounded-sm text-xs font-medium transition-colors',
                  useExisting
                    ? 'bg-[var(--accent)] text-white'
                    : 'text-[var(--text-muted)] hover:text-[var(--text-primary)]'
                )}
              >
                Existing Project
              </button>
            </div>
          )}

          {useExisting ? (
            <div>
              <label className="text-xs font-semibold text-[var(--text-muted)] mb-1.5 block">Select Project</label>
              <select
                value={existingProjectId}
                onChange={(e) => {
                  setExistingProjectId(e.target.value);
                  const proj = existingProjects.find(p => p.id === e.target.value);
                  if (proj) {
                    setName(proj.name);
                    if (proj.visionOwner) setVisionOwner(proj.visionOwner);
                    if (proj.devOwner) setDevOwner(proj.devOwner);
                    if (proj.lifecycle) setLifecycle(proj.lifecycle as any);
                  }
                }}
                className="w-full px-3 py-2 bg-[var(--bg-secondary)] border border-[var(--border-default)] rounded-md text-sm text-[var(--text-primary)] outline-none focus:border-[var(--accent)]"
              >
                <option value="">Choose a project...</option>
                {projectsWithoutVision.map(p => (
                  <option key={p.id} value={p.id}>{p.name}</option>
                ))}
              </select>
            </div>
          ) : (
            <div>
              <label className="text-xs font-semibold text-[var(--text-muted)] mb-1.5 block">Project Name</label>
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="e.g. Mobile App"
                className="w-full px-3 py-2 bg-[var(--bg-secondary)] border border-[var(--border-default)] rounded-md text-sm text-[var(--text-primary)] placeholder-[var(--text-muted)] outline-none focus:border-[var(--accent)]"
                autoFocus
              />
            </div>
          )}

          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
            <div>
              <label className="text-xs font-semibold text-[var(--text-muted)] mb-1.5 block">Lifecycle</label>
              <select
                value={lifecycle}
                onChange={(e) => setLifecycle(e.target.value as any)}
                className="w-full px-3 py-2 bg-[var(--bg-secondary)] border border-[var(--border-default)] rounded-md text-xs text-[var(--text-primary)] outline-none focus:border-[var(--accent)]"
              >
                <option value="building">🔨 Building</option>
                <option value="mature">🌿 Mature</option>
                <option value="bau">🔄 BAU</option>
                <option value="sunset">🌅 Sunset</option>
              </select>
            </div>
            <div>
              <label className="text-xs font-semibold text-[var(--text-muted)] mb-1.5 block">Vision Owner</label>
              <input
                value={visionOwner}
                onChange={(e) => setVisionOwner(e.target.value)}
                placeholder="Owner name"
                className="w-full px-3 py-2 bg-[var(--bg-secondary)] border border-[var(--border-default)] rounded-md text-xs text-[var(--text-primary)] placeholder-[var(--text-muted)] outline-none focus:border-[var(--accent)]"
              />
            </div>
            <div>
              <label className="text-xs font-semibold text-[var(--text-muted)] mb-1.5 block">Dev Owner</label>
              <input
                value={devOwner}
                onChange={(e) => setDevOwner(e.target.value)}
                placeholder="Dev owner"
                className="w-full px-3 py-2 bg-[var(--bg-secondary)] border border-[var(--border-default)] rounded-md text-xs text-[var(--text-primary)] placeholder-[var(--text-muted)] outline-none focus:border-[var(--accent)]"
              />
            </div>
          </div>

          <div>
            <label className="text-xs font-semibold text-[var(--text-muted)] mb-1.5 block">North Star <span className="font-normal text-[var(--text-muted)]">(optional)</span></label>
            <textarea
              value={northStar}
              onChange={(e) => setNorthStar(e.target.value)}
              placeholder="What is the ultimate vision for this project?"
              rows={3}
              className="w-full px-3 py-2 bg-[var(--bg-secondary)] border border-[var(--border-default)] rounded-md text-sm text-[var(--text-primary)] placeholder-[var(--text-muted)] outline-none focus:border-[var(--accent)] resize-none"
            />
          </div>
        </div>

        {/* Footer */}
        <div className="flex items-center justify-end gap-3 px-6 py-4 border-t border-[var(--border-subtle)]">
          <button
            onClick={onClose}
            className="px-4 py-2 text-sm text-[var(--text-muted)] hover:text-[var(--text-primary)] transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={handleCreate}
            disabled={creating || (useExisting ? !existingProjectId : !name.trim())}
            className="px-5 py-2 rounded-md bg-[var(--accent)] text-white text-sm font-medium hover:opacity-90 transition-all disabled:opacity-40 disabled:cursor-not-allowed flex items-center gap-2"
          >
            {creating ? (
              <>
                <Loader size={14} className="animate-spin" />
                Creating...
              </>
            ) : (
              <>
                <Plus size={14} />
                Create Vision
              </>
            )}
          </button>
        </div>
      </div>
    </div>
  );
}

// --- Main Page ---

export default function VisionPage() {
  const storeData = useWSData<any>('store') as any;
  const allProjects: Project[] = storeData?.projects || [];
  const loading = !storeData;

  // Filter projects with vision docs
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(null);
  const [docContent, setDocContent] = useState<string | null>(null);
  const [docLoading, setDocLoading] = useState(false);
  const [launching, setLaunching] = useState(false);
  const [isEditing, setIsEditing] = useState(false);
  const [showNewVision, setShowNewVision] = useState(false);

  // Get teammate names for owner dropdowns
  const teammates: string[] = (storeData?.settings?.teammates || []).map((t: any) => t.name).filter(Boolean);

  // Track which projects have vision docs (loaded once, then on-demand)
  const [visionDocIds, setVisionDocIds] = useState<Set<string>>(new Set());
  const [initialLoadDone, setInitialLoadDone] = useState(false);

  // One-time load: discover which projects have vision docs
  useEffect(() => {
    if (allProjects.length === 0 || initialLoadDone) return;

    const discoverVisionDocs = async () => {
      const ids = new Set<string>();
      for (const project of allProjects) {
        try {
          const res = await fetch(`/api/vision/${project.id}/doc`);
          if (res.ok) ids.add(project.id);
        } catch (e) {
          // Skip
        }
      }
      setVisionDocIds(ids);
      setInitialLoadDone(true);
    };

    discoverVisionDocs();
  }, [allProjects, initialLoadDone]);

  // Derive projectsWithVision from WS data + known vision doc IDs
  // This updates immediately when allProjects changes (e.g. after updateProject)
  const projectsWithVision = useMemo(() => {
    if (!initialLoadDone) return [];
    return allProjects
      .filter(p => visionDocIds.has(p.id))
      .sort(
        (a, b) =>
          (b.autonomy?.lastLaunchedAt || b.createdAt || 0) -
          (a.autonomy?.lastLaunchedAt || a.createdAt || 0)
      );
  }, [allProjects, visionDocIds, initialLoadDone]);

  // Auto-select first project
  useEffect(() => {
    if (projectsWithVision.length > 0 && !selectedProjectId) {
      setSelectedProjectId(projectsWithVision[0].id);
    }
  }, [projectsWithVision, selectedProjectId]);

  // Load vision doc when selected project changes
  const selectedProject = useMemo(
    () =>
      projectsWithVision.find((p) => p.id === selectedProjectId) ||
      projectsWithVision[0] ||
      null,
    [projectsWithVision, selectedProjectId]
  );

  useEffect(() => {
    if (selectedProject) {
      loadVisionDoc(selectedProject.id);
    }
  }, [selectedProject?.id]);

  const loadVisionDoc = async (projectId: string) => {
    setDocLoading(true);
    try {
      const res = await fetch(`/api/vision/${projectId}/doc`);
      if (res.ok) {
        const data = (await res.json()) as VisionDocData;
        setDocContent(data.content);
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

  const handleLaunch = async () => {
    if (!selectedProject) return;
    setLaunching(true);
    try {
      const res = await fetch(`/api/vision/${selectedProject.id}/launch`, {
        method: 'POST',
      });
      const data = await res.json();
      if (data.ok) {
        // Refresh doc to show updated state
        await loadVisionDoc(selectedProject.id);
      } else {
        console.error('Launch failed:', data.error);
      }
    } catch (e) {
      console.error('Launch error:', e);
    } finally {
      setLaunching(false);
    }
  };

  const handleApprovalModeChange = async (
    mode: 'per-version' | 'per-major'
  ) => {
    if (!selectedProject) return;
    await updateProject(selectedProject.id, {
      autonomy: {
        ...(selectedProject.autonomy || {}),
        enabled: selectedProject.autonomy?.enabled ?? false,
        approvalMode: mode,
      },
    });
  };

  const handleStop = async () => {
    console.log('[Vision:handleStop] called', {
      selectedProject: selectedProject?.id,
      currentAutonomy: selectedProject?.autonomy,
    });
    if (!selectedProject) {
      console.warn('[Vision:handleStop] no selectedProject — aborting');
      return;
    }
    const updates = {
      autonomy: {
        ...(selectedProject.autonomy || {}),
        enabled: selectedProject.autonomy?.enabled ?? false,
        pendingVersion: null as any,
      },
    };
    console.log('[Vision:handleStop] calling updateProject with:', JSON.stringify(updates));
    try {
      await updateProject(selectedProject.id, updates);
      console.log('[Vision:handleStop] updateProject completed successfully');
    } catch (err) {
      console.error('[Vision:handleStop] updateProject threw:', err);
    }
  };

  const handleSaveDoc = async (content: string) => {
    if (!selectedProject) return;
    try {
      const res = await fetch(`/api/vision/${selectedProject.id}/doc`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content }),
      });
      if (res.ok) {
        setDocContent(content);
        setIsEditing(false);
      } else {
        console.error('Save failed:', await res.text());
      }
    } catch (e) {
      console.error('Save error:', e);
    }
  };

  if (loading) {
    return (
      <div className="flex flex-col h-screen">
        <PageHeader title="Vision" />
        <div className="flex-1 flex items-center justify-center text-[var(--text-muted)]">
          <Loader size={24} className="animate-spin" />
        </div>
      </div>
    );
  }

  // Empty state — no projects with vision docs
  if (projectsWithVision.length === 0) {
    if (loading || !initialLoadDone) {
      return (
        <div className="flex flex-col h-screen">
          <PageHeader title="Vision" />
          <div className="flex-1 flex items-center justify-center text-[var(--text-muted)]">
            <Loader size={24} className="animate-spin" />
          </div>
        </div>
      );
    }

    return (
      <div className="flex flex-col h-screen">
        <PageHeader title="Vision" />
        <div className="flex-1 flex flex-col items-center justify-center text-[var(--text-muted)] gap-4">
          <p className="text-lg">No projects with vision documents yet</p>
          <button
            onClick={() => setShowNewVision(true)}
            className="px-5 py-2.5 rounded-md bg-[var(--accent)] text-white text-sm font-medium hover:opacity-90 transition-all flex items-center gap-2"
          >
            <Plus size={16} />
            Create Your First Vision
          </button>
        </div>
        {showNewVision && (
          <NewVisionModal
            existingProjects={allProjects}
            teammates={teammates}
            onCreated={(projectId) => {
              setShowNewVision(false);
              setSelectedProjectId(projectId);
            }}
            onClose={() => setShowNewVision(false)}
          />
        )}
      </div>
    );
  }

  return (
    <div className="flex flex-col h-screen bg-[var(--bg)]">
      <PageHeader title="Vision" />

      {/* Pill Selector */}
      <PillSelector
        projects={projectsWithVision}
        selectedId={selectedProjectId}
        onSelect={(id) => {
          setSelectedProjectId(id);
          setIsEditing(false);
        }}
        onNewVision={() => setShowNewVision(true)}
      />

      {/* Status Strip */}
      {selectedProject && <StatusStrip project={selectedProject} />}

      {/* Vision Card */}
      {selectedProject && (
        <VisionCard
          project={selectedProject}
          docContent={docContent}
          docLoading={docLoading}
          onLaunch={handleLaunch}
          onStop={handleStop}
          onApprovalModeChange={handleApprovalModeChange}
          launching={launching}
          onEditToggle={() => setIsEditing(!isEditing)}
          isEditing={isEditing}
          onSaveDoc={handleSaveDoc}
        />
      )}

      {/* New Vision Modal */}
      {showNewVision && (
        <NewVisionModal
          existingProjects={allProjects}
          teammates={teammates}
          onCreated={(projectId) => {
            setShowNewVision(false);
            setSelectedProjectId(projectId);
            // Force re-discover vision docs
            setInitialLoadDone(false);
          }}
          onClose={() => setShowNewVision(false)}
        />
      )}
    </div>
  );
}
