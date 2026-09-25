import { afterEach, describe, expect, it } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { readAdminWorktreeRecords } from "../worktree-admin.js";

const cleanupPaths = [];

afterEach(async () => {
  await Promise.all(
    cleanupPaths.splice(0).map((target) =>
      fs.rm(target, { recursive: true, force: true }),
    ),
  );
});

async function createFixture() {
  const fixtureRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "garcon-worktree-admin-"),
  );
  cleanupPaths.push(fixtureRoot);
  const repositoryPath = path.join(fixtureRoot, "repo");
  const commonDir = path.join(repositoryPath, ".git");
  const worktreesDir = path.join(commonDir, "worktrees");
  await fs.mkdir(worktreesDir, { recursive: true });
  await fs.writeFile(path.join(commonDir, "HEAD"), "ref: refs/heads/main\n");
  await fs.writeFile(path.join(commonDir, "config"), "[core]\n\tbare = false\n");
  return { fixtureRoot, repositoryPath, commonDir, worktreesDir };
}

async function createAdminEntry(
  worktreesDir,
  id,
  gitdir,
  head,
) {
  const adminDir = path.join(worktreesDir, id);
  await fs.mkdir(adminDir, { recursive: true });
  if (gitdir !== null) {
    await fs.writeFile(path.join(adminDir, "gitdir"), gitdir);
  }
  if (head !== null) {
    await fs.writeFile(path.join(adminDir, "HEAD"), head);
  }
}

