'use client';

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { Moon, Sun } from 'lucide-react';

type WorkspaceOption = { id: string; name: string; role?: string };

export default function LoginPage() {
  const router = useRouter();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [isDark, setIsDark] = useState(true);

  // #1387 A.4 — workspace selector state (only shown for multi-ws users)
  const [requiresWorkspaceSelection, setRequiresWorkspaceSelection] = useState(false);
  const [workspaces, setWorkspaces] = useState<WorkspaceOption[]>([]);
  const [selectedWorkspace, setSelectedWorkspace] = useState<string>('');

  // Initialize theme from system preference or localStorage
  useEffect(() => {
    const saved = localStorage.getItem('theme');
    if (saved) {
      setIsDark(saved === 'dark');
    } else {
      // Default to dark
      setIsDark(true);
    }
  }, []);

  // Persist theme preference
  useEffect(() => {
    localStorage.setItem('theme', isDark ? 'dark' : 'light');
  }, [isDark]);

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

  const bgClass = isDark
    ? 'bg-gradient-to-br from-slate-900 to-slate-800'
    : 'bg-gradient-to-br from-slate-50 to-slate-100';
  const cardClass = isDark
    ? 'bg-slate-800 border-slate-700'
    : 'bg-white border-slate-200';
  const textPrimaryClass = isDark ? 'text-white' : 'text-slate-900';
  const textSecondaryClass = isDark ? 'text-slate-300' : 'text-slate-600';
  const inputBgClass = isDark ? 'bg-slate-700 border-slate-600' : 'bg-slate-100 border-slate-300';
  const inputPlaceholderClass = isDark ? 'placeholder-slate-500' : 'placeholder-slate-400';
  const focusClass = isDark ? 'focus:ring-blue-500' : 'focus:ring-blue-600';
  const buttonClass = isDark
    ? 'bg-blue-600 hover:bg-blue-700 disabled:bg-blue-800'
    : 'bg-blue-600 hover:bg-blue-700 disabled:bg-blue-800';
  const dividerClass = isDark ? 'border-slate-700' : 'border-slate-200';

  return (
    <div className={`min-h-screen ${bgClass} flex flex-col items-center justify-center p-4 transition-colors duration-300`}>
      {/* Theme Toggle Button */}
      <button
        onClick={() => setIsDark(!isDark)}
        className={`absolute top-6 right-6 p-2 rounded-lg transition-colors ${
          isDark
            ? 'bg-slate-800 hover:bg-slate-700 text-yellow-400'
            : 'bg-slate-200 hover:bg-slate-300 text-slate-800'
        }`}
        aria-label="Toggle dark mode"
      >
        {isDark ? (
          <Sun size={20} />
        ) : (
          <Moon size={20} />
        )}
      </button>

      <div className="w-full max-w-md">
        {/* Logo and title with animation */}
        <div className="text-center mb-8 animate-fade-in">
          <h1 className={`text-4xl font-bold ${textPrimaryClass} mb-2 transition-colors duration-300`}>
            Org Studio
          </h1>
        </div>

        {/* Login card with animation */}
        <div
          className={`${cardClass} rounded-lg shadow-xl p-8 transition-colors duration-300 border animate-fade-in`}
          style={{ animationDelay: '0.1s' }}
        >
          {!requiresWorkspaceSelection ? (
          <form onSubmit={handleLogin} className="space-y-6">
            {/* Username */}
            <div>
              <label htmlFor="username" className={`block text-sm font-medium ${textSecondaryClass} mb-2 transition-colors duration-300`}>
                Username
              </label>
              <input
                id="username"
                type="text"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                placeholder="your username"
                disabled={loading}
                className={`w-full px-4 py-2 ${inputBgClass} rounded-lg ${textPrimaryClass} ${inputPlaceholderClass} outline-none ring-0 ${focusClass} focus:ring-2 focus:border-transparent disabled:opacity-50 transition-all duration-200 ${!isDark ? 'text-slate-900' : ''}`}
                required
                autoFocus
              />
            </div>

            {/* Password */}
            <div>
              <label htmlFor="password" className={`block text-sm font-medium ${textSecondaryClass} mb-2 transition-colors duration-300`}>
                Password
              </label>
              <input
                id="password"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="••••••••"
                disabled={loading}
                className={`w-full px-4 py-2 ${inputBgClass} rounded-lg ${textPrimaryClass} ${inputPlaceholderClass} outline-none ring-0 ${focusClass} focus:ring-2 focus:border-transparent disabled:opacity-50 transition-all duration-200 ${!isDark ? 'text-slate-900' : ''}`}
                required
              />
            </div>

            {/* Error message with animation */}
            {error && (
              <div className={`${isDark ? 'bg-red-900 border-red-700 text-red-100' : 'bg-red-100 border-red-300 text-red-800'} border rounded-lg p-3 text-sm animate-fade-in transition-colors duration-300`}>
                {error}
              </div>
            )}

            {/* Submit button with enhanced styling */}
            <button
              type="submit"
              disabled={loading}
              className={`w-full ${buttonClass} text-white font-semibold py-2 px-4 rounded-lg transition-all duration-200 disabled:opacity-50 focus:outline-none focus:ring-2 focus:ring-offset-2 ${isDark ? 'focus:ring-offset-slate-800' : 'focus:ring-offset-slate-100'} transform hover:scale-[1.02] active:scale-[0.98]`}
            >
              {loading ? (
                <span className="flex items-center justify-center">
                  <svg className="animate-spin -ml-1 mr-2 h-4 w-4 text-white" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
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
                <h2 className={`text-lg font-semibold ${textPrimaryClass} mb-1`}>Choose a workspace</h2>
                <p className={`text-sm ${textSecondaryClass}`}>
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
                          ? isDark
                            ? 'bg-slate-700 border-blue-500'
                            : 'bg-blue-50 border-blue-500'
                          : isDark
                            ? 'bg-slate-700/50 border-slate-600 hover:bg-slate-700'
                            : 'bg-slate-100 border-slate-300 hover:bg-slate-200'
                      }`}
                    >
                      <div className="flex items-center gap-3">
                        <input
                          type="radio"
                          name="workspace"
                          value={ws.id}
                          checked={checked}
                          onChange={() => setSelectedWorkspace(ws.id)}
                          className="accent-blue-600"
                        />
                        <div>
                          <div className={`text-sm font-medium ${textPrimaryClass}`}>{ws.name}</div>
                          <div className={`text-xs ${textSecondaryClass}`}>{ws.id}</div>
                        </div>
                      </div>
                      {ws.role && (
                        <span className={`text-xs px-2 py-0.5 rounded ${isDark ? 'bg-slate-600 text-slate-200' : 'bg-slate-200 text-slate-700'}`}>
                          {ws.role}
                        </span>
                      )}
                    </label>
                  );
                })}
              </div>

              {error && (
                <div className={`${isDark ? 'bg-red-900 border-red-700 text-red-100' : 'bg-red-100 border-red-300 text-red-800'} border rounded-lg p-3 text-sm animate-fade-in transition-colors duration-300`}>
                  {error}
                </div>
              )}

              <div className="flex items-center gap-3">
                <button
                  type="button"
                  onClick={handleBackToCredentials}
                  disabled={loading}
                  className={`px-4 py-2 rounded-lg text-sm font-medium transition-colors ${
                    isDark
                      ? 'bg-slate-700 hover:bg-slate-600 text-slate-100'
                      : 'bg-slate-200 hover:bg-slate-300 text-slate-800'
                  } disabled:opacity-50`}
                >
                  Back
                </button>
                <button
                  type="submit"
                  disabled={loading || !selectedWorkspace}
                  className={`flex-1 ${buttonClass} text-white font-semibold py-2 px-4 rounded-lg transition-all duration-200 disabled:opacity-50 focus:outline-none focus:ring-2 focus:ring-offset-2 ${isDark ? 'focus:ring-offset-slate-800' : 'focus:ring-offset-slate-100'}`}
                >
                  {loading ? 'Entering…' : 'Continue'}
                </button>
              </div>
            </form>
          )}

          {/* Info text */}
          <div className={`mt-6 pt-6 border-t ${dividerClass} transition-colors duration-300`}>
            <p className={`text-xs ${isDark ? 'text-slate-400' : 'text-slate-500'} text-center transition-colors duration-300`}>
              Remote access requires authentication. Contact your administrator for credentials.
            </p>
          </div>
        </div>

        {/* Footer */}
        <p className={`text-center ${isDark ? 'text-slate-400' : 'text-slate-500'} text-xs mt-8 transition-colors duration-300`}>
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

