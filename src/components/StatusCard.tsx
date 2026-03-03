'use client';

import { clsx } from 'clsx';
import type { LucideIcon } from 'lucide-react';

interface StatusCardProps {
  title: string;
  value: string | number;
  subtitle?: string;
  icon: LucideIcon;
  color?: 'default' | 'success' | 'warning' | 'error' | 'accent';
  stagger?: number;
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
  success: 'bg-[rgba(34,197,94,0.1)]',
  warning: 'bg-[rgba(245,158,11,0.1)]',
  error: 'bg-[rgba(239,68,68,0.1)]',
  accent: 'bg-[rgba(255,92,92,0.1)]',
};

const glowMap = {
  default: '',
  success: 'hover:shadow-[0_0_20px_rgba(34,197,94,0.15)]',
  warning: 'hover:shadow-[0_0_20px_rgba(245,158,11,0.15)]',
  error: 'hover:shadow-[0_0_20px_rgba(239,68,68,0.15)]',
  accent: 'hover:shadow-[0_0_20px_var(--accent-glow)]',
};

export function StatusCard({ title, value, subtitle, icon: Icon, color = 'default', stagger = 0 }: StatusCardProps) {
  return (
    <div className={clsx(
      'animate-rise bg-[var(--card)] border border-[var(--border-default)] rounded-[var(--radius-lg)] p-5',
      'hover:border-[var(--border-strong)] transition-all duration-200',
      'shadow-[var(--shadow-sm),inset_0_1px_0_var(--card-highlight)]',
      glowMap[color],
      stagger > 0 && `stagger-${stagger}`,
    )}>
      <div className="flex items-start justify-between">
        <div className="space-y-1.5">
          <p className="text-[11px] font-medium text-[var(--text-tertiary)] uppercase tracking-[0.04em]">{title}</p>
          <p className={clsx('text-2xl font-bold tracking-tight leading-none', colorMap[color])}>{value}</p>
          {subtitle && (
            <p className="text-xs text-[var(--text-tertiary)]">{subtitle}</p>
          )}
        </div>
        <div className={clsx('p-2.5 rounded-[var(--radius-md)]', iconBgMap[color])}>
          <Icon size={18} className={colorMap[color]} />
        </div>
      </div>
    </div>
  );
}
