import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createGitOperations } from '../git-service.js';
import { literalGitPathspec } from '../pathspecs.js';
import { initRepoWithCommit, plantUnmergedStages, runGitCommand } from './repository-fixture.js';

describe('literal Git selections', () => {
  let projectPath;
  let git;
  beforeEach(async () => {
    projectPath = await fs.mkdtemp(path.join(os.tmpdir(), 'garcon-git-literal-'));
    await initRepoWithCommit(projectPath);
    git = createGitOperations();
  });
  afterEach(async () => {
    await fs.rm(projectPath, { recursive: true, force: true });
  });

  it('rejects recursive deletion of a directory with clean tracked descendants', async () => {
    await fs.mkdir(path.join(projectPath, 'dir'));
    await fs.writeFile(path.join(projectPath, 'dir/kept.txt'), 'tracked\n');
    await runGitCommand(projectPath, ['add', 'dir']);
    await runGitCommand(projectPath, ['commit', '-m', 'track descendant']);
    await fs.writeFile(path.join(projectPath, 'dir/new.txt'), 'untracked\n');

    await expect(git.deleteUntracked({ projectPath, file: 'dir' })).rejects.toThrow('tracked by Git');
    expect(await fs.readFile(path.join(projectPath, 'dir/kept.txt'), 'utf8')).toBe('tracked\n');
    expect(await fs.readFile(path.join(projectPath, 'dir/new.txt'), 'utf8')).toBe('untracked\n');
    expect(await fs.readFile(path.join(projectPath, 'a.txt'), 'utf8')).toBe('one\n');
  });

  for (const [file, sibling] of [['*.txt', 'other.txt'], ['[ab].txt', 'b.txt'], [':(glob)*.txt', 'other.txt']]) {
    it(`refuses deleting a tracked literal ${file}`, async () => {
      await fs.writeFile(path.join(projectPath, file), 'tracked\n');
      await runGitCommand(projectPath, ['add', '--', literalGitPathspec(file)]);
      await runGitCommand(projectPath, ['commit', '-m', 'track literal']);
      await fs.writeFile(path.join(projectPath, sibling), 'untracked\n');
      await expect(git.deleteUntracked({ projectPath, file })).rejects.toThrow('tracked by Git');
      expect(await fs.readFile(path.join(projectPath, file), 'utf8')).toBe('tracked\n');
      expect(await fs.readFile(path.join(projectPath, sibling), 'utf8')).toBe('untracked\n');
    });

    it(`accepts only the requested conflict side for ${file}`, async () => {
      for (const name of [file, sibling]) {
        await plantUnmergedStages(projectPath, name, [[1, 'base\n'], [2, 'ours\n'], [3, 'theirs\n']]);
        await fs.writeFile(path.join(projectPath, name), '<<<<<<< ours\n=======\n>>>>>>> theirs\n');
      }
      const unmerged = (await runGitCommand(projectPath, ['ls-files', '-u', '-z', '--', literalGitPathspec(sibling)])).stdout;
      await git.acceptConflictSide({ projectPath, file, side: 'theirs' });
      expect(await fs.readFile(path.join(projectPath, file), 'utf8')).toBe('theirs\n');
      expect((await runGitCommand(projectPath, ['ls-files', '-u', '-z', '--', literalGitPathspec(file)])).stdout).toBe('');
      expect((await runGitCommand(projectPath, ['ls-files', '-u', '-z', '--', literalGitPathspec(sibling)])).stdout).toBe(unmerged);
      expect(await fs.readFile(path.join(projectPath, sibling), 'utf8')).toContain('<<<<<<<');
    });

    it(`marks only ${file} resolved without staging sibling conflict markers`, async () => {
      for (const name of [file, sibling]) {
        await plantUnmergedStages(projectPath, name, [[1, 'base\n'], [2, 'ours\n'], [3, 'theirs\n']]);
      }
      await fs.writeFile(path.join(projectPath, file), 'resolved\n');
      await fs.writeFile(path.join(projectPath, sibling), '<<<<<<< ours\n');
      const unmerged = (await runGitCommand(projectPath, ['ls-files', '-u', '-z', '--', literalGitPathspec(sibling)])).stdout;
      await git.markConflictResolved({ projectPath, file });
      expect((await runGitCommand(projectPath, ['show', `:${file}`])).stdout).toBe('resolved\n');
      expect((await runGitCommand(projectPath, ['ls-files', '-u', '-z', '--', literalGitPathspec(sibling)])).stdout).toBe(unmerged);
    });

    it(`limits history to the literal ${file}`, async () => {
      await fs.writeFile(path.join(projectPath, file), 'literal\n');
      await runGitCommand(projectPath, ['add', '--', literalGitPathspec(file)]);
      await runGitCommand(projectPath, ['commit', '-m', 'literal change']);
      await fs.writeFile(path.join(projectPath, sibling), 'sibling\n');
      await runGitCommand(projectPath, ['add', '--', literalGitPathspec(sibling)]);
      await runGitCommand(projectPath, ['commit', '-m', 'sibling change']);
      const { commits } = await git.getFileHistory({ projectPath, file });
      expect(commits.map(commit => commit.subject)).toEqual(['literal change']);
    });
  }

  it('deletes only the requested untracked file or directory', async () => {
    await fs.writeFile(path.join(projectPath, '*.txt'), 'literal\n');
    await fs.writeFile(path.join(projectPath, 'other.txt'), 'sibling\n');
    await git.deleteUntracked({ projectPath, file: '*.txt' });
    expect(await fs.exists(path.join(projectPath, '*.txt'))).toBe(false);
    expect(await fs.readFile(path.join(projectPath, 'other.txt'), 'utf8')).toBe('sibling\n');
    await fs.mkdir(path.join(projectPath, 'dir'));
    await fs.writeFile(path.join(projectPath, 'dir/new.txt'), 'new\n');
    await git.deleteUntracked({ projectPath, file: 'dir' });
    expect(await fs.exists(path.join(projectPath, 'dir'))).toBe(false);
    expect(await fs.readFile(path.join(projectPath, 'a.txt'), 'utf8')).toBe('one\n');
  });
});
