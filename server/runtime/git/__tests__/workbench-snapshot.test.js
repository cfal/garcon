import { describe, it, expect } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createGitOperations } from "../git-service.js";
import { runGitCommand, initRepoWithCommit } from "./repository-fixture.js";
import { runGitTraced } from "../run.js";
import { materializeReviewResponse } from "./rendered-patch-fixture.js";

function findTreeNode(nodes, executorPath) {
  for (const node of nodes) {
    if (node.path === executorPath) return node;
    if (Array.isArray(node.children)) {
      const child = findTreeNode(node.children, executorPath);
      if (child) return child;
    }
  }
  return null;
}

async function expectSummaryAndBodyFingerprintsMatch(
  git,
  projectPath,
  { file = "a.txt", mode = "working" } = {},
) {
  const snapshot = await git.getWorkbenchSnapshot({
    projectPath,
    mode,
    context: 5,
  });
  expect(snapshot.status).toBe("ready");
  const summary = snapshot.reviewSummary.files.find(
    (entry) => entry.path === file,
  );
  expect(summary).toBeDefined();

  const body = materializeReviewResponse(
    await git.getReviewDocumentFileBodies({
      projectPath,
      documentId: snapshot.reviewSummary.documentId,
      files: [file],
      purpose: "visible",
    }),
  ).files[file];

  expect(body).toBeDefined();
  expect(body.bodyFingerprint).toBe(summary.bodyFingerprint);
}

