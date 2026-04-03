/**
 * vision-completion.ts
 * 
 * Detects when all tasks for a version are complete,
 * updates the VISION.md doc, and suggests lifecycle transitions.
 */

import { Project, Task } from './store';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join, relative } from 'path';
import { exec as execCb } from 'child_process';

export interface VersionCompletionSummary {
  isComplete: boolean;
  message: string;
  lifecycleSuggestion?: {
    current: string;
    suggested: string;
    reasons: string[];
  };
}

/**
 * Parses the pending version from project autonomy
 */
function getPendingVersionNumber(project: Project): string | null {
  if (!project.autonomy?.pendingVersion) return null;
  // pendingVersion might be a version string like "0.4" or a JSON proposal
  // Try to extract if it's JSON
  try {
    const parsed = JSON.parse(project.autonomy.pendingVersion);
    return parsed.version || null;
  } catch {
    // It's a plain version string
    return project.autonomy.pendingVersion;
  }
}

/**
 * Check if all tasks linked to a version are complete
 */
export function checkVersionCompletion(
  project: Project,
  allTasks: Task[]
): VersionCompletionSummary {
  const pendingVersion = getPendingVersionNumber(project);

  if (!pendingVersion) {
    return {
      isComplete: false,
      message: 'No pending version found.',
    };
  }

  // Get all tasks for this project
  const projectTasks = allTasks.filter(t => t.projectId === project.id);

  // For now, we consider the version complete if there are no tasks in backlog/in-progress/review
  // This is a simplification; in production, we'd track which tasks belong to which version
  const activeTasks = projectTasks.filter(t =>
    ['backlog', 'in-progress', 'review', 'qa'].includes(t.status)
  );

  const isComplete = activeTasks.length === 0;

  if (!isComplete) {
    return {
      isComplete: false,
      message: `Version ${pendingVersion} has ${activeTasks.length} active task(s) remaining.`,
    };
  }

  // All tasks done — try to update VISION.md
  try {
    updateVisionDoc(project, pendingVersion);
  } catch (e: any) {
    console.error('Failed to update VISION.md:', e?.message);
    // Don't fail the overall completion — the doc update is best-effort
  }

  const lifecycleSuggestion = suggestLifecycleTransition(project, pendingVersion);

  return {
    isComplete: true,
    message: `✅ Version ${pendingVersion} completed! ${projectTasks.length} tasks shipped.`,
    lifecycleSuggestion,
  };
}

/**
 * Update VISION.md after version completion
 * - Check off completed items in current version
 * - Bump version number
 * - Update Change History
 */
