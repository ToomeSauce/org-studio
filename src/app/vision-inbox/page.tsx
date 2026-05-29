'use client';

/**
 * /vision-inbox — MOCKUP (#1562 spike, not wired)
 *
 * A clickable static mockup of the per-vision Inbox: one aggregated feed that
 * merges every comment across all of a vision's tickets + Telegram DMs to that
 * vision's owners, so Basil stops paying the flip-tax (Telegram <-> N ticket
 * comment threads).
 *
 * NOTHING here is wired to live data — it's seeded with representative messages
 * (drawn from the real 2026-05-29 version-guard thread) so we can react to
 * pixels before committing to data wiring. Reply box is non-functional.
 *
 * Concept being tested:
 *   - Comments stay the durable substrate (ticket-attributable, agents already
 *     consume them as dispatches).
 *   - This is an AGGREGATION LENS on top: one chronological feed per vision.
 *   - Replying from the feed routes back to the right ticket thread (the ticket
 *     is just metadata on the message).
 *   - Telegram demoted to a mirror (reply from TG -> lands as a comment).
 */

import { useMemo, useState } from 'react';

type Source = 'comment' | 'telegram';
type Msg = {
  id: string;
  author: string;
  agent: boolean;
  ticket: number | null; // null = Telegram DM not yet bound to a ticket
  ticketTitle: string | null;
  source: Source;
  ts: string; // display time
  body: string;
  mentions?: string[];
};

const VISION = {
  name: 'Org Studio',
  northStar: 'Foster continuous learning & growth with coaching agents that make hard things easy.',
  owner: 'Mikey',
  components: ['Platform', 'Tools', 'GTM'],
};

// Representative feed — what the flip-tax looks like aggregated into ONE place.
const SEED: Msg[] = [
  {
    id: 'm1', author: 'Ana', agent: true, ticket: 1561,
    ticketTitle: 'Version-scheme validation guard',
    source: 'comment', ts: '2:31 PM',
    body: '🤝 Closed from my side too. Guard scans the right surfaces, hints when something smells like a container, and stays correctly non-gating until catpilot data is clean.',
    mentions: ['Mikey'],
  },
  {
    id: 'm2', author: 'Ana', agent: true, ticket: 1561,
    ticketTitle: 'Version-scheme validation guard',
    source: 'comment', ts: '2:31 PM',
    body: '@Basil — consolidating the 3 catpilot version-data items Mikey\u2019s guard surfaced so you can clear them in one pass. None block anything (guard is non-gating until these land + I canary it).',
    mentions: ['Basil'],
  },
  {
    id: 'm3', author: 'Mikey', agent: true, ticket: 1561,
    ticketTitle: 'Version-scheme validation guard',
    source: 'comment', ts: '2:29 PM',
    body: '📋 3 catpilot version-data items for Basil: (1) mark 2026-Q2-sprint kind:"umbrella", (2) resolve double-current, (3) prune 0.1.0 stub. Items 1+2 touch the same version — decide together.',
    mentions: ['Basil'],
  },
  {
    id: 'm4', author: 'Basil', agent: false, ticket: null,
    ticketTitle: null,
    source: 'telegram', ts: '2:10 PM',
    body: 'to ensure we\u2019re aligned, here\u2019s my understanding of current state… (vision/component/version model) — are these optimal? what would you change?',
  },
  {
    id: 'm5', author: 'Sam', agent: true, ticket: 1540,
    ticketTitle: 'ToS review for public launch',
    source: 'comment', ts: '1:48 PM',
    body: 'Draft ToS section 4 (data retention) ready for review. No blockers — proceeding with the opinionated default (30-day soft delete) per guardrails.',
  },
  {
    id: 'm6', author: 'Henry', agent: true, ticket: 1555,
    ticketTitle: 'Onboarding flow polish',
    source: 'comment', ts: '11:22 AM',
    body: 'Routed the invite-email copy to Sam for a compliance pass. Will ship the flow once it\u2019s back — not blocking on it.',
  },
];

const AGENT_COLOR: Record<string, string> = {
  Ana: '#34d399', Mikey: '#f59e0b', Henry: '#22d3ee', Sam: '#a78bfa', Basil: '#fbbf24',
};

