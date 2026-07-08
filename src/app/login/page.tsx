'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Moon, Sun, SunMedium } from 'lucide-react';
import { useTheme, type Theme } from '@/components/ThemeProvider';

type WorkspaceOption = { id: string; name: string; role?: string };

// Icon + label per theme, used by the cycle toggle. Order matches THEME_ORDER
// (solarized → light → dark) so the login toggle behaves identically to the
// in-app TopBar toggle.
const THEME_META: Record<Theme, { icon: typeof Sun; label: string }> = {
  solarized: { icon: SunMedium, label: 'Solarized 2.0 theme' },
  light: { icon: Sun, label: 'Light theme' },
  dark: { icon: Moon, label: 'Dark theme' },
};

export default function LoginPage() {
  const router = useRouter();
  // Single source of truth for theming — the same provider the rest of the app
  // uses. Defaults to Solarized and persists to localStorage['mc-theme'], so
  // the login page is no longer a hardcoded dark island with its own 'theme'
  // key. All colors below come from the CSS variables that html.solarized /
  // html.light / html.dark define in globals.css.
  const { theme, toggle } = useTheme();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  // #1387 A.4 — workspace selector state (only shown for multi-ws users)
  const [requiresWorkspaceSelection, setRequiresWorkspaceSelection] = useState(false);
  const [workspaces, setWorkspaces] = useState<WorkspaceOption[]>([]);
  const [selectedWorkspace, setSelectedWorkspace] = useState<string>('');

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setLoading(true);

    try {
      // #1387 A.4 — two-step flow.
      // Step 1 = credentials only. If the server replies with
      // `requiresWorkspaceSelection`, switch UI into selector mode.
      // Step 2 = credentials + workspaceId (sent below in handleWorkspaceSubmit).
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password }),
      });
      const data = await res.json().catch(() => ({}));

      if (!res.ok) {
        setError(data.error || 'Login failed');
        return;
      }

      if (data.requiresWorkspaceSelection) {
        // Multi-workspace user: stay on this page, render selector.
        setWorkspaces(data.workspaces || []);
        setSelectedWorkspace((data.workspaces && data.workspaces[0]?.id) || '');
        setRequiresWorkspaceSelection(true);
        return;
      }

      // Single-workspace path: session is set, go home.
      router.push('/');
    } catch (e: any) {
      setError('Network error: ' + e.message);
    } finally {
      setLoading(false);
    }
  };

  const handleWorkspaceSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedWorkspace) {
      setError('Please pick a workspace');
      return;
    }
    setError('');
    setLoading(true);
    try {
      // Re-submit credentials with the chosen workspaceId.
      // The server re-validates the password (defense in depth) and
      // verifies workspace membership before creating the session.
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password, workspaceId: selectedWorkspace }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(data.error || 'Workspace selection failed');
        return;
      }
      router.push('/');
    } catch (e: any) {
      setError('Network error: ' + e.message);
    } finally {
      setLoading(false);
    }
  };

  const handleBackToCredentials = () => {
    setRequiresWorkspaceSelection(false);
    setWorkspaces([]);
    setSelectedWorkspace('');
    setError('');
  };

  const ThemeIcon = THEME_META[theme].icon;

  // Shared input styling — token-driven so it tracks whatever theme is active.
  const inputClass =
    'w-full px-4 py-2 rounded-lg outline-none ring-0 focus:ring-2 focus:border-transparent ' +
    'disabled:opacity-50 transition-all duration-200 bg-[var(--bg-tertiary)] ' +
    'border border-[var(--border-default)] text-[var(--text-primary)] ' +
    'placeholder-[var(--text-muted)] focus:ring-[var(--accent-primary)]';

  return (
    <div className="min-h-screen bg-[var(--bg-primary)] flex flex-col items-center justify-center p-4 transition-colors duration-300">
      {/* Theme cycle toggle — mirrors the in-app TopBar (solarized → light → dark) */}
      <button
        onClick={toggle}
        className="absolute top-6 right-6 p-2 rounded-lg transition-colors bg-[var(--bg-secondary)] hover:bg-[var(--bg-hover)] text-[var(--accent-primary)] border border-[var(--border-default)]"
        aria-label={`Switch theme (current: ${THEME_META[theme].label})`}
        title={THEME_META[theme].label}
      >
        <ThemeIcon size={20} />
      </button>

      <div className="w-full max-w-md">
        {/* Logo and title with animation */}
        <div className="text-center mb-8 animate-fade-in">
          <h1 className="text-4xl font-bold text-[var(--text-primary)] mb-2 transition-colors duration-300">
            Org Studio
          </h1>
        </div>

        {/* Login card with animation */}
        <div
          className="bg-[var(--bg-secondary)] border border-[var(--border-default)] rounded-lg shadow-[var(--shadow-lg)] p-8 transition-colors duration-300 animate-fade-in"
          style={{ animationDelay: '0.1s' }}
        >
          {!requiresWorkspaceSelection ? (
          <form onSubmit={handleLogin} className="space-y-6">
            {/* Username */}
            <div>
              <label htmlFor="username" className="block text-sm font-medium text-[var(--text-secondary)] mb-2 transition-colors duration-300">
                Username
              </label>
              <input
                id="username"
                type="text"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                placeholder="your username"
                disabled={loading}
                className={inputClass}
                required
                autoFocus
              />
            </div>

            {/* Password */}
            <div>
              <label htmlFor="password" className="block text-sm font-medium text-[var(--text-secondary)] mb-2 transition-colors duration-300">
                Password
              </label>
              <input
                id="password"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="••••••••"
                disabled={loading}
                className={inputClass}
                required
              />
            </div>

            {/* Error message with animation */}
            {error && (
              <div className="bg-[var(--error-subtle)] border border-[var(--error)] text-[var(--error)] border rounded-lg p-3 text-sm animate-fade-in transition-colors duration-300">
                {error}
              </div>
            )}

            {/* Submit button */}
            <button
              type="submit"
              disabled={loading}
              className="w-full bg-[var(--accent-primary)] hover:bg-[var(--accent-hover)] text-[var(--accent-contrast)] font-semibold py-2 px-4 rounded-lg transition-all duration-200 disabled:opacity-50 focus:outline-none focus:ring-2 focus:ring-[var(--accent-primary)] focus:ring-offset-2 focus:ring-offset-[var(--bg-secondary)] transform hover:scale-[1.02] active:scale-[0.98]"
            >
              {loading ? (
                <span className="flex items-center justify-center">
                  <svg className="animate-spin -ml-1 mr-2 h-4 w-4" style={{ color: 'var(--accent-contrast)' }} xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
                  </svg>
                  Logging in...
                </span>
              ) : (
                'Sign In'
              )}
            </button>
          </form>
          ) : (
            // #1387 A.4 — workspace selector step (requiresWorkspaceSelection)
            <form onSubmit={handleWorkspaceSubmit} className="space-y-6">
              <div>
                <h2 className="text-lg font-semibold text-[var(--text-primary)] mb-1">Choose a workspace</h2>
                <p className="text-sm text-[var(--text-secondary)]">
                  Signed in as <span className="font-medium">{username}</span>.
                  Pick which workspace you want to enter.
                </p>
              </div>

              <div className="space-y-2" role="radiogroup" aria-label="Workspace">
                {workspaces.map((ws) => {
                  const checked = selectedWorkspace === ws.id;
                  return (
                    <label
                      key={ws.id}
                      className={`flex items-center justify-between gap-3 px-4 py-3 rounded-lg border cursor-pointer transition-colors ${
                        checked
                          ? 'bg-[var(--accent-muted)] border-[var(--accent-primary)]'
                          : 'bg-[var(--bg-tertiary)] border-[var(--border-default)] hover:bg-[var(--bg-hover)]'
                      }`}
                    >
                      <div className="flex items-center gap-3">
                        <input
                          type="radio"
                          name="workspace"
                          value={ws.id}
                          checked={checked}
                          onChange={() => setSelectedWorkspace(ws.id)}
                          style={{ accentColor: 'var(--accent-primary)' }}
                        />
                        <div>
                          <div className="text-sm font-medium text-[var(--text-primary)]">{ws.name}</div>
                          <div className="text-xs text-[var(--text-secondary)]">{ws.id}</div>
                        </div>
                      </div>
                      {ws.role && (
                        <span className="text-xs px-2 py-0.5 rounded bg-[var(--bg-active)] text-[var(--text-secondary)]">
                          {ws.role}
                        </span>
                      )}
                    </label>
                  );
                })}
              </div>

              {error && (
                <div className="bg-[var(--error-subtle)] border border-[var(--error)] text-[var(--error)] border rounded-lg p-3 text-sm animate-fade-in transition-colors duration-300">
                  {error}
                </div>
              )}

              <div className="flex items-center gap-3">
                <button
                  type="button"
                  onClick={handleBackToCredentials}
                  disabled={loading}
                  className="px-4 py-2 rounded-lg text-sm font-medium transition-colors bg-[var(--bg-tertiary)] hover:bg-[var(--bg-hover)] text-[var(--text-primary)] border border-[var(--border-default)] disabled:opacity-50"
                >
                  Back
                </button>
                <button
                  type="submit"
                  disabled={loading || !selectedWorkspace}
                  className="flex-1 bg-[var(--accent-primary)] hover:bg-[var(--accent-hover)] text-[var(--accent-contrast)] font-semibold py-2 px-4 rounded-lg transition-all duration-200 disabled:opacity-50 focus:outline-none focus:ring-2 focus:ring-[var(--accent-primary)] focus:ring-offset-2 focus:ring-offset-[var(--bg-secondary)]"
                >
                  {loading ? 'Entering…' : 'Continue'}
                </button>
              </div>
            </form>
          )}

          {/* Info text */}
          <div className="mt-6 pt-6 border-t border-[var(--border-default)] transition-colors duration-300">
            <p className="text-xs text-[var(--text-muted)] text-center transition-colors duration-300">
              Remote access requires authentication. Contact your administrator for credentials.
            </p>
          </div>
        </div>

        {/* Footer */}
        <p className="text-center text-[var(--text-muted)] text-xs mt-8 transition-colors duration-300">
          © 2026 Org Studio. All rights reserved.
        </p>
      </div>

      <style>{`
        @keyframes fade-in {
          from {
            opacity: 0;
            transform: translateY(10px);
          }
          to {
            opacity: 1;
            transform: translateY(0);
          }
        }
        .animate-fade-in {
          animation: fade-in 0.3s ease-out forwards;
          opacity: 0;
        }
      `}</style>
    </div>
  );
}
