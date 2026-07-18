import { afterEach, describe, expect, it, spyOn } from 'bun:test';
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import {
  createClaudeNativePath,
  resolveClaudeNativePath,
  sanitizeClaudeProjectPath,
} from '../native-path.js';

const temporaryDirectories = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) =>
    fs.rm(directory, { recursive: true, force: true })
  ));
});

async function temporaryDirectory() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'claude-native-path-'));
  temporaryDirectories.push(directory);
  return directory;
}

describe('sanitizeClaudeProjectPath', () => {
  it('replaces every non-ASCII-alphanumeric character', () => {
    expect(sanitizeClaudeProjectPath('/garcon/.worktrees/simplify')).toBe(
      '-garcon--worktrees-simplify',
    );
    expect(sanitizeClaudeProjectPath('/tmp/a b_c:d~e/f.g')).toBe(
      '-tmp-a-b-c-d-e-f-g',
    );
    expect(sanitizeClaudeProjectPath('/tmp/na\u00efve/\u9879\u76ee')).toBe(
      '-tmp-na-ve---',
    );
  });

  it('uses Claude Code long-path truncation and hashing', () => {
    const projectPath = `/${'a'.repeat(220)}`;
    const sanitized = sanitizeClaudeProjectPath(projectPath);

    expect(sanitized).toBe(
      `${projectPath.replace(/[^a-zA-Z0-9]/g, '-').slice(0, 200)}-${Bun.hash(projectPath).toString(36)}`,
    );
  });
});

describe('createClaudeNativePath', () => {
  it('canonicalizes symlinks and uses Claude Code project encoding', async () => {
    const rootDirectory = await temporaryDirectory();
    const configHomeDir = path.join(rootDirectory, 'config');
    const actualProjectPath = path.join(rootDirectory, 'repo', '.worktrees', 'simplify');
    const symlinkProjectPath = path.join(rootDirectory, 'project-alias');
    await fs.mkdir(actualProjectPath, { recursive: true });
    await fs.symlink(actualProjectPath, symlinkProjectPath);

    const nativePath = await createClaudeNativePath(symlinkProjectPath, 'session-1', {
      configHomeDir,
    });
    const canonicalProjectPath = (await fs.realpath(actualProjectPath)).normalize('NFC');

    expect(nativePath).toBe(path.join(
      configHomeDir,
      'projects',
      sanitizeClaudeProjectPath(canonicalProjectPath),
      'session-1.jsonl',
    ));
    expect(nativePath).not.toContain('project-alias');
  });

  it('normalizes the canonical project path to NFC', async () => {
    const rootDirectory = await temporaryDirectory();
    const projectPath = path.join(rootDirectory, `caf\u0065\u0301`);
    await fs.mkdir(projectPath, { recursive: true });

    const nativePath = await createClaudeNativePath(projectPath, 'session-1', {
      configHomeDir: path.join(rootDirectory, 'config'),
    });
    const normalizedPath = (await fs.realpath(projectPath)).normalize('NFC');

    expect(path.basename(path.dirname(nativePath))).toBe(
      sanitizeClaudeProjectPath(normalizedPath),
    );
  });
});

