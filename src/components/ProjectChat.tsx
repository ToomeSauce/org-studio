'use client';

import { useState, useEffect, useMemo } from 'react';
import { Hash, Archive } from 'lucide-react';
import { ChatThread } from './ChatThread';
import type { CommentScope, Section } from '@/lib/store';

interface ProjectChatProps {
  project: {
    id: string;
    sections?: Section[];
    [key: string]: any;
  };
  tasks: any[];
  agents: string[];
  nameColors: Record<string, string>;
  currentAuthor: string;
}

/** Slugify section name: lowercase, replace non-alphanumeric with -, trim dashes */
function toSlug(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

interface Channel {
  id: string;          // 'general' or section.id
  label: string;       // '#general' or '#section-slug'
  scope: CommentScope;
  readOnly: boolean;
  archived: boolean;
}

export function ProjectChat({ project, tasks, agents, nameColors, currentAuthor }: ProjectChatProps) {
  const sections = project.sections || [];

  // Build channel list
  const channels = useMemo<Channel[]>(() => {
    const list: Channel[] = [];

    // #general — always first (board scope)
    list.push({
      id: 'general',
      label: '#general',
      scope: { kind: 'board', boardProjectId: project.id },
      readOnly: false,
      archived: false,
    });

    // Compute set of section IDs that have >0 tasks
    const sectionTaskCounts = new Map<string, number>();
    for (const t of tasks) {
      if (t.projectId === project.id && t.sectionId) {
        sectionTaskCounts.set(t.sectionId, (sectionTaskCounts.get(t.sectionId) || 0) + 1);
      }
    }

    // Active sections with >0 tasks
    const activeSections = sections.filter(
      (s: Section) => !s.archivedAt && sectionTaskCounts.get(s.id)! > 0
    );
    for (const s of activeSections) {
      list.push({
        id: s.id,
        label: `#${toSlug(s.name)}`,
        scope: { kind: 'section', sectionId: s.id, boardProjectId: project.id },
        readOnly: false,
        archived: false,
      });
    }

    // Archived sections (show under "Archived" group, read-only)
    const archivedSections = sections.filter((s: Section) => !!s.archivedAt);
    for (const s of archivedSections) {
      list.push({
        id: s.id,
        label: `#${toSlug(s.name)}`,
        scope: { kind: 'section', sectionId: s.id, boardProjectId: project.id },
        readOnly: true,
        archived: true,
      });
    }

    return list;
  }, [project.id, sections, tasks]);

  // Active channel state — default to 'general', read from URL hash if present
  const [activeChannelId, setActiveChannelId] = useState<string>(() => {
    if (typeof window !== 'undefined') {
      const hash = window.location.hash;
      if (hash.startsWith('#chat-')) {
        const channelRef = hash.slice(6); // remove '#chat-'
        if (channelRef === 'general') return 'general';
        // Find section by ID
        const match = sections.find((s: Section) => s.id === channelRef);
        if (match) return match.id;
      }
    }
    return 'general';
  });

  // Sync URL hash when channel changes
  useEffect(() => {
    if (typeof window !== 'undefined') {
      const hashVal = activeChannelId === 'general' ? 'chat-general' : `chat-${activeChannelId}`;
      // Use replaceState to avoid polluting history
      window.history.replaceState(null, '', `#${hashVal}`);
    }
  }, [activeChannelId]);

  const activeChannel = channels.find(c => c.id === activeChannelId) || channels[0];

  const activeChannels = channels.filter(c => !c.archived);
  const archivedChannels = channels.filter(c => c.archived);

  return (
    <div className="flex gap-0 min-h-[300px]" style={{ maxHeight: '500px' }}>
      {/* Sidebar */}
      <div className="w-44 shrink-0 border-r border-[var(--border-default)] overflow-y-auto pr-1">
        <div className="space-y-0.5 py-1">
          {activeChannels.map(ch => (
            <button
              key={ch.id}
              onClick={() => setActiveChannelId(ch.id)}
              className={`w-full text-left px-2.5 py-1.5 rounded-md text-xs font-medium transition-colors flex items-center gap-1.5 ${
                activeChannel.id === ch.id
                  ? 'bg-[var(--accent-primary)]/10 text-[var(--accent-primary)]'
                  : 'text-[var(--text-muted)] hover:text-[var(--text-secondary)] hover:bg-[var(--bg-secondary)]'
              }`}
            >
              <Hash size={12} className="shrink-0 opacity-60" />
              <span className="truncate">{ch.label.slice(1)}</span>
            </button>
          ))}

          {archivedChannels.length > 0 && (
            <>
              <div className="flex items-center gap-1.5 px-2.5 pt-3 pb-1">
                <Archive size={10} className="text-[var(--text-muted)] opacity-60" />
                <span className="text-[10px] font-semibold text-[var(--text-muted)] uppercase tracking-wider">
                  Archived
                </span>
              </div>
              {archivedChannels.map(ch => (
                <button
                  key={ch.id}
                  onClick={() => setActiveChannelId(ch.id)}
                  className={`w-full text-left px-2.5 py-1.5 rounded-md text-xs font-medium transition-colors flex items-center gap-1.5 ${
                    activeChannel.id === ch.id
                      ? 'bg-[var(--warning)]/10 text-[var(--warning)]'
                      : 'text-[var(--text-muted)] hover:text-[var(--text-secondary)] hover:bg-[var(--bg-secondary)] opacity-60'
                  }`}
                >
                  <Hash size={12} className="shrink-0 opacity-40" />
                  <span className="truncate">{ch.label.slice(1)}</span>
                </button>
              ))}
            </>
          )}
        </div>
      </div>

      {/* Chat thread panel */}
      <div className="flex-1 pl-3 min-w-0">
        <div className="flex items-center gap-2 mb-2 pb-2 border-b border-[var(--border-default)]">
          <Hash size={14} className="text-[var(--text-muted)]" />
          <span className="text-sm font-semibold text-[var(--text-primary)]">
            {activeChannel.label.slice(1)}
          </span>
          {activeChannel.readOnly && (
            <span className="text-[10px] px-1.5 py-0.5 rounded bg-[var(--warning)]/10 text-[var(--warning)] font-medium">
              Read-only
            </span>
          )}
        </div>
        <ChatThread
          key={activeChannel.id}
          scope={activeChannel.scope}
          project={project}
          agents={agents}
          nameColors={nameColors}
          currentAuthor={currentAuthor}
          readOnly={activeChannel.readOnly}
        />
      </div>
    </div>
  );
}
