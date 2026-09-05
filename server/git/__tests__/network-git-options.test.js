import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createStatusOperations } from "../status.js";

// The network timeout derives from the HTTP idle budget. Config re-reads the
// environment on every call until initializeServerConfig() pins a value, so
// setting the budget at file scope reaches the operations under test; 4s
// yields a 2s bound (4s - 2s margin).
process.env.GARCON_HTTP_IDLE_TIMEOUT_SECONDS = "4";

const fakeGitScript = `#!${process.execPath}
const argv = process.argv.slice(2);
const cmd = argv[0];
if (cmd === "rev-parse") {
  if (argv.includes("--is-inside-work-tree")) {
    console.log("true");
    process.exit(0);
  }
  const last = argv.at(-1) ?? "";
  if (last.includes("@{upstream}")) process.exit(1);
  console.log("main");
  process.exit(0);
}
if (cmd === "fetch" || cmd === "pull" || cmd === "push") {
  const fs = await import("node:fs");
  fs.appendFileSync(
    process.env.FAKE_GIT_RECORD,
    JSON.stringify({ argv, terminalPrompt: process.env.GIT_TERMINAL_PROMPT ?? null }) + "\\n",
  );
  if (process.env.FAKE_GIT_SLEEP === "1") await new Promise(() => {});
  console.log("network ok");
  process.exit(0);
}
console.log("");
process.exit(0);
`;

describe("network git options wiring", () => {
  let commandDirectory;
  let projectPath;
  let originalPath;
  let originalTerminalPrompt;
  let originalIdleTimeout;
  let operations;

  beforeAll(() => {
    commandDirectory = mkdtempSync(path.join(os.tmpdir(), "garcon-fake-git-net-"));
    const fakeGitPath = path.join(commandDirectory, "git");
    writeFileSync(fakeGitPath, fakeGitScript, { mode: 0o755 });
    projectPath = mkdtempSync(path.join(os.tmpdir(), "garcon-net-project-"));
    originalPath = process.env.PATH;
    originalIdleTimeout = process.env.GARCON_HTTP_IDLE_TIMEOUT_SECONDS;
    // An inherited value would satisfy the spawn env even with the option
    // unwired, masking the regression this suite pins.
    originalTerminalPrompt = process.env.GIT_TERMINAL_PROMPT ?? null;
    delete process.env.GIT_TERMINAL_PROMPT;
    process.env.PATH = `${commandDirectory}${path.delimiter}${originalPath}`;
    operations = createStatusOperations({
      run: () => {
        throw new Error("agent runner must not be used by network commands");
      },
    });
  });

  afterAll(() => {
    process.env.PATH = originalPath;
    if (originalIdleTimeout === undefined) delete process.env.GARCON_HTTP_IDLE_TIMEOUT_SECONDS;
    else process.env.GARCON_HTTP_IDLE_TIMEOUT_SECONDS = originalIdleTimeout;
    if (originalTerminalPrompt !== null) process.env.GIT_TERMINAL_PROMPT = originalTerminalPrompt;
    delete process.env.FAKE_GIT_SLEEP;
    delete process.env.FAKE_GIT_RECORD;
    rmSync(commandDirectory, { recursive: true, force: true });
    rmSync(projectPath, { recursive: true, force: true });
  });

  function recordedCalls() {
    return readFileSync(process.env.FAKE_GIT_RECORD, "utf8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  }

  function freshRecorder() {
    const recordPath = path.join(commandDirectory, "record.log");
    writeFileSync(recordPath, "");
    process.env.FAKE_GIT_RECORD = recordPath;
    return recordPath;
  }

  it("runs fetch, pull, and push with terminal prompts disabled", async () => {
    freshRecorder();
    await operations.fetch({ projectPath });
    await operations.pull({ projectPath });
    await operations.push({ projectPath });

    const calls = recordedCalls().map(({ argv, terminalPrompt }) => ({
      command: argv[0],
      args: argv.slice(1),
      terminalPrompt,
    }));
    expect(calls).toEqual([
      { command: "fetch", args: ["origin"], terminalPrompt: "0" },
      { command: "pull", args: ["origin", "main"], terminalPrompt: "0" },
      { command: "push", args: ["origin", "main:main"], terminalPrompt: "0" },
    ]);
  });

  it("bounds a hung fetch, pull, and push by the idle-budget timeout", async () => {
    freshRecorder();
    process.env.FAKE_GIT_SLEEP = "1";
    try {
      // Each operation runs concurrently: 4s idle budget minus the 2s margin
      // bounds every network command at 2s, while the runner's 30s default
      // would keep the request hanging far past the HTTP budget.
      const runs = await Promise.all(["fetch", "pull", "push"].map(async (op) => {
        const startedAt = performance.now();
        await expect(operations[op]({ projectPath })).rejects.toMatchObject({
          timedOut: true,
        });
        return performance.now() - startedAt;
      }));
      for (const elapsed of runs) {
        // Above the 1s floor to pin the 4s derivation, below the 30s default.
        expect(elapsed).toBeGreaterThan(1_500);
        expect(elapsed).toBeLessThan(6_000);
      }
      const calls = recordedCalls();
      expect(calls).toHaveLength(3);
      for (const call of calls) {
        expect(call.terminalPrompt).toBe("0");
      }
      expect(calls.map((call) => call.argv[0]).sort()).toEqual(["fetch", "pull", "push"]);
    } finally {
      delete process.env.FAKE_GIT_SLEEP;
    }
  }, 15_000);
});