export default function VisionInboxMock() {
  const [filter, setFilter] = useState<'all' | string>('all');
  const [showTelegram, setShowTelegram] = useState(true);

  const tickets = useMemo(() => {
    const m = new Map<number, string>();
    for (const x of SEED) if (x.ticket) m.set(x.ticket, x.ticketTitle || '');
    return [...m.entries()].sort((a, b) => b[0] - a[0]);
  }, []);

  const feed = SEED.filter((m) => {
    if (!showTelegram && m.source === 'telegram') return false;
    if (filter === 'all') return true;
    if (filter === 'tg') return m.source === 'telegram';
    return String(m.ticket) === filter;
  });

  return (
    <div style={S.page}>
      {/* LEFT RAIL — vision context + filters */}
      <aside style={S.rail}>
        <div style={S.eyebrow}>VISION INBOX · mockup</div>
        <h1 style={S.visionName}>{VISION.name}</h1>
        <p style={S.northStar}>★ {VISION.northStar}</p>
        <div style={S.ownerRow}>
          <span style={{ ...S.dot, background: AGENT_COLOR[VISION.owner] }} />
          owner <b>{VISION.owner}</b>
        </div>

        <div style={S.compRow}>
          {VISION.components.map((c) => (
            <span key={c} style={S.compChip}>{c}</span>
          ))}
        </div>

        <div style={S.filterLabel}>FILTER</div>
        <button style={chip(filter === 'all')} onClick={() => setFilter('all')}>All activity</button>
        <button style={chip(filter === 'tg')} onClick={() => setFilter('tg')}>📨 Telegram only</button>
        <div style={S.ticketHdr}>BY TICKET</div>
        {tickets.map(([num, title]) => (
          <button key={num} style={chip(filter === String(num))} onClick={() => setFilter(String(num))}>
            <span style={S.ticketNum}>#{num}</span> {title}
          </button>
        ))}

        <label style={S.toggleRow}>
          <input type="checkbox" checked={showTelegram} onChange={(e) => setShowTelegram(e.target.checked)} />
          mirror Telegram DMs into feed
        </label>
      </aside>

      {/* CENTER — aggregated chronological feed */}
      <main style={S.main}>
        <div style={S.feedHdr}>
          <div>
            <div style={S.feedTitle}>{filter === 'all' ? 'All activity' : filter === 'tg' ? 'Telegram' : `#${filter}`}</div>
            <div style={S.feedSub}>{feed.length} messages · one feed across {tickets.length} tickets + Telegram</div>
          </div>
          <div style={S.taxNote}>no more flipping app ↔ ticket</div>
        </div>

        <div style={S.feed}>
          {feed.map((m) => (
            <div key={m.id} style={S.msg}>
              <span style={{ ...S.avatar, background: AGENT_COLOR[m.author] || '#64748b' }}>
                {m.author[0]}
              </span>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={S.msgHead}>
                  <b style={{ color: AGENT_COLOR[m.author] || '#e2e8f0' }}>{m.author}</b>
                  {!m.agent && <span style={S.human}>human</span>}
                  {m.source === 'telegram' ? (
                    <span style={S.tgTag}>📨 Telegram{m.ticket ? '' : ' · unfiled'}</span>
                  ) : (
                    <span style={S.ticketTag}>#{m.ticket} · {m.ticketTitle}</span>
                  )}
                  <span style={S.time}>{m.ts}</span>
                </div>
                <div style={S.body}>{m.body}</div>
                <div style={S.actions}>
                  <button style={S.reply}>↩ reply on #{m.ticket ?? '—'}</button>
                  {!m.ticket && <button style={S.fileBtn}>📎 file to ticket…</button>}
                </div>
              </div>
            </div>
          ))}
        </div>

        {/* REPLY BAR — routes to whichever ticket the thread belongs to */}
        <div style={S.replyBar}>
          <input style={S.replyInput} placeholder={filter.match(/^\d+$/) ? `Reply on #${filter}…` : 'Reply (pick a ticket, or it files as a vision note)…'} disabled />
          <button style={S.send} disabled>Send →</button>
        </div>
        <div style={S.footNote}>
          Mockup — not wired. Comments stay the substrate; this is an aggregation lens. Replies route to the ticket thread. Telegram becomes a mirror, not a second source of truth.
        </div>
      </main>
    </div>
  );
}

