import { execFileSync } from "child_process";
import { mkdtempSync, readFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  OPENAI_COMPAT_DIFF_END,
  OPENAI_COMPAT_DIFF_START,
  runOpenAiCompatEngine,
} from "@/lib/workers/engine-openai-compat";
import type { OpenAiCompatCommandRequest } from "@/lib/workers/engine-openai-compat";

function makeResponse(payload: any, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => payload,
    text: async () => JSON.stringify(payload),
  } as any;
}

function makeDiff(path = "README.md", addedPath?: string) {
  return [
    OPENAI_COMPAT_DIFF_START,
    `diff --git a/${path} b/${path}`,
    `--- a/${path}`,
    `+++ b/${path}`,
    "@@ -1 +1 @@",
    "-old",
    "+new",
    ...(addedPath
      ? [
          `diff --git a/${addedPath} b/${addedPath}`,
          "new file mode 100644",
          "--- /dev/null",
          `+++ b/${addedPath}`,
          "@@ -0,0 +1 @@",
          "+created",
        ]
      : []),
    OPENAI_COMPAT_DIFF_END,
  ].join("\n");
}

function successRunner(overrides: Partial<Record<string, any>> = {}) {
  return vi.fn(async (request: OpenAiCompatCommandRequest) => {
    const joined = `${request.command} ${request.args.join(" ")}`;
    if (joined.includes("git apply --check"))
      return { exitCode: 0, stdout: "", stderr: "", timedOut: false };
    if (joined.includes("git apply --whitespace=nowarn")) {
      return { exitCode: 0, stdout: "", stderr: "", timedOut: false };
    }
    if (joined.includes("git diff --name-status")) {
      return {
        exitCode: 0,
        stdout: "M\tREADME.md\nA\tsrc/new.ts\n",
        stderr: "",
        timedOut: false,
      };
    }
    if (
      joined ===
      "bash -lc npm run test -- src/__tests__/engine-openai-compat.test.ts"
    ) {
      return { exitCode: 0, stdout: "", stderr: "", timedOut: false };
    }
    if (
      joined === "bash -lc npx eslint src/lib/workers/engine-openai-compat.ts"
    ) {
      return { exitCode: 0, stdout: "", stderr: "", timedOut: false };
    }
    if (overrides[joined]) return overrides[joined];
    return { exitCode: 0, stdout: "", stderr: "", timedOut: false };
  });
}

afterEach(() => {
  delete process.env.TEST_OPENAI_KEY;
  delete process.env.ENV_ONLY_OPENAI_KEY;
});

