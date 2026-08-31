import { describe, expect, it } from "bun:test";
import {
  parseWorktreePorcelainLines,
  parseWorktreePorcelainZ,
  readPorcelainWorktreeRecords,
} from "../worktree-porcelain.js";

describe("worktree porcelain parsing", () => {
  it("parses NUL-framed branch, detached, bare, and ignored attributes", () => {
    const output = [
      "worktree /repo",
      "HEAD 1111111111111111111111111111111111111111",
      "branch refs/heads/main",
      "",
      "worktree /repo/linked",
      "HEAD 2222222222222222222222222222222222222222",
      "detached",
      "locked reason",
      "",
      "worktree /repo.git",
      "bare",
      "prunable stale",
      "",
      "",
    ].join("\0");

    expect(parseWorktreePorcelainZ(output)).toEqual([
      {
        path: "/repo",
        branch: "main",
        name: "main",
        isMain: true,
      },
      {
        path: "/repo/linked",
        branch: "(detached)",
        name: "linked",
        isMain: false,
      },
      {
        path: "/repo.git",
        branch: "",
        name: "repo.git",
        isMain: true,
      },
    ]);
  });

  it("preserves newlines in NUL-framed paths", () => {
    const worktreePath = "/repo/line\nbreak";
    expect(
      parseWorktreePorcelainZ(
        `worktree ${worktreePath}\0HEAD 0000000000000000000000000000000000000000\0branch refs/heads/topic\0\0`,
      ),
    ).toEqual([
      {
        path: worktreePath,
        branch: "topic",
        name: "topic",
        isMain: true,
      },
    ]);
  });

  it("supports the legacy newline fallback", () => {
    expect(
      parseWorktreePorcelainLines(
        "worktree /repo\nHEAD 0000000000000000000000000000000000000000\nbranch refs/heads/main\n\n",
      ),
    ).toEqual([
      {
        path: "/repo",
        branch: "main",
        name: "main",
        isMain: true,
      },
    ]);
  });

  it("uses NUL framing when Git supports it", async () => {
    const calls = [];
    const records = await readPorcelainWorktreeRecords(
      "/repo",
      [],
      async (_projectPath, args) => {
        calls.push(args);
        return {
          stdout: "worktree /repo\0HEAD 0000000000000000000000000000000000000000\0branch refs/heads/main\0\0",
          stderr: "",
        };
      },
    );

    expect(calls).toEqual([
      ["worktree", "list", "--porcelain", "-z"],
    ]);
    expect(records[0]).toMatchObject({ path: "/repo", branch: "main" });
  });

  it("retries with legacy framing when Git rejects -z", async () => {
    const calls = [];
    const records = await readPorcelainWorktreeRecords(
      "/repo",
      [],
      async (_projectPath, args) => {
        calls.push(args);
        if (args.includes("-z")) {
          throw Object.assign(new Error("unknown switch `z'"), {
            code: 129,
            stderr: "error: unknown switch `z'",
          });
        }
        return {
          stdout: "worktree /repo\nHEAD 0000000000000000000000000000000000000000\nbranch refs/heads/main\n\n",
          stderr: "",
        };
      },
    );

    expect(calls).toEqual([
      ["worktree", "list", "--porcelain", "-z"],
      ["worktree", "list", "--porcelain"],
    ]);
    expect(records[0]).toMatchObject({ path: "/repo", branch: "main" });
  });

  it("does not retry operational failures", async () => {
    const calls = [];
    const failure = Object.assign(new Error("timed out"), {
      timedOut: true,
      stderr: "",
    });
    const result = readPorcelainWorktreeRecords(
      "/repo",
      [],
      async (_projectPath, args) => {
        calls.push(args);
        throw failure;
      },
    );

    await expect(result).rejects.toBe(failure);
    expect(calls).toEqual([
      ["worktree", "list", "--porcelain", "-z"],
    ]);
  });
});