function chip(active: boolean): React.CSSProperties {
  return {
    display: 'block', width: '100%', textAlign: 'left', marginBottom: 6,
    padding: '7px 10px', borderRadius: 8, cursor: 'pointer',
    border: `1px solid ${active ? '#f59e0b66' : '#1e293b'}`,
    background: active ? '#f59e0b18' : 'transparent',
    color: active ? '#fbbf24' : '#cbd5e1', fontSize: 13, lineHeight: 1.3,
  };
}

const S: Record<string, React.CSSProperties> = {
  page: { display: 'grid', gridTemplateColumns: '300px 1fr', height: '100vh', background: '#0a0f1a', color: '#e2e8f0', fontFamily: 'system-ui, sans-serif' },
  rail: { borderRight: '1px solid #1e293b', padding: '20px 16px', overflowY: 'auto' },
  eyebrow: { fontSize: 10, letterSpacing: 1.5, color: '#f59e0b', fontWeight: 700 },
  visionName: { fontSize: 22, margin: '4px 0 6px', fontWeight: 700 },
  northStar: { fontSize: 12, color: '#94a3b8', lineHeight: 1.4, margin: '0 0 12px' },
  ownerRow: { fontSize: 12, color: '#cbd5e1', display: 'flex', alignItems: 'center', gap: 6, marginBottom: 12 },
  dot: { width: 9, height: 9, borderRadius: 9 },
  compRow: { display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 18 },
  compChip: { fontSize: 11, padding: '3px 8px', borderRadius: 6, background: '#1e293b', color: '#94a3b8' },
  filterLabel: { fontSize: 10, letterSpacing: 1, color: '#475569', fontWeight: 700, marginBottom: 8 },
  ticketHdr: { fontSize: 10, letterSpacing: 1, color: '#475569', fontWeight: 700, margin: '14px 0 8px' },
  ticketNum: { color: '#f59e0b', fontWeight: 700, marginRight: 4 },
  toggleRow: { display: 'flex', gap: 8, alignItems: 'center', fontSize: 11, color: '#94a3b8', marginTop: 18, cursor: 'pointer' },
  main: { display: 'flex', flexDirection: 'column', height: '100vh', overflow: 'hidden' },
  feedHdr: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '18px 24px', borderBottom: '1px solid #1e293b' },
  feedTitle: { fontSize: 18, fontWeight: 700 },
  feedSub: { fontSize: 12, color: '#64748b', marginTop: 2 },
  taxNote: { fontSize: 11, color: '#34d399', background: '#34d39915', padding: '4px 10px', borderRadius: 999 },
  feed: { flex: 1, overflowY: 'auto', padding: '16px 24px' },
  msg: { display: 'flex', gap: 12, padding: '14px 0', borderBottom: '1px solid #131c2b' },
  avatar: { width: 30, height: 30, borderRadius: 30, flexShrink: 0, display: 'grid', placeItems: 'center', color: '#0a0f1a', fontWeight: 800, fontSize: 13 },
  msgHead: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', fontSize: 13, marginBottom: 4 },
  human: { fontSize: 9, background: '#fbbf2422', color: '#fbbf24', padding: '1px 6px', borderRadius: 4, letterSpacing: 0.5 },
  ticketTag: { fontSize: 11, color: '#64748b' },
  tgTag: { fontSize: 11, color: '#38bdf8' },
  time: { fontSize: 11, color: '#475569', marginLeft: 'auto' },
  body: { fontSize: 13.5, color: '#cbd5e1', lineHeight: 1.5 },
  actions: { display: 'flex', gap: 10, marginTop: 8 },
  reply: { fontSize: 11, color: '#94a3b8', background: 'transparent', border: '1px solid #1e293b', borderRadius: 6, padding: '3px 9px', cursor: 'pointer' },
  fileBtn: { fontSize: 11, color: '#38bdf8', background: 'transparent', border: '1px solid #38bdf833', borderRadius: 6, padding: '3px 9px', cursor: 'pointer' },
  replyBar: { display: 'flex', gap: 10, padding: '14px 24px', borderTop: '1px solid #1e293b' },
  replyInput: { flex: 1, background: '#0f1726', border: '1px solid #1e293b', borderRadius: 8, padding: '10px 14px', color: '#e2e8f0', fontSize: 13 },
  send: { background: '#f59e0b', color: '#0a0f1a', border: 'none', borderRadius: 8, padding: '0 18px', fontWeight: 700, cursor: 'pointer' },
  footNote: { fontSize: 10.5, color: '#475569', padding: '0 24px 14px', lineHeight: 1.4 },
};
