import { spawn } from "child_process";
import { lstat, mkdtemp, readFile, realpath, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { basename, isAbsolute, join, relative, resolve, sep } from "path";
import type {
  EngineCommand,
  EngineFileChange,
  EngineRunOpts,
  EngineUsage,
  WorkerRunResult,
} from "./engine-codex";

export interface OpenAiCompatRunOpts extends EngineRunOpts {
  /** OpenAI-compatible endpoint base URL (e.g. https://host/v1). */
  baseUrl?: string;
  /** Env var name containing the API key. Missing key is allowed for local OSS. */
  apiKeyEnv?: string;
  /** Worker-configured verification commands (never model-supplied). */
  verificationCommands?: string[];
}

export const OPENAI_COMPAT_DIFF_START = "<<<ORG_STUDIO_UNIFIED_DIFF_START>>>";
export const OPENAI_COMPAT_DIFF_END = "<<<ORG_STUDIO_UNIFIED_DIFF_END>>>";
export const OPENAI_COMPAT_EXACT_EDITS_START =
  "<<<ORG_STUDIO_EXACT_EDITS_START>>>";
export const OPENAI_COMPAT_EXACT_EDITS_END =
  "<<<ORG_STUDIO_EXACT_EDITS_END>>>";

// Conservative cap to keep single-shot cheap-worker payload parsing bounded.
const OPENAI_COMPAT_EXACT_EDITS_MAX_BYTES = 64 * 1024;
const OPENAI_COMPAT_EXACT_EDITS_MAX_EDITS = 3;
const OPENAI_COMPAT_EXACT_EDITS_MAX_PATH_BYTES = 512;

export interface OpenAiCompatCommandRequest {
  command: string;
  args: string[];
  cwd: string;
  timeoutMs: number;
  env?: Record<string, string>;
}

export interface OpenAiCompatCommandResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export type OpenAiCompatCommandRunner = (
  request: OpenAiCompatCommandRequest,
) => Promise<OpenAiCompatCommandResult>;

export interface OpenAiCompatDeps {
  fetchImpl?: typeof fetch;
  runCommand?: OpenAiCompatCommandRunner;
  nowMs?: () => number;
}

function defaultNowMs(): number {
  return Date.now();
}

function defaultRunCommand(
  request: OpenAiCompatCommandRequest,
): Promise<OpenAiCompatCommandResult> {
  return new Promise((resolve) => {
    const child = spawn(request.command, request.args, {
      cwd: request.cwd,
      env: { ...process.env, ...(request.env || {}) },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;

    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, request.timeoutMs);

    child.on("error", (error) => {
      clearTimeout(timer);
      resolve({
        exitCode: null,
        stdout,
        stderr: `${stderr}\nspawn failed: ${error.message}`.trim(),
        timedOut,
      });
    });

    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({
        exitCode: timedOut ? null : code,
        stdout,
        stderr,
        timedOut,
      });
    });
  });
}

function safeTail(value: string, max = 500): string {
  return value.length > max ? value.slice(-max) : value;
}

type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
  return value !== null && typeof value === "object";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function normalizeUsage(raw: unknown): EngineUsage | null {
  if (!isRecord(raw)) return null;
  const promptDetails = isRecord(raw.prompt_tokens_details)
    ? raw.prompt_tokens_details
    : null;
  return {
    inputTokens:
      typeof raw.prompt_tokens === "number"
        ? raw.prompt_tokens
        : typeof raw.input_tokens === "number"
          ? raw.input_tokens
          : null,
    cachedInputTokens:
      typeof raw.cached_input_tokens === "number"
        ? raw.cached_input_tokens
        : promptDetails && typeof promptDetails.cached_tokens === "number"
          ? promptDetails.cached_tokens
          : null,
    outputTokens:
      typeof raw.completion_tokens === "number"
        ? raw.completion_tokens
        : typeof raw.output_tokens === "number"
          ? raw.output_tokens
          : null,
    reasoningOutputTokens:
      typeof raw.reasoning_output_tokens === "number"
        ? raw.reasoning_output_tokens
        : null,
  };
}

function extractMessageText(payload: unknown): string | null {
  if (!isRecord(payload) || !Array.isArray(payload.choices)) return null;
  const choice = payload.choices[0];
  if (!isRecord(choice) || !isRecord(choice.message)) return null;
  const content = choice.message.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const joined = content
      .map((part: unknown) => {
        if (typeof part === "string") return part;
        if (isRecord(part) && typeof part.text === "string") return part.text;
        return "";
      })
      .filter(Boolean)
      .join("\n")
      .trim();
    return joined || null;
  }
  return null;
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const REFERENCED_FILE_CONTEXT_MAX_FILES = 3;
const REFERENCED_FILE_CONTEXT_MAX_BYTES = 24 * 1024;
const REFERENCED_FILE_MAX_SOURCE_BYTES = 2 * 1024 * 1024;
const FILE_EXCERPT_TRUNCATION_MARKER =
  "... [TRUNCATED: showing head/tail excerpt] ...";
const REPO_CONTEXT_TOTAL_TRUNCATION_MARKER =
  "[TRUNCATED: referenced file context exceeded 24KiB budget]";
const FORBIDDEN_SECRET_FILE_PATTERN =
  /(?:^|[._-])(secret|secrets|token|tokens|password|passwd|credential|credentials|private|key|keys)(?:[._-]|$)|\.(pem|p12|pfx|key)$/i;

