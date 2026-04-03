/**
 * vision-prompt.ts
 * 
 * Constructs a structured prompt for agents to propose the next vision version.
 * Used by the autonomous cron job to suggest improvements for a project.
 */

import { Project, Task } from './store';
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';

export interface VersionProposalResponse {
  version: string;
  tasks: Array<{
    title: string;
    impact: string;
    effort: 'small' | 'medium' | 'large';
    outcomeIds?: string[];
  }>;
  rationale: string;
  lifecycleSuggestion?: {
    current: string;
    suggested: string;
    reasons: string[];
  };
  markerNoImprovements?: boolean;
}

/**
 * Read VISION.md content for a project
 */
async function readVisionDoc(project: Project): Promise<string | null> {
  // Try Postgres first (if DATABASE_URL is set)
  if (process.env.DATABASE_URL) {
    try {
      const pg = await import('pg');
      const client = new pg.Client(process.env.DATABASE_URL);
      await client.connect();
      try {
        const result = await client.query(
          'SELECT content FROM org_studio_vision_docs WHERE project_id = $1',
          [project.id]
        );
        if (result.rows.length > 0) {
          return result.rows[0].content;
        }
      } finally {
        await client.end();
      }
    } catch (pgErr) {
      // Fall through to filesystem
      console.warn(`[readVisionDoc] Postgres error for ${project.id}, falling back to filesystem`);
    }
  }

  // Fall back to filesystem
  let docPath: string | null = null;

  // Try visionDocPath first
  if (project.visionDocPath) {
    const absPath = project.visionDocPath.startsWith('/')
      ? project.visionDocPath
      : join(process.cwd(), project.visionDocPath);
    if (existsSync(absPath)) {
      try {
        return readFileSync(absPath, 'utf-8');
      } catch {
        // fall through
      }
    }
  }

  // Fallback to docs/visions/{id}.md
  const fallbackPath = join(process.cwd(), 'docs', 'visions', `${project.id}.md`);
  if (existsSync(fallbackPath)) {
    try {
      return readFileSync(fallbackPath, 'utf-8');
    } catch {
      // fall through
    }
  }

  return null;
}

/**
 * Parse the current version from roadmap table or VISION.md
 * Checks roadmap table first for status='current', then falls back to markdown parsing
 */