describe("worktree admin metadata", () => {
  it("reads relative and absolute gitdirs with Git-compatible HEAD states", async () => {
    const { repositoryPath, commonDir, worktreesDir } = await createFixture();
    const upperPath = path.join(repositoryPath, "paths", "Zed");
    const lowerPath = path.join(repositoryPath, "paths", "apple");
    const emptyHeadPath = path.join(repositoryPath, "paths", "empty-head");
    const externalRefPath = path.join(repositoryPath, "paths", "external-ref");
    await Promise.all(
      [upperPath, lowerPath, emptyHeadPath, externalRefPath].map((target) =>
        fs.mkdir(target, { recursive: true }),
      ),
    );

    await createAdminEntry(
      worktreesDir,
      "relative",
      "../../../paths/Zed/.git\n",
      "ref: refs/heads/feature\n",
    );
    await createAdminEntry(
      worktreesDir,
      "absolute",
      `${lowerPath}/.git\n`,
      `${"a".repeat(40)}\n`,
    );
    await createAdminEntry(
      worktreesDir,
      "empty-head",
      `${emptyHeadPath}/.git\n`,
      null,
    );
    await createAdminEntry(
      worktreesDir,
      "external-ref",
      `${externalRefPath}/.git\n`,
      "ref: refs/custom/topic\n",
    );
    await createAdminEntry(worktreesDir, "empty-gitdir", "", null);
    await createAdminEntry(worktreesDir, "missing-gitdir", null, null);
    await fs.writeFile(path.join(worktreesDir, "stray-file"), "ignored");

    const records = await readAdminWorktreeRecords({
      worktreeRoot: repositoryPath,
      commonDir,
      refFormat: "files",
    });
    expect(records?.[0]).toEqual(
      {
        path: repositoryPath,
        branch: "main",
        name: "main",
        isMain: true,
      },
    );
    const linkedRecords = records?.slice(1);
    expect(linkedRecords).toHaveLength(4);
    expect(linkedRecords).toEqual(expect.arrayContaining([
      {
        path: upperPath,
        branch: "feature",
        name: "feature",
        isMain: false,
      },
      {
        path: lowerPath,
        branch: "(detached)",
        name: "apple",
        isMain: false,
      },
      {
        path: emptyHeadPath,
        branch: "",
        name: "empty-head",
        isMain: false,
      },
      {
        path: externalRefPath,
        branch: "refs/custom/topic",
        name: "refs/custom/topic",
        isMain: false,
      },
    ]));
  });

  it("declines bare and separate Git-directory layouts", async () => {
    const fixtureRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), "garcon-worktree-nonstandard-"),
    );
    cleanupPaths.push(fixtureRoot);
    const commonDir = path.join(fixtureRoot, "repository.git");
    await fs.mkdir(commonDir);

    expect(
      await readAdminWorktreeRecords({
        worktreeRoot: fixtureRoot,
        commonDir,
        refFormat: "files",
      }),
    ).toBeNull();
  });

  it("declines symlink-based HEAD refs", async () => {
    const { repositoryPath, commonDir } = await createFixture();
    const headPath = path.join(commonDir, "HEAD");
    await fs.rm(headPath);
    await fs.symlink("refs/heads/main", headPath);

    expect(
      await readAdminWorktreeRecords({
        worktreeRoot: repositoryPath,
        commonDir,
        refFormat: "files",
      }),
    ).toBeNull();
  });

  it("declines linked symlink-based HEAD refs", async () => {
    const { repositoryPath, commonDir, worktreesDir } = await createFixture();
    const linkedPath = path.join(repositoryPath, "linked");
    await fs.mkdir(linkedPath);
    await createAdminEntry(
      worktreesDir,
      "linked",
      `${linkedPath}/.git\n`,
      "ref: refs/heads/linked\n",
    );
    const linkedHeadPath = path.join(worktreesDir, "linked", "HEAD");
    await fs.rm(linkedHeadPath);
    await fs.symlink("refs/heads/linked", linkedHeadPath);

    expect(
      await readAdminWorktreeRecords({
        worktreeRoot: repositoryPath,
        commonDir,
        refFormat: "files",
      }),
    ).toBeNull();
  });

  it("declines bare and per-worktree config layouts", async () => {
    const { repositoryPath, commonDir } = await createFixture();
    await fs.writeFile(path.join(commonDir, "config"), "[core] bare = true\n");

    expect(
      await readAdminWorktreeRecords({
        worktreeRoot: repositoryPath,
        commonDir,
        refFormat: "files",
      }),
    ).toBeNull();

    await fs.writeFile(path.join(commonDir, "config"), "[core]\n\tbare = true\n");

    expect(
      await readAdminWorktreeRecords({
        worktreeRoot: repositoryPath,
        commonDir,
        refFormat: "files",
      }),
    ).toBeNull();

    await fs.writeFile(path.join(commonDir, "config"), "[core]\n\tbare = false\n");
    await fs.writeFile(path.join(commonDir, "config.worktree"), "[core]\n");
    expect(
      await readAdminWorktreeRecords({
        worktreeRoot: repositoryPath,
        commonDir,
        refFormat: "files",
      }),
    ).toBeNull();
  });

  it("declines non-empty gitdir metadata that trims to empty", async () => {
    const { repositoryPath, commonDir, worktreesDir } = await createFixture();
    await createAdminEntry(worktreesDir, "blank-gitdir", " \t\n", null);

    expect(
      await readAdminWorktreeRecords({
        worktreeRoot: repositoryPath,
        commonDir,
        refFormat: "files",
      }),
    ).toBeNull();
  });

  it("resolves chained HEAD symrefs", async () => {
    const { repositoryPath, commonDir } = await createFixture();
    const customRefs = path.join(commonDir, "refs", "custom");
    await fs.mkdir(customRefs, { recursive: true });
    await fs.writeFile(path.join(commonDir, "HEAD"), "ref: refs/custom/mid\n");
    await fs.writeFile(
      path.join(customRefs, "mid"),
      "ref: refs/heads/topic\n",
    );

    expect(
      (await readAdminWorktreeRecords({
        worktreeRoot: repositoryPath,
        commonDir,
        refFormat: "files",
      }))?.[0],
    ).toMatchObject({ branch: "topic", name: "topic" });
  });

  it("resolves the existing prefix of a missing relative worktree", async () => {
    const { repositoryPath, commonDir, worktreesDir } = await createFixture();
    const actualParent = path.join(repositoryPath, "actual");
    const linkedParent = path.join(repositoryPath, "linked");
    await fs.mkdir(actualParent);
    await fs.symlink(actualParent, linkedParent, "dir");
    const adminDir = path.join(worktreesDir, "missing-relative");
    await createAdminEntry(
      worktreesDir,
      "missing-relative",
      `${path.relative(adminDir, path.join(linkedParent, "missing", ".git"))}\n`,
      "ref: refs/heads/missing\n",
    );

    expect(
      (await readAdminWorktreeRecords({
        worktreeRoot: repositoryPath,
        commonDir,
        refFormat: "files",
      }))?.[1],
    ).toMatchObject({
      path: path.join(actualParent, "missing"),
      branch: "missing",
    });
  });

  it("propagates structural read failures for the Git fallback", async () => {
    const { repositoryPath, commonDir, worktreesDir } = await createFixture();
    await fs.rm(worktreesDir, { recursive: true, force: true });
    await fs.writeFile(worktreesDir, "not a directory");

    await expect(
      readAdminWorktreeRecords({
        worktreeRoot: repositoryPath,
        commonDir,
        refFormat: "files",
      }),
    ).rejects.toThrow();
  });
});