function utf8Prefix(value: string, maxBytes: number): string {
  if (maxBytes <= 0) return "";
  let used = 0;
  const out: string[] = [];
  for (const char of value) {
    const size = Buffer.byteLength(char, "utf8");
    if (used + size > maxBytes) break;
    out.push(char);
    used += size;
  }
  return out.join("");
}

function utf8Suffix(value: string, maxBytes: number): string {
  if (maxBytes <= 0) return "";
  const chars = Array.from(value);
  let used = 0;
  const out: string[] = [];
  for (let index = chars.length - 1; index >= 0; index -= 1) {
    const char = chars[index];
    const size = Buffer.byteLength(char, "utf8");
    if (used + size > maxBytes) break;
    out.push(char);
    used += size;
  }
  return out.reverse().join("");
}

function truncateUtf8WithMarker(
  value: string,
  maxBytes: number,
  marker: string,
): string {
  if (Buffer.byteLength(value, "utf8") <= maxBytes) return value;
  const markerLine = `\n${marker}`;
  const markerBytes = Buffer.byteLength(markerLine, "utf8");
  if (maxBytes <= markerBytes) return utf8Prefix(marker, maxBytes);
  return `${utf8Prefix(value, maxBytes - markerBytes).trimEnd()}${markerLine}`;
}

function renderBoundedFileExcerpt(content: string, maxBytes: number): string {
  if (Buffer.byteLength(content, "utf8") <= maxBytes) return content;
  const marker = `\n${FILE_EXCERPT_TRUNCATION_MARKER}\n`;
  const markerBytes = Buffer.byteLength(marker, "utf8");
  if (maxBytes <= markerBytes) return utf8Prefix(FILE_EXCERPT_TRUNCATION_MARKER, maxBytes);
  const budget = maxBytes - markerBytes;
  const headBudget = Math.floor(budget / 2);
  const tailBudget = budget - headBudget;
  return `${utf8Prefix(content, headBudget)}${marker}${utf8Suffix(content, tailBudget)}`;
}

