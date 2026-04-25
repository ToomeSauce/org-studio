'use client';

/**
 * Studio Ledger — project detail page.
 *
 * Foundation milestone: scaffolds the page with title masthead, component
 * tabs, and placeholder zones. Roadmap rows / banner / vision blocks land
 * in subsequent milestones.
 *
 * Data: identical hooks as the legacy page (useWSData('store'),
 * useSearchParams for ?component=). Only presentation differs.
 */

import { useEffect, useMemo, useState, Suspense } from 'react';
import { useParams, useRouter, useSearchParams } from 'next/navigation';
import Link from 'next/link';
import { useWSData } from '@/lib/ws';
import {
  getEffectiveComponents,
  getComponentVersions,
  getComponentApprovedThrough,
  type ComponentLike,
  type ProjectLike,
} from '@/lib/component-helpers';

// Tiny utility — read createdAt safely for the masthead.
function fmtIssueDate(ms?: number): string {
  if (!ms) return new Date().toLocaleDateString('en-US', { weekday: 'short', day: '2-digit', month: 'short', year: 'numeric' });
  return new Date(ms).toLocaleDateString('en-US', { weekday: 'short', day: '2-digit', month: 'short', year: 'numeric' });
}

function fmtBuildingSince(ms?: number): string {
  if (!ms) return '—';
  return new Date(ms).toLocaleDateString('en-US', { day: '2-digit', month: 'short', year: 'numeric' });
}

