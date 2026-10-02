import { describe, it, expect } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createGitOperations } from "../../../runtime/git/git-service.js";
import {
  runGitCommand,
  initRepoWithCommit,
} from "../../../runtime/git/__tests__/repository-fixture.js";
import { generateCommitMessage } from "../commit-message.js";
import { generateCommitMessageForFiles } from "../commit-generation.js";
import { collectCommitMessageDiffContext } from "../../../runtime/git/status.js";

const mockAgents = { runSingleQuery: async () => "chore: stub" };

describe("commit message generation", () => {
  it("builds the staged diff with one batched pathspec command for normal selections", async () => {
    const calls = [];
    const diffContext = await collectCommitMessageDiffContext(
      "/repo",
      ["src/a.ts", "src/b.ts"],
      async (cwd, args, options) => {
        calls.push({ cwd, args, options });
        return { stdout: "patch text" };
      },
    );

    expect(diffContext).toBe("patch text");
    expect(calls).toEqual([
      {
        cwd: "/repo",
        args: [
          "diff",
          "--cached",
          "--no-ext-diff",
          "--no-color",
          "-U10",
          "--",
          "src/a.ts",
          "src/b.ts",
        ],
        options: {
          disableOptionalLocks: true,
          maxStdoutBytes: 320_000,
          truncateStdout: true,
        },
      },
    ]);
  });

  it("keeps up to eighty thousand diff characters in generated commit message prompts", async () => {
    let capturedPrompt = "";
    const marker = "after-limit-marker";
    const diffContext = `${"a".repeat(80_000)}${marker}`;

    await generateCommitMessage(["a.txt"], diffContext, "claude", (prompt) => {
      capturedPrompt = prompt;
      return Promise.resolve("chore: stub");
    });

    const diffStart =
      capturedPrompt.indexOf("Diff excerpt:\n") + "Diff excerpt:\n".length;
    const diffEnd = capturedPrompt.indexOf(
      "\n\nReturn only the commit message now.",
      diffStart,
    );
    const diffExcerpt = capturedPrompt.slice(diffStart, diffEnd);

    expect(diffExcerpt).toHaveLength(80_000);
    expect(diffExcerpt).not.toContain(marker);
  });

  it("preserves replacement metacharacters in commit context", async () => {
    let capturedPrompt = "";

    await generateCommitMessage(
      ["src/$&-$1.ts"],
      "diff with $& and $1 and $$",
      "claude",
      (prompt) => {
        capturedPrompt = prompt;
        return Promise.resolve("chore: stub");
      },
      { customPrompt: "Files:\n{{files}}\nDiff:\n{{diff}}" },
    );

    expect(capturedPrompt).toBe(
      "Files:\n- src/$&-$1.ts\nDiff:\ndiff with $& and $1 and $$",
    );
  });

  it("returns the server-applied directory prefix with generated messages", async () => {
    const projectPath = await fs.mkdtemp(
      path.join(os.tmpdir(), "garcon-git-commit-message-prefix-"),
    );
    const git = createGitOperations();
    const agents = mockAgents;

    try {
      await initRepoWithCommit(projectPath);
      await fs.mkdir(path.join(projectPath, "feature", "auth"), {
        recursive: true,
      });
      await fs.writeFile(
        path.join(projectPath, "feature", "auth", "a.txt"),
        "a\n",
        "utf-8",
      );
      await fs.writeFile(
        path.join(projectPath, "feature", "auth", "b.txt"),
        "b\n",
        "utf-8",
      );
      await runGitCommand(projectPath, [
        "add",
        "feature/auth/a.txt",
        "feature/auth/b.txt",
      ]);

      const result = await generateCommitMessageForFiles(
        agents,
        {
          collectCommitMessageContext: (input, options) =>
            git.collectCommitMessageContext({
              ...input,
              signal: options?.signal,
            }),
        },
        {
          projectPath,
          files: ["feature/auth/a.txt", "feature/auth/b.txt"],
          agentId: "claude",
          useCommonDirPrefix: true,
        },
      );

      expect(result).toEqual({
        message: "feature/auth: chore: stub",
        directoryPrefix: "feature/auth",
      });
    } finally {
      await fs.rm(projectPath, { recursive: true, force: true });
    }
  });

  it("captures selected multi-file staged diffs from a real repository", async () => {
    const projectPath = await fs.mkdtemp(
      path.join(os.tmpdir(), "garcon-git-commit-message-batched-"),
    );
    let capturedPrompt = "";
    let capturedOptions;
    const git = createGitOperations();
    const agents = {
      runSingleQuery: (prompt, options) => {
        capturedPrompt = prompt;
        capturedOptions = options;
        return Promise.resolve("chore: stub");
      },
    };

    try {
      await initRepoWithCommit(projectPath);
      await fs.mkdir(path.join(projectPath, "feature"), { recursive: true });
      await fs.writeFile(
        path.join(projectPath, "feature", "a.txt"),
        "alpha\n",
        "utf-8",
      );
      await fs.writeFile(
        path.join(projectPath, "feature", "name with space.txt"),
        "space\n",
        "utf-8",
      );
      await fs.writeFile(
        path.join(projectPath, "unselected.txt"),
        "skip\n",
        "utf-8",
      );
      await runGitCommand(projectPath, [
        "add",
        "feature/a.txt",
        "feature/name with space.txt",
        "unselected.txt",
      ]);

      await generateCommitMessageForFiles(
        agents,
        {
          collectCommitMessageContext: (input, options) =>
            git.collectCommitMessageContext({
              ...input,
              signal: options?.signal,
            }),
        },
        {
          projectPath,
          files: ["feature/a.txt", "feature/name with space.txt"],
          agentId: "claude",
          thinkingMode: "max",
        },
      );

      expect(capturedPrompt).toContain(
        "diff --git a/feature/a.txt b/feature/a.txt",
      );
      expect(capturedPrompt).toContain("+alpha");
      expect(capturedPrompt).toContain(
        "diff --git a/feature/name with space.txt b/feature/name with space.txt",
      );
      expect(capturedPrompt).toContain("+space");
      expect(capturedPrompt).not.toContain("unselected.txt");
      expect(capturedPrompt).not.toContain("+skip");
      expect(capturedOptions).toMatchObject({
        agentId: "claude",
        thinkingMode: "max",
        timeoutMs: 110_000,
      });
      expect(capturedOptions).not.toHaveProperty("cwd");
      expect(capturedOptions).not.toHaveProperty("projectPath");
    } finally {
      await fs.rm(projectPath, { recursive: true, force: true });
    }
  });

  it("uses ten lines of hunk context for generated commit message prompts", async () => {
    const projectPath = await fs.mkdtemp(
      path.join(os.tmpdir(), "garcon-git-commit-message-context-"),
    );
    let capturedPrompt = "";
    const git = createGitOperations();
    const agents = {
      runSingleQuery: (prompt) => {
        capturedPrompt = prompt;
        return Promise.resolve("chore: stub");
      },
    };

    try {
      await initRepoWithCommit(projectPath);
      const lines = Array.from(
        { length: 25 },
        (_, index) => `line ${index + 1}`,
      );
      await fs.writeFile(
        path.join(projectPath, "a.txt"),
        `${lines.join("\n")}\n`,
        "utf-8",
      );
      await runGitCommand(projectPath, ["add", "a.txt"]);
      await runGitCommand(projectPath, ["commit", "-m", "expand fixture"]);

      lines[12] = "line 13 changed";
      await fs.writeFile(
        path.join(projectPath, "a.txt"),
        `${lines.join("\n")}\n`,
        "utf-8",
      );
      await runGitCommand(projectPath, ["add", "a.txt"]);

      await generateCommitMessageForFiles(
        agents,
        {
          collectCommitMessageContext: (input, options) =>
            git.collectCommitMessageContext({
              ...input,
              signal: options?.signal,
            }),
        },
        {
          projectPath,
          files: ["a.txt"],
          agentId: "claude",
        },
      );

      expect(capturedPrompt).toContain("@@ -3,21 +3,21 @@");
      expect(capturedPrompt).toContain("\n line 3\n");
      expect(capturedPrompt).toContain("-line 13\n");
      expect(capturedPrompt).toContain("+line 13 changed\n");
      expect(capturedPrompt).toContain("\n line 23\n");
      expect(capturedPrompt).not.toContain("\n line 2\n");
      expect(capturedPrompt).not.toContain("\n line 24\n");
    } finally {
      await fs.rm(projectPath, { recursive: true, force: true });
    }
  });
});
