import { describe, it, expect } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createGitOperations } from "../git-service.js";
import { runGitCommand, initRepoWithCommit } from "./repository-fixture.js";

async function commitFileAt(projectPath, file, contents, message, timestamp) {
  await fs.writeFile(path.join(projectPath, file), contents, "utf-8");
  await runGitCommand(projectPath, ["add", file]);
  await runGitCommand(projectPath, ["commit", "-m", message], {
    env: {
      GIT_AUTHOR_DATE: timestamp,
      GIT_COMMITTER_DATE: timestamp,
    },
  });
  const { stdout } = await runGitCommand(projectPath, ["rev-parse", "HEAD"]);
  return stdout.trim();
}

describe("git ref checkout and branch creation", () => {
  it("lists local branches by default and finds remote branches and tags by search", async () => {
    const projectPath = await fs.mkdtemp(
      path.join(os.tmpdir(), "garcon-git-refs-"),
    );
    const git = createGitOperations();

    try {
      await initRepoWithCommit(projectPath);
      await runGitCommand(projectPath, ["branch", "-M", "main"]);
      await runGitCommand(projectPath, ["tag", "v1.0.0"]);
      const { stdout: head } = await runGitCommand(projectPath, [
        "rev-parse",
        "HEAD",
      ]);
      await runGitCommand(projectPath, [
        "update-ref",
        "refs/remotes/origin/main",
        head.trim(),
      ]);
      await runGitCommand(projectPath, [
        "symbolic-ref",
        "refs/remotes/origin/HEAD",
        "refs/remotes/origin/main",
      ]);

      const { refs } = await git.getRefs({ projectPath });

      expect(refs).toContainEqual({
        name: "main",
        ref: "refs/heads/main",
        kind: "local-branch",
        updatedAt: expect.any(String),
        isCurrent: true,
      });
      expect(refs.some((ref) => ref.kind === "remote-branch")).toBe(false);
      expect(refs.some((ref) => ref.kind === "tag")).toBe(false);

      const { refs: remoteRefs } = await git.getRefs({
        projectPath,
        query: "origin/main",
      });
      expect(remoteRefs).toContainEqual({
        name: "origin/main",
        ref: "refs/remotes/origin/main",
        kind: "remote-branch",
        updatedAt: expect.any(String),
      });
      expect(remoteRefs.some((ref) => ref.name === "origin/HEAD")).toBe(false);

      const { refs: tagRefs } = await git.getRefs({
        projectPath,
        query: "v1.0.0",
      });
      expect(tagRefs).toContainEqual({
        name: "v1.0.0",
        ref: "refs/tags/v1.0.0",
        kind: "tag",
        updatedAt: expect.any(String),
      });
    } finally {
      await fs.rm(projectPath, { recursive: true, force: true });
    }
  });

  it("returns bounded ref search results", async () => {
    const projectPath = await fs.mkdtemp(
      path.join(os.tmpdir(), "garcon-git-ref-search-"),
    );
    const git = createGitOperations();

    try {
      await initRepoWithCommit(projectPath);
      await runGitCommand(projectPath, ["branch", "-M", "main"]);
      const { stdout: head } = await runGitCommand(projectPath, [
        "rev-parse",
        "HEAD",
      ]);
      await runGitCommand(projectPath, [
        "update-ref",
        "refs/remotes/origin/main",
        head.trim(),
      ]);
      await runGitCommand(projectPath, [
        "update-ref",
        "refs/remotes/upstream/main",
        head.trim(),
      ]);

      const { refs } = await git.getRefs({
        projectPath,
        query: "main",
        limit: 1,
      });

      expect(refs).toHaveLength(1);
      expect(refs[0].name).toContain("main");
    } finally {
      await fs.rm(projectPath, { recursive: true, force: true });
    }
  });

  it("sorts before limiting and reports branch and tag creator timestamps", async () => {
    const projectPath = await fs.mkdtemp(
      path.join(os.tmpdir(), "garcon-git-ref-sorting-"),
    );
    const git = createGitOperations();
    const oldTimestamp = "2024-01-01T00:00:00Z";
    const newTimestamp = "2024-03-01T00:00:00Z";
    const tagTimestamp = "2024-04-01T00:00:00Z";

    try {
      await runGitCommand(projectPath, ["init"]);
      await runGitCommand(projectPath, [
        "config",
        "user.email",
        "test@example.com",
      ]);
      await runGitCommand(projectPath, ["config", "user.name", "Test User"]);
      const oldHash = await commitFileAt(
        projectPath,
        "dated.txt",
        "old\n",
        "old",
        oldTimestamp,
      );
      await runGitCommand(projectPath, ["branch", "-M", "main"]);
      await runGitCommand(projectPath, ["branch", "candidate-old", oldHash]);
      const newHash = await commitFileAt(
        projectPath,
        "dated.txt",
        "new\n",
        "new",
        newTimestamp,
      );
      await runGitCommand(projectPath, ["branch", "candidate-new", newHash]);
      await runGitCommand(projectPath, ["branch", "tie-b", newHash]);
      await runGitCommand(projectPath, ["branch", "tie-a", newHash]);
      await runGitCommand(projectPath, [
        "update-ref",
        "refs/remotes/origin/candidate-new",
        newHash,
      ]);
      await runGitCommand(projectPath, ["tag", "release-light", oldHash]);
      await runGitCommand(
        projectPath,
        ["tag", "-a", "release-annotated", oldHash, "-m", "release"],
        {
          env: {
            GIT_AUTHOR_DATE: tagTimestamp,
            GIT_COMMITTER_DATE: tagTimestamp,
          },
        },
      );
      await fs.writeFile(path.join(projectPath, "artifact.bin"), "artifact\n");
      const { stdout: blobHash } = await runGitCommand(projectPath, [
        "hash-object",
        "-w",
        "artifact.bin",
      ]);
      await runGitCommand(projectPath, [
        "update-ref",
        "refs/tags/artifact-blob",
        blobHash.trim(),
      ]);
      await runGitCommand(projectPath, [
        "update-ref",
        "refs/tags/artifact-commit",
        oldHash,
      ]);

      const defaultName = await git.getRefs({
        projectPath,
        query: "candidate",
      });
      expect(
        defaultName.refs
          .filter((ref) => ref.kind === "local-branch")
          .map((ref) => ref.name),
      ).toEqual(["candidate-new", "candidate-old"]);

      const descendingName = await git.getRefs({
        projectPath,
        query: "candidate",
        sort: { key: "name", direction: "desc" },
      });
      expect(
        descendingName.refs
          .filter((ref) => ref.kind === "local-branch")
          .map((ref) => ref.name),
      ).toEqual(["candidate-old", "candidate-new"]);

      const newest = await git.getRefs({
        projectPath,
        query: "candidate",
        limit: 1,
        sort: { key: "updated", direction: "desc" },
      });
      expect(newest.refs).toMatchObject([
        {
          name: "candidate-new",
          updatedAt: "2024-03-01T00:00:00.000Z",
        },
      ]);

      const oldestFirst = await git.getRefs({
        projectPath,
        query: "candidate",
        sort: { key: "updated", direction: "asc" },
      });
      const oldestLocalBranches = oldestFirst.refs.filter(
        (ref) => ref.kind === "local-branch",
      );
      expect(oldestLocalBranches.map((ref) => ref.name)).toEqual([
        "candidate-old",
        "candidate-new",
      ]);
      expect(oldestLocalBranches.map((ref) => ref.updatedAt)).toEqual([
        "2024-01-01T00:00:00.000Z",
        "2024-03-01T00:00:00.000Z",
      ]);

      const tied = await git.getRefs({
        projectPath,
        query: "tie",
        sort: { key: "updated", direction: "desc" },
      });
      expect(tied.refs.map((ref) => ref.name)).toEqual(["tie-a", "tie-b"]);

      const remote = await git.getRefs({
        projectPath,
        query: "origin/candidate-new",
        sort: { key: "updated", direction: "desc" },
      });
      expect(remote.refs).toMatchObject([
        {
          kind: "remote-branch",
          updatedAt: "2024-03-01T00:00:00.000Z",
        },
      ]);

      const tags = await git.getRefs({
        projectPath,
        query: "release",
        sort: { key: "updated", direction: "desc" },
      });
      expect(
        tags.refs.map(({ name, updatedAt }) => ({ name, updatedAt })),
      ).toEqual([
        {
          name: "release-annotated",
          updatedAt: "2024-04-01T00:00:00.000Z",
        },
        {
          name: "release-light",
          updatedAt: "2024-01-01T00:00:00.000Z",
        },
      ]);

      const artifactsAscending = await git.getRefs({
        projectPath,
        query: "artifact",
        sort: { key: "updated", direction: "asc" },
      });
      expect(
        artifactsAscending.refs.map(({ name, updatedAt }) => ({
          name,
          updatedAt,
        })),
      ).toEqual([
        { name: "artifact-blob", updatedAt: null },
        {
          name: "artifact-commit",
          updatedAt: "2024-01-01T00:00:00.000Z",
        },
      ]);
      const artifactsDescending = await git.getRefs({
        projectPath,
        query: "artifact",
        sort: { key: "updated", direction: "desc" },
      });
      expect(artifactsDescending.refs.map((ref) => ref.name)).toEqual([
        "artifact-commit",
        "artifact-blob",
      ]);
    } finally {
      await fs.rm(projectPath, { recursive: true, force: true });
    }
  });

  it("returns refs without a HEAD identity in an unborn repository", async () => {
    const projectPath = await fs.mkdtemp(
      path.join(os.tmpdir(), "garcon-git-ref-unborn-"),
    );
    const git = createGitOperations();

    try {
      await runGitCommand(projectPath, ["init"]);
      await fs.writeFile(path.join(projectPath, "artifact.bin"), "artifact\n");
      const { stdout: blobHash } = await runGitCommand(projectPath, [
        "hash-object",
        "-w",
        "artifact.bin",
      ]);
      await runGitCommand(projectPath, [
        "update-ref",
        "refs/tags/artifact",
        blobHash.trim(),
      ]);

      const { refs } = await git.getRefs({ projectPath, query: "artifact" });

      expect(refs).toEqual([
        {
          name: "artifact",
          ref: "refs/tags/artifact",
          kind: "tag",
          updatedAt: null,
        },
      ]);
    } finally {
      await fs.rm(projectPath, { recursive: true, force: true });
    }
  });

  it("marks matching refs as current while HEAD is detached", async () => {
    const projectPath = await fs.mkdtemp(
      path.join(os.tmpdir(), "garcon-git-ref-detached-"),
    );
    const git = createGitOperations();

    try {
      await initRepoWithCommit(projectPath);
      await runGitCommand(projectPath, ["branch", "-M", "main"]);
      const { stdout: head } = await runGitCommand(projectPath, [
        "rev-parse",
        "HEAD",
      ]);
      await runGitCommand(projectPath, ["branch", "shared", head.trim()]);
      await runGitCommand(projectPath, ["tag", "shared", head.trim()]);
      await runGitCommand(projectPath, [
        "update-ref",
        "refs/remotes/origin/shared",
        head.trim(),
      ]);
      await runGitCommand(projectPath, ["checkout", "--detach", head.trim()]);

      const { refs } = await git.getRefs({ projectPath, query: "shared" });

      expect(refs).toHaveLength(3);
      expect(refs.map((ref) => ref.kind).sort()).toEqual([
        "local-branch",
        "remote-branch",
        "tag",
      ]);
      expect(
        refs.find((ref) => ref.kind === "local-branch")?.isCurrent,
      ).toBeUndefined();
      expect(refs.find((ref) => ref.kind === "remote-branch")?.isCurrent).toBe(
        true,
      );
      expect(refs.find((ref) => ref.kind === "tag")?.isCurrent).toBe(true);
    } finally {
      await fs.rm(projectPath, { recursive: true, force: true });
    }
  });

  it("preserves repository validation errors while ref operations run concurrently", async () => {
    const fixtureRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), "garcon-git-ref-validation-"),
    );
    const nonRepositoryPath = path.join(fixtureRoot, "non-repository");
    const repositoryPath = path.join(fixtureRoot, "repository");
    const missingPath = path.join(fixtureRoot, "missing");
    const notRepositoryMessage =
      'Git is not initialized in this directory. Initialize a repository with "git init" before using source control actions.';
    const git = createGitOperations();

    try {
      await fs.mkdir(nonRepositoryPath);
      await fs.mkdir(repositoryPath);
      await initRepoWithCommit(repositoryPath);

      await expect(
        git.getRefs({ projectPath: nonRepositoryPath }),
      ).rejects.toThrow(notRepositoryMessage);
      await expect(
        git.getRefs({ projectPath: nonRepositoryPath, query: "invalid query" }),
      ).rejects.toThrow(notRepositoryMessage);
      await expect(git.getRefs({ projectPath: missingPath })).rejects.toThrow(
        `Unable to access project directory: ${missingPath}`,
      );
      await expect(
        git.getRefs({ projectPath: path.join(repositoryPath, ".git") }),
      ).rejects.toThrow(
        "The target path exists but is not inside a Git working tree.",
      );
    } finally {
      await fs.rm(fixtureRoot, { recursive: true, force: true });
    }
  });

  it("rejects cleanly when concurrent ref operations are aborted", async () => {
    const projectPath = await fs.mkdtemp(
      path.join(os.tmpdir(), "garcon-git-ref-abort-"),
    );
    const git = createGitOperations();

    try {
      await initRepoWithCommit(projectPath);
      const controller = new AbortController();
      const request = git.getRefs({ projectPath, signal: controller.signal });
      controller.abort();

      await expect(request).rejects.toThrow();
    } finally {
      await fs.rm(projectPath, { recursive: true, force: true });
    }
  });

  it("streams default branch order and retains explicit sort paths", async () => {
    const projectPath = await fs.mkdtemp(
      path.join(os.tmpdir(), "garcon-git-ref-commands-"),
    );
    const git = createGitOperations();

    try {
      await initRepoWithCommit(projectPath);
      await runGitCommand(projectPath, ["branch", "-M", "main"]);
      for (const branch of [
        "zeta",
        "alpha/x-y",
        "alpha/x",
        "alpha.x",
        "alpha-x",
      ]) {
        await runGitCommand(projectPath, ["branch", branch]);
      }
      await runGitCommand(projectPath, ["pack-refs", "--all"]);
      await runGitCommand(projectPath, ["branch", "alpha-w"]);
      await runGitCommand(projectPath, ["branch", "alpha/x-w"]);

      async function runCapturedRefQuery(options) {
        const commands = [];
        const originalSpawn = Bun.spawn;
        Bun.spawn = (command, spawnOptions) => {
          if (command[0] === "git") commands.push(command.slice(1));
          return originalSpawn(command, spawnOptions);
        };
        try {
          const { refs } = await git.getRefs({ projectPath, ...options });
          const refCommand = commands.find(([name]) => name === "for-each-ref");
          return { commands, refCommand, refs };
        } finally {
          Bun.spawn = originalSpawn;
        }
      }

      const defaultQuery = await runCapturedRefQuery({ limit: 4 });
      expect(defaultQuery.commands).toHaveLength(3);
      expect(defaultQuery.commands).toContainEqual([
        "rev-parse",
        "--is-inside-work-tree",
      ]);
      expect(defaultQuery.commands).toContainEqual([
        "rev-parse",
        "HEAD",
        "--symbolic-full-name",
        "HEAD",
      ]);
      expect(
        defaultQuery.refCommand?.some((argument) =>
          argument.startsWith("--sort="),
        ),
      ).toBe(false);
      expect(defaultQuery.refs.map((ref) => ref.name)).toEqual([
        "alpha-w",
        "alpha-x",
        "alpha.x",
        "alpha/x",
      ]);

      const searchedQuery = await runCapturedRefQuery({ query: "alpha/" });
      expect(searchedQuery.commands).toHaveLength(3);
      expect(searchedQuery.refCommand).toContain("--sort=refname");
      expect(searchedQuery.refCommand).toContain("--sort=refname:lstrip=2");
      expect(searchedQuery.refs.map((ref) => ref.name)).toEqual([
        "alpha/x",
        "alpha/x-w",
        "alpha/x-y",
      ]);

      const descendingQuery = await runCapturedRefQuery({
        limit: 4,
        sort: { key: "name", direction: "desc" },
      });
      expect(descendingQuery.commands).toHaveLength(3);
      expect(descendingQuery.refCommand).toContain("--sort=refname");
      expect(descendingQuery.refCommand).toContain("--sort=-refname:lstrip=2");
      expect(descendingQuery.refs.map((ref) => ref.name)).toEqual([
        "zeta",
        "main",
        "alpha/x-y",
        "alpha/x-w",
      ]);

      const updatedQuery = await runCapturedRefQuery({
        sort: { key: "updated", direction: "desc" },
      });
      expect(updatedQuery.commands).toHaveLength(3);
      expect(updatedQuery.refCommand).toContain("--sort=refname");
      expect(updatedQuery.refCommand).toContain("--sort=-creatordate");
    } finally {
      await fs.rm(projectPath, { recursive: true, force: true });
    }
  });

  it("keeps local branch checkout attached", async () => {
    const projectPath = await fs.mkdtemp(
      path.join(os.tmpdir(), "garcon-git-local-checkout-"),
    );
    const git = createGitOperations();

    try {
      await initRepoWithCommit(projectPath);
      await runGitCommand(projectPath, ["branch", "-M", "main"]);
      await runGitCommand(projectPath, ["checkout", "-b", "feature"]);
      await runGitCommand(projectPath, ["checkout", "main"]);

      await git.checkout({ projectPath, ref: "refs/heads/feature" });
      const { stdout } = await runGitCommand(projectPath, [
        "branch",
        "--show-current",
      ]);

      expect(stdout.trim()).toBe("feature");
    } finally {
      await fs.rm(projectPath, { recursive: true, force: true });
    }
  });

  it("checks out remote refs without creating a local branch", async () => {
    const projectPath = await fs.mkdtemp(
      path.join(os.tmpdir(), "garcon-git-remote-checkout-"),
    );
    const git = createGitOperations();

    try {
      await initRepoWithCommit(projectPath);
      await runGitCommand(projectPath, ["branch", "-M", "main"]);
      const { stdout: head } = await runGitCommand(projectPath, [
        "rev-parse",
        "HEAD",
      ]);
      await runGitCommand(projectPath, [
        "update-ref",
        "refs/remotes/origin/main",
        head.trim(),
      ]);

      await git.checkout({ projectPath, ref: "refs/remotes/origin/main" });
      const { stdout: branch } = await runGitCommand(projectPath, [
        "branch",
        "--show-current",
      ]);
      const { stdout: localMain } = await runGitCommand(projectPath, [
        "rev-parse",
        "--verify",
        "refs/heads/main",
      ]);

      expect(branch.trim()).toBe("");
      expect(localMain.trim()).toBe(head.trim());
    } finally {
      await fs.rm(projectPath, { recursive: true, force: true });
    }
  });

  it("uses the selected ref kind when a tag collides with a local branch name", async () => {
    const projectPath = await fs.mkdtemp(
      path.join(os.tmpdir(), "garcon-git-tag-collision-"),
    );
    const git = createGitOperations();

    try {
      await initRepoWithCommit(projectPath);
      await runGitCommand(projectPath, ["branch", "-M", "main"]);
      await runGitCommand(projectPath, ["branch", "release"]);
      const { stdout: branchCommit } = await runGitCommand(projectPath, [
        "rev-parse",
        "refs/heads/release",
      ]);
      await fs.writeFile(
        path.join(projectPath, "a.txt"),
        "one\ntwo\n",
        "utf-8",
      );
      await runGitCommand(projectPath, ["commit", "-am", "tag target"]);
      await runGitCommand(projectPath, ["tag", "release"]);
      const { stdout: tagCommit } = await runGitCommand(projectPath, [
        "rev-parse",
        "refs/tags/release",
      ]);

      await git.checkout({
        projectPath,
        ref: "refs/tags/release",
        refKind: "tag",
      });
      const { stdout: branch } = await runGitCommand(projectPath, [
        "branch",
        "--show-current",
      ]);
      const { stdout: head } = await runGitCommand(projectPath, [
        "rev-parse",
        "HEAD",
      ]);

      expect(branch.trim()).toBe("");
      expect(head.trim()).toBe(tagCommit.trim());
      expect(head.trim()).not.toBe(branchCommit.trim());
    } finally {
      await fs.rm(projectPath, { recursive: true, force: true });
    }
  });

  it("creates a branch from a selected base ref", async () => {
    const projectPath = await fs.mkdtemp(
      path.join(os.tmpdir(), "garcon-git-branch-base-"),
    );
    const git = createGitOperations();

    try {
      await initRepoWithCommit(projectPath);
      await runGitCommand(projectPath, ["branch", "-M", "main"]);
      await runGitCommand(projectPath, ["checkout", "-b", "remote-source"]);
      await fs.writeFile(
        path.join(projectPath, "a.txt"),
        "one\ntwo\n",
        "utf-8",
      );
      await runGitCommand(projectPath, ["commit", "-am", "remote edit"]);
      const { stdout: remoteCommit } = await runGitCommand(projectPath, [
        "rev-parse",
        "HEAD",
      ]);
      await runGitCommand(projectPath, [
        "update-ref",
        "refs/remotes/origin/main",
        remoteCommit.trim(),
      ]);
      await runGitCommand(projectPath, ["checkout", "main"]);

      await git.createBranch({
        projectPath,
        branch: "feature/from-origin",
        baseRef: "refs/remotes/origin/main",
      });
      const { stdout: branch } = await runGitCommand(projectPath, [
        "branch",
        "--show-current",
      ]);
      const { stdout: head } = await runGitCommand(projectPath, [
        "rev-parse",
        "HEAD",
      ]);

      expect(branch.trim()).toBe("feature/from-origin");
      expect(head.trim()).toBe(remoteCommit.trim());
    } finally {
      await fs.rm(projectPath, { recursive: true, force: true });
    }
  });
});

