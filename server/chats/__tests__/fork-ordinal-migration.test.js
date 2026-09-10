import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { removeLegacyForkOrdinals } from '../fork-ordinal-migration.js';

const SOURCE_ID = '1786077000000001';
const CHILD_ID = '1786077000000002';
let workspaceDir;
let registryPath;

function entry(overrides = {}) {
  return {
    agentId: 'test',
    model: 'model-a',
    projectPath: '/repo',
    agentOwnershipEpoch: 'synthetic-epoch',
    agentSettingsById: {},
    carryOverSegments: [],
    nativeSeedReceipt: null,
    carryOverMigrationQuarantine: null,
    ...overrides,
  };
}

beforeEach(async () => {
  workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), 'garcon-fork-ordinal-migration-'));
  registryPath = path.join(workspaceDir, 'chats.json');
});

afterEach(async () => {
  await fs.rm(workspaceDir, { recursive: true, force: true });
});

describe('fork ordinal cleanup', () => {
  it('removes only the obsolete field and is idempotent', async () => {
    const source = entry({ nextForkOrdinal: 4, retainedExtra: 'preserved' });
    const child = entry({
      nextForkOrdinal: 'invalid legacy value',
      parentChat: { chatId: SOURCE_ID, relation: 'fork', transcriptViewId: 'view-1', ordinal: 2 },
    });
    const original = { version: 5, retainedExtra: true, sessions: { [SOURCE_ID]: source, [CHILD_ID]: child } };
    await fs.writeFile(registryPath, JSON.stringify(original));

    await removeLegacyForkOrdinals(workspaceDir);

    delete source.nextForkOrdinal;
    delete child.nextForkOrdinal;
    expect(JSON.parse(await fs.readFile(registryPath, 'utf8'))).toEqual(original);
    const rename = spyOn(fs, 'rename');
    try {
      await removeLegacyForkOrdinals(workspaceDir);
      expect(rename).not.toHaveBeenCalled();
    } finally {
      rename.mockRestore();
    }
  });

  it('does not create a missing registry or rewrite one without counters', async () => {
    await removeLegacyForkOrdinals(workspaceDir);
    await expect(fs.stat(registryPath)).rejects.toMatchObject({ code: 'ENOENT' });
    const raw = JSON.stringify({ version: 5, sessions: { [SOURCE_ID]: entry() } });
    await fs.writeFile(registryPath, raw);

    await removeLegacyForkOrdinals(workspaceDir);

    expect(await fs.readFile(registryPath, 'utf8')).toBe(raw);
  });

  it.each([
    { version: 4, sessions: {} },
    { version: 5, sessions: [] },
    { version: 5, sessions: { [SOURCE_ID]: entry({ nextForkOrdinal: 1 }), [CHILD_ID]: null } },
    { version: 5, sessions: { invalid: entry({ nextForkOrdinal: 1 }) } },
    { version: 5, sessions: { [SOURCE_ID]: entry({ nextForkOrdinal: 1, agentOwnershipEpoch: null }) } },
  ])('refuses malformed registries without rewriting them', async (registry) => {
    const raw = JSON.stringify(registry);
    await fs.writeFile(registryPath, raw);

    await expect(removeLegacyForkOrdinals(workspaceDir)).rejects.toThrow();
    expect(await fs.readFile(registryPath, 'utf8')).toBe(raw);
  });

  it('preserves the original after a failed write and can retry', async () => {
    const raw = JSON.stringify({ version: 5, sessions: { [SOURCE_ID]: entry({ nextForkOrdinal: 4 }) } });
    await fs.writeFile(registryPath, raw);
    const rename = spyOn(fs, 'rename').mockRejectedValue(new Error('disk unavailable'));
    try {
      await expect(removeLegacyForkOrdinals(workspaceDir)).rejects.toThrow('disk unavailable');
      expect(await fs.readFile(registryPath, 'utf8')).toBe(raw);
    } finally {
      rename.mockRestore();
    }

    await removeLegacyForkOrdinals(workspaceDir);
    expect(JSON.parse(await fs.readFile(registryPath, 'utf8')).sessions[SOURCE_ID])
      .not.toHaveProperty('nextForkOrdinal');
  });
});
