import { Project, Task } from './store';

export interface Teammate {
  id?: string;
  name: string;
  agentId?: string;
  role?: string;
  avatar?: string;
}

/**
 * Generate a VISION.md template for a project.
 * Groups completed tasks by approximate version using timestamps.
 */
export function generateVisionTemplate(
  project: Project,
  completedTasks: Task[],
  teammates: Teammate[]
): string {
  const today = new Date().toISOString().split('T')[0];
  
  // Resolve owners
  const visionOwner = project.visionOwner || project.owner || 'Unassigned';
  const devOwner = project.devOwner || project.owner || 'Unassigned';
  const qaOwner = project.qaOwner || 'Unassigned';
  
  // Build version history from completed tasks
  // Group tasks by creation date to approximate versions
  const versionHistory: string[] = [];
  
  if (completedTasks.length > 0) {
    // Sort by createdAt descending (newest first)
    const sorted = [...completedTasks].sort((a, b) => b.createdAt - a.createdAt);
    
    // Group into approximate versions (every ~5 tasks or by time)
    let currentVersion = 0.1;
    let tasksInVersion = 0;
    let versionTasks: Task[] = [];
    
    for (const task of sorted) {
      versionTasks.push(task);
      tasksInVersion++;
      
      // Create version every 3-5 tasks, or if we hit a big time gap
      if (tasksInVersion >= 4 || versionTasks.length === sorted.length) {
        if (versionTasks.length > 0) {
          const versionNum = (currentVersion + 0.1 * (Math.floor(currentVersion * 10) % 10)).toFixed(1);
          const shippedDate = new Date(versionTasks[versionTasks.length - 1].createdAt).toISOString().split('T')[0];
          
          const taskLines = versionTasks
            .map(t => `- [x] ${t.title}`)
            .join('\n');
          
          versionHistory.push(
            `### v${versionNum} (shipped ${shippedDate})\n${taskLines}`
          );
        }
        
        currentVersion += 0.1;
        tasksInVersion = 0;
        versionTasks = [];
      }
    }
  }
  
  const versionSection = versionHistory.length > 0
    ? versionHistory.join('\n\n')
    : `### v0.1 (current)
- [ ] Define and ship first milestone`;

  const markdown = `# ${project.name}

## Meta
- **Version:** ${project.currentVersion || '0.1'}
- **Last Updated:** ${today}
- **Vision Owner:** ${visionOwner}
- **Dev Owner:** ${devOwner}
- **QA Owner:** ${qaOwner}
- **Lifecycle:** ${project.lifecycle || 'building'}
- **Repo:** ${project.repoUrl || 'none'}
- **Dependencies:** ${project.dependsOn?.length ? project.dependsOn.join(', ') : 'none'}

## North Star
${project.description || 'Replace with your aspirational vision — what does the world look like when this vision is fully realized?'}

## Current Status
Project activated. Ready for the first milestone.

## Roadmap

### v${(parseFloat(project.currentVersion || '0.1') + 0.1).toFixed(1)} (next)
- [ ] Define key features for next version
- [ ] Impact: enables X for users

${versionSection}

## Aspirations
<!-- Long-term ideas — agents draw from this when proposing versions -->
- Placeholder idea one
- Placeholder idea two
- Placeholder idea three

## Boundaries
<!-- What this project will NOT do -->
- Placeholder boundary one
- Placeholder boundary two

## Context
<!-- Links, prior art, specs, architectural docs -->
- See project description above

## Change History
| Date | Version | Author | Change |
|------|---------|--------|--------|
| ${today} | ${project.currentVersion || '0.1'} | ${visionOwner} | Vision created |
`;

  return markdown;
}