function LedgerProjectPageInner() {
  const params = useParams();
  const router = useRouter();
  const searchParams = useSearchParams();
  const projectId = params?.id as string;

  const storeData = useWSData<any>('store');
  const project = useMemo<any>(() => {
    if (!storeData?.projects) return null;
    return storeData.projects.find((p: any) => p.id === projectId) || null;
  }, [storeData, projectId]);

  const components = useMemo<ComponentLike[]>(
    () => (project ? getEffectiveComponents(project) : []),
    [project]
  );

  // Active component from ?component=… query, falling back to first component.
  const activeId = useMemo(() => {
    const fromQuery = searchParams?.get('component');
    if (fromQuery && components.some((c) => c.id === fromQuery)) return fromQuery;
    return components[0]?.id ?? null;
  }, [searchParams, components]);
  const activeComp = components.find((c) => c.id === activeId) ?? components[0] ?? null;

  if (!storeData) {
    return (
      <div className="flex items-center justify-center h-full ledger-mono text-sm text-[var(--text-muted)]">
        Loading…
      </div>
    );
  }
  if (!project) {
    return (
      <div className="flex items-center justify-center h-full ledger-mono text-sm text-[var(--text-muted)]">
        Project not found
      </div>
    );
  }

  const issueNumber = (project.sections?.[0]?.versions ?? []).reduce(
    (acc: number, v: any) => acc + (v.status === 'shipped' ? 1 : 0),
    0
  );
  const currentVolume = project.currentVersion ?? '—';

  return (
    <div className="flex-1 overflow-auto">
      <div className="ledger-page max-w-[1280px] mx-auto px-8 sm:px-16 pt-14 pb-32 grid grid-cols-1 lg:grid-cols-[minmax(0,1fr)_280px] gap-x-20">

        {/* ---------- MASTHEAD ---------- */}
        <header
          className="col-span-full flex items-end justify-between border-b border-[var(--ledger-ink)] pb-3.5 mb-14 ledger-mono uppercase tracking-[0.14em] text-[11px] text-[var(--ledger-ink-soft)]"
        >
          <div className="flex flex-wrap gap-x-2">
            <Link href="/" className="hover:text-[var(--ledger-oxblood)] border-b border-dotted border-[var(--ledger-ink-mute)] pb-px transition-colors">Org Studio</Link>
            <span className="text-[var(--ledger-ink-mute)]">/</span>
            <Link href="/projects" className="hover:text-[var(--ledger-oxblood)] border-b border-dotted border-[var(--ledger-ink-mute)] pb-px transition-colors">Projects</Link>
            <span className="text-[var(--ledger-ink-mute)]">/</span>
            <span className="text-[var(--ledger-ink)]">{project.name}</span>
          </div>
          <div className="hidden sm:flex gap-7">
            <span>Vol. <b className="text-[var(--ledger-ink)] font-medium tracking-[0.04em]">{currentVolume}</b></span>
            <span>Issue <b className="text-[var(--ledger-ink)] font-medium tracking-[0.04em]">№ {issueNumber}</b></span>
            <span><b className="text-[var(--ledger-ink)] font-medium tracking-[0.04em]">{fmtIssueDate(Date.now())}</b></span>
          </div>
        </header>

        {/* ---------- MAIN COLUMN ---------- */}
        <main className="ledger-stagger min-w-0">
          {/* TITLE */}
          <section className="mb-10">
            <div className="flex items-center gap-3 mb-4 ledger-mono text-[10px] tracking-[0.3em] uppercase text-[var(--ledger-oxblood)]">
              <span className="inline-block w-7 h-px bg-[var(--ledger-oxblood)]" />
              <span>{project.tagline ?? `A project of ${project.owner ?? 'Catpilot'}`} · Building since {fmtBuildingSince(project.createdAt)}</span>
            </div>
            <h1
              className="ledger-serif text-[var(--ledger-ink)] m-0 leading-[0.95] tracking-[-0.025em]"
              style={{
                fontSize: 'clamp(56px, 8vw, 104px)',
                fontWeight: 350,
                fontVariationSettings: '"opsz" 144, "SOFT" 30, "WONK" 1',
              }}
            >
              {project.name}
              <em
                className="not-italic"
                style={{
                  fontStyle: 'italic',
                  fontWeight: 300,
                  color: 'var(--ledger-oxblood)',
                  fontVariationSettings: '"opsz" 144, "SOFT" 100, "WONK" 1',
                }}
              >
                .
              </em>
            </h1>
            {project.description && (
              <p className="ledger-serif italic text-lg text-[var(--ledger-ink-soft)] max-w-[56ch] mt-3 mb-0" style={{ fontWeight: 300 }}>
                {project.description}
              </p>
            )}
          </section>

          {/* TABS */}
          <nav
            role="tablist"
            className="flex gap-1 border-b border-[var(--ledger-rule)] flex-wrap items-end mt-14 mb-2"
          >
            {components.map((c, i) => {
              const horizon = getComponentApprovedThrough(project as any, c.id) ?? '—';
              const isActive = c.id === activeId;
              return (
                <button
                  key={c.id}
                  role="tab"
                  aria-selected={isActive}
                  onClick={() => router.replace(`/projects/${projectId}?component=${c.id}`, { scroll: false })}
                  className="ledger-mono uppercase text-[11px] tracking-[0.12em] py-3.5 px-5 inline-flex items-center gap-2.5 cursor-pointer relative transition-colors duration-200"
                  style={{ color: isActive ? 'var(--ledger-ink)' : 'var(--ledger-ink-mute)' }}
                  onMouseEnter={(e) => { if (!isActive) e.currentTarget.style.color = 'var(--ledger-ink)'; }}
                  onMouseLeave={(e) => { if (!isActive) e.currentTarget.style.color = 'var(--ledger-ink-mute)'; }}
                >
                  <span style={{ color: 'var(--ledger-ink-mute)', opacity: 0.6, fontWeight: 500 }}>
                    {romanize(i + 1)}.
                  </span>
                  <span>{c.name}</span>
                  <span style={{ color: 'var(--ledger-ink-mute)', fontWeight: 500 }}>· {horizon}</span>
                  {isActive && (
                    <span
                      className="absolute -bottom-px left-3 right-3 h-0.5"
                      style={{ background: 'var(--ledger-oxblood)' }}
                    />
                  )}
                </button>
              );
            })}
          </nav>

          {/* ACTIVE COMPONENT BODY (placeholder for next milestone) */}
          {activeComp ? (
            <article className="pt-10 ledger-rise">
              <div className="grid grid-cols-[auto_1fr_auto] items-baseline gap-6 mb-2">
                <div
                  className="ledger-serif"
                  style={{
                    fontSize: '92px',
                    fontWeight: 300,
                    lineHeight: 1,
                    color: 'var(--ledger-oxblood)',
                    fontVariationSettings: '"opsz" 144, "SOFT" 50',
                    letterSpacing: '-0.04em',
                  }}
                >
                  {romanize(components.findIndex((c) => c.id === activeComp.id) + 1)}
                </div>
                <div>
                  <h2 className="ledger-serif text-[38px] leading-[1.05] tracking-[-0.02em] m-0" style={{ fontWeight: 400 }}>
                    {activeComp.name}
                    {activeComp.contract ? (
                      <em
                        className="ml-2 text-[22px] text-[var(--ledger-ink-mute)]"
                        style={{ fontStyle: 'italic', fontWeight: 300 }}
                      >
                        — {activeComp.contract}
                      </em>
                    ) : null}
                  </h2>
                  {activeComp.outcomes && (
                    <p className="text-[13.5px] text-[var(--ledger-ink-soft)] max-w-[60ch] mt-1.5 mb-0">
                      {activeComp.outcomes}
                    </p>
                  )}
                </div>
              </div>

              {/* Placeholder card — roadmap rows arrive in next milestone */}
              <div
                className="mt-10 p-12 text-center ledger-serif italic text-[var(--ledger-ink-mute)] border border-dashed border-[var(--ledger-rule)]"
                style={{ fontSize: '15px' }}
              >
                Roadmap rows, approval-horizon banner, and vision/guardrails block
                arrive in the next milestone. Component data is wired:
                <span className="ledger-mono text-[12px] block mt-3 not-italic text-[var(--ledger-ink-soft)]">
                  owner = {activeComp.owner || '—'} · approved-through ={' '}
                  {getComponentApprovedThrough(project as any, activeComp.id) || '—'} ·{' '}
                  {(getComponentVersions(project as any, activeComp.id) as any[]).length} versions
                </span>
              </div>
            </article>
          ) : (
            <div className="pt-10 ledger-serif italic text-[var(--ledger-ink-mute)]">
              This project has no components yet.
            </div>
          )}
        </main>

        {/* ---------- METADATA RAIL ---------- */}
        <aside className="hidden lg:block sticky top-8 self-start text-[13px]">
          <div className="border-b border-[var(--ledger-rule-soft)] pb-7 mb-9">
            <h5 className="ledger-mono text-[9.5px] tracking-[0.25em] uppercase text-[var(--ledger-ink-mute)] m-0 mb-3 font-medium">
              Project state
            </h5>
            <div className="ledger-serif" style={{ fontSize: '28px', fontWeight: 300, lineHeight: 1.1, letterSpacing: '-0.02em' }}>
              <em style={{ fontStyle: 'italic', color: 'var(--ledger-oxblood)' }}>
                {(project.state as string)?.replace(/^./, (c) => c.toUpperCase()) || 'Building'}
              </em>{' '}
              <span className="text-[13px] text-[var(--ledger-ink-mute)]">since v{project.sections?.[0]?.versions?.[0]?.version ?? '0.1.0'}</span>
            </div>
          </div>

          <div className="border-b border-[var(--ledger-rule-soft)] pb-7 mb-9">
            <h5 className="ledger-mono text-[9.5px] tracking-[0.25em] uppercase text-[var(--ledger-ink-mute)] m-0 mb-3 font-medium">
              Components
            </h5>
            <div className="grid gap-2.5">
              {components.map((c) => (
                <Link
                  key={c.id}
                  href={`/projects/${projectId}?component=${c.id}`}
                  className="flex items-baseline justify-between gap-3 no-underline ledger-serif text-[16px] border-b border-dotted border-[var(--ledger-rule)] pb-1.5 transition-colors text-[var(--ledger-ink)] hover:text-[var(--ledger-oxblood)]"
                >
                  <span>{c.name}</span>
                  <span className="ledger-mono text-[11px] text-[var(--ledger-ink-mute)] tracking-[0.05em]">
                    {getComponentApprovedThrough(project as any, c.id) || '—'}
                  </span>
                </Link>
              ))}
            </div>
          </div>

          {project.repoUrl && (
            <div>
              <h5 className="ledger-mono text-[9.5px] tracking-[0.25em] uppercase text-[var(--ledger-ink-mute)] m-0 mb-3 font-medium">
                Repository
              </h5>
              <p className="ledger-mono text-[12px] m-0 text-[var(--ledger-ink-soft)]">{project.repoUrl}</p>
            </div>
          )}
        </aside>

        {/* ---------- COLOPHON ---------- */}
        <footer
          className="col-span-full mt-20 pt-6 border-t border-[var(--ledger-ink)] flex justify-between ledger-mono text-[10px] tracking-[0.2em] uppercase text-[var(--ledger-ink-mute)]"
        >
          <span>Set in <em className="not-italic text-[var(--ledger-oxblood)]">Fraunces</em> &amp; <em className="not-italic text-[var(--ledger-oxblood)]">JetBrains Mono</em></span>
          <span>Org Studio · Studio Ledger Edition</span>
        </footer>
      </div>
    </div>
  );
}

function romanize(n: number): string {
  const numerals: Array<[number, string]> = [[10,'X'],[9,'IX'],[5,'V'],[4,'IV'],[1,'I']];
  let out = '';
  let v = n;
  for (const [val, sym] of numerals) {
    while (v >= val) { out += sym; v -= val; }
  }
  return out;
}

export default function LedgerProjectPage() {
  return (
    <Suspense fallback={<div className="flex items-center justify-center h-full ledger-mono text-sm text-[var(--text-muted)]">Loading…</div>}>
      <LedgerProjectPageInner />
    </Suspense>
  );
}
