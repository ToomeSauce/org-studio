'use client';

/**
 * /vision-inbox — Vision Inbox (P0, WIRED to live data)
 *
 * One aggregated comment feed per vision (project): every comment across all of
 * the vision's tickets, newest-first, each item tagged with its ticket so a
 * reply routes back to the owning thread.
 *
 * P0 scope: read-only feed (live) + ticket filter + reply-routing (live).
 * The Telegram mirror was cut (Basil: Org Studio inbox is home for Org Studio
 * work; Telegram is for unrelated comms). Vision-notes lane / roles /
 * version-kind are P1.
 *
 * Data:
 *   GET  /api/vision/:id/inbox            → feed
 *   POST /api/vision/:id/inbox {taskId,content} → reply (routes to ticket)
 *
 * Pick the vision with ?vision=<projectId> (defaults to proj-org-studio).
 */

import { useCallback, useEffect, useState } from 'react';

type FeedItem = {
  commentId: string;
  taskId: string;
  ticketNumber: number | string | null;
  ticketTitle: string | null;
  ticketStatus: string | null;
  author: string;
  content: string;
  createdAt: number;
  type: 'comment' | 'system' | 'stop' | 'resume';
  model?: string;
  mentions: string[];
};

type TicketSummary = {
  taskId: string;
  ticketNumber: number | string | null;
  title: string | null;
  status: string | null;
  commentCount: number;
};

type InboxResponse = {
  visionId: string;
  visionName: string | null;
  owner: string | null;
  components: string[];
  ticketCount: number;
  totalTickets: number;
  items: FeedItem[];
  tickets: TicketSummary[];
};

