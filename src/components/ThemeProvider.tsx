'use client';

import { createContext, useContext, useState, useEffect, useCallback } from 'react';

export type Theme = 'dark' | 'light' | 'solarized';

// The three themes cycle in this order via the TopBar toggle.
export const THEME_ORDER: Theme[] = ['solarized', 'light', 'dark'];
const THEMES = new Set<Theme>(THEME_ORDER);
const DEFAULT_THEME: Theme = 'solarized';
const STORAGE_KEY = 'mc-theme';

function isTheme(v: unknown): v is Theme {
  return typeof v === 'string' && THEMES.has(v as Theme);
}

/**
 * Apply a theme by swapping ONLY the theme token class on <html>, preserving
 * every other class (the Geist/Fraunces/JetBrains font-variable classes that
 * src/app/layout.tsx renders on <html>). The previous implementation did
 * `documentElement.className = theme`, which clobbered those font classes and
 * silently broke typography after the first toggle. Token-swap fixes that.
 */
function applyThemeClass(theme: Theme) {
  const el = document.documentElement;
  el.classList.remove(...THEME_ORDER);
  el.classList.add(theme);
}

const ThemeContext = createContext<{
  theme: Theme;
  toggle: () => void;
  setTheme: (t: Theme) => void;
}>({ theme: DEFAULT_THEME, toggle: () => {}, setTheme: () => {} });

export function useTheme() {
  return useContext(ThemeContext);
}

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  // Must match the SSR class on <html> in layout.tsx to avoid a flash.
  const [theme, setThemeState] = useState<Theme>(DEFAULT_THEME);

  useEffect(() => {
    let saved: string | null = null;
    try {
      saved = localStorage.getItem(STORAGE_KEY);
    } catch {
      /* private mode / storage disabled — fall through to default */
    }
    // Only honor a previously-chosen, still-valid theme. Users who never
    // picked one (or have a stale value) get the new default: Solarized.
    if (isTheme(saved)) {
      setThemeState(saved);
      applyThemeClass(saved);
    } else {
      applyThemeClass(DEFAULT_THEME);
    }
  }, []);

  const setTheme = useCallback((next: Theme) => {
    if (!isTheme(next)) return;
    setThemeState(next);
    applyThemeClass(next);
    try {
      localStorage.setItem(STORAGE_KEY, next);
    } catch {
      /* ignore persistence failure */
    }
  }, []);

  const toggle = useCallback(() => {
    setThemeState(prev => {
      const idx = THEME_ORDER.indexOf(prev);
      const next = THEME_ORDER[(idx + 1) % THEME_ORDER.length];
      applyThemeClass(next);
      try {
        localStorage.setItem(STORAGE_KEY, next);
      } catch {
        /* ignore persistence failure */
      }
      return next;
    });
  }, []);

  return (
    <ThemeContext.Provider value={{ theme, toggle, setTheme }}>
      {children}
    </ThemeContext.Provider>
  );
}