describe('resolveClaudeNativePath', () => {
  it('recovers a transcript stored under Claude Code encoding', async () => {
    const rootDirectory = await temporaryDirectory();
    const configHomeDir = path.join(rootDirectory, 'config');
    const projectPath = path.join(rootDirectory, 'repo', '.worktrees', 'simplify');
    await fs.mkdir(projectPath, { recursive: true });
    const expectedPath = await createClaudeNativePath(projectPath, 'session-1', {
      configHomeDir,
    });
    await fs.mkdir(path.dirname(expectedPath), { recursive: true });
    await fs.writeFile(expectedPath, '{}\n');
    const warning = spyOn(console, 'warn').mockImplementation(() => {});

    const resolved = await resolveClaudeNativePath({
      projectPath,
      agentSessionId: 'session-1',
      nativePath: path.join(configHomeDir, 'projects', 'stale', 'session-1.jsonl'),
    }, { configHomeDir });

    expect(resolved).toBe(expectedPath);
    expect(warning).toHaveBeenCalledWith(
      '[agents:claude:native-path]',
      expect.stringContaining('stored transcript path is unavailable'),
    );
    warning.mockRestore();
  });

  it('recovers within a custom config home inferred from the stored path', async () => {
    const rootDirectory = await temporaryDirectory();
    const configHomeDir = path.join(rootDirectory, 'custom-config');
    const projectPath = path.join(rootDirectory, 'repo', '.worktrees', 'simplify');
    await fs.mkdir(projectPath, { recursive: true });
    const expectedPath = await createClaudeNativePath(projectPath, 'session-1', {
      configHomeDir,
    });
    await fs.mkdir(path.dirname(expectedPath), { recursive: true });
    await fs.writeFile(expectedPath, '{}\n');
    const warning = spyOn(console, 'warn').mockImplementation(() => {});

    const resolved = await resolveClaudeNativePath({
      projectPath,
      agentSessionId: 'session-1',
      nativePath: path.join(
        configHomeDir,
        'projects',
        'stale-encoding',
        'session-1.jsonl',
      ),
    });

    expect(resolved).toBe(expectedPath);
    expect(warning).toHaveBeenCalledWith(
      '[agents:claude:native-path]',
      expect.stringContaining('stored transcript path is unavailable'),
    );
    warning.mockRestore();
  });

  it('warns and searches all project directories when derivation misses', async () => {
    const rootDirectory = await temporaryDirectory();
    const configHomeDir = path.join(rootDirectory, 'config');
    const projectPath = path.join(rootDirectory, 'repo');
    const recoveredPath = path.join(
      configHomeDir,
      'projects',
      'future-encoding',
      'session-1.jsonl',
    );
    await fs.mkdir(projectPath, { recursive: true });
    await fs.mkdir(path.dirname(recoveredPath), { recursive: true });
    await fs.writeFile(recoveredPath, '{}\n');
    const warning = spyOn(console, 'warn').mockImplementation(() => {});

    const resolved = await resolveClaudeNativePath({
      projectPath,
      agentSessionId: 'session-1',
    }, { configHomeDir });

    expect(resolved).toBe(recoveredPath);
    expect(warning).toHaveBeenCalledWith(
      '[agents:claude:native-path]',
      expect.stringContaining('searching'),
    );
    expect(warning).toHaveBeenCalledWith(
      '[agents:claude:native-path]',
      expect.stringContaining('recovered transcript path by session search'),
    );
    warning.mockRestore();
  });

  it('refuses to choose between duplicate session files', async () => {
    const rootDirectory = await temporaryDirectory();
    const configHomeDir = path.join(rootDirectory, 'config');
    const projectPath = path.join(rootDirectory, 'repo');
    await fs.mkdir(projectPath, { recursive: true });
    for (const projectDirectory of ['first', 'second']) {
      const transcriptPath = path.join(
        configHomeDir,
        'projects',
        projectDirectory,
        'session-1.jsonl',
      );
      await fs.mkdir(path.dirname(transcriptPath), { recursive: true });
      await fs.writeFile(transcriptPath, '{}\n');
    }
    const warning = spyOn(console, 'warn').mockImplementation(() => {});
    const error = spyOn(console, 'error').mockImplementation(() => {});

    const resolved = await resolveClaudeNativePath({
      projectPath,
      agentSessionId: 'session-1',
    }, { configHomeDir });

    expect(resolved).toBeNull();
    expect(error).toHaveBeenCalledWith(
      '[agents:claude:native-path]',
      expect.stringContaining('found multiple files'),
      expect.any(Array),
    );
    warning.mockRestore();
    error.mockRestore();
  });
});