function normalizeCandidatePath(raw: string): string {
  return raw
    .trim()
    .replace(/^['"`]+|['"`]+$/g, "")
    .replace(/[),.;:!?]+$/g, "")
    .replace(/^([ab])\//, "");
}

function extractBriefPathCandidates(brief: string): string[] {
  const pathLike =
    /`([^`\n]+)`|"([^"\n]+)"|'([^'\n]+)'|(\b(?:[A-Za-z0-9][A-Za-z0-9._-]*\/)+[A-Za-z0-9][A-Za-z0-9._-]*\b|\b[A-Za-z0-9][A-Za-z0-9._-]*\.[A-Za-z0-9][A-Za-z0-9._-]*\b)/g;
  const found: string[] = [];
  for (const match of brief.matchAll(pathLike)) {
    const candidate = normalizeCandidatePath(
      match[1] || match[2] || match[3] || match[4] || "",
    );
    if (candidate) found.push(candidate);
  }
  return found;
}

function isForbiddenPath(path: string): boolean {
  if (
    !path ||
    isAbsolute(path) ||
    path.includes("\\") ||
    /[\u0000-\u001f\u007f]/.test(path)
  ) {
    return true;
  }
  const parts = path.split("/");
  if (parts.length === 0) return true;
  if (parts.some((part) => !part || part === "." || part === "..")) return true;
  if (parts.some((part) => part.startsWith("."))) return true;
  if (parts.some((part) => FORBIDDEN_SECRET_FILE_PATTERN.test(part))) return true;
  if (FORBIDDEN_SECRET_FILE_PATTERN.test(basename(path))) return true;
  return false;
}

interface ReferencedFileContext {
  path: string;
  excerpt: string;
}

async function resolveReferencedFileContext(
  cwd: string,
  brief: string,
): Promise<ReferencedFileContext[]> {
  const rootReal = await realpath(cwd).catch(() => resolve(cwd));
  const candidates = [...new Set(extractBriefPathCandidates(brief))]
    .filter((candidate) => !isForbiddenPath(candidate))
    .sort((a, b) => a.localeCompare(b));

  if (candidates.length === 0) return [];

  const selected: { path: string; absolutePath: string }[] = [];
  for (const candidate of candidates) {
    if (selected.length >= REFERENCED_FILE_CONTEXT_MAX_FILES) break;
    const absolutePath = resolve(cwd, candidate);
    const repoRelative = relative(cwd, absolutePath);
    if (!repoRelative || repoRelative.startsWith("..") || isAbsolute(repoRelative)) {
      continue;
    }

    const segments = candidate.split("/");
    let currentPath = cwd;
    let finalStat: Awaited<ReturnType<typeof lstat>> | null = null;
    let valid = true;
    for (const segment of segments) {
      currentPath = join(currentPath, segment);
      let stat;
      try {
        stat = await lstat(currentPath);
      } catch {
        valid = false;
        break;
      }
      if (stat.isSymbolicLink()) {
        valid = false;
        break;
      }
      finalStat = stat;
    }
    if (
      !valid ||
      !finalStat ||
      !finalStat.isFile() ||
      finalStat.size > REFERENCED_FILE_MAX_SOURCE_BYTES
    ) {
      continue;
    }

    const realCandidate = await realpath(absolutePath).catch(() => null);
    if (!realCandidate) continue;
    if (realCandidate !== rootReal && !realCandidate.startsWith(`${rootReal}${sep}`)) {
      continue;
    }

    selected.push({ path: candidate, absolutePath });
  }

  if (selected.length === 0) return [];

  const perFileBudget = Math.max(
    1024,
    Math.floor((REFERENCED_FILE_CONTEXT_MAX_BYTES - 512) / selected.length),
  );
  const contexts: ReferencedFileContext[] = [];
  for (const file of selected) {
    const content = await readFile(file.absolutePath, "utf8").catch(() => null);
    if (content === null || content.includes("\0")) continue;
    contexts.push({
      path: file.path,
      excerpt: renderBoundedFileExcerpt(content, perFileBudget),
    });
  }
  return contexts;
}

async function maybeAugmentBriefWithReferencedFiles(
  cwd: string,
  brief: string,
): Promise<string> {
  const contexts = await resolveReferencedFileContext(cwd, brief).catch(
    () => [] as ReferencedFileContext[],
  );
  if (contexts.length === 0) return brief;

  const contextBlock = contexts
    .map(
      (context) =>
        [`--- BEGIN FILE: ${context.path} ---`, context.excerpt, `--- END FILE: ${context.path} ---`].join(
          "\n",
        ),
    )
    .join("\n\n");
  const appendix = [
    "[Referenced existing file context; bounded for cheap worker]",
    contextBlock,
  ].join("\n");
  const boundedAppendix = truncateUtf8WithMarker(
    appendix,
    REFERENCED_FILE_CONTEXT_MAX_BYTES,
    REPO_CONTEXT_TOTAL_TRUNCATION_MARKER,
  );
  return `${brief}\n\n${boundedAppendix}`;
}

function repairRecognizableUnifiedDiffHunkCounts(diff: string): string {
  const normalized = diff.replace(/\r\n/g, "\n");
  const lines = normalized.split("\n");
  const hadTrailingNewline = lines.length > 0 && lines[lines.length - 1] === "";
  if (hadTrailingNewline) lines.pop();

  const repaired = [...lines];
  let touched = false;

  for (let index = 0; index < lines.length; index += 1) {
    const header = lines[index];
    const headerMatch = header.match(
      /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/,
    );
    if (!headerMatch) continue;

    const oldStart = headerMatch[1];
    const newStart = headerMatch[3];
    const section = headerMatch[5] || "";

    let oldCount = 0;
    let newCount = 0;
    let bodyIndex = index + 1;
    while (bodyIndex < lines.length) {
      const bodyLine = lines[bodyIndex];
      if (bodyLine.startsWith("@@ ") || bodyLine.startsWith("diff --git ")) {
        break;
      }
      // A plain multi-file patch can place a new ---/+++ file header directly
      // after a hunk. The same byte prefixes are also valid deleted/added hunk
      // content, so do not guess which case this is.
      if (bodyLine.startsWith("--- ") && lines[bodyIndex + 1]?.startsWith("+++ ")) {
        return diff;
      }
      if (bodyLine === "\\ No newline at end of file") {
        bodyIndex += 1;
        continue;
      }
      const prefix = bodyLine[0];
      if (prefix !== " " && prefix !== "+" && prefix !== "-") {
        return diff;
      }
      if (prefix !== "+") oldCount += 1;
      if (prefix !== "-") newCount += 1;
      bodyIndex += 1;
    }

    if (oldCount === 0 && newCount === 0) return diff;

    const oldCountFragment = oldCount === 1 ? "" : `,${oldCount}`;
    const newCountFragment = newCount === 1 ? "" : `,${newCount}`;
    const repairedHeader = `@@ -${oldStart}${oldCountFragment} +${newStart}${newCountFragment} @@${section}`;
    if (repairedHeader !== header) {
      repaired[index] = repairedHeader;
      touched = true;
    }
  }

  if (!touched) return diff;
  return `${repaired.join("\n")}${hadTrailingNewline ? "\n" : ""}`;
}

interface OpenAiCompatExactEdit {
  path: string;
  oldText: string;
  newText: string;
}

interface OpenAiCompatExactEdits {
  edits: OpenAiCompatExactEdit[];
}

function extractMarkerWrappedBody(
  text: string,
  markerStart: string,
  markerEnd: string,
): { ok: true; body: string } | { ok: false; error: string } {
  const trimmed = text.trim();
  const startCount = trimmed.split(markerStart).length - 1;
  const endCount = trimmed.split(markerEnd).length - 1;
  if (startCount !== 1 || endCount !== 1) {
    return {
      ok: false,
      error: `response must include exactly one ${markerStart}/${markerEnd} block`,
    };
  }

  const bodyPattern = new RegExp(
    `^${escapeRegex(markerStart)}\\r?\\n([\\s\\S]+?)\\r?\\n${escapeRegex(markerEnd)}$`,
  );
  const match = trimmed.match(bodyPattern);
  if (!match) {
    return {
      ok: false,
      error: `response must contain only the marker-wrapped block for ${markerStart}`,
    };
  }

  const body = match[1].trim();
  if (!body) {
    return { ok: false, error: "marker block is empty" };
  }
  return { ok: true, body };
}

function parseStrictExactEditsJson(
  text: string,
): { ok: true; value: OpenAiCompatExactEdits } | { ok: false; error: string } {
  const extracted = extractMarkerWrappedBody(
    text,
    OPENAI_COMPAT_EXACT_EDITS_START,
    OPENAI_COMPAT_EXACT_EDITS_END,
  );
  if (!extracted.ok) return { ok: false, error: extracted.error };

  const bodyBytes = Buffer.byteLength(extracted.body, "utf8");
  if (bodyBytes > OPENAI_COMPAT_EXACT_EDITS_MAX_BYTES) {
    return {
      ok: false,
      error: `exact-edit JSON exceeds ${OPENAI_COMPAT_EXACT_EDITS_MAX_BYTES} bytes`,
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(extracted.body);
  } catch (error: unknown) {
    return {
      ok: false,
      error: `exact-edit JSON parse failed: ${errorMessage(error)}`,
    };
  }

  if (!isRecord(parsed) || Array.isArray(parsed)) {
    return { ok: false, error: "exact-edit JSON must be an object" };
  }
  const rootKeys = Object.keys(parsed);
  if (rootKeys.length !== 1 || rootKeys[0] !== "edits") {
    return {
      ok: false,
      error: "exact-edit JSON must contain exactly one key: edits",
    };
  }
  if (!Array.isArray(parsed.edits)) {
    return { ok: false, error: "exact-edit JSON edits must be an array" };
  }
  if (parsed.edits.length < 1 || parsed.edits.length > OPENAI_COMPAT_EXACT_EDITS_MAX_EDITS) {
    return {
      ok: false,
      error: `exact-edit JSON edits must contain 1-${OPENAI_COMPAT_EXACT_EDITS_MAX_EDITS} entries`,
    };
  }

  const edits: OpenAiCompatExactEdit[] = [];
  const seenPaths = new Set<string>();
  for (let index = 0; index < parsed.edits.length; index += 1) {
    const candidate = parsed.edits[index];
    if (!isRecord(candidate) || Array.isArray(candidate)) {
      return { ok: false, error: `edit ${index} must be an object` };
    }
    const keys = Object.keys(candidate).sort();
    if (keys.join(",") !== "newText,oldText,path") {
      return {
        ok: false,
        error: `edit ${index} must contain exactly path, oldText, newText`,
      };
    }

    const path = candidate.path;
    const oldText = candidate.oldText;
    const newText = candidate.newText;
    if (typeof path !== "string" || typeof oldText !== "string" || typeof newText !== "string") {
      return {
        ok: false,
        error: `edit ${index} path, oldText, and newText must be strings`,
      };
    }
    if (!path.trim()) {
      return { ok: false, error: `edit ${index} path must be non-empty` };
    }
    if (Buffer.byteLength(path, "utf8") > OPENAI_COMPAT_EXACT_EDITS_MAX_PATH_BYTES) {
      return {
        ok: false,
        error: `edit ${index} path exceeds ${OPENAI_COMPAT_EXACT_EDITS_MAX_PATH_BYTES} bytes`,
      };
    }
    if (path.includes("\0") || oldText.includes("\0") || newText.includes("\0")) {
      return {
        ok: false,
        error: `edit ${index} contains a forbidden NUL character`,
      };
    }
    if (isForbiddenPath(path)) {
      return {
        ok: false,
        error: `edit ${index} path is unsafe: ${path}`,
      };
    }
    if (!oldText) {
      return { ok: false, error: `edit ${index} oldText must be non-empty` };
    }
    if (oldText === newText) {
      return {
        ok: false,
        error: `edit ${index} newText must differ from oldText`,
      };
    }
    if (seenPaths.has(path)) {
      return {
        ok: false,
        error: `exact-edit paths must be unique (duplicate: ${path})`,
      };
    }
    seenPaths.add(path);
    edits.push({ path, oldText, newText });
  }

  return { ok: true, value: { edits } };
}

export function extractMarkedUnifiedDiff(
  text: string,
): { ok: true; diff: string } | { ok: false; error: string } {
  const extracted = extractMarkerWrappedBody(
    text,
    OPENAI_COMPAT_DIFF_START,
    OPENAI_COMPAT_DIFF_END,
  );
  if (!extracted.ok) return { ok: false, error: extracted.error };

  const diffBody = extracted.body;
  if (!diffBody) {
    return { ok: false, error: "marker block is empty" };
  }
  // `git apply` requires a complete final patch line. The model response is
  // marker-wrapped, so normalize the extracted body to exactly one trailing
  // newline instead of trimming it away (#1693 live-run regression).
  const diff = `${diffBody}\n`;
  if (
    !/^diff --git\s/m.test(diff) &&
    (!/^---\s/m.test(diff) || !/^\+\+\+\s/m.test(diff))
  ) {
    return {
      ok: false,
      error: "marker block does not look like a unified diff",
    };
  }
  return { ok: true, diff };
}

function normalizePatchPath(raw: string): string {
  const value = raw.trim();
  if (value === "/dev/null") return value;
  if (value.startsWith('"') && value.endsWith('"')) {
    try {
      return JSON.parse(value).replace(/^[ab]\//, "");
    } catch {
      // Fall through to the conservative literal path.
    }
  }
  return value.replace(/^[ab]\//, "");
}

/** Derive the adapter's structured file list from the exact patch we apply.
 * `git diff --name-status` omits newly-created untracked files and can include
 * unrelated pre-existing worktree changes, so it is not authoritative here. */
function parsePatchFileChanges(diff: string): EngineFileChange[] {
  const changes: EngineFileChange[] = [];
  const seen = new Set<string>();
  const headerPattern = /^---[ \t]+(.+)\r?\n\+\+\+[ \t]+(.+)$/gm;
  for (const match of diff.matchAll(headerPattern)) {
    const oldPath = normalizePatchPath(match[1]);
    const newPath = normalizePatchPath(match[2]);
    const kind = oldPath === "/dev/null" ? "add" : newPath === "/dev/null" ? "delete" : "update";
    const path = kind === "delete" ? oldPath : newPath;
    if (path === "/dev/null" || seen.has(path)) continue;
    seen.add(path);
    changes.push({ path, kind });
  }
  return changes;
}

function countExactOccurrences(haystack: string, needle: string): number {
  if (!needle) return 0;
  let count = 0;
  let cursor = 0;
  while (cursor <= haystack.length) {
    const foundAt = haystack.indexOf(needle, cursor);
    if (foundAt === -1) break;
    count += 1;
    // Advance one code unit so overlapping matches are also ambiguous.
    cursor = foundAt + 1;
  }
  return count;
}

interface ExactEditResolvedFile {
  path: string;
  absolutePath: string;
  original: Buffer;
  next: Buffer;
}

async function derivePatchFromExactEdits(args: {
  cwd: string;
  edits: OpenAiCompatExactEdit[];
  runCommand: OpenAiCompatCommandRunner;
  timeoutMs: () => number;
  env?: Record<string, string>;
  commands: EngineCommand[];
  allowedPaths: Set<string>;
}): Promise<{ ok: true; diff: string } | { ok: false; error: string }> {
  const cwdReal = await realpath(args.cwd).catch(() => resolve(args.cwd));
  const sortedEdits = [...args.edits].sort((a, b) => a.path.localeCompare(b.path));

  const resolvedFiles: ExactEditResolvedFile[] = [];
  for (const edit of sortedEdits) {
    if (!args.allowedPaths.has(edit.path)) {
      return {
        ok: false,
        error: `exact-edit path was not explicitly referenced in the brief: ${edit.path}`,
      };
    }

    const absolutePath = resolve(args.cwd, edit.path);
    const repoRelative = relative(args.cwd, absolutePath);
    if (!repoRelative || repoRelative.startsWith("..") || isAbsolute(repoRelative)) {
      return { ok: false, error: `exact-edit path escapes repo root: ${edit.path}` };
    }

    const segments = edit.path.split("/");
    let currentPath = args.cwd;
    let finalStat: Awaited<ReturnType<typeof lstat>> | null = null;
    for (const segment of segments) {
      currentPath = join(currentPath, segment);
      let stat;
      try {
        stat = await lstat(currentPath);
      } catch {
        return {
          ok: false,
          error: `exact-edit target does not exist: ${edit.path}`,
        };
      }
      if (stat.isSymbolicLink()) {
        return {
          ok: false,
          error: `exact-edit path cannot target symlinks: ${edit.path}`,
        };
      }
      finalStat = stat;
    }

    if (!finalStat?.isFile()) {
      return {
        ok: false,
        error: `exact-edit target must be an existing regular file: ${edit.path}`,
      };
    }
    if (finalStat.size > REFERENCED_FILE_MAX_SOURCE_BYTES) {
      return {
        ok: false,
        error: `exact-edit target exceeds ${REFERENCED_FILE_MAX_SOURCE_BYTES} bytes: ${edit.path}`,
      };
    }

    const resolvedRealPath = await realpath(absolutePath).catch(() => null);
    if (!resolvedRealPath) {
      return {
        ok: false,
        error: `exact-edit target is unreadable: ${edit.path}`,
      };
    }
    if (
      resolvedRealPath !== cwdReal &&
      !resolvedRealPath.startsWith(`${cwdReal}${sep}`)
    ) {
      return {
        ok: false,
        error: `exact-edit path resolves outside repo root: ${edit.path}`,
      };
    }

    let originalBytes: Buffer;
    try {
      originalBytes = await readFile(absolutePath);
    } catch {
      return {
        ok: false,
        error: `exact-edit target is unreadable text: ${edit.path}`,
      };
    }
    if (originalBytes.includes(0)) {
      return {
        ok: false,
        error: `exact-edit target contains forbidden NUL bytes: ${edit.path}`,
      };
    }
    const original = originalBytes.toString("utf8");
    if (!originalBytes.equals(Buffer.from(original, "utf8"))) {
      return {
        ok: false,
        error: `exact-edit target is not valid UTF-8 text: ${edit.path}`,
      };
    }

    const occurrences = countExactOccurrences(original, edit.oldText);
    if (occurrences !== 1) {
      return {
        ok: false,
        error: `exact-edit oldText must appear exactly once in ${edit.path} (found ${occurrences})`,
      };
    }

    const next = original.replace(edit.oldText, edit.newText);
    resolvedFiles.push({
      path: edit.path,
      absolutePath,
      original: originalBytes,
      next: Buffer.from(next, "utf8"),
    });
  }

  const targetPaths = resolvedFiles.map((file) => file.path);
  const trackedArgs = ["ls-files", "--error-unmatch", "--", ...targetPaths];
  const trackedCommand = `git ${trackedArgs.join(" ")}`;
  const trackedResult = await args.runCommand({
    command: "git",
    args: trackedArgs,
    cwd: args.cwd,
    timeoutMs: args.timeoutMs(),
    env: args.env,
  });
  args.commands.push({
    command: trackedCommand,
    exitCode: trackedResult.exitCode,
  });
  if (trackedResult.timedOut || trackedResult.exitCode !== 0) {
    return {
      ok: false,
      error: "exact-edit targets must already be tracked by git",
    };
  }

  const statusArgs = ["status", "--porcelain", "--", ...targetPaths];
  const statusCommand = `git ${statusArgs.join(" ")}`;
  const statusResult = await args.runCommand({
    command: "git",
    args: statusArgs,
    cwd: args.cwd,
    timeoutMs: args.timeoutMs(),
    env: args.env,
  });
  args.commands.push({ command: statusCommand, exitCode: statusResult.exitCode });
  if (statusResult.timedOut || statusResult.exitCode !== 0) {
    return {
      ok: false,
      error: `failed to inspect target file cleanliness before exact-edit apply: ${safeTail(
        statusResult.stderr || statusResult.stdout || "non-zero exit",
      )}`,
    };
  }
  if (statusResult.stdout.trim().length > 0) {
    return {
      ok: false,
      error: "exact-edit targets have pre-existing staged or unstaged changes",
    };
  }

  let outcome: { ok: true; diff: string } | { ok: false; error: string } = {
    ok: false,
    error: "exact-edit preparation did not run",
  };
  const restoreFailures: string[] = [];
  try {
    let writeFailure: string | null = null;
    for (const file of resolvedFiles) {
      try {
        await writeFile(file.absolutePath, file.next, "utf8");
      } catch {
        writeFailure = file.path;
        break;
      }
    }

    if (writeFailure) {
      outcome = {
        ok: false,
        error: `failed to stage temporary exact-edit content for ${writeFailure}`,
      };
    } else {
      const diffArgs = [
        "diff",
        "--binary",
        "--no-ext-diff",
        "--",
        ...targetPaths,
      ];
      const diffCommand = `git ${diffArgs.join(" ")}`;
      const diffResult = await args.runCommand({
        command: "git",
        args: diffArgs,
        cwd: args.cwd,
        timeoutMs: args.timeoutMs(),
        env: args.env,
      });
      args.commands.push({ command: diffCommand, exitCode: diffResult.exitCode });
      if (diffResult.timedOut || diffResult.exitCode !== 0) {
        outcome = {
          ok: false,
          error: `failed to generate git diff for exact edits: ${safeTail(
            diffResult.stderr || diffResult.stdout || "non-zero exit",
          )}`,
        };
      } else if (!diffResult.stdout.trim()) {
        outcome = {
          ok: false,
          error: "exact-edit contract produced an empty git diff",
        };
      } else {
        outcome = { ok: true, diff: diffResult.stdout };
      }
    }
  } finally {
    await Promise.all(
      resolvedFiles.map(async (file) => {
        try {
          await writeFile(file.absolutePath, file.original, "utf8");
        } catch {
          restoreFailures.push(file.path);
        }
      }),
    );
  }

  if (restoreFailures.length > 0) {
    return {
      ok: false,
      error: `failed to restore original content after exact-edit diff generation (${restoreFailures.join(", ")})`,
    };
  }
  return outcome;
}

function buildResult(args: {
  ok: boolean;
  startedMs: number;
  nowMs: () => number;
  exitCode: number | null;
  commands: EngineCommand[];
  fileChanges: EngineFileChange[];
  messages: string[];
  errors: string[];
  usage: EngineUsage | null;
  rawEventCount: number;
}): WorkerRunResult {
  return {
    ok: args.ok,
    exitCode: args.exitCode,
    durationMs: Math.max(0, args.nowMs() - args.startedMs),
    commands: args.commands,
    fileChanges: args.fileChanges,
    messages: args.messages,
    errors: args.errors,
    usage: args.usage,
    rawEventCount: args.rawEventCount,
  };
}

const SYSTEM_PROMPT = [
  "You are a single-shot patch engine for a git checkout.",
  "Prefer this contract for existing-file replacements:",
  OPENAI_COMPAT_EXACT_EDITS_START,
  '{"edits":[{"path":"repo/relative.txt","oldText":"exact unique existing text","newText":"replacement text"}]}',
  OPENAI_COMPAT_EXACT_EDITS_END,
  "The exact-edit JSON must be strict: object with only edits[], 1-3 edits, each edit has only path/oldText/newText.",
  "Each exact edit must target a safe repo-relative existing file explicitly named in the user request, and oldText must match exactly once.",
  "If exact edits are not viable, fall back to one unified diff wrapped by:",
  OPENAI_COMPAT_DIFF_START,
  "<UNIFIED_DIFF>",
  OPENAI_COMPAT_DIFF_END,
  "Return exactly one marker block (exact-edits preferred), never both.",
  "No prose, no markdown fences, no shell commands, no extra text.",
  "Any unified diff must be directly applicable with `git apply`.",
].join("\n");

/**
 * OpenAI-compatible single-shot patch engine.
 * - exactly one chat-completions request
 * - strict marker-wrapped contract: preferred exact-edits JSON OR legacy unified diff
 * - exact-edits are materialized to a deterministic git patch via temporary edits + git diff
 * - git apply --check, then apply
 * - run ONLY worker-configured verification commands
 */
export async function runOpenAiCompatEngine(
  opts: OpenAiCompatRunOpts,
  deps: OpenAiCompatDeps = {},
): Promise<WorkerRunResult> {
  const nowMs = deps.nowMs || defaultNowMs;
  const startedMs = nowMs();
  const fetchImpl = deps.fetchImpl || (fetch as typeof fetch);
  const runCommand = deps.runCommand || defaultRunCommand;

  const commands: EngineCommand[] = [];
  const fileChanges: EngineFileChange[] = [];
  const messages: string[] = [];
  const errors: string[] = [];
  let usage: EngineUsage | null = null;
  let rawEventCount = 0;

  const verificationCommands = Array.isArray(opts.verificationCommands)
    ? opts.verificationCommands
        .filter(
          (c): c is string => typeof c === "string" && c.trim().length > 0,
        )
        .map((c) => c.trim())
    : [];

  const deadlineMs = startedMs + Math.max(1, opts.timeoutMs);
  const remainingMs = () => Math.max(1, deadlineMs - nowMs());

  const baseUrl = (
    opts.baseUrl ||
    process.env.OPENAI_COMPAT_BASE_URL ||
    "https://api.openai.com/v1"
  ).replace(/\/+$/, "");
  const apiKeyEnv =
    typeof opts.apiKeyEnv === "string" && opts.apiKeyEnv.trim().length > 0
      ? opts.apiKeyEnv.trim()
      : "OPENAI_API_KEY";
  const apiKey = Object.prototype.hasOwnProperty.call(opts.env || {}, apiKeyEnv)
    ? opts.env?.[apiKeyEnv]
    : process.env[apiKeyEnv];

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (apiKey) {
    headers.Authorization = `Bearer ${apiKey}`;
    headers["api-key"] = apiKey;
  }

  const abortController = new AbortController();
  const requestTimer = setTimeout(() => abortController.abort(), remainingMs());
  const userPrompt = await maybeAugmentBriefWithReferencedFiles(opts.cwd, opts.brief);

  let payload: unknown;
  try {
    rawEventCount = 1;
    const response = await fetchImpl(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        model: opts.model,
        temperature: 0,
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: userPrompt },
        ],
      }),
      signal: abortController.signal,
    });

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      errors.push(
        `chat-completions HTTP ${response.status}: ${safeTail(body)}`,
      );
      messages.push("OpenAI-compatible engine failed on HTTP request.");
      return buildResult({
        ok: false,
        startedMs,
        nowMs,
        exitCode: null,
        commands,
        fileChanges,
        messages,
        errors,
        usage,
        rawEventCount,
      });
    }

    try {
      payload = await response.json();
    } catch (error: unknown) {
      errors.push(`invalid chat-completions JSON: ${errorMessage(error)}`);
      messages.push("OpenAI-compatible engine failed to parse JSON response.");
      return buildResult({
        ok: false,
        startedMs,
        nowMs,
        exitCode: null,
        commands,
        fileChanges,
        messages,
        errors,
        usage,
        rawEventCount,
      });
    }
  } catch (error: unknown) {
    const detail =
      error instanceof Error && error.name === "AbortError"
        ? `request timed out at ${opts.timeoutMs}ms`
        : errorMessage(error);
    errors.push(`chat-completions request failed: ${detail}`);
    messages.push(
      "OpenAI-compatible engine request failed before patch extraction.",
    );
    return buildResult({
      ok: false,
      startedMs,
      nowMs,
      exitCode: null,
      commands,
      fileChanges,
      messages,
      errors,
      usage,
      rawEventCount,
    });
  } finally {
    clearTimeout(requestTimer);
  }

  usage = normalizeUsage(isRecord(payload) ? payload.usage : null);
  const text = extractMessageText(payload);
  if (!text) {
    errors.push(
      "chat-completions response missing choices[0].message.content text",
    );
    messages.push("OpenAI-compatible engine received malformed model content.");
    return buildResult({
      ok: false,
      startedMs,
      nowMs,
      exitCode: null,
      commands,
      fileChanges,
      messages,
      errors,
      usage,
      rawEventCount,
    });
  }

  const hasExactMarkers =
    text.includes(OPENAI_COMPAT_EXACT_EDITS_START) ||
    text.includes(OPENAI_COMPAT_EXACT_EDITS_END);
  const hasDiffMarkers =
    text.includes(OPENAI_COMPAT_DIFF_START) ||
    text.includes(OPENAI_COMPAT_DIFF_END);
  if (hasExactMarkers && hasDiffMarkers) {
    errors.push(
      "response contract violation: response must contain exactly one marker block (exact-edits OR unified diff), not both",
    );
    messages.push(
      "OpenAI-compatible engine rejected model output (mixed marker contracts).",
    );
    return buildResult({
      ok: false,
      startedMs,
      nowMs,
      exitCode: null,
      commands,
      fileChanges,
      messages,
      errors,
      usage,
      rawEventCount,
    });
  }

  let patchDiff = "";
  if (hasExactMarkers) {
    const parsedExact = parseStrictExactEditsJson(text);
    if (!parsedExact.ok) {
      errors.push(`exact-edit contract violation: ${parsedExact.error}`);
      messages.push(
        "OpenAI-compatible engine rejected model output (exact-edit marker contract).",
      );
      return buildResult({
        ok: false,
        startedMs,
        nowMs,
        exitCode: null,
        commands,
        fileChanges,
        messages,
        errors,
        usage,
        rawEventCount,
      });
    }

    const derived = await derivePatchFromExactEdits({
      cwd: opts.cwd,
      edits: parsedExact.value.edits,
      runCommand,
      timeoutMs: remainingMs,
      env: opts.env,
      commands,
      allowedPaths: new Set(
        extractBriefPathCandidates(opts.brief).filter(
          (candidate) => !isForbiddenPath(candidate),
        ),
      ),
    });
    if (!derived.ok) {
      errors.push(`exact-edit apply-prep failed: ${derived.error}`);
      messages.push(
        "OpenAI-compatible engine rejected exact edits before git apply.",
      );
      return buildResult({
        ok: false,
        startedMs,
        nowMs,
        exitCode: null,
        commands,
        fileChanges,
        messages,
        errors,
        usage,
        rawEventCount,
      });
    }
    patchDiff = derived.diff;
  } else {
    const extracted = extractMarkedUnifiedDiff(text);
    if (!extracted.ok) {
      const parseError = extracted.error;
      errors.push(`unified diff contract violation: ${parseError}`);
      messages.push(
        "OpenAI-compatible engine rejected model output (diff marker contract).",
      );
      return buildResult({
        ok: false,
        startedMs,
        nowMs,
        exitCode: null,
        commands,
        fileChanges,
        messages,
        errors,
        usage,
        rawEventCount,
      });
    }
    patchDiff = extracted.diff;
  }

  const repairedDiff = repairRecognizableUnifiedDiffHunkCounts(patchDiff);
  fileChanges.push(...parsePatchFileChanges(repairedDiff));

  let patchDir = "";
  let patchPath = "";
  const reverseAppliedPatch = async (reason: string) => {
    if (!patchPath) return;
    const rollbackCommand = `git apply -R --whitespace=nowarn ${patchPath}`;
    const rollback = await runCommand({
      command: "git",
      args: ["apply", "-R", "--whitespace=nowarn", patchPath],
      cwd: opts.cwd,
      timeoutMs: remainingMs(),
      env: opts.env,
    });
    commands.push({ command: rollbackCommand, exitCode: rollback.exitCode });
    if (rollback.timedOut || rollback.exitCode !== 0) {
      errors.push(
        `rollback failed after ${reason}: ${safeTail(
          rollback.stderr ||
            rollback.stdout ||
            (rollback.timedOut ? "timed out" : "non-zero exit"),
        )}`,
      );
    } else {
      messages.push(`Rolled back applied patch after ${reason}.`);
    }
  };

  try {
    patchDir = await mkdtemp(join(tmpdir(), "worker-openai-compat-"));
    patchPath = join(patchDir, "patch.diff");
    await writeFile(patchPath, repairedDiff, "utf8");

    const patchCheckCommand = `git apply --check --whitespace=nowarn ${patchPath}`;
    const patchCheck = await runCommand({
      command: "git",
      args: ["apply", "--check", "--whitespace=nowarn", patchPath],
      cwd: opts.cwd,
      timeoutMs: remainingMs(),
      env: opts.env,
    });
    commands.push({
      command: patchCheckCommand,
      exitCode: patchCheck.exitCode,
    });
    if (patchCheck.timedOut || patchCheck.exitCode !== 0) {
      errors.push(
        `git apply --check failed: ${safeTail(patchCheck.stderr || patchCheck.stdout || "non-zero exit")}`,
      );
      messages.push("OpenAI-compatible engine patch failed preflight check.");
      return buildResult({
        ok: false,
        startedMs,
        nowMs,
        exitCode: patchCheck.exitCode,
        commands,
        fileChanges,
        messages,
        errors,
        usage,
        rawEventCount,
      });
    }

    const patchApplyCommand = `git apply --whitespace=nowarn ${patchPath}`;
    const patchApply = await runCommand({
      command: "git",
      args: ["apply", "--whitespace=nowarn", patchPath],
      cwd: opts.cwd,
      timeoutMs: remainingMs(),
      env: opts.env,
    });
    commands.push({
      command: patchApplyCommand,
      exitCode: patchApply.exitCode,
    });
    if (patchApply.timedOut || patchApply.exitCode !== 0) {
      errors.push(
        `git apply failed: ${safeTail(patchApply.stderr || patchApply.stdout || "non-zero exit")}`,
      );
      messages.push("OpenAI-compatible engine failed to apply patch.");
      return buildResult({
        ok: false,
        startedMs,
        nowMs,
        exitCode: patchApply.exitCode,
        commands,
        fileChanges,
        messages,
        errors,
        usage,
        rawEventCount,
      });
    }

    for (const command of verificationCommands) {
      const verification = await runCommand({
        command: "bash",
        args: ["-lc", command],
        cwd: opts.cwd,
        timeoutMs: remainingMs(),
        env: opts.env,
      });
      commands.push({ command, exitCode: verification.exitCode });
      if (verification.timedOut || verification.exitCode !== 0) {
        errors.push(
          `verification failed: ${command} (exit ${verification.exitCode ?? "null"}) ${safeTail(
            verification.stderr || verification.stdout,
          )}`,
        );
        messages.push(
          "OpenAI-compatible engine patch applied, but verification failed.",
        );
        await reverseAppliedPatch("verification failure");
        return buildResult({
          ok: false,
          startedMs,
          nowMs,
          exitCode: verification.exitCode,
          commands,
          fileChanges,
          messages,
          errors,
          usage,
          rawEventCount,
        });
      }
    }

    messages.push(
      `Applied patch and passed ${verificationCommands.length} verification command${verificationCommands.length === 1 ? "" : "s"}.`,
    );
    return buildResult({
      ok: true,
      startedMs,
      nowMs,
      exitCode: 0,
      commands,
      fileChanges,
      messages,
      errors,
      usage,
      rawEventCount,
    });
  } catch (error: unknown) {
    errors.push(`patch extraction/apply failure: ${errorMessage(error)}`);
    messages.push("OpenAI-compatible engine failed during patch handling.");
    return buildResult({
      ok: false,
      startedMs,
      nowMs,
      exitCode: null,
      commands,
      fileChanges,
      messages,
      errors,
      usage,
      rawEventCount,
    });
  } finally {
    if (patchDir) {
      await rm(patchDir, { recursive: true, force: true }).catch(
        () => undefined,
      );
    }
  }
}
