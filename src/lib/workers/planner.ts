import type { ModelTier } from '../model-tier';
import type { WorkerRunResult } from './engine-codex';

export const PLANNER_RESULT_START = 'ORG_STUDIO_PLAN_JSON_START';
export const PLANNER_RESULT_END = 'ORG_STUDIO_PLAN_JSON_END';
export const MIN_PLANNER_CHUNKS = 2;
export const MAX_PLANNER_CHUNKS = 12;

export interface PlannerChunk {
  key: string;
  title: string;
  description: string;
  doneWhen: string;
  constraints: string;
  modelTier: ModelTier;
  dependsOn: string[];
}

export interface PlannerOutput {
  chunks: PlannerChunk[];
}

export interface PlannerRoadmapContext {
  projectId: string;
  projectName?: string;
  version: string;
  versionTitle?: string;
  versionSuccessCriteria?: string;
  itemId: string;
  itemTitle: string;
  visionExtract?: string;
}

export interface PlannerSourceTask {
  id: string;
  ticketNumber?: number;
  title: string;
  description?: string;
  doneWhen?: string;
  constraints?: string;
}

export interface PlannerChunkCreateInput {
  title: string;
  description: string;
  doneWhen: string;
  constraints: string;
  modelTier: ModelTier;
  status: 'planning';
  projectId: string;
  sectionId?: string;
  assignee: string;
  taskType: 'feature';
  parentId: string;
  /** Canonical roadmap linkage. Multiple planner chunks share the source
   *  item's id; the item's taskId remains the plan-task anchor. */
  roadmapItemId: string;
  version: string;
  plannerChunkKey: string;
  plannerSourceTaskId: string;
  blockedBy: number[];
}

export interface CreatedPlannerChunk {
  id: string;
  ticketNumber: number;
  title: string;
  plannerChunkKey: string;
  modelTier?: ModelTier;
  blockedBy: number[];
}

export interface PlannerPersistenceDeps {
  findExisting: (sourceTaskId: string) => Promise<CreatedPlannerChunk[]>;
  createChunk: (input: PlannerChunkCreateInput) => Promise<CreatedPlannerChunk>;
  updateChunk: (taskId: string, updates: { blockedBy: number[] }) => Promise<void>;
  rollbackChunk: (taskId: string) => Promise<void>;
}

const VALID_TIERS = new Set<ModelTier>(['trivial', 'standard', 'complex']);
const VALID_KEY = /^[a-z][a-z0-9-]{0,39}$/;

function cleanRequiredString(
  value: unknown,
  path: string,
  maxLength: number,
): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`${path} must be a non-empty string`);
  }
  const out = value.trim();
  if (out.length > maxLength) throw new Error(`${path} exceeds ${maxLength} characters`);
  return out;
}

