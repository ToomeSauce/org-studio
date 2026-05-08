/**
 * ProjectSettingsPanel — slide-over for editing project metadata.
 *
 * #1281: closes the gap where project.name / description / devOwner /
 * qaOwner / visionOwner / repoUrl were create-time-only. Saves go through
 * the existing /api/store action=updateProject endpoint (already accepts
 * arbitrary {updates} patches — pure UI gap).
 *
 * Mirrors the chrome of TaskDetailPanel (right-side, 520px, backdrop) so
 * the visual language stays consistent.
 */

'use client';

import { useEffect, useRef, useState } from 'react';
import { X, Loader2 } from 'lucide-react';
import clsx from 'clsx';

interface ProjectMeta {
  id: string;
  name?: string;
  description?: string;
  devOwner?: string;
  visionOwner?: string;
  repoUrl?: string;
}

interface Props {
  open: boolean;
  project: ProjectMeta;
  teammates: string[];
  onClose: () => void;
  /** Called with the patch object on successful save. Lets the parent
   *  push an optimistic update into local store cache. */
  onSaved?: (patch: Partial<ProjectMeta>) => void;
}

export default function ProjectSettingsPanel({ open, project, teammates, onClose, onSaved }: Props) {
  const [name, setName] = useState(project.name || '');
  const [description, setDescription] = useState(project.description || '');
  const [devOwner, setDevOwner] = useState(project.devOwner || '');
  const [visionOwner, setVisionOwner] = useState(project.visionOwner || '');
  const [repoUrl, setRepoUrl] = useState(project.repoUrl || '');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const firstFieldRef = useRef<HTMLInputElement | null>(null);

  // Hydrate form when project changes / panel opens.
  useEffect(() => {
    if (!open) return;
    setName(project.name || '');
    setDescription(project.description || '');
    setDevOwner(project.devOwner || '');
    setVisionOwner(project.visionOwner || '');
    setRepoUrl(project.repoUrl || '');
    setError(null);
    // Focus the name field on open for quick edits.
    setTimeout(() => firstFieldRef.current?.focus(), 50);
  }, [open, project.id, project.name, project.description, project.devOwner, project.visionOwner, project.repoUrl]);

  // Esc to close.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;

  const trimmedName = name.trim();
  const canSave = trimmedName.length > 0 && !saving;

  // Build the patch — only include changed fields so partial writes stay
  // partial. Empty string clears the field (server-side updateProject
  // accepts the value as-is).
  const buildPatch = (): Partial<ProjectMeta> => {
    const patch: Partial<ProjectMeta> = {};
    if (trimmedName !== (project.name || '')) patch.name = trimmedName;
    if (description !== (project.description || '')) patch.description = description;
    if (devOwner !== (project.devOwner || '')) patch.devOwner = devOwner;
    if (visionOwner !== (project.visionOwner || '')) patch.visionOwner = visionOwner;
    if (repoUrl !== (project.repoUrl || '')) patch.repoUrl = repoUrl;
    return patch;
  };

  const handleSave = async () => {
    if (!canSave) return;
    const patch = buildPatch();
    if (Object.keys(patch).length === 0) {
      onClose();
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const resp = await fetch('/api/store', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'updateProject', id: project.id, updates: patch }),
      });
      if (!resp.ok) {
        const body = await resp.json().catch(() => ({} as any));
        throw new Error(body?.error || `HTTP ${resp.status}`);
      }
      onSaved?.(patch);
      onClose();
    } catch (e: any) {
      setError(e?.message || 'Save failed');
    } finally {
      setSaving(false);
    }
  };

  // Owner select — uses the same teammates roster passed in. Empty option
  // clears the field. Includes current value (in case it's stale-out-of-roster)
  // so the picker never silently drops it.
  const ownerSelect = (current: string, setter: (v: string) => void, label: string) => {
    const options = Array.from(new Set([...(current ? [current] : []), ...teammates]));
    return (
      <label className="block">
        <span className="text-xs uppercase tracking-[0.1em] text-[var(--text-muted)]">{label}</span>
        <select
          value={current}
          onChange={(e) => setter(e.target.value)}
          className="mt-1 w-full px-3 py-2 bg-[var(--bg-secondary)] border border-[var(--border-color)] rounded-lg text-[var(--text-primary)] focus:outline-none focus:border-[var(--accent)]"
        >
          <option value="">— none —</option>
          {options.map((t) => (
            <option key={t} value={t}>{t}</option>
          ))}
        </select>
      </label>
    );
  };

  return (
    <>
      {/* Backdrop */}
      <div
        className="fixed inset-0 z-40 bg-black/40 backdrop-blur-[2px] transition-opacity duration-200"
        onClick={onClose}
        aria-hidden
      />
      {/* Slide-over */}
      <aside
        role="dialog"
        aria-modal="true"
        aria-label="Project settings"
        className={clsx(
          'fixed top-0 right-0 z-50 h-full w-[520px] max-w-[95vw] bg-[var(--bg-primary)] border-l border-[var(--border-strong)] shadow-2xl',
          'flex flex-col',
        )}
      >
        <header className="flex items-center justify-between px-5 py-4 border-b border-[var(--border-color)]">
          <h2 className="text-base font-semibold text-[var(--text-primary)]">Project Settings</h2>
          <button
            type="button"
            onClick={onClose}
            className="p-1.5 rounded hover:bg-[var(--bg-tertiary)] transition-colors"
            aria-label="Close"
          >
            <X className="w-4 h-4 text-[var(--text-muted)]" />
          </button>
        </header>

        <div className="flex-1 overflow-y-auto px-5 py-4 space-y-4">
          <label className="block">
            <span className="text-xs uppercase tracking-[0.1em] text-[var(--text-muted)]">Name</span>
            <input
              ref={firstFieldRef}
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Project name"
              className="mt-1 w-full px-3 py-2 bg-[var(--bg-secondary)] border border-[var(--border-color)] rounded-lg text-[var(--text-primary)] focus:outline-none focus:border-[var(--accent)]"
            />
            {!trimmedName && (
              <span className="block mt-1 text-[11px] text-red-500">Required.</span>
            )}
          </label>

          <label className="block">
            <span className="text-xs uppercase tracking-[0.1em] text-[var(--text-muted)]">Description</span>
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="One-line description, mission, or scope"
              rows={3}
              className="mt-1 w-full px-3 py-2 bg-[var(--bg-secondary)] border border-[var(--border-color)] rounded-lg text-[var(--text-primary)] focus:outline-none focus:border-[var(--accent)]"
            />
          </label>

          <div className="pt-2 border-t border-[var(--border-color)]" />

          {ownerSelect(devOwner, setDevOwner, 'Default owner (component fallback)')}
          {ownerSelect(visionOwner, setVisionOwner, 'Vision owner')}

          <div className="pt-2 border-t border-[var(--border-color)]" />

          <label className="block">
            <span className="text-xs uppercase tracking-[0.1em] text-[var(--text-muted)]">Repo URL</span>
            <input
              type="text"
              value={repoUrl}
              onChange={(e) => setRepoUrl(e.target.value)}
              placeholder="org/repo or https://github.com/org/repo"
              className="mt-1 w-full px-3 py-2 bg-[var(--bg-secondary)] border border-[var(--border-color)] rounded-lg text-[var(--text-primary)] focus:outline-none focus:border-[var(--accent)] font-mono text-sm"
            />
          </label>

          {error && (
            <div className="px-3 py-2 rounded bg-red-50 dark:bg-red-950/30 border border-red-200 dark:border-red-800/50 text-sm text-red-700 dark:text-red-300">
              {error}
            </div>
          )}
        </div>

        <footer className="flex items-center justify-end gap-2 px-5 py-3 border-t border-[var(--border-color)]">
          <button
            type="button"
            onClick={onClose}
            className="px-4 py-2 rounded text-sm text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)] transition-colors"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={handleSave}
            disabled={!canSave}
            className="inline-flex items-center gap-2 px-4 py-2 rounded text-sm font-medium bg-[var(--accent-primary)] text-white hover:opacity-90 disabled:opacity-50 transition-opacity"
          >
            {saving && <Loader2 size={14} className="animate-spin" />}
            {saving ? 'Saving…' : 'Save'}
          </button>
        </footer>
      </aside>
    </>
  );
}
