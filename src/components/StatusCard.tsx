'use client';

import { clsx } from 'clsx';
import type { LucideIcon } from 'lucide-react';

interface StatusCardProps {
  title: string;
  value: string | number;
  subtitle?: string;
  icon: LucideIcon;
  trend?: 'up' | 'down' | 'neutral';
  color?: 'default' | 'success' | 'warning' | 'error' | 'accent';
}

const colorMap = {
  default: 'text-[var(--text-primary)]',
  success: 'text-[var(--success)]',
  warning: 'text-[var(--warning)]',
  error: 'text-[var(--error)]',
  accent: 'text-[var(--accent-primary)]',
};

const iconBgMap = {
  default: 'bg-[var(--bg-tertiary)]',
  success: 'bg-green-500/10',
  warning: 'bg-yellow-500/10',
  error: 'bg-red-500/10',
  accent: 'bg-violet-500/10',
};

export function StatusCard({ title, value, subtitle, icon: Icon, color = 'default' }: StatusCardProps) {
  return (
    <div className="bg-[var(--bg-secondary)] border border-[var(--border-default)] rounded-lg p-4 hover:border-[var(--border-strong)] transition-colors">
      <div className="flex items-start justify-between">
        <div className="space-y-1">
          <p className="text-xs text-[var(--text-tertiary)] uppercase tracking-wide">{title}</p>
          <p className={clsx('text-2xl font-semibold', colorMap[color])}>{value}</p>
          {subtitle && (
            <p className="text-xs text-[var(--text-tertiary)]">{subtitle}</p>
          )}
        </div>
        <div className={clsx('p-2 rounded-lg', iconBgMap[color])}>
          <Icon size={18} className={colorMap[color]} />
        </div>
      </div>
    </div>
  );
}
