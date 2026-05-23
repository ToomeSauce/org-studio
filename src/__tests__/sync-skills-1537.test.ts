/**
 * sync-skills-1537.test.ts
 *
 * Verifies that scripts/sync-skills.sh:
 *   1. Mirrors SKILL.md + references/*.md from the canonical source into
 *      every workspace-* dir that already has a skills/org-studio-api/.
 *   2. Skips workspace-* dirs that do NOT have skills/org-studio-api/
 *      (does NOT bootstrap new installs).
 *   3. Is idempotent — re-running with no source change writes no files
 *      and reports 0 files written.
 *   4. Leaves non-canonical files (e.g. agent-local notes) untouched.
 *   5. --dry-run does not touch the filesystem.
 *
 * Filed in v0.4.0 retro: workspace-* skill copies silently drift from the
 * repo source. This script + test makes the drift impossible after the
 * next release.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

const REPO_ROOT = path.resolve(__dirname, "..", "..");
const SCRIPT = path.join(REPO_ROOT, "scripts", "sync-skills.sh");
const CANONICAL_SRC = path.join(REPO_ROOT, "skills", "org-studio-api");

function makeTmpRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "sync-skills-test-"));
}

function makeWorkspace(root: string, name: string, withSkill: boolean) {
  const ws = path.join(root, `workspace-${name}`);
  fs.mkdirSync(ws, { recursive: true });
  if (withSkill) {
    const sd = path.join(ws, "skills", "org-studio-api");
    fs.mkdirSync(path.join(sd, "references"), { recursive: true });
    // Seed with stale content so we can verify it gets overwritten.
    fs.writeFileSync(path.join(sd, "SKILL.md"), "STALE SKILL CONTENT");
    fs.writeFileSync(
      path.join(sd, "references", "api-reference.md"),
      "STALE REFERENCE CONTENT",
    );
  }
  return ws;
}

function run(tmpRoot: string, extraArgs: string[] = []) {
  return execSync(
    `bash ${SCRIPT} --quiet ${extraArgs.join(" ")}`.trim(),
    {
      env: { ...process.env, OPENCLAW_WORKSPACES_ROOT: tmpRoot },
      encoding: "utf8",
    },
  );
}

describe("scripts/sync-skills.sh (#1537)", () => {
  let tmpRoot: string;

  beforeEach(() => {
    tmpRoot = makeTmpRoot();
  });

  afterEach(() => {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  it("mirrors SKILL.md + references/*.md into workspaces that have the skill dir", () => {
    const ws = makeWorkspace(tmpRoot, "alpha", true);
    run(tmpRoot);

    const canonicalSkill = fs.readFileSync(
      path.join(CANONICAL_SRC, "SKILL.md"),
      "utf8",
    );
    const wsSkill = fs.readFileSync(
      path.join(ws, "skills", "org-studio-api", "SKILL.md"),
      "utf8",
    );
    expect(wsSkill).toBe(canonicalSkill);

    const canonicalRef = fs.readFileSync(
      path.join(CANONICAL_SRC, "references", "api-reference.md"),
      "utf8",
    );
    const wsRef = fs.readFileSync(
      path.join(ws, "skills", "org-studio-api", "references", "api-reference.md"),
      "utf8",
    );
    expect(wsRef).toBe(canonicalRef);
  });

  it("skips workspaces that do NOT have skills/org-studio-api/ (no bootstrap)", () => {
    const wsWithout = makeWorkspace(tmpRoot, "noskill", false);
    run(tmpRoot);
    // The skill dir should NOT have been created.
    expect(fs.existsSync(path.join(wsWithout, "skills", "org-studio-api"))).toBe(
      false,
    );
  });

  it("is idempotent — second run writes zero files", () => {
    makeWorkspace(tmpRoot, "alpha", true);
    makeWorkspace(tmpRoot, "beta", true);

    // First run: should write all canonical files.
    const out1 = execSync(`bash ${SCRIPT}`, {
      env: { ...process.env, OPENCLAW_WORKSPACES_ROOT: tmpRoot },
      encoding: "utf8",
    });
    expect(out1).toMatch(/files written:\s+[1-9]/);

    // Second run: nothing to do.
    const out2 = execSync(`bash ${SCRIPT}`, {
      env: { ...process.env, OPENCLAW_WORKSPACES_ROOT: tmpRoot },
      encoding: "utf8",
    });
    expect(out2).toMatch(/files written:\s+0/);
    expect(out2).toMatch(/already in sync:\s+[1-9]/);
  });

  it("leaves non-canonical files in the workspace skill dir untouched", () => {
    const ws = makeWorkspace(tmpRoot, "alpha", true);
    // Drop an agent-local file that is NOT in the canonical source.
    const localNote = path.join(
      ws,
      "skills",
      "org-studio-api",
      "AGENT_LOCAL_NOTES.md",
    );
    fs.writeFileSync(localNote, "do not delete me");

    run(tmpRoot);
    expect(fs.existsSync(localNote)).toBe(true);
    expect(fs.readFileSync(localNote, "utf8")).toBe("do not delete me");
  });

  it("--dry-run does not modify the filesystem", () => {
    const ws = makeWorkspace(tmpRoot, "alpha", true);
    const stalePath = path.join(ws, "skills", "org-studio-api", "SKILL.md");
    const before = fs.readFileSync(stalePath, "utf8");
    expect(before).toBe("STALE SKILL CONTENT");

    execSync(`bash ${SCRIPT} --dry-run`, {
      env: { ...process.env, OPENCLAW_WORKSPACES_ROOT: tmpRoot },
      encoding: "utf8",
    });

    const after = fs.readFileSync(stalePath, "utf8");
    expect(after).toBe("STALE SKILL CONTENT");
  });

  it("succeeds (exit 0) when no workspaces exist", () => {
    // tmpRoot exists but has no workspace-* children.
    expect(() => run(tmpRoot)).not.toThrow();
  });

  it("succeeds (exit 0) when workspaces root does not exist", () => {
    const missing = path.join(tmpRoot, "does-not-exist");
    expect(() =>
      execSync(`bash ${SCRIPT} --quiet`, {
        env: { ...process.env, OPENCLAW_WORKSPACES_ROOT: missing },
        encoding: "utf8",
      }),
    ).not.toThrow();
  });
});