async function parseCurrentVersion(projectId: string, content: string): Promise<string | null> {
  // Try roadmap table first
  try {
    const protocol = process.env.NODE_ENV === 'production' ? 'https' : 'http';
    const host = process.env.APP_HOST || '127.0.0.1';
    const port = process.env.PORT || '4501';
    const url = `${protocol}://${host}:${port}/api/roadmap/${projectId}`;
    
    const response = await fetch(url, {
      method: 'GET',
      headers: { 'Content-Type': 'application/json' }
    });
    
    if (response.ok) {
      const data = await response.json();
      const current = (data.versions || []).find((v: any) => v.status === 'current');
      if (current) {
        return current.version;
      }
    }
  } catch (err: any) {
    // Fall through to markdown parsing
    console.warn(`[parseCurrentVersion] API error:`, err.message);
  }

  // Fallback to markdown parsing
  // Try (current) marker first
  const currentMatch = content.match(/### v([\d.]+)\s+.*\(current\)/);
  if (currentMatch) return currentMatch[1];

  // Fallback: read from ## Meta section
  const metaMatch = content.match(/## Meta\n([\s\S]*?)(?=\n## (?!#)|$)/);
  if (metaMatch) {
    const versionLine = metaMatch[1].match(/\*\*Version[:\s]*\*\*\s*([\d.]+)/);
    if (versionLine) return versionLine[1];
  }

  return null;
}

/**
 * Parse roadmap items from VISION.md
 */
function parseRoadmapItems(content: string): Array<{ text: string; done: boolean }> {
  const roadmapMatch = content.match(/## Roadmap\n([\s\S]*?)(?=\n## (?!#)|$)/);
  if (!roadmapMatch) return [];

  const roadmapBlock = roadmapMatch[1];
  const items: Array<{ text: string; done: boolean }> = [];

  // Find all checklist items (- [ ] or - [x])
  const itemMatches = roadmapBlock.matchAll(/^-\s+\[([ xX])\]\s+(.+?)(?=\n-\s+\[|$)/gm);
  for (const match of itemMatches) {
    items.push({
      text: match[2],
      done: match[1].toLowerCase() === 'x',
    });
  }

  return items;
}

/**
 * Fetch roadmap versions from the API/database
 */
async function getRoadmapVersions(projectId: string): Promise<any[]> {
  try {
    const protocol = process.env.NODE_ENV === 'production' ? 'https' : 'http';
    const host = process.env.APP_HOST || '127.0.0.1';
    const port = process.env.PORT || '4501';
    const url = `${protocol}://${host}:${port}/api/roadmap/${projectId}`;
    
    const response = await fetch(url, { 
      method: 'GET',
      headers: { 'Content-Type': 'application/json' }
    });
    
    if (!response.ok) {
      console.warn(`[getRoadmapVersions] Failed to fetch: ${response.status}`);
      return [];
    }
    
    const data = await response.json();
    return data.versions || [];
  } catch (err: any) {
    console.warn(`[getRoadmapVersions] Error:`, err.message);
    // Fallback to parsing from markdown
    return [];
  }
}

/**
 * Parse full roadmap structure with version headers for prompt context.
 * Now fetches from the roadmap table/API first, falls back to markdown parsing.
 */
async function parseRoadmapStructured(projectId: string, fallbackContent: string): Promise<string> {
  // Try to fetch from roadmap API
  const roadmapVersions = await getRoadmapVersions(projectId);
  
  if (roadmapVersions.length > 0) {
    const result: string[] = [];
    
    for (const version of roadmapVersions) {
      const header = `### v${version.version}: ${version.title}`;
      const isShipped = version.status === 'shipped';
      
      if (isShipped) {
        result.push(`${header} ✅`);
      } else {
        result.push(header);
        const items = version.items || [];
        for (const item of items) {
          const done = item.done;
          result.push(`  ${done ? '✅' : '⬜'} ${item.title}`);
        }
      }
    }
    
    return result.length > 0 ? result.join('\n') : '(no roadmap versions found)';
  }
  
  // Fallback to markdown parsing
  const roadmapMatch = fallbackContent.match(/## Roadmap\n([\s\S]*?)(?=\n## (?!#)|$)/);
  if (!roadmapMatch) return '(no roadmap found)';

  const roadmapBlock = roadmapMatch[1];
  const versionBlocks = roadmapBlock.split(/(?=### v)/);
  const result: string[] = [];

  for (const block of versionBlocks) {
    const headerMatch = block.match(/### (v[\d.]+[^\n]*)/);
    if (!headerMatch) continue;

    const header = headerMatch[1];
    const isShipped = /shipped/i.test(header);

    if (isShipped) {
      // Just show the header for shipped versions (no items)
      result.push(`${header} ✅`);
    } else {
      // Show header + all items for unshipped versions
      result.push(header);
      const itemMatches = block.matchAll(/^-\s+\[([ xX])\]\s+(.+?)$/gm);
      for (const m of itemMatches) {
        const done = m[1].toLowerCase() === 'x';
        result.push(`  ${done ? '✅' : '⬜'} ${m[2].trim()}`);
      }
    }
  }

  return result.join('\n') || '(no roadmap versions found)';
}

/**
 * Parse boundaries from VISION.md
 */
function parseBoundaries(content: string): string[] {
  const boundariesMatch = content.match(/## Boundaries\n([\s\S]*?)(?=\n## (?!#)|$)/);
  if (!boundariesMatch) return [];

  const boundaries: string[] = [];
  const lines = boundariesMatch[1].split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith('-') && trimmed.length > 2) {
      boundaries.push(trimmed.substring(1).trim());
    }
  }

  return boundaries;
}

/**
 * Parse aspirations from VISION.md
 */
function parseAspirations(content: string): string[] {
  const aspirationsMatch = content.match(/## Aspirations\n([\s\S]*?)(?=\n## (?!#)|$)/);
  if (!aspirationsMatch) return [];

  const aspirations: string[] = [];
  const lines = aspirationsMatch[1].split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith('-') && trimmed.length > 2) {
      aspirations.push(trimmed.substring(1).trim());
    }
  }

  return aspirations;
}

/**
 * Get the lifecycle-appropriate version budget (max tasks per version)
 */
function getVersionBudget(lifecycle: string | undefined): number {
  switch (lifecycle) {
    case 'building': return 8;
    case 'mature': return 5;
    case 'bau': return 2; // Bug fixes only
    case 'sunset': return 0; // Disabled
    default: return 8;
  }
}

/**
 * Check if a task conflicts with existing work
 */
function isConflictingWithExisting(proposedTask: string, existingTasks: Task[]): boolean {
  const proposedLower = proposedTask.toLowerCase();
  return existingTasks.some(t => {
    const titleLower = (t.title || '').toLowerCase();
    // Simple heuristic: significant token overlap
    const proposedTokens = proposedLower.split(/\W+/);
    const titleTokens = titleLower.split(/\W+/);
    const overlap = proposedTokens.filter(t => titleTokens.includes(t)).length;
    return overlap >= 3; // At least 3 common words
  });
}

/**
 * Build the autonomous version proposal prompt
 * 
 * This function:
 * 1. Reads VISION.md content
 * 2. Reads current Context Board tasks for the project
 * 3. Checks dependency health
 * 4. Cross-references VISION.md roadmap with actual board task completions
 * 5. Constructs a structured prompt with all constraints
 * 6. Returns the prompt as a message string for an agent
 */
export async function buildVisionPrompt(
  project: Project,
  existingTasks: Task[],
  allProjects: Project[] = []
): Promise<string> {
  // Skip if sunset/BAU with no special override
  if (project.lifecycle === 'sunset') {
    return 'SKIP: Vision is marked as sunset. No autonomous improvements proposed.';
  }

  // Read VISION.md
  const docContent = await readVisionDoc(project);
  if (!docContent) {
    return `ERROR: Vision document not found for project ${project.id}`;
  }

  const currentVersion = await parseCurrentVersion(project.id, docContent);
  let roadmapItems = parseRoadmapItems(docContent);
  const boundaries = parseBoundaries(docContent);
  const aspirations = parseAspirations(docContent);
  const budget = getVersionBudget(project.lifecycle);

  // **NEW: Cross-reference roadmap items with actual board tasks**
  // If a roadmap item has a corresponding "done" task on the board, mark it as done
  // This keeps the vision cycle in sync with reality without manual VISION.md updates
  roadmapItems = roadmapItems.map(roadmapItem => {
    // Try to find a matching done task (fuzzy match: significant token overlap)
    const roadmapTokens = roadmapItem.text.toLowerCase().split(/\W+/).filter(t => t.length > 2);
    const matchingDoneTask = existingTasks.find(t => {
      if (t.projectId !== project.id || t.status !== 'done') return false;
      const taskTokens = (t.title || '').toLowerCase().split(/\W+/).filter(t => t.length > 2);
      const overlap = roadmapTokens.filter(rt => taskTokens.some(tt => tt.includes(rt) || rt.includes(tt))).length;
      return overlap >= 2; // At least 2 significant matching tokens
    });
    // If a matching done task found, mark the roadmap item as done
    if (matchingDoneTask) {
      return { ...roadmapItem, done: true };
    }
    return roadmapItem;
  });

  // Check dependency health
  const depHealth = (project.dependsOn || []).map(depId => {
    const depProject = allProjects.find(p => p.id === depId);
    if (!depProject) return `${depId}: not found`;
    if (depProject.lifecycle === 'sunset') return `${depProject.name}: sunset (blocked)`;
    if (depProject.lifecycle === 'bau') return `${depProject.name}: BAU (stable)`;
    return `${depProject.name}: ${depProject.currentVersion || 'v0.1'} (${depProject.lifecycle})`;
  });

  // Filter backlog/in-progress tasks
  const activeOrBacklogTasks = existingTasks.filter(t =>
    t.projectId === project.id &&
    ['backlog', 'in-progress', 'qa', 'review'].includes(t.status)
  );

  // Build prompt
  const prompt = `
You are an autonomous agent proposing the next version plan for a software vision.

## PROJECT: ${project.name}

**Current Version:** ${currentVersion || 'v0.1'}
**Lifecycle:** ${project.lifecycle || 'building'}
**Vision Owner (approval required):** ${project.visionOwner || 'Unassigned'}
**Dev Owner (will execute):** ${project.devOwner || project.owner}

---

## VISION CONTEXT

### Roadmap (structured — shipped versions collapsed, unshipped shown with items)
${await parseRoadmapStructured(project.id, docContent)}

### Undone Roadmap Items (flat list, auto-synced with context board)
${
  roadmapItems
    .filter(item => !item.done)
    .map(item => `- ${item.text}`)
    .join('\n') || '(none — all roadmap items are complete! 🎉)'
}

### Aspirations (ideas for future versions)
${aspirations.map(a => `- ${a}`).join('\n') || '(none defined)'}

### Boundaries (what NOT to do)
${boundaries.map(b => `- ${b}`).join('\n') || '(none defined)'}

### Outcomes (success criteria)
${
  project.outcomes
    ?.filter(o => !o.done)
    .map(o => `- [ ] ${o.text}`)
    .join('\n') || '(no outcomes defined)'
}

### Completed Outcomes
${
  project.outcomes
    ?.filter(o => o.done)
    .map(o => `- [x] ${o.text}`)
    .join('\n') || '(none completed yet)'
}

### Guardrails (boundaries + contribution criteria)
${project.guardrails || '(no guardrails defined)'}

### Dependency Status
${depHealth.length > 0 ? depHealth.join('\n') : '(no dependencies)'}

### Existing Active Work
${
  activeOrBacklogTasks.length > 0
    ? activeOrBacklogTasks.map(t => `- [${t.status}] ${t.title}`).join('\n')
    : '(no active tasks)'
}

---

## YOUR TASK

Propose the next version plan OR report that no meaningful improvements exist.

**CONSTRAINTS:**
1. **Impact thesis required** — every task must state what user-facing or measurable outcome it enables
2. **Version budget: max ${budget} tasks** — forces prioritization
3. **"Would I demo this?" test** — the version as a whole must be demo-able to a user
4. **Diff from last version** — articulate what's *new* compared to ${currentVersion}
5. **No duplicates** — don't propose work that overlaps with active backlog/in-progress tasks
6. **Boundary enforcement** — all proposed tasks must respect the Boundaries section
7. **Guardrail compliance** — all proposed work must respect the Guardrails section
8. **Outcome alignment** — every proposed task should serve at least one incomplete outcome
9. **Version number must follow the roadmap** — find the FIRST unshipped version in the structured roadmap above and propose THAT version. Do NOT invent a new version number or re-propose a shipped version. Current version in Meta is ${currentVersion || 'unknown'}.

**IF no meaningful improvements exist:** Return ONLY this marker:
\`\`\`
NO_IMPROVEMENTS_FOUND
\`\`\`

**IF you have a proposal:** Return a JSON block with this structure:
\`\`\`json
{
  "version": "next version number (e.g. if current is 0.3, propose 0.4)",
  "tasks": [
    {
      "title": "short task title",
      "impact": "what user-facing outcome this enables",
      "effort": "small|medium|large",
      "outcomeIds": ["outcome-id-1"]
    }
  ],
  "rationale": "brief explanation: why these items, why now, why they demo well together",
  "lifecycleSuggestion": {
    "current": "${project.lifecycle || 'building'}",
    "suggested": "building|mature|bau|sunset (or null to keep current)",
    "reasons": ["reason 1", "reason 2"]
  }
}
\`\`\`

---

## CONTEXT LINKS

**Org Studio:** http://127.0.0.1:4501
**Context Board Tasks:** http://127.0.0.1:4501/context
**This Vision:** http://127.0.0.1:4501/vision/${project.id}

---

Now propose the next version. Think step-by-step about what would meaningfully move this project forward, then respond with either the marker or the JSON block.
`;

  return prompt;
}

/**
 * Parse the agent's response and extract the proposal
 */
export function parseVersionProposal(agentResponse: string): VersionProposalResponse | null {
  const response = agentResponse.trim();

  // Check for no-improvements marker
  if (response.includes('NO_IMPROVEMENTS_FOUND')) {
    return {
      version: '',
      tasks: [],
      rationale: 'No meaningful improvements found.',
      markerNoImprovements: true,
    };
  }

  // Try to extract JSON block
  const jsonMatch = response.match(/```json\n([\s\S]*?)\n```/);
  if (!jsonMatch) {
    // Try without code fence
    const jsonStart = response.indexOf('{');
    const jsonEnd = response.lastIndexOf('}');
    if (jsonStart === -1 || jsonEnd === -1) {
      return null;
    }
    try {
      return JSON.parse(response.substring(jsonStart, jsonEnd + 1));
    } catch {
      return null;
    }
  }

  try {
    return JSON.parse(jsonMatch[1]);
  } catch {
    return null;
  }
}
