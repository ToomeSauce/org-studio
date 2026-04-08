'use client';

import { useState, useEffect, Suspense } from 'react';
import Link from 'next/link';
import { clsx } from 'clsx';
import { Plus, X, ChevronDown, Trash2, RotateCcw } from 'lucide-react';
import { useWSData } from '@/lib/ws';
import { getProjectStatusLabel } from '@/lib/vision-status';
import { useSearchParams, useRouter } from 'next/navigation';

interface Project {
  id: string;
  name: string;
  owner?: string;
  devOwner?: string;
  currentVersion?: string;
  isArchived?: boolean;
  archivedAt?: number;
  autonomy?: any;
  [key: string]: any;
}

interface Task {
  id: string;
  projectId: string;
  isArchived?: boolean;
  [key: string]: any;
}

function ProjectsContent() {
  const storeData = useWSData('store');
  const projects = (storeData?.projects || []) as Project[];
  const allTasks = (storeData?.tasks || []) as Task[];
  const searchParams = useSearchParams();
  const router = useRouter();
  const [showNewProjectModal, setShowNewProjectModal] = useState(false);
  const [creating, setCreating] = useState(false);
  const [expandedArchived, setExpandedArchived] = useState(false);
  const [showDeleteModal, setShowDeleteModal] = useState(false);
  const [deleteProjectId, setDeleteProjectId] = useState<string | null>(null);
  const [deleteConfirmText, setDeleteConfirmText] = useState('');
  const [deleting, setDeleting] = useState(false);
  const [wizardStep, setWizardStep] = useState(1);
  const [newProject, setNewProject] = useState({
    name: '',
    lifecycle: 'building',
    devOwner: '',
    visionOwner: '',
    qaOwner: '',
    vision: `## North Star
<!-- What does the world look like when this project is fully realized? -->

## Current State
<!-- Where are we today? What's the gap between here and the North Star? -->`,
    outcomes: [''],
    guardrails: '',
  });

  useEffect(() => {
    if (searchParams.get('new') === 'true') {
      setShowNewProjectModal(true);
    }
  }, [searchParams]);

  useEffect(() => {
    // Auto-fill vision owner and dev owner with first teammate if not set
    if (showNewProjectModal && (storeData?.settings?.teammates?.length > 0)) {
      const firstTeammate = storeData.settings.teammates[0];
      if (!newProject.visionOwner && firstTeammate) {
        setNewProject(prev => ({ ...prev, visionOwner: firstTeammate.name }));
      }
      if (!newProject.devOwner && firstTeammate) {
        setNewProject(prev => ({ ...prev, devOwner: firstTeammate.name }));
      }
    }
  }, [showNewProjectModal, storeData?.settings?.teammates]);

  const getProjectStats = (projectId: string) => {
    const tasks = allTasks.filter((t) => t.projectId === projectId && !t.isArchived);
    const done = tasks.filter((t) => t.status === 'done').length;
    const total = tasks.length;
    return { done, total };
  };

  const handleCreateProject = async () => {
    if (!newProject.name.trim()) return;
    setCreating(true);
    try {
      // Step 1: Create the project
      const createResp = await fetch('/api/store', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'addProject',
          project: {
            name: newProject.name,
            lifecycle: newProject.lifecycle,
            devOwner: newProject.devOwner || undefined,
            owner: newProject.visionOwner || undefined,
            visionOwner: newProject.visionOwner || undefined,
            qaOwner: newProject.qaOwner || undefined,
          },
        }),
      });

      if (!createResp.ok) throw new Error('Failed to create project');
      const { project } = await createResp.json();

      // Step 2: Save vision if provided
      if (newProject.vision.trim()) {
        const visionContent = `# Vision\n\n${newProject.vision}`;
        await fetch(`/api/vision/${project.id}/doc`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ content: visionContent }),
        }).catch(e => console.warn('Vision save failed:', e));
      }

      // Step 3: Add outcomes if provided
      for (const outcome of newProject.outcomes) {
        if (outcome.trim()) {
          await fetch('/api/store', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              action: 'addOutcome',
              projectId: project.id,
              outcome: { text: outcome },
            }),
          }).catch(e => console.warn('Outcome save failed:', e));
        }
      }

      // Step 4: Save guardrails if provided
      if (newProject.guardrails.trim()) {
        await fetch('/api/store', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            action: 'updateGuardrails',
            projectId: project.id,
            guardrails: newProject.guardrails,
          }),
        }).catch(e => console.warn('Guardrails save failed:', e));
      }

      setShowNewProjectModal(false);
      setWizardStep(1);
      setNewProject({
        name: '',
        lifecycle: 'building',
        devOwner: '',
        visionOwner: '',
        qaOwner: '',
        vision: `## North Star
<!-- What does the world look like when this project is fully realized? -->

## Current State
<!-- Where are we today? What's the gap between here and the North Star? -->`,
        outcomes: [''],
        guardrails: '',
      });
    } finally {
      setCreating(false);
    }
  };

  const handleUnarchiveProject = async (projectId: string) => {
    try {
      await fetch('/api/store', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'updateProject',
          id: projectId,
          updates: {
            isArchived: false,
            archivedAt: null,
          },
        }),
      });
    } catch (e) {
      console.error('Failed to unarchive project:', e);
    }
  };

  const handleDeleteProject = async () => {
    if (!deleteProjectId) return;
    const project = projects.find(p => p.id === deleteProjectId);
    if (!project || deleteConfirmText !== project.name) return;

    setDeleting(true);
    try {
      // Get all tasks for this project
      const projectTasks = allTasks.filter(t => t.projectId === deleteProjectId);
      
      // Delete all tasks first
      for (const task of projectTasks) {
        await fetch('/api/store', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            action: 'permanentlyDeleteTask',
            id: task.id,
          }),
        });
      }

      // Delete the project
      await fetch('/api/store', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'deleteProject',
          id: deleteProjectId,
        }),
      });

      setShowDeleteModal(false);
      setDeleteProjectId(null);
      setDeleteConfirmText('');
    } catch (e) {
      console.error('Failed to delete project:', e);
    } finally {
      setDeleting(false);
    }
  };

  // Categorize projects by sprint status
  const activeSprints: Project[] = [];
  const completedSprints: Project[] = [];
  const otherProjects: Project[] = [];

  for (const p of projects.filter(p => !p.isArchived)) {
    const cv = (p as any).currentVersion;
    const projectTasks = allTasks.filter(t => t.projectId === p.id && !t.isArchived);
    const versionTasks = cv ? projectTasks.filter(t => (t as any).version === cv) : [];
    const activeTasks = versionTasks.filter(t => ['in-progress', 'qa', 'backlog'].includes(t.status as string));
    const allDone = versionTasks.length > 0 && versionTasks.every(t => t.status === 'done');

    if (cv && activeTasks.length > 0) {
      activeSprints.push(p);
    } else if (cv && allDone) {
      completedSprints.push(p);
    } else {
      otherProjects.push(p);
    }
  }

  const archivedProjects = projects.filter(p => p.isArchived);

  const ProjectCard = ({ project }: { project: Project }) => {
    const statusLabel = getProjectStatusLabel(project, allTasks);
    const stats = getProjectStats(project.id);
    const progressPercent =
      stats.total > 0 ? Math.round((stats.done / stats.total) * 100) : 0;

    return (
      <Link
        href={`/projects/${project.id}`}
        className="block p-4 rounded-lg border border-[var(--border-color)] hover:border-[var(--accent)] transition-all hover:shadow-lg hover:shadow-[var(--accent)]/10 cursor-pointer bg-[var(--bg-secondary)]"
      >
        <div className="space-y-3">
          <div>
            <h3 className="font-semibold text-[var(--text-primary)]">
              {project.name}
            </h3>
            <div className="flex items-center gap-2 mt-2">
              <span
                className={clsx(
                  'text-sm px-2 py-1 rounded-full font-medium',
                  {
                    'bg-blue-50 text-blue-700 dark:bg-blue-950/20 dark:text-blue-400':
                      statusLabel.color === 'blue',
                    'bg-amber-50 text-amber-700 dark:bg-amber-950/20 dark:text-amber-400':
                      statusLabel.color === 'amber',
                    'bg-green-50 text-green-700 dark:bg-green-950/20 dark:text-green-400':
                      statusLabel.color === 'green',
                    'bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-400':
                      statusLabel.color === 'slate',
                  }
                )}
              >
                {statusLabel.emoji} {statusLabel.label}
              </span>
            </div>
          </div>

          {stats.total > 0 && (
            <div className="space-y-1">
              <div className="h-2 bg-[var(--bg-tertiary)] rounded-full overflow-hidden">
                <div
                  className="h-full bg-[var(--accent)] transition-all"
                  style={{ width: `${progressPercent}%` }}
                />
              </div>
              <p className="text-xs text-[var(--text-muted)]">
                {stats.done}/{stats.total} tasks
              </p>
            </div>
          )}

          {project.devOwner && (
            <p className="text-xs text-[var(--text-muted)]">
              Dev: <span className="font-medium">{project.devOwner}</span>
            </p>
          )}
        </div>
      </Link>
    );
  };

  return (
    <div className="flex-1 overflow-auto bg-[var(--bg-primary)]">
      <div className="max-w-6xl mx-auto p-6 space-y-6">
        <div className="flex items-center justify-between">
          <h1 className="text-3xl font-bold text-[var(--text-primary)]">Projects</h1>
          <button
            onClick={() => setShowNewProjectModal(true)}
            className="flex items-center gap-2 px-4 py-2 bg-[var(--accent-primary)] text-white rounded-lg font-medium hover:bg-[var(--accent-hover)] transition-colors"
          >
            <Plus className="w-4 h-4" />
            New Project
          </button>
        </div>

        {/* Active Sprints */}
        {activeSprints.length > 0 && (
          <div className="space-y-3">
            <h2 className="text-sm font-semibold text-[var(--text-secondary)] flex items-center gap-2">
              <span className="relative flex h-2 w-2">
                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-green-400 opacity-75"></span>
                <span className="relative inline-flex rounded-full h-2 w-2 bg-green-500"></span>
              </span>
              Active Sprints
            </h2>
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
              {activeSprints.map((project) => (
                <ProjectCard key={project.id} project={project} />
              ))}
            </div>
          </div>
        )}

        {/* Sprint Complete */}
        {completedSprints.length > 0 && (
          <div className="space-y-3">
            <h2 className="text-sm font-semibold text-[var(--text-secondary)]">✅ Sprint Complete</h2>
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
              {completedSprints.map((project) => (
                <ProjectCard key={project.id} project={project} />
              ))}
            </div>
          </div>
        )}

        {/* Other Projects */}
        {otherProjects.length > 0 && (
          <div className="space-y-3">
            <h2 className="text-sm font-semibold text-[var(--text-muted)]">Other Projects</h2>
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
              {otherProjects.map((project) => (
                <ProjectCard key={project.id} project={project} />
              ))}
            </div>
          </div>
        )}

        {/* No Projects Message */}
        {activeSprints.length === 0 && completedSprints.length === 0 && otherProjects.length === 0 && (
          <div className="flex flex-col items-center justify-center py-12">
            <p className="text-[var(--text-muted)] text-lg">No projects yet</p>
          </div>
        )}

        {/* Archived Section */}
        {archivedProjects.length > 0 && (
          <div className="border border-[var(--border-color)] rounded-lg overflow-hidden">
            <button
              onClick={() => setExpandedArchived(!expandedArchived)}
              className="w-full px-4 py-3 bg-[var(--bg-secondary)] hover:bg-[var(--bg-hover)] transition-colors flex items-center justify-between"
            >
              <span className="font-semibold text-[var(--text-primary)]">
                ▶ Archived ({archivedProjects.length})
              </span>
              <ChevronDown
                size={18}
                className={clsx(
                  'transition-transform duration-200',
                  expandedArchived && 'rotate-180'
                )}
              />
            </button>

            {expandedArchived && (
              <div className="border-t border-[var(--border-color)] p-4 space-y-3 bg-[var(--bg-primary)]">
                {archivedProjects.map((project) => {
                  const stats = getProjectStats(project.id);

                  return (
                    <div
                      key={project.id}
                      className="flex items-center justify-between p-3 rounded-lg bg-[var(--bg-secondary)] opacity-60 hover:opacity-80 transition-opacity"
                    >
                      <div className="flex-1 min-w-0">
                        <h3 className="font-medium text-[var(--text-primary)] truncate">
                          {project.name}
                        </h3>
                        {stats.total > 0 && (
                          <p className="text-xs text-[var(--text-muted)] mt-1">
                            {stats.done}/{stats.total} tasks
                          </p>
                        )}
                      </div>
                      <div className="flex items-center gap-2 ml-3">
                        <button
                          onClick={() => handleUnarchiveProject(project.id)}
                          className="px-3 py-1 text-xs bg-[var(--accent-primary)]/10 text-[var(--accent-primary)] rounded hover:bg-[var(--accent-primary)]/20 transition-colors font-medium"
                        >
                          <RotateCcw className="w-3 h-3 inline mr-1" />
                          Unarchive
                        </button>
                        <button
                          onClick={() => {
                            setDeleteProjectId(project.id);
                            setDeleteConfirmText('');
                            setShowDeleteModal(true);
                          }}
                          className="px-3 py-1 text-xs bg-red-50 dark:bg-red-900/20 text-red-600 dark:text-red-400 rounded hover:bg-red-100 dark:hover:bg-red-900/30 transition-colors font-medium"
                        >
                          <Trash2 className="w-3 h-3 inline mr-1" />
                          Delete
                        </button>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        )}
      </div>

      {/* Project Creation Wizard Modal */}
      {showNewProjectModal && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-0">
          <div className="bg-[var(--card)] border border-[var(--border-default)] rounded-[var(--radius-lg)] p-6 w-full h-full sm:max-w-2xl sm:h-auto sm:mx-4 shadow-lg overflow-y-auto sm:rounded-lg">
            <div className="flex items-center justify-between mb-6">
              <h2 className="text-lg font-semibold text-[var(--text-primary)]">
                New Project — Step {wizardStep}/4
              </h2>
              <button
                onClick={() => {
                  setShowNewProjectModal(false);
                  setWizardStep(1);
                  setNewProject({
                    name: '',
                    lifecycle: 'building',
                    devOwner: '',
                    visionOwner: '',
                    qaOwner: '',
                    vision: `## North Star
<!-- What does the world look like when this project is fully realized? -->

## Current State
<!-- Where are we today? What's the gap between here and the North Star? -->`,
                    outcomes: [''],
                    guardrails: '',
                  });
                }}
                className="p-1 hover:bg-[var(--bg-hover)] rounded transition-colors"
              >
                <X size={18} />
              </button>
            </div>

            {/* Step Indicator - Compact on mobile */}
            <div className="flex gap-1 sm:gap-2 mb-6">
              {[1, 2, 3, 4].map((step) => (
                <div
                  key={step}
                  className={clsx(
                    'h-1 sm:h-2 flex-1 rounded-full transition-colors',
                    step <= wizardStep
                      ? 'bg-[var(--accent-primary)]'
                      : 'bg-[var(--bg-tertiary)]'
                  )}
                />
              ))}
            </div>

            {/* Step 1: Basics */}
            {wizardStep === 1 && (
              <div className="space-y-4">
                <h3 className="text-sm font-semibold text-[var(--text-secondary)]">
                  Project Basics
                </h3>

                <div>
                  <label className="block text-sm font-medium text-[var(--text-secondary)] mb-1">
                    Project Name *
                  </label>
                  <input
                    type="text"
                    value={newProject.name}
                    onChange={(e) => setNewProject({ ...newProject, name: e.target.value })}
                    placeholder="e.g., My Project v2.0"
                    className="w-full px-3 py-2 bg-[var(--bg-primary)] border border-[var(--border-default)] rounded-[var(--radius-md)] text-sm text-[var(--text-primary)] placeholder:text-[var(--text-muted)] focus:outline-none focus:border-[var(--accent-primary)]"
                  />
                </div>

                <div>
                  <label className="block text-sm font-medium text-[var(--text-secondary)] mb-1">
                    Lifecycle
                  </label>
                  <select
                    value={newProject.lifecycle}
                    onChange={(e) => setNewProject({ ...newProject, lifecycle: e.target.value })}
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
                    value={newProject.visionOwner}
                    onChange={(e) => setNewProject({ ...newProject, visionOwner: e.target.value })}
                    className="w-full px-3 py-2 bg-[var(--bg-primary)] border border-[var(--border-default)] rounded-[var(--radius-md)] text-sm text-[var(--text-primary)] focus:outline-none focus:border-[var(--accent-primary)]"
                  >
                    {(storeData?.settings?.teammates || []).map((teammate: any) => (
                      <option key={teammate.id} value={teammate.name}>
                        {teammate.name}
                      </option>
                    ))}
                  </select>
                </div>

                <div>
                  <label className="block text-sm font-medium text-[var(--text-secondary)] mb-1">
                    Dev Owner *
                  </label>
                  <select
                    value={newProject.devOwner}
                    onChange={(e) => setNewProject({ ...newProject, devOwner: e.target.value })}
                    className="w-full px-3 py-2 bg-[var(--bg-primary)] border border-[var(--border-default)] rounded-[var(--radius-md)] text-sm text-[var(--text-primary)] focus:outline-none focus:border-[var(--accent-primary)]"
                  >
                    {(storeData?.settings?.teammates || []).map((teammate: any) => (
                      <option key={teammate.id} value={teammate.name}>
                        {teammate.name}
                      </option>
                    ))}
                  </select>
                </div>

                <div>
                  <label className="block text-sm font-medium text-[var(--text-secondary)] mb-1">
                    Backup Dev / QA (optional)
                  </label>
                  <select
                    value={newProject.qaOwner}
                    onChange={(e) => setNewProject({ ...newProject, qaOwner: e.target.value })}
                    className="w-full px-3 py-2 bg-[var(--bg-primary)] border border-[var(--border-default)] rounded-[var(--radius-md)] text-sm text-[var(--text-primary)] focus:outline-none focus:border-[var(--accent-primary)]"
                  >
                    <option value="">Select...</option>
                    {(storeData?.settings?.teammates || []).map((teammate: any) => (
                      <option key={teammate.id} value={teammate.name}>
                        {teammate.name}
                      </option>
                    ))}
                  </select>
                </div>
              </div>
            )}

            {/* Step 2: Vision */}
            {wizardStep === 2 && (
              <div className="space-y-4">
                <div>
                  <h3 className="text-sm font-semibold text-[var(--text-secondary)] mb-2">
                    Project Vision
                  </h3>
                  <p className="text-xs text-[var(--text-muted)] mb-3">
                    Describe your project's North Star — what does the world look like when this is fully realized?
                  </p>
                </div>

                <textarea
                  value={newProject.vision}
                  onChange={(e) => setNewProject({ ...newProject, vision: e.target.value })}
                  rows={8}
                  className="w-full px-3 py-2 bg-[var(--bg-primary)] border border-[var(--border-default)] rounded-[var(--radius-md)] text-sm text-[var(--text-primary)] placeholder:text-[var(--text-muted)] focus:outline-none focus:border-[var(--accent-primary)] resize-none"
                />

                <p className="text-xs text-[var(--text-muted)]">
                  💡 This helps agents understand the project context and propose aligned work.
                </p>
              </div>
            )}

            {/* Step 3: Outcomes */}
            {wizardStep === 3 && (
              <div className="space-y-4">
                <div>
                  <h3 className="text-sm font-semibold text-[var(--text-secondary)] mb-1">
                    Outcomes
                  </h3>
                  <p className="text-xs text-[var(--text-muted)] mb-4">
                    What does success look like? Define measurable outcomes. Agents will propose work that moves toward these.
                  </p>
                </div>

                <div className="space-y-2">
                  {newProject.outcomes.map((outcome, idx) => (
                    <div key={idx} className="flex gap-2">
                      <input
                        type="text"
                        value={outcome}
                        onChange={(e) => {
                          const newOutcomes = [...newProject.outcomes];
                          newOutcomes[idx] = e.target.value;
                          setNewProject({ ...newProject, outcomes: newOutcomes });
                        }}
                        placeholder="e.g., Agents complete sprints without human intervention for 3+ days"
                        className="flex-1 px-3 py-2 bg-[var(--bg-primary)] border border-[var(--border-default)] rounded-[var(--radius-md)] text-sm text-[var(--text-primary)] placeholder:text-[var(--text-muted)] focus:outline-none focus:border-[var(--accent-primary)]"
                      />
                      {newProject.outcomes.length > 1 && (
                        <button
                          onClick={() => {
                            const newOutcomes = newProject.outcomes.filter((_, i) => i !== idx);
                            setNewProject({ ...newProject, outcomes: newOutcomes });
                          }}
                          className="px-2 py-2 hover:bg-[var(--bg-hover)] rounded transition-colors"
                        >
                          <X size={16} className="text-[var(--text-muted)]" />
                        </button>
                      )}
                    </div>
                  ))}
                </div>

                <button
                  onClick={() => setNewProject({ ...newProject, outcomes: [...newProject.outcomes, ''] })}
                  className="w-full sm:w-auto flex items-center justify-center sm:justify-start gap-1 text-xs text-[var(--accent-primary)] hover:text-[var(--accent-hover)] font-medium transition-colors"
                >
                  <Plus size={14} />
                  Add Outcome
                </button>
              </div>
            )}

            {/* Step 4: Guardrails */}
            {wizardStep === 4 && (
              <div className="space-y-4">
                <div>
                  <h3 className="text-sm font-semibold text-[var(--text-secondary)] mb-1">
                    Guardrails
                  </h3>
                  <p className="text-xs text-[var(--text-muted)] mb-4">
                    Set boundaries and standards for your agents. They read these before proposing any work.
                  </p>
                </div>

                <textarea
                  value={newProject.guardrails}
                  onChange={(e) => setNewProject({ ...newProject, guardrails: e.target.value })}
                  placeholder={`What should agents NOT do?
- No breaking changes to existing APIs
- No third-party integrations without approval

What makes a good proposal?
- Names the specific user who benefits
- Can be demonstrated in under 2 minutes`}
                  rows={10}
                  className="w-full px-3 py-2 bg-[var(--bg-primary)] border border-[var(--border-default)] rounded-[var(--radius-md)] text-sm text-[var(--text-primary)] placeholder:text-[var(--text-muted)] focus:outline-none focus:border-[var(--accent-primary)] resize-none font-mono text-xs"
                />
              </div>
            )}

            {/* Navigation */}
            <div className="flex flex-col sm:flex-row gap-2 mt-6">
              {wizardStep > 1 && (
                <button
                  onClick={() => setWizardStep(wizardStep - 1)}
                  className="px-4 py-2 bg-[var(--bg-tertiary)] text-[var(--text-secondary)] rounded-[var(--radius-md)] font-medium hover:bg-[var(--bg-hover)] transition-colors sm:order-first"
                >
                  Back
                </button>
              )}

              {wizardStep < 4 && (
                <button
                  onClick={() => setWizardStep(wizardStep + 1)}
                  disabled={wizardStep === 1 && (!newProject.name.trim() || !newProject.visionOwner || !newProject.devOwner)}
                  className="flex-1 px-4 py-2 bg-[var(--accent-primary)] text-white rounded-[var(--radius-md)] font-medium hover:bg-[var(--accent-hover)] transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  Next
                </button>
              )}

              {wizardStep === 4 && (
                <>
                  <button
                    onClick={handleCreateProject}
                    disabled={!newProject.name.trim() || !newProject.visionOwner || !newProject.devOwner || creating}
                    className="flex-1 px-4 py-2 bg-[var(--accent-primary)] text-white rounded-[var(--radius-md)] font-medium hover:bg-[var(--accent-hover)] transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    {creating ? 'Creating...' : 'Create Project'}
                  </button>
                  <button
                    onClick={() => {
                      setShowNewProjectModal(false);
                      setWizardStep(1);
                      setNewProject({
                        name: '',
                        lifecycle: 'building',
                        devOwner: '',
                        visionOwner: '',
                        qaOwner: '',
                        vision: `## North Star
<!-- What does the world look like when this project is fully realized? -->

## Current State
<!-- Where are we today? What's the gap between here and the North Star? -->`,
                        outcomes: [''],
                        guardrails: '',
                      });
                    }}
                    className="px-4 py-2 bg-[var(--bg-tertiary)] text-[var(--text-secondary)] rounded-[var(--radius-md)] font-medium hover:bg-[var(--bg-hover)] transition-colors sm:flex-1"
                  >
                    Cancel
                  </button>
                </>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Delete Project Modal */}
      {showDeleteModal && deleteProjectId && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
          <div className="bg-[var(--card)] border border-[var(--border-default)] rounded-[var(--radius-lg)] p-6 max-w-md w-full mx-4 shadow-lg">
            <div className="mb-4">
              <h2 className="text-lg font-semibold text-[var(--text-primary)] mb-2">
                ⚠️ Permanently Delete "{projects.find(p => p.id === deleteProjectId)?.name}"?
              </h2>
              <p className="text-sm text-[var(--text-muted)] mb-3">
                This will permanently delete:
              </p>
              <ul className="text-sm text-[var(--text-muted)] space-y-1 ml-4 mb-3 list-disc">
                <li>The project and all configuration</li>
                <li>{allTasks.filter(t => t.projectId === deleteProjectId).length} tasks</li>
                <li>Vision document</li>
              </ul>
              <p className="text-sm font-semibold text-red-600 dark:text-red-400">
                This action cannot be undone.
              </p>
            </div>

            <div className="mb-4">
              <label className="block text-sm font-medium text-[var(--text-secondary)] mb-2">
                Type "{projects.find(p => p.id === deleteProjectId)?.name}" to confirm:
              </label>
              <input
                type="text"
                value={deleteConfirmText}
                onChange={(e) => setDeleteConfirmText(e.target.value)}
                className="w-full px-3 py-2 bg-[var(--bg-primary)] border border-[var(--border-default)] rounded-[var(--radius-md)] text-sm text-[var(--text-primary)] focus:outline-none focus:border-red-500"
              />
            </div>

            <div className="flex items-center gap-2">
              <button
                onClick={() => {
                  setShowDeleteModal(false);
                  setDeleteProjectId(null);
                  setDeleteConfirmText('');
                }}
                className="flex-1 px-4 py-2 bg-[var(--bg-tertiary)] text-[var(--text-secondary)] rounded-[var(--radius-md)] font-medium hover:bg-[var(--bg-hover)] transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={handleDeleteProject}
                disabled={deleteConfirmText !== projects.find(p => p.id === deleteProjectId)?.name || deleting}
                className="flex-1 px-4 py-2 bg-red-600 text-white rounded-[var(--radius-md)] font-medium hover:bg-red-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {deleting ? 'Deleting...' : 'Delete Permanently'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default function ProjectsPage() {
  return (
    <Suspense fallback={<div className="flex-1 flex items-center justify-center">Loading projects...</div>}>
      <ProjectsContent />
    </Suspense>
  );
}
