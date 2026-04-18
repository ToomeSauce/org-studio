'use client';

import { useState, useEffect, useRef } from 'react';
import { Building2, Check, ChevronDown, RefreshCw } from 'lucide-react';
import { clsx } from 'clsx';

interface WorkspaceInfo {
  id: string;
  name: string;
  owner?: string;
  createdAt?: number;
}

interface WorkspacesResponse {
  ok: boolean;
  current: WorkspaceInfo;
  workspaces: WorkspaceInfo[];
  multiWorkspace: boolean;
}

/**
 * WorkspaceSwitcher — shows current workspace and allows switching
 * if the user has access to multiple workspaces.
 *
 * Renders as a dropdown in the topbar or settings page.
 * Mobile-friendly: works in both contexts.
 */
export function WorkspaceSwitcher({
  variant = 'compact',
  onSwitch,
}: {
  variant?: 'compact' | 'full';
  onSwitch?: (workspace: WorkspaceInfo) => void;
}) {
  const [data, setData] = useState<WorkspacesResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [switching, setSwitching] = useState(false);
  const [open, setOpen] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);

  // Fetch workspace data
  useEffect(() => {
    fetch('/api/workspaces')
      .then((r) => r.json())
      .then((d) => setData(d))
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  // Close dropdown on outside click
  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  const handleSwitch = async (workspaceId: string) => {
    if (switching) return;
    setSwitching(true);
    try {
      const resp = await fetch('/api/workspaces', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'switch', workspaceId }),
      });
      const result = await resp.json();
      if (result.ok) {
        setOpen(false);
        if (onSwitch) {
          onSwitch(result.workspace);
        } else {
          // Reload to re-fetch all data scoped to the new workspace
          window.location.reload();
        }
      }
    } catch {
      // silent
    } finally {
      setSwitching(false);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center gap-1.5 px-2 py-1 text-[var(--text-xs)] text-[var(--text-muted)]">
        <RefreshCw size={12} className="animate-spin" />
        <span>Loading...</span>
      </div>
    );
  }

  if (!data || !data.multiWorkspace) {
    // Single workspace — nothing to show in compact mode
    if (variant === 'compact') return null;

    // In full mode, show the current workspace info
    return (
      <div className="flex items-center gap-2 px-3 py-2.5 rounded-[var(--radius-md)] bg-[var(--bg-primary)] border border-[var(--border-subtle)]">
        <Building2 size={16} className="text-[var(--text-muted)]" />
        <div className="flex-1">
          <p className="text-[var(--text-sm)] font-medium text-[var(--text-primary)]">
            {data?.current?.name || 'Default Workspace'}
          </p>
          <p className="text-[var(--text-xs)] text-[var(--text-tertiary)]">
            Single workspace — all data lives here
          </p>
        </div>
      </div>
    );
  }

  // Multi-workspace dropdown
  return (
    <div ref={dropdownRef} className="relative">
      <button
        onClick={() => setOpen(!open)}
        className={clsx(
          'flex items-center gap-1.5 rounded-[var(--radius-md)] border transition-all',
          variant === 'compact'
            ? 'px-2 py-1 text-[var(--text-xs)] bg-[var(--bg-tertiary)] border-[var(--border-default)] hover:border-[var(--border-strong)]'
            : 'px-3 py-2.5 text-[var(--text-sm)] bg-[var(--bg-primary)] border-[var(--border-subtle)] hover:border-[var(--border-default)] w-full',
        )}
      >
        <Building2 size={variant === 'compact' ? 12 : 16} className="text-[var(--text-secondary)]" />
        <span className="text-[var(--text-primary)] font-medium truncate">
          {data.current.name}
        </span>
        <ChevronDown
          size={variant === 'compact' ? 12 : 14}
          className={clsx(
            'text-[var(--text-muted)] transition-transform ml-auto',
            open && 'rotate-180',
          )}
        />
      </button>

      {open && (
        <div
          className={clsx(
            'absolute z-50 mt-1 rounded-[var(--radius-lg)] border border-[var(--border-default)] bg-[var(--card)] shadow-[var(--shadow-md)] overflow-hidden',
            variant === 'compact' ? 'right-0 w-56' : 'left-0 right-0',
          )}
        >
          <div className="p-1.5 max-h-64 overflow-y-auto">
            {data.workspaces.map((ws) => {
              const isCurrent = ws.id === data.current.id;
              return (
                <button
                  key={ws.id}
                  onClick={() => !isCurrent && handleSwitch(ws.id)}
                  disabled={isCurrent || switching}
                  className={clsx(
                    'w-full flex items-center gap-2.5 px-3 py-2 rounded-[var(--radius-md)] text-left transition-colors',
                    isCurrent
                      ? 'bg-[color-mix(in_srgb,var(--accent-primary)_10%,transparent)]'
                      : 'hover:bg-[var(--bg-hover)]',
                    (switching && !isCurrent) && 'opacity-50 cursor-wait',
                  )}
                >
                  <Building2
                    size={14}
                    className={
                      isCurrent ? 'text-[var(--accent-primary)]' : 'text-[var(--text-muted)]'
                    }
                  />
                  <div className="flex-1 min-w-0">
                    <p
                      className={clsx(
                        'text-[var(--text-xs)] font-medium truncate',
                        isCurrent
                          ? 'text-[var(--accent-primary)]'
                          : 'text-[var(--text-primary)]',
                      )}
                    >
                      {ws.name}
                    </p>
                    {ws.owner && (
                      <p className="text-[10px] text-[var(--text-muted)] truncate">
                        Owner: {ws.owner}
                      </p>
                    )}
                  </div>
                  {isCurrent && (
                    <Check size={14} className="text-[var(--accent-primary)] shrink-0" />
                  )}
                </button>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * WorkspaceInfoCard — shows current workspace details for the settings page.
 */
export function WorkspaceInfoCard() {
  const [data, setData] = useState<WorkspacesResponse | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch('/api/workspaces')
      .then((r) => r.json())
      .then((d) => setData(d))
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  if (loading) {
    return (
      <div className="flex items-center gap-2 py-4">
        <RefreshCw size={14} className="animate-spin text-[var(--text-muted)]" />
        <span className="text-[var(--text-xs)] text-[var(--text-muted)]">Loading workspace info...</span>
      </div>
    );
  }

  const ws = data?.current;
  if (!ws) return null;

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 gap-3">
        <div>
          <p className="text-[var(--text-xs)] text-[var(--text-tertiary)]">Workspace Name</p>
          <p className="text-[var(--text-sm)] text-[var(--text-primary)] font-medium">{ws.name}</p>
        </div>
        <div>
          <p className="text-[var(--text-xs)] text-[var(--text-tertiary)]">Workspace ID</p>
          <p className="text-[var(--text-xs)] text-[var(--text-secondary)] font-mono">{ws.id}</p>
        </div>
        {ws.owner && (
          <div>
            <p className="text-[var(--text-xs)] text-[var(--text-tertiary)]">Owner</p>
            <p className="text-[var(--text-sm)] text-[var(--text-secondary)]">{ws.owner}</p>
          </div>
        )}
        {ws.createdAt && ws.createdAt > 0 && (
          <div>
            <p className="text-[var(--text-xs)] text-[var(--text-tertiary)]">Created</p>
            <p className="text-[var(--text-sm)] text-[var(--text-secondary)]">
              {new Date(ws.createdAt).toLocaleDateString()}
            </p>
          </div>
        )}
      </div>

      {data?.multiWorkspace && (
        <div className="pt-2">
          <p className="text-[var(--text-xs)] text-[var(--text-tertiary)] mb-2">Switch Workspace</p>
          <WorkspaceSwitcher variant="full" />
        </div>
      )}
    </div>
  );
}
