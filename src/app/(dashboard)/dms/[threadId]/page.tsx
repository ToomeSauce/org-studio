'use client';

import { useParams } from 'next/navigation';
import { DmSidebar } from '@/components/DmSidebar';
import { ChatThread } from '@/components/ChatThread';
import { useWSData } from '@/lib/ws';
import { extractParticipants, CURRENT_USER_ID, getOtherParticipant } from '@/lib/dm';
import { buildNameColorMap } from '@/lib/teammates';
import type { Teammate } from '@/lib/teammates';

export default function DmThreadPage() {
  const params = useParams();
  const threadId = decodeURIComponent(params.threadId as string);
  const storeData = useWSData<any>('store');
  const teammates: Teammate[] = storeData?.settings?.teammates || [];
  const nameColors = buildNameColorMap(teammates);

  // Resolve the other participant for display
  let otherName = 'Unknown';
  let otherEmoji = '👤';
  try {
    const otherId = getOtherParticipant(threadId, CURRENT_USER_ID);
    const t = teammates.find(
      (tm) => tm.id === otherId || tm.agentId === otherId || tm.name.toLowerCase() === otherId.toLowerCase()
    );
    if (t) {
      otherName = t.name;
      otherEmoji = t.emoji;
    } else {
      otherName = otherId.charAt(0).toUpperCase() + otherId.slice(1);
    }
  } catch {
    // Invalid thread ID — show fallback
  }

  // Build agents list for ChatThread (used for @mention autocomplete)
  const agents = teammates.map((t) => t.name);

  return (
    <div className="flex h-[calc(100vh-4rem)]">
      {/* Sidebar */}
      <div className="w-64 shrink-0 border-r border-[var(--border-default)] overflow-y-auto">
        <div className="px-3 py-3 border-b border-[var(--border-default)]">
          <h2 className="text-[var(--text-sm)] font-bold text-[var(--text-primary)]">Messages</h2>
        </div>
        <DmSidebar teammates={teammates} activeThreadId={threadId} />
      </div>

      {/* Chat thread */}
      <div className="flex-1 flex flex-col min-w-0">
        {/* Header */}
        <div className="flex items-center gap-2.5 px-4 py-3 border-b border-[var(--border-default)] shrink-0">
          <span className="text-lg">{otherEmoji}</span>
          <h3 className="text-[var(--text-base)] font-bold text-[var(--text-primary)]">
            {otherName}
          </h3>
        </div>

        {/* ChatThread */}
        <div className="flex-1 px-4 py-3 overflow-hidden">
          <ChatThread
            key={threadId}
            scope={{ kind: 'dm', dmThreadId: threadId }}
            project={null}
            agents={agents}
            nameColors={nameColors}
            currentAuthor="You"
          />
        </div>
      </div>
    </div>
  );
}
