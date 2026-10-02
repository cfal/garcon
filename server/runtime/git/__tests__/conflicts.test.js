import { describe, it, expect, spyOn } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createGitOperations } from "../git-service.js";
import { runGitCommand, initRepoWithCommit } from "./repository-fixture.js";
import { materializeReviewResponse } from "./rendered-patch-fixture.js";
import { withGitOperation } from "../operation-context.js";

describe("porcelain conflict and comparison robustness", () => {
  it('previews and resolves in-repository symlinks without staging their targets', async () => {
    const projectPath = await fs.mkdtemp(path.join(os.tmpdir(), 'garcon-git-conflict-link-'));
    try {
      await initRepoWithCommit(projectPath);
      await fs.symlink('a.txt', path.join(projectPath, 'link'));
      const git = createGitOperations();
      const details = await withGitOperation(projectPath, {}, () => git.getConflictDetails({ projectPath, file: 'link' }));
      expect(details.working.content).toBe('one\n');
      await withGitOperation(projectPath, {}, () => git.markConflictResolved({ projectPath, file: 'link' }));
      expect((await runGitCommand(projectPath, ['show', ':link'])).stdout).toBe('a.txt');
      expect((await runGitCommand(projectPath, ['ls-files', '-s', 'link'])).stdout).toStartWith('120000 ');
      expect(await fs.readFile(path.join(projectPath, 'a.txt'), 'utf8')).toBe('one\n');
    } finally { await fs.rm(projectPath, { recursive: true, force: true }); }
  });

  it('bounds previews at the exact byte limit and when a file grows after stat', async () => {
    const projectPath = await fs.mkdtemp(path.join(os.tmpdir(), 'garcon-git-preview-bound-'));
    let openSpy;
    try {
      await initRepoWithCommit(projectPath);
      const filePath = path.join(projectPath, 'a.txt');
      const git = createGitOperations();
      await fs.writeFile(filePath, 'x'.repeat(256 * 1024));
      expect((await git.getConflictDetails({ projectPath, file: 'a.txt' })).working)
        .toMatchObject({ truncated: false, byteLength: 256 * 1024 });
      const open = fs.open.bind(fs);
      openSpy = spyOn(fs, 'open').mockImplementation(async (...args) => {
        const handle = await open(...args);
        const read = handle.read.bind(handle);
        let grew = false;
        handle.read = async (...readArgs) => {
          if (!grew) { grew = true; await fs.appendFile(filePath, 'x'.repeat(256 * 1024)); }
          return read(...readArgs);
        };
        return handle;
      });
      expect((await git.getConflictDetails({ projectPath, file: 'a.txt' })).working)
        .toMatchObject({ content: null, truncated: true, byteLength: 512 * 1024, limitReason: 'content-too-large' });
    } finally {
      openSpy?.mockRestore();
      await fs.rm(projectPath, { recursive: true, force: true });
    }
  });

  it('rejects nonregular conflict files without waiting for a FIFO writer', async () => {
    if (process.platform === 'win32') return;
    const projectPath = await fs.mkdtemp(path.join(os.tmpdir(), 'garcon-git-conflict-fifo-'));
    try {
      await initRepoWithCommit(projectPath);
      const fifo = path.join(projectPath, 'pipe');
      expect(Bun.spawnSync(['mkfifo', fifo]).exitCode).toBe(0);
      const git = createGitOperations();
      const details = await withGitOperation(projectPath, { timeoutMs: 1000 }, () =>
        git.getConflictDetails({ projectPath, file: 'pipe' }));
      expect(details.working.content).toBeNull();
      await expect(withGitOperation(projectPath, { timeoutMs: 1000 }, () =>
        git.markConflictResolved({ projectPath, file: 'pipe' }))).rejects.toThrow('regular file');
      expect((await runGitCommand(projectPath, ['ls-files', '--', 'pipe'])).stdout).toBe('');
    } finally {
      await fs.rm(projectPath, { recursive: true, force: true });
    }
  }, 5000);

  it('scans all resolution content, including split markers and markers near EOF', async () => {
    const projectPath = await fs.mkdtemp(path.join(os.tmpdir(), 'garcon-git-conflict-scan-'));
    try {
      await initRepoWithCommit(projectPath);
      const git = createGitOperations();
      for (const marker of ['<<<<<<<', '=======', '>>>>>>>']) {
        for (const prefix of ['x'.repeat(65532) + '\n', 'x'.repeat(512 * 1024) + '\n', 'x'.repeat(65531) + '\u2028']) {
          await fs.writeFile(path.join(projectPath, 'a.txt'), prefix + marker + ' unresolved\n');
          await expect(git.markConflictResolved({ projectPath, file: 'a.txt' })).rejects.toThrow('Conflict markers remain');
          expect((await runGitCommand(projectPath, ['show', ':a.txt'])).stdout).toBe('one\n');
        }
      }
      const resolved = ('x'.repeat(65532) + '<<<<<<< embedded, not a line marker\n').repeat(10);
      await fs.writeFile(path.join(projectPath, 'a.txt'), resolved);
      await git.markConflictResolved({ projectPath, file: 'a.txt' });
      expect((await runGitCommand(projectPath, ['show', ':a.txt'])).stdout).toBe(resolved);
    } finally {
      await fs.rm(projectPath, { recursive: true, force: true });
    }
  });

  for (const operation of ['markConflictResolved', 'getConflictDetails']) it(`honors cancellation during ${operation} filesystem reads`, async () => {
    const projectPath = await fs.mkdtemp(path.join(os.tmpdir(), 'garcon-git-conflict-abort-'));
    let openSpy;
    let readSpy;
    try {
      await initRepoWithCommit(projectPath);
      await fs.writeFile(path.join(projectPath, 'a.txt'), 'resolved\n'.repeat(20_000));
      const controller = new AbortController();
      const open = fs.open.bind(fs);
      openSpy = spyOn(fs, 'open').mockImplementation(async (...args) => {
        const handle = await open(...args);
        const read = handle.read.bind(handle);
        readSpy = spyOn(handle, 'read').mockImplementation(async (...readArgs) => {
          const result = await read(...readArgs);
          controller.abort(new Error('scan cancelled'));
          return result;
        });
        return handle;
      });
      await expect(createGitOperations()[operation]({ projectPath, file: 'a.txt', signal: controller.signal }))
        .rejects.toThrow('scan cancelled');
      expect((await runGitCommand(projectPath, ['show', ':a.txt'])).stdout).toBe('one\n');
    } finally {
      readSpy?.mockRestore();
      openSpy?.mockRestore();
      await fs.rm(projectPath, { recursive: true, force: true });
    }
  });

  it("returns bounded conflict details for large conflicted files", async () => {
    const projectPath = await fs.mkdtemp(
      path.join(os.tmpdir(), "garcon-git-conflict-limit-"),
    );
    const git = createGitOperations();

    try {
      await initRepoWithCommit(projectPath);
      await runGitCommand(projectPath, ["checkout", "-b", "side"]);
      await fs.writeFile(
        path.join(projectPath, "a.txt"),
        `one\n${"side\n".repeat(70_000)}`,
        "utf-8",
      );
      await runGitCommand(projectPath, ["commit", "-am", "side edit"]);
      await runGitCommand(projectPath, ["checkout", "master"]);
      await fs.writeFile(
        path.join(projectPath, "a.txt"),
        `one\n${"main\n".repeat(70_000)}`,
        "utf-8",
      );
      await runGitCommand(projectPath, ["commit", "-am", "main edit"]);
      try {
        await runGitCommand(projectPath, ["merge", "side"]);
      } catch {
        // Expected merge conflict.
      }

      const { conflicts } = await git.getConflicts({ projectPath });
      const conflict = conflicts.find((entry) => entry.path === "a.txt");
      const details = await git.getConflictDetails({
        projectPath,
        file: "a.txt",
      });

      expect(conflict).toMatchObject({
        status: "UU",
        baseAvailable: true,
        oursAvailable: true,
        theirsAvailable: true,
      });
      expect(details.truncated).toBe(true);
      expect(details.ours).toMatchObject({
        content: null,
        truncated: true,
        limitReason: "content-too-large",
      });
      expect(details.theirs).toMatchObject({
        content: null,
        truncated: true,
        limitReason: "content-too-large",
      });
      expect(details.working.byteLength).toBeGreaterThan(0);

      const comparison = await git.getComparisonSnapshot({
        projectPath,
        from: { kind: "revision", revision: "HEAD" },
        to: { kind: "working-tree" },
        mode: "direct",
      });
      expect(
        comparison.files.find((file) => file.path === "a.txt"),
      ).toMatchObject({
        bodyState: "too-large",
        limitReason: "unsupported-file-kind",
      });
    } finally {
      await fs.rm(projectPath, { recursive: true, force: true });
    }
  });

  it("reports no conflicts when a rename source name parses as an unmerged status", async () => {
    const projectPath = await fs.mkdtemp(
      path.join(os.tmpdir(), "garcon-git-conflict-rename-"),
    );
    const git = createGitOperations();

    try {
      await initRepoWithCommit(projectPath);
      await runGitCommand(projectPath, ["config", "status.renames", "true"]);
      // A rename source literally named "UU a.txt" turns into a second
      // porcelain token; a parser that fails to consume it would fabricate a
      // UU conflict from the file name itself.
      await fs.writeFile(path.join(projectPath, "UU a.txt"), "one\n", "utf-8");
      await runGitCommand(projectPath, ["add", "UU a.txt"]);
      await runGitCommand(projectPath, ["commit", "-m", "add named source"]);
      await fs.copyFile(
        path.join(projectPath, "UU a.txt"),
        path.join(projectPath, "dst.txt"),
      );
      await runGitCommand(projectPath, ["add", "dst.txt"]);
      await runGitCommand(projectPath, ["commit", "-m", "add dst"]);
      await runGitCommand(projectPath, ["rm", "--cached", "dst.txt"]);
      await runGitCommand(projectPath, ["add", "-N", "dst.txt"]);
      await fs.rm(path.join(projectPath, "UU a.txt"));
      expect(
        (await runGitCommand(projectPath, ["status", "--porcelain", "-z"]))
          .stdout,
      ).toBe("DR dst.txt\0UU a.txt\0");

      const { conflicts } = await git.getConflicts({ projectPath });

      expect(conflicts).toEqual([]);
    } finally {
      await fs.rm(projectPath, { recursive: true, force: true });
    }
  });

  it("parses compare output for paths containing tabs", async () => {
    const projectPath = await fs.mkdtemp(
      path.join(os.tmpdir(), "garcon-git-compare-z-"),
    );
    const git = createGitOperations();
    const tabbedPath = "a\tb.txt";
    const renamedPath = "c\td.txt";

    try {
      await runGitCommand(projectPath, ["init"]);
      await runGitCommand(projectPath, [
        "config",
        "user.email",
        "test@example.com",
      ]);
      await runGitCommand(projectPath, ["config", "user.name", "Test User"]);
      await fs.writeFile(path.join(projectPath, tabbedPath), "one\n", "utf-8");
      await runGitCommand(projectPath, ["add", tabbedPath]);
      await runGitCommand(projectPath, ["commit", "-m", "initial"]);
      await runGitCommand(projectPath, ["checkout", "-b", "next"]);
      await runGitCommand(projectPath, ["mv", tabbedPath, renamedPath]);
      await fs.writeFile(
        path.join(projectPath, renamedPath),
        "one\ntwo\n",
        "utf-8",
      );
      await runGitCommand(projectPath, ["commit", "-am", "rename tabbed path"]);

      const compare = await git.getComparisonSnapshot({
        projectPath,
        from: { kind: "revision", revision: "master" },
        to: { kind: "revision", revision: "next" },
        mode: "direct",
      });

      expect(compare.status).toBe("ready");
      expect(compare.files).toContainEqual(
        expect.objectContaining({
          status: "renamed",
          rawStatus: expect.stringMatching(/^R/),
          originalPath: tabbedPath,
          path: renamedPath,
          additions: 1,
          deletions: 0,
        }),
      );

      const bodies = materializeReviewResponse(
        await git.getReviewDocumentFileBodies({
          projectPath,
          documentId: compare.documentId,
          files: [{ path: renamedPath, originalPath: tabbedPath }].map(
            (file) => file.path,
          ),
          purpose: "visible",
        }),
      );
      expect(bodies.files[renamedPath]).toMatchObject({
        path: renamedPath,
        bodyFingerprint: compare.files[0].bodyFingerprint,
      });
      expect(bodies.files[renamedPath].rows).toContainEqual(
        expect.objectContaining({ kind: "add", text: "two" }),
      );
    } finally {
      await fs.rm(projectPath, { recursive: true, force: true });
    }
  });
});
