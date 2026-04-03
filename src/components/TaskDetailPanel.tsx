'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import {
  X, ChevronDown, ChevronRight, Target, Shield, FileText,
  Link as LinkIcon, MessageSquare, Clock, Trash2,
  AlertTriangle, Send, ClipboardCheck,
} from 'lucide-react';
import { clsx } from 'clsx';
import type { Task, Project, TaskComment } from '@/lib/store';
import { extractMentions } from '@/lib/store';
import { toast } from 'react-toastify';

// --- Status config ---
const ALL_STATUS_ORDER: Task['status'][] = ['planning', 'backlog', 'in-progress', 'qa', 'review', 'done'];
const NO_QA_STATUS_ORDER: Task['status'][] = ['planning', 'backlog', 'in-progress', 'review', 'done'];
const STATUS_LABELS: Record<Task['status'], string> = {
  'planning': 'Planning',
  'backlog': 'Backlog',
  'in-progress': 'In Progress',
  'qa': 'QA',
  'review': 'Review',
  'done': 'Done',
};



function isBackwardMove(from: Task['status'], to: Task['status'], statusOrder: Task['status'][]): boolean {
  const fromIdx = statusOrder.indexOf(from);
  const toIdx = statusOrder.indexOf(to);
  return toIdx < fromIdx;
}

