'use client';

import { useEffect, useState, useRef, useMemo, useCallback, Suspense } from 'react';
import { useRouter, useParams, useSearchParams } from 'next/navigation';
import Link from 'next/link';
import { clsx } from 'clsx';
import { ArrowLeft, Loader, Pencil, X, Archive, ChevronRight, Plus, Trash2 } from 'lucide-react';
import { useWSData } from '@/lib/ws';
import { getProjectStatusLabel } from '@/lib/vision-status';
import { TaskDetailPanel } from '@/components/TaskDetailPanel';
import { updateTask, addComment as addTaskComment, deleteTask, addSection, updateSection, deleteSection } from '@/lib/store';
import { isVersionInHorizon, formatVersion } from '@/lib/version-utils';
import {
  getComponentIcon,
  getComponentCounts,
  getComponentTotalCount,
  resolveWaitsForLabel,
  shouldShowLegacyDrawer,
  filterTasksByComponent,
  getEffectiveComponents,
  type ComponentLike,
  type ProjectLike,
  type ComponentCounts as ComponentCountsType,
} from '@/lib/component-helpers';
import dynamic from 'next/dynamic';

const RoadmapWithApprovalHorizon = dynamic(
  () => import('@/components/RoadmapWithApprovalHorizon').then(mod => mod.RoadmapWithApprovalHorizon),
  { ssr: false, loading: () => <div className="p-8 text-center text-[var(--text-muted)]">Loading roadmap…</div> }
);
const ReactMarkdown = dynamic(() => import('react-markdown'), { ssr: false });
import remarkGfm from 'remark-gfm';

// Type definitions
interface Project {
  id: string;
  name: string;
  owner?: string;
  devOwner?: string;
  qaOwner?: string;
  currentVersion?: string;
  autonomy?: {
    approvedThrough?: string | null; // version string up to which the agent may execute
    cadence?: string;
    lastApprovedAt?: number;
    lastProposal?: any;
  };
  [key: string]: any;
}

interface Task {
  id: string;
  title: string;
  status: 'planning' | 'backlog' | 'in-progress' | 'review' | 'done' | 'blocked';
  projectId: string;
  assignee: string;  // Required
  version?: string;
  priority?: 'high' | 'medium' | 'low';
  createdAt: number;  // Required by TaskDetailPanel
  [key: string]: any;
}

interface RoadmapVersion {
  id: string;
  version: string;
  title: string;
  status: 'planned' | 'current' | 'shipped';
  items: Array<{ title: string; done: boolean; taskId?: string | null }>;
  progress?: { done: number; total: number };
  shipped_at?: number | null;
  sort_order?: number;
  version_type?: 'outcome' | 'foundation' | 'chore';
}

// Extract section from markdown
function extractSection(content: string, sectionName: string): string {
  const regex = new RegExp(`## ${sectionName}[^]*?(?=## |$)`, 'i');
  const match = content.match(regex);
  return match ? match[0].replace(new RegExp(`## ${sectionName}`, 'i'), '').trim() : '';
}

// Compute project state
function getProjectState(
  project: Project,
  roadmapVersions: RoadmapVersion[],
  projectTasks: Task[]
): {
  state: 'draft' | 'ready' | 'running' | 'blocked' | 'completed';
  label: string;
  emoji: string;
  color: string;
  detail?: string;
} {
  const hasRoadmap = roadmapVersions.length > 0;
  const currentVersion = project.currentVersion;
  const allShipped = hasRoadmap && roadmapVersions.every((v) => v.status === 'shipped');

  if (allShipped && hasRoadmap) {
    return {
      state: 'completed',
      label: 'Completed',
      emoji: '✅',
      color: 'green',
      detail: `All ${roadmapVersions.length} versions shipped`,
    };
  }

  // Check for pending vision cycle — REMOVED: launch flow simplified, no vision cycle
  
  if (!hasRoadmap) {
    return {
      state: 'draft',
      label: 'Draft',
      emoji: '📝',
      color: 'slate',
      detail: 'Create a roadmap to get started',
    };
  }

  if (!currentVersion) {
    return {
      state: 'ready',
      label: 'Ready to Launch',
      emoji: '🟢',
      color: 'blue',
      detail: `${roadmapVersions.length} versions planned`,
    };
  }

  // Has current version — check task progress
  const sprintTasks = projectTasks.filter((t) => t.version === currentVersion);
  const allDone = sprintTasks.length > 0 && sprintTasks.every((t) => t.status === 'done');

  if (allDone) {
    // Check if there's a next version
    const currentIdx = roadmapVersions.findIndex((v) => v.version === currentVersion);
    const nextVersion = roadmapVersions[currentIdx + 1];
    if (nextVersion) {
      return {
        state: 'ready',
        label: 'Sprint Complete',
        emoji: '🎉',
        color: 'green',
        detail: `${currentVersion} done — ready for ${nextVersion.version}`,
      };
    }
    return {
      state: 'completed',
      label: 'Completed',
      emoji: '✅',
      color: 'green',
      detail: 'All versions shipped',
    };
  }

  // Check for blocked tasks (in-progress for too long — we don't have timestamps easily, so skip blocked for now)
  const doneTasks = sprintTasks.filter((t) => t.status === 'done');

  return {
    state: 'running',
    label: 'Running',
    emoji: '⚙️',
    color: 'blue',
    detail: `${currentVersion} — ${doneTasks.length}/${sprintTasks.length} tasks done`,
  };
}

export default function ProjectDetailPage() {
  return (
    <Suspense fallback={<div className="flex items-center justify-center h-full"><Loader className="w-8 h-8 animate-spin text-[var(--text-muted)]" /></div>}>
      <ProjectDetailPageInner />
    </Suspense>
  );
}

