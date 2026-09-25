import { afterEach, expect, test, spyOn } from 'bun:test';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { runGit } from '../run.js';
import { GitReviewDocumentRegistry } from '../review-document-registry.js';
import { GIT_REVIEW_DOCUMENT_LIMITS } from '../types.js';
import { cleanupExecutorRuntimeFixtures, executorRuntimeFixture, untrackedReview } from './executor-runtime-fixture.js';

afterEach(cleanupExecutorRuntimeFixtures);

async function scratchIndexes(projectPath: string) {
  return (await fs.readdir(path.join(projectPath, '.git'))).filter(name => name.startsWith('.garcon-index-'));
}

async function indexBytes(projectPath: string, file: string) {
  const child = Bun.spawn(['git', 'show', `:${file}`], { cwd: projectPath, stdout: 'pipe', stderr: 'pipe' });
  const [bytes, error, code] = await Promise.all([new Response(child.stdout).arrayBuffer(), new Response(child.stderr).text(), child.exited]);
  if (code !== 0) throw new Error(error);
  return Buffer.from(bytes);
}

for (const method of ['stageHunk', 'stageSelection'] as const) {
  for (const attributes of ['', '*.txt -text\n']) {
    test(`${method} uses native clean conversion (${attributes ? '-text' : 'autocrlf'})`, async () => {
      const { projectPath, git } = await executorRuntimeFixture();
      await runGit(projectPath, ['config', 'core.autocrlf', 'true']);
      if (attributes) await fs.writeFile(path.join(projectPath, '.gitattributes'), attributes);
      const file = 'new.txt';
      await fs.writeFile(path.join(projectPath, file), 'one\r\ntwo\r\n');
      const indexBefore = await fs.readFile(path.join(projectPath, '.git/index'));
      const { document, body } = await untrackedReview(git, projectPath, file);
      const newline = attributes ? '\r\n' : '\n';
      expect(body.patch).toContain(`+one${newline}+two${newline}`);
      expect(body.patchDigest).toBe(createHash('sha256').update(body.patch!).digest('hex'));
      expect(await fs.readFile(path.join(projectPath, '.git/index'))).toEqual(indexBefore);
      expect(await scratchIndexes(projectPath)).toEqual([]);
      const proof = { projectPath, file, document, bodyFingerprint: body.bodyFingerprint, patchDigest: body.patchDigest!, mode: 'stage' as const, contextLines: 2 };
      if (method === 'stageHunk') await git.stageHunk({ ...proof, hunkIndex: 0 });
      else await git.stageSelection({ ...proof, selection: { lineIndices: [1] } });
      expect((await indexBytes(projectPath, file)).toString()).toBe(method === 'stageHunk' ? `one${newline}two${newline}` : `two${newline}`);
      expect(await fs.readFile(path.join(projectPath, file), 'utf8')).toBe('one\r\ntwo\r\n');
      expect(await scratchIndexes(projectPath)).toEqual([]);
    });
  }

  test(`${method} displays and stages filtered rows using indexed attributes`, async () => {
    const { projectPath, git } = await executorRuntimeFixture();
    await fs.writeFile(path.join(projectPath, '.gitattributes'), 'new.txt filter=normalize\n');
    await runGit(projectPath, ['add', '.gitattributes']);
    await fs.rm(path.join(projectPath, '.gitattributes'));
    await runGit(projectPath, ['config', 'filter.normalize.clean', "awk '{print toupper($0); print \"extra\"}'"]);
    await fs.writeFile(path.join(projectPath, 'new.txt'), 'one\ntwo\n');
    const indexBefore = await fs.readFile(path.join(projectPath, '.git/index'));
    const { document, body } = await untrackedReview(git, projectPath, 'new.txt');
    expect(body.patch).toContain('+ONE\n+extra\n+TWO\n+extra\n');
    expect(body.renderedRowCount).toBe(5);
    expect(await fs.readFile(path.join(projectPath, '.git/index'))).toEqual(indexBefore);
    const proof = { projectPath, file: 'new.txt', document, bodyFingerprint: body.bodyFingerprint, patchDigest: body.patchDigest!, mode: 'stage' as const, contextLines: 2 };
    if (method === 'stageHunk') await git.stageHunk({ ...proof, hunkIndex: 0 });
    else await git.stageSelection({ ...proof, selection: { lineIndices: [1, 2] } });
    expect((await indexBytes(projectPath, 'new.txt')).toString()).toBe(method === 'stageHunk' ? 'ONE\nextra\nTWO\nextra\n' : 'extra\nTWO\n');
    expect(await scratchIndexes(projectPath)).toEqual([]);
  });

  test(`${method} preserves BOM, EOF and executable mode`, async () => {
    const { projectPath, git } = await executorRuntimeFixture();
    const content = Buffer.from('\uFEFFno newline');
    await fs.writeFile(path.join(projectPath, 'new.txt'), content, { mode: 0o755 });
    const { document, body } = await untrackedReview(git, projectPath, 'new.txt');
    expect(body.patch).toContain('\\ No newline at end of file');
    const proof = { projectPath, file: 'new.txt', document, bodyFingerprint: body.bodyFingerprint, patchDigest: body.patchDigest!, mode: 'stage' as const, contextLines: 2 };
    if (method === 'stageHunk') await git.stageHunk({ ...proof, hunkIndex: 0 });
    else await git.stageSelection({ ...proof, selection: { lineIndices: [0] } });
    expect(await indexBytes(projectPath, 'new.txt')).toEqual(content);
    expect((await runGit(projectPath, ['ls-files', '-s', 'new.txt'])).stdout).toStartWith('100755 ');
  });
}