function parsePlannerJson(raw: string): unknown {
  const start = raw.lastIndexOf(PLANNER_RESULT_START);
  if (start < 0) throw new Error(`missing ${PLANNER_RESULT_START} marker`);
  const bodyStart = start + PLANNER_RESULT_START.length;
  const end = raw.indexOf(PLANNER_RESULT_END, bodyStart);
  if (end < 0) throw new Error(`missing ${PLANNER_RESULT_END} marker`);
  const body = raw.slice(bodyStart, end).trim();
  try {
    return JSON.parse(body);
  } catch (error) {
    throw new Error(`invalid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export function validatePlannerOutput(raw: unknown): PlannerOutput {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('planner output must be an object');
  }
  const keys = Object.keys(raw);
  if (keys.some((key) => key !== 'chunks')) {
    throw new Error(`planner output has unknown field(s): ${keys.filter((key) => key !== 'chunks').join(', ')}`);
  }
  const chunksRaw = (raw as { chunks?: unknown }).chunks;
  if (!Array.isArray(chunksRaw)) throw new Error('planner output.chunks must be an array');
  if (chunksRaw.length < MIN_PLANNER_CHUNKS || chunksRaw.length > MAX_PLANNER_CHUNKS) {
    throw new Error(
      `planner output must contain ${MIN_PLANNER_CHUNKS}-${MAX_PLANNER_CHUNKS} chunks (received ${chunksRaw.length})`,
    );
  }

  const chunks: PlannerChunk[] = chunksRaw.map((candidate, index) => {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
      throw new Error(`chunks[${index}] must be an object`);
    }
    const chunk = candidate as Record<string, unknown>;
    const allowed = new Set([
      'key',
      'title',
      'description',
      'doneWhen',
      'constraints',
      'modelTier',
      'dependsOn',
    ]);
    const unknown = Object.keys(chunk).filter((key) => !allowed.has(key));
    if (unknown.length > 0) {
      throw new Error(`chunks[${index}] has unknown field(s): ${unknown.join(', ')}`);
    }
    const key = cleanRequiredString(chunk.key, `chunks[${index}].key`, 40);
    if (!VALID_KEY.test(key)) {
      throw new Error(`chunks[${index}].key must match ${VALID_KEY}`);
    }
    if (!VALID_TIERS.has(chunk.modelTier as ModelTier)) {
      throw new Error(
        `chunks[${index}].modelTier must be one of trivial, standard, complex`,
      );
    }
    if (!Array.isArray(chunk.dependsOn) || chunk.dependsOn.some((dep) => typeof dep !== 'string')) {
      throw new Error(`chunks[${index}].dependsOn must be an array of chunk keys`);
    }
    return {
      key,
      title: cleanRequiredString(chunk.title, `chunks[${index}].title`, 180),
      description: cleanRequiredString(
        chunk.description,
        `chunks[${index}].description`,
        5_000,
      ),
      doneWhen: cleanRequiredString(chunk.doneWhen, `chunks[${index}].doneWhen`, 3_000),
      constraints: cleanRequiredString(
        chunk.constraints,
        `chunks[${index}].constraints`,
        3_000,
      ),
      modelTier: chunk.modelTier as ModelTier,
      dependsOn: [...new Set((chunk.dependsOn as string[]).map((dep) => dep.trim()))],
    };
  });

  const keySet = new Set<string>();
  for (const chunk of chunks) {
    if (keySet.has(chunk.key)) throw new Error(`duplicate chunk key '${chunk.key}'`);
    keySet.add(chunk.key);
  }
  for (const [index, chunk] of chunks.entries()) {
    for (const dep of chunk.dependsOn) {
      if (!keySet.has(dep)) throw new Error(`chunks[${index}] depends on unknown key '${dep}'`);
      if (dep === chunk.key) throw new Error(`chunks[${index}] cannot depend on itself`);
    }
  }

  const visiting = new Set<string>();
  const visited = new Set<string>();
  const byKey = new Map(chunks.map((chunk) => [chunk.key, chunk]));
  const visit = (key: string): void => {
    if (visiting.has(key)) throw new Error(`dependency cycle detected at '${key}'`);
    if (visited.has(key)) return;
    visiting.add(key);
    for (const dep of byKey.get(key)?.dependsOn || []) visit(dep);
    visiting.delete(key);
    visited.add(key);
  };
  for (const chunk of chunks) visit(chunk.key);

  return { chunks };
}

export function parsePlannerResult(result: WorkerRunResult): PlannerOutput {
  if (!result.ok) {
    throw new Error(`engine run failed (exit ${result.exitCode ?? 'unknown'})`);
  }
  if (result.fileChanges.length > 0) {
    throw new Error('planner attempted repository file changes; plan jobs are read-only');
  }
  const text = result.messages.join('\n');
  return validatePlannerOutput(parsePlannerJson(text));
}

export function buildPlannerInstructions(context: PlannerRoadmapContext): string {
  const lines = [
    '## Planner mode — read-only deliverable',
    '',
    'You are a FRONTIER-tier planning worker. Decompose the roadmap item below into independently executable code chunks.',
    'You are NOT implementing code: do not edit files, commit, push, open a PR, or run destructive commands.',
    'Inspect the repository only when needed to ground file paths, interfaces, and verification commands.',
    '',
    `Project: ${context.projectName || context.projectId}`,
    `Version: ${context.version}${context.versionTitle ? ` — ${context.versionTitle}` : ''}`,
    `Roadmap item: ${context.itemTitle} (${context.itemId})`,
  ];
  if (context.versionSuccessCriteria) {
    lines.push(`Version success criteria: ${context.versionSuccessCriteria}`);
  }
  if (context.visionExtract) {
    lines.push('', '### Vision extract', '', context.visionExtract.trim());
  }
  lines.push(
    '',
    '### Decomposition rules',
    '',
    `- Produce ${MIN_PLANNER_CHUNKS}-${MAX_PLANNER_CHUNKS} chunks.`,
    '- Every chunk must be self-contained: name concrete file paths, interfaces, and implementation approach.',
    '- doneWhen must be objectively verifiable and include a targeted command where possible.',
    '- Use dependsOn chunk keys only for real ordering constraints; keep independent chunks unblocked.',
    '- Choose modelTier: trivial for mechanical/local work, standard for normal scoped implementation, complex for cross-cutting/high-reasoning work.',
    '- Chunks will be created in planning; do not suggest bypassing the human launch gate.',
    '',
    '### Required output',
    '',
    `Return exactly one JSON object between ${PLANNER_RESULT_START} and ${PLANNER_RESULT_END}. No markdown fences.`,
    `${PLANNER_RESULT_START}`,
    '{"chunks":[{"key":"stable-kebab-key","title":"...","description":"...","doneWhen":"...","constraints":"...","modelTier":"trivial|standard|complex","dependsOn":[]}]}',
    `${PLANNER_RESULT_END}`,
  );
  return lines.join('\n');
}

export function extractVisionForPlanner(content: string, maxChars = 6_000): string {
  const trimmed = content.trim();
  if (!trimmed) return '';
  const preferred = ['North Star', 'Mission', 'Product Promise', 'Aspiration', 'Principles'];
  const sections = trimmed.split(/(?=^##\s+)/m);
  const selected = sections.filter((section) =>
    preferred.some((heading) => new RegExp(`^##\\s+.*${heading}`, 'im').test(section)),
  );
  const candidate = (selected.length > 0 ? selected.join('\n') : trimmed).trim();
  return candidate.length <= maxChars
    ? candidate
    : `${candidate.slice(0, maxChars).trimEnd()}\n…[vision extract truncated]`;
}

export async function persistPlannerChunks(args: {
  sourceTask: PlannerSourceTask & {
    projectId: string;
    sectionId?: string;
    version: string;
    roadmapItemId: string;
    assignee: string;
  };
  output: PlannerOutput;
  deps: PlannerPersistenceDeps;
}): Promise<CreatedPlannerChunk[]> {
  const existing = await args.deps.findExisting(args.sourceTask.id);
  if (existing.length > 0) {
    if (existing.length !== args.output.chunks.length) {
      throw new Error(
        `planner output already partially materialized (${existing.length}/${args.output.chunks.length} chunks); refusing duplicate writes`,
      );
    }
    const existingByKey = new Map(existing.map((task) => [task.plannerChunkKey, task]));
    const ticketByKey = new Map(existing.map((task) => [task.plannerChunkKey, task.ticketNumber]));
    for (const chunk of args.output.chunks) {
      const task = existingByKey.get(chunk.key);
      if (!task) {
        throw new Error(`existing planner materialization is missing chunk '${chunk.key}'`);
      }
      if (task.modelTier !== undefined && task.modelTier !== chunk.modelTier) {
        throw new Error(`existing planner chunk '${chunk.key}' has drifted modelTier`);
      }
      const expectedBlockedBy = chunk.dependsOn.map((key) => ticketByKey.get(key));
      if (
        expectedBlockedBy.some((ticket) => ticket === undefined) ||
        JSON.stringify([...task.blockedBy].sort((a, b) => a - b)) !==
          JSON.stringify((expectedBlockedBy as number[]).sort((a, b) => a - b))
      ) {
        throw new Error(`existing planner chunk '${chunk.key}' has drifted dependency wiring`);
      }
    }
    return existing;
  }

  const created: CreatedPlannerChunk[] = [];
  try {
    for (const chunk of args.output.chunks) {
      const task = await args.deps.createChunk({
        title: chunk.title,
        description: chunk.description,
        doneWhen: chunk.doneWhen,
        constraints: chunk.constraints,
        modelTier: chunk.modelTier,
        status: 'planning',
        projectId: args.sourceTask.projectId,
        sectionId: args.sourceTask.sectionId,
        assignee: args.sourceTask.assignee,
        taskType: 'feature',
        parentId: args.sourceTask.id,
        roadmapItemId: args.sourceTask.roadmapItemId,
        version: args.sourceTask.version,
        plannerChunkKey: chunk.key,
        plannerSourceTaskId: args.sourceTask.id,
        blockedBy: [],
      });
      created.push(task);
    }

    const ticketByKey = new Map(created.map((task) => [task.plannerChunkKey, task.ticketNumber]));
    for (const chunk of args.output.chunks) {
      const target = created.find((task) => task.plannerChunkKey === chunk.key);
      if (!target) throw new Error(`created chunk '${chunk.key}' could not be resolved`);
      const blockedBy = chunk.dependsOn.map((key) => {
        const ticketNumber = ticketByKey.get(key);
        if (!ticketNumber) throw new Error(`dependency '${key}' has no created ticket number`);
        return ticketNumber;
      });
      if (blockedBy.length > 0) {
        await args.deps.updateChunk(target.id, { blockedBy });
        target.blockedBy = blockedBy;
      }
    }
    return created;
  } catch (error) {
    await Promise.allSettled(created.map((task) => args.deps.rollbackChunk(task.id)));
    throw error;
  }
}

export function renderPlannerSummary(
  sourceTask: PlannerSourceTask,
  chunks: CreatedPlannerChunk[],
): string {
  const lines = [
    `🧭 **Planner result** — #${sourceTask.ticketNumber ?? '?'} produced ${chunks.length} planning chunks`,
    '',
  ];
  for (const chunk of chunks) {
    const blockers = chunk.blockedBy.length > 0 ? ` — blocked by ${chunk.blockedBy.map((n) => `#${n}`).join(', ')}` : '';
    lines.push(`- #${chunk.ticketNumber} ${chunk.title}${blockers}`);
  }
  lines.push('', 'All chunks are in **Planning**. Human launch approval is still required before any chunk reaches backlog.');
  return lines.join('\n');
}
