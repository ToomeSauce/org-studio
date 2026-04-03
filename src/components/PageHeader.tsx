'use client';

import { ReactNode } from 'react';

interface PageHeaderProps {
  title: string;
  description?: string;
  actions?: ReactNode;
}

export function PageHeader({ title, description, actions }: PageHeaderProps) {
  return (
    <div className="flex items-end justify-between gap-4 pb-3">
      <div>
        <h1 className="text-[var(--text-2xl)] font-bold tracking-tight leading-tight text-[var(--text-primary)]">
          {title}
        </h1>
        {description && (
          <p className="text-[var(--text-base)] text-[var(--text-tertiary)] mt-1.5">{description}</p>
        )}
      </div>
      {actions && <div className="flex items-center gap-3 shrink-0">{actions}</div>}
    </div>
  );
}
