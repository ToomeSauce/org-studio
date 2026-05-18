'use client';

/**
 * #1386 Phase 2 — API tokens management UI for the Team page.
 *
 * Per-teammate collapsible panel for admins to:
 *   - Mint a new token (label + scope), with the plaintext shown ONCE in a
 *     modal that requires explicit copy-to-clipboard before close.
 *   - List active tokens (label, scope, created, last_used).
 *   - Revoke a token (soft delete via DELETE /api/admin/tokens/{id}).
 *
 * Calls /api/admin/* with the session cookie (no Bearer needed). The
 * endpoints themselves enforce admin-only via ORG_STUDIO_API_KEY OR
 * authenticated admin session — we just don't render the UI when the API
 * returns 401/403.
 */

import { useState, useEffect, useCallback } from 'react';
import { clsx } from 'clsx';
import { AlertCircle, Copy, Check, Trash2, Plus, KeyRound, X } from 'lucide-react';

interface ApiTokenRecord {
  id: string;
  label: string;
  scope: 'read' | 'write';
  created_at: string;
  created_by: string | null;
  last_used_at: string | null;
  revoked_at: string | null;
}

interface ApiTokensSectionProps {
  /** User id to scope the listing & mint operations to. */
  userId: string;
  /** Human-readable name (e.g. teammate name) for the section header. */
  displayName: string;
}

function fmtDate(s: string | null): string {
  if (!s) return '—';
  try {
    const d = new Date(s);
    return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
  } catch {
    return s;
  }
}

