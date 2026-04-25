'use client';

/**
 * Studio Ledger — project detail page.
 *
 * Renders the project-page UX in the editorial Studio Ledger theme.
 * Activated via STUDIO_LEDGER_UX feature flag (route fork in
 * /projects/[id]/page.tsx). Identical data hooks as the legacy page —
 * only presentation differs.
 *
 * Sections:
 *  - Masthead         — breadcrumbs + volume/issue/date strap
 *  - Title block      — project name with display Fraunces + tagline rule
 *  - Component tabs   — roman-numeralled, with current horizon glyph
 *  - Component body   — approval-horizon banner, roadmap rows, Begin work CTA
 *  - Vision & guardrails — vision summary + autonomy/cadence side-notes
 *  - Metadata rail    — sticky right column with state, components, repo
 *  - Colophon         — typeset-by footer rule
 */

import { useEffect, useMemo, useState, Suspense, useCallback } from 'react';
import { useParams, useRouter, useSearchParams } from 'next/navigation';
import Link from 'next/link';
import dynamic from 'next/dynamic';
import remarkGfm from 'remark-gfm';
import { useWSData } from '@/lib/ws';
import {
  getEffectiveComponents,
  getComponentVersions,
  getComponentApprovedThrough,
  type ComponentLike,
} from '@/lib/component-helpers';
import { isVersionInHorizon } from '@/lib/version-utils';
import { TaskDetailPanel } from '@/components/TaskDetailPanel';
import { updateTask, addComment as addTaskComment, deleteTask } from '@/lib/store';

const ReactMarkdown = dynamic(() => import('react-markdown'), { ssr: false });

/* -------------------------------------------------------------------------- */
/* Helpers                                                                    */
/* -------------------------------------------------------------------------- */

