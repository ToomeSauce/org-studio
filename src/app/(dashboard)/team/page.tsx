'use client';

import { Pencil, Check, X, Trash2, Unplug, RefreshCw } from 'lucide-react';
import { clsx } from 'clsx';
import { useState, useCallback, useMemo, useEffect, useRef } from 'react';
import { useWSData } from '@/lib/ws';

import { ForceGraph } from '@/components/ForceGraph';
import { Teammate, resolveColor } from '@/lib/teammates';
import { EmojiAvatarPicker, AddTeammateCard } from '@/components/TeammateEditor';
import { mergeTeammates, hasGateway } from '@/lib/teammate-sync';
import TeammateDetailPanel from '@/components/TeammateDetailPanel';
import { GiveKudosModal } from '@/components/GiveKudosModal';
import { KudosBoard } from '@/components/KudosBoard';
import { KudosLeaderboard } from '@/components/KudosLeaderboard';

function PersonCard({ person, isActive, activityStatus, overrides, onSave, onUpdateTeammate, onRemove, taskCount, projectCount, isDisconnected, isGatewayAgent, onClick }: {
  person: Teammate;
  isActive: boolean;
  activityStatus?: { status: string; detail?: string };
  overrides?: { title?: string; domain?: string; owns?: string; defers?: string; description?: string };
  onSave: (id: string, updates: { title?: string; domain?: string; description?: string }) => void;
  onUpdateTeammate: (id: string, updates: Partial<Teammate>) => void;
  onRemove: (id: string) => void;
  taskCount: number;
  projectCount: number;
  isDisconnected?: boolean;
  isGatewayAgent?: boolean;
  onClick?: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [showEmojiPicker, setShowEmojiPicker] = useState(false);
  const [confirmingRemove, setConfirmingRemove] = useState(false);
  const [draft, setDraft] = useState({ title: '', domain: '', owns: '', defers: '', description: '' });

  const displayTitle = overrides?.title || person.title;
  const displayDomain = overrides?.domain || person.domain;
  const displayOwns = overrides?.owns || person.owns || '';
  const displayDefers = overrides?.defers || person.defers || '';
  const displayDesc = overrides?.description || person.description;

  const colors = resolveColor(person.color);
  const saveId = person.agentId || person.id;
  const startEdit = () => {
    setDraft({ title: displayTitle, domain: displayDomain, owns: displayOwns, defers: displayDefers, description: displayDesc });
    setEditing(true);
  };
  const saveEdit = () => {
    onSave(saveId, draft);
    setEditing(false);
  };

  return (
    <div
      onClick={onClick}
      className={clsx(
      'bg-[var(--card)] border rounded-[var(--radius-lg)] p-5 transition-all duration-300 cursor-pointer',
      'shadow-[var(--shadow-sm),inset_0_1px_0_var(--card-highlight)]',
      person.isHuman
        ? `border-[${colors.border}]`
        : isActive
          ? 'border-[rgba(52,211,153,0.3)]'
          : 'border-[var(--border-default)] hover:border-[var(--border-strong)]',
      colors.glow,
    )}>
      <div className="flex items-start gap-4">
        <div className="relative">
          <button
            onClick={(e) => { e.stopPropagation(); setShowEmojiPicker(!showEmojiPicker); }}
            className={clsx(
              'w-12 h-12 rounded-full flex items-center justify-center text-xl shrink-0 cursor-pointer hover:ring-2 hover:ring-[var(--accent-primary)] transition-all overflow-hidden',
              colors.bg,
            )}
            title="Change avatar"
          >
            {person.avatar
              ? <img src={person.avatar} alt="" className="w-full h-full object-cover rounded-full" />
              : person.emoji}
          </button>
          {showEmojiPicker && (
            <EmojiAvatarPicker
              currentEmoji={person.emoji}
              currentAvatar={person.avatar}
              onSelect={u => onUpdateTeammate(person.id, { emoji: u.emoji || person.emoji, avatar: u.avatar })}
              onClose={() => setShowEmojiPicker(false)}
            />
          )}
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2.5 mb-0.5">
            <h3 className="text-[var(--text-md)] font-bold text-[var(--text-primary)] tracking-tight">
              {person.name}
            </h3>
            {person.isHuman && (
              <>
                <span className="text-sm" title="Human">👤</span>
                <div className="w-2.5 h-2.5 rounded-full bg-[var(--success)] shadow-[0_0_8px_rgba(52,211,153,0.5)]" />
              </>
            )}
            {!person.isHuman && !isDisconnected && (
              <>
                <div className={clsx(
                  'w-2.5 h-2.5 rounded-full',
                  isActive ? 'bg-[var(--success)] shadow-[0_0_8px_rgba(52,211,153,0.5)]' : 'bg-zinc-600'
                )} />
                <span className={clsx(
                  'text-[10px] font-semibold px-1.5 py-0.5 rounded-full ml-auto',
                  isActive
                    ? 'bg-[var(--success-subtle)] text-[var(--success)]'
                    : 'bg-[var(--bg-tertiary)] text-[var(--text-muted)]'
                )}>
                  {isActive ? 'ACTIVE' : 'IDLE'}
                </span>
              </>
            )}
            {!person.isHuman && isDisconnected && (
              <span className="flex items-center gap-1 text-[10px] font-semibold px-1.5 py-0.5 rounded-full ml-auto bg-amber-400/10 text-amber-400 border border-amber-400/20" title="Agent not found in runtime — may have been removed from config">
                <Unplug size={10} /> DISCONNECTED
              </span>
            )}
            {person.isHuman && <span className="ml-auto" />}
            {!editing && !confirmingRemove && (
              <>
                <button onClick={(e) => { e.stopPropagation(); startEdit(); }} className="text-[var(--text-muted)] hover:text-[var(--text-primary)] transition-colors" title="Edit">
                  <Pencil size={12} />
                </button>
                {!isGatewayAgent && (
                  <button onClick={(e) => { e.stopPropagation(); setConfirmingRemove(true); }} className="text-[var(--text-muted)] hover:text-red-400 transition-colors" title="Remove">
                    <Trash2 size={12} />
                  </button>
                )}
              </>
            )}
          </div>

          {editing ? (
            <div className="space-y-2 mt-1" onClick={e => e.stopPropagation()}>
              <input value={draft.domain} onChange={e => setDraft(d => ({ ...d, domain: e.target.value }))}
                className="w-full bg-[var(--bg-secondary)] border border-[var(--border-strong)] rounded-[var(--radius-sm)] px-2 py-1 text-[var(--text-sm)] text-[var(--text-primary)] font-bold focus:outline-none focus:border-[var(--accent-primary)]"
                placeholder="Domain (e.g. Engineering, Legal)" />
              <input value={draft.title} onChange={e => setDraft(d => ({ ...d, title: e.target.value }))}
                className="w-full bg-[var(--bg-secondary)] border border-[var(--border-strong)] rounded-[var(--radius-sm)] px-2 py-1 text-[var(--text-xs)] text-[var(--text-muted)] focus:outline-none focus:border-[var(--accent-primary)]"
                placeholder="Role (e.g. Senior Engineer)" />
              <div>
                <label className="text-[var(--text-xs)] font-semibold text-[var(--success)] mb-1 block">✅ Owns — autonomous decisions</label>
                <textarea value={draft.owns} onChange={e => setDraft(d => ({ ...d, owns: e.target.value }))}
                  rows={2}
                  className="w-full bg-[var(--bg-secondary)] border border-[var(--border-strong)] rounded-[var(--radius-sm)] px-2 py-1 text-[var(--text-xs)] text-[var(--text-tertiary)] leading-relaxed resize-none focus:outline-none focus:border-[var(--accent-primary)]"
                  placeholder="Architecture decisions, CI/CD, staging deploys, code review..." />
              </div>
              <div>
                <label className="text-[var(--text-xs)] font-semibold text-amber-400 mb-1 block">🛑 Defers — needs confirmation</label>
                <textarea value={draft.defers} onChange={e => setDraft(d => ({ ...d, defers: e.target.value }))}
                  rows={2}
                  className="w-full bg-[var(--bg-secondary)] border border-[var(--border-strong)] rounded-[var(--radius-sm)] px-2 py-1 text-[var(--text-xs)] text-[var(--text-tertiary)] leading-relaxed resize-none focus:outline-none focus:border-[var(--accent-primary)]"
                  placeholder="Production deploys, budget, customer-facing changes, hiring..." />
              </div>
              <textarea value={draft.description} onChange={e => setDraft(d => ({ ...d, description: e.target.value }))}
                rows={2}
                className="w-full bg-[var(--bg-secondary)] border border-[var(--border-strong)] rounded-[var(--radius-sm)] px-2 py-1 text-[var(--text-sm)] text-[var(--text-tertiary)] leading-relaxed resize-none focus:outline-none focus:border-[var(--accent-primary)]"
                placeholder="Description (optional)" />
              <div className="flex gap-2">
                <button onClick={saveEdit} className="flex items-center gap-1 px-2 py-1 rounded-[var(--radius-sm)] bg-[var(--success-subtle)] text-[var(--success)] text-[var(--text-xs)] font-medium hover:bg-[var(--success)] hover:text-white transition-colors">
                  <Check size={11} /> Save
                </button>
                <button onClick={() => setEditing(false)} className="flex items-center gap-1 px-2 py-1 rounded-[var(--radius-sm)] bg-[var(--bg-tertiary)] text-[var(--text-muted)] text-[var(--text-xs)] font-medium hover:text-[var(--text-primary)] transition-colors">
                  <X size={11} /> Cancel
                </button>
              </div>
            </div>
          ) : (
            <>
              <p className={clsx('text-[var(--text-base)] font-bold', colors.text)}>{displayDomain}</p>
              <p className="text-[var(--text-xs)] text-[var(--text-muted)] mt-0.5 mb-1.5">{displayTitle}</p>
              {displayOwns && (
                <p className="text-[var(--text-xs)] text-[var(--text-tertiary)] leading-relaxed mb-1">
                  <span className="font-semibold text-[var(--success)]">Owns:</span> {displayOwns}
                </p>
              )}
              {displayDefers && (
                <p className="text-[var(--text-xs)] text-[var(--text-tertiary)] leading-relaxed mb-1">
                  <span className="font-semibold text-amber-400">Defers:</span> {displayDefers}
                </p>
              )}
              {displayDesc && (
                <p className="text-[var(--text-sm)] text-[var(--text-tertiary)] leading-relaxed mt-1">
                  {displayDesc}
                </p>
              )}
            </>
          )}

          {activityStatus && !editing && !confirmingRemove && (
            <div className="mt-3 px-3 py-2 rounded-[var(--radius-md)] bg-[var(--success-subtle)] border border-[rgba(52,211,153,0.2)]">
              <p className="text-[var(--text-xs)] font-semibold text-[var(--success)]">
                {activityStatus.status}
              </p>
              {activityStatus.detail && (
                <p className="text-[var(--text-xs)] text-[var(--success)] opacity-70 mt-0.5">
                  {activityStatus.detail}
                </p>
              )}
            </div>
          )}

          {/* Inline remove confirmation */}
          {confirmingRemove && (
            <div className="mt-3 px-3 py-3 rounded-[var(--radius-md)] bg-red-500/5 border border-red-500/20">
              <p className="text-[var(--text-sm)] font-semibold text-red-400 mb-1.5">
                Remove {person.name}?
              </p>
              {(taskCount > 0 || projectCount > 0) && (
                <p className="text-[var(--text-xs)] text-[var(--text-muted)] mb-2">
                  {person.name} has{' '}
                  {taskCount > 0 && <span className="font-semibold text-[var(--text-secondary)]">{taskCount} task{taskCount !== 1 ? 's' : ''}</span>}
                  {taskCount > 0 && projectCount > 0 && ' and '}
                  {projectCount > 0 && <span className="font-semibold text-[var(--text-secondary)]">{projectCount} project{projectCount !== 1 ? 's' : ''}</span>}
                  {' '}that will become unassigned.
                </p>
              )}
              {!person.isHuman && isActive && (
                <p className="text-[var(--text-xs)] text-amber-400 mb-2">
                  ⚠ This agent is currently active. Removing won't stop it — only hides it from the roster.
                </p>
              )}
              <p className="text-[var(--text-xs)] text-[var(--text-muted)] mb-3">
                This removes them from the team page, visualizations, and assignee lists. It does not delete tasks or disconnect agents.
              </p>
              <div className="flex gap-2">
                <button
                  onClick={(e) => { e.stopPropagation(); onRemove(person.id); setConfirmingRemove(false); }}
                  className="flex items-center gap-1.5 px-3 py-1.5 rounded-[var(--radius-sm)] bg-red-500/15 text-red-400 text-[var(--text-xs)] font-medium hover:bg-red-500 hover:text-white transition-colors"
                >
                  <Trash2 size={11} /> Remove
                </button>
                <button
                  onClick={(e) => { e.stopPropagation(); setConfirmingRemove(false); }}
                  className="flex items-center gap-1.5 px-3 py-1.5 rounded-[var(--radius-sm)] bg-[var(--bg-tertiary)] text-[var(--text-muted)] text-[var(--text-xs)] font-medium hover:text-[var(--text-primary)] transition-colors"
                >
                  Cancel
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function ValueCard({ value: v, index, allValues }: { value: any; index: number; allValues: any }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState({ title: '', description: '', icon: '', letter: '' });

  const startEdit = () => {
    setDraft({ title: v.title, description: v.description, icon: v.icon, letter: v.letter });
    setEditing(true);
  };

  const saveEdit = async () => {
    const updated = { ...allValues };
    updated.items = [...updated.items];
    updated.items[index] = { ...updated.items[index], ...draft };
    await fetch('/api/store', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'updateValues', values: updated }),
    });
    setEditing(false);
  };

  return (
    <div className="group bg-[var(--card)] border border-[var(--border-default)] rounded-[var(--radius-lg)] p-5 shadow-[var(--shadow-sm),inset_0_1px_0_var(--card-highlight)] text-center relative overflow-hidden">
      <span className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 text-[8rem] font-black leading-none text-[var(--accent-primary)] opacity-[0.15] pointer-events-none select-none">{v.letter}</span>
      {!editing && (
        <button
          onClick={startEdit}
          className="absolute top-3 right-3 opacity-0 group-hover:opacity-100 text-[var(--text-muted)] hover:text-[var(--text-primary)] transition-all z-10"
          title="Edit value"
        >
          <Pencil size={12} />
        </button>
      )}
      {editing ? (
        <div className="relative space-y-2">
          <input value={draft.icon} onChange={e => setDraft(d => ({ ...d, icon: e.target.value }))}
            className="w-full bg-[var(--bg-secondary)] border border-[var(--border-strong)] rounded-[var(--radius-sm)] px-2 py-1 text-center text-2xl focus:outline-none focus:border-[var(--accent-primary)]"
            placeholder="Icon" maxLength={4} />
          <input value={draft.title} onChange={e => setDraft(d => ({ ...d, title: e.target.value }))}
            className="w-full bg-[var(--bg-secondary)] border border-[var(--border-strong)] rounded-[var(--radius-sm)] px-2 py-1 text-[var(--text-sm)] font-bold text-[var(--text-primary)] text-center focus:outline-none focus:border-[var(--accent-primary)]"
            placeholder="Title" />
          <textarea value={draft.description} onChange={e => setDraft(d => ({ ...d, description: e.target.value }))}
            rows={3}
            className="w-full bg-[var(--bg-secondary)] border border-[var(--border-strong)] rounded-[var(--radius-sm)] px-2 py-1 text-[var(--text-xs)] text-[var(--text-tertiary)] leading-relaxed text-center resize-none focus:outline-none focus:border-[var(--accent-primary)]"
            placeholder="Description" />
          <div className="flex justify-center gap-2">
            <button onClick={saveEdit} className="flex items-center gap-1 px-2 py-1 rounded-[var(--radius-sm)] bg-[var(--success-subtle)] text-[var(--success)] text-[var(--text-xs)] font-medium hover:bg-[var(--success)] hover:text-white transition-colors">
              <Check size={11} /> Save
            </button>
            <button onClick={() => setEditing(false)} className="flex items-center gap-1 px-2 py-1 rounded-[var(--radius-sm)] bg-[var(--bg-tertiary)] text-[var(--text-muted)] text-[var(--text-xs)] font-medium hover:text-[var(--text-primary)] transition-colors">
              <X size={11} /> Cancel
            </button>
          </div>
        </div>
      ) : (
        <>
          <span className="text-3xl block mb-3 relative">{v.icon}</span>
          <h3 className="text-[var(--text-sm)] font-bold text-[var(--text-primary)] mb-2 relative">{v.title}</h3>
          <p className="text-[var(--text-xs)] text-[var(--text-tertiary)] leading-relaxed relative">{v.description}</p>
        </>
      )}
    </div>
  );
}

export default function TeamPage() {

  const [editingMission, setEditingMission] = useState(false);
  const [missionDraft, setMissionDraft] = useState('');
  const [selectedTeammate, setSelectedTeammate] = useState<Teammate | null>(null);
  const sessions = useWSData<any>('sessions');
  const rawStatuses = useWSData<any>('activity-status');
  const storeData = useWSData<any>('store');
  const [gatewayAgents, setGatewayAgents] = useState<any>(null);
  const [syncing, setSyncing] = useState(false);

  // Sync agents from all runtimes on-demand
  const syncAgents = useCallback(async () => {
    setSyncing(true);
    try {
      const resp = await fetch('/api/runtimes');
      const data = await resp.json();
      if (data.runtimes) {
        // Flatten all agents from all connected runtimes into gateway-agents shape
        const allAgents = data.runtimes
          .filter((r: any) => r.connected && r.agents?.length)
          .flatMap((r: any) => r.agents);
        setGatewayAgents({ agents: allAgents });
      }
    } catch (err) {
      console.error('Failed to sync agents:', err);
    } finally {
      setSyncing(false);
    }
  }, []);

  // Sync once on mount
  useEffect(() => { syncAgents(); }, [syncAgents]);
  const activityStatuses = rawStatuses?.statuses || rawStatuses || {};
  const sessionList = sessions?.sessions || [];

  // Determine active agents
  const now = Date.now();
  const activeAgentIds = new Set<string>();
  if (Array.isArray(sessionList)) {
    for (const s of sessionList) {
      const key: string = s.key || '';
      const agentId = key.split(':')[1] || '';
      if (s.updatedAt && now - s.updatedAt < 3600000) {
        activeAgentIds.add(agentId);
      }
    }
  }
  // Also mark as active if self-reported
  for (const key of Object.keys(activityStatuses)) {
    activeAgentIds.add(key);
  }
  // Also mark as active if agent has in-progress tasks
  const allTasks = storeData?.tasks || [];
  const storeTeammatesTemp: Teammate[] = storeData?.settings?.teammates || [];
  for (const tm of storeTeammatesTemp) {
    if (tm.isHuman || !tm.agentId) continue;
    const hasIP = allTasks.some((t: any) => (
      (t.assignee?.toLowerCase() === tm.name.toLowerCase() || 
       t.assignee?.toLowerCase() === tm.agentId.toLowerCase()) && 
      t.status === 'in-progress' && !t.isArchived
    ));
    if (hasIP) activeAgentIds.add(tm.agentId);
  }

  // Merge Gateway agents with store teammates
  const storeTeammates: Teammate[] = storeData?.settings?.teammates || [];
  const gwAvailable = hasGateway(gatewayAgents);
  const { merged: teammates, newAgents } = useMemo(
    () => mergeTeammates(storeTeammates, gwAvailable ? gatewayAgents : null),
    [storeTeammates, gatewayAgents, gwAvailable]
  );
  const gwAgentIds = useMemo(
    () => new Set((gatewayAgents?.agents || []).map((a: any) => a.id)),
    [gatewayAgents]
  );

  // Auto-scaffold moved to server-side (/api/runtimes endpoint).
  // No client-side scaffolding needed — agents are persisted when Sync is clicked.
  const tasks: any[] = storeData?.tasks || [];
  const projects: any[] = storeData?.projects || [];
  const valuesData = storeData?.settings?.values;
  const defaultMission = 'Define your mission — what does your team exist to do?';
  const missionStatement = storeData?.settings?.missionStatement || defaultMission;

  const startEditing = useCallback(() => {
    setMissionDraft(missionStatement);
    setEditingMission(true);
  }, [missionStatement]);

  const saveMission = useCallback(async () => {
    const trimmed = missionDraft.trim();
    if (!trimmed) return;
    await fetch('/api/store', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'updateSettings', settings: { missionStatement: trimmed } }),
    });
    setEditingMission(false);
  }, [missionDraft]);

  const cancelEditing = useCallback(() => {
    setEditingMission(false);
  }, []);

  const agentOverrides: Record<string, any> = storeData?.settings?.agentOverrides || {};

  const saveAgentOverride = useCallback(async (agentId: string, updates: { title?: string; domain?: string; owns?: string; defers?: string; description?: string }) => {
    // Save to agentOverrides for backward compat
    const current = storeData?.settings?.agentOverrides || {};
    const merged = { ...current, [agentId]: { ...(current[agentId] || {}), ...updates } };
    await fetch('/api/store', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'updateSettings', settings: { agentOverrides: merged } }),
    });
    // Also persist owns/defers to the teammate record directly
    const teammate = teammates.find(t => (t.agentId || t.id) === agentId);
    if (teammate && (updates.owns !== undefined || updates.defers !== undefined)) {
      await fetch('/api/store', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'updateTeammate', id: teammate.id, updates: { owns: updates.owns, defers: updates.defers } }),
      });
    }
  }, [storeData, teammates]);

  const updateTeammate = useCallback(async (id: string, updates: Partial<Teammate>) => {
    await fetch('/api/store', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'updateTeammate', id, updates }),
    });
  }, []);

  const removeTeammate = useCallback(async (id: string) => {
    await fetch('/api/store', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'removeTeammate', id }),
    });
  }, []);

  const addTeammate = useCallback(async (teammate: any) => {
    await fetch('/api/store', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'addTeammate', teammate }),
    });
  }, []);

  // Kudos modal state
  const [kudosModalOpen, setKudosModalOpen] = useState(false);
  const [kudosTarget, setKudosTarget] = useState<{ agentId?: string; taskId?: string } | null>(null);

  const openKudosModal = (agentId?: string, taskId?: string) => {
    setKudosTarget({ agentId, taskId });
    setKudosModalOpen(true);
  };

  const handleKudosSubmit = useCallback(async (data: {
    agentId: string;
    givenBy: string;
    type: 'kudos' | 'flag';
    values: string[];
    note: string;
    taskId?: string;
  }) => {
    const res = await fetch('/api/kudos', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    });
    if (!res.ok) {
      const err = await res.json();
      throw new Error(err.error || 'Failed to submit kudos');
    }
  }, []);

  return (
    <div className="space-y-10">
      {/* OUR TEAM — header + visualization */}
      <div>
        <div className="flex items-center justify-between mb-4">
          <div>
            <h2 className="text-[var(--text-lg)] font-bold tracking-tight text-[var(--text-primary)]">Our Team</h2>
            <p className="text-[var(--text-base)] text-[var(--text-tertiary)] mt-1">Domain ownership · Flat structure · Mission-driven</p>
          </div>
          <button
            onClick={syncAgents}
            disabled={syncing}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-[var(--radius-md)] text-[var(--text-xs)] font-medium border transition-all bg-[var(--bg-tertiary)] border-[var(--border-default)] text-[var(--text-secondary)] hover:border-[var(--border-strong)] hover:bg-[var(--bg-hover)] disabled:opacity-50"
          >
            <RefreshCw size={13} className={syncing ? 'animate-spin' : ''} />
            {syncing ? 'Syncing...' : 'Sync Agents'}
          </button>
        </div>
        <div className="bg-gradient-to-br from-[rgba(255,92,92,0.03)] via-[rgba(139,92,246,0.03)] to-[rgba(34,211,238,0.03)] border border-[var(--border-default)] rounded-[var(--radius-lg)] overflow-hidden">
          <ForceGraph activeAgentIds={activeAgentIds} activityStatuses={activityStatuses} savedNodePhysics={storeData?.settings?.nodePhysics} teammates={teammates} />
        </div>
      </div>

      {/* OUR MISSION — editable card */}
      <div>
        <h2 className="text-[var(--text-lg)] font-bold tracking-tight text-[var(--text-primary)]">Our Mission</h2>
        <p className="text-[var(--text-base)] text-[var(--text-tertiary)] mt-1 mb-4">Our north star</p>
        <div className="bg-[var(--card)] border border-[var(--border-default)] rounded-[var(--radius-lg)] p-8 shadow-[var(--shadow-sm),inset_0_1px_0_var(--card-highlight)]">
          {editingMission ? (
            <div className="mx-auto">
              <input
                value={missionDraft}
                onChange={e => setMissionDraft(e.target.value)}
                autoFocus
                className="w-full bg-[var(--bg-secondary)] border border-[var(--border-strong)] rounded-[var(--radius-md)] px-4 py-3 text-[1.75rem] text-[var(--text-primary)] font-bold text-center focus:outline-none focus:border-[var(--accent-primary)]"
                onKeyDown={e => {
                  if (e.key === 'Enter') { e.preventDefault(); saveMission(); }
                  if (e.key === 'Escape') cancelEditing();
                }}
              />
              <div className="flex items-center justify-center gap-2 mt-3">
                <button onClick={saveMission} className="flex items-center gap-1 px-3 py-1.5 rounded-[var(--radius-sm)] bg-[var(--success-subtle)] text-[var(--success)] text-[var(--text-xs)] font-medium hover:bg-[var(--success)] hover:text-white transition-colors">
                  <Check size={12} /> Save
                </button>
                <button onClick={cancelEditing} className="flex items-center gap-1 px-3 py-1.5 rounded-[var(--radius-sm)] bg-[var(--bg-tertiary)] text-[var(--text-muted)] text-[var(--text-xs)] font-medium hover:text-[var(--text-primary)] transition-colors">
                  <X size={12} /> Cancel
                </button>
              </div>
            </div>
          ) : (
            <div className="group relative text-center">
              <p className="text-[1.75rem] text-[var(--text-primary)] leading-snug font-bold">{missionStatement}</p>
              <button
                onClick={startEditing}
                className="absolute right-0 top-0 opacity-0 group-hover:opacity-100 text-[var(--text-muted)] hover:text-[var(--text-primary)] transition-all p-1"
                title="Edit mission statement"
              >
                <Pencil size={14} />
              </button>
            </div>
          )}
        </div>
      </div>

      {/* Cultural Values — from store */}
      {valuesData && valuesData.items?.length > 0 && (
        <div>
          <h2 className="text-[var(--text-lg)] font-bold tracking-tight text-[var(--text-primary)]">
            Our {valuesData.name || 'Values'}
          </h2>
          <p className="text-[var(--text-base)] text-[var(--text-tertiary)] mt-1 mb-4">Guiding principles. Cultural values.</p>
          <div className={clsx('grid gap-4', valuesData.items.length <= 3 ? 'grid-cols-1 md:grid-cols-3' : 'grid-cols-2 md:grid-cols-4')}>
            {valuesData.items.map((v: any, idx: number) => (
              <ValueCard key={v.letter} value={v} index={idx} allValues={valuesData} />
            ))}
          </div>
        </div>
      )}

      {/* Our People — flat grid, domain-first */}
      <div>
        <div className="flex items-start justify-between">
          <div>
            <h2 className="text-[var(--text-lg)] font-bold tracking-tight text-[var(--text-primary)]">Our Teammates</h2>
            <p className="text-[var(--text-base)] text-[var(--text-tertiary)] mt-1 mb-4">
              Human, agent, and everything in between
              {gwAvailable && (
                <span className="text-[var(--text-xs)] text-[var(--text-muted)] block mt-0.5">
                  Note: Agents are synced from your runtime. To add or remove agents, update your agent configuration, e.g. in OpenClaw Gateway.
                </span>
              )}
              {!gwAvailable && (
                <span className="text-[var(--text-xs)] text-[var(--text-muted)] block mt-0.5">
                  No runtime connected. Connect a Gateway to auto-discover agents.
                </span>
              )}
            </p>
          </div>
          {gwAvailable && (
            <button
              onClick={(e) => {
                const btn = e.currentTarget;
                btn.classList.add('animate-spin');
                fetch('/api/gateway', {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ method: 'agents.list' }),
                }).finally(() => setTimeout(() => btn.classList.remove('animate-spin'), 600));
              }}
              className="shrink-0 mt-1 p-2 rounded-[var(--radius-md)] text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-hover)] transition-colors"
              title="Sync from runtime"
            >
              <RefreshCw size={15} />
            </button>
          )}
        </div>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
          {teammates.map(person => {
            const personTaskCount = tasks.filter(t => t.assignee === person.name).length;
            const personProjectCount = projects.filter(p => p.owner === person.name).length;
            const disconnected = !!(person as any)._disconnected;
            const fromGateway = gwAvailable && !person.isHuman && gwAgentIds.has(person.agentId);
            return (
              <PersonCard
                key={person.id}
                person={person}
                isActive={activeAgentIds.has(person.agentId)}
                activityStatus={person.agentId ? activityStatuses[person.agentId] : undefined}
                overrides={agentOverrides[person.agentId || person.id]}
                onSave={saveAgentOverride}
                onUpdateTeammate={updateTeammate}
                onRemove={removeTeammate}
                taskCount={personTaskCount}
                projectCount={personProjectCount}
                isDisconnected={disconnected}
                isGatewayAgent={fromGateway}
                onClick={() => setSelectedTeammate(person)}
              />
            );
          })}
          <AddTeammateCard onAdd={addTeammate} gatewayConnected={gwAvailable} />
        </div>
      </div>

      {/* Teammate Detail Panel */}
      {selectedTeammate && (
        <TeammateDetailPanel
          teammate={selectedTeammate}
          isActive={activeAgentIds.has(selectedTeammate.agentId)}
          activityStatus={selectedTeammate.agentId ? activityStatuses[selectedTeammate.agentId] : undefined}
          overrides={agentOverrides[selectedTeammate.agentId || selectedTeammate.id]}
          tasks={tasks}
          projects={projects}
          loops={storeData?.settings?.loops || []}
          isDisconnected={!!(selectedTeammate as any)._disconnected}
          onClose={() => setSelectedTeammate(null)}
          onSave={saveAgentOverride}
          onUpdateTeammate={updateTeammate}
        />
      )}

      {/* Kudos Board Section */}
      <div>
        <div className="flex items-center justify-between mb-4">
          <div>
            <h2 className="text-[var(--text-lg)] font-bold tracking-tight text-[var(--text-primary)]">Kudos Board</h2>
            <p className="text-[var(--text-base)] text-[var(--text-tertiary)] mt-1">Recognition & feedback</p>
          </div>
          <button
            onClick={() => openKudosModal()}
            className="px-3 py-1.5 rounded-[var(--radius-md)] bg-[var(--accent-primary)] text-white text-[var(--text-xs)] font-medium hover:bg-[var(--accent-primary-hover)] transition-colors"
          >
            ⭐ Give Kudos
          </button>
        </div>
        <KudosBoard />
      </div>

      {/* Kudos Leaderboard Section */}
      <div>
        <h2 className="text-[var(--text-lg)] font-bold tracking-tight text-[var(--text-primary)] mb-4">Leaderboard (30 days)</h2>
        <KudosLeaderboard />
      </div>

      {/* Give Kudos Modal */}
      <GiveKudosModal
        isOpen={kudosModalOpen}
        onClose={() => setKudosModalOpen(false)}
        prefilledAgent={kudosTarget?.agentId}
        onSubmit={handleKudosSubmit}
      />
    </div>
  );
}