function formatTimestamp(ts: number): string {
  const d = new Date(ts);
  const now = new Date();
  const diffMs = now.getTime() - d.getTime();
  const diffMins = Math.floor(diffMs / 60000);
  if (diffMins < 1) return 'just now';
  if (diffMins < 60) return `${diffMins}m ago`;
  const diffHours = Math.floor(diffMins / 60);
  if (diffHours < 24) return `${diffHours}h ago`;
  const diffDays = Math.floor(diffHours / 24);
  if (diffDays < 7) return `${diffDays}d ago`;
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

function formatFullDate(ts: number): string {
  return new Date(ts).toLocaleString('en-US', {
    month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
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
    // Add text before mention
    if (match.index > lastIndex) {
      parts.push(content.slice(lastIndex, match.index));
    }
    // Add highlighted mention
    parts.push(
      <span key={`mention-${match.index}`} className="font-semibold text-[var(--info)] bg-[var(--info)]/10 px-1 py-0.5 rounded">
        {match[0]}
      </span>
    );
    lastIndex = regex.lastIndex;
  }

  // Add remaining text
  if (lastIndex < content.length) {
    parts.push(content.slice(lastIndex));
  }

  return parts.length > 0 ? parts : content;
}

interface TaskDetailPanelProps {
  task: Task;
  projects: Project[];
  agents: string[];
  nameColors: Record<string, string>;
  qaLead?: string | null;
  onUpdate: (id: string, updates: Partial<Task>) => Promise<void>;
  onDelete: (id: string) => Promise<void>;
  onAddComment: (taskId: string, comment: Omit<TaskComment, 'id' | 'createdAt'>) => Promise<TaskComment>;
  onClose: () => void;
}

export function TaskDetailPanel({
  task, projects, agents, nameColors, qaLead, onUpdate, onDelete, onAddComment, onClose,
}: TaskDetailPanelProps) {
  // Local editing state
  const [title, setTitle] = useState(task.title);
  const [editingTitle, setEditingTitle] = useState(false);
  const [projectId, setProjectId] = useState(task.projectId);
  const [assignee, setAssignee] = useState(task.assignee);

  const [status, setStatus] = useState<Task['status']>(task.status);
  const [description, setDescription] = useState(task.description || '');
  const [doneWhen, setDoneWhen] = useState(task.doneWhen || '');
  const [constraints, setConstraints] = useState(task.constraints || '');
  const [context, setContext] = useState(task.context || '');
  const [testPlan, setTestPlan] = useState(task.testPlan || '');
  const [testType, setTestType] = useState<'self' | 'qa'>(task.testType || 'self');
  const [testAssignee, setTestAssignee] = useState(task.testAssignee || '');
  const [outcomeIds, setOutcomeIds] = useState<string[]>(task.outcomeIds || []);
  const [criteriaOpen, setCriteriaOpen] = useState(
    !!(task.doneWhen?.trim() || task.constraints?.trim() || task.context?.trim())
  );
  const [testPlanOpen, setTestPlanOpen] = useState(!!(task.testPlan?.trim()));
  const [historyOpen, setHistoryOpen] = useState(false);
  const [commentText, setCommentText] = useState('');
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [visible, setVisible] = useState(false);

  const titleInputRef = useRef<HTMLInputElement>(null);
  const commentInputRef = useRef<HTMLTextAreaElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  // Derive status order based on qaLead
  const statusOrder = qaLead ? ALL_STATUS_ORDER : NO_QA_STATUS_ORDER;

  // Animate in
  useEffect(() => {
    requestAnimationFrame(() => setVisible(true));
  }, []);

  // Sync task changes from outside
  useEffect(() => {
    setTitle(task.title);
    setProjectId(task.projectId);
    setAssignee(task.assignee);
    setStatus(task.status);
    setDescription(task.description || '');
    setDoneWhen(task.doneWhen || '');
    setConstraints(task.constraints || '');
    setContext(task.context || '');
    setTestPlan(task.testPlan || '');
    setTestType(task.testType || 'self');
    setTestAssignee(task.testAssignee || '');
    setOutcomeIds(task.outcomeIds || []);
  }, [task]);

  const handleClose = useCallback(() => {
    setVisible(false);
    setTimeout(onClose, 200);
  }, [onClose]);

  // Save field on blur
  const saveField = useCallback(async (field: string, value: any) => {
    await onUpdate(task.id, { [field]: value || undefined });
  }, [task.id, onUpdate]);

  const handleTitleSave = useCallback(async () => {
    setEditingTitle(false);
    if (title.trim() && title.trim() !== task.title) {
      await saveField('title', title.trim());
    } else {
      setTitle(task.title);
    }
  }, [title, task.title, saveField]);

  const handleStatusChange = useCallback(async (newStatus: Task['status']) => {
    if (newStatus === status) return;

    // Soft gate: warn if testType is set but testPlan is empty
    if ((newStatus === 'review' || newStatus === 'done' || newStatus === 'qa') && testType) {
      const currentTestPlan = task.testPlan?.trim();
      if (!currentTestPlan) {
        toast.warn('⚠️ This task has no test plan. A test plan ensures proper verification before completion.', { autoClose: 5000 });
        // Allow the move but warn — agents are expected to write test plans
      }
    }

    if (isBackwardMove(status, newStatus, statusOrder)) {
      const reason = window.prompt(
        `Moving from "${STATUS_LABELS[status]}" back to "${STATUS_LABELS[newStatus]}".\n\nReason for reopening?`
      );
      if (reason === null) return; // cancelled
      if (reason.trim()) {
        await onAddComment(task.id, {
          author: 'System',
          content: `Reopened (${STATUS_LABELS[status]} → ${STATUS_LABELS[newStatus]}): ${reason.trim()}`,
          type: 'system',
        });
      }
    }

    setStatus(newStatus);
    await onUpdate(task.id, { status: newStatus });
  }, [status, task.id, onUpdate, onAddComment]);

  const handleAddComment = useCallback(async () => {
    if (!commentText.trim()) return;
    const mentions = extractMentions(commentText);
    await onAddComment(task.id, {
      author: 'You',
      content: commentText.trim(),
      type: 'comment',
      mentions: mentions.length > 0 ? mentions : undefined,
    });
    setCommentText('');
    if (mentions.length > 0) {
      toast.info(`Mentioned ${mentions.length} agent${mentions.length > 1 ? 's' : ''}: ${mentions.join(', ')}`);
    }
  }, [commentText, task.id, onAddComment]);

  const handleDeleteConfirm = useCallback(async () => {
    handleClose();
    // small delay so panel animates out first
    setTimeout(() => onDelete(task.id), 250);
  }, [task.id, onDelete, handleClose]);

  const comments: TaskComment[] = task.comments || [];
  const statusHistory: { status: string; timestamp: number }[] = (task as any).statusHistory || [];

  return (
    <>
      {/* Backdrop */}
      <div
        className={clsx(
          'fixed inset-0 z-40 bg-black/40 backdrop-blur-[2px] transition-opacity duration-200',
          visible ? 'opacity-100' : 'opacity-0'
        )}
        onClick={handleClose}
      />

      {/* Panel */}
      <div
        ref={panelRef}
        className={clsx(
          'fixed top-0 right-0 z-50 h-full w-[520px] max-w-[90vw] bg-[var(--bg-primary)] border-l border-[var(--border-strong)]',
          'flex flex-col shadow-2xl transition-transform duration-200 ease-out',
          visible ? 'translate-x-0' : 'translate-x-full'
        )}
      >
        {/* Header */}
        <div className="flex items-center gap-3 px-5 py-4 border-b border-[var(--border-default)] shrink-0">
          <div className="flex-1 min-w-0">
            {editingTitle ? (
              <input
                ref={titleInputRef}
                value={title}
                onChange={e => setTitle(e.target.value)}
                onBlur={handleTitleSave}
                onKeyDown={e => {
                  if (e.key === 'Enter') handleTitleSave();
                  if (e.key === 'Escape') { setTitle(task.title); setEditingTitle(false); }
                }}
                className="w-full text-[var(--text-base)] font-bold bg-transparent text-[var(--text-primary)] outline-none border-b border-[var(--accent-primary)]/40 pb-0.5"
                autoFocus
              />
            ) : (
              <h2
                className="text-[var(--text-base)] font-bold text-[var(--text-primary)] truncate cursor-pointer hover:text-[var(--accent-primary)] transition-colors"
                onClick={() => { setEditingTitle(true); setTimeout(() => titleInputRef.current?.focus(), 0); }}
                title="Click to edit title"
              >
                {task.title}
              </h2>
            )}
          </div>
          <button
            onClick={handleClose}
            className="p-1.5 rounded-[var(--radius-sm)] hover:bg-[var(--bg-hover)] text-[var(--text-muted)] hover:text-[var(--text-primary)] transition-colors shrink-0"
          >
            <X size={18} />
          </button>
        </div>

        {/* Scrollable content */}
        <div className="flex-1 overflow-y-auto">
          {/* Metadata row */}
          <div className="grid grid-cols-2 gap-3 px-5 py-4 border-b border-[var(--border-default)]">
            <div>
              <label className="text-[10px] font-semibold text-[var(--text-muted)] uppercase tracking-wider mb-1.5 block">Project</label>
              <select
                value={projectId}
                onChange={e => { setProjectId(e.target.value); saveField('projectId', e.target.value); }}
                className="w-full text-[var(--text-sm)] bg-[var(--bg-secondary)] border border-[var(--border-default)] rounded-[var(--radius-sm)] px-2.5 py-1.5 text-[var(--text-secondary)] outline-none focus:border-[var(--accent-primary)] transition-colors"
              >
                {projects.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
              </select>
            </div>
            <div>
              <label className="text-[10px] font-semibold text-[var(--text-muted)] uppercase tracking-wider mb-1.5 block">Assignee</label>
              <select
                value={assignee}
                onChange={e => { setAssignee(e.target.value); saveField('assignee', e.target.value); }}
                className={clsx(
                  'w-full text-[var(--text-sm)] bg-[var(--bg-secondary)] border border-[var(--border-default)] rounded-[var(--radius-sm)] px-2.5 py-1.5 outline-none focus:border-[var(--accent-primary)] transition-colors font-medium',
                  nameColors[assignee] || 'text-[var(--text-secondary)]'
                )}
              >
                {agents.map(a => <option key={a} value={a}>{a}</option>)}
              </select>
            </div>
            <div>
              <label className="text-[10px] font-semibold text-[var(--text-muted)] uppercase tracking-wider mb-1.5 block">Status</label>
              <select
                value={status}
                onChange={e => handleStatusChange(e.target.value as Task['status'])}
                className="w-full text-[var(--text-sm)] bg-[var(--bg-secondary)] border border-[var(--border-default)] rounded-[var(--radius-sm)] px-2.5 py-1.5 text-[var(--text-secondary)] outline-none focus:border-[var(--accent-primary)] transition-colors"
              >
                {statusOrder.map(s => (
                  <option key={s} value={s}>{STATUS_LABELS[s]}</option>
                ))}
              </select>
            </div>
            {/* Test type row — only shown when QA lead is set */}
            {qaLead && (
            <div className="col-span-2 flex items-center gap-4 pt-1">
              <label className="text-[var(--text-xs)] text-[var(--text-muted)]">Test Type</label>
              <select
                value={testType}
                onChange={e => {
                  const v = e.target.value as 'self' | 'qa';
                  setTestType(v);
                  saveField('testType', v);
                }}
                className="text-[var(--text-xs)] bg-[var(--bg-secondary)] border border-[var(--border-default)] rounded-[var(--radius-sm)] px-2.5 py-1.5 text-[var(--text-secondary)] outline-none focus:border-[var(--accent-primary)] transition-colors"
              >
                <option value="self">Self Test</option>
                <option value="qa">QA Test</option>
              </select>
              {testType === 'qa' && (
                <select
                  value={testAssignee}
                  onChange={e => {
                    setTestAssignee(e.target.value);
                    saveField('testAssignee', e.target.value || undefined);
                  }}
                  className="text-[var(--text-xs)] bg-[var(--bg-secondary)] border border-[var(--border-default)] rounded-[var(--radius-sm)] px-2 py-1.5 text-[var(--text-secondary)] outline-none focus:border-[var(--accent-primary)] transition-colors"
                >
                  <option value="">Auto (default QA)</option>
                  {agents.map(a => <option key={a} value={a}>{a}</option>)}
                </select>
              )}
            </div>
            )}
          </div>

          {/* Linked Outcomes */}
          {(() => {
            const currentProject = projects.find(p => p.id === projectId);
            const projectOutcomes = currentProject?.outcomes || [];
            if (projectOutcomes.length > 0) {
              return (
                <div className="px-5 py-3 border-b border-[var(--border-default)]">
                  <label className="text-[10px] font-semibold text-[var(--text-muted)] uppercase tracking-wider mb-2 block">Linked Outcomes</label>
                  <div className="space-y-2">
                    {projectOutcomes.map(outcome => (
                      <label key={outcome.id} className="flex items-center gap-2 cursor-pointer hover:bg-[var(--bg-secondary)] p-1.5 rounded transition-colors">
                        <input
                          type="checkbox"
                          checked={outcomeIds.includes(outcome.id)}
                          onChange={e => {
                            const newIds = e.target.checked
                              ? [...outcomeIds, outcome.id]
                              : outcomeIds.filter(id => id !== outcome.id);
                            setOutcomeIds(newIds);
                            saveField('outcomeIds', newIds.length > 0 ? newIds : undefined);
                          }}
                          className="w-4 h-4 cursor-pointer"
                        />
                        <span className="text-[var(--text-xs)] text-[var(--text-secondary)]">
                          {outcome.text}
                        </span>
                      </label>
                    ))}
                  </div>
                </div>
              );
            }
            return null;
          })()}

          {/* Description */}
          <div className="px-5 py-3 border-b border-[var(--border-default)]">
            <label className="text-[10px] font-semibold text-[var(--text-muted)] uppercase tracking-wider mb-1.5 block">Description</label>
            <textarea
              value={description}
              onChange={e => setDescription(e.target.value)}
              onBlur={() => saveField('description', description.trim())}
              placeholder="Additional notes or context..."
              rows={4}
              className="w-full text-[var(--text-sm)] bg-[var(--bg-secondary)] border border-[var(--border-default)] rounded-[var(--radius-md)] px-3 py-2 text-[var(--text-secondary)] placeholder-[var(--text-muted)] outline-none resize-y focus:border-[var(--accent-primary)] transition-colors"
            />
          </div>

          {/* Acceptance Criteria */}
          <div className="px-5 py-3 border-b border-[var(--border-default)]">
            <button
              onClick={() => setCriteriaOpen(!criteriaOpen)}
              className="flex items-center gap-2 text-[var(--text-xs)] font-semibold text-[var(--text-secondary)] hover:text-[var(--text-primary)] transition-colors w-full"
            >
              {criteriaOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
              <Target size={14} className="text-[var(--accent-primary)]" />
              Acceptance Criteria
            </button>

            {criteriaOpen && (
              <div className="mt-3 space-y-3">
                <div>
                  <label className="text-[10px] font-semibold text-[var(--text-muted)] uppercase tracking-wider mb-1 block">
                    Acceptance Criteria
                  </label>
                  <textarea
                    value={doneWhen}
                    onChange={e => setDoneWhen(e.target.value)}
                    onBlur={() => saveField('doneWhen', doneWhen.trim())}
                    placeholder="List the specific conditions that must be true when complete."
                    rows={3}
                    className="w-full text-[var(--text-sm)] bg-[var(--bg-secondary)] border border-[var(--border-default)] rounded-[var(--radius-md)] px-3 py-2 text-[var(--text-secondary)] placeholder-[var(--text-muted)] outline-none resize-y focus:border-[var(--accent-primary)] transition-colors"
                  />
                </div>
                <div>
                  <label className="text-[10px] font-semibold text-[var(--text-muted)] uppercase tracking-wider mb-1 flex items-center gap-1">
                    <Shield size={10} /> Boundaries
                  </label>
                  <textarea
                    value={constraints}
                    onChange={e => setConstraints(e.target.value)}
                    onBlur={() => saveField('constraints', constraints.trim())}
                    placeholder="What's off-limits or out of scope?"
                    rows={3}
                    className="w-full text-[var(--text-sm)] bg-[var(--bg-secondary)] border border-[var(--border-default)] rounded-[var(--radius-md)] px-3 py-2 text-[var(--text-secondary)] placeholder-[var(--text-muted)] outline-none resize-y focus:border-[var(--accent-primary)] transition-colors"
                  />
                </div>
                <div>
                  <label className="text-[10px] font-semibold text-[var(--text-muted)] uppercase tracking-wider mb-1 flex items-center gap-1">
                    <FileText size={10} /> References
                  </label>
                  <textarea
                    value={context}
                    onChange={e => setContext(e.target.value)}
                    onBlur={() => saveField('context', context.trim())}
                    placeholder="Links, files, or background info."
                    rows={3}
                    className="w-full text-[var(--text-sm)] bg-[var(--bg-secondary)] border border-[var(--border-default)] rounded-[var(--radius-md)] px-3 py-2 text-[var(--text-secondary)] placeholder-[var(--text-muted)] outline-none resize-y focus:border-[var(--accent-primary)] transition-colors"
                  />
                </div>
              </div>
            )}
          </div>

          {/* Test Plan */}
          <div className="px-5 py-3 border-b border-[var(--border-default)]">
            <button
              onClick={() => setTestPlanOpen(!testPlanOpen)}
              className="flex items-center gap-2 text-[var(--text-xs)] font-semibold text-[var(--text-secondary)] hover:text-[var(--text-primary)] transition-colors w-full"
            >
              {testPlanOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
              <ClipboardCheck size={14} className="text-[var(--accent-primary)]" />
              Test Plan
            </button>

            {testPlanOpen && (
              <div className="mt-3">
                <textarea
                  value={testPlan}
                  onChange={e => setTestPlan(e.target.value)}
                  onBlur={() => saveField('testPlan', testPlan.trim())}
                  placeholder={testType === 'qa'
                    ? "Steps for end-user validation (e.g., navigate to /garage/market, verify prices load, check error states)"
                    : "What you'll verify and how (e.g., curl endpoints, check build output, verify DB state)"}
                  rows={4}
                  className="w-full text-[var(--text-sm)] bg-[var(--bg-secondary)] border border-[var(--border-default)] rounded-[var(--radius-md)] px-3 py-2 text-[var(--text-secondary)] placeholder-[var(--text-muted)] outline-none resize-y focus:border-[var(--accent-primary)] transition-colors"
                />
                <p className="text-[10px] text-[var(--text-muted)] mt-1.5">
                  {testType === 'qa'
                    ? 'Describes how QA should verify this from the end-user perspective.'
                    : 'Describes what you verified and how — results go in review notes.'}
                </p>
              </div>
            )}
          </div>

          {/* Review Notes (read-only) */}
          {task.reviewNotes?.trim() && (
            <div className="px-5 py-3 border-b border-[var(--border-default)]">
              <div className="px-3 py-2.5 bg-[var(--bg-secondary)] border-l-2 border-[var(--accent-primary)] rounded-r-[var(--radius-sm)]">
                <div className="flex items-center gap-1.5 mb-1">
                  <MessageSquare size={11} className="text-[var(--accent-primary)]" />
                  <span className="text-[10px] font-semibold uppercase tracking-wide text-[var(--accent-primary)]">
                    {task.status === 'review' ? 'Review Notes' : 'Completion Notes'}
                  </span>
                </div>
                <p className="text-[var(--text-sm)] text-[var(--text-secondary)] leading-relaxed whitespace-pre-wrap">{task.reviewNotes}</p>
              </div>
            </div>
          )}

          {/* Comments */}
          <div className="px-5 py-3 border-b border-[var(--border-default)]">
            <div className="flex items-center gap-2 mb-3">
              <MessageSquare size={14} className="text-[var(--text-muted)]" />
              <span className="text-[10px] font-semibold text-[var(--text-muted)] uppercase tracking-wider">
                Comments {comments.length > 0 && `(${comments.length})`}
              </span>
            </div>

            {comments.length > 0 && (
              <div className="space-y-2.5 mb-3">
                {comments.map(c => (
                  <div
                    key={c.id}
                    className={clsx(
                      'rounded-[var(--radius-md)] px-3 py-2',
                      c.type === 'system'
                        ? 'bg-[var(--warning-subtle)] border border-[var(--warning)]/20'
                        : 'bg-[var(--bg-secondary)] border border-[var(--border-default)]'
                    )}
                  >
                    <div className="flex items-center gap-2 mb-1">
                      {c.type === 'system' && <AlertTriangle size={11} className="text-[var(--warning)]" />}
                      <span className={clsx(
                        'text-[11px] font-semibold',
                        c.type === 'system' ? 'text-[var(--warning)]' : (nameColors[c.author] || 'text-[var(--text-secondary)]')
                      )}>
                        {c.author}
                      </span>
                      {(c as any).model && (
                        <span className="text-[9px] px-1.5 py-0.5 rounded bg-[var(--bg-tertiary)] text-[var(--text-muted)] font-mono">
                          {(c as any).model}
                        </span>
                      )}
                      <span className="text-[10px] text-[var(--text-muted)]">{formatTimestamp(c.createdAt)}</span>
                    </div>
                    <p className="text-[var(--text-sm)] text-[var(--text-secondary)] leading-relaxed whitespace-pre-wrap">{renderCommentWithMentions(c.content)}</p>
                  </div>
                ))}
              </div>
            )}

            <div className="flex gap-2">
              <textarea
                ref={commentInputRef}
                value={commentText}
                onChange={e => setCommentText(e.target.value)}
                placeholder="Add a comment... (use @name to mention agents)"
                rows={2}
                className="flex-1 text-[var(--text-sm)] bg-[var(--bg-secondary)] border border-[var(--border-default)] rounded-[var(--radius-md)] px-3 py-2 text-[var(--text-secondary)] placeholder-[var(--text-muted)] outline-none resize-none focus:border-[var(--accent-primary)] transition-colors"
                onKeyDown={e => {
                  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                    e.preventDefault();
                    handleAddComment();
                  }
                }}
              />
              <button
                onClick={handleAddComment}
                disabled={!commentText.trim()}
                className="self-end px-3 py-2 bg-[var(--accent-primary)] text-white rounded-[var(--radius-md)] hover:bg-[var(--accent-hover)] transition-colors disabled:opacity-30 disabled:cursor-not-allowed shrink-0"
                title="Add comment (Cmd+Enter)"
              >
                <Send size={14} />
              </button>
            </div>
          </div>

          {/* Status History */}
          {statusHistory.length > 0 && (
            <div className="px-5 py-3 border-b border-[var(--border-default)]">
              <button
                onClick={() => setHistoryOpen(!historyOpen)}
                className="flex items-center gap-2 text-[var(--text-xs)] font-semibold text-[var(--text-secondary)] hover:text-[var(--text-primary)] transition-colors w-full"
              >
                {historyOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                <Clock size={14} className="text-[var(--text-muted)]" />
                Status History ({statusHistory.length})
              </button>

              {historyOpen && (
                <div className="mt-3 ml-2 border-l border-[var(--border-default)] pl-4 space-y-2">
                  {statusHistory.map((entry, i) => (
                    <div key={i} className="flex items-center gap-2 flex-wrap">
                      <div className="w-1.5 h-1.5 rounded-full bg-[var(--text-muted)] -ml-[calc(1rem+3px)]" />
                      <span className="text-[var(--text-xs)] font-medium text-[var(--text-secondary)]">
                        {STATUS_LABELS[entry.status as Task['status']] || entry.status}
                      </span>
                      {(entry as any).by && (
                        <span className="text-[10px] text-[var(--text-muted)]">by {(entry as any).by}</span>
                      )}
                      {(entry as any).model && (
                        <span className="text-[9px] px-1.5 py-0.5 rounded bg-[var(--bg-tertiary)] text-[var(--text-muted)] font-mono">
                          {(entry as any).model}
                        </span>
                      )}
                      <span className="text-[10px] text-[var(--text-muted)]">{formatFullDate(entry.timestamp)}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* Delete */}
          <div className="px-5 py-4">
            {confirmDelete ? (
              <div className="flex items-center gap-3">
                <span className="text-[var(--text-sm)] text-[var(--error)]">Delete this task permanently?</span>
                <button
                  onClick={handleDeleteConfirm}
                  className="text-[var(--text-xs)] px-3 py-1.5 bg-[var(--error)] text-white rounded-[var(--radius-sm)] hover:opacity-90 transition-opacity font-medium"
                >
                  Yes, delete
                </button>
                <button
                  onClick={() => setConfirmDelete(false)}
                  className="text-[var(--text-xs)] px-3 py-1.5 text-[var(--text-muted)] hover:text-[var(--text-primary)] transition-colors"
                >
                  Cancel
                </button>
              </div>
            ) : (
              <button
                onClick={() => setConfirmDelete(true)}
                className="flex items-center gap-2 text-[var(--text-sm)] text-[var(--text-muted)] hover:text-[var(--error)] transition-colors"
              >
                <Trash2 size={14} />
                Delete task
              </button>
            )}
          </div>
        </div>
      </div>
    </>
  );
}