function fmtDate(ms?: number): string {
  if (!ms) return '—';
  return new Date(ms).toLocaleDateString('en-US', {
    weekday: 'short', day: '2-digit', month: 'short', year: 'numeric',
  });
}
function fmtDateShort(ms?: number): string {
  if (!ms) return '—';
  return new Date(ms).toLocaleDateString('en-US', { day: '2-digit', month: 'short', year: 'numeric' });
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

function statusGlyph(status: string): string {
  if (status === 'shipped') return '✓';
  if (status === 'current') return '●';
  return '○';
}

/* -------------------------------------------------------------------------- */
/* Inner page                                                                 */
/* -------------------------------------------------------------------------- */

function LedgerProjectPageInner() {
  const params = useParams();
  const router = useRouter();
  const searchParams = useSearchParams();
  const projectId = params?.id as string;

  // Activate Studio Ledger theme on the document root for the lifetime of
  // this page, then clean up so other routes keep the dashboard's dark UI.
  useEffect(() => {
    const el = document.documentElement;
    const prev = el.getAttribute('data-theme');
    el.setAttribute('data-theme', 'ledger');
    return () => {
      if (prev == null) el.removeAttribute('data-theme');
      else el.setAttribute('data-theme', prev);
    };
  }, []);

  const storeData = useWSData<any>('store');
  const project = useMemo<any>(() => {
    if (!storeData?.projects) return null;
    return storeData.projects.find((p: any) => p.id === projectId) || null;
  }, [storeData, projectId]);

  const components = useMemo<ComponentLike[]>(
    () => (project ? getEffectiveComponents(project) : []),
    [project]
  );

  const allTasks: any[] = (storeData?.tasks || []) as any[];
  const taskById = useMemo(() => {
    const m = new Map<string, any>();
    for (const t of allTasks) m.set(t.id, t);
    return m;
  }, [allTasks]);

  // Active component from ?component=… query, falling back to first component.
  const activeId = useMemo(() => {
    const fromQuery = searchParams?.get('component');
    if (fromQuery && components.some((c) => c.id === fromQuery)) return fromQuery;
    return components[0]?.id ?? null;
  }, [searchParams, components]);
  const activeComp = components.find((c) => c.id === activeId) ?? components[0] ?? null;

  // Versions + horizon for the active component.
  const compVersions = useMemo<any[]>(
    () => (activeComp ? (getComponentVersions(project as any, activeComp.id) as any[]) : []),
    [project, activeComp]
  );
  const compHorizon = useMemo<string | null>(
    () => (activeComp ? (getComponentApprovedThrough(project as any, activeComp.id) ?? null) : null),
    [project, activeComp]
  );

  // First unshipped, in-horizon version — the "Begin work" target.
  const beginTarget = useMemo<any | null>(() => {
    if (!compHorizon) return null;
    return compVersions.find(
      (v) => v.status !== 'shipped' && isVersionInHorizon(v.version, compHorizon)
    ) || null;
  }, [compVersions, compHorizon]);

  // Task panel
  const [selectedTask, setSelectedTask] = useState<any | null>(null);
  const [showDetailPanel, setShowDetailPanel] = useState(false);

  const onPickTask = useCallback((taskId?: string) => {
    if (!taskId) return;
    const t = taskById.get(taskId);
    if (!t) return;
    setSelectedTask(t);
    setShowDetailPanel(true);
  }, [taskById]);

  const onBeginWork = useCallback(async () => {
    if (!beginTarget || !projectId) return;
    const draftItems = (beginTarget.items || []).filter((it: any) => !it.taskId);
    if (draftItems.length > 0) {
      alert(`Cannot start ${beginTarget.version}: ${draftItems.length} item(s) need planning tickets first.`);
      return;
    }
    const resp = await fetch('/api/store', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'promoteVersion', projectId, targetVersion: beginTarget.version }),
    });
    const result = await resp.json().catch(() => ({}));
    if (!result.ok && result.reason) alert(`Cannot start: ${result.reason}`);
  }, [beginTarget, projectId]);

  if (!storeData) {
    return <div className="flex items-center justify-center h-full ledger-mono text-sm text-[var(--ledger-ink-mute)]">Loading…</div>;
  }
  if (!project) {
    return <div className="flex items-center justify-center h-full ledger-mono text-sm text-[var(--ledger-ink-mute)]">Project not found</div>;
  }

  // Issue # = total shipped versions across the project (across components when present).
  const issueNumber = (() => {
    let n = 0;
    for (const c of components) {
      const v = getComponentVersions(project as any, c.id) as any[];
      n += v.filter((x) => x.status === 'shipped').length;
    }
    return n;
  })();
  const currentVolume = project.currentVersion ?? '—';

  /* ---------------- Render ---------------- */

  return (
    <div className="flex-1 overflow-auto">
      <div className="ledger-page max-w-[1280px] mx-auto px-8 sm:px-16 pt-14 pb-32 grid grid-cols-1 lg:grid-cols-[minmax(0,1fr)_280px] gap-x-20">

        {/* MASTHEAD */}
        <header className="col-span-full flex items-end justify-between border-b border-[var(--ledger-ink)] pb-3.5 mb-14 ledger-mono uppercase tracking-[0.14em] text-[11px] text-[var(--ledger-ink-soft)]">
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
            <span><b className="text-[var(--ledger-ink)] font-medium tracking-[0.04em]">{fmtDate(Date.now())}</b></span>
          </div>
        </header>

        {/* MAIN COLUMN */}
        <main className="ledger-stagger min-w-0">
          {/* TITLE BLOCK */}
          <section className="mb-10">
            <div className="flex items-center gap-3 mb-4 ledger-mono text-[10px] tracking-[0.3em] uppercase text-[var(--ledger-oxblood)]">
              <span className="inline-block w-7 h-px bg-[var(--ledger-oxblood)]" />
              <span>{project.tagline ?? `A project of ${project.owner ?? 'Catpilot'}`} · Building since {fmtDateShort(project.createdAt)}</span>
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

          {/* COMPONENT TABS */}
          <nav role="tablist" className="flex gap-1 border-b border-[var(--ledger-rule)] flex-wrap items-end mt-14 mb-2">
            {components.map((c, i) => {
              const horizon = getComponentApprovedThrough(project as any, c.id) ?? '—';
              const isActive = c.id === activeId;
              return (
                <button
                  key={c.id}
                  role="tab"
                  aria-selected={isActive}
                  onClick={() => router.replace(`/projects/${projectId}?component=${c.id}`, { scroll: false })}
                  className="ledger-mono uppercase text-[11px] tracking-[0.12em] py-3.5 px-5 inline-flex items-center gap-2.5 cursor-pointer relative transition-colors duration-200 bg-transparent border-0"
                  style={{ color: isActive ? 'var(--ledger-ink)' : 'var(--ledger-ink-mute)' }}
                  onMouseEnter={(e) => { if (!isActive) (e.currentTarget as HTMLButtonElement).style.color = 'var(--ledger-ink)'; }}
                  onMouseLeave={(e) => { if (!isActive) (e.currentTarget as HTMLButtonElement).style.color = 'var(--ledger-ink-mute)'; }}
                >
                  <span style={{ color: 'var(--ledger-ink-mute)', opacity: 0.6, fontWeight: 500 }}>{romanize(i + 1)}.</span>
                  <span>{c.name}</span>
                  <span style={{ color: 'var(--ledger-ink-mute)', fontWeight: 500 }}>· {horizon}</span>
                  {isActive && <span className="absolute -bottom-px left-3 right-3 h-0.5" style={{ background: 'var(--ledger-oxblood)' }} />}
                </button>
              );
            })}
          </nav>

          {/* COMPONENT BODY */}
          {activeComp ? (
            <article className="pt-10 ledger-rise">
              {/* Heading row */}
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
                      <em className="ml-2 text-[22px] text-[var(--ledger-ink-mute)]" style={{ fontStyle: 'italic', fontWeight: 300 }}>
                        — {activeComp.contract}
                      </em>
                    ) : null}
                  </h2>
                  {activeComp.outcomes && (
                    <p className="text-[13.5px] text-[var(--ledger-ink-soft)] max-w-[60ch] mt-1.5 mb-0">{activeComp.outcomes}</p>
                  )}
                </div>
                {activeComp.owner && (
                  <div className="ledger-mono text-[10.5px] uppercase tracking-[0.2em] text-[var(--ledger-ink-mute)] text-right whitespace-nowrap">
                    Owner<br />
                    <span className="text-[var(--ledger-ink)]">{activeComp.owner}</span>
                  </div>
                )}
              </div>

              {/* APPROVAL HORIZON BANNER */}
              {compHorizon ? (
                <div
                  className="mt-8 mb-10 p-5 px-7 flex items-center justify-between gap-6 relative"
                  style={{
                    background: 'rgba(184, 137, 61, 0.08)',
                    border: '1px solid var(--ledger-gilt)',
                    borderLeftWidth: '4px',
                    transform: 'rotate(-0.25deg)',
                  }}
                >
                  <div>
                    <div className="ledger-mono text-[10px] uppercase tracking-[0.25em] text-[var(--ledger-gilt)] mb-1.5 font-medium">
                      Approval horizon
                    </div>
                    <div className="ledger-serif text-[17px] text-[var(--ledger-ink)] leading-tight">
                      Agents may proceed through{' '}
                      <em style={{ fontStyle: 'italic', color: 'var(--ledger-oxblood)' }}>v{compHorizon}</em>
                      {beginTarget && (
                        <>
                          {' '}— next up: <span className="ledger-mono text-[14px]">v{beginTarget.version}</span>
                        </>
                      )}
                    </div>
                  </div>
                  {beginTarget && beginTarget.status !== 'current' && (
                    <button
                      onClick={onBeginWork}
                      className="ledger-mono text-[11px] uppercase tracking-[0.18em] px-5 py-3 text-[var(--ledger-paper)] transition-all hover:scale-[1.02] active:scale-[0.99]"
                      style={{
                        background: 'var(--ledger-oxblood)',
                        border: 'none',
                        cursor: 'pointer',
                        boxShadow: '0 2px 0 var(--ledger-oxblood-deep)',
                      }}
                    >
                      Begin work →
                    </button>
                  )}
                </div>
              ) : (
                <div className="mt-8 mb-10 p-4 px-6 ledger-mono text-[11px] uppercase tracking-[0.2em] text-[var(--ledger-ink-mute)] border border-dashed border-[var(--ledger-rule)]">
                  No approval horizon set — agents are paused on this component.
                </div>
              )}

              {/* ROADMAP ROWS */}
              {compVersions.length === 0 ? (
                <div className="ledger-serif italic text-[var(--ledger-ink-mute)] text-[15px] py-10 border-t border-[var(--ledger-rule)]">
                  No roadmap versions defined for this component.
                </div>
              ) : (
                <ol className="list-none p-0 m-0 mt-6 border-t border-[var(--ledger-ink)]">
                  {compVersions.map((v) => {
                    const items: any[] = v.items || [];
                    const inHorizon = compHorizon ? isVersionInHorizon(v.version, compHorizon) : false;
                    const isShipped = v.status === 'shipped';
                    const isCurrent = v.status === 'current';
                    const accent = isShipped
                      ? 'var(--ledger-moss)'
                      : isCurrent
                        ? 'var(--ledger-oxblood)'
                        : inHorizon
                          ? 'var(--ledger-gilt)'
                          : 'var(--ledger-ink-mute)';
                    return (
                      <li key={v.version} className="border-b border-[var(--ledger-rule-soft)] py-6 grid grid-cols-[140px_1fr] gap-8 items-start">
                        {/* Left rail: version + status */}
                        <div>
                          <div
                            className="ledger-serif tabular-nums whitespace-nowrap"
                            style={{
                              fontSize: '30px',
                              lineHeight: 1,
                              fontWeight: 350,
                              letterSpacing: '-0.02em',
                              color: accent,
                              fontVariationSettings: '"opsz" 96, "SOFT" 40',
                            }}
                          >
                            v{v.version}
                          </div>
                          <div className="ledger-mono text-[10px] uppercase tracking-[0.22em] mt-2" style={{ color: accent }}>
                            <span className="mr-1.5">{statusGlyph(v.status)}</span>
                            {v.status}
                          </div>
                          {v.waitsFor && (
                            <div className="ledger-mono text-[10px] uppercase tracking-[0.16em] text-[var(--ledger-ink-mute)] mt-2 italic">
                              waits on {v.waitsFor.componentId} v{v.waitsFor.version}
                            </div>
                          )}
                        </div>
                        {/* Right rail: items */}
                        <div>
                          {items.length === 0 ? (
                            <p className="ledger-serif italic text-[var(--ledger-ink-mute)] text-[14px] m-0">No items.</p>
                          ) : (
                            <ul className="list-none p-0 m-0 grid gap-1.5">
                              {items.map((it, idx) => {
                                const t = it.taskId ? taskById.get(it.taskId) : null;
                                const title = t?.title ?? it.title ?? '(untitled)';
                                const taskStatus = t?.status as string | undefined;
                                const done = (taskStatus === 'done') || it.done === true;
                                const isPlanning = !it.taskId && !done;
                                // Label resolution priority:
                                //   shipped/done item       → (no label, the ✓ carries it)
                                //   linked task w/ status    → the task status
                                //   archived item w/o taskId → (no label)
                                //   no taskId yet (draft)    → "planning"
                                let label = '';
                                if (done) label = '';
                                else if (taskStatus) label = taskStatus;
                                else if (isPlanning) label = 'planning';
                                return (
                                  <li
                                    key={it.id ?? `${v.version}-${idx}`}
                                    className="grid grid-cols-[20px_1fr_auto] items-baseline gap-3 py-1 group"
                                  >
                                    <span
                                      className="ledger-mono text-[12px] tabular-nums text-right"
                                      style={{ color: done ? 'var(--ledger-moss)' : 'var(--ledger-ink-mute)' }}
                                    >
                                      {done ? '✓' : '·'}
                                    </span>
                                    <button
                                      type="button"
                                      onClick={() => onPickTask(it.taskId)}
                                      disabled={!it.taskId}
                                      className="ledger-serif text-left text-[15px] leading-snug bg-transparent border-0 p-0 m-0 cursor-pointer disabled:cursor-default disabled:opacity-90"
                                      style={{
                                        color: done ? 'var(--ledger-ink-mute)' : 'var(--ledger-ink)',
                                        textDecoration: done ? 'line-through' : 'none',
                                        textDecorationColor: 'var(--ledger-ink-mute)',
                                        textDecorationThickness: '1px',
                                      }}
                                    >
                                      {title}
                                    </button>
                                    {label && (
                                      <span
                                        className="ledger-mono text-[10px] uppercase tracking-[0.18em]"
                                        style={{ color: isPlanning ? 'var(--ledger-gilt)' : 'var(--ledger-ink-mute)' }}
                                      >
                                        {label}
                                      </span>
                                    )}
                                  </li>
                                );
                              })}
                            </ul>
                          )}
                        </div>
                      </li>
                    );
                  })}
                </ol>
              )}

              {/* VISION & GUARDRAILS */}
              <VisionAndGuardrails project={project} projectId={projectId} />
            </article>
          ) : (
            <div className="pt-10 ledger-serif italic text-[var(--ledger-ink-mute)]">This project has no components yet.</div>
          )}
        </main>

        {/* METADATA RAIL */}
        <aside className="hidden lg:block sticky top-8 self-start text-[13px]">
          <div className="border-b border-[var(--ledger-rule-soft)] pb-7 mb-9">
            <h5 className="ledger-mono text-[9.5px] tracking-[0.25em] uppercase text-[var(--ledger-ink-mute)] m-0 mb-3 font-medium">
              Project state
            </h5>
            <div className="ledger-serif" style={{ fontSize: '28px', fontWeight: 300, lineHeight: 1.1, letterSpacing: '-0.02em' }}>
              <em style={{ fontStyle: 'italic', color: 'var(--ledger-oxblood)' }}>
                {(project.state as string)?.replace(/^./, (c: string) => c.toUpperCase()) || 'Building'}
              </em>{' '}
              <span className="text-[13px] text-[var(--ledger-ink-mute)]">v{project.currentVersion ?? '0.1.0'}</span>
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
            <div className="border-b border-[var(--ledger-rule-soft)] pb-7 mb-9">
              <h5 className="ledger-mono text-[9.5px] tracking-[0.25em] uppercase text-[var(--ledger-ink-mute)] m-0 mb-3 font-medium">
                Repository
              </h5>
              <a
                href={project.repoUrl}
                target="_blank"
                rel="noreferrer"
                className="ledger-mono text-[12px] m-0 text-[var(--ledger-ink-soft)] hover:text-[var(--ledger-oxblood)] break-all"
              >
                {project.repoUrl}
              </a>
            </div>
          )}

          {(project.devOwner || project.qaOwner) && (
            <div>
              <h5 className="ledger-mono text-[9.5px] tracking-[0.25em] uppercase text-[var(--ledger-ink-mute)] m-0 mb-3 font-medium">
                Owners
              </h5>
              <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 m-0">
                {project.devOwner && (<>
                  <dt className="ledger-mono text-[10px] uppercase tracking-[0.2em] text-[var(--ledger-ink-mute)]">Dev</dt>
                  <dd className="ledger-serif text-[14px] m-0 text-[var(--ledger-ink)]">{project.devOwner}</dd>
                </>)}
                {project.qaOwner && (<>
                  <dt className="ledger-mono text-[10px] uppercase tracking-[0.2em] text-[var(--ledger-ink-mute)]">QA</dt>
                  <dd className="ledger-serif text-[14px] m-0 text-[var(--ledger-ink)]">{project.qaOwner}</dd>
                </>)}
              </dl>
            </div>
          )}
        </aside>

        {/* COLOPHON */}
        <footer className="col-span-full mt-20 pt-6 border-t border-[var(--ledger-ink)] flex justify-between ledger-mono text-[10px] tracking-[0.2em] uppercase text-[var(--ledger-ink-mute)]">
          <span>Set in <em className="not-italic text-[var(--ledger-oxblood)]">Fraunces</em> &amp; <em className="not-italic text-[var(--ledger-oxblood)]">JetBrains Mono</em></span>
          <span>Org Studio · Studio Ledger Edition</span>
        </footer>
      </div>

      {/* TASK DETAIL PANEL — same component as the legacy page, just opened from the ledger row click. */}
      {showDetailPanel && selectedTask && (
        <TaskDetailPanel
          task={selectedTask}
          projects={storeData?.projects || []}
          agents={storeData?.settings?.teammates?.map((t: any) => t.name) || []}
          nameColors={{}}
          qaLead={project?.qaLead}
          onUpdate={async (id, updates) => { await updateTask(id, updates); }}
          onDelete={async (id) => { await deleteTask(id); }}
          onAddComment={async (taskId, comment) => addTaskComment(taskId, comment)}
          onClose={() => setShowDetailPanel(false)}
        />
      )}
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Vision & guardrails block                                                  */
/* -------------------------------------------------------------------------- */

