'use client';

import { MessageCircle } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { computeDmThreadId, CURRENT_USER_ID } from '@/lib/dm';

interface NewDmButtonProps {
  participantId: string;
  participantName: string;
}

/**
 * Small button for teammate cards — navigates to DM thread with the given participant.
 * Computes a deterministic thread ID from CURRENT_USER_ID + participantId.
 */
export function NewDmButton({ participantId, participantName }: NewDmButtonProps) {
  const router = useRouter();

  const handleClick = (e: React.MouseEvent) => {
    e.stopPropagation(); // Don't trigger parent onClick (TeammateDetailPanel open)
    const threadId = computeDmThreadId([CURRENT_USER_ID, participantId]);
    router.push(`/dms/${encodeURIComponent(threadId)}`);
  };

  return (
    <button
      onClick={handleClick}
      className="flex items-center gap-1.5 px-2 py-1 rounded-[var(--radius-sm)] text-[var(--text-xs)] font-medium text-[var(--text-muted)] hover:text-[var(--accent-primary)] hover:bg-[var(--accent-primary)]/10 transition-colors"
      title={`Message ${participantName}`}
    >
      <MessageCircle size={12} />
      <span>Message</span>
    </button>
  );
}