test('eviction and changed clean configuration reject the old proof before real intent-to-add', async () => {
  const { git, projectPath } = await executorRuntimeFixture(new GitReviewDocumentRegistry({ maxBodyBytes: 0 }));
  await fs.writeFile(path.join(projectPath, 'new.txt'), 'one\r\ntwo\r\n');
  await runGit(projectPath, ['config', 'core.autocrlf', 'false']);
  const { document, body } = await untrackedReview(git, projectPath, 'new.txt');
  await runGit(projectPath, ['config', 'core.autocrlf', 'true']);
  await expect(git.stageHunk({ projectPath, file: 'new.txt', document, bodyFingerprint: body.bodyFingerprint, patchDigest: body.patchDigest!, mode: 'stage', contextLines: 2, hunkIndex: 0 })).rejects.toMatchObject({ code: 'GIT_STALE_DOCUMENT' });
  expect((await runGit(projectPath, ['ls-files', 'new.txt'])).stdout).toBe('');
  expect(await scratchIndexes(projectPath)).toEqual([]);
  const refreshed = await untrackedReview(git, projectPath, 'new.txt');
  expect(refreshed.document.documentId).not.toBe(document.documentId);
  expect(refreshed.body.patch).toContain('+one\n+two\n');
});

for (const [name, command, outcome] of [
  ['expansion', `head -c ${GIT_REVIEW_DOCUMENT_LIMITS.maxFilePatchBytes + 1_000_000} /dev/zero | tr '\\0' x`, { bodyState: 'too-large', limitReason: 'file-too-many-bytes' }],
  ['binary', "printf '\\0binary'", { bodyState: 'binary', limitReason: 'binary' }],
  ['required failure', 'exit 1', { bodyState: 'error' }],
] as const) {
  test(`bounds filtered output and cleans scratch indexes after ${name}`, async () => {
    const { projectPath, git } = await executorRuntimeFixture();
    await fs.writeFile(path.join(projectPath, '.gitattributes'), 'new.txt filter=normalize\n');
    await runGit(projectPath, ['config', 'filter.normalize.clean', command]);
    await runGit(projectPath, ['config', 'filter.normalize.required', 'true']);
    await fs.writeFile(path.join(projectPath, 'new.txt'), 'small\n');
    const indexBefore = await fs.readFile(path.join(projectPath, '.git/index'));
    const { body } = await untrackedReview(git, projectPath, 'new.txt');
    expect(body).toMatchObject(outcome);
    expect(await fs.readFile(path.join(projectPath, '.git/index'))).toEqual(indexBefore);
    expect(await scratchIndexes(projectPath)).toEqual([]);
  });
}

test('cancelled scratch-index preparation cleans files without marking a real mutation', async () => {
  const { git, projectPath } = await executorRuntimeFixture(new GitReviewDocumentRegistry({ maxBodyBytes: 0 }));
  await fs.writeFile(path.join(projectPath, 'new.txt'), 'one\n');
  const { document, body } = await untrackedReview(git, projectPath, 'new.txt');
  const controller = new AbortController();
  const copyFile = fs.copyFile;
  const copy = spyOn(fs, 'copyFile').mockImplementation(async (...args) => {
    await copyFile(...args);
    controller.abort();
  });
  try {
    await expect(git.stageHunk({ projectPath, file: 'new.txt', document, bodyFingerprint: body.bodyFingerprint, patchDigest: body.patchDigest!, mode: 'stage', contextLines: 2, hunkIndex: 0 }, { signal: controller.signal })).rejects.toMatchObject({ code: 'GIT_TIMEOUT' });
  } finally { copy.mockRestore(); }
  expect(await scratchIndexes(projectPath)).toEqual([]);
  expect((await runGit(projectPath, ['ls-files', 'new.txt'])).stdout).toBe('');
});