function VisionAndGuardrails({ project, projectId }: { project: any; projectId: string }) {
  const autonomy = project.autonomy || {};
  const guardrails: string[] = (project.guardrails || []).filter(Boolean);
  const cadence = autonomy.cadence;
  const approvalMode = autonomy.approvalMode;
  const approvedThrough = autonomy.approvedThrough;

  // Fetch the project's full vision document from Postgres-backed
  // /api/vision/[id]/doc. Falls back gracefully — a missing doc is
  // common for thin projects.
  const [doc, setDoc] = useState<string | null>(null);
  const [docLoading, setDocLoading] = useState(true);
  useEffect(() => {
    let alive = true;
    setDocLoading(true);
    fetch(`/api/vision/${projectId}/doc`)
      .then((r) => (r.ok ? r.json() : Promise.resolve({ content: '' })))
      .then((d) => { if (alive) setDoc((d?.content as string) || ''); })
      .catch(() => { if (alive) setDoc(''); })
      .finally(() => { if (alive) setDocLoading(false); });
    return () => { alive = false; };
  }, [projectId]);

  const hasDoc = !!(doc && doc.trim());
  const hasInlineVision = !!project.vision;
  const showAny = hasDoc || hasInlineVision || cadence || approvalMode || approvedThrough || guardrails.length > 0;
  if (!showAny && !docLoading) return null;

  // Studio-Ledger markdown styling. Headings echo masthead rules; body uses
  // Fraunces serif at reading size; code drops to JetBrains Mono on a paper
  // tone. First paragraph in the doc receives a drop cap via .ledger-prose.
  const mdComponents = {
    h1: ({ children }: any) => (
      <h2
        className="ledger-serif text-[var(--ledger-ink)] mt-0 mb-6 pb-3 border-b border-[var(--ledger-ink)]"
        style={{ fontSize: '34px', lineHeight: 1.05, fontWeight: 350, letterSpacing: '-0.015em', fontVariationSettings: '"opsz" 96, "SOFT" 30' }}
      >
        {children}
      </h2>
    ),
    h2: ({ children }: any) => (
      <h3
        className="ledger-serif text-[var(--ledger-oxblood)] mt-10 mb-4 pb-2 border-b border-[var(--ledger-rule)]"
        style={{ fontSize: '22px', lineHeight: 1.15, fontWeight: 400, fontVariationSettings: '"opsz" 60' }}
      >
        {children}
      </h3>
    ),
    h3: ({ children }: any) => (
      <h4 className="ledger-mono text-[10.5px] uppercase tracking-[0.22em] text-[var(--ledger-ink-soft)] mt-7 mb-2 font-semibold">
        {children}
      </h4>
    ),
    p: ({ children }: any) => (
      <p className="ledger-serif text-[15.5px] leading-[1.65] text-[var(--ledger-ink)] mb-4" style={{ fontWeight: 350 }}>
        {children}
      </p>
    ),
    ul: ({ children }: any) => (
      <ul className="ledger-serif text-[15px] leading-[1.6] text-[var(--ledger-ink-soft)] mb-4 pl-5 space-y-1.5 list-none">
        {children}
      </ul>
    ),
    ol: ({ children }: any) => (
      <ol className="ledger-serif text-[15px] leading-[1.6] text-[var(--ledger-ink-soft)] mb-4 pl-6 space-y-1.5 list-decimal">
        {children}
      </ol>
    ),
    li: ({ children }: any) => (
      <li className="ledger-serif text-[15px] leading-[1.6] relative pl-4">
        <span className="absolute left-0 top-0 text-[var(--ledger-ink-mute)]">·</span>
        {children}
      </li>
    ),
    strong: ({ children }: any) => (
      <strong className="font-semibold text-[var(--ledger-ink)]">{children}</strong>
    ),
    em: ({ children }: any) => (
      <em className="italic text-[var(--ledger-oxblood)]">{children}</em>
    ),
    a: ({ href, children }: any) => (
      <a href={href} className="text-[var(--ledger-oxblood)] underline decoration-[var(--ledger-rule)] underline-offset-[3px] hover:decoration-[var(--ledger-oxblood)]" target="_blank" rel="noopener noreferrer">
        {children}
      </a>
    ),
    code: ({ children, className }: any) => {
      const isBlock = className?.includes('language-');
      if (isBlock) {
        return (
          <code className="block bg-[var(--ledger-paper-deep)] border border-[var(--ledger-rule-soft)] rounded-sm px-3 py-2.5 ledger-mono text-[12px] text-[var(--ledger-ink)] overflow-x-auto mb-4">
            {children}
          </code>
        );
      }
      return (
        <code className="bg-[var(--ledger-paper-deep)] px-1.5 py-0.5 rounded-sm ledger-mono text-[12px] text-[var(--ledger-ink)]">
          {children}
        </code>
      );
    },
    pre: ({ children }: any) => (
      <pre className="bg-[var(--ledger-paper-deep)] border border-[var(--ledger-rule-soft)] rounded-sm p-4 overflow-x-auto mb-5">
        {children}
      </pre>
    ),
    blockquote: ({ children }: any) => (
      <blockquote className="border-l-2 border-[var(--ledger-oxblood)] pl-5 my-5 ledger-serif italic text-[var(--ledger-ink-soft)]" style={{ fontSize: '16px', lineHeight: 1.55 }}>
        {children}
      </blockquote>
    ),
    hr: () => (
      <hr className="my-8 border-0 border-t border-[var(--ledger-rule)]" />
    ),
    table: ({ children }: any) => (
      <table className="border-collapse w-full mb-5 ledger-serif text-[14px]">{children}</table>
    ),
    thead: ({ children }: any) => (
      <thead className="border-b border-[var(--ledger-ink)]">{children}</thead>
    ),
    th: ({ children }: any) => (
      <th className="text-left ledger-mono text-[10px] uppercase tracking-[0.18em] text-[var(--ledger-ink-mute)] py-2 pr-4 font-medium">{children}</th>
    ),
    td: ({ children }: any) => (
      <td className="py-2 pr-4 align-top border-b border-[var(--ledger-rule-soft)] text-[var(--ledger-ink-soft)]">{children}</td>
    ),
  };

  return (
    <section className="mt-16 pt-10 border-t border-[var(--ledger-ink)] grid grid-cols-1 md:grid-cols-[1fr_240px] gap-x-12 gap-y-8">
      <div>
        <h3 className="ledger-mono text-[10px] uppercase tracking-[0.28em] text-[var(--ledger-oxblood)] mb-6 font-medium">
          Vision
        </h3>

        {hasDoc ? (
          <div className="ledger-prose">
            <ReactMarkdown remarkPlugins={[remarkGfm]} components={mdComponents}>
              {doc as string}
            </ReactMarkdown>
          </div>
        ) : hasInlineVision ? (
          <p className="ledger-serif text-[18px] leading-[1.55] text-[var(--ledger-ink)] m-0" style={{ fontWeight: 350 }}>
            <span
              className="ledger-serif float-left mr-3 mt-1"
              style={{
                fontSize: '64px',
                lineHeight: 0.85,
                fontWeight: 300,
                color: 'var(--ledger-oxblood)',
                fontVariationSettings: '"opsz" 144, "SOFT" 60',
              }}
            >
              {String(project.vision).trim().charAt(0)}
            </span>
            {String(project.vision).trim().slice(1)}
          </p>
        ) : docLoading ? (
          <p className="ledger-serif italic text-[var(--ledger-ink-mute)] m-0 text-[15px]">Loading…</p>
        ) : (
          <p className="ledger-serif italic text-[var(--ledger-ink-mute)] m-0 text-[15px]">No vision recorded.</p>
        )}
      </div>

      <aside className="border-l border-[var(--ledger-rule)] pl-8">
        <h4 className="ledger-mono text-[9.5px] uppercase tracking-[0.25em] text-[var(--ledger-ink-mute)] mb-3 font-medium">
          Autonomy
        </h4>
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 m-0 mb-6">
          {cadence && (<>
            <dt className="ledger-mono text-[10px] uppercase tracking-[0.18em] text-[var(--ledger-ink-mute)]">Cadence</dt>
            <dd className="ledger-serif text-[13px] m-0 text-[var(--ledger-ink)]">{cadence}</dd>
          </>)}
          {approvalMode && (<>
            <dt className="ledger-mono text-[10px] uppercase tracking-[0.18em] text-[var(--ledger-ink-mute)]">Approval</dt>
            <dd className="ledger-serif text-[13px] m-0 text-[var(--ledger-ink)]">{approvalMode}</dd>
          </>)}
          {approvedThrough && (<>
            <dt className="ledger-mono text-[10px] uppercase tracking-[0.18em] text-[var(--ledger-ink-mute)]">Through</dt>
            <dd className="ledger-mono text-[12px] m-0 text-[var(--ledger-oxblood)]">v{approvedThrough}</dd>
          </>)}
        </dl>

        {guardrails.length > 0 && (
          <>
            <h4 className="ledger-mono text-[9.5px] uppercase tracking-[0.25em] text-[var(--ledger-ink-mute)] mb-3 font-medium">
              Guardrails
            </h4>
            <ul className="list-none p-0 m-0 grid gap-2">
              {guardrails.map((g, i) => (
                <li key={i} className="ledger-serif italic text-[13px] text-[var(--ledger-ink-soft)] leading-snug">
                  &middot; {g}
                </li>
              ))}
            </ul>
          </>
        )}
      </aside>
    </section>
  );
}

/* -------------------------------------------------------------------------- */
/* Outer Suspense boundary                                                    */
/* -------------------------------------------------------------------------- */

export default function LedgerProjectPage() {
  return (
    <Suspense fallback={<div className="flex items-center justify-center h-full ledger-mono text-sm text-[var(--ledger-ink-mute)]">Loading…</div>}>
      <LedgerProjectPageInner />
    </Suspense>
  );
}
