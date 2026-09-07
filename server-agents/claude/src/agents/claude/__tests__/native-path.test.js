import { afterEach, describe, expect, it, mock } from 'bun:test';
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import {
  createClaudeNativePath,
  prepareClaudeNativeSessionRelocation,
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

function createLogger() {
  return {
    debug: mock(() => undefined),
    info: mock(() => undefined),
    warn: mock(() => undefined),
    error: mock(() => undefined),
  };
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
    const projectPath = `/tmp/claude-long-hash-vector/${'a'.repeat(90)}/${'b'.repeat(90)}`;
    const sanitized = sanitizeClaudeProjectPath(projectPath);

    expect(sanitized).toBe(
      `${projectPath.replace(/[^a-zA-Z0-9]/g, '-').slice(0, 200)}-m0kdax`,
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
    const logger = createLogger();

    const resolved = await resolveClaudeNativePath({
      projectPath,
      agentSessionId: 'session-1',
      nativePath: path.join(configHomeDir, 'projects', 'stale', 'session-1.jsonl'),
    }, { configHomeDir, logger });

    expect(resolved).toBe(expectedPath);
    expect(logger.warn).toHaveBeenCalledWith(
      'Claude stored transcript path is unavailable; using derived path',
      expect.objectContaining({ agentSessionId: 'session-1' }),
    );
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
    const logger = createLogger();

    const resolved = await resolveClaudeNativePath({
      projectPath,
      agentSessionId: 'session-1',
      nativePath: path.join(
        configHomeDir,
        'projects',
        'stale-encoding',
        'session-1.jsonl',
      ),
    }, { logger });

    expect(resolved).toBe(expectedPath);
    expect(logger.warn).toHaveBeenCalledWith(
      'Claude stored transcript path is unavailable; using derived path',
      expect.objectContaining({ agentSessionId: 'session-1' }),
    );
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
    const logger = createLogger();

    const resolved = await resolveClaudeNativePath({
      projectPath,
      agentSessionId: 'session-1',
    }, { configHomeDir, logger });

    expect(resolved).toBe(recoveredPath);
    expect(logger.warn).toHaveBeenCalledWith(
      'Claude expected transcript path is unavailable; searching projects',
      expect.objectContaining({ agentSessionId: 'session-1' }),
    );
    expect(logger.warn).toHaveBeenCalledWith(
      'Claude transcript path recovered by session search',
      expect.objectContaining({ agentSessionId: 'session-1' }),
    );
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
    const logger = createLogger();

    const resolved = await resolveClaudeNativePath({
      projectPath,
      agentSessionId: 'session-1',
    }, { configHomeDir, logger });

    expect(resolved).toBeNull();
    expect(logger.error).toHaveBeenCalledWith(
      'Claude transcript search found multiple files and refused to choose',
      expect.objectContaining({ agentSessionId: 'session-1' }),
    );
  });
});

