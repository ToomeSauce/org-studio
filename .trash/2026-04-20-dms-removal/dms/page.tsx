'use client';

import { MessageCircle } from 'lucide-react';
import { DmSidebar } from '@/components/DmSidebar';
import { useWSData } from '@/lib/ws';
import type { Teammate } from '@/lib/teammates';

export default function DmsPage() {
  const storeData = useWSData<any>('store');
  const teammates: Teammate[] = storeData?.settings?.teammates || [];

  return (
    <div className="flex h-[calc(100vh-4rem)]">
      {/* Sidebar */}
      <div className="w-64 shrink-0 border-r border-[var(--border-default)] overflow-y-auto">
        <div className="px-3 py-3 border-b border-[var(--border-default)]">
          <h2 className="text-[var(--text-sm)] font-bold text-[var(--text-primary)]">Messages</h2>
        </div>
        <DmSidebar teammates={teammates} />
      </div>

      {/* Empty state — no thread selected */}
      <div className="flex-1 flex items-center justify-center">
        <div className="text-center">
          <MessageCircle size={32} className="mx-auto text-[var(--text-muted)] mb-3 opacity-40" />
          <p className="text-[var(--text-base)] font-medium text-[var(--text-secondary)]">
            Select a conversation
          </p>
          <p className="text-[var(--text-sm)] text-[var(--text-muted)] mt-1">
            Or click Message on a teammate to start one.
          </p>
        </div>
      </div>
    </div>
  );
}