describe("#1693: OpenAI-compatible worker engine", () => {
  it("preserves the terminal patch newline required by real git apply", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "openai-compat-real-git-"));
    try {
      execFileSync("git", ["init", "-q"], { cwd });
      const content = [
        OPENAI_COMPAT_DIFF_START,
        "diff --git a/live-proof.txt b/live-proof.txt",
        "new file mode 100644",
        "--- /dev/null",
        "+++ b/live-proof.txt",
        "@@ -0,0 +1 @@",
        "+ok",
        OPENAI_COMPAT_DIFF_END,
      ].join("\n");
      const fetchImpl = vi.fn(async () =>
        makeResponse({ choices: [{ message: { content } }], usage: {} }),
      );

      const result = await runOpenAiCompatEngine(
        {
          cwd,
          brief: "Create the live proof fixture",
          model: "gpt-4.1-mini",
          timeoutMs: 30_000,
          baseUrl: "https://models.example/v1",
          verificationCommands: [],
        },
        { fetchImpl: fetchImpl as any },
      );

      expect(result.ok).toBe(true);
      expect(result.fileChanges).toEqual([
        { path: "live-proof.txt", kind: "add" },
      ]);
      expect(readFileSync(join(cwd, "live-proof.txt"), "utf8")).toBe("ok\n");
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("makes one chat-completions request, applies patch, and runs configured verification commands", async () => {
    process.env.TEST_OPENAI_KEY = "shh";
    const fetchImpl = vi.fn(async (_url: string, _init: any) =>
      makeResponse({
        choices: [{ message: { content: makeDiff("README.md", "src/new.ts") } }],
        usage: { prompt_tokens: 21, completion_tokens: 8 },
      }),
    );
    const runCommand = successRunner();

    const result = await runOpenAiCompatEngine(
      {
        cwd: "/tmp",
        brief: "Apply fix",
        model: "local-oss-model",
        timeoutMs: 30_000,
        baseUrl: "http://127.0.0.1:11434/v1/",
        apiKeyEnv: "TEST_OPENAI_KEY",
        verificationCommands: [
          "npm run test -- src/__tests__/engine-openai-compat.test.ts",
          "npx eslint src/lib/workers/engine-openai-compat.ts",
        ],
      },
      { fetchImpl: fetchImpl as any, runCommand },
    );

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe("http://127.0.0.1:11434/v1/chat/completions");
    expect(init.headers.Authorization).toBe("Bearer shh");
    expect(init.headers["api-key"]).toBe("shh");
    expect(result.ok).toBe(true);
    expect(result.usage?.inputTokens).toBe(21);
    expect(result.usage?.outputTokens).toBe(8);
    expect(result.fileChanges).toEqual([
      { path: "README.md", kind: "update" },
      { path: "src/new.ts", kind: "add" },
    ]);
    expect(result.commands.map((c) => c.command)).toContain(
      "npm run test -- src/__tests__/engine-openai-compat.test.ts",
    );
    expect(result.commands.map((c) => c.command)).toContain(
      "npx eslint src/lib/workers/engine-openai-compat.ts",
    );
  });

  it("allows requests without auth header when apiKeyEnv is unset/missing", async () => {
    const fetchImpl = vi.fn(async (_url: string, _init: any) =>
      makeResponse({
        choices: [{ message: { content: makeDiff("x.ts") } }],
        usage: {},
      }),
    );
    const runCommand = successRunner();

    const result = await runOpenAiCompatEngine(
      {
        cwd: "/tmp",
        brief: "Apply fix",
        model: "local-oss-model",
        timeoutMs: 30_000,
        baseUrl: "http://localhost:8080/v1",
        apiKeyEnv: "MISSING_KEY_ENV",
        verificationCommands: [],
      },
      { fetchImpl: fetchImpl as any, runCommand },
    );

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [, init] = fetchImpl.mock.calls[0];
    expect(init.headers.Authorization).toBeUndefined();
    expect(init.headers["api-key"]).toBeUndefined();
    expect(result.ok).toBe(true);
  });

  it("prefers opts.env API keys and sends Azure/OpenAI-compatible auth headers", async () => {
    process.env.ENV_ONLY_OPENAI_KEY = "process-key";
    const fetchImpl = vi.fn(async (_url: string, _init: any) =>
      makeResponse({
        choices: [{ message: { content: makeDiff("env.ts") } }],
        usage: {},
      }),
    );
    const runCommand = successRunner();

    const result = await runOpenAiCompatEngine(
      {
        cwd: "/tmp",
        brief: "Apply fix",
        model: "m",
        timeoutMs: 30_000,
        apiKeyEnv: "ENV_ONLY_OPENAI_KEY",
        env: { ENV_ONLY_OPENAI_KEY: "injected-key" },
        verificationCommands: [],
      },
      { fetchImpl: fetchImpl as any, runCommand },
    );

    const [, init] = fetchImpl.mock.calls[0];
    expect(init.headers.Authorization).toBe("Bearer injected-key");
    expect(init.headers["api-key"]).toBe("injected-key");
    expect(result.ok).toBe(true);
  });

  it("returns structured parse failure on malformed model response", async () => {
    const fetchImpl = vi.fn(async () =>
      makeResponse({
        choices: [
          { message: { content: "Here is your patch:\n--- a/x\n+++ b/x" } },
        ],
      }),
    );
    const runCommand = vi.fn();

    const result = await runOpenAiCompatEngine(
      {
        cwd: "/tmp",
        brief: "Apply fix",
        model: "m",
        timeoutMs: 30_000,
        verificationCommands: ["echo nope"],
      },
      { fetchImpl: fetchImpl as any, runCommand: runCommand as any },
    );

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(runCommand).not.toHaveBeenCalled();
    expect(result.ok).toBe(false);
    expect(result.errors.join("\n")).toContain(
      "unified diff contract violation",
    );
  });

  it("returns structured patch-check failure and skips verification", async () => {
    const fetchImpl = vi.fn(async () =>
      makeResponse({
        choices: [{ message: { content: makeDiff("bad.ts") } }],
        usage: {},
      }),
    );
    const runCommand = vi.fn(async (request: OpenAiCompatCommandRequest) => {
      const joined = `${request.command} ${request.args.join(" ")}`;
      if (joined.includes("git apply --check")) {
        return {
          exitCode: 1,
          stdout: "",
          stderr: "patch does not apply",
          timedOut: false,
        };
      }
      return { exitCode: 0, stdout: "", stderr: "", timedOut: false };
    });

    const result = await runOpenAiCompatEngine(
      {
        cwd: "/tmp",
        brief: "Apply fix",
        model: "m",
        timeoutMs: 30_000,
        verificationCommands: ["npm test"],
      },
      { fetchImpl: fetchImpl as any, runCommand },
    );

    expect(result.ok).toBe(false);
    expect(result.errors.join("\n")).toContain("git apply --check failed");
    expect(
      runCommand.mock.calls.some((call) => call[0].command === "bash"),
    ).toBe(false);
  });

  it("returns structured verification failure after patch apply", async () => {
    const fetchImpl = vi.fn(async () =>
      makeResponse({
        choices: [{ message: { content: makeDiff("verify.ts") } }],
        usage: {},
      }),
    );
    const runCommand = vi.fn(async (request: OpenAiCompatCommandRequest) => {
      const joined = `${request.command} ${request.args.join(" ")}`;
      if (joined.includes("git apply --check"))
        return { exitCode: 0, stdout: "", stderr: "", timedOut: false };
      if (joined.includes("git apply --whitespace=nowarn")) {
        return { exitCode: 0, stdout: "", stderr: "", timedOut: false };
      }
      if (joined.includes("git diff --name-status")) {
        return {
          exitCode: 0,
          stdout: "M\tverify.ts\n",
          stderr: "",
          timedOut: false,
        };
      }
      if (joined === "bash -lc npm run test -- verify.ts") {
        return {
          exitCode: 2,
          stdout: "",
          stderr: "test failure",
          timedOut: false,
        };
      }
      return { exitCode: 0, stdout: "", stderr: "", timedOut: false };
    });

    const result = await runOpenAiCompatEngine(
      {
        cwd: "/tmp",
        brief: "Apply fix",
        model: "m",
        timeoutMs: 30_000,
        verificationCommands: ["npm run test -- verify.ts"],
      },
      { fetchImpl: fetchImpl as any, runCommand },
    );

    expect(result.ok).toBe(false);
    expect(result.exitCode).toBe(2);
    expect(result.errors.join("\n")).toContain("verification failed");
    expect(result.commands).toContainEqual({
      command: "npm run test -- verify.ts",
      exitCode: 2,
    });
    expect(result.commands.some((c) => c.command.includes("git apply -R"))).toBe(
      true,
    );
  });

  it("attempts rollback when verification fails and reports rollback failure", async () => {
    const fetchImpl = vi.fn(async () =>
      makeResponse({
        choices: [{ message: { content: makeDiff("verify.ts") } }],
        usage: {},
      }),
    );
    const runCommand = vi.fn(async (request: OpenAiCompatCommandRequest) => {
      const joined = `${request.command} ${request.args.join(" ")}`;
      if (joined.includes("git apply --check"))
        return { exitCode: 0, stdout: "", stderr: "", timedOut: false };
      if (joined.includes("git apply --whitespace=nowarn")) {
        return { exitCode: 0, stdout: "", stderr: "", timedOut: false };
      }
      if (joined.includes("git diff --name-status")) {
        return {
          exitCode: 0,
          stdout: "M\tverify.ts\n",
          stderr: "",
          timedOut: false,
        };
      }
      if (joined === "bash -lc npm run test -- verify.ts") {
        return {
          exitCode: 2,
          stdout: "",
          stderr: "test failure",
          timedOut: false,
        };
      }
      if (joined.includes("git apply -R --whitespace=nowarn")) {
        return {
          exitCode: 1,
          stdout: "",
          stderr: "reverse failed",
          timedOut: false,
        };
      }
      return { exitCode: 0, stdout: "", stderr: "", timedOut: false };
    });

    const result = await runOpenAiCompatEngine(
      {
        cwd: "/tmp",
        brief: "Apply fix",
        model: "m",
        timeoutMs: 30_000,
        verificationCommands: ["npm run test -- verify.ts"],
      },
      { fetchImpl: fetchImpl as any, runCommand },
    );

    expect(result.ok).toBe(false);
    expect(result.commands.some((c) => c.command.includes("git apply -R"))).toBe(
      true,
    );
    expect(result.errors.join("\n")).toContain(
      "rollback failed after verification failure",
    );
    expect(result.errors.join("\n")).toContain("reverse failed");
  });
});