export function updateVisionDoc(project: Project, completedVersion: string): void {
  let docPath: string | null = null;

  // Determine doc path
  if (project.visionDocPath) {
    docPath = project.visionDocPath.startsWith('/')
      ? project.visionDocPath
      : join(process.cwd(), project.visionDocPath);
  } else {
    docPath = join(process.cwd(), 'docs', 'visions', `${project.id}.md`);
  }

  if (!existsSync(docPath)) {
    throw new Error(`Vision doc not found at ${docPath}`);
  }

  let content = readFileSync(docPath, 'utf-8');

  // Update roadmap: change "### v{version} (current)" to "### v{version} (shipped ...)"
  const versionRegex = new RegExp(`### v${completedVersion.replace(/\./g, '\\.')}\\s+\\(current\\)`);
  if (versionRegex.test(content)) {
    const today = new Date().toISOString().split('T')[0];
    content = content.replace(
      versionRegex,
      `### v${completedVersion} (shipped ${today})`
    );

    // Check off all items in that section
    // This is a bit tricky — find the section and check all its items
    const versionSectionRegex = new RegExp(
      `### v${completedVersion.replace(/\./g, '\\.')}\\s+\\(shipped[^)]*\\)\\n([\\s\\S]*?)(?=###\\s+v|##\\s+|$)`
    );
    const match = content.match(versionSectionRegex);
    if (match) {
      const section = match[1];
      const updatedSection = section.replace(/^-\s+\[\s*\]\s+/gm, '- [x] ');
      content = content.replace(versionSectionRegex, `### v${completedVersion} (shipped ${today})\n${updatedSection}`);
    }
  }

  // Update Change History
  const today = new Date().toISOString().split('T')[0];
  const changeEntry = `| ${today} | ${completedVersion} | Agent | Version completed and shipped |`;
  const historyMatch = content.match(/## Change History\n(\|.*?\n)*(.*?)(\n##|$)/);
  if (historyMatch) {
    content = content.replace(
      /## Change History\n(\|.*?\n\|.*?\n)+/,
      match => match.replace(/\n$/, `\n${changeEntry}\n`)
    );
  }

  // Write back
  writeFileSync(docPath, content, 'utf-8');
  console.log(`[Vision Completion] Updated VISION.md for v${completedVersion} at ${docPath}`);

  // Auto-commit + push to git (fire-and-forget, same as PUT /api/vision/[id]/doc)
  const cwd = process.cwd();
  const relPath = relative(cwd, docPath);
  const commitMsg = `docs: vision ${completedVersion} shipped — auto-updated roadmap`;
  const gitCmd = `cd "${cwd}" && git add "${relPath}" && git diff --cached --quiet || (git commit -m "${commitMsg}" && git push origin HEAD 2>&1)`;
  execCb(gitCmd, { timeout: 30000 }, (err, stdout, stderr) => {
    if (err) {
      console.error(`[Vision Completion] git push failed: ${err.message}`);
    } else if (stdout?.trim()) {
      console.log(`[Vision Completion] committed: ${stdout.trim().split('\n').slice(-1)[0]}`);
    }
  });
}

/**
 * Evaluate whether a lifecycle transition is appropriate
 */
export function suggestLifecycleTransition(
  project: Project,
  justCompletedVersion: string
): { current: string; suggested: string; reasons: string[] } | undefined {
  const current = project.lifecycle || 'building';

  // Only suggest if currently building
  if (current !== 'building') {
    return undefined;
  }

  // Simple heuristic: if we've hit v1.0+, suggest mature
  const [major] = justCompletedVersion.split('.');
  const majorNum = parseInt(major, 10);

  if (majorNum >= 1) {
    return {
      current,
      suggested: 'mature',
      reasons: [
        `Shipped major version ${justCompletedVersion}`,
        'Core roadmap likely fulfilled',
        'Ready to slow cycle to biweekly improvements',
      ],
    };
  }

  return undefined;
}

/**
 * Format a completion summary for delivery to the vision owner
 */
export function formatCompletionSummary(
  project: Project,
  summary: VersionCompletionSummary
): string {
  let msg = `🎉 **Version completed: ${project.name}**\n\n`;
  msg += summary.message + '\n';

  if (summary.lifecycleSuggestion) {
    msg += `\n📊 **Lifecycle suggestion:**\n`;
    msg += `Current: ${summary.lifecycleSuggestion.current} → Suggested: ${summary.lifecycleSuggestion.suggested}\n`;
    msg += `Reasons:\n`;
    summary.lifecycleSuggestion.reasons.forEach(r => {
      msg += `  • ${r}\n`;
    });
  }

  msg += `\n[View Vision](http://127.0.0.1:4501/vision/${project.id})`;

  return msg;
}

/**
 * Find the next unshipped version in VISION.md
 * Scans the roadmap for the first version section with unchecked items (- [ ])
 */
function findNextUnshippedVersion(content: string): string | null {
  // Look for version sections like "### v0.4 (current)" or "### v0.4" with unchecked items
  const lines = content.split('\n');
  let currentVersion: string | null = null;
  let hasUncheckedItems = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Match version header: ### v<number>.<number>
    const versionMatch = line.match(/###\s+v(\d+\.\d+)/);
    if (versionMatch) {
      // If we found unchecked items in the previous version, return it
      if (currentVersion && hasUncheckedItems) {
        return currentVersion;
      }

      currentVersion = versionMatch[1];
      hasUncheckedItems = false;
      continue;
    }

    // Check for unchecked items (- [ ]) within the current version
    if (currentVersion && line.match(/^-\s+\[\s*\]\s+/)) {
      hasUncheckedItems = true;
    }

    // Stop at next section (##) if we haven't found unchecked items yet
    if (line.match(/^##\s+/) && currentVersion && !line.includes('v')) {
      break;
    }
  }

  // Return the last version if it has unchecked items
  if (currentVersion && hasUncheckedItems) {
    return currentVersion;
  }

  return null;
}

/**
 * Read the VISION.md document for a project
 */
function readVisionDoc(project: Project): string | null {
  let docPath: string | null = null;

  if (project.visionDocPath) {
    docPath = project.visionDocPath.startsWith('/')
      ? project.visionDocPath
      : join(process.cwd(), project.visionDocPath);
  } else {
    docPath = join(process.cwd(), 'docs', 'visions', `${project.id}.md`);
  }

  if (!existsSync(docPath)) {
    return null;
  }

  try {
    return readFileSync(docPath, 'utf-8');
  } catch {
    return null;
  }
}

/**
 * Determine if the next version should auto-launch based on approval mode
 * Returns true if within approval boundary (should auto-launch)
 */
export function shouldAutoLaunchNext(project: Project, completedVersion: string): boolean {
  const mode = project.autonomy?.approvalMode || 'per-version';

  if (mode === 'per-version') {
    // Default: every version needs explicit approval
    return false;
  }

  if (mode === 'per-major') {
    // Parse major version number from completed version
    const [major] = completedVersion.split('.');

    // Read VISION.md to find next unshipped version
    const docContent = readVisionDoc(project);
    if (!docContent) {
      return false;
    }

    const nextVersion = findNextUnshippedVersion(docContent);
    if (!nextVersion) {
      // No more versions to ship
      return false;
    }

    // Parse major version of next
    const [nextMajor] = nextVersion.split('.');

    // Auto-launch if same major (e.g., 0.9 → 0.10)
    // Stop if different major (e.g., 0.x → 1.0)
    return major === nextMajor;
  }

  return false;
}

/**
 * Check if any outcomes are now complete based on their linked tasks
 * Returns the list of newly completed outcome IDs
 */
export async function checkOutcomeCompletion(
  project: Project,
  allTasks: Task[]
): Promise<{ completedOutcomeIds: string[]; message: string }> {
  const outcomes = project.outcomes || [];
  if (outcomes.length === 0) {
    return { completedOutcomeIds: [], message: 'No outcomes to check.' };
  }

  const completedOutcomeIds: string[] = [];

  // Get all tasks for this project
  const projectTasks = allTasks.filter(t => t.projectId === project.id);

  for (const outcome of outcomes) {
    // Skip outcomes already done
    if (outcome.done) {
      continue;
    }

    // Find all tasks linked to this outcome
    const linkedTasks = projectTasks.filter(t => t.outcomeIds?.includes(outcome.id));

    // If no tasks are linked, skip this outcome
    if (linkedTasks.length === 0) {
      continue;
    }

    // Check if all linked tasks are done
    const allDone = linkedTasks.every(t => t.status === 'done');

    if (allDone) {
      completedOutcomeIds.push(outcome.id);
    }
  }

  const message =
    completedOutcomeIds.length > 0
      ? `✅ Completed ${completedOutcomeIds.length} outcome(s): ${completedOutcomeIds.map(id => outcomes.find(o => o.id === id)?.text).filter(Boolean).join(', ')}`
      : 'No outcomes completed at this time.';

  return { completedOutcomeIds, message };
}