const AGENT_COLOR: Record<string, string> = {
  Ana: '#34d399', Mikey: '#f59e0b', Henry: '#22d3ee', Sam: '#a78bfa',
  Basil: '#fbbf24', Billy: '#f472b6', Kate: '#60a5fa', system: '#64748b',
};
function colorFor(name: string) {
  return AGENT_COLOR[name] || '#94a3b8';
}
function fmtTime(ts: number) {
  if (!ts) return '';
  const d = new Date(ts);
  return d.toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

export default function VisionInbox() {
  const [visionId, setVisionId] = useState('proj-org-studio');
  const [data, setData] = useState<InboxResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<'all' | string>('all'); // 'all' or a taskId
  const [includeSystem, setIncludeSystem] = useState(true);
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);

  useEffect(() => {
    const q = new URLSearchParams(window.location.search).get('vision');
    if (q) setVisionId(q);
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/vision/${visionId}/inbox?includeSystem=${includeSystem}`, { cache: 'no-store' });
      if (!res.ok) {
        const e = await res.json().catch(() => ({}));
        throw new Error(e.error || `HTTP ${res.status}`);
      }
      setData(await res.json());
    } catch (e: any) {
      setError(e.message || 'failed to load');
      setData(null);
    } finally {
      setLoading(false);
    }
  }, [visionId, includeSystem]);

  useEffect(() => { load(); }, [load]);

  const feed = (data?.items || []).filter((m) => filter === 'all' || m.taskId === filter);
  const activeTicket = filter !== 'all' ? data?.tickets.find((t) => t.taskId === filter) : null;

  async function sendReply() {
    if (filter === 'all' || !draft.trim()) return;
    setSending(true);
    try {
      const res = await fetch(`/api/vision/${visionId}/inbox`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ taskId: filter, content: draft.trim() }),
      });
      if (!res.ok) {
        const e = await res.json().catch(() => ({}));
        throw new Error(e.error || `HTTP ${res.status}`);
      }
      setDraft('');
      await load();
    } catch (e: any) {
      setError(e.message || 'reply failed');
    } finally {
      setSending(false);
    }
  }

  return (
    <div style={S.page}>
      {/* LEFT RAIL */}
      <aside style={S.rail}>
        <div style={S.eyebrow}>VISION INBOX · P0</div>
        <h1 style={S.visionName}>{data?.visionName || visionId}</h1>
        {data?.owner && (
          <div style={S.ownerRow}>
            <span style={{ ...S.dot, background: colorFor(data.owner) }} />
            owner <b>{data.owner}</b>
          </div>
        )}
        {!!data?.components?.length && (
          <div style={S.compRow}>
            {data.components.map((c) => <span key={c} style={S.compChip}>{c}</span>)}
          </div>
        )}

        <div style={S.filterLabel}>FILTER</div>
        <button style={chip(filter === 'all')} onClick={() => setFilter('all')}>
          All activity {data ? `· ${data.items.length}` : ''}
        </button>

        <div style={S.ticketHdr}>BY TICKET {data ? `· ${data.ticketCount}` : ''}</div>
        <div style={S.ticketScroll}>
          {(data?.tickets || []).map((t) => (
            <button key={t.taskId} style={chip(filter === t.taskId)} onClick={() => setFilter(t.taskId)}>
              {t.ticketNumber != null && <span style={S.ticketNum}>#{t.ticketNumber}</span>}
              {t.title || t.taskId}
              <span style={S.cmtCount}>{t.commentCount}</span>
            </button>
          ))}
        </div>

        <label style={S.toggleRow}>
          <input type="checkbox" checked={includeSystem} onChange={(e) => setIncludeSystem(e.target.checked)} />
          show system comments
        </label>
        <button style={S.refresh} onClick={load}>↻ refresh</button>
      </aside>

      {/* CENTER FEED */}
      <main style={S.main}>
        <div style={S.feedHdr}>
          <div>
            <div style={S.feedTitle}>
              {filter === 'all' ? 'All activity' : activeTicket ? `#${activeTicket.ticketNumber ?? '—'} ${activeTicket.title ?? ''}` : filter}
            </div>
            <div style={S.feedSub}>
              {loading ? 'loading…' : error ? '' : `${feed.length} messages · ${data?.ticketCount ?? 0} tickets · ${data?.totalTickets ?? 0} total`}
            </div>
          </div>
          <div style={S.taxNote}>one feed · no ticket-hopping</div>
        </div>

        <div style={S.feed}>
          {error && <div style={S.error}>⚠ {error}</div>}
          {!error && !loading && feed.length === 0 && <div style={S.empty}>No comments yet in this vision.</div>}
          {feed.map((m) => (
            <div key={m.commentId} style={S.msg}>
              <span style={{ ...S.avatar, background: colorFor(m.author) }}>{(m.author || '?')[0].toUpperCase()}</span>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={S.msgHead}>
                  <b style={{ color: colorFor(m.author) }}>{m.author}</b>
                  {m.type === 'system' && <span style={S.sysTag}>system</span>}
                  <span style={S.ticketTag}>
                    {m.ticketNumber != null ? `#${m.ticketNumber}` : '—'} · {m.ticketTitle || m.taskId}
                  </span>
                  <span style={S.time}>{fmtTime(m.createdAt)}</span>
                </div>
                <div style={S.body}>{m.content}</div>
                <div style={S.actions}>
                  <button style={S.reply} onClick={() => setFilter(m.taskId)}>
                    ↩ open #{m.ticketNumber ?? '—'}
                  </button>
                  {!!m.mentions?.length && <span style={S.mentions}>@ {m.mentions.join(', ')}</span>}
                </div>
              </div>
            </div>
          ))}
        </div>

        {/* REPLY BAR — only active when a ticket is selected (routes there) */}
        <div style={S.replyBar}>
          <input
            style={S.replyInput}
            placeholder={filter === 'all' ? 'Pick a ticket to reply on it…' : `Reply on #${activeTicket?.ticketNumber ?? '—'}…`}
            value={draft}
            disabled={filter === 'all' || sending}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendReply(); } }}
          />
          <button style={{ ...S.send, opacity: filter === 'all' || sending || !draft.trim() ? 0.5 : 1 }}
            disabled={filter === 'all' || sending || !draft.trim()} onClick={sendReply}>
            {sending ? '…' : 'Send →'}
          </button>
        </div>
        <div style={S.footNote}>
          P0 — live. Replies route to the selected ticket via addComment (cross-vision leak guarded). Comments stay the substrate; this is an aggregation lens.
        </div>
      </main>
    </div>
  );
}

function chip(active: boolean): React.CSSProperties {
  return {
    display: 'flex', alignItems: 'center', gap: 6, width: '100%', textAlign: 'left', marginBottom: 6,
    padding: '7px 10px', borderRadius: 8, cursor: 'pointer',
    border: `1px solid ${active ? '#f59e0b66' : '#1e293b'}`,
    background: active ? '#f59e0b18' : 'transparent',
    color: active ? '#fbbf24' : '#cbd5e1', fontSize: 13, lineHeight: 1.3,
  };
}