for (const method of ['stageHunk', 'stageSelection'] as const) {
  for (const cancelled of [false, true]) test(`${method} preserves an external writer's staging after ${cancelled ? 'cancellation' : 'lock contention'}`, async () => {
    const { git, projectPath } = await executorRuntimeFixture();
    const index = path.join(projectPath, '.git/index');
    const externalIndex = path.join(projectPath, '.git/external-index');
    await fs.copyFile(index, externalIndex);
    await fs.writeFile(path.join(projectPath, 'new.txt'), 'externally staged-only content\n');
    await runGit(projectPath, ['add', 'new.txt'], { env: { GIT_INDEX_FILE: externalIndex } });
    const expected = await fs.readFile(externalIndex);
    await fs.writeFile(path.join(projectPath, 'new.txt'), 'displayed content\n');
    const { document, body } = await untrackedReview(git, projectPath, 'new.txt');
    await fs.copyFile(externalIndex, `${index}.lock`);
    const controller = new AbortController();
    const original = Bun.spawn;
    let writer: Promise<void> | undefined;
    const command = spyOn(Bun, 'spawn').mockImplementation((args, options) => {
      const child = original(args, options);
      if (Array.isArray(args) && args[0] === 'git' && (args[1] === 'apply' || args[1] === 'add') && !options?.env?.GIT_INDEX_FILE && !writer) {
        writer = child.exited.then(async () => {
          await fs.rename(`${index}.lock`, index);
          if (cancelled) controller.abort();
        });
      }
      return child;
    });
    try {
      const proof = { projectPath, file: 'new.txt', document, bodyFingerprint: body.bodyFingerprint, patchDigest: body.patchDigest!, mode: 'stage' as const, contextLines: 2 };
      const pending = method === 'stageHunk'
        ? git.stageHunk({ ...proof, hunkIndex: 0 }, { signal: controller.signal })
        : git.stageSelection({ ...proof, selection: { lineIndices: [0] } }, { signal: controller.signal });
      await expect(pending).rejects.toThrow();
      await writer;
      expect(writer).toBeDefined();
      expect(await fs.readFile(index)).toEqual(expected);
      expect(command.mock.calls.some(([args, options]) => Array.isArray(args) && args[0] === 'git' && ['add', 'reset'].includes(args[1]) && !options?.env?.GIT_INDEX_FILE)).toBe(false);
    } finally { command.mockRestore(); await writer; }
    expect((await indexBytes(projectPath, 'new.txt')).toString()).toBe('externally staged-only content\n');
    expect(await scratchIndexes(projectPath)).toEqual([]);
  });

  for (const intent of [false, true]) test(`${method} preserves creation headers despite prefix configuration (${intent ? 'existing intent' : 'untracked'})`, async () => {
    const { projectPath, git } = await executorRuntimeFixture();
    const file = 'nested/new file.txt';
    await fs.mkdir(path.join(projectPath, 'nested'));
    await fs.writeFile(path.join(projectPath, file), '++content\nsecond\n');
    if (intent) await runGit(projectPath, ['add', '-N', '--', file]);
    await runGit(projectPath, ['config', 'diff.noprefix', 'true']);
    const { document, body } = await untrackedReview(git, projectPath, file);
    const proof = { projectPath, file, document, bodyFingerprint: body.bodyFingerprint, patchDigest: body.patchDigest!, mode: 'stage' as const, contextLines: 2 };
    if (method === 'stageHunk') await git.stageHunk({ ...proof, hunkIndex: 0 });
    else await git.stageSelection({ ...proof, selection: { lineIndices: [0] } });
    expect((await indexBytes(projectPath, file)).toString()).toBe(method === 'stageHunk' ? '++content\nsecond\n' : '++content\n');
    expect((await runGit(projectPath, ['ls-files', '--', 'new file.txt'])).stdout).toBe('');
  });
}

test('an empty numeric selection cannot stage a header-only empty file', async () => {
  const { projectPath, git } = await executorRuntimeFixture();
  await fs.writeFile(path.join(projectPath, 'new.txt'), 'one\n');
  const { document, body } = await untrackedReview(git, projectPath, 'new.txt');
  await expect(git.stageSelection({ projectPath, file: 'new.txt', document, bodyFingerprint: body.bodyFingerprint, patchDigest: body.patchDigest!, mode: 'stage', contextLines: 2, selection: { lineIndices: [50] } })).rejects.toMatchObject({ code: 'GIT_INVALID_INPUT' });
  expect((await runGit(projectPath, ['ls-files', 'new.txt'])).stdout).toBe('');
});

test('a failed selection never removes pre-existing intent-to-add', async () => {
  const { git, projectPath } = await executorRuntimeFixture();
  await fs.writeFile(path.join(projectPath, 'new.txt'), 'one\n');
  await runGit(projectPath, ['add', '-N', 'new.txt']);
  const { document, body } = await untrackedReview(git, projectPath, 'new.txt');
  const before = (await runGit(projectPath, ['ls-files', '--debug', 'new.txt'])).stdout;
  await expect(git.stageHunk({ projectPath, file: 'new.txt', document, bodyFingerprint: body.bodyFingerprint, patchDigest: body.patchDigest!, mode: 'stage', contextLines: 2, hunkIndex: 50 })).rejects.toThrow();
  expect((await runGit(projectPath, ['ls-files', '--debug', 'new.txt'])).stdout).toBe(before);
});