describe("getWorkbenchSnapshot", () => {
  it("records git command duration and byte counts when trace is provided", async () => {
    const projectPath = await fs.mkdtemp(
      path.join(os.tmpdir(), "garcon-git-trace-"),
    );
    try {
      await runGitCommand(projectPath, ["init"]);
      const trace = [];
      await runGitTraced(
        projectPath,
        ["rev-parse", "--is-inside-work-tree"],
        trace,
      );

      expect(trace).toHaveLength(1);
      expect(trace[0]).toMatchObject({
        args: ["rev-parse", "--is-inside-work-tree"],
      });
      expect(trace[0].durationMs).toBeGreaterThanOrEqual(0);
      expect(trace[0].stdoutBytes).toBeGreaterThan(0);
    } finally {
      await fs.rm(projectPath, { recursive: true, force: true });
    }
  });

  it("returns tree and review summary from one loaded snapshot", async () => {
    const projectPath = await fs.mkdtemp(
      path.join(os.tmpdir(), "garcon-git-snapshot-"),
    );
    const git = createGitOperations();

    try {
      await initRepoWithCommit(projectPath);
      await fs.writeFile(
        path.join(projectPath, "a.txt"),
        "one\ntwo\n",
        "utf-8",
      );
      const trace = [];
      const snapshot = await git.getWorkbenchSnapshot({
        projectPath,
        mode: "working",
        context: 5,
        trace,
      });

      expect(snapshot.status).toBe("ready");
      expect(snapshot.tree.statsState).toBe("loaded");
      expect(trace.some((entry) => entry.args.includes("--numstat"))).toBe(
        true,
      );
      expect(snapshot.tree.root[0]).toMatchObject({
        path: "a.txt",
        additions: 1,
        deletions: 0,
      });
      expect(snapshot.reviewSummary.files[0]).toMatchObject({
        path: "a.txt",
        additions: 1,
        deletions: 0,
        bodyState: "unloaded",
      });
      expect(snapshot.selectedFile).toBe("a.txt");
    } finally {
      await fs.rm(projectPath, { recursive: true, force: true });
    }
  });

  it("aggregates directory stats from each changed file entry", async () => {
    const projectPath = await fs.mkdtemp(
      path.join(os.tmpdir(), "garcon-git-tree-dir-stats-"),
    );
    const git = createGitOperations();

    try {
      await initRepoWithCommit(projectPath);
      await fs.mkdir(path.join(projectPath, "src", "nested"), {
        recursive: true,
      });
      await fs.writeFile(
        path.join(projectPath, "src", "nested", "large.txt"),
        "base\n",
        "utf-8",
      );
      await fs.writeFile(
        path.join(projectPath, "src", "nested", "small.txt"),
        "base\n",
        "utf-8",
      );
      await runGitCommand(projectPath, [
        "add",
        "src/nested/large.txt",
        "src/nested/small.txt",
      ]);
      await runGitCommand(projectPath, ["commit", "-m", "add nested files"]);

      const largeLines = Array.from(
        { length: 75 },
        (_, index) => `large ${index + 1}`,
      );
      await fs.writeFile(
        path.join(projectPath, "src", "nested", "large.txt"),
        `base\n${largeLines.join("\n")}\n`,
        "utf-8",
      );
      await fs.writeFile(
        path.join(projectPath, "src", "nested", "small.txt"),
        "base\nsmall 1\n",
        "utf-8",
      );

      const snapshot = await git.getWorkbenchSnapshot({
        projectPath,
        mode: "working",
        context: 5,
      });

      expect(snapshot.status).toBe("ready");
      expect(findTreeNode(snapshot.tree.root, "src")).toMatchObject({
        additions: 76,
        deletions: 0,
      });
      expect(findTreeNode(snapshot.tree.root, "src/nested")).toMatchObject({
        additions: 76,
        deletions: 0,
      });
      expect(
        findTreeNode(snapshot.tree.root, "src/nested/large.txt"),
      ).toMatchObject({
        additions: 75,
        deletions: 0,
      });
      expect(
        findTreeNode(snapshot.tree.root, "src/nested/small.txt"),
      ).toMatchObject({
        additions: 1,
        deletions: 0,
      });
    } finally {
      await fs.rm(projectPath, { recursive: true, force: true });
    }
  });

  it("returns typed non-repository snapshots", async () => {
    const projectPath = await fs.mkdtemp(
      path.join(os.tmpdir(), "garcon-git-not-repo-"),
    );
    const git = createGitOperations();

    try {
      const snapshot = await git.getWorkbenchSnapshot({
        projectPath,
        mode: "working",
        context: 5,
      });

      expect(snapshot).toMatchObject({
        status: "not-git-repository",
        project: projectPath,
        target: null,
        tree: null,
        reviewSummary: null,
        selectedFile: null,
        firstBodyCandidates: [],
      });
    } finally {
      await fs.rm(projectPath, { recursive: true, force: true });
    }
  });

  it("loads numstat for paths containing tabs", async () => {
    const projectPath = await fs.mkdtemp(
      path.join(os.tmpdir(), "garcon-git-tree-tab-path-"),
    );
    const git = createGitOperations();
    const fileName = "a\tb.txt";

    try {
      await runGitCommand(projectPath, ["init"]);
      await runGitCommand(projectPath, [
        "config",
        "user.email",
        "test@example.com",
      ]);
      await runGitCommand(projectPath, ["config", "user.name", "Test User"]);
      await fs.writeFile(path.join(projectPath, fileName), "one\n", "utf-8");
      await runGitCommand(projectPath, ["add", fileName]);
      await runGitCommand(projectPath, ["commit", "-m", "initial"]);
      await fs.writeFile(
        path.join(projectPath, fileName),
        "one\ntwo\n",
        "utf-8",
      );

      const snapshot = await git.getWorkbenchSnapshot({
        projectPath,
        mode: "working",
        context: 5,
      });

      expect(snapshot.status).toBe("ready");
      expect(snapshot.tree.root).toHaveLength(1);
      expect(snapshot.tree.root[0]).toMatchObject({
        path: fileName,
        additions: 1,
        deletions: 0,
      });
      expect(snapshot.reviewSummary.files[0].path).toBe(fileName);
    } finally {
      await fs.rm(projectPath, { recursive: true, force: true });
    }
  });

  it("expands untracked directories to untracked files", async () => {
    const projectPath = await fs.mkdtemp(
      path.join(os.tmpdir(), "garcon-git-tree-"),
    );
    const git = createGitOperations();

    try {
      await runGitCommand(projectPath, ["init"]);
      await fs.mkdir(path.join(projectPath, "newdir/subdir"), {
        recursive: true,
      });
      await fs.writeFile(
        path.join(projectPath, "newdir/subdir/file.txt"),
        "hello\n",
        "utf-8",
      );

      const snapshot = await git.getWorkbenchSnapshot({
        projectPath,
        mode: "working",
        context: 5,
      });
      expect(snapshot.status).toBe("ready");
      expect(snapshot.tree.root).toMatchObject([
        {
          path: "newdir",
          name: "newdir",
          kind: "directory",
          changeKind: "untracked",
          staged: false,
          hasUnstaged: true,
          children: [
            {
              path: "newdir/subdir",
              name: "subdir",
              kind: "directory",
              changeKind: "untracked",
              staged: false,
              hasUnstaged: true,
              children: [
                {
                  path: "newdir/subdir/file.txt",
                  name: "file.txt",
                  kind: "file",
                  changeKind: "untracked",
                  staged: false,
                  hasUnstaged: true,
                  indexStatus: "?",
                  workTreeStatus: "?",
                  unstagedFacet: {
                    status: "?",
                    changeKind: "untracked",
                    stats: { additions: 0, deletions: 0 },
                  },
                  additions: 0,
                  deletions: 0,
                },
              ],
            },
          ],
        },
      ]);
    } finally {
      await fs.rm(projectPath, { recursive: true, force: true });
    }
  });

  it("reports separate staged and unstaged facets for the same file", async () => {
    const projectPath = await fs.mkdtemp(
      path.join(os.tmpdir(), "garcon-git-mixed-"),
    );
    const git = createGitOperations();

    try {
      await initRepoWithCommit(projectPath);
      await fs.writeFile(
        path.join(projectPath, "a.txt"),
        "one\nstaged\n",
        "utf-8",
      );
      await runGitCommand(projectPath, ["add", "a.txt"]);
      await fs.writeFile(
        path.join(projectPath, "a.txt"),
        "one\nstaged\nunstaged\n",
        "utf-8",
      );

      const snapshot = await git.getWorkbenchSnapshot({
        projectPath,
        mode: "working",
        context: 5,
      });
      expect(snapshot.status).toBe("ready");
      const file = snapshot.tree.root.find((node) => node.path === "a.txt");

      expect(file.indexStatus).toBe("M");
      expect(file.workTreeStatus).toBe("M");
      expect(file.staged).toBe(true);
      expect(file.hasUnstaged).toBe(true);
      expect(file.stagedFacet).toMatchObject({
        status: "M",
        changeKind: "modified",
      });
      expect(file.unstagedFacet).toMatchObject({
        status: "M",
        changeKind: "modified",
      });
    } finally {
      await fs.rm(projectPath, { recursive: true, force: true });
    }
  });

  it("keeps staged text summaries independent from later binary worktree edits", async () => {
    const projectPath = await fs.mkdtemp(
      path.join(os.tmpdir(), "garcon-git-staged-text-worktree-binary-"),
    );
    const git = createGitOperations();

    try {
      await initRepoWithCommit(projectPath);
      await fs.writeFile(
        path.join(projectPath, "a.txt"),
        "one\nstaged text\n",
        "utf-8",
      );
      await runGitCommand(projectPath, ["add", "a.txt"]);
      await fs.writeFile(
        path.join(projectPath, "a.txt"),
        Buffer.from([0, 1, 2, 3, 4, 5]),
      );

      const snapshot = await git.getWorkbenchSnapshot({
        projectPath,
        mode: "staged",
        context: 5,
      });
      expect(snapshot.status).toBe("ready");
      const summary = snapshot.reviewSummary.files.find(
        (file) => file.path === "a.txt",
      );
      expect(summary.isBinary).toBe(false);
      expect(summary.bodyState).toBe("unloaded");

      const body = materializeReviewResponse(
        await git.getReviewDocumentFileBodies({
          projectPath,
          documentId: snapshot.reviewSummary.documentId,
          files: ["a.txt"],
          purpose: "visible",
        }),
      ).files["a.txt"];
      expect(body.bodyState).toBe("loaded");
      expect(body.isBinary).toBe(false);
      expect(
        body.rows.some(
          (row) => row.kind === "add" && row.text === "staged text",
        ),
      ).toBe(true);
    } finally {
      await fs.rm(projectPath, { recursive: true, force: true });
    }
  });

  it("uses body-compatible fingerprints for common review states", async () => {
    const git = createGitOperations();
    const cases = [
      {
        name: "modified tracked path with spaces",
        mode: "working",
        file: "a b.txt",
        mutate: async (projectPath) => {
          await fs.writeFile(
            path.join(projectPath, "a b.txt"),
            "base\n",
            "utf-8",
          );
          await runGitCommand(projectPath, ["add", "a b.txt"]);
          await runGitCommand(projectPath, ["commit", "-m", "add spaced path"]);
          await fs.writeFile(
            path.join(projectPath, "a b.txt"),
            "base\nchanged\n",
            "utf-8",
          );
        },
      },
      {
        name: "untracked file",
        mode: "working",
        file: "new file.txt",
        mutate: async (projectPath) => {
          await fs.writeFile(
            path.join(projectPath, "new file.txt"),
            "new\n",
            "utf-8",
          );
        },
      },
      {
        name: "working deletion",
        mode: "working",
        file: "a.txt",
        mutate: async (projectPath) => {
          await fs.rm(path.join(projectPath, "a.txt"));
        },
      },
      {
        name: "staged modification",
        mode: "staged",
        file: "a.txt",
        mutate: async (projectPath) => {
          await fs.writeFile(
            path.join(projectPath, "a.txt"),
            "one\nstaged\n",
            "utf-8",
          );
          await runGitCommand(projectPath, ["add", "a.txt"]);
        },
      },
      {
        name: "staged deletion",
        mode: "staged",
        file: "a.txt",
        mutate: async (projectPath) => {
          await runGitCommand(projectPath, ["rm", "a.txt"]);
        },
      },
    ];

    for (const testCase of cases) {
      const projectPath = await fs.mkdtemp(
        path.join(
          os.tmpdir(),
          `garcon-git-fingerprint-${testCase.name.replaceAll(" ", "-")}-`,
        ),
      );
      try {
        await initRepoWithCommit(projectPath);
        await testCase.mutate(projectPath);
        await expectSummaryAndBodyFingerprintsMatch(git, projectPath, {
          file: testCase.file,
          mode: testCase.mode,
        });
      } finally {
        await fs.rm(projectPath, { recursive: true, force: true });
      }
    }
  });
});