const S: Record<string, React.CSSProperties> = {
  page: { display: 'grid', gridTemplateColumns: '300px 1fr', height: '100vh', background: '#0a0f1a', color: '#e2e8f0', fontFamily: 'system-ui, sans-serif' },
  rail: { borderRight: '1px solid #1e293b', padding: '20px 16px', overflowY: 'auto', display: 'flex', flexDirection: 'column' },
  eyebrow: { fontSize: 10, letterSpacing: 1.5, color: '#f59e0b', fontWeight: 700 },
  visionName: { fontSize: 22, margin: '4px 0 6px', fontWeight: 700 },
  ownerRow: { fontSize: 12, color: '#cbd5e1', display: 'flex', alignItems: 'center', gap: 6, marginBottom: 12 },
  dot: { width: 9, height: 9, borderRadius: 9 },
  compRow: { display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 18 },
  compChip: { fontSize: 11, padding: '3px 8px', borderRadius: 6, background: '#1e293b', color: '#94a3b8' },
  filterLabel: { fontSize: 10, letterSpacing: 1, color: '#475569', fontWeight: 700, marginBottom: 8 },
  ticketHdr: { fontSize: 10, letterSpacing: 1, color: '#475569', fontWeight: 700, margin: '14px 0 8px' },
  ticketScroll: { overflowY: 'auto', flex: 1, minHeight: 60 },
  ticketNum: { color: '#f59e0b', fontWeight: 700 },
  cmtCount: { marginLeft: 'auto', fontSize: 11, color: '#64748b', background: '#0f1726', borderRadius: 999, padding: '1px 7px' },
  toggleRow: { display: 'flex', gap: 8, alignItems: 'center', fontSize: 11, color: '#94a3b8', marginTop: 14, cursor: 'pointer' },
  refresh: { marginTop: 10, fontSize: 12, color: '#94a3b8', background: 'transparent', border: '1px solid #1e293b', borderRadius: 8, padding: '6px', cursor: 'pointer' },
  main: { display: 'flex', flexDirection: 'column', height: '100vh', overflow: 'hidden' },
  feedHdr: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '18px 24px', borderBottom: '1px solid #1e293b' },
  feedTitle: { fontSize: 18, fontWeight: 700 },
  feedSub: { fontSize: 12, color: '#64748b', marginTop: 2 },
  taxNote: { fontSize: 11, color: '#34d399', background: '#34d39915', padding: '4px 10px', borderRadius: 999, whiteSpace: 'nowrap' },
  feed: { flex: 1, overflowY: 'auto', padding: '16px 24px' },
  error: { color: '#fca5a5', background: '#7f1d1d22', border: '1px solid #7f1d1d', borderRadius: 8, padding: '10px 14px', fontSize: 13, marginBottom: 12 },
  empty: { color: '#475569', fontSize: 13, padding: '40px 0', textAlign: 'center' },
  msg: { display: 'flex', gap: 12, padding: '14px 0', borderBottom: '1px solid #131c2b' },
  avatar: { width: 30, height: 30, borderRadius: 30, flexShrink: 0, display: 'grid', placeItems: 'center', color: '#0a0f1a', fontWeight: 800, fontSize: 13 },
  msgHead: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', fontSize: 13, marginBottom: 4 },
  sysTag: { fontSize: 9, background: '#64748b22', color: '#94a3b8', padding: '1px 6px', borderRadius: 4, letterSpacing: 0.5 },
  ticketTag: { fontSize: 11, color: '#64748b' },
  time: { fontSize: 11, color: '#475569', marginLeft: 'auto' },
  body: { fontSize: 13.5, color: '#cbd5e1', lineHeight: 1.5, whiteSpace: 'pre-wrap' },
  actions: { display: 'flex', gap: 10, marginTop: 8, alignItems: 'center' },
  reply: { fontSize: 11, color: '#94a3b8', background: 'transparent', border: '1px solid #1e293b', borderRadius: 6, padding: '3px 9px', cursor: 'pointer' },
  mentions: { fontSize: 11, color: '#fbbf24' },
  replyBar: { display: 'flex', gap: 10, padding: '14px 24px', borderTop: '1px solid #1e293b' },
  replyInput: { flex: 1, background: '#0f1726', border: '1px solid #1e293b', borderRadius: 8, padding: '10px 14px', color: '#e2e8f0', fontSize: 13 },
  send: { background: '#f59e0b', color: '#0a0f1a', border: 'none', borderRadius: 8, padding: '0 18px', fontWeight: 700, cursor: 'pointer' },
  footNote: { fontSize: 10.5, color: '#475569', padding: '0 24px 14px', lineHeight: 1.4 },
};
