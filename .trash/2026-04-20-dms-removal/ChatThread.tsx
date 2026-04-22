'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import { Send, Loader, ChevronUp, RefreshCw, X } from 'lucide-react';
import { extractMentions } from '@/lib/store';
import type { CommentScope } from '@/lib/store';
import { useOfflineQueue } from '@/lib/useOfflineQueue';
import type { QueuedMessage } from '@/lib/offline-queue';

interface Comment {
  id: string;
  author: string;
  content: string;
  createdAt: number;
  type?: 'comment' | 'system';
  model?: string;
  mentions?: string[];
}

interface ChatThreadProps {
  scope: CommentScope;
  project: any;
  agents: string[];
  nameColors: Record<string, string>;
  currentAuthor: string;
  readOnly?: boolean;
}

function formatTimestamp(ts: number): string {
  return new Date(ts).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

/**
 * Render comment content with @mentions highlighted
 */
function renderCommentWithMentions(content: string): React.ReactNode {
  const parts: React.ReactNode[] = [];
  let lastIndex = 0;
  const regex = /(@\w+)/g;
  let match;

  while ((match = regex.exec(content)) !== null) {
    if (match.index > lastIndex) {
      parts.push(content.slice(lastIndex, match.index));
    }
    parts.push(
      <span key={`mention-${match.index}`} className="font-semibold text-[var(--info)] bg-[var(--info)]/10 px-1 py-0.5 rounded">
        {match[0]}
      </span>
    );
    lastIndex = regex.lastIndex;
  }

  if (lastIndex < content.length) {
    parts.push(content.slice(lastIndex));
  }

  return parts.length > 0 ? parts : content;
}

/**
 * Generic chat thread component — renders a single chat thread for ANY CommentScope.
 * Supports board, section, task, and dm scopes.
 */
export function ChatThread({ scope, project, agents, nameColors, currentAuthor, readOnly }: ChatThreadProps) {
  const [comments, setComments] = useState<Comment[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [hasOlder, setHasOlder] = useState(false);
  const [commentText, setCommentText] = useState('');
  const scrollRef = useRef<HTMLDivElement>(null);
  const commentInputRef = useRef<HTMLTextAreaElement>(null);
  const PAGE_SIZE = 50;

  // Stable scope key to detect scope changes
  const scopeKey = scope.kind + ':' + (scope.taskId || scope.sectionId || scope.boardProjectId || scope.dmThreadId || '');

  const fetchComments = useCallback(async (before?: number) => {
    try {
      const body: Record<string, any> = {
        action: 'listComments',
        scope,
        limit: PAGE_SIZE,
      };
      if (before) body.before = before;

      const res = await fetch('/api/store', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) return [];
      const data = await res.json();
      return (data.comments || []) as Comment[];
    } catch {
      return [];
    }
  }, [scopeKey]); // eslint-disable-line react-hooks/exhaustive-deps

  // Initial load — re-fetch when scope changes
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setComments([]);
    fetchComments().then(fetched => {
      if (cancelled) return;
      setComments(fetched);
      setHasOlder(fetched.length >= PAGE_SIZE);
      setLoading(false);
      // Scroll to bottom on initial load
      setTimeout(() => {
        if (scrollRef.current) {
          scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
        }
      }, 50);
    });
    return () => { cancelled = true; };
  }, [fetchComments]);

  const handleLoadOlder = useCallback(async () => {
    if (comments.length === 0 || loadingOlder) return;
    setLoadingOlder(true);
    const oldestCreatedAt = comments[0]?.createdAt;
    const older = await fetchComments(oldestCreatedAt);
    setComments(prev => [...older, ...prev]);
    setHasOlder(older.length >= PAGE_SIZE);
    setLoadingOlder(false);
  }, [comments, loadingOlder, fetchComments]);

  // Offline queue integration
  const { items: queuedItems, enqueue, retryOne, remove } = useOfflineQueue();
  // Filter queued items to ones matching this scope
  const scopeQueueItems = queuedItems.filter(qi => {
    if (qi.scope.kind !== scope.kind) return false;
    switch (scope.kind) {
      case 'board': return qi.scope.boardProjectId === scope.boardProjectId;
      case 'section': return qi.scope.sectionId === scope.sectionId && qi.scope.boardProjectId === scope.boardProjectId;
      case 'task': return qi.scope.taskId === scope.taskId;
      case 'dm': return qi.scope.dmThreadId === scope.dmThreadId;
      default: return false;
    }
  });

  const handleSend = useCallback(() => {
    if (!commentText.trim() || readOnly) return;
    const mentions = extractMentions(commentText);
    enqueue(scope, {
      author: currentAuthor,
      content: commentText.trim(),
      type: 'comment',
      mentions: mentions.length > 0 ? mentions : undefined,
    });
    setCommentText('');
    // Scroll to bottom after enqueue
    setTimeout(() => {
      if (scrollRef.current) {
        scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
      }
    }, 50);
  }, [commentText, readOnly, scope, currentAuthor, enqueue]);

  if (loading) {
    return (
      <div className="flex items-center justify-center py-8">
        <Loader className="w-5 h-5 animate-spin text-[var(--text-muted)]" />
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full">
      {/* Messages area */}
      <div
        ref={scrollRef}
        className="overflow-y-auto space-y-2.5 px-1 flex-1"
        style={{ maxHeight: '400px' }}
      >
        {/* Load older button */}
        {hasOlder && (
          <div className="flex justify-center py-2">
            <button
              onClick={handleLoadOlder}
              disabled={loadingOlder}
              className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-[var(--text-muted)] hover:text-[var(--text-secondary)] bg-[var(--bg-secondary)] hover:bg-[var(--bg-tertiary)] rounded-full transition-colors disabled:opacity-50"
            >
              {loadingOlder ? (
                <Loader className="w-3 h-3 animate-spin" />
              ) : (
                <ChevronUp className="w-3 h-3" />
              )}
              Load older
            </button>
          </div>
        )}

        {comments.length === 0 && (
          <p className="text-sm text-[var(--text-muted)] text-center py-6">
            {readOnly ? 'No messages in this archived channel.' : 'No messages yet. Start the conversation!'}
          </p>
        )}

        {comments.map(c => (
          <div
            key={c.id}
            className={`rounded-[var(--radius-md)] px-3 py-2 ${
              c.type === 'system'
                ? 'bg-[var(--warning-subtle)] border border-[var(--warning)]/20'
                : 'bg-[var(--bg-secondary)] border border-[var(--border-default)]'
            }`}
          >
            <div className="flex items-center gap-2 mb-1">
              <span className={`text-[11px] font-semibold ${
                c.type === 'system'
                  ? 'text-[var(--warning)]'
                  : (nameColors[c.author] || 'text-[var(--text-secondary)]')
              }`}>
                {c.author}
              </span>
              {c.model && (
                <span className="text-[9px] px-1.5 py-0.5 rounded bg-[var(--bg-tertiary)] text-[var(--text-muted)] font-mono">
                  {c.model}
                </span>
              )}
              <span className="text-[10px] text-[var(--text-muted)]">
                {formatTimestamp(c.createdAt)}
              </span>
            </div>
            <p className="text-[var(--text-sm)] text-[var(--text-secondary)] leading-relaxed whitespace-pre-wrap">
              {renderCommentWithMentions(c.content)}
            </p>
          </div>
        ))}

        {/* Queued / in-flight messages */}
        {scopeQueueItems.map(qi => (
          <QueuedMessageBubble
            key={qi.id}
            item={qi}
            onRetry={() => retryOne(qi.id)}
            onDismiss={() => remove(qi.id)}
          />
        ))}
      </div>

      {/* Composer section — hidden when readOnly */}
      {!readOnly && (
        <div className="mt-3">
          {/* Queue count subtitle */}
          {scopeQueueItems.length > 0 && (
            <div className="mb-1.5 px-1">
              <span className="text-[11px] font-medium text-[var(--text-muted)]">
                {scopeQueueItems.length === 1
                  ? '1 message queued'
                  : `${scopeQueueItems.length} messages queued`}
              </span>
            </div>
          )}
          <div className="flex gap-2">
            <textarea
              ref={commentInputRef}
              value={commentText}
              onChange={e => setCommentText(e.target.value)}
              placeholder="Add a message... (use @name to mention agents)"
              rows={2}
              className="flex-1 text-[var(--text-sm)] bg-[var(--bg-secondary)] border border-[var(--border-default)] rounded-[var(--radius-md)] px-3 py-2 text-[var(--text-secondary)] placeholder-[var(--text-muted)] outline-none resize-none focus:border-[var(--accent-primary)] transition-colors"
              onKeyDown={e => {
                if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                  e.preventDefault();
                  handleSend();
                }
              }}
            />
            <button
              onClick={handleSend}
              disabled={!commentText.trim()}
              className="self-end px-3 py-2 bg-[var(--accent-primary)] text-white rounded-[var(--radius-md)] hover:bg-[var(--accent-hover)] transition-colors disabled:opacity-30 disabled:cursor-not-allowed shrink-0"
              title="Send message (Cmd+Enter)"
            >
              <Send size={14} />
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// QueuedMessageBubble — visual indicator for pending / failed / retrying msgs
// ---------------------------------------------------------------------------

function QueuedMessageBubble({
  item,
  onRetry,
  onDismiss,
}: {
  item: QueuedMessage;
  onRetry: () => void;
  onDismiss: () => void;
}) {
  const { status, errorMessage, comment, retryAttempts } = item;

  // Border + background per status
  const wrapperClass =
    status === 'pending'
      ? 'bg-[var(--bg-secondary)] border border-[var(--border-default)] opacity-60'
      : status === 'retrying'
        ? 'bg-[var(--bg-secondary)] border border-[var(--border-default)] opacity-50'
        : status === 'sent'
          ? 'bg-[var(--success)]/5 border border-[var(--success)]/30'
          : 'bg-red-500/5 border border-red-500/30'; // failed

  return (
    <div className={`rounded-[var(--radius-md)] px-3 py-2 ${wrapperClass}`}>
      {/* Message content */}
      <div className="flex items-center gap-2 mb-1">
        <span className="text-[11px] font-semibold text-[var(--text-secondary)]">
          {comment.author}
        </span>
      </div>
      <p className="text-[var(--text-sm)] text-[var(--text-secondary)] leading-relaxed whitespace-pre-wrap">
        {renderCommentWithMentions(comment.content)}
      </p>

      {/* Status row */}
      <div className="flex items-center gap-2 mt-1.5">
        {status === 'pending' && (
          <span className="text-[10px] text-[var(--text-muted)] flex items-center gap-1">
            <Loader className="w-3 h-3 animate-spin" />
            ⏳ Sending…
          </span>
        )}

        {status === 'retrying' && (
          <span className="text-[10px] text-[var(--text-muted)] flex items-center gap-1">
            <RefreshCw className="w-3 h-3 animate-spin" />
            🔄 Retrying… (attempt {retryAttempts})
          </span>
        )}

        {status === 'sent' && (
          <span className="text-[10px] text-[var(--success)] flex items-center gap-1">
            ✓ Sent
          </span>
        )}

        {status === 'failed' && (
          <>
            <span className="text-[10px] text-red-500 flex-1">
              {errorMessage || '❌ Send failed'}
            </span>
            <button
              onClick={onRetry}
              aria-label={`Retry sending message: ${comment.content.slice(0, 40)}`}
              className="text-[10px] font-semibold text-[var(--accent-primary)] hover:underline"
            >
              Retry
            </button>
            <button
              onClick={onDismiss}
              aria-label="Dismiss failed message"
              className="text-[var(--text-muted)] hover:text-[var(--text-secondary)] transition-colors"
            >
              <X size={12} />
            </button>
          </>
        )}
      </div>
    </div>
  );
}

/**
 * Backward-compatible wrapper — BoardChat now delegates to ChatThread with board scope.
 * @deprecated Use ChatThread or ProjectChat instead.
 */
export function BoardChat({ projectId, agents, nameColors, currentAuthor }: {
  projectId: string;
  agents: string[];
  nameColors: Record<string, string>;
  currentAuthor: string;
}) {
  return (
    <ChatThread
      scope={{ kind: 'board', boardProjectId: projectId }}
      project={null}
      agents={agents}
      nameColors={nameColors}
      currentAuthor={currentAuthor}
    />
  );
}
