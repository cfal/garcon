import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { UserMessage } from '../../../common/chat-types.js';
import { CarryOverTranscriptStore } from '../carryover-transcript-store.ts';
import {
  markCarryOverMigrationRollbackUnsafe,
  migrateLegacyCarryOverWorkspace,
  rollbackLegacyCarryOverMigration,
} from '../chat-carryover-migration.ts';

const CHAT_ID = '1786077000000001';
const TIMESTAMP = '2026-01-01T00:00:00.000Z';

describe('legacy carryover migration', () => {
  let workspaceDir;

  beforeEach(async () => {
    workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), 'garcon-carryover-migration-'));
    await writeWorkspaceVersion(3);
  });

  afterEach(async () => {
    await fs.rm(workspaceDir, { recursive: true, force: true });
  });

  it('preserves sanitized messages and empty-segment boundaries in linked nodes', async () => {
    await writeLegacyWorkspace({
      segments: [
        segment('codex', 'gpt', [new UserMessage(TIMESTAMP, 'first')], {
          target: { agentId: 'claude', model: 'opus' },
        }),
        segment('claude', 'opus', [], {
          target: { agentId: 'pi', model: 'kimi' },
        }),
      ],
      currentAgentId: 'pi',
      currentModel: 'kimi',
    });

    await migrateLegacyCarryOverWorkspace(workspaceDir);

    const registry = await readJson('chats.json');
    const migrated = registry.sessions[CHAT_ID];
    expect(registry.version).toBe(4);
    expect(typeof migrated.carryOverHeadId).toBe('string');
    const store = new CarryOverTranscriptStore({ workspaceDir });
    await store.initialize();
    const messages = await store.loadAll(migrated.carryOverHeadId, {
      agentId: 'pi',
      model: 'kimi',
    });
    expect(messages).toEqual([
      expect.objectContaining({ type: 'user-message', content: 'first' }),
      expect.objectContaining({
        type: 'agent-switch',
        fromAgentId: 'codex',
        toAgentId: 'claude',
      }),
      expect.objectContaining({
        type: 'agent-switch',
        fromAgentId: 'claude',
        toAgentId: 'pi',
      }),
    ]);
  });

  it('resumes after the registry commit and before the ownership-journal commit', async () => {
    await writeLegacyWorkspace({
      segments: [segment('codex', 'gpt', [new UserMessage(TIMESTAMP, 'first')])],
      currentAgentId: 'claude',
      currentModel: 'opus',
    });
    await migrateLegacyCarryOverWorkspace(workspaceDir);
    const complete = await readJson('carryover-transcripts/migration-v1.json');
    const migratedFile = (await fs.readdir(workspaceDir)).find((file) => (
      file.startsWith('chat-carryover.v4.migrated.')
    ));
    expect(migratedFile).toBeDefined();
    await fs.rename(
      path.join(workspaceDir, migratedFile),
      path.join(workspaceDir, 'chat-carryover.json'),
    );
    await fs.writeFile(
      path.join(workspaceDir, 'agent-ownership-journal.json'),
      JSON.stringify({ version: 1, intents: [] }),
    );
    const {
      completedAt: _completedAt,
      rollbackSafe: _rollbackSafe,
      ...readyFields
    } = complete;
    await fs.writeFile(
      path.join(workspaceDir, 'carryover-transcripts/migration-v1.json'),
      JSON.stringify({ ...readyFields, phase: 'ready-to-commit' }),
    );

    await migrateLegacyCarryOverWorkspace(workspaceDir);

    expect(await readJson('agent-ownership-journal.json')).toEqual({
      version: 2,
      ownershipIntents: [],
      transferCleanup: [],
    });
    expect((await readJson('carryover-transcripts/migration-v1.json')).phase).toBe('complete');
    await expect(fs.stat(path.join(workspaceDir, 'chat-carryover.json')))
      .rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('rejects a schema-v4 registry without migration provenance in a v3 workspace', async () => {
    await fs.writeFile(
      path.join(workspaceDir, 'chats.json'),
      JSON.stringify({ version: 4, sessions: {} }),
    );

    await expect(migrateLegacyCarryOverWorkspace(workspaceDir))
      .rejects.toThrow('no committed carryover migration marker');
  });

  it('quarantines malformed chat history without treating it as empty history', async () => {
    await writeLegacyWorkspace({
      segments: [{ agentId: 'codex', model: 'gpt', messages: [{ type: 'invalid' }] }],
      currentAgentId: 'claude',
      currentModel: 'opus',
    });

    await migrateLegacyCarryOverWorkspace(workspaceDir);

    const entry = (await readJson('chats.json')).sessions[CHAT_ID];
    expect(entry.carryOverHeadId).toBeNull();
    expect(entry.carryOverMigrationQuarantine).toMatchObject({
      errorCode: 'INVALID_CARRYOVER_ENTRY',
    });
    await expect(fs.stat(path.join(
      workspaceDir,
      'carryover-transcripts',
      'quarantine',
      `${entry.carryOverMigrationQuarantine.artifactId}.json`,
    ))).resolves.toBeDefined();
  });

  it('restores every legacy artifact during the rollback validation window', async () => {
    await writeLegacyWorkspace({
      segments: [segment('codex', 'gpt', [new UserMessage(TIMESTAMP, 'first')])],
      currentAgentId: 'claude',
      currentModel: 'opus',
    });
    const legacyCarryOver = await readJson('chat-carryover.json');
    const legacyRegistry = await readJson('chats.json');
    const legacyJournal = await readJson('agent-ownership-journal.json');
    await migrateLegacyCarryOverWorkspace(workspaceDir);
    await writeWorkspaceVersion(4);

    expect(await rollbackLegacyCarryOverMigration(workspaceDir)).toBe('restored');

    expect(await readJson('workspace-version.json')).toEqual({ version: 3 });
    expect(await readJson('chats.json')).toEqual(legacyRegistry);
    expect(await readJson('chat-carryover.json')).toEqual(legacyCarryOver);
    expect(await readJson('agent-ownership-journal.json')).toEqual(legacyJournal);
    await expect(fs.stat(path.join(workspaceDir, 'carryover-transcripts/migration-v1.json')))
      .rejects.toMatchObject({ code: 'ENOENT' });
    expect((await fs.readdir(path.join(workspaceDir, 'carryover-transcripts'))).some((file) => (
      file.startsWith('migration-v1.rolled-back.')
    ))).toBe(true);
    expect(await rollbackLegacyCarryOverMigration(workspaceDir)).toBe('already-restored');
  });

  it('closes the rollback window before a normal node can be accepted', async () => {
    await writeLegacyWorkspace({
      segments: [segment('codex', 'gpt', [new UserMessage(TIMESTAMP, 'first')])],
      currentAgentId: 'claude',
      currentModel: 'opus',
    });
    await migrateLegacyCarryOverWorkspace(workspaceDir);
    await writeWorkspaceVersion(4);

    await markCarryOverMigrationRollbackUnsafe(workspaceDir);

    expect((await readJson('carryover-transcripts/migration-v1.json')).rollbackSafe).toBe(false);
    await expect(rollbackLegacyCarryOverMigration(workspaceDir))
      .rejects.toThrow('unsafe after new-format history was created');
    expect((await readJson('chats.json')).version).toBe(4);
  });

  async function writeWorkspaceVersion(version) {
    await fs.writeFile(
      path.join(workspaceDir, 'workspace-version.json'),
      JSON.stringify({ version }),
    );
  }

  async function writeLegacyWorkspace({ segments, currentAgentId, currentModel }) {
    await fs.writeFile(path.join(workspaceDir, 'chats.json'), JSON.stringify({
      version: 3,
      sessions: {
        [CHAT_ID]: legacyEntry(currentAgentId, currentModel),
      },
    }));
    await fs.writeFile(path.join(workspaceDir, 'chat-carryover.json'), JSON.stringify({
      version: 4,
      chats: {
        [CHAT_ID]: { revision: 1, segments },
      },
    }));
    await fs.writeFile(
      path.join(workspaceDir, 'agent-ownership-journal.json'),
      JSON.stringify({ version: 1, intents: [] }),
    );
  }

  function readJson(relativePath) {
    return fs.readFile(path.join(workspaceDir, relativePath), 'utf8').then(JSON.parse);
  }
});

function segment(agentId, model, messages, options = {}) {
  return {
    agentId,
    model,
    messages,
    at: TIMESTAMP,
    boundary: true,
    boundaryTarget: options.target ?? null,
  };
}

function legacyEntry(agentId, model) {
  return {
    agentId,
    agentSessionId: `${agentId}-session`,
    nativeSession: null,
    agentOwnershipEpoch: `${agentId}-epoch`,
    agentSettingsById: {
      [agentId]: { ownerId: agentId, schemaVersion: 1, values: {} },
    },
    projectPath: '/workspace/project',
    tags: [],
    model,
    apiProviderId: null,
    modelEndpointId: null,
    modelProtocol: null,
    lastReadAt: null,
    permissionMode: 'default',
    thinkingMode: 'none',
  };
}