function ProjectDetailPageInner() {
  const params = useParams();
  const router = useRouter();
  const searchParams = useSearchParams();
  const projectId = params?.id as string;

  const storeData = useWSData('store');
  const [visionDoc, setVisionDoc] = useState<string>('');
  const [visionLoading, setVisionLoading] = useState(true);
  const [selectedTask, setSelectedTask] = useState<Task | null>(null);
  const [showDetailPanel, setShowDetailPanel] = useState(false);
  const [showEditModal, setShowEditModal] = useState(false);
  const [editProject, setEditProject] = useState({ name: '', lifecycle: '', devOwner: '', visionOwner: '', qaOwner: '' });
  const [editLoading, setEditLoading] = useState(false);
  const [editingVision, setEditingVision] = useState(false);
  const [visionEditContent, setVisionEditContent] = useState('');
  const [visionSaving, setVisionSaving] = useState(false);
  const [showArchiveModal, setShowArchiveModal] = useState(false);
  const [archiving, setArchiving] = useState(false);
  const [roadmap, setRoadmap] = useState<RoadmapVersion[]>([]);
  const [roadmapLoading, setRoadmapLoading] = useState(true);
  const [justSavedProject, setJustSavedProject] = useState(false);
  const [launching, setLaunching] = useState(false);
  const [editingGuardrails, setEditingGuardrails] = useState(false);
  const [guardrailsEditContent, setGuardrailsEditContent] = useState('');
  const [guardrailsSaving, setGuardrailsSaving] = useState(false);
  // #1112 PR 3: Components panel state
  const [showAddComponent, setShowAddComponent] = useState(false);
  const [newComponent, setNewComponent] = useState({ name: '', owner: '', role: '' });
  const [addingComponent, setAddingComponent] = useState(false);
  const [editingComponent, setEditingComponent] = useState<string | null>(null); // component id or null
  const [editComponentForm, setEditComponentForm] = useState<{
    name: string; owner: string; role: string; outcomes: string; contract: string;
    waitsFor: Array<{ componentId: string; projectId?: string; version: string }>;
  }>({ name: '', owner: '', role: '', outcomes: '', contract: '', waitsFor: [] });
  const [savingComponent, setSavingComponent] = useState(false);
  // Board filter pill — from URL
  const activeComponentFilter = searchParams.get('component') || 'all';
  const [proposingRoadmap, setProposingRoadmap] = useState(false);
  const [proposingError, setProposingError] = useState<string | null>(null);

  // Fetch vision doc - MUST be before early returns
  useEffect(() => {
    if (!projectId) return;
    
    const fetchVisionDoc = async () => {
      try {
        const res = await fetch(`/api/vision/${projectId}/doc`);
        if (res.ok) {
          const data = await res.json();
          setVisionDoc(data.content || '');
        }
      } catch (e) {
        console.error('Failed to fetch vision doc:', e);
      } finally {
        setVisionLoading(false);
      }
    };

    fetchVisionDoc();
  }, [projectId]);

  // Fetch roadmap
  useEffect(() => {
    if (!projectId) return;

    const fetchRoadmap = async () => {
      try {
        const res = await fetch(`/api/roadmap/${projectId}`);
        if (res.ok) {
          const data = await res.json();
          setRoadmap(data.versions || []);
        }
      } catch (e) {
        console.error('Failed to fetch roadmap:', e);
      } finally {
        setRoadmapLoading(false);
      }
    };

    fetchRoadmap();
  }, [projectId]);

  // Initialize edit form ONLY when modal first opens (not on store updates while editing)
  const editModalOpenRef = useRef(false);
  useEffect(() => {
    if (showEditModal && !editModalOpenRef.current && storeData?.projects) {
      editModalOpenRef.current = true;
      const proj = storeData.projects.find((p: Project) => p.id === projectId);
      if (proj) {
        console.log('[EditModal] Initializing form from store:', { qaOwner: proj.qaOwner, devOwner: proj.devOwner });
        setEditProject({
          name: proj.name || '',
          lifecycle: proj.lifecycle || 'building',
          devOwner: proj.devOwner || '',
          visionOwner: proj.visionOwner || proj.owner || '',
          qaOwner: proj.qaOwner || '',
        });
      }
    } else if (showEditModal && editModalOpenRef.current) {
      console.log('[EditModal] SKIPPED re-init (modal already open, ref=true)');
    }
    if (!showEditModal) {
      editModalOpenRef.current = false;
    }
  }, [showEditModal, projectId, storeData?.projects]);

  // Find the project
  const project = storeData?.projects?.find((p: Project) => p.id === projectId) as Project | undefined;
  const allTasks = (storeData?.tasks || []) as Task[];
  const projectTasks = allTasks.filter((t: Task) => t.projectId === projectId && !t.isArchived);

  // Get status label
  const statusLabel = project ? getProjectStatusLabel(project, allTasks) : null;

  if (!projectId) {
    return (
      <div className="flex items-center justify-center h-full">
        <p>Project not found</p>
      </div>
    );
  }

  if (!project) {
    return (
      <div className="flex items-center justify-center h-full">
        <Loader className="w-8 h-8 animate-spin text-[var(--text-muted)]" />
      </div>
    );
  }

  // Parse roadmap
  const roadmapVersions = roadmap;

  // #1112 PR 3: effective components (prefer components[], fall back to sections[])
  const components = getEffectiveComponents(project as any);
  const allProjects = (storeData?.projects || []) as ProjectLike[];

  // Filter tasks by current version
  const currentVersion = project.currentVersion;
  const currentSprintTasks = currentVersion
    ? projectTasks.filter((t) => t.version === currentVersion)
    : [];

  const doneTasks = currentSprintTasks.filter((t) => t.status === 'done');
  const inProgressTasks = currentSprintTasks.filter(
    (t) => t.status === 'in-progress'
  );
  const backlogTasks = currentSprintTasks.filter((t) => t.status === 'backlog');

  const sprintProgress = currentSprintTasks.length
    ? Math.round((doneTasks.length / currentSprintTasks.length) * 100)
    : 0;

  // Sort tasks: done → active → backlog
  const sortedTasks = [
    ...doneTasks,
    ...inProgressTasks,
    ...backlogTasks,
  ];

  // Helper: calculate outcome progress
  const getOutcomeProgress = (outcomeId: string) => {
    const linkedTasks = projectTasks.filter(t => t.outcomeIds?.includes(outcomeId));
    const doneTasks = linkedTasks.filter(t => t.status === 'done');
    const progress = linkedTasks.length > 0 ? Math.round((doneTasks.length / linkedTasks.length) * 100) : 0;
    return { linkedCount: linkedTasks.length, doneCount: doneTasks.length, progress };
  };

  // Helper: calculate overall outcome completion
  const getOutcomesSummary = () => {
    // Derive from outcome-type roadmap versions (new model)
    const outcomeVersions = roadmap.filter(v => (v.version_type || 'outcome') === 'outcome');
    if (outcomeVersions.length > 0) {
      const completed = outcomeVersions.filter(v => v.status === 'shipped').length;
      const percent = Math.round((completed / outcomeVersions.length) * 100);
      return { total: outcomeVersions.length, completed, percent };
    }
    // Fallback to legacy project.outcomes for backward compat
    if (!project.outcomes || project.outcomes.length === 0) {
      return { total: 0, completed: 0, percent: 0 };
    }
    const completed = project.outcomes.filter((o: any) => o.done).length;
    const percent = Math.round((completed / project.outcomes.length) * 100);
    return { total: project.outcomes.length, completed, percent };
  };

  const handleSaveProject = async () => {
    if (!editProject.name.trim()) return;
    setEditLoading(true);
    try {
      const resp = await fetch('/api/store', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'updateProject',
          id: projectId,
          updates: {
            name: editProject.name,
            lifecycle: editProject.lifecycle,
            devOwner: editProject.devOwner || undefined,
            owner: editProject.visionOwner || undefined,
            visionOwner: editProject.visionOwner || undefined,
            ...(editProject.qaOwner !== undefined && { qaOwner: editProject.qaOwner || '' }),
          },
        }),
      });
      if (resp.ok) {
        setShowEditModal(false);
        // Set flag to suppress WS updates for 5 seconds
        setJustSavedProject(true);
        setTimeout(() => setJustSavedProject(false), 5000);
      }
    } finally {
      setEditLoading(false);
    }
  };

  const handleSaveVision = async () => {
    setVisionSaving(true);
    try {
      const resp = await fetch(`/api/vision/${projectId}/doc`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: visionEditContent }),
      });
      if (resp.ok) {
        setVisionDoc(visionEditContent);
        setEditingVision(false);
      }
    } finally {
      setVisionSaving(false);
    }
  };

  const handleSaveGuardrails = async () => {
    setGuardrailsSaving(true);
    try {
      await fetch('/api/store', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'updateGuardrails',
          projectId,
          guardrails: guardrailsEditContent,
        }),
      });
      setEditingGuardrails(false);
    } finally {
      setGuardrailsSaving(false);
    }
  };

  // #1112 PR 3: Component CRUD handlers
  const handleAddComponent = async () => {
    if (!newComponent.name.trim()) return;
    setAddingComponent(true);
    try {
      await addSection(projectId, {
        name: newComponent.name.trim(),
        owner: newComponent.owner,
        role: newComponent.role || undefined,
        outcomes: '',
        contract: '',
      } as any);
      setNewComponent({ name: '', owner: '', role: '' });
      setShowAddComponent(false);
    } catch (e) {
      console.error('Failed to add component:', e);
    } finally {
      setAddingComponent(false);
    }
  };

  const handleOpenEditComponent = (comp: ComponentLike) => {
    setEditComponentForm({
      name: comp.name,
      owner: comp.owner,
      role: comp.role || '',
      outcomes: (comp as any).outcomes || '',
      contract: (comp as any).contract || '',
      waitsFor: (comp.waitsFor || []).map(w => ({ ...w })),
    });
    setEditingComponent(comp.id);
  };

  const handleSaveComponent = async () => {
    if (!editingComponent) return;
    setSavingComponent(true);
    try {
      await updateSection(projectId, editingComponent, {
        name: editComponentForm.name,
        owner: editComponentForm.owner,
        role: editComponentForm.role || undefined,
        outcomes: editComponentForm.outcomes,
        contract: editComponentForm.contract,
        waitsFor: editComponentForm.waitsFor.length > 0 ? editComponentForm.waitsFor : undefined,
      } as any);
      setEditingComponent(null);
    } catch (e) {
      console.error('Failed to save component:', e);
    } finally {
      setSavingComponent(false);
    }
  };

  const handleDeleteComponent = async (compId: string) => {
    if (!confirm('Delete this component? Tasks assigned to it will become unassigned.')) return;
    try {
      await deleteSection(projectId, compId);
      if (editingComponent === compId) setEditingComponent(null);
    } catch (e) {
      console.error('Failed to delete component:', e);
    }
  };

  const setComponentFilter = (id: string) => {
    const params = new URLSearchParams(searchParams.toString());
    if (id === 'all') {
      params.delete('component');
    } else {
      params.set('component', id);
    }
    router.replace(`?${params.toString()}`, { scroll: false });
  };

  const handleArchiveProject = async () => {
    setArchiving(true);
    try {
      const resp = await fetch('/api/store', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'updateProject',
          id: projectId,
          updates: {
            isArchived: true,
            archivedAt: Date.now(),
          },
        }),
      });
      if (resp.ok) {
        setShowArchiveModal(false);
        router.push('/projects');
      }
    } finally {
      setArchiving(false);
    }
  };

  const handleLaunch = async () => {
    setLaunching(true);
    try {
      const approvedThrough = project.autonomy?.approvedThrough;
      // Find the first unshipped version that's within the approval horizon
      const nextVersion = roadmapVersions.find((v) => {
        if (v.status === 'shipped') return false;
        if (!approvedThrough) return false;
        return isVersionInHorizon(v.version, approvedThrough);
      });
      if (!nextVersion) return;

      // Gate: block launch if any items are missing planning tickets
      const draftItems = nextVersion.items?.filter((item: any) => !item.taskId) || [];
      if (draftItems.length > 0) {
        alert(`Cannot start ${nextVersion.version}: ${draftItems.length} item(s) need planning tickets before launch.`);
        return;
      }

      // Use consolidated promoteVersion action
      const resp = await fetch('/api/store', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'promoteVersion',
          projectId,
          targetVersion: nextVersion.version,
        }),
      });
      const result = await resp.json();
      if (!result.ok && result.reason) {
        alert(`Cannot start: ${result.reason}`);
        return;
      }

      // Refresh roadmap
      const roadmapRes = await fetch(`/api/roadmap/${projectId}`);
      if (roadmapRes.ok) {
        const roadmapData = await roadmapRes.json();
        setRoadmap(roadmapData.versions || []);
      }
    } catch (e) {
      console.error('Start failed:', e);
    } finally {
      setLaunching(false);
    }
  };

  return (
    <div className="flex-1 overflow-auto bg-[var(--bg-primary)]">
      <div className="max-w-5xl mx-auto p-4 sm:p-6 space-y-6 sm:space-y-8">
        {/* Compressed Header */}
        <div className="space-y-3">
          {/* Line 1: Back button, title, edit, status badge */}
          <div className="flex items-center gap-2 flex-wrap">
            <Link
              href="/projects"
              className="p-1 hover:bg-[var(--bg-secondary)] rounded-lg transition-colors flex-shrink-0"
              title="Back to projects"
            >
              <ArrowLeft className="w-4 h-4 text-[var(--text-muted)]" />
            </Link>
            <h1 className="text-xl sm:text-2xl font-bold text-[var(--text-primary)] min-w-0 truncate">{project.name}</h1>
            <button
              onClick={() => setShowEditModal(true)}
              className="p-1 hover:bg-[var(--bg-secondary)] rounded-lg transition-colors flex-shrink-0"
              title="Edit project"
            >
              <Pencil className="w-4 h-4 text-[var(--text-muted)]" />
            </button>
            <span
              className={clsx(
                'px-2 py-1 rounded-full text-xs font-medium transition-colors flex-shrink-0',
                statusLabel
                  ? {
                    'bg-blue-50 text-blue-700 border border-blue-200 dark:bg-blue-950/20 dark:border-blue-800 dark:text-blue-400':
                      statusLabel.color === 'blue',
                    'bg-amber-50 text-amber-700 border border-amber-200 dark:bg-amber-950/20 dark:border-amber-800 dark:text-amber-400':
                      statusLabel.color === 'amber',
                    'bg-green-50 text-green-700 border border-green-200 dark:bg-green-950/20 dark:border-green-800 dark:text-green-400':
                      statusLabel.color === 'green',
                    'bg-slate-100 text-slate-600 border border-slate-200 dark:bg-slate-800 dark:border-slate-700 dark:text-slate-400':
                      statusLabel.color === 'slate',
                  }
                  : 'bg-slate-100 text-slate-600'
              )}
            >
              {statusLabel?.emoji} {statusLabel?.label}
            </span>

            {/* Action buttons — inline with title on desktop, wrap on mobile */}
            <div className="flex items-center gap-2 ml-auto flex-shrink-0">
              {/* Start button — shown when project is stopped */}
              {(project as any).state === 'stopped' && (() => {
                const approvedThrough = project.autonomy?.approvedThrough;
                const hasApprovedUnshipped = approvedThrough && roadmapVersions.some(v =>
                  v.status !== 'shipped' && isVersionInHorizon(v.version, approvedThrough)
                );
                // If no currentVersion and no approved unshipped versions, disable start
                if (!currentVersion && (!hasApprovedUnshipped)) {
                  // Find the next unshipped version (first in roadmap order with status !== 'shipped').
                  const nextUnshipped = roadmapVersions.find((v) => v.status !== 'shipped');
                  return (
                    <div className="flex items-center gap-2">
                      {nextUnshipped ? (
                        <button
                          onClick={async () => {
                            try {
                              await fetch('/api/store', {
                                method: 'POST',
                                headers: { 'Content-Type': 'application/json' },
                                body: JSON.stringify({
                                  action: 'updateProject',
                                  id: projectId,
                                  updates: {
                                    autonomy: {
                                      ...(project.autonomy || {}),
                                      approvedThrough: nextUnshipped.version,
                                    },
                                  },
                                }),
                              });
                              // Then launch the next version (flips state to started + sets currentVersion).
                              await handleLaunch();
                            } catch (e) {
                              console.error('Failed to approve+start:', e);
                            }
                          }}
                          title={`Approve ${nextUnshipped.version} and start`}
                          className="px-4 py-2 bg-[var(--accent-primary)] text-white rounded-lg font-medium text-sm hover:opacity-90 flex items-center gap-2"
                        >
                          <span>✅</span>
                          Approve &amp; Start {nextUnshipped.version}
                        </button>
                      ) : (
                        <>
                          <button
                            disabled
                            title="Add versions to the roadmap to continue"
                            className="px-4 py-2 bg-[var(--bg-tertiary)] text-[var(--text-muted)] rounded-lg font-medium text-sm cursor-not-allowed flex items-center gap-2 opacity-60"
                          >
                            <span>▶️</span>
                            Start
                          </button>
                          <span className="text-[var(--text-xs)] text-[var(--text-muted)]">✅ All versions shipped</span>
                        </>
                      )}
                    </div>
                  );
                }
                return (
                  <button
                    onClick={async () => {
                      try {
                        // If there's a currentVersion already, just flip state
                        // Otherwise, also run handleLaunch to pick next version
                        if (currentVersion) {
                          await fetch('/api/store', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({
                              action: 'updateProject',
                              id: projectId,
                              updates: { state: 'started' },
                            }),
                          });
                        } else {
                          // Set started + launch next version
                          await fetch('/api/store', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({
                              action: 'updateProject',
                              id: projectId,
                              updates: { state: 'started' },
                            }),
                          });
                          await handleLaunch();
                        }
                      } catch (e) {
                        console.error('Failed to start project:', e);
                      }
                    }}
                    disabled={launching}
                    className="px-4 py-2 bg-[var(--accent-primary)] hover:bg-[var(--accent-hover)] text-white rounded-lg font-medium text-sm transition-all disabled:opacity-50 flex items-center gap-2"
                  >
                    {launching ? (
                      <>
                        <Loader className="w-4 h-4 animate-spin" />
                        Starting...
                      </>
                    ) : (
                      <>
                        <span>▶️</span>
                        Start
                      </>
                    )}
                  </button>
                );
              })()}
              {/* Start button for projects without explicit state (legacy/running) that have no currentVersion */}
              {(project as any).state !== 'stopped' && !currentVersion && roadmapVersions.length > 0 && (() => {
                const approvedThrough = project.autonomy?.approvedThrough;
                const hasApprovedUnshipped = approvedThrough && roadmapVersions.some(v =>
                  v.status !== 'shipped' && isVersionInHorizon(v.version, approvedThrough)
                );
                if (!hasApprovedUnshipped) {
                  const nextUnshipped = roadmapVersions.find((v) => v.status !== 'shipped');
                  return (
                    <div className="flex items-center gap-2">
                      {nextUnshipped ? (
                        <button
                          onClick={async () => {
                            try {
                              await fetch('/api/store', {
                                method: 'POST',
                                headers: { 'Content-Type': 'application/json' },
                                body: JSON.stringify({
                                  action: 'updateProject',
                                  id: projectId,
                                  updates: {
                                    autonomy: {
                                      ...(project.autonomy || {}),
                                      approvedThrough: nextUnshipped.version,
                                    },
                                  },
                                }),
                              });
                              await handleLaunch();
                            } catch (e) {
                              console.error('Failed to approve+start:', e);
                            }
                          }}
                          title={`Approve ${nextUnshipped.version} and start`}
                          className="px-4 py-2 bg-[var(--accent-primary)] text-white rounded-lg font-medium text-sm hover:opacity-90 flex items-center gap-2"
                        >
                          <span>✅</span>
                          Approve &amp; Start {nextUnshipped.version}
                        </button>
                      ) : (
                        <>
                          <button
                            disabled
                            title="Add versions to the roadmap to continue"
                            className="px-4 py-2 bg-[var(--bg-tertiary)] text-[var(--text-muted)] rounded-lg font-medium text-sm cursor-not-allowed flex items-center gap-2 opacity-60"
                          >
                            <span>▶️</span>
                            Start
                          </button>
                          <span className="text-[var(--text-xs)] text-[var(--text-muted)]">✅ All versions shipped</span>
                        </>
                      )}
                    </div>
                  );
                }
                return (
                  <button
                    onClick={handleLaunch}
                    disabled={launching}
                    className="px-4 py-2 bg-[var(--accent-primary)] hover:bg-[var(--accent-hover)] text-white rounded-lg font-medium text-sm transition-all disabled:opacity-50 flex items-center gap-2"
                  >
                    {launching ? (
                      <>
                        <Loader className="w-4 h-4 animate-spin" />
                        Starting...
                      </>
                    ) : (
                      <>
                        <span>▶️</span>
                        Start
                      </>
                    )}
                  </button>
                );
              })()}
              {/* Stop button — shown when project is running (state !== 'stopped') and has currentVersion */}
              {(project as any).state !== 'stopped' && currentVersion && (
                <button
                  onClick={async () => {
                    try {
                      await fetch('/api/store', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                          action: 'updateProject',
                          id: projectId,
                          updates: {
                            state: 'stopped',
                            // Preserve currentVersion — it's just "which version was in flight"
                          },
                        }),
                      });
                    } catch (e) {
                      console.error('Failed to stop project:', e);
                    }
                  }}
                  className="px-4 py-2 border border-red-200 dark:border-red-800/50 text-red-600 dark:text-red-400 rounded-lg font-medium hover:bg-red-50 dark:hover:bg-red-950/20 transition-all text-sm flex items-center gap-2"
                >
                  <span>⏹</span>
                  Stop
                </button>
              )}
            </div>
          </div>

          {/* Line 2: Vision owner (single line — devOwner/qaOwner moved to Components panel) */}
          {(project.visionOwner || project.owner) && (
            <div className="text-sm text-[var(--text-muted)] ml-6">
              Vision: <strong className="text-[var(--text-primary)]">{project.visionOwner || project.owner}</strong>
            </div>
          )}
        </div>

        {/* #1112 PR 3: Components Panel */}
        {components.length > 0 && (
          <div className="space-y-2">
            <h2 className="text-sm font-semibold text-[var(--text-secondary)] uppercase tracking-wide">Components</h2>
            <div className="rounded-xl border border-[var(--border-color)] bg-[var(--bg-secondary)] divide-y divide-[var(--border-color)]">
              {components.map((comp) => {
                const counts = getComponentCounts(projectTasks, comp.id, currentVersion);
                const icon = getComponentIcon(comp.role);
                return (
                  <div key={comp.id} className="group">
                    <button
                      onClick={() => handleOpenEditComponent(comp)}
                      className="w-full px-4 py-3 flex items-center gap-3 text-left hover:bg-[var(--bg-hover)] transition-colors"
                    >
                      <span className="text-base flex-shrink-0">{icon}</span>
                      <span className="font-medium text-[var(--text-primary)] min-w-[80px]">{comp.name}</span>
                      <span className="text-sm text-[var(--text-muted)] truncate">
                        {comp.owner}{comp.role ? ` · ${comp.role}` : ''}
                      </span>
                      <div className="ml-auto flex items-center gap-2 text-xs font-mono flex-shrink-0">
                        <span className={clsx(counts.backlog > 0 ? 'text-[var(--text-secondary)]' : 'text-[var(--text-muted)] opacity-40')}>{counts.backlog}b</span>
                        <span className={clsx(counts.inProgress > 0 ? 'text-blue-500' : 'text-[var(--text-muted)] opacity-40')}>{counts.inProgress}p</span>
                        <span className={clsx(counts.done > 0 ? 'text-green-500' : 'text-[var(--text-muted)] opacity-40')}>{counts.done}d</span>
                      </div>
                    </button>
                    {/* waitsFor chips */}
                    {comp.waitsFor && comp.waitsFor.length > 0 && (
                      <div className="px-4 pb-2 flex items-center gap-2 flex-wrap">
                        <span className="text-xs text-[var(--text-muted)]">⏳ waits for:</span>
                        {comp.waitsFor.map((w, wi) => {
                          const resolved = resolveWaitsForLabel(projectId, allProjects as any, w);
                          return (
                            <button
                              key={wi}
                              onClick={(e) => {
                                e.stopPropagation();
                                if (resolved.isCrossProject && resolved.targetProjectId) {
                                  router.push(`/projects/${resolved.targetProjectId}`);
                                } else {
                                  // Scroll to component row (same project)
                                  const el = document.getElementById(`comp-${w.componentId}`);
                                  el?.scrollIntoView({ behavior: 'smooth', block: 'center' });
                                }
                              }}
                              className="px-2 py-0.5 text-xs rounded-full bg-amber-100 dark:bg-amber-900/30 text-amber-700 dark:text-amber-300 border border-amber-200 dark:border-amber-800 hover:bg-amber-200 dark:hover:bg-amber-900/50 transition-colors"
                            >
                              {resolved.label}
                            </button>
                          );
                        })}
                      </div>
                    )}
                    {/* anchor for scroll-to */}
                    <div id={`comp-${comp.id}`} />
                  </div>
                );
              })}
            </div>
            <button
              onClick={() => setShowAddComponent(true)}
              className="flex items-center gap-1.5 text-sm text-[var(--accent-primary)] hover:text-[var(--accent-hover)] transition-colors font-medium"
            >
              <Plus size={14} />
              Add component
            </button>
          </div>
        )}

        {/* Add Component - inline if no components yet */}
        {components.length === 0 && (
          <button
            onClick={() => setShowAddComponent(true)}
            className="flex items-center gap-1.5 text-sm text-[var(--accent-primary)] hover:text-[var(--accent-hover)] transition-colors font-medium"
          >
            <Plus size={14} />
            Add first component
          </button>
        )}

        {/* #1112 PR 3: Board Filter Pills */}
        {components.length > 0 && (
          <div className="flex items-center gap-2 flex-wrap">
            <button
              onClick={() => setComponentFilter('all')}
              className={clsx(
                'px-3 py-1.5 rounded-full text-xs font-medium transition-colors border',
                activeComponentFilter === 'all'
                  ? 'bg-[var(--accent-primary)] text-white border-transparent'
                  : 'bg-[var(--bg-secondary)] text-[var(--text-secondary)] border-[var(--border-color)] hover:bg-[var(--bg-hover)]'
              )}
            >
              All
            </button>
            {(() => {
              // #1112 PR 3 follow-up: the primary component (first non-QA, non-support) absorbs
              // untagged tasks for display count, matching how the roadmap filter behaves.
              const primaryCompId = components.find((c: any) => !c.role || (c.role !== 'qa' && c.role !== 'support'))?.id;
              return components.map((comp) => {
                const counts = getComponentCounts(projectTasks, comp.id, currentVersion);
                let total = getComponentTotalCount(counts);
                if (comp.id === primaryCompId) {
                  const untagged = projectTasks.filter((t: any) => !t.sectionId && (!currentVersion || t.version === currentVersion));
                  total += untagged.length;
                }
                return (
                  <button
                    key={comp.id}
                    onClick={() => setComponentFilter(comp.id)}
                    className={clsx(
                      'px-3 py-1.5 rounded-full text-xs font-medium transition-colors border',
                      activeComponentFilter === comp.id
                        ? 'bg-[var(--accent-primary)] text-white border-transparent'
                        : 'bg-[var(--bg-secondary)] text-[var(--text-secondary)] border-[var(--border-color)] hover:bg-[var(--bg-hover)]'
                    )}
                  >
                    {comp.name} {total > 0 && <span className="ml-1 opacity-70">{total}</span>}
                  </button>
                );
              });
            })()}
          </div>
        )}

        {/* No Roadmap Banner (#697) */}
        {!roadmapLoading && roadmapVersions.length === 0 && (
          <div className="rounded-lg border border-amber-300 bg-amber-50 dark:bg-amber-950/30 dark:border-amber-700 p-4 flex items-center justify-between gap-4">
            <div>
              <p className="text-amber-800 dark:text-amber-300 font-medium">
                This project has no roadmap. Propose one to start dispatching work.
              </p>
              {proposingError && (
                <p className="text-red-600 dark:text-red-400 text-sm mt-1">{proposingError}</p>
              )}
            </div>
            <button
              disabled={proposingRoadmap}
              onClick={async () => {
                setProposingRoadmap(true);
                setProposingError(null);
                try {
                  const res = await fetch(`/api/roadmap/${projectId}`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                      action: 'upsert',
                      version: '0.1',
                      title: '',
                      status: 'planned',
                      items: [],
                    }),
                  });
                  if (!res.ok) {
                    const data = await res.json().catch(() => ({}));
                    throw new Error(data.error || `HTTP ${res.status}`);
                  }
                  // Refresh roadmap data
                  const rmRes = await fetch(`/api/roadmap/${projectId}`);
                  if (rmRes.ok) {
                    const rmData = await rmRes.json();
                    setRoadmap(rmData.versions || []);
                  }
                } catch (e: any) {
                  setProposingError(e.message || 'Failed to propose roadmap');
                } finally {
                  setProposingRoadmap(false);
                }
              }}
              className="px-4 py-2 rounded-lg bg-amber-600 hover:bg-amber-700 text-white font-medium text-sm whitespace-nowrap disabled:opacity-60 transition-colors"
            >
              {proposingRoadmap ? 'Proposing roadmap…' : 'Propose roadmap'}
            </button>
          </div>
        )}


        {/* Roadmap Section with Approval Horizon */}
        <div className="space-y-4">
          {roadmapLoading ? (
            <div className="flex items-center justify-center py-8">
              <Loader className="w-5 h-5 animate-spin text-[var(--text-muted)]" />
            </div>
          ) : (
            <RoadmapWithApprovalHorizon
              projectId={projectId}
              project={project}
              versions={roadmapVersions}
              tasks={allTasks}
              onVersionsChange={setRoadmap}
              componentFilter={activeComponentFilter}
              selectedTask={selectedTask}
              onTaskSelect={(task) => {
                setSelectedTask(task);
                setShowDetailPanel(true);
              }}
            />
          )}
        </div>

        {/* Vision Document (collapsed by default during execution) */}
        <details open={!currentVersion} className="rounded-2xl border border-[var(--border-color)] overflow-hidden group">
          <summary className="cursor-pointer py-4 px-6 flex items-center gap-2 text-sm font-semibold text-[var(--text-primary)] bg-[var(--bg-secondary)] hover:bg-[var(--bg-hover)] transition-colors select-none list-none">
            <ChevronRight size={14} className="text-[var(--text-muted)] group-open:rotate-90 transition-transform" />
            Vision Document
            <button
              onClick={(e) => {
                e.preventDefault();
                setEditingVision(true);
                setVisionEditContent(visionDoc);
              }}
              className="ml-auto p-1 hover:bg-[var(--bg-primary)] rounded transition-colors"
              title="Edit vision document"
            >
              <Pencil size={12} className="text-[var(--text-muted)]" />
            </button>
          </summary>

          <div className="border-t border-[var(--border-color)] p-6 space-y-4">
            {visionLoading ? (
              <div className="flex items-center justify-center py-8">
                <Loader className="w-5 h-5 animate-spin text-[var(--text-muted)]" />
              </div>
            ) : editingVision ? (
              <div className="space-y-3">
                <textarea
                  value={visionEditContent}
                  onChange={(e) => setVisionEditContent(e.target.value)}
                  className="w-full px-4 py-2 bg-[var(--bg-secondary)] border border-[var(--border-color)] rounded-lg text-[var(--text-primary)] font-mono text-sm focus:outline-none focus:border-[var(--accent)]"
                  style={{ minHeight: '300px', resize: 'vertical' }}
                  placeholder="Enter vision document in markdown..."
                />
                <div className="flex gap-2">
                  <button
                    onClick={handleSaveVision}
                    disabled={visionSaving}
                    className="px-4 py-2 bg-[var(--accent)] text-white rounded-lg font-medium hover:opacity-90 transition-opacity disabled:opacity-50"
                  >
                    {visionSaving ? 'Saving...' : 'Save'}
                  </button>
                  <button
                    onClick={() => setEditingVision(false)}
                    className="px-4 py-2 bg-[var(--bg-tertiary)] text-[var(--text-secondary)] rounded-lg font-medium hover:bg-[var(--bg-hover)] transition-colors"
                  >
                    Cancel
                  </button>
                </div>
              </div>
            ) : (
              <div className="prose prose-sm max-w-none dark:prose-invert text-[var(--text-primary)]">
                {visionDoc ? (
                  <ReactMarkdown
                    remarkPlugins={[remarkGfm]}
                    components={{
                      h1: ({ children }) => (
                        <h1 className="text-xl font-bold text-[var(--text-primary)] mt-0 mb-4 pb-2 border-b border-[var(--border-subtle)]">
                          {children}
                        </h1>
                      ),
                      h2: ({ children }) => (
                        <h2 className="text-base font-bold text-[var(--text-primary)] mt-8 mb-3 pb-1.5 border-b border-[var(--border-subtle)]">
                          {children}
                        </h2>
                      ),
                      h3: ({ children }) => (
                        <h3 className="text-sm font-bold text-[var(--text-secondary)] mt-5 mb-2">
                          {children}
                        </h3>
                      ),
                      p: ({ children }) => (
                        <p className="text-sm text-[var(--text-secondary)] leading-relaxed mb-3">
                          {children}
                        </p>
                      ),
                      ul: ({ children }) => (
                        <ul className="text-sm text-[var(--text-secondary)] leading-relaxed mb-3 pl-4 space-y-1 list-disc">
                          {children}
                        </ul>
                      ),
                      ol: ({ children }) => (
                        <ol className="text-sm text-[var(--text-secondary)] leading-relaxed mb-3 pl-4 space-y-1 list-decimal">
                          {children}
                        </ol>
                      ),
                      li: ({ children }) => (
                        <li className="text-sm text-[var(--text-secondary)] leading-relaxed">
                          {children}
                        </li>
                      ),
                      strong: ({ children }) => (
                        <strong className="font-semibold text-[var(--text-primary)]">{children}</strong>
                      ),
                      em: ({ children }) => (
                        <span className="text-[var(--text-muted)]">{children}</span>
                      ),
                      a: ({ href, children }) => (
                        <a href={href} className="text-[var(--accent)] hover:underline" target="_blank" rel="noopener noreferrer">
                          {children}
                        </a>
                      ),
                      code: ({ children, className }) => {
                        const isBlock = className?.includes('language-');
                        if (isBlock) {
                          return (
                            <code className="block bg-[var(--bg-secondary)] rounded-md p-3 text-[11px] font-mono text-[var(--text-secondary)] overflow-x-auto mb-3">
                              {children}
                            </code>
                          );
                        }
                        return (
                          <code className="bg-[var(--bg-tertiary)] px-1.5 py-0.5 rounded text-[11px] font-mono text-[var(--text-secondary)]">
                            {children}
                          </code>
                        );
                      },
                      pre: ({ children }) => (
                        <pre className="bg-[var(--bg-secondary)] rounded-md p-4 overflow-x-auto mb-4 border border-[var(--border-subtle)]">
                          {children}
                        </pre>
                      ),
                      table: ({ children }) => (
                        <table className="border-collapse border border-[var(--border-subtle)] mb-3">
                          {children}
                        </table>
                      ),
                      thead: ({ children }) => (
                        <thead className="bg-[var(--bg-secondary)]">{children}</thead>
                      ),
                      tbody: ({ children }) => (
                        <tbody>{children}</tbody>
                      ),
                      tr: ({ children }) => (
                        <tr className="border-b border-[var(--border-subtle)]">{children}</tr>
                      ),
                      th: ({ children }) => (
                        <th className="text-left text-[var(--text-primary)] font-semibold p-2 border-r border-[var(--border-subtle)]">
                          {children}
                        </th>
                      ),
                      td: ({ children }) => (
                        <td className="text-sm text-[var(--text-secondary)] p-2 border-r border-[var(--border-subtle)]">
                          {children}
                        </td>
                      ),
                      blockquote: ({ children }) => (
                        <blockquote className="border-l-4 border-[var(--accent)] pl-4 italic text-[var(--text-muted)] my-4">
                          {children}
                        </blockquote>
                      ),
                    }}
                  >
                    {visionDoc}
                  </ReactMarkdown>
                ) : (
                  <p className="text-[var(--text-muted)]">No vision document yet</p>
                )}
              </div>
            )}
          </div>
        </details>


        {/* Guardrails Section */}
        <details open className="rounded-2xl border border-[var(--border-color)] overflow-hidden group">
          <summary className="cursor-pointer py-4 px-6 flex items-center justify-between text-sm font-semibold text-[var(--text-primary)] bg-[var(--bg-secondary)] hover:bg-[var(--bg-hover)] transition-colors select-none list-none">
            <div className="flex items-center gap-2">
              <ChevronRight size={14} className="text-[var(--text-muted)] group-open:rotate-90 transition-transform" />
              Guardrails
            </div>
            <button
              onClick={(e) => {
                e.preventDefault();
                setEditingGuardrails(true);
                setGuardrailsEditContent(project.guardrails || '');
              }}
              className="p-1 hover:bg-[var(--bg-primary)] rounded transition-colors"
              title="Edit guardrails"
            >
              <Pencil size={12} className="text-[var(--text-muted)]" />
            </button>
          </summary>

          <div className="border-t border-[var(--border-color)] p-6 space-y-4">
            {editingGuardrails ? (
              <div className="space-y-3">
                <textarea
                  value={guardrailsEditContent}
                  onChange={(e) => setGuardrailsEditContent(e.target.value)}
                  className="w-full px-4 py-2 bg-[var(--bg-secondary)] border border-[var(--border-color)] rounded-lg text-[var(--text-primary)] font-mono text-sm focus:outline-none focus:border-[var(--accent)]"
                  style={{ minHeight: '200px', resize: 'vertical' }}
                  placeholder={`What should agents NOT do?
- No breaking changes to existing APIs
- No third-party integrations without approval

What makes a good proposal?
- Names the specific user who benefits
- Can be demonstrated in under 2 minutes`}
                />
                <div className="flex flex-col sm:flex-row gap-2">
                  <button
                    onClick={handleSaveGuardrails}
                    disabled={guardrailsSaving}
                    className="flex-1 px-4 py-2 bg-[var(--accent)] text-white rounded-lg font-medium hover:opacity-90 transition-opacity disabled:opacity-50 text-sm"
                  >
                    {guardrailsSaving ? 'Saving...' : 'Save'}
                  </button>
                  <button
                    onClick={() => setEditingGuardrails(false)}
                    className="flex-1 px-4 py-2 bg-[var(--bg-tertiary)] text-[var(--text-secondary)] rounded-lg font-medium hover:bg-[var(--bg-hover)] transition-colors text-sm"
                  >
                    Cancel
                  </button>
                </div>
              </div>
            ) : (
              <div className="prose prose-sm max-w-none dark:prose-invert">
                {project.guardrails ? (
                  <div className="text-sm text-[var(--text-secondary)] whitespace-pre-wrap bg-[var(--bg-secondary)] p-4 rounded-lg border border-[var(--border-color)]">
                    {project.guardrails}
                  </div>
                ) : (
                  <p className="text-sm text-[var(--text-muted)]">
                    No guardrails defined.{' '}
                    <button
                      onClick={() => {
                        setEditingGuardrails(true);
                        setGuardrailsEditContent('');
                      }}
                      className="text-[var(--accent-primary)] hover:underline font-medium"
                    >
                      Set guardrails
                    </button>
                  </p>
                )}
              </div>
            )}
          </div>
        </details>

        {/* #1112 PR 3: Legacy owners drawer (conditional) */}
        {shouldShowLegacyDrawer(project as any) && (
          <details className="text-sm text-[var(--text-muted)]">
            <summary className="cursor-pointer select-none hover:text-[var(--text-secondary)] transition-colors">
              ▸ Legacy owners (read-only)
            </summary>
            <div className="mt-2 ml-4 space-y-1 border-l-2 border-[var(--border-color)] pl-3">
              {project.devOwner && <p>Dev Owner: <strong className="text-[var(--text-primary)]">{project.devOwner}</strong></p>}
              {project.qaOwner && <p>QA Owner: <strong className="text-[var(--text-primary)]">{project.qaOwner}</strong></p>}
              <p className="text-xs text-[var(--text-muted)] mt-2 italic">
                Superseded by Components panel. Kept for historical context; edit via Components going forward.
              </p>
            </div>
          </details>
        )}

        {/* Danger Zone */}
        <div className="rounded-2xl border border-red-200/50 dark:border-red-800/30 overflow-hidden">
          <div className="h-1 bg-red-500 dark:bg-red-400" />
          <div className="p-6 space-y-4 bg-[var(--bg-primary)]">
            <div className="flex items-center gap-2">
              <span className="text-lg">⚠️</span>
              <h2 className="font-semibold text-red-700 dark:text-red-400">Danger Zone</h2>
            </div>
            <p className="text-sm text-red-600 dark:text-red-300">
              Archive this project to hide it from the sidebar and home. You can unarchive it later.
            </p>
            <button
              onClick={() => setShowArchiveModal(true)}
              className="px-4 py-2.5 border border-red-200 dark:border-red-800/50 text-red-600 dark:text-red-400 rounded-xl font-medium hover:bg-red-50 dark:hover:bg-red-950/20 transition-all duration-200 text-sm flex items-center gap-2"
            >
              <Archive className="w-4 h-4" />
              Archive Project
            </button>
          </div>
        </div>
      </div>

      {/* Archive Project Modal */}
      {showArchiveModal && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
          <div className="bg-[var(--card)] border border-[var(--border-default)] rounded-[var(--radius-lg)] p-6 max-w-md w-full mx-4 shadow-lg">
            <h2 className="text-lg font-semibold text-[var(--text-primary)] mb-4">
              Archive {project.name}?
            </h2>
            <p className="text-sm text-[var(--text-secondary)] mb-6">
              It will be hidden from the sidebar and Home but all data is preserved. You can unarchive anytime.
            </p>

            <div className="flex items-center gap-2">
              <button
                onClick={() => setShowArchiveModal(false)}
                className="flex-1 px-4 py-2 bg-[var(--bg-tertiary)] text-[var(--text-secondary)] rounded-[var(--radius-md)] font-medium hover:bg-[var(--bg-hover)] transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={handleArchiveProject}
                disabled={archiving}
                className="flex-1 px-4 py-2 bg-red-600 text-white rounded-[var(--radius-md)] font-medium hover:bg-red-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {archiving ? 'Archiving...' : 'Archive'}
              </button>
            </div>
          </div>
        </div>
      )}

      {showEditModal && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
          <div className="bg-[var(--card)] border border-[var(--border-default)] rounded-[var(--radius-lg)] p-6 max-w-md w-full mx-4 shadow-lg">
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-lg font-semibold text-[var(--text-primary)]">Edit Project</h2>
              <button
                onClick={() => setShowEditModal(false)}
                className="p-1 hover:bg-[var(--bg-hover)] rounded transition-colors"
              >
                <X size={18} />
              </button>
            </div>

            <div className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-[var(--text-secondary)] mb-1">
                  Project Name *
                </label>
                <input
                  type="text"
                  value={editProject.name}
                  onChange={(e) => setEditProject({ ...editProject, name: e.target.value })}
                  className="w-full px-3 py-2 bg-[var(--bg-primary)] border border-[var(--border-default)] rounded-[var(--radius-md)] text-sm text-[var(--text-primary)] focus:outline-none focus:border-[var(--accent-primary)]"
                />
              </div>

              <div>
                <label className="block text-sm font-medium text-[var(--text-secondary)] mb-1">
                  Lifecycle
                </label>
                <select
                  value={editProject.lifecycle}
                  onChange={(e) => setEditProject({ ...editProject, lifecycle: e.target.value })}
                  className="w-full px-3 py-2 bg-[var(--bg-primary)] border border-[var(--border-default)] rounded-[var(--radius-md)] text-sm text-[var(--text-primary)] focus:outline-none focus:border-[var(--accent-primary)]"
                >
                  <option value="building">🏗️ Building</option>
                  <option value="mature">📦 Mature</option>
                  <option value="bau">🔄 BAU</option>
                  <option value="sunset">🌅 Sunset</option>
                </select>
              </div>

              <div>
                <label className="block text-sm font-medium text-[var(--text-secondary)] mb-1">
                  Vision Owner *
                </label>
                <select
                  value={editProject.visionOwner}
                  onChange={(e) => setEditProject({ ...editProject, visionOwner: e.target.value })}
                  className="w-full px-3 py-2 bg-[var(--bg-primary)] border border-[var(--border-default)] rounded-[var(--radius-md)] text-sm text-[var(--text-primary)] focus:outline-none focus:border-[var(--accent-primary)]"
                >
                  {(storeData?.settings?.teammates || []).map((teammate: any) => (
                    <option key={teammate.id} value={teammate.name}>
                      {teammate.name}
                    </option>
                  ))}
                </select>
                <p className="text-xs text-[var(--text-muted)] mt-1">Component owners are managed in the Components panel below.</p>
              </div>
            </div>

            <div className="flex items-center gap-2 mt-6">
              <button
                onClick={handleSaveProject}
                disabled={!editProject.name.trim() || !editProject.visionOwner || editLoading}
                className="flex-1 px-4 py-2 bg-[var(--accent-primary)] text-white rounded-[var(--radius-md)] font-medium hover:bg-[var(--accent-hover)] transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {editLoading ? 'Saving...' : 'Save'}
              </button>
              <button
                onClick={() => setShowEditModal(false)}
                className="flex-1 px-4 py-2 bg-[var(--bg-tertiary)] text-[var(--text-secondary)] rounded-[var(--radius-md)] font-medium hover:bg-[var(--bg-hover)] transition-colors"
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}

      {/* #1112 PR 3: Add Component Modal */}
      {showAddComponent && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
          <div className="bg-[var(--card)] border border-[var(--border-default)] rounded-[var(--radius-lg)] p-6 max-w-sm w-full mx-4 shadow-lg">
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-lg font-semibold text-[var(--text-primary)]">Add Component</h2>
              <button onClick={() => setShowAddComponent(false)} className="p-1 hover:bg-[var(--bg-hover)] rounded transition-colors">
                <X size={18} />
              </button>
            </div>
            <div className="space-y-3">
              <div>
                <label className="block text-sm font-medium text-[var(--text-secondary)] mb-1">Name *</label>
                <input
                  type="text"
                  value={newComponent.name}
                  onChange={(e) => setNewComponent({ ...newComponent, name: e.target.value })}
                  placeholder="e.g. Frontend, Backend, QA"
                  className="w-full px-3 py-2 bg-[var(--bg-primary)] border border-[var(--border-default)] rounded-[var(--radius-md)] text-sm text-[var(--text-primary)] focus:outline-none focus:border-[var(--accent-primary)]"
                  autoFocus
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-[var(--text-secondary)] mb-1">Owner</label>
                <select
                  value={newComponent.owner}
                  onChange={(e) => setNewComponent({ ...newComponent, owner: e.target.value })}
                  className="w-full px-3 py-2 bg-[var(--bg-primary)] border border-[var(--border-default)] rounded-[var(--radius-md)] text-sm text-[var(--text-primary)] focus:outline-none focus:border-[var(--accent-primary)]"
                >
                  <option value="">Select owner...</option>
                  {(storeData?.settings?.teammates || []).map((teammate: any) => (
                    <option key={teammate.id} value={teammate.name}>{teammate.name}</option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-sm font-medium text-[var(--text-secondary)] mb-1">Role</label>
                <input
                  type="text"
                  value={newComponent.role}
                  onChange={(e) => setNewComponent({ ...newComponent, role: e.target.value })}
                  placeholder="e.g. dev, qa, design, backend"
                  className="w-full px-3 py-2 bg-[var(--bg-primary)] border border-[var(--border-default)] rounded-[var(--radius-md)] text-sm text-[var(--text-primary)] focus:outline-none focus:border-[var(--accent-primary)]"
                />
              </div>
            </div>
            <div className="flex items-center gap-2 mt-4">
              <button
                onClick={handleAddComponent}
                disabled={!newComponent.name.trim() || addingComponent}
                className="flex-1 px-4 py-2 bg-[var(--accent-primary)] text-white rounded-[var(--radius-md)] font-medium hover:bg-[var(--accent-hover)] transition-colors disabled:opacity-50"
              >
                {addingComponent ? 'Adding...' : 'Add'}
              </button>
              <button
                onClick={() => setShowAddComponent(false)}
                className="flex-1 px-4 py-2 bg-[var(--bg-tertiary)] text-[var(--text-secondary)] rounded-[var(--radius-md)] font-medium hover:bg-[var(--bg-hover)] transition-colors"
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}

      {/* #1112 PR 3: Edit Component Drawer (right panel) */}
      {editingComponent && (
        <>
          <div
            className="fixed inset-0 z-40 bg-black/40 backdrop-blur-[2px] transition-opacity duration-200"
            onClick={() => setEditingComponent(null)}
          />
          <div className="fixed top-0 right-0 z-50 h-full w-[480px] max-w-[90vw] bg-[var(--bg-primary)] border-l border-[var(--border-color)] overflow-y-auto shadow-xl">
            <div className="p-6 space-y-5">
              <div className="flex items-center justify-between">
                <h2 className="text-lg font-semibold text-[var(--text-primary)]">Edit Component</h2>
                <div className="flex items-center gap-2">
                  <button
                    onClick={() => handleDeleteComponent(editingComponent)}
                    className="p-1.5 text-red-500 hover:bg-red-50 dark:hover:bg-red-950/30 rounded transition-colors"
                    title="Delete component"
                  >
                    <Trash2 size={16} />
                  </button>
                  <button onClick={() => setEditingComponent(null)} className="p-1.5 hover:bg-[var(--bg-hover)] rounded transition-colors">
                    <X size={18} />
                  </button>
                </div>
              </div>

              <div className="space-y-4">
                <div>
                  <label className="block text-sm font-medium text-[var(--text-secondary)] mb-1">Name</label>
                  <input
                    type="text"
                    value={editComponentForm.name}
                    onChange={(e) => setEditComponentForm({ ...editComponentForm, name: e.target.value })}
                    className="w-full px-3 py-2 bg-[var(--bg-secondary)] border border-[var(--border-default)] rounded-[var(--radius-md)] text-sm text-[var(--text-primary)] focus:outline-none focus:border-[var(--accent-primary)]"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-[var(--text-secondary)] mb-1">Owner</label>
                  <select
                    value={editComponentForm.owner}
                    onChange={(e) => setEditComponentForm({ ...editComponentForm, owner: e.target.value })}
                    className="w-full px-3 py-2 bg-[var(--bg-secondary)] border border-[var(--border-default)] rounded-[var(--radius-md)] text-sm text-[var(--text-primary)] focus:outline-none focus:border-[var(--accent-primary)]"
                  >
                    <option value="">Select owner...</option>
                    {(storeData?.settings?.teammates || []).map((teammate: any) => (
                      <option key={teammate.id} value={teammate.name}>{teammate.name}</option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="block text-sm font-medium text-[var(--text-secondary)] mb-1">Role</label>
                  <input
                    type="text"
                    value={editComponentForm.role}
                    onChange={(e) => setEditComponentForm({ ...editComponentForm, role: e.target.value })}
                    placeholder="e.g. dev, qa, design, backend"
                    className="w-full px-3 py-2 bg-[var(--bg-secondary)] border border-[var(--border-default)] rounded-[var(--radius-md)] text-sm text-[var(--text-primary)] focus:outline-none focus:border-[var(--accent-primary)]"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-[var(--text-secondary)] mb-1">Outcomes</label>
                  <textarea
                    value={editComponentForm.outcomes}
                    onChange={(e) => setEditComponentForm({ ...editComponentForm, outcomes: e.target.value })}
                    placeholder="What this component exists to deliver..."
                    className="w-full px-3 py-2 bg-[var(--bg-secondary)] border border-[var(--border-default)] rounded-[var(--radius-md)] text-sm text-[var(--text-primary)] focus:outline-none focus:border-[var(--accent-primary)] min-h-[80px] resize-y"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-[var(--text-secondary)] mb-1">Contract</label>
                  <textarea
                    value={editComponentForm.contract}
                    onChange={(e) => setEditComponentForm({ ...editComponentForm, contract: e.target.value })}
                    placeholder="What it gives to / expects from other components..."
                    className="w-full px-3 py-2 bg-[var(--bg-secondary)] border border-[var(--border-default)] rounded-[var(--radius-md)] text-sm text-[var(--text-primary)] focus:outline-none focus:border-[var(--accent-primary)] min-h-[80px] resize-y"
                  />
                </div>

                {/* waitsFor editor */}
                <div>
                  <label className="block text-sm font-medium text-[var(--text-secondary)] mb-2">Waits For</label>
                  <div className="space-y-2">
                    {editComponentForm.waitsFor.map((w, idx) => {
                      // Build component options grouped by project
                      const currentComponents = components.filter(c => c.id !== editingComponent);
                      const otherProjects = (storeData?.projects || []).filter((p: any) => p.id !== projectId && !p.isArchived);
                      return (
                        <div key={idx} className="flex items-center gap-2">
                          <select
                            value={w.projectId ? `${w.projectId}:${w.componentId}` : w.componentId}
                            onChange={(e) => {
                              const val = e.target.value;
                              const updated = [...editComponentForm.waitsFor];
                              if (val.includes(':')) {
                                const [pId, cId] = val.split(':');
                                updated[idx] = { ...updated[idx], componentId: cId, projectId: pId };
                              } else {
                                updated[idx] = { ...updated[idx], componentId: val, projectId: undefined };
                              }
                              setEditComponentForm({ ...editComponentForm, waitsFor: updated });
                            }}
                            className="flex-1 px-2 py-1.5 bg-[var(--bg-secondary)] border border-[var(--border-default)] rounded text-xs text-[var(--text-primary)] focus:outline-none"
                          >
                            <option value="">Select component...</option>
                            {currentComponents.length > 0 && (
                              <optgroup label="This project">
                                {currentComponents.map(c => (
                                  <option key={c.id} value={c.id}>{c.name}</option>
                                ))}
                              </optgroup>
                            )}
                            {otherProjects.map((p: any) => {
                              const pComps = getEffectiveComponents(p);
                              if (pComps.length === 0) return null;
                              return (
                                <optgroup key={p.id} label={p.name}>
                                  {pComps.map((c: any) => (
                                    <option key={`${p.id}:${c.id}`} value={`${p.id}:${c.id}`}>{c.name}</option>
                                  ))}
                                </optgroup>
                              );
                            })}
                          </select>
                          <span className="text-xs text-[var(--text-muted)]">@</span>
                          <input
                            type="text"
                            value={w.version}
                            onChange={(e) => {
                              const updated = [...editComponentForm.waitsFor];
                              updated[idx] = { ...updated[idx], version: e.target.value };
                              setEditComponentForm({ ...editComponentForm, waitsFor: updated });
                            }}
                            placeholder="0.14.0"
                            className="w-24 px-2 py-1.5 bg-[var(--bg-secondary)] border border-[var(--border-default)] rounded text-xs text-[var(--text-primary)] focus:outline-none"
                          />
                          <button
                            onClick={() => {
                              const updated = editComponentForm.waitsFor.filter((_, i) => i !== idx);
                              setEditComponentForm({ ...editComponentForm, waitsFor: updated });
                            }}
                            className="p-1 text-red-400 hover:text-red-500 transition-colors"
                          >
                            <X size={14} />
                          </button>
                        </div>
                      );
                    })}
                    <button
                      onClick={() => {
                        setEditComponentForm({
                          ...editComponentForm,
                          waitsFor: [...editComponentForm.waitsFor, { componentId: '', version: '' }],
                        });
                      }}
                      className="flex items-center gap-1 text-xs text-[var(--accent-primary)] hover:text-[var(--accent-hover)] transition-colors"
                    >
                      <Plus size={12} />
                      Add waitsFor
                    </button>
                  </div>
                </div>
              </div>

              <div className="flex items-center gap-2 pt-2 border-t border-[var(--border-color)]">
                <button
                  onClick={handleSaveComponent}
                  disabled={!editComponentForm.name.trim() || savingComponent}
                  className="flex-1 px-4 py-2 bg-[var(--accent-primary)] text-white rounded-[var(--radius-md)] font-medium hover:bg-[var(--accent-hover)] transition-colors disabled:opacity-50"
                >
                  {savingComponent ? 'Saving...' : 'Save'}
                </button>
                <button
                  onClick={() => setEditingComponent(null)}
                  className="flex-1 px-4 py-2 bg-[var(--bg-tertiary)] text-[var(--text-secondary)] rounded-[var(--radius-md)] font-medium hover:bg-[var(--bg-hover)] transition-colors"
                >
                  Cancel
                </button>
              </div>
            </div>
          </div>
        </>
      )}

      {/* Task Detail Panel */}
      {showDetailPanel && selectedTask && (
        <TaskDetailPanel
          task={selectedTask}
          projects={storeData?.projects || []}
          agents={storeData?.settings?.teammates?.map((t: any) => t.name) || []}
          nameColors={{}}
          qaLead={project?.qaLead}
          onUpdate={async (id, updates) => {
            await updateTask(id, updates);
          }}
          onDelete={async (id) => {
            await deleteTask(id);
          }}
          onAddComment={async (taskId, comment) => {
            const result = await addTaskComment(taskId, comment);
            return result;
          }}
          onClose={() => setShowDetailPanel(false)}
        />
      )}
    </div>
  );
}
