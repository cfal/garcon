import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import { constants, promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import { randomUUID } from 'crypto';
import {
  stripResolvedFileMentionContext,
} from '../../chats/file-mentions.ts';
import { LocalWorkspaceFileMentionService } from '../local-workspace-file-mentions.js';

const service = new LocalWorkspaceFileMentionService();
const resolveFileMentionsInCommand = (command, projectPath, signal = new AbortController().signal) =>
  service.resolve({ command, projectPath }, signal);

let projectPath;
let outsidePath;

beforeEach(async () => {
  const root = path.join(os.tmpdir(), `garcon-file-mentions-${randomUUID()}`);
  projectPath = path.join(root, 'project');
  outsidePath = path.join(root, 'secret.txt');
  await fs.mkdir(path.join(projectPath, 'src'), { recursive: true });
  await fs.mkdir(path.join(projectPath, 'docs'), { recursive: true });
  await fs.writeFile(path.join(projectPath, 'src/main.ts'), 'export const value = 42;\n', 'utf8');
  await fs.writeFile(path.join(projectPath, 'docs/design note.md'), '# Design\n', 'utf8');
  await fs.writeFile(outsidePath, 'do not include\n', 'utf8');
});

afterEach(async () => {
  await fs.rm(path.dirname(projectPath), { recursive: true, force: true });
});

describe('resolveFileMentionsInCommand', () => {
  it('rejects cancelled reads before filesystem access even without mention tokens', async () => {
    const signal = AbortSignal.abort(new Error('Synthetic mention cancellation'));
    const realpath = spyOn(fs, 'realpath');
    try {
      await expect(resolveFileMentionsInCommand('plain input', projectPath, signal)).rejects.toBe(signal.reason);
      await expect(resolveFileMentionsInCommand('read @src/main.ts', projectPath, signal)).rejects.toBe(signal.reason);
      expect(realpath).not.toHaveBeenCalled();
    } finally {
      realpath.mockRestore();
    }
  });

  it('closes every acquired handle when cancellation races a later file open', async () => {
    const cancellation = new AbortController();
    const error = new Error('Synthetic open cancellation');
    const originalOpen = fs.open.bind(fs);
    const closes = [];
    const open = spyOn(fs, 'open').mockImplementation(async (...args) => {
      const handle = await originalOpen(...args);
      closes.push(spyOn(handle, 'close'));
      if (closes.length === 2) cancellation.abort(error);
      return handle;
    });
    try {
      await expect(resolveFileMentionsInCommand('read @src/main.ts @"docs/design note.md"', projectPath, cancellation.signal))
        .rejects.toBe(error);
      expect(closes).toHaveLength(2);
      for (const close of closes) expect(close).toHaveBeenCalledTimes(1);
    } finally {
      open.mockRestore();
      for (const close of closes) close.mockRestore();
    }
  });

  it('discards a cancelled native read and closes its handle before rejecting', async () => {
    const cancellation = new AbortController();
    const error = new Error('Synthetic read cancellation');
    const originalOpen = fs.open.bind(fs);
    let close;
    const open = spyOn(fs, 'open').mockImplementation(async (...args) => {
      const handle = await originalOpen(...args);
      const read = handle.read.bind(handle);
      close = spyOn(handle, 'close');
      handle.read = async (...readArgs) => {
        const result = await read(...readArgs);
        cancellation.abort(error);
        return result;
      };
      return handle;
    });
    try {
      await expect(resolveFileMentionsInCommand('read @src/main.ts', projectPath, cancellation.signal))
        .rejects.toBe(error);
      expect(close).toHaveBeenCalledTimes(1);
    } finally {
      open.mockRestore();
      close?.mockRestore();
    }
  });

  it('appends contents for mentioned project files', async () => {
    const resolved = await resolveFileMentionsInCommand(
      'read @src/main.ts and @"docs/design note.md"',
      projectPath,
    );

    expect(resolved).toContain('Referenced file contents from @file mentions:');
    expect(resolved).toContain('@src/main.ts');
    expect(resolved).toContain('export const value = 42;');
    expect(resolved).toContain('@docs/design note.md');
    expect(resolved).toContain('# Design');
  });

  it('does not include files outside the project root', async () => {
    const resolved = await resolveFileMentionsInCommand('read @../secret.txt', projectPath);

    expect(resolved).toBe('read @../secret.txt');
    expect(resolved).not.toContain('do not include');
  });

  it('does not follow project symlinks outside the project root', async () => {
    await fs.symlink(outsidePath, path.join(projectPath, 'secret-link.txt'));

    const resolved = await resolveFileMentionsInCommand('read @secret-link.txt', projectPath);

    expect(resolved).toBe('read @secret-link.txt');
    expect(resolved).not.toContain('do not include');
  });

  it.skipIf(process.platform === 'win32')('ignores named pipes without blocking', async () => {
    const fifoPath = path.join(projectPath, 'blocked.pipe');
    const mkfifo = Bun.spawn(['mkfifo', fifoPath], { stdout: 'ignore', stderr: 'ignore' });
    expect(await mkfifo.exited).toBe(0);

    const resolution = resolveFileMentionsInCommand('read @blocked.pipe', projectPath);
    let timeout;
    const completedPromptly = await Promise.race([
      resolution.then(() => true),
      new Promise((resolve) => {
        timeout = setTimeout(() => resolve(false), 250);
      }),
    ]);
    clearTimeout(timeout);
    if (!completedPromptly) {
      const writer = await fs.open(
        fifoPath,
        constants.O_WRONLY | constants.O_NONBLOCK,
      ).catch(() => null);
      await writer?.close();
    }

    expect(await resolution).toBe('read @blocked.pipe');
    expect(completedPromptly).toBe(true);
  });

  it('rejects a directory replacement between resolution and open', async () => {
    const sourceDirectory = path.join(projectPath, 'src');
    const originalDirectory = path.join(projectPath, 'original-src');
    const outsideDirectory = path.join(path.dirname(projectPath), 'outside-src');
    await fs.mkdir(outsideDirectory);
    await fs.writeFile(path.join(outsideDirectory, 'main.ts'), 'do not include\n', 'utf8');
    const originalOpen = fs.open.bind(fs);
    let replaced = false;
    const open = spyOn(fs, 'open').mockImplementation(async (filePath, ...args) => {
      if (!replaced && filePath === path.join(sourceDirectory, 'main.ts')) {
        replaced = true;
        await fs.rename(sourceDirectory, originalDirectory);
        await fs.symlink(outsideDirectory, sourceDirectory, 'dir');
      }
      return originalOpen(filePath, ...args);
    });

    try {
      const resolved = await resolveFileMentionsInCommand('read @src/main.ts', projectPath);

      expect(resolved).toBe('read @src/main.ts');
      expect(resolved).not.toContain('do not include');
    } finally {
      open.mockRestore();
    }
  });

  it('strips resolved context back to the user-authored prompt', async () => {
    const resolved = await resolveFileMentionsInCommand('read @src/main.ts', projectPath);

    expect(stripResolvedFileMentionContext(resolved)).toBe('read @src/main.ts');
  });

  it('reads only the configured prefix of a large mentioned file', async () => {
    const largePath = path.join(projectPath, 'large.txt');
    const handle = await fs.open(largePath, 'w');
    await handle.truncate(16 * 1024 * 1024);
    await handle.write(Buffer.from(`prefix contents${'a'.repeat(4096)}`), 0, 4096, 0);
    await handle.close();

    const originalOpen = fs.open.bind(fs);
    let largestReadBuffer = 0;
    const open = spyOn(fs, 'open').mockImplementation(async (...args) => {
      const file = await originalOpen(...args);
      const originalRead = file.read.bind(file);
      file.read = async (buffer, ...readArgs) => {
        largestReadBuffer = Math.max(largestReadBuffer, buffer.byteLength);
        return originalRead(buffer, ...readArgs);
      };
      return file;
    });

    try {
      const resolved = await resolveFileMentionsInCommand('read @large.txt', projectPath);

      expect(resolved).toContain('prefix contents');
      expect(resolved).toContain('Garcon truncated this file at 131072 bytes.');
      expect(largestReadBuffer).toBeGreaterThan(0);
      expect(largestReadBuffer).toBeLessThanOrEqual(128 * 1024 + 1);
    } finally {
      open.mockRestore();
    }
  });
});