async function pathExists(targetPath) {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

async function relocationFixture(options = {}) {
  const rootDirectory = await temporaryDirectory();
  const sourceConfigHome = path.join(rootDirectory, 'source-config');
  const targetConfigHome = options.targetConfigHome
    ?? sourceConfigHome;
  const previousProjectPath = path.join(rootDirectory, 'project-a');
  const nextProjectPath = path.join(rootDirectory, 'project-b');
  await fs.mkdir(previousProjectPath, { recursive: true });
  await fs.mkdir(nextProjectPath, { recursive: true });
  const sourcePath = await createClaudeNativePath(
    previousProjectPath,
    'session-1',
    { configHomeDir: sourceConfigHome },
  );
  await fs.mkdir(path.dirname(sourcePath), { recursive: true });
  await fs.writeFile(sourcePath, 'source transcript\n');
  const sourceQueuePath = path.join(
    path.dirname(sourcePath),
    'session-1.queue.json',
  );
  const sourceSupportPath = path.join(
    path.dirname(sourcePath),
    'session-1',
  );
  await fs.writeFile(sourceQueuePath, '{"entries":[]}\n');
  await fs.mkdir(path.join(sourceSupportPath, 'subagents'), { recursive: true });
  await fs.writeFile(
    path.join(sourceSupportPath, 'subagents', 'agent-1.jsonl'),
    'subagent transcript\n',
  );

  return {
    logger: createLogger(),
    nextProjectPath,
    previousProjectPath,
    sourceConfigHome,
    sourcePath,
    sourceQueuePath,
    sourceSupportPath,
    targetConfigHome,
  };
}

describe('prepareClaudeNativeSessionRelocation', () => {
  it('copies all session artifacts before removing the source on commit', async () => {
    const fixture = await relocationFixture();

    const relocation = await prepareClaudeNativeSessionRelocation({
      previousProjectPath: fixture.previousProjectPath,
      nextProjectPath: fixture.nextProjectPath,
      agentSessionId: 'session-1',
      nativePath: fixture.sourcePath,
      configHomeDir: fixture.targetConfigHome,
      logger: fixture.logger,
    });
    const targetQueuePath = path.join(
      path.dirname(relocation.nativePath),
      'session-1.queue.json',
    );
    const targetSupportPath = path.join(
      path.dirname(relocation.nativePath),
      'session-1',
    );

    expect(await fs.readFile(relocation.nativePath, 'utf8')).toBe(
      'source transcript\n',
    );
    expect(await fs.readFile(targetQueuePath, 'utf8')).toBe(
      '{"entries":[]}\n',
    );
    expect(await fs.readFile(
      path.join(targetSupportPath, 'subagents', 'agent-1.jsonl'),
      'utf8',
    )).toBe('subagent transcript\n');
    expect(await pathExists(fixture.sourcePath)).toBe(true);

    await relocation.commit();

    expect(await pathExists(fixture.sourcePath)).toBe(false);
    expect(await pathExists(fixture.sourceQueuePath)).toBe(false);
    expect(await pathExists(fixture.sourceSupportPath)).toBe(false);
    expect(await pathExists(relocation.nativePath)).toBe(true);
  });

  it('removes prepared destination artifacts on rollback', async () => {
    const fixture = await relocationFixture();
    const relocation = await prepareClaudeNativeSessionRelocation({
      previousProjectPath: fixture.previousProjectPath,
      nextProjectPath: fixture.nextProjectPath,
      agentSessionId: 'session-1',
      nativePath: fixture.sourcePath,
      configHomeDir: fixture.targetConfigHome,
      logger: fixture.logger,
    });

    await relocation.rollback();

    expect(await pathExists(relocation.nativePath)).toBe(false);
    expect(await pathExists(fixture.sourcePath)).toBe(true);
    expect(await pathExists(fixture.sourceQueuePath)).toBe(true);
    expect(await pathExists(fixture.sourceSupportPath)).toBe(true);
  });

  it('uses the current config home for the destination', async () => {
    const rootDirectory = await temporaryDirectory();
    const targetConfigHome = path.join(rootDirectory, 'current-config');
    const fixture = await relocationFixture({ targetConfigHome });

    const relocation = await prepareClaudeNativeSessionRelocation({
      previousProjectPath: fixture.previousProjectPath,
      nextProjectPath: fixture.nextProjectPath,
      agentSessionId: 'session-1',
      nativePath: fixture.sourcePath,
      configHomeDir: targetConfigHome,
      logger: fixture.logger,
    });

    expect(relocation.nativePath.startsWith(
      path.join(targetConfigHome, 'projects'),
    )).toBe(true);
    await relocation.rollback();
  });

  it('replaces stale destination artifacts without merging them', async () => {
    const fixture = await relocationFixture();
    const targetPath = await createClaudeNativePath(
      fixture.nextProjectPath,
      'session-1',
      { configHomeDir: fixture.targetConfigHome },
    );
    const targetSupportPath = path.join(path.dirname(targetPath), 'session-1');
    await fs.mkdir(targetSupportPath, { recursive: true });
    await fs.writeFile(targetPath, 'stale transcript\n');
    await fs.writeFile(path.join(targetSupportPath, 'stale.txt'), 'stale\n');

    const relocation = await prepareClaudeNativeSessionRelocation({
      previousProjectPath: fixture.previousProjectPath,
      nextProjectPath: fixture.nextProjectPath,
      agentSessionId: 'session-1',
      nativePath: fixture.sourcePath,
      configHomeDir: fixture.targetConfigHome,
      logger: fixture.logger,
    });

    expect(await fs.readFile(relocation.nativePath, 'utf8')).toBe(
      'source transcript\n',
    );
    expect(await pathExists(path.join(targetSupportPath, 'stale.txt'))).toBe(
      false,
    );
    await relocation.rollback();
  });

  it('returns a no-op relocation for the same canonical project', async () => {
    const fixture = await relocationFixture();

    const relocation = await prepareClaudeNativeSessionRelocation({
      previousProjectPath: fixture.previousProjectPath,
      nextProjectPath: fixture.previousProjectPath,
      agentSessionId: 'session-1',
      nativePath: fixture.sourcePath,
      configHomeDir: fixture.targetConfigHome,
      logger: fixture.logger,
    });

    await relocation.commit();
    await relocation.rollback();
    expect(relocation.nativePath).toBe(fixture.sourcePath);
    expect(await pathExists(fixture.sourcePath)).toBe(true);
  });

  it('rejects missing and structurally unsafe source transcripts', async () => {
    const rootDirectory = await temporaryDirectory();
    const projectPath = path.join(rootDirectory, 'project');
    await fs.mkdir(projectPath, { recursive: true });

    await expect(prepareClaudeNativeSessionRelocation({
      previousProjectPath: projectPath,
      nextProjectPath: projectPath,
      agentSessionId: 'missing-session',
      nativePath: null,
      configHomeDir: path.join(rootDirectory, 'config'),
    })).rejects.toMatchObject({ code: 'TRANSCRIPT_UNAVAILABLE' });

    const unsafePath = path.join(rootDirectory, 'unsafe-session.jsonl');
    await fs.writeFile(unsafePath, 'unsafe\n');
    await expect(prepareClaudeNativeSessionRelocation({
      previousProjectPath: projectPath,
      nextProjectPath: projectPath,
      agentSessionId: 'unsafe-session',
      nativePath: unsafePath,
      configHomeDir: path.join(rootDirectory, 'config'),
    })).rejects.toMatchObject({ code: 'TRANSCRIPT_UNAVAILABLE' });
  });

  it('rejects session IDs that could escape recursive artifact cleanup', async () => {
    const rootDirectory = await temporaryDirectory();
    const configHomeDir = path.join(rootDirectory, 'config');
    const projectPath = path.join(rootDirectory, 'project');
    const projectDirectory = path.join(configHomeDir, 'projects', 'source');
    const siblingDirectory = path.join(configHomeDir, 'projects', 'sibling');
    const unsafePath = path.join(projectDirectory, '...jsonl');
    await fs.mkdir(projectPath, { recursive: true });
    await fs.mkdir(projectDirectory, { recursive: true });
    await fs.mkdir(siblingDirectory, { recursive: true });
    await fs.writeFile(unsafePath, 'unsafe\n');
    await fs.writeFile(path.join(siblingDirectory, 'retained.txt'), 'retained\n');

    await expect(prepareClaudeNativeSessionRelocation({
      previousProjectPath: projectPath,
      nextProjectPath: projectPath,
      agentSessionId: '..',
      nativePath: unsafePath,
      configHomeDir,
    })).rejects.toMatchObject({ code: 'TRANSCRIPT_UNAVAILABLE' });

    expect(await pathExists(unsafePath)).toBe(true);
    expect(await pathExists(path.join(siblingDirectory, 'retained.txt'))).toBe(
      true,
    );
  });
});
