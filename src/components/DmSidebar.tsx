'use client';

import { useEffect, useState, useCallback } from 'react';
import { useRouter, useParams } from 'next/navigation';
import { MessageCircle, Loader } from 'lucide-react';
import { extractParticipants, CURRENT_USER_ID } from '@/lib/dm';
import type { Teammate } from '@/lib/teammates';

export interface DmThread {
  threadId: string;
  participantIds: string[];
  lastCommentAt: number;
  lastCommentPreview: string;
  lastCommentAuthor?: string;
}

interface DmSidebarProps {
  teammates: Teammate[];
  activeThreadId?: string;
}

/**
 * Sidebar listing recent DM threads, sorted by last message timestamp DESC.
 * Shows other participant's name/emoji and a message preview.
 */
export function DmSidebar({ teammates, activeThreadId }: DmSidebarProps) {
  const router = useRouter();
  const [threads, setThreads] = useState<DmThread[]>([]);
  const [loading, setLoading] = useState(true);

  const fetchThreads = useCallback(async () => {
    try {
      const res = await fetch('/api/store', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'listDmThreads' }),
      });
      if (!res.ok) {
        setThreads([]);
        return;
      }
      const data = await res.json();
      setThreads(data.threads || []);
    } catch {
      setThreads([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchThreads();
  }, [fetchThreads]);

  // Build teammate lookup
  const teammateMap = new Map<string, Teammate>();
  for (const t of teammates) {
    teammateMap.set(t.id, t);
    if (t.agentId) teammateMap.set(t.agentId, t);
    teammateMap.set(t.name.toLowerCase(), t);
  }

  function resolveParticipant(id: string): { name: string; emoji: string } {
    const t = teammateMap.get(id) || teammateMap.get(id.toLowerCase());
    if (t) return { name: t.name, emoji: t.emoji };
    // Fallback — capitalize the ID
    return { name: id.charAt(0).toUpperCase() + id.slice(1), emoji: '👤' };
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center py-8">
        <Loader className="w-4 h-4 animate-spin text-[var(--text-muted)]" />
      </div>
    );
  }

  if (threads.length === 0) {
    return (
      <div className="px-3 py-6 text-center">
        <MessageCircle size={20} className="mx-auto text-[var(--text-muted)] mb-2 opacity-50" />
        <p className="text-[var(--text-xs)] text-[var(--text-muted)] leading-relaxed">
          No conversations yet — click Message on a teammate to start one.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-0.5 py-1">
      {threads.map((thread) => {
        let otherParticipantId: string;
        try {
          const [a, b] = extractParticipants(thread.threadId);
          otherParticipantId = a === CURRENT_USER_ID ? b : a;
        } catch {
          otherParticipantId = thread.participantIds?.[0] || 'unknown';
        }
        const other = resolveParticipant(otherParticipantId);
        const isActive = activeThreadId === thread.threadId;
        const preview = thread.lastCommentPreview || '';
        const truncatedPreview = preview.length > 40 ? preview.slice(0, 40) + '…' : preview;

        return (
          <button
            key={thread.threadId}
            onClick={() => router.push(`/dms/${encodeURIComponent(thread.threadId)}`)}
            className={`w-full text-left px-3 py-2.5 rounded-[var(--radius-md)] transition-colors ${
              isActive
                ? 'bg-[var(--accent-primary)]/10 border border-[var(--accent-primary)]/20'
                : 'hover:bg-[var(--bg-secondary)] border border-transparent'
            }`}
          >
            <div className="flex items-center gap-2.5">
              <span className="text-base shrink-0">{other.emoji}</span>
              <div className="flex-1 min-w-0">
                <p className={`text-[var(--text-sm)] font-medium truncate ${
                  isActive ? 'text-[var(--accent-primary)]' : 'text-[var(--text-primary)]'
                }`}>
                  {other.name}
                </p>
                {truncatedPreview && (
                  <p className="text-[var(--text-xs)] text-[var(--text-muted)] truncate mt-0.5">
                    {truncatedPreview}
                  </p>
                )}
              </div>
            </div>
          </button>
        );
      })}
    </div>
  );
}