function timeAgo(s: string | null): string {
  if (!s) return 'never';
  const d = new Date(s).getTime();
  if (Number.isNaN(d)) return s;
  const diff = Date.now() - d;
  const min = Math.floor(diff / 60_000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  if (day < 30) return `${day}d ago`;
  return fmtDate(s);
}

export default function ApiTokensSection({ userId, displayName }: ApiTokensSectionProps) {
  const [open, setOpen] = useState(false);
  const [tokens, setTokens] = useState<ApiTokenRecord[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [denied, setDenied] = useState(false); // 401/403 → hide section entirely

  // Mint modal state
  const [showMint, setShowMint] = useState(false);
  const [mintLabel, setMintLabel] = useState('');
  const [mintScope, setMintScope] = useState<'read' | 'write'>('write');
  const [minting, setMinting] = useState(false);
  const [mintedToken, setMintedToken] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const fetchTokens = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(
        `/api/admin/tokens?userId=${encodeURIComponent(userId)}&includeRevoked=false`,
        { credentials: 'include' },
      );
      if (res.status === 401 || res.status === 403) {
        setDenied(true);
        setTokens([]);
        return;
      }
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.message || body.error || `HTTP ${res.status}`);
      }
      const data = await res.json();
      setTokens(Array.isArray(data.tokens) ? data.tokens : Array.isArray(data) ? data : []);
    } catch (e: any) {
      setError(e?.message || 'Failed to load tokens');
    } finally {
      setLoading(false);
    }
  }, [userId]);

  useEffect(() => {
    if (open && tokens === null && !denied) {
      void fetchTokens();
    }
  }, [open, tokens, denied, fetchTokens]);

  async function mint() {
    if (!mintLabel.trim()) return;
    setMinting(true);
    setError(null);
    try {
      const res = await fetch('/api/admin/tokens', {
        method: 'POST',
        credentials: 'include',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ userId, label: mintLabel.trim(), scope: mintScope }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(body.message || body.error || `HTTP ${res.status}`);
      }
      const plaintext = body.token || body.plaintext || body.apiToken;
      if (!plaintext) {
        throw new Error('Mint succeeded but no plaintext token in response');
      }
      setMintedToken(plaintext);
      setCopied(false);
      // Refresh list in the background.
      void fetchTokens();
    } catch (e: any) {
      setError(e?.message || 'Mint failed');
    } finally {
      setMinting(false);
    }
  }

  async function revoke(tokenId: string, label: string) {
    if (!confirm(`Revoke token "${label}"? This cannot be undone.`)) return;
    try {
      const res = await fetch(`/api/admin/tokens/${encodeURIComponent(tokenId)}`, {
        method: 'DELETE',
        credentials: 'include',
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.message || body.error || `HTTP ${res.status}`);
      }
      await fetchTokens();
    } catch (e: any) {
      setError(e?.message || 'Revoke failed');
    }
  }

  async function copyToClipboard(text: string) {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
    } catch {
      // Fallback: prompt user to copy manually.
      window.prompt('Copy this token (Cmd/Ctrl+C):', text);
      setCopied(true);
    }
  }

  function closeMintModal() {
    if (mintedToken && !copied) return; // gate close until copied
    setShowMint(false);
    setMintedToken(null);
    setMintLabel('');
    setMintScope('write');
    setCopied(false);
  }

  if (denied) {
    // Admin-only — silently hide for non-admins.
    return null;
  }

  return (
    <div className="border-t border-[var(--border-subtle)] pt-3 mt-3">
      <button
        onClick={() => setOpen((o) => !o)}
        className="w-full flex items-center justify-between text-left group"
      >
        <span className="flex items-center gap-2 text-[var(--text-sm)] font-medium text-[var(--text-primary)]">
          <KeyRound size={14} className="text-[var(--text-muted)]" />
          API tokens
          {tokens && tokens.length > 0 && (
            <span className="text-[var(--text-xs)] text-[var(--text-muted)]">({tokens.length})</span>
          )}
        </span>
        <span className="text-[var(--text-xs)] text-[var(--text-muted)] group-hover:text-[var(--text-secondary)]">
          {open ? '−' : '+'}
        </span>
      </button>

      {open && (
        <div className="mt-3 space-y-3">
          {error && (
            <div className="flex items-start gap-2 text-[var(--text-xs)] text-red-400 bg-red-500/10 border border-red-500/20 rounded px-2 py-1.5">
              <AlertCircle size={12} className="mt-0.5 shrink-0" />
              <span>{error}</span>
            </div>
          )}

          {loading && (
            <p className="text-[var(--text-xs)] text-[var(--text-muted)] italic">Loading…</p>
          )}

          {!loading && tokens && tokens.length === 0 && (
            <p className="text-[var(--text-xs)] text-[var(--text-muted)] italic">
              No active tokens for {displayName}.
            </p>
          )}

          {!loading && tokens && tokens.length > 0 && (
            <div className="space-y-1.5">
              {tokens.map((t) => (
                <div
                  key={t.id}
                  className="flex items-center justify-between gap-2 px-2 py-1.5 rounded bg-[var(--bg-elevated)] border border-[var(--border-subtle)]"
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="text-[var(--text-xs)] font-medium text-[var(--text-primary)] truncate">
                        {t.label}
                      </span>
                      <span
                        className={clsx(
                          'text-[10px] px-1.5 py-0.5 rounded uppercase tracking-wide font-mono',
                          t.scope === 'write'
                            ? 'bg-amber-500/15 text-amber-400'
                            : 'bg-blue-500/15 text-blue-400',
                        )}
                      >
                        {t.scope}
                      </span>
                    </div>
                    <p className="text-[10px] text-[var(--text-muted)] mt-0.5">
                      Created {fmtDate(t.created_at)} · Last used {timeAgo(t.last_used_at)}
                    </p>
                  </div>
                  <button
                    onClick={() => revoke(t.id, t.label)}
                    className="text-[var(--text-muted)] hover:text-red-400 shrink-0 p-1 rounded hover:bg-red-500/10"
                    title="Revoke token"
                  >
                    <Trash2 size={12} />
                  </button>
                </div>
              ))}
            </div>
          )}

          <button
            onClick={() => setShowMint(true)}
            className="w-full flex items-center justify-center gap-1.5 px-3 py-1.5 text-[var(--text-xs)] font-medium text-[var(--text-secondary)] bg-[var(--bg-elevated)] border border-[var(--border-subtle)] rounded hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)] transition-colors"
          >
            <Plus size={12} />
            Mint new token
          </button>
        </div>
      )}

      {/* Mint modal */}
      {showMint && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4">
          <div className="bg-[var(--bg-base)] border border-[var(--border-default)] rounded-lg shadow-xl max-w-md w-full p-5">
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-[var(--text-base)] font-semibold text-[var(--text-primary)]">
                {mintedToken ? 'Token created' : `Mint token for ${displayName}`}
              </h3>
              <button
                onClick={closeMintModal}
                disabled={!!(mintedToken && !copied)}
                className={clsx(
                  'text-[var(--text-muted)] hover:text-[var(--text-primary)]',
                  mintedToken && !copied && 'opacity-30 cursor-not-allowed',
                )}
                title={mintedToken && !copied ? 'Copy the token first' : 'Close'}
              >
                <X size={16} />
              </button>
            </div>

            {!mintedToken && (
              <div className="space-y-3">
                <div>
                  <label className="block text-[var(--text-xs)] font-medium text-[var(--text-secondary)] mb-1">
                    Label
                  </label>
                  <input
                    type="text"
                    value={mintLabel}
                    onChange={(e) => setMintLabel(e.target.value)}
                    placeholder="e.g. mikey local laptop"
                    className="w-full px-2.5 py-1.5 text-[var(--text-sm)] bg-[var(--bg-elevated)] border border-[var(--border-subtle)] rounded text-[var(--text-primary)] focus:outline-none focus:border-[var(--border-strong)]"
                  />
                </div>
                <div>
                  <label className="block text-[var(--text-xs)] font-medium text-[var(--text-secondary)] mb-1">
                    Scope
                  </label>
                  <div className="flex gap-2">
                    {(['read', 'write'] as const).map((s) => (
                      <button
                        key={s}
                        onClick={() => setMintScope(s)}
                        className={clsx(
                          'flex-1 px-3 py-1.5 text-[var(--text-xs)] font-medium rounded border transition-colors',
                          mintScope === s
                            ? 'bg-[var(--accent)] border-[var(--accent)] text-white'
                            : 'bg-[var(--bg-elevated)] border-[var(--border-subtle)] text-[var(--text-secondary)] hover:text-[var(--text-primary)]',
                        )}
                      >
                        {s}
                      </button>
                    ))}
                  </div>
                  <p className="text-[10px] text-[var(--text-muted)] mt-1">
                    {mintScope === 'read'
                      ? 'Read-only: cannot mutate state.'
                      : 'Write: can read and mutate state.'}
                  </p>
                </div>
                {error && (
                  <div className="text-[var(--text-xs)] text-red-400 bg-red-500/10 border border-red-500/20 rounded px-2 py-1.5">
                    {error}
                  </div>
                )}
                <div className="flex gap-2 pt-1">
                  <button
                    onClick={closeMintModal}
                    className="flex-1 px-3 py-1.5 text-[var(--text-xs)] font-medium text-[var(--text-secondary)] bg-[var(--bg-elevated)] border border-[var(--border-subtle)] rounded hover:bg-[var(--bg-hover)]"
                  >
                    Cancel
                  </button>
                  <button
                    onClick={mint}
                    disabled={!mintLabel.trim() || minting}
                    className="flex-1 px-3 py-1.5 text-[var(--text-xs)] font-medium text-white bg-[var(--accent)] rounded hover:opacity-90 disabled:opacity-40 disabled:cursor-not-allowed"
                  >
                    {minting ? 'Minting…' : 'Mint token'}
                  </button>
                </div>
              </div>
            )}

            {mintedToken && (
              <div className="space-y-3">
                <div className="flex items-start gap-2 text-[var(--text-xs)] text-amber-400 bg-amber-500/10 border border-amber-500/20 rounded p-2.5">
                  <AlertCircle size={14} className="mt-0.5 shrink-0" />
                  <div>
                    <p className="font-medium mb-0.5">Copy this token now.</p>
                    <p className="text-[var(--text-muted)]">
                      It will NOT be shown again. If you lose it, revoke and mint a new one.
                    </p>
                  </div>
                </div>
                <div className="font-mono text-[10px] text-[var(--text-primary)] bg-[var(--bg-elevated)] border border-[var(--border-subtle)] rounded p-2 break-all select-all">
                  {mintedToken}
                </div>
                <button
                  onClick={() => copyToClipboard(mintedToken)}
                  className={clsx(
                    'w-full flex items-center justify-center gap-1.5 px-3 py-2 text-[var(--text-xs)] font-medium rounded transition-colors',
                    copied
                      ? 'bg-green-500/20 text-green-400 border border-green-500/30'
                      : 'bg-[var(--accent)] text-white hover:opacity-90',
                  )}
                >
                  {copied ? (
                    <>
                      <Check size={12} /> Copied — you may close now
                    </>
                  ) : (
                    <>
                      <Copy size={12} /> Copy to clipboard
                    </>
                  )}
                </button>
                {copied && (
                  <button
                    onClick={closeMintModal}
                    className="w-full px-3 py-1.5 text-[var(--text-xs)] font-medium text-[var(--text-secondary)] bg-[var(--bg-elevated)] border border-[var(--border-subtle)] rounded hover:bg-[var(--bg-hover)]"
                  >
                    Close
                  </button>
                )}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