describe("porcelain ref validation", () => {
  it("rejects option-like checkout refs", async () => {
    const projectPath = await fs.mkdtemp(
      path.join(os.tmpdir(), "garcon-git-ref-checkout-"),
    );
    const git = createGitOperations();

    try {
      await initRepoWithCommit(projectPath);

      await expect(
        git.checkout({ projectPath, ref: "-HEAD" }),
      ).rejects.toMatchObject({
        code: "INVALID_INPUT",
        message: "Invalid checkout ref.",
      });
      await expect(
        git.checkout({ projectPath, ref: "." }),
      ).rejects.toMatchObject({
        code: "INVALID_INPUT",
        message: "Invalid checkout ref.",
      });
    } finally {
      await fs.rm(projectPath, { recursive: true, force: true });
    }
  });

  it("rejects invalid branch creation names and base refs", async () => {
    const projectPath = await fs.mkdtemp(
      path.join(os.tmpdir(), "garcon-git-ref-create-"),
    );
    const git = createGitOperations();

    try {
      await initRepoWithCommit(projectPath);

      await expect(
        git.createBranch({ projectPath, branch: "-bad" }),
      ).rejects.toMatchObject({
        code: "INVALID_INPUT",
        message: "Invalid branch name.",
      });
      await expect(
        git.createBranch({ projectPath, branch: "." }),
      ).rejects.toMatchObject({
        code: "INVALID_INPUT",
        message: "Invalid branch name.",
      });
      await expect(
        git.createBranch({
          projectPath,
          branch: "feature/good",
          baseRef: "missing-ref",
        }),
      ).rejects.toMatchObject({
        code: "INVALID_INPUT",
        message: "Invalid base ref.",
      });
    } finally {
      await fs.rm(projectPath, { recursive: true, force: true });
    }
  });

  it("rejects invalid worktree branch names and base refs", async () => {
    const projectPath = await fs.mkdtemp(
      path.join(os.tmpdir(), "garcon-git-ref-worktree-"),
    );
    const git = createGitOperations();

    try {
      await initRepoWithCommit(projectPath);

      await expect(
        git.createWorktree({
          projectPath,
          worktreePath: path.join(os.tmpdir(), "garcon-worktree-bad-branch"),
          branch: "--bad",
        }),
      ).rejects.toMatchObject({
        code: "INVALID_INPUT",
        message: "Invalid branch name.",
      });
      await expect(
        git.createWorktree({
          projectPath,
          worktreePath: path.join(os.tmpdir(), "garcon-worktree-bad-base"),
          branch: "feature/good",
          baseRef: "-x",
        }),
      ).rejects.toMatchObject({
        code: "INVALID_INPUT",
        message: "Invalid base ref.",
      });
    } finally {
      await fs.rm(projectPath, { recursive: true, force: true });
    }
  });

  it("rejects invalid push remotes and remote branches", async () => {
    const projectPath = await fs.mkdtemp(
      path.join(os.tmpdir(), "garcon-git-ref-push-"),
    );
    const git = createGitOperations();

    try {
      await initRepoWithCommit(projectPath);

      await expect(
        git.push({ projectPath, remote: "--force" }),
      ).rejects.toMatchObject({
        code: "INVALID_INPUT",
        message: "Invalid remote.",
      });
      await expect(
        git.push({ projectPath, remoteBranch: "-x" }),
      ).rejects.toMatchObject({
        code: "INVALID_INPUT",
        message: "Invalid remote branch name.",
      });
      await runGitCommand(projectPath, ["branch", "-M", "feature"]);
      await expect(
        git.push({ projectPath, remoteBranch: "main" }),
      ).rejects.toMatchObject({
        code: "INVALID_INPUT",
        message: "Remote branch must match the current local branch.",
      });
    } finally {
      await fs.rm(projectPath, { recursive: true, force: true });
    }
  });

  it("rejects option-like blame refs", async () => {
    const projectPath = await fs.mkdtemp(
      path.join(os.tmpdir(), "garcon-git-ref-blame-"),
    );
    const git = createGitOperations();

    try {
      await initRepoWithCommit(projectPath);

      await expect(
        git.getBlame({ projectPath, file: "a.txt", ref: "-HEAD" }),
      ).rejects.toMatchObject({
        code: "INVALID_INPUT",
        message: "Invalid blame ref.",
      });
    } finally {
      await fs.rm(projectPath, { recursive: true, force: true });
    }
  });

  it("reports a missing comparison endpoint without running a diff", async () => {
    const projectPath = await fs.mkdtemp(
      path.join(os.tmpdir(), "garcon-git-ref-compare-"),
    );
    const git = createGitOperations();

    try {
      await initRepoWithCommit(projectPath);

      const comparison = await git.getComparisonSnapshot({
        projectPath,
        from: { kind: "revision", revision: "missing-ref" },
        to: { kind: "revision", revision: "HEAD" },
        mode: "direct",
      });
      expect(comparison).toMatchObject({
        status: "not-found",
        endpoint: "from",
        revision: "missing-ref",
      });
    } finally {
      await fs.rm(projectPath, { recursive: true, force: true });
    }
  });
});
